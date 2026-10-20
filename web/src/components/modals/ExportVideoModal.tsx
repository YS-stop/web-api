import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';

export type ExportDimension = 'episode' | 'shot';
export type ExportRange = 'all' | 'custom';

export interface ExportVideoOptions {
    dimension: ExportDimension;
    range: ExportRange;
    /** 最终参与导出的集号列表 */
    selected: number[];
}

interface ExportVideoModalProps {
    open: boolean;
    /** 所有可选集号 */
    episodes: number[];
    /** 视频生成页面当前选中的集，用于「分片段导出（本集）」 */
    currentEpisode: number;
    /** 导出中：禁用按钮并显示 loading */
    exporting?: boolean;
    onClose: () => void;
    onConfirm: (options: ExportVideoOptions) => void;
}

const OptionButton: React.FC<{
    active: boolean;
    onClick: () => void;
    title: string;
    disabled?: boolean;
}> = ({ active, onClick, title, disabled }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex-1 min-w-0 px-3.5 h-11 rounded-xl border text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            active
                ? 'border-white/[0.5] bg-white/[0.08] text-neutral-100'
                : 'border-white/[0.08] bg-white/[0.03] text-neutral-500 hover:border-white/[0.2] hover:text-neutral-300'
        }`}
    >
        {title}
    </button>
);

/**
 * 视频批量导出弹窗。
 * 只保留「导出维度」与「导出范围」，导出类型固定为视频。
 */
export const ExportVideoModal: React.FC<ExportVideoModalProps> = ({
    open,
    episodes,
    currentEpisode,
    exporting = false,
    onClose,
    onConfirm,
}) => {
    const [dimension, setDimension] = useState<ExportDimension>('episode');
    const [range, setRange] = useState<ExportRange>('all');
    const [selected, setSelected] = useState<number[]>([]);
    const [error, setError] = useState('');

    const episodesKey = episodes.join(',');

    // 每次打开时重置为默认：分集导出 + 全部分集
    useEffect(() => {
        if (!open) return;
        setDimension('episode');
        setRange('all');
        setSelected(episodes);
        setError('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, episodesKey]);

    const allSelected = episodes.length > 0 && selected.length === episodes.length;

    const toggleEpisode = (ep: number) => {
        setSelected((prev) =>
            prev.includes(ep)
                ? prev.filter((item) => item !== ep)
                : [...prev, ep].sort((a, b) => a - b)
        );
    };

    const handleConfirm = () => {
        // 分片段导出（本集）：固定只导出当前集
        const selectedEpisodes = dimension === 'shot'
            ? [currentEpisode]
            : range === 'all'
                ? episodes
                : selected;

        if (selectedEpisodes.length === 0) {
            setError('请至少选择一集');
            return;
        }

        setError('');
        onConfirm({ dimension, range, selected: selectedEpisodes });
    };

    if (!open) return null;

    const rangeDisabled = exporting || dimension === 'shot';

    return (
        <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && !exporting && onClose()}
        >
            <div className="bg-[#121212] border border-neutral-800 rounded-2xl w-[560px] max-w-[95vw] max-h-[90vh] shadow-2xl overflow-hidden flex flex-col">
                {/* 头部 */}
                <div className="flex items-center justify-between px-6 pt-5 pb-3">
                    <h3 className="text-[16px] font-semibold text-neutral-100">导出</h3>
                    <button
                        onClick={onClose}
                        disabled={exporting}
                        className="h-8 w-8 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.06] flex items-center justify-center transition-colors disabled:opacity-40"
                    >
                        <X size={17} />
                    </button>
                </div>

                <div className="px-6 pb-5 overflow-y-auto">
                    {/* 导出维度 */}
                    <div className="text-[12px] text-neutral-400 mb-2">导出维度</div>
                    <div className="flex gap-2">
                        <OptionButton
                            active={dimension === 'episode'}
                            onClick={() => setDimension('episode')}
                            title="分集导出"
                            disabled={exporting}
                        />
                        <OptionButton
                            active={dimension === 'shot'}
                            onClick={() => setDimension('shot')}
                            title="分片段导出（本集）"
                            disabled={exporting}
                        />
                    </div>

                    {/* 导出范围 */}
                    <div className="text-[12px] text-neutral-400 mt-5 mb-2">
                        导出范围
                        {dimension === 'shot' && (
                            <span className="ml-2 text-[11px] text-neutral-600">分片段导出固定为第 {currentEpisode} 集</span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <OptionButton
                            active={dimension === 'episode' && range === 'all'}
                            onClick={() => setRange('all')}
                            title="导出全部分集"
                            disabled={rangeDisabled}
                        />
                        <OptionButton
                            active={dimension === 'episode' && range === 'custom'}
                            onClick={() => setRange('custom')}
                            title="自定义分集"
                            disabled={rangeDisabled}
                        />
                    </div>

                    {/* 自定义分集：集数勾选 */}
                    {dimension === 'episode' && range === 'custom' && (
                        <div className="mt-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[12px] text-neutral-400">选择分集</span>
                                <button
                                    type="button"
                                    onClick={() => setSelected(allSelected ? [] : episodes)}
                                    disabled={exporting}
                                    className="text-[12px] text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
                                >
                                    {allSelected ? '取消全选' : '全选'}
                                </button>
                            </div>
                            <div className="grid grid-cols-4 gap-2">
                                {episodes.map((ep) => {
                                    const active = selected.includes(ep);
                                    return (
                                        <button
                                            key={ep}
                                            type="button"
                                            onClick={() => toggleEpisode(ep)}
                                            disabled={exporting}
                                            className={`h-9 rounded-lg border text-[12px] transition-colors disabled:opacity-40 ${
                                                active
                                                    ? 'border-cyan-400/60 bg-cyan-400/[0.12] text-cyan-200'
                                                    : 'border-white/[0.1] bg-white/[0.03] text-neutral-400 hover:border-white/[0.22]'
                                            }`}
                                        >
                                            第 {ep} 集
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {error && <div className="mt-3 text-[12px] text-rose-400">{error}</div>}
                </div>

                {/* 底部 */}
                <div className="px-6 py-4 border-t border-white/[0.08] flex items-center justify-end gap-3">
                    <button
                        onClick={onClose}
                        disabled={exporting}
                        className="h-10 px-5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[13px] text-neutral-300 transition-colors disabled:opacity-40"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={exporting}
                        className="h-10 px-6 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[13px] font-semibold text-[#04231f] flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    >
                        {exporting && <Loader2 size={15} className="animate-spin" />}
                        {exporting ? '导出中…' : '确认导出'}
                    </button>
                </div>
            </div>
        </div>
    );
};
