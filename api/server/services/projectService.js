/**
 * projectService.js
 *
 * 项目与「项目修改申请」服务。
 *
 * 存储层由 DB_DRIVER 决定：
 *   file = 继续读写 library/projects.json、library/change-requests.json（默认）
 *   db   = 读写 PostgreSQL（projects / project_episodes / project_assets / change_requests）
 *   dual = 写 PG 的同时保留文件副本（读以 PG 为准）
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
import { isDbEnabled, isDualWrite, exec, many, one, transaction } from '../db/index.js';
import { getUserById } from './userService.js';

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

// 是否有权新建项目（组员不能新建）
export function canCreateProject(role) {
    return ROLE_RANK[role] >= ROLE_RANK.team_leader;
}

// 是否有权分配项目归属组长（管理员 / 项目主管）
export function canAssignProject(role) {
    return role === 'admin' || role === 'project_manager';
}

/**
 * 项目可见性（数据隔离的唯一判定入口）：
 *  - 管理员 / 项目主管：全部项目
 *  - 组长：仅自己名下的项目（leader_id = 自己）
 *  - 组员：仅自己所属组长名下的项目
 */
export function canViewProject(user, project) {
    if (!user || !project) return false;
    if (user.role === 'admin' || user.role === 'project_manager') return true;
    if (user.role === 'team_leader') return (project.leaderId || '') === user.id;
    if (user.role === 'user') {
        return !!user.leaderId && (project.leaderId || '') === user.leaderId;
    }
    return false;
}

/** 内存过滤：列表 / 文件驱动统一走这里，避免两条路径规则不一致。 */
function filterVisibleProjects(projects, user) {
    if (!user) return [];
    return projects.filter((project) => canViewProject(user, project));
}

// ============================================================================
// 通用映射
// ============================================================================

/** 前端字段名 → 数据库列名 */
const PROJECT_COLUMNS = {
    name: 'name',
    category: 'category',
    department: 'department',
    owner: 'owner',
    productionMode: 'production_mode',
    aspectRatio: 'aspect_ratio',
    targetDuration: 'target_duration',
    scriptSource: 'script_source',
    scriptName: 'script_name',
    dramaName: 'drama_name',
    totalEpisodes: 'total_episodes',
};

/** 前端字段名 → JSON 字段名（scriptAnalysis 拆表时使用） */
const ASSET_GROUPS = [
    ['character', 'characters'],
    ['scene', 'scenes'],
    ['prop', 'props'],
];

const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

/** 数据库行 → 前端项目对象（不含 scriptAnalysis） */
function rowToProject(row) {
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        category: row.category,
        department: row.department,
        owner: row.owner,
        productionMode: row.production_mode,
        aspectRatio: row.aspect_ratio,
        targetDuration: row.target_duration,
        scriptSource: row.script_source,
        scriptName: row.script_name,
        dramaName: row.drama_name,
        totalEpisodes: row.total_episodes,
        stage: row.stage,
        doneEpisodes: row.done_episodes,
        abnormal: row.abnormal === undefined ? null : row.abnormal,
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        createdBy: row.created_by,
        leaderId: row.leader_id || '',
        /** 归属组长姓名（列表查询 LEFT JOIN users 带出；详情查询可能为空） */
        leaderName: row.leader_name || '',
    };
}

function rowToRequest(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        projectCode: row.project_code,
        projectName: row.project_name,
        requesterId: row.requester_id,
        requesterName: row.requester_name,
        requesterRole: row.requester_role,
        changes: row.changes || {},
        reason: row.reason,
        status: row.status,
        approverId: row.approver_id,
        approverName: row.approver_name,
        createdAt: iso(row.created_at),
        reviewedAt: iso(row.reviewed_at),
    };
}

function pickEditable(fields) {
    const out = {};
    EDITABLE_FIELDS.forEach((k) => {
        if (fields && fields[k] !== undefined) out[k] = fields[k];
    });
    return out;
}

// ============================================================================
// 文件实现（原逻辑，DB_DRIVER=file 时使用）
// ============================================================================

function loadJson(file, fallback) {
    return readJson(file, fallback);
}

function saveJson(file, data) {
    writeJsonSync(file, data);
}

/**
 * 读取项目列表（文件版）：
 * - 文件不存在时返回空数组；
 * - 顺带清理历史遗留的演示种子项目（id 以 seed- 开头）。
 */
