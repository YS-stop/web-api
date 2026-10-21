/**
 * db/importLegacy.js
 *
 * 把 library/ 下现有的 JSON 数据一次性导入 PostgreSQL。
 *
 * 用法（在 api/ 目录下）：
 *   node server/db/importLegacy.js                    导入全部 P0 数据
 *   node server/db/importLegacy.js --dry-run          只解析并统计，不连数据库
 *   node server/db/importLegacy.js --only=users,projects
 *   node server/db/importLegacy.js --truncate         先清空目标表再导入
 *
 * 特性：
 *   * 幂等：全部按主键 UPSERT，重复执行结果一致；
 *   * 分集/资产按项目整体重建（先删该项目旧行再插入），避免残留脏数据；
 *   * 单事务：任何一步失败整体回滚，不会留下半截数据；
 *   * --dry-run 不依赖数据库，可先确认解析结果与行数。
 *
 * 注意：媒体文件（图片/视频/音频）不进数据库，只导入其 .json 元数据。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '..', '..');

dotenv.config({ path: path.join(API_DIR, '.env') });

const { readJson } = await import('../utils/jsonStore.js');
const {
    LIBRARY_DIR,
    WORKFLOWS_DIR,
    PROJECT_WORKFLOWS_DIR,
    CHATS_DIR,
    ASSETS_DIR,
    IMAGES_DIR,
    VIDEOS_DIR,
    USERS_FILE,
    COMPANY_FILE,
    PROJECTS_FILE,
    CHANGE_REQUESTS_FILE,
} = await import('../utils/paths.js');

// ============================================================================
// 参数
// ============================================================================

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const truncate = args.includes('--truncate');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg
    ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
    : null;

/** 按 --only 过滤表名 */
function want(table) {
    return !ONLY || ONLY.has(table);
}

// ============================================================================
// 值转换
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));

const str = (v, def = '') => (v === null || v === undefined ? def : String(v));

const toInt = (v, def = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
};

/** 毫秒时间戳（video_tasks 沿用数字语义） */
const toMs = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** 任意时间表示 → ISO 字符串 */
const toIso = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const date = new Date(typeof v === 'number' ? v : String(v));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const safeDecode = (v) => {
    try {
        return decodeURIComponent(v);
    } catch {
        return v;
    }
};

// ============================================================================
// 采集：只读 library/，不依赖数据库
// ============================================================================

function collectCompany() {
    const data = readJson(COMPANY_FILE, {}) || {};
    const tenantKey = str(data.tenantKey);
    if (!tenantKey) return { rows: [], warnings: ['company.json 无 tenantKey，跳过'] };
    return {
        rows: [{ id: 1, tenant_key: tenantKey, name: str(data.name), updated_at: new Date().toISOString() }],
        warnings: [],
    };
}

function collectUsers() {
    const raw = readJson(USERS_FILE, []);
    const list = Array.isArray(raw) ? raw : [];
    const rows = [];
    const warnings = [];

    for (const user of list) {
        if (!user || !isUuid(user.id)) {
            warnings.push(`用户 id 非 UUID，跳过: ${str(user?.id)}`);
            continue;
        }
        if (!user.feishuOpenId) {
            warnings.push(`用户缺少 feishuOpenId（id=${user.id}），open_id 唯一索引会冲突，跳过`);
            continue;
        }
        rows.push({
            id: user.id,
            feishu_open_id: str(user.feishuOpenId),
            feishu_union_id: str(user.feishuUnionId),
            tenant_key: str(user.tenantKey),
            company_name: str(user.companyName),
            name: str(user.name),
            avatar_url: str(user.avatarUrl),
            role: str(user.role, 'user'),
            status: str(user.status, 'active'),
            permissions: user.permissions || {},
            created_at: toIso(user.createdAt),
            last_login_at: toIso(user.lastLoginAt),
        });
    }
    return { rows, warnings };
}

