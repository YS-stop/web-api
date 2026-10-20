import test from 'node:test';
import assert from 'node:assert/strict';

import {
    VOICE_CATALOG,
    findVoice,
    inferVoiceId,
    isChineseOnlyText,
    isEnglishSpeaker,
    normalizeVoiceId,
    resolveSpeakerV2,
    resolveVoiceType,
    voiceCatalogForPrompt,
} from '../server/config/voices.js';

test('音色目录结构完整：每项都有四层映射', () => {
    assert.ok(VOICE_CATALOG.length >= 7);
    for (const v of VOICE_CATALOG) {
        assert.match(v.id, /^[a-z-]+$/);
        assert.ok(v.name.length > 0);
        // 新增的 2.0 专属音色没有 1.0 版本，voiceType 允许为空
        if (v.voiceType) assert.match(v.voiceType, /^zh_/);
        assert.match(v.voiceTypeV2, /_uranus_bigtts$/);
        assert.ok(Array.isArray(v.tags) && v.tags.length > 0);
    }
});

test('2.0 音色 ID 全局唯一（两个预设指向同一音色时听起来会一模一样）', () => {
    const ids = VOICE_CATALOG.map((v) => v.voiceTypeV2);
    assert.equal(new Set(ids).size, ids.length);
});

test('「默认音色」不再被原样透传（历史 bug 回归）', () => {
    // 修复前会把「默认音色」这个中文字符串当 voice_type 发给火山接口，必然报错
    assert.equal(resolveVoiceType('默认音色'), 'zh_female_qingxin');
    assert.equal(resolveSpeakerV2('默认音色'), 'zh_female_shuangkuaisisi_uranus_bigtts');
});

test('中文名、id、voice_type 三种写法都能解析到同一条目', () => {
    const byName = findVoice('沉稳男声');
    const byId = findVoice('calm-male');
    const byV2 = findVoice('zh_male_m191_uranus_bigtts');

    assert.equal(byName.id, 'calm-male');
    assert.equal(byId.id, 'calm-male');
    assert.ok(byV2); // 2.0 音色可能被多个条目共用，只要能命中即可
});

test('未知音色回落默认值而不是透传', () => {
    assert.equal(resolveSpeakerV2('不存在的音色'), 'zh_female_shuangkuaisisi_uranus_bigtts');
    assert.equal(normalizeVoiceId('随便写的'), 'narrator-xiaomei');
});

test('控制台自定义 voice_type 允许透传', () => {
    assert.equal(resolveSpeakerV2('zh_male_custom_uranus_bigtts'), 'zh_male_custom_uranus_bigtts');
    assert.equal(normalizeVoiceId('zh_female_custom_mars_bigtts'), 'zh_female_custom_mars_bigtts');
    // 英文音色同样允许透传，否则会被误判为未知值回落成中文默认音色
    assert.equal(normalizeVoiceId('en_male_custom_uranus_bigtts'), 'en_male_custom_uranus_bigtts');
});

test('英文音色能按 id / speaker 两种写法识别（试听示例句要按语种切换）', () => {
    const english = VOICE_CATALOG.filter((v) => v.voiceTypeV2.startsWith('en_'));
    assert.ok(english.length >= 1, '音色目录里应至少有一个英文音色');

    for (const v of english) {
        assert.equal(isEnglishSpeaker(v.id), true, `${v.id} 应识别为英文音色`);
        assert.equal(isEnglishSpeaker(v.voiceTypeV2), true, `${v.voiceTypeV2} 应识别为英文音色`);
    }
    for (const v of VOICE_CATALOG.filter((v) => !v.voiceTypeV2.startsWith('en_'))) {
        assert.equal(isEnglishSpeaker(v.id), false, `${v.id} 不应识别为英文音色`);
    }
});

test('语种匹配判断：纯中文文本不能喂给英文音色', () => {
    assert.equal(isChineseOnlyText('你好，我是这个角色的配音。'), true);
    assert.equal(isChineseOnlyText('Hello, I am the voice.'), false);
    // 中英混排放行，交给上游自行处理
    assert.equal(isChineseOnlyText('Hi，我是小美。'), false);
    assert.equal(isChineseOnlyText(''), false);
});

test('按人物信息推断音色：儿童 / 中年反派 / 年轻女性', () => {
    assert.equal(inferVoiceId({ name: '小满', description: '8岁的小女孩' }), 'child');
    assert.equal(inferVoiceId({ name: '赵爷', bio: '五十岁的帮派头目，阴狠' }), 'calm-male');
    assert.equal(inferVoiceId({ name: '林夏', bio: '二十二岁的实习女记者，活泼直率' }), 'bright-female');
});

test('年龄不会被中文数字子串误判（「二十五岁」不是儿童）', () => {
    assert.notEqual(inferVoiceId({ name: '王姐', bio: '二十五岁的公司职员' }), 'child');
    assert.equal(inferVoiceId({ name: '小宇', description: '10岁的男孩' }), 'child');
});

test('性别不明时保守回落到通用音色', () => {
    assert.equal(inferVoiceId({ name: '神秘人', description: '身份不明的访客' }), 'narrator-xiaomei');
});

test('提示词清单包含全部音色 id 与适用说明', () => {
    const text = voiceCatalogForPrompt();
    for (const v of VOICE_CATALOG) {
        assert.ok(text.includes(v.id), `清单缺少 ${v.id}`);
        assert.ok(text.includes(v.name), `清单缺少 ${v.name}`);
    }
});
