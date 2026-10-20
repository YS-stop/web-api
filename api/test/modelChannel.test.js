/**
 * modelChannel 多 key 调度单测（node:test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChannel, getKey, withConcurrency } from '../server/services/modelChannel.js';

/** 清理测试用环境变量 */
function clearEnv() {
    for (const key of Object.keys(process.env)) {
        if (/^(DRAMA|TESTPROV)_API_KEY/.test(key)) delete process.env[key];
    }
}

test('normalizeChannel: 非法通道回退 free', () => {
    assert.equal(normalizeChannel('free'), 'free');
    assert.equal(normalizeChannel('project'), 'project');
    assert.equal(normalizeChannel('workflow'), 'workflow');
    assert.equal(normalizeChannel('unknown'), 'free');
    assert.equal(normalizeChannel(undefined), 'free');
});

test('getKey: 未知 provider 返回 null', () => {
    assert.equal(getKey('NOT_A_PROVIDER', 'free'), null);
});

test('getKey: 单 key 兼容 PREFIX_API_KEY', () => {
    clearEnv();
    process.env.DRAMA_API_KEY = 'single-key';
    assert.equal(getKey('DRAMA', 'free'), 'single-key');
    clearEnv();
});

test('getKey: 逗号分隔多 key 轮询', () => {
    clearEnv();
    process.env.DRAMA_API_KEYS = 'k1, k2 ,k3';
    const seen = new Set();
    for (let i = 0; i < 6; i++) seen.add(getKey('DRAMA', 'free'));
    assert.deepEqual([...seen].sort(), ['k1', 'k2', 'k3']);
    clearEnv();
});

test('getKey: 数字下标多 key', () => {
    clearEnv();
    process.env.DRAMA_API_KEY_1 = 'a';
    process.env.DRAMA_API_KEY_2 = 'b';
    process.env.DRAMA_API_KEY_4 = 'd'; // 下标不连续，应在 _3 处停止
    const seen = new Set();
    for (let i = 0; i < 6; i++) seen.add(getKey('DRAMA', 'free'));
    assert.deepEqual([...seen].sort(), ['a', 'b']);
    clearEnv();
});

test('getKey: 通道专属 key 优先于共享池', () => {
    clearEnv();
    process.env.DRAMA_API_KEY = 'shared';
    process.env.DRAMA_API_KEY_WORKFLOW = 'wf-only';
    assert.equal(getKey('DRAMA', 'workflow'), 'wf-only');
    assert.equal(getKey('DRAMA', 'free'), 'shared');
    clearEnv();
});

test('withConcurrency: 超出上限的任务排队执行', async () => {
    let running = 0;
    let peak = 0;
    const task = () => withConcurrency('GEMINI', 'free', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
        return true;
    });

    const results = await Promise.all(Array.from({ length: 10 }, task));
    assert.equal(results.every(Boolean), true);
    assert.ok(peak <= 4, `峰值并发 ${peak} 超过 4`);
});
