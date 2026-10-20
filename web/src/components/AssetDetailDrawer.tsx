/**
 * AssetDetailDrawer.tsx
 *
 * 资产详情页（借鉴设计稿）：点击资产卡片后以全屏浮层打开。
 *   左栏：当前图大图（可再次点击放大）+ 历史记录缩略图 + 剧本描述
 *   右栏：名称、造型列表、提示词（可编辑描述 + 完整提示词预览）、生成参数与生成按钮
 *
 * 数据仍由 AssetConfirmPanel 持有，本组件只做展示与交互回调；
 * 「最终提示词」通过 buildPrompt 注入，避免与父级模块形成循环依赖。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    X,
    Loader2,
    Sparkles,
    RefreshCw,
    Plus,
    Check,
    ChevronDown,
    Copy,
    ImageOff,
    Trash2,
} from 'lucide-react';
import type { AssetCategory, EditableAsset, Look } from './AssetConfirmPanel';

// ============================================================================
// 类型
// ============================================================================

interface SelectOption {
    id: string;
    name: string;
}

interface AssetDetailDrawerProps {
    asset: EditableAsset;
    category: AssetCategory;
    /** 生成参数（与面板共用同一份状态） */
    imageModel: string;
    imageResolution: string;
    modelOptions: SelectOption[];
    resolutionOptions: string[];
    onModelChange: (id: string) => void;
    onResolutionChange: (v: string) => void;
    /**
     * 生成中标记：
     *   undefined —— 无生成任务
     *   null      —— 主图生成中
     *   string    —— 该造型 id 生成中
     */
    generatingKey?: string | null;
    /** 计算最终提示词（父级注入） */
    buildPrompt: (patch: Partial<EditableAsset>) => string;
    onClose: () => void;
    /** 提交名称 / 描述修改 */
    onSave: (patch: Partial<EditableAsset>) => void;
    /** 生成主图（可携带当前草稿，保证改名改描述后立即可用） */
    onGenerate: (patch: Partial<EditableAsset>) => void;
    /** 生成指定造型 */
    onGenerateLook: (lookId: string, patch: Partial<EditableAsset>) => void;
    /** 新增造型 */
    onAddLook: () => void;
    /** 删除造型（至少保留 1 个，由父级保证） */
    onRemoveLook: (lookId: string) => void;
    /** 删除主图（主图与所有造型图脱节时，作为独立条目可单独删除） */
    onRemoveMain: () => void;
    /** 查看大图 */
    onPreview: (src: string, title: string) => void;
}

const CATEGORY_LABEL: Record<AssetCategory, string> = {
    characters: '角色 Character',
    scenes: '场景 Scene',
    props: '道具 Prop',
};

/** 资产设定图固定画幅（不跟随项目画幅） */
const ASSET_ASPECT_LABEL = '16:9';

// ============================================================================
// 组件
// ============================================================================

