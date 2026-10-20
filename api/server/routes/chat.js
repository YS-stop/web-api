/**
 * chat.js
 *
 * AI 对话（LangGraph Agent）接口。
 *   GET    /api/chat/models
 *   POST   /api/chat            SSE 流式响应
 *   GET    /api/chat/sessions
 *   GET    /api/chat/sessions/:id
 *   DELETE /api/chat/sessions/:id
 *
 * 由 server/index.js 内联代码搬出，逻辑保持不变。
 */

import express from 'express';
import chatAgent from '../agent/index.js';

const router = express.Router();

// 与原 index.js 一致：模块加载时读取一次，运行中改 .env 不生效
const VLM_DOUBAO_API_KEY = process.env.VLM_DOUBAO_API_KEY;
const API_KEY = process.env.GEMINI_API_KEY;

// 可用聊天模型（按 .env 中已配置的 key 决定）
const CHAT_MODEL_DEFS = [
    { id: 'doubao', label: '豆包 Seed', provider: 'doubao', key: () => VLM_DOUBAO_API_KEY },
    { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek', key: () => process.env.DRAMA_API_KEY || VLM_DOUBAO_API_KEY },
    { id: 'gemini', label: 'Gemini 2.0 Flash', provider: 'gemini', key: () => API_KEY },
];

/** 根据前端选择的模型 id 解析 provider 与 apiKey；未指定或不可用时自动选择 */
function resolveChatModel(modelId) {
    const def = CHAT_MODEL_DEFS.find(d => d.id === modelId);
    if (def) {
        const key = def.key();
        if (key) return { provider: def.provider, apiKey: key };
    }
    if (VLM_DOUBAO_API_KEY) return { provider: 'doubao', apiKey: VLM_DOUBAO_API_KEY };
    return { provider: 'gemini', apiKey: API_KEY };
}

// List available chat models
router.get('/models', (req, res) => {
    const models = CHAT_MODEL_DEFS.filter(d => !!d.key()).map(d => ({ id: d.id, label: d.label }));
    res.json(models);
});

// Send a message to the chat agent
router.post('/', async (req, res) => {
    try {
        const { sessionId, message, media, scope, model } = req.body;

        // 聊天模型：按前端选择解析，未指定时自动（豆包优先，回退 Gemini）
        const { provider: chatProvider, apiKey: chatApiKey } = resolveChatModel(model);

        if (!chatApiKey) {
            return res.status(500).json({ error: "Server missing API Key config" });
        }

        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required" });
        }

        if (!message && !media) {
            return res.status(400).json({ error: "message or media is required" });
        }

        // SSE 流式响应
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        let clientAborted = false;
        res.on('close', () => { if (!res.writableEnded) clientAborted = true; });

        const result = await chatAgent.streamChat(
            sessionId, message, media, chatApiKey, chatProvider,
            (chunk) => {
                if (!clientAborted && !res.writableEnded) {
                    res.write('data: ' + JSON.stringify({ type: 'chunk', content: chunk }) + '\n\n');
                }
            },
            () => clientAborted,
            scope
        );

        if (!clientAborted && !res.writableEnded) {
            res.write('data: ' + JSON.stringify({ type: 'done', topic: result.topic, messageCount: result.messageCount }) + '\n\n');
            res.end();
        }
    } catch (error) {
        console.error("Chat API Error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || "Chat failed" });
        } else {
            try {
                res.write('data: ' + JSON.stringify({ type: 'error', error: error.message || 'Chat failed' }) + '\n\n');
                res.end();
            } catch (e) { /* client already gone */ }
        }
    }
});

// List all chat sessions
router.get('/sessions', async (req, res) => {
    try {
        const sessions = chatAgent.listSessions(req.query.scope);
        res.json(sessions);
    } catch (error) {
        console.error("List sessions error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Delete a chat session
router.delete('/sessions/:id', async (req, res) => {
    try {
        // deleteSession 对不存在的会话或非法 id 返回 false，避免误报成功
        const deleted = chatAgent.deleteSession(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: "Session not found" });
        }
        res.json({ success: true });
    } catch (error) {
        console.error("Delete session error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Get full session data (for loading a specific chat)
router.get('/sessions/:id', async (req, res) => {
    try {
        const sessionData = chatAgent.getSessionData(req.params.id);
        if (!sessionData) {
            return res.status(404).json({ error: "Session not found" });
        }
        res.json(sessionData);
    } catch (error) {
        console.error("Get session error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
