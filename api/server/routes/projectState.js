/**
 * projectState.js
 *
 * 项目制作过程状态（原前端 localStorage）读写接口。
 *
 *   GET    /api/projects/:projectId/state                        整包拉取（首屏水合）
 *   PUT    /api/projects/:projectId/state                        整包分片覆盖（历史数据上迁）
 *
 *   GET/PUT /api/projects/:projectId/state/assets/:episode       单集资产确认
 *   GET/PUT /api/projects/:projectId/state/shots/:episode        单集分镜
 *   PUT     /api/projects/:projectId/state/shots/:episode/:shotNo/history   单镜头视频历史
 *   GET/PUT /api/projects/:projectId/state/dubbing/:episode      单集配音
 *   PUT     /api/projects/:projectId/state/scene-merges/:episode 单集场景合并
 *   PUT     /api/projects/:projectId/state/ui/:key               零散 UI 状态
 *   DELETE  /api/projects/:projectId/state/ui/:key
 *   GET/POST /api/projects/:projectId/state/jobs                 生成任务台账
 *   DELETE  /api/projects/:projectId/state/jobs/:jobId
 *
 * 并发：PUT 可带 baseVersion，冲突返回 409 并附 currentVersion，
 * 前端据此决定「覆盖 / 重取」，避免静默丢写。
 */

import express from 'express';
import { one } from '../db/index.js';
import {
    StateConflictError,
    loadProjectState,
    getAssetState,
    getShots,
    saveAssetState,
    saveShots,
    saveShotHistory,
    saveDubbing,
    saveSceneMerge,
    setUiState,
    listJobs,
    upsertJob,
    deleteJob,
    saveProjectState,
} from '../db/projectState.js';
import { requireAuth } from '../middleware/auth.js';
import { canViewProject } from '../services/projectService.js';

const router = express.Router();

router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 校验 projectId、项目存在性以及当前用户的可见权限（数据隔离） */
async function ensureProject(req, res) {
    const { projectId } = req.params;
    if (!UUID_RE.test(projectId)) {
        res.status(400).json({ error: '项目 id 非法' });
        return null;
    }
    const row = await one('SELECT id, leader_id FROM projects WHERE id = $1', [projectId]);
    if (!row) {
        res.status(404).json({ error: '项目不存在' });
        return null;
    }
    // 组长只能访问自己名下的项目，组员只能访问所属组长的项目
    if (!canViewProject(req.user, { leaderId: row.leader_id || '' })) {
        res.status(404).json({ error: '项目不存在或无权限访问' });
        return null;
    }
    return projectId;
}

/** 统一错误处理：版本冲突转 409，其余 400/500 */
function fail(res, error) {
    if (error instanceof StateConflictError) {
        return res.status(409).json({ error: error.message, currentVersion: error.currentVersion });
    }
    console.error('[project-state] 操作失败:', error.message);
    return res.status(400).json({ error: error.message });
}

/** 包装 async handler，省掉每个路由的 try/catch 样板 */
function wrap(handler) {
    return async (req, res) => {
        const projectId = await ensureProject(req, res);
        if (!projectId) return;
        try {
            await handler(req, res, projectId);
        } catch (error) {
            fail(res, error);
        }
    };
}

// ============================================================================
// 整包
// ============================================================================

router.get('/:projectId/state', wrap(async (req, res, projectId) => {
    res.json(await loadProjectState(projectId));
}));

router.put('/:projectId/state', wrap(async (req, res, projectId) => {
    const summary = await saveProjectState(projectId, req.body || {});
    res.json({ success: true, summary });
}));

// ============================================================================
// 资产确认（按集）
// ============================================================================

router.get('/:projectId/state/assets/:episode', wrap(async (req, res, projectId) => {
    const state = await getAssetState(projectId, req.params.episode);
    if (!state) return res.json({ categories: { characters: [], scenes: [], props: [] }, version: 0 });
    res.json(state);
}));

router.put('/:projectId/state/assets/:episode', wrap(async (req, res, projectId) => {
    const { categories, baseVersion } = req.body || {};
    const saved = await saveAssetState(projectId, req.params.episode, categories, baseVersion);
    res.json({ success: true, ...saved });
}));

// ============================================================================
// 分镜（按集）
// ============================================================================

router.get('/:projectId/state/shots/:episode', wrap(async (req, res, projectId) => {
    const state = await getShots(projectId, req.params.episode);
    if (!state) return res.json({ shots: [], version: 0 });
    res.json(state);
}));

router.put('/:projectId/state/shots/:episode', wrap(async (req, res, projectId) => {
    const { shots, baseVersion } = req.body || {};
    const saved = await saveShots(projectId, req.params.episode, shots, baseVersion);
    res.json({ success: true, ...saved });
}));

// 单镜头视频结果 / 历史
router.put('/:projectId/state/shots/:episode/:shotNo/history', wrap(async (req, res, projectId) => {
    const { urls, videoId, videoUrl } = req.body || {};
    const saved = await saveShotHistory(projectId, req.params.episode, req.params.shotNo, { urls, videoId, videoUrl });
    res.json({ success: true, ...saved });
}));

// ============================================================================
// 配音 / 场景合并（按集）
// ============================================================================

router.get('/:projectId/state/dubbing/:episode', wrap(async (req, res, projectId) => {
    const state = await one(
        'SELECT payload, version, updated_at FROM project_dubbing WHERE project_id = $1 AND episode_no = $2',
        [projectId, Number(req.params.episode)],
    );
    if (!state) return res.json({ payload: {}, version: 0 });
    res.json({ payload: state.payload, version: state.version, updatedAt: state.updated_at });
}));

router.put('/:projectId/state/dubbing/:episode', wrap(async (req, res, projectId) => {
    const { payload, baseVersion } = req.body || {};
    const saved = await saveDubbing(projectId, req.params.episode, payload, baseVersion);
    res.json({ success: true, ...saved });
}));

router.put('/:projectId/state/scene-merges/:episode', wrap(async (req, res, projectId) => {
    const saved = await saveSceneMerge(projectId, req.params.episode, req.body?.payload || {});
    res.json({ success: true, ...saved });
}));

// ============================================================================
// 零散 UI 状态
// ============================================================================

router.put('/:projectId/state/ui/:key', wrap(async (req, res, projectId) => {
    const saved = await setUiState(projectId, req.params.key, req.body?.value);
    res.json({ success: true, ...saved });
}));

router.delete('/:projectId/state/ui/:key', wrap(async (req, res, projectId) => {
    await setUiState(projectId, req.params.key, null);
    res.json({ success: true });
}));

// ============================================================================
// 任务台账
// ============================================================================

router.get('/:projectId/state/jobs', wrap(async (req, res, projectId) => {
    res.json({ jobs: await listJobs(projectId, req.query.kind) });
}));

router.post('/:projectId/state/jobs', wrap(async (req, res, projectId) => {
    // 触发人由 token 认定：哪怕前端在 payload 里写了别人的 id，也只记 req.user
    const job = await upsertJob(projectId, req.body || {}, req.user);
    res.json({ success: true, job });
}));

router.delete('/:projectId/state/jobs/:jobId', wrap(async (req, res, projectId) => {
    const deleted = await deleteJob(projectId, req.params.jobId);
    if (!deleted) return res.status(404).json({ error: '任务不存在' });
    res.json({ success: true });
}));

export default router;
