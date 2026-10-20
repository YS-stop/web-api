import React, { useState, useEffect, useMemo } from 'react';
import {
    ArrowLeft,
    Info,
    ListVideo,
    Boxes,
    ChevronLeft,
    ChevronRight,
    Check,
    CheckCircle2,
    Loader2,
    FileText,
    Clock,
    AlertTriangle,
    LayoutTemplate,
} from 'lucide-react';
import { Project, fetchProject } from '../services/projectService';
import { AnalyzedEpisode, formatDurationSeconds } from '../services/scriptAnalysisService';
import { AssetConfirmPanel, loadAssetStore } from './AssetConfirmPanel';
import type { EpisodeMap } from './AssetConfirmPanel';

// ============================================================================
// 步骤定义
// ============================================================================

const STEPS = [
    { key: 'basic', label: '基本信息', icon: Info },
    { key: 'episodes', label: '剧本分集', icon: ListVideo },
    { key: 'assets', label: '资产确认', icon: Boxes },
    { key: 'canvas', label: '进入画布', icon: LayoutTemplate },
] as const;

// ============================================================================
// 类型
// ============================================================================

interface WorkflowPageProps {
    projectId: string;
    onBack: () => void;
    /** 进入项目画布（二次确认后触发） */
    onEnterCanvas: (projectId: string) => void;
}

// ============================================================================
// 集标题本地存储（分集阅读器可修改集标题，按 projectId 隔离）
// ============================================================================

const episodeTitleKey = (projectId: string) => `episode-titles:${projectId}`;
const workflowStepKey = (projectId: string) => `workflow-step:${projectId}`;

const loadWorkflowStep = (projectId: string): number => {
    try {
        const value = Number(localStorage.getItem(workflowStepKey(projectId)));
        if (!Number.isInteger(value) || value < 0) return 0;
        // 「视频生成」步骤已移除：旧缓存里指向第 5 步（索引 4）的进度回退到最后一步「进入画布」
        return Math.min(value, STEPS.length - 1);
    } catch {
        return 0;
    }
};

const loadEpisodeTitles = (projectId: string): Record<number, string> => {
    try {
        const raw = localStorage.getItem(episodeTitleKey(projectId));
        return raw ? (JSON.parse(raw) as Record<number, string>) : {};
    } catch {
        return {};
    }
};

const saveEpisodeTitles = (projectId: string, titles: Record<number, string>) => {
    try {
        localStorage.setItem(episodeTitleKey(projectId), JSON.stringify(titles));
    } catch {
        /* 忽略写入失败 */
    }
};

// ============================================================================
// 页面组件
// ============================================================================

