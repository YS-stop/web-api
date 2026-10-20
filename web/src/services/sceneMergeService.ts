/**
 * sceneMergeService.ts
 *
 * 「场景级成片」：先把一个场景内的片段拼成场景视频，再由场景视频拼整集。
 *
 * 为什么单独一层：
 *   剧本本身就是「集 → 场景(1-1/1-2) → 片段」三层结构。按场景先合成，
 *   改某一场景的片段时只需重合成这一个场景，整集再拼一次即可，
 *   也让「这个场景单独导出」成为可能。
 *
 * 过期判断：
 *   场景成片记录合成时用到的片段地址，片段一重新生成，
 *   场景成片就与当前片段对不上，自动判定过期，避免拿旧场景片拼整集。
 */

import { mergeVideos, type AudioMode } from './mergeService';
import type { ShotState } from './shotService';

// ============================================================================
// 类型
// ============================================================================

/** 一个场景及其片段 */
export interface SceneGroup {
    /** 分组键：场号，无场号时为「未分场」 */
    key: string;
    sceneNumber: string;
    location: string;
    timeOfDay: string;
    interiorExterior: string;
    /** 场景内片段，按 shotNumber 升序 */
    shots: ShotState[];
    /** 场景内片段是否都已生成视频 */
    ready: boolean;
}

/** 一条场景成片记录 */
export interface SceneMergeRecord {
    url: string;
    /** 合成时用到的片段视频地址：与当前片段不一致即视为过期 */
    sources: string[];
}

/** 按集号、场号存储的场景成片 */
export type SceneMergeStore = Record<string, Record<string, SceneMergeRecord>>;

// ============================================================================
// 分组
// ============================================================================

/** 把一集的片段按场号分组，保持剧本顺序 */
export const groupShotsByScene = (shots: ShotState[]): SceneGroup[] => {
    const map = new Map<string, SceneGroup>();
    for (const shot of shots) {
        const sceneNumber = String(shot.sceneNumber || '').trim() || '未分场';
        let group = map.get(sceneNumber);
        if (!group) {
            group = {
                key: sceneNumber,
                sceneNumber,
                location: shot.location || '',
                timeOfDay: shot.timeOfDay || '',
                interiorExterior: shot.interiorExterior || '',
                shots: [],
                ready: false,
            };
            map.set(sceneNumber, group);
        }
        group.shots.push(shot);
    }
    const groups = Array.from(map.values());
    for (const group of groups) {
        group.shots.sort((a, b) => (a.shotNumber || 0) - (b.shotNumber || 0));
        group.ready = group.shots.length > 0 && group.shots.every((s) => !!s.videoUrl);
        // 场次信息以该场第一个片段为准（同场片段应当一致）
        const first = group.shots[0];
        group.location = group.location || first?.location || '';
        group.timeOfDay = group.timeOfDay || first?.timeOfDay || '';
        group.interiorExterior = group.interiorExterior || first?.interiorExterior || '';
    }
    return groups;
};

/** 场景标题，如「1-2 杨柳村·德贵叔家院子（日·外）」 */
export const sceneLabel = (group: SceneGroup): string => {
    const parts = [group.sceneNumber];
    if (group.location) parts.push(group.location);
    const when = `${group.timeOfDay || ''}${group.interiorExterior ? `·${group.interiorExterior}` : ''}`;
    if (when.trim() && when !== '·') parts.push(`（${when}）`);
    return parts.filter(Boolean).join(' ');
};

// ============================================================================
// 存储
// ============================================================================

const storeKey = (projectId: string) => `scene-merge:${projectId}`;

export const loadSceneMerges = (projectId: string): SceneMergeStore => {
    if (!projectId) return {};
    try {
        const raw = localStorage.getItem(storeKey(projectId));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as SceneMergeStore) : {};
    } catch {
        return {};
    }
};

const saveSceneMerges = (projectId: string, store: SceneMergeStore) => {
    if (!projectId) return;
    try {
        localStorage.setItem(storeKey(projectId), JSON.stringify(store));
    } catch {
        /* 配额满或隐私模式：忽略 */
    }
};

/** 取某集某场的场景成片；过期时返回 null */
export const getSceneMerge = (
    store: SceneMergeStore,
    episode: number,
    group: SceneGroup
): SceneMergeRecord | null => {
    const record = store[String(episode)]?.[group.sceneNumber];
    if (!record?.url) return null;
    const current = group.shots.map((s) => s.videoUrl || '').filter(Boolean);
    // 片段有增删或重新生成，场景成片即失效
    if (record.sources.length !== current.length) return null;
    if (record.sources.some((src, i) => src !== current[i])) return null;
    return record;
};

export const setSceneMerge = (
    projectId: string,
    episode: number,
    group: SceneGroup,
    url: string
): SceneMergeStore => {
    const store = loadSceneMerges(projectId);
    const epKey = String(episode);
    store[epKey] = store[epKey] || {};
    store[epKey][group.sceneNumber] = {
        url,
        sources: group.shots.map((s) => s.videoUrl || '').filter(Boolean),
    };
    saveSceneMerges(projectId, store);
    return store;
};

