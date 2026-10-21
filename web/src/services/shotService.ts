/**
 * shotService.ts
 *
 * 分镜（片段）数据层：读写 localStorage、拆分镜、提示词拼装、参考图匹配。
 *
 * 数据来源
 * ─────────────────────────────────────────────────────────────
 * 分镜状态由工作流「视频生成」页（ShotEditorPanel）写入 localStorage：
 *   key   = `shot-editor:<projectId>`
 *   value = { shots: Record<集号, ShotState[]>, history, videoIds, pendingVideoJobs }
 * 其中 ShotState = ShotItem + { videoUrl?, imageUrl? }，videoUrl 即该分镜的成片。
 *
 * 本文件把「读存储 / 拆分镜 / 拼提示词 / 匹配参考图」从 UI 中抽出来，
 * 供项目画布的分镜面板与一键成片复用，避免两处各写一套而漂移。
 */

import { AnalyzedEpisode, ShotDialogue, ShotItem, splitShots } from './scriptAnalysisService';
import {
    buildVideoPrompt,
    buildVideoPromptMultiline,
    resolveStyleByContentType,
    resolveFormByContentType,
} from './stylePresets';
import { persistShots, persistShotHistory } from './projectStateService';

// ============================================================================
// 类型
// ============================================================================

/** 单条分镜的完整状态（与 ShotEditorPanel 的 ShotState 对齐） */
export interface ShotState extends ShotItem {
    videoUrl?: string;
    imageUrl?: string;
}

/** localStorage 中整份分镜存储 */
export interface ShotStore {
    shots: Record<string, ShotState[]>;
    history?: Record<string, string[]>;
    videoIds?: Record<string, string>;
    pendingVideoJobs?: unknown[];
}

// ============================================================================
// 存储
// ============================================================================

export const shotStoreKey = (projectId: string) => `shot-editor:${projectId}`;

/** 读取项目的整份分镜存储；解析失败返回空骨架 */
export const loadShotStore = (projectId: string): ShotStore => {
    try {
        const raw = localStorage.getItem(shotStoreKey(projectId));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return { ...parsed, shots: parsed.shots || {} } as ShotStore;
            }
        }
    } catch {
        /* 解析失败按空处理 */
    }
    return { shots: {} };
};

/** 写回整份分镜存储 */
export const saveShotStore = (projectId: string, store: ShotStore) => {
    try {
        localStorage.setItem(shotStoreKey(projectId), JSON.stringify(store));
    } catch {
        /* 忽略写入失败（隐私模式 / 配额满） */
    }
};

/**
 * 取某一集的分镜列表（按 shotNumber 升序）。
 * 兼容 localStorage 里集号被存成字符串或数字两种情况。
 */
export const getEpisodeShots = (projectId: string, episode: number): ShotState[] => {
    const store = loadShotStore(projectId);
    const list = store.shots[String(episode)] || (store.shots as Record<number, ShotState[]>)[episode];
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => (a.shotNumber || 0) - (b.shotNumber || 0));
};

/**
 * 把某一集的分镜写回存储，保留其他集与历史记录不动。
 * localStorage 作为同步缓存，同时异步落库（数据库为准）。
 */
export const saveEpisodeShots = (projectId: string, episode: number, shots: ShotState[]) => {
    const store = loadShotStore(projectId);
    store.shots[String(episode)] = shots;
    saveShotStore(projectId, store);
    persistShots(projectId, episode, shots);
};

/**
 * 把画布上生成的成片回写到对应分镜。
 *
 * 分镜 → 画布生成的视频节点带有 shotEpisode / shotNumber 溯源字段，
 * 生成成功后调用本函数，分镜面板的「已生成」计数与成片预览才能同步更新。
 */
export const writeBackShotVideo = (
    projectId: string,
    episode: number,
    shotNumber: number,
    videoUrl: string
): void => {
    const shots = getEpisodeShots(projectId, episode);
    if (shots.length === 0) return;
    let changed = false;
    const next = shots.map((s) => {
        if (s.shotNumber !== shotNumber || s.videoUrl === videoUrl) return s;
        changed = true;
        return { ...s, videoUrl };
    });
    if (changed) {
        saveEpisodeShots(projectId, episode, next);
        persistShotHistory(projectId, episode, shotNumber, { videoUrl });
    }
};

// ============================================================================
// 拆分镜
// ============================================================================

