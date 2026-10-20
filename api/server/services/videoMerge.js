/**
 * videoMerge.js
 *
 * 视频与视频拼接（成片）服务。
 *
 * 三种模式：
 *   - fast     规格完全一致 → concat demuxer + -c copy，秒级、无损
 *   - xfade    需要转场 → filter_complex xfade 链，逐段归一化后交叉淡化
 *   - concat   规格不一致但不要转场 → filter_complex concat，一次重编码
 *
 * 音轨策略（audioMode）：
 *   - tts    用外部音频（整集 TTS 配音）覆盖，自动 apad 对齐视频长度
 *   - keep   保留各片段原音轨（有转场时用 acrossfade 对齐，无转场时 concat）
 *   - mute   丢弃音轨
 *
 * 关键实现细节（踩坑点）：
 *   1. xfade 要求输入同分辨率、同帧率、同像素格式、同时间基，
 *      因此每段必须先 scale/pad/setsar/fps/format/settb=AVTB 归一化；
 *   2. xfade 的 offset 是「累加偏移」，第 k 个转场
 *      offset = 前 k 段时长之和 - k × 转场时长；
 *   3. 相邻两段转场会让总时长缩短 (n-1) × 转场时长，音频用 acrossfade 才能同步；
 *   4. 片段缺音轨时用 anullsrc 生成对应时长的静音，否则 concat/acrossfade 报错；
 *   5. 路径含中文或空格时 list.txt 必须单引号包裹并转义。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
    runFFmpeg,
    probeMedia,
    inferOutputSpec,
    isSpecUniform,
    fpsToFraction,
} from '../utils/ffmpeg.js';

// ============================================================================
// 转场预设
// ============================================================================

/**
 * 内置转场预设。
 *
 * id 必须是 ffmpeg xfade 滤镜支持的 transition 名，
 * 不能随意编造，否则 ffmpeg 会报 "Error initializing filter"。
 * 参考：ffmpeg -h filter=xfade
 */
export const TRANSITION_PRESETS = [
    { id: 'fade', label: '淡入淡出', desc: '最通用，柔和过渡，适合叙事连贯的镜头', group: '基础' },
    { id: 'fadeblack', label: '黑场过渡', desc: '中间经过黑场，适合时间跳跃或段落分隔', group: '基础' },
    { id: 'fadewhite', label: '白场过渡', desc: '中间经过白场，适合闪回或梦境', group: '基础' },
    { id: 'dissolve', label: '溶解', desc: '两画面同时淡入淡出，比 fade 更自然', group: '基础' },
    { id: 'wipeleft', label: '左擦除', desc: '新画面从右向左推入，有推进感', group: '擦除' },
    { id: 'wiperight', label: '右擦除', desc: '新画面从左向右推入', group: '擦除' },
    { id: 'wipeup', label: '上擦除', desc: '新画面从下向上推入', group: '擦除' },
    { id: 'wipedown', label: '下擦除', desc: '新画面从上向下推入', group: '擦除' },
    { id: 'slideleft', label: '左滑动', desc: '画面整体左移，节奏比擦除更快', group: '滑动' },
    { id: 'slideright', label: '右滑动', desc: '画面整体右移', group: '滑动' },
    { id: 'slideup', label: '上滑动', desc: '画面整体上移', group: '滑动' },
    { id: 'slidedown', label: '下滑动', desc: '画面整体下移', group: '滑动' },
    { id: 'circleopen', label: '圆形展开', desc: '圆形从中心扩散，适合聚焦主体', group: '形状' },
    { id: 'circleclose', label: '圆形收缩', desc: '圆形向中心收拢', group: '形状' },
    { id: 'radial', label: '径向擦除', desc: '绕中心旋转擦除，动感强', group: '形状' },
    { id: 'smoothleft', label: '平滑左移', desc: '带缓动的左移，比 slideleft 柔和', group: '滑动' },
    { id: 'smoothright', label: '平滑右移', desc: '带缓动的右移', group: '滑动' },
    { id: 'pixelize', label: '像素化', desc: '马赛克过渡，适合转场到回忆或幻觉', group: '特效' },
    { id: 'hblur', label: '水平模糊', desc: '横向运动模糊，适合快速运镜衔接', group: '特效' },
    { id: 'distance', label: '距离融合', desc: '基于亮度距离的融合，质感偏电影', group: '特效' },
    { id: 'none', label: '硬切（无转场）', desc: '直接切换，节奏最快', group: '基础' },
];

/** 合法转场 id 集合，用于入参校验 */
const VALID_TRANSITIONS = new Set(
    TRANSITION_PRESETS.map((p) => p.id).filter((id) => id !== 'none')
);

