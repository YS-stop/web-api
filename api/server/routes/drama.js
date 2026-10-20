/**
 * drama.js
 *
 * 剧本智能解析路由：让 AI（火山方舟 DeepSeek）分析剧本全文，一次性产出：
 *   1. 分集详情（每集的标题、剧情概要、字数、预计时长）
 *   2. 每集涉及的资产（人物 / 场景 / 道具）
 *   3. 全局去重后的资产清单
 *
 * 这合并了「创建草稿并解析」与「拆集确认」两个步骤：
 * 一个智能体任务里同时完成「拆集」和「资产识别/规划」。
 */

import express from 'express';
import { getKey, withConcurrency } from '../services/modelChannel.js';
import { retryOperation, parseJsonFromText, arkChat } from '../services/llmClient.js';
import { findVoice, inferVoiceId, voiceCatalogForPrompt } from '../config/voices.js';
// 场景/台词写法由这份剧本自己决定，不在这里枚举格式
import {
    detectScriptFormat,
    makeSceneResolver,
    parseSceneTitle,
    countScenes,
    describeFormat,
    CAST_LINE_RE,
    ACTION_LINE_RE,
} from '../services/scriptFormat.js';

const router = express.Router();

// 火山方舟（OpenAI 兼容接口）上的 DeepSeek 模型配置
const DRAMA_BASE_URL = process.env.DRAMA_BASE_URL || process.env.VLM_DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const DRAMA_MODEL_ID = process.env.DRAMA_MODEL_ID || 'deepseek-v4-flash-ga-260731';

/** 统计字符串中有效字符数（去除所有空白后的字符个数） */
function countChars(s) {
    return String(s || '').replace(/\s/g, '').length;
}

/** 单次最多处理的集数（一次性自由拆分时仍偏保守，预切分模式可放宽） */
const MAX_EPISODES = 100;
/** 一次性「自由拆分」时，为控制输出 token 建议的集数上限 */
const FREE_SPLIT_SOFT_LIMIT = 30;
/** 预切分「逐集补全」时，每批处理的集数（输出量小、不易截断） */
const ENRICH_BATCH = 10;

/**
 * 归一化资产项：名称去掉括号备注（「陈念念（男）」→「陈念念」），
 * 备注在描述为空时补进描述，避免资产确认页出现重复或怪名字。
 */
function normalizeAsset(item) {
    if (typeof item === 'string') {
        const { name, note } = splitNameNote(item);
        return { name, description: note };
    }
    const { name, note } = splitNameNote((item && item.name) || '');
    const out = {
        name,
        description: (item && item.description) || note || '',
    };
    // 人物专属字段必须透传，否则会在归一化 / 去重环节被丢弃
    if (item && typeof item.bio === 'string' && item.bio.trim()) out.bio = item.bio.trim();
    if (item && typeof item.visual === 'string' && item.visual.trim()) out.visual = item.visual.trim();
    // 音色同理：AI 分配的 voiceName 若不透传，会被去重环节静默丢掉
    if (item && typeof item.voiceName === 'string' && item.voiceName.trim()) {
        out.voiceName = item.voiceName.trim();
    }
    // 别名同样必须透传：台词的说话人可能写成「石头」，丢了别名就套不上「赵磊」的音色
    if (item && Array.isArray(item.aliases)) {
        const aliases = item.aliases
            .map((a) => String(a || '').trim())
            .filter((a) => a && a !== name);
        if (aliases.length) out.aliases = Array.from(new Set(aliases));
    }
    return out;
}

/** 按名称去重资产列表（「陈海英（女）」与「陈海英」视为同一资产） */
function dedupeAssets(list) {
    const seen = new Set();
    const result = [];
    for (const raw of list || []) {
        const item = normalizeAsset(raw);
        if (!item.name) continue;
        const key = assetKey(item.name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

/**
 * 按每集的起始锚点（startText）把剧本原文切成每一集的原文片段。
 * - startText 为该集在原文中开头的连续文字，用 indexOf 定位切分点；
 * - 依次尝试 40/20/10 字前缀，尽量容忍 AI 摘录时的细微差异；
 * - 定位不到时，按各集字数占比在原文中估算位置兜底；
 * - 结果保证切分点单调递增，避免片段错乱。
 */
function sliceEpisodeContents(text, episodes) {
    const n = episodes.length;
    if (n === 0) return [];
    const positions = new Array(n).fill(-1);

    let cursor = 0;
    for (let i = 0; i < n; i++) {
        const marker = String(episodes[i].startText || '').trim();
        if (!marker) continue;
        let idx = -1;
        for (const len of [40, 20, 10]) {
            const probe = marker.slice(0, len);
            if (!probe) continue;
            idx = text.indexOf(probe, Math.max(0, cursor - 10));
            if (idx === -1) idx = text.indexOf(probe);
            if (idx !== -1) break;
        }
        if (idx !== -1) {
            positions[i] = idx;
            cursor = idx + 1;
        }
    }

    // 兜底：未定位到的按累计字数占比估算
    const wordCounts = episodes.map((e) => Math.max(0, Number(e.wordCount) || 0));
    const totalWords = wordCounts.reduce((a, b) => a + b, 0) || n;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        if (positions[i] === -1) positions[i] = Math.round((acc / totalWords) * text.length);
        acc += wordCounts[i];
    }

    // 强制单调递增，避免切分点错乱
    positions[0] = 0;
    for (let i = 1; i < n; i++) {
        if (positions[i] <= positions[i - 1]) positions[i] = positions[i - 1] + 1;
    }

    const markerRe = /^第\s*[0-9一二三四五六七八九十百零]+\s*(集|回|章)\s*$/;
    return episodes.map((ep, i) => {
        const start = positions[i];
        const end = i + 1 < n ? positions[i + 1] : text.length;
        const lines = text.slice(start, Math.max(start, end)).trim().split('\n');
        // 去掉片段末尾残留的下一集标记（如「第二集」）
        while (lines.length > 1 && markerRe.test(lines[lines.length - 1].trim())) lines.pop();
        return lines.join('\n').trim();
    });
}

/**
 * 判断正文起点（场景标题 / 出场人物 / 动作行 / 常见分镜标记）。
 *
 * 场景标题的写法不再在这里枚举，而是由 scriptFormat.detectScriptFormat
 * 针对每份剧本单独探测；探不到显式标题时，makeSceneResolver 会退化为
 * 「下一行是出场人物行 → 当前行就是场景标题」，因此没有场号的剧本也能分场。
 */
function findBodyStartIndex(lines, profile) {
    const resolve = makeSceneResolver(lines, profile);
    for (let i = 0; i < lines.length; i++) {
        const t = String(lines[i] || '').trim();
        if (!t) continue;
        if (resolve(i)) return i;
        if (CAST_LINE_RE.test(t)) return i;
        if (/^(场景|场次|内景|外景|镜号|镜头|画面)/.test(t)) return i;
        if (ACTION_LINE_RE.test(t)) return i;
    }
    return -1;
}

/** 场次出场人物行（与 scriptFormat 同源，避免两处正则漂移） */
const SCENE_CAST_RE = CAST_LINE_RE;

/**
 * 剧本显式列出的资产清单行，例如：
 *   【人物】陈海英（女）、林大妹（女）、胖子、瘦子
 *   【场景】云海仙境、渔船甲板·夜
 *   【道具】红锦鲤、煤油灯
 * 这类清单是「资产确认」的权威依据，清洗正文时必须保留，不能当作剧本前言丢弃。
 */
const DECLARED_LINE_RE = /^\s*[【\[]\s*(人物|角色|场景|地点|道具|物品)\s*[】\]]\s*[:：]?\s*(.+)$/;

/** 拆出资产名与括号备注（「陈海英（女）」→ 名称「陈海英」、备注「女」） */
function splitNameNote(raw) {
    const text = String(raw || '').trim();
    const m = text.match(/^(.+?)\s*[（(]\s*([^）)]*)\s*[）)]\s*$/);
    if (!m) return { name: text, note: '' };
    return { name: m[1].trim(), note: m[2].trim() };
}

/** 资产名归一化（去掉括号备注 / 空格 / 统一小写），用于清单与模型结果比对去重 */
function assetKey(raw) {
    return splitNameNote(raw).name.replace(/\s+/g, '').toLowerCase();
}

/** 从单集原文中解析「显式声明的资产清单」 */
function parseDeclaredAssets(raw) {
    const out = { characters: [], scenes: [], props: [] };
    if (!raw) return out;
    for (const line of String(raw).replace(/\r\n?/g, '\n').split('\n')) {
        const m = line.match(DECLARED_LINE_RE);
        if (!m) continue;
        const kind = m[1];
        const bucket = /人物|角色/.test(kind) ? out.characters : /场景|地点/.test(kind) ? out.scenes : out.props;
        for (const piece of m[2].split(/[、,，;；]+/)) {
            const { name, note } = splitNameNote(piece);
            if (!name) continue;
            if (bucket.some((a) => assetKey(a.name) === assetKey(name))) continue;
            bucket.push({ name, description: note });
        }
    }
    return out;
}

/**
 * 从单集正文解析「场次标题」与「出场人物」，作为资产识别的硬清单。
 *
 * 标准剧本每一场都是两行开头：
 *   1-1，县城·长途汽车站候车厅，日，内
 *   出场人物：胡万金、小马、老朱（镇上粮油店老板）、供货商若干
 * 剧本已经写死了这一场在哪里、有哪些人，比让模型自己读正文推断可靠得多：
 * 模型读长正文时经常只认出前几场的人，中后段场次直接漏掉。
 */
function parseSceneMeta(raw) {
    const characters = [];
    const scenes = [];
    const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
    // 每份剧本自己决定场景标题长什么样
    const resolve = makeSceneResolver(lines, detectScriptFormat(raw));

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) continue;

        const head = resolve(i);
        if (head) {
            const { location, timeOfDay, interiorExterior } = parseSceneTitle(head.rest);
            if (location && !scenes.some((s) => assetKey(s.name) === assetKey(location))) {
                // 时间与内外景（日/夜、内/外）写进描述，供生图与分镜参考
                const when = [timeOfDay, interiorExterior].filter(Boolean).join('·');
                scenes.push({ name: location, description: when });
            }
            continue;
        }

        const m = t.match(SCENE_CAST_RE);
        if (!m) continue;
        for (const piece of m[1].split(/[、,，;；]+/)) {
            const { name, note } = splitNameNote(piece);
            if (!name) continue;
            if (characters.some((c) => assetKey(c.name) === assetKey(name))) continue;
            // 群演（供货商若干 / 候车旅客若干 / 乡亲若干）也照样入列：
            // 剧本已经写明这一场有他们，漏掉就与原文对不上。
            characters.push({ name, description: note });
        }
    }
    return { characters, scenes };
}

