/**
 * stylePresets.ts
 *
 * 本地「画面风格库 + 提示词增强」。
 * 提示词结构、镜头语言与风格词汇提炼自 GitHub 开源 skill：
 *   - songguoxs/seedance-prompt-skill（Seedance 2.0 视频提示词工程）
 *   - yang0/handraw-style（331 种手绘/国风/动漫风格词库）
 * 生成时由 buildImagePrompt / buildVideoPrompt 自动拼入 prompt，无需外部依赖。
 */

export interface StylePreset {
    id: string;
    /** 下拉框中显示的名称 */
    name: string;
    /** 生图风格描述：画质 / 色彩 / 光影 / 构图 / 材质 */
    image: string;
    /** 生视频风格描述：在画质基础上补充运镜、动效与氛围 */
    video: string;
}

export interface FormPreset {
    id: string;
    name: string;
    /** 形象 / 人物面孔约束 */
    hint: string;
}

/* ------------------------------------------------------------------ *
 * 镜头语言词汇库（源自 seedance-prompt-skill「镜头语言词汇库」）
 * 供后续扩展「运镜 / 景别」选择器使用，也用于生视频时的氛围增强
 * ------------------------------------------------------------------ */
export const LENS_LANGUAGE = {
    景别: ['大远景', '远景', '全景', '中景', '近景', '特写', '大特写'],
    运镜: ['推镜头', '拉镜头', '摇镜头', '移镜头', '跟拍', '环绕拍摄', '航拍', '手持跟拍', '希区柯克变焦'],
    角度: ['平视', '俯拍', '仰拍', '低角度', '鸟瞰视角', '鱼眼镜头', '第一人称视角', '主观视角'],
    节奏: ['慢动作', '快切', '延时摄影', '一镜到底', '升格拍摄', '硬切', '卡点'],
    焦点: ['浅景深', '深景深', '焦点转移', '虚化背景', '选择性对焦'],
    特殊: ['遮挡擦镜转场', '无缝渐变转场', '环绕摇镜快切特写', '定格慢放'],
} as const;

/* 风格词汇库（源自 seedance-prompt-skill「风格词汇库」） */
export const STYLE_LEXICON = {
    画面质感: ['电影感', '胶片质感', '高清晰度', '8K分辨率', 'HDR', 'RAW质感'],
    影像风格: ['好莱坞大片', '独立电影', '纪录片', 'MV风格', '广告大片', 'Vlog风格', '2.35:1宽银幕'],
    色调氛围: ['暖色调', '冷色调', '高对比度', '低饱和度', '莫兰迪色系', '赛博朋克霓虹', '红金高饱和'],
    艺术风格: ['写实主义', '超现实主义', '极简主义', '蒸汽波', '赛博朋克', '中国风水墨', '3D国漫CG'],
    光影效果: ['自然光', '侧逆光', '丁达尔效应', '霓虹灯光', '月光', '黄金时段光线', '体积光'],
    动画风格: ['中国奇幻动画电影风格', '超精细CG动画', '日漫赛璐璐', '3D渲染写实'],
} as const;

/* 主题 → 风格匹配表（源自 seedance-prompt-skill「图片风格必须与视频主题契合」） */
export const THEME_STYLE_MAP: Record<string, string> = {
    仙侠: '3D国漫渲染风格、中国仙侠概念设计风格',
    修真: '3D国漫渲染风格、中国仙侠概念设计风格',
    古风: '中国风工笔画、水墨画、古典绘画风格',
    历史: '中国风工笔画、水墨画、古典绘画风格',
    赛博朋克: '未来科幻写实CG风格、概念设计风格',
    科幻: '未来科幻写实CG风格、概念设计风格',
    现实: '电影摄影写实风格、人像摄影风格',
    都市: '电影摄影写实风格、人像摄影风格',
    美食: '美食广告摄影风格、商业摄影风格',
    风光: '风光摄影风格、航拍纪录片风格',
    动漫: '日漫赛璐璐、国漫3D渲染风格',
};

/* ------------------------------------------------------------------ *
 * 内置风格预设：每个风格分别给出「生图」与「生视频」描述词
 * ------------------------------------------------------------------ */
