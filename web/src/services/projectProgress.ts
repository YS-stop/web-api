/**
 * projectProgress.ts
 *
 * 首页项目进度的动态计算：从本地缓存的「资产确认」「分镜 / 视频」数据推导，
 * 不依赖后端写死的 stage / doneEpisodes / abnormal 字段。
 *
 * 数据来源（均按 projectId 隔离）：
 *  - localStorage['asset-confirm:<projectId>']  资产确认结果（含生成图 / 造型图）
 *  - localStorage['shot-editor:<projectId>']     分镜与视频生成结果 + 进行中的任务
 */

export interface ProjectProgress {
    /** 是否已开始制作（存在资产确认或分镜数据） */
    started: boolean;
    /** 推导出的当前生产阶段 */
    stage: string;
    /** 推导出的项目状态 */
    status: '待启动' | '制作中' | '审核中' | '已完成';
    /** 已完成集数（该集分镜全部生成视频） */
    doneEpisodes: number;
    totalEpisodes: number;
    /** 资产已全部生成图的集数 */
    assetDoneEpisodes: number;
    /** 视频已全部生成的集数 */
    videoDoneEpisodes: number;
    /** 正在生成视频的集数 */
    runningEpisodes: number;
    /** 待人工确认：分镜已拆分、视频尚未生成的片段数 */
    pendingConfirm: number;
    /** 异常：超时仍未完成的视频任务数 */
    abnormal: number;
}

interface AssetLike {
    imageUrl?: string;
    looks?: { imageUrl?: string }[];
}

type AssetCategoryMap = {
    characters?: AssetLike[];
    scenes?: AssetLike[];
    props?: AssetLike[];
};

type AssetStore = Record<string, AssetCategoryMap>;

interface ShotLike {
    videoUrl?: string;
    imageUrl?: string;
}

type ShotStore = {
    shots?: Record<string, ShotLike[]>;
    pendingVideoJobs?: { episode: number; startedAt?: number }[];
};

const readJson = <T>(key: string): T | null => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
};

const hasImage = (item: AssetLike): boolean =>
    !!item.imageUrl || !!item.looks?.some((l) => !!l.imageUrl);

/** 视频任务超过该时长仍未完成，视为异常 */
const ABNORMAL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 计算某个项目的动态进度。
 * 判定口径：
 *  - 资产「完成一集」= 该集人物 / 场景 / 道具全部已有生成图；
 *  - 视频「完成一集」= 该集所有片段都已有 videoUrl；
 *  - 项目「完成」= 视频完成集数达到总集数。
 */
export const computeProjectProgress = (projectId: string, totalEpisodes: number): ProjectProgress => {
    const assetStore = readJson<AssetStore>(`asset-confirm:${projectId}`);
    const shotStore = readJson<ShotStore>(`shot-editor:${projectId}`);

    // ---- 资产：该集全部资产都有生成图才算完成 ----
    let assetDoneEpisodes = 0;
    let hasAssetData = false;
    if (assetStore) {
        for (const epKey of Object.keys(assetStore)) {
            const cats = assetStore[epKey] || {};
            const all = [
                ...(cats.characters || []),
                ...(cats.scenes || []),
                ...(cats.props || []),
            ];
            if (all.length === 0) continue;
            hasAssetData = true;
            if (all.every(hasImage)) assetDoneEpisodes += 1;
        }
    }

    // ---- 分镜 / 视频：该集所有片段都有 videoUrl 才算完成 ----
    let videoDoneEpisodes = 0;
    let pendingConfirm = 0;
    let hasShotData = false;
    const shots = shotStore?.shots || {};
    for (const epKey of Object.keys(shots)) {
        const list = shots[epKey] || [];
        if (list.length === 0) continue;
        hasShotData = true;
        const pending = list.filter((s) => !s.videoUrl).length;
        pendingConfirm += pending;
        if (pending === 0) videoDoneEpisodes += 1;
    }

    // ---- 运行中 / 异常 ----
    const jobs = shotStore?.pendingVideoJobs || [];
    const runningEpisodes = new Set(jobs.map((j) => j.episode)).size;
    const now = Date.now();
    const abnormal = jobs.filter((j) => now - (j.startedAt || 0) > ABNORMAL_TIMEOUT_MS).length;

    // ---- 阶段 / 状态推导 ----
    const total = Math.max(0, Number(totalEpisodes) || 0);
    // 点过「开始」（进入过工作流）也视为已开始，保证「开始」只出现一次
    const startedFlag = (() => {
        try {
            return localStorage.getItem(`project-started:${projectId}`) === '1';
        } catch {
            return false;
        }
    })();
    const started = hasAssetData || hasShotData || startedFlag;
    let stage = '等待确认拆集';
    let status: ProjectProgress['status'] = '待启动';

    if (started) {
        if (!hasShotData) {
            // 尚未拆分镜：有资产数据则处于资产确认，否则仍是拆集确认阶段
            stage = hasAssetData ? '资产确认' : '等待确认拆集';
            status = assetDoneEpisodes > 0 ? '审核中' : '制作中';
        } else if (total > 0 && videoDoneEpisodes >= total) {
            stage = '已完成';
            status = '已完成';
        } else {
            stage = '视频生成';
            status = '制作中';
        }
    }

    return {
        started,
        stage,
        status,
        doneEpisodes: total > 0 ? Math.min(videoDoneEpisodes, total) : videoDoneEpisodes,
        totalEpisodes: total,
        assetDoneEpisodes,
        videoDoneEpisodes,
        runningEpisodes,
        pendingConfirm,
        abnormal,
    };
};
