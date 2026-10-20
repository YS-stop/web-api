/**
 * gemini.js
 *
 * Gemini 多模态工具接口（图片描述 / 提示词优化）。
 *   POST /api/gemini/describe-image
 *   POST /api/gemini/optimize-prompt
 *
 * 由 server/index.js 内联代码搬出，逻辑保持不变。
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { IMAGES_DIR } from '../utils/paths.js';
import { resolveInside } from '../utils/safePath.js';

const router = express.Router();

// 与原 index.js 一致：启动时读取一次
const API_KEY = process.env.GEMINI_API_KEY;

const getClient = () => new GoogleGenAI({ apiKey: API_KEY || '' });

// Describe an image for prompt generation
router.post('/describe-image', async (req, res) => {
    try {
        const { imageUrl, prompt } = req.body;
        console.log(`[Gemini DescribeV2] Request received. imageUrl: ${imageUrl ? (imageUrl.length > 100 ? imageUrl.substring(0, 100) + '...' : imageUrl) : 'missing'}`);
        // DEBUG: Verify story context injection
        if (prompt) {
            console.log('[Gemini DescribeV2] Received Prompt:', prompt);
        }

        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL is required' });
        }

        // Handle base64 or file URL
        let imagePart;

        // Check if it's a data URL (base64)
        if (imageUrl.startsWith('data:')) {
            const matches = imageUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                imagePart = {
                    inlineData: {
                        data: matches[2],
                        mimeType: matches[1]
                    }
                };
            }
        }
        // Handle local file paths (e.g., /library/images/...)
        else {
            // Strip domain if present to get relative path
            let cleanUrl = imageUrl;
            try {
                if (imageUrl.startsWith('http')) {
                    const u = new URL(imageUrl);
                    cleanUrl = u.pathname;
                }
            } catch (e) {
                // ignore invalid url parse, treat as path
            }

            // CRITICAL: Strip query string (cache busting params like ?t=123)
            if (cleanUrl.includes('?')) {
                cleanUrl = cleanUrl.split('?')[0];
            }

            console.log(`[Gemini DescribeV2] Cleaned path: ${cleanUrl}`);

            if (cleanUrl.startsWith('/library/')) {
                // Need to read the file from disk
                // Convert URL path to system path
                let fullPath = '';

                if (cleanUrl.startsWith('/library/images/')) {
                    const relativePath = cleanUrl.replace('/library/images/', '');
                    // 防目录逃逸：否则可把库外文件（如 .env）读出来发给模型
                    fullPath = resolveInside(IMAGES_DIR, relativePath) || '';
                } else if (cleanUrl.startsWith('/library/videos/')) {
                    return res.status(400).json({ error: 'Video description not directly supported, use a frame.' });
                }

                console.log(`[Gemini DescribeV2] Resolved path: ${fullPath}`);

                if (fullPath && fs.existsSync(fullPath)) {
                    const imageData = fs.readFileSync(fullPath);
                    const base64Data = imageData.toString('base64');
                    const mimeType = fullPath.endsWith('.png') ? 'image/png' :
                        fullPath.endsWith('.jpg') || fullPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/webp';

                    imagePart = {
                        inlineData: {
                            data: base64Data,
                            mimeType: mimeType
                        }
                    };
                } else {
                    console.log(`[Gemini DescribeV2] File not found at: ${fullPath}`);
                }
            }
        }

        if (!imagePart) {
            console.log('[Gemini DescribeV2] Failed to process image part');
            return res.status(400).json({ error: 'Could not process image URL. Provide base64 data or a valid library path.', debug: { imageUrl } });
        }

        const client = getClient();
        // Correct SDK usage for @google/genai ^1.32.0
        const result = await client.models.generateContent({
            model: "gemini-2.0-flash",
            contents: {
                parts: [
                    { text: prompt || "Describe this image in detail for video generation." },
                    imagePart
                ]
            }
        });

        let text = "";

        // Handle @google/genai SDK response structure
        if (result.candidates && result.candidates.length > 0) {
            const candidate = result.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                text = candidate.content.parts[0].text || "";
            }
        }
        // Fallback for other potential response shapes
        else if (result.response && typeof result.response.text === 'function') {
            text = result.response.text();
        }

        if (!text) {
            console.warn('[Gemini DescribeV2] Warning: No text content found in response.');
            console.debug('[Gemini DescribeV2] Response dump:', JSON.stringify(result, null, 2));
        }

        res.json({ description: text });

    } catch (error) {
        console.error("Describe image error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Optimize a prompt for video generation
router.post('/optimize-prompt', async (req, res) => {
    try {
        const { prompt } = req.body;
        console.log(`[Gemini Optimize] Request received. Prompt: ${prompt ? (prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt) : 'missing'}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const client = getClient();
        const systemInstruction = "You are an expert video prompt engineer. Your goal is to rewrite the user's prompt to be descriptive, visual, and optimized for AI video generation models like Veo, Kling, and Hailuo. detailed, cinematic, and focused on motion and atmosphere. Keep it under 60 words. Output ONLY the rewritten prompt.";

        const result = await client.models.generateContent({
            model: "gemini-2.0-flash",
            contents: {
                parts: [
                    { text: `${systemInstruction}\n\nUser Prompt: ${prompt}` }
                ]
            }
        });

        let text = "";

        // Handle @google/genai SDK response structure
        if (result.candidates && result.candidates.length > 0) {
            const candidate = result.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                text = candidate.content.parts[0].text || "";
            }
        }
        // Fallback for other potential response shapes
        else if (result.response && typeof result.response.text === 'function') {
            text = result.response.text();
        }

        if (!text) {
            console.warn('[Gemini Optimize] Warning: No text content found in response.');
            return res.status(500).json({ error: 'Failed to optimize prompt' });
        }

        // Clean up text (remove quotes if present)
        text = text.trim().replace(/^["']|["']$/g, '');

        res.json({ optimizedPrompt: text });

    } catch (error) {
        console.error("Optimize prompt error:", error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