export const STYLE_PRESETS: StylePreset[] = [
    {
        id: 'realistic-film',
        name: '写实影视',
        image: '电影摄影写实风格，人像摄影质感，自然光影，浅景深，胶片颗粒感，HDR高动态范围',
        video: '电影感，写实影视风格，真实人物与真实场景，自然光与侧逆光，浅景深，电影级运镜，胶片质感',
    },
    {
        id: 'urban-texture',
        name: '都市质感',
        image: '现代都市时尚摄影，清透冷色调，玻璃与金属质感，几何构图，时尚广告级精修',
        video: '都市时尚质感，清透冷色，流畅镜头运动，潮流氛围，广告大片质感，浅景深突出主体',
    },
    {
        id: 'ancient-drama',
        name: '古风短剧',
        image: '中国风工笔画与水墨风格，古典绘画质感，低饱和暖色调，水墨意境，留白构图，服饰与建筑考究',
        video: '古风影视质感，中国风水墨意境，柔和暖光，缓缓运镜，衣袂与发丝自然飘动，仙侠意境氛围',
    },
    {
        id: 'anime',
        name: '动画风',
        image: '动漫赛璐璐风格，日漫质感，干净线条与色块，明亮色彩，赛璐璐上色',
        video: '动画风格，流畅帧动画，鲜明色彩，夸张表现力，日系番剧质感，3D国漫CG渲染',
    },
    {
        id: 'cyberpunk',
        name: '赛博朋克',
        image: '赛博朋克风格，未来科幻写实CG，霓虹蓝紫光，高对比，金属与全息投影，概念设计感',
        video: '赛博朋克风格，未来科幻CG质感，霓虹灯光闪烁，低机位广角运镜，高对比色彩，未来都市氛围',
    },
    {
        id: '2d-animation',
        name: '2D动画风',
        image: '二维动画赛璐璐上色（2D cel animation），清晰线稿与平涂色块，边缘轮廓线明确，色彩明亮通透，日式/国产二维动画质感，明确为 2D 手绘动画，非 3D 非写实摄影',
        video: '2D 动画风格，赛璐璐平涂与清晰线稿，逐帧动画流畅，色彩鲜明，二维动画演出感，非 3D 渲染非实拍',
    },
    {
        id: '2d-manhwa',
        name: '2D韩漫风',
        image: '精致韩漫插画（Korean webtoon, semi-realistic manhwa），细腻干净的数字线稿，柔和赛璐璐渐变上色（soft cel with airbrushed gradients），发丝与眼瞳带精细高光，五官半写实、八头身修长身形，高级低饱和配色，二维插画质感',
        video: '韩漫插画风格，细腻线稿与柔和渐变上色，发丝与眼神高光精致，镜头柔和，半写实二维动画演出',
    },
    {
        id: '3d-donghua',
        name: '3D国漫',
        /**
         * 曾经只写了「UE5 精细建模 / PBR / SSS 肤质 / 真实褶皱」这类渲染技术词，
         * 只排除了「2D 插画」，没有排除「真人」，结果模型一律画成写实 CG 人像。
         * 3D 国漫的本质是「三维建模 + 动漫化五官比例」，所以要先把造型说清楚。
         */
        image: '国产三维动画（3D 国漫 / Chinese 3D donghua）风格，动漫化角色设计：五官按动画比例塑造、眼睛略大而有神、鼻唇简化、脸型干净利落，皮肤为细腻均匀的 CG 材质（无毛孔、无真实皮肤纹理）；UE5 级三维建模与 PBR 材质，古风服饰纹样与佩饰考究，发丝成束分层；体积光与丁达尔光束；输出动画电影级的角色造型，非真人、非真人照片、非 3D 拟真人、非影视剧剧照',
        video: '国产三维动画（3D 国漫）风格，动漫化角色与场景，UE5 级渲染，体积光与克制粒子特效，衣袂发丝自然飘动，东方玄幻宏大场景，电影级运镜，非真人实拍',
    },
    {
        id: '3d-modeling',
        name: '3D建模渲染',
        image: '3D 建模渲染，干净拓扑与清晰结构，PBR 材质与真实反射，三点棚拍布光，中性灰或纯色背景，Octane 渲染器风格，产品级 3D 可视化质感，形体准确无变形',
        video: '3D 建模展示动画，PBR 材质，棚拍光与柔和反射，镜头环绕展示主体，干净背景，产品级 3D 可视化',
    },
    {
        id: '3d-pixar',
        name: '3D皮克斯动画',
        image: '皮克斯/迪士尼 3D 动画风格，卡通化夸张比例，大而富有表现力的眼睛，圆润造型，次表面散射（耳朵与鼻尖透光），柔和体积主光与全局光照，明亮饱和的英雄色配色，高精度 3D CGI 渲染，非实拍非 2D',
        video: '皮克斯 3D 动画风格，流畅动画表演，夸张而自然的动作，柔和全局光照，明亮饱和色彩，电影级 3D 动画质感',
    },
    {
        id: '3d-digital-human',
        name: '3D拟真人',
        /*
         * 3D 拟真人的难点：写「超写实」会被模型做成实拍照片，写「卡通」又会变成皮克斯。
         * 按社区验证有效的写法，核心是用「真人级比例 + CG 材质」制造违和感最小的 CG 感：
         *   1. 五官骨骼按真人比例（保住「拟真人」）；
         *   2. 皮肤/头发/光照全部换成 CG 渲染语言（瓷感树脂、边缘高光、局部受光、体积雾辉光）；
         *   3. 显式排除实拍特征（毛孔、细纹、油光、胶片颗粒）。
         */
        image: '高精度 3D 数字人 CG 渲染（high-precision 3D digital human, MetaHuman / UE5 实时渲染），偏现实的高端风格化写实肖像——五官比例与骨骼结构按真人，但整体明确是 3D CG 渲染而非实拍照片；皮肤为半透明瓷感与树脂感的高级 CG 材质，表面均匀通透、无毛孔无细纹，带次表面散射透光；头发为分层渲染的发丝，单根走向清晰，发梢有透光与边缘高光；侧上方暖光打亮头顶一侧与发丝边缘，形成柔和金色轮廓光；面部局部受光、局部留影，转折面与体积感明确；浅景深、背景虚化，轻微体积雾与柔和辉光，PBR 物理材质与光线追踪反射，电影级 CG 打光。不要真实照片，不要皮肤毛孔与细纹，不要油光与胶片颗粒，不要磨皮美颜的塑料假脸',
        video: '3D 数字人 CG 动画（MetaHuman / UE5 实时渲染），五官比例写实但明确为 CG 渲染而非实拍；瓷感树脂皮肤带次表面散射，发丝分层渲染，侧上方暖光与边缘高光，局部受光局部留影，浅景深与柔和辉光，体积雾氛围，光线追踪反射，电影级 CG 打光；不要真实照片质感，不要皮肤毛孔与油光',
    },
];

