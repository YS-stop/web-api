/**
 * AssetConfirmPanel.tsx
 *
 * 「资产确认」界面（按集 / 按分类组织），同时用于：
 *   1. 工作流页「资产确认」步骤；
 *   2. 项目详情页「项目资产」标签页（浅色主题）。
 *
 * 结构对齐设计稿：
 *   左侧「分集目录」导航  +  右侧主区
 *   主区：AI 提取信息条 → 图片模型/分辨率 + 一键生成全资产 → 分类 Tab → 资产卡片网格 → 新增卡片
 *
 * 资产编辑（新增 / 重命名 / 描述 / 造型数 / 音色 / 重绘）保存在本地
 * （localStorage，按 projectId 隔离），刷新后不丢失；图片走既有 /api/generate-image。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Mic,
    MoreHorizontal,
    Loader2,
    Pencil,
    Trash2,
    RefreshCw,
    Users,
    MapPin,
    Package,
    Sparkles,
    Layers,
    Plus,
    AlertCircle,
    ChevronDown,
    ChevronLeft,
    X,
    Wand2,
    Play,
    Pause,
} from 'lucide-react';
import type { AnalyzedEpisode, AssetItem } from '../services/scriptAnalysisService';
import { submitImageTask, getImageTaskStatus } from '../services/generationService';
import { resolveStyleByContentType, getAssetStyleImage, isLiveActionContentType } from '../services/stylePresets';
import { runWithConcurrency, BATCH_CONCURRENCY } from '../utils/concurrency';
import { AssetDetailDrawer } from './AssetDetailDrawer';
import {
    findVoice,
    groupVoices,
    isEnglishVoice,
    isKnownVoice,
    normalizeVoiceId,
    voiceLabel,
} from '../services/voiceCatalog';
import { previewKeyOf, useVoicePreview } from '../services/useVoicePreview';
import { persistAssetState, persistJob } from '../services/projectStateService';
import { finishJob } from '../services/generationTaskService';

// ============================================================================
// 常量
// ============================================================================

export type AssetCategory = 'characters' | 'scenes' | 'props';

interface CategoryMeta {
    key: AssetCategory;
    label: string;
    /** 新增卡片文案，如「新增角色」 */
    addLabel: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
}

const CATEGORY_META: CategoryMeta[] = [
    { key: 'characters', label: '角色', addLabel: '新增角色', icon: Users },
    { key: 'scenes', label: '场景', addLabel: '新增场景', icon: MapPin },
    { key: 'props', label: '道具', addLabel: '新增道具', icon: Package },
];

/**
 * 资产生成图片模型：与自由画布（NodeControls）保持一致，仅使用国内豆包模型。
 * 首项即默认选中项。
 */
const IMAGE_MODELS = [
    { id: 'doubao-seedream-5-0-pro-260628', name: '豆包 Seedream 5.0 Pro' },
];
const IMAGE_RESOLUTIONS = ['1K', '1.5K', '2K'];

/**
 * 资产设定图统一使用横版 16:9。
 * 无头身体三视图并排 + 独立正/侧脸部需要横向空间，且不再跟随项目画幅（竖版会让人物过小、空间利用率差）。
 */
const ASSET_ASPECT_RATIO = '16:9';

/**
 * 音色弹层固定高度（px）。
 * 固定而非随内容伸缩：展开 14 个音色的分组时高度不变，靠滚轮查看，
 * 避免弹层一会儿拉长一会儿缩回、还容易被视口裁掉。
 */
const VOICE_PANEL_H = 320;

/**
 * 依据「基本信息 → 内容类型」决定整体画面风格，避免生成与题材不符的荒唐内容。
 * 内容类型取自项目基本信息（见 CONTENT_TYPES）：国内真人 / 2D 动画 / 2D 精致韩漫 /
 * 3D 国漫古风 / 3D 建模 / 3D 皮克斯 / 3D 拟真人国内。
 *
 * 风格词按资产分类取用：人物用人像词，场景 / 道具各用专属词，
 * 避免把「皮肤、五官、人像摄影」这类人物向词汇塞进场景与道具提示词。
 */
const resolveStyleHint = (contentType: string | undefined, category: AssetCategory): string => {
    if (!contentType) return '';
    const styleName = resolveStyleByContentType(contentType);
    const style = getAssetStyleImage(styleName, category);
    return style ? `整体风格：${style}。` : '';
};

/**
 * 角色音色：统一来自 voiceCatalog（与后端 api/server/config/voices.js 对齐）。
 * 存储用 id、展示用中文名；历史数据里存的是中文名，voiceLabel / 后端都能解析。
 */

// ============================================================================
// 类型
// ============================================================================

export interface Look {
    id: string;
    name: string;
    imageUrl?: string;
}

export interface EditableAsset {
    id: string;
    name: string;
    description?: string;
    imageUrl?: string;
    looks: Look[];
    voiceName?: string;
    /** 自定义音色风格指令（自然语言，配合 voiceName 作为基础音色） */
    voicePrompt?: string;
    /** 人物小传（仅角色）：展示用，不直接进提示词 */
    bio?: string;
    /** 视觉特征（仅角色）：唯一进提示词的人物设定 */
    visual?: string;
}

export type CategoryMap = Record<AssetCategory, EditableAsset[]>;
export type EpisodeMap = Record<number, CategoryMap>;

interface AssetGenerationJob {
    id: string;
    episode: number;
    category: AssetCategory;
    assetId: string;
    lookId?: string;
    /** 提交时的 prompt；任务在服务端丢失（notfound）时据此重新提交 */
    prompt?: string;
    startedAt: number;
    /** 资产名：任务列表展示用，资产后续改名不影响历史记录 */
    assetName?: string;
    /** 提交时的生成参数：重试按原参数重发，避免参数漂移 */
    aspectRatio?: string;
    resolution?: string;
    imageModel?: string;
}

interface AssetConfirmPanelProps {
    projectId: string;
    episodes: AnalyzedEpisode[];
    /** 基本信息里的「内容类型」（见 CONTENT_TYPES），用于统一画面风格 */
    contentType?: string;
    /** 初始选中的集号；不传则默认第一集 */
    initialEpisode?: number;
    /** 点击左侧「返回概览」时回调 */
    onGoOverview?: () => void;
    /** 资产数据变化回调（含生成图），供后续「视频生成」引用 */
    onAssetsChange?: (map: EpisodeMap) => void;
    /** 铺满父容器高度（工作流步骤用）；详情页为卡片内嵌，靠内容撑高 */
    fillHeight?: boolean;
}

// ============================================================================
// 工具
// ============================================================================

const uid = () => Math.random().toString(36).slice(2, 10);

/** 把 '16:9' 这类画幅转成 CSS aspect-ratio 值，非法时回退 4/5 */
const cssAspectRatio = (ratio?: string): string => {
    const [w, h] = (ratio || '').split(':').map((n) => Number(n.trim()));
    return w > 0 && h > 0 ? `${w} / ${h}` : '4 / 5';
};

/** 资产图固定画幅的 CSS 值 */
const ASSET_CSS_ASPECT = cssAspectRatio(ASSET_ASPECT_RATIO);

const emptyCategoryMap = (): CategoryMap => ({ characters: [], scenes: [], props: [] });

/**
 * 跨集稳定的资产 id：同一分类下同名资产视为「同一个资产」。
 * 例如第 1 集的「陈海英」与第 3、5 集的「陈海英」id 相同，共用同一张图，只生成一次。
 */
const assetUid = (category: AssetCategory, name: string): string => `${category}:${name}`;

const toEditable = (a: AssetItem, category: AssetCategory): EditableAsset => ({
    id: assetUid(category, a.name),
    name: a.name,
    description: a.description,
    imageUrl: a.imageUrl,
    looks: a.looks && a.looks.length > 0
        ? a.looks
        : [{ id: `${assetUid(category, a.name)}:look1`, name: '造型 1' }],
    voiceName: a.voiceName,
    voicePrompt: category === 'characters' ? a.voicePrompt : undefined,
    // 人物小传与视觉特征只在角色分类下有意义，场景 / 道具不写入，避免脏数据
    bio: category === 'characters' ? a.bio : undefined,
    visual: category === 'characters' ? a.visual : undefined,
});

/** 从分集数据构建初始可编辑资产表（跨集同名资产共享 id，复用同一张图） */
const buildEpisodeMap = (episodes: AnalyzedEpisode[]): EpisodeMap => {
    const map: EpisodeMap = {};
    for (const ep of episodes) {
        const src = ep.assets || { characters: [], scenes: [], props: [] };
        map[ep.episode] = {
            characters: (src.characters || []).map((a) => toEditable(a, 'characters')),
            scenes: (src.scenes || []).map((a) => toEditable(a, 'scenes')),
            props: (src.props || []).map((a) => toEditable(a, 'props')),
        };
    }
    return map;
};

/** 资产确认数据的本地存储键（按项目隔离），供工作流其他步骤判断完成度 */
export const assetStoreKey = (projectId: string) => `asset-confirm:${projectId}`;
const assetJobsKey = (projectId: string) => `asset-confirm-jobs:${projectId}`;

