/**
 * modelDefaults.ts
 *
 * 画布新建节点时的默认模型。
 *
 * 统一收口的原因：默认模型此前在多个文件里硬编码为 'gpt-image-1.5'，
 * 而 .env 未配置 OPENAI_API_KEY，导致画布上点「生成」直接返回 500。
 * 现在默认走火山方舟 Seedream（对应 SEEDREAM_API_KEY），与资产确认面板保持一致。
 */

/** 默认图片模型：豆包 Seedream 5.0 Pro（需 SEEDREAM_API_KEY） */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';

/** 默认视频模型：豆包 Seedance 2.0（需 SEEDANCE_API_KEY） */
export const DEFAULT_VIDEO_MODEL = 'doubao-seedance-2-0-260128';
