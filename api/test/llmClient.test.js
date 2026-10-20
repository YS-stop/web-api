/**
 * llmClient 纯函数单测（node:test，无需额外依赖）
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonFromText, repairTruncatedJson, retryOperation } from '../server/services/llmClient.js';

test('parseJsonFromText: 解析纯 JSON', () => {
    assert.deepEqual(parseJsonFromText('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonFromText('[1,2,3]'), [1, 2, 3]);
});

test('parseJsonFromText: 兼容 ```json 代码块', () => {
    const text = '好的，结果如下：\n```json\n{"episodes":[{"title":"第一集"}]}\n```\n以上。';
    assert.deepEqual(parseJsonFromText(text), { episodes: [{ title: '第一集' }] });
});

test('parseJsonFromText: 兼容无语言标记的代码块', () => {
    assert.deepEqual(parseJsonFromText('```\n{"x":2}\n```'), { x: 2 });
});

test('parseJsonFromText: 丢弃 JSON 前后的噪声文本', () => {
    assert.deepEqual(parseJsonFromText('说明文字 {"a":{"b":[1]}} 尾部说明'), { a: { b: [1] } });
});

test('parseJsonFromText: 截断的 JSON 可被修复', () => {
    const truncated = '{"episodes":[{"title":"第一集"},{"title":"第二集"},{"tit';
    const result = parseJsonFromText(truncated);
    // 至少保留已完整的两个元素（残缺的第三个会被裁剪成空对象）
    assert.ok(result.episodes.length >= 2);
    assert.equal(result.episodes[0].title, '第一集');
    assert.equal(result.episodes[1].title, '第二集');
});

test('parseJsonFromText: 数组被截断时保留完整元素', () => {
    const result = parseJsonFromText('{"list":[1,2,3,');
    assert.deepEqual(result, { list: [1, 2, 3] });
});

test('parseJsonFromText: 完全无法解析时抛错', () => {
    assert.throws(() => parseJsonFromText('这里没有任何 JSON'));
});

test('repairTruncatedJson: 空字符串返回 null', () => {
    assert.equal(repairTruncatedJson(''), null);
});

test('repairTruncatedJson: 已完整 JSON 原样返回', () => {
    assert.equal(repairTruncatedJson('{"a":1}'), '{"a":1}');
});

test('retryOperation: 失败后重试并最终成功', async () => {
    let calls = 0;
    const result = await retryOperation(async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'ok';
    }, 5, 1, 'Test');
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('retryOperation: 重试耗尽后抛出最后一次错误', async () => {
    await assert.rejects(
        () => retryOperation(async () => { throw new Error('always'); }, 2, 1, 'Test'),
        /always/
    );
});
