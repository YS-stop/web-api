/**
 * db/mediaAssets.js
 *
 * media_assets 表读写封装（生成产物元数据）。
 *
 * 写入方（全部通过 upsertMediaAsset，保证字段映射只有一份）：
 *   routes/generation.js        同步图片 / 视频生成
 *   routes/videoTrim.js         视频裁剪
 *   routes/assets.js            手动保存素材
 *   tools/tiktok.js             TikTok 导入
 *   services/videoTaskRunner.js Seedance 异步任务完成
 *
 * 读取方：routes/assets.js
 *
 * 说明：媒体文件本身仍在 library/images|videos 下，这里只存元数据与访问 URL。
 * 原 .json 元数据文件在 file / dual 模式下继续保留，供老逻辑与前端兜底读取。
 */

import { exec, one, isDbEnabled } from './index.js';

/** 目录名（images / videos）→ 数据库 kind */
export function mediaKind(type) {
    return type === 'images' ? 'image' : 'video';
}

/** 数据库 kind → 目录名 */
export function mediaTypeOf(kind) {
    return kind === 'image' ? 'images' : 'videos';
}

/**
 * 写入 / 更新一条媒体元数据。
 * DB_DRIVER=file 时直接跳过（调用方无需自己判断驱动）。
 * @param {object} metadata 与原 .json 元数据同结构（id、filename、prompt、model、createdAt、type …）
 * @param {'images'|'videos'} type
 */
export async function upsertMediaAsset(metadata, type) {
    if (!isDbEnabled()) return;

    const {
        id,
        filename,
        prompt,
        model,
        createdAt,
        type: _ignored,
        aspectRatio,
        resolution,
        ...rest
    } = metadata || {};

    await exec(
        `INSERT INTO media_assets
            (id, kind, filename, url, prompt, model, aspect_ratio, resolution, meta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (id) DO UPDATE SET
            kind         = EXCLUDED.kind,
            filename     = EXCLUDED.filename,
            url          = EXCLUDED.url,
            prompt       = EXCLUDED.prompt,
            model        = EXCLUDED.model,
            aspect_ratio = EXCLUDED.aspect_ratio,
            resolution   = EXCLUDED.resolution,
            meta         = EXCLUDED.meta,
            created_at   = EXCLUDED.created_at`,
        [
            String(id),
            mediaKind(type),
            filename || '',
            filename ? `/library/${type}/${filename}` : '',
            prompt || '',
            model || '',
            aspectRatio ?? null,
            resolution ?? null,
            JSON.stringify(rest || {}),
            createdAt || new Date().toISOString(),
        ],
    );
}

/** 数据库行 → 前端素材元数据（结构与原 .json 保持一致） */
export function rowToMediaAsset(row) {
    const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);
    const type = mediaTypeOf(row.kind);
    return {
        id: row.id,
        filename: row.filename,
        prompt: row.prompt,
        model: row.model,
        ...(row.meta || {}),
        ...(row.aspect_ratio ? { aspectRatio: row.aspect_ratio } : {}),
        ...(row.resolution ? { resolution: row.resolution } : {}),
        type,
        createdAt: iso(row.created_at),
        url: row.url || `/library/${type}/${row.filename}`,
    };
}

/** 按 id 取单条（不存在返回 null） */
export async function getMediaAsset(id) {
    const row = await one('SELECT * FROM media_assets WHERE id = $1', [String(id)]);
    return row ? rowToMediaAsset(row) : null;
}

export default {
    mediaKind,
    mediaTypeOf,
    upsertMediaAsset,
    rowToMediaAsset,
    getMediaAsset,
};
