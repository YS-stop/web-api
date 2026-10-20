/**
 * TopBar.tsx
 *
 * 画布顶部信息卡片（对齐「项目画布」的布局格式）：
 *   - 左上角独立「返回」按钮（left-4 top-4）
 *   - 左上角「信息胶囊卡片」（left-14 top-4），可收起
 *   - 卡片内保留：Logo、标题（双击编辑）、自动保存/未保存提示、保存、新建
 * 功能与原横贯式 TopBar 完全一致，仅外壳布局对齐项目画布。
 */

import React, { useState } from 'react';
import { Plus, Save, Loader2, LayoutGrid, ChevronUp, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TopBarProps {
    // Title
    canvasTitle: string;
    isEditingTitle: boolean;
    editingTitleValue: string;
    canvasTitleInputRef: React.RefObject<HTMLInputElement>;
    setCanvasTitle: (title: string) => void;
    setIsEditingTitle: (editing: boolean) => void;
    setEditingTitleValue: (value: string) => void;
    // Actions
    onSave: () => void | Promise<void>;
    onNew: () => void;
    hasUnsavedChanges: boolean;
    lastAutoSaveTime?: number;
    // Layout
    isChatOpen?: boolean;
    // Theme
    canvasTheme: 'dark' | 'light';
    onBackToProjects?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
    canvasTitle,
    isEditingTitle,
    editingTitleValue,
    canvasTitleInputRef,
    setCanvasTitle,
    setIsEditingTitle,
    setEditingTitleValue,
    onSave,
    onNew,
    hasUnsavedChanges,
    lastAutoSaveTime,
    // isChatOpen 保留兼容，卡片式布局不再依赖宽度计算
    isChatOpen: _isChatOpen,
    canvasTheme,
    onBackToProjects
}) => {
    const { t } = useTranslation();
    const [showNewConfirm, setShowNewConfirm] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [collapsed, setCollapsed] = useState(false);

    const isDark = canvasTheme === 'dark';

    const handleTitleBlur = () => {
        if (editingTitleValue.trim()) {
            setCanvasTitle(editingTitleValue.trim());
        } else {
            setEditingTitleValue(canvasTitle);
        }
        setIsEditingTitle(false);
    };

    const handleTitleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (editingTitleValue.trim()) {
                setCanvasTitle(editingTitleValue.trim());
            }
            setIsEditingTitle(false);
        } else if (e.key === 'Escape') {
            setEditingTitleValue(canvasTitle);
            setIsEditingTitle(false);
        }
    };

    const handleTitleDoubleClick = () => {
        setEditingTitleValue(canvasTitle);
        setIsEditingTitle(true);
    };

    const handleNewClick = () => {
        if (hasUnsavedChanges) {
            setShowNewConfirm(true);
        } else {
            onNew();
        }
    };

    const handleSaveAndNew = async () => {
        try {
            setIsSaving(true);
            await onSave();
            setShowNewConfirm(false);
            onNew();
        } catch (error) {
            console.error("Failed to save and new:", error);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDiscardAndNew = () => {
        setShowNewConfirm(false);
        onNew();
    };

    // 元信息行：优先显示自动保存状态，其次显示未保存提示
    const metaText = lastAutoSaveTime && !hasUnsavedChanges
        ? `${t('topbar.autoSaved')} ${new Date(lastAutoSaveTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : hasUnsavedChanges
            ? '有未保存更改'
            : '自由创作';

    return (
        <>
            {/* 返回按钮（独立，始终显示，与项目画布一致） */}
            {onBackToProjects && (
                <button
                    onClick={onBackToProjects}
                    title="返回项目列表"
                    className={`fixed top-4 left-4 z-50 w-9 h-9 rounded-xl flex items-center justify-center border shadow-lg backdrop-blur-xl transition-colors ${
                        isDark
                            ? 'bg-[#161521]/85 border-white/10 text-neutral-200 hover:text-white hover:bg-white/10'
                            : 'bg-white/85 border-slate-200 text-slate-600 hover:text-slate-900'
                    }`}
                >
                    <LayoutGrid size={16} />
                </button>
            )}

            {/* 信息卡片（可收起） */}
            {collapsed ? (
                <button
                    onClick={() => setCollapsed(false)}
                    title="展开画布信息"
                    className={`fixed top-4 left-14 z-50 w-8 h-8 rounded-lg flex items-center justify-center border shadow-lg backdrop-blur-xl transition-colors ${
                        isDark
                            ? 'bg-[#161521]/85 border-white/10 text-neutral-300 hover:text-white'
                            : 'bg-white/85 border-slate-200 text-slate-500 hover:text-slate-900'
                    }`}
                >
                    <ChevronDown size={15} />
                </button>
            ) : (
                <header
                    className="fixed top-4 left-14 z-50 flex items-center gap-2.5 h-11 pl-1.5 pr-2 rounded-xl border shadow-lg backdrop-blur-xl"
                    style={{
                        background: isDark ? 'rgba(22, 21, 33, .85)' : 'rgba(255, 255, 255, .85)',
                        borderColor: isDark ? 'rgba(196, 181, 253, .13)' : 'rgba(203, 213, 225, .8)',
                        boxShadow: isDark ? '0 14px 38px rgba(0, 0, 0, .28)' : '0 14px 38px rgba(71, 85, 105, .11)'
                    }}
                >
                    {/* Logo */}
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-400 flex items-center justify-center shrink-0">
                        <img src="/TwitCanva-logo.png" alt="TwitCanva Logo" className="w-6 h-6 rounded object-contain" />
                    </div>

                    {/* 标题 + 元信息 */}
                    <div className="flex flex-col leading-tight min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                            {isEditingTitle ? (
                                <input
                                    ref={canvasTitleInputRef as React.RefObject<HTMLInputElement>}
                                    type="text"
                                    value={editingTitleValue}
                                    onChange={(e) => setEditingTitleValue(e.target.value)}
                                    onBlur={handleTitleBlur}
                                    onKeyDown={handleTitleKeyDown}
                                    className="font-semibold text-neutral-100 bg-transparent border-b border-violet-400 outline-none min-w-[100px]"
                                />
                            ) : (
                                <span
                                    className={`font-semibold cursor-pointer transition-colors max-w-[180px] truncate ${
                                        isDark ? 'text-neutral-100 hover:text-violet-200' : 'text-slate-900 hover:text-violet-700'
                                    }`}
                                    onDoubleClick={handleTitleDoubleClick}
                                    title={t('topbar.renameHint')}
                                >
                                    {canvasTitle}
                                </span>
                            )}
                        </div>
                        <div className={`text-[10px] mt-0.5 truncate max-w-[200px] ${isDark ? 'text-neutral-400' : 'text-slate-500'}`}>
                            {metaText}
                        </div>
                    </div>

                    {/* 操作按钮 */}
                    <button
                        onClick={() => onSave()}
                        title={t('topbar.save')}
                        className={`h-7 px-2.5 rounded-lg flex items-center gap-1.5 text-[12px] font-medium transition-colors border ${
                            isDark
                                ? 'bg-violet-500/90 hover:bg-violet-400 text-white border-violet-400'
                                : 'bg-violet-600 hover:bg-violet-700 text-white border-violet-600'
                        }`}
                    >
                        <Save size={13} />
                        <span className="hidden sm:inline">{t('topbar.save')}</span>
                    </button>
                    <button
                        onClick={handleNewClick}
                        title={t('topbar.new')}
                        className={`h-7 w-7 rounded-lg flex items-center justify-center transition-colors border ${
                            isDark
                                ? 'bg-white/[.06] hover:bg-white/[.12] text-neutral-100 border-white/10'
                                : 'bg-slate-100 hover:bg-slate-200 text-slate-900 border-slate-200'
                        }`}
                    >
                        <Plus size={15} />
                    </button>
                    <button
                        onClick={() => setCollapsed(true)}
                        title="收起画布信息"
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors shrink-0 ${
                            isDark ? 'text-neutral-500 hover:text-white hover:bg-white/10' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                        }`}
                    >
                        <ChevronUp size={15} />
                    </button>
                </header>
            )}

            {/* Unsaved Changes Confirmation Modal */}
            {showNewConfirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]">
                    <div className="bg-[#1a1a1a] border border-neutral-700 rounded-2xl p-6 w-[400px] shadow-2xl">
                        <h3 className="text-lg font-semibold text-white mb-2">{t('topbar.unsavedTitle')}</h3>
                        <p className="text-neutral-400 text-sm mb-6">
                            {t('topbar.unsavedDesc')}
                        </p>
                        <div className="flex gap-3 justify-end">
                            <button
                                onClick={() => setShowNewConfirm(false)}
                                disabled={isSaving}
                                className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t('topbar.cancel')}
                            </button>
                            <button
                                onClick={handleDiscardAndNew}
                                disabled={isSaving}
                                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t('topbar.discard')}
                            </button>
                            <button
                                onClick={handleSaveAndNew}
                                disabled={isSaving}
                                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        {t('topbar.saving')}
                                    </>
                                ) : (
                                    t('topbar.saveAndNew')
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
