/**
 * agent/index.js
 * 
 * Main entry point for the LangGraph chat agent.
 * Exports the compiled graph and utility functions.
 * 
 * NOTE: Currently implemented in JavaScript/LangGraph.js for simplicity.
 * If more advanced agent capabilities are needed (complex tool chains,
 * multi-agent systems, advanced memory), consider migrating to Python
 * LangGraph which has a more mature and feature-rich ecosystem.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createChatGraph, generateTopicTitle, streamModel } from "./graph/chatGraph.js";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { resolveInside } from '../utils/safePath.js';
import { isDbEnabled, isDualWrite, one, many, exec } from '../db/index.js';

// ============================================================================
// FILE PATHS
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHATS_DIR = path.join(__dirname, '..', '..', 'library', 'chats');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'library', 'images');

// Ensure chats directory exists
if (!fs.existsSync(CHATS_DIR)) {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
}

/**
 * Resolve an image URL or base64 to a base64 data URL
 * Handles both file paths (/library/images/...) and data URLs
 */
function resolveImageToBase64(imageInput) {
    if (!imageInput) return null;

    // Already a base64 data URL
    if (imageInput.startsWith('data:')) {
        return imageInput;
    }

    // Handle full URL or path
    let cleanPath = imageInput;
    try {
        if (imageInput.startsWith('http')) {
            const u = new URL(imageInput);
            cleanPath = u.pathname;
        }
    } catch (e) {
        // invalid url, treat as path
    }

    // Decode URI components (e.g., %20 -> space)
    cleanPath = decodeURIComponent(cleanPath);

    // File URL - read from disk
    if (cleanPath.startsWith('/library/images/')) {
        const filename = cleanPath.replace('/library/images/', '');
        // 防目录逃逸：`/library/images/../../.env` 会读到库外文件
        const filePath = resolveInside(IMAGES_DIR, filename);
        if (filePath && fs.existsSync(filePath)) {
            const buffer = fs.readFileSync(filePath);
            const ext = path.extname(filename).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
            return `data:${mimeType};base64,${buffer.toString('base64')}`;
        }
    }

    // Return as-is if unknown format
    return imageInput;
}

// ============================================================================
// SESSION MANAGEMENT (FILE-BASED)
// ============================================================================

/**
 * In-memory cache for active sessions
 * Sessions are also persisted to disk after each message
 */
const sessionCache = new Map();

/**
 * Convert multimodal content to text representation for serialization
 * This ensures context is preserved without huge base64 data
 */
function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        const parts = [];
        let imageCount = 0;

        for (const part of content) {
            if (part.type === 'text') {
                parts.push(part.text);
            } else if (part.type === 'image_url') {
                imageCount++;
                parts.push(`[IMAGE ${imageCount} ATTACHED]`);
            }
        }

        return parts.join('\n');
    }

    return JSON.stringify(content);
}

/**
 * Convert LangChain messages to serializable format
 * Multimodal messages are converted to text with [IMAGE ATTACHED] markers
 */
function serializeMessages(messages) {
    return messages.map(msg => ({
        role: msg._getType?.() === 'human' ? 'user' : 'assistant',
        content: contentToText(msg.content),
        media: msg.additional_kwargs?.media,
        timestamp: new Date().toISOString()
    }));
}

/**
 * Convert serialized messages back to LangChain format
 * All messages are now stored as text (images converted to markers)
 */
function deserializeMessages(messages) {
    return messages.map(msg => {
        if (msg.role === 'user') {
            const message = new HumanMessage(msg.content);
            if (msg.media) {
                message.additional_kwargs = { media: msg.media };
            }
            return message;
        } else {
            return new AIMessage(msg.content);
        }
    });
}

/**
 * Get the file path for a session.
 * 防目录逃逸：sessionId 来自 URL，`..%2Fusers` 解码后会读到/删除 chats 之外的文件。
 * @returns {string|null} 逃逸时返回 null
 */
function getSessionPath(sessionId) {
    return resolveInside(CHATS_DIR, `${sessionId}.json`);
}

