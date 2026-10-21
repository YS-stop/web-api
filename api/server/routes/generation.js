/**
 * generation.js
 * 
 * Routes for AI image and video generation.
 * Supports Gemini, Veo, Kling AI, Hailuo AI, and OpenAI GPT Image providers.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { generateKlingVideo } from '../services/kling.js';
import { generateVeoVideo } from '../services/gemini.js';
import { generateHailuoVideo } from '../services/hailuo.js';
import { generateSeedanceVideo, getMaxReferenceImages } from '../services/doubao.js';
import { submitSeedanceVideoTask, getVideoTask, findTaskByNodeId } from '../services/videoTaskRunner.js';
import { generateImageBuffer } from '../services/imageGeneration.js';
import { submitImageTask, getImageTask } from '../services/imageTaskRunner.js';
import { resolveImageToBase64, saveBufferToFile } from '../utils/imageHelpers.js';
import { getKey, withConcurrency } from '../services/modelChannel.js';
import { resolveInside } from '../utils/safePath.js';
import { upsertMediaAsset, getMediaAsset } from '../db/mediaAssets.js';
import { isDbEnabled } from '../db/index.js';

const router = express.Router();

// ============================================================================
// IMAGE GENERATION
// ============================================================================

router.post('/generate-image', async (req, res) => {
    try {
        const { nodeId, prompt, aspectRatio, resolution, imageBase64: rawImageBase64, imageModel, klingReferenceMode, klingFaceIntensity, klingSubjectIntensity, channel } = req.body;
        const { IMAGES_DIR } = req.app.locals;

        // 统一走共享生成逻辑（与后台任务队列同源，避免 provider 分支两处维护）
        const { imageBuffer, imageFormat } = await generateImageBuffer({
            prompt,
            imageModel,
            aspectRatio,
            resolution,
            imageBase64: rawImageBase64,
            klingReferenceMode,
            klingFaceIntensity,
            klingSubjectIntensity,
            channel,
        });

        // Save to library - use unique filename to preserve previous generations
        const saved = saveBufferToFile(imageBuffer, IMAGES_DIR, 'img', imageFormat);

        // Determine metadata ID: use nodeId for recovery if available, otherwise use file ID
        const metadataId = nodeId || saved.id;

        // Save metadata (id must match the metadata filename for delete to work)
        const metadata = {
            id: metadataId,  // Must match the filename for delete API to find it
            filename: saved.filename,
            prompt: prompt,
            model: imageModel || 'gemini-pro',
            createdAt: new Date().toISOString(),
            type: 'images'
        };
        // 元数据只写数据库（media_assets），不再落盘 <id>.json
        await upsertMediaAsset(metadata, 'images');

        console.log(`Image saved: ${saved.url} (model: ${imageModel || 'gemini-pro'})`);
        return res.json({ resultUrl: saved.url });

    } catch (error) {
        console.error("Server Image Gen Error:", error);
        res.status(500).json({ error: error.message || "Image generation failed" });
    }
});

// ============================================================================
// IMAGE GENERATION (ASYNC)
// 提交后由服务端后台队列生成并落盘（services/imageTaskRunner.js），
// 前端只查状态：即使页面关闭 / 进程重启，任务也会继续跑完。
// ============================================================================

/**
 * 提交图片生成任务：只创建任务并立即返回 taskId，不在请求内等待生成。
 */
router.post('/generate-image/submit', async (req, res) => {
    try {
        const {
            nodeId, prompt, aspectRatio, resolution, imageBase64, imageModel,
            klingReferenceMode, klingFaceIntensity, klingSubjectIntensity, channel,
        } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: '缺少 prompt' });
        }

        const task = await submitImageTask({
            nodeId,
            prompt,
            aspectRatio,
            resolution,
            imageModel,
            channel,
            imageBase64,
            klingReferenceMode,
            klingFaceIntensity,
            klingSubjectIntensity,
        });

        console.log(`[Image Async] 任务已提交: ${task.taskId} (nodeId=${nodeId || '-'})`);
        return res.json({ taskId: task.taskId, nodeId: task.nodeId, status: task.status });
    } catch (error) {
        console.error('[Image Async] 提交失败:', error);
        return res.status(500).json({ error: error.message || '提交图片任务失败' });
    }
});

