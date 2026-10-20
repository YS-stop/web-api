/**
 * scriptFormat.js
 *
 * 剧本格式自适应。
 *
 * 问题：不同编剧写场景的写法差别很大——
 *   1-1，县城·长途汽车站候车厅，日，内
 *   1.1 县城车站 日 内
 *   场景1：县城车站，日，内
 *   第1场 县城车站 日 内
 *   场景：县城车站，日，内
 *   甚至完全没有场景标题，只靠「出场人物：」分场。
 *
 * 做法：先对全文采样，判断这份剧本实际用哪种写法（显式标题打分 + 无标题时
 * 用「出场人物」上方的短行兜底），再据此生成场景边界判定器。
 * 这样新增一种写法不需要改解析代码，探不到也能靠「出场人物」兜住。
 */

// ============================================================================
// 基础特征
// ============================================================================

/** 出场人物行：「出场人物：A、B、C」 */
export const CAST_LINE_RE = /^\s*(?:出场人物|本场人物|人物|角色)\s*[:：]\s*(.+)$/;

/** 动作行前缀：△ ○ ● ▲ 等 */
export const ACTION_LINE_RE = /^\s*([△▲○●◇◆·•])\s*/;

/** 集标题行：第1集 / 第1章 / EP01 / Episode 1 */
export const EPISODE_HEAD_RE = /^\s*(?:第\s*[\d一二三四五六七八九十百零]+\s*[集章回节]|EP\s*\d+|Episode\s*\d+)\b/i;

/** 台词行：「角色：台词」「角色（提示）：台词」 */
export const DIALOGUE_LINE_RE = /^([^：:（(]{1,12})(?:[（(]([^）)]*)[）)])?\s*[：:]\s*(.+)$/;

/**
 * 显式场景标题候选。
 * 只是「候选」，最终用哪个由 detectScriptFormat 按实际命中数决定。
 */
const EXPLICIT_SCENE_PATTERNS = [
    { id: 'number-dash', label: '场号式（1-1）', re: /^(\d+\s*[-－—–.]\s*\d+)\s*[，,、:：]?\s*(.*)$/ },
    {
        id: 'scene-number',
        label: '场景编号式（场景1：）',
        re: /^((?:场景|场次)\s*[\d一二三四五六七八九十百零]+)\s*[：:，,、]?\s*(.*)$/,
    },
    {
        id: 'di-chang',
        label: '第N场式（第1场）',
        re: /^(第\s*[\d一二三四五六七八九十百零]+\s*[场幕])\s*[：:，,、]?\s*(.*)$/,
    },
    { id: 'scene-only', label: '场景式（场景：地点）', re: /^(场景|场次)\s*[：:，,、]\s*(.*)$/ },
    { id: 'english', label: '英文式（INT./EXT.）', re: /^((?:INT|EXT)\s*[.．]?)\s*(.*)$/i },
];

const normalizeLines = (raw) => String(raw || '').replace(/\r\n?/g, '\n').split('\n');

// ============================================================================
// 探测
// ============================================================================

/**
 * 无显式场号时，从「出场人物：」上方一行归纳场景标题形态。
 *
 * 例如：
 *   县城·长途汽车站候车厅，日，内
 *   出场人物：胡万金、小马
 * 就认为「地点，日，内」这一行是场景标题。
 */
function inferImplicitScene(labels) {
    const samples = [];
    for (let i = 0; i < labels.length; i++) {
        if (!CAST_LINE_RE.test(labels[i])) continue;
        let j = i - 1;
        while (j >= 0 && !labels[j].trim()) j--;
        if (j < 0) continue;
        const prev = labels[j].trim();
        if (!prev || prev.length > 40) continue;
        if (ACTION_LINE_RE.test(prev) || CAST_LINE_RE.test(prev) || EPISODE_HEAD_RE.test(prev)) continue;
        samples.push(prev);
    }
    if (samples.length < 2) return null;

    // 归纳形状：数字 → \d+，拉丁字母 → [A-Za-z]+，即可跨集复用
    const shapes = samples
        .map((s) => String(s).split(/[，,、:：]/)[0].trim())
        .map((head) => head.replace(/\d+/g, '\\d+').replace(/[A-Za-z]+/g, '[A-Za-z]+'))
        .filter(Boolean);
    const uniq = [...new Set(shapes)];
    if (uniq.length === 0 || uniq.length > 8) return null;

    return {
        id: 'implicit',
        label: '无显式场号（以「出场人物」行分场）',
        source: `^(${uniq.join('|')})\\s*[，,、:：]?\\s*(.*)$`,
        example: samples[0],
        hits: samples.length,
    };
}

