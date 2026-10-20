/**
 * ttsBidirection.js
 *
 * 豆包语音合成 2.0 —— WebSocket 双向流式（文本流式输入 + 音频流式输出）。
 *
 * 端点  wss://openspeech.bytedance.com/api/v3/tts/bidirection
 * 鉴权  X-Api-Key（新版控制台），兼容旧版 X-Api-App-Id + X-Api-Access-Key
 * 资源  X-Api-Resource-Id: seed-tts-2.0
 *
 * 二进制帧格式（严格对齐官方 TTS Websocket Bidirection protocols.zip 的 protocols.py）：
 *
 *   0                   1                   2                   3
 *   +-------------------+-------------------+-------------------+-------------------+
 *   | version(4)        | header size(4)    | msg type(4)       | flags(4)          |
 *   +-------------------+-------------------+-------------------+-------------------+
 *   | serialization(4)  | compression(4)    | reserved(8)                           |
 *   +-------------------+-------------------+-----------------------------------------+
 *   | event (int32 BE，仅 flags 含 WithEvent 时)                                  |
 *   | session id len (u32 BE) + session id（连接类事件不写）                      |
 *   | connect id len (u32 BE) + connect id（仅服务端 Connection* 响应读）          |
 *   | payload len (u32 BE) + payload                                              |
 *   +----------------------------------------------------------------------------+
 *
 * 注意几个官方实现里的不对称点，容易踩：
 *   1. flags 是低 4 位，msg type 是高 4 位，都在第 2 个字节（不是整字节常量）。
 *   2. 客户端的 StartConnection / FinishConnection 帧【不写】session id 字段。
 *   3. 服务端的 ConnectionStarted / ConnectionFailed / ConnectionFinished 帧既【不读】
 *      session id，又多一段 connect id；漏掉会让后续 payload 偏移错位。
 *   4. Error 帧（msg type 15）的 error code 出现在 event 之前。
 *
 * 文档：https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-text-to-speech-websocket
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

import { TtsError } from './ttsV3.js';

const DEFAULT_URL = process.env.TTS_BIDIRECTION_URL || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';

/** 消息类型（高 4 位） */
export const MsgType = {
    Invalid: 0b0000,
    FullClientRequest: 0b0001,
    AudioOnlyClient: 0b0010,
    FullServerResponse: 0b1001,
    AudioOnlyServer: 0b1011,
    FrontEndResultServer: 0b1100,
    Error: 0b1111,
};

/** 消息标志位（低 4 位） */
export const MsgTypeFlag = {
    NoSeq: 0b0000,
    PositiveSeq: 0b0001,
    LastNoSeq: 0b0010,
    NegativeSeq: 0b0011,
    WithEvent: 0b0100,
};

/** 事件号 */
export const EventType = {
    StartConnection: 1,
    FinishConnection: 2,
    ConnectionStarted: 50,
    ConnectionFailed: 51,
    ConnectionFinished: 52,
    StartSession: 100,
    CancelSession: 101,
    FinishSession: 102,
    SessionStarted: 150,
    SessionCanceled: 151,
    SessionFinished: 152,
    SessionFailed: 153,
    UsageResponse: 154,
    TaskRequest: 200,
    UpdateConfig: 201,
    TTSSentenceStart: 350,
    TTSSentenceEnd: 351,
    TTSResponse: 352,
    TTSSubtitle: 364,
    TTSEnded: 359,
};

/** 连接类事件：帧里不带 session id 段 */
const CONNECTION_EVENTS = new Set([
    EventType.StartConnection,
    EventType.FinishConnection,
    EventType.ConnectionStarted,
    EventType.ConnectionFailed,
    EventType.ConnectionFinished,
]);

/** 服务端 Connection* 响应后会多一段 connect id */
const CONNECT_ID_EVENTS = new Set([
    EventType.ConnectionStarted,
    EventType.ConnectionFailed,
    EventType.ConnectionFinished,
]);

