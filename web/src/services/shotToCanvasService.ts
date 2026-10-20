/**
 * shotToCanvasService.ts
 *
 * 「分镜 → 画布节点」转换：把一个分镜搭成完整的生成链路。
 *
 * 生成的节点拓扑
 * ─────────────────────────────────────────────────────────────
 *   [参考图 A] ─┐
 *   [参考图 B] ─┼─→  [视频节点]
 *   [参考图 C] ─┘
 *
 * 布局
 * ─────────────────────────────────────────────────────────────
 * 参考图在左、视频在右，参考图整体相对视频节点垂直居中；
 * 每列最多 4 张（超过则分两列），链路整体尺寸由 buildShotChain 返回，
 * 批量铺开时按该尺寸逐行下移，保证不重叠。
 *
 * 说明
 * ─────────────────────────────────────────────────────────────
 * 1. 参考图节点（IMAGE，SUCCESS）：每个命中资产一张，直接带 resultUrl，
 *    不需要再生成，只是给视频节点提供形象/场景/道具的一致性依据。
 * 2. 视频节点（VIDEO，IDLE）：提示词已按「画面主体与动作 + 景别/运镜/光线/氛围 +
 *    风格 + 禁止项」拼好，parentIds 指向所有参考图，videoInputMode='reference'
 *    保证多张父图走 reference_image 而不是被误判成首尾帧插值。
 * 3. 分镜自带首帧图（shot.imageUrl）且没有命中任何参考图时，该图单独成节点，
 *    此时视频节点走 first-frame 语义。
 * 4. 已有视频（shot.videoUrl）直接建成 SUCCESS 的 VIDEO 节点，不再触发生成。
 */

import { NodeData, NodeStatus, NodeType } from '../types';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '../constants/modelDefaults';
import { AnalyzedEpisode } from './scriptAnalysisService';
import {
    ShotState,
    MatchedRef,
    RefAssets,
    composeModelVideoPrompt,
    matchRefsForShot,
    resolveShotStyle,
    makeShotCode,
} from './shotService';

// ============================================================================
// 布局常量
// ============================================================================

/** 画布节点近似尺寸（CanvasNode 图片/视频节点宽 340px） */
export const CHAIN_LAYOUT = {
    /** 节点宽 */
    NODE_W: 340,
    /** 图片节点近似高度（宽 340 + 图片最高 500 + 标题/操作栏） */
    REF_H: 480,
    /** 视频节点宽度（带结果时会自适应，按 360 预留） */
    VIDEO_W: 360,
    /** 视频节点近似高度 */
    VIDEO_H: 460,
    /** 参考图列间距 */
    REF_GAP_X: 48,
    /** 参考图行间距 */
    REF_GAP_Y: 40,
    /** 参考图区与视频节点间距（留出连线空间） */
    VIDEO_GAP_X: 160,
    /** 相邻分镜链路之间的纵向间距 */
    CHAIN_GAP_Y: 140,
    /** 单列最多几张参考图 */
    MAX_REFS_PER_COL: 4,
    /** 满列后允许的最大列数（9 张参考图排 3 列 × 3 行，避免过长） */
    MAX_REF_COLS: 3,
} as const;

// ============================================================================
// 类型
// ============================================================================

export interface BuildShotChainParams {
    projectId: string;
    episode: AnalyzedEpisode;
    shot: ShotState;
    /** 链路起点坐标（链路左上角） */
    originX: number;
    originY: number;
    /** 项目内容类型，用于推导默认风格与形象 */
    contentType?: string;
    /** 画布比例 */
    aspectRatio?: string;
    /** 视频时长（秒），优先用分镜自带的 durationSeconds */
    duration?: number;
    /** 已存在的节点，用于跳过重复参考图 */
    existingNodes?: NodeData[];
    /**
     * 是否复用画布上已有的同 URL 参考图节点。
     * true 时不新建图片节点，直接连到已有节点，避免同一角色反复建图。
     */
    reuseExistingRefs?: boolean;
    /**
     * 参考图匹配数据源：优先传「资产确认」里已生成图片的资产，
     * 否则剧本解析的资产没有 imageUrl，会导致人物参考图匹配不到。
     */
    refAssets?: RefAssets;
}

