/**
 * modelChannel.js
 *
 * 三通道（free / project / workflow）模型调用隔离 + 多 key 轮询 + 简单并发队列。
 *
 * 通道：
 *   free     —— 自由画布（/canvas）
 *   project  —— 项目画布（/canvas/:projectId）
 *   workflow —— 工作流（/workflow/:projectId）
 *
 * 用途：
 *   三个模块各自用不同的 key 组，避免「一个模块人多卡顿把另外两个也拖慢」；
 *   每类模型可配多把 key 轮询，分摊单把 key 的并发 / QPS 压力；
 *   withConcurrency 做进程内队列限流，削平瞬时洪峰。
 *
 * 环境变量约定（以 DRAMA 为例，其余 provider 同规则）：
 *   DRAMA_API_KEY              —— 单 key（向后兼容，所有通道共享兜底）
 *   DRAMA_API_KEYS             —— 多 key，逗号分隔（所有通道共享）
 *   DRAMA_API_KEY_1 / _2 / …   —— 多 key，数字下标（所有通道共享）
 *   DRAMA_API_KEY_WORKFLOW     —— workflow 通道专属单 key
 *   DRAMA_API_KEYS_WORKFLOW    —— workflow 通道专属多 key（逗号分隔）
 *   （同理 PROJECT / FREE）
 *
 * 优先级：通道专属 key > 共享多 key 池 > 共享单 key。
 */

export const CHANNELS = ['free', 'project', 'workflow'];
const DEFAULT_CHANNEL = 'free';

/** 参与多 key 轮询的 provider（单 key 字符串型；Kling 为 access/secret 成对，不在此列） */
const PROVIDERS = new Set(['DRAMA', 'SEEDANCE', 'SEEDREAM', 'VLM_DOUBAO', 'GEMINI', 'OPENAI', 'HAILUO', 'FAL']);

/** 归一化通道名（非法值回退默认通道） */
export function normalizeChannel(channel) {
    return CHANNELS.includes(channel) ? channel : DEFAULT_CHANNEL;
}

/** 收集某 provider 的「共享 key 池」（去空、去重） */
function collectSharedKeys(prefix) {
    const keys = [];

    // 1) 逗号分隔多 key：PREFIX_API_KEYS=key1,key2
    const multi = process.env[`${prefix}_API_KEYS`];
    if (multi) {
        for (const k of multi.split(',')) {
            const t = k.trim();
            if (t) keys.push(t);
        }
    }

    // 2) 数字下标多 key：PREFIX_API_KEY_1 / _2 / …
    for (let i = 1; i <= 100; i++) {
        const k = process.env[`${prefix}_API_KEY_${i}`];
        if (k && k.trim()) keys.push(k.trim());
        else break; // 无间隙，遇空即停
    }

    // 3) 单 key 兼容：PREFIX_API_KEY
    const single = process.env[`${prefix}_API_KEY`];
    if (single && single.trim()) keys.push(single.trim());

    return [...new Set(keys)];
}

/** 获取某 provider 在某通道下的可用 key 列表 */
function getKeysForChannel(prefix, channel) {
    const ch = normalizeChannel(channel);
    const suffix = ch.toUpperCase();

    // 通道专属多 key
    const channelMulti = process.env[`${prefix}_API_KEYS_${suffix}`];
    if (channelMulti) {
        const keys = channelMulti.split(',').map((k) => k.trim()).filter(Boolean);
        if (keys.length) return [...new Set(keys)];
    }

    // 通道专属单 key
    const channelSingle = process.env[`${prefix}_API_KEY_${suffix}`];
    if (channelSingle && channelSingle.trim()) return [channelSingle.trim()];

    // 回退共享池
    return collectSharedKeys(prefix);
}

// 轮询指针：`${provider}:${channel}` -> 下一个下标
const rrIndex = {};

/**
 * 轮询返回某 provider 在某通道下的一把 key。
 * @returns {string|null} key；无可用 key 时返回 null
 */
export function getKey(provider, channel) {
    if (!PROVIDERS.has(provider)) return null;
    const ch = normalizeChannel(channel);
    const keys = getKeysForChannel(provider, ch);
    if (keys.length === 0) return null;

    const slot = `${provider}:${ch}`;
    const idx = rrIndex[slot] || 0;
    rrIndex[slot] = (idx + 1) % keys.length;
    return keys[idx];
}

// ============================================================================
// 简单并发队列（进程内信号量）
// ============================================================================

const active = {};   // `${provider}:${channel}` -> 当前运行数
const waiters = {};  // `${provider}:${channel}` -> 等待中的 resolve 队列

const DEFAULT_MAX_CONCURRENT = parseInt(process.env.CHANNEL_MAX_CONCURRENT || '4', 10);

/**
 * 限制同一 provider+channel 的并发执行，超出部分排队等待。
 * @param {string} provider
 * @param {string} channel
 * @param {() => Promise<T>} task
 * @param {number} [maxConcurrent]
 * @returns {Promise<T>}
 */
export async function withConcurrency(provider, channel, task, maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    const ch = normalizeChannel(channel);
    const slot = `${provider}:${ch}`;
    const max = Math.max(1, maxConcurrent || DEFAULT_MAX_CONCURRENT);

    while ((active[slot] || 0) >= max) {
        await new Promise((resolve) => {
            (waiters[slot] = waiters[slot] || []).push(resolve);
        });
    }

    active[slot] = (active[slot] || 0) + 1;
    try {
        return await task();
    } finally {
        active[slot] = Math.max(0, (active[slot] || 0) - 1);
        const next = (waiters[slot] || []).shift();
        if (next) next();
    }
}