/** 时间字段统一输出 ISO 字符串（DB 返回 Date，文件里本来就是字符串） */
function toIso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Save a session.
 * DB_DRIVER=db/dual 时写 chat_sessions；file 模式下仍写 library/chats/{id}.json。
 * dual 模式两份都写，切换驱动后历史不丢。
 */
async function saveSession(sessionId, session, scope) {
    const filePath = getSessionPath(sessionId);
    if (!filePath) {
        throw new Error('Invalid session id');
    }

    const createdAt = session.createdAt instanceof Date
        ? session.createdAt.toISOString()
        : (session.createdAt || new Date().toISOString());

    const data = {
        id: sessionId,
        scope: scope || 'free',
        topic: session.topic ?? null,
        createdAt,
        updatedAt: new Date().toISOString(),
        messages: serializeMessages(session.messages)
    };

    if (isDbEnabled()) {
        await exec(
            `INSERT INTO chat_sessions (id, scope, topic, messages, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
                scope      = EXCLUDED.scope,
                topic      = EXCLUDED.topic,
                messages   = EXCLUDED.messages,
                updated_at = EXCLUDED.updated_at`,
            [data.id, data.scope, data.topic, JSON.stringify(data.messages), data.createdAt, data.updatedAt],
        );
    }

    if (!isDbEnabled() || isDualWrite()) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
}

/**
 * Load a session（结构：{ messages, topic, createdAt }）
 */
async function loadSession(sessionId) {
    const filePath = getSessionPath(sessionId);
    if (!filePath) return null;

    if (isDbEnabled()) {
        try {
            const row = await one(
                'SELECT topic, messages, created_at FROM chat_sessions WHERE id = $1',
                [sessionId],
            );
            if (!row) return null;
            return {
                messages: deserializeMessages(Array.isArray(row.messages) ? row.messages : []),
                topic: row.topic,
                createdAt: row.created_at ? new Date(row.created_at) : new Date(),
            };
        } catch (err) {
            console.error(`Failed to load session ${sessionId} from db:`, err.message);
            return null;
        }
    }

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content);
        return {
            messages: deserializeMessages(data.messages),
            topic: data.topic,
            createdAt: new Date(data.createdAt)
        };
    } catch (err) {
        console.error(`Failed to load session ${sessionId}:`, err);
        return null;
    }
}

/**
 * Get or create a chat session
 * @param {string} sessionId - Unique session identifier
 * @returns {Promise<object>} Session object
 */
export async function getSession(sessionId) {
    // Check cache first
    if (sessionCache.has(sessionId)) {
        return sessionCache.get(sessionId);
    }

    // Try to load from storage
    const loaded = await loadSession(sessionId);
    if (loaded) {
        sessionCache.set(sessionId, loaded);
        return loaded;
    }

    // Create new session
    const newSession = {
        messages: [],
        topic: null,
        createdAt: new Date(),
    };
    sessionCache.set(sessionId, newSession);
    return newSession;
}

/**
 * Delete a chat session
 * @param {string} sessionId - Session to delete
 * @returns {Promise<boolean>} Whether session existed and was deleted
 */
export async function deleteSession(sessionId) {
    sessionCache.delete(sessionId);

    const filePath = getSessionPath(sessionId);
    if (!filePath) return false;

    let deleted = false;

    if (isDbEnabled()) {
        const result = await exec('DELETE FROM chat_sessions WHERE id = $1', [sessionId]);
        deleted = result.rowCount > 0;
    }

    if (!isDbEnabled() || isDualWrite()) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            deleted = true;
        }
    }

    return deleted;
}

/**
 * List all sessions (for chat history)
 * @param {string} [scope] - 按归属域过滤，缺省返回全部
 * @returns {Promise<Array>} Array of session summaries
 */