/**
 * 查询图片生成任务状态（由服务端后台队列推进，本接口只读持久化记录）。
 */
router.get('/generate-image/status/:taskId', async (req, res) => {
    try {
        const task = await getImageTask(req.params.taskId);
        if (!task) {
            return res.status(404).json({ error: '任务不存在或已过期' });
        }

        if (task.status === 'running') {
            return res.json({ status: 'running' });
        }
        if (task.status === 'failed') {
            return res.json({ status: 'failed', error: task.error || '图片生成失败' });
        }
        return res.json({ status: 'succeeded', resultUrl: task.resultUrl });
    } catch (error) {
        console.error('[Image Async] 查询失败:', error);
        return res.status(500).json({ error: error.message || '查询图片任务失败' });
    }
});

// ============================================================================
// VIDEO GENERATION
// ============================================================================

router.post('/generate-video', async (req, res) => {
    try {
        const { nodeId, prompt, imageBase64: rawImageBase64, lastFrameBase64: rawLastFrameBase64, motionReferenceUrl: rawMotionReferenceUrl, referenceImages: rawReferenceImages, aspectRatio, resolution, duration, videoModel, channel } = req.body;
        const { KLING_ACCESS_KEY, KLING_SECRET_KEY, VIDEOS_DIR } = req.app.locals;

        // Resolve file URLs to base64
        const imageBase64 = resolveImageToBase64(rawImageBase64);
        const lastFrameBase64 = resolveImageToBase64(rawLastFrameBase64);
        const motionReferenceUrl = resolveImageToBase64(rawMotionReferenceUrl);
        // 多参考图：逐个把文件 URL 解析为 base64，过滤解析失败项
        const referenceImages = Array.isArray(rawReferenceImages)
            ? rawReferenceImages.map((u) => resolveImageToBase64(u)).filter(Boolean)
            : [];

        // Determine provider
        const isKlingModel = videoModel && videoModel.startsWith('kling-');
        const isHailuoModel = videoModel && videoModel.startsWith('hailuo-');
        const isSeedanceModel = videoModel && videoModel.startsWith('doubao-seedance');

        // 多图参考只有 Seedance 支持（reference_image）。其余模型静默忽略会让用户误以为生效，这里直接报错。
        if (referenceImages.length > 0 && !isSeedanceModel) {
            return res.status(400).json({
                error: `多图参考仅支持豆包 Seedance 模型（当前模型：${videoModel || '未指定'}）。` +
                    '请改用 Seedance，或把视频节点的输入模式切换为「首帧 / 首尾帧」。'
            });
        }

        // 参考图数量上限按模型区分（Seedance 2.0 = 9 张，2.5 = 30 张），提前拦截避免厂商侧参数报错
        if (isSeedanceModel && referenceImages.length > 0) {
            const maxRefs = getMaxReferenceImages(videoModel);
            const effectiveCount = new Set([...(imageBase64 ? [imageBase64] : []), ...referenceImages]).size;
            if (effectiveCount > maxRefs) {
                return res.status(400).json({
                    error: `参考图 ${effectiveCount} 张，超过模型 ${videoModel} 的上限 ${maxRefs} 张` +
                        '（Seedance 2.0 系列最多 9 张，2.5 系列最多 30 张）。'
                });
            }
        }

        let videoBuffer;

        if (isKlingModel) {
            // --- KLING AI VIDEO GENERATION ---

            // Check if this is a Kling 2.6 model (route to Fal.ai - official API doesn't support v2.6)
            const isKling26 = videoModel === 'kling-v2-6';
            // Check if this is a motion control request (kling-v2-6 with motion reference)
            const isMotionControl = isKling26 && motionReferenceUrl;

            let resultVideoUrl;

            if (isKling26) {
                // --- KLING 2.6 VIA FAL.AI ---
                // Official Kling API doesn't support v2.6, use fal.ai instead
                const FAL_API_KEY = getKey('FAL', channel);

                if (!FAL_API_KEY) {
                    return res.status(500).json({
                        error: "FAL_API_KEY not configured. Add FAL_API_KEY to .env for Kling 2.6."
                    });
                }

                if (isMotionControl) {
                    // Motion Control mode
                    console.log(`\n[Route] Kling 2.6 Motion Control detected - routing to fal.ai`);
                    console.log(`[Route] Motion Reference: ${motionReferenceUrl ? 'YES (' + Math.round(motionReferenceUrl.length / 1024) + ' KB)' : 'NO'}`);
                    console.log(`[Route] Character Image: ${imageBase64 ? 'YES (' + Math.round(imageBase64.length / 1024) + ' KB)' : 'NO'}`);
                    console.log(`[Route] Prompt: ${prompt ? prompt.substring(0, 50) + '...' : '(none)'}`);

                    const { generateFalMotionControl } = await import('../services/fal.js');

                    resultVideoUrl = await withConcurrency('FAL', channel, () => generateFalMotionControl({
                        prompt,
                        characterImageBase64: imageBase64,
                        motionVideoBase64: motionReferenceUrl,
                        characterOrientation: 'video',
                        apiKey: FAL_API_KEY
                    }));
                } else {
                    // Standard Image-to-Video mode
                    console.log(`\n[Route] Kling 2.6 Image-to-Video - routing to fal.ai`);
                    console.log(`[Route] Image: ${imageBase64 ? 'YES (' + Math.round(imageBase64.length / 1024) + ' KB)' : 'NO'}`);
                    console.log(`[Route] Duration: ${duration || 5}s`);
                    console.log(`[Route] Generate Audio: ${req.body.generateAudio !== false}`);

                    const { generateFalImageToVideo } = await import('../services/fal.js');

                    resultVideoUrl = await withConcurrency('FAL', channel, () => generateFalImageToVideo({
                        prompt,
                        imageBase64,
                        duration: String(duration || 5),
                        generateAudio: req.body.generateAudio !== false, // Default to true
                        apiKey: FAL_API_KEY
                    }));
                }
            } else {
                // --- STANDARD KLING VIDEO GENERATION ---
                if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
                    return res.status(500).json({
                        error: "Kling API credentials not configured. Add KLING_ACCESS_KEY and KLING_SECRET_KEY to .env"
                    });
                }

                console.log(`Using Kling AI model: ${videoModel}, duration: ${duration || 5}s`);

                resultVideoUrl = await withConcurrency('KLING', channel, () => generateKlingVideo({
                    prompt,
                    imageBase64,
                    lastFrameBase64,
                    modelId: videoModel,
                    aspectRatio,
                    duration: duration || 5,
                    motionReferenceUrl,
                    accessKey: KLING_ACCESS_KEY,
                    secretKey: KLING_SECRET_KEY
                }));
            }

            // Download from the result URL
            const videoResponse = await fetch(resultVideoUrl);
            if (!videoResponse.ok) {
                throw new Error('Failed to download generated video');
            }
            videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

        } else if (isHailuoModel) {
            // --- HAILUO AI VIDEO GENERATION ---
            const HAILUO_API_KEY = getKey('HAILUO', channel);
            if (!HAILUO_API_KEY) {
                return res.status(500).json({
                    error: "Hailuo API key not configured. Add HAILUO_API_KEY to .env"
                });
            }

            console.log(`Using Hailuo AI model: ${videoModel}, duration: ${duration || 6}s`);

            const hailuoVideoUrl = await withConcurrency('HAILUO', channel, () => generateHailuoVideo({
                prompt,
                imageBase64,
                lastFrameBase64,
                modelId: videoModel,
                aspectRatio,
                resolution,
                duration: duration || 6,
                apiKey: HAILUO_API_KEY
            }));

            // Download from Hailuo's URL
            const videoResponse = await fetch(hailuoVideoUrl);
            if (!videoResponse.ok) {
                throw new Error('Failed to download video from Hailuo');
            }
            videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

        } else if (isSeedanceModel) {
            // --- DOUBAO SEEDANCE VIDEO GENERATION ---
            const SEEDANCE_API_KEY = getKey('SEEDANCE', channel);
            if (!SEEDANCE_API_KEY) {
                return res.status(500).json({
                    error: "SEEDANCE_API_KEY not configured. Add SEEDANCE_API_KEY to .env"
                });
            }

            console.log(`Using Seedance model: ${videoModel}, duration: ${duration || 5}s`);

            const seedanceVideoUrl = await withConcurrency('SEEDANCE', channel, () => generateSeedanceVideo({
                prompt,
                imageBase64,
                lastFrameBase64,
                referenceImages,
                duration: duration || 5,
                resolution: (resolution && resolution !== 'Auto') ? resolution : '720p',
                ratio: (aspectRatio && aspectRatio !== 'Auto') ? aspectRatio : '16:9',
                generateAudio: req.body.generateAudio !== false,
                apiKey: SEEDANCE_API_KEY,
                modelId: videoModel
            }));

            // Download from Seedance's URL
            const videoResponse = await fetch(seedanceVideoUrl);
            if (!videoResponse.ok) {
                throw new Error('Failed to download video from Seedance');
            }
            videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

        } else {
            // --- VEO VIDEO GENERATION (Default) ---
            const GEMINI_API_KEY = getKey('GEMINI', channel);
            if (!GEMINI_API_KEY) {
                return res.status(500).json({ error: "Server missing API Key config" });
            }

            console.log(`Using Veo model: ${videoModel || 'veo-3.1'}, duration: ${duration || 8}s, generateAudio: ${req.body.generateAudio !== false}`);

            videoBuffer = await withConcurrency('GEMINI', channel, () => generateVeoVideo({
                prompt,
                imageBase64,
                lastFrameBase64,
                aspectRatio,
                resolution,
                duration: duration || 8,
                generateAudio: req.body.generateAudio !== false, // Default to true
                apiKey: GEMINI_API_KEY
            }));
        }

        // Save to library - use unique filename to preserve previous generations
        const saved = saveBufferToFile(videoBuffer, VIDEOS_DIR, 'vid', 'mp4');

        // Determine metadata ID: use nodeId for recovery if available, otherwise use file ID
        const metadataId = nodeId || saved.id;

        // Save metadata (id must match the metadata filename for delete to work)
        const metadata = {
            id: metadataId,  // Must match the filename for delete API to find it
            filename: saved.filename,
            prompt: prompt,
            model: videoModel || 'veo-3.1',
            aspectRatio: aspectRatio || 'Auto',
            resolution: resolution || 'Auto',
            createdAt: new Date().toISOString(),
            type: 'videos'
        };
        // 元数据只写数据库（media_assets），不再落盘 <id>.json
        await upsertMediaAsset(metadata, 'videos');

        console.log(`Video saved: ${saved.url} (model: ${videoModel || 'veo-3.1'})`);
        return res.json({ resultUrl: saved.url });

    } catch (error) {
        console.error("Server Video Gen Error:", error);
        res.status(500).json({ error: error.message || "Video generation failed" });
    }
});

