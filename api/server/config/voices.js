/**
 * voices.js
 *
 * 音色目录 —— 全项目唯一真源。
 *
 * 一份数据同时承载三层信息，避免前后端、1.0 / 2.0 之间各自维护一张表导致漂移：
 *   id          语义化音色 id（前端存储、资产 voiceName 建议值）
 *   name        中文显示名（兼容历史数据，老项目里存的就是中文名）
 *   voiceType   火山 1.0 音色（v1 接口 /api/v1/tts 用）
 *   voiceTypeV2 火山 2.0 音色（*_uranus_bigtts，v3 接口与 WebSocket 双向用）
 *
 * 前端对应文件：web/src/services/voiceCatalog.ts（内容保持一致，改这里要同步改那边）
 *
 * 历史坑：老版本前端预设里有「默认音色」，但映射表里没有，导致这个字符串被原样
 * 当作 voice_type 发给火山接口 → 必然报错。现在统一由 LEGACY_ALIASES 归一化。
 */

/** 2.0 默认音色：爽快思思 */
export const DEFAULT_SPEAKER_V2 =
    process.env.TTS_DEFAULT_SPEAKER || 'zh_female_shuangkuaisisi_uranus_bigtts';
/** 1.0 默认音色：清新女声 */
export const DEFAULT_VOICE_TYPE_V1 = 'zh_female_qingxin';

/**
 * 音色目录。
 * gender / age / tags 用于 AI 分配音色时的兜底推断，以及日志可读性。
 */