export const AssetDetailDrawer: React.FC<AssetDetailDrawerProps> = ({
    asset,
    category,
    imageModel,
    imageResolution,
    modelOptions,
    resolutionOptions,
    onModelChange,
    onResolutionChange,
    generatingKey,
    buildPrompt,
    onClose,
    onSave,
    onGenerate,
    onGenerateLook,
    onAddLook,
    onRemoveLook,
    onRemoveMain,
    onPreview,
}) => {
    const [draftName, setDraftName] = useState(asset.name);
    const [draftDesc, setDraftDesc] = useState(asset.description || '');
    /** 人物小传草稿（仅角色，展示用） */
    const [draftBio, setDraftBio] = useState(asset.bio || '');
    /** 视觉特征草稿（仅角色，进提示词） */
    const [draftVisual, setDraftVisual] = useState(asset.visual || '');
    /** 当前大图：'main' 或造型 id */
    const [currentKey, setCurrentKey] = useState<string>('main');
    const [showPrompt, setShowPrompt] = useState(false);
    const [copied, setCopied] = useState(false);
    /** 待确认删除的造型（有图的造型需二次确认） */
    const [confirmDeleteLook, setConfirmDeleteLook] = useState<Look | null>(null);
    /** 待确认删除的独立主图 */
    const [confirmDeleteMain, setConfirmDeleteMain] = useState(false);

    // 切换资产时重置草稿与当前图
    useEffect(() => {
        setDraftName(asset.name);
        setDraftDesc(asset.description || '');
        setDraftBio(asset.bio || '');
        setDraftVisual(asset.visual || '');
        setCurrentKey('main');
        setShowPrompt(false);
        setCopied(false);
        setConfirmDeleteLook(null);
        setConfirmDeleteMain(false);
    }, [asset.id]);

    const isCharacter = category === 'characters';

    /**
     * 图片清单：所有已生成的图（主图 + 各造型图）。
     * 右侧「造型」区与左下「历史记录」共用这一份数据，
     * 保证两边条目数量与顺序完全一致，便于逐张判断删留。
     * 主图若与某造型图相同（同一张图），只记一次，避免缩略图重复。
     */
    const gallery = useMemo(() => {
        const items: { key: string; label: string; src: string }[] = [];
        const mainDupOfLook = !!asset.imageUrl && asset.looks.some((l) => l.imageUrl === asset.imageUrl);
        if (asset.imageUrl && !mainDupOfLook) items.push({ key: 'main', label: '主图', src: asset.imageUrl });
        for (const look of asset.looks) {
            if (look.imageUrl) items.push({ key: look.id, label: look.name, src: look.imageUrl });
        }
        return items;
    }, [asset.imageUrl, asset.looks]);

    /**
     * 主图是否「独立」：主图存在，但不等于任何造型的图。
     * 重新生成主图时不会覆盖已有造型图，此时主图成为一条没有造型归属的独立图，
     * 右侧必须单独列出来，否则历史记录有 2 张、造型区只显示 1 条，无法对齐。
     */
    const mainIsDetached = useMemo(
        () => !!asset.imageUrl && !asset.looks.some((l) => l.imageUrl === asset.imageUrl),
        [asset.imageUrl, asset.looks]
    );

    /** 主图被哪个造型占用（未脱节时用于在造型行内高亮） */
    const mainLookId = useMemo(
        () => asset.looks.find((l) => l.imageUrl && l.imageUrl === asset.imageUrl)?.id,
        [asset.imageUrl, asset.looks]
    );

    // 当前图被替换 / 删除后回退到第一张
    useEffect(() => {
        if (gallery.length === 0) return;
        if (!gallery.some((g) => g.key === currentKey)) {
            setCurrentKey(gallery[0].key);
        }
    }, [gallery, currentKey]);

    const current = gallery.find((g) => g.key === currentKey) || gallery[0] || null;
    const promptText = buildPrompt({ name: draftName, description: draftDesc, visual: draftVisual, bio: draftBio });

    const mainGenerating = generatingKey === null;
    const anyGenerating = generatingKey !== undefined;

    /** 当前草稿对应的资产补丁 */
    const commitPatch = (): Partial<EditableAsset> => ({
        name: draftName.trim() || asset.name,
        description: draftDesc,
        // 小传与视觉特征仅角色有意义，场景 / 道具不写入
        ...(isCharacter ? { bio: draftBio, visual: draftVisual } : {}),
    });

    /** 轮换查看下一张历史图 */
    const cycle = () => {
        if (gallery.length < 2) return;
        const idx = gallery.findIndex((g) => g.key === currentKey);
        setCurrentKey(gallery[(idx + 1) % gallery.length].key);
    };

    const handleCopyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(promptText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            /* 剪贴板不可用则忽略 */
        }
    };

    return (
        <div className="fixed inset-0 z-[90] bg-[#0c0c11] flex flex-col">
            {/* ===================== 顶部 ===================== */}
            <header className="h-12 shrink-0 px-4 flex items-center gap-3 border-b border-white/[0.08]">
                <button
                    onClick={onClose}
                    title="关闭（Esc）"
                    className="h-8 w-8 -ml-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.07] flex items-center justify-center transition-colors"
                >
                    <X size={18} />
                </button>
                <span className="text-[14px] font-medium text-neutral-100 truncate">{draftName}</span>
                <span className="text-[11px] text-neutral-600">内容由 AI 生成，仅供参考</span>
            </header>

            {/* ===================== 主体 ===================== */}
            <div className="flex-1 min-h-0 flex">
                {/* ---------- 左栏：大图 / 历史记录 / 描述 ---------- */}
                <div className="flex-1 min-w-0 flex flex-col">
                    {/* 工具行 */}
                    <div className="h-10 shrink-0 px-4 flex items-center justify-between border-b border-white/[0.06]">
                        <span className="rounded bg-cyan-500/15 text-cyan-300 text-[11px] px-2 py-0.5">
                            {current ? `当前：${current.label}` : '暂无图片'}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] text-neutral-500">已生成 {gallery.length} 张</span>
                            {gallery.length > 1 && (
                                <button
                                    onClick={cycle}
                                    title="换一张"
                                    className="h-7 px-2 rounded-md border border-white/[0.12] text-[11px] text-neutral-300 hover:text-cyan-300 hover:border-cyan-400/40 flex items-center gap-1 transition-colors"
                                >
                                    <RefreshCw size={12} />
                                    换一张
                                </button>
                            )}
                        </div>
                    </div>

                    {/* 大图：用绝对定位容器固定可用空间，图片按容器自适应缩放，不溢出 */}
                    <div className="relative flex-1 min-h-0 bg-[#0a0a0e]">
                        {current ? (
                            <button
                                onClick={() => onPreview(current.src, `${asset.name} · ${current.label}`)}
                                title="点击查看大图"
                                className="group absolute inset-3 flex items-center justify-center cursor-zoom-in"
                            >
                                <img
                                    src={current.src}
                                    alt={asset.name}
                                    className="max-h-full max-w-full object-contain rounded-lg border border-white/[0.07] shadow-2xl"
                                />
                                {mainGenerating && (
                                    <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-[#0a0a0e]/85">
                                        <Loader2 size={26} className="animate-spin text-cyan-300" />
                                        <span className="text-[13px] text-cyan-200/90">正在生成…</span>
                                        <span className="h-1 w-20 rounded-full bg-white/[0.12] overflow-hidden">
                                            <span className="block h-full w-1/2 rounded-full bg-cyan-400/80 animate-pulse" />
                                        </span>
                                    </span>
                                )}
                            </button>
                        ) : mainGenerating ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                                <Loader2 size={28} className="animate-spin text-cyan-300" />
                                <span className="text-[13px] text-cyan-200/90">正在生成…</span>
                                <span className="h-1 w-20 rounded-full bg-white/[0.12] overflow-hidden">
                                    <span className="block h-full w-1/2 rounded-full bg-cyan-400/80 animate-pulse" />
                                </span>
                            </div>
                        ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-600">
                                <ImageOff size={30} />
                                <span className="text-[13px]">暂无图片，点击右下角「生成」</span>
                            </div>
                        )}
                    </div>

                    {/* 剧本描述：角色优先展示人物小传，场景 / 道具展示剧本描述 */}
                    {(() => {
                        const text = isCharacter && asset.bio ? asset.bio : asset.description;
                        if (!text) return null;
                        return (
                            <div className="shrink-0 max-h-32 overflow-y-auto border-t border-white/[0.06] px-4 py-3">
                                <p className="text-[12px] leading-relaxed text-neutral-400">{text}</p>
                            </div>
                        );
                    })()}

                    {/* 历史记录（单行紧凑，尽量把高度留给大图） */}
                    <div className="shrink-0 border-t border-white/[0.06] px-4 py-2 flex items-center gap-3">
                        <div className="shrink-0 text-[11px] text-neutral-500">历史记录</div>
                        {gallery.length > 0 ? (
                            <div className="flex-1 min-w-0 flex gap-2 overflow-x-auto py-0.5">
                                {gallery.map((g) => (
                                    <button
                                        key={g.key}
                                        onClick={() => setCurrentKey(g.key)}
                                        title={`${g.label}（点击查看）`}
                                        className={`group relative shrink-0 w-14 h-14 rounded-md overflow-hidden border transition-colors ${
                                            g.key === currentKey
                                                ? 'border-cyan-400/70 ring-1 ring-cyan-400/40'
                                                : 'border-white/[0.1] hover:border-white/[0.28]'
                                        }`}
                                    >
                                        <img src={g.src} alt={g.label} className="w-full h-full object-cover" />
                                        {/* 角标：与右侧造型列表同名，便于确认删留 */}
                                        <span className="absolute inset-x-0 bottom-0 bg-black/65 text-[9px] leading-[13px] text-neutral-200 text-center truncate px-0.5">
                                            {g.label}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <span className="text-[11px] text-neutral-600">生成后在此查看</span>
                        )}
                    </div>
                </div>

                {/* ---------- 右栏：属性 / 造型 / 提示词 / 生成 ---------- */}
                <aside className="w-[380px] shrink-0 border-l border-white/[0.06] bg-[#141419] flex flex-col">
                    {/* 标题 */}
                    <div className="shrink-0 px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                        <span className="text-[13px] text-neutral-200">{CATEGORY_LABEL[category]}</span>
                        <button
                            onClick={onAddLook}
                            className="h-7 px-2 rounded-md border border-white/[0.12] text-[11px] text-neutral-300 hover:text-cyan-300 hover:border-cyan-400/40 flex items-center gap-1 transition-colors"
                        >
                            <Plus size={12} />
                            新增造型
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
                        {/* 名称 */}
                        <label className="block">
                            <span className="text-[12px] text-neutral-400">名称</span>
                            <input
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                onBlur={() => onSave(commitPatch())}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') onSave(commitPatch());
                                }}
                                className="mt-1.5 w-full h-9 rounded-lg bg-white/[0.06] border border-white/[0.08] px-3 text-[13px] text-neutral-100 outline-none focus:border-cyan-400/50"
                            />
                        </label>

                        {/* 造型 / 图片列表：与历史记录一一对应，逐张可查看 / 重绘 / 删除 */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[12px] text-neutral-400">造型</span>
                                <span className="text-[11px] text-neutral-600">
                                    {gallery.length} 张 / {asset.looks.length} 个造型
                                </span>
                            </div>
                            <div className="space-y-1.5">
                                {asset.looks.length === 0 && !mainIsDetached && (
                                    <div className="rounded-lg border border-dashed border-white/[0.1] px-2 py-3 text-center text-[11px] text-neutral-600">
                                        暂无造型，点击右上「新增造型」添加
                                    </div>
                                )}
                                {/* 独立主图：主图未归属任何造型时单独列出，保证与历史记录对齐 */}
                                {mainIsDetached && (
                                    <div
                                        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
                                            currentKey === 'main'
                                                ? 'border-cyan-400/50 bg-cyan-400/[0.06]'
                                                : 'border-white/[0.06] bg-white/[0.02]'
                                        }`}
                                    >
                                        <button
                                            onClick={() => setCurrentKey('main')}
                                            title="点击查看"
                                            className="w-9 h-9 rounded bg-[#0d0d12] overflow-hidden shrink-0 flex items-center justify-center cursor-pointer"
                                        >
                                            <img src={asset.imageUrl} alt="" className="w-full h-full object-cover" />
                                        </button>
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-[12px] text-neutral-300 truncate">主图</span>
                                            <span className="block text-[10px] text-amber-300/70">未归属造型</span>
                                        </span>
                                        <button
                                            onClick={() => onGenerate(commitPatch())}
                                            disabled={anyGenerating}
                                            title="重绘主图"
                                            className="h-7 px-2 rounded-md border border-white/[0.12] text-[11px] text-neutral-300 hover:text-cyan-300 hover:border-cyan-400/40 disabled:opacity-40 flex items-center gap-1 transition-colors"
                                        >
                                            {mainGenerating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                            重绘
                                        </button>
                                        <button
                                            onClick={() => setConfirmDeleteMain(true)}
                                            disabled={anyGenerating}
                                            title="删除这张主图"
                                            className="h-7 w-7 rounded-md border border-white/[0.12] text-neutral-400 hover:text-red-300 hover:border-red-400/40 disabled:opacity-40 flex items-center justify-center transition-colors"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                )}

                                {asset.looks.map((look) => {
                                    const lookBusy = generatingKey === look.id;
                                    const isMain = look.id === mainLookId;
                                    return (
                                        <div
                                            key={look.id}
                                            className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
                                                currentKey === look.id
                                                    ? 'border-cyan-400/50 bg-cyan-400/[0.06]'
                                                    : 'border-white/[0.06] bg-white/[0.02]'
                                            }`}
                                        >
                                            <button
                                                onClick={() => {
                                                    if (look.imageUrl) setCurrentKey(look.id);
                                                }}
                                                title={look.imageUrl ? '点击查看' : '暂无图片'}
                                                className="w-9 h-9 rounded bg-[#0d0d12] overflow-hidden shrink-0 flex items-center justify-center cursor-pointer"
                                            >
                                                {look.imageUrl ? (
                                                    <img src={look.imageUrl} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <span className="text-[10px] text-neutral-600">无图</span>
                                                )}
                                            </button>
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-[12px] text-neutral-300 truncate">{look.name}</span>
                                                {isMain && <span className="block text-[10px] text-cyan-300/70">当前主图</span>}
                                            </span>
                                            <button
                                                onClick={() => onGenerateLook(look.id, commitPatch())}
                                                disabled={anyGenerating}
                                                className="h-7 px-2 rounded-md border border-white/[0.12] text-[11px] text-neutral-300 hover:text-cyan-300 hover:border-cyan-400/40 disabled:opacity-40 flex items-center gap-1 transition-colors"
                                            >
                                                {lookBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                                {look.imageUrl ? '重绘' : '生成'}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    // 造型可删到 0 个；有图二次确认，无图直接删
                                                    if (look.imageUrl) setConfirmDeleteLook(look);
                                                    else onRemoveLook(look.id);
                                                }}
                                                disabled={anyGenerating}
                                                title="删除造型"
                                                className="h-7 w-7 rounded-md border border-white/[0.12] text-neutral-400 hover:text-red-300 hover:border-red-400/40 disabled:opacity-40 flex items-center justify-center transition-colors"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 视觉特征（仅角色）：人物小传 bio 仅保留数据，不再提供页面展示与编辑 */}
                        {isCharacter && (
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[12px] text-neutral-400">视觉特征</span>
                                    <span className="text-[11px] text-neutral-600">{draftVisual.length}/1000</span>
                                </div>
                                <textarea
                                    value={draftVisual}
                                    onChange={(e) => setDraftVisual(e.target.value.slice(0, 1000))}
                                    onBlur={() => onSave(commitPatch())}
                                    rows={4}
                                    placeholder="只写外貌：年龄段、体型、五官、肤色、发型、服装、气质。不要写剧情"
                                    className="w-full rounded-lg bg-white/[0.06] border border-white/[0.08] px-3 py-2 text-[13px] leading-relaxed text-neutral-100 outline-none focus:border-cyan-400/50 resize-none"
                                />
                                <p className="mt-1 text-[11px] leading-relaxed text-neutral-600">
                                    这一段会直接拼进生图提示词，请只描述画面上能看见的特征。
                                </p>
                            </div>
                        )}

                        {/* 描述 / 提示词 */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[12px] text-neutral-400">
                                    {isCharacter ? '一句话描述' : '描述 / 提示词补充'}
                                </span>
                                <span className="text-[11px] text-neutral-600">{draftDesc.length}/3000</span>
                            </div>
                            <textarea
                                value={draftDesc}
                                onChange={(e) => setDraftDesc(e.target.value.slice(0, 3000))}
                                onBlur={() => onSave(commitPatch())}
                                rows={isCharacter ? 2 : 4}
                                placeholder={isCharacter
                                    ? '身份 / 外貌的一句话概括，如「40岁打渔女，皮肤黝黑，神情疲惫而倔强」'
                                    : '补充该资产的外观、气质、关键特征，用于生成与重绘'}
                                className="w-full rounded-lg bg-white/[0.06] border border-white/[0.08] px-3 py-2 text-[13px] text-neutral-100 outline-none focus:border-cyan-400/50 resize-none"
                            />

                            {/* 完整提示词预览 */}
                            <div className="mt-2 rounded-lg border border-white/[0.08] bg-white/[0.02]">
                                <div className="flex items-center justify-between px-2.5 py-2">
                                    <button
                                        onClick={() => setShowPrompt((v) => !v)}
                                        className="flex items-center gap-1.5 text-[12px] text-neutral-400 hover:text-neutral-200 transition-colors"
                                    >
                                        <ChevronDown
                                            size={13}
                                            className={`transition-transform ${showPrompt ? '' : '-rotate-90'}`}
                                        />
                                        完整提示词
                                    </button>
                                    <button
                                        onClick={handleCopyPrompt}
                                        title="复制提示词"
                                        className="h-6 w-6 rounded text-neutral-500 hover:text-cyan-300 hover:bg-white/[0.06] flex items-center justify-center transition-colors"
                                    >
                                        {copied ? <Check size={13} className="text-cyan-300" /> : <Copy size={13} />}
                                    </button>
                                </div>
                                {showPrompt && (
                                    <p className="px-2.5 pb-2 text-[12px] leading-relaxed text-neutral-500 whitespace-pre-wrap">
                                        {promptText}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 底部：生成参数 + 生成 */}
                    <div className="shrink-0 border-t border-white/[0.06] px-4 py-3 space-y-2.5">
                        <div className="flex items-center gap-2">
                            <MiniSelect
                                value={imageModel}
                                options={modelOptions.map((m) => m.id)}
                                labels={modelOptions.map((m) => m.name)}
                                onChange={onModelChange}
                            />
                            <MiniSelect
                                value={imageResolution}
                                options={resolutionOptions}
                                onChange={onResolutionChange}
                            />
                            <span className="ml-auto text-[11px] text-neutral-500">{ASSET_ASPECT_LABEL}</span>
                        </div>
                        <button
                            onClick={() => onGenerate(commitPatch())}
                            disabled={anyGenerating}
                            className="w-full h-10 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-[13px] font-medium text-[#04231f] flex items-center justify-center gap-1.5 transition-colors"
                        >
                            {mainGenerating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                            {asset.imageUrl ? '重新生成主图' : '生成主图'}
                        </button>
                    </div>

                    {/* 角色专属提示 */}
                    {isCharacter && (
                        <div className="shrink-0 px-4 pb-3 -mt-1 text-[11px] leading-relaxed text-neutral-600">
                            角色图固定横版 {ASSET_ASPECT_LABEL}，左侧生成「正脸 / 侧脸头肩特写」，右侧生成「无头身体三视图（正面 / 侧面 / 背面）」，不含道具与配饰，道具请到「道具」分类生成。
                        </div>
                    )}
                </aside>
            </div>

            {/* 删除造型确认 */}
            {confirmDeleteLook && (
                <div
                    className="fixed inset-0 z-[95] bg-black/60 backdrop-blur-sm flex items-center justify-center"
                    onClick={() => setConfirmDeleteLook(null)}
                >
                    <div
                        className="w-[360px] rounded-2xl border border-white/10 bg-[#1a1a22] p-5 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-[15px] font-semibold text-neutral-100 mb-2">删除造型</h3>
                        <p className="text-[13px] text-neutral-400 leading-relaxed mb-5">
                            确定删除「{confirmDeleteLook.name}」吗？该造型已生成的图片将一并删除，且不可恢复。
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setConfirmDeleteLook(null)}
                                className="h-9 px-4 rounded-lg border border-white/[0.12] text-[13px] text-neutral-300 hover:bg-white/[0.06] transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => {
                                    onRemoveLook(confirmDeleteLook.id);
                                    if (currentKey === confirmDeleteLook.id) setCurrentKey('main');
                                    setConfirmDeleteLook(null);
                                }}
                                className="h-9 px-4 rounded-lg bg-red-500 hover:bg-red-400 text-[13px] font-medium text-white transition-colors"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 删除独立主图确认 */}
            {confirmDeleteMain && (
                <div
                    className="fixed inset-0 z-[95] bg-black/60 backdrop-blur-sm flex items-center justify-center"
                    onClick={() => setConfirmDeleteMain(false)}
                >
                    <div
                        className="w-[360px] rounded-2xl border border-white/10 bg-[#1a1a22] p-5 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-[15px] font-semibold text-neutral-100 mb-2">删除主图</h3>
                        <p className="text-[13px] text-neutral-400 leading-relaxed mb-5">
                            这张主图不属于任何造型，删除后不可恢复。造型中的图片不受影响。
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setConfirmDeleteMain(false)}
                                className="h-9 px-4 rounded-lg border border-white/[0.12] text-[13px] text-neutral-300 hover:bg-white/[0.06] transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => {
                                    onRemoveMain();
                                    setConfirmDeleteMain(false);
                                }}
                                className="h-9 px-4 rounded-lg bg-red-500 hover:bg-red-400 text-[13px] font-medium text-white transition-colors"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================================
