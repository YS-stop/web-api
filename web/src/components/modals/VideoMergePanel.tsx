/**
 * VideoMergePanel.tsx
 *
 * 视频合并节点（VIDEO_MERGE）的配置面板。
 *
 * 三块内容：
 *   1. 片段列表 —— 展示所有输入片段，可上下调整顺序（顺序即播放顺序）；
 *   2. 转场配置 —— 转场类型 + 时长，实时显示估算成片时长；
 *   3. 音轨配置 —— 保留原音 / TTS 整集配音覆盖 / 静音。
 *
 * 交互约定：
 *   - 拼接是长任务，进行中禁用所有输入并显示进度文案；
 *   - 已生成成片后仍可改配置重新拼接（重新拼接会覆盖 resultUrl）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    X, Film, ArrowUp, ArrowDown, Sparkles, Music, VolumeX, Volume2,
    Loader2, AlertTriangle, Clock, Layers, CheckCircle2,
} from 'lucide-react';
import {
    fetchTransitionPresets,
    estimateMergedDuration,
    FALLBACK_PRESETS,
    type TransitionPreset,
    type AudioMode,
} from '../../services/mergeService';
import type { MergeClip } from '../../hooks/useVideoMerge';
import { buildEpisodeTrack, loadDubbing } from '../../services/dubbingService';
import { loadAssetStore } from '../AssetConfirmPanel';

// ============================================================================
// 类型
// ============================================================================

interface VideoMergePanelProps {
    isOpen: boolean;
    /** 当前合并节点 id */
    nodeId: string | null;
    /** 输入片段（已按顺序） */
    clips: MergeClip[];
    /** 是否正在拼接 */
    isMerging: boolean;
    /** 错误信息 */
    error?: string | null;
    /** 已生成的成片地址 */
    resultUrl?: string;
    /** 已生成的成片时长 */
    resultDuration?: number;
    /** 初始转场（从节点回填） */
    initialTransition?: string;
    /** 初始转场时长 */
    initialTransitionDuration?: number;
    /** 初始音轨模式 */
    initialAudioMode?: AudioMode;
    /** 初始 TTS 音频地址 */
    initialAudioUrl?: string;
    /** 初始逐边界转场 id（来自分镜，长度 = 片段数 - 1） */
    initialTransitions?: string[];
    /** 当前集号 */
    episode?: number;
    /** 当前项目 id：TTS 模式留空时用它读取资产音色与配音台词，自动生成音轨 */
    projectId?: string;
    /** 关闭面板 */
    onClose: () => void;
    /** 调整片段顺序 */
    onReorder: (nodeId: string, from: number, to: number) => void;
    /** 执行拼接 */
    onMerge: (
        nodeId: string,
        options: {
            transition: string;
            transitionDuration: number;
            transitions?: string[];
            transitionDurations?: number[];
            audioMode: AudioMode;
            audioUrl?: string;
            episode?: number;
        }
    ) => void;
    /** 画布主题：light 时面板改为浅色（白色画布 /canvas-studio 使用） */
    canvasTheme?: 'dark' | 'light';
}

// ============================================================================
// 工具
// ============================================================================