function loadProjectsFromFile() {
    const raw = loadJson(PROJECTS_FILE, []);
    const list = Array.isArray(raw) ? raw : [];
    const cleaned = list.filter((p) => !String(p?.id || '').startsWith('seed-'));
    if (cleaned.length !== list.length) {
        saveJson(PROJECTS_FILE, cleaned);
    }
    return cleaned;
}

function loadRequestsFromFile() {
    const raw = loadJson(REQUESTS_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

function createProjectFromFile(data, user) {
    const projects = loadProjectsFromFile();
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
        // 归属组长：组长自建 = 自己；主管 / 管理员可指派（未指派为空，仅上级可见）
        leaderId: data.leaderId || '',
        // 新建项目时保存「剧本分集 + 资产」分析结果（供项目画布展示）
        scriptAnalysis: data.scriptAnalysis || null,
    };

    projects.push(project);
    saveJson(PROJECTS_FILE, projects);
    return project;
}

function updateProjectFromFile(id, fields) {
    const projects = loadProjectsFromFile();
    const project = projects.find((p) => p.id === id);
    if (!project) throw new Error('项目不存在');

    const changes = pickEditable(fields);
    if (Object.keys(changes).length === 0) throw new Error('没有需要修改的字段');

    Object.assign(project, changes);
    project.updatedAt = new Date().toISOString();
    saveJson(PROJECTS_FILE, projects);
    return project;
}

function createChangeRequestFromFile(project, changes, reason, user) {
    const requests = loadRequestsFromFile();
    const now = new Date().toISOString();
    const request = {
        id: crypto.randomUUID(),
        projectId: project.id,
        projectCode: project.code,
        projectName: project.name,
        requesterId: user.id,
        requesterName: user.name,
        requesterRole: user.role,
        changes,
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

function reviewChangeRequestFromFile(requestId, approve, user) {
    const requests = loadRequestsFromFile();
    const request = requests.find((r) => r.id === requestId);
    if (!request) throw new Error('申请不存在');
    if (request.status !== 'pending') throw new Error('该申请已处理');

    const now = new Date().toISOString();
    request.status = approve ? 'approved' : 'rejected';
    request.approverId = user.id;
    request.approverName = user.name;
    request.reviewedAt = now;

    if (approve) {
        const projects = loadProjectsFromFile();
        const project = projects.find((p) => p.id === request.projectId);
        if (project) {
            Object.assign(project, request.changes);
            project.updatedAt = now;
            saveJson(PROJECTS_FILE, projects);
        }
    }

    saveJson(REQUESTS_FILE, requests);
    return request;
}

// ============================================================================
// PostgreSQL 实现
// ============================================================================

/** 写入分集与资产（先清空该项目旧数据，避免残留） */
async function saveScriptAnalysis(client, projectId, analysis) {
    await client.query('DELETE FROM project_episodes WHERE project_id = $1', [projectId]);
    await client.query('DELETE FROM project_assets WHERE project_id = $1', [projectId]);
    if (!analysis || typeof analysis !== 'object') return;

    const episodes = Array.isArray(analysis.episodes) ? analysis.episodes : [];
    for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i] || {};
        await client.query(
            `INSERT INTO project_episodes
                (project_id, episode_no, title, summary, word_count, duration_seconds, start_text, content, assets)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT (project_id, episode_no) DO UPDATE SET
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                word_count = EXCLUDED.word_count,
                duration_seconds = EXCLUDED.duration_seconds,
                start_text = EXCLUDED.start_text,
                content = EXCLUDED.content,
                assets = EXCLUDED.assets`,
            [
                projectId,
                Number(ep.episode) || i + 1,
                ep.title || '',
                ep.summary || '',
                Number(ep.wordCount) || 0,
                Number(ep.durationSeconds) || 0,
                ep.startText || '',
                ep.content || '',
                ep.assets === undefined || ep.assets === null ? null : JSON.stringify(ep.assets),
            ],
        );
    }

    for (const [kind, key] of ASSET_GROUPS) {
        const list = Array.isArray(analysis.assets?.[key]) ? analysis.assets[key] : [];
        for (let i = 0; i < list.length; i++) {
            const item = list[i] || {};
            await client.query(
                `INSERT INTO project_assets
                    (project_id, kind, name, description, bio, visual, episode_no, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    projectId,
                    kind,
                    item.name || '',
                    item.description || '',
                    item.bio || '',
                    item.visual || '',
                    item.episode === undefined || item.episode === null ? null : Number(item.episode),
                    i,
                ],
            );
        }
    }
}

/** 读取 scriptAnalysis（分集 + 资产），没有数据时返回 null */
async function loadScriptAnalysis(projectId) {
    const episodeRows = await many(
        'SELECT * FROM project_episodes WHERE project_id = $1 ORDER BY episode_no',
        [projectId],
    );
    const assetRows = await many(
        'SELECT * FROM project_assets WHERE project_id = $1 ORDER BY kind, sort_order',
        [projectId],
    );
    if (episodeRows.length === 0 && assetRows.length === 0) return null;

    const assets = { characters: [], scenes: [], props: [] };
    const kindToKey = { character: 'characters', scene: 'scenes', prop: 'props' };
    for (const row of assetRows) {
        const key = kindToKey[row.kind] || 'characters';
        const item = { name: row.name, description: row.description };
        // 只在原数据里存在时补上可选字段，避免前端出现空键
        if (row.bio) item.bio = row.bio;
        if (row.visual) item.visual = row.visual;
        assets[key].push(item);
    }

    return {
        totalEpisodes: episodeRows.length,
        episodes: episodeRows.map((row) => ({
            episode: row.episode_no,
            title: row.title,
            summary: row.summary,
            wordCount: row.word_count,
            durationSeconds: row.duration_seconds,
            startText: row.start_text,
            content: row.content,
            assets: row.assets || { characters: [], scenes: [], props: [] },
        })),
        assets,
    };
}

/** 下一个项目编号（XM-P-n） */
async function nextProjectCode(client) {
    const row = (await client.query(
        `SELECT COALESCE(MAX((regexp_match(code, '(\\d+)\\s*$'))[1]::int), 0) AS max FROM projects`,
    )).rows[0];
    return 'XM-P-' + (Number(row?.max || 0) + 1);
}

async function createProjectFromDb(data, user) {
    return transaction(async (client) => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const code = await nextProjectCode(client);

        await client.query(
            `INSERT INTO projects
                (id, code, name, category, department, owner, production_mode, aspect_ratio,
                 target_duration, script_source, script_name, drama_name, total_episodes,
                 stage, done_episodes, abnormal, status, created_by, created_at, updated_at, leader_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [
                id,
                code,
                data.name || '未命名项目',
                data.category || '',
                data.department || '',
                data.owner || '',
                data.productionMode || '人工逐节点',
                data.aspectRatio || '9:16',
                Number(data.targetDuration) || 90,
                data.scriptSource || '',
                data.scriptName || '',
                data.dramaName || '',
                Number(data.totalEpisodes) || 0,
                '等待确认拆集',
                0,
                null,
                '待启动',
                user ? user.id : '',
                now,
                now,
                data.leaderId || '',
            ],
        );

        if (data.scriptAnalysis) {
            await saveScriptAnalysis(client, id, data.scriptAnalysis);
        }

        const row = (await client.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
        const project = rowToProject(row);
        project.scriptAnalysis = await loadScriptAnalysis(id);
        return project;
    });
}

async function updateProjectFromDb(id, fields) {
    const changes = pickEditable(fields);
    if (Object.keys(changes).length === 0) throw new Error('没有需要修改的字段');

    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(changes)) {
        params.push(value);
        sets.push(`${PROJECT_COLUMNS[key]} = $${params.length}`);
    }
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    params.push(id);

    const result = await exec(
        `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
        params,
    );
    if (result.rowCount === 0) throw new Error('项目不存在');

    return getProjectFromDb(id);
}

async function getProjectFromDb(id) {
    const row = await one('SELECT * FROM projects WHERE id = $1', [id]);
    if (!row) return null;
    const project = rowToProject(row);
    project.scriptAnalysis = await loadScriptAnalysis(id);
    return project;
}

const PROJECT_LIST_COLUMNS = `p.id, p.code, p.name, p.category, p.department, p.owner, p.production_mode, p.aspect_ratio,
        p.target_duration, p.script_source, p.script_name, p.drama_name, p.total_episodes,
        p.stage, p.done_episodes, p.abnormal, p.status, p.created_by, p.created_at, p.updated_at, p.leader_id,
        u.name AS leader_name`;

// projects.leader_id 是 TEXT、users.id 是 UUID，JOIN 时显式转成 text 比较
const PROJECT_LIST_FROM = 'FROM projects p LEFT JOIN users u ON u.id::text = p.leader_id';

const PROJECT_LIST_ORDER = 'ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST';

async function listProjectsFromDb(user) {
    // 安全默认：没有用户上下文时不返回任何项目
    if (!user) return [];

    if (user.role === 'admin' || user.role === 'project_manager') {
        const rows = await many(`SELECT ${PROJECT_LIST_COLUMNS} ${PROJECT_LIST_FROM} ${PROJECT_LIST_ORDER}`);
        return rows.map(rowToProject);
    }

    // 组长：仅自己名下的项目（同级互相不可见）
    if (user.role === 'team_leader') {
        const rows = await many(
            `SELECT ${PROJECT_LIST_COLUMNS} ${PROJECT_LIST_FROM} WHERE p.leader_id = $1 ${PROJECT_LIST_ORDER}`,
            [user.id],
        );
        return rows.map(rowToProject);
    }

    // 组员：仅所属组长名下的项目；未绑定组长则看不到任何项目
    if (user.role === 'user' && user.leaderId) {
        const rows = await many(
            `SELECT ${PROJECT_LIST_COLUMNS} ${PROJECT_LIST_FROM} WHERE p.leader_id = $1 ${PROJECT_LIST_ORDER}`,
            [user.leaderId],
        );
        return rows.map(rowToProject);
    }

    return [];
}

async function createChangeRequestFromDb(project, changes, reason, user) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await exec(
        `INSERT INTO change_requests
            (id, project_id, project_code, project_name, requester_id, requester_name, requester_role,
             changes, reason, status, approver_id, approver_name, created_at, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',NULL,NULL,$10,NULL)`,
        [
            id,
            project.id,
            project.code || '',
            project.name || '',
            user.id,
            user.name || '',
            user.role || '',
            JSON.stringify(changes || {}),
            reason || '',
            now,
        ],
    );
    const row = await one('SELECT * FROM change_requests WHERE id = $1', [id]);
    return rowToRequest(row);
}

async function listChangeRequestsFromDb(user) {
    if (user.role !== 'admin' && user.role !== 'project_manager') return [];
    const rows = user.role === 'admin'
        ? await many('SELECT * FROM change_requests ORDER BY created_at DESC NULLS LAST')
        : await many(
            `SELECT * FROM change_requests
             WHERE requester_role = 'team_leader'
             ORDER BY created_at DESC NULLS LAST`,
        );
    return rows.map(rowToRequest);
}

async function reviewChangeRequestFromDb(requestId, approve, user) {
    return transaction(async (client) => {
        const found = (await client.query('SELECT * FROM change_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
        if (!found) throw new Error('申请不存在');
        if (found.status !== 'pending') throw new Error('该申请已处理');

        const now = new Date().toISOString();
        await client.query(
            'UPDATE change_requests SET status = $1, approver_id = $2, approver_name = $3, reviewed_at = $4 WHERE id = $5',
            [approve ? 'approved' : 'rejected', user.id, user.name || '', now, requestId],
        );

        if (approve) {
            const changes = found.changes || {};
            const entries = Object.entries(changes).filter(([key]) => PROJECT_COLUMNS[key]);
            if (entries.length > 0) {
                const sets = [];
                const params = [];
                for (const [key, value] of entries) {
                    params.push(value);
                    sets.push(`${PROJECT_COLUMNS[key]} = $${params.length}`);
                }
                params.push(now);
                sets.push(`updated_at = $${params.length}`);
                params.push(found.project_id);
                await client.query(
                    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length}`,
                    params,
                );
            }
        }

        const row = (await client.query('SELECT * FROM change_requests WHERE id = $1', [requestId])).rows[0];
        return rowToRequest(row);
    });
}

// ============================================================================
// 对外接口（按驱动分流）
// ============================================================================

export async function listProjects(user) {
    if (!isDbEnabled()) {
        const list = loadProjectsFromFile()
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
            // 列表接口剔除重量级的剧本分集/资产，详情再单独拉取
            .map(({ scriptAnalysis, ...rest }) => rest);
        return filterVisibleProjects(list, user);
    }
    return listProjectsFromDb(user);
}

/** 读取项目详情；传 user 时校验可见性（越权视为不存在）。 */
export async function getProject(id, user) {
    const project = isDbEnabled()
        ? await getProjectFromDb(id)
        : loadProjectsFromFile().find((p) => p.id === id) || null;

    if (!project) return null;
    if (user && !canViewProject(user, project)) return null;
    return project;
}

/** 分配项目归属组长（管理员 / 项目主管）。leaderId 为空表示收回为「未分配」。 */
export async function assignProjectLeader(projectId, leaderId, user) {
    if (!canAssignProject(user?.role)) {
        throw new Error('无权限：仅管理员或项目主管可分配项目');
    }

    const project = await getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const target = String(leaderId || '').trim();
    if (target) {
        const leader = await getUserById(target);
        if (!leader || leader.role !== 'team_leader') {
            throw new Error('只能分配给组长（team_leader）');
        }
    }

    const now = new Date().toISOString();
    if (isDbEnabled()) {
        await exec('UPDATE projects SET leader_id = $1, updated_at = $2 WHERE id = $3', [target, now, projectId]);
    } else {
        const projects = loadProjectsFromFile();
        const targetProject = projects.find((p) => p.id === projectId);
        if (!targetProject) throw new Error('项目不存在');
        targetProject.leaderId = target;
        targetProject.updatedAt = now;
        saveJson(PROJECTS_FILE, projects);
    }

    if (isDualWrite()) {
        const projects = loadProjectsFromFile();
        const targetProject = projects.find((p) => p.id === projectId);
        if (targetProject) {
            targetProject.leaderId = target;
            targetProject.updatedAt = now;
            saveJson(PROJECTS_FILE, projects);
        }
    }

    return getProject(projectId);
}

export async function createProject(data, user) {
    if (!canCreateProject(user?.role)) {
        throw new Error('无权限：组员不能新建项目');
    }

    // 归属组长：组长只能建自己的项目；主管 / 管理员可指派（不指派则为「未分配」）
    let leaderId = '';
    if (user.role === 'team_leader') {
        leaderId = user.id;
    } else {
        const requested = String(data?.leaderId || '').trim();
        if (requested) {
            const leader = await getUserById(requested);
            if (!leader || leader.role !== 'team_leader') {
                throw new Error('归属组长必须是组长（team_leader）');
            }
            leaderId = leader.id;
        }
    }

    const payload = { ...data, leaderId };
    const project = isDbEnabled()
        ? await createProjectFromDb(payload, user)
        : createProjectFromFile(payload, user);

    // dual：PG 为主，文件保留一份副本
    if (isDualWrite()) {
        const projects = loadProjectsFromFile();
        projects.push(project);
        saveJson(PROJECTS_FILE, projects);
    }
    return project;
}

export async function updateProject(id, fields, user) {
    const project = isDbEnabled()
        ? await updateProjectFromDb(id, fields)
        : updateProjectFromFile(id, fields);

    if (isDualWrite()) {
        const projects = loadProjectsFromFile();
        const target = projects.find((p) => p.id === id);
        if (target) {
            Object.assign(target, project);
            saveJson(PROJECTS_FILE, projects);
        }
    }
    return project;
}

/**
 * 发起「申请修改」（组长）。
 * changes 为期望的字段新值（仅含要改的字段）。
 */
export async function createChangeRequest(projectId, changes, reason, user) {
    const project = await getProject(projectId);
    if (!project) throw new Error('项目不存在');
    if (!canViewProject(user, project)) throw new Error('无权限：不能对他人项目发起申请');

    const cleanChanges = pickEditable(changes);
    if (Object.keys(cleanChanges).length === 0) throw new Error('没有需要修改的字段');

    const request = isDbEnabled()
        ? await createChangeRequestFromDb(project, cleanChanges, reason, user)
        : createChangeRequestFromFile(project, cleanChanges, reason, user);

    if (isDualWrite()) {
        const requests = loadRequestsFromFile();
        requests.push(request);
        saveJson(REQUESTS_FILE, requests);
    }
    return request;
}

/**
 * 审批申请列表（按审批者角色过滤）。
 * 管理员看所有；项目主管看组长提交的申请。
 */
export async function listChangeRequests(user) {
    if (isDbEnabled()) return listChangeRequestsFromDb(user);

    const all = loadRequestsFromFile();
    if (user.role === 'admin') return all;
    if (user.role === 'project_manager') return all.filter((r) => r.requesterRole === 'team_leader');
    return [];
}

/**
 * 审批（通过 / 拒绝）。通过时把 changes 应用到项目。
 */
export async function reviewChangeRequest(requestId, approve, user) {
    const request = isDbEnabled()
        ? await reviewChangeRequestFromDb(requestId, approve, user)
        : reviewChangeRequestFromFile(requestId, approve, user);

    if (isDualWrite()) {
        const requests = loadRequestsFromFile();
        const target = requests.find((r) => r.id === requestId);
        if (target) {
            Object.assign(target, request);
            saveJson(REQUESTS_FILE, requests);
        }
    }
    return request;
}

export default {
    ROLE_RANK,
    EDITABLE_FIELDS,
    canEditProject,
    canRequestChange,
    canApprove,
    canCreateProject,
    canAssignProject,
    canViewProject,
    listProjects,
    getProject,
    createProject,
    updateProject,
    assignProjectLeader,
    createChangeRequest,
    listChangeRequests,
    reviewChangeRequest,
};