/* ------------------------------------------------------------------ *
 * 分类化风格词（人物 / 场景 / 道具）
 *
 * STYLE_PRESETS.image 是按「人物」写的（人像摄影质感、次表面散射皮肤、
 * 五官比例、发丝渲染等），直接套到场景与道具上会污染画面：
 *   - 场景图被塞入「皮肤」「五官」→ 模型容易在空镜里脑补人物；
 *   - 道具图被塞入「人像摄影」→ 静物拍不出材质与结构。
 * 因此场景、道具各自单独给一套贴合主体的风格词。
 * 人物沿用 STYLE_PRESETS.image，无需重复维护。
 * ------------------------------------------------------------------ */
export type AssetPromptCategory = 'characters' | 'scenes' | 'props';

export const ASSET_STYLE_TEXT: Record<string, { scene: string; prop: string }> = {
    写实影视: {
        scene: '电影级实拍场景，真实建筑结构与材质，自然光影与大气透视，空间纵深真实，胶片颗粒感，HDR高动态范围',
        prop: '商业静物摄影，真实材质与使用痕迹，柔和定向光与自然投影，浅景深，细节锐利，胶片颗粒感',
    },
    都市质感: {
        scene: '现代都市空间摄影，清透冷色调，玻璃幕墙与金属结构，几何秩序感，城市天际线层次，时尚广告级建筑精修',
        prop: '现代都市产品静物摄影，清透冷色调，玻璃与金属反光，极简几何陈列，时尚广告级精修',
    },
    古风短剧: {
        scene: '中国古典园林与建筑场景，工笔画与水墨意境，飞檐斗拱与木构细节考究，低饱和暖色调，留白与薄雾层次',
        prop: '中式古典器物，工笔画质感，木作、陶瓷与铜器纹理考究，低饱和暖色调，水墨留白背景',
    },
    动画风: {
        scene: '动漫背景美术（anime background art），赛璐璐平涂与手绘场景，干净线条分区，明亮通透色彩，日系番剧场景质感',
        prop: '动漫道具设定，赛璐璐平涂上色，清晰轮廓线与色块，明亮色彩，日系番剧道具质感',
    },
    赛博朋克: {
        scene: '赛博朋克未来都市景观，霓虹蓝紫光，湿地面镜面反射，高对比明暗，全息投影广告与金属管道，概念设计感',
        prop: '赛博朋克机械装置，霓虹蓝紫光，金属与全息投影材质，高对比，未来科技概念设计',
    },
    '2D动画风': {
        scene: '二维动画场景美术，赛璐璐平涂背景，清晰线稿与色块分区，明亮通透色彩，日式/国产二维动画场景质感，明确为 2D 手绘背景，非 3D 非写实摄影',
        prop: '二维动画道具设定，赛璐璐平涂，明确轮廓线与色块，明亮色彩，2D 手绘动画道具质感，非 3D 非写实摄影',
    },
    '2D韩漫风': {
        scene: '韩漫插画场景（Korean webtoon background），细腻线稿与柔和渐变上色，光影通透，空间层次干净，高级低饱和配色，二维插画质感',
        prop: '韩漫插画道具，细腻线稿与柔和渐变上色，材质高光精致，高级低饱和配色，二维插画质感',
    },
    '3D国漫': {
        scene: '3D 国漫仙侠 CG 场景，UE5 级精细建模，古风建筑与山水考究，PBR 物理材质，体积光与丁达尔光束，雾气层次分明，明确为 3D 渲染而非 2D 插画',
        prop: '3D 国漫古风道具，UE5 级精细建模，PBR 物理材质，木作、金属与玉器质感考究，体积光，明确为 3D 渲染而非 2D 插画',
    },
    '3D建模渲染': {
        scene: '3D 建筑与空间建模渲染，干净拓扑与清晰结构，PBR 材质与真实反射，三点棚拍布光，中性灰背景，Octane 渲染器风格，形体准确无变形',
        prop: '3D 产品级建模渲染，干净拓扑与准确结构，PBR 材质与真实反射，三点棚拍布光，中性灰或纯色背景，Octane 渲染器风格',
    },
    '3D皮克斯动画': {
        scene: '皮克斯/迪士尼 3D 动画场景，卡通化夸张比例与圆润造型，明亮饱和的英雄色配色，柔和全局光照，高精度 3D CGI 渲染，非实拍非 2D',
        prop: '皮克斯 3D 动画道具，卡通化圆润造型与夸张比例，明亮饱和色彩，柔和全局光照，高精度 3D CGI 渲染，非实拍非 2D',
    },
    '3D拟真人': {
        scene: '次世代 3D CG 场景，UE5 级实时渲染，PBR 物理材质，光线追踪反射，电影级 CG 打光，空间整洁、材质纯净，呈现 3D 渲染质感而非实拍照片',
        prop: '次世代 3D CG 道具，3D CG 渲染而非实拍照片，PBR 物理材质，光线追踪反射，边缘锐利、材质纯净，UE5 级实时渲染',
    },
};

