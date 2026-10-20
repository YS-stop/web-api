/**
 * shotImportService.ts
 *
 * 把「分镜片段」数据导入项目画布。
 *
 * 数据来源
 * ─────────────────────────────────────────────────────────────
 * ShotEditorPanel 把分镜状态存在 localStorage：
 *   key   = `shot-editor:<projectId>`
 *   value = { shots: Record<集号, ShotState[]>, history, videoIds, pendingVideoJobs }
 * 其中 ShotState = ShotItem + { videoUrl?, imageUrl? }，videoUrl 即该分镜的成片。
 *
 * 导入策略
 * ─────────────────────────────────────────────────────────────
 * 1. 只导入指定集（按集隔离），节点上写 mergeEpisode 作为归属标记；
 * 2. 有 videoUrl 的分镜 → VIDEO 节点（SUCCESS，可直接进合并节点）
 *    只有 imageUrl 的分镜 → IMAGE 节点（可继续图生视频）
 *    两者都没有 → 跳过（空分镜没有导入价值）
 * 3. 每集额外生成一个 VIDEO_MERGE 节点，父节点按顺序指向本集所有视频片段，
 *    用户双击即可一键拼成整集成片。
 * 4. 布局用两列网格，避免节点重叠。
 */

import { NodeData, NodeStatus, NodeType } from '../types';

// ============================================================================
// 类型
// ============================================================================

/** localStorage 中单条分镜的状态（与 ShotEditorPanel 的 ShotState 对齐） */
export interface StoredShot {
    shotNumber: number;
    description: string;
    cameraAngle?: string;
    cameraMovement?: string;
    lighting?: string;
    mood?: string;
    durationSeconds?: number;
    /** 从上一镜头切到本镜头用的转场 id（后端 split-shots 生成） */
    transitionOut?: string;
    prompt?: string;
    videoUrl?: string;
    imageUrl?: string;
}

/** localStorage 中整份分镜存储 */
export interface ShotEditorStore {
    shots: Record<string, StoredShot[]>;
    history?: Record<string, string[]>;
    videoIds?: Record<string, string>;
    pendingVideoJobs?: unknown[];
}

/** 导入结果 */
export interface ImportShotsResult {
    nodes: NodeData[];
    /** 导入的视频片段数 */
    videoCount: number;
    /** 导入的图片数 */
    imageCount: number;
    /** 跳过的空分镜数 */
    skipped: number;
    /** 该集的合并节点 id（有视频片段时才有） */
    mergeNodeId?: string;
}

// ============================================================================
// 读取
// ============================================================================

const storeKey = (projectId: string) => `shot-editor:${projectId}`;

/**
 * 读取项目的分镜存储。解析失败返回 null。
 */
