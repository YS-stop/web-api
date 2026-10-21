/**
 * imageTaskRunner.js
 *
 * 图片生成任务的后台执行器。
 *
 * 背景
 * ─────────────────────────────────────────────────────────────
 * 图片生成原来是「前端同步等待」：AssetConfirmPanel 里 await /api/generate-image，
 * 后端生成完才返回。用户切页 / 刷新时前端组件销毁，剩余批量任务直接丢失，
 * 已发出的结果也写不回资产。
 *
 * 现在改为「提交即返回 + 服务端后台执行」：
 *   1. 提交任务后立刻持久化（db image_tasks / library/image-tasks.json）；
 *   2. 后台按全局并发队列调用图片 provider，成功后落盘并写 media_assets；
 *   3. 进程重启时恢复 running 任务继续执行；
 *   4. 前端 /generate-image/status/:taskId 只读任务状态，不承担生成职责。
 *
 * 与 videoTaskRunner 的区别：
 *   图片厂商是「同步 API」（调用一次即等出图），没有 taskId 可轮询，
 *   因此后台是「直接执行生成」，而非「轮询厂商状态」。
 */

import path from 'path';
import { LIBRARY_DIR, IMAGES_DIR } from '../utils/paths.js';
import { readJson, updateJson } from '../utils/jsonStore.js';
import { saveBufferToFile } from '../utils/imageHelpers.js';
import { generateImageBuffer } from './imageGeneration.js';
import { isDbEnabled, isDualWrite, exec, many, one } from '../db/index.js';
import { upsertMediaAsset } from '../db/mediaAssets.js';

// ============================================================================
// 配置
// ============================================================================

/** 任务持久化文件 */
const TASKS_FILE = path.join(LIBRARY_DIR, 'image-tasks.json');

/** 全局图片生成并发上限（与前端 BATCH_CONCURRENCY 及 modelChannel 默认值对齐） */
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.IMAGE_MAX_CONCURRENT || '3', 10));

/** 已完成任务保留多久（便于前端重复查询） */
const FINISHED_TTL = 24 * 60 * 60 * 1000;

/** 正在执行的任务集合 */
const running = new Set();

/** 排队中的任务 */
const queue = [];

// ============================================================================
// 存储
// ============================================================================

/** 数据库行 → 任务对象 */
function rowToTask(row) {
    return {
        taskId: row.task_id,
        nodeId: row.node_id,
        status: row.status,
        modelId: row.model_id,
        prompt: row.prompt,
        aspectRatio: row.aspect_ratio,
        resolution: row.resolution,
        channel: row.channel,
        params: row.params || {},
        errorCount: row.error_count,
        error: row.error ?? undefined,
        resultUrl: row.result_url ?? undefined,
        createdAt: row.created_at === null ? undefined : Number(row.created_at),
        updatedAt: row.updated_at === null ? undefined : Number(row.updated_at),
        finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
    };
}

/** 读取全部任务（文件版） */
function readTasksFromFile() {
    const data = readJson(TASKS_FILE, {});
    return data && typeof data === 'object' ? data : {};
}

/** 读取全部任务：db 模式返回 { taskId: task } */
async function readTasks() {
    if (!isDbEnabled()) return readTasksFromFile();

    const rows = await many('SELECT * FROM image_tasks');
    const map = {};
    for (const row of rows) {
        const task = rowToTask(row);
        map[task.taskId] = task;
    }
    return map;
}

/** 读取单个任务 */
async function readTask(taskId) {
    if (!isDbEnabled()) return readTasksFromFile()[taskId];
    const row = await one('SELECT * FROM image_tasks WHERE task_id = $1', [taskId]);
    return row ? rowToTask(row) : undefined;
}

/** 写入单个任务（db 模式 UPSERT；dual 模式同时保留文件） */
async function saveTask(task) {
    if (isDbEnabled()) {
        await exec(
            `INSERT INTO image_tasks
                (task_id, node_id, status, model_id, prompt, aspect_ratio, resolution,
                 channel, params, error_count, error, result_url, created_at, updated_at, finished_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (task_id) DO UPDATE SET
                node_id = EXCLUDED.node_id,
                status = EXCLUDED.status,
                model_id = EXCLUDED.model_id,
                prompt = EXCLUDED.prompt,
                aspect_ratio = EXCLUDED.aspect_ratio,
                resolution = EXCLUDED.resolution,
                channel = EXCLUDED.channel,
                params = EXCLUDED.params,
                error_count = EXCLUDED.error_count,
                error = EXCLUDED.error,
                result_url = EXCLUDED.result_url,
                updated_at = EXCLUDED.updated_at,
                finished_at = EXCLUDED.finished_at`,
            [
                task.taskId,
                task.nodeId || null,
                task.status || 'running',
                task.modelId || '',
                task.prompt || '',
                task.aspectRatio || '',
                task.resolution || '',
                task.channel || '',
                JSON.stringify(task.params || {}),
                Number(task.errorCount) || 0,
                task.error || null,
                task.resultUrl || null,
                task.createdAt || null,
                task.updatedAt || null,
                task.finishedAt || null,
            ],
        );
    }

    if (!isDbEnabled() || isDualWrite()) {
        await updateJson(TASKS_FILE, (current) => {
            const all = current && typeof current === 'object' ? current : {};
            all[task.taskId] = task;
            return all;
        }, {});
    }
}

