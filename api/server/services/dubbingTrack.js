/**
 * dubbingTrack.js
 *
 * 「整集配音音轨」合成：把已按角色分好音色的台词逐条合成 TTS，拼成一条 mp3，
 * 落到 library/audio/，供成片合并（videoMerge 的 audioMode='tts'）直接引用。
 *
 * 为什么需要它：
 *   配音面板产出的音频是浏览器里的 data URL，videoMerge 的输入解析只认
 *   本地文件 / /library 相对地址 / http(s) 地址，遇到 data: 一律报
 *   「无法定位片段文件」；而且成片只需要一条音轨，逐条留在 localStorage 也不现实。
 *
 * 音色同步（本文件的核心设计）：
 *   输出文件名带「内容指纹」，指纹包含每条台词的文本、音色、风格提示词、音量语速。
 *     · 资产里的音色一改 → 指纹变 → 文件名变 → 必然重新合成；
 *     · 内容没变 → 命中同指纹文件 → 直接复用，不重复消耗 TTS 额度。
 *   这样「资产音色改变，视频音色同步改变」不依赖任何人工清理缓存。
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { synthesize } from './tts.js';
import { runFFmpeg, isFFmpegAvailable } from '../utils/ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 与 index.js 的 `/library` 静态映射保持一致：<repo>/library */
const LIBRARY_DIR = path.join(__dirname, '..', '..', 'library');
const AUDIO_DIR = path.join(LIBRARY_DIR, 'audio');

/** 单次合成请求的台词上限，防止一次误传整本剧本 */
const MAX_LINES = 200;
/** 单条台词最大字数，超长截断（避免单条把额度打光） */
const MAX_LINE_CHARS = 400;

const clamp = (n, min, max, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
};

/**
 * 归一化台词列表：去空行、截断超长文本、补齐音色字段。
 * 返回的每一项都只保留参与「合成 + 指纹」的字段，避免调用方塞进来的
 * UI 字段（id、audioUrl…）污染指纹。
 *
 * @param {Array<{role?: string, text?: string, voice?: string, contextTexts?: string[]}>} lines
 * @returns {Array<{role: string, text: string, voice: string, contextTexts: string[]}>}
 */
export function normalizeDubbingLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines
        .map((line) => {
            const text = String(line?.text || '').trim().slice(0, MAX_LINE_CHARS);
            const voice = String(line?.voice || '').trim();
            const contextTexts = Array.isArray(line?.contextTexts)
                ? line.contextTexts.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4)
                : [];
            return {
                role: String(line?.role || '旁白').trim() || '旁白',
                text,
                voice,
                contextTexts,
            };
        })
        .filter((line) => line.text.length > 0)
        .slice(0, MAX_LINES);
}

/**
 * 内容指纹：文本 + 音色 + 风格指令 + 音量语速 + 集号。
 *
 * 只用 sha1 前 12 位，够区分内容，又不会让文件名长得没法看。
 * 任意一项变化都会产生新指纹，这就是「音色改了必须重生成」的机制。
 *
 * @param {{episode?: number, volume?: number, speed?: number, lines: Array<object>}} p
 * @returns {string}
 */
