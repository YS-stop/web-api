/**
 * useChatAgent.ts
 * 
 * Custom hook for chat agent interactions.
 * Manages messages, sessions, topics, and API communication.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    media?: {
        type: 'image' | 'video';
        url: string;
    }[]; // Array of media attachments
    timestamp: Date;
}

export interface ChatSession {
    id: string;
    topic: string;
    createdAt: string;
    updatedAt?: string;
    messageCount: number;
}

export interface ChatModelOption {
    id: string;
    label: string;
}

interface UseChatAgentReturn {
    messages: ChatMessage[];
    topic: string | null;
    sessionId: string | null;
    isLoading: boolean;
    error: string | null;
    sessions: ChatSession[];
    isLoadingSessions: boolean;
    models: ChatModelOption[];
    selectedModel: string;
    setSelectedModel: (id: string) => void;
    sendMessage: (content: string, media?: { type: 'image' | 'video'; url: string; base64?: string }[]) => Promise<void>;
    stopGeneration: () => void;
    removeLastExchange: () => void;
    startNewChat: () => void;
    loadSession: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    refreshSessions: () => Promise<void>;
    hasMessages: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
    return `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// HOOK
// ============================================================================

export function useChatAgent(scope: string = 'free'): UseChatAgentReturn {
    // --- State ---
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [topic, setTopic] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = useState(false);
    const [models, setModels] = useState<ChatModelOption[]>([]);
    const [selectedModel, setSelectedModel] = useState('');

    // Use ref to track if we've initialized a session
    const hasInitializedRef = useRef(false);
    // Abort controller for interrupting in-flight chat requests
    const abortControllerRef = useRef<AbortController | null>(null);

    // --- Callbacks ---

    /**
     * Initialize a new session if needed
     */
    const ensureSession = useCallback(() => {
        if (!sessionId) {
            const newSessionId = generateSessionId();
            setSessionId(newSessionId);
            return newSessionId;
        }
        return sessionId;
    }, [sessionId]);

    /**
     * Fetch all chat sessions from the server
     */
    const refreshSessions = useCallback(async () => {
        setIsLoadingSessions(true);
        try {
            const response = await fetch(`/api/chat/sessions?scope=${encodeURIComponent(scope)}`);
            if (response.ok) {
                const data = await response.json();
                setSessions(data);
            }
        } catch (err) {
            console.error('Failed to fetch sessions:', err);
        } finally {
            setIsLoadingSessions(false);
        }
    }, [scope]);

    /**
     * Fetch available chat models and pick a default
     */
    const fetchModels = useCallback(async () => {
        try {
            const response = await fetch('/api/chat/models');
            if (response.ok) {
                const data: ChatModelOption[] = await response.json();
                setModels(data);
                setSelectedModel(prev => prev || data[0]?.id || '');
            }
        } catch (err) {
            console.error('Failed to fetch chat models:', err);
        }
    }, []);

    /**
     * Load a specific session by ID
     */
    const loadSession = useCallback(async (targetSessionId: string) => {
        setIsLoading(true);
        setError(null);

        try {
            const response = await fetch(`/api/chat/sessions/${targetSessionId}`);
            if (!response.ok) {
                throw new Error('Session not found');
            }

            const data = await response.json();

            // Convert messages to ChatMessage format
            const loadedMessages: ChatMessage[] = data.messages.map((msg: any, index: number) => ({
                id: `loaded-${targetSessionId}-${index}`,
                role: msg.role,
                content: msg.content,
                media: msg.media,
                timestamp: new Date(msg.timestamp || data.createdAt),
            }));

            setSessionId(targetSessionId);
            setMessages(loadedMessages);
            setTopic(data.topic);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to load session';
            setError(errorMessage);
            console.error('Load session error:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Delete a session
     */
    const deleteSession = useCallback(async (targetSessionId: string) => {
        try {
            await fetch(`/api/chat/sessions/${targetSessionId}`, {
                method: 'DELETE',
            });

            // Refresh sessions list
            await refreshSessions();

            // If we deleted the current session, start a new one
            if (targetSessionId === sessionId) {
                setMessages([]);
                setTopic(null);
                setSessionId(generateSessionId());
            }
        } catch (err) {
            console.error('Failed to delete session:', err);
        }
    }, [sessionId, refreshSessions]);

    /**
     * Send a message to the chat agent
     */
    const sendMessage = useCallback(async (
        content: string,
        media?: { type: 'image' | 'video'; url: string; base64?: string }[]
    ) => {
        const currentSessionId = ensureSession();
        setError(null);
        setIsLoading(true);

        // Add user message immediately
        const userMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'user',
            content,
            media: media ? media.map(m => ({ type: m.type, url: m.url })) : undefined,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, userMessage]);

        // 创建空的 AI 消息占位（流式填充）
        const assistantId = generateMessageId();
        const assistantPlaceholder: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            content: '',
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, assistantPlaceholder]);

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: currentSessionId,
                    scope,
                    model: selectedModel || undefined,
                    message: content,
                    media: media ? media.map(m => ({
                        type: m.type,
                        base64: m.base64 || m.url,
                    })) : undefined,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || response.statusText);
            }

            // 读取 SSE 流
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Stream not supported');
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const event of events) {
                    if (!event.startsWith('data: ')) continue;
                    let data: any;
                    try {
                        data = JSON.parse(event.slice(6));
                    } catch { continue; }

                    if (data.type === 'chunk') {
                        setMessages(prev => prev.map(m =>
                            m.id === assistantId ? { ...m, content: m.content + data.content } : m
                        ));
                    } else if (data.type === 'done') {
                        if (data.topic) setTopic(data.topic);
                    } else if (data.type === 'error') {
                        setError(data.error || 'Chat failed');
                    }
                }
            }

            await refreshSessions();
        } catch (err: unknown) {
            if ((err as any)?.name === 'AbortError') {
                // 用户中断：给占位消息标记中断
                setMessages(prev => prev.map(m =>
                    m.id === assistantId ? { ...m, content: m.content + '\n\n[已中断]' } : m
                ));
            } else {
                const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
                setError(errorMessage);
                console.error('Chat error:', err);
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    }, [ensureSession, refreshSessions, scope, selectedModel]);

    /**
     * 中断当前生成
     */
    const stopGeneration = useCallback(() => {
        abortControllerRef.current?.abort();
    }, []);

    /**
     * 移除最后一轮（用户消息 + AI 回复），用于「编辑上一条」
     */
    const removeLastExchange = useCallback(() => {
        setMessages(prev => {
            const copy = [...prev];
            // 移除末尾的 assistant 消息（如果存在）
            while (copy.length > 0 && copy[copy.length - 1].role === 'assistant') {
                copy.pop();
            }
            // 移除末尾的 user 消息
            if (copy.length > 0 && copy[copy.length - 1].role === 'user') {
                copy.pop();
            }
            return copy;
        });
    }, []);

    /**
     * Start a new chat session
     */
    const startNewChat = useCallback(() => {
        setMessages([]);
        setTopic(null);
        setSessionId(generateSessionId());
        setError(null);
        hasInitializedRef.current = false;
    }, []);

    // scope 变化时重置当前会话（切换画布/项目时避免串用对话内容）
    const prevScopeRef = useRef(scope);
    useEffect(() => {
        if (prevScopeRef.current !== scope) {
            prevScopeRef.current = scope;
            setMessages([]);
            setTopic(null);
            setSessionId(generateSessionId());
            setError(null);
        }
    }, [scope]);

    // Load sessions on mount
    useEffect(() => {
        refreshSessions();
    }, [refreshSessions]);

    // Load available models on mount
    useEffect(() => {
        fetchModels();
    }, [fetchModels]);

    return {
        messages,
        topic,
        sessionId,
        isLoading,
        error,
        sessions,
        isLoadingSessions,
        models,
        selectedModel,
        setSelectedModel,
        sendMessage,
        stopGeneration,
        removeLastExchange,
        startNewChat,
        loadSession,
        deleteSession,
        refreshSessions,
        hasMessages: messages.length > 0,
    };
}

export default useChatAgent;