/**
 * 把「剧本显式清单」合并进模型识别结果：
 * 清单里出现的资产一个都不能少（模型漏识别的直接补回），
 * 模型已识别的同名资产保留其描述。
 */
function mergeDeclaredAssets(declared, recognized) {
    const list = dedupeAssets(recognized);
    const index = new Map(list.map((a, i) => [assetKey(a.name), i]));
    for (const item of declared || []) {
        const key = assetKey(item.name);
        if (!key) continue;
        const at = index.get(key);
        if (at === undefined) {
            index.set(key, list.length);
            list.push({ name: item.name, description: item.description || '' });
        } else if (!list[at].description) {
            // 模型已识别但没给描述时，用清单里的性别/备注补上
            list[at].description = item.description || '';
        }
    }
    return list;
}

/**
 * 全局人物清单补全 bio / visual。
 *
 * 模型在「全局 assets」里经常只给 name + description，人物小传与视觉特征
 * 只写在分集里。这里用分集结果做兜底合并，避免资产确认页拿不到小传。
 */
function backfillCharacterDetails(globalList, episodeLists) {
    const detail = new Map();
    for (const list of episodeLists) {
        for (const item of list || []) {
            const key = assetKey(item.name);
            if (!key) continue;
            const prev = detail.get(key) || {};
            const prevAliases = prev.aliases || [];
            detail.set(key, {
                bio: prev.bio || item.bio || '',
                visual: prev.visual || item.visual || '',
                voiceName: prev.voiceName || item.voiceName || '',
                // 别名按并集累积：不同分集可能只给了其中一部分称呼
                aliases: Array.from(new Set([...prevAliases, ...(Array.isArray(item.aliases) ? item.aliases : [])])),
            });
        }
    }
    for (const item of globalList || []) {
        const extra = detail.get(assetKey(item.name));
        if (!extra) continue;
        if (!item.bio && extra.bio) item.bio = extra.bio;
        if (!item.visual && extra.visual) item.visual = extra.visual;
        if (!item.voiceName && extra.voiceName) item.voiceName = extra.voiceName;
        const mergedAliases = Array.from(new Set([...(item.aliases || []), ...(extra.aliases || [])]));
        if (mergedAliases.length) item.aliases = mergedAliases;
    }
    return globalList;
}

/**
 * 归一化角色音色。
 *   - AI 给了合法 id / 中文名 → 统一成 id；
 *   - 没给、或给了清单外的非法值 → 按性别 / 年龄 / 身份规则兜底。
 * 目的是保证「每个角色都有一个可直接合成的音色」，且绝不把未知字符串透传给火山接口
 * （老版本「默认音色」就是这么挂的）。
 */
function normalizeCharacterVoices(list) {
    for (const item of list || []) {
        const hit = findVoice(item.voiceName);
        item.voiceName = hit
            ? hit.id
            : inferVoiceId({
                description: item.description,
                bio: item.bio,
                name: item.name,
            });
    }
    return list;
}

/**
 * 清洗单集原文，让「分集目录」只保留该集正文：
 * 找到第一个正文起始行（场景 / △ / 内景 / 外景 / 镜号 / 镜头），
 * 其之前的剧本前言（《编号》、故事梗概、人物小传等）丢弃；
 * 但【人物】【场景】【道具】三类资产清单要保留并前置——资产识别依赖它们；
 * 最后去掉空行，输出紧凑格式。
 */
/**
 * 抽取剧本前言（正文起点之前的「故事梗概 / 人物小传」段落）。
 *
 * cleanEpisodeContent 为了保证分集阅读器只显示本集正文，会把前言整体丢弃；
 * 但前言里的「人物小传」是角色形象设定的核心依据（年龄、身份、气质、处境），
 * 资产识别需要它才能写出有血有肉的人物，因此单独取出来一并喂给模型。
 * 只取正文起点之前的内容，长度做上限保护，避免长剧本把 prompt 撑爆。
 */
