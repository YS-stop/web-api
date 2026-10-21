import { CanvasAssetCategory, NodeData, NodeType } from '../types';

export type { CanvasAssetCategory } from '../types';

export interface CanvasAssetSource {
    name: string;
    aliases?: string[];
    imageUrl?: string;
    looks?: { imageUrl?: string }[];
}

export type CanvasAssetSources = Partial<Record<CanvasAssetCategory, CanvasAssetSource[]>>;

export interface CanvasAssetGroup {
    category: CanvasAssetCategory;
    x: number;
    y: number;
    width: number;
    height: number;
    count: number;
}

export interface CanvasAssetOrganizeResult {
    nodes: NodeData[];
    changed: boolean;
    removedDuplicates: number;
}

export const CANVAS_ASSET_CATEGORY_ORDER: CanvasAssetCategory[] = ['characters', 'scenes', 'props'];

const LAYOUT = {
    ORIGIN_X: 120,
    ORIGIN_Y: 130,
    NODE_W: 360,
    NODE_H: 520,
    GAP_X: 24,
    GAP_Y: 12,
    GROUP_COLS: 3,
    GROUP_PAD_X: 28,
    GROUP_HEADER_H: 96,
    GROUP_NODE_TOP_GAP: 0,
    GROUP_PAD_BOTTOM: 28,
    GROUP_GAP_Y: 64,
    VIDEO_GAP_X: 520,
    VIDEO_W: 360,
    VIDEO_H: 500,
    VIDEO_GAP_X_WITHIN: 56,
    VIDEO_GAP_Y: 56,
    /** 分镜视频按场景分行：每行左侧的场景标签区宽度（与画布渲染保持一致） */
    VIDEO_SCENE_LABEL_W: 200,
    /** 场景块内边距 */
    VIDEO_SCENE_PAD_X: 24,
    VIDEO_SCENE_PAD_Y: 24,
    /** 场景块之间的垂直间距 */
    VIDEO_SCENE_GAP_Y: 40,
} as const;

const normalizeName = (value?: string): string => (value || '').trim().toLowerCase();

