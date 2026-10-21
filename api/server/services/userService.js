/**
 * userService.js
 *
 * 用户管理服务。存储层由 DB_DRIVER 决定：
 *   file = 继续读写 library/users.json、library/company.json（默认）
 *   db   = 读写 PostgreSQL（users / company_settings）
 *   dual = 写 PG 的同时保留文件副本（读以 PG 为准）
 *
 * 角色：admin（管理员）/ project_manager（项目主管）/ team_leader（组长）/ user（组员）
 * 权限层级：管理员管所有人；项目主管只能管组长；组长只能管组员。
 * 只能管理直属下级：同级不可互管、不可越级、不可向上管理。
 */

import crypto from 'crypto';
import { readJson, writeJsonSync } from '../utils/jsonStore.js';
import { USERS_FILE, COMPANY_FILE } from '../utils/paths.js';
import { isDbEnabled, isDualWrite, exec, many, one, transaction } from '../db/index.js';

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
    PERMISSIONS.forEach((p) => { result[p.key] = value; });
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
    PERMISSIONS.forEach((p) => {
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

/**
 * 剥离敏感字段（飞书 open_id / union_id / tenant_key / 邮箱 / 手机号）
 */
export function sanitizeUser(user) {
    const { feishuOpenId, feishuUnionId, tenantKey, email, mobile, ...rest } = user;
    if (!rest.permissions) rest.permissions = getDefaultPermissions(rest.role);
    return rest;
}

// ============================================================================
// 映射
// ============================================================================

const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

function rowToUser(row) {
    return {
        id: row.id,
        feishuOpenId: row.feishu_open_id,
        feishuUnionId: row.feishu_union_id,
        tenantKey: row.tenant_key,
        companyName: row.company_name,
        name: row.name,
        avatarUrl: row.avatar_url,
        role: row.role,
        status: row.status,
        permissions: row.permissions || getDefaultPermissions(row.role),
        leaderId: row.leader_id || '',
        createdAt: iso(row.created_at),
        lastLoginAt: iso(row.last_login_at),
    };
}

/**
 * 操作者可以看到的角色列表；null 表示不限。
 * 主管需要看到组员才能把组员分配到组长，因此列表里包含 user。
 */
function manageableRoles(operatorRole) {
    if (operatorRole === 'admin') return null;
    if (operatorRole === 'project_manager') return ['team_leader', 'user'];
    if (operatorRole === 'team_leader') return ['user'];
    return [];
}

// ============================================================================
// 文件实现（原逻辑）
// ============================================================================

function loadUsersFromFile() {
    const raw = readJson(USERS_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

function saveUsersToFile(users) {
    writeJsonSync(USERS_FILE, users);
}

function getCompanyTenantKeyFromFile() {
    const data = readJson(COMPANY_FILE, {});
    return (data && data.tenantKey) || '';
}

function setCompanyTenantKeyToFile(tenantKey) {
    writeJsonSync(COMPANY_FILE, { tenantKey });
}

function findOrCreateUserFromFile(userInfo) {
    const users = loadUsersFromFile();
    const existing = users.find((u) => u.feishuOpenId === userInfo.open_id);

    if (existing) {
        existing.lastLoginAt = new Date().toISOString();
        existing.name = userInfo.name || existing.name;
        existing.avatarUrl = userInfo.avatar_url || existing.avatarUrl;
        existing.tenantKey = userInfo.tenant_key || existing.tenantKey || '';
        existing.companyName = userInfo.companyName || existing.companyName || '';
        delete existing.email;
        delete existing.mobile;
        if (!existing.permissions) existing.permissions = getDefaultPermissions(existing.role);
        saveUsersToFile(users);
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
    saveUsersToFile(users);
    return user;
}

function updateUserFromFile(id, data, operatorRole, mode) {
    const users = loadUsersFromFile();
    const user = users.find((u) => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');

    if (mode === 'role') {
        const role = data;
        if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
        if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');
        user.role = role;
    } else if (mode === 'permissions') {
        user.permissions = normalizePermissions(data, user.permissions);
    } else if (mode === 'status') {
        user.status = data;
    } else {
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
    }

    saveUsersToFile(users);
    return user;
}

// ============================================================================
// PostgreSQL 实现
// ============================================================================

async function getCompanyTenantKeyFromDb() {
    const row = await one('SELECT tenant_key FROM company_settings WHERE id = 1');
    return (row && row.tenant_key) || '';
}

async function setCompanyTenantKeyToDb(tenantKey) {
    await exec(
        `INSERT INTO company_settings (id, tenant_key, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET tenant_key = EXCLUDED.tenant_key, updated_at = now()`,
        [tenantKey],
    );
}

async function findUserByOpenIdFromDb(openId) {
    const row = await one('SELECT * FROM users WHERE feishu_open_id = $1', [openId]);
    return row ? rowToUser(row) : null;
}

async function getUserByIdFromDb(id) {
    // id 可能不是合法 UUID（旧 token / 异常入参），直接返回 null，避免 SQL 类型错误
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) {
        return null;
    }
    const row = await one('SELECT * FROM users WHERE id = $1', [id]);
    return row ? rowToUser(row) : null;
}

async function findOrCreateUserFromDb(userInfo) {
    return transaction(async (client) => {
        const now = new Date().toISOString();
        const existing = (await client.query('SELECT * FROM users WHERE feishu_open_id = $1', [userInfo.open_id])).rows[0];

        if (existing) {
            const updated = (await client.query(
                `UPDATE users SET
                    last_login_at = $1,
                    name = COALESCE(NULLIF($2, ''), name),
                    avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
                    tenant_key = COALESCE(NULLIF($4, ''), tenant_key),
                    company_name = COALESCE(NULLIF($5, ''), company_name)
                 WHERE id = $6
                 RETURNING *`,
                [now, userInfo.name || '', userInfo.avatar_url || '', userInfo.tenant_key || '', userInfo.companyName || '', existing.id],
            )).rows[0];

            // 兼容旧数据：补全权限字段
            if (!updated.permissions || Object.keys(updated.permissions).length === 0) {
                const permissions = getDefaultPermissions(updated.role);
                await client.query('UPDATE users SET permissions = $1::jsonb WHERE id = $2', [JSON.stringify(permissions), updated.id]);
                updated.permissions = permissions;
            }
            return rowToUser(updated);
        }

        const countRow = (await client.query('SELECT count(*)::int AS total FROM users')).rows[0];
        const isFirstUser = Number(countRow.total) === 0;
        const role = isFirstUser ? 'admin' : 'user';

        const inserted = (await client.query(
            `INSERT INTO users
                (id, feishu_open_id, feishu_union_id, tenant_key, company_name, name, avatar_url,
                 role, status, permissions, created_at, last_login_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9::jsonb,$10,$10)
             RETURNING *`,
            [
                crypto.randomUUID(),
                userInfo.open_id,
                userInfo.union_id || '',
                userInfo.tenant_key || '',
                userInfo.companyName || '',
                userInfo.name || '',
                userInfo.avatar_url || '',
                role,
                JSON.stringify(getDefaultPermissions(role)),
                now,
            ],
        )).rows[0];

        return rowToUser(inserted);
    });
}

async function listUsersFromDb(operatorRole, operatorId) {
    const roles = manageableRoles(operatorRole);
    if (roles && roles.length === 0) return [];

    let rows;
    if (!roles) {
        rows = await many('SELECT * FROM users ORDER BY created_at ASC NULLS LAST');
    } else if (operatorRole === 'team_leader') {
        // 组长只看自己名下的组员
        rows = await many(
            `SELECT * FROM users WHERE role = ANY($1::text[]) AND leader_id = $2
             ORDER BY created_at ASC NULLS LAST`,
            [roles, operatorId || ''],
        );
    } else {
        rows = await many(
            'SELECT * FROM users WHERE role = ANY($1::text[]) ORDER BY created_at ASC NULLS LAST',
            [roles],
        );
    }

    return rows.map(rowToUser).map(sanitizeUser);
}

async function updateUserFromDb(id, data, operatorRole, mode) {
    return transaction(async (client) => {
        const row = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) throw new Error('用户不存在');
        if (!canManage(operatorRole, row.role)) throw new Error('无权管理该用户');

        const target = rowToUser(row);

        if (mode === 'role') {
            const role = data;
            if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
            if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');
            target.role = role;
        } else if (mode === 'permissions') {
            target.permissions = normalizePermissions(data, target.permissions);
        } else if (mode === 'status') {
            target.status = data;
        } else {
            const { role, status, permissions } = data || {};
            if (role !== undefined) {
                if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
                if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');
                target.role = role;
            }
            if (status !== undefined) target.status = status;
            if (permissions !== undefined) {
                target.permissions = normalizePermissions(permissions, target.permissions);
            }
        }

        const updated = (await client.query(
            'UPDATE users SET role = $1, status = $2, permissions = $3::jsonb WHERE id = $4 RETURNING *',
            [target.role, target.status, JSON.stringify(target.permissions), id],
        )).rows[0];

        return rowToUser(updated);
    });
}

async function deleteUserFromDb(id, operatorRole) {
    return transaction(async (client) => {
        const row = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) throw new Error('用户不存在');
        if (!canManage(operatorRole, row.role)) throw new Error('无权管理该用户');
        await client.query('DELETE FROM users WHERE id = $1', [id]);
    });
}

// ============================================================================
// 对外接口（按驱动分流）
// ============================================================================

/**
 * 读取已锁定的公司（企业）标识 tenant_key。
 * 用于登录身份校验：只有本公司人员可访问。
 */
export async function getCompanyTenantKey() {
    return isDbEnabled() ? getCompanyTenantKeyFromDb() : getCompanyTenantKeyFromFile();
}

/**
 * 锁定公司标识：以首个登录用户所属飞书企业为准。
 */
export async function setCompanyTenantKey(tenantKey) {
    if (isDbEnabled()) await setCompanyTenantKeyToDb(tenantKey);
    if (!isDbEnabled() || isDualWrite()) setCompanyTenantKeyToFile(tenantKey);
}

/**
 * 根据飞书 open_id 查找用户
 */
export async function findUserByOpenId(openId) {
    if (isDbEnabled()) return findUserByOpenIdFromDb(openId);
    return loadUsersFromFile().find((u) => u.feishuOpenId === openId) || null;
}

/**
 * 查找或创建用户（首次登录自动建号，第一个用户成为 admin）
 */
export async function findOrCreateUser(userInfo) {
    const user = isDbEnabled()
        ? await findOrCreateUserFromDb(userInfo)
        : findOrCreateUserFromFile(userInfo);

    if (isDualWrite()) {
        const users = loadUsersFromFile();
        const index = users.findIndex((u) => u.feishuOpenId === user.feishuOpenId);
        if (index >= 0) users[index] = user;
        else users.push(user);
        saveUsersToFile(users);
    }
    return user;
}

/**
 * 用户列表（按操作者权限过滤，剥离飞书敏感字段）
 */
export async function listUsers(operator = 'admin') {
    const operatorRole = typeof operator === 'string' ? operator : operator?.role;
    const operatorId = typeof operator === 'string' ? '' : operator?.id;

    if (isDbEnabled()) return listUsersFromDb(operatorRole, operatorId);

    let users = loadUsersFromFile();
    if (operatorRole === 'team_leader') {
        users = users.filter((u) => u.role === 'user' && (u.leaderId || '') === (operatorId || ''));
    } else {
        const roles = manageableRoles(operatorRole);
        users = roles ? users.filter((u) => roles.includes(u.role)) : users;
    }
    return users.map(sanitizeUser);
}

export async function getUserById(id) {
    if (isDbEnabled()) return getUserByIdFromDb(id);
    return loadUsersFromFile().find((u) => u.id === id) || null;
}

/**
 * 编辑用户（角色 + 状态 + 权限；姓名/头像等基础信息由飞书登录自动同步）
 */
export async function updateUser(id, data, operatorRole) {
    const user = isDbEnabled()
        ? await updateUserFromDb(id, data, operatorRole, 'all')
        : updateUserFromFile(id, data, operatorRole, 'all');
    if (isDualWrite()) syncUserToFile(user);
    return user;
}

// 单独更新用户功能权限
export async function updateUserPermissions(id, permissions, operatorRole) {
    const user = isDbEnabled()
        ? await updateUserFromDb(id, permissions, operatorRole, 'permissions')
        : updateUserFromFile(id, permissions, operatorRole, 'permissions');
    if (isDualWrite()) syncUserToFile(user);
    return user;
}

export async function updateUserRole(id, role, operatorRole) {
    if (!ROLES.includes(role)) throw new Error('无效的角色: ' + role);
    if (!canManage(operatorRole, role)) throw new Error('无权分配该角色');

    const user = isDbEnabled()
        ? await updateUserFromDb(id, role, operatorRole, 'role')
        : updateUserFromFile(id, role, operatorRole, 'role');
    if (isDualWrite()) syncUserToFile(user);
    return user;
}

export async function setUserStatus(id, status, operatorRole) {
    const user = isDbEnabled()
        ? await updateUserFromDb(id, status, operatorRole, 'status')
        : updateUserFromFile(id, status, operatorRole, 'status');
    if (isDualWrite()) syncUserToFile(user);
    return user;
}

/**
 * 设置组员的所属组长（管理员 / 项目主管）。
 * leaderId 为空表示解除归属；目标必须是组长（team_leader）。
 */
export async function setUserLeader(id, leaderId, operator) {
    const operatorRole = typeof operator === 'string' ? operator : operator?.role;
    if (operatorRole !== 'admin' && operatorRole !== 'project_manager') {
        throw new Error('无权限：仅管理员或项目主管可调整成员归属');
    }

    const user = await getUserById(id);
    if (!user) throw new Error('用户不存在');
    if (user.role !== 'user') throw new Error('只能为组员设置所属组长');

    const target = String(leaderId || '').trim();
    if (target) {
        const leader = await getUserById(target);
        if (!leader || leader.role !== 'team_leader') throw new Error('所属组长必须是组长角色');
    }

    if (isDbEnabled()) {
        await exec('UPDATE users SET leader_id = $1 WHERE id = $2', [target, id]);
    }
    if (!isDbEnabled() || isDualWrite()) {
        const users = loadUsersFromFile();
        const targetUser = users.find((u) => u.id === id);
        if (targetUser) {
            targetUser.leaderId = target;
            saveUsersToFile(users);
        }
    }

    return getUserById(id);
}

export async function deleteUser(id, operatorRole) {
    if (isDbEnabled()) {
        await deleteUserFromDb(id, operatorRole);
        if (isDualWrite()) {
            saveUsersToFile(loadUsersFromFile().filter((u) => u.id !== id));
        }
        return;
    }
    const user = loadUsersFromFile().find((u) => u.id === id);
    if (!user) throw new Error('用户不存在');
    if (!canManage(operatorRole, user.role)) throw new Error('无权管理该用户');
    saveUsersToFile(loadUsersFromFile().filter((u) => u.id !== id));
}

/** dual 模式下把单条用户同步回文件 */
function syncUserToFile(user) {
    const users = loadUsersFromFile();
    const index = users.findIndex((u) => u.id === user.id);
    if (index >= 0) users[index] = user;
    else users.push(user);
    saveUsersToFile(users);
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
    setUserLeader,
    deleteUser,
    getCompanyTenantKey,
    setCompanyTenantKey,
    sanitizeUser,
};