// ============================================================================
// SEEDANCE ASYNC VIDEO
// 提交后由服务端后台轮询并落盘（services/videoTaskRunner.js），
// 前端只查状态：即使页面关闭/进程重启，任务也会继续跑完并写入 library/videos/<nodeId>.json。
// ============================================================================

/**
 * 提交 Seedance 视频任务：只创建任务并立即返回 taskId，不在请求内等待生成。
 * 批量场景下前端可先并发提交全部任务，再统一轮询，避免「一个跑完才提交下一个」。
 */
router.post('/generate-video/submit', async (req, res) => {
    try {
        const {
            nodeId, prompt,
            imageBase64: rawImageBase64,
            lastFrameBase64: rawLastFrameBase64,
            referenceImages: rawReferenceImages,
            aspectRatio, resolution, duration, videoModel, channel,
        } = req.body;

        if (!videoModel || !videoModel.startsWith('doubao-seedance')) {
            return res.status(400).json({ error: '异步提交目前仅支持 Seedance 模型' });
        }

        const SEEDANCE_API_KEY = getKey('SEEDANCE', channel);
        if (!SEEDANCE_API_KEY) {
            return res.status(500).json({ error: 'SEEDANCE_API_KEY not configured' });
        }

        const imageBase64 = resolveImageToBase64(rawImageBase64);
        const lastFrameBase64 = resolveImageToBase64(rawLastFrameBase64);
        const referenceImages = Array.isArray(rawReferenceImages)
            ? rawReferenceImages.map((u) => resolveImageToBase64(u)).filter(Boolean)
            : [];

        // 参考图上限按模型区分（Seedance 2.0 = 9 张，2.5 = 30 张）
        if (referenceImages.length > 0) {
            const maxRefs = getMaxReferenceImages(videoModel);
            const effectiveCount = new Set([...(imageBase64 ? [imageBase64] : []), ...referenceImages]).size;
            if (effectiveCount > maxRefs) {
                return res.status(400).json({
                    error: `参考图 ${effectiveCount} 张，超过模型 ${videoModel} 的上限 ${maxRefs} 张` +
                        '（Seedance 2.0 系列最多 9 张，2.5 系列最多 30 张）。'
                });
            }
        }

        // 提交本身很快（1~3 秒），仍走并发槽限流，避免瞬时打爆厂商 QPS。
        // 提交后由服务端后台轮询并落盘，前端离开页面也不影响任务完成。
        const task = await withConcurrency('SEEDANCE', channel, () => submitSeedanceVideoTask({
            apiKey: SEEDANCE_API_KEY,
            channel,
            nodeId,
            modelId: videoModel,
            prompt,
            aspectRatio,
            resolution,
            duration,
            imageBase64,
            lastFrameBase64,
            referenceImages,
            generateAudio: req.body.generateAudio !== false,
        }));

        console.log(`[Seedance Async] 任务已提交: ${task.taskId} (nodeId=${nodeId || '-'})`);
        return res.json({ taskId: task.taskId, nodeId: task.nodeId });
    } catch (error) {
        console.error('[Seedance Async] 提交失败:', error);
        return res.status(500).json({ error: error.message || '提交视频任务失败' });
    }
});

