/**
 * dubbingService.ts
 *
 * 「视频生成 → 配音」的数据与试听 / 合成服务。
 *
 *   1. 管理并持久化配音数据（按 projectId + episode 隔离，存 localStorage）；
 *   2. 「试听」使用浏览器内置 speechSynthesis（中文），仅用于快速预览节奏与断句；
 *   3. 「AI 合成」走后端火山引擎豆包语音 TTS（POST /api/tts/synthesize），
 *      返回真实 mp3，可在线播放、单条下载；凭证在 .env 的 TTS_APP_ID /
 *      TTS_ACCESS_TOKEN 中配置。
 */

import type { ShotDialogue } from './scriptAnalysisService';
import { DEFAULT_VOICE_ID, VOICE_OPTIONS } from './voiceCatalog';
import {
    buildRoleVoiceMap,
    lineVoiceSignature,
    resolveLineContext,
    resolveLineVoice,
    type CharacterVoiceSource,
} from './dubbingVoice';

// ============================================================================
// 类型
// ============================================================================

/** 一条分镜台词配音 */
export interface DubbingLine {
    id: string;
    /** 说话角色名；'旁白' 表示旁白解说 */
    role: string;
    /** 台词文本 */
    text: string;
    /** 台词所属分镜序号：合并成片时按镜头顺序排布 */
    shotNumber?: number;
    /** 剧本括号里的表演提示（如「压低声音」），作为风格指令的一部分送给 TTS */
    tone?: string;
    /** 画外音 / 内心独白（剧本 OS） */
    isVoiceOver?: boolean;
    /** 已合成的音频地址（data URL） */
    audioUrl?: string;
    /**
     * 合成这条音频时的「音色指纹」（文本 + 角色 + 音色 + 风格指令）。
     * 资产里的音色一改，指纹就与当前值不一致，音频判定为过期，
     * 这样「资产音色改变 → 视频音色同步改变」不依赖人工清理缓存。
     */
    audioSignature?: string;
}

/** 单集配音数据 */
export interface EpisodeDubbing {
    /** 旁白绑定的音色名 */
    narratorVoice: string;
    /** 音量 0 ~ 1 */
    volume: number;
    /** 音速倍率 0.5 ~ 2 */
    speed: number;
    lines: DubbingLine[];
}

/** 整部项目的配音数据：key 为集号 */
export type DubbingStore = Record<number, EpisodeDubbing>;

// ============================================================================
// 常量
// ============================================================================

/**
 * 可选音色：统一由 voiceCatalog 提供（与后端 api/server/config/voices.js 对齐），
 * 这里只做再导出，避免前后端各维护一份导致漂移。
 */
export { DEFAULT_VOICE_ID, VOICE_OPTIONS };

export const NARRATOR = '旁白';

const DEFAULT_VOLUME = 1;
const DEFAULT_SPEED = 1;

