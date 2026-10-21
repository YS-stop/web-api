/**
 * workflows.js
 *
 * 工作流与项目画布持久化。
 *   POST   /api/workflows
 *   GET    /api/workflows
 *   GET    /api/workflows/:id
 *   DELETE /api/workflows/:id
 *   PUT    /api/workflows/:id/cover
 *   GET    /api/public-workflows
 *   GET    /api/public-workflows/:id
 *   GET    /api/project-workflows/:projectId/:episode
 *   POST   /api/project-workflows/:projectId/:episode
 *
 * 存储层由 DB_DRIVER 决定（file / db / dual）。
 * public-workflows 是随仓库打包的模板（public/workflows），始终走文件，不入库。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WORKFLOWS_DIR, PROJECT_WORKFLOWS_DIR, PUBLIC_WORKFLOWS_DIR } from '../utils/paths.js';
import { sanitizeWorkflowNodes } from '../utils/workflowSanitize.js';
import { resolveInside } from '../utils/safePath.js';
import { isDbEnabled, isDualWrite, exec, one, many } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { canViewProject } from '../services/projectService.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

/**
 * 工作流文件路径（防目录逃逸）。
 * 不校验时 `/api/workflows/..%2Fusers` 会读到 library/users.json。
 * @returns {string|null} 逃逸时返回 null
 */
function workflowFile(id) {
    return resolveInside(WORKFLOWS_DIR, `${id}.json`);
}

/** 公共工作流文件路径（防目录逃逸） */
function publicWorkflowFile(id) {
    return resolveInside(PUBLIC_WORKFLOWS_DIR, `${id}.json`);
}

/** 数据库行 → 前端工作流对象 */
function rowToWorkflow(row) {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        nodes: row.nodes || [],
        groups: row.groups || [],
        viewport: row.viewport,
        coverUrl: row.cover_url,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
}

// ============================================================================
// 用户工作流
// ============================================================================

