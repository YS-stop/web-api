/**
 * ttsV3.js
 *
 * 豆包语音合成 2.0 —— HTTP 单向流式（chunked）接入。
 *
 * 与 v1（POST /api/v1/tts，一次性返回整段 base64）的区别：
 *   - 端点  POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   - 鉴权  X-Api-App-Id + X-Api-Access-Key（控制台 AppID + Access Token，非方舟 Ark Key）
 *   - 资源  X-Api-Resource-Id: seed-tts-2.0
 *           ⚠️ 2.0 只支持以 _uranus_bigtts 结尾的音色，1.0 音色（zh_female_qingxin 等）会报参数错误
 *   - 响应  chunked 流，正文是连续 JSON 帧；音频以 base64 分散在多帧里，需按到达顺序拼接
 *
 * 单帧结构存在两种历史写法，这里都兼容：
 *   { "header": { "code": 0, "message": "OK" }, "payload_msg": "<base64>" }
 *   { "code": 0, "message": "", "data": "<base64>" }
 *
 * 文档：https://www.volcengine.com/docs/6561/1598757
 */

const DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';

/** 正常码：0 为音频片段，20000000 为部分版本的流结束标志 */
const OK_CODES = new Set([0, 20000000]);

/** 语音合成专用错误：带上错误码与可执行的排查提示，便于前端直接展示 */
export class TtsError extends Error {
    constructor(message, meta = {}) {
        super(message);
        this.name = 'TtsError';
        this.code = meta.code;
        this.httpStatus = meta.httpStatus;
        this.hint = meta.hint || '';
    }
}

const hintFor = (code, resourceId, appId) => {
    switch (Number(code)) {
        case 45000030:
        case 3001:
            return `资源未授权（resource_id=${resourceId}）。请在火山引擎「语音技术 → 语音合成 2.0」完成开通，`
                + `并确认该能力已绑定到 AppID ${appId || '(未配置)'}；新开通通常需数分钟生效。`;
        case 45000000:
            return `当前应用不支持该 Resource ID（resource_id=${resourceId}）。请确认控制台开通的是语音合成 2.0，`
                + '对应资源 ID 为 seed-tts-2.0。';
        default:
            return '';
    }
};

/**
 * 从缓冲区中切出完整的 JSON 对象（大括号配对，忽略字符串里的括号）。
 * 返回已完整的帧与剩余的不完整片段，供流式解析复用。
 */
export const takeJsonObjects = (input) => {
    const frames = [];
    let rest = String(input || '');
    for (;;) {
        const start = rest.indexOf('{');
        if (start === -1) {
            rest = '';
            break;
        }
        let depth = 0;
        let end = -1;
        let inStr = false;
        let esc = false;
        for (let i = start; i < rest.length; i += 1) {
            const ch = rest[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') {
                inStr = true;
                continue;
            }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end === -1) {
            // 半包：保留从 start 开始的内容，等待后续字节
            rest = rest.slice(start);
            break;
        }
        frames.push(rest.slice(start, end));
        rest = rest.slice(end);
    }
    return { frames, rest };
};

/** 从单帧 JSON 中取出音频 base64（兼容 data / payload_msg / audio 三种键） */
const pickAudioBase64 = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    const candidates = [obj.data, obj.payload_msg, obj.audio, obj.header?.payload_msg];
    for (const c of candidates) {
        if (typeof c === 'string' && c.length > 0) return c;
    }
    return '';
};

/**
 * 合成一段文本（2.0 单向流式）。
 *
 * @param {object} p
 * @param {string} p.text           待合成文本
 * @param {string} p.speaker        2.0 音色 ID（*_uranus_bigtts）
 * @param {string} [p.encoding]     音频格式：mp3 / pcm / ogg_opus
 * @param {number} [p.sampleRate]   采样率，默认 24000
 * @param {number} [p.speechRate]   语速，范围 [-50, 100]，0 为原速
 * @param {number} [p.loudnessRate] 音量，范围 [-50, 100]，0 为原始
 * @param {string} [p.emotion]      情感：happy / sad / angry / narrator 等
 * @param {number} [p.emotionScale] 情绪强度 [1, 5]
 * @param {string[]} [p.contextTexts] 语音指令（自然语言控制语气/语速/情绪，仅 2.0 音色，不参与计费）
 * @param {string} [p.apiKey]      新版控制台 API Key（优先于 appId + accessToken）
 * @param {string} [p.appId]
 * @param {string} [p.accessToken]
 * @param {string} [p.resourceId]
 * @param {string} [p.url]
 * @returns {Promise<{ buffer: Buffer, encoding: string, requestId: string }>}
 */