/** 对外可见的任务视图（剔除参考图等大字段） */
export function publicTask(task) {
    if (!task) return null;
    return {
        taskId: task.taskId,
        nodeId: task.nodeId || null,
        status: task.status,
        modelId: task.modelId,
        resultUrl: task.resultUrl,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

// ============================================================================
// 调度（全局并发队列）
// ============================================================================

/** 入队并尝试执行 */
function enqueue(taskId) {
    if (running.has(taskId) || queue.includes(taskId)) return;
    queue.push(taskId);
    pump();
}

/** 从队列取出任务，直到达到并发上限 */
function pump() {
    while (running.size < MAX_CONCURRENT && queue.length > 0) {
        const taskId = queue.shift();
        running.add(taskId);
        executeTask(taskId)
            .catch((error) => {
                console.error(`[ImageTask] 执行异常 ${taskId}:`, error.message);
            })
            .finally(() => {
                running.delete(taskId);
                pump();
            });
    }
}

/** 执行单个任务：生成 → 落盘 → 写元数据 → 更新状态 */
async function executeTask(taskId) {
    const task = await readTask(taskId);
    if (!task || task.status !== 'running') return;

    try {
        const { imageBuffer, imageFormat } = await generateImageBuffer({
            prompt: task.prompt,
            imageModel: task.modelId,
            aspectRatio: task.aspectRatio,
            resolution: task.resolution,
            imageBase64: task.params?.imageBase64,
            klingReferenceMode: task.params?.klingReferenceMode,
            klingFaceIntensity: task.params?.klingFaceIntensity,
            klingSubjectIntensity: task.params?.klingSubjectIntensity,
            channel: task.channel,
        });

        const saved = saveBufferToFile(imageBuffer, IMAGES_DIR, 'img', imageFormat);

        // 以 nodeId 命名元数据：前端 `/api/generation-status/:nodeId` 靠它恢复结果
        const metadataId = task.nodeId || task.taskId;
        const metadata = {
            id: metadataId,
            filename: saved.filename,
            prompt: task.prompt || '',
            model: task.modelId || 'gemini-pro',
            createdAt: new Date().toISOString(),
            type: 'images',
        };
        await upsertMediaAsset(metadata, 'images');

        await saveTask({
            ...task,
            status: 'succeeded',
            resultUrl: saved.url,
            error: undefined,
            updatedAt: Date.now(),
            finishedAt: Date.now(),
        });

        console.log(`[ImageTask] 任务完成 ${taskId} → ${saved.url} (nodeId=${task.nodeId || '-'})`);
    } catch (error) {
        await saveTask({
            ...task,
            status: 'failed',
            error: error.message || '图片生成失败',
            updatedAt: Date.now(),
            finishedAt: Date.now(),
        });
        console.warn(`[ImageTask] 任务失败 ${taskId}: ${error.message}`);
    }
}

// ============================================================================
// 对外接口
// ============================================================================

/**
 * 提交图片生成任务并排队执行。
 * @returns {Promise<object>} 对外可见的任务信息（含 taskId）
 */
export async function submitImageTask(params) {
    const {
        nodeId,
        prompt,
        aspectRatio,
        resolution,
        imageModel,
        channel = 'free',
        imageBase64,
        klingReferenceMode,
        klingFaceIntensity,
        klingSubjectIntensity,
    } = params;

    // 直接用 nodeId 作为 taskId：前端恢复 / generation-status 都按 nodeId 查询
    const taskId = nodeId || `image-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const task = {
        taskId,
        nodeId: nodeId || null,
        status: 'running',
        modelId: imageModel || '',
        prompt: prompt || '',
        aspectRatio: aspectRatio || '',
        resolution: resolution || '',
        channel,
        params: {
            imageBase64: imageBase64 ?? null,
            klingReferenceMode: klingReferenceMode ?? null,
            klingFaceIntensity: klingFaceIntensity ?? null,
            klingSubjectIntensity: klingSubjectIntensity ?? null,
        },
        errorCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    await saveTask(task);
    enqueue(taskId);

    cleanupOldTasks().catch((error) => console.warn('[ImageTask] 清理过期任务失败:', error.message));

    console.log(`[ImageTask] 任务已提交 ${taskId} (nodeId=${nodeId || '-'}, model=${imageModel || '-'})`);
    return publicTask(task);
}

/** 查询任务（不含参考图等大字段） */
export async function getImageTask(taskId) {
    const task = await readTask(taskId);
    return publicTask(task);
}

/** 清理过期的已完成任务 */
export async function cleanupOldTasks() {
    const now = Date.now();

    if (isDbEnabled()) {
        await exec(
            `DELETE FROM image_tasks
             WHERE status <> 'running'
               AND COALESCE(finished_at, updated_at, 0) < $1`,
            [now - FINISHED_TTL],
        );
    }

    if (!isDbEnabled() || isDualWrite()) {
        await updateJson(TASKS_FILE, (current) => {
            const all = current && typeof current === 'object' ? current : {};
            for (const [id, task] of Object.entries(all)) {
                if (!task) { delete all[id]; continue; }
                if (task.status !== 'running' && now - (task.finishedAt || task.updatedAt || 0) > FINISHED_TTL) {
                    delete all[id];
                }
            }
            return all;
        }, {});
    }
}

/**
 * 服务启动时恢复未完成任务：进程重启（--watch / 部署）后继续生成并落盘。
 */
export async function restoreImageTasks() {
    const tasks = await readTasks();
    const pending = Object.values(tasks).filter((t) => t && t.status === 'running');

    let resumed = 0;
    for (const task of pending) {
        if (!task.taskId) continue;
        enqueue(task.taskId);
        resumed += 1;
    }

    if (resumed > 0) {
        console.log(`[ImageTask] 已恢复 ${resumed} 个未完成的图片任务`);
    }
    cleanupOldTasks().catch((error) => console.warn('[ImageTask] 清理过期任务失败:', error.message));
    return resumed;
}

/** 当前排队 + 执行中的任务数（诊断用） */
export function getActiveTaskCount() {
    return running.size + queue.length;
}
