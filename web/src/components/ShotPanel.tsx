/**
 * ShotPanel.tsx
 *
 * 项目画布左侧面板的「分镜」Tab。
 *
 * 职责
 * ─────────────────────────────────────────────────────────────
 * 1. 展示当前集的分镜列表（缩略图 / 片段号 / 描述 / 状态）；
 * 2. 点击片段展开详情：描述、景别、运镜、光线、氛围、时长、完整提示词；
 * 3. 每个片段可「添加到画布」或「生成视频」：
 *    - 添加到画布：只把已有成片/分镜图放上画布，不触发生成；
 *    - 生成视频：自动建参考图节点 + 视频节点、写入提示词、自动连线并触发生成。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    Loader2,
    Play,
    Film,
    Sparkles,
    Plus,
    ChevronDown,
    ChevronRight,
    RefreshCw,
    AlertTriangle,
    Wand2,
} from 'lucide-react';
import { AnalyzedEpisode } from '../services/scriptAnalysisService';
import {
    ShotState,
    RefAssets,
    getEpisodeShots,
    splitEpisodeShots,
    matchRefsForShot,
    resolveShotStyle,
    makeShotCode,
    orderShotsForMerge,
} from '../services/shotService';
import { groupShotsByScene } from '../services/sceneMergeService';

// ============================================================================
// 类型
// ============================================================================

interface ShotPanelProps {
    projectId: string;
    episode: AnalyzedEpisode | undefined;
    /** 项目内容类型，用于推导风格 */
    contentType?: string;
    /** 画布比例 */
    aspectRatio?: string;
    /** 目标时长（秒） */
    targetDuration?: number;
    /** 外部数据版本号：画布生成完成回写分镜后递增，触发面板重新读取 */
    refreshKey?: number;
    /** 参考图匹配数据源（资产确认里已生成图片的资产），不传则回退剧本资产 */
    refAssets?: RefAssets;
    /** 添加单个分镜到画布（不生成） */
    onAddShotToCanvas: (shot: ShotState) => void;
    /** 添加整集分镜到画布（不生成） */
    onAddAllShots: (shots: ShotState[]) => void;
    /** 一键成片：建参考图 + 视频节点并触发生成 */
    onGenerateShot: (shot: ShotState) => void;
    /** 批量一键成片 */
    onGenerateAllShots: (shots: ShotState[]) => void;
}

// ============================================================================
// 小组件
// ============================================================================

const MetaRow: React.FC<{ label: string; value?: string }> = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className="flex gap-2 text-[11px] leading-5">
            <span className="text-neutral-500 shrink-0 w-10">{label}</span>
            <span className="text-neutral-300 min-w-0">{value}</span>
        </div>
    );
};

// ============================================================================
// 主组件
// ============================================================================

