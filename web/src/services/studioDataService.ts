/**
 * studioDataService.ts
 *
 * 新画布（/canvas-studio）的数据适配层。
 *
 * 新画布原本是一套按原型图写的静态演示页：节点、资产、任务全是写死的常量。
 * 这里负责把真实数据接进去，同时不改动原型样式：
 *   1. 剧本解析结果（分集 + 资产）→ 新画布的资产卡片
 *   2. 资产确认页已生成的图 → 合并成卡片的真实封面
 *   3. 资产生成（复用资产确认页的提示词模板，保证画风一致）
 *
 * 只做「映射 + 生成」，不重复实现业务逻辑；分镜、参考图匹配、场景合成
 * 仍然由 shotService / sceneMergeService 提供。
 */

import type { AnalyzedEpisode } from './scriptAnalysisService';
import type { AssetCategory, CategoryMap, EditableAsset, EpisodeMap } from '../components/AssetConfirmPanel';
import { assetStoreKey, buildAssetPrompt } from '../components/AssetConfirmPanel';
import { generateImage } from './generationService';

// ============================================================================
// 类型
// ============================================================================

/** 新画布资产卡片视图（字段与原 StudioAsset 保持一致，额外挂真实图与音色） */
export interface StudioAssetView {
    id: string;
    name: string;
    /** 副标题：角色显示音色，场景显示描述 */
    role: string;
    status: string;
    tone: 'success' | 'warning' | 'info' | 'danger' | 'neutral';
    accent: string;
    category: AssetCategory;
    detail: string;
    imageUrl?: string;
    looks?: { id: string; name: string; imageUrl?: string }[];
    voiceName?: string;
    description?: string;
    visual?: string;
    bio?: string;
    aliases?: string[];
}

export interface AssetProgress {
    total: number;
    done: number;
    /** 按分类统计，供左侧面板分 Tab 显示 */
    byCategory: Record<AssetCategory, { total: number; done: number }>;
}

// ============================================================================
// 常量
// ============================================================================

/** 与资产确认页一致的画幅与模型，保证两边出图规格相同 */
const ASSET_ASPECT_RATIO = '16:9';
const ASSET_RESOLUTION = '2K';
const ASSET_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';

/**
 * 卡片首字母色块的底色（无图时显示）。
 * 与原型演示数据保持同一格式：Tailwind 的 three-stop 渐变类名，
 * 页面按 `bg-gradient-to-br ${accent}` 使用。
 */
const ACCENTS = [
    'from-[#b98a9f] via-[#d7b5c0] to-[#6d4d5b]',
    'from-[#6e8da2] via-[#9db1c1] to-[#42576a]',
    'from-[#8d7bb0] via-[#b3a4cd] to-[#4f4270]',
    'from-[#a2846a] via-[#c8ad92] to-[#5f4630]',
    'from-[#6f8f7d] via-[#a2bfae] to-[#3f5a4c]',
    'from-[#9a7a7a] via-[#c4a5a5] to-[#5c3f3f]',
];

const CATEGORY_LABEL: Record<AssetCategory, string> = {
    characters: '角色',
    scenes: '场景',
    props: '道具',
};

// ============================================================================
// 映射
// ============================================================================

const emptyCategoryMap = (): CategoryMap => ({ characters: [], scenes: [], props: [] });

/** 读资产确认页的本地存储（与 AssetConfirmPanel 同一个 key） */
export const loadStudioAssetStore = (projectId: string): EpisodeMap => {
    if (!projectId) return {};
    try {
        const raw = localStorage.getItem(assetStoreKey(projectId));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as EpisodeMap) : {};
    } catch {
        return {};
    }
};

/**
 * 把「剧本资产 + 已生成的图」合并成新画布用的资产列表。
 *
 * 资产名是跨集的稳定键：同一角色在不同集里共用同一张图，
 * 所以按 name 去匹配资产确认页里已生成的记录。
 */