export interface BuildShotChainResult {
    /** 新建的全部节点（参考图 + 视频） */
    nodes: NodeData[];
    /** 视频节点 id（用于触发生成） */
    videoNodeId: string;
    /** 视频节点是否已有成片（true 则不需要触发生成） */
    hasExistingVideo: boolean;
    /** 命中的参考图数量 */
    refCount: number;
    /** 复用了画布上已有参考图的数量（未新建图片节点） */
    reusedRefCount: number;
    /** 视频节点的输入模式，供调用方决定是否需要首帧 */
    inputMode: 'reference' | 'first-frame' | 'auto';
    /** 整条链路占用的画布尺寸，供批量布局排下一行 */
    size: { width: number; height: number };
}

// ============================================================================
// 构建
// ============================================================================

/**
 * 把一个分镜搭成「参考图 → 视频」的完整链路。
 */
export const buildShotChain = (params: BuildShotChainParams): BuildShotChainResult => {
    const {
        episode,
        shot,
        originX,
        originY,
        contentType,
        aspectRatio = '9:16',
        duration = 5,
        existingNodes = [],
        reuseExistingRefs = true,
        refAssets,
    } = params;

    const { style, form } = resolveShotStyle(contentType);
    const nodes: NodeData[] = [];
    const { NODE_W, REF_H, REF_GAP_X, REF_GAP_Y, VIDEO_W, VIDEO_H, VIDEO_GAP_X, MAX_REFS_PER_COL, MAX_REF_COLS } = CHAIN_LAYOUT;

    // ---------- 1. 收集参考图 ----------
    const matched: MatchedRef[] = matchRefsForShot(shot, episode, refAssets);

    /** 已存在节点里 URL → 节点，用于复用 */
    const existingByUrl = new Map<string, NodeData>();
    for (const n of existingNodes) {
        if (n.resultUrl && (n.type === NodeType.IMAGE || n.type === NodeType.VIDEO)) {
            existingByUrl.set(n.resultUrl, n);
        }
    }

    const refParentIds: string[] = [];
    const refUrls: string[] = [];
    const usedUrls = new Set<string>();
    let reusedRefCount = 0;

    const pushRef = (name: string, url: string) => {
        if (!url || usedUrls.has(url)) return;
        usedUrls.add(url);
        refUrls.push(url);

        // 复用画布上已有的同 URL 图片节点，避免同一角色反复建图
        if (reuseExistingRefs) {
            const existed = existingByUrl.get(url);
            if (existed) {
                refParentIds.push(existed.id);
                reusedRefCount += 1;
                return;
            }
        }

        const node: NodeData = {
            id: crypto.randomUUID(),
            type: NodeType.IMAGE,
            // 位置在下面统一排版（先占位，避免逐张计算）
            x: originX,
            y: originY,
            title: name,
            prompt: name,
            status: NodeStatus.SUCCESS,
            resultUrl: url,
            model: DEFAULT_IMAGE_MODEL,
            imageModel: DEFAULT_IMAGE_MODEL,
            aspectRatio,
            resolution: '1K',
            parentIds: [],
            // 标记来源，便于画布区分「分镜参考图」与用户自己建的图
            shotRefFor: shot.shotNumber,
        };
        nodes.push(node);
        refParentIds.push(node.id);
    };

    matched.forEach((m) => pushRef(m.name, m.url));

    // ---------- 2. 决定视频节点的输入模式 ----------
    // 有参考图 → 走 reference（多图作参考，不贴首帧）
    // 无参考图但有分镜首帧图 → 该图作首帧
    // 两者都没有 → auto（纯文生视频）
    let inputMode: BuildShotChainResult['inputMode'] = 'auto';

    if (refParentIds.length > 0) {
        inputMode = 'reference';
    } else if (shot.imageUrl) {
        inputMode = 'first-frame';
        pushRef(`第 ${episode.episode} 集 · 镜头 ${shot.shotNumber} 首帧`, shot.imageUrl);
        // 首帧图必须作为第一个父节点
        if (refParentIds.length > 1) {
            const first = refParentIds.pop()!;
            refParentIds.unshift(first);
        }
    }

    // ---------- 3. 参考图排版（左列，相对视频垂直居中） ----------
    const refCount = refUrls.length;
    // 1 列最多 MAX_REFS_PER_COL 张，超过则加列，最多 MAX_REF_COLS 列
    const cols = Math.min(MAX_REF_COLS, Math.max(1, Math.ceil(refCount / MAX_REFS_PER_COL)));
    const rows = refCount > 0 ? Math.ceil(refCount / cols) : 0;
    const refsWidth = refCount > 0 ? cols * NODE_W + (cols - 1) * REF_GAP_X : 0;
    const refsHeight = rows > 0 ? rows * REF_H + (rows - 1) * REF_GAP_Y : 0;

    const contentHeight = Math.max(VIDEO_H, refsHeight);
    const refsTop = originY + Math.max(0, (contentHeight - refsHeight) / 2);
    const videoX = refCount > 0 ? originX + refsWidth + VIDEO_GAP_X : originX;
    const videoY = originY + Math.max(0, (contentHeight - VIDEO_H) / 2);

    // 先列后行的填充顺序：第一列从上到下，再第二列
    nodes.forEach((node, index) => {
        const col = Math.floor(index / Math.max(1, rows));
        const row = index % Math.max(1, rows);
        node.x = originX + col * (NODE_W + REF_GAP_X);
        node.y = refsTop + row * (REF_H + REF_GAP_Y);
    });

    // ---------- 4. 视频节点 ----------
    const videoNodeId = crypto.randomUUID();
    // 把命中的参考图一并交给提示词：提示词里会写明「图N=谁」，模型才知道哪张图控制什么
    const prompt = composeModelVideoPrompt(
        shot,
        style,
        form,
        matched.map((m) => ({ name: m.name, category: m.category }))
    );
    const hasExistingVideo = !!shot.videoUrl;

    const videoNode: NodeData = {
        id: videoNodeId,
        type: NodeType.VIDEO,
        x: videoX,
        y: videoY,
        // 节点标题直接用片段编号（EP04-4-1-03），和分镜列表里的编号一一对应
        title: makeShotCode(episode.episode, shot.sceneNumber, shot.shotNumber),
        prompt,
        status: hasExistingVideo ? NodeStatus.SUCCESS : NodeStatus.IDLE,
        resultUrl: hasExistingVideo ? shot.videoUrl : undefined,
        model: DEFAULT_VIDEO_MODEL,
        videoModel: DEFAULT_VIDEO_MODEL,
        videoDuration: shot.durationSeconds || duration,
        aspectRatio,
        resolution: '720p',
        generateAudio: true,
        parentIds: refParentIds,
        videoInputMode: inputMode,
        // 溯源信息：从哪个分镜来的，便于后续回写结果 / 去重
        shotEpisode: episode.episode,
        shotNumber: shot.shotNumber,
    };

    nodes.push(videoNode);

    return {
        nodes,
        videoNodeId,
        hasExistingVideo,
        refCount: matched.length,
        reusedRefCount,
        inputMode,
        size: {
            width: refsWidth + (refCount > 0 ? VIDEO_GAP_X : 0) + VIDEO_W,
            height: contentHeight,
        },
    };
};

