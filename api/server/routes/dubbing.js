/**
 * dubbing.js
 *
 * 配音音轨路由。
 *
 *   GET  /api/dubbing/status    ffmpeg 与 TTS 是否就绪（前端据此决定是否显示「生成音轨」）
 *   POST /api/dubbing/track     按角色音色合成整集配音音轨，返回可直接给合并接口用的 /library 地址
 *
 * POST /api/dubbing/track body:
 *   {
 *     episode?: number,
 *     volume?: number,          // 0.1 ~ 3
 *     speed?: number,           // 0.2 ~ 3
 *     force?: boolean,          // true 时忽略同指纹缓存强制重合成
 *     lines: [{ role, text, voice, contextTexts? }]
 *   }
 *
 * 响应:
 *   { success, url, duration, fingerprint, cached, lineCount, failed }
 *
 * 关键约定：`voice` 必须由前端按「资产确认页配置的角色音色」解析后传入，
 * 服务端不再做角色推断——资产是本项目音色的唯一真源。
 */

import { Router } from 'express';

import { buildDubbingTrack } from '../services/dubbingTrack.js';
import { isTTSConfigured } from '../services/tts.js';
import { isFFmpegAvailable } from '../utils/ffmpeg.js';

const router = Router();

router.get('/status', async (_req, res) => {
    const [ffmpeg, tts] = await Promise.all([isFFmpegAvailable(), Promise.resolve(isTTSConfigured())]);
    res.json({ success: true, ffmpeg, tts, ready: ffmpeg && tts });
});

router.post('/track', async (req, res) => {
    const { episode, volume, speed, force, lines } = req.body || {};

    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ success: false, error: 'lines 不能为空' });
    }

    try {
        const result = await buildDubbingTrack({ episode, volume, speed, force, lines });
        return res.json({ success: true, ...result });
    } catch (error) {
        const message = error?.message || '配音音轨生成失败';
        console.error('[Dubbing] 生成音轨失败:', message);
        // 参数类问题（空台词、缺音色）返回 400，其余归为上游/环境故障
        const status = /不能为空|没有可合成|缺少音色/.test(message) ? 400 : 502;
        return res.status(status).json({ success: false, error: message });
    }
});

export default router;
