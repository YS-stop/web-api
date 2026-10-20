/**
 * ffmpeg.js
 *
 * ffmpeg / ffprobe 调用的统一封装。
 *
 * 本项目原先在 index.js 与 tools/tiktok.js 中各自 spawn ffmpeg，
 * 这里抽出一份共用实现，供裁剪、拼接、探测复用。
 *
 * 设计要点：
 *   1. Windows 下 ffmpeg 常不在 PATH 的裸命令里，统一用 shell: true；
 *   2. 错误信息必须带 stderr 尾部，否则排查极难；
 *   3. 所有调用返回 Promise，失败 reject Error。
 */

import { spawn } from 'child_process';

// ============================================================================
// 可用性探测
// ============================================================================

let availabilityCache = null;

/**
 * 检查系统是否安装了 ffmpeg。
 * 结果会缓存，避免每次请求都 spawn 一次。
 * @returns {Promise<boolean>}
 */
export async function isFFmpegAvailable() {
    if (availabilityCache !== null) return availabilityCache;
    availabilityCache = await new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
    return availabilityCache;
}

/**
 * 检查系统是否安装了 ffprobe。
 * @returns {Promise<boolean>}
 */
export async function isFFprobeAvailable() {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-version'], { shell: true });
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

// ============================================================================
// 底层执行
// ============================================================================

/**
 * 执行一条 ffmpeg 命令。
 * @param {string[]} args 参数数组（不含 'ffmpeg' 本身）
 * @param {object} [opts]
 * @param {string} [opts.bin='ffmpeg'] 可执行文件名，可为 'ffprobe'
 * @param {number} [opts.timeoutMs] 超时毫秒数，超时会 kill 进程
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
/**
 * 为 shell 模式转义单个参数。
 *
 * 为什么必须做：Windows 下 `shell: true` 会把参数数组拼成一条字符串再交给 cmd，
 * 路径含空格（本项目路径就是 `Video Workflow`）时会被空格截断，
 * 表现为 ffprobe 报「文件不存在」。统一用双引号包裹并转义内部双引号。
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteArg(arg) {
    const s = String(arg);
    // 不含空格和 shell 元字符时不必加引号，保持命令可读性
    if (!/[\s"'&|<>^()]/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
}

export function runFFmpeg(args, opts = {}) {
    const { bin = 'ffmpeg', timeoutMs } = opts;

    // shell 模式下必须自行转义，否则含空格路径会被截断
    const safeArgs = Array.isArray(args) ? args.map(quoteArg) : args;

    return new Promise((resolve, reject) => {
        const proc = spawn(bin, safeArgs, { shell: true });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;

        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                reject(new Error(`${bin} 超时（${timeoutMs}ms）`));
            }, timeoutMs);
        }

        proc.stdout?.on('data', (d) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (code === 0) return resolve({ stdout, stderr });
            reject(new Error(`${bin} 失败（exit ${code}）：${stderr.slice(-800)}`));
        });

        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            reject(new Error(`${bin} 启动失败：${err.message}`));
        });
    });
}

// ============================================================================
// 媒体探测
// ============================================================================

/**
 * 用 ffprobe 探测单个媒体文件的规格。
 *
 * 返回字段刻意与「拼接归一化」所需参数对齐：
 *   width / height / fps / codec / pixFmt / sar / hasAudio /
 *   audioSampleRate / audioChannels / duration
 *
 * @param {string} filePath 绝对路径
 * @returns {Promise<object|null>} 探测失败返回 null
 */
export async function probeMedia(filePath) {
    const args = [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
    ];

    let parsed;
    try {
        const { stdout } = await runFFmpeg(args, { bin: 'ffprobe', timeoutMs: 30000 });
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }

    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    if (!video) return null;

    return {
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        fps: parseFps(video.r_frame_rate || video.avg_frame_rate),
        codec: video.codec_name || '',
        pixFmt: video.pix_fmt || '',
        sar: video.sample_aspect_ratio && video.sample_aspect_ratio !== '0:1'
            ? video.sample_aspect_ratio
            : '1:1',
        hasAudio: !!audio,
        audioSampleRate: audio ? Number(audio.sample_rate) || 0 : 0,
        audioChannels: audio ? Number(audio.channels) || 0 : 0,
        duration: Number(parsed?.format?.duration) || Number(video.duration) || 0,
        bitrate: Number(parsed?.format?.bit_rate) || 0,
        size: Number(parsed?.format?.size) || 0,
    };
}

/**
 * 解析 ffprobe 的帧率字符串（形如 "30000/1001"）为数字。
 * @param {string} rate
 * @returns {number}
 */
export function parseFps(rate) {
    if (!rate || typeof rate !== 'string') return 0;
    const [num, den] = rate.split('/').map(Number);
    if (!den) return num || 0;
    return den === 0 ? 0 : num / den;
}

/**
 * 把浮点帧率规整成 ffmpeg 可用的分数形式，避免 29.97 之类精度漂移。
 * @param {number} fps
 * @returns {string}
 */
export function fpsToFraction(fps) {
    if (!fps || fps <= 0) return '30';
    const common = [
        [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1],
        [48, 1], [50, 1], [60000, 1001], [60, 1], [120, 1],
    ];
    for (const [n, d] of common) {
        if (Math.abs(n / d - fps) < 0.02) return `${n}/${d}`;
    }
    return String(Math.round(fps));
}

// ============================================================================
// 输出规格推断
// ============================================================================

/**
 * 从一组探测结果中推断统一的输出规格。
 *
 * 策略：
 *   - 分辨率取「出现次数最多的宽高」，并列时取面积最大的（宁可大不要糊）；
 *   - 帧率取众数，并列取最高；
 *   - 像素格式与采样率固定为兼容性最好的值。
 *
 * @param {object[]} probes probeMedia 的结果数组
 * @returns {{width:number,height:number,fps:number,pixFmt:string,sampleRate:number,channels:number}}
 */
export function inferOutputSpec(probes) {
    const valid = probes.filter(Boolean);

    // 分辨率众数
    const sizeCount = new Map();
    for (const p of valid) {
        if (!p.width || !p.height) continue;
        const key = `${p.width}x${p.height}`;
        const cur = sizeCount.get(key) || { count: 0, width: p.width, height: p.height };
        cur.count += 1;
        sizeCount.set(key, cur);
    }
    let bestSize = { count: 0, width: 1280, height: 720 };
    for (const v of sizeCount.values()) {
        if (v.count > bestSize.count
            || (v.count === bestSize.count && v.width * v.height > bestSize.width * bestSize.height)) {
            bestSize = v;
        }
    }

    // 帧率众数
    const fpsCount = new Map();
    for (const p of valid) {
        if (!p.fps) continue;
        const key = p.fps.toFixed(2);
        fpsCount.set(key, (fpsCount.get(key) || 0) + 1);
    }
    let bestFps = 30;
    let bestFpsCount = 0;
    for (const [key, count] of fpsCount) {
        const value = Number(key);
        if (count > bestFpsCount || (count === bestFpsCount && value > bestFps)) {
            bestFps = value;
            bestFpsCount = count;
        }
    }

    // 音频采样率：优先 48000，其次取众数
    const rateCount = new Map();
    for (const p of valid) {
        if (!p.hasAudio || !p.audioSampleRate) continue;
        rateCount.set(p.audioSampleRate, (rateCount.get(p.audioSampleRate) || 0) + 1);
    }
    let sampleRate = 48000;
    let rateCountBest = 0;
    for (const [rate, count] of rateCount) {
        if (count > rateCountBest) {
            sampleRate = rate;
            rateCountBest = count;
        }
    }

    // 声道：任一片段为立体声即用立体声
    const channels = valid.some((p) => p.audioChannels >= 2) ? 2 : 1;

    return {
        width: bestSize.width,
        height: bestSize.height,
        fps: bestFps,
        pixFmt: 'yuv420p',
        sampleRate,
        channels,
    };
}

/**
 * 判断一组探测结果是否「规格完全一致」，可用于 -c copy 无损拼接。
 * @param {object[]} probes
 * @returns {boolean}
 */
export function isSpecUniform(probes) {
    const valid = probes.filter(Boolean);
    if (valid.length < 2) return true;

    const first = valid[0];
    return valid.every((p) =>
        p.width === first.width
        && p.height === first.height
        && Math.abs(p.fps - first.fps) < 0.02
        && p.codec === first.codec
        && p.pixFmt === first.pixFmt
        && p.hasAudio === first.hasAudio
        && (!p.hasAudio || (p.audioSampleRate === first.audioSampleRate
            && p.audioChannels === first.audioChannels))
    );
}