function extractPreamble(raw, maxLen = 6000) {
    if (!raw) return '';
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    const bodyIndex = findBodyStartIndex(lines, detectScriptFormat(raw));
    if (bodyIndex <= 0) return '';
    const text = lines.slice(0, bodyIndex).join('\n').trim();
    return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function cleanEpisodeContent(raw) {
    if (!raw) return '';
    const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');

    // 定位正文起点，其之前是剧本前言
    const bodyIndex = findBodyStartIndex(lines, detectScriptFormat(raw));
    const preamble = bodyIndex > 0 ? lines.slice(0, bodyIndex) : [];
    const body = bodyIndex > 0 ? lines.slice(bodyIndex) : lines;

    // 前言中只挑出资产清单行保留（其余全部丢弃）
    const declaredLines = preamble
        .filter((line) => DECLARED_LINE_RE.test(line))
        .map((line) => line.trim());

    const out = [];
    for (const line of [...declaredLines, ...body]) {
        const t = line.replace(/\s+$/, '');
        if (t.trim() === '') continue;
        if (out[out.length - 1] === t) continue; // 去掉紧邻重复行
        out.push(t);
    }
    return out.join('\n').trim();
}

/** 调用火山方舟 DeepSeek（OpenAI 兼容），返回解析后的 JSON 对象 */
async function callDeepSeek(apiKey, systemPrompt, maxTokens = 4096, channel = 'workflow') {
    const responseText = await withConcurrency('DRAMA', channel, () =>
        retryOperation(
            () => arkChat({
                apiKey,
                systemPrompt,
                model: DRAMA_MODEL_ID,
                baseUrl: DRAMA_BASE_URL,
                maxTokens,
                tag: 'Drama',
            }),
            3,
            2000,
            'Drama'
        )
    );
    try {
        return parseJsonFromText(responseText);
    } catch (parseError) {
        console.error('[Drama] JSON 解析失败:', parseError);
        console.error('[Drama] 原始响应:', responseText);
        throw new Error('AI 返回格式无法解析，请重试');
    }
}

/**
 * POST /api/drama/analyze-script
 * Body: {
 *   text: string,            // 剧本全文（必填）
 *   title?: string,          // 剧目名
 *   genre?: string,          // 题材
 *   targetDuration?: number  // 单集目标时长（秒，默认 90）
 * }
 * 分集数量由 AI 根据剧本内容自动判断（上限 30 集）。
 * Returns: { totalEpisodes, episodes: [...], assets: { characters, scenes, props } }
 */
router.post('/analyze-script', async (req, res) => {
    try {
        const { text, title, genre, targetDuration, channel } = req.body || {};
        const apiKey = getKey('DRAMA', channel || 'workflow');

        if (!apiKey) {
            return res.status(500).json({ error: 'VLM_DOUBAO_API_KEY not configured. Add it to .env (火山方舟 DeepSeek)' });
        }

        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: '缺少剧本内容（text）' });
        }

        const durationSec = parseInt(targetDuration, 10) || 90;

        console.log(`[Drama] 智能解析剧本「${title || '未命名'}」，模型 ${DRAMA_MODEL_ID}（集数由 AI 自动判断）`);

        const systemPrompt = `你是资深短剧策划、编剧与美术统筹。
你的任务：分析给定的剧本，一次性完成「拆集规划」和「每集资产识别」。

要求：
1. 根据剧本内容自动判断合适的分集数量：
   - 若剧本中已包含「第X集」「第X回」「第X章」等明确分集标记，请严格按其分集；
   - 否则根据剧情节奏合理拆分。集数控制在 1~${MAX_EPISODES} 集之间。
   每一集需包含：
   - "episode": 集数（从 1 开始）
   - "title": 该集标题（简短、抓人，10 字以内）
   - "summary": 该集剧情概要（2-3 句话，交代发生的事件与情绪）
   - "wordCount": 估算该集正文字数（一个合理数字）
   - "assets": 该集涉及到的资产，分为三类：
       * "characters": 人物（姓名 + 一句话外貌/身份描述）
       * "scenes": 场景（地点名称 + 一句话环境描述）
       * "props": 道具（物品名称 + 一句话说明）
2. 额外输出一份「全局资产清单」"assets"：把全剧所有集涉及的人物、场景、道具分别去重汇总（同一资产只出现一次）。

${title ? `剧目：《${title}》` : ''}
${genre ? `题材：${genre}` : ''}
单集目标时长：${durationSec} 秒（用于控制每集信息量）

剧本全文如下：
"""
${text.trim()}
"""

只输出一个合法 JSON 对象，格式如下（不要输出任何其他文字、不要用 markdown 代码块）：
{
  "totalEpisodes": <实际集数>,
  "episodes": [
    {
      "episode": 1,
      "title": "标题",
      "summary": "剧情概要",
      "wordCount": 2800,
      "assets": {
        "characters": [{ "name": "人物名", "description": "描述" }],
        "scenes": [{ "name": "场景名", "description": "描述" }],
        "props": [{ "name": "道具名", "description": "描述" }]
      }
    }
  ],
  "assets": {
    "characters": [{ "name": "人物名", "description": "描述" }],
    "scenes": [{ "name": "场景名", "description": "描述" }],
    "props": [{ "name": "道具名", "description": "描述" }]
  }
}`;

        const parsed = await callDeepSeek(apiKey, systemPrompt, 8192, channel);

        const rawEpisodes = parsed.episodes || parsed.scenes || parsed;
        if (!Array.isArray(rawEpisodes) || rawEpisodes.length === 0) {
            return res.status(500).json({ error: 'AI 未能产出分集结果，请重试' });
        }

        // 归一化每集数据
        const episodes = rawEpisodes.slice(0, MAX_EPISODES).map((ep, i) => ({
            episode: ep.episode || i + 1,
            title: ep.title || `第 ${i + 1} 集`,
            summary: ep.summary || '',
            wordCount: ep.wordCount || ep.words || 0,
            durationSeconds: ep.durationSeconds || Math.round((ep.wordCount || 2800) / 31),
            assets: {
                characters: dedupeAssets(ep.assets && ep.assets.characters),
                scenes: dedupeAssets(ep.assets && ep.assets.scenes),
                props: dedupeAssets(ep.assets && ep.assets.props),
            },
        }));

        // 全局资产：优先用模型返回的全局清单，再用剧本文本里显式声明的清单兜底（模型常漏项）
        const globalAssets = parsed.assets || {};
        const declaredAll = parseDeclaredAssets(text);
        const assets = {
            characters: mergeDeclaredAssets(
                declaredAll.characters,
                globalAssets.characters || episodes.flatMap((e) => e.assets.characters)
            ),
            scenes: mergeDeclaredAssets(
                declaredAll.scenes,
                globalAssets.scenes || episodes.flatMap((e) => e.assets.scenes)
            ),
            props: mergeDeclaredAssets(
                declaredAll.props,
                globalAssets.props || episodes.flatMap((e) => e.assets.props)
            ),
        };

        console.log(`[Drama] 解析完成：${episodes.length} 集，人物 ${assets.characters.length}，场景 ${assets.scenes.length}，道具 ${assets.props.length}`);

        return res.json({ totalEpisodes: parsed.totalEpisodes || episodes.length, episodes, assets });
    } catch (error) {
        console.error('[Drama] 剧本解析失败:', error);
        res.status(500).json({ error: error.message || '剧本解析失败' });
    }
});

/**
 * POST /api/drama/split-episodes
 * 只做「拆集」，不识别资产——输出量小、速度快，对应向导的「剧本分集」步骤。
 * Body: { text, title?, genre?, targetDuration? }
 * Returns: { totalEpisodes, episodes: [{ episode, title, summary, wordCount, durationSeconds }] }
 */