function collectProjects() {
    const raw = readJson(PROJECTS_FILE, []);
    const list = Array.isArray(raw) ? raw : [];

    const projects = [];
    const episodes = [];
    const assets = [];
    const warnings = [];
    const seenEpisode = new Set();

    for (const p of list) {
        if (!p || !isUuid(p.id)) {
            warnings.push(`项目 id 非 UUID，跳过: ${str(p?.id)}`);
            continue;
        }
        // 与 projectService 保持一致：历史演示种子数据不导入
        if (String(p.id).startsWith('seed-')) continue;

        projects.push({
            id: p.id,
            code: str(p.code),
            name: str(p.name, '未命名项目'),
            category: str(p.category),
            department: str(p.department),
            owner: str(p.owner),
            production_mode: str(p.productionMode),
            aspect_ratio: str(p.aspectRatio, '9:16'),
            target_duration: toInt(p.targetDuration, 0),
            script_source: str(p.scriptSource),
            script_name: str(p.scriptName),
            drama_name: str(p.dramaName),
            total_episodes: toInt(p.totalEpisodes, 0),
            stage: str(p.stage),
            done_episodes: toInt(p.doneEpisodes, 0),
            abnormal: p.abnormal === undefined ? null : p.abnormal,
            status: str(p.status),
            created_by: str(p.createdBy),
            created_at: toIso(p.createdAt),
            updated_at: toIso(p.updatedAt),
        });

        const analysis = p.scriptAnalysis;
        if (!analysis || typeof analysis !== 'object') continue;

        if (Array.isArray(analysis.episodes)) {
            analysis.episodes.forEach((ep, index) => {
                if (!ep) return;
                const episodeNo = toInt(ep.episode, index + 1);
                const key = `${p.id}:${episodeNo}`;
                if (seenEpisode.has(key)) {
                    warnings.push(`项目 ${p.id} 第 ${episodeNo} 集重复，保留后者`);
                    episodes.splice(episodes.findIndex((e) => e.project_id === p.id && e.episode_no === episodeNo), 1);
                }
                seenEpisode.add(key);
                episodes.push({
                    project_id: p.id,
                    episode_no: episodeNo,
                    title: str(ep.title),
                    summary: str(ep.summary),
                    word_count: toInt(ep.wordCount, 0),
                    duration_seconds: toInt(ep.durationSeconds, 0),
                    start_text: str(ep.startText),
                    content: str(ep.content),
                    assets: ep.assets === undefined ? null : ep.assets,
                });
            });
        }

        const assetGroups = [
            ['character', 'characters'],
            ['scene', 'scenes'],
            ['prop', 'props'],
        ];
        for (const [kind, key] of assetGroups) {
            const arr = Array.isArray(analysis.assets?.[key]) ? analysis.assets[key] : [];
            arr.forEach((item, index) => {
                if (!item) return;
                assets.push({
                    project_id: p.id,
                    kind,
                    name: str(item.name),
                    description: str(item.description),
                    bio: str(item.bio),
                    visual: str(item.visual),
                    episode_no: item.episode === undefined ? null : toInt(item.episode, 0),
                    sort_order: index,
                });
            });
        }
    }

    return { rows: { projects, episodes, assets }, warnings };
}

function collectChangeRequests() {
    const raw = readJson(CHANGE_REQUESTS_FILE, []);
    const list = Array.isArray(raw) ? raw : [];
    const rows = [];
    const warnings = [];

    for (const r of list) {
        if (!r || !isUuid(r.id)) {
            warnings.push(`变更申请 id 非 UUID，跳过: ${str(r?.id)}`);
            continue;
        }
        rows.push({
            id: r.id,
            project_id: str(r.projectId),
            project_code: str(r.projectCode),
            project_name: str(r.projectName),
            requester_id: str(r.requesterId),
            requester_name: str(r.requesterName),
            requester_role: str(r.requesterRole),
            changes: r.changes || {},
            reason: str(r.reason),
            status: str(r.status, 'pending'),
            approver_id: r.approverId ?? null,
            approver_name: r.approverName ?? null,
            created_at: toIso(r.createdAt),
            reviewed_at: toIso(r.reviewedAt),
        });
    }
    return { rows, warnings };
}

