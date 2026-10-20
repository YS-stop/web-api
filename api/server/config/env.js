/**
 * env.js
 *
 * 环境变量统一入口。
 *
 * 注意执行顺序：ESM 会先求值所有被 import 的模块，再执行导入方的模块体。
 * 因此 dotenv.config() 必须放在本模块内部，并在 index.js 首行用 side-effect import
 * 引入（`import './config/env.js'`），否则其它模块求值时 process.env 尚未加载。
 */

import dotenv from 'dotenv';

dotenv.config();

/** 解析整数环境变量，非法值回退默认值 */
function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

/** 解析布尔环境变量，支持 1/true/yes/on */
function toBool(value, fallback) {
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';

/** 服务端口。默认 8024；前端 vite 代理写死指向 8024，改动需同步前端。 */
export const PORT = toInt(process.env.PORT, 8024);

/**
 * 鉴权模式：
 *  - off     : 关闭鉴权中间件（保持现状）
 *  - warn    : 解析 token，未登录请求只记录日志、不拦截（灰度观察，默认）
 *  - enforce : 未登录请求直接 401
 */
export const AUTH_MODE = (process.env.AUTH_MODE || 'warn').toLowerCase();

/** 单模型通道最大并发数（modelChannel.js 使用） */
export const CHANNEL_MAX_CONCURRENT = toInt(process.env.CHANNEL_MAX_CONCURRENT, 4);

/** 是否输出请求访问日志 */
export const LOG_REQUESTS = toBool(process.env.LOG_REQUESTS, true);

/** 启动自检：必需变量缺失时打印汇总警告（不阻断启动） */
export const REQUIRED_ENV_KEYS = [
    'GEMINI_API_KEY',
    'SEEDREAM_API_KEY',
    'SEEDANCE_API_KEY',
    'DRAMA_API_KEY',
    'VLM_DOUBAO_API_KEY',
    'TTS_APP_ID',
    'TTS_ACCESS_TOKEN',
];

/**
 * 打印缺失的必需环境变量。
 * @param {string[]} keys 变量名列表，默认 REQUIRED_ENV_KEYS
 * @returns {string[]} 缺失的变量名
 */
export function warnMissingEnv(keys = REQUIRED_ENV_KEYS) {
    const missing = keys.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.warn(`[ENV] 缺失 ${missing.length} 个推荐配置项: ${missing.join(', ')}`);
    }
    return missing;
}
