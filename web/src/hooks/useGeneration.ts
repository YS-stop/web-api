/**
 * useGeneration.ts
 * 
 * Custom hook for handling AI content generation (images and videos).
 * Manages generation state, API calls, and error handling.
 */

import { NodeData, NodeType, NodeStatus } from '../types';
import { generateImage, generateVideo, submitVideoTask, getVideoTaskStatus, getGenerationStatus } from '../services/generationService';
import { generateLocalImage } from '../services/localModelService';
import { extractVideoLastFrame } from '../utils/videoHelpers';

interface UseGenerationProps {
    nodes: NodeData[];
    updateNode: (id: string, updates: Partial<NodeData>) => void;
    channel: string; // 模型调用通道：free / project / workflow
    /**
     * 视频生成开始回调：调用方用它把任务写入持久化台账。
     * 用户离开画布后，回来可凭 nodeId 调 /api/generation-status 认领服务端已生成的结果。
     */
    onVideoJobStart?: (node: NodeData) => void;
    /** 视频生成结束回调：success 表示结果已写入节点；error 表示生成失败 */
    onVideoJobEnd?: (nodeId: string, outcome: 'success' | 'error') => void;
    /** Seedance 异步任务提交成功：外部可记下 taskId，便于离开页面后快速恢复 */
    onVideoTaskSubmitted?: (nodeId: string, taskId: string) => void;
}