/**
 * 从原文里按「角色：台词」抽台词，供本地兜底使用。
 *
 * 兜底分镜如果丢掉台词，成片就会变成没有对白的哑画面——
 * 而这恰恰是 AI 拆分镜失败时最容易发生的事，所以这里单独兜一层。
 */
/**
 * 场景标题行，兼容几种常见写法：
 * 「1-1，地点，日，内」「1.1 地点 日 内」「场景1：地点」「第1场 …」「INT. 地点 - 日」
 */
const SCENE_HEAD_LINE_RE =
    /^\s*(?:\d+\s*[-－—–.]\s*\d+|(?:场景|场次)\s*[\d一二三四五六七八九十百零]*|第\s*[\d一二三四五六七八九十百零]+\s*[场幕]|(?:INT|EXT)\s*[.．]?)/i;

const extractLocalDialogues = (text: string): ShotDialogue[] => {
    const out: ShotDialogue[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('△') || line.startsWith('出场人物')) continue;
        // 场次标题不是台词：1-1 / 场景1 / 第1场 / INT. 等写法都要识别
        if (SCENE_HEAD_LINE_RE.test(line)) continue;
        const m = line.match(/^([^：:（(]{1,12})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/);
        if (!m) continue;
        const hint = (m[2] || '').trim();
        const isOS = /^os$/i.test(hint);
        out.push({
            role: m[1].trim(),
            text: m[3].trim(),
            tone: isOS ? undefined : hint || undefined,
            isVoiceOver: isOS || undefined,
        });
    }
    return out;
};

// ============================================================================
// 片段编号与合并顺序
// ============================================================================

/**
 * 片段编号：`EP04-4-1-03`（集号 - 场号 - 片段号）。
 *
 * 只用 shotNumber 无法跨集、跨场景定位一个片段，核对生成出来的视频时
 * 对不上号；这个编号同时出现在分镜列表和画布节点标题上，便于一一对应。
 */