function collectWorkflows() {
    if (!fs.existsSync(WORKFLOWS_DIR)) return { rows: [], warnings: [] };
    const rows = [];
    const warnings = [];

    for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.json'))) {
        const data = readJson(path.join(WORKFLOWS_DIR, file), null);
        if (!data || !data.id) {
            warnings.push(`工作流文件无效，跳过: ${file}`);
            continue;
        }
        if (!isUuid(data.id)) {
            warnings.push(`工作流 id 非 UUID，跳过: ${data.id}`);
            continue;
        }
        const nodes = Array.isArray(data.nodes) ? data.nodes : [];
        rows.push({
            id: data.id,
            title: str(data.title, 'Untitled Workflow'),
            description: str(data.description),
            nodes,
            groups: Array.isArray(data.groups) ? data.groups : [],
            viewport: data.viewport ?? null,
            cover_url: data.coverUrl ?? null,
            node_count: nodes.length,
            user_id: data.userId ?? null,
            created_at: toIso(data.createdAt),
            updated_at: toIso(data.updatedAt),
        });
    }
    return { rows, warnings };
}

function collectProjectWorkflows() {
    if (!fs.existsSync(PROJECT_WORKFLOWS_DIR)) return { rows: [], warnings: [] };
    const rows = [];
    const warnings = [];

    for (const file of fs.readdirSync(PROJECT_WORKFLOWS_DIR).filter((f) => f.endsWith('.json'))) {
        const data = readJson(path.join(PROJECT_WORKFLOWS_DIR, file), null);
        if (!data) {
            warnings.push(`画布文件无法解析，跳过: ${file}`);
            continue;
        }

        // 文件名格式：{encodeURIComponent(projectId)}_ep{episode}.json，旧数据为 {projectId}.json
        const matched = /^(.*)_ep(\d+)\.json$/.exec(file);
        const projectId = matched ? safeDecode(matched[1]) : safeDecode(file.replace(/\.json$/, ''));
        const episodeNo = matched ? parseInt(matched[2], 10) : 1;
        if (!projectId) {
            warnings.push(`画布文件名无法解析出 projectId，跳过: ${file}`);
            continue;
        }

        const nodes = Array.isArray(data.nodes) ? data.nodes : [];
        rows.push({
            project_id: str(data.projectId || projectId),
            episode_no: toInt(data.episode, episodeNo),
            nodes,
            groups: Array.isArray(data.groups) ? data.groups : [],
            viewport: data.viewport ?? null,
            created_at: toIso(data.createdAt),
            updated_at: toIso(data.updatedAt),
        });
    }
    return { rows, warnings };
}

function collectVideoTasks() {
    const raw = readJson(path.join(LIBRARY_DIR, 'video-tasks.json'), {});
    const map = raw && typeof raw === 'object' ? raw : {};
    const rows = [];
    const warnings = [];

    for (const [key, task] of Object.entries(map)) {
        if (!task) continue;
        const taskId = str(task.taskId || key);
        if (!taskId) {
            warnings.push('视频任务缺少 taskId，跳过一条');
            continue;
        }
        rows.push({
            task_id: taskId,
            node_id: str(task.nodeId) || null,
            status: str(task.status),
            model_id: str(task.modelId),
            prompt: str(task.prompt),
            aspect_ratio: str(task.aspectRatio),
            resolution: str(task.resolution),
            duration: toInt(task.duration, 0),
            channel: str(task.channel),
            api_key: str(task.apiKey),
            error_count: toInt(task.errorCount, 0),
            error: task.error ?? null,
            result_url: task.resultUrl ?? null,
            created_at: toMs(task.createdAt),
            updated_at: toMs(task.updatedAt),
            finished_at: toMs(task.finishedAt),
        });
    }
    return { rows, warnings };
}

