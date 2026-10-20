/**
 * tts.js
 *
 * 火山引擎「豆包语音」语音合成（TTS）服务 —— HTTP 非流式（一次性合成）。
 *
 * 接口文档: https://www.volcengine.com/docs/6561/79820
 *   POST https://openspeech.bytedance.com/api/v1/tts
 *
 * 鉴权（重要，与方舟 Ark Key 不同）：
 *   请求头  Authorization: Bearer; <ACCESS_TOKEN>   —— 注意 Bearer 后有「分号 + 空格」
 *   请求体  app.appid / app.token / app.cluster
 *   凭证在「语音技术控制台」创建应用后获取，与方舟模型服务（ark.cn-beijing）相互独立。
 *
 * 返回：JSON。成功时 resp.data 为音频的 base64 字符串（mp3 / wav / pcm）。
 */

import { synthesizeV3, TtsError } from './ttsV3.js';
// 音色映射统一由 config/voices.js 提供（与前端 voiceCatalog.ts 对齐），此处仅再导出以兼容旧调用方
import { resolveVoiceType, resolveSpeakerV2, isEnglishSpeaker, isChineseOnlyText } from '../config/voices.js';

const TTS_HTTP_URL = process.env.TTS_HTTP_URL || 'https://openspeech.bytedance.com/api/v1/tts';
const TTS_APP_ID = process.env.TTS_APP_ID || '';
const TTS_ACCESS_TOKEN = process.env.TTS_ACCESS_TOKEN || '';
/** 音色集群：大模型语音合成用 volcano_tts；部分精品/复刻音色可能是 volcano_mega */
const TTS_CLUSTER = process.env.TTS_CLUSTER || 'volcano_tts';
/**
 * 合成协议版本：
 *   v3   = 豆包语音合成 2.0（seed-tts-2.0，流式，支持 *_uranus_bigtts 音色）
 *   v1   = 旧版一次性接口（/api/v1/tts，支持 zh_female_qingxin 等 1.0 音色）
 *   auto = 先走 v3，失败再回落 v1（默认）
 */
const TTS_API_VERSION = String(process.env.TTS_API_VERSION || 'auto').toLowerCase();
/** v3 资源 ID：2.0 为 seed-tts-2.0；声音复刻 2.0 为 seed-icl-2.0 */
const TTS_RESOURCE_ID = process.env.TTS_RESOURCE_ID || 'seed-tts-2.0';
/** 2.0 默认音色：爽快思思 */
const TTS_DEFAULT_SPEAKER_V2 = process.env.TTS_DEFAULT_SPEAKER || 'zh_female_shuangkuaisisi_uranus_bigtts';

// ============================================================================
// 音色映射：统一由 config/voices.js 提供（与 web/src/services/voiceCatalog.ts 保持一致）
//   id / 中文名 / 1.0 voice_type / 2.0 speaker 四层映射都在那边维护，这里只做再导出，
//   避免出现「预设里有、映射里没有」导致的透传报错（老版本「默认音色」就是这么挂的）。
// ============================================================================

export { resolveVoiceType, resolveSpeakerV2 };

