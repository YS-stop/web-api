/**
 * 豆包语音合成 2.0（v3）流式分帧与音色映射单测（node:test）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { takeJsonObjects } from '../server/services/ttsV3.js';
import { resolveSpeakerV2 } from '../server/services/tts.js';

test('takeJsonObjects: 单个完整帧全部取出', () => {
    const { frames, rest } = takeJsonObjects('{"header":{"code":0},"payload_msg":"AAA"}');
    assert.equal(frames.length, 1);
    assert.equal(rest, '');
    assert.deepEqual(JSON.parse(frames[0]), { header: { code: 0 }, payload_msg: 'AAA' });
});

test('takeJsonObjects: 半包留在 rest 里等下一批数据', () => {
    const { frames, rest } = takeJsonObjects('{"header":{"code":0},"payload_msg":"AA');
    assert.equal(frames.length, 0);
    assert.equal(rest, '{"header":{"code":0},"payload_msg":"AA');
});

test('takeJsonObjects: 两帧粘连可连续切出', () => {
    const { frames, rest } = takeJsonObjects('{"data":"A"}{"data":"B"}');
    assert.equal(frames.length, 2);
    assert.equal(rest, '');
    assert.equal(JSON.parse(frames[0]).data, 'A');
    assert.equal(JSON.parse(frames[1]).data, 'B');
});

test('takeJsonObjects: 字符串里的花括号不会被当成帧边界', () => {
    const raw = '{"data":"{\\"a\\":1}","code":0}';
    const { frames, rest } = takeJsonObjects(raw);
    assert.equal(frames.length, 1);
    assert.equal(rest, '');
    assert.equal(JSON.parse(frames[0]).data, '{"a":1}');
});

test('takeJsonObjects: 前导换行（NDJSON 风格）可正常解析', () => {
    const { frames } = takeJsonObjects('\n{"code":0,"data":"X"}\n{"code":20000000,"data":""}\n');
    assert.equal(frames.length, 2);
    assert.equal(JSON.parse(frames[1]).code, 20000000);
});

test('resolveSpeakerV2: 语义化 id 与中文名都映射到 2.0 音色', () => {
    assert.equal(resolveSpeakerV2('温柔女声'), 'zh_female_xiaohe_uranus_bigtts');
    assert.equal(resolveSpeakerV2('gentle-female'), 'zh_female_xiaohe_uranus_bigtts');
    assert.equal(resolveSpeakerV2('童声'), 'zh_female_tianmeixiaoyuan_uranus_bigtts');
});

test('resolveSpeakerV2: 已是 2.0 音色时原样透传', () => {
    assert.equal(resolveSpeakerV2('zh_male_m191_uranus_bigtts'), 'zh_male_m191_uranus_bigtts');
});

test('resolveSpeakerV2: 1.0 音色回落到默认 2.0 音色', () => {
    assert.equal(resolveSpeakerV2('zh_female_qingxin'), 'zh_female_shuangkuaisisi_uranus_bigtts');
    assert.equal(resolveSpeakerV2(undefined), 'zh_female_shuangkuaisisi_uranus_bigtts');
});
