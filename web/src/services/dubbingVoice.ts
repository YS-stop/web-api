/**
 * dubbingVoice.ts
 *
 * 「角色 → 音色」解析的唯一入口。
 *
 * 为什么单独抽一份：
 *   资产确认页配置的 voiceName / voicePrompt 是本项目音色的唯一真源。
 *   配音面板、整集音轨生成、成片合并三处如果各自实现一遍解析，
 *   迟早会出现「面板显示新音色、成片还是旧声音」这类不一致。
 *
 * 依赖方向：本文件只依赖 voiceCatalog，不依赖 dubbingService，
 * 避免与「台词数据结构」形成循环引用。
 */

import { DEFAULT_VOICE_ID, normalizeVoiceId } from './voiceCatalog';

/** 与 dubbingService.NARRATOR 保持一致（此处不 import，避免循环依赖） */
const NARRATOR_ROLE = '旁白';

/** 角色音色的来源字段：只取资产对象里与音色相关的部分 */
export interface CharacterVoiceSource {
    name: string;
    voiceName?: string;
    voicePrompt?: string;
}

/** 单个角色解析后的音色设置 */
export interface RoleVoice {
    /** 音色 id（已归一化，可直接发给 TTS 接口） */
    voice: string;
    /** 自定义风格指令（对应 2.0 的 context_texts） */
    prompt?: string;
}

export type RoleVoiceMap = Record<string, RoleVoice>;

/**
 * 由资产角色列表构建 角色名 → 音色 映射。
 *
 * 角色名是台词与资产之间的唯一关联键（DubbingLine.role 存的就是名字），
 * 所以这里也用 name 建 map；同名角色视为同一人。
 */
export const buildRoleVoiceMap = (characters: CharacterVoiceSource[] = []): RoleVoiceMap => {
    const map: RoleVoiceMap = {};
    for (const character of characters) {
        const name = String(character?.name || '').trim();
        if (!name) continue;
        const rawVoice = String(character.voiceName || '').trim();
        const prompt = String(character.voicePrompt || '').trim();
        map[name] = {
            // 资产没配音色时用默认音色，保证一定能合成
            voice: normalizeVoiceId(rawVoice || DEFAULT_VOICE_ID),
            prompt: prompt || undefined,
        };
    }
    return map;
};

/**
 * 解析某条台词该用的音色。
 * 旁白用面板里选的旁白音色；角色用资产配置的音色，缺失时回落旁白。
 */
export const resolveLineVoice = (
    role: string,
    map: RoleVoiceMap,
    narratorVoice: string
): string => {
    if (!role || role === NARRATOR_ROLE) return normalizeVoiceId(narratorVoice || DEFAULT_VOICE_ID);
    return map[role]?.voice || normalizeVoiceId(narratorVoice || DEFAULT_VOICE_ID);
};

/** 解析某条台词该用的风格指令（旁白不参与自定义音色） */
export const resolveLinePrompt = (role: string, map: RoleVoiceMap): string | undefined => {
    if (!role || role === NARRATOR_ROLE) return undefined;
    return map[role]?.prompt;
};

/**
 * 一条台词完整的风格指令：角色自定义音色提示 + 剧本括号里的表演提示。
 *
 * 剧本写成「老朱（往前一步）：谈单子，带这么多现金？」时，
 * 「往前一步」是表演/情绪信息，只靠角色音色表达不出来，必须随台词一起送给 TTS。
 */
export const resolveLineContext = (
    line: { role: string; tone?: string },
    map: RoleVoiceMap
): string[] => {
    const parts: string[] = [];
    const base = resolveLinePrompt(line.role, map);
    if (base) parts.push(base);
    const tone = String(line.tone || '').trim();
    if (tone) parts.push(`语气与表演：${tone}`);
    return parts;
};

/**
 * 台词音频的「音色指纹」。
 *
 * 用来判断浏览器里已合成的 audioUrl 是否仍然有效：
 * 资产的音色或风格指令一改，指纹就变，旧音频自动判定为过期并重新合成。
 * 这与后端音轨文件名的指纹是同一套思路（后端还额外包含集号/音量/语速）。
 */
export const lineVoiceSignature = (p: {
    role: string;
    text: string;
    voice: string;
    prompt?: string;
}): string =>
    [p.role, p.text.trim(), normalizeVoiceId(p.voice), (p.prompt || '').trim()].join('\u0001');
