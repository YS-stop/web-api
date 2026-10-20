/**
 * videoMerge.js
 *
 * 视频拼接成片接口。
 *
 * 端点：
 *   GET  /api/video-merge/presets     转场预设 + 音轨模式（前端下拉用）
 *   GET  /api/video-merge/status      ffmpeg / ffprobe 环境自检
 *   POST /api/video-merge/merge       执行拼接
 *
 * 输入可以是：
 *   - /library/xxx.mp4        服务器静态目录下的相对地址
 *   - http(s)://...           远程地址（下载后拼接）
 *   - 绝对路径                 本地文件
 */

import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ESM 下没有 __dirname，必须从 import.meta.url 还原
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
    mergeVideos,
    TRANSITION_PRESETS,
    normalizeTransition,
} from '../services/videoMerge.js';
import { isFFmpegAvailable, isFFprobeAvailable } from '../utils/ffmpeg.js';

const router = express.Router();

/**
 * 静态资源根目录。
 *
 * index.js 里 `/library` 映射到 `server/../library`（仓库根下的 library），
 * 不是 public/library，所以这里必须用同一个基准，否则生成的文件 404。
 */
const LIBRARY_DIR = path.join(__dirname, '..', '..', 'library');

// ============================================================================
// 路径解析
// ============================================================================

/**
 * 把前端地址解析为服务器本地绝对路径。
 *
 * @param {string} urlOrPath
 * @param {string} tmpDir 远程文件下载目录
 * @param {number|string} index 序号（用于临时文件名）
 * @returns {Promise<string>} 本地绝对路径
 */
async function resolveInput(urlOrPath, tmpDir, index) {
    const raw = String(urlOrPath || '').trim();
    if (!raw) throw new Error('片段地址为空');

    // 1. 已是本地文件
    if (fs.existsSync(raw)) return path.resolve(raw);

    // 2. 静态相对地址：/library/xxx.mp4 → <repo>/library/xxx.mp4
    const clean = raw.split('?')[0];
    if (clean.startsWith('/library/')) {
        const candidate = path.join(LIBRARY_DIR, clean.slice('/library/'.length));
        if (fs.existsSync(candidate)) return candidate;
    }
    // 兜底：直接拼在 library 根下
    const candidate2 = path.join(LIBRARY_DIR, clean.replace(/^\/+/, ''));
    if (fs.existsSync(candidate2)) return candidate2;

    // 3. 远程地址 → 下载
    if (/^https?:\/\//i.test(raw)) {
        const extMatch = clean.match(/\.(mp4|mov|webm|mkv|m4v|mp3|wav|aac|m4a)$/i);
        const ext = extMatch ? extMatch[0].toLowerCase() : '.mp4';
        const dest = path.join(tmpDir, `input_${index}${ext}`);

        const res = await fetch(raw);
        if (!res.ok) {
            throw new Error(`片段 ${index} 下载失败：HTTP ${res.status}`);
        }
        await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        return dest;
    }

    throw new Error(`无法定位片段文件：${raw}`);
}

// ============================================================================
// GET /presets
// ============================================================================

router.get('/presets', (req, res) => {
    res.json({
        presets: TRANSITION_PRESETS,
        audioModes: [
            { id: 'keep', label: '保留原音', desc: '各片段自带音频，按转场对齐拼接' },
            { id: 'tts', label: 'TTS 覆盖', desc: '用整集配音替换原音，长度不匹配自动补静音/截断' },
            { id: 'mute', label: '静音', desc: '丢弃所有音轨' },
        ],
    });
});

// ============================================================================
// GET /status
// ============================================================================

router.get('/status', async (req, res) => {
    const [ffmpeg, ffprobe] = await Promise.all([
        isFFmpegAvailable(),
        isFFprobeAvailable(),
    ]);
    res.json({ ffmpeg, ffprobe, ready: ffmpeg && ffprobe });
});

// ============================================================================
// POST /merge
// ============================================================================