export const clearSceneMerge = (projectId: string, episode: number, sceneNumber: string): SceneMergeStore => {
    const store = loadSceneMerges(projectId);
    const epKey = String(episode);
    if (store[epKey]) {
        delete store[epKey][sceneNumber];
        saveSceneMerges(projectId, store);
    }
    return store;
};

// ============================================================================
// 合成
// ============================================================================

/** 场景内片段统一硬切：同一场景的连续动作不需要转场 */
const SCENE_TRANSITION = 'none';
const SCENE_TRANSITION_DURATION = 0.3;

/**
 * 合成单个场景。
 *
 * @throws Error 场景内片段还没全部生成时抛出
 */
export const mergeScene = async (params: {
    projectId: string;
    episode: number;
    group: SceneGroup;
}): Promise<{ url: string; store: SceneMergeStore }> => {
    const { projectId, episode, group } = params;
    const videos = group.shots.map((s) => s.videoUrl).filter((u): u is string => !!u);
    if (videos.length === 0) throw new Error('该场景还没有已生成的片段视频');
    if (videos.length < group.shots.length) {
        throw new Error(`该场景还有 ${group.shots.length - videos.length} 个片段未生成视频`);
    }

    // 只有一个片段时无需拼接，直接以片段本身作为场景成片
    if (videos.length === 1) {
        const store = setSceneMerge(projectId, episode, group, videos[0]);
        return { url: videos[0], store };
    }

    const result = await mergeVideos({
        videos,
        transition: SCENE_TRANSITION,
        transitionDuration: SCENE_TRANSITION_DURATION,
        audioMode: 'keep',
        episode,
        prompt: `场景 ${sceneLabel(group)}`,
    });

    const store = setSceneMerge(projectId, episode, group, result.url);
    return { url: result.url, store };
};

/**
 * 收集用于整集成片的视频序列。
 *
 * 每个场景优先用场景成片；未合成或已过期的场景，回落到其内部片段。
 * 这样「只合成了部分场景」也能出整集，不会因为一个场景没合成而整集不能用。
 */
export const collectEpisodeVideos = (
    store: SceneMergeStore,
    episode: number,
    groups: SceneGroup[]
): { videos: string[]; sceneCount: number; fallbackShotCount: number; complete: boolean } => {
    const videos: string[] = [];
    let sceneCount = 0;
    let fallbackShotCount = 0;

    for (const group of groups) {
        const record = getSceneMerge(store, episode, group);
        if (record) {
            videos.push(record.url);
            sceneCount += 1;
            continue;
        }
        const clips = group.shots.map((s) => s.videoUrl).filter((u): u is string => !!u);
        videos.push(...clips);
        fallbackShotCount += clips.length;
    }

    return {
        videos,
        sceneCount,
        fallbackShotCount,
        complete: groups.length > 0 && sceneCount === groups.length,
    };
};

/** 一次把所有就绪场景合成（用于「全部场景成片」按钮） */
export const mergeAllScenes = async (params: {
    projectId: string;
    episode: number;
    groups: SceneGroup[];
    onProgress?: (done: number, total: number, label: string) => void;
}): Promise<{ store: SceneMergeStore; done: number; failed: Array<{ scene: string; error: string }> }> => {
    const { projectId, episode, groups, onProgress } = params;
    const targets = groups.filter((g) => g.ready);
    const failed: Array<{ scene: string; error: string }> = [];
    let store = loadSceneMerges(projectId);
    let done = 0;

    for (const group of targets) {
        try {
            const result = await mergeScene({ projectId, episode, group });
            store = result.store;
            done += 1;
            onProgress?.(done, targets.length, sceneLabel(group));
        } catch (e: any) {
            failed.push({ scene: sceneLabel(group), error: e?.message || '合成失败' });
            onProgress?.(done, targets.length, sceneLabel(group));
        }
    }

    return { store, done, failed };
};

/** 整集音轨合成时可选：用场景成片再拼一遍 */
export const mergeEpisodeFromScenes = async (params: {
    projectId: string;
    episode: number;
    groups: SceneGroup[];
    transition: string;
    transitionDuration: number;
    audioMode: AudioMode;
    audioUrl?: string;
}): Promise<{ url: string; source: string }> => {
    const store = loadSceneMerges(params.projectId);
    const { videos, complete } = collectEpisodeVideos(store, params.episode, params.groups);
    if (videos.length === 0) throw new Error('该集还没有可用的片段视频');

    if (videos.length === 1) return { url: videos[0], source: complete ? 'scene' : 'shot' };

    const result = await mergeVideos({
        videos,
        transition: params.transition,
        transitionDuration: params.transitionDuration,
        audioMode: params.audioMode,
        audioUrl: params.audioUrl,
        episode: params.episode,
        prompt: `第 ${params.episode} 集（按场景合成）`,
    });
    return { url: result.url, source: complete ? 'scene' : 'shot' };
};
