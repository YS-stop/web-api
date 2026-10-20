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
 * 由 server/index.js 内联代码搬出，逻辑保持不变；挂载在 /api 下。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WORKFLOWS_DIR, PROJECT_WORKFLOWS_DIR, PUBLIC_WORKFLOWS_DIR } from '../utils/paths.js';
import { sanitizeWorkflowNodes } from '../utils/workflowSanitize.js';
import { resolveInside } from '../utils/safePath.js';

const router = express.Router();

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

// Save/Update workflow
router.post('/workflows', async (req, res) => {
    try {
        const workflow = req.body;
        if (!workflow.id) {
            workflow.id = crypto.randomUUID();
        }
        workflow.updatedAt = new Date().toISOString();
        if (!workflow.createdAt) {
            workflow.createdAt = workflow.updatedAt;
        }


        const filePath = workflowFile(workflow.id);
        if (!filePath) {
            return res.status(400).json({ error: "Invalid workflow id" });
        }

        // Preserve existing coverUrl if it exists
        if (fs.existsSync(filePath)) {
            try {
                const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (existingData.coverUrl) {
                    workflow.coverUrl = existingData.coverUrl;
                }
            } catch (readError) {
                console.warn("Could not read existing workflow to preserve cover:", readError);
            }
        }

        // Sanitize nodes: convert any base64 data to file URLs before saving
        if (workflow.nodes) {
            workflow.nodes = sanitizeWorkflowNodes(workflow.nodes);
        }

        fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));


        res.json({ success: true, id: workflow.id });
    } catch (error) {
        console.error("Save workflow error:", error);
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
        const filePath = workflowFile(req.params.id);
        if (!filePath) {
            return res.status(400).json({ error: "Invalid workflow id" });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }
        fs.unlinkSync(filePath);
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
        const filePath = workflowFile(req.params.id);

        if (!filePath) {
            return res.status(400).json({ error: "Invalid workflow id" });
        }

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: "Workflow not found" });
        }

        const workflowData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        workflowData.coverUrl = coverUrl;
        fs.writeFileSync(filePath, JSON.stringify(workflowData, null, 2));

        res.json({ success: true, coverUrl });
    } catch (error) {
        console.error("Update cover error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Project Canvas Persistence API ---
// 项目画布节点持久化：按「projectId + 集号」独立存储，实现分集隔离画布。
// 每个剧集一个文件 {projectId}_ep{episode}.json，互不干扰、独立保存。
// 兼容旧数据：旧的 {projectId}.json（全局单画布）作为第 1 集的初始画布回退读取。

// encodeURIComponent 已把 `/`、`..` 转义成文件名安全字符，再叠加一次目录逃逸校验做双保险。
const projectWorkflowFile = (projectId, episode) =>
    resolveInside(PROJECT_WORKFLOWS_DIR, `${encodeURIComponent(projectId)}_ep${encodeURIComponent(episode)}.json`);
const legacyProjectWorkflowFile = (projectId) =>
    resolveInside(PROJECT_WORKFLOWS_DIR, `${encodeURIComponent(projectId)}.json`);

// Load project canvas for a given episode (returns null if not yet saved)
router.get('/project-workflows/:projectId/:episode', async (req, res) => {
    try {
        const { projectId, episode } = req.params;
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
router.post('/project-workflows/:projectId/:episode', async (req, res) => {
    try {
        const { projectId, episode } = req.params;
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
        const filePath = projectWorkflowFile(projectId, episode);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (error) {
        console.error("Save project canvas error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
