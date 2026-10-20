/**
 * videoTaskRunner.js
 *
 * Seedance 视频任务的后台执行器。
 *
 * 背景
 * ─────────────────────────────────────────────────────────────
 * 原来的异步接口是「客户端轮询式」：提交后只有前端来查状态时，
 * 服务端才去问厂商、下载产物并落盘。用户关页面/切页面后没人轮询，
 * 任务即使厂商侧已完成也不会落盘，结果只能重新生成。
 *
 * 现在改为「服务端自己轮询」：
 *   1. 提交任务后立刻持久化到 library/video-tasks.json；
 *   2. 后台定时查询厂商状态，成功后下载并写 library/videos/<nodeId>.json；
 *   3. 进程重启时从任务文件恢复未完成任务，继续轮询；
 *   4. 前端 /generate-video/status/:taskId 只读任务状态，不再承担落盘职责。
 *
 * 说明
 * ─────────────────────────────────────────────────────────────
 * - 任务记录里的 apiKey 仅存于本地运行时文件（library/ 已被 git 忽略），
 *   接口返回前会剔除，不对外泄露。
 * - 文件读写走 jsonStore：原子写 + 串行化，避免并发丢任务。
 */

import fs from 'fs';
import path from 'path';
import { LIBRARY_DIR, VIDEOS_DIR } from '../utils/paths.js';
import { readJson, updateJson } from '../utils/jsonStore.js';
import { saveBufferToFile } from '../utils/imageHelpers.js';
import { createSeedanceTask, querySeedanceTask } from './doubao.js';

// ============================================================================
// 配置
// ============================================================================

/** 任务持久化文件 */
const TASKS_FILE = path.join(LIBRARY_DIR, 'video-tasks.json');

/** 轮询间隔（毫秒），与 doubao.js 的默认值保持一致 */
const POLL_INTERVAL = parseInt(process.env.SEEDANCE_POLL_INTERVAL || '10', 10) * 1000;

/** 单任务最长等待（毫秒）：厂商侧 10 分钟，额外留 1 分钟下载余量 */
const MAX_WAIT = parseInt(process.env.SEEDANCE_MAX_WAIT || '600', 10) * 1000 + 60 * 1000;

/** 连续查询失败多少次判定任务失败（网络抖动容忍） */
const MAX_CONSECUTIVE_ERRORS = 5;

/** 已完成任务在文件中保留多久（便于前端重复查询） */
const FINISHED_TTL = 24 * 60 * 60 * 1000;

/** taskId -> 定时器 */
const timers = new Map();

// ============================================================================
// 存储
// ============================================================================

/** 读取全部任务 */
function readTasks() {
    const data = readJson(TASKS_FILE, {});
    return data && typeof data === 'object' ? data : {};
}

/** 写入单个任务（串行化，避免并发覆盖） */
async function saveTask(task) {
    await updateJson(TASKS_FILE, (current) => {
        const all = current && typeof current === 'object' ? current : {};
        all[task.taskId] = task;
        return all;
    }, {});
}

/** 对外可见的任务视图（剔除密钥等内部字段） */
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
// 调度
// ============================================================================

/** 安排下一次轮询 */
function schedule(taskId, delay = POLL_INTERVAL) {
    const prev = timers.get(taskId);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
        timers.delete(taskId);
        pollTask(taskId).catch((error) => {
            console.error(`[VideoTask] 轮询异常 ${taskId}:`, error.message);
            // 异常已在 pollTask 内部做退避，这里兜底避免任务彻底停摆
            schedule(taskId, POLL_INTERVAL * 2);
        });
    }, Math.max(1000, delay));

    // 不阻止进程退出（测试和优雅关闭更友好）
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(taskId, timer);
}

/** 任务失败收尾 */
async function finalizeFailed(taskId, error) {
    const task = readTasks()[taskId];
    if (!task || task.status !== 'running') return;
    await saveTask({
        ...task,
        status: 'failed',
        error: error || '视频生成失败',
        updatedAt: Date.now(),
        finishedAt: Date.now(),
    });
    const prev = timers.get(taskId);
    if (prev) clearTimeout(prev);
    timers.delete(taskId);
    console.warn(`[VideoTask] 任务失败 ${taskId}: ${error}`);
}