function collectMediaAssets() {
    const rows = [];
    const warnings = [];
    const seen = new Map();

    const scan = (dir, kind) => {
        if (!fs.existsSync(dir)) return;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            const data = readJson(path.join(dir, file), null);
            if (!data) {
                warnings.push(`素材元数据无法解析，跳过: ${kind}/${file}`);
                continue;
            }
            const id = str(data.id) || path.basename(file, '.json');
            const filename = str(data.filename);
            if (seen.has(id) && seen.get(id) !== kind) {
                warnings.push(`素材 id 在不同目录重复（${seen.get(id)} / ${kind}）: ${id}`);
            }
            seen.set(id, kind);

            // 未列出的字段原样留在 meta，避免丢信息
            const { id: _id, filename: _f, prompt: _p, model: _m, createdAt: _c, type: _t, aspectRatio, resolution, ...rest } = data;
            rows.push({
                id,
                kind,
                filename,
                url: filename ? `/library/${kind === 'image' ? 'images' : 'videos'}/${filename}` : '',
                prompt: str(data.prompt),
                model: str(data.model),
                aspect_ratio: aspectRatio ?? null,
                resolution: resolution ?? null,
                meta: rest,
                created_at: toIso(data.createdAt),
            });
        }
    };

    scan(IMAGES_DIR, 'image');
    scan(VIDEOS_DIR, 'video');
    return { rows, warnings };
}

function collectLibraryAssets() {
    const raw = readJson(path.join(ASSETS_DIR, 'assets.json'), []);
    const list = Array.isArray(raw) ? raw : [];
    const rows = [];
    const warnings = [];

    for (const asset of list) {
        if (!asset || !isUuid(asset.id)) {
            warnings.push(`素材库 id 非 UUID，跳过: ${str(asset?.id)}`);
            continue;
        }
        const { id, name, category, url, type, createdAt, ...meta } = asset;
        rows.push({
            id,
            name: str(name),
            category: str(category),
            url: str(url),
            type: str(type, 'image'),
            meta,
            created_at: toIso(createdAt),
        });
    }
    return { rows, warnings };
}

function collectChatSessions() {
    if (!fs.existsSync(CHATS_DIR)) return { rows: [], warnings: [] };
    const rows = [];
    const warnings = [];

    for (const file of fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json'))) {
        const data = readJson(path.join(CHATS_DIR, file), null);
        if (!data) {
            warnings.push(`会话文件无法解析，跳过: ${file}`);
            continue;
        }
        const id = str(data.id) || path.basename(file, '.json');
        rows.push({
            id,
            scope: str(data.scope, 'free'),
            topic: data.topic ?? null,
            messages: Array.isArray(data.messages) ? data.messages : [],
            created_at: toIso(data.createdAt),
            updated_at: toIso(data.updatedAt),
        });
    }
    return { rows, warnings };
}

// ============================================================================
// 写库
// ============================================================================

/** 表的写入策略 */
const TARGETS = [
    { table: 'company_settings', collect: collectCompany, pk: ['id'] },
    { table: 'users', collect: collectUsers, pk: ['id'], json: ['permissions'] },
    { table: 'projects', fromProjects: 'projects', pk: ['id'], json: ['abnormal'] },
    { table: 'project_episodes', fromProjects: 'episodes', pk: null, rebuildBy: 'project_id', rebuildCast: 'uuid', json: ['assets'] },
    { table: 'project_assets', fromProjects: 'assets', pk: null, rebuildBy: 'project_id', rebuildCast: 'uuid' },
    { table: 'change_requests', collect: collectChangeRequests, pk: ['id'], json: ['changes'] },
    { table: 'workflows', collect: collectWorkflows, pk: ['id'], json: ['nodes', 'groups', 'viewport'] },
    { table: 'project_workflows', collect: collectProjectWorkflows, pk: ['project_id', 'episode_no'], json: ['nodes', 'groups', 'viewport'] },
    { table: 'video_tasks', collect: collectVideoTasks, pk: ['task_id'] },
    { table: 'media_assets', collect: collectMediaAssets, pk: ['id'], json: ['meta'] },
    { table: 'library_assets', collect: collectLibraryAssets, pk: ['id'], json: ['meta'] },
    { table: 'chat_sessions', collect: collectChatSessions, pk: ['id'], json: ['messages'] },
];

function buildInsert(table, columns, jsonColumns) {
    const placeholders = columns
        .map((col, i) => (jsonColumns.includes(col) ? `$${i + 1}::jsonb` : `$${i + 1}`))
        .join(', ');
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
}