/**
 * 查询 Seedance 异步任务状态。
 *
 * 状态由服务端后台轮询推进（videoTaskRunner），本接口只读持久化的任务记录：
 * 即使客户端只查一次、或者查到一半离开，任务仍会跑完并落盘。
 */
router.get('/generate-video/status/:taskId', async (req, res) => {
    try {
        const task = await getVideoTask(req.params.taskId);
        if (!task) {
            return res.status(404).json({ error: '任务不存在或已过期' });
        }

        if (task.status === 'running') {
            return res.json({ status: 'running' });
        }
        if (task.status === 'failed') {
            return res.json({ status: 'failed', error: task.error || '视频生成失败' });
        }
        return res.json({ status: 'succeeded', resultUrl: task.resultUrl });
    } catch (error) {
        console.error('[Seedance Async] 查询失败:', error);
        return res.status(500).json({ error: error.message || '查询视频任务失败' });
    }
});

// ============================================================================
// GENERATION STATUS / RECOVERY
// ============================================================================

/**
 * Check if a generation has finished for a specific nodeId.
 * Returns the resultUrl if it exists.
 */
router.get('/generation-status/:nodeId', async (req, res) => {
    try {
        const { nodeId } = req.params;
        const { IMAGES_DIR, VIDEOS_DIR } = req.app.locals;

        // 防目录逃逸：nodeId 来自 URL，`..%2Fx` 解码后可能跳出目录
        const imageMetaPath = resolveInside(IMAGES_DIR, `${nodeId}.json`);
        const videoMetaPath = resolveInside(VIDEOS_DIR, `${nodeId}.json`);
        if (!imageMetaPath || !videoMetaPath) {
            return res.status(400).json({ error: 'Invalid node id' });
        }

        // 1) 数据库为准：media_assets 里同一 id 即该节点的生成结果
        if (isDbEnabled()) {
            try {
                const asset = await getMediaAsset(nodeId);
                if (asset && asset.url) {
                    return res.json({
                        status: 'success',
                        resultUrl: asset.url,
                        type: asset.type === 'images' ? 'image' : 'video',
                        createdAt: asset.createdAt,
                    });
                }
            } catch (error) {
                console.warn('[generation-status] 查库失败，回退文件:', error.message);
            }
        }

        // 2) 回退文件：兼容 db 模式上线前生成的历史产物
        if (fs.existsSync(imageMetaPath)) {
            const meta = JSON.parse(fs.readFileSync(imageMetaPath, 'utf8'));
            return res.json({ status: 'success', resultUrl: `/library/images/${meta.filename}`, type: 'image', createdAt: meta.createdAt });
        }

        if (fs.existsSync(videoMetaPath)) {
            const meta = JSON.parse(fs.readFileSync(videoMetaPath, 'utf8'));
            return res.json({ status: 'success', resultUrl: `/library/videos/${meta.filename}`, type: 'video', createdAt: meta.createdAt });
        }

        // 3) 任务已明确失败时把原因带回前端：
        //    否则前端只能看到 pending 一直轮询，直到自身超时才报错（节点长时间转圈）
        try {
            const videoTask = await findTaskByNodeId(nodeId);
            if (videoTask?.status === 'failed') {
                return res.json({ status: 'failed', error: videoTask.error || '视频生成失败' });
            }
            const imageTask = await getImageTask(nodeId);
            if (imageTask?.status === 'failed') {
                return res.json({ status: 'failed', error: imageTask.error || '图片生成失败' });
            }
        } catch (error) {
            console.warn('[generation-status] 查询任务状态失败:', error.message);
        }

        res.json({ status: 'pending' });
    } catch (error) {
        console.error("Status Check Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// BATCH EXPORT (打包下载已生成的视频)
// ============================================================================

/**
 * POST /api/export-videos
 * body: { items: [{ episode, shotNumber, url }], dimension: 'episode' | 'shot', filename? }
 * 先把有效文件筛出来，再用 archiver 流式打包，避免大视频全量进内存。
 */
router.post('/export-videos', async (req, res) => {
    try {
        const { items, dimension = 'episode', filename = '工作流视频导出.zip' } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: '没有可导出的视频' });
        }

        const { VIDEOS_DIR } = req.app.locals;
        const videosRoot = path.resolve(VIDEOS_DIR);

        // 先筛选真实存在的文件，避免返回空压缩包
        const files = [];
        for (const item of items) {
            const rawUrl = String(item?.url || '');
            if (!rawUrl.startsWith('/library/videos/')) continue;

            const fileName = path.basename(rawUrl.split('?')[0]);
            const filePath = path.resolve(VIDEOS_DIR, fileName);
            // 防路径穿越：解析后必须仍在 VIDEOS_DIR 内
            if (!filePath.startsWith(videosRoot + path.sep)) continue;
            if (!fs.existsSync(filePath)) continue;

            const ep = String(item.episode ?? '').padStart(2, '0');
            const shot = String(item.shotNumber ?? '').padStart(2, '0');
            files.push({
                filePath,
                archiveName: dimension === 'episode'
                    ? `第${ep}集/片段${shot}.mp4`
                    : `第${ep}集-片段${shot}.mp4`,
            });
        }

        if (files.length === 0) {
            return res.status(404).json({ error: '选中的片段没有已生成的视频' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );

        const archive = archiver('zip', { zlib: { level: 1 } }); // 视频已是压缩格式，低压缩级别即可
        archive.on('warning', (err) => console.warn('[Export] warning:', err));
        archive.on('error', (err) => {
            console.error('[Export] error:', err);
            res.destroy(err);
        });
        archive.pipe(res);

        for (const f of files) archive.file(f.filePath, { name: f.archiveName });

        console.log(`[Export] 打包 ${files.length} 个视频 (dimension=${dimension})`);
        await archive.finalize();
    } catch (error) {
        console.error('[Export] 失败:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message || '导出失败' });
    }
});

export default router;