export const VOICE_CATALOG = [
    {
        id: 'narrator-xiaomei',
        name: '解说小美',
        gender: 'female',
        age: 'adult',
        tags: ['通用', '解说', '旁白', '亲切'],
        desc: '清爽女声，通用旁白与年轻女性角色',
        voiceType: 'zh_female_qingxin',
        voiceTypeV2: 'zh_female_shuangkuaisisi_uranus_bigtts',
    },
    {
        id: 'narrator-xiaojun',
        name: '解说小军',
        gender: 'male',
        age: 'adult',
        tags: ['通用', '解说', '旁白', '稳重'],
        desc: '标准男声，通用旁白与青年男性角色',
        voiceType: 'zh_male_M392_conversation_wvae',
        voiceTypeV2: 'zh_male_m191_uranus_bigtts',
    },
    {
        id: 'calm-male',
        name: '沉稳男声',
        gender: 'male',
        age: 'mature',
        tags: ['沉稳', '中年', '儒雅', '掌权者'],
        desc: '儒雅成熟，适合中年男性、掌权者、书生型角色',
        voiceType: 'zh_male_zhixing',
        voiceTypeV2: 'zh_male_ruyayichen_uranus_bigtts',
    },
    {
        id: 'deep-male',
        name: '浑厚男声',
        gender: 'male',
        age: 'mature',
        tags: ['浑厚', '大叔', '反派', '旁白'],
        desc: '厚重低沉，适合大叔、反派、纪录片式旁白',
        voiceType: '',
        voiceTypeV2: 'zh_male_dayi_uranus_bigtts',
    },
    {
        id: 'bright-female',
        name: '清亮女声',
        gender: 'female',
        age: 'young',
        tags: ['清亮', '少女', '活泼', '干练'],
        desc: '明亮清脆，适合年轻女性、女主角、职场角色',
        voiceType: 'zh_female_cancan_mars_bigtts',
        voiceTypeV2: 'zh_female_cancan_uranus_bigtts',
    },
    {
        id: 'young-male',
        name: '少年音',
        gender: 'male',
        age: 'teen',
        tags: ['少年', '青春', '学生'],
        desc: '清朗少年感，适合十几岁男性角色',
        voiceType: 'zh_male_shaoergushi_mars_bigtts',
        voiceTypeV2: 'zh_male_taocheng_uranus_bigtts',
    },
    {
        id: 'teen-boy',
        name: '少年梓辛',
        gender: 'male',
        age: 'teen',
        tags: ['少年', '青涩', '学生'],
        desc: '更青涩的少年声线，适合初高中生',
        voiceType: '',
        voiceTypeV2: 'zh_male_shaonianzixin_uranus_bigtts',
    },
    {
        id: 'child',
        name: '童声',
        gender: 'female',
        age: 'child',
        tags: ['儿童', '天真', '活泼'],
        desc: '儿童音色，适合 12 岁以下角色',
        voiceType: 'zh_female_tianmeixiaoyuan_mars_bigtts',
        voiceTypeV2: 'zh_female_tianmeixiaoyuan_uranus_bigtts',
    },
    {
        id: 'storybook-child',
        name: '儿童绘本',
        gender: 'female',
        age: 'child',
        tags: ['儿童', '绘本', '讲故事'],
        desc: '绘本朗读童声，适合儿童故事与童话',
        voiceType: '',
        voiceTypeV2: 'zh_female_xiaoxue_uranus_bigtts',
    },
    {
        id: 'gentle-female',
        name: '温柔女声',
        gender: 'female',
        age: 'mature',
        tags: ['温柔', '成熟', '母亲', '旁白'],
        desc: '柔和温暖，适合成熟女性、母亲、情感类旁白',
        voiceType: 'zh_female_wanwanxiaohe_moon_bigtts',
        voiceTypeV2: 'zh_female_xiaohe_uranus_bigtts',
    },
    {
        id: 'queen-female',
        name: '高冷御姐',
        gender: 'female',
        age: 'young',
        tags: ['高冷', '御姐', '强势', '女强人'],
        desc: '冷艳有距离感，适合女强人、御姐、清冷女主',
        voiceType: '',
        voiceTypeV2: 'zh_female_gaolengyujie_uranus_bigtts',
    },
    {
        id: 'girl-next-door',
        name: '邻家女孩',
        gender: 'female',
        age: 'young',
        tags: ['亲切', '邻家', '自然'],
        desc: '亲切自然，适合生活流女主、日常对话',
        voiceType: '',
        voiceTypeV2: 'zh_female_linjianvhai_uranus_bigtts',
    },
    {
        id: 'charming-female',
        name: '魅力女友',
        gender: 'female',
        age: 'young',
        tags: ['魅力', '成熟', '诱惑'],
        desc: '成熟有磁性，适合魅力型女性角色',
        voiceType: '',
        voiceTypeV2: 'zh_female_meilinvyou_uranus_bigtts',
    },
    {
        id: 'sweet-female',
        name: '甜美桃子',
        gender: 'female',
        age: 'young',
        tags: ['甜美', '元气', '可爱'],
        desc: '甜美元气，适合甜妹、少女偶像',
        voiceType: '',
        voiceTypeV2: 'zh_female_tianmeitaozi_uranus_bigtts',
    },
    {
        id: 'cute-female',
        name: '撒娇学妹',
        gender: 'female',
        age: 'teen',
        tags: ['撒娇', '可爱', '学妹'],
        desc: '软糯撒娇，适合学妹、萌系角色',
        voiceType: '',
        voiceTypeV2: 'zh_female_sajiaoxuemei_uranus_bigtts',
    },
    {
        id: 'warm-female',
        name: '温情女声',
        gender: 'female',
        age: 'adult',
        tags: ['温情', '励志', '治愈'],
        desc: '温暖治愈，适合情感解说、励志旁白',
        voiceType: '',
        voiceTypeV2: 'zh_female_jitangnv_uranus_bigtts',
    },
    {
        id: 'narration-long',
        name: '流畅旁白',
        gender: 'female',
        age: 'adult',
        tags: ['旁白', '长文', '有声书'],
        desc: '流畅耐听，适合长文朗读、有声书旁白',
        voiceType: '',
        voiceTypeV2: 'zh_female_liuchangnv_uranus_bigtts',
    },
    {
        id: 'cartoon-boy',
        name: '猴哥',
        gender: 'male',
        age: 'adult',
        tags: ['角色', '卡通', '豪迈'],
        desc: '喜剧化角色音，适合搞笑、神话角色',
        voiceType: '',
        voiceTypeV2: 'zh_male_sunwukong_uranus_bigtts',
    },
    {
        id: 'cartoon-girl',
        name: '卡通童声',
        gender: 'female',
        age: 'child',
        tags: ['角色', '卡通', '儿童'],
        desc: '卡通化童声，适合动画配角与搞笑桥段',
        voiceType: '',
        voiceTypeV2: 'zh_female_peiqi_uranus_bigtts',
    },
    {
        id: 'cartoon-mizai',
        name: '咪仔',
        gender: 'female',
        age: 'child',
        tags: ['角色', '卡通', '可爱'],
        desc: '可爱卡通女声，适合搞笑与旁支角色',
        voiceType: '',
        voiceTypeV2: 'zh_female_mizai_uranus_bigtts',
    },
    {
        id: 'male-liufei',
        name: '刘飞',
        gender: 'male',
        age: 'adult',
        tags: ['通用', '男声', '自然'],
        desc: '通用男声，自然平实，适合日常对话',
        voiceType: '',
        voiceTypeV2: 'zh_male_liufei_uranus_bigtts',
    },
    {
        id: 'male-sophie',
        name: '魅力苏菲',
        gender: 'male',
        age: 'adult',
        tags: ['通用', '男声', '磁性'],
        desc: '磁性男声，适合成熟男性角色',
        voiceType: '',
        voiceTypeV2: 'zh_male_sophie_uranus_bigtts',
    },
    {
        id: 'fresh-female',
        name: '清新女声',
        gender: 'female',
        age: 'young',
        tags: ['清新', '淡雅', '少女'],
        desc: '清新淡雅女声，适合文艺、校园题材',
        voiceType: '',
        voiceTypeV2: 'zh_female_qingxinnvsheng_uranus_bigtts',
    },
    {
        id: 'teacher-female',
        name: 'Tina老师',
        gender: 'female',
        age: 'adult',
        tags: ['教学', '知性', '英语'],
        desc: '教师音色，适合讲解、科普、教学场景',
        voiceType: '',
        voiceTypeV2: 'zh_female_yingyujiaoxue_uranus_bigtts',
    },
    {
        id: 'service-female',
        name: '暖阳女声',
        gender: 'female',
        age: 'adult',
        tags: ['客服', '温暖', '专业'],
        desc: '温暖专业，适合客服、导览、助手类旁白',
        voiceType: '',
        voiceTypeV2: 'zh_female_kefunvsheng_uranus_bigtts',
    },
    {
        id: 'multi-female',
        name: 'Vivi',
        gender: 'female',
        age: 'young',
        tags: ['多语种', '女声', '情感丰富'],
        desc: '多语种女声（中/日/印尼/西班牙），情感表现力强',
        voiceType: '',
        voiceTypeV2: 'zh_female_vv_uranus_bigtts',
    },
    {
        id: 'en-male-tim',
        name: 'Tim',
        gender: 'male',
        age: 'adult',
        tags: ['英文', '男声', '美式'],
        desc: '美式英语男声，适合英文内容',
        voiceType: '',
        voiceTypeV2: 'en_male_tim_uranus_bigtts',
    },
    {
        id: 'en-female-dacey',
        name: 'Dacey',
        gender: 'female',
        age: 'adult',
        tags: ['英文', '女声', '美式'],
        desc: '美式英语女声，适合英文内容',
        voiceType: '',
        voiceTypeV2: 'en_female_dacey_uranus_bigtts',
    },
    {
        id: 'en-female-stokie',
        name: 'Stokie',
        gender: 'female',
        age: 'adult',
        tags: ['英文', '女声', '美式'],
        desc: '美式英语女声，音色偏低，适合英文旁白',
        voiceType: '',
        voiceTypeV2: 'en_female_stokie_uranus_bigtts',
    },
];