/**
 * 批量把一个分镜列表搭成链路。
 *
 * - 按链路实际高度逐行下移，避免不同参考图数量造成重叠；
 * - 画布上已存在该分镜视频节点（shotEpisode + shotNumber）时默认跳过，
 *   所以重复点击「添加整集」或进入画布自动导入都不会产生重复节点。
 */
export const buildShotsChain = (params: {
    projectId: string;
    episode: AnalyzedEpisode;
    shots: ShotState[];
    originX: number;
    originY: number;
    contentType?: string;
    aspectRatio?: string;
    duration?: number;
    existingNodes?: NodeData[];
    refAssets?: RefAssets;
    /** 是否复用画布上已有的参考图节点 */
    reuseExistingRefs?: boolean;
    /** 已存在同分镜视频节点时是否跳过（默认跳过） */
    skipExistingShots?: boolean;
}): { nodes: NodeData[]; videoNodeIds: string[]; totalRefs: number; skipped: number } => {
    const { episode, shots, originX, originY, skipExistingShots = true } = params;
    const allNodes: NodeData[] = [];
    const videoNodeIds: string[] = [];
    let totalRefs = 0;
    let skipped = 0;

    // 画布上已有本集分镜视频节点的分镜号（用于去重）。
    // 只认带 shotEpisode 的节点，避免把「分镜视频导入」等其他来源的视频节点误判成本集分镜。
    const existingShotKeys = new Set<string>();
    for (const n of params.existingNodes || []) {
        if (n.type === NodeType.VIDEO && n.shotEpisode != null && n.shotNumber != null) {
            existingShotKeys.add(`${n.shotEpisode}:${n.shotNumber}`);
        }
    }

    let cursorY = originY;

    shots.forEach((shot) => {
        const key = `${episode.episode}:${shot.shotNumber}`;
        if (skipExistingShots && existingShotKeys.has(key)) {
            skipped += 1;
            return;
        }

        // 传入已累积的节点，保证同一批次里重复出现的角色参考图按配置复用
        const result = buildShotChain({
            ...params,
            shot,
            originX,
            originY: cursorY,
            existingNodes: [...(params.existingNodes || []), ...allNodes],
        });
        allNodes.push(...result.nodes);
        videoNodeIds.push(result.videoNodeId);
        totalRefs += result.refCount;
        existingShotKeys.add(key);
        cursorY += result.size.height + CHAIN_LAYOUT.CHAIN_GAP_Y;
    });

    return { nodes: allNodes, videoNodeIds, totalRefs, skipped };
};

