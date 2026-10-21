/**
 * ShotEditorPanel.tsx
 *
 * 工作流「视频生成」步骤 —— 三栏式片段（分镜）编辑 / 生成界面。
 *
 * 布局对齐设计稿：
 *   左栏  按集列出「片段」（缩略图 + 描述），底部「批量生成」
 *   中栏  视频预览（详情 / 工具箱）+ 播放器 + 该片段的历史生成记录（缩略图，点击切版本）
 *   右栏  多参生视频 / 多参生图 / 配音：参考图、提示词、风格、模型/分辨率/时长、生成按钮
 *
 * 片段由后端 /api/drama/split-shots（AI 拆分镜）生成，失败时本地规则兜底；
 * 生成视频走既有 /api/generate-video，片段与历史缓存在 localStorage（按 projectId 隔离）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Loader2,
    Pencil,
    Plus,
    X,
    Clock,
    Info,
    Briefcase,
    Play,
    Pause,
    Volume2,
    VolumeX,
    Maximize2,
    MoreVertical,
    Download,
    AlertCircle,
    Film,
    SquarePlus,
    SquareUser,
    CaptionsOff,
    Frame,
    Image as ImageIcon,
    Sparkles,
    Link2,
    ChevronDown,
    Menu,
    Lock,
    Check,
    History,
    Trash2,
} from 'lucide-react';
import type { AnalyzedEpisode, ShotItem } from '../services/scriptAnalysisService';
import { splitShots } from '../services/scriptAnalysisService';
import { generateImage, generateVideo, getGenerationStatus, submitVideoTask, getVideoTaskStatus } from '../services/generationService';
import { STYLE_OPTIONS, FORM_OPTIONS, buildImagePrompt, buildVideoPrompt, resolveStyleByContentType, resolveFormByContentType } from '../services/stylePresets';
import { persistJob } from '../services/projectStateService';
import { finishJob } from '../services/generationTaskService';
// 台词表演提示与画布侧共用一套拼法，避免「面板生成」和「画布生成」两处提示词漂移
import {
    composeModelVideoPrompt,
    describeRefsFromUrls,
    orderShotsForMerge,
    makeShotCode,
} from '../services/shotService';
// 场景级成片：场景内片段先拼成场景视频，再由场景视频拼整集
import {
    groupShotsByScene,
    sceneLabel,
    loadSceneMerges,
    getSceneMerge,
    mergeScene,
    mergeAllScenes,
    collectEpisodeVideos,
    type SceneGroup,
    type SceneMergeStore,
} from '../services/sceneMergeService';
import { runWithConcurrency, VIDEO_SUBMIT_CONCURRENCY, VIDEO_POLL_CONCURRENCY } from '../utils/concurrency';
import { VideoEditorModal } from './modals/VideoEditorModal';
import { DubbingPanel } from './DubbingPanel';
import {
    DubbingStore,
    EpisodeDubbing,
    buildEpisodeDubbing,
    loadDubbing,
    saveDubbing,
} from '../services/dubbingService';

// ============================================================================
// 常量
// ============================================================================

interface VideoModelMeta {
    id: string;
    name: string;
    durations: number[];
    resolutions: string[];
}

const VIDEO_MODELS: VideoModelMeta[] = [
    { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0', durations: [5, 10], resolutions: ['720p', '1080p'] },
    { id: 'doubao-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast', durations: [5, 10], resolutions: ['720p', '480p'] },
    { id: 'doubao-seedance-2-5-260628', name: 'Seedance 2.5', durations: [5, 10], resolutions: ['720p', '1080p'] },
];

const IMAGE_MODELS = [
    { id: 'doubao-seedream-5-0-pro-260628', name: '豆包 Seedream 5.0 Pro' },
];

const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'];
const ASPECT_OPTIONS = ['9:16', '16:9', '1:1'];
const PROMPT_MAX = 10000;

// ============================================================================
// 类型
// ============================================================================

interface ShotState extends ShotItem {
    videoUrl?: string;
    imageUrl?: string;
}

interface ShotEditorPanelProps {
    projectId: string;
    episodes: AnalyzedEpisode[];
    aspectRatio?: string;
    targetDuration?: number;
    genre?: string;
    /** 权限阶梯：某集资产是否已完成（false 表示该集暂不可生成视频） */
    episodeGate?: Record<number, boolean>;
}

type ModeTab = 'video' | 'image' | 'voice';

/** 工具箱条目 */
type ToolKey = 'edit' | 'extend' | 'voice' | 'subtitle' | 'frame' | 'download';

interface ToolMeta {
    key: ToolKey;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    disabled?: boolean;
}

const TOOLS: ToolMeta[] = [
    { key: 'edit', label: '视频编辑', icon: Film },
    { key: 'extend', label: '视频延长', icon: SquarePlus },
    { key: 'voice', label: '音色克隆', icon: SquareUser, disabled: true },
    { key: 'subtitle', label: '去字幕', icon: CaptionsOff },
    { key: 'frame', label: '抽帧', icon: Frame },
    { key: 'download', label: '下载', icon: Download },
];

// ============================================================================
// 工具
// ============================================================================

const fmtTime = (sec: number): string => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
};

const storeKey = (projectId: string) => `shot-editor:${projectId}`;

interface PanelStore {
    shots: Record<number, ShotState[]>;
    history: Record<string, string[]>;
    /** URL → 服务端元数据 ID；旧记录没有 ID 时仍可从项目历史删除。 */
    videoIds?: Record<string, string>;
    pendingVideoJobs?: VideoGenerationJob[];
}

interface VideoGenerationJob {
    id: string;
    episode: number;
    shotNumber: number;
    previousUrl?: string;
    /** 异步任务 ID（Seedance 提交后返回），刷新后据此继续轮询 */
    taskId?: string;
    startedAt: number;
    /** 提交时的提示词：任务台账展示与失败排查用 */
    prompt?: string;
}

/** 已提交、待轮询的视频任务（批量两阶段流程使用） */
interface SubmittedVideoTask {
    taskId: string;
    job: VideoGenerationJob;
    shot: ShotState;
    epNo: number;
}

const loadStore = (projectId: string): PanelStore => {
    try {
        const raw = localStorage.getItem(storeKey(projectId));
        if (raw) return JSON.parse(raw) as PanelStore;
    } catch {
        /* ignore */
    }
    return { shots: {}, history: {}, videoIds: {}, pendingVideoJobs: [] };
};

const saveStore = (projectId: string, store: PanelStore) => {
    try {
        localStorage.setItem(storeKey(projectId), JSON.stringify(store));
    } catch {
        /* ignore */
    }
};

