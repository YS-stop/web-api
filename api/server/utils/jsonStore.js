/**
 * jsonStore.js
 *
 * JSON 文件读写工具。
 *
 * 相比原来的 `fs.writeFileSync(file, JSON.stringify(...))`：
 *  1. 原子写：先写临时文件再 rename，进程崩溃不会留下半截 JSON；
 *  2. 串行化：同一文件的并发 update 排成队列，避免「读-改-写」丢更新；
 *  3. 读失败降级：文件损坏时返回 fallback 而不是抛出（与原逻辑一致）。
 */

import fs from 'fs';
import path from 'path';

/** 文件路径 -> 串行队列尾 Promise */
const queues = new Map();

/**
 * 读取 JSON。
 * @param {string} file 绝对路径
 * @param {*} fallback 文件不存在或解析失败时的返回值
 */
export function readJson(file, fallback = null) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        console.error('[jsonStore] 读取失败:', file, error.message);
        return fallback;
    }
}

/**
 * 同步原子写 JSON：写临时文件 -> rename 覆盖。
 * Windows 下目标文件被占用时 rename 可能 EPERM，做少量重试。
 * @param {string} file 绝对路径
 * @param {*} data 可序列化数据
 */
export function writeJsonSync(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(data, null, 2);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, payload);

    let lastError;
    for (let i = 0; i < 3; i++) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch (error) {
            lastError = error;
            // 目标被占用（Windows 常见），短暂等待后重试
            const until = Date.now() + 20;
            while (Date.now() < until) { /* busy wait 20ms 以内，避免引入异步破坏调用方语义 */ }
        }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw lastError;
}

/**
 * 串行化的「读-改-写」。
 *
 * @param {string} file 绝对路径
 * @param {(current:any)=>any|Promise<any>} updater 接收当前数据，返回要写入的新数据
 * @param {*} fallback 文件不存在时的初始值
 * @returns {Promise<any>} 写入后的数据
 */
export function updateJson(file, updater, fallback = null) {
    const prev = queues.get(file) || Promise.resolve();
    const next = prev
        .catch(() => { /* 前一个任务失败不阻塞后续 */ })
        .then(async () => {
            const current = readJson(file, fallback);
            const updated = await updater(current);
            writeJsonSync(file, updated);
            return updated;
        });

    queues.set(file, next);
    // 队列只在最后一个任务结束后清理，避免 Map 无限增长
    next.finally(() => {
        if (queues.get(file) === next) queues.delete(file);
    }).catch(() => { /* 由调用方处理 */ });

    return next;
}

/**
 * 判断某个路径当前是否有排队中的写入（测试/诊断用）。
 */
export function hasPendingWrite(file) {
    return queues.has(file);
}