// ============================================================================
// 画布落点
// ============================================================================

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 两个矩形是否相交（留一点安全边距） */
const intersects = (a: Rect, b: Rect, margin = 40): boolean =>
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y;

/** 节点近似包围盒（按节点类型取宽高常量） */
const nodeRect = (node: NodeData): Rect => {
    const isVideo = node.type === NodeType.VIDEO || node.type === NodeType.VIDEO_MERGE || node.type === NodeType.VIDEO_EDITOR;
    return {
        x: node.x,
        y: node.y,
        width: isVideo ? CHAIN_LAYOUT.VIDEO_W : CHAIN_LAYOUT.NODE_W,
        height: isVideo ? CHAIN_LAYOUT.VIDEO_H : CHAIN_LAYOUT.REF_H,
    };
};

/**
 * 为新链路找一个不与现有节点重叠的落点：
 * 首选传入的 origin；若与现有节点重叠，则排到现有内容最右侧再留出间距。
 */
export const placeChainOrigin = (
    nodes: NodeData[],
    origin: { x: number; y: number },
    size: { width: number; height: number }
): { x: number; y: number } => {
    if (nodes.length === 0) return origin;

    const candidate: Rect = { x: origin.x, y: origin.y, width: size.width, height: size.height };
    const overlapped = nodes.some((n) => intersects(candidate, nodeRect(n)));
    if (!overlapped) return origin;

    const right = Math.max(...nodes.map((n) => n.x + nodeRect(n).width));
    return { x: right + 160, y: origin.y };
};
