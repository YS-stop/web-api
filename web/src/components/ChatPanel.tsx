/**
 * ChatPanel.tsx
 * 
 * Agent chat panel that slides in from the right side.
 * Shows greeting, inspiration suggestions, chat messages, and input.
 * Supports drag-drop of image/video nodes from canvas.
 * Includes chat history panel for viewing past conversations.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, History, Paperclip, Globe, Settings, Send, Sparkles, Plus, Loader2, ChevronLeft, Trash2, MessageSquare, Square, Pencil, Check } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import { useChatAgent, ChatMessage as ChatMessageType, ChatSession } from '../hooks/useChatAgent';

// ============================================================================
// TYPES
// ============================================================================

interface AttachedMedia {
    type: 'image' | 'video';
    url: string;
    nodeId: string;
    base64?: string;
}

interface ChatPanelProps {
    isOpen: boolean;
    onClose: () => void;
    userName?: string;
    isDraggingNode?: boolean;
    onNodeDrop?: (nodeId: string, url: string, type: 'image' | 'video') => void;
    canvasTheme?: 'dark' | 'light';
    scope?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ChatPanel: React.FC<ChatPanelProps> = ({
    isOpen,
    onClose,
    userName,
    isDraggingNode = false,
    canvasTheme = 'dark',
    scope = 'free',
}) => {
    const { t } = useTranslation();
    const displayName = userName || t('chat.defaultUser');
    // --- State ---
    const [message, setMessage] = useState('');
    const [showTip, setShowTip] = useState(true);
    const [attachedMedia, setAttachedMedia] = useState<AttachedMedia[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [showModelMenu, setShowModelMenu] = useState(false);

    // Theme helper
    const isDark = canvasTheme === 'dark';

    // Chat agent hook
    const {
        messages,
        topic,
        isLoading,
        error,
        sessions,
        isLoadingSessions,
        sendMessage,
        stopGeneration,
        removeLastExchange,
        startNewChat,
        loadSession,
        deleteSession,
        hasMessages,
        models,
        selectedModel,
        setSelectedModel,
    } = useChatAgent(scope);

    // Refs
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- Effects ---

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    // --- Event Handlers ---

    const handleDragEnter = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        // Only set false if leaving the panel entirely
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragOver(false);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);

        // Get data from drag event
        const nodeData = e.dataTransfer.getData('application/json');
        if (nodeData) {
            try {
                const { nodeId, url, type } = JSON.parse(nodeData);
                if (url && (type === 'image' || type === 'video')) {
                    // Convert URL to base64 for API consumption
                    let base64Data: string | undefined;

                    if (type === 'image') {
                        try {
                            // Fetch the image and convert to base64
                            const response = await fetch(url);
                            const blob = await response.blob();
                            base64Data = await new Promise<string>((resolve, reject) => {
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                    const result = reader.result as string;
                                    // Extract just the base64 part (remove data:image/...;base64, prefix)
                                    const base64 = result.split(',')[1];
                                    resolve(base64);
                                };
                                reader.onerror = reject;
                                reader.readAsDataURL(blob);
                            });
                        } catch (err) {
                            console.error('Failed to convert image to base64:', err);
                        }
                    }

                    // Add to attachments if not already present
                    setAttachedMedia(prev => {
                        if (prev.some(m => m.nodeId === nodeId)) return prev;
                        return [...prev, { type, url, nodeId, base64: base64Data }];
                    });
                }
            } catch (err) {
                console.error('Failed to parse dropped node data:', err);
            }
        }
    };


    const removeAttachment = (nodeId: string) => {
        setAttachedMedia(prev => prev.filter(m => m.nodeId !== nodeId));
    };

    // 从本地选择文件作为附件上传
    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files: FileList | null = e.target.files;
        if (!files || files.length === 0) return;

        Array.from(files).forEach(file => {
            const isImage = file.type.startsWith('image/');
            const isVideo = file.type.startsWith('video/');
            if (!isImage && !isVideo) return;

            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target?.result as string;
                const base64 = dataUrl.split(',')[1];
                const nodeId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                setAttachedMedia(prev => [...prev, {
                    type: isVideo ? 'video' : 'image',
                    url: dataUrl,
                    nodeId,
                    base64,
                }]);
            };
            reader.readAsDataURL(file);
        });

        e.target.value = '';
    };

    const handleSend = async () => {
        if ((!message.trim() && attachedMedia.length === 0) || isLoading) return;

        const currentMessage = message;
        const currentMedia = attachedMedia;

        // Clear input immediately for better UX
        setMessage('');
        setAttachedMedia([]);

        // Reset textarea height
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }

        // Hide tip after first message
        if (showTip) {
            setShowTip(false);
        }

        await sendMessage(
            currentMessage,
            currentMedia.length > 0 ? currentMedia.map(m => ({
                type: m.type,
                url: m.url,
                base64: m.base64,
            })) : undefined
        );
    };

    // 编辑上一条用户消息：取出内容、移除最后一轮、聚焦输入框
    const handleEditLastMessage = () => {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) {
            setMessage(lastUser.content);
            removeLastExchange();
            if (textareaRef.current) {
                textareaRef.current.focus();
            }
        }
    };

    // 计算最后一条用户消息的索引（用于显示编辑按钮）
    const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);

    const handleNewChat = () => {
        startNewChat();
        setMessage('');
        setAttachedMedia([]);
        setShowTip(true);
        setShowHistory(false);
    };

    const handleLoadSession = async (sessionId: string) => {
        await loadSession(sessionId);
        setShowHistory(false);
        setShowTip(false);
    };

    const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        await deleteSession(sessionId);
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diffDays === 1) {
            return t('chat.yesterday');
        } else if (diffDays < 7) {
            return t('chat.daysAgo', { n: diffDays });
        } else {
            return date.toLocaleDateString();
        }
    };

    // --- Render ---

    if (!isOpen) return null;

    const showHighlight = isDraggingNode || isDragOver;

    return (
        <div
            className={`fixed top-0 right-0 w-[400px] h-full border-l flex flex-col z-40 shadow-2xl transition-all duration-300 ${showHighlight ? 'border-cyan-500 border-2' : isDark ? 'border-neutral-800' : 'border-neutral-200'} ${isDark ? 'bg-[#1a1a1a]' : 'bg-white'}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Drag Overlay */}
            {showHighlight && (
                <div className="absolute inset-0 bg-cyan-500/10 pointer-events-none z-10 flex items-center justify-center">
                    <div className="bg-cyan-500/20 border-2 border-dashed border-cyan-400 rounded-2xl px-8 py-6 text-center">
                        <Sparkles className="w-10 h-10 mx-auto mb-2 text-cyan-400" />
                        <p className="text-cyan-300 font-medium">{t('chat.dropHere')}</p>
                    </div>
                </div>
            )}

            {/* History Panel */}
            {showHistory && (
                <div className={`absolute inset-0 z-20 flex flex-col ${isDark ? 'bg-[#1a1a1a]' : 'bg-white'}`}>
                    {/* History Header */}
                    <div className={`flex items-center gap-3 px-4 py-3 border-b ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                        <button
                            onClick={() => setShowHistory(false)}
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <span className={`font-medium text-sm ${isDark ? 'text-white' : 'text-neutral-900'}`}>{t('chat.history')}</span>
                    </div>

                    {/* History List */}
                    <div className="flex-1 overflow-y-auto p-4">
                        {isLoadingSessions ? (
                            <div className="flex items-center justify-center py-8">
                                <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                            </div>
                        ) : sessions.length === 0 ? (
                            <div className="text-center py-8">
                                <MessageSquare className="w-12 h-12 mx-auto mb-3 text-neutral-600" />
                                <p className="text-neutral-500 text-sm">{t('chat.noHistory')}</p>
                                <p className="text-neutral-600 text-xs mt-1">{t('chat.startConversation')}</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {sessions.map((session: ChatSession) => (
                                    <div
                                        key={session.id}
                                        onClick={() => handleLoadSession(session.id)}
                                        role="button"
                                        tabIndex={0}
                                        className={`w-full text-left p-3 rounded-xl transition-colors group cursor-pointer ${isDark ? 'bg-neutral-800/50 hover:bg-neutral-800' : 'bg-neutral-100 hover:bg-neutral-200'}`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-sm font-medium truncate ${isDark ? 'text-white' : 'text-neutral-900'}`}>
                                                    {session.topic}
                                                </p>
                                                <p className={`text-xs mt-1 ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>
                                                    {t('chat.messages', { n: session.messageCount })} · {formatDate(session.updatedAt || session.createdAt)}
                                                </p>
                                            </div>
                                            <button
                                                onClick={(e) => handleDeleteSession(e, session.id)}
                                                className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-red-500/20 rounded-lg transition-all text-neutral-500 hover:text-red-400"
                                                title={t('chat.deleteChat')}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* New Chat Button */}
                    <div className={`p-4 border-t ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                        <button
                            onClick={handleNewChat}
                            className="w-full py-2.5 bg-cyan-500 hover:bg-cyan-400 rounded-xl text-white font-medium text-sm transition-colors flex items-center justify-center gap-2"
                        >
                            <Plus size={16} />
                            {t('chat.newChat')}
                        </button>
                    </div>
                </div>
            )
            }

            {/* Header */}
            <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                <div className="flex items-center gap-3">
                    {/* Topic or default title */}
                    <span className={`font-medium text-sm truncate max-w-[180px] ${isDark ? 'text-white' : 'text-neutral-900'}`}>
                        {topic || (hasMessages ? t('chat.newChat') : t('chat.title'))}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    {/* New Chat button - only show after messages exist */}
                    {hasMessages && (
                        <button
                            onClick={handleNewChat}
                            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}
                            title={t('chat.newChat')}
                        >
                            <Plus size={18} />
                        </button>
                    )}
                    <button
                        onClick={() => setShowHistory(true)}
                        className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}
                        title={t('chat.history')}
                    >
                        <History size={18} />
                    </button>
                    <button
                        onClick={onClose}
                        className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-800 text-neutral-400 hover:text-white' : 'hover:bg-neutral-100 text-neutral-500 hover:text-neutral-900'}`}
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
                {/* Show greeting and tip if no messages */}
                {!hasMessages ? (
                    <>
                        {/* Greeting */}
                        <h1 className={`text-2xl font-bold mb-1 ${isDark ? 'text-white' : 'text-neutral-900'}`}>
                            {t('chat.greeting', { name: displayName })}
                        </h1>
                        <p className="text-cyan-400 text-lg mb-6">
                            {t('chat.inspiration')}
                        </p>

                        {/* Tip Card */}
                        {showTip && (
                            <div className={`rounded-2xl p-4 mb-4 ${isDark ? 'bg-neutral-800/50' : 'bg-neutral-100'}`}>
                                <div className={`rounded-xl overflow-hidden mb-3 flex items-center justify-center ${isDark ? 'bg-neutral-700/50' : 'bg-neutral-200'}`}>
                                    <img
                                        src="/chat-preview.gif"
                                        alt={t('chat.dragPreview')}
                                        className="w-full h-auto object-cover rounded-xl"
                                    />
                                </div>
                                <p className={`text-sm leading-relaxed mb-3 ${isDark ? 'text-neutral-400' : 'text-neutral-600'}`}>
                                    {t('chat.dragTip')}
                                </p>
                                <div className="flex justify-end">
                                    <button
                                        onClick={() => setShowTip(false)}
                                        className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${isDark ? 'bg-neutral-700 hover:bg-neutral-600 text-white' : 'bg-neutral-200 hover:bg-neutral-300 text-neutral-900'}`}
                                    >
                                        {t('chat.gotIt')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    /* Chat Messages */
                    <div className="space-y-1">
                        {messages.map((msg: ChatMessageType, index: number) => (
                            <div key={msg.id} className="relative group/msg">
                                <ChatMessage
                                    role={msg.role}
                                    content={msg.content}
                                    media={msg.media}
                                    timestamp={msg.timestamp}
                                />
                                {msg.role === 'user' && index === lastUserIndex && !isLoading && (
                                    <button
                                        onClick={handleEditLastMessage}
                                        className="absolute -left-7 top-2 p-1 rounded-lg opacity-0 group-hover/msg:opacity-100 transition-opacity bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white"
                                        title={t('chat.edit')}
                                    >
                                        <Pencil size={12} />
                                    </button>
                                )}
                            </div>
                        ))}

                        {/* Loading indicator */}
                        {isLoading && (
                            <div className="flex justify-start mb-4">
                                <div className={`rounded-2xl rounded-bl-md px-4 py-3 ${isDark ? 'bg-neutral-800' : 'bg-neutral-100'}`}>
                                    <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                                </div>
                            </div>
                        )}

                        {/* Error message */}
                        {error && (
                            <div className="flex justify-center mb-4">
                                <div className="bg-red-500/20 border border-red-500/50 rounded-lg px-4 py-2 text-red-400 text-sm">
                                    {error}
                                </div>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>
                )}
            </div>

            {/* Input Area */}
            <div className={`p-4 border-t ${isDark ? 'border-neutral-800' : 'border-neutral-200'}`}>
                <div className={`rounded-2xl p-3 ${isDark ? 'bg-neutral-800' : 'bg-neutral-100'}`}>
                    {/* Attached Media Preview */}
                    {attachedMedia.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                            {attachedMedia.map((media) => (
                                <div key={media.nodeId} className="relative">
                                    {media.type === 'image' ? (
                                        <img
                                            src={media.url}
                                            alt={t('chat.attached')}
                                            className="w-14 h-14 object-cover rounded-lg"
                                        />
                                    ) : (
                                        <video
                                            src={media.url}
                                            className="w-14 h-14 object-cover rounded-lg"
                                        />
                                    )}
                                    <button
                                        onClick={() => removeAttachment(media.nodeId)}
                                        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center text-white text-[10px]"
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        ref={textareaRef}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder={t('chat.placeholder')}
                        className={`w-full bg-transparent text-sm outline-none mb-3 resize-none min-h-[24px] max-h-[120px] ${isDark ? 'text-white placeholder:text-neutral-500' : 'text-neutral-900 placeholder:text-neutral-400'}`}
                        rows={1}
                        style={{ scrollbarWidth: 'none' }}
                        disabled={isLoading}
                        onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = 'auto';
                            const newHeight = Math.min(target.scrollHeight, 120);
                            target.style.height = newHeight + 'px';
                            target.style.overflowY = target.scrollHeight > 120 ? 'auto' : 'hidden';
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                    />
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-700 text-neutral-400' : 'hover:bg-neutral-200 text-neutral-500'}`}
                                title={t('chat.upload')}
                            >
                                <Paperclip size={16} />
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,video/*"
                                multiple
                                className="hidden"
                                onChange={handleFileSelect}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <button className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-neutral-700 text-neutral-400' : 'hover:bg-neutral-200 text-neutral-500'}`}>
                                <Globe size={16} />
                            </button>
                            <div className="relative">
                                <button
                                    onClick={() => setShowModelMenu(v => !v)}
                                    className={`flex items-center gap-1 p-1.5 rounded-lg transition-colors ${showModelMenu ? (isDark ? 'bg-neutral-700 text-white' : 'bg-neutral-200 text-neutral-900') : (isDark ? 'hover:bg-neutral-700 text-neutral-400' : 'hover:bg-neutral-200 text-neutral-500')}`}
                                    title={t('chat.selectModel')}
                                >
                                    <Settings size={16} />
                                </button>
                                {showModelMenu && (
                                    <div className={`absolute bottom-full right-0 mb-2 min-w-[180px] rounded-xl border shadow-2xl py-1 z-50 ${isDark ? 'bg-neutral-800 border-neutral-700' : 'bg-white border-neutral-200'}`}>
                                        <div className={`px-3 py-1.5 text-[11px] uppercase tracking-wider ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>
                                            {t('chat.selectModel')}
                                        </div>
                                        {models.length === 0 ? (
                                            <div className={`px-3 py-2 text-sm ${isDark ? 'text-neutral-500' : 'text-neutral-400'}`}>
                                                {t('chat.noModels')}
                                            </div>
                                        ) : models.map(m => (
                                            <button
                                                key={m.id}
                                                onClick={() => { setSelectedModel(m.id); setShowModelMenu(false); }}
                                                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors ${m.id === selectedModel
                                                    ? (isDark ? 'text-cyan-400' : 'text-cyan-600')
                                                    : (isDark ? 'text-neutral-200 hover:bg-neutral-700' : 'text-neutral-700 hover:bg-neutral-100')}`}
                                            >
                                                <span>{m.label}</span>
                                                {m.id === selectedModel && <Check size={14} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {isLoading ? (
                                <button
                                    onClick={stopGeneration}
                                    className="p-2 rounded-full bg-red-500 hover:bg-red-400 text-white transition-colors"
                                    title={t('chat.stop')}
                                >
                                    <Square size={14} />
                                </button>
                            ) : (
                                <button
                                    onClick={handleSend}
                                    disabled={!message.trim() && !attachedMedia.length}
                                    className={`p-2 rounded-full transition-colors text-white ${(!message.trim() && !attachedMedia.length)
                                        ? 'bg-neutral-600 cursor-not-allowed'
                                        : 'bg-cyan-500 hover:bg-cyan-400'
                                        }`}
                                >
                                    <Send size={14} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div >
    );
};

// ============================================================================
// CHAT BUBBLE
// ============================================================================

/**
 * ChatBubble - Floating button to open chat
 */
interface ChatBubbleProps {
    onClick: () => void;
    isOpen: boolean;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ onClick, isOpen }) => {
    if (isOpen) return null;

    return (
        <button
            onClick={onClick}
            className="fixed bottom-6 right-6 w-12 h-12 bg-gradient-to-br from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 rounded-full flex items-center justify-center shadow-lg shadow-cyan-500/30 transition-all hover:scale-110 z-50 animate-breathing"
            style={{
                animation: 'breathing 3s ease-in-out infinite',
            }}
        >
            <Sparkles size={22} className="text-white" />
            <style>{`
                @keyframes breathing {
                    0%, 100% {
                        transform: scale(1);
                        box-shadow: 0 10px 15px -3px rgba(6, 182, 212, 0.3), 0 4px 6px -4px rgba(6, 182, 212, 0.3);
                    }
                    50% {
                        transform: scale(1.08);
                        box-shadow: 0 20px 25px -5px rgba(6, 182, 212, 0.5), 0 8px 10px -6px rgba(6, 182, 212, 0.5);
                    }
                }
            `}</style>
        </button>
    );
};