router.post('/merge', async (req, res) => {
    const {
        videos,
        transition = 'fade',
        transitionDuration = 0.5,
        /** 逐边界转场 id（长度 = videos.length - 1），优先于 transition */
        transitions,
        /** 逐边界转场时长，可选 */
        transitionDurations,
        audioMode = 'keep',
        audioUrl,
        episode,
        width,
        height,
        fps,
    } = req.body || {};

    if (!Array.isArray(videos) || videos.length < 2) {
        return res.status(400).json({
            success: false,
            error: '至少需要 2 个视频片段才能拼接',
        });
    }
    if (audioMode === 'tts' && !audioUrl) {
        return res.status(400).json({
            success: false,
            error: 'TTS 覆盖模式需要提供配音音频地址',
        });
    }

    const tmpDir = path.join(
        os.tmpdir(),
        `merge_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    );
    await fsp.mkdir(tmpDir, { recursive: true });

    const logs = [];
    const onLog = (msg) => {
        logs.push(msg);
        console.log(`[VideoMerge] ${msg}`);
    };

    try {
        onLog(`收到拼接请求：${videos.length} 段，转场=${transition}(${transitionDuration}s)，音轨=${audioMode}`);

        // ---- 解析所有输入为本地路径 ----
        const inputPaths = [];
        for (let i = 0; i < videos.length; i++) {
            inputPaths.push(await resolveInput(videos[i], tmpDir, i));
        }

        // ---- 配音音频 ----
        let audioPath = null;
        if (audioMode === 'tts') {
            audioPath = await resolveInput(audioUrl, tmpDir, 'tts');
        }

        // ---- 输出路径：library/merged/[ep01_]merged_<ts>.mp4 ----
        const outDir = path.join(LIBRARY_DIR, 'merged');
        await fsp.mkdir(outDir, { recursive: true });

        const epNum = episode ? Number(episode) : 0;
        const epTag = epNum > 0 ? `ep${String(epNum).padStart(2, '0')}_` : '';
        const outName = `${epTag}merged_${Date.now()}.mp4`;
        const outputPath = path.join(outDir, outName);

        // ---- 执行拼接 ----
        const result = await mergeVideos({
            inputPaths,
            outputPath,
            options: {
                transition: normalizeTransition(transition),
                transitionDuration: Number(transitionDuration) || 0.5,
                transitions: Array.isArray(transitions) ? transitions : null,
                transitionDurations: Array.isArray(transitionDurations) ? transitionDurations : null,
                audioMode,
                audioPath,
                width: width ? Number(width) : undefined,
                height: height ? Number(height) : undefined,
                fps: fps ? Number(fps) : undefined,
                onLog,
            },
        });

        const stat = await fsp.stat(outputPath).catch(() => null);

        onLog(`完成：${outName}（${result.duration.toFixed(1)}s，模式=${result.mode}）`);

        res.json({
            success: true,
            url: `/library/merged/${outName}`,
            duration: result.duration,
            mode: result.mode,
            spec: result.spec,
            size: stat ? stat.size : 0,
            transition: result.transition,
            transitionDuration: result.transitionDuration,
            boundaries: result.boundaries,
            audioMode: result.audioMode,
            episode: epNum || null,
            clips: result.clips,
            logs,
        });
    } catch (error) {
        console.error('[VideoMerge] 拼接失败:', error);
        res.status(500).json({
            success: false,
            error: error.message || '视频拼接失败',
            logs,
        });
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
});

// ============================================================================
// POST /shots-to-nodes
// ============================================================================

/** 画布节点布局常量（与前端 shotImportService 保持一致） */
const NODE_COLUMNS = 3;
const NODE_COL_GAP = 420;
const NODE_ROW_GAP = 520;

/**
 * 把某一集的分镜片段转成画布节点。
 *
 * 为什么由后端做：
 *   画布节点的布局 / 去重 / 合并节点连线规则容易前后端各写一套而漂移，
 *   集中到后端后，画布、批量脚本、将来的定时任务都走同一份逻辑。
 *
 * 分镜数据本身仍由前端提供（ShotEditorPanel 存在 localStorage），
 * 后端不持有分镜库，只做「分镜 → 节点」的纯转换。
 *
 * body: {
 *   shots: [{ shotNumber, description, prompt?, durationSeconds?,
 *             transitionOut?, videoUrl?, imageUrl? }],
 *   episode: number,
 *   originX?: number, originY?: number,
 *   aspectRatio?: string,          // 默认 9:16
 *   includeImages?: boolean,       // 默认 true
 *   createMergeNode?: boolean,     // 默认 true，需 >= 2 个视频片段
 *   existingUrls?: string[],       // 已导入过的片段地址，用于去重
 *   videoModel?: string, imageModel?: string,
 * }
 *
 * 返回: { success, nodes, videoCount, imageCount, skipped, mergeNodeId }
 */
router.post('/shots-to-nodes', (req, res) => {
    try {
        const {
            shots,
            episode,
            originX = 0,
            originY = 0,
            aspectRatio = '9:16',
            includeImages = true,
            createMergeNode = true,
            existingUrls = [],
            videoModel = 'doubao-seedance-2-0-260128',
            imageModel = 'gpt-image-1.5',
        } = req.body || {};

        if (!Array.isArray(shots) || shots.length === 0) {
            return res.status(400).json({ success: false, error: 'shots 不能为空' });
        }
        const ep = Number(episode);
        if (!Number.isFinite(ep) || ep <= 0) {
            return res.status(400).json({ success: false, error: 'episode 必须是正整数' });
        }

        // 按镜头号升序，保证播放顺序与分镜一致
        const ordered = [...shots].sort(
            (a, b) => (Number(a?.shotNumber) || 0) - (Number(b?.shotNumber) || 0)
        );

        const skipUrls = new Set(
            (Array.isArray(existingUrls) ? existingUrls : []).filter(Boolean)
        );

        const nodes = [];
        const videoNodeIds = [];
        /** 与 videoNodeIds 对齐：第 i 段的 transitionOut（「切入本镜头」的转场） */
        const videoTransitionOuts = [];
        let videoCount = 0;
        let imageCount = 0;
        let skipped = 0;
        let slot = 0;

        for (const shot of ordered) {
            const videoUrl = typeof shot?.videoUrl === 'string' && shot.videoUrl ? shot.videoUrl : '';
            const imageUrl = typeof shot?.imageUrl === 'string' && shot.imageUrl ? shot.imageUrl : '';

            if (!videoUrl && !imageUrl) {
                skipped += 1;
                continue;
            }
            if (!videoUrl && imageUrl && !includeImages) {
                skipped += 1;
                continue;
            }

            const url = videoUrl || imageUrl;
            if (skipUrls.has(url)) {
                skipped += 1;
                continue;
            }

            const col = slot % NODE_COLUMNS;
            const row = Math.floor(slot / NODE_COLUMNS);
            slot += 1;

            const hasVideo = Boolean(videoUrl);
            const shotNo = Number(shot.shotNumber) || slot;

            const node = {
                id: crypto.randomUUID(),
                type: hasVideo ? 'Video' : 'Image',
                x: originX + col * NODE_COL_GAP,
                y: originY + row * NODE_ROW_GAP,
                title: `第 ${ep} 集 · 镜头 ${shotNo}`,
                prompt: buildShotPrompt(shot),
                status: 'success',
                resultUrl: url,
                model: hasVideo ? videoModel : imageModel,
                videoModel: hasVideo ? videoModel : undefined,
                imageModel: hasVideo ? undefined : imageModel,
                videoDuration: hasVideo
                    ? (Number(shot.durationSeconds) || 5)
                    : undefined,
                aspectRatio,
                resolution: hasVideo ? '720p' : '1K',
                parentIds: [],
                mergeEpisode: ep,
                shotNumber: shotNo,
                shotTransitionOut: shot.transitionOut || undefined,
            };

            nodes.push(node);

            if (hasVideo) {
                videoCount += 1;
                videoNodeIds.push(node.id);
                videoTransitionOuts.push(shot.transitionOut || 'fade');
            } else {
                imageCount += 1;
            }
        }

        // ---------- 为本集创建合并节点 ----------
        let mergeNodeId = null;
        if (createMergeNode && videoNodeIds.length >= 2) {
            mergeNodeId = crypto.randomUUID();
            const rowCount = Math.ceil(slot / NODE_COLUMNS);

            nodes.push({
                id: mergeNodeId,
                type: 'Video Merge',
                x: originX + NODE_COLUMNS * NODE_COL_GAP,
                y: originY + Math.max(0, rowCount - 1) * NODE_ROW_GAP / 2,
                title: `第 ${ep} 集 · 合并成片`,
                prompt: `第 ${ep} 集整集拼接`,
                status: 'idle',
                model: '',
                aspectRatio,
                resolution: '720p',
                // 父节点顺序 = 分镜顺序 = 播放顺序
                parentIds: videoNodeIds,
                mergeEpisode: ep,
                mergeTransition: 'fade',
                mergeTransitionDuration: 0.5,
                // 第 k 个边界（片段 k → k+1）取第 k+1 段的 transitionOut
                mergeTransitions: videoTransitionOuts.slice(1),
                mergeTransitionDurations: videoTransitionOuts.slice(1).map(() => 0.5),
                mergeAudioMode: 'keep',
                mergeClipUrls: nodes
                    .filter((n) => videoNodeIds.includes(n.id))
                    .map((n) => n.resultUrl),
            });
        }

        res.json({
            success: true,
            nodes,
            videoCount,
            imageCount,
            skipped,
            mergeNodeId,
        });
    } catch (error) {
        console.error('[ShotsToNodes] 转换失败:', error);
        res.status(500).json({ success: false, error: error.message || '分镜转节点失败' });
    }
});

/**
 * 拼一段可读的分镜提示词，作为节点 prompt。
 *
 * @param {object} shot
 * @returns {string}
 */
function buildShotPrompt(shot) {
    const parts = [];
    if (shot?.description) parts.push(String(shot.description).trim());
    if (shot?.cameraAngle) parts.push(`景别/角度：${shot.cameraAngle}`);
    if (shot?.cameraMovement) parts.push(`运镜：${shot.cameraMovement}`);
    if (shot?.lighting) parts.push(`光线：${shot.lighting}`);
    if (shot?.mood) parts.push(`氛围：${shot.mood}`);
    if (shot?.prompt) parts.push(String(shot.prompt).trim());
    return parts.join('，') || '分镜片段';
}

export default router;