/**
 * 校验并归一化转场 id，非法值回退到 fade。
 * @param {string} name
 * @returns {string}
 */
export function normalizeTransition(name) {
    const id = String(name || '').trim().toLowerCase();
    return VALID_TRANSITIONS.has(id) ? id : 'fade';
}

// ============================================================================
// 工具
// ============================================================================

/**
 * 生成安全的临时目录。
 * @param {string} prefix
 * @returns {string}
 */
function makeTempDir(prefix = 'merge') {
    const dir = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 递归删除目录，失败静默。
 * @param {string} dir
 */
function cleanupDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

/**
 * 把路径写成 concat demuxer 需要的 list.txt 内容。
 *
 * 规则：路径用单引号包裹，内部的单引号转义为 '\''
 * 否则含中文、空格、引号的路径会解析失败。
 *
 * @param {string[]} filePaths
 * @returns {string}
 */
export function buildConcatList(filePaths) {
    return filePaths
        .map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n';
}

/**
 * 视频归一化滤镜链（不含标签）。
 * 所有拼接路径都必须先过这一段，否则 xfade / concat 会因参数不匹配失败。
 *
 * @param {object} spec inferOutputSpec 的结果
 * @returns {string}
 */
function normalizeVideoFilter(spec) {
    const { width, height, fps, pixFmt } = spec;
    return [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${fpsToFraction(fps)}`,
        `format=${pixFmt}`,
        'settb=AVTB',
    ].join(',');
}

/**
 * 音频归一化滤镜链（不含标签）。
 * @param {object} spec
 * @returns {string}
 */
function normalizeAudioFilter(spec) {
    const layout = spec.channels >= 2 ? 'stereo' : 'mono';
    return `aformat=sample_rates=${spec.sampleRate}:channel_layouts=${layout}`;
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 拼接多个视频。
 *
 * @param {object} params
 * @param {string[]} params.inputPaths 输入视频绝对路径，按播放顺序
 * @param {string} params.outputPath 输出视频绝对路径
 * @param {object} [params.options]
 * @param {string} [params.options.transition='fade'] 统一转场 id，'none' 表示硬切
 * @param {number} [params.options.transitionDuration=0.5] 统一转场时长（秒）
 * @param {string[]} [params.options.transitions] 逐边界转场 id（长度 n-1），优先于 transition
 * @param {number[]} [params.options.transitionDurations] 逐边界转场时长（长度 n-1）
 * @param {'tts'|'keep'|'mute'} [params.options.audioMode='keep'] 音轨策略
 * @param {string} [params.options.audioPath] audioMode='tts' 时的音频文件路径
 * @param {number} [params.options.width] 强制输出宽度
 * @param {number} [params.options.height] 强制输出高度
 * @param {number} [params.options.fps] 强制输出帧率
 * @param {boolean} [params.options.allowFastCopy=true] 规格一致时是否允许 -c copy
 * @param {number} [params.options.crf=20] 重编码质量
 * @param {(msg:string)=>void} [params.options.onLog] 日志回调
 *
 * @returns {Promise<{outputPath:string, duration:number, mode:string, spec:object, clips:object[]}>}
 */
export async function mergeVideos({ inputPaths, outputPath, options = {} }) {
    const {
        transition = 'fade',
        transitionDuration = 0.5,
        transitions: perBoundaryTransitions = null,
        transitionDurations: perBoundaryDurations = null,
        audioMode = 'keep',
        audioPath = null,
        width: forceWidth,
        height: forceHeight,
        fps: forceFps,
        allowFastCopy = true,
        crf = 20,
        onLog = () => { },
    } = options;

    if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
        throw new Error('没有可拼接的视频片段');
    }
    if (inputPaths.length === 1 && !audioPath) {
        throw new Error('至少需要 2 个片段才能拼接');
    }

    // ---- 1. 校验输入存在 ----
    for (const p of inputPaths) {
        if (!fs.existsSync(p)) {
            throw new Error(`片段文件不存在：${path.basename(p)}`);
        }
    }

    // ---- 2. 探测规格 ----
    onLog(`探测 ${inputPaths.length} 个片段规格…`);
    const probes = [];
    for (const p of inputPaths) {
        const info = await probeMedia(p);
        if (!info) throw new Error(`无法解析视频信息：${path.basename(p)}`);
        if (!info.duration || info.duration <= 0) {
            throw new Error(`片段时长为 0，无法拼接：${path.basename(p)}`);
        }
        probes.push(info);
    }

    // ---- 3. 推断输出规格 ----
    const spec = inferOutputSpec(probes);
    if (forceWidth) spec.width = forceWidth;
    if (forceHeight) spec.height = forceHeight;
    if (forceFps) spec.fps = forceFps;

    // ---- 3.5 构建逐边界转场表 ----
    // 边界 k 位于片段 k 与 k+1 之间，共 n-1 个。
    // 优先用 transitions[]（分镜里每个镜头各自指定的转场），
    // 否则所有边界统一用 transition。
    const boundaryCount = inputPaths.length - 1;
    const baseTd = Math.max(0.1, Number(transitionDuration) || 0.5);
    const boundaries = [];

    for (let k = 0; k < boundaryCount; k++) {
        const rawId = Array.isArray(perBoundaryTransitions) && perBoundaryTransitions[k]
            ? perBoundaryTransitions[k]
            : transition;
        const id = String(rawId || 'none').toLowerCase() === 'none'
            ? 'none'
            : normalizeTransition(rawId);

        let dur = Array.isArray(perBoundaryDurations) && perBoundaryDurations[k] != null
            ? Number(perBoundaryDurations[k])
            : baseTd;
        if (!Number.isFinite(dur) || dur <= 0) dur = baseTd;

        // 转场时长不能超过相邻两段较短者的一半，否则 xfade 会失败
        const shorter = Math.min(probes[k].duration, probes[k + 1].duration);
        if (dur > shorter / 2) {
            const clamped = Math.max(0.1, Math.round((shorter / 2) * 100) / 100);
            onLog(`第 ${k + 1} 处转场时长 ${dur}s 超过片段长度限制，调整为 ${clamped}s`);
            dur = clamped;
        }

        boundaries.push({ id, duration: id === 'none' ? 0 : dur });
    }

    // 全局 td 仅用于「统一转场」的快速路径与返回值展示
    let td = baseTd;
    const minDuration = Math.min(...probes.map((p) => p.duration));
    if (td > minDuration / 2) {
        td = Math.max(0.1, Math.round((minDuration / 2) * 100) / 100);
        onLog(`转场时长超限，自动调整为 ${td}s`);
    }

    const useTransition = boundaries.some((b) => b.id !== 'none');

    // ---- 4. 选择模式 ----
    let mode;
    if (!useTransition && allowFastCopy && audioMode !== 'tts' && isSpecUniform(probes)) {
        mode = 'fast';
    } else if (useTransition) {
        mode = 'xfade';
    } else {
        mode = 'concat';
    }
    onLog(`拼接模式：${mode}（${spec.width}x${spec.height}@${spec.fps}）`);
    if (useTransition) {
        onLog(`转场序列：${boundaries.map((b) => `${b.id}(${b.duration}s)`).join(' → ')}`);
    }

    // ---- 5. 执行 ----
    let result;
    if (mode === 'fast') {
        result = await runFastConcat({ inputPaths, outputPath, audioMode });
    } else if (mode === 'xfade') {
        result = await runXfadeConcat({
            inputPaths, outputPath, probes, spec, td, audioMode, audioPath, crf, onLog,
            transition: normalizeTransition(transition),
            boundaries,
        });
    } else {
        result = await runFilterConcat({
            inputPaths, outputPath, probes, spec, audioMode, audioPath, crf, onLog,
        });
    }

    // ---- 6. 汇总时长 ----
    const finalProbe = await probeMedia(outputPath);
    const clipDurations = probes.map((p) => Math.round(p.duration * 100) / 100);

    return {
        outputPath,
        duration: finalProbe?.duration || 0,
        mode,
        spec,
        transition: useTransition ? normalizeTransition(transition) : 'none',
        transitionDuration: useTransition ? td : 0,
        // 逐边界转场明细，供前端展示「镜头 1→2 用 fade」这类信息
        boundaries: boundaries.map((b, k) => ({
            from: k + 1,
            to: k + 2,
            transition: b.id,
            duration: b.duration,
        })),
        audioMode,
        clips: probes.map((p, i) => ({
            index: i,
            name: path.basename(inputPaths[i]),
            duration: clipDurations[i],
            width: p.width,
            height: p.height,
            fps: Math.round(p.fps * 100) / 100,
            hasAudio: p.hasAudio,
        })),
    };
}

// ============================================================================
// 模式一：fast（-c copy）
// ============================================================================

/**
 * 规格完全一致时的无损快速拼接。
 * @param {object} p
 * @returns {Promise<object>}
 */
async function runFastConcat({ inputPaths, outputPath, audioMode }) {
    const tempDir = makeTempDir('fastconcat');
    try {
        const listPath = path.join(tempDir, 'list.txt');
        fs.writeFileSync(listPath, buildConcatList(inputPaths), 'utf8');

        const args = [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            // 时间戳异常时重新生成，避免音画不同步
            '-fflags', '+genpts',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
        ];
        if (audioMode === 'mute') {
            args.push('-an');
        }
        args.push(outputPath);

        await runFFmpeg(args, { timeoutMs: 10 * 60 * 1000 });
        return { mode: 'fast' };
    } finally {
        cleanupDir(tempDir);
    }
}

// ============================================================================
// 模式二：xfade（带转场）
// ============================================================================

/**
 * 计算某个边界实际使用的淡化时长。
 *
 * 硬切（id='none'）没有真正的「无转场」模式可用，只能用极短 xfade 近似。
 * 坑：取 1 帧（1/30≈0.033）时，配合 normalizeVideoFilter 的 settb=AVTB，
 * xfade 链会在后续边界处提前截断（实测 3 段 8.47s 只剩 5.50s）。
 * 取 ≥2 帧（≥0.04s）可稳定通过，视觉上仍是瞬间切换。
 *
 * 视频 xfade 与音频 acrossfade 必须用同一函数取值，否则音画会累积偏移。
 *
 * @param {{id: string, duration: number}} boundary
 * @param {number} fps
 * @returns {number}
 */
function resolveBoundaryFade(boundary, fps) {
    if (boundary.id !== 'none') return boundary.duration;
    return Math.max(0.04, 2 / (fps || 30));
}

/**
 * 带转场的拼接。
 *
 * 滤镜图结构：
 *   [0:v]归一化[v0]; [1:v]归一化[v1]; ...
 *   [v0][v1]xfade=...[vx1];
 *   [vx1][v2]xfade=...[vx2]; ...
 *
 * 音频同理用 acrossfade 链，保证与视频总时长一致。
 *
 * @param {object} p
 * @returns {Promise<object>}
 */
async function runXfadeConcat({
    inputPaths, outputPath, probes, spec, td, audioMode, audioPath, crf, onLog, transition,
    boundaries: boundariesIn,
}) {
    const n = inputPaths.length;
    const vFilter = normalizeVideoFilter(spec);
    const aFilter = normalizeAudioFilter(spec);

    // 逐边界转场表；未传入时退化为「全部用统一转场」
    const boundaries = Array.isArray(boundariesIn) && boundariesIn.length === n - 1
        ? boundariesIn
        : Array.from({ length: n - 1 }, () => ({
            id: normalizeTransition(transition),
            duration: td,
        }));

    const parts = [];

    // ---- 视频：逐段归一化 ----
    for (let i = 0; i < n; i++) {
        parts.push(`[${i}:v]${vFilter}[v${i}]`);
    }

    // ---- 视频：xfade 链 ----
    // 硬切边界（id='none'）也要走 xfade，否则链式标签会断。
    // ffmpeg 的 xfade 没有「无转场」模式，这里用极短 duration 近似硬切。
    //
    // offset 计算（关键，算错会黑屏/卡帧）：
    //   已消耗时间轴长度 acc 从第 1 段时长开始；
    //   每次转场后 acc = acc + 下一段时长 - 本次转场时长。
    //   offset = acc - 本次转场时长。
    let acc = probes[0].duration;
    let prevLabel = 'v0';

    for (let i = 1; i < n; i++) {
        const b = boundaries[i - 1];
        const d = resolveBoundaryFade(b, spec.fps);
        // 硬切没有对应转场名，用 fade + 极短时长近似
        const trans = b.id === 'none' ? 'fade' : b.id;

        const offset = Math.max(0, acc - d);
        const outLabel = i === n - 1 ? 'vout' : `vx${i}`;

        parts.push(
            `[${prevLabel}][v${i}]xfade=transition=${trans}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`
        );

        prevLabel = outLabel;
        acc = acc + probes[i].duration - d;
    }

    // ---- 音频 ----
    let useTtsAudio = false;

    if (audioMode === 'tts' && audioPath) {
        // 外部 TTS 音频作为最后一个输入（索引 n），apad 补齐后由 -shortest 截到视频长度
        parts.push(`[${n}:a]${aFilter},apad[aout]`);
        useTtsAudio = true;
    } else if (audioMode === 'keep') {
        // 缺音轨的片段补静音
        for (let i = 0; i < n; i++) {
            if (probes[i].hasAudio) {
                parts.push(`[${i}:a]${aFilter}[a${i}]`);
            } else {
                parts.push(
                    `anullsrc=r=${spec.sampleRate}:cl=${spec.channels >= 2 ? 'stereo' : 'mono'},`
                    + `atrim=duration=${probes[i].duration.toFixed(3)},${aFilter},asetpts=PTS-STARTPTS[a${i}]`
                );
            }
        }

        // 音频交叉淡化时长必须与对应视频转场一致，否则音画会累积偏移。
        // 用与视频完全相同的 resolveBoundaryFade，保证两侧逐帧对齐。
        let prevA = 'a0';
        for (let i = 1; i < n; i++) {
            const d = resolveBoundaryFade(boundaries[i - 1], spec.fps);
            const outLabel = i === n - 1 ? 'aout' : `ax${i}`;
            parts.push(
                `[${prevA}][a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${outLabel}]`
            );
            prevA = outLabel;
        }
    }

    // ---- 组装参数 ----
    const args = ['-y'];
    for (const p of inputPaths) args.push('-i', p);
    if (audioMode === 'tts' && audioPath) args.push('-i', audioPath);

    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]');

    if (useTtsAudio) {
        // apad 让音频无限延长，-shortest 保证输出以视频为准
        args.push('-map', '[aout]');
        args.push('-c:a', 'aac', '-b:a', '192k');
        args.push('-shortest');
    } else if (audioMode === 'keep') {
        args.push('-map', '[aout]');
        args.push('-c:a', 'aac', '-b:a', '192k');
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(crf),
        '-pix_fmt', spec.pixFmt,
        '-movflags', '+faststart',
    );
    if (audioMode === 'mute') args.push('-an');
    args.push(outputPath);

    onLog(`xfade 滤镜段数：${n}，转场时长 ${td}s`);
    await runFFmpeg(args, { timeoutMs: 30 * 60 * 1000 });
    return { mode: 'xfade' };
}

// ============================================================================
// 模式三：concat（无转场 + 规格不一致）
// ============================================================================

/**
 * 无转场的重编码拼接（兜底路径）。
 *
 * 用 concat filter，而不是 demuxer，因为规格不一致时 demuxer 会花屏。
 *
 * @param {object} p
 * @returns {Promise<object>}
 */
async function runFilterConcat({
    inputPaths, outputPath, probes, spec, audioMode, audioPath, crf, onLog,
}) {
    const n = inputPaths.length;
    const vFilter = normalizeVideoFilter(spec);
    const aFilter = normalizeAudioFilter(spec);
    const parts = [];

    for (let i = 0; i < n; i++) {
        parts.push(`[${i}:v]${vFilter}[v${i}]`);
    }

    let useTtsAudio = false;

    if (audioMode === 'tts' && audioPath) {
        parts.push(`[${n}:a]${aFilter},apad[aout]`);
        useTtsAudio = true;
    } else if (audioMode === 'keep') {
        for (let i = 0; i < n; i++) {
            if (probes[i].hasAudio) {
                parts.push(`[${i}:a]${aFilter}[a${i}]`);
            } else {
                parts.push(
                    `anullsrc=r=${spec.sampleRate}:cl=${spec.channels >= 2 ? 'stereo' : 'mono'},`
                    + `atrim=duration=${probes[i].duration.toFixed(3)},${aFilter},asetpts=PTS-STARTPTS[a${i}]`
                );
            }
        }
    }

    // 拼接视频（及音轨）标签
    let concatInputs = '';
    for (let i = 0; i < n; i++) {
        concatInputs += `[v${i}]`;
        if (audioMode === 'keep') concatInputs += `[a${i}]`;
    }

    const hasAudioOut = audioMode === 'keep';
    parts.push(
        `${concatInputs}concat=n=${n}:v=1:a=${hasAudioOut ? 1 : 0}[vout]`
        + (hasAudioOut ? '[aout]' : '')
    );

    const args = ['-y'];
    for (const p of inputPaths) args.push('-i', p);
    if (audioMode === 'tts' && audioPath) args.push('-i', audioPath);

    args.push('-filter_complex', parts.join(';'));
    args.push('-map', '[vout]');

    if (useTtsAudio) {
        args.push('-map', '[aout]');
        args.push('-c:a', 'aac', '-b:a', '192k');
        args.push('-shortest');
    } else if (audioMode === 'keep') {
        args.push('-map', '[aout]');
        args.push('-c:a', 'aac', '-b:a', '192k');
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(crf),
        '-pix_fmt', spec.pixFmt,
        '-movflags', '+faststart',
    );
    if (audioMode === 'mute') args.push('-an');
    args.push(outputPath);

    onLog(`concat filter 重编码 ${n} 段`);
    await runFFmpeg(args, { timeoutMs: 30 * 60 * 1000 });
    return { mode: 'concat' };
}
