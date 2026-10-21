/**
 * episodeStatus.ts
 *
 * 从真实数据源推导「每集状态」与「全项目统计」，供项目详情的
 * 概览 / 分集管理 / 项目资产 / 生成任务 / 版本记录 / 审核记录各标签共用。
 *
 * 之前各标签的统计（总集数 80、生产中 26、已审核 14、已完成 12、异常 3）
 * 以及分集表的「分镜 / 镜头视频 / 成片 / 当前阶段 / 审核状态」都是写死的演示值，
 * 与项目实际进度无关。本文件把它们统一到同一条推导链上，避免各标签各写一套而漂移。
 *
 * 数据来源（均按 projectId 隔离，只读）：
 *  1. project.scriptAnalysis.episodes  —— 分集与资产解析结果（后端）
 *  2. localStorage['asset-confirm:<id>'] —— 资产确认结果（含生成图 / 造型图）
 *  3. localStorage['shot-editor:<id>']   —— 分镜、镜头视频与进行中的视频任务
 *  4. localStorage['scene-merge:<id>']   —— 场景级成片
 */

import type { AnalyzedEpisode } from './scriptAnalysisService';
import { loadAssetStore } from '../components/AssetConfirmPanel';
import { loadShotStore } from './shotService';
import { loadSceneMerges, groupShotsByScene, getSceneMerge } from './sceneMergeService';

// ============================================================================
// 类型
// ============================================================================

export type EpisodeStageKey =
    | 'pendingInit'
    | 'analyzed'
    | 'assetConfirm'
    | 'storyboardReview'
    | 'shotGenerating'
    | 'finalReview'
    | 'done';

export type BadgeTone = 'gray' | 'yellow' | 'green' | 'blue' | 'purple' | 'orange' | 'cyan';

export interface EpisodeStatus {
    episode: number;
    /** 两位集号，如 '01' */
    id: string;
    title: string;
    wordCount: number;
    durationSeconds: number;

    /** 引用资产：角色 / 场景 / 道具数量 */
    assetCounts: { characters: number; scenes: number; props: number };
    assetTotal: number;
    /** 已有设定图的资产数（主图或任一造型图） */
    assetGenerated: number;
    /** 该集资产是否全部已有设定图 */
    assetsConfirmed: boolean;

    /** 分镜总数与已生成视频数 */
    shotTotal: number;
    shotVideoDone: number;
    /** 正在生成视频的分镜数 */
    shotsGenerating: number;
    /** 超过超时阈值仍未完成的视频任务数 */
    abnormal: number;

    /** 场景成片：已合成的场景数 / 场景总数 */
    sceneTotal: number;
    sceneMerged: number;

    /** 该集是否已合成整集成片（所有场景成片就绪） */
    finalDone: boolean;

    stageKey: EpisodeStageKey;
    stage: string;
    stageTone: BadgeTone;

    review: string;
    reviewTone: BadgeTone;

    /** 成片状态文案与色调 */
    final: string;
    finalTone: BadgeTone;

    /** 0-100 制作进度 */
    progress: number;
    /** 最近更新时间戳（取最近一条视频任务的开始时间；无则 null） */
    updatedAt: number | null;
}

export interface ProjectStats {
    total: number;
    /** 生产中：资产确认 / 分镜审核 / 镜头生成中 */
    inProduction: number;
    /** 待审核：待确认 / 待审核 / 待成片审核 */
    pendingReview: number;
    /** 已完成 */
    done: number;
    /** 异常镜头总数 */
    abnormal: number;
    /** 资产：总数 / 已生成图 */
    assetTotal: number;
    assetGenerated: number;
    /** 分镜：总数 / 已生成视频 */
    shotTotal: number;
    shotVideoDone: number;
    /** 整体进度百分比（按各集进度平均） */
    progressPercent: number;
    /** 已完成的集数 */
    doneEpisodes: number;
    /** 已完成资产确认的集数 */
    assetDoneEpisodes: number;
    /** 已完成全部镜头视频的集数 */
    videoDoneEpisodes: number;
    /** 正在生成视频的集数 */
    runningEpisodes: number;
    /** 待人工确认的片段数（已拆分、尚未出视频） */
    pendingConfirmShots: number;
}

