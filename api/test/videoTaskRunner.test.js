/**
 * 服务端视频任务执行器单测（node:test，mock fetch，不访问厂商）
 *
 * 验证：提交后由服务端后台轮询 → 成功 → 下载落盘 → 写 metadata → 任务状态可查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 轮询间隔调快，便于测试（必须在 import 执行器之前设置）
process.env.SEEDANCE_POLL_INTERVAL = '1';

const { submitSeedanceVideoTask, getVideoTask, restoreVideoTasks } = await import('../server/services/videoTaskRunner.js');
const { LIBRARY_DIR, VIDEOS_DIR } = await import('../server/utils/paths.js');
const { updateJson } = await import('../server/utils/jsonStore.js');

const TASKS_FILE = path.join(LIBRARY_DIR, 'video-tasks.json');
const NODE_ID = `__test_node_${Date.now()}`;
const TASK_ID = 'task-runner-test-ok';

const jsonResponse = (data) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('submitSeedanceVideoTask: 后台轮询成功后自动下载落盘并写 metadata', async () => {
    const originalFetch = globalThis.fetch;
    let queried = 0;

    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const method = (options.method || 'GET').toUpperCase();

        if (target.endsWith('/contents/generations/tasks') && method === 'POST') {
            return jsonResponse({ id: TASK_ID });
        }
        if (target.endsWith(`/contents/generations/tasks/${TASK_ID}`)) {
            queried += 1;
            return jsonResponse({ status: 'succeeded', content: { video_url: 'https://fake.local/v.mp4' } });
        }
        if (target === 'https://fake.local/v.mp4') {
            return new Response(Buffer.from('fake-mp4-bytes'), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${method} ${target}`);
    };

    try {
        const created = await submitSeedanceVideoTask({
            apiKey: 'test-key',
            channel: 'project',
            nodeId: NODE_ID,
            modelId: 'doubao-seedance-2-0-260128',
            prompt: '测试提示词',
            aspectRatio: '9:16',
            resolution: '720p',
            duration: 5,
            referenceImages: [],
            generateAudio: true,
        });

        // 提交返回：立即拿到 taskId，且不能泄露 apiKey
        assert.equal(created.taskId, TASK_ID);
        assert.equal(created.status, 'running');
        assert.equal('apiKey' in created, false, '对外视图不应包含 apiKey');

        // 等待服务端后台轮询完成
        let task = null;
        for (let i = 0; i < 40; i += 1) {
            task = getVideoTask(TASK_ID);
            if (task && task.status !== 'running') break;
            await sleep(200);
        }

        assert.ok(queried >= 1, '后台应至少轮询一次厂商状态');
        assert.equal(task.status, 'succeeded');
        assert.match(task.resultUrl, /^\/library\/videos\//);

        // metadata 必须存在，前端 /api/generation-status/:nodeId 依赖它恢复
        const metaPath = path.join(VIDEOS_DIR, `${NODE_ID}.json`);
        assert.equal(fs.existsSync(metaPath), true, '应写入 <nodeId>.json 元数据');

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        assert.equal(meta.id, NODE_ID);
        assert.equal(meta.model, 'doubao-seedance-2-0-260128');

        // 产物文件存在
        const videoPath = path.join(VIDEOS_DIR, meta.filename);
        assert.equal(fs.existsSync(videoPath), true, '应下载并保存视频文件');

        // 清理测试产物
        fs.unlinkSync(metaPath);
        fs.unlinkSync(videoPath);
        await updateJson(TASKS_FILE, (current) => {
            const all = current && typeof current === 'object' ? current : {};
            delete all[TASK_ID];
            return all;
        }, {});
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('getVideoTask: 不存在的任务返回 null', () => {
    assert.equal(getVideoTask('task-not-exist-xxx'), null);
});

test('restoreVideoTasks: 无未完成任务时安全返回 0', async () => {
    const resumed = await restoreVideoTasks();
    assert.equal(typeof resumed, 'number');
    assert.ok(resumed >= 0);
});
