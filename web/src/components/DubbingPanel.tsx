/**
 * DubbingPanel.tsx
 *
 * 「视频生成 → 配音」面板（对齐设计稿）。
 *   配音导出说明（可关）
 *   音色配置（旁白音色，可折叠）
 *   基础设置（音量 / 音速滑杆，可折叠）
 *   台词配音（按分镜逐条：角色、台词、试听、重生成、排序、删除）
 *   底部「添加出镜角色」
 *
 * 数据通过 dubbingService 持久化；试听使用浏览器内置语音合成。
 * 真实 AI 音频导出待后端 TTS 接入（见 dubbingService.synthesizeLine）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    X,
    Loader2,
    Info,
    ChevronUp,
    ChevronDown,
    Play,
    RefreshCw,
    Trash2,
    SlidersHorizontal,
    Plus,
    AlertCircle,
    Download,
    Wand2,
    Pause,
} from 'lucide-react';
import {
    DubbingLine,
    EpisodeDubbing,
    NARRATOR,
    VOICE_OPTIONS,
    createLine,
    isPreviewSupported,
    previewLine,
    stopPreview,
    synthesizeLine,
    isTTSConfigured,
    playAudio,
    stopAudio,
    downloadAudio,
    isLineAudioFresh,
    signatureOf,
} from '../services/dubbingService';
import {
    resolveLineContext,
    resolveLineVoice,
    type RoleVoiceMap,
} from '../services/dubbingVoice';
import { normalizeVoiceId, voiceLabel } from '../services/voiceCatalog';

interface DubbingPanelProps {
    /** 当前集号 */
    episode: number;
    /** 当前集配音数据（由父级持有并持久化） */
    data: EpisodeDubbing;
    /** 本集角色名（来自角色资产，外加「旁白」） */
    roleNames: string[];
    /** 角色名 → 音色（来自资产确认页的 voiceName，未配置则不传） */
    voiceByRole?: Record<string, string>;
    /** 角色名 → 自定义音色风格提示词（来自资产确认页的 voicePrompt） */
    voicePromptByRole?: Record<string, string>;
    /** 修改当前集配音数据 */
    onChange: (next: EpisodeDubbing) => void;
}

// ============================================================================
// 组件
// ============================================================================

