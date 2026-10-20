/**
 * projectService.ts
 *
 * 项目与「项目修改申请」的前端类型定义与 API 封装。
 * 权限规则（与后端 projectService 保持一致）：
 *  - 管理员 / 项目主管：可直接编辑项目。
 *  - 组长：可发起「申请修改」。
 *  - 组员：只能查看。
 */

import type { ScriptAnalysis } from './scriptAnalysisService';

export interface Project {
    id: string;
    code: string;
    name: string;
    category: string;
    department: string;
    owner: string;
    productionMode: string;
    aspectRatio: string;
    targetDuration: number;
    scriptSource: string;
    scriptName: string;
    dramaName: string;
    totalEpisodes: number;
    stage: string;
    doneEpisodes: number;
    abnormal: number | null;
    status: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    /** 新建项目时产生的「剧本分集 + 资产」分析结果（项目画布展示用） */
    scriptAnalysis?: ScriptAnalysis | null;
}

/** 「新建项目的内容」中可编辑 / 可申请修改的字段 */
export interface ProjectEditableFields {
    name?: string;
    category?: string;
    department?: string;
    owner?: string;
    productionMode?: string;
    aspectRatio?: string;
    targetDuration?: number;
    scriptSource?: string;
    scriptName?: string;
    dramaName?: string;
    totalEpisodes?: number;
    /** 新建项目时随创建请求一并保存的剧本分集/资产（不参与编辑表单） */
    scriptAnalysis?: ScriptAnalysis | null;
}

export interface ChangeRequest {
    id: string;
    projectId: string;
    projectCode: string;
    projectName: string;
    requesterId: string;
    requesterName: string;
    requesterRole: string;
    changes: ProjectEditableFields;
    reason: string;
    status: 'pending' | 'approved' | 'rejected';
    approverId: string | null;
    approverName: string | null;
    createdAt: string;
    reviewedAt: string | null;
}

/** 项目「内容类型」可选项（新建项目下拉 / 列表筛选 / 详情编辑共用） */
export const CONTENT_TYPES: string[] = [
    '国内真人',
    '2D动画',
    '2D精致韩漫',
    '3D国漫',
    '3D建模',
    '3D皮克斯',
    '3D拟真人国内',
];

/** 制作部门选项（新建 / 编辑项目共用） */
export const DEPARTMENTS: string[] = ['短剧制作部', '漫剧制作部', '内容部'];

/** 项目负责人选项（新建 / 编辑项目共用） */
export const OWNERS: string[] = ['林雪琪', '江云天', '黄强', '内容制作组'];

/** 生产模式选项（新建 / 编辑项目共用） */
export const PRODUCTION_MODES: string[] = ['全自动', '人工逐节点'];

/** 默认画幅选项（新建 / 项目设置共用） */
export const ASPECT_RATIOS: string[] = ['9:16', '16:9', '1:1', '4:3', '3:4'];

/** 可编辑字段的中文标签（详情 / 编辑 / 申请表单复用） */
export const FIELD_LABELS: Record<string, string> = {
    name: '项目名称',
    category: '内容类型',
    department: '制作部门',
    owner: '项目负责人',
    productionMode: '生产模式',
    aspectRatio: '默认画幅',
    targetDuration: '单集目标时长（秒）',
    scriptSource: '剧本来源',
    scriptName: '锁定剧本',
    dramaName: '剧目名',
    totalEpisodes: '总集数',
};

/** 可编辑字段的展示顺序 */
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
] as const;

const TOKEN_KEY = 'twitcanva_auth_token';

function token(): string {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) || '' : '';
}

function authHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token() };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

async function handle<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as any).error || ('请求失败 (' + resp.status + ')'));
    }
    return resp.json() as Promise<T>;
}

// 项目列表
export async function fetchProjects(): Promise<Project[]> {
    const resp = await fetch('/api/projects', { headers: authHeaders() });
    const data = await handle<{ projects: Project[] }>(resp);
    return data.projects;
}

// 项目详情
export async function fetchProject(id: string): Promise<Project> {
    const resp = await fetch('/api/projects/' + id, { headers: authHeaders() });
    const data = await handle<{ project: Project }>(resp);
    return data.project;
}

// 新建项目
export async function createProject(data: ProjectEditableFields): Promise<Project> {
    const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(data),
    });
    const r = await handle<{ project: Project }>(resp);
    return r.project;
}

// 直接编辑项目（管理员 / 项目主管）
export async function updateProject(id: string, fields: ProjectEditableFields): Promise<Project> {
    const resp = await fetch('/api/projects/' + id, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify(fields),
    });
    const r = await handle<{ project: Project }>(resp);
    return r.project;
}

// 发起申请修改（组长）
export async function submitChangeRequest(id: string, changes: ProjectEditableFields, reason: string): Promise<ChangeRequest> {
    const resp = await fetch('/api/projects/' + id + '/change-requests', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ changes, reason }),
    });
    const r = await handle<{ request: ChangeRequest }>(resp);
    return r.request;
}

// 审批申请列表（管理员 / 项目主管）
export async function fetchChangeRequests(): Promise<ChangeRequest[]> {
    const resp = await fetch('/api/projects/change-requests', { headers: authHeaders() });
    const data = await handle<{ requests: ChangeRequest[] }>(resp);
    return data.requests;
}

// 审批（通过 / 拒绝）
export async function reviewChangeRequest(requestId: string, approve: boolean): Promise<ChangeRequest> {
    const resp = await fetch('/api/projects/change-requests/' + requestId, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ approve }),
    });
    const r = await handle<{ request: ChangeRequest }>(resp);
    return r.request;
}

// 权限判断（与后端一致）
export function canEditProject(role?: string): boolean {
    return role === 'admin' || role === 'project_manager';
}
export function canRequestChange(role?: string): boolean {
    return role === 'team_leader';
}
export function canApprove(role?: string): boolean {
    return role === 'admin' || role === 'project_manager';
}
