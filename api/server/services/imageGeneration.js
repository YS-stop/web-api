/**
 * imageGeneration.js
 *
 * 图片生成的统一入口：根据 imageModel 路由到对应 provider，
 * 返回落盘前的图片 Buffer 与格式。同步接口与后台任务队列共用这一份逻辑，
 * 避免 provider 分支在多处重复维护。
 *
 * 各 provider 返回值：
 *   - Kling / Seedream：返回厂商图片 URL，需下载后转 Buffer；
 *   - OpenAI / Gemini：直接返回 Buffer。
 */

import { generateKlingImage, generateKlingMultiImage } from './kling.js';
import { generateGeminiImage } from './gemini.js';
import { generateOpenAIImage } from './openai.js';
import { generateSeedreamImage } from './doubao.js';
import { resolveImageToBase64 } from '../utils/imageHelpers.js';
import { getKey, withConcurrency } from './modelChannel.js';

/**
 * 生成图片并返回 Buffer。
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} [params.imageModel] 图片模型 id（kling-* / gpt-image-* / doubao-seedream* / 其它）
 * @param {string} [params.aspectRatio]
 * @param {string} [params.resolution]
 * @param {string|string[]} [params.imageBase64] 参考图（data URL 或文件 URL，支持数组）
 * @param {string} [params.klingReferenceMode] Kling V1.5 参考模式
 * @param {number} [params.klingFaceIntensity]
 * @param {number} [params.klingSubjectIntensity]
 * @param {string} [params.channel] 模型调用通道（free / project / workflow）
 * @returns {Promise<{ imageBuffer: Buffer, imageFormat: string }>}
 */
export async function generateImageBuffer({
    prompt,
    imageModel,
    aspectRatio,
    resolution,
    imageBase64: rawImageBase64,
    klingReferenceMode,
    klingFaceIntensity,
    klingSubjectIntensity,
    channel = 'free',
}) {
    const isKlingModel = imageModel && imageModel.startsWith('kling-');
    const isOpenAIModel = imageModel && imageModel.startsWith('gpt-image-');
    const isSeedreamModel = imageModel && imageModel.startsWith('doubao-seedream');

    let imageBuffer;
    let imageFormat = 'png';

    if (isKlingModel) {
        const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
        const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
        if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
            throw new Error('Kling API credentials not configured. Add KLING_ACCESS_KEY and KLING_SECRET_KEY to .env');
        }

        let resolvedImages = null;
        if (rawImageBase64) {
            const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
            resolvedImages = rawImages.map((img) => resolveImageToBase64(img)).filter(Boolean);
        }

        const isV2Model = imageModel === 'kling-v2' || imageModel === 'kling-v2-1' || imageModel === 'kling-v2-new';
        const hasReferenceImages = resolvedImages && resolvedImages.length > 0;

        let klingImageUrl;
        if (hasReferenceImages && isV2Model) {
            klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingMultiImage({
                prompt,
                subjectImages: resolvedImages,
                modelId: imageModel,
                aspectRatio,
                resolution,
                accessKey: KLING_ACCESS_KEY,
                secretKey: KLING_SECRET_KEY,
            }));
        } else if (hasReferenceImages && resolvedImages.length > 1) {
            klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingMultiImage({
                prompt,
                subjectImages: resolvedImages,
                modelId: imageModel,
                aspectRatio,
                resolution,
                accessKey: KLING_ACCESS_KEY,
                secretKey: KLING_SECRET_KEY,
            }));
        } else {
            klingImageUrl = await withConcurrency('KLING', channel, () => generateKlingImage({
                prompt,
                imageBase64: resolvedImages,
                modelId: imageModel,
                aspectRatio,
                resolution,
                klingReferenceMode,
                klingFaceIntensity,
                klingSubjectIntensity,
                accessKey: KLING_ACCESS_KEY,
                secretKey: KLING_SECRET_KEY,
            }));
        }

        const imageResponse = await fetch(klingImageUrl);
        if (!imageResponse.ok) {
            throw new Error('Failed to download image from Kling');
        }
        imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        if (klingImageUrl.includes('.jpg') || klingImageUrl.includes('.jpeg')) {
            imageFormat = 'jpg';
        }
    } else if (isOpenAIModel) {
        const OPENAI_API_KEY = getKey('OPENAI', channel);
        if (!OPENAI_API_KEY) {
            throw new Error('OpenAI API key not configured. Add OPENAI_API_KEY to .env');
        }

        let imageBase64Array = null;
        if (rawImageBase64) {
            const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
            imageBase64Array = rawImages.map((img) => resolveImageToBase64(img)).filter(Boolean);
        }

        imageBuffer = await withConcurrency('OPENAI', channel, () => generateOpenAIImage({
            prompt,
            imageBase64Array,
            aspectRatio,
            resolution,
            apiKey: OPENAI_API_KEY,
        }));
    } else if (isSeedreamModel) {
        const SEEDREAM_API_KEY = getKey('SEEDREAM', channel);
        if (!SEEDREAM_API_KEY) {
            throw new Error('SEEDREAM_API_KEY not configured. Add SEEDREAM_API_KEY to .env');
        }

        let imageBase64Array = null;
        if (rawImageBase64) {
            const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
            imageBase64Array = rawImages.map((img) => resolveImageToBase64(img)).filter(Boolean);
        }

        const seedreamUrl = await withConcurrency('SEEDREAM', channel, () => generateSeedreamImage({
            prompt,
            aspectRatio,
            imageBase64: imageBase64Array,
            apiKey: SEEDREAM_API_KEY,
            modelId: imageModel,
        }));

        const imageResponse = await fetch(seedreamUrl);
        if (!imageResponse.ok) {
            throw new Error('Failed to download image from Seedream');
        }
        imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        if (seedreamUrl.includes('.jpg') || seedreamUrl.includes('.jpeg')) {
            imageFormat = 'jpg';
        }
    } else {
        const GEMINI_API_KEY = getKey('GEMINI', channel);
        if (!GEMINI_API_KEY) {
            throw new Error('Server missing API Key config');
        }

        let imageBase64Array = null;
        if (rawImageBase64) {
            const rawImages = Array.isArray(rawImageBase64) ? rawImageBase64 : [rawImageBase64];
            imageBase64Array = rawImages.map((img) => resolveImageToBase64(img)).filter(Boolean);
        }

        imageBuffer = await withConcurrency('GEMINI', channel, () => generateGeminiImage({
            prompt,
            imageBase64Array,
            aspectRatio,
            resolution,
            apiKey: GEMINI_API_KEY,
        }));
    }

    return { imageBuffer, imageFormat };
}