/** 统计各显式候选的命中数，选中命中最多的那个 */
function pickExplicitScene(labels) {
    let best = null;
    for (const cand of EXPLICIT_SCENE_PATTERNS) {
        let hits = 0;
        let example = '';
        for (const raw of labels) {
            const line = raw.trim();
            if (!line || line.length > 80) continue;
            if (!cand.re.test(line)) continue;
            hits += 1;
            if (!example) example = line;
        }
        if (hits > 0 && (!best || hits > best.hits)) {
            best = { id: cand.id, label: cand.label, source: cand.re.source, example, hits };
        }
    }
    return best;
}

/** 探测动作行前缀（△ / ○ / 无） */
function detectActionPrefix(labels) {
    const counter = new Map();
    for (const raw of labels) {
        const m = raw.trim().match(ACTION_LINE_RE);
        if (!m) continue;
        counter.set(m[1], (counter.get(m[1]) || 0) + 1);
    }
    let best = '';
    let bestHits = 0;
    for (const [prefix, hits] of counter) {
        if (hits > bestHits) {
            best = prefix;
            bestHits = hits;
        }
    }
    return { prefix: best, hits: bestHits };
}

/**
 * 探测整份剧本的格式。
 *
 * @param {string} raw 剧本全文
 * @returns {{
 *   sceneHead: {id:string,label:string,source:string,example:string,hits:number},
 *   cast: {source:string,example:string,hits:number},
 *   dialogue: {withHint:boolean,example:string,hits:number},
 *   actionPrefix: string,
 *   episodeHead: {example:string,hits:number},
 *   sampleLines: number
 * }}
 */
export function detectScriptFormat(raw) {
    const lines = normalizeLines(raw);
    const labels = lines.slice(0, 1200);
    const nonEmpty = labels.filter((l) => l.trim());

    const explicit = pickExplicitScene(labels);
    const implicit = inferImplicitScene(labels);
    const sceneHead =
        explicit ||
        implicit || {
            id: 'unknown',
            label: '未识别到场景标题（按「出场人物」行兜底分场）',
            source: '',
            example: '',
            hits: 0,
        };

    // 台词：判断是否使用「角色（提示）：」的括号写法
    let dialogueHits = 0;
    let withHint = false;
    let dialogueExample = '';
    for (const rawLine of nonEmpty) {
        const line = rawLine.trim();
        if (ACTION_LINE_RE.test(line) || CAST_LINE_RE.test(line)) continue;
        if (CAST_LINE_RE.test(line)) continue;
        const m = line.match(DIALOGUE_LINE_RE);
        if (!m) continue;
        // 场景标题本身也带冒号，排除掉，避免把「场景1：地点」算成台词
        if (sceneHead.source && new RegExp(sceneHead.source).test(line)) continue;
        dialogueHits += 1;
        if (m[2]) withHint = true;
        if (!dialogueExample) dialogueExample = line;
    }

    const castLine = nonEmpty.map((l) => l.trim()).find((l) => CAST_LINE_RE.test(l)) || '';
    const episodeLine = nonEmpty.map((l) => l.trim()).find((l) => EPISODE_HEAD_RE.test(l)) || '';
    const action = detectActionPrefix(labels);

    return {
        sceneHead,
        cast: {
            source: CAST_LINE_RE.source,
            example: castLine,
            hits: nonEmpty.filter((l) => CAST_LINE_RE.test(l.trim())).length,
        },
        dialogue: { withHint, example: dialogueExample, hits: dialogueHits },
        actionPrefix: action.prefix,
        episodeHead: {
            example: episodeLine,
            hits: nonEmpty.filter((l) => EPISODE_HEAD_RE.test(l.trim())).length,
        },
        sampleLines: nonEmpty.length,
    };
}

