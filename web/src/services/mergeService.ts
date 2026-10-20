/**
 * mergeService.ts
 *
 * 视频拼接成片的前端服务层。
 *
 * 对应后端接口：
 *   GET  /api/video-merge/presets   转场预设
 *   GET  /api/video-merge/status    ffmpeg 环境自检
 *   POST /api/video-merge/merge     执行拼接
 */

// ============================================================================
// 类型
// ============================================================================

/** 音轨策略 */
export type AudioMode = 'keep' | 'tts' | 'mute';

/** 转场预设 */
export interface TransitionPreset {
    /** ffmpeg xfade transition 名，或 'none' 表示硬切 */
    id: string;
    label: string;
    desc: string;
    /** 分组：基础 / 擦除 / 滑动 / 形状 / 特效 */
    group: string;
}

/** 音轨模式选项 */
export interface AudioModeOption {
    id: AudioMode;
    label: string;
    desc: string;
}

/** 拼接请求参数 */
export interface MergeVideosParams {
    /** 片段地址，按播放顺序 */
    videos: string[];
    /** 统一转场 id（transitions 未提供时生效） */
    transition: string;
    /** 统一转场时长（秒） */
    transitionDuration: number;
    /** 逐边界转场 id（长度 = videos.length - 1），优先于 transition */
    transitions?: string[];
    /** 逐边界转场时长（长度 = videos.length - 1） */
    transitionDurations?: number[];
    /** 音轨策略 */
    audioMode: AudioMode;
    /** TTS 音频地址（audioMode='tts' 时必需） */
    audioUrl?: string;
    /** 集号，用于输出文件命名 */
    episode?: number;
    /** 节点提示词，仅用于日志 */
    prompt?: string;
}

/** 单处转场明细（后端返回） */
export interface MergeBoundary {
    /** 起始片段序号（1-based） */
    from: number;
    /** 结束片段序号（1-based） */
    to: number;
    transition: string;
    duration: number;
}

/** 拼接结果 */
export interface MergeVideosResult {
    url: string;
    duration: number;
    mode: string;
    size: number;
    transition: string;
    transitionDuration: number;
    boundaries?: MergeBoundary[];
    audioMode: AudioMode;
    episode: number | null;
    spec: { width: number; height: number; fps: number };
    clips: Array<{
        index: number;
        name: string;
        duration: number;
        width: number;
        height: number;
        fps: number;
        hasAudio: boolean;
    }>;
}

// ============================================================================
// 本地兜底预设（后端不可用时仍能渲染面板）
// ============================================================================

export const FALLBACK_PRESETS: TransitionPreset[] = [
    { id: 'none', label: '硬切', desc: '无转场，直接切换', group: '基础' },
    { id: 'fade', label: '淡入淡出', desc: '最通用，柔和过渡', group: '基础' },
    { id: 'fadeblack', label: '黑场过渡', desc: '经过黑场，适合段落分隔', group: '基础' },
    { id: 'fadewhite', label: '白场过渡', desc: '经过白场，适合闪回', group: '基础' },
    { id: 'dissolve', label: '溶解', desc: '两画面同时淡入淡出', group: '基础' },
    { id: 'wipeleft', label: '左擦除', desc: '从右向左推入', group: '擦除' },
    { id: 'wiperight', label: '右擦除', desc: '从左向右推入', group: '擦除' },
    { id: 'wipeup', label: '上擦除', desc: '从下向上推入', group: '擦除' },
    { id: 'wipedown', label: '下擦除', desc: '从上向下推入', group: '擦除' },
    { id: 'slideleft', label: '左滑动', desc: '画面整体左移', group: '滑动' },
    { id: 'slideright', label: '右滑动', desc: '画面整体右移', group: '滑动' },
    { id: 'slideup', label: '上滑动', desc: '画面整体上移', group: '滑动' },
    { id: 'slidedown', label: '下滑动', desc: '画面整体下移', group: '滑动' },
    { id: 'circleopen', label: '圆形展开', desc: '圆形从中心扩散', group: '形状' },
    { id: 'circleclose', label: '圆形收缩', desc: '圆形向中心收拢', group: '形状' },
    { id: 'radial', label: '径向擦除', desc: '绕中心旋转擦除', group: '形状' },
    { id: 'smoothleft', label: '平滑左移', desc: '带缓动的左移', group: '滑动' },
    { id: 'smoothright', label: '平滑右移', desc: '带缓动的右移', group: '滑动' },
    { id: 'pixelize', label: '像素化', desc: '马赛克过渡', group: '特效' },
    { id: 'distance', label: '距离融合', desc: '基于亮度距离融合', group: '特效' },
];