/** 视频任务超过该时长仍未完成，视为异常（与 projectProgress 保持一致） */
const ABNORMAL_TIMEOUT_MS = 15 * 60 * 1000;

// ============================================================================
// 阶段文案
// ============================================================================

export const STAGE_LABEL: Record<EpisodeStageKey, string> = {
    pendingInit: '待初始化',
    analyzed: '单集分析完成',
    assetConfirm: '资产确认',
    storyboardReview: '分镜审核',
    shotGenerating: '镜头生成中',
    finalReview: '成片审核',
    done: '已完成',
};

export const STAGE_TONE: Record<EpisodeStageKey, BadgeTone> = {
    pendingInit: 'gray',
    analyzed: 'blue',
    assetConfirm: 'cyan',
    storyboardReview: 'orange',
    shotGenerating: 'blue',
    finalReview: 'purple',
    done: 'green',
};

/** 阶段推进顺序，用于「生产总览」的流程条 */
export const STAGE_ORDER: EpisodeStageKey[] = [
    'pendingInit',
    'analyzed',
    'assetConfirm',
    'storyboardReview',
    'shotGenerating',
    'finalReview',
    'done',
];

// ============================================================================
// 推导
// ============================================================================

export interface DeriveOptions {
    projectId: string;
    episodes: AnalyzedEpisode[];
    /**
     * 项目记录上的最近更新时间（字符串）。
     * 本地资产表 / 分镜表都没有写时间戳，当某集既没有进行中的任务、
     * 也没有任何本地改动时，用它兜底「最近更新」列，避免整列都是 —。
     */
    fallbackUpdatedAt?: string;
}

/** 把 'YYYY-MM-DD HH:mm' / ISO 字符串解析为毫秒时间戳，失败返回 null */
const parseTime = (value?: string): number | null => {
    if (!value) return null;
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const ts = new Date(normalized).getTime();
    return Number.isFinite(ts) ? ts : null;
};

/**
 * 逐集推导制作状态。
 *
 * 判定口径（严格按生产流程由前到后，命中即停）：
 *  1. 无解析内容也无资产  → 待初始化
 *  2. 有解析结果，但没有资产确认记录 → 单集分析完成
 *  3. 有资产确认记录，但该集资产未全部出图 → 资产确认
 *  4. 资产齐了但还没拆分镜 → 分镜审核（等待拆分 / 审核）
 *  5. 已拆分镜、尚无任何镜头视频 → 分镜审核（视频未开始）
 *  6. 部分镜头出视频或任务在跑 → 镜头生成中
 *  7. 全部镜头出视频、但整集未合成 → 成片审核
 *  8. 整集已合成 → 已完成
 *
 * 审核状态由阶段确定性映射（当前没有独立审核后端，避免编造审核结果）：
 *  完成 → 全部通过；成片审核 → 待成片审核；镜头生成中 → 分镜已通过；
 *  分镜审核 → 待审核；资产确认 → 待确认；其余 → 未提交；有异常 → 有修改意见。
 */
