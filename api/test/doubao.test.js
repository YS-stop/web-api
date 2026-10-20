/**
 * Seedance 多参考图组装与上限单测（node:test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedanceContent, getMaxReferenceImages, createSeedanceTask } from '../server/services/doubao.js';

const IMG = (n) => `data:image/png;base64,REF${n}`;

test('getMaxReferenceImages: Seedance 2.0 系列为 9 张', () => {
    assert.equal(getMaxReferenceImages('doubao-seedance-2-0-260128'), 9);
    assert.equal(getMaxReferenceImages('doubao-seedance-2-0-fast-260128'), 9);
    assert.equal(getMaxReferenceImages('doubao-seedance-2-0-mini-260615'), 9);
});

test('getMaxReferenceImages: Seedance 2.5 为 30 张', () => {
    assert.equal(getMaxReferenceImages('doubao-seedance-2-5-260628'), 30);
});

test('getMaxReferenceImages: 未知/缺省模型按 9 张保守处理', () => {
    assert.equal(getMaxReferenceImages('unknown-model'), 9);
    assert.equal(getMaxReferenceImages(undefined), 9);
});

test('buildSeedanceContent: 纯文生视频只有 text', () => {
    const content = buildSeedanceContent({ prompt: '海边日落' });
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
});

test('buildSeedanceContent: 单图走 first_frame', () => {
    const content = buildSeedanceContent({ prompt: 'p', imageBase64: IMG(1) });
    const img = content.find((c) => c.type === 'image_url');
    assert.equal(img.role, 'first_frame');
});

test('buildSeedanceContent: 首尾帧走 first_frame + last_frame', () => {
    const content = buildSeedanceContent({ prompt: 'p', imageBase64: IMG(1), lastFrameBase64: IMG(2), referenceImages: [IMG(3)] });
    const roles = content.filter((c) => c.type === 'image_url').map((c) => c.role);
    assert.deepEqual(roles, ['first_frame', 'last_frame']);
});

test('buildSeedanceContent: 多图参考全部使用 reference_image（2.0 上限 9）', () => {
    const refs = Array.from({ length: 9 }, (_, i) => IMG(i + 1));
    const content = buildSeedanceContent({ prompt: 'p', referenceImages: refs, modelId: 'doubao-seedance-2-0-260128' });
    const imgs = content.filter((c) => c.type === 'image_url');
    assert.equal(imgs.length, 9);
    assert.equal(imgs.every((c) => c.role === 'reference_image'), true);
});

test('buildSeedanceContent: 首帧并入参考图列表头部', () => {
    const content = buildSeedanceContent({ prompt: 'p', imageBase64: IMG(1), referenceImages: [IMG(2), IMG(3)] });
    const urls = content.filter((c) => c.type === 'image_url').map((c) => c.image_url.url);
    assert.deepEqual(urls, [IMG(1), IMG(2), IMG(3)]);
    assert.equal(content.filter((c) => c.type === 'image_url').every((c) => c.role === 'reference_image'), true);
});

test('buildSeedanceContent: 2.0 超过 9 张直接报错，不再静默截断', () => {
    const refs = Array.from({ length: 10 }, (_, i) => IMG(i + 1));
    assert.throws(
        () => buildSeedanceContent({ prompt: 'p', referenceImages: refs, modelId: 'doubao-seedance-2-0-260128' }),
        /上限 9 张/
    );
});

test('buildSeedanceContent: 2.5 支持 30 张，31 张报错', () => {
    const refs30 = Array.from({ length: 30 }, (_, i) => IMG(i + 1));
    const content = buildSeedanceContent({ prompt: 'p', referenceImages: refs30, modelId: 'doubao-seedance-2-5-260628' });
    assert.equal(content.filter((c) => c.type === 'image_url').length, 30);

    const refs31 = Array.from({ length: 31 }, (_, i) => IMG(i + 1));
    assert.throws(
        () => buildSeedanceContent({ prompt: 'p', referenceImages: refs31, modelId: 'doubao-seedance-2-5-260628' }),
        /上限 30 张/
    );
});

test('buildSeedanceContent: 重复参考图会先去重', () => {
    const content = buildSeedanceContent({ prompt: 'p', referenceImages: [IMG(1), IMG(1), IMG(2)] });
    assert.equal(content.filter((c) => c.type === 'image_url').length, 2);
});

test('createSeedanceTask: 3 张参考图真实进入请求体（mock fetch，不发网络）', async () => {
    const originalFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, options) => {
        captured = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: 'task-123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    try {
        const taskId = await createSeedanceTask({
            prompt: '三个人物同框',
            referenceImages: [IMG(1), IMG(2), IMG(3)],
            modelId: 'doubao-seedance-2-0-260128',
            apiKey: 'test-key',
        });
        assert.equal(taskId, 'task-123');
        const refs = captured.content.filter((c) => c.role === 'reference_image');
        assert.equal(refs.length, 3);
        assert.equal(captured.content.filter((c) => c.role === 'first_frame').length, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('createSeedanceTask: 超过上限时不发请求直接抛错', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
    try {
        await assert.rejects(
            () => createSeedanceTask({
                prompt: 'x',
                referenceImages: Array.from({ length: 10 }, (_, i) => IMG(i)),
                modelId: 'doubao-seedance-2-0-260128',
                apiKey: 'k',
            }),
            /上限 9 张/
        );
        assert.equal(called, false, '超出上限时不应发起网络请求');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
