/**
 * NodeControls.tsx
 * 
 * Control panel for canvas nodes.
 * Handles prompt input, model selection, size/ratio settings, and generation button.
 * For Video nodes: includes Advanced Settings for frame-to-frame mode.
 */

import React, { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Banana, Settings2, Check, ChevronDown, ChevronUp, GripVertical, Image as ImageIcon, Film, Clock, Expand, Shrink, Monitor, Crop, HardDrive } from 'lucide-react';
import { NodeData, NodeStatus, NodeType } from '../../types';
import { OpenAIIcon, GoogleIcon, KlingIcon, HailuoIcon } from '../icons/BrandIcons';
import { useFaceDetection } from '../../hooks/useFaceDetection';
import { ChangeAnglePanel } from './ChangeAnglePanel';
import { LocalModel, getLocalModels } from '../../services/localModelService';
import { DEFAULT_IMAGE_MODEL } from '../../constants/modelDefaults';

interface NodeControlsProps {
    data: NodeData;
    inputUrl?: string;
    isLoading: boolean;
    isSuccess: boolean;
    connectedImageNodes?: { id: string; url: string; type?: NodeType }[]; // Connected parent nodes
    onUpdate: (id: string, updates: Partial<NodeData>) => void;
    onGenerate: (id: string) => void;
    onChangeAngleGenerate?: (nodeId: string) => void;
    onSelect: (id: string) => void;
    zoom: number;
    canvasTheme?: 'dark' | 'light';
}

const IMAGE_RATIOS = [
    "Auto", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"
];

const VIDEO_RESOLUTIONS = [
    "Auto", "1080p", "768p", "720p", "512p"
];

// Video durations in seconds
const VIDEO_DURATIONS = [5, 6, 8, 10];

// Video model versions with metadata
// supportsTextToVideo: Can generate video from text prompt only
// supportsImageToVideo: Can use a single input image (start frame)
// supportsMultiImage: Can use multiple input images (frame-to-frame)
// supportsReferenceImages: Can use N images as reference_image (multi-reference mode)
// maxReferenceImages: 官方限制的参考图张数（Seedance 2.0 = 9，2.5 = 30）
// durations: Supported video durations in seconds
// resolutions: Supported resolutions (model-specific)
// aspectRatios: Supported aspect ratios (most video models support 16:9 and 9:16)
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16"];

