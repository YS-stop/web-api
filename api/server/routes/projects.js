/**
 * projects.js
 *
 * 项目路由：列表 / 详情 / 新建 / 编辑 / 变更申请 / 审批。
 * 权限判断集中在 projectService，此处做角色校验与参数校验。
 *
 * 注意：审批列表 GET /change-requests 必须定义在 GET /:id 之前，
 * 否则会被 /:id 当作项目 id 匹配。
 */

import express from 'express';
import {
    listProjects,
    getProject,
    createProject,
    updateProject,
    assignProjectLeader,
    createChangeRequest,
    listChangeRequests,
    reviewChangeRequest,
    canEditProject,
    canRequestChange,
    canApprove,
    canCreateProject,
    canAssignProject,
} from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';
import { loadProjectProgress } from '../db/projectProgress.js';

const router = express.Router();

router.use(requireAuth);

// 项目列表（按角色做数据隔离：管理员/主管看全部，组长看自己，组员看所属组长）
router.get('/', async (req, res) => {
    res.json({ projects: await listProjects(req.user) });
});

// 新建项目（组员无权限；组长只能建自己的，主管/管理员可指派归属组长）
router.post('/', async (req, res) => {
    if (!canCreateProject(req.user.role)) {
        return res.status(403).json({ error: '无权限：组员不能新建项目' });
    }
    try {
        const project = await createProject(req.body, req.user);
        res.json({ success: true, project });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 审批申请列表（管理员 / 项目主管）
router.get('/change-requests', async (req, res) => {
    if (!canApprove(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }
    res.json({ requests: await listChangeRequests(req.user) });
});

// 审批（通过 / 拒绝）
router.put('/change-requests/:requestId', async (req, res) => {
    if (!canApprove(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅管理员或项目主管可审批' });
    }
    try {
        const approve = req.body.approve === true;
        const request = await reviewChangeRequest(req.params.requestId, approve, req.user);
        res.json({ success: true, request });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 项目进度（服务端聚合，必须定义在 /:id 之前，否则会被当作项目 id）
router.get('/progress', async (req, res) => {
    try {
        const projects = await listProjects(req.user);
        const progress = await loadProjectProgress(projects);
        res.json({ progress });
    } catch (e) {
        console.error('[projects] 进度聚合失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 项目详情（越权视为不存在，防止用 ID 直连绕过列表隔离）
router.get('/:id', async (req, res) => {
    const project = await getProject(req.params.id, req.user);
    if (!project) return res.status(404).json({ error: '项目不存在或无权限访问' });
    res.json({ project });
});

// 直接编辑项目（管理员 / 项目主管）
router.put('/:id', async (req, res) => {
    if (!canEditProject(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅管理员或项目主管可直接修改项目' });
    }
    try {
        const project = await updateProject(req.params.id, req.body, req.user);
        res.json({ success: true, project });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 分配项目归属组长（管理员 / 项目主管）；leaderId 传空表示收回为「未分配」
router.put('/:id/leader', async (req, res) => {
    if (!canAssignProject(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅管理员或项目主管可分配项目' });
    }
    try {
        const project = await assignProjectLeader(req.params.id, req.body.leaderId || '', req.user);
        res.json({ success: true, project });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 发起「申请修改」（组长）
router.post('/:id/change-requests', async (req, res) => {
    if (!canRequestChange(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅组长可发起申请修改' });
    }
    try {
        const request = await createChangeRequest(req.params.id, req.body.changes || {}, req.body.reason, req.user);
        res.json({ success: true, request });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

export default router;