export const WorkflowPage: React.FC<WorkflowPageProps> = ({ projectId, onBack, onEnterCanvas }) => {
    const [project, setProject] = useState<Project | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [stepIndex, setStepIndex] = useState(() => loadWorkflowStep(projectId));
    const [canvasConfirmOpen, setCanvasConfirmOpen] = useState(false);

    // 当前工作流步骤按项目记忆，刷新或从其他页面返回时不再退回基本信息。
    useEffect(() => {
        setStepIndex(loadWorkflowStep(projectId));
    }, [projectId]);

    useEffect(() => {
        try {
            localStorage.setItem(workflowStepKey(projectId), String(stepIndex));
        } catch {
            /* 忽略浏览器存储不可用 */
        }
    }, [projectId, stepIndex]);

    // 加载项目
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setLoadError('');
            try {
                const p = await fetchProject(projectId);
                if (!cancelled) setProject(p);
            } catch (e: any) {
                if (!cancelled) setLoadError(e.message || '加载项目失败');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const analysis = project?.scriptAnalysis;
    const episodes: AnalyzedEpisode[] = useMemo(
        () => project?.scriptAnalysis?.episodes || [],
        [project]
    );

    // 剧本分集阅读器：当前选中的集索引 + 可本地修改的集标题
    const [activeEpisodeIndex, setActiveEpisodeIndex] = useState(0);
    const [episodeTitles, setEpisodeTitles] = useState<Record<number, string>>(() => loadEpisodeTitles(projectId));

    useEffect(() => {
        saveEpisodeTitles(projectId, episodeTitles);
    }, [projectId, episodeTitles]);

    useEffect(() => {
        setActiveEpisodeIndex((i) => Math.min(i, Math.max(0, episodes.length - 1)));
    }, [episodes.length]);

    /** 集标题合并后供各步骤共用 */
    const mergedEpisodes: AnalyzedEpisode[] = useMemo(
        () => episodes.map((ep) => ({ ...ep, title: episodeTitles[ep.episode] ?? ep.title })),
        [episodes, episodeTitles]
    );

    // 资产确认结果（含生成图）：从本地恢复，并随资产确认面板的改动更新
    const [assetState, setAssetState] = useState<EpisodeMap | null>(() => loadAssetStore(projectId));

    const handleAssetsChange = React.useCallback((map: EpisodeMap) => {
        setAssetState((prev) => (JSON.stringify(prev) === JSON.stringify(map) ? prev : map));
    }, []);

    // ============================================================================
    // 渲染
    // ============================================================================

    if (loading) {
        return (
            <div className="h-screen w-screen flex items-center justify-center bg-[#0a0a0f] text-neutral-500">
                <Loader2 size={20} className="animate-spin mr-2" />
                加载项目中...
            </div>
        );
    }

    if (loadError || !project) {
        return (
            <div className="h-screen w-screen flex flex-col items-center justify-center gap-4 bg-[#0a0a0f]">
                <AlertTriangle size={30} className="text-red-400" />
                <div className="text-neutral-400 text-sm">{loadError || '项目不存在'}</div>
                <button onClick={onBack} className="px-4 h-9 rounded-lg bg-cyan-500 text-[#04231f] text-sm font-medium">
                    返回项目列表
                </button>
            </div>
        );
    }

    const currentStep = STEPS[stepIndex];

    const infoFields: { label: string; value: string }[] = [
        { label: '项目名称', value: project.name },
        { label: '项目编号', value: project.code },
        { label: '内容类型', value: project.category },
        { label: '制作部门', value: project.department },
        { label: '项目负责人', value: project.owner },
        { label: '生产模式', value: project.productionMode },
        { label: '单集目标时长', value: project.targetDuration ? `${project.targetDuration} 秒` : '—' },
        { label: '锁定剧本', value: project.scriptName },
        { label: '剧本来源', value: project.scriptSource },
        { label: '总集数', value: `${project.totalEpisodes} 集` },
    ];

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-[#0a0a0f] text-neutral-200 font-sans flex flex-col">
            {/* 背景氛围光（对齐设计稿的紫红辉光） */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -bottom-40 -right-32 w-[560px] h-[560px] rounded-full bg-fuchsia-600/[0.09] blur-[130px]" />
                <div className="absolute bottom-0 right-48 w-[380px] h-[380px] rounded-full bg-rose-500/[0.08] blur-[130px]" />
                <div className="absolute -top-40 left-1/3 w-[420px] h-[420px] rounded-full bg-cyan-500/[0.05] blur-[130px]" />
            </div>

            {/* ============ 顶部栏 ============ */}
            <header className="relative z-10 flex items-center gap-4 px-4 h-14 border-b border-white/[0.08] bg-[#0d0d12]/80 backdrop-blur shrink-0">
                <button
                    onClick={onBack}
                    title="返回项目列表"
                    className="h-8 px-2.5 rounded-lg text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.07] flex items-center gap-1.5 text-[13px] transition-colors shrink-0"
                >
                    <ArrowLeft size={16} />
                    <span>返回</span>
                </button>

                {/* 步骤条 */}
                <nav className="flex-1 flex items-center gap-1.5 px-4 min-w-0">
                    {STEPS.map((s, i) => {
                        const isDone = i < stepIndex;
                        const isCurrent = i === stepIndex;
                        return (
                            <React.Fragment key={s.key}>
                                {i > 0 && (
                                    <div className={`h-px w-7 shrink-0 ${i <= stepIndex ? 'bg-cyan-400/40' : 'bg-white/[0.1]'}`} />
                                )}
                                <button
                                    onClick={() => setStepIndex(i)}
                                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg shrink-0 transition-colors ${
                                        isCurrent ? 'text-cyan-300' : isDone ? 'text-neutral-300' : 'text-neutral-500 hover:text-neutral-300'
                                    }`}
                                >
                                    <span
                                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-medium shrink-0 ${
                                            isCurrent
                                                ? 'bg-cyan-400 text-[#04231f]'
                                                : isDone
                                                    ? 'bg-cyan-400/25 text-cyan-300'
                                                    : 'bg-white/[0.08] text-neutral-500'
                                        }`}
                                    >
                                        {isDone ? <Check size={12} /> : i + 1}
                                    </span>
                                    <span className="text-[13px] font-medium whitespace-nowrap">{s.label}</span>
                                </button>
                            </React.Fragment>
                        );
                    })}
                </nav>

                {/* 右侧操作 */}
                <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                            disabled={stepIndex === 0}
                            title="上一步"
                            className="h-8 w-8 rounded-lg text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.07] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                        >
                            <ChevronLeft size={17} />
                        </button>
                        <button
                            onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
                            disabled={stepIndex === STEPS.length - 1}
                            className="h-8 px-3.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-[13px] font-medium text-[#04231f] flex items-center gap-1 transition-colors"
                        >
                            下一步
                            <ChevronRight size={15} />
                        </button>
                    </div>
                </div>
            </header>

            {/* ============ 内容区 ============ */}
            <main className="relative z-10 flex-1 flex min-h-0">
                {/* ---------- 步骤 3：资产确认（左侧选集栏由面板自绘） ---------- */}
                {currentStep.key === 'assets' ? (
                    <AssetConfirmPanel
                        projectId={project.id}
                        episodes={mergedEpisodes}
                        contentType={project.category}
                        onGoOverview={() => setStepIndex(0)}
                        onAssetsChange={handleAssetsChange}
                    />
                ) : currentStep.key === 'canvas' ? (
                    <div className="flex-1 flex items-center justify-center p-6">
                        <div className="w-full max-w-[520px] rounded-2xl border border-white/[0.08] bg-[#141419] p-8 text-center">
                            <div className="mx-auto w-14 h-14 rounded-2xl bg-violet-500/15 flex items-center justify-center mb-4">
                                <LayoutTemplate size={26} className="text-violet-300" />
                            </div>
                            <h2 className="text-[17px] font-semibold text-neutral-100">进入项目画布</h2>
                            <p className="text-[13px] text-neutral-500 mt-2 mb-6 leading-relaxed">
                                进入后可按「集」搭建独立画布，围绕每一集自由编排文本 → 图片 → 视频的节点流；各集画布互不干扰、独立保存。
                            </p>
                            <button
                                onClick={() => setCanvasConfirmOpen(true)}
                                className="h-10 px-6 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-[14px] font-medium transition-colors inline-flex items-center gap-2"
                            >
                                <LayoutTemplate size={16} />
                                进入画布
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 min-w-0 overflow-y-auto">
                        <div className="max-w-[1080px] mx-auto px-6 py-6">
                            {/* ---------- 步骤 1：基本信息 ---------- */}
                            {currentStep.key === 'basic' && (
                                <section>
                                    <h2 className="text-[15px] font-semibold text-neutral-100 flex items-center gap-2">
                                        <Info size={16} className="text-cyan-300" />
                                        基本信息
                                    </h2>
                                    <p className="text-[13px] text-neutral-500 mt-1 mb-4">项目的基础档案，来源于项目创建时填写的资料。</p>
                                    <div className="grid grid-cols-2 gap-3">
                                        {infoFields.map((f) => (
                                            <div key={f.label} className="rounded-xl border border-white/[0.08] bg-[#141419] px-4 py-3 flex items-start justify-between gap-3">
                                                <span className="text-[13px] text-neutral-500 shrink-0">{f.label}</span>
                                                <span className="text-[13px] text-neutral-200 font-medium text-right">{f.value || '—'}</span>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* ---------- 步骤 2：剧本分集（与新建项目的分集阅读器一致） ---------- */}
                            {currentStep.key === 'episodes' && (
                                <section>
                                    <div className="flex items-center gap-2 mb-3">
                                        <CheckCircle2 size={17} className="text-emerald-400" />
                                        <span className="text-[14px] font-medium text-neutral-100">
                                            分集完成，共 {mergedEpisodes.length} 集
                                        </span>
                                        <span className="text-[12px] text-neutral-500">· 左侧选择分集，右侧查看对应剧本原文</span>
                                    </div>

                                    {mergedEpisodes.length === 0 ? (
                                        <EmptyHint text="该项目暂无剧本分集结果，请先在项目详情中解析剧本。" />
                                    ) : (
                                        <div className="flex gap-3 h-[560px]">
                                            {/* 左侧分集目录 */}
                                            <div className="w-[150px] shrink-0 border border-white/[0.08] rounded-lg overflow-hidden flex flex-col">
                                                <div className="px-3 py-2 text-[12px] font-medium text-neutral-500 bg-white/[0.04] border-b border-white/[0.06]">
                                                    分集目录
                                                </div>
                                                <div className="flex-1 overflow-y-auto">
                                                    {mergedEpisodes.map((ep, idx) => {
                                                        const active = activeEpisodeIndex === idx;
                                                        return (
                                                            <button
                                                                key={ep.episode}
                                                                type="button"
                                                                onClick={() => setActiveEpisodeIndex(idx)}
                                                                className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${
                                                                    active
                                                                        ? 'bg-cyan-400/[0.08] border-cyan-400'
                                                                        : 'border-transparent hover:bg-white/[0.04]'
                                                                }`}
                                                            >
                                                                <div className={`text-[13px] font-medium ${active ? 'text-cyan-300' : 'text-neutral-300'}`}>
                                                                    第 {String(ep.episode).padStart(2, '0')} 集
                                                                </div>
                                                                <div className={`text-[12px] truncate ${active ? 'text-cyan-300/70' : 'text-neutral-500'}`}>
                                                                    {ep.title}
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </div>

                                            {/* 右侧内容：标题 / 概要 / 剧本原文 */}
                                            <div className="flex-1 min-w-0 border border-white/[0.08] rounded-lg overflow-hidden flex flex-col">
                                                {mergedEpisodes[activeEpisodeIndex] ? (() => {
                                                    const ep = mergedEpisodes[activeEpisodeIndex];
                                                    return (
                                                        <>
                                                            <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-3">
                                                                <span className="text-[12px] text-neutral-500 whitespace-nowrap">
                                                                    第 {String(ep.episode).padStart(2, '0')} 集
                                                                </span>
                                                                <input
                                                                    type="text"
                                                                    value={ep.title}
                                                                    onChange={(e) =>
                                                                        setEpisodeTitles((prev) => ({ ...prev, [ep.episode]: e.target.value }))
                                                                    }
                                                                    className="w-[180px] px-2 py-1 rounded border border-transparent hover:border-white/[0.12] focus:border-cyan-400/60 focus:outline-none text-[13px] font-medium text-neutral-100 bg-transparent"
                                                                />
                                                                <span className="flex-1" />
                                                                <span className="text-[12px] text-neutral-500 whitespace-nowrap">{ep.wordCount} 字</span>
                                                                <span className="text-[12px] text-neutral-500 whitespace-nowrap flex items-center gap-1">
                                                                    <Clock size={12} />
                                                                    {formatDurationSeconds(ep.durationSeconds)}
                                                                </span>
                                                            </div>
                                                            <div className="px-4 py-2 text-[12px] text-neutral-400 leading-relaxed bg-white/[0.03] border-b border-white/[0.06]">
                                                                {ep.summary || '暂无概要'}
                                                            </div>
                                                            <div className="flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-7 text-neutral-300 whitespace-pre-wrap">
                                                                {ep.content && ep.content.trim()
                                                                    ? ep.content
                                                                    : '（未能定位到该集的剧本原文）'}
                                                            </div>
                                                        </>
                                                    );
                                                })() : (
                                                    <div className="flex-1 flex items-center justify-center text-[13px] text-neutral-500">
                                                        请选择左侧分集
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </section>
                            )}
                        </div>
                    </div>
                )}
            </main>

            {/* 进入画布二次确认 */}
            {canvasConfirmOpen && (
                <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-full max-w-[400px] rounded-2xl border border-white/[0.12] bg-[#16161c] p-6">
                        <h3 className="text-[15px] font-semibold text-neutral-100">确认进入项目画布</h3>
                        <p className="text-[13px] text-neutral-500 mt-2 leading-relaxed">
                            即将离开当前工作流，进入「{project?.name || ''}」的项目画布。当前步骤与资产进度已自动保存，可随时返回继续。
                        </p>
                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={() => setCanvasConfirmOpen(false)}
                                className="h-9 px-4 rounded-lg border border-white/[0.12] text-[13px] text-neutral-300 hover:text-neutral-100 hover:border-white/[0.25] transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => onEnterCanvas(projectId)}
                                className="h-9 px-4 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[13px] font-medium transition-colors"
                            >
                                确认进入
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};

// ============================================================================
// 空状态提示
// ============================================================================

const EmptyHint: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-neutral-600">
        <FileText size={28} className="opacity-70" />
        <div className="text-[13px]">{text}</div>
    </div>
);

export default WorkflowPage;
