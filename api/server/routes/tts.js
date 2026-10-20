/**
 * tts 路由 —— 火山引擎豆包语音合成。
 *
 *   GET  /api/tts/status        查询 TTS 是否已配置凭证
 *   POST /api/tts/synthesize    合成语音
 *
 * POST body:
 *   { text, voice?, volume?, speed?, pitch?, encoding?, response?: 'binary'|'base64',
 *     mode?: 'auto'|'bidirection' }
 *
 * 默认直接返回音频二进制（Content-Type: audio/mpeg），前端可把响应当文件 URL 使用；
 * response=base64 时返回 JSON { audio: 'data:audio/mpeg;base64,...' }，
 * 便于需要在内存里立即播放的场景。
 *
 * mode=bidirection 时走 WebSocket 双向流式（wss://.../api/v3/tts/bidirection），
 * 其余情况保持原有 HTTP 单向链路，行为不变。
 */

import { Router } from 'express';
import { synthesize, resolveSpeakerV2, getTTSInfo } from '../services/tts.js';
import { synthesizeBidirection } from '../services/ttsBidirection.js';

const router = Router();

/** 倍率转 2.0 的 [-50, 100] 百分比参数 */
const clamp = (n, min, max, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
};

const MIME = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pcm: 'audio/L16',
    ogg: 'audio/ogg',
    // 豆包 2.0 的 opus 格式名
    ogg_opus: 'audio/ogg',
};

router.get('/status', (_req, res) => {
    // configured 为兼容旧前端的字段；其余字段用于排查走的是 2.0 还是旧接口
    res.json(getTTSInfo());
});

router.post('/synthesize', async (req, res) => {
    try {
        const {
            text,
            voice,
            volume,
            speed,
            pitch,
            encoding = 'mp3',
            response = 'binary',
            mode = 'auto',
            contextTexts,
            appId,
            accessToken,
            cluster,
            version,
        } = req.body || {};

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'text 为必填项' });
        }

        let buffer;
        let enc;
        let usedVersion;

        if (mode === 'bidirection') {
            // 双向流式的 format 枚举与 HTTP 链路一致，但 ogg 要写成 ogg_opus
            const encWs = encoding === 'wav' ? 'pcm' : encoding === 'ogg' ? 'ogg_opus' : encoding;
            const r = await synthesizeBidirection({
                text,
                speaker: resolveSpeakerV2(voice),
                encoding: encWs,
                speechRate: Math.round((clamp(speed, 0.2, 3, 1) - 1) * 100),
                loudnessRate: Math.round((clamp(volume, 0.1, 3, 1) - 1) * 100),
                contextTexts: Array.isArray(contextTexts) ? contextTexts : undefined,
                apiKey: process.env.TTS_API_KEY,
                appId: appId || process.env.TTS_APP_ID,
                accessToken: accessToken || process.env.TTS_ACCESS_TOKEN,
            });
            buffer = r.buffer;
            enc = r.encoding;
            usedVersion = 'v3-bidirection';
        } else {
            const r = await synthesize({
                text,
                voice,
                volume,
                speed,
                pitch,
                encoding,
                contextTexts: Array.isArray(contextTexts) ? contextTexts : undefined,
                appId,
                accessToken,
                cluster,
                version,
            });
            buffer = r.buffer;
            enc = r.encoding;
            usedVersion = r.version;
        }

        if (response === 'base64') {
            const mime = MIME[enc] || 'audio/mpeg';
            return res.json({
                audio: `data:${mime};base64,${buffer.toString('base64')}`,
                encoding: enc,
                version: usedVersion,
            });
        }

        res.setHeader('Content-Type', MIME[enc] || 'audio/mpeg');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('X-TTS-Version', String(usedVersion || ''));
        // 不强制下载，允许作为 <audio> 源直接播放
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buffer);
    } catch (error) {
        console.error('[TTS] 合成错误:', error?.message);
        const raw = error?.message || 'TTS 合成失败';
        // 语种不匹配属于调用方参数问题（英文音色喂中文），用 400 区分于上游故障
        const status = /未配置/.test(raw) ? 503 : error?.code === 'LANG_MISMATCH' ? 400 : 502;
        res.status(status).json({ error: raw, hint: error?.hint || '' });
    }
});

export default router;