export const buildStudioAssets = (
    episodes: AnalyzedEpisode[],
    episodeNo: number,
    store: EpisodeMap
): StudioAssetView[] => {
    if (!episodes || episodes.length === 0) return [];
    const episode = episodes.find((e) => e.episode === episodeNo) || episodes[0];
    if (!episode) return [];

    const saved = store[episode.episode] || emptyCategoryMap();
    const out: StudioAssetView[] = [];
    let index = 0;

    for (const category of ['characters', 'scenes', 'props'] as const) {
        const list = (episode.assets?.[category] || []) as Array<{
            name: string;
            description?: string;
            imageUrl?: string;
            looks?: { id?: string; name?: string; imageUrl?: string }[];
            voiceName?: string;
            visual?: string;
            bio?: string;
            aliases?: string[];
        }>;

        for (const item of list) {
            const record = (saved[category] || []).find((a) => a.name === item.name);
            const imageUrl = record?.imageUrl || item.imageUrl;
            const looks = (record?.looks || item.looks || []).map((l, i) => ({
                id: l.id || `look-${i + 1}`,
                name: l.name || `造型 ${i + 1}`,
                imageUrl: l.imageUrl,
            }));

            out.push({
                id: record?.id || `${category}-${item.name}`,
                name: item.name,
                role:
                    category === 'characters'
                        ? record?.voiceName || item.voiceName || '未配音色'
                        : item.description || CATEGORY_LABEL[category],
                status: imageUrl ? '已生成' : '待生成',
                tone: imageUrl ? 'success' : 'warning',
                accent: ACCENTS[index % ACCENTS.length],
                category,
                detail: item.visual || item.description || '',
                imageUrl,
                looks,
                voiceName: record?.voiceName || item.voiceName,
                description: item.description,
                visual: item.visual,
                bio: item.bio,
                aliases: item.aliases,
            });
            index += 1;
        }
    }

    return out;
};

/** 统计某集资产的生成进度（供流程节点显示 3/10） */
export const countAssetProgress = (assets: StudioAssetView[]): AssetProgress => {
    const byCategory: AssetProgress['byCategory'] = {
        characters: { total: 0, done: 0 },
        scenes: { total: 0, done: 0 },
        props: { total: 0, done: 0 },
    };
    let done = 0;
    for (const asset of assets) {
        byCategory[asset.category].total += 1;
        if (asset.imageUrl) {
            byCategory[asset.category].done += 1;
            done += 1;
        }
    }
    return { total: assets.length, done, byCategory };
};

// ============================================================================
// 写回与生成
// ============================================================================

/**
 * 把生成好的图写回资产确认页的存储。
 *
 * 主图与「造型 1」是同一份图（与 AssetConfirmPanel 的约定一致），
 * 这样旧画布、分镜参考图、新画布三处读到的都是同一张。
 */
export const writeStudioAssetImage = (
    projectId: string,
    episodeNo: number,
    category: AssetCategory,
    name: string,
    url: string
): void => {
    if (!projectId || !name || !url) return;
    const store = loadStudioAssetStore(projectId);
    const map = store[episodeNo] || emptyCategoryMap();
    const list = map[category] || [];
    const at = list.findIndex((a) => a.name === name);

    if (at >= 0) {
        const asset = list[at];
        const looks = asset.looks && asset.looks.length > 0
            ? asset.looks
            : [{ id: 'look-1', name: '造型 1' }];
        list[at] = {
            ...asset,
            imageUrl: url,
            looks: looks.map((l, i) => (i === 0 ? { ...l, imageUrl: url } : l)),
        };
    } else {
        const created: EditableAsset = {
            id: `${category}-${name}`,
            name,
            imageUrl: url,
            looks: [{ id: 'look-1', name: '造型 1', imageUrl: url }],
        };
        list.push(created);
    }

    map[category] = list;
    store[episodeNo] = map;
    try {
        localStorage.setItem(assetStoreKey(projectId), JSON.stringify(store));
    } catch {
        /* 配额满或隐私模式：忽略 */
    }
};

/**
 * 生成一张资产图。
 *
 * 提示词复用资产确认页的 buildAssetPrompt（含风格、构图、画风底线），
 * 所以新画布出的图与资产页完全同款，不会出现两套画风。
 */
export const generateStudioAssetImage = async (params: {
    projectId: string;
    episodeNo: number;
    contentType?: string;
    asset: StudioAssetView;
}): Promise<string> => {
    const { projectId, episodeNo, contentType, asset } = params;

    const editable: EditableAsset = {
        id: asset.id,
        name: asset.name,
        description: asset.description,
        imageUrl: asset.imageUrl,
        looks: asset.looks,
        voiceName: asset.voiceName,
        bio: asset.bio,
        visual: asset.visual,
    };

    const url = await generateImage({
        prompt: buildAssetPrompt(asset.category, editable, undefined, contentType),
        aspectRatio: ASSET_ASPECT_RATIO,
        resolution: ASSET_RESOLUTION,
        imageModel: ASSET_IMAGE_MODEL,
        nodeId: `${asset.id}-${Date.now()}`,
        channel: 'workflow',
    });

    writeStudioAssetImage(projectId, episodeNo, asset.category, asset.name, url);
    return url;
};

export default {
    loadStudioAssetStore,
    buildStudioAssets,
    countAssetProgress,
    writeStudioAssetImage,
    generateStudioAssetImage,
};
