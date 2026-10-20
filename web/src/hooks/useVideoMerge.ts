/**
 * useVideoMerge.ts
 *
 * 视频合并节点（VIDEO_MERGE）的模态框状态与拼接执行逻辑。
 *
 * 与 useVideoEditor 的区别：
 *   - Video Editor 是「单输入 → 裁剪」，只取第一个父节点；
 *   - Video Merge 是「多输入 → 拼接」，必须收集所有父节点，并按连线顺序排序。
 *
 * 连线顺序即播放顺序：按 parentIds 数组顺序（连线的先后）遍历，
 * 这样用户在画布上「先连第 1 集第 1 段，再连第 2 段」就能直接决定成片顺序。
 */

import { useState, useCallback, useMemo } from 'react';
import { NodeData, NodeStatus, NodeType } from '../types';
import {
    mergeVideos,
    validateMergeInput,
    type AudioMode,
    type MergeVideosResult,
} from '../services/mergeService';

// ============================================================================
// 类型
// ============================================================================

/** 一个待拼接的片段（从父节点解析而来） */
export interface MergeClip {
    /** 来源节点 id */
    nodeId: string;
    /** 视频地址 */
    url: string;
    /** 片段时长（秒），未知为 0 */
    duration: number;
    /** 来源节点类型，用于展示标签 */
    sourceType: string;
    /** 节点上的提示词，用于展示 */
    label?: string;
    /** 分镜序号（从分镜导入的节点才有） */
    shotNumber?: number;
    /** 所属集号（从分镜导入的节点才有），用于跨集排序 */
    shotEpisode?: number;
    /** 分镜建议的「切入本镜头」转场 id */
    shotTransitionOut?: string;
}

interface MergeModalState {
    isOpen: boolean;
    nodeId: string | null;
}

interface UseVideoMergeOptions {
    nodes: NodeData[];
    updateNode: (id: string, updates: Partial<NodeData>) => void;
}

// ============================================================================
// 工具
// ============================================================================

/**
 * 从节点上解析视频地址。
 *
 * VIDEO 节点的产物在 resultUrl；部分历史节点只有 lastFrame（末帧图），
 * 那不是视频，必须排除，否则会把图片当视频传给 ffmpeg。
 */
function resolveVideoUrl(node: NodeData): string | undefined {
    if (!node.resultUrl) return undefined;

    // 明确是视频扩展名 → 直接接受
    if (/\.(mp4|mov|webm|mkv|avi)(\?|$)/i.test(node.resultUrl)) {
        return node.resultUrl;
    }

    // 无扩展名时，按节点类型判断（后端仍会再校验一次文件是否可解析）
    if (node.type === NodeType.VIDEO
        || node.type === NodeType.VIDEO_EDITOR
        || node.type === NodeType.VIDEO_MERGE) {
        return node.resultUrl;
    }

    return undefined;
}

// ============================================================================
// HOOK
// ============================================================================

