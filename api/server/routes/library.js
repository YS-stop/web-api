/**
 * library.js
 *
 * 精选素材库（library/assets）的增删查。
 *   POST   /api/library       保存素材（base64 或 library 内文件）
 *   GET    /api/library       列出全部素材（按创建时间倒序）
 *   DELETE /api/library/:id   删除素材及其文件
 *
 * 由 server/index.js 内联代码搬出，逻辑保持不变。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ASSETS_DIR as LIBRARY_ASSETS_DIR, IMAGES_DIR, VIDEOS_DIR } from '../utils/paths.js';
import { readJson, updateJson } from '../utils/jsonStore.js';
import { resolveInside } from '../utils/safePath.js';

const router = express.Router();

/** 素材索引文件 */
const libraryJsonPath = path.join(LIBRARY_ASSETS_DIR, 'assets.json');

/**
 * 生成不重名的目标文件名。
 * 原实现直接用净化后的 name 作文件名，中文名会被净化成纯下划线（如「主角」→「__」），
 * 多个中文命名素材会互相覆盖。这里只在发生冲突时追加时间戳后缀，保持既有文件命名习惯。
 */
function uniqueFilename(destDir, base, ext) {
    let filename = `${base}${ext}`;
    if (!fs.existsSync(path.join(destDir, filename))) return filename;
    const suffix = Date.now().toString(36);
    filename = `${base}_${suffix}${ext}`;
    let i = 1;
    while (fs.existsSync(path.join(destDir, filename))) {
        filename = `${base}_${suffix}_${i}${ext}`;
        i += 1;
    }
    return filename;
}

// Save curated asset to library
router.post('/', async (req, res) => {
    try {
        const { sourceUrl, name, category, meta } = req.body;

        if (!sourceUrl || !name || !category) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Determine destination directory
        const destDir = path.join(LIBRARY_ASSETS_DIR, category);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        // Sanitize name for filesystem（纯中文/符号名会净化成空串，兜底为 asset）
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'asset';

        let destFilename;
        let destPath;

        // HANDLE DATA URL (Base64)
        if (sourceUrl.startsWith('data:')) {
            const matches = sourceUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                return res.status(400).json({ error: 'Invalid data URL format' });
            }

            const mimeType = matches[1];
            const base64Data = matches[2];
            const buffer = Buffer.from(base64Data, 'base64');

            // Determine extension from mime
            let ext = '.png';
            if (mimeType === 'image/jpeg') ext = '.jpg';
            else if (mimeType === 'video/mp4') ext = '.mp4';
            // Add more as needed

            destFilename = uniqueFilename(destDir, safeName, ext);
            destPath = path.join(destDir, destFilename);

            fs.writeFileSync(destPath, buffer);
        }
        // HANDLE FILE PATH OR URL
        else {
            // Determine source file path
            let sourcePath = null;

            // Normalize URL: remove origin if present to get just the path
            let cleanUrl = sourceUrl;
            try {
                // If it's a full URL, extract pathname
                if (sourceUrl.startsWith('http')) {
                    const u = new URL(sourceUrl);
                    cleanUrl = u.pathname;
                }
            } catch (e) {
                // Not a valid URL, treat as path
            }

            // Always strip query string (cache busting params like ?t=123)
            cleanUrl = cleanUrl.split('?')[0];

            // Ensure cleanUrl starts with / if it doesn't (though URL.pathname does)
            if (!cleanUrl.startsWith('/')) cleanUrl = '/' + cleanUrl;

            // Handle URL decoding (e.g. %20 -> space)
            cleanUrl = decodeURIComponent(cleanUrl);

            // 防目录逃逸：sourceUrl 可为 `/library/images/../../.env`，否则会被复制进素材库并对外可下载
            if (cleanUrl.startsWith('/library/images/')) {
                sourcePath = resolveInside(IMAGES_DIR, cleanUrl.replace('/library/images/', ''));
            } else if (cleanUrl.startsWith('/library/videos/')) {
                sourcePath = resolveInside(VIDEOS_DIR, cleanUrl.replace('/library/videos/', ''));
            } else if (cleanUrl.startsWith('/assets/images/')) { // Legacy support
                sourcePath = resolveInside(IMAGES_DIR, cleanUrl.replace('/assets/images/', ''));
            } else if (cleanUrl.startsWith('/assets/videos/')) { // Legacy support
                sourcePath = resolveInside(VIDEOS_DIR, cleanUrl.replace('/assets/videos/', ''));
            }

            if (!sourcePath || !fs.existsSync(sourcePath)) {
                console.error(`Save asset failed: Source file not found. URL: ${sourceUrl}, Path: ${sourcePath}`);
                return res.status(404).json({ error: "Source file not found", debug: { sourceUrl, sourcePath, cleanUrl } });
            }

            // Copy file
            const ext = path.extname(sourcePath);
            destFilename = uniqueFilename(destDir, safeName, ext);
            destPath = path.join(destDir, destFilename);

            fs.copyFileSync(sourcePath, destPath);
        }

        // Update assets.json（串行化写入，避免并发保存时互相覆盖丢条目）
        const newEntry = {
            id: crypto.randomUUID(),
            name: name,
            category: category,
            url: `/library/assets/${category}/${destFilename}`,
            type: sourceUrl.includes('video') || (sourceUrl.startsWith('data:video')) ? 'video' : 'image',
            createdAt: new Date().toISOString(),
            ...meta
        };

        await updateJson(libraryJsonPath, (current) => {
            const list = Array.isArray(current) ? current : [];
            list.push(newEntry);
            return list;
        }, []);

        res.json({ success: true, asset: newEntry });
    } catch (error) {
        console.error("Save to library error:", error);
        res.status(500).json({ error: error.message });
    }
});

// List library assets
router.get('/', async (req, res) => {
    try {
        const libraryData = readJson(libraryJsonPath, []);
        // Sort newest first
        libraryData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(libraryData);
    } catch (error) {
        console.error("List library error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete library asset
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!fs.existsSync(libraryJsonPath)) {
            return res.status(404).json({ error: "Library not found" });
        }

        const libraryData = readJson(libraryJsonPath, []);
        const asset = libraryData.find(a => a.id === id);

        if (!asset) {
            return res.status(404).json({ error: "Asset not found" });
        }

        // Delete the actual file if it exists in our assets folder
        // asset.url usually looks like /library/assets/Category/file.ext
        if (asset.url && asset.url.startsWith('/library/assets/')) {
            const relativePath = asset.url.replace('/library/assets/', '');
            const filePath = resolveInside(LIBRARY_ASSETS_DIR, relativePath);
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // Remove from array（串行化写入，避免与并发保存互相覆盖）
        await updateJson(libraryJsonPath, (current) => {
            const list = Array.isArray(current) ? current : [];
            return list.filter(a => a.id !== id);
        }, []);

        res.json({ success: true });
    } catch (error) {
        console.error("Delete library asset error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