/** 历史值 → 音色 id（老项目 localStorage 里存的是中文名） */
export const LEGACY_ALIASES = {
    默认音色: 'narrator-xiaomei',
    默认: 'narrator-xiaomei',
    女声: 'narrator-xiaomei',
    男声: 'narrator-xiaojun',
};

/**
 * 按 id / 中文名 / 1.0 音色 / 2.0 音色 查找音色条目。
 * @param {string} [value]
 * @returns {object|null}
 */
export function findVoice(value) {
    const key = String(value || '').trim();
    if (!key) return null;

    const alias = LEGACY_ALIASES[key];
    const target = alias || key;

    return (
        VOICE_CATALOG.find((v) => v.id === target)
        || VOICE_CATALOG.find((v) => v.name === target)
        || VOICE_CATALOG.find((v) => v.voiceType === target || v.voiceTypeV2 === target)
        || null
    );
}

/**
 * 把任意历史值归一化成音色 id。
 * 找不到时返回默认音色 id —— 绝不把无法识别的字符串透传给火山接口。
 */
export function normalizeVoiceId(value, fallback = 'narrator-xiaomei') {
    const hit = findVoice(value);
    if (hit) return hit.id;
    // 用户可能直接填了控制台里的任意 voice_type，这类值允许透传（zh_ 中文 / en_ 英文）
    if (/^(?:zh|en)_[a-z0-9_]+$/i.test(String(value || '').trim())) return String(value).trim();
    return fallback;
}

/** 解析为火山 1.0 voice_type */
export function resolveVoiceType(voice) {
    if (!voice) return DEFAULT_VOICE_TYPE_V1;
    const hit = findVoice(voice);
    // 新增的 2.0 专属音色没有 1.0 对应项（voiceType 为空），回落 1.0 默认音色
    if (hit) return hit.voiceType || DEFAULT_VOICE_TYPE_V1;
    // 已经是 voice_type 就透传（便于使用控制台开通的任意音色）
    if (/^zh_[a-z0-9_]+$/i.test(String(voice).trim())) return String(voice).trim();
    console.warn(`[TTS] 未知音色 ${voice}，已回落 ${DEFAULT_VOICE_TYPE_V1}`);
    return DEFAULT_VOICE_TYPE_V1;
}