const VERSION_V1 = 1;
const HEADER_SIZE_4 = 1; // 值 1 表示 4 字节头
const SERIALIZATION_JSON = 1;
const NO_COMPRESSION = 0;

const asBuffer = (payload) => {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload === undefined || payload === null) return Buffer.alloc(0);
    if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
    return Buffer.from(JSON.stringify(payload), 'utf8');
};

/**
 * 编码一帧。参数名与官方 protocols.py 的 Message 字段保持一致。
 *
 * @param {object} p
 * @param {number} p.type        MsgType
 * @param {number} [p.flag]      MsgTypeFlag，默认 NoSeq
 * @param {number} [p.event]     EventType
 * @param {string} [p.sessionId]
 * @param {number} [p.sequence]
 * @param {number} [p.errorCode]
 * @param {Buffer|string} [p.payload]
 * @returns {Buffer}
 */
export function encodeMessage({
    type,
    flag = MsgTypeFlag.NoSeq,
    event = 0,
    sessionId = '',
    sequence = 0,
    errorCode = 0,
    payload = Buffer.alloc(0),
} = {}) {
    const header = Buffer.alloc(4);
    header[0] = ((VERSION_V1 & 0x0f) << 4) | (HEADER_SIZE_4 & 0x0f);
    header[1] = ((type & 0x0f) << 4) | (flag & 0x0f);
    header[2] = ((SERIALIZATION_JSON & 0x0f) << 4) | (NO_COMPRESSION & 0x0f);
    header[3] = 0;

    const parts = [header];

    if (type === MsgType.Error) {
        const code = Buffer.alloc(4);
        code.writeUInt32BE(errorCode >>> 0, 0);
        parts.push(code);
    }

    if (flag === MsgTypeFlag.WithEvent) {
        const ev = Buffer.alloc(4);
        ev.writeInt32BE(event | 0, 0);
        parts.push(ev);

        if (!CONNECTION_EVENTS.has(event)) {
            const sid = Buffer.from(String(sessionId || ''), 'utf8');
            const sidLen = Buffer.alloc(4);
            sidLen.writeUInt32BE(sid.length, 0);
            parts.push(sidLen);
            if (sid.length > 0) parts.push(sid);
        }
    }

    if (flag === MsgTypeFlag.PositiveSeq || flag === MsgTypeFlag.NegativeSeq) {
        const seq = Buffer.alloc(4);
        seq.writeInt32BE(sequence | 0, 0);
        parts.push(seq);
    }

    const body = asBuffer(payload);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    parts.push(len, body);

    return Buffer.concat(parts);
}

/**
 * 解码一帧。
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @returns {{version:number, headerSize:number, type:number, flag:number, event:number,
 *            sessionId:string, connectId:string, sequence:number, errorCode:number, payload:Buffer}}
 */