function buildUpsert(table, columns, jsonColumns, pk) {
    const insert = buildInsert(table, columns, jsonColumns);
    const updates = columns.filter((c) => !pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
    if (!updates.length) return `${insert} ON CONFLICT (${pk.join(', ')}) DO NOTHING`;
    return `${insert} ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${updates.join(', ')}`;
}

function rowParams(row, columns, jsonColumns) {
    return columns.map((col) => {
        const value = row[col];
        if (!jsonColumns.includes(col)) return value === undefined ? null : value;
        if (value === null || value === undefined) return null;
        return JSON.stringify(value);
    });
}

/**
 * 单事务写入。
 * @param {import('pg').PoolClient} client
 */
async function writeAll(client, plan) {
    for (const item of plan) {
        const { table, rows, pk, json = [], rebuildBy, rebuildCast = 'text' } = item;

        if (!rows.length) continue;

        if (truncate) {
            await client.query(`TRUNCATE TABLE ${table} CASCADE`);
        }

        const columns = Object.keys(rows[0]);

        if (rebuildBy) {
            // 分集 / 资产：按项目整体重建，避免删除分集后残留旧行
            const keys = [...new Set(rows.map((r) => r[rebuildBy]))];
            await client.query(`DELETE FROM ${table} WHERE ${rebuildBy} = ANY($1::${rebuildCast}[])`, [keys]);
            const insert = buildInsert(table, columns, json);
            for (const row of rows) {
                await client.query(insert, rowParams(row, columns, json));
            }
            continue;
        }

        const sql = buildUpsert(table, columns, json, pk);
        for (const row of rows) {
            await client.query(sql, rowParams(row, columns, json));
        }
    }
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
    console.log('============================================================');
    console.log('[import] 来源目录:', LIBRARY_DIR);
    console.log(`[import] 模式    : ${dryRun ? 'dry-run（不写库）' : '写入 PostgreSQL'}${truncate ? ' + truncate' : ''}`);
    if (ONLY) console.log('[import] 仅导入  :', [...ONLY].join(', '));
    console.log('============================================================');

    // 采集（project 只在 projects / episodes / assets 三表之间解析一次）
    const needsProjects = TARGETS.some((t) => t.fromProjects && want(t.table));
    const projectData = needsProjects ? collectProjects() : null;

    const plan = TARGETS.filter((t) => want(t.table)).map((target) => {
        const collected = target.fromProjects
            ? { rows: projectData.rows[target.fromProjects] || [], warnings: projectData.warnings }
            : target.collect();

        return {
            table: target.table,
            rows: Array.isArray(collected.rows) ? collected.rows : [],
            pk: target.pk,
            json: target.json || [],
            rebuildBy: target.rebuildBy,
            rebuildCast: target.rebuildCast,
            warnings: collected.warnings || [],
        };
    });

    let totalRows = 0;
    const summary = plan.map((item) => {
        totalRows += item.rows.length;
        item.warnings.slice(0, 5).forEach((w) => console.warn(`  [warn] ${item.table}: ${w}`));
        if (item.warnings.length > 5) {
            console.warn(`  [warn] ${item.table}: 另有 ${item.warnings.length - 5} 条警告`);
        }
        return { 表: item.table, 行数: item.rows.length, 警告: item.warnings.length };
    });

    console.table(summary);
    console.log(`[import] 合计 ${totalRows} 行`);

    if (dryRun) {
        for (const item of plan) {
            if (!item.rows.length) continue;
            console.log(`\n--- ${item.table} 首行预览 ---`);
            console.log(JSON.stringify(item.rows[0], null, 2).slice(0, 800));
        }
        console.log('\n[import] dry-run 完成：未连接数据库，未写入任何数据。');
        return;
    }

    const { transaction, closePool, describeTarget, healthCheck } = await import('./index.js');

    const health = await healthCheck();
    if (!health.ok) throw new Error(`数据库连接失败：${health.error}`);
    console.log(`[import] 已连接 ${describeTarget()}`);

    try {
        await transaction(async (client) => {
            await writeAll(client, plan);
        });
        console.log('[import] 全部数据已在单个事务内写入成功。');
    } finally {
        await closePool();
    }
}

main().catch((error) => {
    console.error('[import] 失败（事务已回滚）:', error.message);
    process.exitCode = 1;
});
