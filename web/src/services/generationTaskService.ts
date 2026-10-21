/**
 * generationTaskService.ts
 *
 * 项目「生成任务」标签页的数据层。
 *
 * 数据源是后端 project_jobs 台账（`GET /api/projects/:projectId/state/jobs`），
 * 一条记录 = 一次真实的生成尝试：
 *   kind     asset（资产出图）/ shot-video（分镜片段）/ canvas-video（画布节点）
 *   status   running | succeeded | failed
 *   payload  发起时的参数（提示词 / 模型 / taskId …），失败时补 error
 *
 * 之前的任务页是用逐集产物进度「反推」出来的假列表，失败与重试都没有落点。
 * 这里同时承担两件事：
 *   1. 读取：把台账映射成表格行，并判定「异常」（失败 / 运行超时）
 *   2. 写入：任务结束时补终态，失败原因随 payload 一起存下来
 */

import { persistJob } from './projectStateService';
import { submitImageTask } from './generationService';
import { DEFAULT_IMAGE_MODEL } from '../constants/modelDefaults';

const TOKEN_KEY = 'twitcanva_auth_token';

function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    try {
        const token = localStorage.getItem(TOKEN_KEY) || '';
        if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
        /* 隐私模式忽略 */
    }
    return headers;
}

// ============================================================================
// 类型
// ============================================================================

export interface ProjectJob {
    id: string;
    kind: string;
    episode: number | null;
    status: string;
    payload: Record<string, any>;
    startedAt: number | null;
    updatedAt: string | null;
    /**
     * 触发人（发起这次生成的登录账号）。
     * 由后端按 token 写入，只在任务创建那一次落值；空值 = 系统任务或 005 迁移前的历史任务。
     */
    createdBy: string;
    createdByName: string;
    createdByRole: string;
}

/** 任务类型 → 表格「节点 / 生成服务」两列 */
export const JOB_KIND_META: Record<string, { node: string; service: string }> = {
    asset: { node: '项目资产', service: '图像生成' },
    'shot-video': { node: '镜头视频', service: '视频生成' },
    'canvas-video': { node: '画布生成', service: '视频生成' },
};

/**
 * 运行超时阈值：超过仍未拿到终态即视为异常。
 * 视频侧服务端最长等待约 11 分钟，这里留余量；图片任务通常几分钟内结束。
 */
const RUNNING_TIMEOUT: Record<string, number> = {
    asset: 10 * 60 * 1000,
    'shot-video': 15 * 60 * 1000,
    'canvas-video': 15 * 60 * 1000,
};

const DEFAULT_TIMEOUT = 15 * 60 * 1000;

/** 是否异常：明确失败，或运行时间已超过该类型的超时阈值 */
export function isJobAbnormal(job: ProjectJob, now = Date.now()): boolean {
    if (job.status === 'failed') return true;
    if (job.status !== 'running') return false;
    const startedAt = Number(job.startedAt || 0);
    if (!startedAt) return false;
    return now - startedAt > (RUNNING_TIMEOUT[job.kind] || DEFAULT_TIMEOUT);
}

/** 任务标题：集号 + 具体对象，避免表格里只剩一串 id */
export function describeJob(job: ProjectJob): string {
    const episodeLabel = job.episode ? `第${String(job.episode).padStart(2, '0')}集` : '项目级';
    const payload = job.payload || {};

    if (job.kind === 'asset') {
        const name = String(payload.assetName || '').trim();
        if (name) return `${episodeLabel} · ${name} 设定图`;
        const prompt = String(payload.prompt || '').trim();
        return `${episodeLabel} · ${prompt ? `${prompt.slice(0, 16)}…` : '资产设定图'}`;
    }
    if (job.kind === 'shot-video') {
        const shotNumber = Number(payload.shotNumber || 0);
        return shotNumber > 0
            ? `${episodeLabel} · 片段${shotNumber} 视频`
            : `${episodeLabel} · 镜头视频`;
    }
    if (job.kind === 'canvas-video') {
        return `${episodeLabel} · 画布节点 ${job.id.slice(0, 12)}`;
    }
    return `${episodeLabel} · ${job.id}`;
}

// ============================================================================
// 读取
// ============================================================================

