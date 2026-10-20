/**
 * assets.js
 *
 * 生成素材历史（图片 / 视频）：媒体文件 + 同名 .json 元数据。
 * 对应接口：
 *   POST   /api/assets/:type
 *   GET    /api/assets/:type
 *   DELETE /api/assets/:type/:id
 *
 * 由 server/index.js 内联代码搬出，逻辑保持不变。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { IMAGES_DIR, VIDEOS_DIR } from '../utils/paths.js';
import { resolveInside } from '../utils/safePath.js';

const router = express.Router();

const VALID_TYPES = ['images', 'videos'];

function resolveDir(type) {
    return type === 'images' ? IMAGES_DIR : VIDEOS_DIR;
}

// Save an asset (image or video)
router.post('/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const { data, prompt } = req.body;

        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = resolveDir(type);
        const id = Date.now().toString();
        const ext = type === 'images' ? 'png' : 'mp4';
        const filename = `${id}.${ext}`;
        const metaFilename = `${id}.json`;

        // Save the asset file
        const base64Data = data.replace(/^data:[^;]+;base64,/, '');
        fs.writeFileSync(path.join(targetDir, filename), base64Data, 'base64');

        // Save metadata
        const metadata = {
            id,
            filename,
            prompt: prompt || '',
            createdAt: new Date().toISOString(),
            type
        };
        fs.writeFileSync(path.join(targetDir, metaFilename), JSON.stringify(metadata, null, 2));

        res.json({ success: true, id, filename, url: `/library/${type}/${filename}` });
    } catch (error) {
        console.error('Save asset error:', error);
        res.status(500).json({ error: error.message });
    }
});

// List all assets of a type (with pagination support)
router.get('/:type', async (req, res) => {
    try {
        const { type } = req.params;
        const limit = parseInt(req.query.limit) || 0; // 0 = no limit (backward compatible)
        const offset = parseInt(req.query.offset) || 0;

        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = resolveDir(type);

        if (!fs.existsSync(targetDir)) {
            // Return paginated format if limit is specified, otherwise array for backward compatibility
            return res.json(limit > 0 ? { assets: [], total: 0, hasMore: false } : []);
        }

        const files = fs.readdirSync(targetDir);
        const assets = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const content = fs.readFileSync(path.join(targetDir, file), 'utf8');
                    const metadata = JSON.parse(content);
                    metadata.url = `/library/${type}/${metadata.filename}`;
                    assets.push(metadata);
                } catch (e) {
                    // Skip invalid JSON files
                }
            }
        }

        // Sort by createdAt descending (newest first)
        assets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        // If limit is specified, return paginated response
        if (limit > 0) {
            const paginatedAssets = assets.slice(offset, offset + limit);
            return res.json({
                assets: paginatedAssets,
                total: assets.length,
                hasMore: offset + limit < assets.length
            });
        }

        // Backward compatible: return full array if no limit specified
        res.json(assets);
    } catch (error) {
        console.error('List assets error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete an asset
router.delete('/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;

        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({ error: 'Invalid asset type' });
        }

        const targetDir = resolveDir(type);
        // 防目录逃逸：id 来自 URL，`..%2Fx` 解码后可能跳出目录
        const metaPath = resolveInside(targetDir, `${id}.json`);
        if (!metaPath) {
            return res.status(400).json({ error: 'Invalid asset id' });
        }

        // Read metadata to get the actual filename (may differ from ID)
        let assetFilename = null;
        if (fs.existsSync(metaPath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                assetFilename = metadata.filename;
            } catch (e) {
                console.warn(`Could not read metadata for ${id}:`, e.message);
            }
        }

        // Delete the media file using filename from metadata
        if (assetFilename) {
            const assetPath = path.join(targetDir, assetFilename);
            if (fs.existsSync(assetPath)) {
                fs.unlinkSync(assetPath);
                console.log(`Deleted asset file: ${assetPath}`);
            }
        }

        // Delete the metadata file
        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
            console.log(`Deleted metadata file: ${metaPath}`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Delete asset error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