export const FORM_PRESETS: FormPreset[] = [
    { id: 'cn-real', name: '国内真人风格', hint: '中国演员面孔，东方面孔，符合国内审美' },
    { id: 'cn-digital-human', name: '国内拟真人风格', hint: '东方面孔五官比例，符合国内审美的 3D CG 数字人，不是真实演员照片' },
    { id: 'eu-real', name: '欧美真人风格', hint: '欧美演员面孔，西方面孔，国际化审美' },
    { id: 'anime-form', name: '动漫风格', hint: '二次元动漫角色形象' },
    // 3D 国漫既不能用「二次元动漫」（会往 2D 平涂走），也不能用「中国演员面孔」（会往真人走）
    {
        id: 'cn-3d-anime',
        name: '3D 国漫动画形象',
        hint: '三维动画角色造型，动漫化五官比例（眼睛略大、鼻唇简化、脸型干净），皮肤为干净 CG 材质无毛孔，不是真人、不是真人照片、不是影视剧妆造',
    },
];

export const STYLE_OPTIONS = STYLE_PRESETS.map((s) => s.name);
export const FORM_OPTIONS = FORM_PRESETS.map((f) => f.name);

/* ------------------------------------------------------------------ *
 * 项目「内容类型」→ 画面风格 映射
 * 资产确认生图、分镜生图 / 生视频统一按此取风格，确保画风与题材一致。
 * ------------------------------------------------------------------ */
