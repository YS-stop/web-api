/**
 * llmClient.js
 *
 * 统一的 LLM 调用基础设施（火山方舟 OpenAI 兼容接口）。
 * 收敛原先散落在 routes/drama.js、routes/storyboard.js 中的重复实现：
 *   - retryOperation   指数退避重试
 *   - parseJsonFromText 稳健地从模型输出中提取 JSON（含截断修复）
 *   - arkChat          调用 /chat/completions，返回纯文本
 *   - arkChatJson      调用 + 解析 JSON
 *
 * 说明：并发限流仍由 services/modelChannel.js 的 withConcurrency 负责，
 * 本模块只做「单次调用 + 重试 + 解析」，便于组合与单测。
 */

/** 火山方舟（OpenAI 兼容）默认地址与模型 */
export const ARK_BASE_URL =
    process.env.DRAMA_BASE_URL ||
    process.env.VLM_DOUBAO_BASE_URL ||
    'https://ark.cn-beijing.volces.com/api/v3';

export const ARK_MODEL_ID = process.env.DRAMA_MODEL_ID || 'deepseek-v4-flash-ga-260731';

/** 默认单次调用超时（3 分钟） */
export const DEFAULT_TIMEOUT_MS = 180000;

/**
 * 带指数退避的重试。
 * @param {() => Promise<any>} operation 要执行的操作
 * @param {number} maxRetries 最大尝试次数
 * @param {number} initialDelayMs 首次退避时长（之后翻倍）
 * @param {string} tag 日志前缀
 */
export async function retryOperation(operation, maxRetries = 3, initialDelayMs = 2000, tag = 'LLM') {
    let delay = initialDelayMs;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            const isLastAttempt = i === maxRetries - 1;
            console.warn(`[${tag}] API call failed (attempt ${i + 1}/${maxRetries}):`, error.message);
            if (isLastAttempt) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
}

/**
 * 尝试修复「因 max_tokens 截断」而不完整的 JSON。
 * 策略：从末尾丢弃残缺片段，补齐未闭合的字符串/数组/对象，直到能闭合到顶层。
 * 无法修复时返回 null。
 * @param {string} s
 * @returns {string|null}
 */
export function repairTruncatedJson(s) {
    let str = s;
    // 逐字符扫描，跟踪字符串内外与括号栈。
    for (let pass = 0; pass < 6; pass += 1) {
        const stack = [];
        let inStr = false;
        let escaped = false;
        let lastSafe = -1; // 最后一个「结构完整点」（逗号之后且不在字符串内）的下标
        for (let i = 0; i < str.length; i += 1) {
            const ch = str[i];
            if (inStr) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{' || ch === '[') stack.push(ch);
            else if (ch === '}' || ch === ']') stack.pop();
            else if (ch === ',') lastSafe = i;
        }
        // 若在字符串内被截断，丢弃最后那个未闭合字符串（回退到它的开引号之前）
        if (inStr) {
            const cut = str.lastIndexOf('"');
            if (cut <= 0) return null;
            str = str.slice(0, cut);
            continue;
        }
        // 去掉末尾悬空的逗号 / 残缺键值
        const trimmed = str.replace(/[,\s:]*$/, '');
        // 用括号栈补齐
        const st = [];
        let ins = false;
        let esc = false;
        for (let i = 0; i < trimmed.length; i += 1) {
            const ch = trimmed[i];
            if (ins) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') ins = false;
            } else if (ch === '"') ins = true;
            else if (ch === '{' || ch === '[') st.push(ch);
            else if (ch === '}' || ch === ']') st.pop();
        }
        if (ins) continue;
        let closed = trimmed;
        for (let i = st.length - 1; i >= 0; i -= 1) {
            closed += st[i] === '{' ? '}' : ']';
        }
        try {
            JSON.parse(closed);
            return closed;
        } catch (e) {
            // 回退到最后一个逗号安全点，丢弃未完成的最后一个元素
            if (lastSafe > 0) {
                str = str.slice(0, lastSafe);
                continue;
            }
            return null;
        }
    }
    return null;
}

/**
 * 从模型响应文本中稳健地提取 JSON（兼容 markdown 代码块、前后缀噪声、截断）。
 * @param {string} responseText
 * @returns {any}
 */
export function parseJsonFromText(responseText) {
    let jsonStr = String(responseText || '').trim();
    if (jsonStr.includes('```json')) {
        jsonStr = jsonStr.split('```json')[1].split('```')[0].trim();
    } else if (jsonStr.includes('```')) {
        jsonStr = jsonStr.split('```')[1].split('```')[0].trim();
    }
    // 去除可能的包裹前缀/后缀，直到首个 { 或 [
    const firstBrace = jsonStr.indexOf('{');
    const firstBracket = jsonStr.indexOf('[');
    let start = -1;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);
    if (start > 0) jsonStr = jsonStr.slice(start);

    try {
        return JSON.parse(jsonStr);
    } catch (initialErr) {
        // 情况一：JSON 后面还跟着说明文字，截到最后一个 } 或 ] 再试
        const lastBrace = jsonStr.lastIndexOf('}');
        const lastBracket = jsonStr.lastIndexOf(']');
        const cut = Math.max(lastBrace, lastBracket);
        if (cut > 0 && cut < jsonStr.length - 1) {
            try {
                return JSON.parse(jsonStr.slice(0, cut + 1));
            } catch (e) {
                // 继续尝试截断修复
            }
        }

        // 情况二：输出过长被截断，JSON 末尾不完整。尝试逐步修复后再解析。
        const repaired = repairTruncatedJson(jsonStr);
        if (repaired) return JSON.parse(repaired);
        throw initialErr;
    }
}