const uid = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `l_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ============================================================================
// 持久化
// ============================================================================

const storeKey = (projectId: string) => `dubbing:${projectId}`;

export const loadDubbing = (projectId: string): DubbingStore => {
    try {
        const raw = localStorage.getItem(storeKey(projectId));
        if (raw) return JSON.parse(raw) as DubbingStore;
    } catch {
        /* ignore */
    }
    return {};
};

export const saveDubbing = (projectId: string, store: DubbingStore): void => {
    try {
        localStorage.setItem(storeKey(projectId), JSON.stringify(store));
    } catch {
        /* 容量超限 / 隐私模式：静默失败 */
    }
};

// ============================================================================
// 初始化
// ============================================================================

/**
 * 把台词里的角色名对齐到资产里的标准姓名。
 *
 * 剧本常用别名指代（赵磊写成「石头」），匹配不上就套不到该角色的音色，
 * 所以先用资产名精确匹配，再查别名表，最后按包含关系兜底。
 */
const resolveRoleName = (
    rawRole: string,
    characters: string[],
    aliasMap: Record<string, string[]> = {}
): string => {
    const raw = (rawRole || '').trim();
    if (!raw || raw === NARRATOR) return NARRATOR;
    if (characters.includes(raw)) return raw;

    for (const [name, aliases] of Object.entries(aliasMap)) {
        if ((aliases || []).some((a) => a && (a === raw || raw.includes(a)))) return name;
    }

    // 「赵磊（石头）」这类带括号备注的写法，取核心名再比一次
    const core = raw.split(/[（(·\s]/)[0].trim();
    if (core && characters.includes(core)) return core;
    const hit = characters.find((c) => raw.includes(c) || c.includes(raw));
    return hit || raw;
};

/**
 * 依据分镜初始化某集台词配音。
 *
 * 首选分镜里的剧本原台词（shot.dialogues）——这才是视频里人物要真正说出来的话；
 * 老数据的分镜没有台词字段时，才回落到「把画面描述当旁白」的旧行为，
 * 保证老项目打开配音面板不会突然变空。
 */
export const buildEpisodeDubbing = (
    shots: { shotNumber?: number; description?: string; dialogues?: ShotDialogue[] }[],
    roleNames: string[] = [],
    aliasMap: Record<string, string[]> = {}
): EpisodeDubbing => {
    const characters = roleNames.filter((r) => r && r !== NARRATOR);
    const hasDialogue = shots.some((s) => (s.dialogues || []).some((d) => (d?.text || '').trim()));

    const lines: DubbingLine[] = hasDialogue
        ? shots.flatMap((s) =>
              (s.dialogues || [])
                  .filter((d) => (d?.text || '').trim())
                  .map((d) => ({
                      id: uid(),
                      role: resolveRoleName(d.role, characters, aliasMap),
                      text: d.text.trim(),
                      tone: d.tone?.trim() || undefined,
                      isVoiceOver: d.isVoiceOver || undefined,
                      shotNumber: s.shotNumber,
                  }))
          )
        : shots.map((s, i) => {
              const text = (s.description || '').replace(/。+$/, '') || `分镜台词 ${i + 1}`;
              // 分镜描述里只提到一个角色时，直接把这条台词绑给该角色，
              // 这样资产里配的音色才能生效；提到多个角色时保守用旁白，避免张冠李戴。
              const mentioned = characters.filter((r) => text.includes(r));
              return {
                  id: uid(),
                  role: mentioned.length === 1 ? mentioned[0] : NARRATOR,
                  text,
                  shotNumber: s.shotNumber,
              };
          });

    return {
        narratorVoice: DEFAULT_VOICE_ID,
        volume: DEFAULT_VOLUME,
        speed: DEFAULT_SPEED,
        lines,
    };
};

/** 新增一条空台词 */
export const createLine = (index: number): DubbingLine => ({
    id: uid(),
    role: NARRATOR,
    text: `分镜台词 ${index}`,
});

// ============================================================================
// 试听：浏览器内置 TTS
// ============================================================================

/** 当前是否支持浏览器语音试听 */
export const isPreviewSupported = (): boolean =>
    typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * 试听一条台词（浏览器语音合成）。
 * @returns stop 函数，用于中途停止
 */
export const previewLine = (
    line: Pick<DubbingLine, 'text'>,
    opts: { volume?: number; speed?: number } = {}
): (() => void) => {
    if (!isPreviewSupported()) return () => {};
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(line.text);
    utter.lang = 'zh-CN';
    utter.volume = clamp(opts.volume ?? DEFAULT_VOLUME, 0, 1);
    utter.rate = clamp(opts.speed ?? DEFAULT_SPEED, 0.5, 2);

    // 尽量挑选中文语音
    const voices = window.speechSynthesis.getVoices();
    const zh = voices.find((v) => /zh(-|_)?(CN|Hans)/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang));
    if (zh) utter.voice = zh;

    window.speechSynthesis.speak(utter);
    return () => window.speechSynthesis.cancel();
};

/** 停止所有试听 */
export const stopPreview = (): void => {
    if (isPreviewSupported()) window.speechSynthesis.cancel();
};

// ============================================================================
// 真实 TTS（火山引擎豆包语音，经后端 /api/tts）
// ============================================================================

/** 全局唯一的真实音频播放器（同一时刻只播一条） */
let audioEl: HTMLAudioElement | null = null;
/** 当前正在播放的真实音频台词 id（供 UI 高亮） */
let activeAudioId: string | null = null;
let audioEndCb: (() => void) | null = null;

/** 后端是否已配置火山 TTS 凭证（结果缓存一次） */
let configuredCache: boolean | null = null;

/** 查询后端 TTS 是否已配置凭证 */
export const isTTSConfigured = async (): Promise<boolean> => {
    if (configuredCache !== null) return configuredCache;
    try {
        const resp = await fetch('/api/tts/status');
        if (!resp.ok) return false;
        const data = await resp.json();
        configuredCache = !!data.configured;
    } catch {
        configuredCache = false;
    }
    return configuredCache;
};

/**
 * 合成一条台词的真实 AI 音频，返回可直接播放/下载的 data URL。
 * 失败时抛出带中文信息的 Error。
 */
export const synthesizeLine = async (
    line: DubbingLine,
    opts: { voice: string; volume: number; speed: number; contextTexts?: string[] }
): Promise<string> => {
    const text = (line.text || '').trim();
    if (!text) throw new Error('台词内容为空，无法合成');

    const resp = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            voice: opts.voice,
            volume: opts.volume,
            speed: opts.speed,
            // 自定义音色的风格提示词：以语音指令形式传给 2.0 模型，控制语气 / 语速 / 情绪
            contextTexts: opts.contextTexts?.length ? opts.contextTexts : undefined,
            encoding: 'mp3',
            response: 'base64',
        }),
    });

    if (!resp.ok) {
        let msg = `合成失败（HTTP ${resp.status}）`;
        try {
            const err = await resp.json();
            if (err?.error) msg = err.error;
        } catch {
            /* ignore */
        }
        if (resp.status === 503) {
            msg = '服务器未配置 TTS 凭证（TTS_APP_ID / TTS_ACCESS_TOKEN）';
        }
        throw new Error(msg);
    }

    const data = await resp.json();
    if (!data?.audio) throw new Error('合成返回缺少音频数据');
    return data.audio as string;
};

// ============================================================================
// 音色同步：本地音频是否过期 / 整集音轨生成
// ============================================================================

/** 按「当前资产音色」算出的台词指纹 */
export const signatureOf = (
    line: Pick<DubbingLine, 'role' | 'text'>,
    voice: string,
    prompt?: string
): string => lineVoiceSignature({ role: line.role, text: line.text, voice, prompt });

/**
 * 已合成的本地音频是否仍然匹配当前音色。
 * 不匹配（资产换了音色 / 改了风格 / 改了台词）就应该重新合成。
 */
export const isLineAudioFresh = (line: DubbingLine, signature: string): boolean =>
    Boolean(line.audioUrl) && line.audioSignature === signature;

/** 整集音轨里单条台词合成失败的明细 */
export interface EpisodeTrackFailure {
    index: number;
    role: string;
    preview: string;
    reason: string;
}

export interface EpisodeTrackResult {
    /** 可直接提供给成片合并接口的地址：/library/audio/dub_ep01_<指纹>.mp3 */
    url: string;
    duration: number;
    fingerprint: string;
    /** true 表示内容与音色都没变，复用了已有文件（不消耗额度） */
    cached: boolean;
    lineCount: number;
    failed: EpisodeTrackFailure[];
}

/**
 * 生成整集配音音轨。
 *
 * 音色在这里逐条按资产解析后传给服务端——服务端不做角色推断，
 * 避免前后端各自判断导致音色不一致。返回的文件名带内容指纹，
 * 资产音色一变就是新文件，成片自然用新音色。
 */
export const buildEpisodeTrack = async (p: {
    lines: DubbingLine[];
    /** 本集角色资产（含 voiceName / voicePrompt） */
    characters?: CharacterVoiceSource[];
    narratorVoice: string;
    episode?: number;
    volume?: number;
    speed?: number;
    /** true 时忽略同指纹缓存强制重合成 */
    force?: boolean;
}): Promise<EpisodeTrackResult> => {
    const voiceMap = buildRoleVoiceMap(p.characters);

    const payloadLines: Array<{
        role: string;
        text: string;
        voice: string;
        contextTexts?: string[];
    }> = [];
    for (const line of p.lines) {
        const text = (line.text || '').trim();
        if (!text) continue;
        const voice = resolveLineVoice(line.role, voiceMap, p.narratorVoice);
        const contextTexts = resolveLineContext(line, voiceMap);
        payloadLines.push({
            role: line.role,
            text,
            voice,
            contextTexts: contextTexts.length ? contextTexts : undefined,
        });
    }

    if (payloadLines.length === 0) {
        throw new Error('本集还没有台词，请先在配音面板填写');
    }

    const resp = await fetch('/api/dubbing/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            episode: p.episode,
            volume: p.volume,
            speed: p.speed,
            force: p.force,
            lines: payloadLines,
        }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.url) {
        throw new Error(data?.error || `音轨生成失败（HTTP ${resp.status}）`);
    }
    return data as EpisodeTrackResult;
};

/** 是否有真实音频正在播放 */
export const isAudioPlaying = (id?: string): boolean =>
    !!audioEl && !audioEl.paused && (id === undefined || activeAudioId === id);

/** 当前播放中的真实音频台词 id */
export const getPlayingAudioId = (): string | null => activeAudioId;

/**
 * 播放某条真实音频。
 * @returns stop 函数，用于中途停止
 */
export const playAudio = (
    id: string,
    url: string,
    onEnd?: () => void
): (() => void) => {
    stopAudio();
    const el = new Audio(url);
    audioEl = el;
    activeAudioId = id;
    audioEndCb = onEnd || null;
    el.onended = () => {
        if (activeAudioId === id) {
            activeAudioId = null;
            audioEndCb?.();
            audioEndCb = null;
        }
    };
    el.onerror = () => {
        activeAudioId = null;
        audioEndCb = null;
    };
    void el.play().catch(() => {
        activeAudioId = null;
    });
    return () => stopAudio();
};

/** 停止所有真实音频播放 */
export const stopAudio = (): void => {
    if (audioEl) {
        audioEl.onended = null;
        audioEl.onerror = null;
        audioEl.pause();
        audioEl.src = '';
        audioEl = null;
    }
    activeAudioId = null;
    if (audioEndCb) {
        audioEndCb = null;
    }
};

/** 下载一条已合成的音频为独立文件 */
export const downloadAudio = (url: string, filename: string): void => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.mp3') ? filename : `${filename}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
