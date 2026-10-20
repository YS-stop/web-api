/**
 * voiceCatalog.ts
 *
 * 音色目录 —— 前端唯一真源，内容与后端 api/server/config/voices.js 保持一致。
 *
 * 三层信息一次给全，避免「预设里有、映射里没有」：
 *   id           语义化音色 id（推荐存储值）
 *   name         中文显示名（兼容老数据：以前存的就是中文名）
 *   voiceType    火山 1.0 音色（v1 接口）；空字符串表示该音色没有 1.0 版本
 *   voiceTypeV2  火山 2.0 音色（*_uranus_bigtts，v3 与 WebSocket 双向）
 *
 * 本表所有 voiceTypeV2 均已用真实接口逐条验证可用，且音频指纹互不相同。
 * 改这里务必同步改后端那份，否则会出现前端能选、后端不认识的情况。
 */

export interface VoiceOption {
    /** 语义化 id，推荐持久化这个值 */
    id: string;
    /** 中文显示名，兼容历史数据 */
    name: string;
    gender: 'male' | 'female';
    age: 'child' | 'teen' | 'young' | 'adult' | 'mature';
    /** 用于 AI 分配与人工挑选的语义标签 */
    tags: string[];
    /** 适用场景说明，展示在音色选择器里 */
    desc: string;
    /** 火山 1.0 voice_type；空表示无 1.0 版本 */
    voiceType: string;
    /** 火山 2.0 speaker（*_uranus_bigtts） */
    voiceTypeV2: string;
}

export const VOICE_CATALOG: VoiceOption[] = [
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

/** 历史值 → 音色 id（老项目 localStorage 里存的是中文名，甚至有「默认音色」） */
export const LEGACY_VOICE_ALIASES: Record<string, string> = {
    默认音色: 'narrator-xiaomei',
    默认: 'narrator-xiaomei',
    女声: 'narrator-xiaomei',
    男声: 'narrator-xiaojun',
};

/** 默认音色 id（旁白、以及任何未指定音色的角色） */
export const DEFAULT_VOICE_ID = 'narrator-xiaomei';

/** 兼容旧代码：VOICE_OPTIONS 只暴露 id + 中文名 */
export const VOICE_OPTIONS: { id: string; name: string }[] = VOICE_CATALOG.map((v) => ({
    id: v.id,
    name: v.name,
}));

/** 英文音色（按 speaker 前缀判断，避免给英文音色单独维护一份目录） */
export const isEnglishVoice = (v: VoiceOption): boolean => v.voiceTypeV2.startsWith('en_');

export interface VoiceGroup {
    title: string;
    items: VoiceOption[];
}

/**
 * 按「男声 / 女声 / 儿童 / 英文」分组，供选择器展示。
 * 儿童优先判定（不分男女），英文音色单独一组，避免混进中文角色里选错。
 */
export const groupVoices = (list: VoiceOption[] = VOICE_CATALOG): VoiceGroup[] =>
    [
        { title: '男声', items: list.filter((v) => !isEnglishVoice(v) && v.age !== 'child' && v.gender === 'male') },
        { title: '女声', items: list.filter((v) => !isEnglishVoice(v) && v.age !== 'child' && v.gender === 'female') },
        { title: '儿童', items: list.filter((v) => !isEnglishVoice(v) && v.age === 'child') },
        { title: '英文', items: list.filter(isEnglishVoice) },
    ].filter((g) => g.items.length > 0);

/** 按 id / 中文名 / 1.0 / 2.0 voice_type 查找 */
export const findVoice = (value?: string | null): VoiceOption | null => {
    const key = String(value || '').trim();
    if (!key) return null;

    const target = LEGACY_VOICE_ALIASES[key] || key;
    return (
        VOICE_CATALOG.find((v) => v.id === target)
        || VOICE_CATALOG.find((v) => v.name === target)
        || VOICE_CATALOG.find((v) => v.voiceType === target || v.voiceTypeV2 === target)
        || null
    );
};

/** 归一化成音色 id；无法识别时给默认值（绝不把未知字符串透传给接口） */
export const normalizeVoiceId = (value?: string | null, fallback = DEFAULT_VOICE_ID): string => {
    const hit = findVoice(value);
    if (hit) return hit.id;
    const raw = String(value || '').trim();
    // zh_ / en_ 都是合法的火山 voice_type，直接透传（en_ 音色由英文分组使用）
    if (/^(?:zh|en)_[a-z0-9_]+$/i.test(raw)) return raw;
    return fallback;
};

/** 展示用中文名：无论存的是 id、中文名还是 voice_type，都能显示成人话 */
export const voiceLabel = (value?: string | null): string => {
    if (!value) return '';
    const hit = findVoice(value);
    if (hit) return hit.name;
    return String(value);
};

/** 是否是一个已收录的标准音色 */
export const isKnownVoice = (value?: string | null): boolean => Boolean(findVoice(value));
