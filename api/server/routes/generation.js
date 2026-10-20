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
import { generateKlingVideo, generateKlingImage, generateKlingMultiImage } from '../services/kling.js';
import { generateGeminiImage, generateVeoVideo } from '../services/gemini.js';
import { generateHailuoVideo } from '../services/hailuo.js';
import { generateOpenAIImage } from '../services/openai.js';
import { generateSeedanceVideo, generateSeedreamImage, getMaxReferenceImages } from '../services/doubao.js';
import { submitSeedanceVideoTask, getVideoTask } from '../services/videoTaskRunner.js';
import { resolveImageToBase64, saveBufferToFile } from '../utils/imageHelpers.js';
import { getKey, withConcurrency } from '../services/modelChannel.js';
import { resolveInside } from '../utils/safePath.js';

const router = express.Router();

// ============================================================================
// IMAGE GENERATION
// ============================================================================

router.post('/generate-image', async (req, res) => {
    try {
        const { nodeId, prompt, aspectRatio, resolution, imageBase64: rawImageBase64, imageModel, klingReferenceMode, klingFaceIntensity, klingSubjectIntensity, channel } = req.body;
        const { KLING_ACCESS_KEY, KLING_SECRET_KEY, IMAGES_DIR } = req.app.locals;

        // Determine provider
        const isKlingModel = imageModel && imageModel.startsWith('kling-');
        const isOpenAIModel = imageModel && imageModel.startsWith('gpt-image-');
        const isSeedreamModel = imageModel && imageModel.startsWith('doubao-seedream');

        let imageBuffer;
        let imageFormat = 'png';

        if (isKlingModel) {
            // --- KLING AI IMAGE GENERATION ---
            if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
                return res.status(500).json({
                    error: "Kling API credentials not configured. Add KLING_ACCESS_KEY and KLING_SECRET_KEY to .env"
                });
            }

            console.log(`Using Kling AI model for image: ${imageModel}`);

            // Resolve images if provided
            let resolvedImages = null;
            if (rawImageBase64) {
                const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
                resolvedImages = rawImages.map(img => resolveImageToBase64(img)).filter(Boolean);
            }

            let klingImageUrl;

            // Determine which API to use based on model and reference images:
            // - kling-v1-5: Uses standard API with image_reference parameter
            // - kling-v2, kling-v2-1: Use Multi-Image API (image_reference not supported)
            const isV2Model = imageModel === 'kling-v2' || imageModel === 'kling-v2-1' || imageModel === 'kling-v2-new';
            const hasReferenceImages = resolvedImages && resolvedImages.length > 0;

            if (hasReferenceImages && isV2Model) {
                // V2 models: Use Multi-Image API for image-to-image
                console.log(`Using Kling Multi-Image API for ${imageModel} with ${resolvedImages.length} subject image(s)`);
                klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingMultiImage({
                    prompt,
                    subjectImages: resolvedImages,
                    modelId: imageModel,
                    aspectRatio,
                    resolution,
                    accessKey: KLING_ACCESS_KEY,
                    secretKey: KLING_SECRET_KEY
                }));
            } else if (hasReferenceImages && resolvedImages.length > 1) {
                // Multiple images with non-V2 model: Use Multi-Image API
                console.log(`Using Kling Multi-Image API with ${resolvedImages.length} subject images`);
                klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingMultiImage({
                    prompt,
                    subjectImages: resolvedImages,
                    modelId: imageModel,
                    aspectRatio,
                    resolution,
                    accessKey: KLING_ACCESS_KEY,
                    secretKey: KLING_SECRET_KEY
                }));
            } else {
                // V1.5 or text-to-image: Use standard API (V1.5 supports image_reference)
                klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingImage({
                    prompt,
                    imageBase64: resolvedImages,
                    modelId: imageModel,
                    aspectRatio,
                    resolution,
                    klingReferenceMode,
                    klingFaceIntensity,
                    klingSubjectIntensity,
                    accessKey: KLING_ACCESS_KEY,
                    secretKey: KLING_SECRET_KEY
                }));
            }

            // Download from Kling's URL
            const imageResponse = await fetch(klingImageUrl);
            if (!imageResponse.ok) {
                throw new Error('Failed to download image from Kling');
            }
            imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

            if (klingImageUrl.includes('.jpg') || klingImageUrl.includes('.jpeg')) {
                imageFormat = 'jpg';
            }

        } else if (isOpenAIModel) {
            // --- OPENAI GPT IMAGE GENERATION ---
            const OPENAI_API_KEY = getKey('OPENAI', channel);
            if (!OPENAI_API_KEY) {
                return res.status(500).json({
                    error: "OpenAI API key not configured. Add OPENAI_API_KEY to .env"
                });
            }

            console.log(`Using OpenAI GPT Image model: ${imageModel}`);

            // Resolve images if provided
            let imageBase64Array = null;
            if (rawImageBase64) {
                const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
                imageBase64Array = rawImages.map(img => resolveImageToBase64(img)).filter(Boolean);
            }

            imageBuffer = await withConcurrency('OPENAI', channel, () => generateOpenAIImage({
                prompt,
                imageBase64Array,
                aspectRatio,
                resolution,
                apiKey: OPENAI_API_KEY
            }));

        } else if (isSeedreamModel) {
            // --- DOUBAO SEEDREAM IMAGE GENERATION ---
            const SEEDREAM_API_KEY = getKey('SEEDREAM', channel);
            if (!SEEDREAM_API_KEY) {
                return res.status(500).json({
                    error: "SEEDREAM_API_KEY not configured. Add SEEDREAM_API_KEY to .env"
                });
            }

            console.log(`Using Seedream model: ${imageModel}`);

            // 多参考图（图生图）：逐个把文件 URL 解析为 base64 data URI，过滤解析失败项
            let imageBase64Array = null;
            if (rawImageBase64) {
                const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
                imageBase64Array = rawImages.map((img) => resolveImageToBase64(img)).filter(Boolean);
            }

            const seedreamUrl = await withConcurrency('SEEDREAM', channel, () => generateSeedreamImage({
                prompt,
                aspectRatio,
                imageBase64: imageBase64Array,
                apiKey: SEEDREAM_API_KEY,
                modelId: imageModel
            }));

            // Download from Seedream's URL
            const imageResponse = await fetch(seedreamUrl);
            if (!imageResponse.ok) {
                throw new Error('Failed to download image from Seedream');
            }
            imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

            if (seedreamUrl.includes('.jpg') || seedreamUrl.includes('.jpeg')) {
                imageFormat = 'jpg';
            }

        } else {
            // --- GEMINI IMAGE GENERATION (Default) ---
            const GEMINI_API_KEY = getKey('GEMINI', channel);
            if (!GEMINI_API_KEY) {
                return res.status(500).json({ error: "Server missing API Key config" });
            }

            let imageBase64Array = null;
            if (rawImageBase64) {
                const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
                imageBase64Array = rawImages.map(img => resolveImageToBase64(img)).filter(Boolean);
            }

            imageBuffer = await withConcurrency('GEMINI', channel, () => generateGeminiImage({
                prompt,
                imageBase64Array,
                aspectRatio,
                resolution,
                apiKey: GEMINI_API_KEY
            }));
        }

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
        fs.writeFileSync(path.join(IMAGES_DIR, `${metadataId}.json`), JSON.stringify(metadata, null, 2));

        console.log(`Image saved: ${saved.url} (model: ${imageModel || 'gemini-pro'})`);
        return res.json({ resultUrl: saved.url });

    } catch (error) {
        console.error("Server Image Gen Error:", error);
        res.status(500).json({ error: error.message || "Image generation failed" });
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
        fs.writeFileSync(path.join(VIDEOS_DIR, `${metadataId}.json`), JSON.stringify(metadata, null, 2));

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
        const task = getVideoTask(req.params.taskId);
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

        // Check images metadata
        if (fs.existsSync(imageMetaPath)) {
            const meta = JSON.parse(fs.readFileSync(imageMetaPath, 'utf8'));
            return res.json({ status: 'success', resultUrl: `/library/images/${meta.filename}`, type: 'image', createdAt: meta.createdAt });
        }

        // Check videos metadata
        if (fs.existsSync(videoMetaPath)) {
            const meta = JSON.parse(fs.readFileSync(videoMetaPath, 'utf8'));
            return res.json({ status: 'success', resultUrl: `/library/videos/${meta.filename}`, type: 'video', createdAt: meta.createdAt });
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
