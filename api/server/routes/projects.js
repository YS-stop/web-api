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
    createChangeRequest,
    listChangeRequests,
    reviewChangeRequest,
    canEditProject,
    canRequestChange,
    canApprove,
} from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

// 项目列表
router.get('/', (req, res) => {
    res.json({ projects: listProjects() });
});

// 新建项目
router.post('/', (req, res) => {
    try {
        const project = createProject(req.body, req.user);
        res.json({ success: true, project });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 审批申请列表（管理员 / 项目主管）
router.get('/change-requests', (req, res) => {
    if (!canApprove(req.user.role)) {
        return res.status(403).json({ error: '无权限' });
    }
    res.json({ requests: listChangeRequests(req.user) });
});

// 审批（通过 / 拒绝）
router.put('/change-requests/:requestId', (req, res) => {
    if (!canApprove(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅管理员或项目主管可审批' });
    }
    try {
        const approve = req.body.approve === true;
        const request = reviewChangeRequest(req.params.requestId, approve, req.user);
        res.json({ success: true, request });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 项目详情
router.get('/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });
    res.json({ project });
});

// 直接编辑项目（管理员 / 项目主管）
router.put('/:id', (req, res) => {
    if (!canEditProject(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅管理员或项目主管可直接修改项目' });
    }
    try {
        const project = updateProject(req.params.id, req.body, req.user);
        res.json({ success: true, project });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 发起「申请修改」（组长）
router.post('/:id/change-requests', (req, res) => {
    if (!canRequestChange(req.user.role)) {
        return res.status(403).json({ error: '无权限：仅组长可发起申请修改' });
    }
    try {
        const request = createChangeRequest(req.params.id, req.body.changes || {}, req.body.reason, req.user);
        res.json({ success: true, request });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

export default router;
