/**
 * scriptAnalysisService.ts
 *
 * 剧本智能解析前端服务层。
 * 调用后端 /api/drama/analyze-script，让 AI 分析剧本并返回：
 *   - 分集详情（每集标题、概要、字数、时长、资产）
 *   - 全局去重后的资产清单（人物 / 场景 / 道具）
 */

/** 资产「造型」（同一角色的多个外观版本，每个造型一张设定图） */
export interface AssetLook {
    id: string;
    name: string;
    imageUrl?: string;
}

export interface AssetItem {
    name: string;
    /**
     * 别名 / 其他称呼（如 赵磊 → 石头）。
     * 台词的说话人可能写成别名，靠它才能把台词对到本人并套用同一条音色。
     */
    aliases?: string[];
    description?: string;
    /** 生成的造型图 URL（资产确认页使用） */
    imageUrl?: string;
    /** 造型列表（资产确认页使用） */
    looks?: AssetLook[];
    /** 已配置音色名称（角色资产使用） */
    voiceName?: string;
    /** 自定义音色风格指令（自然语言，配合 voiceName 作为基础音色） */
    voicePrompt?: string;
    /**
     * 人物小传（仅角色）：身份、年龄、处境、性格、欲望。
     * 全剧级数据，只用于展示与人工编辑，不直接进生图提示词。
     */
    bio?: string;
    /**
     * 视觉特征（仅角色）：从人物小传提炼出的纯外貌描述，
     * 是唯一进入生图提示词的人物设定字段（避免剧情元素污染画面）。
     */
    visual?: string;
}

export interface EpisodeAssets {
    characters: AssetItem[];
    scenes: AssetItem[];
    props: AssetItem[];
}

export interface AnalyzedEpisode {
    episode: number;
    title: string;
    summary: string;
    wordCount: number;
    durationSeconds: number;
    assets: EpisodeAssets;
    /** 该集在剧本原文中对应的原文片段（由后端按分集结果切分） */
    content?: string;
}

export interface ScriptAnalysis {
    totalEpisodes: number;
    episodes: AnalyzedEpisode[];
    assets: {
        characters: AssetItem[];
        scenes: AssetItem[];
        props: AssetItem[];
    };
}

export interface AnalyzeScriptParams {
    text: string;
    title?: string;
    genre?: string;
    episodeCount?: number;
    targetDuration?: number;
    /** 前端已按集标记切好的片段：后端只逐批补全标题/概要（用于超长剧本） */
    preSplit?: { episode: number; content: string }[];
    /** 模型调用通道（drama 系列固定走 workflow） */
    channel?: string;
}

export const analyzeScript = async (params: AnalyzeScriptParams): Promise<ScriptAnalysis> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 分钟超时
    try {
        const response = await fetch('/api/drama/analyze-script', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...params, channel: params.channel || 'workflow' }),
            signal: controller.signal,
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `解析失败（${response.status}）`);
        }
        return data as ScriptAnalysis;
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error('解析超时（超过 3 分钟），请重试或缩短剧本');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};

/** 分集结果中的单集（不含资产） */
export interface EpisodeBrief {
    episode: number;
    title: string;
    summary: string;
    wordCount: number;
    durationSeconds: number;
    /** 该集在剧本原文中对应的原文片段（由后端按分集结果切分） */
    content?: string;
}

/** 资产识别结果中的单集资产 */
export interface EpisodeAssetsResult {
    episode: number;
    assets: EpisodeAssets;
}

/** 通用 JSON 请求封装（3 分钟超时） */
const requestJson = async <T>(url: string, params: unknown): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || `请求失败（${response.status}）`);
        }
        return data as T;
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error('请求超时（超过 3 分钟），请重试');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
};

/** 只拆集：调用后端 /split-episodes，输出量小、速度快 */
export const splitEpisodes = (params: AnalyzeScriptParams): Promise<{ totalEpisodes: number; episodes: EpisodeBrief[] }> =>
    requestJson('/api/drama/split-episodes', { ...params, channel: params.channel || 'workflow' });

/** 基于分集识别资产：调用后端 /analyze-assets */
export const analyzeAssets = (params: {
    text: string;
    title?: string;
    genre?: string;
    episodes: EpisodeBrief[];
    channel?: string;
}): Promise<{ assets: { characters: AssetItem[]; scenes: AssetItem[]; props: AssetItem[] }; episodes: EpisodeAssetsResult[] }> =>
    requestJson('/api/drama/analyze-assets', { ...params, channel: params.channel || 'workflow' });

/**
 * 一条台词。
 * text 必须是剧本里的原台词（逐字），不是画面描述的复述——这是配音与音色的文本来源。
 */
export interface ShotDialogue {
    /** 说话角色名（标准姓名，与资产 characters.name / aliases 对齐） */
    role: string;
    /** 台词文本，逐字摘自剧本，不含角色名与括号提示 */
    text: string;
    /** 括号里的表演提示，如「压低声音」「挤出笑」 */
    tone?: string;
    /** 画外音 / 内心独白（剧本里的 OS） */
    isVoiceOver?: boolean;
}

/** 分镜（片段）：单集拆分出的一个镜头 */
export interface ShotItem {
    shotNumber: number;
    /** 场号，如 "1-1"（对应剧本场次标题） */
    sceneNumber?: string;
    /** 场景地点，如「县城·长途汽车站候车厅」 */
    location?: string;
    /** 时间：日 / 夜 / 傍晚 */
    timeOfDay?: string;
    /** 内景 / 外景 */
    interiorExterior?: string;
    /** 本镜头实际出镜的角色姓名 */
    characters?: string[];
    /**
     * 人物站位与调度：谁在画面哪一侧、面向谁、相距多远、有无遮挡或过肩关系。
     * 站位写清楚，视频里的人物才不会各演各的、也不会互相穿插站位漂移。
     */
    blocking?: string;
    /** 本镜头的台词（可能为空：纯动作 / 空镜） */
    dialogues?: ShotDialogue[];
    description: string;
    cameraAngle?: string;
    cameraMovement?: string;
    lighting?: string;
    mood?: string;
    durationSeconds?: number;
    prompt?: string;
    /** 切入本镜头的转场 id（由 AI 建议，合并成片时作为逐边界转场默认值） */
    transitionOut?: string;
}

/** 把单集剧本拆成「分镜（片段）」：调用后端 /api/drama/split-shots */
export const splitShots = (params: {
    episode: { episode: number; title?: string; summary?: string; content?: string };
    characters?: string[];
    style?: string;
    aspectRatio?: string;
    targetDuration?: number;
    channel?: string;
}): Promise<{ shots: ShotItem[] }> => requestJson('/api/drama/split-shots', { ...params, channel: params.channel || 'workflow' });

/** 把秒数格式化为 mm:ss */
export const formatDurationSeconds = (seconds: number): string => {
    const sec = Math.max(0, Math.round(seconds || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