export function fingerprintOf({ episode = 0, volume = 1, speed = 1, lines = [] }) {
    const payload = JSON.stringify({
        episode: Number(episode) || 0,
        volume: Number(volume) || 1,
        speed: Number(speed) || 1,
        lines: normalizeDubbingLines(lines).map((l) => [l.role, l.text, l.voice, l.contextTexts]),
    });
    return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

/** 输出文件名：dub_ep01_<指纹>.mp3；不带集号时省略集号段 */
const trackFileName = (episode, fingerprint) => {
    const epNum = Number(episode) || 0;
    const epTag = epNum > 0 ? `ep${String(epNum).padStart(2, '0')}_` : '';
    return `dub_${epTag}${fingerprint}.mp3`;
};

/**
 * 探测音频时长。
 *
 * 不能复用 utils/ffmpeg.js 的 probeMedia：它要求存在 video stream，
 * 纯音频文件会直接返回 null（那边是给视频合并用的）。
 *
 * @param {string} filePath
 * @returns {Promise<number>} 秒；探测失败返回 0
 */
async function probeAudioDuration(filePath) {
    try {
        const { stdout } = await runFFmpeg(
            ['-v', 'error', '-print_format', 'json', '-show_format', filePath],
            { bin: 'ffprobe', timeoutMs: 30000 }
        );
        const duration = Number(JSON.parse(stdout)?.format?.duration);
        return Number.isFinite(duration) ? duration : 0;
    } catch {
        return 0;
    }
}

/**
 * 用 ffmpeg concat 把多段 mp3 拼成一条。
 *
 * 必须重编码而不是 -c copy：不同音色 / 不同语速合成出来的 mp3 头信息可能不一致，
 * 直接 copy 拼接会在段边界产生爆音或时长错乱。统一重采样到 44.1k 立体声，
 * 后续与视频音轨混流也更省心。
 *
 * @param {string[]} inputPaths
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function concatAudio(inputPaths, outputPath) {
    if (inputPaths.length === 1) {
        await fsp.copyFile(inputPaths[0], outputPath);
        return;
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dubtrack-'));
    try {
        const listPath = path.join(tempDir, 'list.txt');
        // concat demuxer 的路径分隔符必须转义单引号，Windows 反斜杠用正斜杠更稳
        const listBody = inputPaths
            .map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
            .join('\n');
        await fsp.writeFile(listPath, listBody, 'utf8');

        await runFFmpeg(
            [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', listPath,
                '-c:a', 'libmp3lame',
                '-q:a', '4',
                '-ar', '44100',
                '-ac', '2',
                '-movflags', '+faststart',
                outputPath,
            ],
            { timeoutMs: 5 * 60 * 1000 }
        );
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * 合成整集配音音轨。
 *
 * @param {object} p
 * @param {number} [p.episode]        集号，仅用于命名与指纹
 * @param {Array} p.lines             台词列表，每项 { role, text, voice, contextTexts }
 * @param {number} [p.volume]         音量倍率 0.1~3
 * @param {number} [p.speed]          语速倍率 0.2~3
 * @param {boolean} [p.force]         true 时忽略已存在的同指纹文件，强制重合成
 * @returns {Promise<object>} { url, duration, fingerprint, cached, fileName, lineCount, failed }
 */
export async function buildDubbingTrack({
    episode = 0,
    lines,
    volume = 1,
    speed = 1,
    force = false,
} = {}) {
    const usable = normalizeDubbingLines(lines);
    if (usable.length === 0) {
        throw new Error('没有可合成的台词：请先在配音面板填写台词并分配角色');
    }
    if (usable.some((l) => !l.voice)) {
        const missing = usable.filter((l) => !l.voice).map((l) => l.role);
        throw new Error(`以下台词缺少音色：${[...new Set(missing)].join('、')}`);
    }

    const useVolume = clamp(volume, 0.1, 3, 1);
    const useSpeed = clamp(speed, 0.2, 3, 1);
    const fingerprint = fingerprintOf({ episode, volume: useVolume, speed: useSpeed, lines: usable });
    const fileName = trackFileName(episode, fingerprint);
    const outputPath = path.join(AUDIO_DIR, fileName);
    const url = `/library/audio/${fileName}`;

    await fsp.mkdir(AUDIO_DIR, { recursive: true });

    // 命中同指纹缓存：内容与音色都没变，直接复用，不重复计费
    if (!force && fs.existsSync(outputPath)) {
        const stat = await fsp.stat(outputPath);
        if (stat.size > 0) {
            return {
                url,
                duration: await probeAudioDuration(outputPath),
                fingerprint,
                cached: true,
                fileName,
                lineCount: usable.length,
                failed: [],
            };
        }
    }

    if (!(await isFFmpegAvailable())) {
        throw new Error('服务器未安装 ffmpeg，无法拼接配音音轨');
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dubseg-'));
    const segmentPaths = [];
    const failed = [];

    try {
        // 串行合成：TTS 有 QPS 限制，并发容易整批失败
        for (let i = 0; i < usable.length; i += 1) {
            const line = usable[i];
            try {
                // eslint-disable-next-line no-await-in-loop
                const { buffer } = await synthesize({
                    text: line.text,
                    voice: line.voice,
                    volume: useVolume,
                    speed: useSpeed,
                    contextTexts: line.contextTexts.length ? line.contextTexts : undefined,
                    encoding: 'mp3',
                });
                const segPath = path.join(tempDir, `seg_${String(i).padStart(3, '0')}.mp3`);
                // eslint-disable-next-line no-await-in-loop
                await fsp.writeFile(segPath, buffer);
                segmentPaths.push(segPath);
            } catch (error) {
                // 单条失败不中断整集：记录后继续，最后在响应里明确告知
                failed.push({
                    index: i,
                    role: line.role,
                    preview: line.text.slice(0, 20),
                    reason: error?.message || '合成失败',
                });
            }
        }

        if (segmentPaths.length === 0) {
            const reason = failed[0]?.reason || '未知原因';
            throw new Error(`全部台词合成失败：${reason}`);
        }

        await concatAudio(segmentPaths, outputPath);

        return {
            url,
            duration: await probeAudioDuration(outputPath),
            fingerprint,
            cached: false,
            fileName,
            lineCount: usable.length,
            failed,
        };
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

export default { buildDubbingTrack, fingerprintOf, normalizeDubbingLines };