export const ShotPanel: React.FC<ShotPanelProps> = ({
    projectId,
    episode,
    contentType,
    aspectRatio = '9:16',
    targetDuration,
    refreshKey,
    refAssets,
    onAddShotToCanvas,
    onAddAllShots,
    onGenerateShot,
    onGenerateAllShots,
}) => {
    const [shots, setShots] = useState<ShotState[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [localFallback, setLocalFallback] = useState(false);
    const [expandedShot, setExpandedShot] = useState<number | null>(null);

    const episodeNo = episode?.episode;

    // 切换分集时重新读取该集分镜
    useEffect(() => {
        if (!episodeNo) {
            setShots([]);
            return;
        }
        setShots(getEpisodeShots(projectId, episodeNo));
        setError('');
        setLocalFallback(false);
        setExpandedShot(null);
    }, [projectId, episodeNo, refreshKey]);

    // 画布上生成完成后会回写 localStorage，面板重新可见 / 窗口聚焦时同步一次
    useEffect(() => {
        const sync = () => {
            if (!episodeNo) return;
            setShots(getEpisodeShots(projectId, episodeNo));
        };
        window.addEventListener('focus', sync);
        document.addEventListener('visibilitychange', sync);
        return () => {
            window.removeEventListener('focus', sync);
            document.removeEventListener('visibilitychange', sync);
        };
    }, [projectId, episodeNo]);

    const { style, form } = useMemo(() => resolveShotStyle(contentType), [contentType]);

    /** 触发 AI 拆分镜 */
    const handleSplit = async () => {
        if (!episode) return;
        setLoading(true);
        setError('');
        try {
            const result = await splitEpisodeShots({
                projectId,
                episode,
                targetDuration,
                style,
                aspectRatio,
            });
            setShots(result.shots);
            setLocalFallback(result.localFallback);
            if (result.error) setError(result.error);
        } finally {
            setLoading(false);
        }
    };

    /** 刷新（外部可能刚写入新结果） */
    const handleRefresh = () => {
        if (!episodeNo) return;
        setShots(getEpisodeShots(projectId, episodeNo));
    };

    const doneCount = shots.filter((s) => !!s.videoUrl).length;
    const readyCount = shots.filter((s) => s.videoUrl || s.imageUrl).length;

    /** 列表与合并统一使用「场景顺序 + 片段号」的排序，避免展示顺序与实际拼接顺序不一致 */
    const orderedShots = useMemo(() => orderShotsForMerge(shots), [shots]);
    /** 按场号分组：4-1 / 4-2 各包含哪些片段，一眼可见 */
    const sceneGroups = useMemo(() => groupShotsByScene(orderedShots), [orderedShots]);

    // ---------- 空状态 ----------
    if (!episode) {
        return (
            <div className="flex-1 flex items-center justify-center text-[12px] text-neutral-500">
                请先选择分集
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 flex flex-col">
            {/* 顶部统计 + 操作 */}
            <div className="px-3 py-2 border-b border-white/8 shrink-0">
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[12px] text-neutral-300 truncate">
                        第 {episode.episode} 集 · {shots.length} 个片段
                        {sceneGroups.length > 0 && (
                            <span className="text-neutral-500"> · {sceneGroups.length} 个场景</span>
                        )}
                    </span>
                    <span className="ml-auto text-[11px] text-neutral-500 shrink-0 whitespace-nowrap">
                        已生成 <span className="text-cyan-300">{doneCount}</span>/{shots.length}
                    </span>
                </div>

                <div className="flex items-center gap-1.5">
                    <button
                        onClick={handleSplit}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[12px] font-medium transition-colors"
                    >
                        {loading ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                        {shots.length > 0 ? '重新拆分镜' : 'AI 拆分镜'}
                    </button>
                    <button
                        onClick={handleRefresh}
                        title="刷新（读取最新结果）"
                        className="w-8 h-8 rounded-lg border border-white/10 text-neutral-400 hover:bg-white/5 hover:text-neutral-200 flex items-center justify-center transition-colors"
                    >
                        <RefreshCw size={13} />
                    </button>
                </div>

                {localFallback && (
                    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-400/80">
                        <AlertTriangle size={11} />
                        AI 拆分镜失败，已用本地规则兜底
                    </div>
                )}
                {/* 老分镜没有场号：提示重新拆分镜，否则只能显示成「未分场」一组 */}
                {shots.length > 0 && shots.every((s) => !s.sceneNumber) && (
                    <div className="mt-1.5 text-[11px] leading-4 text-amber-400/80">
                        当前分镜没有场景信息，点「重新拆分镜」后会按 4-1 / 4-2 分组
                    </div>
                )}
                {error && !localFallback && (
                    <div className="mt-1.5 text-[11px] text-red-400/80">{error}</div>
                )}
            </div>

            {/* 列表 */}
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
                {loading && shots.length === 0 && (
                    <div className="py-10 flex flex-col items-center gap-2 text-neutral-500 text-[12px]">
                        <Loader2 size={16} className="animate-spin" />
                        AI 正在拆分镜…
                    </div>
                )}

                {!loading && shots.length === 0 && (
                    <div className="py-10 px-3 text-center text-[12px] text-neutral-600 leading-5">
                        该集还没有分镜
                        <br />
                        点上方「AI 拆分镜」开始
                    </div>
                )}

                {orderedShots.map((shot, shotIndex) => {
                    const expanded = expandedShot === shot.shotNumber;
                    const refs = matchRefsForShot(shot, episode, refAssets);
                    // 该片段是所在场景的第一个片段时，先插一行场景头
                    const prevShot = shotIndex > 0 ? orderedShots[shotIndex - 1] : undefined;
                    const sceneKey = String(shot.sceneNumber || '').trim() || '未分场';
                    const isSceneStart =
                        !prevShot || (String(prevShot.sceneNumber || '').trim() || '未分场') !== sceneKey;
                    const sceneGroup = isSceneStart ? sceneGroups.find((g) => g.key === sceneKey) : undefined;
                    return (
                        <React.Fragment key={shot.shotNumber}>
                        {isSceneStart && sceneGroup && (
                            <div className="flex items-center gap-1.5 px-1 pt-2 pb-0.5">
                                <span className="text-[11px] font-semibold text-cyan-300/90 shrink-0">
                                    {sceneGroup.sceneNumber}
                                </span>
                                {sceneGroup.location && (
                                    <span className="text-[10px] text-neutral-500 truncate">
                                        {sceneGroup.location}
                                    </span>
                                )}
                                {(sceneGroup.timeOfDay || sceneGroup.interiorExterior) && (
                                    <span className="text-[10px] text-neutral-600 shrink-0">
                                        {sceneGroup.timeOfDay}
                                        {sceneGroup.interiorExterior ? `·${sceneGroup.interiorExterior}` : ''}
                                    </span>
                                )}
                                <span className="ml-auto text-[10px] text-neutral-600 shrink-0">
                                    {sceneGroup.shots.length} 片段
                                </span>
                            </div>
                        )}
                        <div
                            key={shot.shotNumber}
                            className={`rounded-lg border transition-colors ${
                                expanded
                                    ? 'border-violet-400/50 bg-violet-500/[0.06]'
                                    : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.15]'
                            }`}
                        >
                            {/* 行：缩略图 + 摘要 */}
                            <button
                                onClick={() => {
                                    setExpandedShot(expanded ? null : shot.shotNumber);
                                    /**
                                     * 点击片段即把这条链路铺到画布：
                                     * 参考图节点（角色/场景/道具）+ 视频节点 + 连线一次建好，
                                     * 已经在画布上的片段只会被选中定位，不会重复铺。
                                     */
                                    onAddShotToCanvas(shot);
                                }}
                                className="w-full text-left flex gap-2 p-2"
                            >
                                <div className="relative w-[46px] shrink-0 aspect-[3/4] rounded-md bg-[#131318] overflow-hidden">
                                    {shot.imageUrl ? (
                                        <img src={shot.imageUrl} alt="" className="w-full h-full object-cover" />
                                    ) : shot.videoUrl ? (
                                        <video src={shot.videoUrl} className="w-full h-full object-cover" muted />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-neutral-700">
                                            <Film size={14} />
                                        </div>
                                    )}
                                    {shot.videoUrl && (
                                        <span className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-sm bg-cyan-400 text-[#04231f] flex items-center justify-center">
                                            <Play size={8} />
                                        </span>
                                    )}
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-[11px] text-violet-300">片段{shot.shotNumber}</span>
                                        {shot.durationSeconds ? (
                                            <span className="text-[10px] text-neutral-500">{shot.durationSeconds}s</span>
                                        ) : null}
                                        {refs.length > 0 && (
                                            <span className="text-[10px] text-emerald-400/80">参考图 {refs.length}</span>
                                        )}
                                        <span className="ml-auto text-neutral-600">
                                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                        </span>
                                    </div>
                                    <p className={`mt-0.5 text-[11px] leading-[15px] text-neutral-400 ${expanded ? '' : 'line-clamp-2'}`}>
                                        {shot.description}
                                    </p>
                                    {/* 片段编号：核对生成出来的视频时，用它与画布节点一一对应 */}
                                    <div className="mt-0.5 text-[10px] font-mono text-neutral-600 truncate">
                                        {makeShotCode(episode.episode, shot.sceneNumber, shot.shotNumber)}
                                    </div>
                                </div>
                            </button>

                            {/* 详情 */}
                            {expanded && (
                                <div className="px-2 pb-2 space-y-2">
                                    <div className="rounded-md bg-black/25 p-2 space-y-0.5">
                                        <MetaRow label="景别" value={shot.cameraAngle} />
                                        <MetaRow label="运镜" value={shot.cameraMovement} />
                                        <MetaRow label="光线" value={shot.lighting} />
                                        <MetaRow label="氛围" value={shot.mood} />
                                        <MetaRow label="时长" value={shot.durationSeconds ? `${shot.durationSeconds} 秒` : undefined} />
                                    </div>

                                    {refs.length > 0 && (
                                        <div>
                                            <div className="text-[10px] text-neutral-500 mb-1">自动匹配的参考图</div>
                                            <div className="flex flex-wrap gap-1">
                                                {refs.map((r) => (
                                                    <div key={r.url} className="relative w-9 h-9 rounded overflow-hidden border border-white/10">
                                                        <img src={r.url} alt={r.name} className="w-full h-full object-cover" />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {shot.prompt && (
                                        <div>
                                            <div className="text-[10px] text-neutral-500 mb-1">提示词</div>
                                            <div className="text-[10px] leading-4 text-neutral-400 bg-black/25 rounded-md p-2 max-h-[90px] overflow-y-auto whitespace-pre-wrap">
                                                {shot.prompt}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={() => onGenerateShot(shot)}
                                            className="flex-1 flex items-center justify-center gap-1 h-7 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-medium transition-colors"
                                        >
                                            <Sparkles size={12} />
                                            生成视频
                                        </button>
                                        <button
                                            onClick={() => onAddShotToCanvas(shot)}
                                            className="flex-1 flex items-center justify-center gap-1 h-7 rounded-md border border-white/10 text-neutral-300 hover:bg-white/5 text-[11px] transition-colors"
                                        >
                                            <Plus size={12} />
                                            添加到画布
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                        </React.Fragment>
                    );
                })}
            </div>

            {/* 底部批量操作 */}
            {shots.length > 0 && (
                <div className="p-2.5 border-t border-white/8 shrink-0 space-y-1.5">
                    <button
                        onClick={() => onGenerateAllShots(orderedShots)}
                        className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[12px] font-medium transition-colors"
                    >
                        <Sparkles size={13} />
                        全部生成视频
                        <span className="text-[10px] text-white/70">({shots.length})</span>
                    </button>
                    <button
                        onClick={() => onAddAllShots(orderedShots)}
                        disabled={readyCount === 0}
                        className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg border border-white/10 text-neutral-300 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed text-[12px] transition-colors"
                    >
                        <Plus size={13} />
                        全部添加到画布
                        {readyCount > 0 && <span className="text-[10px] text-neutral-500">({readyCount})</span>}
                    </button>
                </div>
            )}
        </div>
    );
};

export default ShotPanel;