// Save/Update workflow
router.post('/workflows', async (req, res) => {
    try {
        const workflow = req.body;
        if (!workflow.id) {
            workflow.id = crypto.randomUUID();
        }
        // 数据库主键为 UUID：旧的非 UUID id 在 db 模式下重新生成
        if (isDbEnabled() && !UUID_RE.test(String(workflow.id))) {
            workflow.id = crypto.randomUUID();
        }
        workflow.updatedAt = new Date().toISOString();
        if (!workflow.createdAt) {
            workflow.createdAt = workflow.updatedAt;
        }

        // Sanitize nodes: convert any base64 data to file URLs before saving
        if (workflow.nodes) {
            workflow.nodes = sanitizeWorkflowNodes(workflow.nodes);
        }

        if (isDbEnabled()) {
            // Preserve existing coverUrl if it exists
            const existing = await one('SELECT cover_url FROM workflows WHERE id = $1', [workflow.id]);
            if (existing?.cover_url && !workflow.coverUrl) {
                workflow.coverUrl = existing.cover_url;
            }

            const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
            await exec(
                `INSERT INTO workflows
                    (id, title, description, nodes, groups, viewport, cover_url, node_count, user_id, created_at, updated_at)
                 VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)
                 ON CONFLICT (id) DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    nodes = EXCLUDED.nodes,
                    groups = EXCLUDED.groups,
                    viewport = EXCLUDED.viewport,
                    cover_url = EXCLUDED.cover_url,
                    node_count = EXCLUDED.node_count,
                    updated_at = EXCLUDED.updated_at`,
                [
                    workflow.id,
                    workflow.title || 'Untitled Workflow',
                    workflow.description || '',
                    JSON.stringify(nodes),
                    JSON.stringify(Array.isArray(workflow.groups) ? workflow.groups : []),
                    workflow.viewport === undefined || workflow.viewport === null ? null : JSON.stringify(workflow.viewport),
                    workflow.coverUrl ?? null,
                    nodes.length,
                    workflow.userId ?? null,
                    workflow.createdAt,
                    workflow.updatedAt,
                ],
            );
        }

        // dual 模式保留文件副本（与 PG 内容一致）
        if (!isDbEnabled() || isDualWrite()) {
            const filePath = workflowFile(workflow.id);
            if (!filePath) {
                return res.status(400).json({ error: 'Invalid workflow id' });
            }

            // Preserve existing coverUrl if it exists
            if (fs.existsSync(filePath)) {
                try {
                    const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if (existingData.coverUrl) {
                        workflow.coverUrl = existingData.coverUrl;
                    }
                } catch (readError) {
                    console.warn('Could not read existing workflow to preserve cover:', readError);
                }
            }

            fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));
        }

        res.json({ success: true, id: workflow.id });
    } catch (error) {
        console.error('Save workflow error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- Public Workflows API (bundled examples) ---

// List public workflows (shipped with the repo in public/workflows/)
// Dynamically scans directory - no need to maintain index.json manually
router.get('/public-workflows', async (req, res) => {
    try {
        const publicWorkflowsDir = PUBLIC_WORKFLOWS_DIR;

        if (!fs.existsSync(publicWorkflowsDir)) {
            return res.json([]);
        }

        // Scan all .json files except index.json
        const files = fs.readdirSync(publicWorkflowsDir)
            .filter(f => f.endsWith('.json') && f !== 'index.json');

        const workflows = files.map(file => {
            try {
                const content = fs.readFileSync(path.join(publicWorkflowsDir, file), 'utf8');
                const workflow = JSON.parse(content);

                // Generate description from workflow content
                const nodeTypes = workflow.nodes?.reduce((acc, n) => {
                    acc[n.type] = (acc[n.type] || 0) + 1;
                    return acc;
                }, {}) || {};
                const typesSummary = Object.entries(nodeTypes)
                    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
                    .join(', ');
                const description = workflow.description ||
                    (typesSummary ? `Workflow with ${typesSummary}` : 'A public workflow template');

                return {
                    id: file.replace('.json', ''),
                    title: workflow.title || 'Untitled Workflow',
                    description,
                    nodeCount: workflow.nodes?.length || 0,
                    coverUrl: workflow.coverUrl || null
                };
            } catch (parseError) {
                console.warn(`Skipping invalid workflow file: ${file}`, parseError.message);
                return null;
            }
        }).filter(Boolean); // Remove any null entries from parse errors

        // Sort by title alphabetically
        workflows.sort((a, b) => a.title.localeCompare(b.title));

        res.json(workflows);
    } catch (error) {
        console.error("List public workflows error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Load specific public workflow
router.get('/public-workflows/:id', async (req, res) => {
    try {
        const filePath = publicWorkflowFile(req.params.id);

        if (!filePath) {
            return res.status(400).json({ error: "Invalid public workflow id" });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Public workflow not found" });
        }

        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Load public workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- User Workflows API ---

// List all workflows
router.get('/workflows', async (req, res) => {
    try {
        if (isDbEnabled()) {
            const rows = await many(
                `SELECT id, title, created_at, updated_at, node_count, cover_url
                 FROM workflows
                 ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
            );
            return res.json(rows.map((row) => ({
                id: row.id,
                title: row.title,
                createdAt: iso(row.created_at),
                updatedAt: iso(row.updated_at),
                nodeCount: row.node_count,
                coverUrl: row.cover_url,
            })));
        }

        const files = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
        const workflows = files.map(file => {
            const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
            const workflow = JSON.parse(content);
            return {
                id: workflow.id,
                title: workflow.title,
                createdAt: workflow.createdAt,
                updatedAt: workflow.updatedAt,
                nodeCount: workflow.nodes?.length || 0,
                coverUrl: workflow.coverUrl
            };
        });
        workflows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        res.json(workflows);
    } catch (error) {
        console.error("List workflows error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Load specific workflow
router.get('/workflows/:id', async (req, res) => {
    try {
        if (isDbEnabled()) {
            if (!UUID_RE.test(String(req.params.id))) {
                return res.status(404).json({ error: 'Workflow not found' });
            }
            const row = await one('SELECT * FROM workflows WHERE id = $1', [req.params.id]);
            if (!row) {
                return res.status(404).json({ error: 'Workflow not found' });
            }
            return res.json(rowToWorkflow(row));
        }

        const filePath = workflowFile(req.params.id);
        if (!filePath) {
            return res.status(400).json({ error: "Invalid workflow id" });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Load workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete workflow
router.delete('/workflows/:id', async (req, res) => {
    try {
        let removed = false;

        if (isDbEnabled()) {
            if (UUID_RE.test(String(req.params.id))) {
                const result = await exec('DELETE FROM workflows WHERE id = $1', [req.params.id]);
                removed = result.rowCount > 0;
            }
        }

        const filePath = workflowFile(req.params.id);
        if (!isDbEnabled() || isDualWrite()) {
            if (!filePath) {
                return res.status(400).json({ error: "Invalid workflow id" });
            }
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                removed = true;
            }
        }

        if (!removed) {
            return res.status(404).json({ error: "Workflow not found" });
        }
        res.json({ success: true });
    } catch (error) {
        console.error("Delete workflow error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Update workflow cover
router.put('/workflows/:id/cover', async (req, res) => {
    try {
        const { coverUrl } = req.body;

        if (isDbEnabled()) {
            if (!UUID_RE.test(String(req.params.id))) {
                return res.status(404).json({ error: 'Workflow not found' });
            }
            const result = await exec(
                'UPDATE workflows SET cover_url = $1, updated_at = now() WHERE id = $2',
                [coverUrl, req.params.id],
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Workflow not found' });
            }
        }

        if (!isDbEnabled() || isDualWrite()) {
            const filePath = workflowFile(req.params.id);
            if (!filePath) {
                return res.status(400).json({ error: "Invalid workflow id" });
            }
            if (!fs.existsSync(filePath)) {
                if (isDbEnabled()) return res.json({ success: true, coverUrl });
                return res.status(404).json({ error: "Workflow not found" });
            }
            const workflowData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            workflowData.coverUrl = coverUrl;
            fs.writeFileSync(filePath, JSON.stringify(workflowData, null, 2));
        }

        res.json({ success: true, coverUrl });
    } catch (error) {
        console.error("Update cover error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Project Canvas Persistence API ---
// 项目画布节点持久化：按「projectId + 集号」独立存储，实现分集隔离画布。
// file 模式：每个剧集一个文件 {projectId}_ep{episode}.json，兼容旧的 {projectId}.json（视为第 1 集）。
// db 模式：project_workflows(project_id, episode_no)。

// encodeURIComponent 已把 `/`、`..` 转义成文件名安全字符，再叠加一次目录逃逸校验做双保险。
const projectWorkflowFile = (projectId, episode) =>
    resolveInside(PROJECT_WORKFLOWS_DIR, `${encodeURIComponent(projectId)}_ep${encodeURIComponent(episode)}.json`);
const legacyProjectWorkflowFile = (projectId) =>
    resolveInside(PROJECT_WORKFLOWS_DIR, `${encodeURIComponent(projectId)}.json`);

/**
 * 项目画布数据隔离：确认项目存在且当前用户可见。
 * 越权一律返回 404，避免通过状态码探测项目是否存在。
 */
async function ensureProjectVisible(req, res) {
    const projectId = String(req.params.projectId || '');
    if (!UUID_RE.test(projectId)) {
        res.status(404).json({ error: '项目不存在或无权限访问' });
        return false;
    }
    const row = await one('SELECT leader_id FROM projects WHERE id = $1', [projectId]);
    if (!row) {
        res.status(404).json({ error: '项目不存在或无权限访问' });
        return false;
    }
    if (!canViewProject(req.user, { leaderId: row.leader_id || '' })) {
        res.status(404).json({ error: '项目不存在或无权限访问' });
        return false;
    }
    return true;
}

// Load project canvas for a given episode (returns null if not yet saved)
router.get('/project-workflows/:projectId/:episode', requireAuth, async (req, res) => {
    try {
        if (!(await ensureProjectVisible(req, res))) return;
        const { projectId, episode } = req.params;
        const episodeNo = parseInt(episode, 10) || 1;

        if (isDbEnabled()) {
            const row = await one(
                'SELECT * FROM project_workflows WHERE project_id = $1 AND episode_no = $2',
                [projectId, episodeNo],
            );
            if (!row) return res.json(null);
            return res.json({
                nodes: row.nodes || [],
                groups: row.groups || [],
                viewport: row.viewport,
                projectId: row.project_id,
                episode: String(row.episode_no),
                createdAt: iso(row.created_at),
                updatedAt: iso(row.updated_at),
            });
        }

        let filePath = projectWorkflowFile(projectId, episode);
        // 兼容旧数据：第 1 集尚无独立文件时，回退到旧的全局画布文件
        if (!fs.existsSync(filePath) && episode === '1') {
            const legacy = legacyProjectWorkflowFile(projectId);
            if (fs.existsSync(legacy)) filePath = legacy;
        }
        if (!fs.existsSync(filePath)) {
            return res.json(null);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(content));
    } catch (error) {
        console.error("Load project canvas error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Save project canvas for a given episode (nodes + viewport)
router.post('/project-workflows/:projectId/:episode', requireAuth, async (req, res) => {
    try {
        if (!(await ensureProjectVisible(req, res))) return;
        const { projectId, episode } = req.params;
        const episodeNo = parseInt(episode, 10) || 1;
        const data = req.body || {};
        data.projectId = projectId;
        data.episode = episode;
        data.updatedAt = new Date().toISOString();
        if (!data.createdAt) {
            data.createdAt = data.updatedAt;
        }
        // Sanitize nodes: convert any base64 data to file URLs before saving
        if (data.nodes) {
            data.nodes = sanitizeWorkflowNodes(data.nodes);
        }

        if (isDbEnabled()) {
            await exec(
                `INSERT INTO project_workflows
                    (project_id, episode_no, nodes, groups, viewport, created_at, updated_at)
                 VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
                 ON CONFLICT (project_id, episode_no) DO UPDATE SET
                    nodes = EXCLUDED.nodes,
                    groups = EXCLUDED.groups,
                    viewport = EXCLUDED.viewport,
                    updated_at = EXCLUDED.updated_at`,
                [
                    projectId,
                    episodeNo,
                    JSON.stringify(Array.isArray(data.nodes) ? data.nodes : []),
                    JSON.stringify(Array.isArray(data.groups) ? data.groups : []),
                    data.viewport === undefined || data.viewport === null ? null : JSON.stringify(data.viewport),
                    data.createdAt,
                    data.updatedAt,
                ],
            );
        }

        if (!isDbEnabled() || isDualWrite()) {
            const filePath = projectWorkflowFile(projectId, episode);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Save project canvas error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