export const deriveEpisodeStatuses = ({ projectId, episodes, fallbackUpdatedAt }: DeriveOptions): EpisodeStatus[] => {
    if (episodes.length === 0) return [];

    const assetStore = loadAssetStore(projectId) || {};
    const shotStore = loadShotStore(projectId);
    const sceneMerges = loadSceneMerges(projectId);
    const jobs = (shotStore.pendingVideoJobs || []) as {
        episode?: number;
        startedAt?: number;
    }[];
    const now = Date.now();
    /** 项目级兜底时间戳：本地没有更细的时间信息时用它 */
    const projectUpdatedAt = parseTime(fallbackUpdatedAt);

    return episodes.map((ep) => {
        const epKey = String(ep.episode);
        const wordCount = ep.wordCount || 0;
        const durationSeconds = Math.max(0, Math.round(ep.durationSeconds || 0));

        // ---- 资产 ----
        const catMap = assetStore[epKey] || {};
        const srcAssets = ep.assets || { characters: [], scenes: [], props: [] };
        const countOf = (k: 'characters' | 'scenes' | 'props') => {
            // 优先用本地资产确认表（可能用户新增 / 删除了资产），否则退回剧本解析结果
            const local = (catMap as Record<string, unknown[]>)[k];
            if (Array.isArray(local) && local.length > 0) return local.length;
            return srcAssets?.[k]?.length ?? 0;
        };
        const assetCounts = {
            characters: countOf('characters'),
            scenes: countOf('scenes'),
            props: countOf('props'),
        };
        const assetTotal = assetCounts.characters + assetCounts.scenes + assetCounts.props;

        const hasImage = (item: { imageUrl?: string; looks?: { imageUrl?: string }[] }) =>
            !!item.imageUrl || !!item.looks?.some((l) => !!l.imageUrl);

        // 已出图资产数：以本地资产确认表为准（脚本解析结果本身不带图）
        let assetGenerated = 0;
        let localAssetCount = 0;
        for (const key of ['characters', 'scenes', 'props'] as const) {
            const list = (catMap as Record<string, { imageUrl?: string; looks?: { imageUrl?: string }[] }[]>)[key] || [];
            localAssetCount += list.length;
            assetGenerated += list.filter(hasImage).length;
        }
        // 该集在本地资产表里有记录、且全部出图，才算「资产确认完成」
        const assetsConfirmed = localAssetCount > 0 && assetGenerated >= localAssetCount;

        // ---- 分镜 / 镜头视频 ----
        const shots = shotStore.shots[epKey] || [];
        const shotTotal = shots.length;
        const shotVideoDone = shots.filter((s) => !!s.videoUrl).length;

        const epJobs = jobs.filter((j) => Number(j.episode) === ep.episode);
        const shotsGenerating = epJobs.length;
        const abnormal = epJobs.filter((j) => now - (j.startedAt || 0) > ABNORMAL_TIMEOUT_MS).length;
        const latestJobAt = epJobs.reduce(
            (max, j) => Math.max(max, Number(j.startedAt) || 0),
            0
        );

        // ---- 场景成片 / 整集成片 ----
        const sceneGroups = shotTotal > 0 ? groupShotsByScene(shots) : [];
        const sceneTotal = sceneGroups.length;
        // 用 getSceneMerge 判定：片段有增删或重新生成后场景成片即失效，
        // 只看记录是否存在会把「重生成过」的集误判为已完成。
        const sceneMerged = sceneGroups.filter(
            (g) => !!getSceneMerge(sceneMerges, ep.episode, g)
        ).length;
        const finalDone = sceneTotal > 0 && sceneMerged >= sceneTotal;

        // ---- 阶段判定 ----
        const hasParsed = wordCount > 0 || !!ep.content || assetTotal > 0;
        let stageKey: EpisodeStageKey;
        if (!hasParsed && localAssetCount === 0) {
            stageKey = 'pendingInit';
        } else if (localAssetCount === 0) {
            stageKey = 'analyzed';
        } else if (!assetsConfirmed) {
            stageKey = 'assetConfirm';
        } else if (shotTotal === 0) {
            stageKey = 'storyboardReview';
        } else if (shotVideoDone === 0 && shotsGenerating === 0) {
            stageKey = 'storyboardReview';
        } else if (shotVideoDone < shotTotal) {
            stageKey = 'shotGenerating';
        } else if (!finalDone) {
            stageKey = 'finalReview';
        } else {
            stageKey = 'done';
        }

        // ---- 审核状态 ----
        let review: string;
        let reviewTone: BadgeTone;
        if (abnormal > 0) {
            review = '有修改意见';
            reviewTone = 'orange';
        } else if (stageKey === 'done') {
            review = '全部通过';
            reviewTone = 'green';
        } else if (stageKey === 'finalReview') {
            review = '待成片审核';
            reviewTone = 'yellow';
        } else if (stageKey === 'shotGenerating') {
            review = '分镜已通过';
            reviewTone = 'green';
        } else if (stageKey === 'storyboardReview') {
            review = '待审核';
            reviewTone = 'yellow';
        } else if (stageKey === 'assetConfirm') {
            review = '待确认';
            reviewTone = 'yellow';
        } else {
            review = '未提交';
            reviewTone = 'gray';
        }

        // ---- 成片状态 ----
        let final: string;
        let finalTone: BadgeTone;
        if (finalDone) {
            final = '已完成';
            finalTone = 'green';
        } else if (stageKey === 'finalReview') {
            final = '待审核';
            finalTone = 'yellow';
        } else if (shotVideoDone > 0) {
            final = '待生成';
            finalTone = 'gray';
        } else {
            final = '未开始';
            finalTone = 'gray';
        }

        // ---- 进度：资产 30% + 分镜 20% + 镜头视频 40% + 成片 10% ----
        const assetPart = localAssetCount > 0 ? Math.min(1, assetGenerated / localAssetCount) : 0;
        const shotPart = shotTotal > 0 ? 1 : 0;
        const videoPart = shotTotal > 0 ? shotVideoDone / shotTotal : 0;
        const finalPart = finalDone ? 1 : sceneTotal > 0 ? sceneMerged / sceneTotal : 0;
        const progress = Math.round(assetPart * 30 + shotPart * 20 + videoPart * 40 + finalPart * 10);

        return {
            episode: ep.episode,
            id: String(ep.episode).padStart(2, '0'),
            title: ep.title || `第 ${ep.episode} 集`,
            wordCount,
            durationSeconds,
            assetCounts,
            assetTotal,
            assetGenerated,
            assetsConfirmed,
            shotTotal,
            shotVideoDone,
            shotsGenerating,
            abnormal,
            sceneTotal,
            sceneMerged,
            finalDone,
            stageKey,
            stage: STAGE_LABEL[stageKey],
            stageTone: STAGE_TONE[stageKey],
            review,
            reviewTone,
            final,
            finalTone,
            progress: Math.max(0, Math.min(100, progress)),
            /**
             * 最近更新时间：优先取进行中的视频任务启动时间，
             * 其次退回项目记录上的最近更新时间，全都没有才返回 null（表格显示 —）。
             * 之前只取任务时间，导致没有在跑任务的集「最近更新」永远是 —。
             */
            updatedAt: latestJobAt || projectUpdatedAt || null,
        };
    });
};