/** URL 去掉查询参数后作为资产身份，避免带时间戳的同一张图被重复展示。 */
const normalizeUrl = (value?: string): string => (value || '').split(/[?#]/)[0].trim();

const assetUrlKeys = (value?: string): string[] => {
    const url = normalizeUrl(value);
    if (!url) return [];
    const filename = url.split('/').pop() || '';
    return filename && filename !== url ? [url, filename] : [url];
};

const assetNameKeys = (value?: string): string[] => {
    const name = normalizeName(value);
    if (!name) return [];
    const core = name.split(/[（(·\s]/)[0].trim();
    return core.length >= 2 && core !== name ? [name, core] : [name];
};

interface AssetCategoryIndex {
    byUrl: Map<string, CanvasAssetCategory>;
    byName: Map<string, CanvasAssetCategory>;
    order: Map<string, number>;
}

const buildCategoryIndex = (assets: CanvasAssetSources): AssetCategoryIndex => {
    const byUrl = new Map<string, CanvasAssetCategory>();
    const byName = new Map<string, CanvasAssetCategory>();
    const order = new Map<string, number>();
    let sequence = 0;

    for (const category of CANVAS_ASSET_CATEGORY_ORDER) {
        for (const asset of assets[category] || []) {
            const names = [asset.name, ...(asset.aliases || [])];
            for (const name of names) {
                for (const key of assetNameKeys(name)) {
                    if (!byName.has(key)) byName.set(key, category);
                    if (!order.has(key)) order.set(key, sequence);
                }
            }
            const urls = [asset.imageUrl, ...(asset.looks || []).map((look) => look.imageUrl)];
            for (const url of urls) {
                for (const key of assetUrlKeys(url)) {
                    if (!byUrl.has(key)) byUrl.set(key, category);
                }
            }
            sequence += 1;
        }
    }

    return { byUrl, byName, order };
};

const inferCategory = (node: NodeData, index: AssetCategoryIndex): CanvasAssetCategory | undefined => {
    if (node.assetCategory) return node.assetCategory;
    /** 只归类来自「分镜参考图」的图片，用户自己创建的图片保持原样。 */
    if (node.type !== NodeType.IMAGE || node.shotRefFor == null) return undefined;

    for (const key of assetUrlKeys(node.resultUrl)) {
        const category = index.byUrl.get(key);
        if (category) return category;
    }
    for (const key of assetNameKeys(node.title)) {
        const category = index.byName.get(key);
        if (category) return category;
    }
    return undefined;
};

const referenceKey = (node: NodeData, category: CanvasAssetCategory): string => {
    const url = normalizeUrl(node.resultUrl);
    return `${category}:${url || normalizeName(node.title) || node.id}`;
};

/* ========================================================================== */
/* 分镜视频：按场景分组                                                        */
/* ========================================================================== */

export interface CanvasShotSceneGroup {
    key: string;
    label: string;
    episode: number | null;
    scene: string;
    x: number;
    y: number;
    width: number;
    height: number;
    count: number;
}

const SHOT_SCENE_UNASSIGNED = '未分场';

/** 从节点标题 `EP04-4-1-03` 解析场号（中间段），兼容未写入 shotScene 的旧节点。 */
const parseSceneFromTitle = (title?: string): string | undefined => {
    if (!title) return undefined;
    const matched = /^EP\d+-(.+)-(\d+)$/.exec(title.trim());
    return matched ? matched[1] : undefined;
};

const resolveShotScene = (node: NodeData): string => {
    const direct = String(node.shotScene || '').trim();
    if (direct) return direct;
    const parsed = String(parseSceneFromTitle(node.title) || '').trim();
    return parsed || SHOT_SCENE_UNASSIGNED;
};

interface ShotVideoSceneBucket {
    key: string;
    episode: number | null;
    scene: string;
    nodes: NodeData[];
}

/**
 * 把分镜视频节点按「集 + 场」分组：
 * 场号优先取节点上的 shotScene，旧节点回退到标题 `EP04-4-1-03` 里的中间段。
 * 场景顺序按集号后按场号自然排序，未分场排在最后。
 */
const groupShotVideosByScene = (nodes: NodeData[]): ShotVideoSceneBucket[] => {
    const shotVideos = nodes
        .filter((node) => node.type === NodeType.VIDEO && node.shotEpisode != null)
        .sort(
            (a, b) =>
                (a.shotEpisode ?? 0) - (b.shotEpisode ?? 0) ||
                (a.shotNumber ?? 0) - (b.shotNumber ?? 0) ||
                a.id.localeCompare(b.id)
        );

    const buckets = new Map<string, ShotVideoSceneBucket>();
    for (const node of shotVideos) {
        const scene = resolveShotScene(node);
        const episode = node.shotEpisode ?? null;
        const key = `${episode ?? '-'}:${scene}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { key, episode, scene, nodes: [] };
            buckets.set(key, bucket);
        }
        bucket.nodes.push(node);
    }

    const groups = [...buckets.values()];
    groups.sort((a, b) => {
        if (a.episode !== null && b.episode !== null && a.episode !== b.episode) {
            return a.episode - b.episode;
        }
        if (a.scene === SHOT_SCENE_UNASSIGNED) return 1;
        if (b.scene === SHOT_SCENE_UNASSIGNED) return -1;
        return a.scene.localeCompare(b.scene, 'zh-CN', { numeric: true });
    });
    groups.forEach((group) => {
        group.nodes.sort(
            (a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0) || a.id.localeCompare(b.id)
        );
    });

    return groups;
};

const sceneGroupLabel = (
    group: { episode: number | null; scene: string },
    multiEpisode: boolean
): string =>
    multiEpisode && group.episode != null
        ? `EP${String(group.episode).padStart(2, '0')} · ${group.scene} 场景`
        : `${group.scene} 场景`;

/**
 * 画布资产归类：
 * 1. 参考图按人物 / 场景 / 道具分类；
 * 2. 同类别、同图片的节点合并，视频节点 parentIds 自动改连到保留节点；
 * 3. 三类资产从上到下排布，分镜视频集中在右侧，原有拖拽 / 连线 / 缩放逻辑不变。
 */
export const organizeCanvasAssetNodes = (
    inputNodes: NodeData[],
    assets: CanvasAssetSources
): CanvasAssetOrganizeResult => {
    const index = buildCategoryIndex(assets);
    const duplicateToCanonical = new Map<string, string>();
    const canonicalByKey = new Map<string, NodeData>();
    let changed = false;

    const classified = inputNodes.map((node) => {
        const category = inferCategory(node, index);
        if (category && node.assetCategory !== category) {
            changed = true;
            return { ...node, assetCategory: category };
        }
        return node;
    });

    const deduped: NodeData[] = [];
    for (const node of classified) {
        if (!node.assetCategory) {
            deduped.push(node);
            continue;
        }

        const key = referenceKey(node, node.assetCategory);
        const canonical = canonicalByKey.get(key);
        if (canonical) {
            duplicateToCanonical.set(node.id, canonical.id);
            changed = true;
            continue;
        }
        canonicalByKey.set(key, node);
        deduped.push(node);
    }

    const nodes = deduped.map((node) => {
        if (!node.parentIds || node.parentIds.length === 0) return node;
        const nextParentIds: string[] = [];
        for (const parentId of node.parentIds) {
            const canonicalId = duplicateToCanonical.get(parentId) || parentId;
            if (!nextParentIds.includes(canonicalId)) nextParentIds.push(canonicalId);
        }
        if (nextParentIds.length === node.parentIds.length && nextParentIds.every((id, i) => id === node.parentIds![i])) {
            return node;
        }
        changed = true;
        return { ...node, parentIds: nextParentIds };
    });

    const groups = CANVAS_ASSET_CATEGORY_ORDER.map((category) => ({
        category,
        nodes: nodes.filter((node) => node.assetCategory === category),
    })).filter((group) => group.nodes.length > 0);

    if (groups.length === 0) {
        return { nodes, changed, removedDuplicates: duplicateToCanonical.size };
    }

    for (const group of groups) {
        group.nodes.sort((a, b) => {
            const aOrder = index.order.get(normalizeName(a.title)) ?? Number.MAX_SAFE_INTEGER;
            const bOrder = index.order.get(normalizeName(b.title)) ?? Number.MAX_SAFE_INTEGER;
            return aOrder - bOrder || a.id.localeCompare(b.id);
        });
    }

    const maxCols = LAYOUT.GROUP_COLS;
    const groupWidth =
        maxCols * LAYOUT.NODE_W + (maxCols - 1) * LAYOUT.GAP_X + LAYOUT.GROUP_PAD_X * 2;
    const positioned = new Map<string, { x: number; y: number }>();
    let cursorY = LAYOUT.ORIGIN_Y;

    for (const group of groups) {
        group.nodes.forEach((node, indexInGroup) => {
            const col = indexInGroup % maxCols;
            const row = Math.floor(indexInGroup / maxCols);
            positioned.set(node.id, {
                x: LAYOUT.ORIGIN_X + LAYOUT.GROUP_PAD_X + col * (LAYOUT.NODE_W + LAYOUT.GAP_X),
                y:
                    cursorY +
                    LAYOUT.GROUP_HEADER_H +
                    LAYOUT.GROUP_NODE_TOP_GAP +
                    row * (LAYOUT.NODE_H + LAYOUT.GAP_Y),
            });
        });
        const rows = Math.ceil(group.nodes.length / maxCols);
        cursorY +=
            LAYOUT.GROUP_HEADER_H +
            LAYOUT.GROUP_NODE_TOP_GAP +
            rows * LAYOUT.NODE_H +
            Math.max(0, rows - 1) * LAYOUT.GAP_Y +
            LAYOUT.GROUP_PAD_BOTTOM +
            LAYOUT.GROUP_GAP_Y;
    }

    // 分镜视频按场景分行：每行一个场景，左侧留场景标签区，右侧横排该场景的片段。
    const sceneGroups = groupShotVideosByScene(nodes);
    const videoX = LAYOUT.ORIGIN_X + groupWidth + LAYOUT.VIDEO_GAP_X;
    let sceneY = LAYOUT.ORIGIN_Y;
    for (const group of sceneGroups) {
        group.nodes.forEach((node, indexInScene) => {
            positioned.set(node.id, {
                x:
                    videoX +
                    LAYOUT.VIDEO_SCENE_PAD_X +
                    LAYOUT.VIDEO_SCENE_LABEL_W +
                    indexInScene * (LAYOUT.VIDEO_W + LAYOUT.VIDEO_GAP_X_WITHIN),
                y: sceneY + LAYOUT.VIDEO_SCENE_PAD_Y,
            });
        });
        sceneY += LAYOUT.VIDEO_H + LAYOUT.VIDEO_SCENE_PAD_Y * 2 + LAYOUT.VIDEO_SCENE_GAP_Y;
    }

    const laidOut = nodes.map((node) => {
        const position = positioned.get(node.id);
        if (!position || (node.x === position.x && node.y === position.y)) return node;
        changed = true;
        return { ...node, ...position };
    });

    return { nodes: laidOut, changed, removedDuplicates: duplicateToCanonical.size };
};

/** 根据节点当前位置计算三个资产区域，便于在画布上绘制区域标题。 */
export const getCanvasAssetGroups = (nodes: NodeData[]): CanvasAssetGroup[] =>
    CANVAS_ASSET_CATEGORY_ORDER.flatMap((category) => {
        const groupNodes = nodes.filter((node) => node.assetCategory === category);
        if (groupNodes.length === 0) return [];
        const minX = Math.min(...groupNodes.map((node) => node.x));
        const minY = Math.min(...groupNodes.map((node) => node.y));
        const maxX = Math.max(...groupNodes.map((node) => node.x + LAYOUT.NODE_W));
        const maxY = Math.max(...groupNodes.map((node) => node.y + LAYOUT.NODE_H));
        return [{
            category,
            x: minX - LAYOUT.GROUP_PAD_X,
            y: minY - LAYOUT.GROUP_HEADER_H - LAYOUT.GROUP_NODE_TOP_GAP,
            width: maxX - minX + LAYOUT.GROUP_PAD_X * 2,
            height:
                maxY - minY + LAYOUT.GROUP_HEADER_H + LAYOUT.GROUP_NODE_TOP_GAP + LAYOUT.GROUP_PAD_BOTTOM,
            count: groupNodes.length,
        }];
    });

export interface CanvasShotVideoBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    count: number;
}

/** 根据节点当前位置反推每个场景的区块边界，用于画布上绘制场景标签。 */
export const getCanvasShotSceneGroups = (nodes: NodeData[]): CanvasShotSceneGroup[] => {
    const groups = groupShotVideosByScene(nodes);
    if (groups.length === 0) return [];
    const episodes = new Set(
        groups.map((group) => group.episode).filter((episode): episode is number => episode != null)
    );
    const multiEpisode = episodes.size > 1;

    return groups.map((group) => {
        const minX = Math.min(...group.nodes.map((node) => node.x));
        const minY = Math.min(...group.nodes.map((node) => node.y));
        const maxX = Math.max(...group.nodes.map((node) => node.x + LAYOUT.VIDEO_W));
        const maxY = Math.max(...group.nodes.map((node) => node.y + LAYOUT.VIDEO_H));
        return {
            key: group.key,
            label: sceneGroupLabel(group, multiEpisode),
            episode: group.episode,
            scene: group.scene,
            x: minX - LAYOUT.VIDEO_SCENE_PAD_X - LAYOUT.VIDEO_SCENE_LABEL_W,
            y: minY - LAYOUT.VIDEO_SCENE_PAD_Y,
            width: maxX - minX + LAYOUT.VIDEO_SCENE_PAD_X * 2 + LAYOUT.VIDEO_SCENE_LABEL_W,
            height: maxY - minY + LAYOUT.VIDEO_SCENE_PAD_Y * 2,
            count: group.nodes.length,
        };
    });
};

/** 分镜视频整体区域：包住所有场景块，顶部留出「分镜视频」标题区。 */
export const getCanvasShotVideoBounds = (nodes: NodeData[]): CanvasShotVideoBounds | null => {
    const sceneGroups = getCanvasShotSceneGroups(nodes);
    if (sceneGroups.length === 0) return null;
    const minX = Math.min(...sceneGroups.map((group) => group.x));
    const minY = Math.min(...sceneGroups.map((group) => group.y));
    const maxX = Math.max(...sceneGroups.map((group) => group.x + group.width));
    const maxY = Math.max(...sceneGroups.map((group) => group.y + group.height));
    return {
        x: minX - LAYOUT.GROUP_PAD_X,
        y: minY - LAYOUT.GROUP_HEADER_H,
        width: maxX - minX + LAYOUT.GROUP_PAD_X * 2,
        height: maxY - minY + LAYOUT.GROUP_HEADER_H + LAYOUT.GROUP_PAD_BOTTOM,
        count: sceneGroups.reduce((total, group) => total + group.count, 0),
    };
};