export const CONTENT_TYPE_STYLE_MAP: Record<string, string> = {
    '国内真人': '写实影视',
    '2D动画': '2D动画风',
    '2D精致韩漫': '2D韩漫风',
    '3D国漫': '3D国漫',
    // 历史内容类型名，仍要能命中新风格名，否则老项目会回落成写实影视
    '3D国漫古风': '3D国漫',
    '3D建模': '3D建模渲染',
    '3D皮克斯': '3D皮克斯动画',
    '3D拟真人国内': '3D拟真人',
};

/**
 * 依据内容类型解析对应风格名。
 * 优先精确匹配；其次按关键词从具体到宽泛兜底（兼容历史类型名）。
 */
export const resolveStyleByContentType = (contentType?: string): string => {
    if (!contentType) return STYLE_PRESETS[0].name;

    const exact = CONTENT_TYPE_STYLE_MAP[contentType];
    if (exact) return exact;

    // 关键词兜底：顺序必须从具体到宽泛，避免「3D拟真人」被「真人」抢走
    if (contentType.includes('拟真人')) return '3D拟真人';
    if (contentType.includes('皮克斯')) return '3D皮克斯动画';
    if (contentType.includes('建模')) return '3D建模渲染';
    if (contentType.includes('国漫')) return '3D国漫';
    if (contentType.includes('韩漫')) return '2D韩漫风';
    if (contentType.includes('2D') || contentType.includes('动画')) return '2D动画风';
    if (contentType.includes('漫剧')) return '2D动画风'; // 历史类型「AI漫剧」
    if (contentType.includes('古风')) return '古风短剧';
    if (contentType.includes('真人') || contentType.includes('短剧')) return '写实影视'; // 历史「真人短剧」
    if (contentType.includes('都市')) return '都市质感';
    if (contentType.includes('赛博')) return '赛博朋克';
    return STYLE_PRESETS[0].name;
};

/**
 * 该内容类型是否为「实拍真人」。
 * 只有纯真人类型需要「照片质感」约束（毛孔、细纹、自然瑕疵）；
 * 2D / 3D 系列必须反过来排除照片质感，否则会被拉回实拍。
 */
export const isLiveActionContentType = (contentType?: string): boolean => {
    if (!contentType) return true;
    // 具体优先：「3D拟真人国内」虽然含「真人」，但它是 3D，不是实拍
    if (
        contentType.includes('拟真人') ||
        contentType.includes('3D') ||
        contentType.includes('2D') ||
        contentType.includes('漫') ||
        contentType.includes('动画') ||
        contentType.includes('皮克斯') ||
        contentType.includes('建模')
    ) {
        return false;
    }
    return contentType.includes('真人');
};

/**
 * 依据内容类型解析人物形象约束。
 * 真人 / 拟真人用真人面孔；2D / 3D 卡通类用动漫形象，
 * 避免给卡通角色硬套「中国演员面孔」导致画风割裂。
 */
export const resolveFormByContentType = (contentType?: string): string => {
    if (!contentType) return FORM_PRESETS[0].name;
    // 3D 拟真人：五官按东方面孔，但仍是 CG 角色，不能写成「中国演员」否则被拉回实拍
    if (contentType.includes('拟真人')) return '国内拟真人风格';
    // 3D 国漫 / 皮克斯是三维动画，不是二次元 2D，必须放在「动漫风格」之前
    if (contentType.includes('国漫') || contentType.includes('皮克斯')) return '3D 国漫动画形象';
    if (contentType.includes('真人')) return '国内真人风格';
    if (
        contentType.includes('2D') ||
        contentType.includes('漫') ||
        contentType.includes('动画')
    ) {
        return '动漫风格';
    }
    return FORM_PRESETS[0].name;
};

/**
 * 历史风格名 → 现行风格名。
 * 风格改名后，已保存的老项目（project.style、节点 style 字段）仍存着旧名，
 * 不兼容就会静默回退到写实影视，画风突变。
 */
const STYLE_ALIASES: Record<string, string> = {
    '3D国漫古风': '3D国漫',
};

const findStyle = (name: string): StylePreset => {
    const target = STYLE_ALIASES[name] || name;
    return STYLE_PRESETS.find((s) => s.name === target) || STYLE_PRESETS[0];
};

/**
 * 按资产分类取「生图」风格词：
 *   characters → STYLE_PRESETS.image（人像专用词）
 *   scenes     → ASSET_STYLE_TEXT[style].scene（场景专用词）
 *   props      → ASSET_STYLE_TEXT[style].prop（道具专用词）
 * 风格名缺失或未登记时回退到该风格的人像词，保证不返回空。
 */