export async function listSessions(scope) {
    if (isDbEnabled()) {
        const rows = await many(
            `SELECT id, scope, topic, created_at, updated_at,
                    CASE WHEN jsonb_typeof(messages) = 'array'
                         THEN jsonb_array_length(messages) ELSE 0 END AS message_count
             FROM chat_sessions
             WHERE ($1::text IS NULL OR scope = $1)
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
            [scope || null],
        );
        return rows.map((row) => ({
            id: row.id,
            scope: row.scope || 'free',
            topic: row.topic || 'New Chat',
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
            messageCount: Number(row.message_count) || 0,
        }));
    }

    if (!fs.existsSync(CHATS_DIR)) {
        return [];
    }

    const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
        try {
            const filePath = path.join(CHATS_DIR, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            // 按 scope 过滤；旧会话文件没有 scope 字段，默认归入 'free'
            if (scope && (data.scope || 'free') !== scope) continue;
            sessions.push({
                id: data.id,
                scope: data.scope || 'free',
                topic: data.topic || "New Chat",
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                messageCount: data.messages?.length || 0
            });
        } catch (err) {
            console.error(`Failed to read session file ${file}:`, err);
        }
    }

    // Sort by most recent first
    return sessions.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

/**
 * Get full session data (for loading a specific chat)
 * @param {string} sessionId - Session ID
 * @returns {Promise<object|null>} Full session data with messages
 */
export async function getSessionData(sessionId) {
    const filePath = getSessionPath(sessionId);
    if (!filePath) return null;

    if (isDbEnabled()) {
        try {
            const row = await one(
                `SELECT id, scope, topic, messages, created_at, updated_at
                 FROM chat_sessions WHERE id = $1`,
                [sessionId],
            );
            if (!row) return null;
            return {
                id: row.id,
                scope: row.scope || 'free',
                topic: row.topic,
                createdAt: toIso(row.created_at),
                updatedAt: toIso(row.updated_at),
                messages: Array.isArray(row.messages) ? row.messages : [],
            };
        } catch (err) {
            console.error(`Failed to load session data ${sessionId} from db:`, err.message);
            return null;
        }
    }

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`Failed to load session data ${sessionId}:`, err);
        return null;
    }
}

// ============================================================================
// CHAT FUNCTIONS
// ============================================================================

/**
 * Send a message to the chat agent and get a response
 * @param {string} sessionId - Session identifier
 * @param {string} content - User message content
 * @param {Array} media - Optional media attachments [{ type, url, base64 }, ...]
 * @param {string} apiKey - Google AI API key
 * @returns {Promise<object>} { response: string, topic?: string }
 */
export async function sendMessage(sessionId, content, media, apiKey, provider = 'gemini', scope = 'free') {
    const session = await getSession(sessionId);
    const graph = createChatGraph();

    // Debug: Log session state
    console.log(`[Chat] Session ${sessionId} has ${session.messages.length} existing messages`);

    // Build the user message content
    let messageContent;
    if (media && Array.isArray(media) && media.length > 0) {
        // Multimodal message with images/videos
        const contentParts = [{ type: "text", text: content || "What do you see in these images?" }];

        for (const m of media) {
            // Resolve file URLs to base64 if needed
            const resolvedBase64 = resolveImageToBase64(m.base64);
            if (!resolvedBase64) continue;

            const mimeType = m.type === 'video' ? 'video/mp4' : 'image/png';
            // Extract base64 data if it's a data URL
            const base64Data = resolvedBase64.includes(',')
                ? resolvedBase64.split(',')[1]
                : resolvedBase64;

            contentParts.push({
                type: "image_url",
                image_url: {
                    url: `data:${mimeType};base64,${base64Data}`,
                },
            });
        }

        messageContent = contentParts;
    } else {
        messageContent = content;
    }

    // Debug logging


    // Add user message to session
    const userMessage = new HumanMessage(messageContent);

    // Attach metadata for persistence (excluding base64 to save space)
    if (media && Array.isArray(media)) {
        userMessage.additional_kwargs = {
            ...userMessage.additional_kwargs,
            media: media.map(m => {
                // If base64 field contains a URL, preserve it as url
                let url = m.url;
                const b64 = m.base64;
                if (!url && b64 && !b64.startsWith('data:')) {
                    url = b64;
                }
                return { ...m, url, base64: undefined };
            })
        };
    }

    session.messages.push(userMessage);

    console.log(`[Chat] Sending ${session.messages.length} messages to LLM`);

    // Invoke the graph
    const result = await graph.invoke(
        { messages: session.messages },
        { configurable: { apiKey, provider } }
    );

    // Extract AI response from result
    const aiResponse = result.messages[result.messages.length - 1];
    session.messages.push(aiResponse);

    // Convert the multimodal user message to text for future context
    // This ensures the AI remembers what images contained in subsequent turns
    if (typeof messageContent !== 'string') {
        const textVersion = contentToText(messageContent);
        // Replace the last user message with text version but keep metadata
        const userMsgIndex = session.messages.length - 2;
        const originalMsg = session.messages[userMsgIndex];

        const newMsg = new HumanMessage(textVersion);
        if (originalMsg.additional_kwargs) {
            newMsg.additional_kwargs = originalMsg.additional_kwargs;
        }
        session.messages[userMsgIndex] = newMsg;

        session.messages[userMsgIndex] = newMsg;
    }

    // Generate topic if this is the first exchange (2 messages: user + AI)
    let topic = session.topic;
    if (session.messages.length === 2 && !session.topic) {
        try {
            topic = await generateTopicTitle(session.messages, apiKey, provider);
            session.topic = topic;
        } catch (err) {
            console.error("Failed to generate topic:", err);
            topic = "New Chat";
        }
    }

    // Save session after each message（DB / 文件由驱动开关决定）
    await saveSession(sessionId, session, scope);

    return {
        response: aiResponse.content.toString(),
        topic: topic,
        messageCount: session.messages.length,
    };
}

// ============================================================================
// STREAMING CHAT
// ============================================================================

export async function streamChat(sessionId, content, media, apiKey, provider = 'gemini', onChunk, isAborted, scope = 'free') {
    const session = await getSession(sessionId);

    let messageContent;
    if (media && Array.isArray(media) && media.length > 0) {
        const contentParts = [{ type: "text", text: content || "What do you see in these images?" }];
        for (const m of media) {
            const resolvedBase64 = resolveImageToBase64(m.base64);
            if (!resolvedBase64) continue;
            const mimeType = m.type === 'video' ? 'video/mp4' : 'image/png';
            const base64Data = resolvedBase64.includes(',') ? resolvedBase64.split(',')[1] : resolvedBase64;
            contentParts.push({ type: "image_url", image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } });
        }
        messageContent = contentParts;
    } else {
        messageContent = content;
    }

    const userMessage = new HumanMessage(messageContent);
    if (media && Array.isArray(media)) {
        userMessage.additional_kwargs = {
            media: media.map(m => {
                let url = m.url;
                const b64 = m.base64;
                if (!url && b64 && !b64.startsWith('data:')) url = b64;
                return { ...m, url, base64: undefined };
            })
        };
    }
    session.messages.push(userMessage);

    let fullResponse = '';
    await streamModel(session.messages, apiKey, provider, (chunk) => {
        if (isAborted && isAborted()) return;
        fullResponse += chunk;
        onChunk(chunk);
    });

    const aiMessage = new AIMessage(fullResponse);
    session.messages.push(aiMessage);

    if (typeof messageContent !== 'string') {
        const textVersion = contentToText(messageContent);
        const userMsgIndex = session.messages.length - 2;
        const originalMsg = session.messages[userMsgIndex];
        const newMsg = new HumanMessage(textVersion);
        if (originalMsg.additional_kwargs) {
            newMsg.additional_kwargs = originalMsg.additional_kwargs;
        }
        session.messages[userMsgIndex] = newMsg;
    }

    let topic = session.topic;
    if (session.messages.length === 2 && !session.topic) {
        try {
            topic = await generateTopicTitle(session.messages, apiKey, provider);
            session.topic = topic;
        } catch (err) {
            topic = "New Chat";
        }
    }

    await saveSession(sessionId, session, scope);

    return { response: fullResponse, topic, messageCount: session.messages.length };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { createChatGraph, generateTopicTitle, streamModel };

export default {
    getSession,
    deleteSession,
    listSessions,
    getSessionData,
    sendMessage,
    streamChat,
    createChatGraph,
    generateTopicTitle,
};