/**
 * 调用火山方舟 OpenAI 兼容 /chat/completions，返回纯文本内容。
 * 不做重试与并发控制，由调用方用 retryOperation / withConcurrency 组合。
 *
 * @param {object} options
 * @param {string} options.apiKey 必填
 * @param {string} [options.systemPrompt] 单条 user 消息内容
 * @param {Array<{role:string, content:string}>} [options.messages] 完整消息列表（优先于 systemPrompt）
 * @param {string} [options.model] 默认 ARK_MODEL_ID
 * @param {string} [options.baseUrl] 默认 ARK_BASE_URL
 * @param {number} [options.temperature] 默认 0
 * @param {number} [options.maxTokens] 默认 4096
 * @param {number} [options.timeoutMs] 默认 180000
 * @param {string} [options.tag] 日志前缀
 * @param {object} [options.extraBody] 额外请求体字段（如 thinking）
 * @returns {Promise<string>}
 */
export async function arkChat({
    apiKey,
    systemPrompt,
    messages,
    model = ARK_MODEL_ID,
    baseUrl = ARK_BASE_URL,
    temperature = 0,
    maxTokens = 4096,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    tag = 'LLM',
    extraBody = {},
}) {
    if (!apiKey) throw new Error(`${tag}: API key 未配置`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                messages: messages || [{ role: 'user', content: systemPrompt }],
                temperature,
                max_tokens: maxTokens,
                thinking: { type: 'disabled' },
                ...extraBody,
            }),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`${tag} 调用失败（${resp.status}）：${errText.slice(0, 300)}`);
        }
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';
        if (!content.trim()) throw new Error(`${tag} 返回空内容`);
        return content;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * arkChat + parseJsonFromText 的组合，解析失败时抛出可读错误。
 * @param {Parameters<typeof arkChat>[0] & { logRawOnError?: boolean }} options
 * @returns {Promise<any>}
 */
export async function arkChatJson(options) {
    const tag = options.tag || 'LLM';
    const responseText = await arkChat(options);
    try {
        return parseJsonFromText(responseText);
    } catch (parseError) {
        console.error(`[${tag}] JSON 解析失败:`, parseError);
        if (options.logRawOnError !== false) {
            console.error(`[${tag}] 原始响应:`, responseText);
        }
        throw new Error('AI 返回格式无法解析，请重试');
    }
}