export async function fetchProjectJobs(projectId: string): Promise<ProjectJob[]> {
    const response = await fetch(`/api/projects/${projectId}/state/jobs`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`加载任务列表失败：HTTP ${response.status}`);
    const data = await response.json();
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    return jobs.map((job: ProjectJob) => ({
        id: String(job.id),
        kind: job.kind || 'canvas-video',
        episode: job.episode === null || job.episode === undefined ? null : Number(job.episode),
        status: job.status || 'running',
        payload: job.payload || {},
        startedAt: job.startedAt === null || job.startedAt === undefined ? null : Number(job.startedAt),
        updatedAt: job.updatedAt || null,
        createdBy: job.createdBy || '',
        createdByName: job.createdByName || '',
        createdByRole: job.createdByRole || '',
    }));
}

// ============================================================================
// 写入终态
// ============================================================================

/**
 * 给任务写终态。payload 与已有内容合并，只追加 error / finishedAt 等字段，
 * 这样「生成任务」页既能看到发起参数，也能看到失败原因。
 */
export function finishJob(
    projectId: string,
    job: Pick<ProjectJob, 'id' | 'kind' | 'episode' | 'payload' | 'startedAt'>,
    status: 'succeeded' | 'failed',
    extra: Record<string, unknown> = {},
): void {
    persistJob(projectId, {
        id: job.id,
        kind: job.kind,
        episode: job.episode ?? undefined,
        status,
        payload: { ...(job.payload || {}), ...extra, finishedAt: Date.now() },
        startedAt: job.startedAt ?? undefined,
    });
}

// ============================================================================
// 重试
// ============================================================================

export interface RetryResult {
    ok: boolean;
    message: string;
    /** 视频类任务无法只靠 payload 重建（参考图 / 首帧在画布上下文里），需回到画布重试 */
    needCanvas?: boolean;
}

const assetJobsKey = (projectId: string) => `asset-confirm-jobs:${projectId}`;

/**
 * 把重试出来的资产任务追加到本地待认领队列。
 * 资产面板靠这个队列轮询 `getImageTaskStatus` 把结果回填到资产上，
 * 不写本地队列的话，重试虽然提交成功，图片也不会自动回到资产卡片。
 */
function appendLocalAssetJob(projectId: string, job: Record<string, unknown>): void {
    try {
        const raw = localStorage.getItem(assetJobsKey(projectId));
        const list = raw ? (JSON.parse(raw) as unknown[]) : [];
        const next = Array.isArray(list) ? [...list, job] : [job];
        localStorage.setItem(assetJobsKey(projectId), JSON.stringify(next));
    } catch {
        /* 隐私模式忽略 */
    }
}

/**
 * 重试一个任务。
 *
 * - 资产出图：payload 里有提示词与模型，可直接重新提交图片任务，并把新任务写进
 *   台账 + 本地待认领队列，结果会自动回填到资产。
 * - 镜头视频 / 画布视频：payload 只有提示词摘要，缺参考图与首帧，直接重发会得到
 *   与原来不同的画面，所以只提示回到画布对应集重试（画布里有完整上下文）。
 */
export async function retryJob(projectId: string, job: ProjectJob): Promise<RetryResult> {
    if (job.kind !== 'asset') {
        return {
            ok: false,
            needCanvas: true,
            message: '视频任务需回到画布对应集重试，那里才有完整的参考图与首帧',
        };
    }

    const payload = job.payload || {};
    const prompt = String(payload.prompt || '').trim();
    if (!prompt) {
        return { ok: false, message: '该任务没有记录提示词，无法重试' };
    }

    const newJobId = `${job.id}-r${Date.now().toString(36)}`;
    try {
        const submitted = await submitImageTask({
            prompt,
            aspectRatio: payload.aspectRatio || '16:9',
            resolution: payload.resolution || '2K',
            imageModel: payload.imageModel || DEFAULT_IMAGE_MODEL,
            nodeId: newJobId,
            channel: payload.channel || 'workflow',
        });

        const nextPayload = {
            ...payload,
            taskId: submitted.taskId,
            retriedFrom: job.id,
        };

        persistJob(projectId, {
            id: newJobId,
            kind: 'asset',
            episode: job.episode ?? undefined,
            status: 'running',
            payload: nextPayload,
            startedAt: Date.now(),
        });

        if (job.episode && payload.assetId) {
            appendLocalAssetJob(projectId, {
                id: newJobId,
                episode: job.episode,
                category: payload.category,
                assetId: payload.assetId,
                lookId: payload.lookId,
                prompt,
                startedAt: Date.now(),
            });
        }

        return { ok: true, message: '已重新提交生成任务' };
    } catch (error: any) {
        return { ok: false, message: error?.message || '重试失败' };
    }
}