/** 任务成功收尾：下载 + 落盘 + 写元数据（结构与同步接口一致） */
async function finalizeSucceeded(task, videoUrl) {
    const resp = await fetch(videoUrl);
    if (!resp.ok) {
        throw new Error(`下载生成视频失败（${resp.status}）`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const saved = saveBufferToFile(buffer, VIDEOS_DIR, 'vid', 'mp4');

    // 以 nodeId 命名元数据：前端 `/api/generation-status/:nodeId` 靠它恢复结果
    const metadataId = task.nodeId || task.taskId;
    const metadata = {
        id: metadataId,
        filename: saved.filename,
        prompt: task.prompt || '',
        model: task.modelId,
        aspectRatio: task.aspectRatio || 'Auto',
        resolution: task.resolution || 'Auto',
        createdAt: new Date().toISOString(),
        type: 'videos',
    };
    fs.writeFileSync(path.join(VIDEOS_DIR, `${metadataId}.json`), JSON.stringify(metadata, null, 2));

    await saveTask({
        ...task,
        status: 'succeeded',
        resultUrl: saved.url,
        error: undefined,
        updatedAt: Date.now(),
        finishedAt: Date.now(),
    });

    const prev = timers.get(task.taskId);
    if (prev) clearTimeout(prev);
    timers.delete(task.taskId);
    console.log(`[VideoTask] 任务完成 ${task.taskId} → ${saved.url} (nodeId=${task.nodeId || '-'})`);
}

/** 单次轮询 */
async function pollTask(taskId) {
    const task = readTasks()[taskId];
    if (!task || task.status !== 'running') return;

    // 超时兜底
    if (Date.now() - (task.createdAt || 0) > MAX_WAIT) {
        await finalizeFailed(taskId, '视频生成超时（服务端等待超过 11 分钟）');
        return;
    }

    let result;
    try {
        result = await querySeedanceTask(task.taskId, task.apiKey);
    } catch (error) {
        const failures = (task.errorCount || 0) + 1;
        if (failures >= MAX_CONSECUTIVE_ERRORS) {
            await finalizeFailed(taskId, error.message);
            return;
        }
        await saveTask({ ...task, errorCount: failures, updatedAt: Date.now() });
        console.warn(`[VideoTask] 查询失败（${failures}/${MAX_CONSECUTIVE_ERRORS}）${taskId}: ${error.message}`);
        schedule(taskId, POLL_INTERVAL * 2);
        return;
    }

    if (result.status === 'running') {
        await saveTask({ ...task, errorCount: 0, updatedAt: Date.now() });
        schedule(taskId, POLL_INTERVAL);
        return;
    }

    if (result.status === 'failed') {
        await finalizeFailed(taskId, result.error);
        return;
    }

    try {
        await finalizeSucceeded(task, result.videoUrl);
    } catch (error) {
        // 下载失败：保留任务继续重试（厂商侧已完成，重下载是幂等的）
        const failures = (task.errorCount || 0) + 1;
        if (failures >= MAX_CONSECUTIVE_ERRORS) {
            await finalizeFailed(taskId, `下载生成视频失败：${error.message}`);
            return;
        }
        await saveTask({ ...task, errorCount: failures, updatedAt: Date.now() });
        schedule(taskId, POLL_INTERVAL);
    }
}

// ============================================================================
// 对外接口
// ============================================================================

/**
 * 提交 Seedance 视频任务并启动后台轮询。
 * @returns {Promise<object>} 对外可见的任务信息（含 taskId）
 */
export async function submitSeedanceVideoTask(params) {
    const {
        apiKey,
        channel = 'free',
        nodeId,
        modelId,
        prompt,
        aspectRatio,
        resolution,
        duration,
        imageBase64,
        lastFrameBase64,
        referenceImages,
        generateAudio = true,
    } = params;

    const taskId = await createSeedanceTask({
        prompt,
        imageBase64,
        lastFrameBase64,
        referenceImages,
        duration: duration || 5,
        resolution: (resolution && resolution !== 'Auto') ? resolution : '720p',
        ratio: (aspectRatio && aspectRatio !== 'Auto') ? aspectRatio : '16:9',
        generateAudio,
        apiKey,
        modelId,
    });

    const task = {
        taskId,
        nodeId: nodeId || null,
        status: 'running',
        modelId,
        prompt: prompt || '',
        aspectRatio: aspectRatio || 'Auto',
        resolution: resolution || 'Auto',
        duration: duration || 5,
        channel,
        apiKey,
        errorCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    await saveTask(task);
    schedule(taskId, POLL_INTERVAL);

    // 顺手清理过期已完成任务，避免文件无限增长
    cleanupOldTasks().catch((error) => console.warn('[VideoTask] 清理过期任务失败:', error.message));

    console.log(`[VideoTask] 任务已提交 ${taskId} (nodeId=${nodeId || '-'}, model=${modelId})`);
    return publicTask(task);
}

/** 查询任务（不含 apiKey） */
export function getVideoTask(taskId) {
    const task = readTasks()[taskId];
    return publicTask(task);
}

/** 按 nodeId 找最近一次任务（诊断/恢复用） */
export function findTaskByNodeId(nodeId) {
    const tasks = readTasks();
    return publicTask(
        Object.values(tasks)
            .filter((t) => t && t.nodeId === nodeId)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
    );
}

/** 清理过期的已完成任务 */
export async function cleanupOldTasks() {
    const now = Date.now();
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

/**
 * 服务启动时恢复未完成任务：进程重启（--watch / 部署）后继续轮询并落盘。
 */
export async function restoreVideoTasks() {
    const tasks = readTasks();
    const running = Object.values(tasks).filter((t) => t && t.status === 'running');

    let resumed = 0;
    for (const task of running) {
        if (!task.taskId || !task.apiKey) continue;
        if (Date.now() - (task.createdAt || 0) > MAX_WAIT) {
            await finalizeFailed(task.taskId, '视频生成超时（服务重启后已超过最长等待）');
            continue;
        }
        schedule(task.taskId, 2000);
        resumed += 1;
    }

    if (resumed > 0) {
        console.log(`[VideoTask] 已恢复 ${resumed} 个未完成的视频任务`);
    }
    cleanupOldTasks().catch((error) => console.warn('[VideoTask] 清理过期任务失败:', error.message));
    return resumed;
}

/** 当前是否有排队/运行中的任务（诊断用） */
export function getActiveTaskCount() {
    return timers.size;
}
