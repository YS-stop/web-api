// Load environment variables FIRST before any other imports
// env.js 内部执行 dotenv.config()，必须最先求值，保证后续模块拿到 process.env
import { PORT } from './config/env.js';

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import generationRoutes from './routes/generation.js';
import twitterRoutes from './routes/twitter.js';
import tiktokPostRoutes from './routes/tiktok-post.js';
import storyboardRoutes from './routes/storyboard.js';
import dramaRoutes from './routes/drama.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import projectsRoutes from './routes/projects.js';
import projectStateRoutes from './routes/projectState.js';
import ttsRoutes from './routes/tts.js';
import dubbingRoutes from './routes/dubbing.js';
import localModelsRoutes from './routes/local-models.js';
import videoMergeRoutes from './routes/videoMerge.js';
import assetsRoutes from './routes/assets.js';
import tiktokImportRoutes from './routes/tiktokImport.js';
import videoTrimRoutes from './routes/videoTrim.js';
import chatRoutes from './routes/chat.js';
import geminiRoutes from './routes/gemini.js';
import libraryRoutes from './routes/library.js';
import workflowsRoutes from './routes/workflows.js';
import {
    LIBRARY_DIR,
    WORKFLOWS_DIR,
    PROJECT_WORKFLOWS_DIR,
    IMAGES_DIR,
    VIDEOS_DIR,
    CHATS_DIR,
    ASSETS_DIR as LIBRARY_ASSETS_DIR,
    ensureDirs,
} from './utils/paths.js';
import {
    requestId,
    accessLog,
    notFoundHandler,
    errorHandler,
    installProcessGuards,
} from './middleware/errorHandler.js';
import { restoreVideoTasks } from './services/videoTaskRunner.js';
import { restoreImageTasks } from './services/imageTaskRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 目录常量统一由 utils/paths.js 提供（基于模块位置推导，不依赖 cwd）
ensureDirs([LIBRARY_DIR, WORKFLOWS_DIR, PROJECT_WORKFLOWS_DIR, IMAGES_DIR, VIDEOS_DIR, CHATS_DIR, LIBRARY_ASSETS_DIR]);

// 恢复上次进程未完成的视频任务：重启后继续轮询厂商并落盘（不依赖前端页面存活）
restoreVideoTasks().catch((error) => console.error('[VideoTask] 恢复任务失败:', error));
// 恢复上次进程未完成的图片任务：重启后继续生成并落盘
restoreImageTasks().catch((error) => console.error('[ImageTask] 恢复任务失败:', error));

// Enable CORS for all routes (must come before static file serving)
app.use(cors());
app.use(requestId);
app.use(accessLog);
app.use(express.json({ limit: '100mb' }));

// Serve static assets from library with CORS headers for cross-origin image access
app.use('/library', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}, express.static(LIBRARY_DIR));


const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.warn("SERVER WARNING: GEMINI_API_KEY is not set in environment or .env file.");
}

// ============================================================================
// KLING AI CONFIGURATION
// ============================================================================

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const KLING_BASE_URL = 'https://api-singapore.klingai.com';

if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    console.warn("SERVER WARNING: KLING_ACCESS_KEY or KLING_SECRET_KEY not set. Kling AI models will not work.");
}

// ============================================================================
// HAILUO AI CONFIGURATION
// ============================================================================

const HAILUO_API_KEY = process.env.HAILUO_API_KEY;

if (!HAILUO_API_KEY) {
    console.warn("SERVER WARNING: HAILUO_API_KEY not set. Hailuo AI models will not work.");
}

// ============================================================================
// OPENAI GPT IMAGE CONFIGURATION
// ============================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
    console.warn("SERVER WARNING: OPENAI_API_KEY not set. OpenAI GPT Image models will not work.");
}

// ============================================================================
// FAL.AI CONFIGURATION (for Kling 2.6 Motion Control)
// ============================================================================

const FAL_API_KEY = process.env.FAL_API_KEY;

if (!FAL_API_KEY) {
    console.warn("SERVER WARNING: FAL_API_KEY not set. Kling 2.6 Motion Control will not work.");
}

// ============================================================================
// DOUBAO SEEDANCE CONFIGURATION
// ============================================================================

const SEEDANCE_API_KEY = process.env.SEEDANCE_API_KEY;

if (!SEEDANCE_API_KEY) {
    console.warn("SERVER WARNING: SEEDANCE_API_KEY not set. Doubao Seedance video models will not work.");
}

// ============================================================================
// DOUBAO VLM (CHAT ASSISTANT) CONFIGURATION
// ============================================================================

const VLM_DOUBAO_API_KEY = process.env.VLM_DOUBAO_API_KEY;