/** 汇总全项目统计：直接由逐集状态相加，保证与分集表逐行一致 */
export const deriveProjectStats = (statuses: EpisodeStatus[]): ProjectStats => {
    const total = statuses.length;
    const sum = (pick: (s: EpisodeStatus) => number) => statuses.reduce((n, s) => n + pick(s), 0);

    const inProduction = statuses.filter((s) =>
        s.stageKey === 'assetConfirm' || s.stageKey === 'storyboardReview' || s.stageKey === 'shotGenerating'
    ).length;
    const pendingReview = statuses.filter((s) =>
        s.review === '待确认' || s.review === '待审核' || s.review === '待成片审核'
    ).length;
    const done = statuses.filter((s) => s.stageKey === 'done').length;
    const abnormal = sum((s) => s.abnormal);

    const assetTotal = sum((s) => s.assetTotal);
    const assetGenerated = sum((s) => s.assetGenerated);
    const shotTotal = sum((s) => s.shotTotal);
    const shotVideoDone = sum((s) => s.shotVideoDone);

    const progressPercent = total > 0
        ? Math.round(statuses.reduce((n, s) => n + s.progress, 0) / total)
        : 0;

    return {
        total,
        inProduction,
        pendingReview,
        done,
        abnormal,
        assetTotal,
        assetGenerated,
        shotTotal,
        shotVideoDone,
        progressPercent,
        doneEpisodes: done,
        assetDoneEpisodes: statuses.filter((s) => s.assetsConfirmed).length,
        videoDoneEpisodes: statuses.filter((s) => s.shotTotal > 0 && s.shotVideoDone >= s.shotTotal).length,
        runningEpisodes: statuses.filter((s) => s.shotsGenerating > 0).length,
        pendingConfirmShots: statuses.filter((s) => s.shotTotal > 0).reduce((n, s) => n + (s.shotTotal - s.shotVideoDone), 0),
    };
};

/** 分秒格式化，如 92 → '01:32' */
export const formatDuration = (seconds: number): string => {
    const sec = Math.max(0, Math.round(seconds || 0));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
};

/** 相对时间：用于「最近更新」列 */
export const formatRelativeTime = (ts: number | null): string => {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
    const d = new Date(ts);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
