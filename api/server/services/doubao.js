/**
 * doubao.js
 *
 * 火山方舟（豆包）Seedance 视频生成服务。
 * 支持文生视频 + 图生视频。
 *
 * API 文档: POST /contents/generations/tasks + GET /contents/generations/tasks/{id}
 */

const SEEDANCE_BASE_URL = process.env.SEEDANCE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const SEEDANCE_MODEL_ID = process.env.SEEDANCE_MODEL_ID || 'doubao-seedance-2-0-260128';
const POLL_INTERVAL = parseInt(process.env.SEEDANCE_POLL_INTERVAL || '10') * 1000;
const MAX_WAIT = parseInt(process.env.SEEDANCE_MAX_WAIT || '600') * 1000;

// 各 Seedance 模型支持的输出分辨率（火山方舟官方文档）：
// 标准版支持 480p/720p/1080p/4k；fast / mini 仅支持 480p/720p（不支持 1080p）。
const SEEDANCE_MODEL_RESOLUTIONS = {
    'doubao-seedance-2-0-260128': ['480p', '720p', '1080p'],
    'doubao-seedance-2-0-fast-260128': ['480p', '720p'],
    'doubao-seedance-2-0-mini-260615': ['480p', '720p'],
    'doubao-seedance-2-5-260628': ['480p', '720p', '1080p'],
};

/**
 * 各 Seedance 模型「多模态参考生视频」的图片数量上限（火山方舟官方文档）：
 *  - Seedance 2.0 系列（含 fast / mini）：1~9 张
 *  - Seedance 2.5 系列：1~30 张
 * 超过上限方舟会直接报参数错误，这里提前拦截并给出可读提示。
 */
const SEEDANCE_MODEL_MAX_REFERENCE_IMAGES = {
    'doubao-seedance-2-0-260128': 9,
    'doubao-seedance-2-0-fast-260128': 9,
    'doubao-seedance-2-0-mini-260615': 9,
    'doubao-seedance-2-5-260628': 30,
};

/**
 * 查询模型支持的多参考图上限。
 * @param {string} [modelId] 缺省时用 SEEDANCE_MODEL_ID
 * @returns {number} 未知模型按 2.0 系列保守处理
 */
export function getMaxReferenceImages(modelId) {
    return SEEDANCE_MODEL_MAX_REFERENCE_IMAGES[modelId || SEEDANCE_MODEL_ID] ?? 9;
}