export const useGeneration = ({
    nodes,
    updateNode,
    channel,
    onVideoJobStart,
    onVideoJobEnd,
    onVideoTaskSubmitted,
}: UseGenerationProps) => {
    // ============================================================================
    // HELPERS
    // ============================================================================

    /**
     * Convert pixel dimensions to closest standard aspect ratio
     */
    const getClosestAspectRatio = (width: number, height: number): string => {
        const ratio = width / height;
        const standardRatios = [
            { label: '1:1', value: 1 },
            { label: '16:9', value: 16 / 9 },
            { label: '9:16', value: 9 / 16 },
            { label: '4:3', value: 4 / 3 },
            { label: '3:4', value: 3 / 4 },
            { label: '3:2', value: 3 / 2 },
            { label: '2:3', value: 2 / 3 },
            { label: '5:4', value: 5 / 4 },
            { label: '4:5', value: 4 / 5 },
            { label: '21:9', value: 21 / 9 }
        ];

        let closest = standardRatios[0];
        let minDiff = Math.abs(ratio - closest.value);

        for (const r of standardRatios) {
            const diff = Math.abs(ratio - r.value);
            if (diff < minDiff) {
                minDiff = diff;
                closest = r;
            }
        }

        return closest.label;
    };

    /**
     * Detect the actual aspect ratio of an image
     * @param imageUrl - URL or base64 of the image
     * @returns Promise with resultAspectRatio (exact) and aspectRatio (closest standard)
     */
    const getImageAspectRatio = (imageUrl: string): Promise<{ resultAspectRatio: string; aspectRatio: string }> => {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const resultAspectRatio = `${img.naturalWidth}/${img.naturalHeight}`;
                const aspectRatio = getClosestAspectRatio(img.naturalWidth, img.naturalHeight);
                resolve({ resultAspectRatio, aspectRatio });
            };
            img.onerror = () => {
                resolve({ resultAspectRatio: '16/9', aspectRatio: '16:9' });
            };
            img.src = imageUrl;
        });
    };

    /**
     * 轮询服务端 Seedance 任务直到完成。
     *
     * 真正的生成由服务端后台推进（videoTaskRunner），前端轮询只是拿结果；
     * 因此页面离开后任务仍会继续，回到画布可通过 /api/generation-status 恢复。
     * 若任务记录丢失（例如服务重启），回退到按 nodeId 查已落盘结果。
     */
    const waitForSeedanceTask = async (taskId: string, nodeId: string): Promise<string> => {
        const deadline = Date.now() + 11 * 60 * 1000;
        // 连续查询失败容忍次数：后端重启时任务会被 restore 继续跑，短暂不可达属正常，
        // 但持续不可达说明连接已断，必须尽快报错，不能让节点一直转圈到 11 分钟超时。
        const MAX_CONSECUTIVE_FAILURES = 3;
        let consecutiveFailures = 0;

        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5000));

            let status;
            try {
                status = await getVideoTaskStatus(taskId);
                consecutiveFailures = 0;
            } catch {
                // 任务不存在/查询失败：看看服务端有没有已经落盘的结果
                const fallback = await getGenerationStatus(nodeId).catch(() => null);
                if (fallback?.status === 'success' && fallback.resultUrl) return fallback.resultUrl;
                // 服务端已明确失败：立即收尾，不必等超时
                if (fallback?.status === 'failed') {
                    throw new Error(fallback.error || '视频生成失败');
                }

                consecutiveFailures += 1;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    throw new Error('与生成服务的连接已中断（后端可能已重启），请确认服务恢复后重新生成');
                }
                continue;
            }

            if (status.status === 'succeeded' && status.resultUrl) return status.resultUrl;
            if (status.status === 'failed') throw new Error(status.error || '视频生成失败');
        }

        throw new Error('视频生成超时，请稍后在画布中查看或重新生成');
    };

    // ============================================================================
    // GENERATION HANDLER
    // ============================================================================

    /**
     * Handles content generation for a node
     * Supports image and video generation with parent node chaining
     * 
     * @param id - ID of the node to generate content for
     */
    const handleGenerate = async (id: string) => {
        const node = nodes.find(n => n.id === id);
        if (!node) return;

        // Get prompts from connected TEXT nodes (if any)
        const getTextNodePrompts = (): string[] => {
            if (!node.parentIds) return [];
            return node.parentIds
                .map(pid => nodes.find(n => n.id === pid))
                .filter(n => n?.type === NodeType.TEXT && n.prompt)
                .map(n => n!.prompt);
        };

        // Combine prompts: TEXT node prompts + node's own prompt
        const textNodePrompts = getTextNodePrompts();
        const combinedPrompt = [...textNodePrompts, node.prompt].filter(Boolean).join('\n\n');

        // Check if prompt is required
        // For Kling frame-to-frame with both start and end frames, prompt is optional
        const isKlingFrameToFrame =
            node.type === NodeType.VIDEO &&
            node.videoModel?.startsWith('kling-') &&
            (node.parentIds && node.parentIds.length >= 2);

        if (!combinedPrompt && !isKlingFrameToFrame) return;

        updateNode(id, { status: NodeStatus.LOADING, generationStartTime: Date.now() });

        try {
            if (node.type === NodeType.IMAGE || node.type === NodeType.IMAGE_EDITOR) {
                // Collect ALL parent images for multi-input generation
                const imageBase64s: string[] = [];

                // Get images from all direct parents (excluding TEXT nodes)
                if (node.parentIds && node.parentIds.length > 0) {
                    for (const parentId of node.parentIds) {
                        let currentId: string | undefined = parentId;

                        // Traverse up the chain to find an image source (skip TEXT nodes)
                        while (currentId && imageBase64s.length < 14) { // Gemini 3 Pro limit
                            const parent = nodes.find(n => n.id === currentId);
                            // Skip TEXT nodes - they provide prompts, not images
                            if (parent?.type === NodeType.TEXT) {
                                break;
                            }
                            if (parent?.resultUrl) {
                                imageBase64s.push(parent.resultUrl);
                                break; // Found image for this parent chain
                            } else {
                                // Continue up this chain
                                currentId = parent?.parentIds?.[0];
                            }
                        }
                    }
                }

                // Add character reference URLs from storyboard nodes (for maintaining character consistency)
                if (node.characterReferenceUrls && node.characterReferenceUrls.length > 0) {
                    for (const charUrl of node.characterReferenceUrls) {
                        if (imageBase64s.length < 14) { // Respect Gemini's limit
                            imageBase64s.push(charUrl);
                        }
                    }
                }

                // Generate image with all parent images and character references
                const rawResultUrl = await generateImage({
                    prompt: combinedPrompt,
                    aspectRatio: node.aspectRatio,
                    resolution: node.resolution,
                    imageBase64: imageBase64s.length > 0 ? imageBase64s : undefined,
                    imageModel: node.imageModel,
                    nodeId: id,
                    channel,
                    // Kling V1.5 reference settings
                    klingReferenceMode: node.klingReferenceMode,
                    klingFaceIntensity: node.klingFaceIntensity,
                    klingSubjectIntensity: node.klingSubjectIntensity
                });

                // Add cache-busting parameter to force browser to fetch new image
                // (Backend uses nodeId as filename, so URL is the same for regenerated images)
                const resultUrl = `${rawResultUrl}?t=${Date.now()}`;

                // Detect actual image dimensions (for display purposes only)
                const { resultAspectRatio } = await getImageAspectRatio(resultUrl);

                // Keep user's selected aspectRatio - don't overwrite it with detected ratio
                updateNode(id, {
                    status: NodeStatus.SUCCESS,
                    resultUrl,
                    resultAspectRatio,
                    // Note: aspectRatio is intentionally NOT updated to preserve user's selection
                    errorMessage: undefined
                });


            } else if (node.type === NodeType.LOCAL_IMAGE_MODEL) {
                // --- LOCAL MODEL GENERATION ---
                // Check if model is selected
                if (!node.localModelId && !node.localModelPath) {
                    updateNode(id, {
                        status: NodeStatus.ERROR,
                        errorMessage: 'No local model selected. Please select a model first.'
                    });
                    return;
                }

                // Get parent images if any
                const imageBase64s: string[] = [];
                if (node.parentIds && node.parentIds.length > 0) {
                    for (const parentId of node.parentIds) {
                        const parent = nodes.find(n => n.id === parentId);
                        if (parent?.type !== NodeType.TEXT && parent?.resultUrl) {
                            imageBase64s.push(parent.resultUrl);
                        }
                    }
                }

                // Call local generation API
                const result = await generateLocalImage({
                    modelId: node.localModelId,
                    modelPath: node.localModelPath,
                    prompt: combinedPrompt,
                    aspectRatio: node.aspectRatio,
                    resolution: node.resolution || '512'
                });

                if (result.success && result.resultUrl) {
                    // Add cache-busting parameter
                    const resultUrl = `${result.resultUrl}?t=${Date.now()}`;

                    // Detect actual image dimensions
                    const { resultAspectRatio } = await getImageAspectRatio(resultUrl);

                    updateNode(id, {
                        status: NodeStatus.SUCCESS,
                        resultUrl,
                        resultAspectRatio,
                        errorMessage: undefined
                    });
                } else {
                    throw new Error(result.error || 'Local generation failed');
                }

            } else if (node.type === NodeType.VIDEO) {
                // Get first parent image for video generation (start frame)
                let imageBase64: string | undefined;
                let lastFrameBase64: string | undefined;
                /** 参考图模式：父节点图片只作形象/场景参考，不作首帧 */
                const referenceUrls: string[] = [];

                // Get non-TEXT parent nodes (image sources only)
                const imageParentIds = node.parentIds?.filter(pid => {
                    const parent = nodes.find(n => n.id === pid);
                    return parent?.type !== NodeType.TEXT;
                }) || [];

                // 「参考图」模式：父图全部走 reference_image，不进首尾帧判定。
                // 分镜一键成片会连入角色/场景/道具多张图，若按旧逻辑会被当成首尾帧插值，
                // 导致画面在两套设定之间过渡而不是按提示词重新构图。
                // 输入模式优先级：reference > first-frame > frame-to-frame > auto（旧逻辑）
                const inputMode = node.videoInputMode || 'auto';
                const useReferenceMode = inputMode === 'reference';
                const forceFirstFrame = inputMode === 'first-frame';
                const forceFrameToFrame = inputMode === 'frame-to-frame';
                if (useReferenceMode) {
                    for (const pid of imageParentIds) {
                        const parent = nodes.find(n => n.id === pid);
                        if (parent?.resultUrl) referenceUrls.push(parent.resultUrl);
                        else if (parent?.type === NodeType.VIDEO && parent.lastFrame) {
                            referenceUrls.push(parent.lastFrame);
                        }
                    }
                }

                // Check for frame-to-frame mode (explicit or auto-detected from 2+ image parents)
                const hasMultipleInputs = imageParentIds.length >= 2;
                const hasExplicitFrameInputs = node.frameInputs && node.frameInputs.length >= 2;

                // Motion Reference logic (Kling 2.6)
                let motionReferenceUrl: string | undefined;
                let isMotionControl = false;
                if (node.videoModel === 'kling-v2-6') {
                    // Find a parent video node that has a result
                    const videoParent = node.parentIds
                        ?.map(pid => nodes.find(n => n.id === pid))
                        .find(n => n?.type === NodeType.VIDEO && n.resultUrl);

                    if (videoParent) {
                        motionReferenceUrl = videoParent.resultUrl;
                        isMotionControl = true;
                    }
                }

                // 显式输入模式优先：首帧模式即便连了多张图也不进首尾帧；多图参考同理。
                // 只有 auto 才沿用「>=2 张自动首尾帧」的旧行为。
                const isFrameToFrame = !isMotionControl && !useReferenceMode && !forceFirstFrame &&
                    (forceFrameToFrame || node.videoMode === 'frame-to-frame' || hasMultipleInputs || hasExplicitFrameInputs);

                if (isFrameToFrame && imageParentIds.length >= 2) {
                    // Get start and end frames from frameInputs (if user reordered) or default order
                    const parent1 = nodes.find(n => n.id === imageParentIds[0]);
                    const parent2 = nodes.find(n => n.id === imageParentIds[1]);

                    // Check if user has explicitly set frame order
                    if (node.frameInputs && node.frameInputs.length >= 2) {
                        const startFrameInput = node.frameInputs.find(f => f.order === 'start');
                        const endFrameInput = node.frameInputs.find(f => f.order === 'end');

                        if (startFrameInput) {
                            const startNode = nodes.find(n => n.id === startFrameInput.nodeId);
                            if (startNode?.resultUrl) {
                                imageBase64 = startNode.resultUrl;
                            }
                        }

                        if (endFrameInput) {
                            const endNode = nodes.find(n => n.id === endFrameInput.nodeId);
                            if (endNode?.resultUrl) {
                                lastFrameBase64 = endNode.resultUrl;
                            }
                        }
                    } else {
                        // Default: first parent = start, second parent = end
                        if (parent1?.resultUrl) imageBase64 = parent1.resultUrl;
                        if (parent2?.resultUrl) lastFrameBase64 = parent2.resultUrl;
                    }
                } else if (imageParentIds.length > 0 && !useReferenceMode) {
                    // 多图参考模式不设首帧（全部图都走 reference_image，避免首图被当成首帧）
                    // Standard mode or Motion Control: get character reference or first parent image
                    if (isMotionControl) {
                        // For Motion Control, look specifically for an IMAGE parent as character reference
                        const characterParent = node.parentIds
                            ?.map(pid => nodes.find(n => n.id === pid))
                            .find(n => n?.type === NodeType.IMAGE && n.resultUrl);

                        if (characterParent?.resultUrl) {
                            imageBase64 = characterParent.resultUrl;
                        }
                    } else {
                        // Standard mode: get first parent image or video last frame
                        // Use imageParentIds (filtered to exclude TEXT nodes) instead of raw parentIds
                        const parent = nodes.find(n => n.id === imageParentIds[0]);

                        if (parent?.type === NodeType.VIDEO && parent.lastFrame) {
                            // Use last frame from parent video
                            imageBase64 = parent.lastFrame;
                        } else if (parent?.resultUrl) {
                            // Use parent image directly
                            imageBase64 = parent.resultUrl;
                        }
                    }
                }

                // 记录任务台账：即使用户离开画布，服务端仍会生成并落盘，回到画布后可恢复
                onVideoJobStart?.(node);

                const videoParams = {
                    prompt: combinedPrompt,
                    imageBase64,
                    lastFrameBase64,
                    // 参考图模式下把父图全部作为 reference_image 传下去
                    referenceImages: referenceUrls.length > 0 ? Array.from(new Set(referenceUrls)) : undefined,
                    aspectRatio: node.aspectRatio,
                    resolution: node.resolution,
                    duration: node.videoDuration,
                    videoModel: node.videoModel,
                    motionReferenceUrl,
                    generateAudio: node.generateAudio, // For Kling 2.6 and Veo 3.1 native audio
                    nodeId: id,
                    channel
                };

                // Seedance 走「提交 + 轮询」：生成在服务端后台推进，页面离开也不会中断。
                // 其它模型（Kling / Veo / Hailuo）仍是同步接口。
                const isSeedanceModel = !!node.videoModel?.startsWith('doubao-seedance');
                let rawResultUrl: string;
                if (isSeedanceModel) {
                    const { taskId } = await submitVideoTask(videoParams);
                    onVideoTaskSubmitted?.(id, taskId);
                    rawResultUrl = await waitForSeedanceTask(taskId, id);
                } else {
                    rawResultUrl = await generateVideo(videoParams);
                }

                // Add cache-busting parameter to force browser to fetch new video
                // (Backend uses nodeId as filename, so URL is the same for regenerated videos)
                const resultUrl = `${rawResultUrl}?t=${Date.now()}`;

                // Extract last frame for chaining
                const lastFrame = await extractVideoLastFrame(resultUrl);

                // Detect video aspect ratio
                let resultAspectRatio: string | undefined;
                let aspectRatio: string | undefined;
                try {
                    const video = document.createElement('video');
                    await new Promise<void>((resolve) => {
                        video.onloadedmetadata = () => {
                            resultAspectRatio = `${video.videoWidth}/${video.videoHeight}`;
                            aspectRatio = getClosestAspectRatio(video.videoWidth, video.videoHeight);
                            resolve();
                        };
                        video.onerror = () => resolve();
                        video.src = resultUrl;
                    });
                } catch (e) {
                    // Ignore errors, use undefined aspect ratio
                }

                updateNode(id, {
                    status: NodeStatus.SUCCESS,
                    resultUrl,
                    resultAspectRatio,
                    aspectRatio,
                    lastFrame,
                    errorMessage: undefined // Clear any previous error
                });

                // 结果已写入节点，任务台账可以清掉
                onVideoJobEnd?.(id, 'success');
            }
        } catch (error: any) {
            // Handle errors
            const msg = error.toString().toLowerCase();
            let errorMessage = error.message || 'Generation failed';

            if (msg.includes('permission_denied') || msg.includes('403')) {
                errorMessage = 'Permission denied. Check API Key configuration.';
            } else if (msg.includes('unable to process input image') || msg.includes('invalid_argument')) {
                errorMessage = '⚠️ Input image incompatible. Veo requires: JPEG format, 16:9 or 9:16 aspect ratio. Try a different image or generate without input.';
            }

            updateNode(id, { status: NodeStatus.ERROR, errorMessage });
            onVideoJobEnd?.(id, 'error');
            console.error('Generation failed:', error);
        }
    };

    // ============================================================================
    // RETURN
    // ============================================================================

    return {
        handleGenerate
    };
};