// ============================================================================
// 场景边界判定
// ============================================================================

/**
 * 生成场景边界判定器。
 *
 * 判定顺序：
 *   1. 命中探测出的显式场景标题 → 该行就是场景标题；
 *   2. 命中不了但下一行是「出场人物：」→ 当前行视为场景标题（无场号剧本兜底）；
 *   3. 否则不是场景边界。
 *
 * @param {string[]} lines 剧本行
 * @param {object} profile detectScriptFormat 的结果
 * @returns {(index:number) => {id:string, rest:string} | null}
 */
export function makeSceneResolver(lines, profile) {
    const source = profile?.sceneHead?.source;
    const re = source ? new RegExp(source) : null;

    return (index) => {
        const line = String(lines[index] || '').trim();
        if (!line) return null;

        if (re) {
            const m = line.match(re);
            if (m) {
                return { id: String(m[1] || '').replace(/\s+/g, ''), rest: String(m[2] || '').trim() };
            }
        }

        // 兜底：下一行是「出场人物：」时，当前短行就是场景标题
        let next = index + 1;
        while (next < lines.length && !String(lines[next] || '').trim()) next += 1;
        const nextLine = String(lines[next] || '').trim();
        if (
            CAST_LINE_RE.test(nextLine) &&
            line.length <= 40 &&
            !CAST_LINE_RE.test(line) &&
            !ACTION_LINE_RE.test(line) &&
            !EPISODE_HEAD_RE.test(line)
        ) {
            const parts = line.split(/[，,]/).map((p) => p.trim()).filter(Boolean);
            return { id: parts[0] || line, rest: parts.slice(1).join('，') };
        }

        return null;
    };
}

/** 从场景标题的剩余部分解析地点、时间、内外景 */
export function parseSceneTitle(rest) {
    const parts = String(rest || '')
        .split(/[，,、|]/)
        .map((s) => s.trim())
        .filter(Boolean);

    let location = parts[0] || '';
    let timeOfDay = parts[1] || '';
    let interiorExterior = parts[2] || '';

    // 空格分隔写法：县城·车站 日 内
    if (parts.length <= 1) {
        const sp = location.split(/\s+/).filter(Boolean);
        const TIME_RE = /^(日|夜|早|晚|清晨|黄昏|傍晚|午后|白天|深夜|凌晨)$/;
        if (sp.length >= 2 && TIME_RE.test(sp[sp.length - 2] || '')) {
            location = sp.slice(0, -2).join('');
            timeOfDay = sp[sp.length - 2];
            interiorExterior = sp[sp.length - 1];
        }
    }
    return { location, timeOfDay, interiorExterior };
}

/** 统计场景数 */
export function countScenes(raw, profile) {
    const lines = normalizeLines(raw);
    const resolve = makeSceneResolver(lines, profile);
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
        if (resolve(i)) n += 1;
    }
    return n;
}

/** 把探测结果压成一段可直接塞进 prompt 的说明 */
export function describeFormat(profile) {
    if (!profile) return '';
    const parts = [];
    if (profile.sceneHead?.example) {
        parts.push(`场景标题写法：${profile.sceneHead.label}，例如「${profile.sceneHead.example}」`);
    }
    if (profile.cast?.example) {
        parts.push(`出场人物行，例如「${profile.cast.example}」`);
    }
    if (profile.actionPrefix) {
        parts.push(`动作行以「${profile.actionPrefix}」开头`);
    }
    if (profile.dialogue?.example) {
        parts.push(`台词写作「${profile.dialogue.example}」`);
    }
    if (profile.episodeHead?.example) {
        parts.push(`集标题，例如「${profile.episodeHead.example}」`);
    }
    return parts.join('；');
}

export default { detectScriptFormat, makeSceneResolver, parseSceneTitle, countScenes, describeFormat };