export function loadShotStore(projectId: string): ShotEditorStore | null {
    try {
        const raw = localStorage.getItem(storeKey(projectId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as ShotEditorStore;
    } catch (error) {
        console.warn('[shotImport] 读取分镜存储失败:', error);
        return null;
    }
}

/**
 * 取某一集的分镜列表（按 shotNumber 升序）。
 */
export function getEpisodeShots(projectId: string, episode: number): StoredShot[] {
    const store = loadShotStore(projectId);
    if (!store?.shots) return [];
    const list = store.shots[String(episode)] || store.shots[episode as any];
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => (a.shotNumber || 0) - (b.shotNumber || 0));
}

/**
 * 统计某集可导入的分镜数量（有视频或图片的）。
 */
export function countImportableShots(projectId: string, episode: number): {
    total: number;
    withVideo: number;
    withImageOnly: number;
} {
    const shots = getEpisodeShots(projectId, episode);
    let withVideo = 0;
    let withImageOnly = 0;
    for (const s of shots) {
        if (s.videoUrl) withVideo += 1;
        else if (s.imageUrl) withImageOnly += 1;
    }
    return { total: shots.length, withVideo, withImageOnly };
}

// ============================================================================
// 转换
// ============================================================================

/** 布局常量 */
const COL_GAP = 400;
const ROW_GAP = 460;
const COLUMNS = 2;

/**
 * 走后端 /api/video-merge/shots-to-nodes 转换（主路径）。
 *
 * 为什么优先走后端：节点布局、去重、合并节点连线规则集中一处，
 * 避免前端与画布 / 将来的批量脚本各写一套而漂移。
 * 后端不可用（未启动、旧版本）时返回 null，由调用方回落本地实现。
 */
export async function buildShotNodesRemote(params: {
    projectId: string;
    episode: number;
    originX: number;
    originY: number;
    aspectRatio?: string;
    includeImages?: boolean;
    createMergeNode?: boolean;
    existingNodes?: NodeData[];
}): Promise<ImportShotsResult | null> {
    const {
        projectId,
        episode,
        originX,
        originY,
        aspectRatio = '9:16',
        includeImages = true,
        createMergeNode = true,
        existingNodes = [],
    } = params;

    const shots = getEpisodeShots(projectId, episode);
    if (shots.length === 0) return null;

    // 已导入过的片段地址，交给后端去重
    const existingUrls = existingNodes
        .filter((n) => n.mergeEpisode === episode && n.resultUrl)
        .map((n) => n.resultUrl as string);

    try {
        const res = await fetch('/api/video-merge/shots-to-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shots,
                episode,
                originX,
                originY,
                aspectRatio,
                includeImages,
                createMergeNode,
                existingUrls,
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.success || !Array.isArray(data.nodes)) return null;

        return {
            nodes: data.nodes as NodeData[],
            videoCount: Number(data.videoCount) || 0,
            imageCount: Number(data.imageCount) || 0,
            skipped: Number(data.skipped) || 0,
            mergeNodeId: data.mergeNodeId || undefined,
        };
    } catch (error) {
        // 后端不可用时静默回落，导入功能不应因后端缺失而中断
        console.warn('[shotImport] 后端转换不可用，回落本地实现:', error);
        return null;
    }
}

/**
 * 生成分镜的提示词。
 * 优先用 shot.prompt（AI 已生成的完整提示词），否则用结构化字段拼装。
 */
function buildShotPrompt(shot: StoredShot): string {
    if (shot.prompt && shot.prompt.trim()) return shot.prompt.trim();

    const parts = [
        shot.description,
        shot.cameraAngle ? `镜头：${shot.cameraAngle}` : '',
        shot.cameraMovement ? `运镜：${shot.cameraMovement}` : '',
        shot.lighting ? `光线：${shot.lighting}` : '',
        shot.mood ? `氛围：${shot.mood}` : '',
    ].filter(Boolean);

    return parts.join('\n');
}

/**
 * 把某集的分镜转换成画布节点。
 *
 * @param params.projectId 项目 id
 * @param params.episode 集号
 * @param params.originX 起始画布坐标 x
 * @param params.originY 起始画布坐标 y
 * @param params.aspectRatio 画布比例（默认 9:16）
 * @param params.includeImages 是否导入只有图片的分镜（默认 true）
 * @param params.createMergeNode 是否为本集自动建合并节点（默认 true）
 * @param params.existingNodes 当前画布已有节点（用于避免重复导入）
 */
export function buildShotNodes(params: {
    projectId: string;
    episode: number;
    originX: number;
    originY: number;
    aspectRatio?: string;
    includeImages?: boolean;
    createMergeNode?: boolean;
    existingNodes?: NodeData[];
}): ImportShotsResult {
    const {
        projectId,
        episode,
        originX,
        originY,
        aspectRatio = '9:16',
        includeImages = true,
        createMergeNode = true,
        existingNodes = [],
    } = params;

    const shots = getEpisodeShots(projectId, episode);
    const nodes: NodeData[] = [];

    // 已导入过的视频地址，避免重复点击导入产生重复节点
    const existingUrls = new Set(
        existingNodes
            .filter((n) => n.mergeEpisode === episode && n.resultUrl)
            .map((n) => n.resultUrl!)
    );

    let videoCount = 0;
    let imageCount = 0;
    let skipped = 0;
    let slot = 0;

    const videoNodeIds: string[] = [];
    /** 与 videoNodeIds 一一对应的转场建议（第 i 个元素表示「从上一段切到第 i 段」的转场） */
    const videoTransitionOuts: string[] = [];

    for (const shot of shots) {
        const hasVideo = !!shot.videoUrl;
        const hasImage = !!shot.imageUrl;

        if (!hasVideo && !hasImage) {
            skipped += 1;
            continue;
        }
        if (!hasVideo && hasImage && !includeImages) {
            skipped += 1;
            continue;
        }

        const url = hasVideo ? shot.videoUrl! : shot.imageUrl!;
        if (existingUrls.has(url)) {
            skipped += 1;
            continue;
        }

        const col = slot % COLUMNS;
        const row = Math.floor(slot / COLUMNS);
        slot += 1;

        const node: NodeData = {
            id: crypto.randomUUID(),
            type: hasVideo ? NodeType.VIDEO : NodeType.IMAGE,
            x: originX + col * COL_GAP,
            y: originY + row * ROW_GAP,
            title: `第 ${episode} 集 · 镜头 ${shot.shotNumber}`,
            prompt: buildShotPrompt(shot),
            status: NodeStatus.SUCCESS,
            resultUrl: url,
            model: hasVideo ? 'doubao-seedance-2-0-260128' : 'gpt-image-1.5',
            videoModel: hasVideo ? 'doubao-seedance-2-0-260128' : undefined,
            imageModel: hasVideo ? undefined : 'gpt-image-1.5',
            videoDuration: shot.durationSeconds || (hasVideo ? 5 : undefined),
            aspectRatio,
            resolution: hasVideo ? '720p' : '1K',
            parentIds: [],
            // 分集归属标记：用于按集隔离、重复导入检测、合并节点分组
            mergeEpisode: episode,
            // 分镜溯源信息
            shotNumber: shot.shotNumber,
            shotTransitionOut: shot.transitionOut,
        };

        nodes.push(node);

        if (hasVideo) {
            videoCount += 1;
            videoNodeIds.push(node.id);
            // 保留转场建议，合并节点按此顺序取用
            videoTransitionOuts.push(shot.transitionOut || 'fade');
        } else {
            imageCount += 1;
        }
    }

    // ---------- 为本集创建合并节点 ----------
    let mergeNodeId: string | undefined;
    if (createMergeNode && videoNodeIds.length >= 2) {
        const rowCount = Math.ceil(slot / COLUMNS);
        mergeNodeId = crypto.randomUUID();

        nodes.push({
            id: mergeNodeId,
            type: NodeType.VIDEO_MERGE,
            x: originX + COLUMNS * COL_GAP,
            y: originY + Math.max(0, rowCount - 1) * ROW_GAP / 2,
            title: `第 ${episode} 集 · 合并成片`,
            prompt: `第 ${episode} 集整集拼接`,
            status: NodeStatus.IDLE,
            model: '',
            aspectRatio,
            resolution: '720p',
            // 父节点顺序 = 分镜顺序 = 播放顺序
            parentIds: videoNodeIds,
            mergeEpisode: episode,
            mergeTransition: 'fade',
            mergeTransitionDuration: 0.5,
            // 逐边界转场：第 k 个边界（片段 k → k+1）取第 k+1 段的 transitionOut，
            // 与 split-shots 的语义一致（「切入本镜头」的转场）
            mergeTransitions: videoTransitionOuts.slice(1),
            mergeTransitionDurations: videoTransitionOuts.slice(1).map(() => 0.5),
            mergeAudioMode: 'keep',
            mergeClipUrls: nodes
                .filter((n) => videoNodeIds.includes(n.id))
                .map((n) => n.resultUrl!),
        });
    }

    return { nodes, videoCount, imageCount, skipped, mergeNodeId };
}
