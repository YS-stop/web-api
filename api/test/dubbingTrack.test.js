import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDubbingTrack,
    fingerprintOf,
    normalizeDubbingLines,
} from '../server/services/dubbingTrack.js';

const LINE = { role: '林夏', text: '你终于来了。', voice: 'bright-female' };

test('台词归一化：丢弃空台词、补默认角色、限制风格指令条数', () => {
    const lines = normalizeDubbingLines([
        { role: '林夏', text: '  你终于来了。 ', voice: 'bright-female' },
        { text: '   ', voice: 'calm-male' },
        null,
        { text: '我是旁白', voice: 'narrator-xiaomei', contextTexts: ['a', 'b', 'c', 'd', 'e'] },
    ]);

    assert.equal(lines.length, 2);
    assert.equal(lines[0].text, '你终于来了。');
    assert.equal(lines[0].role, '林夏');
    // 未给角色的台词归到旁白，避免音色解析时找不到归属
    assert.equal(lines[1].role, '旁白');
    assert.equal(lines[1].contextTexts.length, 4);
});

test('台词归一化：超长文本截断，避免单条台词打满额度', () => {
    const [line] = normalizeDubbingLines([{ text: '长'.repeat(999), voice: 'child' }]);
    assert.equal(line.text.length, 400);
});

test('内容指纹稳定：同样的台词与音色必须命中同一个文件（不重复计费）', () => {
    const lines = [LINE, { role: '旁白', text: '天亮了。', voice: 'narrator-xiaomei' }];
    const a = fingerprintOf({ episode: 1, volume: 1, speed: 1, lines });
    const b = fingerprintOf({ episode: 1, volume: 1, speed: 1, lines });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{12}$/);
});

test('内容指纹随音色变化：资产换音色后必须生成新音轨', () => {
    const base = fingerprintOf({ episode: 1, lines: [LINE] });
    const changedVoice = fingerprintOf({ episode: 1, lines: [{ ...LINE, voice: 'gentle-female' }] });
    const changedText = fingerprintOf({ episode: 1, lines: [{ ...LINE, text: '你终于走了。' }] });
    const changedPrompt = fingerprintOf({
        episode: 1,
        lines: [{ ...LINE, contextTexts: ['低沉沙哑'] }],
    });

    assert.notEqual(base, changedVoice, '换音色必须换指纹');
    assert.notEqual(base, changedText, '改台词必须换指纹');
    assert.notEqual(base, changedPrompt, '改风格提示词必须换指纹');
});

test('内容指纹随音量语速与集号变化（同一段台词在不同集不能复用同一音轨）', () => {
    const base = fingerprintOf({ episode: 1, volume: 1, speed: 1, lines: [LINE] });
    assert.notEqual(base, fingerprintOf({ episode: 2, volume: 1, speed: 1, lines: [LINE] }));
    assert.notEqual(base, fingerprintOf({ episode: 1, volume: 1.2, speed: 1, lines: [LINE] }));
    assert.notEqual(base, fingerprintOf({ episode: 1, volume: 1, speed: 1.3, lines: [LINE] }));
});

test('没有台词时直接拒绝，不发起任何合成请求', async () => {
    await assert.rejects(
        () => buildDubbingTrack({ episode: 1, lines: [{ text: '   ', voice: 'child' }] }),
        /没有可合成的台词/
    );
});

test('台词缺少音色时明确报错，而不是静默用默认音色（避免资产音色被悄悄覆盖）', async () => {
    await assert.rejects(
        () => buildDubbingTrack({ episode: 1, lines: [{ role: '林夏', text: '你好', voice: '' }] }),
        /缺少音色/
    );
});