/** 秒 → MM:SS */
const formatDuration = (seconds: number): string => {
    if (!seconds || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

/** 转场时长可选项 */
const DURATION_OPTIONS = [0.2, 0.3, 0.5, 0.8, 1.0, 1.5];

// ============================================================================
// 组件
// ============================================================================

export const VideoMergePanel: React.FC<VideoMergePanelProps> = ({
    isOpen,
    nodeId,
    clips,
    isMerging,
    error,
    resultUrl,
    resultDuration,
    initialTransition = 'fade',
    initialTransitionDuration = 0.5,
    initialAudioMode = 'keep',
    initialAudioUrl,
    initialTransitions,
    episode,
    projectId,
    onClose,
    onReorder,
    onMerge,
    canvasTheme = 'dark',
}) => {
    // --- 本地配置状态 ---
    const [transition, setTransition] = useState(initialTransition);
    const [transitionDuration, setTransitionDuration] = useState(initialTransitionDuration);
    /** 逐边界转场（长度 = clips.length - 1）；null 表示所有边界统一用 transition */
    const [boundaryTransitions, setBoundaryTransitions] = useState<string[] | null>(null);
    const [audioMode, setAudioMode] = useState<AudioMode>(initialAudioMode);
    const [audioUrl, setAudioUrl] = useState(initialAudioUrl || '');
    const [presets, setPresets] = useState<TransitionPreset[]>(FALLBACK_PRESETS);

    // 打开时回填节点上的配置
    useEffect(() => {
        if (!isOpen) return;
        setTransition(initialTransition || 'fade');
        setTransitionDuration(initialTransitionDuration || 0.5);
        setAudioMode(initialAudioMode || 'keep');
        /**
         * 自动生成的配音音轨不锁定旧地址。
         *
         * 节点上会持久化上次的 mergeAudioUrl，如果直接回填，资产换了音色后
         * 这里仍指向旧文件，「资产音色变了、成片还是旧声音」就会复现。
         * 统一清空后交给合并前重新解析：指纹没变则命中服务端缓存（不重复计费），
         * 音色变了自然拿到新文件。用户手填的地址（非 dub_ 前缀）保持原样。
         */
        const restoredAudioUrl = initialAudioUrl || '';
        setAudioUrl(/^\/library\/audio\/dub_/.test(restoredAudioUrl) ? '' : restoredAudioUrl);
        setTrackHint('');
        setBoundaryTransitions(
            Array.isArray(initialTransitions) && initialTransitions.length > 0
                ? [...initialTransitions]
                : null
        );
    }, [isOpen, nodeId, initialTransition, initialTransitionDuration, initialAudioMode, initialAudioUrl, initialTransitions]);

    // 片段数量变化时，把逐边界转场数组对齐到正确长度
    const boundaryCount = Math.max(0, clips.length - 1);
    useEffect(() => {
        setBoundaryTransitions((prev) => {
            if (!prev) return prev;
            if (prev.length === boundaryCount) return prev;
            const next = Array.from({ length: boundaryCount }, (_, i) => prev[i] ?? 'fade');
            return next;
        });
    }, [boundaryCount]);

    /** 取第 k 个边界的转场（逐边界优先，否则统一值） */
    const getBoundaryTransition = (k: number): string =>
        boundaryTransitions?.[k] ?? transition;

    /** 修改第 k 个边界的转场 */
    const setBoundaryTransition = (k: number, value: string) => {
        setBoundaryTransitions((prev) => {
            const base = prev
                ? [...prev]
                : Array.from({ length: boundaryCount }, () => transition);
            while (base.length < boundaryCount) base.push(transition);
            base[k] = value;
            return base;
        });
    };

    /** 是否处于「逐镜头自定义」模式 */
    const isPerShot = boundaryTransitions !== null;

    /** 切回统一转场 */
    const resetToUniform = () => setBoundaryTransitions(null);

    // 拉取后端转场预设
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        fetchTransitionPresets().then((list) => {
            if (!cancelled) setPresets(list);
        });
        return () => { cancelled = true; };
    }, [isOpen]);

    // 转场预设按 group 分组
    const grouped = useMemo(() => {
        const map = new Map<string, TransitionPreset[]>();
        for (const p of presets) {
            const arr = map.get(p.group) || [];
            arr.push(p);
            map.set(p.group, arr);
        }
        return Array.from(map.entries());
    }, [presets]);

    const hasTransition = transition !== 'none';

    /** 正在按资产音色生成整集配音音轨 */
    const [trackBuilding, setTrackBuilding] = useState(false);
    /** 音轨生成结果或失败原因，显示在 TTS 输入框下方 */
    const [trackHint, setTrackHint] = useState('');

    /**
     * TTS 模式下音轨地址留空时，按「当前集配音台词 + 资产音色」自动生成整集音轨。
     *
     * 这是「资产音色改变 → 视频音色同步改变」的落点：
     * 服务端按内容指纹命名输出文件，音色一变指纹就变，必然生成新音轨，
     * 不需要用户手动清空地址或删缓存。
     */
    const ensureTtsTrack = async (): Promise<string> => {
        if (!projectId || !episode) {
            throw new Error('缺少项目或集号，无法按资产音色生成配音音轨');
        }
        const dubbing = loadDubbing(projectId)[episode];
        if (!dubbing || !dubbing.lines?.length) {
            throw new Error(`第 ${episode} 集还没有配音台词，请先完成配音`);
        }
        const characters = loadAssetStore(projectId)?.[episode]?.characters || [];
        const track = await buildEpisodeTrack({
            lines: dubbing.lines,
            characters,
            narratorVoice: dubbing.narratorVoice,
            episode,
            volume: dubbing.volume,
            speed: dubbing.speed,
        });
        setAudioUrl(track.url);
        setTrackHint(
            `已按资产音色${track.cached ? '复用' : '生成'}音轨（${track.duration.toFixed(1)}s）`
                + (track.failed.length ? `，${track.failed.length} 条台词合成失败` : '')
        );
        return track.url;
    };

    /** 确认拼接：TTS 模式缺音轨时先补齐再调用合并 */
    const handleConfirm = async () => {
        let finalAudioUrl = audioUrl.trim();
        if (audioMode === 'tts' && !finalAudioUrl) {
            setTrackBuilding(true);
            setTrackHint('');
            try {
                finalAudioUrl = await ensureTtsTrack();
            } catch (error: any) {
                setTrackHint(error?.message || '配音音轨生成失败');
                setTrackBuilding(false);
                return;
            }
            setTrackBuilding(false);
        }

        onMerge(nodeId, {
            transition,
            transitionDuration,
            // 逐镜头模式才传逐边界数组，统一模式让后端用 transition
            transitions: isPerShot ? (boundaryTransitions || undefined) : undefined,
            transitionDurations: isPerShot
                ? Array.from({ length: boundaryCount }, () => transitionDuration)
                : undefined,
            audioMode,
            audioUrl: audioMode === 'tts' ? finalAudioUrl : undefined,
            episode,
        });
    };

    // 估算成片时长（逐镜头模式下按实际有转场的边界数扣减）
    const estimatedDuration = useMemo(() => {
        const durations = clips.map((c) => c.duration);
        const total = durations.reduce((s, d) => s + (Number(d) || 0), 0);

        if (boundaryTransitions && boundaryTransitions.length > 0) {
            // 逐镜头模式：只扣减真正有转场的边界
            const activeCount = boundaryTransitions.filter((t) => t !== 'none').length;
            return Math.max(0, total - activeCount * transitionDuration);
        }

        return estimateMergedDuration(durations, transitionDuration, hasTransition);
    }, [clips, transitionDuration, hasTransition, boundaryTransitions]);

    // 时长是否全部已知（用于判断估算是否可信）
    const durationKnown = clips.length > 0 && clips.every((c) => c.duration > 0);

    if (!isOpen || !nodeId) return null;

    const canMerge = clips.length >= 2 && !isMerging && !trackBuilding;

    // 配色变量：深色保持原样，浅色整体翻转（面板内颜色统一走变量，避免逐处写分支）
    const isDark = canvasTheme === 'dark';
    const themeVars = (isDark
        ? {
            '--vm-surface': '#0d0d0d',
            '--vm-input': '#171717',
            '--vm-panel': 'rgba(23, 23, 23, .7)',
            '--vm-hover': '#262626',
            '--vm-border': '#262626',
            '--vm-border-2': '#404040',
            '--vm-text-strong': '#f5f5f5',
            '--vm-text': '#e5e5e5',
            '--vm-text-dim': '#a3a3a3',
            '--vm-text-mute': '#737373',
        }
        : {
            '--vm-surface': '#ffffff',
            '--vm-input': '#f7f8fb',
            '--vm-panel': '#f4f6fb',
            '--vm-hover': '#eef0f6',
            '--vm-border': '#e8eaf2',
            '--vm-border-2': '#dfe3ec',
            '--vm-text-strong': '#202637',
            '--vm-text': '#2b3242',
            '--vm-text-dim': '#6b7488',
            '--vm-text-mute': '#8a93a5',
        }) as React.CSSProperties;

    return (
        <div className={`fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm ${isDark ? 'bg-black/70' : 'bg-[#0f172a]/25'}`}>
            <div
                className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden bg-[var(--vm-surface)] border-[var(--vm-border)]"
                style={themeVars}
            >
                {/* ---------- Header ---------- */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--vm-border)] shrink-0">
                    <div className="flex items-center gap-2.5">
                        <Layers size={20} className="text-purple-400" />
                        <div>
                            <h2 className="text-base font-medium text-[var(--vm-text-strong)]">视频合并成片</h2>
                            <p className="text-xs text-[var(--vm-text-mute)] mt-0.5">
                                {clips.length} 个片段
                                {episode ? ` · 第 ${episode} 集` : ''}
                                {durationKnown && ` · 总长 ${formatDuration(
                                    clips.reduce((s, c) => s + c.duration, 0)
                                )}`}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isMerging}
                        className="p-1.5 rounded-lg text-[var(--vm-text-dim)] hover:text-[var(--vm-text-strong)] hover:bg-[var(--vm-hover)] disabled:opacity-40 transition-colors"
                        title={isMerging ? '拼接中，请稍候' : '关闭'}
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* ---------- Body ---------- */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

                    {/* ===== 1. 片段列表 ===== */}
                    <section>
                        <h3 className="text-xs font-medium text-[var(--vm-text-dim)] mb-2 flex items-center gap-1.5">
                            <Film size={13} />
                            片段顺序
                            <span className="text-[var(--vm-text-mute)] font-normal">（从上到下依次拼接）</span>
                        </h3>

                        {clips.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-[var(--vm-border-2)] px-4 py-8 text-center">
                                <p className="text-sm text-[var(--vm-text-mute)]">还没有连接任何视频片段</p>
                                <p className="text-xs text-[var(--vm-text-mute)] mt-1">
                                    把视频节点的输出连到本节点即可
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-1.5">
                                {clips.map((clip, index) => (
                                    <React.Fragment key={`${clip.nodeId}-${index}`}>
                                        <div
                                            className="flex items-center gap-3 rounded-lg bg-[var(--vm-panel)] border border-[var(--vm-border)] px-3 py-2"
                                        >
                                            {/* 序号 */}
                                            <span className="w-6 h-6 shrink-0 rounded-md bg-purple-500/15 text-purple-300 text-xs font-medium flex items-center justify-center">
                                                {index + 1}
                                            </span>

                                            {/* 缩略预览 */}
                                            <video
                                                src={clip.url}
                                                className="w-16 h-9 shrink-0 rounded object-cover bg-black"
                                                muted
                                                preload="metadata"
                                            />

                                            {/* 信息 */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs text-[var(--vm-text)] truncate">
                                                    {clip.label || `片段 ${index + 1}`}
                                                </p>
                                                <p className="text-[11px] text-[var(--vm-text-mute)] flex items-center gap-1 mt-0.5">
                                                    <Clock size={10} />
                                                    {clip.duration > 0 ? formatDuration(clip.duration) : '时长未知'}
                                                    <span className="text-neutral-700">·</span>
                                                    {clip.sourceType}
                                                    {clip.shotNumber != null && (
                                                        <>
                                                            <span className="text-neutral-700">·</span>
                                                            <span className="text-purple-400/80">镜头 {clip.shotNumber}</span>
                                                        </>
                                                    )}
                                                </p>
                                            </div>

                                            {/* 排序按钮 */}
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                    onClick={() => onReorder(nodeId, index, index - 1)}
                                                    disabled={index === 0 || isMerging}
                                                    className="p-1 rounded text-[var(--vm-text-mute)] hover:text-[var(--vm-text)] hover:bg-[var(--vm-hover)] disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
                                                    title="上移"
                                                >
                                                    <ArrowUp size={14} />
                                                </button>
                                                <button
                                                    onClick={() => onReorder(nodeId, index, index + 1)}
                                                    disabled={index === clips.length - 1 || isMerging}
                                                    className="p-1 rounded text-[var(--vm-text-mute)] hover:text-[var(--vm-text)] hover:bg-[var(--vm-hover)] disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
                                                    title="下移"
                                                >
                                                    <ArrowDown size={14} />
                                                </button>
                                            </div>
                                        </div>

                                        {/* 片段之间的转场选择器（只在逐镜头模式下出现） */}
                                        {index < clips.length - 1 && isPerShot && (
                                            <div className="flex items-center gap-2 pl-11 pr-2">
                                                <span className="text-[10px] text-[var(--vm-text-mute)] shrink-0">
                                                    {index + 1}→{index + 2}
                                                </span>
                                                <select
                                                    value={getBoundaryTransition(index)}
                                                    onChange={(e) => setBoundaryTransition(index, e.target.value)}
                                                    disabled={isMerging}
                                                    className="flex-1 rounded-md bg-[var(--vm-panel)] border border-[var(--vm-border)] text-[11px] text-[var(--vm-text)] px-2 py-1 outline-none focus:border-purple-500/50 disabled:opacity-50"
                                                >
                                                    {presets.map((p) => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        )}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* ===== 2. 转场配置 ===== */}
                    <section>
                        <h3 className="text-xs font-medium text-[var(--vm-text-dim)] mb-2 flex items-center gap-1.5">
                            <Sparkles size={13} />
                            转场效果
                        </h3>

                        {/* 转场类型 */}
                        <select
                            value={transition}
                            onChange={(e) => setTransition(e.target.value)}
                            disabled={isMerging}
                            className="w-full rounded-lg bg-[var(--vm-input)] border border-[var(--vm-border)] text-sm text-[var(--vm-text)] px-3 py-2 outline-none focus:border-purple-500/60 disabled:opacity-50"
                        >
                            {grouped.map(([group, items]) => (
                                <optgroup key={group} label={group}>
                                    {items.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label} — {p.desc}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>

                        {/* 转场时长 */}
                        {hasTransition && (
                            <div className="mt-3">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[11px] text-[var(--vm-text-mute)]">转场时长</span>
                                    <span className="text-[11px] text-purple-300 font-mono">
                                        {transitionDuration.toFixed(1)}s
                                    </span>
                                </div>
                                <div className="flex gap-1.5">
                                    {DURATION_OPTIONS.map((d) => (
                                        <button
                                            key={d}
                                            onClick={() => setTransitionDuration(d)}
                                            disabled={isMerging}
                                            className={`flex-1 py-1.5 rounded-md text-[11px] transition-colors disabled:opacity-40 ${
                                                Math.abs(transitionDuration - d) < 0.01
                                                    ? 'bg-purple-500/20 text-purple-200 border border-purple-500/40'
                                                    : 'bg-[var(--vm-input)] text-[var(--vm-text-dim)] border border-[var(--vm-border)] hover:border-[var(--vm-border-2)]'
                                            }`}
                                        >
                                            {d}s
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* 逐镜头自定义开关 */}
                        {clips.length >= 2 && (
                            <div className="mt-3 flex items-center justify-between rounded-lg bg-[var(--vm-panel)] border border-[var(--vm-border)] px-3 py-2">
                                <div>
                                    <p className="text-[11px] text-[var(--vm-text)]">逐镜头自定义转场</p>
                                    <p className="text-[10px] text-[var(--vm-text-mute)] mt-0.5">
                                        {isPerShot
                                            ? '每个片段之间可单独选转场（已采用分镜建议）'
                                            : '所有片段之间统一使用上面的转场'}
                                    </p>
                                </div>
                                <button
                                    onClick={() => (isPerShot ? resetToUniform() : setBoundaryTransitions(
                                        Array.from({ length: boundaryCount }, () => transition)
                                    ))}
                                    disabled={isMerging}
                                    className={`shrink-0 px-2.5 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-40 ${
                                        isPerShot
                                            ? 'bg-purple-500/20 text-purple-200 border-purple-500/40'
                                            : 'bg-[var(--vm-hover)] text-[var(--vm-text-dim)] border-[var(--vm-border-2)] hover:border-[var(--vm-border-2)]'
                                    }`}
                                >
                                    {isPerShot ? '已开启' : '开启'}
                                </button>
                            </div>
                        )}

                        {/* 时长估算 */}
                        <div className="mt-3 flex items-center justify-between rounded-lg bg-[var(--vm-panel)] border border-[var(--vm-border)] px-3 py-2">
                            <span className="text-[11px] text-[var(--vm-text-mute)]">预计成片时长</span>
                            <span className="text-xs text-[var(--vm-text)] font-mono">
                                {durationKnown ? formatDuration(estimatedDuration) : '需生成后才能估算'}
                            </span>
                        </div>
                        {clips.length >= 2 && (
                            <p className="text-[11px] text-[var(--vm-text-mute)] mt-1.5">
                                {isPerShot
                                    ? `共 ${boundaryTransitions?.filter((t) => t !== 'none').length ?? 0} 处转场，其余硬切`
                                    : hasTransition
                                        ? `每处转场会让总时长缩短 ${transitionDuration.toFixed(1)}s（共 ${clips.length - 1} 处，合计约 ${((clips.length - 1) * transitionDuration).toFixed(1)}s）`
                                        : '全部硬切，总时长等于各片段之和'}
                            </p>
                        )}
                    </section>

                    {/* ===== 3. 音轨配置 ===== */}
                    <section>
                        <h3 className="text-xs font-medium text-[var(--vm-text-dim)] mb-2 flex items-center gap-1.5">
                            <Music size={13} />
                            音轨
                        </h3>

                        <div className="grid grid-cols-3 gap-2">
                            {([
                                { id: 'keep', label: '保留原音', icon: <Volume2 size={14} />, hint: '各片段自带音频' },
                                { id: 'tts', label: 'TTS 覆盖', icon: <Music size={14} />, hint: '整集配音替换' },
                                { id: 'mute', label: '静音', icon: <VolumeX size={14} />, hint: '丢弃所有音轨' },
                            ] as const).map((opt) => (
                                <button
                                    key={opt.id}
                                    onClick={() => setAudioMode(opt.id)}
                                    disabled={isMerging}
                                    className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2.5 border transition-colors disabled:opacity-40 ${
                                        audioMode === opt.id
                                            ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
                                            : 'bg-[var(--vm-input)] border-[var(--vm-border)] text-[var(--vm-text-dim)] hover:border-[var(--vm-border-2)]'
                                    }`}
                                >
                                    {opt.icon}
                                    <span className="text-[11px] font-medium">{opt.label}</span>
                                    <span className="text-[10px] text-[var(--vm-text-mute)]">{opt.hint}</span>
                                </button>
                            ))}
                        </div>

                        {/* TTS 音频地址 */}
                        {audioMode === 'tts' && (
                            <div className="mt-2.5">
                                <input
                                    type="text"
                                    value={audioUrl}
                                    onChange={(e) => setAudioUrl(e.target.value)}
                                    disabled={isMerging || trackBuilding}
                                    placeholder="留空即按资产音色自动生成整集配音音轨"
                                    className="w-full rounded-lg bg-[var(--vm-input)] border border-[var(--vm-border)] text-xs text-[var(--vm-text)] px-3 py-2 outline-none focus:border-purple-500/60 placeholder:text-[var(--vm-text-mute)] disabled:opacity-50"
                                />
                                <p className="text-[11px] text-[var(--vm-text-mute)] mt-1">
                                    留空时按「资产确认里每个角色的音色」逐条合成；资产换音色后会重新生成
                                </p>
                                {trackHint && (
                                    <p
                                        className={`text-[11px] mt-1 ${
                                            /失败|还没有|缺少/.test(trackHint)
                                                ? 'text-red-400'
                                                : 'text-emerald-300/90'
                                        }`}
                                    >
                                        {trackHint}
                                    </p>
                                )}
                                <p className="text-[11px] text-[var(--vm-text-mute)] mt-1">
                                    配音比视频短时会自动补静音，比视频长时按视频长度截断
                                </p>
                            </div>
                        )}
                    </section>

                    {/* ===== 错误提示 ===== */}
                    {error && (
                        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5">
                            <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-red-300 leading-relaxed">{error}</p>
                        </div>
                    )}

                    {/* ===== 已生成结果 ===== */}
                    {resultUrl && !isMerging && (
                        <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
                            <div className="flex items-center gap-1.5 mb-2">
                                <CheckCircle2 size={13} className="text-emerald-400" />
                                <span className="text-xs text-emerald-300">
                                    成片已生成
                                    {resultDuration ? ` · ${formatDuration(resultDuration)}` : ''}
                                </span>
                            </div>
                            <video
                                src={resultUrl}
                                controls
                                className="w-full rounded-lg bg-black"
                                style={{ maxHeight: 260 }}
                            />
                        </section>
                    )}
                </div>

                {/* ---------- Footer ---------- */}
                <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-t border-[var(--vm-border)] shrink-0">
                    <p className="text-[11px] text-[var(--vm-text-mute)]">
                        {clips.length < 2
                            ? '至少连接 2 个视频片段'
                            : isMerging
                                ? '正在拼接，长片段可能需要几十秒…'
                                : `将拼接 ${clips.length} 个片段${hasTransition ? `，含 ${clips.length - 1} 处转场` : '，硬切无转场'}`}
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            disabled={isMerging}
                            className="px-3.5 py-2 rounded-lg text-xs text-[var(--vm-text-dim)] hover:text-[var(--vm-text)] hover:bg-[var(--vm-hover)] disabled:opacity-40 transition-colors"
                        >
                            取消
                        </button>
                        <button
                            onClick={() => void handleConfirm()}
                            disabled={!canMerge}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-purple-600 text-white hover:bg-purple-500 disabled:bg-[var(--vm-hover)] disabled:text-[var(--vm-text-mute)] disabled:cursor-not-allowed transition-colors"
                        >
                            {trackBuilding ? (
                                <>
                                    <Loader2 size={13} className="animate-spin" />
                                    生成音轨中
                                </>
                            ) : isMerging ? (
                                <>
                                    <Loader2 size={13} className="animate-spin" />
                                    拼接中
                                </>
                            ) : (
                                <>
                                    <Film size={13} />
                                    {resultUrl ? '重新拼接' : '开始拼接'}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VideoMergePanel;
