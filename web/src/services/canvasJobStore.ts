/**
 * canvasJobStore.ts
 *
 * 画布视频生成任务台账（localStorage）。
 *
 * 解决的问题
 * ─────────────────────────────────────────────────────────────
 * 视频生成请求是「一个长连接」：用户点击生成后离开画布（切页面 / 刷新 / 关标签），
 * 前端组件卸载后拿不到返回值，节点状态与结果就丢了，只能重新生成。
 * 后端其实仍在继续生成并把产物落盘（`/library/videos/<nodeId>.json`），
 * 因此这里在发起生成时记一笔台账，回到画布后用 `/api/generation-status/:nodeId`
 * 轮询把结果认领回来，避免重复消耗额度。
 */

import { persistJob, removePersistedJob } from './projectStateService';

export interface CanvasJob {
    /** 发起生成的节点 id（后端以它为产物文件名） */
    nodeId: string;
    /** 所属集号 */
    episode: number;
    /** 发起时间戳 */
    startedAt: number;
    /** 服务端异步任务 id（Seedance 专用，用于快速查询成功/失败） */
    taskId?: string;
    /** 视频模型（仅用于展示/排查） */
    model?: string;
    /** 提示词摘要（仅用于展示/排查） */
    prompt?: string;
}

/** 超过该时长仍未完成的任务视为过期（后端 Seedance 最长等待 10 分钟） */
const MAX_JOB_AGE = 30 * 60 * 1000;

const storeKey = (projectId: string) => `canvas-jobs:${projectId}`;

const readAll = (projectId: string): CanvasJob[] => {
    try {
        const raw = localStorage.getItem(storeKey(projectId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const writeAll = (projectId: string, jobs: CanvasJob[]) => {
    try {
        localStorage.setItem(storeKey(projectId), JSON.stringify(jobs));
    } catch {
        /* 隐私模式 / 配额满时忽略 */
    }
};

/** 读取未完成任务（自动清理过期项） */
export const loadCanvasJobs = (projectId: string): CanvasJob[] => {
    const now = Date.now();
    const alive = readAll(projectId).filter(
        (job) => job && job.nodeId && now - (job.startedAt || 0) < MAX_JOB_AGE
    );
    return alive;
};

/** 取某一集的任务 */
export const getEpisodeCanvasJobs = (projectId: string, episode: number): CanvasJob[] =>
    loadCanvasJobs(projectId).filter((job) => Number(job.episode) === Number(episode));

/** 记录一个刚开始的视频生成任务 */
export const addCanvasJob = (projectId: string, job: CanvasJob) => {
    const jobs = loadCanvasJobs(projectId).filter((j) => j.nodeId !== job.nodeId);
    jobs.push(job);
    writeAll(projectId, jobs);
    persistJob(projectId, {
        id: job.nodeId,
        kind: 'canvas-video',
        episode: job.episode,
        status: 'running',
        payload: job as unknown as Record<string, unknown>,
        startedAt: job.startedAt,
    });
};

/** 更新任务信息（例如提交后补上服务端 taskId） */
export const updateCanvasJob = (projectId: string, nodeId: string, patch: Partial<CanvasJob>) => {
    const jobs = loadCanvasJobs(projectId).map((j) => (j.nodeId === nodeId ? { ...j, ...patch } : j));
    writeAll(projectId, jobs);
    const updated = jobs.find((j) => j.nodeId === nodeId);
    if (updated) {
        persistJob(projectId, {
            id: updated.nodeId,
            kind: 'canvas-video',
            episode: updated.episode,
            status: 'running',
            payload: updated as unknown as Record<string, unknown>,
            startedAt: updated.startedAt,
        });
    }
};

/**
 * 任务结束：把终态写进后端台账，再从本地「待认领」队列移除。
 *
 * 之前无论成功失败都直接删台账，导致「生成任务」页永远看不到历史与失败原因。
 * 现在成功 / 失败都会保留一条记录，只有「节点已删除」这类放弃场景才真正删除。
 */
export const removeCanvasJob = (
    projectId: string,
    nodeId: string,
    outcome: 'succeeded' | 'failed' | 'discard' = 'succeeded',
    error?: string,
) => {
    const job = loadCanvasJobs(projectId).find((j) => j.nodeId === nodeId);
    const jobs = loadCanvasJobs(projectId).filter((j) => j.nodeId !== nodeId);
    writeAll(projectId, jobs);

    if (outcome === 'discard' || !job) {
        removePersistedJob(projectId, nodeId);
        return;
    }

    persistJob(projectId, {
        id: job.nodeId,
        kind: 'canvas-video',
        episode: job.episode,
        status: outcome,
        payload: {
            ...job,
            ...(error ? { error } : {}),
            finishedAt: Date.now(),
        },
        startedAt: job.startedAt,
    });
};

/** 清空某项目的全部任务（排障用） */
export const clearCanvasJobs = (projectId: string) => {
    const ids = readAll(projectId).map((job) => job.nodeId).filter(Boolean);
    try {
        localStorage.removeItem(storeKey(projectId));
    } catch {
        /* ignore */
    }
    for (const id of ids) removePersistedJob(projectId, id);
};
