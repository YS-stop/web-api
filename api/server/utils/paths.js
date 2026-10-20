/**
 * paths.js
 *
 * 统一路径常量。基于模块自身位置推导项目根目录，
 * 不依赖 process.cwd()，保证从任意目录启动服务时路径一致。
 *
 * server/utils/paths.js -> server/ -> api/
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** api/server */
export const SERVER_DIR = path.resolve(HERE, '..');
/** api/ */
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');

/** 运行时数据根目录 */
export const LIBRARY_DIR = path.join(ROOT_DIR, 'library');
/** 生成结果与素材 */
export const IMAGES_DIR = path.join(LIBRARY_DIR, 'images');
export const VIDEOS_DIR = path.join(LIBRARY_DIR, 'videos');
/** 画布与工作流 */
export const WORKFLOWS_DIR = path.join(LIBRARY_DIR, 'workflows');
export const PROJECT_WORKFLOWS_DIR = path.join(LIBRARY_DIR, 'project-workflows');
/** AI 会话 */
export const CHATS_DIR = path.join(LIBRARY_DIR, 'chats');
/** 精选素材库索引 */
export const ASSETS_DIR = path.join(LIBRARY_DIR, 'assets');
/** 业务数据文件 */
export const USERS_FILE = path.join(LIBRARY_DIR, 'users.json');
export const COMPANY_FILE = path.join(LIBRARY_DIR, 'company.json');
export const PROJECTS_FILE = path.join(LIBRARY_DIR, 'projects.json');
export const CHANGE_REQUESTS_FILE = path.join(LIBRARY_DIR, 'change-requests.json');
/** 配置与内置资源 */
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const PUBLIC_WORKFLOWS_DIR = path.join(PUBLIC_DIR, 'workflows');
/** 生产环境前端构建产物 */
export const DIST_DIR = path.join(ROOT_DIR, 'dist');

/**
 * 本地模型目录。支持 LOCAL_MODELS_DIR 覆盖（相对 api/ 或绝对路径）。
 * 用函数而非常量，避免模块求值早于 dotenv 加载。
 */
export function getModelsDir() {
    const custom = process.env.LOCAL_MODELS_DIR;
    return custom ? path.resolve(ROOT_DIR, custom) : path.join(ROOT_DIR, 'models');
}

/** 本地模型架构配置（遗留文件，代码基本未引用） */
export function getModelRegistryPath() {
    return path.join(CONFIG_DIR, 'model-registry.json');
}

/**
 * 确保目录存在。
 * @param {string[]} dirs 目录路径列表
 */
export function ensureDirs(dirs) {
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