/**
 * 解析为火山 2.0 speaker（*_uranus_bigtts）。
 * 传 1.0 音色时回落默认 2.0 音色，避免 2.0 接口直接报参数错误。
 */
export function resolveSpeakerV2(voice) {
    if (!voice) return DEFAULT_SPEAKER_V2;
    const hit = findVoice(voice);
    if (hit) return hit.voiceTypeV2;

    const raw = String(voice).trim();
    if (/_uranus_bigtts$/i.test(raw)) return raw;
    console.warn(`[TTS] 音色 ${voice} 不是 2.0 音色（应以 _uranus_bigtts 结尾），已回落 ${DEFAULT_SPEAKER_V2}`);
    return DEFAULT_SPEAKER_V2;
}

/**
 * 是否英文音色（2.0 speaker 以 en_ 开头）。
 * 英文音色只认英文文本：喂中文时 2.0 接口返回 200 但音频帧为空，
 * 表现为「没有声音」，因此合成前需要显式拦截并给出可读提示。
 */
export function isEnglishSpeaker(value) {
    const hit = findVoice(value);
    const speaker = hit ? hit.voiceTypeV2 : String(value || '').trim();
    return /^en_/i.test(speaker);
}

/** 文本是否只含中文/标点，完全不含拉丁字母（英文音色无法朗读这种文本） */
export function isChineseOnlyText(text) {
    const raw = String(text || '');
    if (!raw.trim()) return false;
    return !/[A-Za-z]/.test(raw);
}

/**
 * 依据人物信息推断音色 id —— 只用于 AI 未给出（或给出非法值）时的兜底，
 * 保证每个角色都有一个可用音色，而不是空着。
 *
 * @param {object} p
 * @param {string} [p.gender]  'male' | 'female' | '男' | '女'
 * @param {string} [p.description]
 * @param {string} [p.bio]
 * @param {string} [p.name]
 * @returns {string} 音色 id
 */
export function inferVoiceId({ gender, description, bio, name } = {}) {
    const text = `${name || ''} ${description || ''} ${bio || ''}`;

    let g = String(gender || '').toLowerCase();
    if (g === '女') g = 'female';
    if (g === '男') g = 'male';
    if (!g) {
        // 单字「女」要保留：描述里常见「女记者」「女掌柜」这类写法
        if (/女|她|姑娘|少女|母亲|妻子|姐|妹|嫂|姨|婆|太后|皇后|妃/.test(text)) g = 'female';
        else if (/男性|男子|男生|男孩|少年|父亲|丈夫|哥|弟|叔|伯|爷|公|国王|皇帝|他/.test(text)) g = 'male';
    }

    // 年龄只信阿拉伯数字：中文数字做子串匹配会误判（「二十五岁」里就含「十五岁」）
    const ageMatch = text.match(/(\d{1,2})\s*岁/);
    const age = ageMatch ? Number(ageMatch[1]) : null;
    if (age !== null && age <= 12) return 'child';
    if (/儿童|小孩|幼童|孩童|小学生|幼儿园/.test(text)) return 'child';

    if (g === 'male') {
        if (age !== null && age <= 19) return 'young-male';
        if (/少年|学生|青春|十六|十七/.test(text)) return 'young-male';
        if (/中年|四十|五十|六十|沉稳|威严|老板|董事|父亲|将军|反派|匪|官|爷/.test(text)) return 'calm-male';
        return 'narrator-xiaojun';
    }

    if (g === 'female') {
        if (/温柔|母亲|妻子|嫂|姨|中年|四十|五十|成熟|贤惠/.test(text)) return 'gentle-female';
        if (/少女|姑娘|年轻|学生|二十|活泼|清亮|清纯/.test(text)) return 'bright-female';
        return 'narrator-xiaomei';
    }

    return 'narrator-xiaomei';
}

/**
 * 供 LLM 提示词使用的音色清单（人类可读，含选择建议）。
 * @returns {string}
 */
export function voiceCatalogForPrompt() {
    return VOICE_CATALOG.map(
        (v) => `- ${v.id}（${v.name}）：${v.desc}；标签：${v.tags.join('/')}`
    ).join('\n');
}

export default {
    VOICE_CATALOG,
    LEGACY_ALIASES,
    DEFAULT_SPEAKER_V2,
    findVoice,
    normalizeVoiceId,
    resolveVoiceType,
    resolveSpeakerV2,
    isEnglishSpeaker,
    isChineseOnlyText,
    inferVoiceId,
    voiceCatalogForPrompt,
};
