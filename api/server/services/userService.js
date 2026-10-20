/**
 * userService.js
 *
 * 用户管理服务（JSON 文件存储，符合现有项目无数据库风格）。
 * 角色：admin（管理员）/ project_manager（项目主管）/ team_leader（组长）/ user（组员）
 * 权限层级：管理员管所有人；项目主管只能管组长；组长只能管组员。
 * 只能管理直属下级：同级不可互管、不可越级、不可向上管理。
 */

import crypto from 'crypto';
import { readJson, writeJsonSync } from '../utils/jsonStore.js';
import { USERS_FILE, COMPANY_FILE } from '../utils/paths.js';

export const ROLES = ['admin', 'project_manager', 'team_leader', 'user'];

export const ROLE_LABELS = {
    admin: '管理员',
    project_manager: '项目主管',
    team_leader: '组长',
    user: '组员',
};

// 角色权限等级：数值越大权限越高
export const ROLE_RANK = {
    admin: 3,
    project_manager: 2,
    team_leader: 1,
    user: 0,
};

// 功能权限点（管理员可在「用户权限设置」中为每个成员单独开关）
export const PERMISSIONS = [
    { key: 'project_manage', label: '项目管理', desc: '创建、编辑、删除项目/工作流' },
    { key: 'image_generate', label: '图片生成', desc: '使用 AI 生成图片' },
    { key: 'video_generate', label: '视频生成', desc: '使用 AI 生成视频' },
    { key: 'storyboard', label: '分镜脚本', desc: 'AI 编剧与分镜生成' },
    { key: 'social_post', label: '社交发布', desc: '发布到 Twitter / TikTok' },
    { key: 'asset_library', label: '素材库', desc: '保存与管理素材资源' },
    { key: 'member_manage', label: '成员管理', desc: '查看和管理成员' },
];

function allPermissions(value) {
    const result = {};
    PERMISSIONS.forEach(p => { result[p.key] = value; });
    return result;
}

// 各角色的默认权限
export function getDefaultPermissions(role) {
    switch (role) {
        case 'admin':
            return allPermissions(true);
        case 'project_manager':
            return { project_manage: true, image_generate: true, video_generate: true, storyboard: true, social_post: true, asset_library: true, member_manage: false };
        case 'team_leader':
            return { project_manage: false, image_generate: true, video_generate: true, storyboard: true, social_post: false, asset_library: true, member_manage: false };
        case 'user':
        default:
            return { project_manage: false, image_generate: true, video_generate: true, storyboard: false, social_post: false, asset_library: false, member_manage: false };
    }
}

// 归一化权限对象：只保留合法键、非布尔的键回退到旧值
function normalizePermissions(input, current) {
    const result = {};
    PERMISSIONS.forEach(p => {
        if (input && typeof input[p.key] === 'boolean') {
            result[p.key] = input[p.key];
        } else {
            result[p.key] = !!(current && current[p.key]);
        }
    });
    return result;
}

/**
 * 判断操作者能否管理目标角色。
 * 管理员管所有人；项目主管只能管组长；组长只能管组员。
 * 只能管理直属下级：同级不可互管、不可越级、不可向上管理。
 */
export function canManage(operatorRole, targetRole) {
    if (operatorRole === 'admin') return true;
    if (operatorRole === 'project_manager') return targetRole === 'team_leader';
    if (operatorRole === 'team_leader') return targetRole === 'user';
    return false;
}

function loadUsers() {
    return readJson(USERS_FILE, []);
}

function saveUsers(users) {
    writeJsonSync(USERS_FILE, users);
}

/**
 * 读取已锁定的公司（企业）标识 tenant_key。
 * 用于登录身份校验：只有本公司人员可访问。
 */
export function getCompanyTenantKey() {
    const data = readJson(COMPANY_FILE, {});
    return (data && data.tenantKey) || '';
}

/**
 * 锁定公司标识：以首个登录用户所属飞书企业为准。
 */
export function setCompanyTenantKey(tenantKey) {
    writeJsonSync(COMPANY_FILE, { tenantKey });
}

/**
 * 根据飞书 open_id 查找用户
 */