function clamp(n, min, max, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

/**
 * 合成一段文本，返回音频 Buffer 与格式。
 *
 * @param {object} p
 * @param {string} p.text            要合成的文本
 * @param {string} [p.voice]         前端音色 id / 名称 / 火山 voice_type
 * @param {number} [p.volume]        音量倍率（0.1 ~ 3，1 为默认）
 * @param {number} [p.speed]         语速倍率（0.2 ~ 3，1 为默认）
 * @param {number} [p.pitch]         音调倍率（0.1 ~ 3，1 为默认）
 * @param {string} [p.encoding]      音频格式：mp3 / wav / pcm / ogg
 * @param {string[]} [p.contextTexts] 语音指令（自然语言风格提示词，仅 2.0 生效）
 * @param {string} [p.appId]         覆盖默认 appid
 * @param {string} [p.accessToken]   覆盖默认 access token
 * @param {string} [p.cluster]       覆盖默认 cluster
 * @returns {Promise<{ buffer: Buffer, encoding: string }>}
 */
export async function synthesize({
    text,
    voice,
    volume,
    speed,
    pitch,
    encoding = 'mp3',
    contextTexts,
    appId,
    accessToken,
    cluster,
    version,
}) {
    const useAppId = appId || TTS_APP_ID;
    const useToken = accessToken || TTS_ACCESS_TOKEN;
    const useCluster = cluster || TTS_CLUSTER;
    const useVersion = String(version || TTS_API_VERSION || 'auto').toLowerCase();

    const hasApiKey = Boolean(process.env.TTS_API_KEY);
    if (!hasApiKey && (!useAppId || !useToken)) {
        throw new Error('未配置语音凭证：需要 TTS_API_KEY（新版 API Key），或 TTS_APP_ID + TTS_ACCESS_TOKEN');
    }

    const content = String(text || '').trim();
    if (!content) {
        throw new Error('合成文本为空');
    }

    // 语种校验：英文音色（en_*）只认英文文本。
    // 直接喂中文时，2.0 接口会返回 HTTP 200 但一个音频帧都不给（前端表现为「点了没声音」），
    // 这里提前拦下并给出可读原因，避免用户以为音色坏了。
    if (isEnglishSpeaker(voice) && isChineseOnlyText(content)) {
        throw new TtsError(
            `音色「${voice}」是英文音色，只能朗读英文文本；当前文本不含英文。`,
            {
                code: 'LANG_MISMATCH',
                hint: '请改用中文音色，或把台词改成英文后再合成。',
            }
        );
    }

    // --- 语音合成 2.0（v3 单向流式） ---
    let v3Error = null;
    if (useVersion !== 'v1') {
        const encV3 = encoding === 'wav' ? 'pcm' : encoding === 'ogg' ? 'ogg_opus' : encoding;
        try {
            const { buffer } = await synthesizeV3({
                text: content,
                speaker: resolveSpeakerV2(voice),
                encoding: encV3,
                // 2.0 的语速/音量是 [-50, 100] 的百分比，这里把倍率换算过去
                speechRate: Math.round((clamp(speed, 0.2, 3, 1) - 1) * 100),
                loudnessRate: Math.round((clamp(volume, 0.1, 3, 1) - 1) * 100),
                contextTexts: Array.isArray(contextTexts) ? contextTexts : undefined,
                apiKey: process.env.TTS_API_KEY,
                appId: useAppId,
                accessToken: useToken,
            });
            return { buffer, encoding: encV3, version: 'v3' };
        } catch (error) {
            if (useVersion === 'v3') throw error;
            v3Error = error;
            console.warn(`[TTS] 2.0 合成失败，回落旧版接口：${error.message}`);
        }
    }

    /** v1 失败时带上 v3 的失败原因，避免只看到旧接口的报错而误判 */
    const fail = (message) => {
        if (v3Error) {
            const hint = v3Error instanceof TtsError && v3Error.hint ? `（${v3Error.hint}）` : '';
            throw new Error(`${message}；语音合成 2.0 也失败：${v3Error.message}${hint}`);
        }
        throw new Error(message);
    };

    if (!useAppId || !useToken) {
        fail('旧版语音合成接口需要 TTS_APP_ID / TTS_ACCESS_TOKEN，当前只配了 TTS_API_KEY');
    }

    const payload = {
        app: {
            appid: useAppId,
            token: useToken,
            cluster: useCluster,
        },
        user: {
            uid: 'twitcanva',
        },
        audio: {
            voice_type: resolveVoiceType(voice),
            encoding,
            speed_ratio: clamp(speed, 0.2, 3, 1),
            volume_ratio: clamp(volume, 0.1, 3, 1),
            pitch_ratio: clamp(pitch, 0.1, 3, 1),
        },
        request: {
            reqid: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            text: content,
            text_type: 'plain',
            operation: 'query',
            with_frontend: 1,
        },
    };

    const resp = await fetch(TTS_HTTP_URL, {
        method: 'POST',
        headers: {
            // 注意官方格式是「Bearer; 」而非常见的「Bearer 」
            Authorization: `Bearer; ${useToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    // 非 2xx：上游通常仍返回 JSON 错误信息
    const raw = await resp.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        if (!resp.ok) fail(`TTS 请求失败 (HTTP ${resp.status}): ${raw.slice(0, 300)}`);
        fail('TTS 返回无法解析');
    }

    // 火山约定：code === 3000 表示成功
    if (data.code !== 3000) {
        const msg = data.message || `错误码 ${data.code}`;
        fail(`火山 TTS 合成失败: ${msg}`);
    }

    if (!data.data) {
        fail('火山 TTS 返回缺少音频数据');
    }

    const buffer = Buffer.from(data.data, 'base64');
    return { buffer, encoding, version: 'v1' };
}

export const isTTSConfigured = () =>
    Boolean(process.env.TTS_API_KEY) || Boolean(TTS_APP_ID && TTS_ACCESS_TOKEN);

/** 运行时配置快照，供 /api/tts/status 展示，便于快速判断走的是 2.0 还是旧接口 */
export const getTTSInfo = () => ({
    configured: isTTSConfigured(),
    // 新版控制台 API Key 优先；否则用旧版 AppID + Access Token
    authMode: process.env.TTS_API_KEY ? 'x-api-key' : 'appid-token',
    version: TTS_API_VERSION,
    resourceId: TTS_RESOURCE_ID,
    defaultSpeaker: TTS_DEFAULT_SPEAKER_V2,
    v3Url: process.env.TTS_V3_URL || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
});

export default { synthesize, resolveVoiceType, resolveSpeakerV2, isTTSConfigured, getTTSInfo };
