/**
 * useVoicePreview.ts
 *
 * 音色试听：点击音色时用固定示例句合成一小段音频并播放。
 *
 * 设计要点：
 *   1. 结果按「基础音色 + 风格提示词」缓存，同一音色反复试听只扣一次费；
 *   2. 模块级共享一个 Audio，全局同时只播一条，切换自动打断；
 *   3. 首次点击需要等服务端合成（约 1~2 秒），用 loadingKey 显示转圈。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { findVoice, isEnglishVoice, normalizeVoiceId } from './voiceCatalog';

/** 试听示例句：控制在 20 字内，既能体现音色，又不浪费计费字数 */
const SAMPLE_TEXT_ZH = '你好，我是这个角色的配音，很高兴见到你。';

/**
 * 英文音色专用示例句。
 * 英文音色（en_*）只认英文文本，喂中文时 2.0 接口返回 200 但音频帧为空，
 * 表现就是「点试听没声音 / 试听失败」，所以必须按语种换句。
 */
const SAMPLE_TEXT_EN = "Hello, I'm the voice of this character. Nice to meet you.";

/** 按音色语种挑选示例句 */
export const sampleTextFor = (voice: string): string => {
    const hit = findVoice(voice);
    return hit && isEnglishVoice(hit) ? SAMPLE_TEXT_EN : SAMPLE_TEXT_ZH;
};

/** 缓存：key = 基础音色|风格提示词 */
const previewCache = new Map<string, string>();

/** 全局共用一个播放器，避免多个卡片同时出声 */
let sharedAudio: HTMLAudioElement | null = null;
let stopCurrent: (() => void) | null = null;

/** 生成的缓存 key，UI 用它判断某一行是否正在播放 */
export const previewKeyOf = (voice: string, prompt?: string): string =>
    `${normalizeVoiceId(voice)}|${(prompt || '').trim()}`;

export interface VoicePreviewApi {
    /** 正在播放的 key */
    activeKey: string | null;
    /** 正在合成的 key */
    loadingKey: string | null;
    /** 最近一次试听的错误信息 */
    error: string;
    /** 点击试听：同一项再次点击则停止 */
    toggle: (voice: string, prompt?: string) => Promise<void>;
    stop: () => void;
}

export const useVoicePreview = (): VoicePreviewApi => {
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const [loadingKey, setLoadingKey] = useState<string | null>(null);
    const [error, setError] = useState('');
    const mounted = useRef(true);
    const activeRef = useRef<string | null>(null);
    const loadingRef = useRef<string | null>(null);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            // 组件卸载时停掉自己发起的播放，避免声音继续响
            if (stopCurrent) {
                stopCurrent();
                stopCurrent = null;
            }
        };
    }, []);

    const stop = useCallback(() => {
        if (stopCurrent) {
            stopCurrent();
            stopCurrent = null;
        }
        activeRef.current = null;
        setActiveKey(null);
    }, []);

    const toggle = useCallback(async (voice: string, prompt?: string) => {
        const key = previewKeyOf(voice, prompt);

        // 同一条正在加载：忽略重复点击
        if (loadingRef.current === key) return;
        // 同一条正在播放：再点一次即停止
        if (activeRef.current === key) {
            stop();
            return;
        }

        stop();
        setError('');

        let url = previewCache.get(key);

        if (!url) {
            loadingRef.current = key;
            setLoadingKey(key);
            try {
                const resp = await fetch('/api/tts/synthesize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: sampleTextFor(voice),
                        voice: normalizeVoiceId(voice),
                        contextTexts: prompt && prompt.trim() ? [prompt.trim()] : undefined,
                        encoding: 'mp3',
                        response: 'base64',
                    }),
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok || !data?.audio) {
                    throw new Error(data?.error || `试听失败（HTTP ${resp.status}）`);
                }
                url = data.audio as string;
                previewCache.set(key, url);
            } catch (e: any) {
                if (mounted.current) setError(e?.message || '试听失败');
                return;
            } finally {
                loadingRef.current = null;
                if (mounted.current) setLoadingKey(null);
            }
        }

        if (!mounted.current) return;

        const audio = sharedAudio || (sharedAudio = new Audio());
        audio.onended = () => {
            activeRef.current = null;
            if (mounted.current) setActiveKey(null);
        };
        audio.onerror = () => {
            activeRef.current = null;
            if (mounted.current) {
                setActiveKey(null);
                setError('音频播放失败');
            }
        };
        audio.src = url;

        stopCurrent = () => {
            audio.pause();
            audio.currentTime = 0;
        };
        activeRef.current = key;
        setActiveKey(key);

        try {
            await audio.play();
        } catch {
            activeRef.current = null;
            if (mounted.current) setActiveKey(null);
        }
    }, [stop]);

    return { activeKey, loadingKey, error, toggle, stop };
};
