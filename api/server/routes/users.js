/**
 * users.js
 *
 * 用户管理路由（仅具备管理权限的角色可访问：管理员 / 项目主管 / 组长）。
 * 权限层级由 userService.canManage 统一判断。
 */

import express from 'express';
import {
    listUsers,
    updateUser,
    updateUserRole,
    updateUserPermissions,
    setUserStatus,
    setUserLeader,
    deleteUser,
    ROLES,
    ROLE_LABELS,
    ROLE_RANK,
    PERMISSIONS,
} from '../services/userService.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// 所有用户管理接口：需登录 + 具备管理权限（管理员/项目主管/组长）
router.use(requireAuth, requireRole('admin', 'project_manager', 'team_leader'));

// 用户列表（按当前用户权限过滤）
router.get('/', async (req, res) => {
    res.json({
        users: await listUsers(req.user),
        roles: ROLES,
        roleLabels: ROLE_LABELS,
        roleRank: ROLE_RANK,
    });
});

// 功能权限点元数据（供前端渲染权限开关）
router.get('/permissions-meta', (req, res) => {
    res.json({ permissions: PERMISSIONS });
});

// 编辑用户（角色 + 状态；基础信息由飞书登录同步）
router.put('/:id', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能编辑自己' });
        const user = await updateUser(req.params.id, req.body, req.user.role);
        res.json({ success: true, user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 分配角色
router.put('/:id/role', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能修改自己的角色' });
        const { role } = req.body;
        const user = await updateUserRole(req.params.id, role, req.user.role);
        res.json({ success: true, user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 设置用户功能权限
router.put('/:id/permissions', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能修改自己的权限' });
        const { permissions } = req.body;
        const user = await updateUserPermissions(req.params.id, permissions, req.user.role);
        res.json({ success: true, user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 设置组员的所属组长（管理员 / 项目主管）；leaderId 传空表示解除归属
router.put('/:id/leader', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能修改自己的归属' });
        const user = await setUserLeader(req.params.id, req.body.leaderId || '', req.user);
        res.json({ success: true, user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 禁用/启用
router.put('/:id/status', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能修改自己的状态' });
        const { status } = req.body;
        const user = await setUserStatus(req.params.id, status, req.user.role);
        res.json({ success: true, user });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 删除用户
router.delete('/:id', async (req, res) => {
    try {
        if (req.user.id === req.params.id) return res.status(403).json({ error: '不能删除自己' });
        await deleteUser(req.params.id, req.user.role);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

export default router;