// 校验并规范化 resolution，非法值一律降级为 720p，避免触发 API 参数错误
function sanitizeResolution(modelId, resolution) {
    const supported = SEEDANCE_MODEL_RESOLUTIONS[modelId] || ['480p', '720p', '1080p'];
    const res = String(resolution || '720p').toLowerCase();
    return supported.includes(res) ? res : '720p';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的 fetch。
 * Node 原生 fetch 默认无超时，网络挂起时请求可能长时间不返回；
 * 另外原始错误只有 "fetch failed"，真实原因（ECONNRESET / ETIMEDOUT / ENOTFOUND）藏在 error.cause 里，
 * 这里把它拼进 message，前端与终端日志都能直接看到。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        const cause = error?.cause;
        const detail = cause?.code || cause?.message
            || (error?.name === 'AbortError' ? `请求超时(${timeoutMs}ms)` : '');
        const msg = detail ? `${error.message} (${detail})` : error.message;
        throw new Error(msg);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 组装 Seedance 请求的 content 数组（纯函数，便于单测）。
 *
 * Seedance 三种图片模式互斥，不能在同一请求混用 first_frame/last_frame 与 reference_image：
 *   - 有尾帧：首尾帧模式（first_frame + last_frame），忽略参考图
 *   - 有多张参考图：多模态参考模式，全部用 reference_image（首帧也并入，不再单独当 first_frame）
 *   - 仅有首帧：首帧图生视频（first_frame）
 * 注意：role 是 content 项的字段，必须与 type、image_url 同级。
 * 旧实现把 role 放进 image_url 对象内部，方舟会将其识别为缺失，返回：
 * "The parameter 'content' specified in the request is not valid: role must be specified for image contents."
 *
 * @param {object} options
 * @param {string} [options.prompt]
 * @param {string} [options.imageBase64]
 * @param {string} [options.lastFrameBase64]
 * @param {string[]} [options.referenceImages]
 * @param {string} [options.modelId]
 * @returns {Array<object>} content 数组
 * @throws {Error} 参考图数量超过模型上限时抛出（message 可直接展示给用户）
 */
export function buildSeedanceContent({ prompt, imageBase64, lastFrameBase64, referenceImages, modelId }) {
    const content = [];
    if (prompt) {
        content.push({ type: 'text', text: prompt });
    }

    // 收集去重后的多参考图（角色 / 物体 / 风格等）
    const refs = Array.isArray(referenceImages)
        ? Array.from(new Set(referenceImages.filter(Boolean)))
        : [];

    if (lastFrameBase64 && imageBase64) {
        content.push({ type: 'image_url', image_url: { url: imageBase64 }, role: 'first_frame' });
        content.push({ type: 'image_url', image_url: { url: lastFrameBase64 }, role: 'last_frame' });
    } else if (refs.length > 0) {
        // 若同时给了单独首帧，将其并入参考图列表头部，保证所有图 role 一致
        const allRefs = imageBase64 ? Array.from(new Set([imageBase64, ...refs])) : refs;
        const maxRefs = getMaxReferenceImages(modelId);
        if (allRefs.length > maxRefs) {
            throw new Error(
                `参考图 ${allRefs.length} 张，超过模型 ${modelId || SEEDANCE_MODEL_ID} 的上限 ${maxRefs} 张` +
                `（Seedance 2.0 系列最多 9 张，2.5 系列最多 30 张）`
            );
        }
        allRefs.forEach((url) => {
            content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
        });
    } else if (imageBase64) {
        content.push({ type: 'image_url', image_url: { url: imageBase64 }, role: 'first_frame' });
    }

    return content;
}

/**
 * 创建 Seedance 视频生成任务（导出供异步提交接口使用）
 */
export async function createSeedanceTask({ prompt, imageBase64, lastFrameBase64, referenceImages, duration, resolution, ratio, generateAudio, apiKey, modelId }) {
    const content = buildSeedanceContent({ prompt, imageBase64, lastFrameBase64, referenceImages, modelId });

    const payload = {
        model: modelId || SEEDANCE_MODEL_ID,
        content,
        duration: duration || 5,
        resolution: sanitizeResolution(modelId || SEEDANCE_MODEL_ID, resolution),
        ratio: ratio || '16:9',
        generate_audio: generateAudio !== false,
        watermark: false,
    };

    // 排查用：只打印内容类型与 role，不打印图片内容，方便确认请求结构是否符合方舟要求
    console.log(
        `[Seedance] model=${payload.model} res=${payload.resolution} ratio=${payload.ratio} duration=${payload.duration}s content=[${content
            .map((c) => (c.type === 'text' ? 'text' : `${c.type}(role=${c.role || 'MISSING'})`))
            .join(', ')}]`
    );

    // 创建任务请求体含 base64 参考图，可能较大，超时放宽到 2 分钟
    const resp = await fetchWithTimeout(`${SEEDANCE_BASE_URL}/contents/generations/tasks`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    }, 120000);

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Seedance 创建任务失败: ${text}`);
    }

    const data = await resp.json();
    return data.id;
}

/**
 * 单次查询 Seedance 任务状态（不循环、不重试）。
 * 供异步提交接口逐个轮询使用，避免一个任务长时间占用一个 HTTP 请求。
 * @returns {Promise<{ status: 'running'|'succeeded'|'failed', videoUrl?: string, error?: string, rawStatus?: string }>}
 */
export async function querySeedanceTask(taskId, apiKey) {
    const resp = await fetchWithTimeout(`${SEEDANCE_BASE_URL}/contents/generations/tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 30000);

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Seedance 查询任务失败: ${text}`);
    }

    let data;
    try {
        data = await resp.json();
    } catch (e) {
        throw new Error(`Seedance 读取轮询结果失败: ${e.message}`);
    }

    if (data.status === 'succeeded') {
        return { status: 'succeeded', videoUrl: data.content?.video_url || data.video_url };
    }

    if (data.status === 'failed' || data.status === 'cancelled') {
        return {
            status: 'failed',
            error: `Seedance 任务失败 (${data.status}): ${JSON.stringify(data.error || data)}`,
        };
    }

    return { status: 'running', rawStatus: data.status };
}

/**
 * 轮询 Seedance 任务直到完成（同步接口内部使用）
 */
async function pollTask(taskId, apiKey) {
    const start = Date.now();
    let pollCount = 0;
    // 轮询是幂等 GET：偶发网络抖动不能直接判死，连续 3 次失败才放弃
    let consecutiveErrors = 0;

    while (Date.now() - start < MAX_WAIT) {
        pollCount++;
        const elapsedSec = Math.round((Date.now() - start) / 1000);

        let result;
        try {
            result = await querySeedanceTask(taskId, apiKey);
            consecutiveErrors = 0;
        } catch (e) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 3) {
                throw new Error(`Seedance 轮询连续失败(${consecutiveErrors}次): ${e.message}`);
            }
            console.warn(`[Seedance] 轮询网络异常（${consecutiveErrors}/3），稍后重试: ${e.message}`);
            await sleep(POLL_INTERVAL);
            continue;
        }

        if (result.status === 'succeeded') {
            return result.videoUrl;
        }

        if (result.status === 'failed') {
            throw new Error(result.error || 'Seedance 任务失败');
        }

        // 打印轮询进度，便于排查任务卡在排队还是生成中
        console.log(`[Seedance] 任务 ${taskId} 第 ${pollCount} 次轮询 (已等待 ${elapsedSec}s): ${result.rawStatus || 'running'}`);

        await sleep(POLL_INTERVAL);
    }

    throw new Error(`Seedance 任务超时 (超过 ${Math.round(MAX_WAIT / 1000)}s)`);
}

/**
 * 生成 Seedance 视频（文生视频 / 图生视频）
 */
export async function generateSeedanceVideo({ prompt, imageBase64, lastFrameBase64, referenceImages, duration, resolution, ratio, generateAudio = true, apiKey, modelId }) {
    if (!apiKey) {
        throw new Error('SEEDANCE_API_KEY 未配置');
    }

    const taskId = await createSeedanceTask({ prompt, imageBase64, lastFrameBase64, referenceImages, duration, resolution, ratio, generateAudio, apiKey, modelId });
    console.log(`[Seedance] 任务已创建: ${taskId}`);

    const videoUrl = await pollTask(taskId, apiKey);
    console.log(`[Seedance] 任务完成: ${videoUrl}`);

    return videoUrl;
}

// ============================================================================
// SEEDREAM (图片生成) CONFIGURATION
// ============================================================================

const SEEDREAM_BASE_URL = process.env.SEEDREAM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const SEEDREAM_MODEL_ID = process.env.SEEDREAM_MODEL_ID || 'ep-20260804162342-5vczp';

function mapAspectRatioToSize(aspectRatio) {
    // Seedream 5.0 Pro 普通生图自定义宽高像素的面积上限为 4,624,220 像素（约 462 万），
    // 宽高比范围 [1/16, 16]。以下尺寸均控制在该限制内，并保持 8 像素对齐。
    const sizeMap = {
        '1:1': '2048x2048',   // 4,194,304
        '16:9': '2816x1584',  // 4,460,544
        '9:16': '1584x2816',  // 4,460,544
        '3:4': '1848x2464',   // 4,553,472
        '4:3': '2464x1848',   // 4,553,472
        '3:2': '2592x1728',   // 4,478,976
        '2:3': '1728x2592',   // 4,478,976
        'Auto': '2048x2048',  // 4,194,304
    };
    return sizeMap[aspectRatio] || '2048x2048';
}

export async function generateSeedreamImage({ prompt, aspectRatio, imageBase64, apiKey, modelId }) {
    if (!apiKey) {
        throw new Error('SEEDREAM_API_KEY 未配置');
    }

    const size = mapAspectRatioToSize(aspectRatio);
    const payload = {
        model: modelId || SEEDREAM_MODEL_ID,
        prompt,
        size,
        response_format: 'url',
        n: 1,
        // 关闭方舟默认添加的「AI 生成」水印
        watermark: false,
    };

    // 多参考图（图生图）：火山方舟 Seedream 支持 image 数组（URL 或 base64 data URI），
    // Seedream 5.0 Pro 最多 10 张；单张也统一走数组。无参考图时按文生图处理。
    const refImages = Array.isArray(imageBase64)
        ? imageBase64.filter(Boolean)
        : (imageBase64 ? [imageBase64] : []);
    if (refImages.length > 0) {
        payload.image = refImages.slice(0, 10);
        console.log(`[Seedream] 生成图片（参考图 ${payload.image.length} 张）: ${size}`);
    } else {
        console.log(`[Seedream] 生成图片（文生图）: ${size}`);
    }

    const resp = await fetch(`${SEEDREAM_BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Seedream 生成失败: ${text}`);
    }

    const data = await resp.json();
    const url = data.data?.[0]?.url;
    if (!url) {
        throw new Error(`Seedream 返回无图片: ${JSON.stringify(data)}`);
    }

    console.log(`[Seedream] 生成完成: ${url}`);
    return url;
}

export default { generateSeedanceVideo, generateSeedreamImage };