export const useVideoMerge = ({ nodes, updateNode }: UseVideoMergeOptions) => {
    const [mergeModal, setMergeModal] = useState<MergeModalState>({
        isOpen: false,
        nodeId: null,
    });
    const [isMerging, setIsMerging] = useState(false);
    const [mergeError, setMergeError] = useState<string | null>(null);

    /**
     * 解析某个合并节点的所有输入片段。
     *
     * 排序规则：
     *   1. 若节点上已保存 mergeClipUrls（用户手动调过序），以该顺序为准；
     *   2. 否则按 parentIds 的连线顺序。
     */
    const resolveClips = useCallback((node: NodeData): MergeClip[] => {
        const parentIds = node.parentIds || [];
        const clips: MergeClip[] = [];

        for (const pid of parentIds) {
            const parent = nodes.find((n) => n.id === pid);
            if (!parent) continue;

            const url = resolveVideoUrl(parent);
            if (!url) continue;

            clips.push({
                nodeId: parent.id,
                url,
                // VIDEO 节点用 videoDuration（生成时指定的时长），其余节点未知记 0
                duration: Number(parent.videoDuration) || 0,
                sourceType: parent.type,
                label: parent.prompt?.slice(0, 40),
                shotNumber: parent.shotNumber,
                shotEpisode: parent.shotEpisode,
                shotTransitionOut: parent.shotTransitionOut,
            });
        }

        // 若节点保存了手动排序，按其重排
        const saved = node.mergeClipUrls;
        const hasManualOrder = Array.isArray(saved) && saved.length > 0;
        if (hasManualOrder) {
            const order = new Map(saved.map((u, i) => [u, i]));
            clips.sort((a, b) => {
                const ia = order.has(a.url) ? order.get(a.url)! : Number.MAX_SAFE_INTEGER;
                const ib = order.has(b.url) ? order.get(b.url)! : Number.MAX_SAFE_INTEGER;
                return ia - ib;
            });
        } else if (clips.length > 1 && clips.every((c) => typeof c.shotNumber === 'number')) {
            /**
             * 没手动排过序、且片段全部来自分镜时，按「集号 → 片段号」排。
             * 连线先后顺序不可靠：先连了后面的镜头、或者重新连过线，
             * 都会让成片顺序与剧本顺序对不上。
             */
            clips.sort(
                (a, b) =>
                    (a.shotEpisode || 0) - (b.shotEpisode || 0) ||
                    (a.shotNumber || 0) - (b.shotNumber || 0)
            );
        }

        return clips;
    }, [nodes]);

    /** 当前打开节点对应的片段列表（供面板渲染） */
    const currentClips = useMemo(() => {
        if (!mergeModal.nodeId) return [];
        const node = nodes.find((n) => n.id === mergeModal.nodeId);
        if (!node) return [];
        return resolveClips(node);
    }, [mergeModal.nodeId, nodes, resolveClips]);

    /** 当前打开节点 */
    const currentNode = useMemo(
        () => (mergeModal.nodeId ? nodes.find((n) => n.id === mergeModal.nodeId) : undefined),
        [mergeModal.nodeId, nodes]
    );

    /**
     * 打开合并面板。
     */
    const handleOpenMerge = useCallback((nodeId: string) => {
        setMergeError(null);
        setMergeModal({ isOpen: true, nodeId });
    }, []);

    /**
     * 关闭合并面板。拼接进行中禁止关闭，避免状态丢失。
     */
    const handleCloseMerge = useCallback(() => {
        if (isMerging) return;
        setMergeModal({ isOpen: false, nodeId: null });
        setMergeError(null);
    }, [isMerging]);

    /**
     * 调整片段顺序（上移 / 下移）。
     *
     * 只把顺序写回节点的 mergeClipUrls，
     * 不改 parentIds —— 因为 parentIds 同时被连线渲染使用，
     * 直接改会导致 SVG 连线的端点跳变。
     */
    const handleReorderClips = useCallback((nodeId: string, fromIndex: number, toIndex: number) => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;

        const clips = resolveClips(node);
        if (fromIndex < 0 || fromIndex >= clips.length) return;
        if (toIndex < 0 || toIndex >= clips.length) return;

        const urls = clips.map((c) => c.url);
        const [moved] = urls.splice(fromIndex, 1);
        urls.splice(toIndex, 0, moved);

        updateNode(nodeId, { mergeClipUrls: urls });
    }, [nodes, resolveClips, updateNode]);

    /**
     * 执行拼接。
     *
     * @param nodeId 合并节点 id
     * @param options 转场与音轨配置
     */
    const handleMerge = useCallback(async (
        nodeId: string,
        options: {
            transition: string;
            transitionDuration: number;
            /** 逐边界转场 id（长度 = 片段数 - 1），不传则统一用 transition */
            transitions?: string[];
            /** 逐边界转场时长，不传则统一用 transitionDuration */
            transitionDurations?: number[];
            audioMode: AudioMode;
            audioUrl?: string;
            episode?: number;
        }
    ): Promise<MergeVideosResult | null> => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return null;

        const clips = resolveClips(node);
        const urls = clips.map((c) => c.url);

        // 前端预检
        const errors = validateMergeInput(urls);
        if (errors.length > 0) {
            setMergeError(errors[0]);
            return null;
        }

        // 逐边界转场长度必须与边界数（片段数 - 1）一致，否则退化为统一转场
        const boundaryCount = Math.max(0, urls.length - 1);
        const transitions = Array.isArray(options.transitions)
            && options.transitions.length === boundaryCount
            ? options.transitions
            : undefined;
        const transitionDurations = Array.isArray(options.transitionDurations)
            && options.transitionDurations.length === boundaryCount
            ? options.transitionDurations
            : undefined;

        setIsMerging(true);
        setMergeError(null);

        // 先把配置写回节点，这样即使用户刷新页面配置也不丢
        updateNode(nodeId, {
            status: NodeStatus.LOADING,
            mergeTransition: options.transition,
            mergeTransitionDuration: options.transitionDuration,
            mergeTransitions: transitions,
            mergeTransitionDurations: transitionDurations,
            mergeAudioMode: options.audioMode,
            mergeAudioUrl: options.audioUrl,
            mergeEpisode: options.episode,
            mergeClipUrls: urls,
            mergeClipDurations: clips.map((c) => c.duration),
        });

        try {
            const result = await mergeVideos({
                videos: urls,
                transition: options.transition,
                transitionDuration: options.transitionDuration,
                transitions,
                transitionDurations,
                audioMode: options.audioMode,
                audioUrl: options.audioUrl,
                episode: options.episode,
                prompt: node.prompt || '',
            });

            updateNode(nodeId, {
                status: NodeStatus.SUCCESS,
                resultUrl: result.url,
                mergeResultDuration: result.duration,
                mergeTransition: result.transition,
                mergeTransitionDuration: result.transitionDuration,
                mergeTransitions: result.boundaries?.map((b) => b.transition) ?? transitions,
                mergeClipDurations: result.clips.map((c) => c.duration),
                errorMessage: undefined,
            });

            return result;
        } catch (error) {
            const msg = (error as Error)?.message || '视频拼接失败';
            console.error('[useVideoMerge] 拼接失败:', error);
            setMergeError(msg);
            updateNode(nodeId, {
                status: NodeStatus.ERROR,
                errorMessage: msg,
            });
            return null;
        } finally {
            setIsMerging(false);
        }
    }, [nodes, resolveClips, updateNode]);

    /**
     * 清除已生成的成片，便于用新配置重试。
     */
    const handleClearResult = useCallback((nodeId: string) => {
        updateNode(nodeId, {
            status: NodeStatus.IDLE,
            resultUrl: undefined,
            mergeResultDuration: undefined,
            errorMessage: undefined,
        });
    }, [updateNode]);

    return {
        mergeModal,
        isMerging,
        mergeError,
        currentClips,
        currentNode,
        handleOpenMerge,
        handleCloseMerge,
        handleReorderClips,
        handleMerge,
        handleClearResult,
        resolveClips,
    };
};