router.post('/split-episodes', async (req, res) => {
    try {
        const { text, title, genre, targetDuration, preSplit, channel } = req.body || {};
        const apiKey = getKey('DRAMA', channel || 'workflow');

        if (!apiKey) {
            return res.status(500).json({ error: 'VLM_DOUBAO_API_KEY not configured. Add it to .env (火山方舟 DeepSeek)' });
        }
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: '缺少剧本内容（text）' });
        }

        const durationSec = parseInt(targetDuration, 10) || 90;

        // ====================================================================
        // 模式 A：前端已按「第N集」标记把原文切好 —— 只逐批补全标题/概要。
        // 适用于集数多、全文长（如 47 集 / 6 万字），避免一次性输出被截断。
        // ====================================================================
        if (Array.isArray(preSplit) && preSplit.length > 0) {
            const rawList = preSplit.slice(0, MAX_EPISODES);
            console.log(`[Drama] 预切分分集「${title || '未命名'}」：${rawList.length} 集，逐批补全（每批 ${ENRICH_BATCH}）`);

            // 先保证每集基础字段可用（即便 AI 补全失败也能按集查看原文）
            const base = rawList.map((ep, i) => {
                const epNo = Number(ep.episode) || i + 1;
                const content = cleanEpisodeContent(String(ep.content || ''));
                const wc = countChars(content);
                return {
                    episode: epNo,
                    title: `第 ${epNo} 集`,
                    summary: '',
                    wordCount: wc,
                    durationSeconds: Math.max(5, Math.round(wc / 4)),
                    startText: '',
                    content,
                };
            });

            // 分批让 AI 补全 title / summary（不传全文，只传每集节选，输出量小）
            for (let b = 0; b < base.length; b += ENRICH_BATCH) {
                const batchItems = base.slice(b, b + ENRICH_BATCH);
                const listPayload = batchItems
                    .map((ep) => `第${ep.episode}集 节选："""${ep.content.slice(0, 260)}"""`)
                    .join('\n');
                const enrichPrompt = `你是资深短剧策划与编剧。下面给出已按集切好的剧本节选，请为每一集补全「标题」和「剧情概要」。

## 要求
1. 严格按给出的集数与顺序输出，一集对应一条，不得增删、合并或拆分。
2. title：10 字以内、抓人；summary：1~2 句话，概括该集核心事件与冲突。
3. 只依据节选内容生成，不要臆造；节选信息不足时概括也要贴合内容。
4. 只输出合法 JSON，不要 markdown、不要解释。

## 待补全
${listPayload}

## JSON Schema
{ "episodes": [ { "episode": 1, "title": "标题", "summary": "概要" } ] }`;

                try {
                    // eslint-disable-next-line no-await-in-loop
                    const parsed = await callDeepSeek(apiKey, enrichPrompt, 4096, channel);
                    const out = Array.isArray(parsed.episodes) ? parsed.episodes : [];
                    out.forEach((o) => {
                        const target = base.find((e) => Number(e.episode) === Number(o.episode));
                        if (!target) return;
                        if (o.title) target.title = String(o.title);
                        if (o.summary) target.summary = String(o.summary);
                    });
                } catch (e) {
                    // 某一批失败不影响整体：保留该批默认标题/空概要，继续后续批次
                    console.warn(`[Drama] 第 ${Math.floor(b / ENRICH_BATCH) + 1} 批补全失败，保留默认：${e.message}`);
                }
            }

            console.log(`[Drama] 预切分分集完成：${base.length} 集`);
            return res.json({ totalEpisodes: base.length, episodes: base, mode: 'preSplit' });
        }

        // ====================================================================
        // 模式 B：常规一次性自由拆分（集数较少时使用）
        // ====================================================================
        console.log(`[Drama] 智能分集「${title || '未命名'}」，模型 ${DRAMA_MODEL_ID}（集数由 AI 自动判断）`);

        const systemPrompt = `你是资深短剧策划与编剧，负责把剧本拆成单集。

## 任务
根据剧本内容自动判断合适的分集数量（1~${FREE_SPLIT_SOFT_LIMIT} 集）：
- 若剧本中已含「第X集」「第X回」「第X章」等明确分集标记，严格按其拆分；
- 否则按剧情节奏合理拆分。
为每一集生成：标题、剧情概要、正文字数估算、预计时长，并标注该集正文在剧本原文中的起始文字（startText）。

## 输入
${title ? `剧目：《${title}》` : ''}
${genre ? `题材：${genre}` : ''}
单集目标时长：${durationSec} 秒（用于控制每集信息量）

剧本全文如下：
"""
${text.trim()}
"""

## 输出要求（务必严格遵守）
1. 只输出一个合法的 JSON 对象，不要输出任何思考过程、推理步骤、分析或解释性文字。
2. 不要使用 markdown 代码块包裹，不要加任何前缀或后缀说明。
3. 字段名、类型、顺序完全一致，不得新增、遗漏或改名。
4. wordCount、durationSeconds 用数字类型（不要加引号）。
5. startText 必须【逐字摘自剧本原文】，取该集在原文中的起始文字（15~25 个字），用于把原文切分到各集，严禁改写、概括或润色。优先取该集开头的集号 / 集标记（如「《4548》」「第 3 集」）；若没有集标记，再取该集正文的第一句（场景 / 画面 / 台词）。
6. 只依据输入内容生成结果，不得臆造剧本中不存在的信息；确实没有的用空数组 [] 或空字符串 ""。

## JSON Schema
{
  "totalEpisodes": 12,
  "episodes": [
    { "episode": 1, "title": "标题", "summary": "2-3句话的剧情概要", "wordCount": 2800, "durationSeconds": 90, "startText": "该集正文开头连续 15~25 个字（逐字摘自原文）" }
  ]
}

## 稳定输出要求
- 相同输入必须给出相同结果，输出要确定、可复现。
- 标题 10 字以内、抓人；概要 2-3 句话、概括本集核心冲突。`;

        const parsed = await callDeepSeek(apiKey, systemPrompt, 8192, channel);

        const rawEpisodes = Array.isArray(parsed) ? parsed : (parsed.episodes || []);
        if (!Array.isArray(rawEpisodes) || rawEpisodes.length === 0) {
            return res.status(500).json({ error: 'AI 未能产出分集结果，请重试' });
        }

        const episodes = rawEpisodes.slice(0, MAX_EPISODES).map((ep, i) => ({
            episode: ep.episode || i + 1,
            title: ep.title || `第 ${i + 1} 集`,
            summary: ep.summary || '',
            wordCount: ep.wordCount || ep.words || 0,
            durationSeconds: ep.durationSeconds || Math.round((ep.wordCount || 2800) / 31),
            startText: ep.startText || '',
        }));

        // 按起始锚点把剧本原文切分到每一集，并清洗掉剧本前言/多余空行，便于前端按集查看原文
        const contents = sliceEpisodeContents(text.trim(), episodes);
        episodes.forEach((ep, i) => { ep.content = cleanEpisodeContent(contents[i]); });

        console.log(`[Drama] 分集完成：${episodes.length} 集`);
        return res.json({ totalEpisodes: parsed.totalEpisodes || episodes.length, episodes });
    } catch (error) {
        console.error('[Drama] 分集失败:', error);
        res.status(500).json({ error: error.message || '分集失败' });
    }
});

/**
 * POST /api/drama/analyze-assets
 * 基于已确定的分集识别每集资产（人物 / 场景 / 道具），对应向导的「智能解析」步骤。
 * Body: { text?, title?, genre?, episodes: [{ episode, title, summary }] }
 * Returns: { assets: { characters, scenes, props }, episodes: [{ episode, assets }] }
 */