/** 纯函数：把 patch 同步应用到「所有集中同分类同 id」的资产，无匹配则原样返回 */
const syncAssetAcrossEpisodes = (
    map: EpisodeMap,
    category: AssetCategory,
    id: string,
    patch: Partial<EditableAsset>
): EpisodeMap => {
    let changed = false;
    const next: EpisodeMap = {};
    for (const key of Object.keys(map)) {
        const epNo = Number(key);
        const catMap = map[epNo] || emptyCategoryMap();
        const list = catMap[category] || [];
        const has = list.some((a) => a.id === id);
        next[epNo] = has
            ? { ...catMap, [category]: list.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
            : catMap;
        if (has) changed = true;
    }
    return changed ? next : map;
};

/**
 * 旧数据迁移：把历史随机 id 归一化为「分类:名称」。
 * 同一分类下同名资产合并为一个（优先保留已生成图的那份），
 * 使旧项目在升级后同样享受跨集复用，而不会因 id 变化丢失已生成的图片。
 */
const normalizeEpisodeMap = (map: EpisodeMap): EpisodeMap => {
    const cats: AssetCategory[] = ['characters', 'scenes', 'props'];
    const authority = new Map<string, EditableAsset>();
    const result: EpisodeMap = {};
    for (const key of Object.keys(map)) {
        const epNo = Number(key);
        const catMap = map[epNo] || emptyCategoryMap();
        const nextCat = emptyCategoryMap();
        for (const c of cats) {
            for (const a of catMap[c] || []) {
                const k = assetUid(c, a.name);
                const existing = authority.get(k);
                if (!existing) {
                    authority.set(k, { ...a, id: k });
                } else {
                    // 合并时逐字段取有值的一方，避免人物小传 / 视觉特征在归一化时丢失
                    const merged: EditableAsset = {
                        ...existing,
                        imageUrl: existing.imageUrl || a.imageUrl,
                        looks: (existing.looks && existing.looks.length > 0) ? existing.looks : a.looks,
                        description: existing.description || a.description,
                        bio: existing.bio || a.bio,
                        visual: existing.visual || a.visual,
                        voiceName: existing.voiceName || a.voiceName,
                        voicePrompt: existing.voicePrompt || a.voicePrompt,
                    };
                    authority.set(k, merged);
                }
                nextCat[c].push(authority.get(k)!);
            }
        }
        result[epNo] = nextCat;
    }
    return result;
};

/** 读取某项目的资产确认数据（加载时自动做跨集归一化迁移） */
export const loadAssetStore = (projectId: string): EpisodeMap | null => {
    try {
        const raw = localStorage.getItem(assetStoreKey(projectId));
        return raw ? normalizeEpisodeMap(JSON.parse(raw) as EpisodeMap) : null;
    } catch {
        return null;
    }
};

const saveStore = (projectId: string, map: EpisodeMap) => {
    try {
        localStorage.setItem(assetStoreKey(projectId), JSON.stringify(map));
    } catch {
        /* 忽略写入失败（隐私模式等） */
    }
    // 按集异步落库（数据库为准，localStorage 为同步缓存）
    for (const [episode, categories] of Object.entries(map)) {
        const ep = Number(episode);
        if (!Number.isFinite(ep) || ep <= 0) continue;
        persistAssetState(projectId, ep, categories);
    }
};

const loadAssetJobs = (projectId: string): AssetGenerationJob[] => {
    try {
        const raw = localStorage.getItem(assetJobsKey(projectId));
        return raw ? JSON.parse(raw) as AssetGenerationJob[] : [];
    } catch {
        return [];
    }
};

const saveAssetJobs = (projectId: string, jobs: AssetGenerationJob[]) => {
    try {
        localStorage.setItem(assetJobsKey(projectId), JSON.stringify(jobs));
    } catch {
        /* ignore */
    }
    // 只同步「待认领」队列里的任务。
    // 已结束的任务会从队列移除，但后端台账必须保留（那里有 succeeded/failed 终态）——
    // 以前这里会对移除项调 removePersistedJob，结果「生成任务」页刚写进去的终态
    // 又被删掉，页面上永远看不到历史与失败原因。
    for (const job of jobs) {
        persistJob(projectId, {
            id: job.id,
            kind: 'asset',
            episode: job.episode,
            status: 'running',
            payload: job as unknown as Record<string, unknown>,
            startedAt: job.startedAt,
        });
    }
};

const generationId = () => `workflow-asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 角色设定图提示词（双区拆件版）。
 *
 * 画面横向分左右两区：
 *   【左半 1/3】上下两格竖排头肩特写（正面 / 90° 左正侧面）：
 *               每格是「紧裁」的头肩像——头顶到下巴占格高约 8 成，
 *               肩线横向铺满格子宽度，画面下缘裁在肩线 / 锁骨处，
 *               不出现手臂、手、抱臂与躯干，用于锚定五官、发型与妆容；
 *               两格头部大小完全一致、眼睛水平线对齐。
 *   【右半 2/3】三个全身立绘（正面 / 正侧面 / 背面），**完全移除头部与脖子**，
 *               颈部领口直接空出，保留完整躯干、双臂、双手（十指清晰）与双腿，
 *               用于锚定服装版型、身材比例与配色。
 *
 * 关键（按参考图 1 的构图校准）：
 *   1. 头肩特写必须「顶满格子」，否则模型会画成小头像 + 大片留白；
 *   2. 头肩特写必须禁止手臂与手，否则模型会自行补出交叉抱臂，把头部挤小；
 *   3. 侧脸必须完整呈现后脑与发型轮廓（马尾 / 发髻可见），鼻尖朝左、只露左脸；
 *   4. 左区改占 1/3，使每格接近参考图的格子比例（约 1.18:1），头部才撑得满。
 * 强约束：纯白背景、无文字；只画角色本体，不含道具 / 配饰 / logo / 场景。
 * 资产「描述」作为角色基础设定拼入提示词。
 */
const buildCharacterPrompt = (asset: EditableAsset, lookName?: string, contentType?: string): string => {
    // 只有实拍真人类型才约束「照片质感」；2D / 3D 类型必须排除照片感，否则会把 CG 拉回实拍
    const textureLine = isLiveActionContentType(contentType)
        ? '【质感】：真实照片质感，非 CG、非插画；皮肤可见毛孔、细纹与自然瑕疵，五官允许轻微不对称，不要磨皮、不要美颜滤镜、不要塑料感与蜡质皮肤。'
        : '【质感】：严格遵循上方「整体风格」的渲染 / 绘制质感，不要真实照片质感，不要皮肤毛孔与细纹，不要胶片颗粒与实拍光影。由于是纯白背景的设定图，不使用背景虚化、体积雾与辉光，改为棚拍式均匀布光，让 CG 材质、发丝分层与服装质感在纯白背景上干净呈现。';
    /**
     * 人物设定来源优先级：
     *   1. visual（视觉特征）—— 由人物小传提炼，纯外貌，最适合生图；
     *   2. description —— 模型给的「一句话身份/外貌」，质量参差但可用；
     *   3. bio（人物小传）—— 剧情向文字，仅在两者都缺失时兜底，并明确要求忽略剧情。
     * 小传直接进提示词会让模型画出病床、讨债人、渔船等剧情元素，因此排在最后。
     */
    const visualSpec = asset.visual
        ? `【外貌特征】：${asset.visual}`
        : asset.description
            ? `【基础设定】：${asset.description}`
            : asset.bio
                ? `【基础设定】：${asset.bio}（以上仅为身份背景，画面只需呈现这个人的外貌，不要描绘任何剧情场景、人物关系与事件）`
                : '';
    const parts = [
        '纯白背景（#FFFFFF），不出现任何文字、水印、logo。',
        '角色设定图（character design sheet，身体与头部拆件展示）。',
        `【角色】：${asset.name}${lookName ? `（造型：${lookName}）` : ''}`,
        visualSpec,
        '画面必须同时包含两组内容：左侧上下 2 张头肩特写，右侧 3 个完整全身立绘（无头），共 5 个图形，不能只画头部。',
        '【左半】约占画面 1/3，上下两格竖排，格与格之间仅留窄缝；每格是一张紧裁的头肩特写（tight head-and-shoulders portrait）：',
        '取景规格：头顶到下巴占格子高度约 8 成，头顶上方仅留极窄空白；肩线横向铺满格子宽度的 8 成以上，左右仅留极窄边距；画面下缘裁切在肩线 / 锁骨处，肩膀以下不出现——绝对不出现手臂、手、手掌、交叉抱臂、躯干与任何肢体动作。',
        '图1（上）：正面头肩特写（front view），头部完全正对镜头、双眼平视、不偏头不歪头，展示完整正脸。',
        '图2（下）：90 度正侧面头肩特写（strict left profile），鼻尖朝画面左边缘，只展示左脸，禁止露出右脸、禁止 3/4 侧面与 45 度侧脸；必须完整呈现头骨与后脑轮廓，发型（含马尾、发髻、发尾）在脑后清晰可见。',
        '两格的头部大小完全一致、面部位置与眼睛水平线对齐，如同同一人原地转 90 度；必须是同一张脸、同一发型、同一领口服装。',
        '【右半】约占画面 2/3，同一角色三个全身立绘（full body），从左到右依次为正面、正侧面、背面：',
        '必须完全移除头部和脖子，颈部领口直接空出来：headless, no head, no hair, no neck above the collar, collar opening empty。',
        '必须保留完整的躯干、双臂、双手（十指清晰）和双腿，双手自然下垂贴于体侧，突出服装版型与材质。',
        '侧面立绘为标准 90 度正侧面，脚尖与胸口朝画面左边缘，仅见左手臂，双腿并拢重叠，禁止朝右、3/4 侧面与 45 度侧背。',
        '三个立绘等高等宽等间距，脚底同线、肩线同高、领口同高，身体大小一致，如同原地转身；从颈部断面到脚底完整入镜，不裁切、不重叠。',
        '所有格子的服装、配色、配饰完全一致，多视角高度统一。',
        '【姿态状态】：绝对静止，自然站立，没有任何动作，无手持道具；头肩特写中同样不得出现手臂与手。',
        textureLine,
        '【英文约束】：Left third: two stacked tight head-and-shoulders portraits that fill their cells — the head from crown to chin occupies about 80% of the cell height, the shoulder line spans over 80% of the cell width, and the frame is cropped at the shoulder/clavicle line with NO arms, NO hands, NO crossed arms and NO torso. Top: straight-on front view, head facing the camera squarely, eyes level. Bottom: strict 90-degree left profile, nose pointing to the left edge, only the left side of the face visible, no three-quarter view; the complete skull and back-of-head silhouette must show, with the full hairstyle (ponytail, bun, hair ends) clearly visible behind. Both heads identical in size and aligned on the same eye line, same face, same hair, same collar. Right two-thirds: three headless full-body designs (front, right-side profile facing left, back); head and neck completely removed with an empty collar opening; complete torso, both arms, both hands with ten clearly separated fingers, both legs and feet; arms hanging naturally at the sides; even height and width, feet on the same baseline, shoulders and collars aligned; no head, no hair, no neck above the collar.',
        '画面中只绘制角色本体：不要出现任何道具、手持物、配饰、首饰、包袋、武器，不要出现 logo、文字、水印、品牌标识、背景摆件，也不要出现其他人物与场景元素。',
    ];
    return parts.filter(Boolean).join('\n');
};

/**
 * 场景画面提示词。
 * 要点：
 *   1. 统一以「高空鸟瞰 / 航拍俯视」视角呈现整个场景的空间布局与动线；
 *   2. 输出「一张完整的航拍场景画面」，明确排除概念设计板 / 分镜板 / 排版稿；
 *   3. 以资产「描述」为主要依据，俯视下仍需细节清晰、布局完整；
 *   4. 强约束：画面内不得出现任何文字、标签、水印、logo、参考图与排版元素。
 */
const buildScenePrompt = (asset: EditableAsset, lookName?: string): string => {
    const parts = [
        `无人空镜场景鸟瞰图（aerial view, empty scene, no people），场景：${asset.name}${lookName ? `（造型：${lookName}）` : ''}。`,
        asset.description
            ? `场景环境设定：${asset.description}。注意：以上设定若包含任何人物、角色、人物动作或站位，一律忽略，只描绘其中的环境、空间、陈设、光线与氛围，不绘制任何人物。`
            : '',
        '请依据以上环境设定生成一张从高空向下俯瞰的完整航拍场景画面（aerial bird\'s-eye view, high-angle overhead shot, looking straight down）——不是设计稿、不是概念板、不是分镜板、不是电影剧照，也不是平视或地面视角。',
        '构图：高空俯视视角，完整呈现整个场景的平面布局、空间关系与主要陈设，场景主体区域清晰可辨、层次丰富、画面饱满；镜头垂直或接近垂直向下，避免倾斜透视和地面平视。',
        '画面中不得出现任何文字、标题、字母、数字、关键词标签、说明文字、水印、logo、品牌标识、参考图缩略图、边框、色卡或排版元素。',
        '航拍级画面质感（画风遵循上方整体风格），光线自然，俯视下材质与空间细节清晰，画质清晰。',
        '画面必须完全无人：不出现任何人物、人体、人物剪影、人物背影、人影、人脸或人群，也不要出现真实的鸟类；场景保持空旷无人状态。',
    ];
    return parts.filter(Boolean).join('');
};

/**
 * 道具提示词。
 * 单一主体静物特写：材质、结构、使用痕迹是核心信息，
 * 因此构图要求主体占满画面、无遮挡、可辨细节，并排除设计板 / 排版 / 人物。
 */
const buildPropPrompt = (asset: EditableAsset, lookName?: string): string => {
    const parts = [
        '纯色或极简背景，不出现任何文字、水印、logo。',
        `道具静物设定图（single prop, still life），道具：${asset.name}${lookName ? `（造型：${lookName}）` : ''}。`,
        asset.description ? `道具设定：${asset.description}。` : '',
        '请依据以上设定生成一张道具静物特写——不是设计稿、不是概念板、不是分镜板、不是电影剧照。',
        '构图：单一主体居中展示并占据画面主要位置，完整呈现外形轮廓与结构，材质、纹理、磨损与做工细节清晰可见，配以自然投影强化体积感。',
        '画面中不得出现任何文字、标题、字母、数字、标签、说明文字、水印、logo、品牌标识、参考图缩略图、边框、色卡或排版元素。',
        '画面中只能有这一件道具：不出现其他物品、不出现任何人物或人体部位，不出现手持状态。',
    ];
    return parts.filter(Boolean).join('\n');
};

/**
 * 依据分类与资产信息拼装生成提示词（可指定造型）。
 * 画面风格由「基本信息 → 内容类型」统一约束，避免题材不符。
 */
export const buildAssetPrompt = (
    category: AssetCategory,
    asset: EditableAsset,
    lookName?: string,
    contentType?: string
): string => {
    const body =
        category === 'characters'
            ? buildCharacterPrompt(asset, lookName, contentType)
            : category === 'scenes'
                ? buildScenePrompt(asset, lookName)
                : buildPropPrompt(asset, lookName);
    const styleHint = resolveStyleHint(contentType, category);
    /**
     * 画风底线：非实拍类型再补一句总纲式负面。
     * 风格词写在最前面权重最高，但后面几百字的构图表述会稀释它，
     * 末尾再压一句「不要真人照片」，是防止 CG 被拉回真人的最后一道。
     */
    const nonRealHint = isLiveActionContentType(contentType)
        ? ''
        : '\n【画风底线】：画面必须是动画 / CG 风格，不要真人照片质感，不要 3D 拟真人写实脸，不要影视剧剧照感。';
    return [styleHint, body, nonRealHint].filter(Boolean).join('\n');
};

// ============================================================================
// 组件
// ============================================================================

export const AssetConfirmPanel: React.FC<AssetConfirmPanelProps> = ({
    projectId,
    episodes,
    contentType,
    initialEpisode,
    onGoOverview,
    onAssetsChange,
    fillHeight = true,
}) => {
    const [assetMap, setAssetMap] = useState<EpisodeMap>(() => loadAssetStore(projectId) || buildEpisodeMap(episodes));
    const [activeEpisode, setActiveEpisode] = useState<number>(() => {
        if (initialEpisode && episodes.some((e) => e.episode === initialEpisode)) return initialEpisode;
        return episodes[0]?.episode ?? 1;
    });
    const [activeCategory, setActiveCategory] = useState<AssetCategory>('characters');

    // 交互态
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [voicePopoverId, setVoicePopoverId] = useState<string | null>(null);
    /** 正在批量分配音色（纯文本决策，不依赖 TTS 授权） */
    const [assigningVoices, setAssigningVoices] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
    /** 生成中标记：key 为资产 id，value 为 null（主图）或造型 id */
    const [generating, setGenerating] = useState<Record<string, string | null>>({});
    const [batchGenerating, setBatchGenerating] = useState(false);
    const [pendingJobs, setPendingJobs] = useState<AssetGenerationJob[]>(() => loadAssetJobs(projectId));
    const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].id);
    const [imageResolution, setImageResolution] = useState('2K');
    const [error, setError] = useState('');
    /** 大图预览的图片地址（null 表示关闭） */
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    /** 大图预览标题（资产名 + 造型） */
    const [previewTitle, setPreviewTitle] = useState('');

    const rootRef = useRef<HTMLDivElement>(null);

    /** 打开大图预览 */
    const openPreview = (src: string, title = '') => {
        setPreviewSrc(src);
        setPreviewTitle(title);
    };

    // 持久化 + 向上回传（供视频生成引用资产图）
    useEffect(() => {
        saveStore(projectId, assetMap);
        onAssetsChange?.(assetMap);
    }, [projectId, assetMap, onAssetsChange]);

    useEffect(() => {
        saveAssetJobs(projectId, pendingJobs);
    }, [projectId, pendingJobs]);

    useEffect(() => {
        setPendingJobs(loadAssetJobs(projectId));
    }, [projectId]);

    // 分集变化时补齐缺失的集
    useEffect(() => {
        setAssetMap((prev) => {
            const next: EpisodeMap = { ...prev };
            let changed = false;
            for (const ep of episodes) {
                if (!next[ep.episode]) {
                    next[ep.episode] = buildEpisodeMap([ep])[ep.episode];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
        setActiveEpisode((cur) => (episodes.some((e) => e.episode === cur) ? cur : episodes[0]?.episode ?? 1));
    }, [episodes]);

    // 点击空白处收起弹层
    useEffect(() => {
        const onDocDown = () => {
            setOpenMenuId(null);
            setVoicePopoverId(null);
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
    }, []);

    // 详情页 / 大图预览：ESC 逐层关闭（先关预览，再关详情）+ 锁定背景滚动
    useEffect(() => {
        if (!previewSrc && !editingAssetId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (previewSrc) setPreviewSrc(null);
            else setEditingAssetId(null);
        };
        window.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [previewSrc, editingAssetId]);

    // ============================================================================
    // 派生数据
    // ============================================================================

    const currentCategoryMap: CategoryMap = assetMap[activeEpisode] || emptyCategoryMap();
    const list = currentCategoryMap[activeCategory] || [];
    const categoryCounts = useMemo(() => ({
        characters: (currentCategoryMap.characters || []).length,
        scenes: (currentCategoryMap.scenes || []).length,
        props: (currentCategoryMap.props || []).length,
    }), [currentCategoryMap]);

    const editingAsset = editingAssetId
        ? (['characters', 'scenes', 'props'] as AssetCategory[])
            .flatMap((k) => currentCategoryMap[k] || [])
            .find((a) => a.id === editingAssetId) || null
        : null;

    /**
     * 旧数据自愈：主图存在但没有任何造型带图时，把主图回填给第一个造型。
     * 仅处理「所有造型都没图」的情况——若某造型已有图，说明主图是另一张独立图，
     * 强行回填会把两张不同的图混为一谈，导致「未归属造型」反复出现。
     */
    useEffect(() => {
        if (!editingAsset || !editingAsset.imageUrl) return;
        const first = editingAsset.looks[0];
        const anyLookHasImage = editingAsset.looks.some((l) => !!l.imageUrl);
        if (first && !anyLookHasImage) {
            patchAsset(activeEpisode, activeCategory, editingAsset.id, {
                looks: editingAsset.looks.map((l, i) => (i === 0 ? { ...l, imageUrl: editingAsset.imageUrl } : l)),
            });
        }
        // 仅在打开的资产变化时执行一次，避免回填循环
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingAssetId]);

    // ============================================================================
    // 资产变更
    // ============================================================================

    const patchCategory = (episode: number, category: AssetCategory, updater: (list: EditableAsset[]) => EditableAsset[]) => {
        setAssetMap((prev) => {
            const epMap = prev[episode] || emptyCategoryMap();
            return { ...prev, [episode]: { ...epMap, [category]: updater(epMap[category] || []) } };
        });
    };

    /** 更新资产：跨集同步所有同名（同 id）资产，保证同一角色/场景/道具在各集共用同一张图 */
    const patchAsset = (episode: number, category: AssetCategory, id: string, patch: Partial<EditableAsset>) =>
        setAssetMap((prev) => syncAssetAcrossEpisodes(prev, category, id, patch));

    /**
     * 批量让 AI 为角色分配音色。
     * 这是纯文本决策（/api/drama/assign-voices + DRAMA key），不需要语音合成授权；
     * 结果只是「音色标签」，真正出声要等语音合成资源开通。
     */
    const handleAssignVoices = async () => {
        const chars = (assetMap[activeEpisode]?.characters || []).filter((c) => c.name.trim());
        if (chars.length === 0) {
            setError('当前集没有角色，无法分配音色');
            return;
        }
        setError('');
        setAssigningVoices(true);
        try {
            const resp = await fetch('/api/drama/assign-voices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    characters: chars.map((c) => ({
                        name: c.name,
                        description: c.description,
                        bio: c.bio,
                    })),
                }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data?.error || `分配音色失败（HTTP ${resp.status}）`);

            const voices = Array.isArray(data?.voices) ? data.voices : [];
            let applied = 0;
            for (const v of voices) {
                const target = chars.find((c) => c.name === v.name);
                if (!target || !v.voiceName) continue;
                // patchAsset 按 id 同步到所有集，保证同一角色跨集音色一致
                patchAsset(activeEpisode, 'characters', target.id, { voiceName: v.voiceName });
                applied += 1;
            }
            if (applied === 0) setError('AI 未返回可用音色，请重试');
        } catch (e: any) {
            setError(e?.message || '分配音色失败');
        } finally {
            setAssigningVoices(false);
        }
    };

    /**
     * 页面重新挂载时恢复未完成任务。生成接口在服务端完成后会按 nodeId 落盘，
     * 因此即使用户切页或刷新导致原请求断开，回到这里仍可取回图片并写入对应集资产。
     */
    useEffect(() => {
        if (pendingJobs.length === 0) return;
        let disposed = false;
        setGenerating((current) => {
            const next = { ...current };
            pendingJobs.forEach((job) => { next[job.assetId] = job.lookId ?? null; });
            return next;
        });

        const recover = async () => {
            const done: AssetGenerationJob[] = [];
            for (const job of pendingJobs) {
                try {
                    const status = await getImageTaskStatus(job.id);
                    if (disposed) return;

                    if (status.status === 'succeeded' && status.resultUrl) {
                        setAssetMap((prev) => {
                            // 跨集找到该资产当前对象，据此计算 patch，再全局同步（生成图对所有集生效）
                            const cats: AssetCategory[] = ['characters', 'scenes', 'props'];
                            let current: EditableAsset | undefined;
                            for (const catMap of Object.values(prev)) {
                                for (const c of cats) {
                                    const found = (catMap[c] || []).find((a) => a.id === job.assetId);
                                    if (found) { current = found; break; }
                                }
                                if (current) break;
                            }
                            if (!current) return prev;
                            const patch: Partial<EditableAsset> = job.lookId
                                ? {
                                    imageUrl: status.resultUrl,
                                    looks: current.looks.map((look) => look.id === job.lookId ? { ...look, imageUrl: status.resultUrl } : look),
                                }
                                : {
                                    imageUrl: status.resultUrl,
                                    // 主图始终归属第一个造型（覆盖旧图），造型为空时补一个
                                    looks: (current.looks.length > 0 ? current.looks : [{ id: uid(), name: '造型 1' }])
                                        .map((look, index) => index === 0 ? { ...look, imageUrl: status.resultUrl } : look),
                                };
                            return syncAssetAcrossEpisodes(prev, job.category, job.assetId, patch);
                        });
                        finishJob(
                            projectId,
                            { id: job.id, kind: 'asset', episode: job.episode, payload: { ...job }, startedAt: job.startedAt },
                            'succeeded',
                            { resultUrl: status.resultUrl },
                        );
                        done.push(job);
                        setGenerating((current) => {
                            const next = { ...current };
                            delete next[job.assetId];
                            return next;
                        });
                    } else if (status.status === 'failed') {
                        // 服务端明确失败：清理任务并提示（不重试，避免相同参数反复失败）
                        setError(`有资产图片生成失败：${status.error || '未知错误'}`);
                        finishJob(
                            projectId,
                            { id: job.id, kind: 'asset', episode: job.episode, payload: { ...job }, startedAt: job.startedAt },
                            'failed',
                            { error: status.error || '未知错误' },
                        );
                        done.push(job);
                        setGenerating((current) => {
                            const next = { ...current };
                            delete next[job.assetId];
                            return next;
                        });
                    } else if (status.status === 'notfound') {
                        // 任务在服务端不存在（可能提交时被打断）：用持久化的 prompt 重新提交
                        if (job.prompt) {
                            await submitImageTask({
                                prompt: job.prompt,
                                aspectRatio: ASSET_ASPECT_RATIO,
                                resolution: imageResolution,
                                imageModel,
                                nodeId: job.id,
                                channel: 'workflow',
                            });
                        } else {
                            // 没有 prompt（历史遗留任务）无法重建，放弃以免死循环
                            finishJob(
                                projectId,
                                { id: job.id, kind: 'asset', episode: job.episode, payload: { ...job }, startedAt: job.startedAt },
                                'failed',
                                { error: '任务已从服务端丢失，且没有记录提示词，无法自动恢复' },
                            );
                            done.push(job);
                            setGenerating((current) => {
                                const next = { ...current };
                                delete next[job.assetId];
                                return next;
                            });
                        }
                    }
                    // running：继续等下一轮
                } catch {
                    // 服务暂不可用时保留任务，下轮继续恢复。
                }
            }
            if (!disposed && done.length) {
                const doneIds = new Set(done.map((job) => job.id));
                setPendingJobs((jobs) => jobs.filter((job) => !doneIds.has(job.id)));
            }
        };
        void recover();
        const timer = window.setInterval(() => void recover(), 3000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [pendingJobs]); // patchCategory 仅使用稳定的 React setter

    const handleAdd = (category: AssetCategory) => {
        const meta = CATEGORY_META.find((c) => c.key === category)!;
        const id = uid();
        const name = `${meta.label}新增项`;
        patchCategory(activeEpisode, category, (list) => [
            ...list,
            { id, name, looks: [{ id: uid(), name: '造型 1' }] },
        ]);
        setRenamingId(id);
    };

    const handleRemove = (category: AssetCategory, id: string) => {
        patchCategory(activeEpisode, category, (list) => list.filter((a) => a.id !== id));
        setOpenMenuId(null);
    };

    const handleAddLook = (category: AssetCategory, asset: EditableAsset) => {
        const nextIndex = asset.looks.length + 1;
        patchAsset(activeEpisode, category, asset.id, {
            looks: [...asset.looks, { id: uid(), name: `造型 ${nextIndex}` }],
        });
        setOpenMenuId(null);
    };

    /**
     * 删除造型。
     * 允许删到 0 个（造型是可选的多外观配置，不是必须项）；
     * 被删造型若正是主图（默认「造型 1」），主图字段让位给剩余造型，
     * 没有剩余造型则清空主图，避免主图指向已删除的造型。
     */
    const handleRemoveLook = (category: AssetCategory, asset: EditableAsset, lookId: string) => {
        const removing = asset.looks.find((l) => l.id === lookId);
        const rest = asset.looks.filter((l) => l.id !== lookId);
        const patch: Partial<EditableAsset> = { looks: rest };
        // 若删掉的是当前主图对应的造型，则主图改用剩余第一个造型（无剩余则清空）
        if (removing && removing.imageUrl === asset.imageUrl) {
            const fallback = rest.find((l) => l.imageUrl) || rest[0];
            patch.imageUrl = fallback?.imageUrl;
        }
        patchAsset(activeEpisode, category, asset.id, patch);
    };

    /**
     * 删除「独立主图」。
     * 重新生成主图后，新图不会覆盖已有造型图，会形成一张不属于任何造型的图；
     * 用户可单独删除它，造型内的图片保持不变。
     */
    const handleRemoveMainImage = (category: AssetCategory, asset: EditableAsset) => {
        patchAsset(activeEpisode, category, asset.id, { imageUrl: undefined });
    };

    // ============================================================================
    // 图片生成
    // ============================================================================

    /**
     * 生成资产图。
     * @param lookId   指定造型（省略则生成主图）
     * @param override 详情页里刚改过、尚未落库的名称/描述，随生成一起写入并使用
     */
    const generateForAsset = async (
        episode: number,
        category: AssetCategory,
        asset: EditableAsset,
        lookId?: string,
        override?: Partial<EditableAsset>
    ) => {
        const target: EditableAsset = override ? { ...asset, ...override } : asset;
        const look = lookId ? target.looks.find((l) => l.id === lookId) : undefined;
        const prompt = buildAssetPrompt(category, target, look?.name, contentType);

        // 文本改动（名称/描述）不依赖生成结果，先写回；图片由轮询结果写回
        if (override) {
            patchAsset(episode, category, asset.id, override);
        }

        const job: AssetGenerationJob = {
            id: generationId(),
            episode,
            category,
            assetId: asset.id,
            lookId,
            prompt,
            startedAt: Date.now(),
            assetName: target.name,
            aspectRatio: ASSET_ASPECT_RATIO,
            resolution: imageResolution,
            imageModel,
        };
        setError('');
        setGenerating((g) => ({ ...g, [asset.id]: lookId ?? null }));
        // 先持久化任务，再提交；切页/刷新后可通过 job.id 从服务端取回结果。
        saveAssetJobs(projectId, [...loadAssetJobs(projectId), job]);
        setPendingJobs((jobs) => [...jobs, job]);
        try {
            // 提交任务（立即返回，不等生成完成）；生成结果由 recover 轮询写回，
            // 不再把「同步等待出图」绑死在当前页面生命周期上。
            await submitImageTask({
                prompt,
                aspectRatio: ASSET_ASPECT_RATIO,
                resolution: imageResolution,
                imageModel,
                nodeId: job.id,
                channel: 'workflow',
            });
        } catch (e: any) {
            setError(`「${asset.name}」生成失败：${e?.message || '未知错误'}`);
            finishJob(
                projectId,
                { id: job.id, kind: 'asset', episode: job.episode, payload: { ...job }, startedAt: job.startedAt },
                'failed',
                { error: e?.message || '提交生成失败' },
            );
            // 提交失败：清理本次任务（服务端无任务，轮询也无法恢复）
            setPendingJobs((jobs) => jobs.filter((item) => item.id !== job.id));
            setGenerating((g) => {
                const next = { ...g };
                delete next[asset.id];
                return next;
            });
        }
    };

    /** 一键生成当前集全部资产图（角色 + 场景 + 道具），已有图 / 生成中的资产跳过（跨集复用，不重复生成） */
    const handleGenerateAll = async () => {
        // pendingJobs 非空 = 上一批还没跑完（含服务端后台生成），阻止重复提交
        if (batchGenerating || pendingJobs.length > 0) return;
        const hasImage = (a: EditableAsset) =>
            !!a.imageUrl || (Array.isArray(a.looks) && a.looks.some((l) => !!l.imageUrl));
        const cats: AssetCategory[] = ['characters', 'scenes', 'props'];
        const targets = cats.flatMap((c) =>
            (assetMap[activeEpisode]?.[c] || [])
                .filter((a) => !hasImage(a) && generating[a.id] === undefined)
                .map((a) => ({ category: c, asset: a }))
        );
        if (targets.length === 0) return;
        setBatchGenerating(true);
        setError('');
        // 整批先标记为「生成中」：排队等待的卡片也有明确反馈，而不是停在「暂无图片」
        setGenerating((g) => {
            const next = { ...g };
            for (const { asset } of targets) next[asset.id] = null;
            return next;
        });
        // 受控并发：同时最多 BATCH_CONCURRENCY 个，其余排队；单个失败不影响整批
        await runWithConcurrency(
            targets,
            ({ category, asset }) => generateForAsset(activeEpisode, category, asset),
            BATCH_CONCURRENCY
        );
        setBatchGenerating(false);
    };

    // ============================================================================
    // 渲染
    // ============================================================================

    return (
        <div
            ref={rootRef}
            className={`flex min-w-0 gap-4 ${fillHeight ? 'flex-1 min-h-0' : 'h-[640px] min-h-[480px]'}`}
        >
            {/* ===================== 左侧：分集目录 ===================== */}
            <aside className="w-[150px] shrink-0 overflow-hidden rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)] flex flex-col">
                <div className="flex h-[44px] shrink-0 items-center justify-between gap-1 border-b border-[#eef0f6] px-3">
                    <span className="text-[13px] font-medium text-[#1c2745]">分集目录</span>
                    <span className="text-[11px] text-[#9ca4b7]">{episodes.length} 集</span>
                </div>
                <div className="flex-1 overflow-y-auto py-1">
                    {episodes.map((ep) => {
                        const active = ep.episode === activeEpisode;
                        return (
                            <button
                                key={ep.episode}
                                onClick={() => setActiveEpisode(ep.episode)}
                                title={ep.title}
                                className={`w-full border-l-2 px-3 py-2 text-left transition-colors ${
                                    active
                                        ? 'border-[#4558dc] bg-[#f5f6ff]'
                                        : 'border-transparent hover:bg-[#fafbff]'
                                }`}
                            >
                                <div className={`text-[13px] font-medium ${active ? 'text-[#4558dc]' : 'text-[#1d2129]'}`}>
                                    第 {String(ep.episode).padStart(2, '0')} 集
                                </div>
                                <div className={`mt-0.5 truncate text-[12px] ${active ? 'text-[#7f889d]' : 'text-[#9ca4b7]'}`}>
                                    {ep.title || '未命名'}
                                </div>
                            </button>
                        );
                    })}
                    {episodes.length === 0 && (
                        <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-[#9ca4b7]">暂无分集</div>
                    )}
                </div>
                {onGoOverview && (
                    <div className="shrink-0 border-t border-[#eef0f6] p-2">
                        <button
                            onClick={onGoOverview}
                            className="flex h-8 w-full items-center justify-center gap-1 rounded-[4px] border border-[#d9d9d9] bg-white text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc] hover:text-[#4558dc]"
                        >
                            <ChevronLeft size={13} />
                            返回概览
                        </button>
                    </div>
                )}
            </aside>

            {/* ===================== 右侧：主区 ===================== */}
            <div className="flex-1 min-w-0 overflow-y-auto rounded-[10px] border border-[#e9ebf2] bg-white shadow-[0_2px_8px_rgba(33,43,83,0.03)]">
                <div className="px-6 py-5">
                    {/* ---------- AI 提取信息条 ---------- */}
                    <div className="flex items-center gap-2 rounded-[6px] border border-[#dbe3ff] bg-[#f5f7ff] px-3 py-2 text-[12px] text-[#4558dc]">
                        <Sparkles size={13} className="shrink-0 text-[#4558dc]" />
                        <span className="flex-1">
                            AI 已从第 {activeEpisode} 集剧本提取 {categoryCounts.characters} 个角色、{categoryCounts.scenes} 个场景、{categoryCounts.props} 个道具
                        </span>
                    </div>

                    {/* ---------- 错误提示 ---------- */}
                    {error && (
                        <div className="mb-3 flex items-center gap-2 rounded-[6px] border border-[#ffccc7] bg-[#fff2f0] px-3 py-2 text-[12px] text-[#cf1322]">
                            <AlertCircle size={14} className="shrink-0" />
                            <span className="flex-1">{error}</span>
                        </div>
                    )}

                    {/* ---------- 生成工具行：模型 / 分辨率 / 一键生成全资产 ---------- */}
                    <div className="mt-4 flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] text-[#4e5969]">生成模型</span>
                        <Select
                            value={imageModel}
                            options={IMAGE_MODELS.map((m) => m.id)}
                            labels={IMAGE_MODELS.map((m) => m.name)}
                            onChange={setImageModel}
                        />
                        <Select value={imageResolution} options={IMAGE_RESOLUTIONS} onChange={setImageResolution} />
                        <button
                            onClick={handleGenerateAll}
                            disabled={batchGenerating || categoryCounts.characters + categoryCounts.scenes + categoryCounts.props === 0}
                            className="flex h-8 items-center gap-1.5 rounded-[4px] bg-[#4558dc] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#5c6fe4] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {batchGenerating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            一键生成全资产
                        </button>
                        <button
                            onClick={handleAssignVoices}
                            disabled={assigningVoices || categoryCounts.characters === 0}
                            title="按人物小传的性别、年龄、性格自动选择音色（纯文本决策，不需要语音合成授权）"
                            className="flex h-8 items-center gap-1.5 rounded-[4px] border border-[#4558dc] bg-white px-3 text-[12px] font-medium text-[#4558dc] transition-colors hover:bg-[#f5f6ff] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {assigningVoices ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                            AI 分配音色
                        </button>
                    </div>

                    {/* ---------- 分类 Tab ---------- */}
                    <div className="mt-4 flex w-fit items-center gap-1 rounded-[6px] bg-[#f2f3f5] p-0.5">
                        {CATEGORY_META.map((cat) => {
                            const active = cat.key === activeCategory;
                            return (
                                <button
                                    key={cat.key}
                                    onClick={() => setActiveCategory(cat.key)}
                                    className={`h-7 rounded-[4px] px-3 text-[13px] transition-colors ${
                                        active
                                            ? 'bg-white text-[#1d2129] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                                            : 'text-[#4e5969] hover:text-[#1d2129]'
                                    }`}
                                >
                                    {cat.label}
                                    <span className={`ml-1.5 text-[11px] ${active ? 'text-[#4558dc]' : 'text-[#9ca4b7]'}`}>
                                        {categoryCounts[cat.key]}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ---------- 资产卡片网格 ---------- */}
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {list.map((asset) => (
                            <AssetCard
                                key={asset.id}
                                asset={asset}
                                category={activeCategory}
                                generating={Object.prototype.hasOwnProperty.call(generating, asset.id)}
                                renaming={renamingId === asset.id}
                                menuOpen={openMenuId === asset.id}
                                voiceOpen={voicePopoverId === asset.id}
                                onRenameStart={() => setRenamingId(asset.id)}
                                onRenameCommit={(name) => {
                                    patchAsset(activeEpisode, activeCategory, asset.id, { name: name.trim() || asset.name });
                                    setRenamingId(null);
                                }}
                                onEdit={() => {
                                    setEditingAssetId(asset.id);
                                    setOpenMenuId(null);
                                }}
                                onRegenerate={() => {
                                    setOpenMenuId(null);
                                    void generateForAsset(activeEpisode, activeCategory, asset);
                                }}
                                onAddLook={() => handleAddLook(activeCategory, asset)}
                                onRemove={() => handleRemove(activeCategory, asset.id)}
                                onToggleMenu={() =>
                                    setOpenMenuId((cur) => (cur === asset.id ? null : asset.id))
                                }
                                onToggleVoice={() =>
                                    setVoicePopoverId((cur) => (cur === asset.id ? null : asset.id))
                                }
                                onPickVoice={(v) => {
                                    // 直接选预设音色时清掉自定义风格，避免「换了音色却保留旧语气」
                                    patchAsset(activeEpisode, activeCategory, asset.id, {
                                        voiceName: v,
                                        voicePrompt: undefined,
                                    });
                                    setVoicePopoverId(null);
                                }}
                                onApplyVoice={(voice, prompt) => {
                                    patchAsset(activeEpisode, activeCategory, asset.id, {
                                        voiceName: voice,
                                        voicePrompt: prompt,
                                    });
                                    setVoicePopoverId(null);
                                }}
                                onOpenDetail={() => {
                                    setEditingAssetId(asset.id);
                                    setOpenMenuId(null);
                                }}
                            />
                        ))}

                        {/* 新增卡片 */}
                        <button
                            onClick={() => handleAdd(activeCategory)}
                            className="flex h-full min-h-[170px] flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-[#d9d9d9] bg-[#fafbff] text-[#86909c] transition-colors hover:border-[#4558dc] hover:bg-[#f5f6ff] hover:text-[#4558dc]"
                        >
                            <Plus size={20} />
                            <span className="text-[13px]">
                                {CATEGORY_META.find((c) => c.key === activeCategory)?.addLabel}
                            </span>
                        </button>
                    </div>
                </div>
            </div>

            {/* ---------- 资产详情页 ---------- */}
            {editingAsset && (
                <AssetDetailDrawer
                    asset={editingAsset}
                    category={activeCategory}
                    imageModel={imageModel}
                    imageResolution={imageResolution}
                    modelOptions={IMAGE_MODELS}
                    resolutionOptions={IMAGE_RESOLUTIONS}
                    onModelChange={setImageModel}
                    onResolutionChange={setImageResolution}
                    generatingKey={generating[editingAsset.id]}
                    buildPrompt={(patch) =>
                        buildAssetPrompt(activeCategory, { ...editingAsset, ...patch }, undefined, contentType)
                    }
                    onClose={() => setEditingAssetId(null)}
                    onSave={(patch) => patchAsset(activeEpisode, activeCategory, editingAsset.id, patch)}
                    onGenerate={(patch) => {
                        void generateForAsset(activeEpisode, activeCategory, editingAsset, undefined, patch);
                    }}
                    onGenerateLook={(lookId, patch) => {
                        void generateForAsset(activeEpisode, activeCategory, editingAsset, lookId, patch);
                    }}
                    onAddLook={() => handleAddLook(activeCategory, editingAsset)}
                    onRemoveLook={(lookId) => handleRemoveLook(activeCategory, editingAsset, lookId)}
                    onRemoveMain={() => handleRemoveMainImage(activeCategory, editingAsset)}
                    onPreview={(src, title) => openPreview(src, title)}
                />
            )}

            {/* ---------- 大图预览 ---------- */}
            {previewSrc &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6"
                        onClick={() => setPreviewSrc(null)}
                    >
                        <button
                            onClick={() => setPreviewSrc(null)}
                            title="关闭（Esc）"
                            className="absolute top-4 right-4 h-9 w-9 rounded-lg bg-white/[0.12] hover:bg-white/[0.22] text-white flex items-center justify-center transition-colors"
                        >
                            <X size={18} />
                        </button>
                        {previewTitle && (
                            <div className="absolute top-4 left-5 text-[13px] text-white/80">{previewTitle}</div>
                        )}
                        <img
                            src={previewSrc}
                            alt={previewTitle}
                            onClick={(e) => e.stopPropagation()}
                            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                        />
                    </div>,
                    document.body
                )}
        </div>
    );
};

// ============================================================================
// 资产卡片
// ============================================================================

interface AssetCardProps {
    asset: EditableAsset;
    category: AssetCategory;
    generating: boolean;
    renaming: boolean;
    menuOpen: boolean;
    voiceOpen: boolean;
    onRenameStart: () => void;
    onRenameCommit: (name: string) => void;
    onEdit: () => void;
    onRegenerate: () => void;
    onAddLook: () => void;
    onRemove: () => void;
    onToggleMenu: () => void;
    onToggleVoice: () => void;
    onPickVoice: (voice: string) => void;
    /** 应用自定义音色：基础音色 + 风格提示词（提示词留空即取消自定义） */
    onApplyVoice: (voice: string, prompt?: string) => void;
    /** 打开资产详情页 */
    onOpenDetail: () => void;
}

const AssetCard: React.FC<AssetCardProps> = ({
    asset,
    category,
    generating,
    renaming,
    menuOpen,
    voiceOpen,
    onRenameStart,
    onRenameCommit,
    onEdit,
    onRegenerate,
    onAddLook,
    onRemove,
    onToggleMenu,
    onToggleVoice,
    onPickVoice,
    onApplyVoice,
    onOpenDetail,
}) => {
    const [draftName, setDraftName] = useState(asset.name);
    /** 音色弹层里的「自定义」编辑态 */
    const [customOpen, setCustomOpen] = useState(false);
    /** 音色分组展开状态（手风琴，一次只展开一个组） */
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    /** 音色按钮引用：用于判断弹层该向上还是向下弹 */
    const voiceBtnRef = useRef<HTMLButtonElement>(null);
    /** 弹层固定高度，空间不足时改为向下弹出 */
    const [voiceDropUp, setVoiceDropUp] = useState(true);
    const [draftVoiceBase, setDraftVoiceBase] = useState(() => normalizeVoiceId(asset.voiceName));
    const [draftVoicePrompt, setDraftVoicePrompt] = useState(asset.voicePrompt || '');
    const {
        activeKey: previewingKey,
        loadingKey: previewLoadingKey,
        error: previewError,
        toggle: togglePreview,
    } = useVoicePreview();

    useEffect(() => {
        if (renaming) setDraftName(asset.name);
    }, [renaming, asset.name]);

    // 弹层关闭时收起自定义编辑态，避免下次打开残留草稿
    useEffect(() => {
        if (!voiceOpen) setCustomOpen(false);
    }, [voiceOpen]);

    // 打开弹层时默认展开「当前音色」所在分组，其余保持收起
    useEffect(() => {
        if (!voiceOpen) return;
        const current = groupVoices().find((g) =>
            g.items.some((v) => v.id === normalizeVoiceId(asset.voiceName))
        );
        setOpenGroups(current ? { [current.title]: true } : {});
        // 只在弹层开关时重置，避免选择音色过程中分组突然收起
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [voiceOpen]);

    const isCharacter = category === 'characters';
    /** 自定义面板草稿对应的试听 key（随基础音色 / 提示词变化） */
    const customVoiceKey = previewKeyOf(draftVoiceBase, draftVoicePrompt.trim() || undefined);
    /** 自定义面板当前基础音色条目：英文音色只能用英文示例句试听 */
    const draftBaseVoice = findVoice(draftVoiceBase);
    const draftBaseIsEnglish = draftBaseVoice ? isEnglishVoice(draftBaseVoice) : false;
    /** 当前已选音色（未配置时回落默认） */
    const selectedVoiceId = normalizeVoiceId(asset.voiceName);

    return (
        <div className="group relative rounded-[8px] border border-[#e9ebf2] bg-white flex flex-col overflow-hidden transition-shadow hover:shadow-[0_4px_14px_rgba(33,43,83,0.10)]">
            {/* 图片区：固定横版比例，object-contain 完整显示不裁切 */}
            <div
                className="relative bg-[#f7f8fc] overflow-hidden"
                style={{ aspectRatio: ASSET_CSS_ASPECT }}
            >
                {asset.imageUrl ? (
                    <button
                        type="button"
                        onClick={onOpenDetail}
                        title="点击查看详情"
                        className="block w-full h-full cursor-pointer"
                    >
                        <img
                            src={asset.imageUrl}
                            alt={asset.name}
                            className="w-full h-full object-contain"
                            loading="lazy"
                        />
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={onOpenDetail}
                        title="点击进入详情"
                        className="w-full h-full flex items-center justify-center text-[#c2c7d2] text-[12px] cursor-pointer hover:text-[#86909c] transition-colors"
                    >
                        暂无图片 · 点击进入详情
                    </button>
                )}

                {generating && (
                    <div className="absolute inset-0 bg-white/88 backdrop-blur-[1px] flex flex-col items-center justify-center gap-2">
                        <Loader2 size={22} className="animate-spin text-[#4558dc]" />
                        <span className="text-[12px] text-[#4558dc]">正在生成…</span>
                        <span className="h-1 w-14 rounded-full bg-[#edf0f7] overflow-hidden">
                            <span className="block h-full w-1/2 rounded-full bg-[#4558dc]/70 animate-pulse" />
                        </span>
                    </div>
                )}

                {/* 造型数 */}
                <span className="absolute bottom-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white backdrop-blur-sm">
                    {asset.looks.length}个造型
                </span>

                {/* 图片悬停操作 */}
                {!generating && (
                    <button
                        onClick={onRegenerate}
                        title={asset.imageUrl ? '重新生成图片' : '生成图片'}
                        className="absolute top-1.5 right-1.5 h-7 w-7 rounded-md bg-black/50 backdrop-blur-sm text-white hover:text-[#dbe3ff] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                        <RefreshCw size={13} />
                    </button>
                )}
            </div>

            {/* 信息 / 操作区 */}
            <div className="flex items-center gap-1 px-2 py-1.5 border-t border-[#eef0f6]">
                {renaming ? (
                    <input
                        autoFocus
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onBlur={() => onRenameCommit(draftName)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') onRenameCommit(draftName);
                            if (e.key === 'Escape') onRenameCommit(asset.name);
                        }}
                        className="flex-1 min-w-0 h-6 rounded bg-white px-1.5 text-[13px] text-[#1d2129] outline-none ring-1 ring-[#4558dc]"
                    />
                ) : (
                    <button
                        onDoubleClick={onRenameStart}
                        title={asset.name}
                        className="flex-1 min-w-0 text-left text-[13px] text-[#1d2129] truncate hover:text-[#4558dc]"
                    >
                        {asset.name}
                    </button>
                )}

                {/* 配置音色（仅角色） */}
                {isCharacter && (
                    <div className="relative shrink-0">
                        <button
                            ref={voiceBtnRef}
                            onClick={(e) => {
                                e.stopPropagation();
                                // 弹层高度固定；上方空间不够就翻到下方，避免被视口裁掉
                                const rect = voiceBtnRef.current?.getBoundingClientRect();
                                if (rect) {
                                    const spaceAbove = rect.top - 12;
                                    const spaceBelow = window.innerHeight - rect.bottom - 12;
                                    setVoiceDropUp(spaceAbove >= VOICE_PANEL_H || spaceAbove >= spaceBelow);
                                }
                                onToggleVoice();
                            }}
                            title={
                                asset.voiceName
                                    ? `音色：${voiceLabel(asset.voiceName)}${asset.voicePrompt ? `｜自定义：${asset.voicePrompt}` : ''}`
                                    : '配置音色'
                            }
                            className={`h-6 px-1.5 rounded text-[11px] flex items-center gap-1 transition-colors ${
                                asset.voiceName
                                    ? 'text-[#4558dc]'
                                    : 'text-[#86909c] hover:text-[#1d2129]'
                            }`}
                        >
                            <Mic size={12} />
                            <span className="max-w-[56px] truncate">
                                {voiceLabel(asset.voiceName) || '配置音色'}
                                {asset.voicePrompt ? '*' : ''}
                            </span>
                        </button>

                        {voiceOpen && (
                            <div
                                onMouseDown={(e) => e.stopPropagation()}
                                style={{
                                    ...(customOpen ? {} : { height: VOICE_PANEL_H }),
                                    // 与项目其他面板一致：细滚动条（Chrome 121+ / Firefox 生效）
                                    scrollbarWidth: 'thin',
                                    scrollbarColor: 'rgba(0,0,0,0.2) transparent',
                                }}
                                className={`absolute right-0 z-30 w-56 overflow-y-auto overscroll-contain rounded-[6px] border border-[#d9d9d9] bg-white shadow-[0_6px_20px_rgba(33,43,83,0.14)] py-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/15 hover:[&::-webkit-scrollbar-thumb]:bg-black/25 ${
                                    voiceDropUp ? 'bottom-full mb-1' : 'top-full mt-1'
                                }`}
                            >
                                {customOpen ? (
                                    <div className="px-2 pt-1.5 pb-2 space-y-1.5">
                                        <div className="text-[11px] text-[#86909c]">基础音色</div>
                                        {/*
                                            原生 select 的选项面板由系统绘制；这里给 option / optgroup
                                            显式指定浅色底与深色文字，避免系统面板与页面主题色错位看不清。
                                        */}
                                        <div className="relative">
                                            <select
                                                value={draftVoiceBase}
                                                onChange={(e) => setDraftVoiceBase(e.target.value)}
                                                className="w-full h-7 appearance-none rounded border border-[#d9d9d9] bg-white pl-1.5 pr-6 text-[12px] text-[#1d2129] outline-none cursor-pointer hover:border-[#4558dc]"
                                            >
                                                {groupVoices().map((g) => (
                                                    <optgroup
                                                        key={g.title}
                                                        label={g.title}
                                                        style={{ background: '#ffffff', color: '#86909c' }}
                                                    >
                                                        {g.items.map((v) => (
                                                            <option
                                                                key={v.id}
                                                                value={v.id}
                                                                style={{ background: '#ffffff', color: '#1d2129' }}
                                                            >
                                                                {v.name}
                                                                {isEnglishVoice(v) ? '（英文）' : ''}
                                                            </option>
                                                        ))}
                                                    </optgroup>
                                                ))}
                                                {/* 透传的自定义 voice_type 不在目录里，补一项否则下拉框会显示空白 */}
                                                {!isKnownVoice(draftVoiceBase) && (
                                                    <option
                                                        value={draftVoiceBase}
                                                        style={{ background: '#ffffff', color: '#1d2129' }}
                                                    >
                                                        {draftVoiceBase}
                                                    </option>
                                                )}
                                            </select>
                                            <ChevronDown
                                                size={12}
                                                className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[#86909c]"
                                            />
                                        </div>
                                        {draftBaseIsEnglish && (
                                            <div className="text-[11px] leading-snug text-[#d98100]">
                                                英文音色只朗读英文文本，试听会用英文示例句
                                            </div>
                                        )}
                                        <div className="text-[11px] text-[#86909c]">风格提示词</div>
                                        <textarea
                                            value={draftVoicePrompt}
                                            onChange={(e) => setDraftVoicePrompt(e.target.value)}
                                            rows={3}
                                            placeholder="如：低沉沙哑、语速偏慢、带点疲惫的克制感"
                                            className="w-full resize-none rounded border border-[#d9d9d9] bg-white px-1.5 py-1 text-[12px] leading-snug text-[#1d2129] outline-none placeholder:text-[#c2c7d2] focus:border-[#4558dc]"
                                        />
                                        <button
                                            onClick={() =>
                                                void togglePreview(draftVoiceBase, draftVoicePrompt.trim() || undefined)
                                            }
                                            title="用示例句试听当前基础音色 + 风格提示词"
                                            className={`w-full h-7 rounded border text-[12px] flex items-center justify-center gap-1 transition-colors ${
                                                previewingKey === customVoiceKey
                                                    ? 'border-[#4558dc] bg-[#f5f6ff] text-[#4558dc]'
                                                    : 'border-[#d9d9d9] text-[#4e5969] hover:border-[#4558dc] hover:text-[#4558dc]'
                                            }`}
                                        >
                                            {previewLoadingKey === customVoiceKey ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : previewingKey === customVoiceKey ? (
                                                <Pause size={12} />
                                            ) : (
                                                <Play size={12} />
                                            )}
                                            试听当前设置
                                        </button>
                                        <div className="flex items-center gap-1">
                                            <button
                                                onClick={() => {
                                                    onApplyVoice(draftVoiceBase, draftVoicePrompt.trim() || undefined);
                                                    setCustomOpen(false);
                                                }}
                                                className="flex-1 h-7 rounded bg-[#4558dc] hover:bg-[#5c6fe4] text-[12px] font-medium text-white"
                                            >
                                                应用
                                            </button>
                                            <button
                                                onClick={() => setCustomOpen(false)}
                                                className="h-7 px-2 rounded border border-[#d9d9d9] bg-white hover:border-[#4558dc] text-[12px] text-[#4e5969]"
                                            >
                                                取消
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="pb-1">
                                        {groupVoices().map((g) => {
                                            const open = !!openGroups[g.title];
                                            return (
                                                <div key={g.title}>
                                                    <button
                                                        onClick={() =>
                                                            // 互斥展开：点开一个组时收起其他组，控制总高度
                                                            setOpenGroups((prev) =>
                                                                prev[g.title] ? {} : { [g.title]: true }
                                                            )
                                                        }
                                                        className="w-full h-8 px-2.5 flex items-center justify-between text-[12px] text-[#1d2129] hover:bg-[#f5f6ff]"
                                                    >
                                                        <span className="flex items-center gap-1.5">
                                                            {g.title}
                                                            <span className="text-[10px] text-[#9ca4b7]">
                                                                {g.items.length}
                                                            </span>
                                                        </span>
                                                        <ChevronDown
                                                            size={12}
                                                            className={`text-[#86909c] transition-transform ${
                                                                open ? 'rotate-180' : ''
                                                            }`}
                                                        />
                                                    </button>
                                                    {open && (
                                                        <div className="pb-1">
                                                            {g.items.map((v) => {
                                                                const vk = previewKeyOf(v.id);
                                                                const busy = previewLoadingKey === vk;
                                                                const playing = previewingKey === vk;
                                                                const selected =
                                                                    selectedVoiceId === v.id && !asset.voicePrompt;
                                                                return (
                                                                    <div key={v.id} className="flex items-center">
                                                                        <button
                                                                            onClick={() => onPickVoice(v.id)}
                                                                            title={v.desc}
                                                                            className="flex-1 min-w-0 text-left pl-5 pr-2 py-1.5 text-[12px] hover:bg-[#f5f6ff] flex items-center justify-between gap-1"
                                                                        >
                                                                            <span
                                                                                className={`truncate ${
                                                                                    selected
                                                                                        ? 'text-[#4558dc]'
                                                                                        : 'text-[#4e5969]'
                                                                                }`}
                                                                            >
                                                                                {v.name}
                                                                            </span>
                                                                        </button>
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                void togglePreview(v.id);
                                                                            }}
                                                                            title={playing ? '停止试听' : '试听该音色'}
                                                                            className={`mr-1 h-6 w-6 shrink-0 rounded flex items-center justify-center transition-colors ${
                                                                                playing || busy
                                                                                    ? 'text-[#4558dc] bg-[#f5f6ff]'
                                                                                    : 'text-[#86909c] hover:text-[#4558dc] hover:bg-[#f5f6ff]'
                                                                            }`}
                                                                        >
                                                                            {busy ? (
                                                                                <Loader2
                                                                                    size={12}
                                                                                    className="animate-spin"
                                                                                />
                                                                            ) : playing ? (
                                                                                <Pause size={12} />
                                                                            ) : (
                                                                                <Play size={12} />
                                                                            )}
                                                                        </button>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {asset.voicePrompt && (
                                            <div className="mx-2 mt-1 max-h-[30px] overflow-hidden rounded bg-[#f5f6ff] px-1.5 py-1 text-[11px] leading-snug text-[#4558dc]">
                                                风格：{asset.voicePrompt}
                                            </div>
                                        )}
                                        <div className="sticky bottom-0 bg-white">
                                            <div className="h-px bg-[#eef0f6] my-1" />
                                            <button
                                                onClick={() => {
                                                    setDraftVoiceBase(selectedVoiceId);
                                                    setDraftVoicePrompt(asset.voicePrompt || '');
                                                    setCustomOpen(true);
                                                }}
                                                title="用自然语言描述音色风格，配合基础音色使用"
                                                className="w-full text-left px-2.5 py-1.5 text-[12px] text-[#4558dc] hover:bg-[#f5f6ff] flex items-center gap-1.5"
                                            >
                                                <Wand2 size={12} />
                                                自定义音色…
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {previewError && (
                                    <div className="px-2.5 pt-1 pb-1.5 text-[11px] leading-snug text-[#cf1322]">
                                        {previewError}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* 更多菜单 */}
                <div className="relative shrink-0">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleMenu();
                        }}
                        className="h-6 w-6 rounded text-[#86909c] hover:text-[#1d2129] hover:bg-[#f2f3f5] flex items-center justify-center"
                    >
                        <MoreHorizontal size={14} />
                    </button>

                    {menuOpen && (
                        <div
                            onMouseDown={(e) => e.stopPropagation()}
                            className="absolute right-0 bottom-full mb-1 z-30 w-36 rounded-[6px] border border-[#d9d9d9] bg-white shadow-[0_6px_20px_rgba(33,43,83,0.14)] py-1"
                        >
                            <MenuItem icon={Pencil} label="编辑名称/描述" onClick={onEdit} />
                            <MenuItem icon={RefreshCw} label={asset.imageUrl ? '重新生成' : '生成图片'} onClick={onRegenerate} />
                            <MenuItem icon={Layers} label="新增造型" onClick={onAddLook} />
                            <div className="h-px bg-[#eef0f6] my-1" />
                            <MenuItem icon={Trash2} label="删除" danger onClick={onRemove} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const MenuItem: React.FC<{
    icon: React.ComponentType<{ size?: number; className?: string }>;
    label: string;
    onClick: () => void;
    danger?: boolean;
}> = ({ icon: Icon, label, onClick, danger }) => (
    <button
        onClick={onClick}
        className={`w-full text-left px-2.5 py-1.5 text-[12px] flex items-center gap-2 hover:bg-[#f5f6ff] ${
            danger ? 'text-[#cf1322] hover:text-[#a8071a]' : 'text-[#4e5969]'
        }`}
    >
        <Icon size={13} />
        {label}
    </button>
);

// ============================================================================
// 轻量下拉选择
// ============================================================================

const Select: React.FC<{
    value: string;
    options: string[];
    labels?: string[];
    onChange: (v: string) => void;
}> = ({ value, options, labels, onChange }) => {
    const [open, setOpen] = useState(false);
    const current = labels ? labels[options.indexOf(value)] || value : value;

    useEffect(() => {
        const onDocDown = () => setOpen(false);
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
    }, []);

    return (
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex h-8 items-center gap-1 rounded-[4px] border border-[#d9d9d9] bg-white px-2.5 text-[12px] text-[#1d2129] transition-colors hover:border-[#4558dc]"
            >
                <span className="truncate max-w-[150px]">{current}</span>
                <ChevronDown size={12} className="shrink-0 text-[#86909c]" />
            </button>
            {open && (
                <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-[6px] border border-[#d9d9d9] bg-white shadow-[0_6px_20px_rgba(33,43,83,0.14)] py-1 max-h-56 overflow-y-auto">
                    {options.map((o, i) => (
                        <button
                            key={o}
                            onClick={() => {
                                onChange(o);
                                setOpen(false);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#f5f6ff] ${
                                o === value ? 'text-[#4558dc]' : 'text-[#4e5969]'
                            }`}
                        >
                            {labels ? labels[i] : o}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default AssetConfirmPanel;