if (!VLM_DOUBAO_API_KEY) {
    console.warn("SERVER WARNING: VLM_DOUBAO_API_KEY not set. Chat assistant will fall back to Gemini.");
}

// ============================================================================
// DOUBAO SEEDREAM (IMAGE) CONFIGURATION
// ============================================================================

const SEEDREAM_API_KEY = process.env.SEEDREAM_API_KEY;

if (!SEEDREAM_API_KEY) {
    console.warn("SERVER WARNING: SEEDREAM_API_KEY not set. Doubao Seedream image models will not work.");
}

// Set up app.locals for sharing config with route modules
app.locals.GEMINI_API_KEY = API_KEY;
app.locals.KLING_ACCESS_KEY = KLING_ACCESS_KEY;
app.locals.KLING_SECRET_KEY = KLING_SECRET_KEY;
app.locals.HAILUO_API_KEY = HAILUO_API_KEY;
app.locals.OPENAI_API_KEY = OPENAI_API_KEY;
app.locals.FAL_API_KEY = FAL_API_KEY;
app.locals.SEEDANCE_API_KEY = SEEDANCE_API_KEY;
app.locals.VLM_DOUBAO_API_KEY = VLM_DOUBAO_API_KEY;
app.locals.DRAMA_API_KEY = process.env.DRAMA_API_KEY || VLM_DOUBAO_API_KEY;
app.locals.SEEDREAM_API_KEY = SEEDREAM_API_KEY;
app.locals.IMAGES_DIR = IMAGES_DIR;
app.locals.VIDEOS_DIR = VIDEOS_DIR;
app.locals.LIBRARY_DIR = LIBRARY_DIR;

// Mount generation routes (image and video generation)
app.use('/api', generationRoutes);

// Mount workflow routes (工作流、公共模板、项目画布)
app.use('/api', workflowsRoutes);

// Mount Twitter routes (Post to X feature)
app.use('/api/twitter', twitterRoutes);

// Mount TikTok routes (Post to TikTok feature)
app.use('/api/tiktok-post', tiktokPostRoutes);

// Mount Local Models routes (本地开源模型发现与推理)
app.use('/api/local-models', localModelsRoutes);

// Mount Storyboard routes (AI script generation)
app.use('/api/storyboard', storyboardRoutes);

// Mount Drama routes (剧本智能解析：拆集 + 资产识别)
app.use('/api/drama', dramaRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/projects', projectsRoutes);
// 制作过程状态（资产确认 / 分镜 / 配音 / 任务台账），路径同为 /api/projects/:id/state
app.use('/api/projects', projectStateRoutes);

// Mount TTS routes (火山引擎豆包语音合成)
app.use('/api/tts', ttsRoutes);

// Mount dubbing routes (整集配音音轨：按角色音色逐条合成后拼接)
app.use('/api/dubbing', dubbingRoutes);

// Mount Video Merge routes (视频拼接成片：xfade 转场 + TTS 音轨覆盖)
app.use('/api/video-merge', videoMergeRoutes);

// Mount assets routes (生成素材历史：图片/视频列表与删除)
app.use('/api/assets', assetsRoutes);

// Mount tiktok import routes (TikTok 视频导入与校验)
app.use('/api/tiktok', tiktokImportRoutes);

// Mount video trim routes (视频裁剪)
app.use('/api/trim-video', videoTrimRoutes);

// Mount chat routes (AI 对话，SSE 流式)
app.use('/api/chat', chatRoutes);

// Mount gemini routes (图片描述 / 提示词优化)
app.use('/api/gemini', geminiRoutes);

// Mount library routes (精选素材库)
app.use('/api/library', libraryRoutes);

// NOTE: Old Kling helpers removed - now in server/services/kling.js

// NOTE: Old generation routes removed - now in server/routes/generation.js


// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '..', 'dist');
    app.use(express.static(distPath));

    // Handle SPA routing: 未命中的前端路由返回 index.html。
    // 注意：Express 5 移除了 '*' 字符串通配（path-to-regexp v8 会直接抛错），
    // 必须用 '/{*splat}'（花括号表示可匹配根路径 '/'）。
    // /api、/library 不在此兜底，交由后面的 notFoundHandler 返回 JSON 404。
    app.get('/{*splat}', (req, res, next) => {
        if (req.path === '/api' || req.path.startsWith('/api/') ||
            req.path === '/library' || req.path.startsWith('/library/')) {
            return next();
        }
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

// 统一 404 与错误响应（必须在所有路由与 SPA fallback 之后）
app.use(notFoundHandler);
app.use(errorHandler);

// 进程级兜底，仅记录日志
installProcessGuards();

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