export const makeShotCode = (
    episode: number,
    sceneNumber: string | undefined,
    shotNumber: number
): string => {
    const ep = String(episode || 0).padStart(2, '0');
    const scene = String(sceneNumber || '未分场')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[\\/:*?"<>|，,]/g, '-');
    return `EP${ep}-${scene}-${String(shotNumber || 0).padStart(2, '0')}`;
};

/**
 * 合并顺序：先按场景在剧本里出现的先后，再按场景内的片段号。
 *
 * 不依赖数组顺序或用户点击顺序——分镜可能被重排、单独重生成，
 * 直接拿当前数组去合并很容易出序。
 */
export const orderShotsForMerge = (shots: ShotState[]): ShotState[] => {
    const sceneOrder = new Map<string, number>();
    for (const shot of shots) {
        const key = String(shot.sceneNumber || '').trim() || '未分场';
        if (!sceneOrder.has(key)) sceneOrder.set(key, sceneOrder.size);
    }
    return [...shots].sort((a, b) => {
        const ka = String(a.sceneNumber || '').trim() || '未分场';
        const kb = String(b.sceneNumber || '').trim() || '未分场';
        const ia = sceneOrder.get(ka) ?? 0;
        const ib = sceneOrder.get(kb) ?? 0;
        if (ia !== ib) return ia - ib;
        return (a.shotNumber || 0) - (b.shotNumber || 0);
    });
};

/**
 * 本地规则拆分镜：AI 拆分镜失败时兜底，保证界面始终有分镜可编辑。
 * 按目标时长反推镜头数（每个镜头默认 10 秒），再把句子尽量均分到各镜头；
 * 台词按原文顺序均分到各镜头，保证兜底结果也能配音、也能进视频提示词。
 */
export const localSplitShots = (ep: AnalyzedEpisode, targetSec?: number): ShotState[] => {
    const text = (ep.content || '').trim() || (ep.summary || '').trim();
    if (!text) return [];
    const sentences = text
        .split(/[。！？!?\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2);
    if (sentences.length === 0) return [];

    const targetCount = Math.max(4, Math.min(30, Math.ceil((targetSec || 90) / 10)));
    const perShot = Math.max(1, Math.ceil(sentences.length / targetCount));
    const shotCount = Math.min(targetCount, Math.ceil(sentences.length / perShot));

    const dialogues = extractLocalDialogues(text);
    /** 第 idx 个镜头应分到的台词：按原文顺序连续切片，不在镜头间跳序 */
    const dialoguesForShot = (idx: number): ShotDialogue[] => {
        if (dialogues.length === 0) return [];
        const start = Math.floor((idx * dialogues.length) / shotCount);
        const end = Math.floor(((idx + 1) * dialogues.length) / shotCount);
        return dialogues.slice(start, end);
    };

    const angles = ['全景', '中景', '近景', '特写'];
    const shots: ShotState[] = [];
    for (let i = 0; i < sentences.length && shots.length < targetCount; i += perShot) {
        const chunk = sentences.slice(i, i + perShot).join('。');
        const n = shots.length + 1;
        shots.push({
            shotNumber: n,
            description: chunk,
            cameraAngle: angles[n % angles.length],
            cameraMovement: n % 2 === 0 ? '固定' : '推',
            durationSeconds: 10,
            prompt: chunk,
            dialogues: dialoguesForShot(shots.length),
        });
    }
    return shots;
};

/**
 * 拆分某一集的分镜：优先调后端 AI，失败时回落本地规则。
 * 返回是否走了本地兜底，便于 UI 提示。
 */
export const splitEpisodeShots = async (params: {
    projectId: string;
    episode: AnalyzedEpisode;
    targetDuration?: number;
    style?: string;
    aspectRatio?: string;
}): Promise<{ shots: ShotState[]; localFallback: boolean; error?: string }> => {
    const { projectId, episode, targetDuration, style, aspectRatio } = params;
    const characters = (episode.assets?.characters || []).map((c) => c.name);

    try {
        const { shots } = await splitShots({
            episode: {
                episode: episode.episode,
                title: episode.title,
                summary: episode.summary,
                content: episode.content,
            },
            characters,
            style,
            aspectRatio,
            targetDuration,
        });
        if (!shots || shots.length === 0) throw new Error('AI 未返回分镜');
        const normalized = shots.map((s) => ({ ...s }));
        saveEpisodeShots(projectId, episode.episode, normalized);
        return { shots: normalized, localFallback: false };
    } catch (e: any) {
        const fallback = localSplitShots(episode, targetDuration);
        if (fallback.length > 0) {
            saveEpisodeShots(projectId, episode.episode, fallback);
            return { shots: fallback, localFallback: true };
        }
        return { shots: [], localFallback: false, error: e?.message || '拆分镜失败' };
    }
};

// ============================================================================
// 提示词
// ============================================================================

/** 把分镜的结构化字段拼成一段可读文本（不含风格修饰） */
export const composeShotPrompt = (shot: ShotState): string => {
    if (shot.prompt) return shot.prompt;
    return [
        shot.description,
        shot.cameraAngle && `景别：${shot.cameraAngle}`,
        shot.mood && `氛围：${shot.mood}`,
    ]
        .filter(Boolean)
        .join('，');
};

/**
 * 生视频提示词：补齐拆分镜阶段产生的结构化镜头信息，再交给提示词库补风格与禁止项。
 * 与 ShotEditorPanel.composeModelVideoPrompt 保持同一口径。
 */
/** 视频提示词里引用的参考图（顺序必须与实际传给模型的图片顺序一致） */
export interface VideoPromptRef {
    name: string;
    category: 'characters' | 'scenes' | 'props';
}

/**
 * 根据参考图 URL 反查资产名与类别。
 *
 * 生成页里参考图是用户可见、可增删的 URL 列表，提示词要写成「图1=老钱（角色）」，
 * 就必须把这些 URL 还原成资产。反查不到的（用户临时加的图）按顺序占位，
 * 保证编号与真正传给模型的图片顺序一致。
 */
export const describeRefsFromUrls = (
    urls: string[],
    episode: AnalyzedEpisode | undefined
): VideoPromptRef[] => {
    if (urls.length === 0) return [];
    const assets = episode?.assets;
    const out: VideoPromptRef[] = [];
    for (const url of urls) {
        let matched: VideoPromptRef | undefined;
        if (assets) {
            for (const category of ['characters', 'scenes', 'props'] as const) {
                const hit = (assets[category] || []).find(
                    (a) => a.imageUrl === url || (a.looks || []).some((l) => l.imageUrl === url)
                );
                if (hit) {
                    matched = { name: hit.name, category };
                    break;
                }
            }
        }
        out.push(matched || { name: `参考图${out.length + 1}`, category: 'characters' });
    }
    return out;
};

const REF_CATEGORY_LABEL: Record<VideoPromptRef['category'], string> = {
    characters: '角色',
    scenes: '场景',
    props: '道具',
};

/**
 * 台词段：一句一行，情绪写在括号里。
 *
 * 画面描述与台词必须分开写——混在一段里，模型会把台词当成旁白或忽略掉，
 * 也不会让人物做出口型。份数上限 3 句，再多会挤掉画面信息。
 */
export const composeDialogueBlock = (shot: ShotState, maxLines = 3): string[] => {
    const lines = (shot.dialogues || []).filter((d) => d.text).slice(0, maxLines);
    return lines.map((d, i) => {
        const tags = [d.role];
        if (d.tone) tags.push(d.tone);
        if (d.isVoiceOver) tags.push('画外音');
        return `台词${i + 1}（${tags.join('，')}）："${d.text}"`;
    });
};

/**
 * 组视频提示词：结构化多段式，而不是把关键词平铺成一段。
 *
 * 依据 Seedance 官方与社区实践，压住人物漂移的关键是三点：
 *   1. 人物长相不靠文字描述，靠参考图，并且每一镜都重新点名「图N=谁」；
 *   2. 文本只写变化量（表情、姿态、站位、动作），不写不变量（脸、发型、服装款式）；
 *   3. 结尾用「全片一致 + 负面清单」双向兜底。
 *
 * @param refs 本镜头匹配到的参考图，顺序即传给模型的图片顺序
 */
export const composeModelVideoPrompt = (
    shot: ShotState,
    style: string,
    form: string,
    refs: VideoPromptRef[] = []
): string => {
    const action = shot.prompt || composeShotPrompt(shot);
    const sceneTitle = [shot.location, shot.timeOfDay, shot.interiorExterior]
        .filter(Boolean)
        .join('，');

    const blocks: string[] = [];

    // 1. 参考图绑定：编号 + 名字 + 类别，让模型知道每张图控制什么
    if (refs.length > 0) {
        const list = refs
            .map((r, i) => `图${i + 1}=${r.name}（${REF_CATEGORY_LABEL[r.category]}）`)
            .join('、');
        blocks.push(
            `【参考图】按传入顺序：${list}。人物长相、发型与服装以角色图为准，环境与光线以场景图为准，道具外观以道具图为准`
        );
    }

    // 2. 场景
    if (sceneTitle) blocks.push(`【场景】${sceneTitle}`);

    // 3. 人物站位：优先用分镜里写好的调度，缺失时按出场角色兜底
    const blocking =
        shot.blocking ||
        (shot.characters && shot.characters.length > 0
            ? `${shot.characters.join('、')}位于画面中景，保持自然的交流姿态`
            : '');
    if (blocking) blocks.push(`【人物站位】${blocking}`);

    // 4. 动作
    if (action) blocks.push(`【动作】${action}`);

    // 5. 台词：独立成行，带情绪标签
    blocks.push(...composeDialogueBlock(shot));

    // 6. 镜头语言
    const camera = [
        shot.cameraAngle && `景别机位：${shot.cameraAngle}`,
        shot.cameraMovement && `运镜：${shot.cameraMovement}`,
        shot.lighting && `光线：${shot.lighting}`,
        shot.mood && `氛围：${shot.mood}`,
    ]
        .filter(Boolean)
        .join('；');
    if (camera) {
        blocks.push(`【镜头】${camera}。一个连贯镜头完成，动作时序连续，不跳切、不闪烁`);
    }

    // 7. 一致性兜底：只改变化量，锁死不变量（空镜没有人物，不需要这一段）
    const hasPeople =
        (shot.characters && shot.characters.length > 0) ||
        refs.some((r) => r.category === 'characters');
    if (hasPeople) {
        blocks.push(
            '【一致性】全片同一人物：脸部五官、年龄、发型发色、服装款式与颜色、体型均与角色图保持一致；本镜头只改变表情、姿态、位置与机位'
        );
    }

    // 8. 首帧不要照抄参考图
    if (refs.length > 0) {
        blocks.push('以参考图确定人物与环境，但画面从本镜头描述的动作开始，不要把参考图原样定格作为开头');
    }

    return buildVideoPromptMultiline(blocks.join('\n'), style, form);
};

/** 按项目内容类型推导默认风格与形象，供画布分镜面板使用 */
export const resolveShotStyle = (contentType?: string) => ({
    style: resolveStyleByContentType(contentType),
    form: resolveFormByContentType(contentType),
});

// ============================================================================
// 参考图匹配
// ============================================================================

/** 参考图命中结果：既返回 URL，也返回命中的资产名（便于在节点标题上展示） */
export interface MatchedRef {
    name: string;
    url: string;
    category: 'characters' | 'scenes' | 'props';
}

/** 参与参考图匹配的资产（只关心名字与可用图片） */
export interface RefAssetLike {
    name: string;
    /** 角色别名（台词的说话人可能写成别名，匹配角色时要认） */
    aliases?: string[];
    imageUrl?: string;
    looks?: { imageUrl?: string }[];
}

/**
 * 本集可用的参考图资产。
 * 优先传「资产确认」里已生成图片的数据（含 looks），
 * 否则剧本解析得到的资产通常只有名字、没有 imageUrl，会匹配不到任何参考图。
 */
export type RefAssets = Partial<Record<'characters' | 'scenes' | 'props', RefAssetLike[]>>;

/**
 * 根据分镜文本，匹配本集已生成的资产图作为视频参考。
 *
 * 规则：资产名（或其核心名）在分镜描述/提示词中出现即命中；
 * 命中资产优先取主图，主图缺失时取第一张造型图。
 * 顺序按 角色 → 场景 → 道具，并在各类内保持资产清单原序。
 *
 * @param assetsOverride 外部合并后的资产（含生成图），不传时回退 episode.assets
 */
export const matchRefsForShot = (
    shot: Pick<ShotState, 'description' | 'prompt' | 'characters' | 'location'> | undefined,
    episode: AnalyzedEpisode | undefined,
    assetsOverride?: RefAssets
): MatchedRef[] => {
    const assets = assetsOverride ?? episode?.assets;
    if (!shot || !assets) return [];

    const haystack = `${shot.description || ''} ${shot.prompt || ''}`.trim();

    /**
     * 分镜上结构化记录的出场角色。
     * 这是匹配角色最可靠的依据：分镜描述常写成「特写：指尖捏着一支笔」，
     * 压根不出现人名，只靠文本匹配就会漏掉角色，只连上道具图。
     */
    const castNames = new Set(
        (shot.characters || []).map((c) => String(c || '').trim()).filter(Boolean)
    );
    const location = String(shot.location || '').trim();

    /** 资产名是否出现在分镜文本里 */
    const inText = (rawName: string): boolean => {
        const name = (rawName || '').trim();
        if (!name || !haystack) return false;

        if (name.length === 1) {
            const idx = haystack.indexOf(name);
            if (idx === -1) return false;
            // 单字名极易误命中（「笔」会被「笔记本」「铅笔」命中），
            // 要求它独立成词或出现两次以上
            const prev = haystack[idx - 1] || '';
            const next = haystack[idx + 1] || '';
            const isolated = !/[\u4e00-\u9fa5]/.test(prev) && !/[\u4e00-\u9fa5]/.test(next);
            const times = haystack.split(name).length - 1;
            return isolated || times >= 2;
        }

        if (haystack.includes(name)) return true;
        // 处理「陈念念（童年）」「林秀峰·病弱」这类带备注的名字，取核心名再匹配
        const core = name.split(/[（(·\s]/)[0].trim();
        return core.length >= 2 && haystack.includes(core);
    };

    /** 角色：先认分镜的出场名单（含别名），再用文本兜底 */
    const hitCharacter = (asset: RefAssetLike): boolean => {
        const names = [asset.name, ...(asset.aliases || [])]
            .map((n) => String(n || '').trim())
            .filter(Boolean);
        if (names.some((n) => castNames.has(n))) return true;
        return inText(asset.name);
    };

    /** 场景：先用分镜的 location 字段对地点，再退回文本 */
    const hitScene = (asset: RefAssetLike): boolean => {
        const name = String(asset.name || '').trim();
        if (name && location && (location === name || location.includes(name) || name.includes(location))) {
            return true;
        }
        return inText(name);
    };

    const out: MatchedRef[] = [];
    const seen = new Set<string>();

    const push = (asset: RefAssetLike, category: 'characters' | 'scenes' | 'props') => {
        const url = asset.imageUrl || asset.looks?.[0]?.imageUrl;
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({ name: asset.name, url, category });
    };

    (assets.characters || []).forEach((asset) => {
        if (hitCharacter(asset)) push(asset, 'characters');
    });
    (assets.scenes || []).forEach((asset) => {
        if (hitScene(asset)) push(asset, 'scenes');
    });
    (assets.props || []).forEach((asset) => {
        if (inText(asset.name)) push(asset, 'props');
    });

    return out;
};
