/**
 * projectService.js
 *
 * 项目与「项目修改申请」服务（JSON 文件存储，符合现有项目无数据库风格）。
 *
 * 权限规则：
 *  - 管理员(admin)：特例，可直接编辑项目，也可审批所有申请。
 *  - 项目主管(project_manager)：可直接编辑项目（无需向管理员申请），审批组长的申请。
 *  - 组长(team_leader)：不能直接编辑，需发起「申请修改」反馈给主管。
 *  - 组员(user)：只能查看，既不能编辑也不能发起申请。
 */

import crypto from 'crypto';
import { readJson, writeJsonSync } from '../utils/jsonStore.js';
import { PROJECTS_FILE, CHANGE_REQUESTS_FILE as REQUESTS_FILE } from '../utils/paths.js';

export const ROLE_RANK = {
    admin: 3,
    project_manager: 2,
    team_leader: 1,
    user: 0,
};

// 「新建项目的内容」中可被编辑/申请修改的字段
export const EDITABLE_FIELDS = [
    'name',
    'category',
    'department',
    'owner',
    'productionMode',
    'aspectRatio',
    'targetDuration',
    'scriptSource',
    'scriptName',
    'dramaName',
    'totalEpisodes',
];

// 是否有权直接编辑项目（管理员 / 项目主管）
export function canEditProject(role) {
    return role === 'admin' || role === 'project_manager';
}

// 是否有权发起「申请修改」（组长）
export function canRequestChange(role) {
    return role === 'team_leader';
}

// 是否有权审批申请（管理员 / 项目主管）
export function canApprove(role) {
    return role === 'admin' || role === 'project_manager';
}

// ============================================================================
// 底层读写
// ============================================================================

function loadJson(file, fallback) {
    return readJson(file, fallback);
}

function saveJson(file, data) {
    writeJsonSync(file, data);
}

// ============================================================================
// 项目加载
// ============================================================================

/**
 * 读取项目列表：不做任何演示数据注入。
 * - 文件不存在时返回空数组，首页展示空状态；
 * - 顺带清理历史遗留的演示种子项目（id 以 seed- 开头），避免首页出现假数据。
 */
function loadProjects() {
    const raw = loadJson(PROJECTS_FILE, []);
    const list = Array.isArray(raw) ? raw : [];
    const cleaned = list.filter((p) => !String(p?.id || '').startsWith('seed-'));
    if (cleaned.length !== list.length) {
        saveJson(PROJECTS_FILE, cleaned);
    }
    return cleaned;
}

function loadRequests() {
    return loadJson(REQUESTS_FILE, []);
}

// ============================================================================
// 项目
// ============================================================================

export function listProjects() {
    return loadProjects()
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        // 列表接口剔除重量级的剧本分集/资产，详情再单独拉取
        .map(({ scriptAnalysis, ...rest }) => rest);
}

export function getProject(id) {
    return loadProjects().find(p => p.id === id) || null;
}

function pickEditable(fields) {
    const out = {};
    EDITABLE_FIELDS.forEach(k => {
        if (fields && fields[k] !== undefined) out[k] = fields[k];
    });
    return out;
}

export function createProject(data, user) {
    const projects = loadProjects();
    const maxCode = projects.reduce((max, p) => {
        const m = String(p.code || '').match(/(\d+)\s*$/);
        const n = m ? parseInt(m[1], 10) : 0;
        return Math.max(max, isNaN(n) ? 0 : n);
    }, 0);

    const now = new Date().toISOString();
    const project = {
        id: crypto.randomUUID(),
        code: 'XM-P-' + (maxCode + 1),
        name: data.name || '未命名项目',
        category: data.category || '',
        department: data.department || '',
        owner: data.owner || '',
        productionMode: data.productionMode || '人工逐节点',
        aspectRatio: data.aspectRatio || '9:16',
        targetDuration: Number(data.targetDuration) || 90,
        scriptSource: data.scriptSource || '',
        scriptName: data.scriptName || '',
        dramaName: data.dramaName || '',
        totalEpisodes: Number(data.totalEpisodes) || 0,
        // 进度相关字段由前端根据实际制作数据动态计算，这里只存初始值
        stage: '等待确认拆集',
        doneEpisodes: 0,
        abnormal: null,
        status: '待启动',
        createdAt: now,
        updatedAt: now,
        createdBy: user ? user.id : '',
        // 新建项目时保存「剧本分集 + 资产」分析结果（供项目画布展示）
        scriptAnalysis: data.scriptAnalysis || null,
    };

    projects.push(project);
    saveJson(PROJECTS_FILE, projects);
    return project;
}

/**
 * 直接编辑项目（仅管理员 / 项目主管）。
 * 只更新可编辑字段，其余（阶段/进度/状态等）保持不变。
 */
export function updateProject(id, fields, user) {
    const projects = loadProjects();
    const project = projects.find(p => p.id === id);
    if (!project) throw new Error('项目不存在');

    const changes = pickEditable(fields);
    if (Object.keys(changes).length === 0) throw new Error('没有需要修改的字段');

    Object.assign(project, changes);
    project.updatedAt = new Date().toISOString();
    saveJson(PROJECTS_FILE, projects);
    return project;
}

// ============================================================================
// 变更申请
// ============================================================================

/**
 * 发起「申请修改」（组长）。
 * changes 为期望的字段新值（仅含要改的字段）。
 */
export function createChangeRequest(projectId, changes, reason, user) {
    const project = getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const cleanChanges = pickEditable(changes);
    if (Object.keys(cleanChanges).length === 0) throw new Error('没有需要修改的字段');

    const requests = loadRequests();
    const now = new Date().toISOString();
    const request = {
        id: crypto.randomUUID(),
        projectId,
        projectCode: project.code,
        projectName: project.name,
        requesterId: user.id,
        requesterName: user.name,
        requesterRole: user.role,
        changes: cleanChanges,
        reason: reason || '',
        status: 'pending',
        approverId: null,
        approverName: null,
        createdAt: now,
        reviewedAt: null,
    };

    requests.push(request);
    saveJson(REQUESTS_FILE, requests);
    return request;
}

/**
 * 审批申请列表（按审批者角色过滤）。
 * 管理员看所有；项目主管看组长提交的申请。
 */
export function listChangeRequests(user) {
    const all = loadRequests();
    if (user.role === 'admin') return all;
    if (user.role === 'project_manager') return all.filter(r => r.requesterRole === 'team_leader');
    return [];
}

/**
 * 审批（通过 / 拒绝）。通过时把 changes 应用到项目。
 */
export function reviewChangeRequest(requestId, approve, user) {
    const requests = loadRequests();
    const request = requests.find(r => r.id === requestId);
    if (!request) throw new Error('申请不存在');
    if (request.status !== 'pending') throw new Error('该申请已处理');

    const now = new Date().toISOString();
    request.status = approve ? 'approved' : 'rejected';
    request.approverId = user.id;
    request.approverName = user.name;
    request.reviewedAt = now;

    if (approve) {
        const projects = loadProjects();
        const project = projects.find(p => p.id === request.projectId);
        if (project) {
            Object.assign(project, request.changes);
            project.updatedAt = now;
            saveJson(PROJECTS_FILE, projects);
        }
    }

    saveJson(REQUESTS_FILE, requests);
    return request;
}

export default {
    ROLE_RANK,
    EDITABLE_FIELDS,
    canEditProject,
    canRequestChange,
    canApprove,
    listProjects,
    getProject,
    createProject,
    updateProject,
    createChangeRequest,
    listChangeRequests,
    reviewChangeRequest,
};