/** 兜底音轨模式 */
export const FALLBACK_AUDIO_MODES: AudioModeOption[] = [
    { id: 'keep', label: '保留原音', desc: '各片段自带音频' },
    { id: 'tts', label: 'TTS 覆盖', desc: '整集配音替换原音' },
    { id: 'mute', label: '静音', desc: '丢弃所有音轨' },
];

// ============================================================================
// API
// ============================================================================

/**
 * 拉取转场预设。失败时返回本地兜底列表，不抛异常。
 */
export async function fetchTransitionPresets(): Promise<TransitionPreset[]> {
    try {
        const res = await fetch('/api/video-merge/presets');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = data?.presets;
        if (Array.isArray(list) && list.length > 0) return list;
        return FALLBACK_PRESETS;
    } catch (error) {
        console.warn('[mergeService] 拉取转场预设失败，使用本地兜底:', error);
        return FALLBACK_PRESETS;
    }
}

/**
 * 检查服务端 ffmpeg 是否就绪。
 */
export async function checkMergeReady(): Promise<{ ready: boolean; ffmpeg: boolean; ffprobe: boolean }> {
    try {
        const res = await fetch('/api/video-merge/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch {
        return { ready: false, ffmpeg: false, ffprobe: false };
    }
}

/**
 * 执行视频拼接。
 *
 * @throws Error 后端返回失败或网络异常时抛出，message 为可直接展示的中文提示
 */
export async function mergeVideos(params: MergeVideosParams): Promise<MergeVideosResult> {
    const res = await fetch('/api/video-merge/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            videos: params.videos,
            transition: params.transition,
            transitionDuration: params.transitionDuration,
            transitions: params.transitions,
            transitionDurations: params.transitionDurations,
            audioMode: params.audioMode,
            audioUrl: params.audioUrl,
            episode: params.episode,
            prompt: params.prompt,
        }),
    });

    let data: any = null;
    try {
        data = await res.json();
    } catch {
        // 非 JSON 响应（如网关 502 返回 HTML）
    }

    if (!res.ok || !data?.success) {
        const msg = data?.error || `拼接请求失败（HTTP ${res.status}）`;
        throw new Error(msg);
    }

    return data as MergeVideosResult;
}

// ============================================================================
// 纯函数工具
// ============================================================================

/**
 * 校验拼接输入，返回错误信息数组（空数组表示通过）。
 */
export function validateMergeInput(videos: string[]): string[] {
    const errors: string[] = [];
    if (!Array.isArray(videos) || videos.length < 2) {
        errors.push('至少需要 2 个视频片段才能拼接');
    }
    if (videos?.some((v) => !v)) {
        errors.push('存在地址为空的片段，请检查节点是否已生成');
    }
    return errors;
}

/**
 * 估算拼接后的成片时长。
 *
 * 每个转场会让总时长减少 transitionDuration 秒。
 * 时长为 0 的片段（未知）按 0 计，此时结果偏小，仅作参考。
 *
 * @param durations 各片段时长（秒）
 * @param transitionDuration 转场时长
 * @param hasTransition 是否有转场
 */
export function estimateMergedDuration(
    durations: number[],
    transitionDuration: number,
    hasTransition: boolean
): number {
    const total = durations.reduce((s, d) => s + (Number(d) || 0), 0);
    if (!hasTransition || durations.length < 2) return total;
    const overlap = (durations.length - 1) * transitionDuration;
    return Math.max(0, total - overlap);
}

/**
 * 秒 → MM:SS
 */
export function formatSeconds(seconds: number): string {
    if (!seconds || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
