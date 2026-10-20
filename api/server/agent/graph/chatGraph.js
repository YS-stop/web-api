/**
 * chatGraph.js
 * 
 * LangGraph state graph for the chat agent.
 * Defines the workflow: receives messages → processes with LLM → returns response.
 * 
 * NOTE: This is a simple conversational agent. If more complex multi-step
 * workflows, tool usage, or agent loops are needed, consider converting
 * to Python LangGraph which has a more mature ecosystem.
 */

import { StateGraph, MessagesAnnotation, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { CHAT_AGENT_SYSTEM_PROMPT, TOPIC_GENERATION_PROMPT } from "../prompts/system.js";

// ============================================================================
// MODEL CONFIGURATION
// ============================================================================

/**
 * Creates a configured Gemini model instance
 * @param {string} apiKey - Google AI API key
 * @returns {ChatGoogleGenerativeAI} Configured model
 */
/** OpenAI 兼容 provider 的连接配置（豆包 VLM / DeepSeek 均走火山方舟） */
export function getOpenAICompatConfig(provider) {
    if (provider === 'doubao') {
        return {
            baseUrl: process.env.VLM_DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
            model: process.env.VLM_DOUBAO_MODEL_ID || 'ep-m-20260731200545-vdkh5',
        };
    }
    if (provider === 'deepseek') {
        return {
            baseUrl: process.env.DRAMA_BASE_URL || process.env.VLM_DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
            model: process.env.DRAMA_MODEL_ID || 'deepseek-v4-flash-ga-260731',
        };
    }
    return null;
}

export function createModel(apiKey, provider = 'gemini') {
    const compat = getOpenAICompatConfig(provider);
    if (compat) {
        return new ChatOpenAI({
            model: compat.model,
            apiKey: apiKey,
            configuration: {
                baseURL: compat.baseUrl,
            },
            temperature: 0.7,
            maxTokens: 1024,
        });
    }

    return new ChatGoogleGenerativeAI({
        model: "gemini-2.0-flash",
        apiKey: apiKey,
        temperature: 0.7,
        maxOutputTokens: 2048,
    });
}

/**
 * Streams model output chunk by chunk (for SSE streaming responses)
 */
function langchainContentToOpenAI(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            if (part.type === 'image_url') return { type: 'image_url', image_url: part.image_url };
            return { type: 'text', text: '' };
        });
    }
    return String(content);
}

export async function streamModel(messages, apiKey, provider = 'gemini', onChunk) {
    const compat = getOpenAICompatConfig(provider);
    if (compat) {
        const openaiMessages = [
            { role: 'system', content: CHAT_AGENT_SYSTEM_PROMPT },
            ...messages.map(m => ({
                role: m._getType?.() === 'human' ? 'user' : 'assistant',
                content: langchainContentToOpenAI(m.content),
            })),
        ];
        const resp = await fetch(compat.baseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: compat.model,
                messages: openaiMessages,
                stream: true,
                max_tokens: 1024,
                temperature: 0.7,
            }),
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) onChunk(delta);
                } catch (e) { /* 忽略不完整的行 */ }
            }
        }
    } else {
        const model = createModel(apiKey, provider);
        const systemMessage = new SystemMessage(CHAT_AGENT_SYSTEM_PROMPT);
        const allMessages = [systemMessage, ...messages];
        const stream = await model.stream(allMessages);
        for await (const chunk of stream) {
            const content = chunk.content;
            if (typeof content === 'string' && content) {
                onChunk(content);
            }
        }
    }
}

// ============================================================================
// GRAPH NODES
// ============================================================================

/**
 * Agent node - processes messages with the LLM
 * @param {object} state - Current graph state with messages
 * @param {object} config - Runtime config including API key
 * @returns {object} Updated state with AI response
 */
async function agentNode(state, config) {
    const model = createModel(config.configurable?.apiKey, config.configurable?.provider);

    // Build messages array with system prompt
    const systemMessage = new SystemMessage(CHAT_AGENT_SYSTEM_PROMPT);
    const allMessages = [systemMessage, ...state.messages];

    // Invoke the model
    const response = await model.invoke(allMessages);

    return {
        messages: [response],
    };
}

// ============================================================================
// GRAPH DEFINITION
// ============================================================================

/**
 * Create and compile the chat graph
 * Simple flow: START → agent → END
 */
export function createChatGraph() {
    const workflow = new StateGraph(MessagesAnnotation)
        .addNode("agent", agentNode)
        .addEdge("__start__", "agent")
        .addEdge("agent", END);

    return workflow.compile();
}

// ============================================================================
// TOPIC GENERATION
// ============================================================================

/**
 * Generate a topic title for the conversation
 * @param {Array} messages - Conversation messages
 * @param {string} apiKey - Google AI API key
 * @returns {Promise<string>} Generated topic title
 */
export async function generateTopicTitle(messages, apiKey, provider = 'gemini') {
    const model = createModel(apiKey, provider);

    // Build context from messages (limit to first few for efficiency)
    const contextMessages = messages.slice(0, 6);
    const conversationSummary = contextMessages
        .map(m => `${m._getType?.() === 'human' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n');

    const prompt = `${TOPIC_GENERATION_PROMPT}\n\nConversation:\n${conversationSummary}`;

    const response = await model.invoke([new HumanMessage(prompt)]);

    // Extract just the topic text
    return response.content.toString().trim();
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    createChatGraph,
    createModel,
    generateTopicTitle,
};