export const getAssetStyleImage = (styleName: string | undefined, category: AssetPromptCategory): string => {
    const style = findStyle(styleName || '');
    if (category === 'scenes') return ASSET_STYLE_TEXT[style.name]?.scene || style.image;
    if (category === 'props') return ASSET_STYLE_TEXT[style.name]?.prop || style.image;
    return style.image;
};

/**
 * 按资产分类取「生视频」风格词。
 * 场景 / 道具以对应生图词为基础，去掉人像运镜，避免视频里出现人物。
 */
export const getAssetStyleVideo = (styleName: string | undefined, category: AssetPromptCategory): string => {
    const style = findStyle(styleName || '');
    if (category === 'characters') return style.video;
    const text = ASSET_STYLE_TEXT[style.name];
    if (category === 'scenes') return text?.scene || style.video;
    return text?.prop || style.video;
};

const findForm = (name: string): FormPreset | undefined => FORM_PRESETS.find((f) => f.name === name);

/** 拼接时避免重复：若基础 prompt 已包含该片段（取前 4 字兜底），则不再追加 */
const contains = (base: string, fragment: string): boolean =>
    base.includes(fragment) || base.includes(fragment.slice(0, 4));

/** 生视频结尾的禁止项（源自 seedance-prompt-skill「禁止项声明」），避免生成字幕/水印 */
/**
 * 生视频负面约束。
 *
 * 人物漂移（换脸、换发型、服装变色、年龄忽大忽小）是 AI 视频最常见的失败，
 * 根因是模型把「长相/服装」当成可自由发挥的部分。负面清单必须把这些
 * 不变量逐项点名，配合正面的一致性约束才压得住。
 */
const VIDEO_NEGATIVE =
    '禁止出现任何文字、字幕、LOGO、水印；' +
    '禁止换脸、改变五官与脸型、改变年龄与体型；' +
    '禁止改变发型发色、改变服装款式与颜色、增减配饰；' +
    '禁止出现参考图以外的多余人物、多余人脸、重复面孔、畸形手指、肢体断裂';

/**
 * 生图提示词：基础描述 + 形象约束 + 画面风格，拼成一段完整提示词。
 */
export const buildImagePrompt = (base: string, styleName?: string, formName?: string): string => {
    const style = findStyle(styleName || '');
    const form = formName ? findForm(formName) : undefined;
    const parts: string[] = [(base || '').trim()].filter(Boolean);
    if (form && form.hint && !contains(base || '', form.hint)) parts.push(form.hint);
    if (style && style.image && !contains(base || '', style.image)) parts.push(`画面风格：${style.image}`);
    return parts.join('，');
};

/**
 * 生视频提示词：基础描述 + 形象约束 + 画面风格（含运镜/氛围）+ 禁止项。
 * 组织顺序遵循 Seedance 推荐结构：主体动作 → 环境光影 → 镜头语言 → 风格关键词。
 */
export const buildVideoPrompt = (base: string, styleName?: string, formName?: string): string => {
    const style = findStyle(styleName || '');
    const form = formName ? findForm(formName) : undefined;
    const parts: string[] = [(base || '').trim()].filter(Boolean);
    if (form && form.hint && !contains(base || '', form.hint)) parts.push(form.hint);
    if (style && style.video && !contains(base || '', style.video)) parts.push(`画面风格：${style.video}`);
    if (!contains(base || '', VIDEO_NEGATIVE)) parts.push(VIDEO_NEGATIVE);
    return parts.join('，');
};

/**
 * 多行版视频提示词。
 *
 * 结构化提示词本身是多段的（参考图/场景/站位/动作/台词/镜头/一致性），
 * 再用逗号把风格与负面约束续在后面，会读成一大串黏连的句子；
 * 换成换行分隔，模型更容易把「禁止项」当成独立指令。
 */
export const buildVideoPromptMultiline = (base: string, styleName?: string, formName?: string): string => {
    const style = findStyle(styleName || '');
    const form = formName ? findForm(formName) : undefined;
    const parts: string[] = [(base || '').trim()].filter(Boolean);
    if (form && form.hint && !contains(base || '', form.hint)) parts.push(`【人物形象】${form.hint}`);
    if (style && style.video && !contains(base || '', style.video)) parts.push(`【画面风格】${style.video}`);
    if (!contains(base || '', VIDEO_NEGATIVE)) parts.push(`【禁止】${VIDEO_NEGATIVE}`);
    return parts.join('\n');
};