const VIDEO_MODELS = [
    { id: 'doubao-seedance-2-0-260128', name: '豆包 Seedance 2.0', provider: 'doubao', supportsTextToVideo: true, supportsImageToVideo: true, supportsMultiImage: true, supportsReferenceImages: true, maxReferenceImages: 9, durations: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
    { id: 'doubao-seedance-2-0-fast-260128', name: '豆包 Seedance 2.0 Fast', provider: 'doubao', supportsTextToVideo: true, supportsImageToVideo: true, supportsMultiImage: true, supportsReferenceImages: true, maxReferenceImages: 9, durations: [5, 10], resolutions: ['720p', '480p'], aspectRatios: ['16:9', '9:16'] },
    { id: 'doubao-seedance-2-0-mini-260615', name: '豆包 Seedance 2.0 Mini', provider: 'doubao', supportsTextToVideo: true, supportsImageToVideo: true, supportsMultiImage: true, supportsReferenceImages: true, maxReferenceImages: 9, durations: [5, 10], resolutions: ['720p', '480p'], aspectRatios: ['16:9', '9:16'] },
    { id: 'doubao-seedance-2-5-260628', name: '豆包 Seedance 2.5', provider: 'doubao', supportsTextToVideo: true, supportsImageToVideo: true, supportsMultiImage: true, supportsReferenceImages: true, maxReferenceImages: 30, durations: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'] },
];

// Image model versions with metadata
// supportsImageToImage: Can use a single reference image (for image-to-image transformation)
// supportsMultiImage: Can use multiple reference images (2-4) via Multi-Image API
// Note: Kling V1 and V2-new don't support reference images in standard API
// Note: Kling V1.5 is the only Kling model supporting single-image reference via image_reference
// Note: Kling V2/V2.1 only support references via Multi-Image API
// aspectRatios: Supported aspect ratios for the model
const IMAGE_MODELS = [
    {
        id: DEFAULT_IMAGE_MODEL,
        name: '豆包 Seedream 5.0 Pro',
        provider: 'doubao',
        // 后端 doubao.js 的 generateSeedreamImage 支持 image 数组（最多 10 张参考图），
        // 因此图生图 / 多图参考都应放开，否则连了图片父节点后该模型会被过滤掉。
        supportsImageToImage: true,
        supportsMultiImage: true,
        resolutions: ["1K", "2K", "4K"],
        aspectRatios: ["Auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3"]
    },
];

/** 视频节点输入模式（UI 三选） */
type VideoInputModeUI = 'first-frame' | 'frame-to-frame' | 'reference';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build a prompt that includes angle transformation instructions
 * for generating the image from a different viewing angle
 */
function buildAnglePrompt(
    basePrompt: string,
    settings: { rotation: number; tilt: number; scale: number; wideAngle: boolean }
): string {
    const parts: string[] = [];

    // Base instruction
    parts.push('Generate this same image from a different camera angle.');

    // Rotation (horizontal)
    if (settings.rotation !== 0) {
        const direction = settings.rotation > 0 ? 'right' : 'left';
        parts.push(`The camera has rotated ${Math.abs(settings.rotation)}° to the ${direction}.`);
    }

    // Tilt (vertical)
    if (settings.tilt !== 0) {
        const direction = settings.tilt > 0 ? 'upward' : 'downward';
        parts.push(`The camera has tilted ${Math.abs(settings.tilt)}° ${direction}.`);
    }

    // Scale
    if (settings.scale !== 0) {
        if (settings.scale > 50) {
            parts.push('The camera is positioned closer to the subject.');
        } else if (settings.scale < 50 && settings.scale > 0) {
            parts.push('The camera is positioned slightly closer.');
        }
    }

    // Wide-angle lens
    if (settings.wideAngle) {
        parts.push('Use a wide-angle lens perspective with visible distortion at the edges.');
    }

    // Add original prompt context if provided
    if (basePrompt.trim()) {
        parts.push(`Original scene description: ${basePrompt}`);
    }

    return parts.join(' ');
}

const NodeControlsComponent: React.FC<NodeControlsProps> = ({
    data,
    inputUrl,
    isLoading,
    isSuccess,
    connectedImageNodes = [],
    onUpdate,
    onGenerate,
    onChangeAngleGenerate,
    onSelect,
    zoom,
    canvasTheme = 'dark'
}) => {
    const { t } = useTranslation();
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [showSizeDropdown, setShowSizeDropdown] = useState(false);
    const [showAspectRatioDropdown, setShowAspectRatioDropdown] = useState(false);
    const [showDurationDropdown, setShowDurationDropdown] = useState(false);
    const [showResolutionDropdown, setShowResolutionDropdown] = useState(false);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [localPrompt, setLocalPrompt] = useState(data.prompt || '');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const aspectRatioDropdownRef = useRef<HTMLDivElement>(null);
    const durationDropdownRef = useRef<HTMLDivElement>(null);
    const resolutionDropdownRef = useRef<HTMLDivElement>(null);
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastSentPromptRef = useRef<string | undefined>(data.prompt); // Track what we sent

    // Local model state for LOCAL_IMAGE_MODEL and LOCAL_VIDEO_MODEL nodes
    const [localModels, setLocalModels] = useState<LocalModel[]>([]);
    const [isLoadingLocalModels, setIsLoadingLocalModels] = useState(false);
    const isLocalModelNode = data.type === NodeType.LOCAL_IMAGE_MODEL || data.type === NodeType.LOCAL_VIDEO_MODEL;

    // Fetch local models when node is a local model type
    useEffect(() => {
        if (!isLocalModelNode) return;

        const fetchModels = async () => {
            setIsLoadingLocalModels(true);
            try {
                const models = await getLocalModels();
                // Filter based on node type
                const filtered = data.type === NodeType.LOCAL_VIDEO_MODEL
                    ? models.filter(m => m.type === 'video')
                    : models.filter(m => m.type === 'image' || m.type === 'lora' || m.type === 'controlnet');
                setLocalModels(filtered);
            } catch (error) {
                console.error('Error fetching local models:', error);
            } finally {
                setIsLoadingLocalModels(false);
            }
        };
        fetchModels();
    }, [isLocalModelNode, data.type]);

    // Face detection hook for Kling V1.5 Face mode
    const { detectFaces, isModelLoaded: isFaceModelLoaded } = useFaceDetection();

    // Trigger face detection when Face mode is selected
    useEffect(() => {
        const runFaceDetection = async () => {
            if (
                data.klingReferenceMode === 'face' &&
                data.faceDetectionStatus === 'loading' &&
                connectedImageNodes?.[0]?.url &&
                isFaceModelLoaded
            ) {
                try {
                    const faces = await detectFaces(connectedImageNodes[0].url);
                    onUpdate(data.id, {
                        detectedFaces: faces,
                        faceDetectionStatus: faces.length > 0 ? 'success' : 'error'
                    });
                } catch (err) {
                    console.error('Face detection failed:', err);
                    onUpdate(data.id, { detectedFaces: [], faceDetectionStatus: 'error' });
                }
            }
        };
        runFaceDetection();
    }, [data.klingReferenceMode, data.faceDetectionStatus, connectedImageNodes, isFaceModelLoaded, detectFaces, onUpdate, data.id]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowSizeDropdown(false);
            }
            if (aspectRatioDropdownRef.current && !aspectRatioDropdownRef.current.contains(event.target as Node)) {
                setShowAspectRatioDropdown(false);
            }
            if (durationDropdownRef.current && !durationDropdownRef.current.contains(event.target as Node)) {
                setShowDurationDropdown(false);
            }
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setShowModelDropdown(false);
            }
            if (resolutionDropdownRef.current && !resolutionDropdownRef.current.contains(event.target as Node)) {
                setShowResolutionDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Sync local prompt with data.prompt ONLY when it changes externally (not from our own update)
    useEffect(() => {
        if (data.prompt !== lastSentPromptRef.current) {
            setLocalPrompt(data.prompt || '');
            lastSentPromptRef.current = data.prompt;
        }
    }, [data.prompt]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (updateTimeoutRef.current) {
                clearTimeout(updateTimeoutRef.current);
            }
        };
    }, []);

    // Auto-open Advanced Settings when:
    // 1. 2+ images are connected to a video node (frame-to-frame)
    // 2. Kling 2.6 with an input image (has audio toggle)
    useEffect(() => {
        if (data.type === NodeType.VIDEO) {
            const shouldAutoExpand = connectedImageNodes.length >= 2 ||
                (data.videoModel === 'kling-v2-6' && connectedImageNodes.length > 0);
            if (shouldAutoExpand) {
                setShowAdvanced(true);
            }
        }
    }, [data.type, connectedImageNodes.length, data.videoModel]);

    // Handle prompt change with debounce
    const handlePromptChange = (value: string) => {
        setLocalPrompt(value); // Update local state immediately for responsive typing
        lastSentPromptRef.current = value; // Track that we're about to send this

        // Debounce the parent update
        if (updateTimeoutRef.current) {
            clearTimeout(updateTimeoutRef.current);
        }
        updateTimeoutRef.current = setTimeout(() => {
            onUpdate(data.id, { prompt: value });
        }, 300); // 300ms debounce - increased for smoother typing
    };

    const handleSizeSelect = (value: string) => {
        if (data.type === NodeType.VIDEO) {
            onUpdate(data.id, { resolution: value });
        } else {
            onUpdate(data.id, { aspectRatio: value });
        }
        setShowSizeDropdown(false);
    };

    const handleAspectRatioSelect = (value: string) => {
        onUpdate(data.id, { aspectRatio: value });
        setShowAspectRatioDropdown(false);
    };

    /**
     * 视频节点输入模式切换：
     *  - first-frame   第一张图作首帧（其余忽略）
     *  - frame-to-frame 第一张首帧 + 第二张尾帧（第 3 张起忽略）
     *  - reference     全部父图作 reference_image（多图参考）
     */
    const handleInputModeChange = (mode: VideoInputModeUI) => {
        if (mode === 'reference') {
            onUpdate(data.id, { videoInputMode: 'reference', videoMode: 'standard', frameInputs: undefined });
        } else if (mode === 'frame-to-frame') {
            const initialFrameInputs = connectedImageNodes.slice(0, 2).map((node, idx) => ({
                nodeId: node.id,
                order: (idx === 0 ? 'start' : 'end') as 'start' | 'end'
            }));
            onUpdate(data.id, { videoInputMode: 'frame-to-frame', videoMode: 'frame-to-frame', frameInputs: initialFrameInputs });
        } else {
            onUpdate(data.id, { videoInputMode: 'first-frame', videoMode: 'standard', frameInputs: undefined });
        }
    };

    const handleFrameReorder = (fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex || connectedImageNodes.length < 2) return;

        // Get the two connected nodes
        const node1 = connectedImageNodes[0];
        const node2 = connectedImageNodes[1];

        // Get current orders (from saved data or default)
        const current1Order = data.frameInputs?.find(f => f.nodeId === node1.id)?.order || 'start';
        const current2Order = data.frameInputs?.find(f => f.nodeId === node2.id)?.order || 'end';

        // Swap the orders
        const updatedFrameInputs = [
            { nodeId: node1.id, order: current1Order === 'start' ? 'end' : 'start' as 'start' | 'end' },
            { nodeId: node2.id, order: current2Order === 'start' ? 'end' : 'start' as 'start' | 'end' }
        ];

        onUpdate(data.id, { frameInputs: updatedFrameInputs });
    };

    const currentSizeLabel = (data.type === NodeType.VIDEO || data.type === NodeType.LOCAL_VIDEO_MODEL)
        ? (data.resolution || "Auto")
        : (data.aspectRatio || "Auto");

    // For image nodes, use model-specific aspect ratios (sizeOptions for video computed later with availableResolutions)
    const currentImageModelForRatios = IMAGE_MODELS.find(m => m.id === data.imageModel) || IMAGE_MODELS[0];
    const imageAspectRatioOptions = currentImageModelForRatios.aspectRatios || IMAGE_RATIOS;
    const isVideoNode = data.type === NodeType.VIDEO || data.type === NodeType.LOCAL_VIDEO_MODEL;
    const isImageNode = data.type === NodeType.IMAGE || data.type === NodeType.LOCAL_IMAGE_MODEL;
    const hasConnectedImages = connectedImageNodes.length > 0;

    // Video model selection logic
    const currentVideoModel = VIDEO_MODELS.find(m => m.id === data.videoModel) || VIDEO_MODELS[0];
    const isReferenceMode = data.videoInputMode === 'reference';
    const supportsReferenceImages = currentVideoModel.supportsReferenceImages === true;
    const maxReferenceImages = currentVideoModel.maxReferenceImages || 9;

    // 输入模式（UI 三选）：显式值优先，旧节点（auto）按连接数推断
    const inputModeUI: VideoInputModeUI = isReferenceMode
        ? 'reference'
        : data.videoInputMode === 'first-frame'
            ? 'first-frame'
            : (data.videoInputMode === 'frame-to-frame'
                || data.videoMode === 'frame-to-frame'
                || connectedImageNodes.length >= 2)
                ? 'frame-to-frame'
                : 'first-frame';
    const isFrameToFrame = inputModeUI === 'frame-to-frame';

    // Determine video generation mode based on inputs and settings
    // 1. Motion Control: If any parent is a video node
    // 2. Multi-Reference: 显式选择多图参考（Seedance reference_image）
    // 3. Frame-to-Frame: If multiple image parents or explicitly set
    // 4. Image-to-Video: If single image parent or inputUrl (last frame)
    // 5. Text-to-Video: Otherwise
    const hasVideoParent = connectedImageNodes.some(n => n.type === NodeType.VIDEO);
    const imageInputCount = connectedImageNodes.filter(n => n.type === NodeType.IMAGE).length;

    const videoGenerationMode = hasVideoParent ? 'motion-control'
        : isReferenceMode ? 'reference'
            : (isFrameToFrame || imageInputCount >= 2) ? 'frame-to-frame'
                : (inputUrl || imageInputCount > 0) ? 'image-to-video'
                    : 'text-to-video';

    // Filter video models based on mode
    const availableVideoModels = VIDEO_MODELS.filter(model => {
        if (videoGenerationMode === 'motion-control') return model.id === 'kling-v2-6'; // Only Kling 2.6 for now
        if (videoGenerationMode === 'reference') return model.supportsReferenceImages === true;
        if (videoGenerationMode === 'text-to-video') return model.supportsTextToVideo;
        if (videoGenerationMode === 'image-to-video') return model.supportsImageToVideo;
        return model.supportsMultiImage; // frame-to-frame
    });

    // Auto-select first available video model when current is no longer valid
    useEffect(() => {
        if (data.type !== NodeType.VIDEO) return;

        const isCurrentModelAvailable = availableVideoModels.some(m => m.id === data.videoModel);
        if (!isCurrentModelAvailable && availableVideoModels.length > 0) {
            onUpdate(data.id, { videoModel: availableVideoModels[0].id });
        }
    }, [videoGenerationMode, data.videoModel, data.type, data.id, availableVideoModels, onUpdate]);

    const handleVideoModelChange = (modelId: string) => {
        const newModel = VIDEO_MODELS.find(m => m.id === modelId);
        const updates: Partial<typeof data> = { videoModel: modelId };

        // Reset duration if current duration is not supported by new model
        if (newModel?.durations && data.videoDuration && !newModel.durations.includes(data.videoDuration)) {
            updates.videoDuration = newModel.durations[0];
        }

        // Reset resolution if current resolution is not supported by new model
        // Normalize to lowercase for comparison
        if (newModel?.resolutions && data.resolution) {
            const currentRes = data.resolution.toLowerCase();
            const supportedRes = newModel.resolutions.map(r => r.toLowerCase());
            if (!supportedRes.includes(currentRes)) {
                updates.resolution = newModel.resolutions[0];
            }
        }

        onUpdate(data.id, updates);
        setShowModelDropdown(false);
    };

    // Get available durations for current model
    const availableDurations = currentVideoModel.durations || [5];
    const currentDuration = data.videoDuration || availableDurations[0];

    // Get available resolutions for current model (considering duration for models with durationResolutionMap)
    const getAvailableResolutions = () => {
        const model = currentVideoModel as any;
        if (model.durationResolutionMap && currentDuration) {
            return model.durationResolutionMap[currentDuration] || model.resolutions || VIDEO_RESOLUTIONS;
        }
        return model.resolutions || VIDEO_RESOLUTIONS;
    };
    const availableResolutions = getAvailableResolutions();

    // sizeOptions: For video nodes use model-specific resolutions, for image nodes use aspect ratios
    const sizeOptions = (data.type === NodeType.VIDEO || data.type === NodeType.LOCAL_VIDEO_MODEL)
        ? availableResolutions
        : imageAspectRatioOptions;

    const handleDurationChange = (duration: number) => {
        const model = currentVideoModel as any;
        const updates: Partial<typeof data> = { videoDuration: duration };

        // If model has duration-specific resolutions, reset resolution if needed
        if (model.durationResolutionMap) {
            const allowedResolutions = model.durationResolutionMap[duration] || model.resolutions;
            if (data.resolution && !allowedResolutions.includes(data.resolution.toLowerCase())) {
                updates.resolution = allowedResolutions[0];
            }
        }

        onUpdate(data.id, updates);
        setShowDurationDropdown(false);
    };

    // Image model selection logic
    const currentImageModel = IMAGE_MODELS.find(m => m.id === data.imageModel) || IMAGE_MODELS[0];

    // Filter image models based on connected inputs
    // 0 inputs = all models, 1 input = needs supportsImageToImage, 2+ inputs = needs supportsMultiImage
    const inputCount = connectedImageNodes.length;
    const availableImageModels = IMAGE_MODELS.filter(model => {
        if (inputCount === 0) return true; // Text-to-image: all models work
        if (inputCount === 1) return model.supportsImageToImage; // Single ref: filter out V2.1
        return model.supportsMultiImage; // Multi-ref: filter out V1, V1.5, V2 New
    });

    // Auto-select first available model when current model is no longer valid for the mode
    useEffect(() => {
        if (data.type !== NodeType.IMAGE && data.type !== NodeType.IMAGE_EDITOR) return;

        const isCurrentModelAvailable = availableImageModels.some(m => m.id === data.imageModel);
        if (!isCurrentModelAvailable && availableImageModels.length > 0) {
            // Auto-select first available model
            onUpdate(data.id, { imageModel: availableImageModels[0].id });
        }
    }, [inputCount, data.imageModel, data.type, data.id, availableImageModels, onUpdate]);

    // Determine current generation mode for display
    const imageGenerationMode = inputCount === 0 ? 'text-to-image'
        : inputCount === 1 ? 'image-to-image'
            : 'multi-image';

    const handleImageModelChange = (modelId: string) => {
        const newModel = IMAGE_MODELS.find(m => m.id === modelId);
        const updates: Partial<typeof data> = { imageModel: modelId };

        // Reset aspect ratio if current ratio is not supported by new model
        if (newModel?.aspectRatios && data.aspectRatio && !newModel.aspectRatios.includes(data.aspectRatio)) {
            updates.aspectRatio = 'Auto';
        }

        // Reset resolution if current resolution is not supported by new model
        if (newModel?.resolutions && data.resolution && !newModel.resolutions.includes(data.resolution)) {
            updates.resolution = newModel.resolutions[0] || 'Auto';
        }

        onUpdate(data.id, updates);
        setShowModelDropdown(false);
    };

    // Handle local model selection
    const handleLocalModelChange = (model: LocalModel) => {
        onUpdate(data.id, {
            localModelId: model.id,
            localModelPath: model.path,
            localModelType: model.type as NodeData['localModelType'],
            localModelArchitecture: model.architecture
        });
        setShowModelDropdown(false);
    };

    // Get selected local model for display
    const selectedLocalModel = localModels.find(m => m.id === data.localModelId);

    const handleResolutionSelect = (value: string) => {
        onUpdate(data.id, { resolution: value });
        setShowResolutionDropdown(false);
    };

    // Get frame inputs with their image URLs
    // Auto-assign order: first connected = start, second = end
    // If user has explicitly set frameInputs, use those orders, otherwise auto-assign
    const frameInputsWithUrls = connectedImageNodes.slice(0, 2).map((node, idx) => {
        // Check if there's an explicit order from user reordering
        const existingInput = data.frameInputs?.find(f => f.nodeId === node.id);
        return {
            nodeId: node.id,
            url: node.url,
            type: node.type,
            order: existingInput?.order || (idx === 0 ? 'start' : 'end') as 'start' | 'end'
        };
    }).sort((a, b) => {
        // Sort by order: 'start' first, 'end' second
        if (a.order === 'start' && b.order === 'end') return -1;
        if (a.order === 'end' && b.order === 'start') return 1;
        return 0;
    });

    // 多图参考模式：展示全部连接图（顺序即发送顺序，提示词里可用 @image1… 引用）
    const referenceInputs = connectedImageNodes.map((node, index) => ({
        nodeId: node.id,
        url: node.url,
        type: node.type,
        index,
    }));
    const exceedingReferenceLimit = isReferenceMode && referenceInputs.length > maxReferenceImages;

    // 面板缩放策略：与画布保持一致
    //  - zoom <= 1：不补偿，面板随画布一起缩小/放大（此前固定 0.8 屏幕尺寸，缩小时显得特别大）
    //  - zoom > 1：按 1/zoom 反向缩放，屏幕尺寸封顶 1 倍，避免放大画布时面板挡住内容
    const localScale = zoom > 1 ? 1 / zoom : 1;

    // Theme helper
    const isDark = canvasTheme === 'dark';

    // Handle angle mode generate - creates a new connected node
    const handleAngleGenerate = () => {
        if (onChangeAngleGenerate) {
            onChangeAngleGenerate(data.id);
        }
    };

    // If in angle mode for Image nodes with result, show ChangeAnglePanel
    if (data.angleMode && data.type === NodeType.IMAGE && isSuccess && data.resultUrl) {
        return (
            <div
                style={{
                    transform: `scale(${localScale})`,
                    transformOrigin: 'top center',
                    transition: 'transform 0.1s ease-out'
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onSelect(data.id)}
            >
                <ChangeAnglePanel
                    imageUrl={data.resultUrl}
                    settings={data.angleSettings || { rotation: 0, tilt: 0, scale: 0, wideAngle: false }}
                    onSettingsChange={(settings) => onUpdate(data.id, { angleSettings: settings })}
                    onClose={() => onUpdate(data.id, { angleMode: false })}
                    onGenerate={handleAngleGenerate}
                    isLoading={isLoading}
                    canvasTheme={canvasTheme}
                />
            </div>
        );
    }

    return (
        <div
            className={`p-4 rounded-2xl shadow-2xl cursor-default w-full transition-colors duration-300 ${isDark ? 'bg-[#1a1a1a] border border-neutral-800' : 'bg-white border border-neutral-200'}`}
            style={{
                transform: `scale(${localScale})`,
                transformOrigin: 'top center',
                transition: 'transform 0.1s ease-out'
            }}
            onPointerDown={(e) => e.stopPropagation()} // Allow selecting text/interacting without dragging
            onClick={() => onSelect(data.id)} // Ensure clicking here selects the node
        >
            {/* Prompt Textarea with Expand Button - Hidden for storyboard-generated scenes */}
            {!(data.prompt && data.prompt.startsWith('Extract panel #')) && (
                <div className="mb-3">
                    <textarea
                        className={`w-full bg-transparent text-sm outline-none resize-none font-light ${isDark ? 'text-white placeholder-neutral-600' : 'text-neutral-900 placeholder-neutral-400'}`}
                        placeholder={
                            data.type === NodeType.VIDEO && isFrameToFrame && currentVideoModel.provider === 'kling'
                                ? t('controls.promptOptional')
                                : data.type === NodeType.VIDEO && inputUrl
                                    ? t('controls.describeAnimate')
                                    : "Describe what you want to generate..."
                        }
                        rows={data.isPromptExpanded ? 12 : 4}
                        value={localPrompt}
                        onChange={(e) => handlePromptChange(e.target.value)}
                        onWheel={(e) => e.stopPropagation()}
                        onBlur={() => {
                            // Ensure final value is saved on blur
                            if (updateTimeoutRef.current) {
                                clearTimeout(updateTimeoutRef.current);
                            }
                            if (localPrompt !== data.prompt) {
                                onUpdate(data.id, { prompt: localPrompt });
                            }
                        }}
                    />
                    {/* Expand/Shrink Button - Below textarea */}
                    <div className="flex justify-end mt-1">
                        <button
                            onClick={() => onUpdate(data.id, { isPromptExpanded: !data.isPromptExpanded })}
                            className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors ${isDark ? 'text-neutral-500 hover:text-white hover:bg-neutral-700' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200'}`}
                            title={data.isPromptExpanded ? t('controls.shrinkPrompt') : t('controls.expandPrompt')}
                        >
                            {data.isPromptExpanded ? <Shrink size={12} /> : <Expand size={12} />}
                            <span>{data.isPromptExpanded ? 'Shrink' : 'Expand'}</span>
                        </button>
                    </div>
                </div>
            )}

            {data.errorMessage && (
                <div className="text-red-400 text-xs mb-2 p-1 bg-red-900/20 rounded border border-red-900/50">
                    {data.errorMessage}
                </div>
            )}

            {/* Motion Control Warning - when motion mode detected but no character image */}
            {isVideoNode && videoGenerationMode === 'motion-control' && imageInputCount === 0 && (
                <div className="text-amber-400 text-xs mb-2 p-2 bg-amber-900/20 rounded border border-amber-700/50 flex items-start gap-2">
                    <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>
                        <strong>{t('controls.motionControl')}</strong> {t('controls.motionControlWarning')}
                    </span>
                </div>
            )}

            {/* Controls - Hidden for storyboard-generated scenes */}
            {!(data.prompt && data.prompt.startsWith('Extract panel #')) && (
                <div className="flex items-center justify-between relative">
                    <div className="flex items-center gap-2">
                        {/* Model Selector - Local, Video, and Image nodes get different dropdowns */}
                        {isLocalModelNode ? (
                            <div className="relative" ref={modelDropdownRef}>
                                <button
                                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    <HardDrive size={12} className="text-purple-400" />
                                    <span className="font-medium">{selectedLocalModel?.name || t('controls.selectModel')}</span>
                                    <ChevronDown size={12} className="ml-0.5 opacity-50" />
                                </button>

                                {/* Local Model Dropdown Menu */}
                                {showModelDropdown && (
                                    <div className="absolute top-full mt-1 left-0 w-56 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100 max-h-64 overflow-y-auto">
                                        {/* Header */}
                                        <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-400 uppercase tracking-wider bg-[#1a1a1a] border-b border-neutral-700 flex items-center gap-1.5">
                                            <HardDrive size={10} />
                                            Local Models
                                        </div>

                                        {isLoadingLocalModels ? (
                                            <div className="px-3 py-4 text-xs text-neutral-500 text-center">{t('controls.loadingModels')}</div>
                                        ) : localModels.length === 0 ? (
                                            <div className="px-3 py-4 text-xs text-neutral-500 text-center">
                                                <p>{t('controls.noModels')}</p>
                                                <p className="text-[10px] mt-1">{t('controls.addModels')}</p>
                                            </div>
                                        ) : (
                                            localModels.map(model => (
                                                <button
                                                    key={model.id}
                                                    onClick={() => handleLocalModelChange(model)}
                                                    className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${data.localModelId === model.id ? 'text-purple-400' : 'text-neutral-300'}`}
                                                >
                                                    <span className="flex flex-col items-start gap-0.5">
                                                        <span className="flex items-center gap-2">
                                                            <HardDrive size={12} className="text-purple-400" />
                                                            {model.name}
                                                            {model.architecture && model.architecture !== 'unknown' && (
                                                                <span className="text-[9px] px-1 py-0.5 bg-purple-600/30 text-purple-400 rounded">{model.architecture.toUpperCase()}</span>
                                                            )}
                                                        </span>
                                                        <span className="text-[10px] text-neutral-500 ml-5">{model.sizeFormatted}</span>
                                                    </span>
                                                    {data.localModelId === model.id && <Check size={12} />}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : data.type === NodeType.VIDEO ? (
                            <div className="relative" ref={modelDropdownRef}>
                                <button
                                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    {currentVideoModel.id === 'veo-3.1' ? (
                                        <GoogleIcon size={12} className="text-white" />
                                    ) : currentVideoModel.provider === 'kling' ? (
                                        <KlingIcon size={14} />
                                    ) : currentVideoModel.provider === 'doubao' ? (
                                        <Sparkles size={12} className="text-purple-400" />
                                    ) : (
                                        <Film size={12} className="text-cyan-400" />
                                    )}
                                    <span className="font-medium">{currentVideoModel.name}</span>
                                    <ChevronDown size={12} className="ml-0.5 opacity-50" />
                                </button>

                                {/* Model Dropdown Menu */}
                                {showModelDropdown && (
                                    <div className="absolute top-full mt-1 left-0 w-52 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100">
                                        {/* Mode indicator */}
                                        <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-400 uppercase tracking-wider bg-[#1a1a1a] border-b border-neutral-700 flex items-center gap-1.5">
                                            <span className={`w-1.5 h-1.5 rounded-full ${videoGenerationMode === 'text-to-video' ? 'bg-blue-400' :
                                                videoGenerationMode === 'image-to-video' ? 'bg-green-400' :
                                                    videoGenerationMode === 'motion-control' ? 'bg-orange-400' : 'bg-purple-400'
                                                }`} />
                                            {videoGenerationMode === 'text-to-video' ? 'Text → Video' :
                                                videoGenerationMode === 'image-to-video' ? t('controls.imageToVideo') :
                                                    videoGenerationMode === 'motion-control' ? t('controls.motionControl') :
                                                        videoGenerationMode === 'reference' ? t('controls.inputModeReference') :
                                                            t('controls.frameToFrame')}
                                        </div>
                                        {/* Google Models */}
                                        {availableVideoModels.filter(m => m.provider === 'google').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                                    Google
                                                </div>
                                                {availableVideoModels.filter(m => m.provider === 'google').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleVideoModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentVideoModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            {model.id === 'veo-3.1' ? (
                                                                <GoogleIcon size={12} className="text-white" />
                                                            ) : (
                                                                <Film size={12} className="text-cyan-400" />
                                                            )}
                                                            {model.name}
                                                        </span>
                                                        {currentVideoModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}

                                        {/* Kling Models */}
                                        {availableVideoModels.filter(m => m.provider === 'kling').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    Kling AI
                                                </div>
                                                {availableVideoModels.filter(m => m.provider === 'kling').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleVideoModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentVideoModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <KlingIcon size={14} />
                                                            {model.name}
                                                        </span>
                                                        {currentVideoModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}

                                        {/* Hailuo Models */}
                                        {availableVideoModels.filter(m => m.provider === 'hailuo').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    Hailuo AI
                                                </div>
                                                {availableVideoModels.filter(m => m.provider === 'hailuo').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleVideoModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentVideoModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <HailuoIcon size={14} />
                                                            {model.name}
                                                        </span>
                                                        {currentVideoModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}
                                        {availableVideoModels.filter(m => m.provider === 'doubao').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    豆包 Seedance
                                                </div>
                                                {availableVideoModels.filter(m => m.provider === 'doubao').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleVideoModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentVideoModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'}`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <Sparkles size={14} className="text-purple-400" />
                                                            {model.name}
                                                        </span>
                                                        {currentVideoModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="relative" ref={modelDropdownRef}>
                                <button
                                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    {currentImageModel.id === 'google-veo' ? ( // Keeping consistency if there was one, but mainly checking provider
                                        <GoogleIcon size={12} className="text-white" />
                                    ) : currentImageModel.id === 'gemini-pro' ? (
                                        <Banana size={12} className="text-yellow-400" />
                                    ) : currentImageModel.provider === 'openai' ? (
                                        <OpenAIIcon size={12} className="text-green-400" />
                                    ) : currentImageModel.provider === 'kling' ? (
                                        <KlingIcon size={14} />
                                    ) : (
                                        <ImageIcon size={12} className="text-cyan-400" />
                                    )}
                                    <span className="font-medium">{currentImageModel.name}</span>
                                    <ChevronDown size={12} className="ml-0.5 opacity-50" />
                                </button>

                                {/* Image Model Dropdown Menu */}
                                {showModelDropdown && (
                                    <div className="absolute top-full mt-1 left-0 w-48 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100">
                                        {/* Mode indicator */}
                                        <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-400 uppercase tracking-wider bg-[#1a1a1a] border-b border-neutral-700 flex items-center gap-1.5">
                                            <span className={`w-1.5 h-1.5 rounded-full ${imageGenerationMode === 'text-to-image' ? 'bg-blue-400' :
                                                imageGenerationMode === 'image-to-image' ? 'bg-green-400' : 'bg-purple-400'
                                                }`} />
                                            {imageGenerationMode === 'text-to-image' ? 'Text → Image' :
                                                imageGenerationMode === 'image-to-image' ? `Image → Image` :
                                                    `${inputCount} Images → Image`}
                                        </div>
                                        {/* OpenAI Models */}
                                        {availableImageModels.filter(m => m.provider === 'openai').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                                    OpenAI
                                                </div>
                                                {availableImageModels.filter(m => m.provider === 'openai').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleImageModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentImageModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <OpenAIIcon size={12} className="text-green-400" />
                                                            {model.name}
                                                        </span>
                                                        {currentImageModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}
                                        {/* Google Models */}
                                        {availableImageModels.filter(m => m.provider === 'google').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    Google
                                                </div>
                                                {availableImageModels.filter(m => m.provider === 'google').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleImageModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentImageModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            {model.id === 'gemini-pro' ? (
                                                                <Banana size={12} className="text-yellow-400" />
                                                            ) : (
                                                                <GoogleIcon size={12} className="text-white" />
                                                            )}
                                                            {model.name}
                                                        </span>
                                                        {currentImageModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}

                                        {/* Kling Models */}
                                        {availableImageModels.filter(m => m.provider === 'kling').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    Kling AI
                                                </div>
                                                {availableImageModels.filter(m => m.provider === 'kling').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleImageModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentImageModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'
                                                            }`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <KlingIcon size={14} />
                                                            {model.name}
                                                        </span>
                                                        {currentImageModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}
                                        {availableImageModels.filter(m => m.provider === 'doubao').length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f] border-t border-neutral-700">
                                                    豆包 Seedream
                                                </div>
                                                {availableImageModels.filter(m => m.provider === 'doubao').map(model => (
                                                    <button
                                                        key={model.id}
                                                        onClick={() => handleImageModelChange(model.id)}
                                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentImageModel.id === model.id ? 'text-blue-400' : 'text-neutral-300'}`}
                                                    >
                                                        <span className="flex items-center gap-2">
                                                            <Sparkles size={14} className="text-purple-400" />
                                                            {model.name}
                                                        </span>
                                                        {currentImageModel.id === model.id && <Check size={12} />}
                                                    </button>
                                                ))}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Unified Size/Ratio Dropdown (hidden for video nodes in motion-control mode) */}
                        {!(isVideoNode && videoGenerationMode === 'motion-control') && (
                            <div className="relative" ref={dropdownRef}>
                                <button
                                    onClick={() => setShowSizeDropdown(!showSizeDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    {isVideoNode && <Monitor size={12} className="text-green-400" />}
                                    {!isVideoNode && <Crop size={12} className="text-blue-400" />}
                                    {isVideoNode && currentSizeLabel === 'Auto' ? 'Auto' : currentSizeLabel}
                                </button>

                                {/* Dropdown Menu */}
                                {showSizeDropdown && (
                                    <div
                                        className="absolute bottom-full mb-2 right-0 w-32 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100 flex flex-col max-h-60 overflow-y-auto"
                                        onWheel={(e) => e.stopPropagation()}
                                    >
                                        <div className="px-3 py-2 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                            {isVideoNode ? t('controls.resolution') : t('controls.aspectRatio')}
                                        </div>
                                        {sizeOptions.map(option => (
                                            <button
                                                key={option}
                                                onClick={() => handleSizeSelect(option)}
                                                className={`flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentSizeLabel === option ? 'text-blue-400' : 'text-neutral-300'
                                                    }`}
                                            >
                                                <span>{option}</span>
                                                {currentSizeLabel === option && <Check size={12} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Image Resolution Dropdown - Only for Image nodes */}
                        {!isVideoNode && (currentImageModel as any).resolutions && (
                            <div className="relative" ref={resolutionDropdownRef}>
                                <button
                                    onClick={() => setShowResolutionDropdown(!showResolutionDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    <Monitor size={12} className="text-green-400" />
                                    {data.resolution || 'Auto'}
                                </button>

                                {/* Dropdown Menu */}
                                {showResolutionDropdown && (
                                    <div
                                        className="absolute bottom-full mb-2 right-0 w-24 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100"
                                        onWheel={(e) => e.stopPropagation()}
                                    >
                                        <div className="px-3 py-2 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                            Quality
                                        </div>
                                        {(currentImageModel as any).resolutions.map((res: string) => (
                                            <button
                                                key={res}
                                                onClick={() => handleResolutionSelect(res)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${(data.resolution || 'Auto') === res ? 'text-blue-400' : 'text-neutral-300'}`}
                                            >
                                                <span>{res}</span>
                                                {(data.resolution || 'Auto') === res && <Check size={12} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Video Aspect Ratio Dropdown - Only for video nodes (hidden in motion-control mode) */}
                        {isVideoNode && videoGenerationMode !== 'motion-control' && (
                            <div className="relative" ref={aspectRatioDropdownRef}>
                                <button
                                    onClick={() => setShowAspectRatioDropdown(!showAspectRatioDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    <Film size={12} className="text-purple-400" />
                                    {data.aspectRatio || '16:9'}
                                </button>

                                {/* Aspect Ratio Dropdown Menu */}
                                {showAspectRatioDropdown && (
                                    <div className="absolute bottom-full mb-2 right-0 w-28 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100">
                                        <div className="px-3 py-2 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                            Size
                                        </div>
                                        {(currentVideoModel?.aspectRatios || VIDEO_ASPECT_RATIOS).map((option: string) => (
                                            <button
                                                key={option}
                                                onClick={() => handleAspectRatioSelect(option)}
                                                className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${data.aspectRatio === option ? 'text-blue-400' : 'text-neutral-300'}`}
                                            >
                                                <span>{option}</span>
                                                {data.aspectRatio === option && <Check size={12} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Duration Dropdown - Only for video nodes (hidden in motion-control mode) */}
                        {isVideoNode && videoGenerationMode !== 'motion-control' && availableDurations.length > 0 && (
                            <div className="relative" ref={durationDropdownRef}>
                                <button
                                    onClick={() => setShowDurationDropdown(!showDurationDropdown)}
                                    className="flex items-center gap-1.5 text-xs font-medium bg-[#252525] hover:bg-[#333] border border-neutral-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
                                >
                                    <Clock size={12} className="text-cyan-400" />
                                    {currentDuration}s
                                </button>

                                {/* Duration Dropdown Menu */}
                                {showDurationDropdown && (
                                    <div className="absolute bottom-full mb-2 right-0 w-24 bg-[#252525] border border-neutral-700 rounded-lg shadow-xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100">
                                        <div className="px-3 py-2 text-[10px] font-bold text-neutral-500 uppercase tracking-wider bg-[#1f1f1f]">
                                            {t('controls.duration')}
                                        </div>
                                        {availableDurations.map((dur: number) => (
                                            <button
                                                key={dur}
                                                onClick={() => handleDurationChange(dur)}
                                                className={`w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-[#333] transition-colors ${currentDuration === dur ? 'text-blue-400' : 'text-neutral-300'}`}
                                            >
                                                <span>{dur}s</span>
                                                {currentDuration === dur && <Check size={12} />}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Generate Button - Active even after success to allow re-generation */}
                        {!isLoading && (() => {
                            // Check if generation is blocked due to no face detected in Face mode
                            const isFaceModeBlocked = !isVideoNode &&
                                data.imageModel === 'kling-v1-5' &&
                                data.klingReferenceMode === 'face' &&
                                (data.faceDetectionStatus === 'error' || data.faceDetectionStatus === 'loading');

                            return (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (isFaceModeBlocked) {
                                            // Show a warning - this is handled by the warning component
                                            return;
                                        }
                                        onGenerate(data.id);
                                    }}
                                    disabled={isFaceModeBlocked}
                                    className={`group w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 ${isFaceModeBlocked
                                        ? 'bg-neutral-700/50 cursor-not-allowed opacity-50'
                                        : isDark
                                            ? 'bg-white text-neutral-900 hover:bg-neutral-100 active:scale-95'
                                            : 'bg-neutral-900 text-white hover:bg-neutral-800 active:scale-95'
                                        }`}
                                    title={isFaceModeBlocked ? t('controls.noFaceDetected') : t('controls.generate')}
                                >
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="w-4 h-4 transition-transform duration-200"
                                        fill="currentColor"
                                    >
                                        <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                </button>
                            );
                        })()}
                    </div>
                </div>
            )}

            {/* Kling V1.5 Reference Settings - For Image nodes with connected input */}
            {!isVideoNode && data.imageModel === 'kling-v1-5' && connectedImageNodes.length > 0 && (
                <div className="mt-3 pt-3 border-t border-neutral-800">
                    <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-2">{t('controls.referenceSettings')}</div>

                    {/* Mode Tabs */}
                    <div className="flex gap-1 mb-3 p-1 bg-neutral-800/50 rounded-lg">
                        <button
                            onClick={() => onUpdate(data.id, { klingReferenceMode: 'subject', detectedFaces: undefined, faceDetectionStatus: undefined })}
                            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors ${(data.klingReferenceMode || 'subject') === 'subject'
                                ? 'bg-neutral-700 text-white font-medium'
                                : 'text-neutral-400 hover:text-white hover:bg-neutral-700/50'
                                }`}
                        >
                            Subject
                        </button>
                        <button
                            onClick={() => {
                                // Just switch mode, face detection will be triggered by effect
                                onUpdate(data.id, { klingReferenceMode: 'face', faceDetectionStatus: 'loading', detectedFaces: undefined });
                            }}
                            className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors ${data.klingReferenceMode === 'face'
                                ? 'bg-neutral-700 text-white font-medium'
                                : 'text-neutral-400 hover:text-white hover:bg-neutral-700/50'
                                }`}
                        >
                            Face
                        </button>
                    </div>

                    {/* Reference Image Preview with Face Detection Overlay */}
                    {connectedImageNodes[0]?.url && (
                        <div className="mb-3">
                            {/* Main image with face highlight */}
                            <div className="rounded-lg overflow-hidden bg-black relative flex items-center justify-center" style={{ maxHeight: '200px' }}>
                                <div className="relative">
                                    <img
                                        src={connectedImageNodes[0].url}
                                        alt="Reference"
                                        className="max-h-[200px] w-auto h-auto block object-contain"
                                    />
                                    {/* Face detection corner brackets - Kling style */}
                                    {data.klingReferenceMode === 'face' && data.faceDetectionStatus === 'success' && data.detectedFaces && data.detectedFaces.length > 0 && (
                                        <>
                                            {data.detectedFaces.map((face, idx) => (
                                                <div
                                                    key={idx}
                                                    className="absolute pointer-events-none"
                                                    style={{
                                                        left: `${face.x}%`,
                                                        top: `${face.y}%`,
                                                        width: `${face.width}%`,
                                                        height: `${face.height}%`,
                                                    }}
                                                >
                                                    {/* Corner brackets - larger with glow */}
                                                    <div className="absolute -top-1 -left-1 w-8 h-8 border-t-4 border-l-4 border-green-400 rounded-tl-xl" style={{ filter: 'drop-shadow(0 0 4px rgba(74, 222, 128, 0.8))' }} />
                                                    <div className="absolute -top-1 -right-1 w-8 h-8 border-t-4 border-r-4 border-green-400 rounded-tr-xl" style={{ filter: 'drop-shadow(0 0 4px rgba(74, 222, 128, 0.8))' }} />
                                                    <div className="absolute -bottom-1 -left-1 w-8 h-8 border-b-4 border-l-4 border-green-400 rounded-bl-xl" style={{ filter: 'drop-shadow(0 0 4px rgba(74, 222, 128, 0.8))' }} />
                                                    <div className="absolute -bottom-1 -right-1 w-8 h-8 border-b-4 border-r-4 border-green-400 rounded-br-xl" style={{ filter: 'drop-shadow(0 0 4px rgba(74, 222, 128, 0.8))' }} />
                                                </div>
                                            ))}
                                        </>
                                    )}
                                    {/* Loading indicator */}
                                    {data.klingReferenceMode === 'face' && data.faceDetectionStatus === 'loading' && (
                                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                            <div className="text-xs text-white">{t('controls.detectingFaces')}</div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Face thumbnail below - Kling style */}
                            {data.klingReferenceMode === 'face' && data.faceDetectionStatus === 'success' && data.detectedFaces && data.detectedFaces.length > 0 && (
                                <div className="flex justify-center mt-3">
                                    <div className="w-14 h-14 rounded-lg border-2 border-green-400 overflow-hidden bg-black">
                                        <img
                                            src={connectedImageNodes[0].url}
                                            alt="Detected face"
                                            className="w-full h-full object-cover"
                                            style={{
                                                objectPosition: `${data.detectedFaces[0].x + data.detectedFaces[0].width / 2}% ${data.detectedFaces[0].y + data.detectedFaces[0].height / 2}%`,
                                                transform: `scale(${100 / Math.max(data.detectedFaces[0].width, data.detectedFaces[0].height) * 0.8})`
                                            }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* No Face Detected Warning */}
                    {data.klingReferenceMode === 'face' && data.faceDetectionStatus === 'error' && (
                        <div className="mb-3 p-2 bg-amber-900/20 border border-amber-700/50 rounded-lg">
                            <div className="flex items-start gap-2 text-amber-400 text-xs">
                                <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                                <span>No face detected. Please use a reference image with a clearer face.</span>
                            </div>
                        </div>
                    )}

                    {/* Subject Mode: Show BOTH Face Reference and Subject Reference sliders */}
                    {(data.klingReferenceMode || 'subject') === 'subject' && (
                        <>
                            <div className="space-y-1 mb-3">
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-neutral-400">{t('controls.faceReference')}</span>
                                    <span className="text-white font-medium">{data.klingFaceIntensity ?? 65}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={data.klingFaceIntensity ?? 65}
                                    onChange={(e) => onUpdate(data.id, { klingFaceIntensity: parseInt(e.target.value) })}
                                    className="w-full h-1.5 bg-neutral-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-md"
                                />
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-neutral-400">{t('controls.subjectReference')}</span>
                                    <span className="text-white font-medium">{data.klingSubjectIntensity ?? 50}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={data.klingSubjectIntensity ?? 50}
                                    onChange={(e) => onUpdate(data.id, { klingSubjectIntensity: parseInt(e.target.value) })}
                                    className="w-full h-1.5 bg-neutral-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-md"
                                />
                            </div>
                        </>
                    )}

                    {/* Face Mode: Show single Reference Strength slider */}
                    {data.klingReferenceMode === 'face' && data.faceDetectionStatus === 'success' && (
                        <div className="space-y-1">
                            <div className="flex justify-between text-[10px]">
                                <span className="text-neutral-400">{t('controls.referenceStrength')}</span>
                                <span className="text-white font-medium">{data.klingFaceIntensity ?? 42}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={data.klingFaceIntensity ?? 42}
                                onChange={(e) => onUpdate(data.id, { klingFaceIntensity: parseInt(e.target.value) })}
                                className="w-full h-1.5 bg-neutral-700 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-md"
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Advanced Settings Drawer - Only for Video nodes */}
            {
                isVideoNode && (
                    <div className="mt-2 pt-2 border-t border-neutral-800">
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="w-full flex items-center justify-center gap-1 cursor-pointer"
                        >
                            <span className="text-[10px] text-neutral-600 uppercase tracking-widest hover:text-neutral-400">
                                Advanced Settings
                            </span>
                            {showAdvanced ? (
                                <ChevronUp size={12} className="text-neutral-600" />
                            ) : (
                                <ChevronDown size={12} className="text-neutral-600" />
                            )}
                        </button>

                        {/* Advanced Settings Content - Only for Video nodes */}
                        {showAdvanced && isVideoNode && (
                            <div className="mt-3 space-y-3">
                                {/* Audio Toggle - Only for Kling 2.6 (Veo 3.1 SDK doesn't support generateAudio yet) */}
                                {data.videoModel === 'kling-v2-6' && (
                                    <div className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-neutral-800/50 rounded-lg w-fit">
                                        <svg className="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                        </svg>
                                        <span className="text-[11px] text-neutral-300">{t('controls.audio')}</span>
                                        <button
                                            onClick={() => onUpdate(data.id, { generateAudio: !(data.generateAudio !== false) })}
                                            className={`relative w-8 h-4 rounded-full transition-colors ${data.generateAudio !== false ? 'bg-cyan-600' : 'bg-neutral-700'}`}
                                        >
                                            <span
                                                className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform shadow-md ${data.generateAudio !== false ? 'left-4' : 'left-0.5'}`}
                                            />
                                        </button>
                                    </div>
                                )}

                                {/* 输入模式：首帧 / 首尾帧 / 多图参考 */}
                                {(connectedImageNodes.length > 0 || isReferenceMode || !!data.videoInputMode) &&
                                    videoGenerationMode !== 'motion-control' && (
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] text-neutral-500 uppercase tracking-wider">
                                            {t('controls.inputMode')}
                                        </label>
                                        <div className="flex gap-1 p-1 bg-neutral-800/60 rounded-lg">
                                            {([
                                                { key: 'first-frame', label: t('controls.inputModeFirstFrame') },
                                                { key: 'frame-to-frame', label: t('controls.inputModeFrameToFrame') },
                                                { key: 'reference', label: t('controls.inputModeReference') },
                                            ] as { key: VideoInputModeUI; label: string }[]).map((opt) => {
                                                const disabled = opt.key === 'reference' && !supportsReferenceImages;
                                                const active = inputModeUI === opt.key;
                                                return (
                                                    <button
                                                        key={opt.key}
                                                        type="button"
                                                        disabled={disabled}
                                                        title={disabled ? t('controls.referenceUnsupported') : undefined}
                                                        onClick={() => { if (!disabled) handleInputModeChange(opt.key); }}
                                                        className={`flex-1 px-2 py-1 text-[10px] rounded-md transition-colors ${active
                                                            ? 'bg-neutral-700 text-white'
                                                            : disabled
                                                                ? 'text-neutral-600 cursor-not-allowed'
                                                                : 'text-neutral-400 hover:text-neutral-200'
                                                            }`}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <div className="text-[10px] leading-relaxed text-neutral-500">
                                            {inputModeUI === 'first-frame' && t('controls.inputModeFirstFrameHint')}
                                            {inputModeUI === 'frame-to-frame' && t('controls.inputModeFrameToFrameHint')}
                                            {inputModeUI === 'reference' && t('controls.inputModeReferenceHint', { total: connectedImageNodes.length, max: maxReferenceImages })}
                                        </div>
                                    </div>
                                )}

                                {/* 已连接的图片：多图参考展示全部，首尾帧只展示前 2 张 */}
                                {connectedImageNodes.length > 0 && (
                                    <div className="space-y-2">
                                        <label className="text-[10px] text-neutral-500 uppercase tracking-wider">
                                            {videoGenerationMode === 'motion-control'
                                                ? 'Input References'
                                                : isReferenceMode
                                                    ? `${t('controls.referenceImages')} (${referenceInputs.length})`
                                                    : 'Connected Frames'}
                                            {videoGenerationMode !== 'motion-control' && !isReferenceMode && <span className="text-neutral-600"> (drag to reorder)</span>}
                                        </label>

                                        {videoGenerationMode === 'motion-control' ? (
                                            /* Horizontal layout for Motion Control */
                                            <div className="flex gap-2">
                                                {frameInputsWithUrls.map((input) => (
                                                    <div
                                                        key={input.nodeId}
                                                        className="flex-1 flex flex-col items-center gap-2 p-2 bg-neutral-800 rounded-lg border border-neutral-700/50"
                                                    >
                                                        <div className="relative w-full aspect-video overflow-hidden rounded bg-black flex items-center justify-center">
                                                            {input.url ? (
                                                                <img
                                                                    src={input.url}
                                                                    alt={input.type === NodeType.VIDEO ? t('controls.motionRef') : t('controls.characterRef')}
                                                                    className="w-full h-full object-contain"
                                                                />
                                                            ) : (
                                                                <div className="text-[10px] text-neutral-600">{t('controls.noPreview')}</div>
                                                            )}
                                                            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                                                            <div className="absolute bottom-1 left-1 right-1">
                                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded block text-center truncate ${input.type === NodeType.VIDEO
                                                                    ? 'bg-purple-600/80 text-white'
                                                                    : 'bg-blue-600/80 text-white'
                                                                    }`}>
                                                                    {input.type === NodeType.VIDEO ? 'MOTION REF' : 'CHARACTER REF'}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : isReferenceMode ? (
                                            /* 多图参考：网格展示全部连接图，顺序即发送顺序 */
                                            <div className="grid grid-cols-2 gap-2">
                                                {referenceInputs.map((input) => (
                                                    <div
                                                        key={input.nodeId}
                                                        className="relative aspect-square overflow-hidden rounded-lg bg-neutral-800 border border-neutral-700/50"
                                                    >
                                                        {input.url ? (
                                                            <img
                                                                src={input.url}
                                                                alt={`REF ${input.index + 1}`}
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral-600">
                                                                {t('controls.noPreview')}
                                                            </div>
                                                        )}
                                                        <span className="absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600/80 text-white">
                                                            REF {input.index + 1}
                                                        </span>
                                                        {input.type === NodeType.VIDEO && (
                                                            <span className="absolute bottom-1 right-1 text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-600/80 text-white">
                                                                FRAME
                                                            </span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : frameInputsWithUrls.length === 0 ? (
                                            <div className="text-xs text-neutral-600 italic py-2">
                                                {t('controls.connectImagesHint')}
                                            </div>
                                        ) : (
                                            /* Vertical draggable layout for Frame-to-Frame */
                                            <div className="space-y-2">
                                                {frameInputsWithUrls.map((input, index) => (
                                                    <div
                                                        key={input.nodeId}
                                                        draggable
                                                        onDragStart={() => setDraggedIndex(index)}
                                                        onDragOver={(e) => e.preventDefault()}
                                                        onDrop={() => {
                                                            if (draggedIndex !== null) {
                                                                handleFrameReorder(draggedIndex, index);
                                                                setDraggedIndex(null);
                                                            }
                                                        }}
                                                        onDragEnd={() => setDraggedIndex(null)}
                                                        className={`flex items-center gap-2 p-2 bg-neutral-800 rounded-lg cursor-grab active:cursor-grabbing transition-all ${draggedIndex === index ? 'opacity-50 scale-95' : ''
                                                            }`}
                                                    >
                                                        <GripVertical size={14} className="text-neutral-600" />
                                                        <img
                                                            src={input.url}
                                                            alt={t('controls.frame', { index: index + 1 })}
                                                            className="w-12 h-12 object-cover rounded"
                                                        />
                                                        <div className="flex-1">
                                                            <span className={`text-xs font-medium px-2 py-0.5 rounded ${input.order === 'start'
                                                                ? 'bg-green-600/30 text-green-400'
                                                                : 'bg-orange-600/30 text-orange-400'
                                                                }`}>
                                                                {input.order === 'start' ? 'START' : 'END'}
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        {/* 多图参考超出模型上限 */}
                                        {exceedingReferenceLimit && (
                                            <div className="text-[10px] leading-relaxed text-amber-400">
                                                {t('controls.referenceLimitExceeded', { total: referenceInputs.length, max: maxReferenceImages })}
                                            </div>
                                        )}

                                        {/* 首帧/首尾帧模式下多出来的图不会参与生成 */}
                                        {!isReferenceMode && videoGenerationMode !== 'motion-control' &&
                                            connectedImageNodes.length > frameInputsWithUrls.length && (
                                                <div className="flex flex-wrap items-center gap-1 text-[10px] leading-relaxed text-amber-400">
                                                    <span>{t('controls.extraInputsUnused', { total: connectedImageNodes.length - frameInputsWithUrls.length })}</span>
                                                    {supportsReferenceImages && (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleInputModeChange('reference')}
                                                            className="underline text-blue-400 hover:text-blue-300"
                                                        >
                                                            {t('controls.switchToReference')}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )
            }
        </div >
    );
};

// Memoize to prevent re-renders when parent state changes
export const NodeControls = memo(NodeControlsComponent);
