/**
 * safePath.js
 *
 * 目录逃逸防护：把用户可控的 id / 文件名拼进路径前，先校验结果仍在基准目录内。
 *
 * 背景：`path.join(WORKFLOWS_DIR, `${req.params.id}.json`)` 这类写法在
 * `id = '..%2Fusers'`（Express 解码后为 '../users'）时会读到/写到工作目录之外，
 * 例如 `/api/workflows/..%2Fusers` 可读出 library/users.json。
 */

import path from 'path';

/**
 * 解析 baseDir 下的路径，若发生目录逃逸则返回 null。
 * @param {string} baseDir 基准目录（绝对路径）
 * @param {...string} segments 相对路径片段
 * @returns {string|null} 绝对路径；逃逸时返回 null
 */
export function resolveInside(baseDir, ...segments) {
    const base = path.resolve(baseDir);
    const target = path.resolve(base, ...segments);
    if (target === base) return null;
    if (!target.startsWith(base + path.sep)) return null;
    return target;
}
