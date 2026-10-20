/**
 * errorHandler.js
 *
 * 统一请求标识、访问日志、404 与错误响应。
 *
 * 响应体保持 `{ error: string }` 结构（前端按该结构解析），
 * 仅追加 requestId 字段，保证向后兼容。
 */

import crypto from 'crypto';
import { IS_PRODUCTION, LOG_REQUESTS } from '../config/env.js';

/** 为每个请求生成 requestId，写入 req.id 与响应头 */
export function requestId(req, res, next) {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
}

/** 精简访问日志：方法、路径、状态码、耗时 */
export function accessLog(req, res, next) {
    if (!LOG_REQUESTS) return next();
    const start = Date.now();
    res.on('finish', () => {
        // 静态资源与浏览器预检不记录，避免噪音
        if (req.method === 'OPTIONS') return;
        if (req.path.startsWith('/library/')) return;
        const ms = Date.now() - start;
        console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms req=${req.id}`);
    });
    next();
}

/** 未匹配任何路由时返回 JSON 404 */
export function notFoundHandler(req, res) {
    res.status(404).json({
        error: `Not found: ${req.method} ${req.originalUrl}`,
        requestId: req.id,
    });
}

/**
 * 统一错误处理。必须挂在所有路由之后。
 */
export function errorHandler(err, req, res, next) {
    const status = err.status || err.statusCode || 500;
    console.error(`[ERROR] ${req.method} ${req.originalUrl} req=${req.id}`, err);

    // SSE / 已发送响应头：无法再写 JSON，交给默认处理器关闭连接
    if (res.headersSent) {
        return next(err);
    }

    const message = status >= 500
        ? (IS_PRODUCTION ? 'Internal Server Error' : (err.message || 'Internal Server Error'))
        : (err.message || 'Request failed');

    const body = { error: message, requestId: req.id };
    if (!IS_PRODUCTION && err.stack) body.stack = err.stack;

    res.status(status).json(body);
}

/**
 * 进程级兜底：记录未捕获异常与未处理的 Promise 拒绝。
 * 这里只记录不退出，保持服务可用性（与原行为一致：原来完全没有兜底）。
 */
export function installProcessGuards() {
    process.on('unhandledRejection', (reason) => {
        console.error('[FATAL] unhandledRejection:', reason);
    });
    process.on('uncaughtException', (error) => {
        console.error('[FATAL] uncaughtException:', error);
    });
}