export function decodeMessage(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (buf.length < 4) {
        throw new TtsError(`语音合成返回的帧过短（${buf.length} 字节）`, { code: 'BAD_FRAME' });
    }

    const version = buf[0] >> 4;
    const headerSizeBits = buf[0] & 0x0f;
    const type = buf[1] >> 4;
    const flag = buf[1] & 0x0f;

    const msg = {
        version,
        headerSize: headerSizeBits || HEADER_SIZE_4,
        type,
        flag,
        event: 0,
        sessionId: '',
        connectId: '',
        sequence: 0,
        errorCode: 0,
        payload: Buffer.alloc(0),
    };

    let offset = (msg.headerSize || 1) * 4;
    const need = (n, what) => {
        if (offset + n > buf.length) {
            throw new TtsError(`语音合成帧不完整，读取 ${what} 时越界`, { code: 'BAD_FRAME' });
        }
    };

    if (type === MsgType.Error) {
        need(4, 'error code');
        msg.errorCode = buf.readUInt32BE(offset);
        offset += 4;
    }

    if (flag === MsgTypeFlag.WithEvent) {
        need(4, 'event');
        msg.event = buf.readInt32BE(offset);
        offset += 4;

        if (!CONNECTION_EVENTS.has(msg.event)) {
            need(4, 'session id 长度');
            const sidLen = buf.readUInt32BE(offset);
            offset += 4;
            if (sidLen > 0) {
                need(sidLen, 'session id');
                msg.sessionId = buf.toString('utf8', offset, offset + sidLen);
                offset += sidLen;
            }
        }

        if (CONNECT_ID_EVENTS.has(msg.event)) {
            // 部分历史实现不带 connect id，做了长度保护
            if (offset + 4 <= buf.length) {
                const cidLen = buf.readUInt32BE(offset);
                offset += 4;
                if (cidLen > 0 && offset + cidLen <= buf.length) {
                    msg.connectId = buf.toString('utf8', offset, offset + cidLen);
                    offset += cidLen;
                }
            }
        }
    }

    if (flag === MsgTypeFlag.PositiveSeq || flag === MsgTypeFlag.NegativeSeq) {
        if (offset + 4 <= buf.length) {
            msg.sequence = buf.readInt32BE(offset);
            offset += 4;
        }
    }

    if (offset + 4 <= buf.length) {
        const payloadLen = buf.readUInt32BE(offset);
        offset += 4;
        if (payloadLen > 0) {
            const end = Math.min(offset + payloadLen, buf.length);
            msg.payload = buf.subarray(offset, end);
        }
    }

    return msg;
}

/** 失败类事件转成可读错误 */
const failureOf = (msg) => {
    const text = msg.payload?.length ? msg.payload.toString('utf8').slice(0, 300) : '';
    switch (msg.event) {
        case EventType.ConnectionFailed:
            return `语音合成连接失败（event 51）${text ? `：${text}` : ''}`;
        case EventType.SessionFailed:
            return `语音合成会话失败（event 153）${text ? `：${text}` : ''}`;
        case EventType.SessionCanceled:
            return `语音合成会话被取消（event 151）${text ? `：${text}` : ''}`;
        default:
            return '';
    }
};

/**
 * 把长文本切成适合流式送入的块。
 * 官方示例为演示时延而逐字符发送（5ms 间隔），实际使用应按标点切句，
 * 否则会产生大量小帧，反而增加往返开销。
 */
export function splitText(text, { maxChars = 60 } = {}) {
    const content = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!content) return [];

    const pieces = content.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) || [content];
    const chunks = [];
    let current = '';

    for (const piece of pieces) {
        if (current && current.length + piece.length > maxChars) {
            chunks.push(current);
            current = '';
        }
        if (piece.length > maxChars) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            for (let i = 0; i < piece.length; i += maxChars) {
                chunks.push(piece.slice(i, i + maxChars));
            }
            continue;
        }
        current += piece;
    }
    if (current) chunks.push(current);
    return chunks.filter((c) => c.trim().length > 0);
}

/**
 * 合成一段文本（双向流式）。
 *
 * @param {object} p
 * @param {string} p.text                待合成文本
 * @param {string} p.speaker             2.0 音色 ID（*_uranus_bigtts）
 * @param {string} [p.encoding]          mp3 / pcm / ogg_opus / wav，默认 mp3
 * @param {number} [p.sampleRate]        采样率，默认 24000
 * @param {number} [p.speechRate]        语速 [-50, 100]
 * @param {number} [p.loudnessRate]      音量 [-50, 100]
 * @param {boolean} [p.enableSubtitle]   返回字级时间戳（仅中英文）
 * @param {string[]} [p.contextTexts]    语音指令（如“用低沉的语气”），仅 2.0 音色，不计费
 * @param {string} [p.sectionId]         多轮上下文 id
 * @param {boolean} [p.aigcWatermark]    结尾加 AIGC 节奏标识
 * @param {string} [p.apiKey]            X-Api-Key（优先）
 * @param {string} [p.appId]             旧版鉴权
 * @param {string} [p.accessToken]       旧版鉴权
 * @param {string} [p.resourceId]
 * @param {string} [p.url]
 * @param {number} [p.timeoutMs]         整体超时，默认 120s
 * @param {(chunk: Buffer) => void} [p.onAudio] 收到音频分片时回调（可用于 SSE 边合成边推送）
 * @returns {Promise<{ buffer: Buffer, encoding: string, usage: object|null,
 *                     logid: string, sessionId: string, chunks: number }>}
 */
