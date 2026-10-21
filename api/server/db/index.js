/**
 * db/index.js
 *
 * PostgreSQL 连接池与查询封装。
 *
 * 配置优先级（均在 api/.env）：
 *   1. DATABASE_URL=postgres://user:pass@host:port/dbname
 *   2. PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD / PGSSL
 *
 * 驱动开关 DB_DRIVER：
 *   file = 不建立任何连接（默认，仍走 library/*.json）
 *   db   = 全部走 PostgreSQL
 *   dual = 双写过渡（写 PG，同时保留文件副本）
 *
 * 连接池惰性创建：只在真正执行 SQL 时才连接，
 * 因此 DB_DRIVER=file 时即使没装库也不影响服务启动。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

// 自己兜底加载 api/.env：无论被谁 import（服务、脚本、node -e）都能读到配置。
// dotenv 默认不覆盖已存在的 process.env，因此不会影响外部显式传入的变量。
dotenv.config({
    path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'),
    quiet: true,
});

const { Pool } = pg;

/** @type {import('pg').Pool|null} */
let pool = null;

// ============================================================================
// 配置读取
// ============================================================================

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envInt(name, fallback) {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 当前数据层驱动 */
export function getDbDriver() {
    const raw = (process.env.DB_DRIVER || 'file').trim().toLowerCase();
    return ['file', 'db', 'dual'].includes(raw) ? raw : 'file';
}

/** 是否启用 PostgreSQL（db / dual） */
export function isDbEnabled() {
    return getDbDriver() !== 'file';
}

/** 是否处于双写过渡模式 */
export function isDualWrite() {
    return getDbDriver() === 'dual';
}

/** 占位值不算有效连接串（.env 模板常见 CHANGE_ME / xxx） */
const PLACEHOLDER_PATTERN = /CHANGE_?ME|YOUR_|xxx+|^postgres:\/\/.*:.*@.*\/(change|your)/i;

/**
 * 是否使用连接串。
 * 以下情况回退到 PGHOST/PGUSER/... 离散配置，避免一个手写错误让整个服务连不上库：
 *   - DATABASE_URL 为空
 *   - 仍是模板占位值（CHANGE_ME）
 *   - 格式非法（漏写 @、host 缺失）
 *   - 没有库名（如 ...@localhost:5432/ 或漏写冒号导致 host 被吞进用户名）
 *
 * 结果按 DATABASE_URL 原值缓存，保证同一份配置只告警一次。
 */
let connStringCache = { raw: null, use: false };

function useConnectionString() {
    const raw = (process.env.DATABASE_URL || '').trim();
    if (connStringCache.raw === raw) return connStringCache.use;

    let use = false;
    if (raw && !PLACEHOLDER_PATTERN.test(raw)) {
        try {
            const parsed = new URL(raw);
            if (!parsed.hostname) {
                console.warn('[db] DATABASE_URL 缺少主机名，已回退到 PGHOST/PGUSER 配置');
            } else if (parsed.pathname.replace(/^\/+/, '') === '') {
                console.warn('[db] DATABASE_URL 缺少库名（形如 @127.0.0.1:5432/dbname），已回退到 PGHOST/PGDATABASE 配置');
            } else {
                use = true;
            }
        } catch {
            console.warn('[db] DATABASE_URL 格式无法解析（可能漏了 @），已回退到 PGHOST/PGUSER 配置');
        }
    }

    connStringCache = { raw, use };
    return use;
}

/**
 * 组装 pg.Pool 配置。
 * 不打印密码；对外展示时用 describeTarget()。
 */
function buildPoolConfig() {
    const ssl = envBool('PGSSL', false) ? { rejectUnauthorized: false } : undefined;

    const base = {
        max: envInt('PG_POOL_MAX', 10),
        idleTimeoutMillis: envInt('PG_IDLE_TIMEOUT_MS', 30000),
        connectionTimeoutMillis: envInt('PG_CONNECTION_TIMEOUT_MS', 5000),
        application_name: 'twitcanva-api',
        ssl,
    };

    const statementTimeout = envInt('PG_STATEMENT_TIMEOUT_MS', 0);
    if (statementTimeout > 0) base.statement_timeout = statementTimeout;

    if (useConnectionString()) {
        return { ...base, connectionString: process.env.DATABASE_URL.trim() };
    }

    return {
        ...base,
        host: process.env.PGHOST || '127.0.0.1',
        port: envInt('PGPORT', 5432),
        database: process.env.PGDATABASE || 'twitcanva',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
    };
}

/**
 * 可安全打印的连接目标描述（脱敏密码）。
 */
export function describeTarget() {
    if (useConnectionString()) {
        try {
            const url = new URL(process.env.DATABASE_URL.trim());
            if (url.password) url.password = '***';
            return url.toString();
        } catch {
            return '(DATABASE_URL 格式无法解析)';
        }
    }
    const host = process.env.PGHOST || '127.0.0.1';
    const port = process.env.PGPORT || '5432';
    const database = process.env.PGDATABASE || 'twitcanva';
    const user = process.env.PGUSER || 'postgres';
    return `postgres://${user}@${host}:${port}/${database}`;
}

// ============================================================================
// 连接池
// ============================================================================

/**
 * 获取（惰性创建）连接池。
 * @returns {import('pg').Pool}
 */
export function getPool() {
    if (pool) return pool;

    if (!useConnectionString() && !process.env.PGHOST && !process.env.PGDATABASE) {
        console.warn('[db] 未配置 DATABASE_URL 或 PGHOST，将使用默认值 127.0.0.1:5432/twitcanva');
    }

    pool = new Pool(buildPoolConfig());

    // 空闲连接被服务端断开等异常，不能让进程崩溃
    pool.on('error', (error) => {
        console.error('[db] 连接池空闲连接异常:', error.message);
    });

    console.log(`[db] 连接池已创建 → ${describeTarget()}`);
    return pool;
}

/**
 * 执行 SQL。
 * @param {string} text
 * @param {any[]} [params]
 */
export function query(text, params) {
    return getPool().query(text, params);
}

/** 返回全部行 */
export async function many(text, params) {
    const result = await query(text, params);
    return result.rows;
}

/** 返回首行，无结果返回 null */
export async function one(text, params) {
    const result = await query(text, params);
    return result.rows[0] || null;
}

/** 只关心影响行数/命令结果 */
export async function exec(text, params) {
    const result = await query(text, params);
    return { rowCount: result.rowCount, command: result.command };
}

/**
 * 事务封装：回调拿到 client，必须用 client.query 执行语句。
 * 回调抛错自动 ROLLBACK。
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('[db] ROLLBACK 失败:', rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

/**
 * 连通性检查。
 * @returns {Promise<{ok:boolean, version?:string, now?:string, error?:string}>}
 */
export async function healthCheck() {
    try {
        const row = await one('SELECT version() AS version, now() AS now');
        return { ok: true, version: row.version, now: row.now };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

/** 关闭连接池（测试 / 优雅退出用） */
export async function closePool() {
    if (!pool) return;
    const current = pool;
    pool = null;
    await current.end().catch((error) => console.error('[db] 关闭连接池失败:', error.message));
}

/** 数据库标识（用于健康检查输出） */
export function dbName() {
    return process.env.PGDATABASE || '(DATABASE_URL)';
}

export default {
    getPool,
    query,
    one,
    many,
    exec,
    transaction,
    healthCheck,
    closePool,
    getDbDriver,
    isDbEnabled,
    isDualWrite,
    describeTarget,
    dbName,
};