export function findUserByOpenId(openId) {
    return loadUsers().find(u => u.feishuOpenId === openId);
}

/**
 * 查找或创建用户（首次登录自动建号，第一个用户成为 admin）
 */
export function findOrCreateUser(userInfo) {
    const users = loadUsers();
    const existing = users.find(u => u.feishuOpenId === userInfo.open_id);

    if (existing) {
        existing.lastLoginAt = new Date().toISOString();
        existing.name = userInfo.name || existing.name;
        existing.avatarUrl = userInfo.avatar_url || existing.avatarUrl;
        existing.tenantKey = userInfo.tenant_key || existing.tenantKey || '';
        existing.companyName = userInfo.companyName || existing.companyName || '';
        // 身份基础信息由飞书提供，不再保留手动填写的邮箱/手机号
        delete existing.email;
        delete existing.mobile;
        // 兼容旧数据：补全权限字段
        if (!existing.permissions) existing.permissions = getDefaultPermissions(existing.role);
        saveUsers(users);
        return existing;
    }

    const isFirstUser = users.length === 0;
    const user = {
        id: crypto.randomUUID(),
        feishuOpenId: userInfo.open_id,
        feishuUnionId: userInfo.union_id || '',
        tenantKey: userInfo.tenant_key || '',
        companyName: userInfo.companyName || '',
        name: userInfo.name || '',
        avatarUrl: userInfo.avatar_url || '',
        role: isFirstUser ? 'admin' : 'user',
        status: 'active',
        permissions: getDefaultPermissions(isFirstUser ? 'admin' : 'user'),
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
    };
    users.push(user);
    saveUsers(users);
    return user;
}

/**
 * 剥离敏感字段（飞书 open_id / union_id / tenant_key / 邮箱 / 手机号）
 */
export function sanitizeUser(user) {
    const { feishuOpenId, feishuUnionId, tenantKey, email, mobile, ...rest } = user;
    if (!rest.permissions) rest.permissions = getDefaultPermissions(rest.role);
    return rest;
}

/**
 * 用户列表（按操作者权限过滤，剥离飞书敏感字段）
 */
export function listUsers(operatorRole = 'admin') {
    return loadUsers()
        .filter(u => canManage(operatorRole, u.role))
        .map(sanitizeUser);
}

export function getUserById(id) {
    return loadUsers().find(u => u.id === id);
}

/**
 * 编辑用户（角色 + 状态；姓名/头像等基础信息由飞书登录自动同步）
 */
export function updateUser(id, data, operatorRole) {
    const users = loadUsers();
    const user = users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');

    const { role, status, permissions } = data || {};
    if (role !== undefined) {
        if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
        if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');
        user.role = role;
    }
    if (status !== undefined) user.status = status;
    if (permissions !== undefined) {
        user.permissions = normalizePermissions(permissions, user.permissions);
    }
    saveUsers(users);
    return user;
}

// 单独更新用户功能权限
export function updateUserPermissions(id, permissions, operatorRole) {
    const users = loadUsers();
    const user = users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');
    user.permissions = normalizePermissions(permissions, user.permissions);
    saveUsers(users);
    return user;
}

export function updateUserRole(id, role, operatorRole) {
    if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
    if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');
    const users = loadUsers();
    const user = users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');
    user.role = role;
    saveUsers(users);
    return user;
}

export function setUserStatus(id, status, operatorRole) {
    const users = loadUsers();
    const user = users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');
    user.status = status;
    saveUsers(users);
    return user;
}

export function deleteUser(id, operatorRole) {
    const users = loadUsers();
    const user = users.find(u => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');
    const idx = users.findIndex(u => u.id === id);
    users.splice(idx, 1);
    saveUsers(users);
}

export default {
    ROLES,
    ROLE_LABELS,
    ROLE_RANK,
    PERMISSIONS,
    getDefaultPermissions,
    canManage,
    findUserByOpenId,
    findOrCreateUser,
    listUsers,
    getUserById,
    updateUser,
    updateUserRole,
    updateUserPermissions,
    setUserStatus,
    deleteUser,
    getCompanyTenantKey,
    setCompanyTenantKey,
    sanitizeUser,
};