const videoGenerationId = () => `workflow-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 把分镜拼成完整提示词 */
const composePrompt = (shot: ShotState): string => {
    if (shot.prompt) return shot.prompt;
    return [shot.description, shot.cameraAngle && `景别：${shot.cameraAngle}`, shot.mood && `氛围：${shot.mood}`]
        .filter(Boolean)
        .join('，');
};

/**
 * 根据当前片段文本，自动匹配本集已生成的资产图作为视频参考。
 * 规则：资产名（或其核心名）在片段描述/提示词中出现即命中；
 * 命中资产优先取主图，主图缺失时取第一张造型图。
 * 顺序按 角色 → 场景 → 道具，并在各类内保持资产清单原序。
 */
const matchRefsForShot = (shot: ShotItem | undefined, episodes: AnalyzedEpisode[], activeEpisode: number): string[] => {
    if (!shot) return [];
    const ep = episodes.find((e) => e.episode === activeEpisode);
    const assets = ep?.assets;
    if (!assets) return [];

    const haystack = `${shot.description || ''} ${shot.prompt || ''}`.trim();
    // 分镜结构化记录的出场角色：描述里没写人名时，靠它把角色图接上
    const castNames = new Set(
        (shot.characters || []).map((c) => String(c || '').trim()).filter(Boolean)
    );
    const location = String(shot.location || '').trim();

    /** 资产名是否出现在片段文本里 */
    const isMentioned = (rawName: string): boolean => {
        const name = (rawName || '').trim();
        if (!name || !haystack) return false;
        if (name.length === 1) {
            const idx = haystack.indexOf(name);
            if (idx === -1) return false;
            // 单字名要求独立成词或多次出现，避免「笔」被「笔记本」命中
            const prev = haystack[idx - 1] || '';
            const next = haystack[idx + 1] || '';
            const isolated = !/[\u4e00-\u9fa5]/.test(prev) && !/[\u4e00-\u9fa5]/.test(next);
            return isolated || haystack.split(name).length - 1 >= 2;
        }
        if (haystack.includes(name)) return true;
        const core = name.split(/[（(·\s]/)[0].trim();
        return core.length >= 2 && haystack.includes(core);
    };

    const urls: string[] = [];
    const seen = new Set<string>();
    const push = (url?: string) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        urls.push(url);
    };
    const urlOf = (a: { imageUrl?: string; looks?: { imageUrl?: string }[] }) =>
        a.imageUrl || (a.looks && a.looks.length > 0 ? a.looks[0].imageUrl : undefined);

    (assets.characters || []).forEach((a) => {
        const names = [a.name, ...(a.aliases || [])].map((n) => String(n || '').trim()).filter(Boolean);
        if (names.some((n) => castNames.has(n)) || isMentioned(a.name)) push(urlOf(a));
    });
    (assets.scenes || []).forEach((a) => {
        const name = String(a.name || '').trim();
        const byLocation =
            name && location && (location === name || location.includes(name) || name.includes(location));
        if (byLocation || isMentioned(name)) push(urlOf(a));
    });
    (assets.props || []).forEach((a) => {
        if (isMentioned(a.name)) push(urlOf(a));
    });
    return urls;
};

/**
 * 本地规则拆分镜：AI 拆分镜失败时兜底，保证界面始终有分镜可编辑。
 * 按目标时长反推镜头数（每个镜头默认 10 秒），再把句子尽量均分到各镜头，
 * 避免「每 3 句一个 5 秒」造成的碎片镜头过多。
 */
const localSplitShots = (ep: AnalyzedEpisode, targetSec?: number): ShotState[] => {
    const text = (ep.content || '').trim() || (ep.summary || '').trim();
    if (!text) return [];
    const sentences = text
        .split(/[。！？!?\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 2);
    if (sentences.length === 0) return [];

    // 目标镜头数：单集时长 ÷ 10 秒，限制在 4~30
    const targetCount = Math.max(4, Math.min(30, Math.ceil((targetSec || 90) / 10)));
    // 每个镜头分到的句子数（向上取整，保证覆盖全部句子且镜头不超过目标数）
    const perShot = Math.max(1, Math.ceil(sentences.length / targetCount));

    const angles = ['全景', '中景', '近景', '特写'];
    const shots: ShotState[] = [];
    for (let i = 0; i < sentences.length && shots.length < targetCount; i += perShot) {
        const chunk = sentences.slice(i, i + perShot).join('。');
        const n = shots.length + 1;
        shots.push({
            shotNumber: n,
            description: chunk,
            cameraAngle: angles[n % angles.length],
            cameraMovement: n % 2 === 0 ? '固定' : '推',
            durationSeconds: 10,
            prompt: chunk,
        });
    }
    return shots;
};

/** 触发浏览器下载 */
const downloadUrl = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.click();
};

/**
 * 抽帧：从视频均匀抽取 count 帧，拼成一张 4 列联系表 PNG（data URL）。
 */
const extractFrameSheet = (videoUrl: string, count = 8): Promise<string> =>
    new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.src = videoUrl;
        video.onerror = () => reject(new Error('视频加载失败'));

        video.onloadeddata = () => {
            const duration = video.duration || 0;
            const w = video.videoWidth;
            const h = video.videoHeight;
            const cols = 4;
            const rows = Math.max(1, Math.ceil(count / cols));
            if (!w || !h) return reject(new Error('无法读取视频画面'));

            const canvas = document.createElement('canvas');
            canvas.width = w * cols;
            canvas.height = h * rows;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject(new Error('画布不可用'));

            let i = 0;
            const next = () => {
                if (i >= count) return resolve(canvas.toDataURL('image/png'));
                video.currentTime = Math.min((duration * (i + 0.5)) / count, Math.max(0, duration - 0.05));
                video.onseeked = () => {
                    ctx.drawImage(video, (i % cols) * w, Math.floor(i / cols) * h, w, h);
                    i += 1;
                    next();
                };
            };
            next();
        };
    });

// ============================================================================
// 组件
// ============================================================================

export const ShotEditorPanel: React.FC<ShotEditorPanelProps> = ({
    projectId,
    episodes,
    aspectRatio = '9:16',
    targetDuration,
    genre,
    episodeGate = {},
}) => {
    const initial = useMemo(() => loadStore(projectId), [projectId]);

    const [shotsByEpisode, setShotsByEpisode] = useState<Record<number, ShotState[]>>(initial.shots);
    const [history, setHistory] = useState<Record<string, string[]>>(initial.history);
    const [videoIds, setVideoIds] = useState<Record<string, string>>(initial.videoIds || {});
    const [pendingVideoJobs, setPendingVideoJobs] = useState<VideoGenerationJob[]>(initial.pendingVideoJobs || []);

    /** 正在被 waitVideoTask 主动轮询的 taskId，避免恢复定时器重复查询同一任务 */
    const activeTaskIdsRef = useRef<Set<string>>(new Set());

    // 配音数据（按项目持久化）
    const [dubbing, setDubbing] = useState<DubbingStore>(() => loadDubbing(projectId));

    // 场景成片（按项目 + 集号 + 场号持久化）
    const [sceneMerges, setSceneMerges] = useState<SceneMergeStore>(() => loadSceneMerges(projectId));
    /** 正在合成的场号；'__all__' 表示全部场景 */
    const [mergingScene, setMergingScene] = useState('');

    useEffect(() => {
        setSceneMerges(loadSceneMerges(projectId));
    }, [projectId]);

    const [activeEpisode, setActiveEpisode] = useState<number>(() => episodes[0]?.episode ?? 1);
    const [activeShotNo, setActiveShotNo] = useState(1);

    /** 持久化当前集号，供工作流的「视频批量导出」判断本集 */
    useEffect(() => {
        try {
            localStorage.setItem(`shot-editor:active-episode:${projectId}`, String(activeEpisode));
        } catch {
            /* ignore */
        }
    }, [projectId, activeEpisode]);

    const [loadingShots, setLoadingShots] = useState(false);
    const [localFallback, setLocalFallback] = useState(false);
    const [error, setError] = useState('');
    const [errorExpanded, setErrorExpanded] = useState(false);

    const [mode, setMode] = useState<ModeTab>('video');
    const [detailOpen, setDetailOpen] = useState(true);
    const [toolsOpen, setToolsOpen] = useState(false);
    const [notice, setNotice] = useState('');
    const [videoEditorOpen, setVideoEditorOpen] = useState(false);
    const [refOpen, setRefOpen] = useState(false);
    const [hintOpen, setHintOpen] = useState(true);
    // 左侧「选集 + 片段」面板是否收缩
    const [collapsed, setCollapsed] = useState(false);

    // 生成参数：风格默认由项目「内容类型」映射而来（如 3D皮克斯 → 3D皮克斯动画），
    // 保证分镜生图 / 生视频与资产图的画风一致；用户仍可在下拉里手动切换。
    const [style, setStyle] = useState(() => resolveStyleByContentType(genre));
    // 形象约束同样跟随内容类型：卡通类用动漫形象，真人/拟真人用真人面孔
    const [form, setForm] = useState(() => resolveFormByContentType(genre));
    const [videoModel, setVideoModel] = useState(VIDEO_MODELS[0].id);
    const [resolution, setResolution] = useState('720p');
    const [duration, setDuration] = useState(5);
    const [aspect, setAspect] = useState(aspectRatio);
    const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].id);
    const [imageResolution, setImageResolution] = useState('2K');

    const [promptDraft, setPromptDraft] = useState('');
    const [refUrls, setRefUrls] = useState<string[]>([]);
    /** 正在生成的片段 key 集合（`集:片段`），按片段隔离，避免切换片段时状态串台 */
    const [generatingKeys, setGeneratingKeys] = useState<Set<string>>(new Set());
    /** 左侧片段描述已展开全文的片段号集合 */
    const [expandedShots, setExpandedShots] = useState<Set<number>>(new Set());
    const [batchRunning, setBatchRunning] = useState(false);
    /** 批量生成二次确认弹窗；null 表示不显示 */
    const [batchConfirm, setBatchConfirm] = useState<{ total: number; pending: number } | null>(null);
    /** 批量生成进度（已成功 / 待生成总数） */
    const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

    /** 整集合并成片：进行中 / 错误 / 结果 */
    const [merging, setMerging] = useState(false);
    const [mergeError, setMergeError] = useState('');
    const [mergedResult, setMergedResult] = useState<{ url: string; duration: number; clips: number } | null>(null);

    // 播放器
    const videoRef = useRef<HTMLVideoElement>(null);
    /** 播放器容器（含自定义控制条），全屏时整体进入全屏 */
    const playerRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [totalTime, setTotalTime] = useState(0);
    const [muted, setMuted] = useState(false);

    const episode = episodes.find((e) => e.episode === activeEpisode) || episodes[0];
    /** 权限阶梯：当前集资产是否已完成（未完成不可生成视频） */
    const gateOk = episodeGate[activeEpisode] !== false;
    const shots = shotsByEpisode[activeEpisode] || [];
    /** 按剧本场号分组：场景是片段之上的真实层级，场景合成也按这个分组走 */
    const sceneGroups = useMemo(() => groupShotsByScene(shots), [shots]);
    const activeShot = shots.find((s) => s.shotNumber === activeShotNo) || shots[0];
    const activeKey = activeShot ? `${activeEpisode}:${activeShot.shotNumber}` : '';
    const shotHistory = history[activeKey] || [];
    /** 是否有任意片段正在生成（用于防重入 / 禁用批量按钮） */
    const generating = generatingKeys.size > 0;
    /** 当前选中片段是否正在生成（中栏遮罩按片段隔离，切换片段不会串台） */
    const isActiveGenerating = activeKey ? generatingKeys.has(activeKey) : false;

    const doneCount = shots.filter((s) => !!s.videoUrl).length;
    const availableRefs = useMemo(() => {
        const list: { name: string; url: string }[] = [];
        const seen = new Set<string>();
        const push = (name: string, url?: string) => {
            if (!url || seen.has(url)) return;
            seen.add(url);
            list.push({ name, url });
        };
        const ep = episodes.find((e) => e.episode === activeEpisode);
        const assets = ep?.assets;
        if (assets) {
            (['characters', 'scenes', 'props'] as const).forEach((k) => {
                (assets[k] || []).forEach((a) => {
                    const asset = a as { name: string; imageUrl?: string; looks?: { name?: string; imageUrl?: string }[] };
                    // 主图
                    push(asset.name, asset.imageUrl);
                    // 各造型图（造型名作为后缀，便于区分）
                    (asset.looks || []).forEach((lk) => {
                        push(lk.name ? `${asset.name} · ${lk.name}` : asset.name, lk.imageUrl);
                    });
                });
            });
        }
        return list;
    }, [episodes, activeEpisode]);

    /** 本集角色名（用于配音角色下拉） */
    const dubbingRoleNames = useMemo(
        () => (episode?.assets?.characters || []).map((c) => c.name),
        [episode]
    );
    /** 角色名 → 音色（资产确认页分配的 voiceName），供配音按角色取音色 */
    const dubbingVoiceByRole = useMemo(() => {
        const map: Record<string, string> = {};
        for (const c of episode?.assets?.characters || []) {
            if (c.voiceName) map[c.name] = c.voiceName;
        }
        return map;
    }, [episode]);
    /** 角色名 → 自定义音色风格指令（资产确认页的 voicePrompt） */
    const dubbingVoicePromptByRole = useMemo(() => {
        const map: Record<string, string> = {};
        for (const c of episode?.assets?.characters || []) {
            if (c.voicePrompt) map[c.name] = c.voicePrompt;
        }
        return map;
    }, [episode]);
    /** 本集配音数据（缺失时给一个空骨架，由 DubbingPanel 受控展示，实际初始化在 effect 中落库） */
    const activeDubbing: EpisodeDubbing =
        dubbing[activeEpisode] || buildEpisodeDubbing([], dubbingRoleNames);

    const updateEpisodeDubbing = (next: EpisodeDubbing) =>
        setDubbing((prev) => ({ ...prev, [activeEpisode]: next }));

    const currentVideoModel = VIDEO_MODELS.find((m) => m.id === videoModel) || VIDEO_MODELS[0];

    // ============================================================================
    // 持久化 & 初始化
    // ============================================================================

    useEffect(() => {
        saveStore(projectId, { shots: shotsByEpisode, history, videoIds, pendingVideoJobs });
    }, [projectId, shotsByEpisode, history, videoIds, pendingVideoJobs]);

    // 配音数据持久化
    useEffect(() => {
        saveDubbing(projectId, dubbing);
    }, [projectId, dubbing]);

    // 分镜就绪后，若该集尚无配音数据则初始化（用分镜里的剧本原台词，每条台词一行）
    useEffect(() => {
        const list = shotsByEpisode[activeEpisode];
        if (!list || list.length === 0) return;
        if (dubbing[activeEpisode]) return;
        const characters = episode?.assets?.characters || [];
        const roleNames = characters.map((c) => c.name);
        // 别名 → 标准名，台词的说话人写成「石头」也能套到「赵磊」的音色
        const aliasMap = Object.fromEntries(
            characters
                .filter((c) => (c.aliases || []).length > 0)
                .map((c) => [c.name, c.aliases as string[]])
        );
        setDubbing((prev) =>
            prev[activeEpisode]
                ? prev
                : { ...prev, [activeEpisode]: buildEpisodeDubbing(list, roleNames, aliasMap) }
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeEpisode, shotsByEpisode, dubbing, episode]);

    useEffect(() => {
        setActiveEpisode((cur) => (episodes.some((e) => e.episode === cur) ? cur : episodes[0]?.episode ?? 1));
    }, [episodes]);

    // 切换集：资产已完成且无缓存时，请求 AI 拆分镜
    useEffect(() => {
        const ep = episodes.find((e) => e.episode === activeEpisode);
        if (!ep) return;
        if (episodeGate[activeEpisode] === false) return; // 未完成资产的集不加载分镜
        if (shotsByEpisode[activeEpisode]?.length) return;
        void loadShots(ep);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeEpisode, episodes, episodeGate]);

    // 切换集时清理参考图 / 默认选中首个片段
    useEffect(() => {
        setActiveShotNo(1);
        setRefUrls([]);
        setLocalFallback(false);
        setError('');
    }, [activeEpisode]);

    // 片段切换 → 同步提示词
    useEffect(() => {
        if (!activeShot) {
            setPromptDraft('');
            return;
        }
        setPromptDraft(activeShot.prompt || composePrompt(activeShot));
        setDetailOpen(true);
        setToolsOpen(false);
        setNotice('');
        // 自动带入参考图：按当前片段文本匹配本集已生成的角色 / 场景 / 道具图
        setRefUrls(matchRefsForShot(activeShot, episodes, activeEpisode));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey]);

    // 视频模型变化时校正分辨率 / 时长
    useEffect(() => {
        const m = VIDEO_MODELS.find((v) => v.id === videoModel) || VIDEO_MODELS[0];
        if (!m.resolutions.includes(resolution)) setResolution(m.resolutions[0]);
        if (!m.durations.includes(duration)) setDuration(m.durations[0]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoModel]);

    // 点击空白收起参考选择器 / 工具箱菜单
    useEffect(() => {
        const onDocDown = () => {
            setRefOpen(false);
            setToolsOpen(false);
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
    }, []);

    // ============================================================================
    // 分镜加载
    // ============================================================================

    const loadShots = async (ep: AnalyzedEpisode) => {
        setLoadingShots(true);
        setError('');
        setLocalFallback(false);
        try {
            const characters = (ep.assets?.characters || []).map((c) => c.name);
            const { shots: result } = await splitShots({
                episode: { episode: ep.episode, title: ep.title, summary: ep.summary, content: ep.content },
                characters,
                style,
                aspectRatio: aspect,
                targetDuration,
            });
            if (!result || result.length === 0) throw new Error('AI 未返回分镜');
            setShotsByEpisode((prev) => ({ ...prev, [ep.episode]: result.map((s) => ({ ...s })) }));
        } catch (e: any) {
            setError(e?.message || '拆分镜失败');
            const fallback = localSplitShots(ep, targetDuration);
            if (fallback.length > 0) {
                setShotsByEpisode((prev) => ({ ...prev, [ep.episode]: fallback }));
                setLocalFallback(true);
                setError('');
            }
        } finally {
            setLoadingShots(false);
        }
    };

    // ============================================================================
    // 片段变更
    // ============================================================================

    const patchShot = (shotNo: number, patch: Partial<ShotState>, episodeNo = activeEpisode) =>
        setShotsByEpisode((prev) => ({
            ...prev,
            [episodeNo]: (prev[episodeNo] || []).map((s) => (s.shotNumber === shotNo ? { ...s, ...patch } : s)),
        }));

    // ============================================================================
    // 生成
    // ============================================================================

    const pushHistory = (key: string, url: string, metadataId?: string) => {
        if (metadataId) setVideoIds((prev) => ({ ...prev, [url]: metadataId }));
        setHistory((prev) => ({
            ...prev,
            [key]: [url, ...(prev[key] || []).filter((item) => item !== url)].slice(0, 20),
        }));
    };

    /** 从服务端落盘结果恢复在刷新/离页时仍在执行的视频任务。 */
    useEffect(() => {
        if (pendingVideoJobs.length === 0) return;
        let disposed = false;
        setGeneratingKeys((current) => {
            const next = new Set(current);
            pendingVideoJobs.forEach((job) => next.add(`${job.episode}:${job.shotNumber}`));
            return next;
        });
        const recover = async () => {
            const settled: VideoGenerationJob[] = [];
            for (const job of pendingVideoJobs) {
                const key = `${job.episode}:${job.shotNumber}`;
                // 已有主动轮询者在跟进这个任务，恢复定时器跳过，避免重复查询/误判 404
                if (job.taskId && activeTaskIdsRef.current.has(job.taskId)) continue;
                try {
                    let resultUrl: string | undefined;
                    if (job.taskId) {
                        // 异步任务：查厂商状态；后端在成功时会自动下载并落盘
                        const status = await getVideoTaskStatus(job.taskId);
                        if (status.status === 'succeeded') resultUrl = status.resultUrl;
                        else if (status.status === 'failed') {
                            finishJob(
                                projectId,
                                {
                                    id: job.id,
                                    kind: 'shot-video',
                                    episode: job.episode,
                                    startedAt: job.startedAt,
                                    payload: {
                                        episode: job.episode,
                                        shotNumber: job.shotNumber,
                                        prompt: job.prompt,
                                        taskId: job.taskId,
                                    },
                                },
                                'failed',
                                { error: status.error || '未知错误' },
                            );
                            settled.push(job);
                            continue;
                        }
                    } else {
                        // 旧的同步任务：查本地落盘结果
                        const status = await getGenerationStatus(job.id);
                        if (status.status === 'success') resultUrl = status.resultUrl;
                    }
                    if (disposed || !resultUrl) continue;
                    if (job.previousUrl && job.previousUrl !== resultUrl) pushHistory(key, job.previousUrl);
                    patchShot(job.shotNumber, { videoUrl: resultUrl }, job.episode);
                    pushHistory(key, resultUrl, job.id);
                    finishJob(
                        projectId,
                        {
                            id: job.id,
                            kind: 'shot-video',
                            episode: job.episode,
                            startedAt: job.startedAt,
                            payload: {
                                episode: job.episode,
                                shotNumber: job.shotNumber,
                                prompt: job.prompt,
                                taskId: job.taskId,
                            },
                        },
                        'succeeded',
                        { resultUrl },
                    );
                    settled.push(job);
                    setGeneratingKeys((current) => {
                        const next = new Set(current);
                        next.delete(key);
                        return next;
                    });
                } catch {
                    // 异步任务已过期 / 服务重启丢失（404）：移除任务，避免无限轮询
                    if (job.taskId) {
                        finishJob(
                            projectId,
                            {
                                id: job.id,
                                kind: 'shot-video',
                                episode: job.episode,
                                startedAt: job.startedAt,
                                payload: {
                                    episode: job.episode,
                                    shotNumber: job.shotNumber,
                                    prompt: job.prompt,
                                    taskId: job.taskId,
                                },
                            },
                            'failed',
                            { error: '任务已过期或生成服务重启，结果丢失' },
                        );
                        settled.push(job);
                        setGeneratingKeys((current) => {
                            const next = new Set(current);
                            next.delete(key);
                            return next;
                        });
                    }
                }
            }
            if (!disposed && settled.length) {
                const ids = new Set(settled.map((job) => job.id));
                setPendingVideoJobs((jobs) => jobs.filter((job) => !ids.has(job.id)));
            }
        };
        void recover();
        const timer = window.setInterval(() => void recover(), 3000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [pendingVideoJobs]); // 函数仅通过 React setter 更新状态

    /**
     * 上报分镜视频任务到后端台账（「生成任务」页的数据源）。
     * 提交时写 running，结束时写终态；失败原因必须一起留下，
     * 否则任务失败后记录被清掉，任务页只会看到「任务凭空消失」。
     */
    const reportShotJob = (
        job: VideoGenerationJob,
        status: 'running' | 'succeeded' | 'failed',
        extra: Record<string, unknown> = {},
    ) => {
        const base = {
            id: job.id,
            kind: 'shot-video',
            episode: job.episode,
            startedAt: job.startedAt,
            payload: {
                episode: job.episode,
                shotNumber: job.shotNumber,
                prompt: (job.prompt || '').slice(0, 400),
                taskId: job.taskId,
                videoModel,
                aspectRatio: aspect,
                resolution,
                duration,
                ...extra,
            },
        };
        if (status === 'running') {
            persistJob(projectId, { ...base, status });
        } else {
            finishJob(projectId, base, status);
        }
    };

    const generateVideoForShot = async (
        shot: ShotState,
        epNo = activeEpisode,
        refs: string[] = []
    ): Promise<string | null> => {
        // 生视频提示词：分镜描述 + 形象 + 画面风格（含运镜/氛围），由本地风格库自动拼装
        const prompt = composeModelVideoPrompt(shot, style, form, describeRefsFromUrls(refs, episode));
        const genKey = `${epNo}:${shot.shotNumber}`;
        const job: VideoGenerationJob = {
            id: videoGenerationId(),
            episode: epNo,
            shotNumber: shot.shotNumber,
            previousUrl: shot.videoUrl,
            startedAt: Date.now(),
            prompt,
        };
        // 按片段标记生成状态：只有该片段自己的预览显示「生成中」，切到其他片段不受影响
        setGeneratingKeys((prev) => new Set(prev).add(genKey));
        // 在发请求前立即落盘，避免用户刚点击生成就刷新时丢掉恢复凭据。
        const stored = loadStore(projectId);
        saveStore(projectId, { ...stored, pendingVideoJobs: [...(stored.pendingVideoJobs || []), job] });
        setPendingVideoJobs((jobs) => [...jobs, job]);
        reportShotJob(job, 'running');
        try {
            // Seedance 的「首帧 first_frame」与「参考图 reference_image」语义不同且互斥：
            //   - first_frame：这张图直接成为视频第一帧，画面会从它原样开始；
            //   - reference_image：仅作形象/场景参考，由模型按提示词重新构图。
            // 参考区一旦有图（角色/场景/道具资产图或用户手选图），一律走多模态参考，
            // 避免把参考图原样贴成视频开头；只有参考区为空时，才用分镜首帧图起画。
            const hasRefs = refs.length > 0;
            const firstFrame = hasRefs ? undefined : (shot.imageUrl || undefined);
            const multiRefs = hasRefs ? Array.from(new Set(refs.filter(Boolean))) : [];
            // 使用该分镜自身时长（拆分镜时已按场景规划，优先 10s 长镜头）；
            // 兜底再用全局 duration
            const shotDuration = shot.durationSeconds || duration;
            const url = await generateVideo({
                prompt,
                aspectRatio: aspect,
                resolution,
                duration: shotDuration,
                videoModel,
                generateAudio: true,
                nodeId: job.id,
                imageBase64: firstFrame,
                referenceImages: multiRefs,
                channel: 'workflow',
            });
            // 重生成前的当前视频先进入历史，随后才切换到新版本，确保旧版本可恢复。
            if (shot.videoUrl && shot.videoUrl !== url) pushHistory(genKey, shot.videoUrl);
            patchShot(shot.shotNumber, { videoUrl: url }, epNo);
            pushHistory(`${epNo}:${shot.shotNumber}`, url, job.id);
            reportShotJob(job, 'succeeded', { resultUrl: url });
            return url;
        } catch (e: any) {
            setError(`片段${shot.shotNumber} 生成失败：${e?.message || '未知错误'}`);
            reportShotJob(job, 'failed', { error: e?.message || '未知错误' });
            return null;
        } finally {
            setPendingVideoJobs((jobs) => jobs.filter((item) => item.id !== job.id));
            setGeneratingKeys((prev) => {
                const next = new Set(prev);
                next.delete(genKey);
                return next;
            });
        }
    };

    /**
     * 批量模式：只提交视频任务，立即返回 taskId（不等待生成）。
     * 与 generateVideoForShot 共用提示词与图片模式逻辑，区别只是不做同步等待。
     */
    const submitVideoForShot = async (
        shot: ShotState,
        epNo: number,
        refs: string[] = []
    ): Promise<SubmittedVideoTask | null> => {
        const prompt = composeModelVideoPrompt(shot, style, form, describeRefsFromUrls(refs, episode));
        const genKey = `${epNo}:${shot.shotNumber}`;
        const job: VideoGenerationJob = {
            id: videoGenerationId(),
            episode: epNo,
            shotNumber: shot.shotNumber,
            previousUrl: shot.videoUrl,
            startedAt: Date.now(),
            prompt,
        };
        setGeneratingKeys((prev) => new Set(prev).add(genKey));
        // 先落盘 pending job，刷新后即使还没拿到 taskId 也能恢复
        setPendingVideoJobs((jobs) => [...jobs, job]);
        reportShotJob(job, 'running');

        try {
            const hasRefs = refs.length > 0;
            const firstFrame = hasRefs ? undefined : (shot.imageUrl || undefined);
            const multiRefs = hasRefs ? Array.from(new Set(refs.filter(Boolean))) : [];
            const { taskId } = await submitVideoTask({
                prompt,
                aspectRatio: aspect,
                resolution,
                duration: shot.durationSeconds || duration,
                videoModel,
                generateAudio: true,
                nodeId: job.id,
                imageBase64: firstFrame,
                referenceImages: multiRefs,
                channel: 'workflow',
            });
            const submittedJob = { ...job, taskId };
            // 标记为「主动轮询中」，恢复定时器据此跳过，避免同一任务被查两次
            activeTaskIdsRef.current.add(taskId);
            setPendingVideoJobs((jobs) => jobs.map((j) => (j.id === job.id ? submittedJob : j)));
            // 补上服务端任务 id：任务页能据此查到真实失败原因
            reportShotJob(submittedJob, 'running');
            return { taskId, job: submittedJob, shot, epNo };
        } catch (e: any) {
            setError(`片段${shot.shotNumber} 提交失败：${e?.message || '未知错误'}`);
            reportShotJob(job, 'failed', { error: e?.message || '提交视频任务失败' });
            setPendingVideoJobs((jobs) => jobs.filter((j) => j.id !== job.id));
            setGeneratingKeys((prev) => {
                const next = new Set(prev);
                next.delete(genKey);
                return next;
            });
            return null;
        }
    };

    /**
     * 轮询已提交任务直到完成：成功后写入分镜与历史，失败/超时返回 null。
     */
    const waitVideoTask = async (task: SubmittedVideoTask): Promise<string | null> => {
        const genKey = `${task.epNo}:${task.shot.shotNumber}`;
        const start = Date.now();
        const maxWait = 11 * 60 * 1000;
        const interval = 3000; // 3 秒查一次，比后端 10 秒轮询更快拿到结果

        try {
            while (Date.now() - start < maxWait) {
                const status = await getVideoTaskStatus(task.taskId);
                if (status.status === 'succeeded' && status.resultUrl) {
                    const url = status.resultUrl;
                    if (task.shot.videoUrl && task.shot.videoUrl !== url) pushHistory(genKey, task.shot.videoUrl);
                    patchShot(task.shot.shotNumber, { videoUrl: url }, task.epNo);
                    pushHistory(genKey, url, task.job.id);
                    reportShotJob(task.job, 'succeeded', { resultUrl: url });
                    return url;
                }
                if (status.status === 'failed') {
                    setError(`片段${task.shot.shotNumber} 生成失败：${status.error || '未知错误'}`);
                    reportShotJob(task.job, 'failed', { error: status.error || '未知错误' });
                    return null;
                }
                await new Promise((resolve) => setTimeout(resolve, interval));
            }
            setError(`片段${task.shot.shotNumber} 生成超时（超过 11 分钟）`);
            reportShotJob(task.job, 'failed', { error: '生成超时（超过 11 分钟）' });
            return null;
        } catch (e: any) {
            setError(`片段${task.shot.shotNumber} 查询状态失败：${e?.message || '未知错误'}`);
            reportShotJob(task.job, 'failed', { error: e?.message || '查询任务状态失败' });
            return null;
        } finally {
            activeTaskIdsRef.current.delete(task.taskId);
            setPendingVideoJobs((jobs) => jobs.filter((j) => j.id !== task.job.id));
            setGeneratingKeys((prev) => {
                const next = new Set(prev);
                next.delete(genKey);
                return next;
            });
        }
    };

    const handleGenerateVideo = async () => {
        if (!activeShot || generating || batchRunning) return;
        setError('');
        // 生成状态由 generateVideoForShot 内部按片段标记，避免全局串台
        await generateVideoForShot({ ...activeShot, prompt: promptDraft }, activeEpisode, refUrls);
    };

    const handleGenerateImage = async () => {
        if (!activeShot || generating) return;
        const genKey = `${activeEpisode}:${activeShot.shotNumber}`;
        setGeneratingKeys((prev) => new Set(prev).add(genKey));
        setError('');
        try {
            const url = await generateImage({
                prompt: buildImagePrompt(promptDraft, style, form),
                aspectRatio: aspect,
                resolution: imageResolution,
                imageBase64: refUrls, // 多参考图：资产生成的角色/场景/道具图
                imageModel,
                channel: 'workflow',
            });
            patchShot(activeShot.shotNumber, { imageUrl: url });
        } catch (e: any) {
            setError(`图片生成失败：${e?.message || '未知错误'}`);
        } finally {
            setGeneratingKeys((prev) => {
                const next = new Set(prev);
                next.delete(genKey);
                return next;
            });
        }
    };

    /**
     * 批量生成入口：只统计「当前集」尚未生成的片段，先弹二次确认，
     * 用户确认后才真正开始生成（避免误触直接调用模型）。
     */
    /** 合成某个场景：场景内片段按顺序拼成一条场景视频 */
    const handleMergeScene = async (group: SceneGroup) => {
        if (mergingScene) return;
        setMergingScene(group.sceneNumber);
        setError('');
        try {
            const { store } = await mergeScene({ projectId, episode: activeEpisode, group });
            setSceneMerges({ ...store });
            setNotice(`场景 ${group.sceneNumber} 已合成`);
        } catch (e: any) {
            setError(e?.message || '场景合成失败');
        } finally {
            setMergingScene('');
        }
    };

    /** 一次合成当前集所有已就绪的场景 */
    const handleMergeAllScenes = async () => {
        if (mergingScene) return;
        setMergingScene('__all__');
        setError('');
        try {
            const { store, done, failed } = await mergeAllScenes({
                projectId,
                episode: activeEpisode,
                groups: sceneGroups,
                onProgress: (d, t, label) => setNotice(`正在合成 ${d}/${t}：${label}`),
            });
            setSceneMerges({ ...store });
            setNotice(
                failed.length
                    ? `已合成 ${done} 个场景，${failed.length} 个失败`
                    : `已合成 ${done} 个场景，可到「成片合并」拼整集`
            );
            if (failed.length) setError(failed.map((f) => `${f.scene}：${f.error}`).join('；'));
        } catch (e: any) {
            setError(e?.message || '场景合成失败');
        } finally {
            setMergingScene('');
        }
    };

    const handleBatchGenerate = () => {
        if (batchRunning || generating) return;
        // shots 已按 activeEpisode 过滤，这里天然只处理当集
        const pending = shots.filter((s) => !s.videoUrl);
        if (pending.length === 0) {
            setNotice(`第 ${activeEpisode} 集片段均已生成，无需批量生成`);
            return;
        }
        setNotice('');
        setBatchConfirm({ total: shots.length, pending: pending.length });
    };

    /**
     * 确认后执行批量生成：先并发提交全部任务（拿到 taskId），再并发轮询。
     * 这样厂商侧能在同一时间并行生成，而不是「一个跑完才提交下一个」。
     */
    const runBatchGenerate = async () => {
        const pending = shots.filter((s) => !s.videoUrl);
        if (pending.length === 0 || batchRunning) return;
        setBatchRunning(true);
        setBatchProgress({ done: 0, total: pending.length });
        setError('');
        let done = 0;

        // 阶段 1：并发提交（Seedance 异步接口），只创建任务，不等待生成
        const submitted = await runWithConcurrency(
            pending,
            (s) => {
                const refs = matchRefsForShot(s, episodes, activeEpisode);
                return submitVideoForShot(s, activeEpisode, refs);
            },
            VIDEO_SUBMIT_CONCURRENCY
        );

        const tasks: SubmittedVideoTask[] = [];
        for (const result of submitted) {
            if (result.status === 'fulfilled' && result.value) tasks.push(result.value);
        }

        // 阶段 2：并发轮询全部已提交任务
        await runWithConcurrency(
            tasks,
            async (task) => {
                const url = await waitVideoTask(task);
                if (url) done += 1;
                setBatchProgress({ done, total: pending.length });
                return url;
            },
            VIDEO_POLL_CONCURRENCY
        );

        setBatchProgress(null);
        setBatchRunning(false);
        setNotice(
            done === pending.length
                ? `第 ${activeEpisode} 集批量生成完成：共 ${done} 个片段`
                : `批量生成结束：成功 ${done}/${pending.length} 个片段，失败信息见上方`
        );
    };

    // ============================================================================
    // 整集合并成片
    // ============================================================================

    /**
     * 把当前集已生成的全部片段按镜头顺序拼成一个成片。
     *
     * 走 /api/video-merge/merge（与画布 VIDEO_MERGE 节点同一套后端能力），
     * 转场取分镜自带的 transitionOut，缺省回落 fade。
     */
    const handleMergeEpisode = async () => {
        if (merging || batchRunning) return;

        // 合并顺序由数据决定：场景先后 → 场景内片段号，不依赖当前数组顺序
        const ordered = orderShotsForMerge(shots);
        const withVideo = ordered.filter((s) => !!s.videoUrl);
        if (withVideo.length === 0) {
            setNotice(`第 ${activeEpisode} 集还没有已生成的片段，请先生成视频`);
            return;
        }

        /**
         * 场景优先：已合成且未过期的场景用「一条场景视频」参与整集拼接，
         * 没合成或已过期的场景回落它内部的片段。
         * 这样整集结构就是「场景 → 场景 → …」，改一个场景不用重拼所有片段。
         */
        const plan = collectEpisodeVideos(sceneMerges, activeEpisode, sceneGroups);
        const videos = plan.sceneCount > 0 ? plan.videos : withVideo.map((s) => s.videoUrl as string);
        const useScenes = plan.sceneCount > 0;

        if (!useScenes && withVideo.length < shots.length) {
            const missing = shots.length - withVideo.length;
            setNotice(`第 ${activeEpisode} 集还有 ${missing} 个片段未生成，仅用已生成的 ${withVideo.length} 个片段合成`);
        } else {
            setNotice('');
        }

        if (videos.length === 1) {
            setMergedResult({ url: videos[0], duration: 0, clips: 1 });
            setNotice('本集只有 1 条视频，无需合并');
            return;
        }

        setMerging(true);
        setMergeError('');
        try {
            const { mergeVideos } = await import('../services/mergeService');
            const result = await mergeVideos({
                videos,
                transition: 'fade',
                transitionDuration: 0.5,
                // 按片段合成时用分镜自带的转场；按场景合成时场景之间统一淡入淡出
                transitions: useScenes
                    ? videos.slice(1).map(() => 'fade')
                    : withVideo.slice(1).map((s) => s.transitionOut || 'fade'),
                transitionDurations: videos.slice(1).map(() => 0.5),
                audioMode: 'keep',
                episode: activeEpisode,
                prompt: useScenes
                    ? `第 ${activeEpisode} 集整集合成（${plan.sceneCount} 个场景成片）`
                    : `第 ${activeEpisode} 集整集合成（${withVideo.length} 个片段）`,
            });

            setMergedResult({ url: result.url, duration: result.duration, clips: videos.length });
            setNotice(
                useScenes
                    ? `第 ${activeEpisode} 集合成完成：${plan.sceneCount} 个场景成片${
                          plan.fallbackShotCount > 0
                              ? ` + ${plan.fallbackShotCount} 个未合成场景的片段`
                              : ''
                      }，时长 ${fmtTime(result.duration)}`
                    : `第 ${activeEpisode} 集合成完成：${withVideo.length} 个片段，时长 ${fmtTime(result.duration)}`
            );
        } catch (err) {
            setMergeError(err instanceof Error ? err.message : '合并失败');
        } finally {
            setMerging(false);
        }
    };

    // ============================================================================
    // 播放器
    // ============================================================================

    const togglePlay = () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play();
        else v.pause();
    };

    /** 放大播放：整个播放器容器（含自定义控制条）进入 / 退出全屏 */
    const toggleFullscreen = () => {
        const el = playerRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen?.();
        else void el.requestFullscreen?.();
    };

    const restoreVersion = (url: string) => {
        if (!activeShot) return;
        patchShot(activeShot.shotNumber, { videoUrl: url });
    };

    /** 删除历史版本；若是当前播放版本，则自动回退到其余最新版本。 */
    const deleteHistoryVersion = async (url: string) => {
        if (!activeShot) return;
        const metadataId = videoIds[url];
        try {
            if (metadataId) {
                const response = await fetch(`/api/assets/videos/${encodeURIComponent(metadataId)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('删除服务端视频失败');
            }
            const remaining = (history[activeKey] || []).filter((item) => item !== url);
            setHistory((prev) => ({ ...prev, [activeKey]: remaining }));
            setVideoIds((prev) => {
                const next = { ...prev };
                delete next[url];
                return next;
            });
            if (activeShot.videoUrl === url) {
                patchShot(activeShot.shotNumber, { videoUrl: remaining[0] }, activeEpisode);
            }
            setNotice(metadataId ? '历史视频已删除' : '历史记录已删除（旧版本文件未保留可删除标识）');
        } catch (e: any) {
            setError(e?.message || '删除历史视频失败');
        }
    };

    // ============================================================================
    // 工具箱
    // ============================================================================

    /** 视频编辑：裁剪后把结果回写到当前片段 */
    const handleTrimExport = async (trimStart: number, trimEnd: number, url: string) => {
        try {
            const resp = await fetch('/api/trim-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoUrl: url, startTime: trimStart, endTime: trimEnd }),
            });
            if (!resp.ok) throw new Error('裁剪失败');
            const data = await resp.json();
            if (!data.url) throw new Error('裁剪结果为空');
            if (activeShot) {
                patchShot(activeShot.shotNumber, { videoUrl: data.url });
                pushHistory(activeKey, data.url);
            }
        } catch (e: any) {
            setError(`视频编辑失败：${e?.message || '未知错误'}`);
        } finally {
            setVideoEditorOpen(false);
        }
    };

    const handleTool = async (key: ToolKey) => {
        setToolsOpen(false);
        setNotice('');
        setError('');
        if (key === 'voice') return;

        const url = activeShot?.videoUrl;
        const needVideo = () => {
            setNotice('请先生成该片段视频');
            return;
        };

        if (key === 'edit') {
            if (!url) return needVideo();
            setVideoEditorOpen(true);
            return;
        }

        if (key === 'download') {
            if (!url) return needVideo();
            downloadUrl(url, `片段${activeShot?.shotNumber}.mp4`);
            return;
        }

        if (key === 'frame') {
            if (!url) return needVideo();
            try {
                setNotice('正在抽帧…');
                const sheet = await extractFrameSheet(url, 8);
                downloadUrl(sheet, `片段${activeShot?.shotNumber}-抽帧.png`);
                setNotice('');
            } catch (e: any) {
                setNotice('');
                setError(`抽帧失败：${e?.message || '未知错误'}`);
            }
            return;
        }

        if (key === 'extend') return setNotice('「视频延长」功能开发中');
        if (key === 'subtitle') return setNotice('「去字幕」功能开发中');
    };

    // ============================================================================
    // 渲染
    // ============================================================================

    if (episodes.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center text-neutral-600 text-[13px]">
                暂无分集，请先完成剧本分集。
            </div>
        );
    }

    // 全屏状态跟踪：ESC / 浏览器退出全屏时同步 UI（恢复圆角与外层比例）
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => document.removeEventListener('fullscreenchange', onFsChange);
    }, []);

    const previewStyle = { aspectRatio: aspect.replace(':', ' / ') };

    return (
        <div className="flex-1 flex min-h-0 min-w-0">
            {/* ===================== 集数 rail（可收缩，仅此处跟收缩） ===================== */}
            <div
                className={`shrink-0 border-r border-white/[0.06] bg-[#0c0c11]/70 flex flex-col items-center py-3 gap-1 transition-[width] duration-200 ${
                    collapsed ? 'w-[40px]' : 'w-[60px]'
                }`}
            >
                <button
                    onClick={() => setCollapsed((v) => !v)}
                    title={collapsed ? '展开选集' : '收缩选集'}
                    className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.07] transition-colors"
                >
                    <Menu size={15} />
                </button>

                {!collapsed && (
                    <>
                        <div className="w-6 h-px bg-white/[0.08] my-1" />
                        <div className="text-[11px] text-neutral-600 mb-0.5">选集</div>
                        <div className="flex-1 w-full min-h-0 overflow-y-auto flex flex-col items-center gap-1.5 pb-2">
                            {episodes.map((ep) => {
                                const act = ep.episode === activeEpisode;
                                const done = episodeGate[ep.episode] !== false;
                                return (
                                    <button
                                        key={ep.episode}
                                        onClick={() => setActiveEpisode(ep.episode)}
                                        title={done ? ep.title : `${ep.title}（资产未完成，暂不可生成）`}
                                        className={`relative w-9 h-9 shrink-0 rounded-lg text-[13px] font-medium flex items-center justify-center transition-all ${
                                            act
                                                ? 'bg-white/[0.1] text-white ring-1 ring-white/50'
                                                : done
                                                    ? 'text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.06]'
                                                    : 'text-neutral-700 hover:text-neutral-500 hover:bg-white/[0.04]'
                                        }`}
                                    >
                                        {ep.episode}
                                        {!done && (
                                            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#0c0c11] border border-neutral-600 text-neutral-400 flex items-center justify-center">
                                                <Lock size={7} />
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>

            {/* ===================== 左栏：片段列表（固定，不随收缩） ===================== */}
            <aside className="w-[270px] shrink-0 border-r border-white/[0.06] bg-[#0c0c11]/70 flex flex-col min-h-0">
                <div className="px-3 py-2.5 flex items-center gap-2 border-b border-white/[0.06] shrink-0">
                    <span className="text-[12px] text-neutral-200 truncate">第{activeEpisode}集</span>
                    <span className="ml-auto text-[11px] text-neutral-500 shrink-0 whitespace-nowrap">
                        已生成 <span className="text-cyan-300">{doneCount}</span>/{shots.length}
                    </span>
                </div>

                        {/* 片段列表 */}
                        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
                            {loadingShots && (
                                <div className="py-10 flex flex-col items-center gap-2 text-neutral-500 text-[12px]">
                                    <Loader2 size={16} className="animate-spin" />
                                    AI 正在拆分镜…
                                </div>
                            )}

                            {!gateOk && (
                                <div className="py-10 px-3 text-center text-[12px] text-amber-400/80 leading-5">
                                    第 {activeEpisode} 集资产尚未全部生成，暂不能生成视频。
                                    <br />请先到「资产确认」完成该集资产生成。
                                </div>
                            )}

                            {gateOk && !loadingShots && shots.length === 0 && (
                                <div className="py-10 text-center text-[12px] text-neutral-600">
                                    {error || '该集暂无分镜'}
                                </div>
                            )}

                            {shots.map((shot, shotIndex) => {
                                const active = shot.shotNumber === activeShotNo;
                                const thumb = shot.imageUrl;
                                const shotGenKey = `${activeEpisode}:${shot.shotNumber}`;
                                const shotGenerating = generatingKeys.has(shotGenKey);
                                const expanded = expandedShots.has(shot.shotNumber);
                                // 场景头：本片段是该场第一个片段时，先渲染场景标题与「合成场景」按钮
                                const prevShot = shotIndex > 0 ? shots[shotIndex - 1] : undefined;
                                const sceneKey = String(shot.sceneNumber || '').trim() || '未分场';
                                const isSceneStart =
                                    !prevShot ||
                                    (String(prevShot.sceneNumber || '').trim() || '未分场') !== sceneKey;
                                const sceneGroup = isSceneStart ? sceneGroups.find((g) => g.key === sceneKey) : undefined;
                                const sceneMerged = sceneGroup
                                    ? !!getSceneMerge(sceneMerges, activeEpisode, sceneGroup)
                                    : false;
                                return (
                                    <React.Fragment key={shot.shotNumber}>
                                    {isSceneStart && sceneGroup && (
                                        <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-0.5">
                                            <span
                                                className="text-[11px] text-cyan-300/80 truncate"
                                                title={sceneLabel(sceneGroup)}
                                            >
                                                {sceneLabel(sceneGroup)}
                                                <span className="text-neutral-600"> · {sceneGroup.shots.length} 片段</span>
                                            </span>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void handleMergeScene(sceneGroup);
                                                }}
                                                disabled={!sceneGroup.ready || !!mergingScene}
                                                title={
                                                    sceneGroup.ready
                                                        ? '把本场景的片段合成一条场景视频'
                                                        : '本场景还有片段未生成视频'
                                                }
                                                className="shrink-0 h-6 px-2 rounded-md text-[10px] border border-white/[0.12] text-neutral-300 hover:border-cyan-400/50 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                                            >
                                                {mergingScene === sceneGroup.sceneNumber ? (
                                                    <Loader2 size={10} className="animate-spin" />
                                                ) : (
                                                    <Film size={10} />
                                                )}
                                                {sceneMerged ? '重新合成' : '合成场景'}
                                            </button>
                                        </div>
                                    )}
                                    <button
                                        key={shot.shotNumber}
                                        onClick={() => setActiveShotNo(shot.shotNumber)}
                                        className={`w-full text-left flex gap-2 rounded-lg border p-2 transition-colors ${
                                            active
                                                ? 'border-cyan-400/60 bg-cyan-400/[0.06]'
                                                : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14]'
                                        }`}
                                    >
                                        <div className="relative w-[52px] shrink-0 aspect-[3/4] rounded-md bg-[#131318] overflow-hidden">
                                            {thumb ? (
                                                <img src={thumb} alt="" className="w-full h-full object-cover" />
                                            ) : shot.videoUrl ? (
                                                <video src={shot.videoUrl} className="w-full h-full object-cover" muted />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-neutral-700">
                                                    <Film size={14} />
                                                </div>
                                            )}
                                            {shot.videoUrl && !shotGenerating && (
                                                <span className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-sm bg-cyan-400 text-[#04231f] flex items-center justify-center">
                                                    <Play size={8} />
                                                </span>
                                            )}
                                            {/* 该片段正在生成：仅覆盖自身缩略图，不影响其他片段 */}
                                            {shotGenerating && (
                                                <span className="absolute inset-0 bg-black/65 flex items-center justify-center">
                                                    <Loader2 size={14} className="animate-spin text-cyan-300" />
                                                </span>
                                            )}
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center justify-between">
                                                <span className={`text-[11px] ${active ? 'text-cyan-300' : 'text-neutral-500'}`}>
                                                    片段{shot.shotNumber}
                                                    {shot.sceneNumber ? ` · ${shot.sceneNumber}` : ''}
                                                </span>
                                                <Pencil size={11} className="text-neutral-600" />
                                            </div>
                                            {/* 描述：默认截断 4 行，点击可展开 / 收起全文（阻止冒泡，不误触切换片段） */}
                                            <p
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setExpandedShots((prev) => {
                                                        const next = new Set(prev);
                                                        if (next.has(shot.shotNumber)) next.delete(shot.shotNumber);
                                                        else next.add(shot.shotNumber);
                                                        return next;
                                                    });
                                                }}
                                                title={expanded ? '点击收起' : '点击查看全文'}
                                                className={`mt-0.5 text-[11px] leading-[15px] text-neutral-400 cursor-pointer hover:text-neutral-200 ${
                                                    expanded ? '' : 'line-clamp-4'
                                                }`}
                                            >
                                                {shot.description}
                                            </p>
                                            {/* 片段编号：与画布节点标题一致，便于核对生成出的视频 */}
                                            <div className="mt-0.5 text-[10px] font-mono text-neutral-600 truncate">
                                                {makeShotCode(activeEpisode, shot.sceneNumber, shot.shotNumber)}
                                            </div>
                                            {/* 台词：直观显示这一镜谁在说什么，没有台词的镜头一眼可辨 */}
                                            {(shot.dialogues || []).length > 0 && (
                                                <div className="mt-1 space-y-0.5 border-l border-cyan-400/30 pl-1.5">
                                                    {(shot.dialogues || []).slice(0, 3).map((d, di) => (
                                                        <p
                                                            key={di}
                                                            className="text-[10px] leading-[14px] text-neutral-500 truncate"
                                                            title={`${d.role}${d.tone ? `（${d.tone}）` : ''}：${d.text}`}
                                                        >
                                                            <span className={d.isVoiceOver ? 'text-neutral-400' : 'text-cyan-300/90'}>
                                                                {d.role}
                                                            </span>
                                                            <span className="text-neutral-600">：</span>
                                                            {d.text}
                                                        </p>
                                                    ))}
                                                    {(shot.dialogues || []).length > 3 && (
                                                        <p className="text-[10px] text-neutral-600">
                                                            …共 {(shot.dialogues || []).length} 句
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </button>
                                    </React.Fragment>
                                );
                            })}
                        </div>

                        <div className="p-2.5 border-t border-white/[0.06] shrink-0 space-y-2">
                            <button
                                onClick={handleBatchGenerate}
                                disabled={batchRunning || generating || shots.length === 0 || !gateOk}
                                className="w-full h-9 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] disabled:opacity-40 disabled:cursor-not-allowed text-[13px] text-neutral-200 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {batchRunning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                批量生成
                                {batchRunning && batchProgress && (
                                    <span className="text-[11px] text-neutral-400 tabular-nums">
                                        {batchProgress.done}/{batchProgress.total}
                                    </span>
                                )}
                            </button>

                            {/* 场景级成片：先把每个场景的片段合成场景视频，整集再拿场景片拼 */}
                            <button
                                onClick={() => void handleMergeAllScenes()}
                                disabled={
                                    !!mergingScene || batchRunning || !sceneGroups.some((g) => g.ready)
                                }
                                title={
                                    sceneGroups.some((g) => g.ready)
                                        ? '把每个场景的片段分别合成场景视频，整集合并时优先使用场景成片'
                                        : '还没有片段全部生成完毕的场景'
                                }
                                className="w-full h-9 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed text-[13px] text-cyan-200 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {mergingScene ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : (
                                    <Film size={14} />
                                )}
                                全部场景成片
                                <span className="text-[11px] text-cyan-300/70 tabular-nums">
                                    {sceneGroups.filter((g) => g.ready).length}/{sceneGroups.length}
                                </span>
                            </button>

                            {/* 整集合并成片：优先用场景成片，未合成的场景回落内部片段 */}
                            <button
                                onClick={handleMergeEpisode}
                                disabled={merging || batchRunning || !shots.some((s) => !!s.videoUrl)}
                                title={
                                    shots.some((s) => !!s.videoUrl)
                                        ? `把本集已生成的 ${shots.filter((s) => !!s.videoUrl).length} 个片段按镜头顺序拼成成片`
                                        : '本集还没有已生成的片段'
                                }
                                className="w-full h-9 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed text-[13px] text-purple-200 flex items-center justify-center gap-1.5 transition-colors"
                            >
                                {merging ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
                                {merging ? '合成中…' : '整集合并成片'}
                                {!merging && (
                                    <span className="text-[11px] text-purple-300/70 tabular-nums">
                                        {shots.filter((s) => !!s.videoUrl).length}/{shots.length}
                                    </span>
                                )}
                            </button>

                            {/* 合并结果 / 错误提示 */}
                            {mergeError && (
                                <p className="text-[11px] leading-4 text-red-400 break-words">{mergeError}</p>
                            )}
                            {mergedResult && !mergeError && (
                                <div className="flex items-center justify-between gap-2 rounded-lg bg-purple-500/10 px-2 py-1.5">
                                    <span className="text-[11px] text-purple-200 truncate">
                                        成片 {fmtTime(mergedResult.duration)} · {mergedResult.clips} 段
                                    </span>
                                    <a
                                        href={mergedResult.url}
                                        download
                                        className="shrink-0 text-[11px] text-purple-300 hover:text-purple-100 flex items-center gap-1"
                                    >
                                        <Download size={11} />
                                        下载
                                    </a>
                                </div>
                            )}
                        </div>
            </aside>

            {/* ===================== 中栏：预览 ===================== */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <div className="px-4 pt-3 flex items-center justify-between shrink-0">
                    <span className="text-[11px] text-neutral-600">内容由 AI 生成，仅供参考</span>
                    <div className="flex items-center gap-1 rounded-lg bg-white/[0.05] p-0.5">
                        <button
                            onClick={() => setDetailOpen((v) => !v)}
                            className={`h-6 px-2.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                                detailOpen ? 'bg-white/[0.1] text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                            }`}
                        >
                            <Info size={11} />
                            详情
                        </button>

                        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
                            <button
                                onClick={() => setToolsOpen((v) => !v)}
                                className={`h-6 px-2.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                                    toolsOpen ? 'bg-white/[0.1] text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                                }`}
                            >
                                <Briefcase size={11} />
                                工具箱
                            </button>

                            {toolsOpen && (
                                <div className="absolute right-0 top-full mt-1 z-40 w-[132px] rounded-xl border border-white/[0.1] bg-[#23232b] shadow-2xl py-1.5">
                                    {TOOLS.map((tool) => {
                                        const Icon = tool.icon;
                                        return (
                                            <button
                                                key={tool.key}
                                                disabled={tool.disabled}
                                                onClick={() => void handleTool(tool.key)}
                                                className={`w-full text-left px-3 py-2 text-[12px] flex items-center gap-2.5 transition-colors ${
                                                    tool.disabled
                                                        ? 'text-neutral-600 cursor-not-allowed'
                                                        : 'text-neutral-200 hover:bg-white/[0.07]'
                                                }`}
                                            >
                                                <Icon size={14} className="shrink-0" />
                                                {tool.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 flex items-center justify-center p-4">
                    <div
                        ref={playerRef}
                        className={`relative h-full max-h-full max-w-full bg-black overflow-hidden flex items-center justify-center ${
                            isFullscreen ? 'rounded-none' : 'rounded-xl border border-white/[0.08]'
                        }`}
                        style={isFullscreen ? undefined : previewStyle}
                    >
                        {activeShot?.videoUrl ? (
                            <video
                                ref={videoRef}
                                src={activeShot.videoUrl}
                                className="w-full h-full object-contain bg-black"
                                onPlay={() => setPlaying(true)}
                                onPause={() => setPlaying(false)}
                                onTimeUpdate={(e) => setCurrentTime((e.target as HTMLVideoElement).currentTime)}
                                onLoadedMetadata={(e) => setTotalTime((e.target as HTMLVideoElement).duration || 0)}
                                muted={muted}
                                onClick={togglePlay}
                            />
                        ) : activeShot?.imageUrl ? (
                            <img src={activeShot.imageUrl} alt="" className="w-full h-full object-contain" />
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-neutral-600">
                                <ImageIcon size={30} />
                                <span className="text-[12px]">
                                    {isActiveGenerating ? '生成中…' : '尚未生成，点击右侧「生视频」'}
                                </span>
                            </div>
                        )}

                        {/* 生成中遮罩（仅当前片段，切换片段不会串台） */}
                        {isActiveGenerating && (
                            <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-2">
                                <Loader2 size={22} className="animate-spin text-cyan-300" />
                                <span className="text-[12px] text-neutral-300">视频生成中，请稍候…</span>
                            </div>
                        )}

                        {/* 大播放按钮 */}
                        {activeShot?.videoUrl && !playing && !isActiveGenerating && (
                            <button
                                onClick={togglePlay}
                                className="absolute inset-0 m-auto w-14 h-14 rounded-full bg-white/90 hover:bg-white text-black flex items-center justify-center transition-colors"
                            >
                                <Play size={22} className="ml-0.5" />
                            </button>
                        )}

                        {/* 右侧悬浮「放大播放」入口（对应设计稿右侧中部，全屏时隐藏） */}
                        {activeShot?.videoUrl && !isActiveGenerating && !isFullscreen && (
                            <button
                                onClick={toggleFullscreen}
                                title="放大播放"
                                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 h-9 w-9 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur-sm text-white flex items-center justify-center ring-1 ring-white/15 transition-colors"
                            >
                                <Maximize2 size={16} />
                            </button>
                        )}

                        {/* 播放器控制条 */}
                        <div className="absolute bottom-0 left-0 right-0 h-10 px-3 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent">
                            <button
                                onClick={togglePlay}
                                disabled={!activeShot?.videoUrl}
                                className="text-neutral-200 hover:text-white disabled:opacity-40"
                            >
                                {playing ? <Pause size={15} /> : <Play size={15} />}
                            </button>
                            <span className="text-[11px] text-neutral-300 tabular-nums">
                                {fmtTime(currentTime)}
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={totalTime || 0}
                                step={0.1}
                                value={currentTime}
                                onChange={(e) => {
                                    const t = Number(e.target.value);
                                    if (videoRef.current) videoRef.current.currentTime = t;
                                    setCurrentTime(t);
                                }}
                                className="flex-1 h-1 accent-cyan-400"
                                disabled={!activeShot?.videoUrl}
                            />
                            <span className="text-[11px] text-neutral-400 tabular-nums">{fmtTime(totalTime)}</span>
                            <button
                                onClick={() => setMuted((m) => !m)}
                                disabled={!activeShot?.videoUrl}
                                className="text-neutral-300 hover:text-white disabled:opacity-40"
                            >
                                {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                            </button>
                            <button
                                onClick={toggleFullscreen}
                                title={isFullscreen ? '退出全屏' : '全屏播放'}
                                disabled={!activeShot?.videoUrl}
                                className="text-neutral-300 hover:text-white disabled:opacity-40"
                            >
                                <Maximize2 size={14} />
                            </button>
                            <button className="text-neutral-300 hover:text-white">
                                <MoreVertical size={14} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* 详情 chips */}
                {detailOpen && activeShot && (
                    <div className="px-4 pb-2 flex items-center gap-2 flex-wrap shrink-0">
                        {[
                            activeShot.cameraAngle && `景别 ${activeShot.cameraAngle}`,
                            activeShot.cameraMovement && `运镜 ${activeShot.cameraMovement}`,
                            activeShot.lighting && `光线 ${activeShot.lighting}`,
                            activeShot.mood && `氛围 ${activeShot.mood}`,
                        ]
                            .filter(Boolean)
                            .map((t) => (
                                <span key={t as string} className="rounded bg-white/[0.06] px-2 py-0.5 text-[11px] text-neutral-400">
                                    {t}
                                </span>
                            ))}
                    </div>
                )}

                {/* 工具箱 / 抽帧 等操作提示 */}
                {notice && <div className="px-4 pb-2 text-[11px] text-amber-400/90 shrink-0">{notice}</div>}

                {/* 历史记录：该片段生成过的视频缩略图，点击即可切回对应版本 */}
                <div className="px-4 pb-3 shrink-0">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] text-neutral-500 flex items-center gap-1.5">
                            <History size={11} />
                            历史记录 History ({shotHistory.length})
                        </span>
                        {shotHistory.length > 0 && (
                            <span className="text-[10px] text-neutral-600">点击缩略图切换版本 · 悬停可删除</span>
                        )}
                    </div>

                    {shotHistory.length === 0 ? (
                        <div className="h-14 rounded-lg border border-dashed border-white/[0.08] flex items-center justify-center text-[11px] text-neutral-600">
                            {batchRunning || isActiveGenerating ? '生成中，完成后自动记录…' : '暂无历史视频，生成后会自动记录'}
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                            {shotHistory.map((url, i) => {
                                const isCurrent = activeShot?.videoUrl === url;
                                return (
                                    <div
                                        key={`${url}-${i}`}
                                        className={`group relative shrink-0 w-14 h-14 rounded-lg overflow-hidden border transition-colors ${
                                            isCurrent
                                                ? 'border-cyan-400/80'
                                                : 'border-white/[0.1] hover:border-white/[0.3]'
                                        }`}
                                    >
                                        <button
                                            onClick={() => restoreVersion(url)}
                                            title={`切换到历史版本 V${shotHistory.length - i}`}
                                            className="absolute inset-0"
                                        >
                                            <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
                                        </button>
                                        <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] leading-3 py-0.5 text-center text-neutral-300">
                                            V{shotHistory.length - i}
                                        </span>
                                        {isCurrent && (
                                            <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-cyan-400 text-[#04231f] flex items-center justify-center">
                                                <Check size={9} />
                                            </span>
                                        )}
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void deleteHistoryVersion(url);
                                            }}
                                            title="删除此历史视频"
                                            className="absolute top-0.5 left-0.5 h-4 w-4 rounded bg-black/70 text-neutral-300 hover:bg-red-500 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <Trash2 size={9} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ===================== 右栏：生成参数 ===================== */}
            <aside className="w-[360px] shrink-0 border-l border-white/[0.06] bg-[#0c0c11]/70 flex flex-col min-h-0">
                {/* 模式 Tab */}
                <div className="flex items-center gap-1 px-3 pt-3 shrink-0">
                    {([['video', '多参生视频'], ['image', '多参生图'], ['voice', '配音']] as const).map(([k, label]) => (
                        <button
                            key={k}
                            onClick={() => setMode(k)}
                            className={`h-7 px-3 rounded-lg text-[12px] transition-colors ${
                                mode === k ? 'bg-white/[0.1] text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
                    {mode !== 'voice' && (
                        <>
                            {/* 参考 */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[12px] text-neutral-300">参考</span>
                                    <div className="relative">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setRefOpen((v) => !v);
                                            }}
                                            className="h-6 w-6 rounded border border-white/[0.12] text-neutral-400 hover:text-cyan-300 hover:border-cyan-400/40 flex items-center justify-center"
                                        >
                                            <Plus size={13} />
                                        </button>
                                        {refOpen && (
                                            <div
                                                onMouseDown={(e) => e.stopPropagation()}
                                                className="absolute right-0 top-full mt-1 z-30 w-48 rounded-lg border border-white/[0.1] bg-[#1b1b22] shadow-xl py-1 max-h-56 overflow-y-auto"
                                            >
                                                {availableRefs.length === 0 ? (
                                                    <div className="px-2.5 py-2 text-[11px] text-neutral-500">
                                                        暂无已生成的资产图，请先到「资产确认」生成
                                                    </div>
                                                ) : (
                                                    availableRefs.map((r) => {
                                                        const added = refUrls.includes(r.url);
                                                        return (
                                                            <button
                                                                key={r.url}
                                                                onClick={() => {
                                                                    setRefUrls((prev) =>
                                                                        added ? prev.filter((u) => u !== r.url) : [...prev, r.url]
                                                                    );
                                                                }}
                                                                className={`w-full text-left px-2.5 py-1.5 text-[12px] flex items-center gap-2 hover:bg-white/[0.07] ${
                                                                    added ? 'text-cyan-300' : 'text-neutral-300'
                                                                }`}
                                                            >
                                                                <img src={r.url} alt="" className="w-6 h-6 rounded object-cover" />
                                                                <span className="truncate flex-1">{r.name}</span>
                                                                {added && <span className="text-[10px]">已选</span>}
                                                            </button>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 flex-wrap min-h-[52px]">
                                    {refUrls.length === 0 && (
                                        <span className="text-[11px] text-neutral-600">未添加参考图</span>
                                    )}
                                    {refUrls.map((u) => (
                                        <div key={u} className="relative group w-[46px] h-[46px] rounded-lg overflow-hidden border border-white/[0.1]">
                                            <img src={u} alt="" className="w-full h-full object-cover" />
                                            <button
                                                onClick={() => setRefUrls((prev) => prev.filter((x) => x !== u))}
                                                className="absolute top-0 right-0 w-4 h-4 bg-black/70 text-neutral-300 hover:text-white items-center justify-center hidden group-hover:flex"
                                            >
                                                <X size={10} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* 配音提示条 */}
                            {hintOpen && (
                                <div className="flex items-start gap-2 rounded-lg bg-emerald-500/[0.1] border border-emerald-500/25 px-2.5 py-2">
                                    <Link2 size={12} className="text-emerald-300 mt-0.5 shrink-0" />
                                    <span className="flex-1 text-[11px] text-emerald-300/90 leading-4">
                                        点击从配音添加，快速引用角色已绑定的音色
                                    </span>
                                    <button onClick={() => setHintOpen(false)} className="text-emerald-400/70 hover:text-emerald-300">
                                        <X size={11} />
                                    </button>
                                </div>
                            )}

                            {/* 提示词 */}
                            <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[12px] text-neutral-300">提示词</span>
                                    <Clock size={12} className="text-neutral-600" />
                                </div>
                                <textarea
                                    value={promptDraft}
                                    maxLength={PROMPT_MAX}
                                    onChange={(e) => {
                                        setPromptDraft(e.target.value);
                                        if (activeShot) patchShot(activeShot.shotNumber, { prompt: e.target.value });
                                    }}
                                    rows={9}
                                    placeholder="描述该片段的画面、人物动作、镜头与氛围…"
                                    className="w-full rounded-lg bg-white/[0.05] border border-white/[0.08] px-2.5 py-2 text-[12px] leading-5 text-neutral-200 outline-none focus:border-cyan-400/50 resize-none"
                                />
                            </div>

                            {/* 风格 / 形象 */}
                            <div className="flex items-center gap-2">
                                <Select value={style} onChange={setStyle} options={STYLE_OPTIONS} />
                                <Select value={form} onChange={setForm} options={FORM_OPTIONS} />
                                <span className="ml-auto text-[10px] text-neutral-600 tabular-nums">
                                    {promptDraft.length}/{PROMPT_MAX}
                                </span>
                            </div>

                            {/* 模型 / 分辨率 / 画幅·时长 */}
                            <div className="flex items-center gap-2">
                                {mode === 'video' ? (
                                    <>
                                        <Select
                                            value={videoModel}
                                            onChange={setVideoModel}
                                            options={VIDEO_MODELS.map((m) => m.id)}
                                            labels={VIDEO_MODELS.map((m) => m.name)}
                                        />
                                        <Select value={resolution} onChange={setResolution} options={currentVideoModel.resolutions} />
                                        <Select
                                            value={`${aspect} · ${duration}s`}
                                            onChange={(v) => {
                                                const [a, d] = v.split(' · ');
                                                setAspect(a);
                                                setDuration(Number(d.replace('s', '')));
                                            }}
                                            options={ASPECT_OPTIONS.flatMap((a) => currentVideoModel.durations.map((d) => `${a} · ${d}s`))}
                                        />
                                    </>
                                ) : (
                                    <>
                                        <Select
                                            value={imageModel}
                                            onChange={setImageModel}
                                            options={IMAGE_MODELS.map((m) => m.id)}
                                            labels={IMAGE_MODELS.map((m) => m.name)}
                                        />
                                        <Select value={imageResolution} onChange={setImageResolution} options={IMAGE_RESOLUTIONS} />
                                        <Select value={aspect} onChange={setAspect} options={ASPECT_OPTIONS} />
                                    </>
                                )}
                            </div>
                        </>
                    )}

                    {/* 配音 */}
                    {mode === 'voice' && (
                        <DubbingPanel
                            episode={activeEpisode}
                            data={activeDubbing}
                            roleNames={dubbingRoleNames}
                            voiceByRole={dubbingVoiceByRole}
                            voicePromptByRole={dubbingVoicePromptByRole}
                            onChange={updateEpisodeDubbing}
                        />
                    )}
                </div>

                {/* 错误提示（点击展开/收起，长错误信息可完整查看） */}
                {error && (
                    <button
                        type="button"
                        onClick={() => setErrorExpanded((v) => !v)}
                        className="mx-3 mb-2 w-[calc(100%-24px)] flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/25 px-2.5 py-2 text-left text-[11px] text-red-300 hover:bg-red-500/15 transition-colors"
                    >
                        <AlertCircle size={12} className="shrink-0 mt-0.5" />
                        <span
                            className={`flex-1 break-all whitespace-pre-wrap ${errorExpanded ? '' : 'line-clamp-2'}`}
                        >
                            {error}
                            <span className="ml-1 text-red-400/80 underline-offset-2 hover:underline">
                                {errorExpanded ? '收起' : '展开'}
                            </span>
                        </span>
                    </button>
                )}
                {localFallback && (
                    <div className="mx-3 mb-2 text-[10px] text-amber-400/80">
                        AI 拆分镜失败，当前为本地规则拆分结果
                    </div>
                )}

                {/* 生成按钮（配音模式不显示，配音面板有独立操作区） */}
                {mode !== 'voice' && (
                    <div className="p-3 pt-0 shrink-0">
                        <button
                            onClick={mode === 'video' ? handleGenerateVideo : handleGenerateImage}
                            disabled={generating || batchRunning || !activeShot || !gateOk}
                            title={!gateOk ? '该集资产未完成，暂不可生成' : undefined}
                            className="w-full h-11 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-[14px] font-semibold text-[#04231f] flex items-center justify-center gap-2 transition-colors"
                        >
                            {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                            {mode === 'video' ? (activeShot?.videoUrl ? '重新生成视频' : '生视频') : '生图'}
                        </button>
                    </div>
                )}
            </aside>

            {/* 批量生成二次确认 */}
            {batchConfirm && (
                <div
                    className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
                    onClick={() => setBatchConfirm(null)}
                >
                    <div
                        className="w-full max-w-[400px] rounded-2xl border border-white/[0.1] bg-[#16161d] p-5 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start gap-3">
                            <span className="w-9 h-9 shrink-0 rounded-full bg-cyan-500/15 text-cyan-300 flex items-center justify-center">
                                <Sparkles size={17} />
                            </span>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-[14px] font-semibold text-neutral-100">确认批量生成视频</h3>
                                <p className="mt-1.5 text-[12px] leading-5 text-neutral-400">
                                    将生成第 <span className="text-neutral-200">{activeEpisode}</span> 集中{' '}
                                    <span className="text-cyan-300 font-medium">{batchConfirm.pending}</span> 个未生成片段
                                    （本集共 {batchConfirm.total} 个片段）。
                                </p>
                                <p className="mt-1.5 text-[11px] leading-5 text-amber-400/80">
                                    生成将直接调用模型且不可撤销，请确认后再继续。
                                </p>
                            </div>
                        </div>

                        <div className="mt-4 flex items-center justify-end gap-2">
                            <button
                                onClick={() => setBatchConfirm(null)}
                                className="h-9 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-neutral-300 transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => {
                                    setBatchConfirm(null);
                                    void runBatchGenerate();
                                }}
                                className="h-9 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-[12px] font-semibold text-[#04231f] transition-colors"
                            >
                                确认生成 {batchConfirm.pending} 个
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 视频编辑（时间线裁剪） */}
            <VideoEditorModal
                isOpen={videoEditorOpen}
                nodeId={activeShot ? `shot-${activeEpisode}-${activeShot.shotNumber}` : null}
                videoUrl={activeShot?.videoUrl}
                onClose={() => setVideoEditorOpen(false)}
                onExport={(_nodeId, trimStart, trimEnd, url) => {
                    void handleTrimExport(trimStart, trimEnd, url);
                }}
            />
        </div>
    );
};

// ============================================================================
// 轻量下拉选择
// ============================================================================

const Select: React.FC<{
    value: string;
    options: string[];
    labels?: string[];
    onChange: (v: string) => void;
}> = ({ value, options, labels, onChange }) => {
    const [open, setOpen] = useState(false);
    const current = labels ? labels[options.indexOf(value)] || value : value;

    useEffect(() => {
        const onDocDown = () => setOpen(false);
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
    }, []);

    return (
        <div className="relative min-w-0" onMouseDown={(e) => e.stopPropagation()}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="h-8 max-w-[150px] px-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[11px] text-neutral-300 hover:border-white/[0.2] flex items-center gap-1 transition-colors"
            >
                <span className="truncate">{current}</span>
                <ChevronDown size={11} className="shrink-0 text-neutral-500" />
            </button>
            {open && (
                <div className="absolute right-0 bottom-full mb-1 z-30 w-40 rounded-lg border border-white/[0.1] bg-[#1b1b22] shadow-xl py-1 max-h-56 overflow-y-auto">
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

export default ShotEditorPanel;