export async function synthesizeV3({
    text,
    speaker,
    encoding = 'mp3',
    sampleRate = 24000,
    speechRate = 0,
    loudnessRate = 0,
    emotion,
    emotionScale,
    contextTexts,
    apiKey,
    appId,
    accessToken,
    resourceId = process.env.TTS_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    url = process.env.TTS_V3_URL || DEFAULT_URL,
    uid = 'twitcanva',
    signal,
} = {}) {
    if (!apiKey && (!appId || !accessToken)) {
        throw new TtsError(
            '未配置语音凭证：需要 TTS_API_KEY（新版控制台 API Key），或 TTS_APP_ID + TTS_ACCESS_TOKEN（旧版鉴权）',
            { code: 'NO_CREDENTIAL' }
        );
    }

    const content = String(text || '').trim();
    if (!content) {
        throw new TtsError('合成文本为空', { code: 'EMPTY_TEXT' });
    }
    if (!speaker) {
        throw new TtsError('缺少音色 speaker', { code: 'NO_SPEAKER' });
    }

    const audioParams = {
        format: encoding,
        sample_rate: sampleRate,
    };
    if (Number.isFinite(Number(speechRate))) audioParams.speech_rate = Number(speechRate);
    if (Number.isFinite(Number(loudnessRate))) audioParams.loudness_rate = Number(loudnessRate);
    if (emotion) {
        audioParams.emotion = emotion;
        if (Number.isFinite(Number(emotionScale))) audioParams.emotion_scale = Number(emotionScale);
    }

    const reqParams = {
        text: content,
        speaker,
        audio_params: audioParams,
    };
    // 语音指令：用自然语言控制语气 / 语速 / 情绪（仅 2.0 音色支持，且不参与计费）
    if (Array.isArray(contextTexts) && contextTexts.length > 0) {
        reqParams.context_texts = contextTexts.filter(Boolean).slice(0, 4);
    }

    const payload = {
        user: { uid },
        req_params: reqParams,
    };

    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: {
                // 新版控制台推荐 X-Api-Key；旧版为 AppID + Access Token，两种都兼容
                ...(apiKey
                    ? { 'X-Api-Key': apiKey }
                    : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessToken }),
                'X-Api-Resource-Id': resourceId,
                'X-Api-Request-Id': requestId,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal,
        });
    } catch (error) {
        throw new TtsError(`连接语音合成 2.0 服务失败：${error?.message || error}`, { code: 'NETWORK' });
    }

    // 非 2xx：服务端通常返回单个 JSON 错误帧
    if (!resp.ok) {
        const raw = await resp.text().catch(() => '');
        let code;
        let message = '';
        try {
            const j = JSON.parse(raw);
            code = j?.header?.code ?? j?.code;
            message = j?.header?.message ?? j?.message ?? '';
        } catch {
            message = raw.slice(0, 300);
        }
        throw new TtsError(
            `豆包语音合成 2.0 失败（HTTP ${resp.status}，code ${code ?? '未知'}）：${message || '无返回内容'}`,
            { code, httpStatus: resp.status, hint: hintFor(code, resourceId, appId) }
        );
    }

    if (!resp.body) {
        throw new TtsError('语音合成返回为空（无响应体）', { code: 'EMPTY_BODY' });
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parts = [];
    let buffer = '';
    let firstError = null;

    const consume = (rawFrames) => {
        for (const raw of rawFrames) {
            let obj;
            try {
                obj = JSON.parse(raw);
            } catch {
                continue;
            }
            const header = obj && typeof obj.header === 'object' ? obj.header : {};
            const code = header.code ?? obj.code;
            const message = header.message || obj.message || '';
            const b64 = pickAudioBase64(obj);
            if (b64) parts.push(Buffer.from(b64, 'base64'));
            if (code !== undefined && !OK_CODES.has(Number(code)) && !firstError) {
                firstError = { code, message };
            }
        }
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = takeJsonObjects(buffer);
            buffer = rest;
            if (frames.length) consume(frames);
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            const { frames } = takeJsonObjects(buffer);
            if (frames.length) consume(frames);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            /* 忽略 */
        }
    }

    if (!parts.length) {
        if (firstError) {
            throw new TtsError(
                `豆包语音合成 2.0 失败（code ${firstError.code}）：${firstError.message || '无返回内容'}`,
                { code: firstError.code, hint: hintFor(firstError.code, resourceId, appId) }
            );
        }
        throw new TtsError('语音合成未返回音频数据', { code: 'NO_AUDIO' });
    }

    return { buffer: Buffer.concat(parts), encoding, requestId };
}

export default { synthesizeV3, takeJsonObjects, TtsError };