export async function synthesizeBidirection({
    text,
    speaker,
    encoding = 'mp3',
    sampleRate = 24000,
    speechRate,
    loudnessRate,
    enableSubtitle = false,
    contextTexts,
    sectionId,
    aigcWatermark,
    apiKey = process.env.TTS_API_KEY,
    appId = process.env.TTS_APP_ID,
    accessToken = process.env.TTS_ACCESS_TOKEN,
    resourceId = process.env.TTS_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    url = DEFAULT_URL,
    timeoutMs = 120000,
    onAudio,
} = {}) {
    if (!apiKey && (!appId || !accessToken)) {
        throw new TtsError(
            '未配置语音凭证：需要 TTS_API_KEY（新版控制台 API Key），或 TTS_APP_ID + TTS_ACCESS_TOKEN（旧版鉴权）',
            { code: 'NO_CREDENTIAL' }
        );
    }

    const content = String(text || '').trim();
    if (!content) throw new TtsError('合成文本为空', { code: 'EMPTY_TEXT' });
    if (!speaker) throw new TtsError('缺少音色 speaker', { code: 'NO_SPEAKER' });

    const audioParams = { format: encoding, sample_rate: sampleRate };
    if (Number.isFinite(Number(speechRate))) audioParams.speech_rate = Number(speechRate);
    if (Number.isFinite(Number(loudnessRate))) audioParams.loudness_rate = Number(loudnessRate);
    if (enableSubtitle) audioParams.enable_subtitle = true;

    const reqParams = { speaker, audio_params: audioParams };
    if (Array.isArray(contextTexts) && contextTexts.length) reqParams.context_texts = contextTexts;
    if (sectionId) reqParams.section_id = sectionId;
    if (aigcWatermark) reqParams.aigc_watermark = true;
    // 台词里常有 ** / # 之类的符号，默认关掉 markdown 朗读（否则会被念成“星星”）
    reqParams.disable_markdown_filter = true;

    const connectId = randomUUID();
    const sessionId = randomUUID();

    const headers = {
        ...(apiKey
            ? { 'X-Api-Key': apiKey }
            : { 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessToken }),
        'X-Api-Resource-Id': resourceId,
        'X-Api-Connect-Id': connectId,
        'X-Control-Require-Usage-Tokens-Return': '*',
    };

    const ws = new WebSocket(url, {
        headers,
        handshakeTimeout: 15000,
        maxPayload: 10 * 1024 * 1024,
    });

    /** 握手阶段就能拿到 403/401 的具体报文，是排查授权问题最有效的信息 */
    let handshakeError = null;
    ws.on('unexpected-response', (_req, res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
            const raw = Buffer.concat(parts).toString('utf8');
            let code;
            let message = raw.slice(0, 300);
            try {
                const j = JSON.parse(raw);
                code = j?.header?.code ?? j?.code ?? j?.error_code;
                message = j?.header?.message ?? j?.message ?? j?.error ?? message;
            } catch {
                /* 非 JSON 就保留原文 */
            }
            // 资源未授权时火山只回一段文本（{"error":"[resource_id=...] requested resource not granted"}），
            // 没有结构化 code，这里按文本兜底映射成 45000030，才能给出准确的开通指引
            if (code === undefined && /requested resource not granted/i.test(raw)) code = 45000030;
            handshakeError = new TtsError(
                `语音合成 WebSocket 握手失败（HTTP ${res.statusCode}，code ${code ?? '未知'}）：${message || '无返回内容'}`,
                { code, httpStatus: res.statusCode, hint: hintFor(code, res.statusCode, resourceId) }
            );
            ws.terminate();
        });
    });

    const logid = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TtsError('语音合成 WebSocket 握手超时', { code: 'TIMEOUT' })), 15000);
        ws.once('open', () => {
            clearTimeout(timer);
            resolve(ws?.upgradeReq?.headers?.['x-tt-logid'] || '');
        });
        ws.once('error', (err) => {
            clearTimeout(timer);
            reject(handshakeError || new TtsError(`连接语音合成服务失败：${err?.message || err}`, { code: 'NETWORK' }));
        });
        ws.once('unexpected-response', () => {
            clearTimeout(timer);
            // 等 body 读完再 reject
            const poll = setInterval(() => {
                if (handshakeError) {
                    clearInterval(poll);
                    reject(handshakeError);
                }
            }, 30);
            setInterval(() => clearInterval(poll), 5000).unref?.();
        });
    });

    /** 收件箱：把收到的帧排队，waitEvent 按事件号取 */
    const inbox = [];
    const waiters = [];
    let closed = false;
    let socketError = null;

    const flushWaiters = () => {
        while (waiters.length && inbox.length) {
            waiters.shift()(inbox.shift());
        }
    };

    ws.on('message', (data) => {
        let msg;
        try {
            msg = decodeMessage(data);
        } catch (err) {
            socketError = err;
            ws.terminate();
            return;
        }
        if (msg.type === MsgType.Error) {
            const body = msg.payload?.length ? msg.payload.toString('utf8').slice(0, 300) : '';
            socketError = new TtsError(
                `语音合成失败（错误码 ${msg.errorCode}，event ${msg.event}）：${body || '无返回内容'}`,
                { code: msg.errorCode, hint: hintFor(msg.errorCode, undefined, resourceId) }
            );
            ws.terminate();
            return;
        }
        const failure = failureOf(msg);
        if (failure) {
            socketError = new TtsError(failure, { code: msg.event });
            ws.terminate();
            return;
        }
        inbox.push(msg);
        flushWaiters();
    });

    ws.on('close', () => {
        closed = true;
        flushWaiters();
    });

    const nextMessage = () => new Promise((resolve, reject) => {
        if (socketError) return reject(socketError);
        if (inbox.length) return resolve(inbox.shift());
        if (closed) return reject(new TtsError('语音合成连接已关闭', { code: 'CLOSED' }));
        const timer = setTimeout(() => reject(new TtsError('等待语音合成响应超时', { code: 'TIMEOUT' })), timeoutMs);
        waiters.push((msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
    });

    const waitEvent = async (event, label) => {
        for (;;) {
            const msg = await nextMessage();
            if (msg.event === event) return msg;
            // 句子边界事件不打断主循环，交给下面的接收循环处理
            if (msg.event === EventType.TTSSentenceStart || msg.event === EventType.TTSSentenceEnd
                || msg.event === EventType.TTSResponse) {
                inbox.unshift(msg);
                throw new TtsError(`等待 ${label} 时收到其他事件（event ${msg.event}）`, { code: 'UNEXPECTED_EVENT' });
            }
        }
    };

    const send = (buf) => new Promise((resolve, reject) => {
        ws.send(buf, (err) => (err ? reject(err) : resolve()));
    });

    const audioParts = [];
    let usage = null;

    try {
        // 1. 建连
        await send(encodeMessage({
            type: MsgType.FullClientRequest,
            flag: MsgTypeFlag.WithEvent,
            event: EventType.StartConnection,
            payload: Buffer.from('{}'),
        }));
        await waitEvent(EventType.ConnectionStarted, 'ConnectionStarted');

        // 2. 开会话（speaker 与 audio_params 在此声明）
        await send(encodeMessage({
            type: MsgType.FullClientRequest,
            flag: MsgTypeFlag.WithEvent,
            event: EventType.StartSession,
            sessionId,
            payload: JSON.stringify({ event: EventType.StartSession, req_params: reqParams }),
        }));
        await waitEvent(EventType.SessionStarted, 'SessionStarted');

        // 3. 文本分块送入（与接收并发，避免背压死锁）
        const chunks = splitText(content);
        const sender = (async () => {
            for (const chunk of chunks) {
                await send(encodeMessage({
                    type: MsgType.FullClientRequest,
                    flag: MsgTypeFlag.WithEvent,
                    event: EventType.TaskRequest,
                    sessionId,
                    payload: JSON.stringify({
                        event: EventType.TaskRequest,
                        req_params: { ...reqParams, text: chunk },
                    }),
                }));
            }
            await send(encodeMessage({
                type: MsgType.FullClientRequest,
                flag: MsgTypeFlag.WithEvent,
                event: EventType.FinishSession,
                sessionId,
                payload: Buffer.from('{}'),
            }));
        })();

        // 4. 收音频，直到 SessionFinished
        for (;;) {
            const msg = await nextMessage();
            if (msg.type === MsgType.AudioOnlyServer || msg.event === EventType.TTSResponse) {
                if (msg.payload?.length) {
                    audioParts.push(Buffer.from(msg.payload));
                    if (onAudio) {
                        try {
                            onAudio(msg.payload);
                        } catch {
                            /* 回调异常不影响主流程 */
                        }
                    }
                }
                continue;
            }
            if (msg.event === EventType.SessionFinished) {
                if (msg.payload?.length) {
                    try {
                        usage = JSON.parse(msg.payload.toString('utf8'));
                    } catch {
                        usage = null;
                    }
                }
                break;
            }
        }

        await sender;
    } finally {
        // 5. 收尾：即使中途失败也尽量优雅关闭
        try {
            if (!closed) {
                await send(encodeMessage({
                    type: MsgType.FullClientRequest,
                    flag: MsgTypeFlag.WithEvent,
                    event: EventType.FinishConnection,
                    payload: Buffer.from('{}'),
                }));
                const waitClose = new Promise((resolve) => {
                    const timer = setTimeout(resolve, 3000);
                    ws.once('close', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
                await waitClose;
            }
        } catch {
            /* 忽略收尾错误 */
        }
        try {
            ws.close();
        } catch {
            /* 忽略 */
        }
    }

    if (!audioParts.length) {
        throw new TtsError('语音合成未返回音频数据', { code: 'NO_AUDIO', hint: hintFor(undefined, 200, resourceId) });
    }

    return {
        buffer: Buffer.concat(audioParts),
        encoding,
        usage,
        logid,
        sessionId,
        chunks: splitText(content).length,
    };
}

/** 常见失败码的可执行提示 */
function hintFor(code, httpStatus, resourceId) {
    const n = Number(code);
    if (n === 45000030 || n === 3001) {
        return `资源未授权（resource_id=${resourceId}）。请在火山引擎「语音技术 → 语音合成 2.0」完成开通，`
            + '并确认该能力已绑定到当前 AppID；新开通通常需数分钟生效。';
    }
    if (n === 45000000) {
        return `当前应用不支持该 Resource ID（resource_id=${resourceId}），请确认控制台开通的是语音合成 2.0。`;
    }
    if (httpStatus === 401 || httpStatus === 403) {
        return '鉴权未通过：请确认 X-Api-Key 属于「语音技术」控制台，或 AppID 已开通语音合成能力。';
    }
    return '';
}

export default { synthesizeBidirection, encodeMessage, decodeMessage, splitText, EventType, MsgType, MsgTypeFlag };