// 轻量下拉选择（详情页内使用）
// ============================================================================

const MiniSelect: React.FC<{
    value: string;
    options: string[];
    labels?: string[];
    onChange: (v: string) => void;
}> = ({ value, options, labels, onChange }) => {
    const [open, setOpen] = useState(false);
    const current = labels ? labels[options.indexOf(value)] || value : value;

    useEffect(() => {
        if (!open) return;
        const onDocDown = () => setOpen(false);
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
    }, [open]);

    return (
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="h-8 px-2.5 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[12px] text-neutral-300 hover:border-white/[0.2] flex items-center gap-1 transition-colors"
            >
                <span className="truncate max-w-[140px]">{current}</span>
                <ChevronDown size={12} className="shrink-0 text-neutral-500" />
            </button>
            {open && (
                <div className="absolute left-0 bottom-full mb-1 z-30 w-48 rounded-lg border border-white/[0.1] bg-[#1b1b22] shadow-xl py-1 max-h-56 overflow-y-auto">
                    {options.map((o, i) => (
                        <button
                            key={o}
                            onClick={() => {
                                onChange(o);
                                setOpen(false);
                            }}
                            className={`w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-white/[0.07] ${
                                o === value ? 'text-cyan-300' : 'text-neutral-300'
                            }`}
                        >
                            {labels ? labels[i] : o}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export default AssetDetailDrawer;