router.post('/analyze-assets', async (req, res) => {
    try {
        const { text, title, genre, episodes, channel } = req.body || {};
        const apiKey = getKey('DRAMA', channel || 'workflow');

        if (!apiKey) {
            return res.status(500).json({ error: 'VLM_DOUBAO_API_KEY not configured. Add it to .env (火山方舟 DeepSeek)' });
        }
        if (!Array.isArray(episodes) || episodes.length === 0) {
            return res.status(400).json({ error: '缺少分集数据（episodes）' });
        }

        /**
         * 每集输入尽量带上「剧本显式清单 + 正文节选」：
         * 只给概要会让模型凭空推断，漏掉剧本里明确列出的人物/场景/道具。
         */
        const declaredByEpisode = episodes.map((ep) => {
            const explicit = parseDeclaredAssets(ep.content || '');
            const sceneMeta = parseSceneMeta(ep.content || '');
            return {
                characters: dedupeAssets([...explicit.characters, ...sceneMeta.characters]),
                scenes: dedupeAssets([...explicit.scenes, ...sceneMeta.scenes]),
                props: explicit.props,
            };
        });
        const episodeList = episodes
            .map((ep, i) => {
                const declared = declaredByEpisode[i];
                const declaredText = [
                    declared.characters.length ? `人物：${declared.characters.map((a) => a.name).join('、')}` : '',
                    declared.scenes.length ? `场景：${declared.scenes.map((a) => a.name).join('、')}` : '',
                    declared.props.length ? `道具：${declared.props.map((a) => a.name).join('、')}` : '',
                ]
                    .filter(Boolean)
                    .join('；');
                // 必须保留换行：场次标题与「出场人物：」要各自独立成行，压成一行模型会读漏
                const body = String(ep.content || '')
                    .replace(/\r\n?/g, '\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim()
                    .slice(0, 2000);
                return [
                    `第${ep.episode}集《${ep.title}》：${ep.summary || ''}`,
                    declaredText ? `  ★本集剧本明确标注的资产清单：${declaredText}` : '',
                    body ? `  正文节选：${body}` : '',
                ]
                    .filter(Boolean)
                    .join('\n');
            })
            .join('\n\n');

        /**
         * 剧本前言：含故事梗概与人物小传。
         * 分集 content 已被 cleanEpisodeContent 清洗掉前言，但人物设定恰恰在里面，
         * 因此从原始全文单独抽取，作为角色 bio 的权威依据喂给模型。
         */
        const preamble = extractPreamble(text || '');

        console.log(`[Drama] 资产识别「${title || '未命名'}」，${episodes.length} 集，前言 ${preamble.length} 字，模型 ${DRAMA_MODEL_ID}`);

        const systemPrompt = `你是短剧美术统筹，负责根据已拆好的分集识别每集资产。

## 任务
资产分三类：
- characters：人物（姓名 + 外貌/身份描述 + 人物小传 + 视觉特征）
- scenes：场景（地点名称 + 环境描述）
- props：道具（物品名称 + 一句话说明）

## 输入
${title ? `剧目：《${title}》` : ''}
${genre ? `题材：${genre}` : ''}
${preamble ? `
## 剧本前言（含故事梗概与人物小传，是角色设定的权威依据）
"""
${preamble}
"""
` : ''}
已拆好的分集如下：
${episodeList}

## 资产识别铁律（务必遵守）
1. 若某集带有「★本集剧本明确标注的资产清单」，清单中的每一项都必须出现在该集对应类别里，一项都不能少、不能合并、不能改名。
2. 清单中「陈海英（女）」这类括号备注是性别/身份，请保留姓名「陈海英」，括号内容写进 description。
3. 清单之外，正文节选里出现的人物、场景、道具也要补充识别。
4. 道具（props）极容易被遗漏，务必逐集排查正文中的每一个具体物件：信物、武器、钱财、饮食、工具、书信、法宝、日常用具等，凡有名称、推动或参与剧情的物件都要列入 props，不要只识别人物与场景。
5. 某集没有某类资产时，该类返回空数组 []，不要用其他集的资产填充。
6. 正文每一场开头都有「出场人物：A、B、C」，这是该场的权威名单：名单里的每一项都必须出现在本集 characters 里，一个都不能少。「供货商若干」「候车旅客若干」「乡亲若干」这类群演同样要列入，不要自行省略、合并或改名。
7. 场次标题「1-1，县城·长途汽车站候车厅，日，内」里的地点，必须出现在本集 scenes 里，并把时间（日/夜）与内外景（内/外）写进 description，例如「日·内」。
8. 必须读完该集全部场次再回答：只要剧本里出现过、且有一句台词或一个动作的人名，都要进 characters，不要只识别前几场就收尾。

## 人物专属要求（characters 必填 bio / visual / voiceName / aliases）
每个人物除 name / description 外，还必须输出四个字段：

### aliases：别名与称呼
- 数组，列出剧本里**明确指代同一个人的其他称呼**：小名、外号、排行称呼、职业称呼。
- 例如人物小传写「赵磊（石头）」时，aliases 为 ["石头"]；「赵叔（赵建国）」为 ["赵建国"]。
- 用途：台词的说话人可能写成别名，靠 aliases 才能把台词与本人对上并套用同一条音色。
- 只放能从原文确认指向本人的称呼，不确定就不写，没有写 []。

### bio：人物小传
- 100~200 字，交代这个人的**身份、年龄、处境、性格、核心欲望与命运感**，用于展示给用户阅读。
- 只写这个人**本身**，不要写剧情事件流水账，不要罗列他做过什么事。
- 优先依据「剧本前言」里的人物小传改写；前言没有该人物时，依据正文节选合理推断。
- 语气平实具体，像人物设定卡，不要空话套话。

### visual：视觉特征（生图专用）
- 一段 60~120 字的**纯外貌描述**，只写画面上能看见的东西：
  年龄段、性别、身高体型、脸型五官、肤色肤质、发型发色与长度、服装款式与材质颜色、鞋帽配饰、手部特征、以及整体气质（如疲惫、精明、朴实、凌厉）。
- **严禁出现剧情信息**：不得出现人物关系、债务、疾病、情绪事件、地点、动作、道具、职业称呼以外的剧情名词。
- 这些内容会直接拼进生图提示词，任何剧情元素都会让画面跑偏（例如写「久病缠身的丈夫」会让模型画出病床）。

### voiceName：角色音色（从下列清单中选一个 id）
可选的音色 id 与适用场景：
${voiceCatalogForPrompt()}

选择规则：
- 只填 id（如 bright-female），**不要填中文名**，不要自造 id。
- 性别必须与 bio 一致；12 岁以下用 child，十几岁男性用 young-male。
- 结合 bio 的年龄、性格、身份挑最贴合的：掌权者/反派/中年男性偏 calm-male，母亲/成熟女性偏 gentle-female，活泼年轻女性偏 bright-female。
- 同一角色在**所有分集**里必须给出完全相同的 voiceName。
- 群演类角色（如「乡亲若干」「供货商若干」）同样要给 voiceName，按这一群人的主要性别与年龄选。

### 群演类角色（名字里带「若干」）
这类角色是群体，也必须完整输出 bio / visual / voiceName，但可以简写：
- bio：20~40 字交代这群人的身份与当下状态，例如「胡万金长期拖欠货款的供货商，被逼急了，堵在检票口讨说法」。
- visual：20~40 字写群体外观，例如「三四十岁男性居多，穿旧夹克与工装，神色焦虑」。
- 目的是让这一场有人可画、有音可配，不要因为「不是主角」就整条省略。

## 输出要求（务必严格遵守）
1. 只输出一个合法的 JSON 对象，不要输出任何思考过程、推理步骤、分析或解释性文字。
2. 不要使用 markdown 代码块包裹，不要加任何前缀或后缀说明。
3. 字段名、类型、顺序完全一致，不得新增、遗漏或改名。
4. 没有资产时用空数组 []。

## JSON Schema
{
  "episodes": [
    { "episode": 1, "assets": { "characters": [{ "name": "人物名", "aliases": ["别名"], "description": "一句话身份/外貌", "bio": "人物小传", "visual": "视觉特征", "voiceName": "音色id" }], "scenes": [], "props": [] } }
  ],
  "assets": { "characters": [], "scenes": [], "props": [] }
}

## 稳定输出要求
- 相同输入必须给出相同结果。
- 同名资产只出现一次（人物/场景/道具各自去重），名称保持中文原样。
- 全局 assets.characters 里每个人物同样要带 bio、visual 与 voiceName。`;

        const parsed = await callDeepSeek(apiKey, systemPrompt, 8192, channel);

        const rawEps = Array.isArray(parsed.episodes) ? parsed.episodes : [];
        const episodesOut = episodes.map((ep, i) => {
            const matched = rawEps.find((r) => Number(r.episode) === Number(ep.episode)) || {};
            // 模型可能漏项：把剧本显式清单强制合并回来，保证「资产确认」与剧本文本一致
            const declared = declaredByEpisode[i];
            return {
                episode: ep.episode,
                assets: {
                    characters: mergeDeclaredAssets(declared.characters, matched.assets && matched.assets.characters),
                    scenes: mergeDeclaredAssets(declared.scenes, matched.assets && matched.assets.scenes),
                    props: mergeDeclaredAssets(declared.props, matched.assets && matched.assets.props),
                },
            };
        });

        // 全局资产：优先用模型返回的全局清单，同样用剧本显式清单兜底
        const globalAssets = parsed.assets || {};
        const declaredAll = declaredByEpisode.reduce(
            (acc, d) => ({
                characters: [...acc.characters, ...d.characters],
                scenes: [...acc.scenes, ...d.scenes],
                props: [...acc.props, ...d.props],
            }),
            { characters: [], scenes: [], props: [] }
        );
        const assets = {
            characters: backfillCharacterDetails(
                mergeDeclaredAssets(
                    declaredAll.characters,
                    globalAssets.characters || episodesOut.flatMap((e) => e.assets.characters)
                ),
                episodesOut.map((e) => e.assets.characters)
            ),
            scenes: mergeDeclaredAssets(
                declaredAll.scenes,
                globalAssets.scenes || episodesOut.flatMap((e) => e.assets.scenes)
            ),
            props: mergeDeclaredAssets(
                declaredAll.props,
                globalAssets.props || episodesOut.flatMap((e) => e.assets.props)
            ),
        };

        // 音色归一化：AI 给的合法就用，缺失或非法按人物信息兜底
        episodesOut.forEach((ep) => normalizeCharacterVoices(ep.assets.characters));
        normalizeCharacterVoices(assets.characters);

        console.log(`[Drama] 资产识别完成：人物 ${assets.characters.length}，场景 ${assets.scenes.length}，道具 ${assets.props.length}`);
        return res.json({ assets, episodes: episodesOut });
    } catch (error) {
        console.error('[Drama] 资产识别失败:', error);
        res.status(500).json({ error: error.message || '资产识别失败' });
    }
});

/**
 * POST /api/drama/assign-voices
 * 批量为角色分配音色（纯文本决策，不需要 TTS 授权）。
 * Body: { characters: [{ name, description?, bio? }], channel? }
 * Returns: { voices: [{ name, voiceName, label }], aiUsed }
 */
router.post('/assign-voices', async (req, res) => {
    try {
        const { characters, channel } = req.body || {};
        if (!Array.isArray(characters) || characters.length === 0) {
            return res.status(400).json({ error: '缺少角色列表（characters）' });
        }

        const apiKey = getKey('DRAMA', channel || 'workflow');
        const list = characters
            .filter((c) => c && String(c.name || '').trim())
            .slice(0, 80)
            .map((c) => ({
                name: String(c.name).trim(),
                description: String(c.description || '').slice(0, 200),
                bio: String(c.bio || '').slice(0, 400),
            }));

        let picked = new Map();
        if (apiKey) {
            const profile = list
                .map((c, i) => `${i + 1}. 姓名：${c.name}\n   简介：${c.description || '（无）'}\n   小传：${c.bio || '（无）'}`)
                .join('\n');

            const systemPrompt = `你是影视剧配音选角导演。请为每个角色从下面的固定音色清单中选择最贴合的一个。

可用音色：
${voiceCatalogForPrompt()}

选择规则：
1. 只填 id（如 bright-female），不要填中文名，不要自造 id。
2. 性别必须一致；12 岁以下用 child；十几岁男性用 young-male。
3. 结合年龄、性格、身份：掌权者 / 反派 / 中年男性偏 calm-male；母亲 / 成熟女性偏 gentle-female；
   活泼年轻女性偏 bright-female；通用旁白感偏 narrator-xiaomei / narrator-xiaojun。

角色列表：
${profile}

只输出一个 JSON 对象，不要任何解释：
{ "voices": [{ "name": "角色名", "voiceName": "音色id" }] }`;

            try {
                const parsed = await callDeepSeek(apiKey, systemPrompt, 2048, channel);
                const arr = Array.isArray(parsed && parsed.voices) ? parsed.voices : [];
                picked = new Map(arr.map((v) => [String((v && v.name) || '').trim(), v && v.voiceName]));
            } catch (error) {
                // 模型失败不应该让整个操作失败：下面还有规则兜底
                console.warn('[Drama] AI 分配音色失败，改用规则推断:', error.message);
            }
        }

        const voices = list.map((c) => {
            const hit = findVoice(picked.get(c.name));
            const voiceName = hit ? hit.id : inferVoiceId(c);
            const label = findVoice(voiceName);
            return { name: c.name, voiceName, label: label ? label.name : voiceName };
        });

        console.log(`[Drama] 分配音色完成：${voices.length} 个角色，AI 命中 ${picked.size} 个`);
        res.json({ voices, aiUsed: picked.size > 0 });
    } catch (error) {
        console.error('[Drama] 分配音色失败:', error);
        res.status(500).json({ error: error.message || '分配音色失败' });
    }
});

/**
 * POST /api/drama/split-shots
 * 把单集剧本拆成「分镜（片段）」，供工作流「片段编辑 / 视频生成」步骤使用。
 * Body: {
 *   episode: { episode, title, summary, content },  // content 可选，缺失时用 summary
 *   characters?: string[],                          // 该集人物名（保证分镜中人物一致）
 *   style?: string,                                 // 画面风格（影视/动画等）
 *   aspectRatio?: string,
 *   targetDuration?: number                         // 单集目标时长（秒）
 * }
 * Returns: { shots: [{ shotNumber, description, cameraAngle, cameraMovement, lighting, mood, durationSeconds, prompt }] }
 */
router.post('/split-shots', async (req, res) => {
    try {
        const { episode, characters, style, aspectRatio, targetDuration, channel } = req.body || {};
        const apiKey = getKey('DRAMA', channel || 'workflow');

        if (!apiKey) {
            return res.status(500).json({ error: 'VLM_DOUBAO_API_KEY not configured. Add it to .env (火山方舟 DeepSeek)' });
        }
        if (!episode) {
            return res.status(400).json({ error: '缺少分集数据（episode）' });
        }

        const text = String(episode.content || '').trim() || String(episode.summary || '').trim();
        if (!text) {
            return res.status(400).json({ error: '该集没有可用的剧本内容，无法拆分镜' });
        }

        const charList = Array.isArray(characters) && characters.length > 0
            ? characters.filter(Boolean).join('、')
            : '（未提供，按剧本中出现的称呼）';

        // 场景数：先探测这份剧本实际用哪种场景标题写法，再按它统计
        const formatProfile = detectScriptFormat(text);
        const sceneCount = countScenes(text, formatProfile);
        console.log(
            `[Drama] 剧本格式探测：${formatProfile.sceneHead.label} ｜ 示例「${formatProfile.sceneHead.example || '-'}」｜ 命中 ${formatProfile.sceneHead.hits} 处`
        );

        /**
         * 片段数由「场景」决定，而不是由「时长 ÷ 10 秒」反推。
         *
         * 标准剧本一集 3~4 场，若按 90÷10=9 个片段再跨场分配，
         * 必然出现「一场只分到 1~2 个片段、大量 △ 动作被压掉」的问题。
         * 改为每场 3~6 个片段，片段只在本场内部拆分，不跨场。
         */
        const epTargetSec = parseInt(targetDuration, 10) || 90;
        const targetShotCount = sceneCount > 0
            ? sceneCount * 4
            : Math.max(4, Math.min(30, Math.ceil(epTargetSec / 10)));
        const minShots = sceneCount > 0 ? sceneCount * 3 : Math.max(3, targetShotCount - 2);
        const maxShots = sceneCount > 0 ? Math.min(60, sceneCount * 6) : Math.min(30, targetShotCount + 2);

        console.log(
            `[Drama] 拆分镜 第${episode.episode}集《${episode.title || ''}》，${sceneCount} 个场景，目标 ${minShots}~${maxShots} 个片段，模型 ${DRAMA_MODEL_ID}`
        );

        const systemPrompt = `你是资深短剧分镜师、摄影指导与 AI 视频提示词专家，负责把单集剧本拆成可直接用于 AI 视频生成的「分镜清单」。

## 任务
${sceneCount > 0
                ? `本集共 ${sceneCount} 个场景。场景标题可能是「1-1，地点，日，内」，也可能是「场景1：地点，日，内」「第1场 地点 日 内」「场景：地点，日，内」这类写法，都按场景边界处理。请按「场景 → 片段」两层拆分：每个场景拆成 3~6 个片段（内容少的场景 3 个，内容多的场景最多 6 个），全集合计 ${minShots}~${maxShots} 个片段。`
                : `把本集拆成约 ${targetShotCount} 个片段（允许 ${minShots}~${maxShots} 个）。`}
每个片段是一段 5~10 秒的连续镜头。

## 单集信息
第${episode.episode}集《${episode.title || ''}》
单集目标时长：约 ${epTargetSec} 秒
${aspectRatio ? `画幅：${aspectRatio}` : ''}
${style ? `画面风格：${style}` : '画面风格：写实影视'}
本集出场人物：${charList}

## 单集剧本
"""
${text.slice(0, 6000)}
"""

## 拆分原则（务必遵守）
1. 场景是硬边界：以「1-1，地点，日，内」这类场次标题划分场景，一个片段只能属于一个场景，严禁跨场景合并。
2. 每个场景拆 3~6 个片段，6 个是上限：只有一两个动作的短场景也要有 3 个（用不同机位撑起来，如全景交代环境 + 中景演动作 + 特写收情绪）；动作与对白密集的长场景 6 个。台词再多也不许超过 6 个，靠提高单个片段的台词容量来容纳，而不是继续加片段。
3. 一个片段 = 一个完整的动作节拍，或一组连续对话（1~3 句台词），时长 5~10 秒。
4. 场景里的每个 △ 动作行都要有归属片段，不要因为「不重要」整段丢掉；相邻的短动作可以合并，但不能把一整场压成一两个片段。
5. 按剧情顺序拆分，片段之间画面递进、彼此连贯，不要重复同一画面。
6. 景别与机位要像真实拍摄一样有目的的变化（远景 / 全景 / 中景 / 近景 / 特写 / 过肩镜头等），避免连续多个片段景别雷同。
7. 提到人物时必须使用其姓名（如「苏云养」），不要用「他/她」这类指代，并保持人物形象与服装前后一致。
8. 画面里出现道具（笔、账本、现金、手机、行李箱等）时，必须写清是谁拿着、在看或在递，并写出人物姓名。不要写成只有道具的空镜——否则后期只能匹配到道具参考图，角色参考图接不上，人物长相会跑。

## 剧本格式说明（本剧本的实际写法已自动识别）
${describeFormat(formatProfile) ? `本次剧本实测格式：${describeFormat(formatProfile)}。以下为通用规则，若与实测格式冲突，以实测格式为准。` : ''}

- 场次标题：写法有很多种，都要认——
  「1-1，县城·长途汽车站候车厅，日，内」「1.1 县城车站 日 内」（场号式）；
  「场景1：县城车站，日，内」「场景一、县城车站，夜，外」（场景编号式）；
  「第1场 县城车站 日 内」（第N场式）；
  「场景：县城车站，日，内」，甚至只写「场景」两个字另起一行（无编号式）。
  只要出现这类行，就是场景边界，其后到下一个场景标题之间属于同一场景。
- 出场人物：「出场人物：胡万金、小马、老朱」= 本场出场角色；台词里的角色必须出自这里（群演除外）。
- 动作行：以「△」开头，是纯画面描述，**不是台词**，绝不能塞进 dialogues。
- 台词行：「小马：胡总，账，还没清呢。」或「胡万金（挤出笑）：小马，你听我说」。角色名后、冒号前括号里的是表演提示。
- 画外音：「赵磊（OS）：我不是冲人。」OS 表示内心独白或画外旁白。

## 台词提取规则（本任务的重中之重）
1. 每条台词必须【逐字摘自原文的台词行】，只去掉「角色名：」与括号里的表演提示；严禁改写、缩写、润色、合并、翻译、补写。
2. 全集的台词必须一条不漏地分配到各分镜的 dialogues 里。宁可多拆几个分镜，也绝不能丢台词。
3. 一个片段通常承担 1~3 条台词；对白很密的场景，一个片段可以容纳 3~5 句短对话（同一场景同一段连续对话）。台词要全，但场景内的片段数仍受 3~6 限制。
4. 括号里的表演提示（如「压低声音」「挤出笑」）写进 tone，不要写进 text。
5. OS 台词把 isVoiceOver 写为 true，其余为 false。
6. dialogues 的 role 用标准姓名，与「出场人物」保持一致；原文出现别名（如「石头」）时，按人物小传还原成标准姓名。
7. 纯动作、空镜、字幕类分镜，dialogues 填空数组 []。

## 每个分镜的内容要求
- "sceneNumber"：该分镜所属场景的标识。原文有场号就照抄（如 "1-1"、"场景1"、"第1场"）；原文只写「场景」而没编号时，按出现顺序自行编号为 "场景1"、"场景2"…，保证不同场景的标识互不相同。
- "location"：场次标题里的地点，如「县城·长途汽车站候车厅」。
- "timeOfDay"：日 / 夜 / 傍晚 等，取自场次标题。
- "interiorExterior"：内 或 外，取自场次标题。
- "characters"：本分镜实际出镜的角色姓名数组，从「出场人物」里挑，不要写群演。
- "blocking"：本镜头的人物站位与调度，一句话写清谁在画面哪一侧、面向谁、相距多远、有没有遮挡或过肩关系。例如「老钱在画面左侧、侧身面向右前方；老周从画面右侧入画，两人相距约一臂，构成过肩关系」。用镜头关系与遮挡关系表达调度，不要写「左边三米」这类坐标；单人镜头写人物与镜头的关系（正面/侧身/背对，靠墙/站门口）。没有人物时留空字符串。
- "dialogues"：本分镜的台词数组，结构见 JSON Schema。
- "description"：2~3 句，写清【画面主体 + 人物具体动作/表情 + 环境氛围】，可直接朗读成画面。
- "prompt"：必须是结构完整、专业的 AI 视频提示词，按以下顺序组织成一段：
  场景环境（时间/地点）→ 人物（姓名、外貌、服装、表情）→ 关键动作与表演 → 景别与运镜 → 光线色调 → 情绪氛围 → 画面风格。
  语言具体、可视化，避免抽象空泛的形容词堆砌。
  有台词的镜头，prompt 里要写清人物正在开口说话、与谁对视交流，让人物有对话表演。

## 转场设计（transitionOut）
每个镜头除第 1 个外，都要声明「从上一镜头切到本镜头」用的转场。
必须从下列 id 中选一个，不要自创：
- fade（淡入淡出）：最通用，叙事连贯、时间平缓推进时用
- fadeblack（黑场过渡）：时间跳跃、段落分隔、场景大转换时用
- fadewhite（白场过渡）：闪回、回忆、梦境进入时用
- dissolve（溶解）：同一场景内时间小幅流逝时用
- wipeleft / wiperight / wipeup / wipedown（擦除）：有明确方向感的推进时用
- slideleft / slideright / slideup / slidedown（滑动）：节奏较快、动作衔接时用
- circleopen / circleclose（圆形开合）：聚焦或收束到某个主体时用
- radial（径向擦除）：强调冲击、转折时用
- pixelize（像素化）：幻觉、记忆模糊、失真时用
- none（硬切）：同一场景内连续对话或连续动作，不需要任何过渡时用

选择原则：
1. 同一场景内的连续镜头优先用 none 或 dissolve，避免每个镜头都做花哨转场；
2. 一集内花哨转场（wipe/slide/circle/radial/pixelize）合计不超过 3 处；
3. 第 1 个镜头的 transitionOut 固定填 "none"。

## 输出要求（务必严格遵守）
1. 只输出一个合法 JSON 对象，不要输出任何思考过程、推理步骤、解释性文字。
2. 不要使用 markdown 代码块包裹，不要加任何前缀或后缀。
3. 字段名、类型完全一致，不得新增、遗漏或改名。
4. durationSeconds 只能填 5 或 10。
5. transitionOut 只能取上面列出的 id 之一。
6. dialogues[].text 必须能在原文台词里逐字找到，不得出现原文没有的台词。
7. 没有台词的分镜写 "dialogues": []，不要为了凑数编造。
8. characters、location、sceneNumber 必须来自原文，不要臆造。

## JSON Schema
{
  "shots": [
    {
      "shotNumber": 1,
      "sceneNumber": "1-1",
      "location": "县城·长途汽车站候车厅",
      "timeOfDay": "日",
      "interiorExterior": "内",
      "characters": ["胡万金", "小马"],
      "blocking": "小马在画面左侧、正面朝向胡万金；胡万金在右侧、微微后仰，两人相距一臂，中景过肩",
      "dialogues": [
        { "role": "小马", "text": "胡总，账，还没清呢。", "tone": "压低声音", "isVoiceOver": false }
      ],
      "description": "画面描述（2~3 句，含人物动作与环境氛围）",
      "cameraAngle": "远景/全景/中景/近景/特写/过肩镜头 等",
      "cameraMovement": "固定/推/拉/摇/跟/升降 等",
      "lighting": "光线与色调描述",
      "mood": "情绪基调",
      "durationSeconds": 10,
      "transitionOut": "fade",
      "prompt": "按 场景→人物→动作→景别运镜→光线→氛围→风格 组织的完整 AI 视频提示词"
    }
  ]
}`;

        const parsed = await callDeepSeek(apiKey, systemPrompt, 8192, channel);
        const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];

        // 合法转场 id 白名单，AI 返回非法值时回退到 fade（第 1 个镜头强制 none）
        const VALID_SHOT_TRANSITIONS = new Set([
            'fade', 'fadeblack', 'fadewhite', 'dissolve',
            'wipeleft', 'wiperight', 'wipeup', 'wipedown',
            'slideleft', 'slideright', 'slideup', 'slidedown',
            'circleopen', 'circleclose', 'radial', 'pixelize', 'none',
        ]);

        /**
         * 清洗模型返回的台词。
         * 台词是配音与音色链路的唯一文本来源，脏数据会一路带到成片，所以这里兜住三件事：
         *   1. 台词本体剥离「角色名（提示）：」前缀与首尾引号；
         *   2. 括号里的表演提示落到 tone，不混进要朗读的文本；
         *   3. OS / 画外 / 内心独白标记为 isVoiceOver。
         */
        const normalizeDialogues = (raw) => {
            if (!Array.isArray(raw)) return [];
            const out = [];
            for (const item of raw) {
                if (!item) continue;
                let text = String(item.text ?? item.line ?? item.content ?? '').trim();
                if (!text) continue;
                const role = String(item.role ?? item.character ?? item.speaker ?? '').trim() || '旁白';
                let tone = String(item.tone ?? item.actionHint ?? '').trim();

                // 只在「前缀确实是这个角色」时剥离，避免把台词正文里的冒号误伤
                const prefix = text.match(/^([^，。！？、\s：:（(]{1,12})(?:[（(]([^）)]*)[）)])?[：:]\s*(.+)$/);
                if (prefix && (prefix[1] === role || role.includes(prefix[1]) || prefix[1].includes(role))) {
                    if (!tone && prefix[2]) tone = prefix[2].trim();
                    text = prefix[3].trim();
                }

                text = text.replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/g, '').trim();
                if (!text) continue;

                const flag = String(item.isVoiceOver ?? item.type ?? '').toLowerCase();
                out.push({
                    role,
                    text,
                    tone: tone || undefined,
                    isVoiceOver: item.isVoiceOver === true || /os|画外|旁白|内心/.test(flag),
                });
            }
            return out;
        };

        // 模型偶尔漏填 sceneNumber：继承上一个片段，避免同一场景被拆成「有编号 + 无编号」两组
        let lastSceneNumber = '';
        const shots = rawShots
            .map((s, i) => {
                const sceneNumber = String(s.sceneNumber || '').trim() || lastSceneNumber;
                lastSceneNumber = sceneNumber;
                return {
                shotNumber: Number(s.shotNumber) || i + 1,
                // 场景信息：视频生成与成片字幕都要用，缺失时继承上一个片段
                sceneNumber,
                location: String(s.location || '').trim(),
                timeOfDay: String(s.timeOfDay || '').trim(),
                interiorExterior: String(s.interiorExterior || '').trim(),
                characters: Array.isArray(s.characters)
                    ? s.characters.map((c) => String(c || '').trim()).filter(Boolean)
                    : [],
                // 站位调度：视频提示词靠它把人物放进画面，缺了就退化成「各演各的」
                blocking: String(s.blocking || '').trim(),
                dialogues: normalizeDialogues(s.dialogues),
                description: String(s.description || s.prompt || '').trim(),
                cameraAngle: String(s.cameraAngle || '').trim(),
                cameraMovement: String(s.cameraMovement || '').trim(),
                lighting: String(s.lighting || '').trim(),
                mood: String(s.mood || '').trim(),
                // 仅允许 5 / 10；无法识别时默认 10（用长镜头减少碎片）
                durationSeconds: Number(s.durationSeconds) <= 5 ? 5 : 10,
                // 转场：AI 建议值，非法时回退 fade
                transitionOut: (() => {
                    const t = String(s.transitionOut || '').trim().toLowerCase();
                    return VALID_SHOT_TRANSITIONS.has(t) ? t : 'fade';
                })(),
                prompt: String(s.prompt || s.description || '').trim(),
                };
            })
            // 只保留真正有内容的镜头：有画面描述，或带台词（纯台词镜头也不能丢）
            .filter((s) => s.description || s.dialogues.length > 0)
            .slice(0, maxShots)
            .map((s, i) => ({
                ...s,
                shotNumber: i + 1,
                // 第 1 个镜头前面没有镜头，转场无意义
                transitionOut: i === 0 ? 'none' : s.transitionOut,
            }));

        if (shots.length === 0) {
            return res.status(500).json({ error: 'AI 未返回有效分镜，请重试' });
        }

        /**
         * 台词兜底补漏。
         *
         * 模型偶尔会漏掉一两句台词，而台词只要丢一句，成片就少一句对白，
         * 而且这种缺失在界面上很难被发现。所以这里以「原文台词行」为基准做差集：
         * 逐行解出角色:台词的句子，凡是模型没提取到的，补回它所属场次的最后一个镜头。
         */
        const rawDialogues = [];
        let currentScene = '';
        const textLines = text.split(/\r?\n/);
        const sceneResolve = makeSceneResolver(textLines, formatProfile);
        for (let lineIndex = 0; lineIndex < textLines.length; lineIndex++) {
            const t = textLines[lineIndex].trim();
            if (!t) continue;
            // 场次标题不是台词（写法由 formatProfile 决定），漏判会把标题抓成一句假台词
            const head = sceneResolve(lineIndex);
            if (head) {
                currentScene = head.id;
                continue;
            }
            // 动作行与出场人物不是台词
            if (t.startsWith('△') || t.startsWith('出场人物')) continue;
            const m = t.match(/^([^：:（(]{1,12})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/);
            if (!m) continue;
            const hint = (m[2] || '').trim();
            const isOS = /^os$/i.test(hint);
            rawDialogues.push({
                scene: currentScene,
                role: m[1].trim(),
                text: m[3].trim(),
                tone: isOS ? '' : hint,
                isVoiceOver: isOS,
            });
        }

        // 标点与空白归一化后再比对，避免模型只改了标点就被当成漏句
        const normalizeForCompare = (s) => String(s || '').replace(/[\s，。！？、；：—…"'“”‘’（）()]/g, '');
        const extractedKeys = shots.flatMap((s) => s.dialogues || []).map((d) => normalizeForCompare(d.text));
        const isCovered = (rawText) => {
            const key = normalizeForCompare(rawText);
            if (!key) return true;
            const probe = key.slice(0, 12);
            return extractedKeys.some((e) => e.includes(probe) || key.includes(e.slice(0, 12)));
        };

        let patchedDialogues = 0;
        for (const item of rawDialogues) {
            if (isCovered(item.text)) continue;
            const sameScene = shots.filter((s) => s.sceneNumber === item.scene);
            const target = sameScene.length > 0 ? sameScene[sameScene.length - 1] : shots[shots.length - 1];
            target.dialogues.push({
                role: item.role,
                text: item.text,
                tone: item.tone || undefined,
                isVoiceOver: item.isVoiceOver,
            });
            patchedDialogues += 1;
        }
        if (patchedDialogues > 0) {
            console.log(`[Drama] 台词补漏：补回 ${patchedDialogues} 条模型遗漏的台词`);
        }

        const dialogueCount = shots.reduce((n, s) => n + s.dialogues.length, 0);
        console.log(
            `[Drama] 拆分镜完成：第${episode.episode}集共 ${shots.length} 个分镜、${dialogueCount} 条台词`
        );
        if (dialogueCount === 0) {
            console.warn('[Drama] 本集未提取到任何台词，请检查剧本格式是否包含「角色：台词」行');
        }
        return res.json({ shots });
    } catch (error) {
        console.error('[Drama] 拆分镜失败:', error);
        res.status(500).json({ error: error.message || '拆分镜失败' });
    }
});

export default router;