export const DubbingPanel: React.FC<DubbingPanelProps> = ({
    episode,
    data,
    roleNames,
    voiceByRole,
    voicePromptByRole,
    onChange,
}) => {
    const [noticeOpen, setNoticeOpen] = useState(true);
    const [voiceOpen, setVoiceOpen] = useState(true);
    const [basicOpen, setBasicOpen] = useState(true);
    /** 正在试听（浏览器语音）的台词 id */
    const [playingId, setPlayingId] = useState<string | null>(null);
    /** 正在播放真实音频的台词 id */
    const [audioId, setAudioId] = useState<string | null>(null);
    /** 正在真实合成的台词 id 集合（支持批量，逐个串行） */
    const [synthIds, setSynthIds] = useState<Set<string>>(new Set());
    /** 是否正在批量合成 */
    const [batch, setBatch] = useState(false);
    /** 后端 TTS 是否已配置凭证 */
    const [ttsReady, setTtsReady] = useState<boolean | null>(null);
    const [error, setError] = useState('');

    // 角色下拉选项：旁白 + 本集角色 + 台词里出现但未进资产的角色（群演、临时称呼）
    const roleOptions = useMemo(() => {
        const set = new Set<string>([NARRATOR, ...roleNames.filter((r) => r !== NARRATOR)]);
        for (const line of data.lines) {
            if (line.role) set.add(line.role);
        }
        return Array.from(set);
    }, [roleNames, data.lines]);

    // 探测一次 TTS 配置状态
    useEffect(() => {
        void isTTSConfigured().then(setTtsReady);
    }, []);

    // 离开 / 切换集时停止试听与真实音频
    useEffect(
        () => () => {
            stopPreview();
            stopAudio();
        },
        []
    );
    useEffect(() => {
        stopPreview();
        stopAudio();
        setPlayingId(null);
        setAudioId(null);
    }, [episode]);

    const patch = (p: Partial<EpisodeDubbing>) => onChange({ ...data, ...p });

    const patchLine = (id: string, p: Partial<DubbingLine>) =>
        patch({ lines: data.lines.map((l) => (l.id === id ? { ...l, ...p } : l)) });

    const removeLine = (id: string) => {
        if (playingId === id) {
            stopPreview();
            setPlayingId(null);
        }
        if (audioId === id) {
            stopAudio();
            setAudioId(null);
        }
        patch({ lines: data.lines.filter((l) => l.id !== id) });
    };

    const moveLine = (id: string, dir: -1 | 1) => {
        const idx = data.lines.findIndex((l) => l.id === id);
        const target = idx + dir;
        if (idx < 0 || target < 0 || target >= data.lines.length) return;
        const next = [...data.lines];
        [next[idx], next[target]] = [next[target], next[idx]];
        patch({ lines: next });
    };

    const addLine = () => patch({ lines: [...data.lines, createLine(data.lines.length + 1)] });

    /**
     * 角色 → 音色映射（统一由 dubbingVoice 解析）。
     * 这里把父级传入的两个 Record 合成一份，保证配音面板与成片音轨
     * 走的是同一套「资产音色优先，缺失回落旁白」的规则。
     */
    const roleVoiceMap = useMemo<RoleVoiceMap>(() => {
        const map: RoleVoiceMap = {};
        for (const [name, voice] of Object.entries(voiceByRole || {})) {
            if (!name || !voice) continue;
            map[name] = { voice, prompt: voicePromptByRole?.[name] || undefined };
        }
        return map;
    }, [voiceByRole, voicePromptByRole]);

    const voiceForLine = (line: DubbingLine): string =>
        resolveLineVoice(line.role, roleVoiceMap, data.narratorVoice);

    /** 该台词的风格指令：角色音色提示 + 剧本括号里的表演提示（送给 2.0 模型） */
    const promptForLine = (line: DubbingLine): string[] | undefined => {
        const ctx = resolveLineContext(line, roleVoiceMap);
        return ctx.length ? ctx : undefined;
    };

    /** 这条台词在当前音色下是否已合成（资产换音色、改表演提示后即为 false） */
    const isFresh = (line: DubbingLine): boolean =>
        isLineAudioFresh(
            line,
            signatureOf(line, voiceForLine(line), promptForLine(line)?.join('\u0001'))
        );

    const handlePreview = (line: DubbingLine) => {
        if (!isPreviewSupported()) {
            setError('当前浏览器不支持语音试听');
            return;
        }
        if (playingId === line.id) {
            stopPreview();
            setPlayingId(null);
            return;
        }
        stopPreview();
        setPlayingId(line.id);
        previewLine(line, { volume: data.volume, speed: data.speed });
        // 兜底：约按字数估算结束后复位（onend 在部分浏览器不稳）
        window.setTimeout(() => setPlayingId((cur) => (cur === line.id ? null : cur)), Math.max(1500, line.text.length * 220));
    };

    /** 真实合成一条；同时记录音色指纹，供「资产换音色后自动失效」判断 */
    const synthOne = async (line: DubbingLine): Promise<void> => {
        setSynthIds((prev) => new Set(prev).add(line.id));
        try {
            const voice = voiceForLine(line);
            const prompt = promptForLine(line);
            const url = await synthesizeLine(line, {
                voice,
                volume: data.volume,
                speed: data.speed,
                contextTexts: prompt,
            });
            patchLine(line.id, {
                audioUrl: url,
                audioSignature: signatureOf(line, voice, prompt?.[0]),
            });
        } finally {
            setSynthIds((prev) => {
                const next = new Set(prev);
                next.delete(line.id);
                return next;
            });
        }
    };

    /** 单条真实合成（带错误提示） */
    const handleSynthesize = async (line: DubbingLine) => {
        setError('');
        try {
            await synthOne(line);
        } catch (e: any) {
            setError(e?.message || '合成失败');
        }
    };

    /** 播放 / 暂停某条已合成的真实音频 */
    const handleToggleAudio = (line: DubbingLine) => {
        if (!line.audioUrl) return;
        if (audioId === line.id) {
            stopAudio();
            setAudioId(null);
            return;
        }
        stopPreview();
        setPlayingId(null);
        setAudioId(line.id);
        playAudio(line.id, line.audioUrl, () =>
            setAudioId((cur) => (cur === line.id ? null : cur))
        );
    };

    /** 单条下载 */
    const handleDownload = (line: DubbingLine, idx: number) => {
        if (!line.audioUrl) return;
        downloadAudio(line.audioUrl, `配音_第${episode}集_${idx + 1}.mp3`);
    };

    /**
     * 批量合成本集全部。
     * 判定依据不是「有没有 audioUrl」，而是「音频是否匹配当前音色」：
     * 资产里改了音色后，旧音频的指纹对不上，会被重新合成。
     */
    const handleBatchSynth = async () => {
        setError('');
        const targets = data.lines.filter((l) => l.text.trim() && !isFresh(l));
        if (targets.length === 0) {
            setError('全部台词均已按当前音色合成，如需刷新请单条点击重生成');
            return;
        }
        setBatch(true);
        let lastErr = '';
        for (const line of targets) {
            try {
                // 用最新数据里的文本，避免用户在批量过程中改了词
                // eslint-disable-next-line no-await-in-loop
                const fresh = data.lines.find((l) => l.id === line.id) || line;
                // eslint-disable-next-line no-await-in-loop
                await synthOne(fresh);
            } catch (e: any) {
                lastErr = e?.message || '合成失败';
            }
        }
        setBatch(false);
        if (lastErr) setError(lastErr);
    };

    return (
        <div className="space-y-3">
            {/* ============ 配音导出说明 ============ */}
            {noticeOpen && (
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.1] px-3 py-2.5">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-300">
                            <Info size={14} />
                            配音导出说明
                        </div>
                        <button
                            onClick={() => setNoticeOpen(false)}
                            className="text-emerald-400/70 hover:text-emerald-200"
                            title="关闭"
                        >
                            <X size={14} />
                        </button>
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-emerald-200/80">
                        生成的配音为 AI 合成音频，导出后将作为【独立音频文件】，用于导入剪映等工具进行剪辑。此功能与视频生成相互独立。
                    </p>
                </div>
            )}

            {/* TTS 凭证未配置提示（已配置则不显示） */}
            {ttsReady === false && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.1] px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-amber-300">
                        <AlertCircle size={14} />
                        AI 配音未启用
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-amber-200/80">
                        服务器尚未配置火山语音凭证。请在 <code className="text-amber-200">.env</code> 填入{' '}
                        <code className="text-amber-200">TTS_APP_ID</code> /{' '}
                        <code className="text-amber-200">TTS_ACCESS_TOKEN</code> 并重启服务。当前「试听」仍可用（浏览器语音预览）。
                    </p>
                </div>
            )}

            {/* ============ 音色配置 ============ */}
            <Section
                title="音色配置"
                subtitle="绑定专属音色，全剧同步变更"
                open={voiceOpen}
                onToggle={() => setVoiceOpen((v) => !v)}
            >
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                    <div className="text-[12px] text-neutral-500">旁白：</div>
                    <div className="mt-1.5 flex items-center gap-2">
                        <select
                            value={normalizeVoiceId(data.narratorVoice)}
                            onChange={(e) => patch({ narratorVoice: e.target.value })}
                            className="h-9 flex-1 rounded-lg bg-white/[0.05] border border-white/[0.1] px-2.5 text-[13px] text-neutral-100 outline-none focus:border-emerald-400/50"
                        >
                            {VOICE_OPTIONS.map((v) => (
                                <option key={v.id} value={v.id} className="bg-[#1b1b22]">
                                    {v.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* 角色音色：来自资产确认页「AI 分配音色」，只读展示 */}
                    {roleNames.length > 0 && (
                        <div className="mt-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                            <div className="text-[12px] text-neutral-500">角色音色（来自资产确认）</div>
                            <div className="mt-1.5 space-y-1">
                                {roleNames.map((r) => (
                                    <div key={r} className="flex items-center justify-between text-[12px]">
                                        <span className="text-neutral-300">{r}</span>
                                        <span
                                            title={voicePromptByRole?.[r] || ''}
                                            className={voiceByRole?.[r] ? 'text-cyan-300' : 'text-neutral-600'}
                                        >
                                            {voiceByRole?.[r]
                                                ? `${voiceLabel(voiceByRole[r])}${voicePromptByRole?.[r] ? '*' : ''}`
                                                : '未配置（跟随旁白）'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </Section>

            {/* ============ 基础设置 ============ */}
            <Section
                title="基础设置"
                open={basicOpen}
                onToggle={() => setBasicOpen((v) => !v)}
            >
                <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-3">
                    <SliderRow
                        label="音量"
                        value={data.volume}
                        min={0}
                        max={1}
                        step={0.05}
                        display={`${data.volume.toFixed(2)}x`}
                        onChange={(v) => patch({ volume: v })}
                    />
                    <SliderRow
                        label="音速"
                        value={data.speed}
                        min={0.5}
                        max={2}
                        step={0.05}
                        display={`${data.speed.toFixed(2)}x`}
                        onChange={(v) => patch({ speed: v })}
                    />
                </div>
            </Section>

            {/* ============ 台词配音 ============ */}
            <div>
                <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[13px] font-semibold text-neutral-200">台词配音</span>
                    <button
                        onClick={() => void handleBatchSynth()}
                        disabled={batch || data.lines.length === 0}
                        className="flex items-center gap-1 h-7 px-2.5 rounded-lg border border-emerald-400/30 bg-emerald-500/[0.08] text-[12px] font-medium text-emerald-300 hover:bg-emerald-500/[0.16] disabled:opacity-50"
                        title="串行合成本集全部尚未合成的台词"
                    >
                        {batch ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                        {batch ? '合成中…' : '一键合成'}
                    </button>
                </div>
                <div className="space-y-2.5">
                    {data.lines.map((line, idx) => {
                        const isPlaying = playingId === line.id;
                        const isAudio = audioId === line.id;
                        const isSynth = synthIds.has(line.id);
                        return (
                            <div
                                key={line.id}
                                className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"
                            >
                                {/* 卡片头：标题 + 排序 / 删除 */}
                                <div className="flex items-center justify-between">
                                    <span className="text-[13px] font-medium text-neutral-200">
                                        {line.shotNumber ? `镜头 ${line.shotNumber} 台词` : `分镜台词${idx + 1}`}
                                        {line.isVoiceOver && (
                                            <span className="ml-1.5 text-[10px] font-normal text-neutral-500">
                                                画外音
                                            </span>
                                        )}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => moveLine(line.id, -1)}
                                            disabled={idx === 0}
                                            title="上移"
                                            className="h-6 w-6 rounded text-neutral-500 hover:text-neutral-200 disabled:opacity-30 flex items-center justify-center"
                                        >
                                            <SlidersHorizontal size={13} className="-rotate-90" />
                                        </button>
                                        <button
                                            onClick={() => moveLine(line.id, 1)}
                                            disabled={idx === data.lines.length - 1}
                                            title="下移"
                                            className="h-6 w-6 rounded text-neutral-500 hover:text-neutral-200 disabled:opacity-30 flex items-center justify-center"
                                        >
                                            <SlidersHorizontal size={13} className="rotate-90" />
                                        </button>
                                        <button
                                            onClick={() => removeLine(line.id)}
                                            title="删除"
                                            className="h-6 w-6 rounded text-neutral-500 hover:text-red-300 flex items-center justify-center"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>

                                {/* 角色 */}
                                <div className="mt-2 text-[12px] text-neutral-500">角色</div>
                                <div className="relative mt-1">
                                    <select
                                        value={line.role}
                                        onChange={(e) => patchLine(line.id, { role: e.target.value })}
                                        className="h-9 w-full appearance-none rounded-lg bg-white/[0.05] border border-white/[0.1] px-2.5 pr-8 text-[13px] text-neutral-100 outline-none focus:border-emerald-400/50"
                                    >
                                        {roleOptions.map((r) => {
                                            const bound =
                                                r === NARRATOR ? data.narratorVoice : roleVoiceMap[r]?.voice;
                                            return (
                                                <option key={r} value={r} className="bg-[#1b1b22]">
                                                    {bound ? `${r} | 音色：${voiceLabel(bound)}` : r}
                                                </option>
                                            );
                                        })}
                                    </select>
                                    <ChevronDown
                                        size={14}
                                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
                                    />
                                </div>

                                {/* 台词 */}
                                <div className="mt-2 flex items-center justify-between">
                                    <span
                                        className={`text-[12px] ${
                                            line.audioUrl && !isFresh(line)
                                                ? 'text-amber-300/80'
                                                : 'text-neutral-500'
                                        }`}
                                    >
                                        {line.audioUrl && !isFresh(line) ? '音色已变更，需重新合成' : '台词'}
                                        {line.tone && (
                                            <span className="ml-1 text-neutral-600">（{line.tone}）</span>
                                        )}
                                    </span>
                                    <div className="flex items-center gap-1">
                                        {/* 试听：浏览器内置语音，快速预览（无需后端） */}
                                        <button
                                            onClick={() => handlePreview(line)}
                                            title={isPlaying ? '停止试听' : '试听（浏览器语音预览）'}
                                            className={`h-6 w-6 rounded flex items-center justify-center transition-colors ${
                                                isPlaying
                                                    ? 'text-emerald-300'
                                                    : 'text-neutral-400 hover:text-emerald-300'
                                            }`}
                                        >
                                            {isPlaying ? <span className="h-2 w-2 rounded-full bg-emerald-400" /> : <Play size={13} />}
                                        </button>
                                        {/* 真实音频播放（仅已合成时可用） */}
                                        <button
                                            onClick={() => handleToggleAudio(line)}
                                            disabled={!line.audioUrl}
                                            title={!line.audioUrl ? '尚未合成 AI 配音' : isAudio ? '停止播放' : '播放 AI 配音'}
                                            className={`h-6 w-6 rounded flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                                                isAudio
                                                    ? 'text-emerald-300'
                                                    : 'text-neutral-400 hover:text-emerald-300'
                                            }`}
                                        >
                                            {isAudio ? <Pause size={13} /> : <Play size={13} className="fill-current" />}
                                        </button>
                                        {/* 下载独立音频 */}
                                        <button
                                            onClick={() => handleDownload(line, idx)}
                                            disabled={!line.audioUrl}
                                            title="下载为独立 mp3 文件"
                                            className="h-6 w-6 rounded text-neutral-400 hover:text-emerald-300 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
                                        >
                                            <Download size={13} />
                                        </button>
                                        {/* 合成 / 重新生成 */}
                                        <button
                                            onClick={() => void handleSynthesize(line)}
                                            disabled={isSynth}
                                            title={line.audioUrl ? '重新生成 AI 配音' : '生成 AI 配音'}
                                            className="h-6 w-6 rounded text-neutral-400 hover:text-emerald-300 disabled:opacity-50 flex items-center justify-center"
                                        >
                                            {isSynth ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                                        </button>
                                    </div>
                                </div>
                                <textarea
                                    value={line.text}
                                    onChange={(e) => patchLine(line.id, { text: e.target.value })}
                                    rows={3}
                                    className="mt-1 w-full resize-none rounded-lg bg-white/[0.04] border border-white/[0.08] px-2.5 py-2 text-[13px] text-neutral-100 outline-none focus:border-emerald-400/50"
                                />
                            </div>
                        );
                    })}

                    {data.lines.length === 0 && (
                        <div className="rounded-xl border border-dashed border-white/[0.12] py-8 text-center text-[12px] text-neutral-600">
                            暂无台词，点击下方按钮添加
                        </div>
                    )}
                </div>

                {/* 添加出镜角色 */}
                <button
                    onClick={addLine}
                    className="mt-3 w-full h-10 rounded-lg border border-emerald-400/30 bg-emerald-500/[0.08] text-[13px] font-medium text-emerald-300 hover:bg-emerald-500/[0.14] flex items-center justify-center gap-1.5 transition-colors"
                >
                    <Plus size={15} />
                    添加出镜角色
                </button>
            </div>

            {/* 错误提示 */}
            {error && (
                <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/25 px-2.5 py-2 text-[11px] text-red-300">
                    <AlertCircle size={12} className="shrink-0" />
                    <span className="flex-1">{error}</span>
                </div>
            )}
        </div>
    );
};

// ============================================================================
// 子组件
// ============================================================================

const Section: React.FC<{
    title: string;
    subtitle?: string;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}> = ({ title, subtitle, open, onToggle, children }) => (
    <div>
        <button
            onClick={onToggle}
            className="w-full flex items-center gap-2 text-left"
        >
            <span className="text-[13px] font-semibold text-neutral-200">{title}</span>
            {subtitle && <span className="text-[11px] text-neutral-500">{subtitle}</span>}
            <span className="ml-auto text-neutral-500">
                {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </span>
        </button>
        {open && <div className="mt-2">{children}</div>}
    </div>
);

const SliderRow: React.FC<{
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    display: string;
    onChange: (v: number) => void;
}> = ({ label, value, min, max, step, display, onChange }) => (
    <div>
        <div className="text-[12px] text-neutral-500">{label}</div>
        <div className="mt-1.5 flex items-center gap-2.5">
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="flex-1 accent-emerald-400"
            />
            <span className="w-14 shrink-0 h-8 rounded-lg bg-white/[0.05] border border-white/[0.1] flex items-center justify-center text-[12px] text-neutral-200">
                {display}
            </span>
        </div>
    </div>
);
