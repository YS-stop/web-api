
export enum NodeType {
  TEXT = 'Text',
  IMAGE = 'Image',
  VIDEO = 'Video',
  AUDIO = 'Audio',
  IMAGE_EDITOR = 'Image Editor',
  VIDEO_EDITOR = 'Video Editor',
  VIDEO_MERGE = 'Video Merge',
  STORYBOARD = 'Storyboard Manager',
  CAMERA_ANGLE = 'Camera Angle',
  // Local open-source model nodes
  LOCAL_IMAGE_MODEL = 'Local Image Model',
  LOCAL_VIDEO_MODEL = 'Local Video Model'
}

export enum NodeStatus {
  IDLE = 'idle',
  LOADING = 'loading',
  SUCCESS = 'success',
  ERROR = 'error'
}

export interface NodeData {
  id: string;
  type: NodeType;
  title?: string; // Custom title for the node (defaults to type if not set)
  x: number;
  y: number;
  prompt: string;
  status: NodeStatus;
  resultUrl?: string; // Image URL or Video URL
  lastFrame?: string; // For Video nodes: base64/url of the last frame to use as input for next node
  parentIds?: string[]; // For connecting lines (supports multiple inputs)
  groupId?: string; // ID of the group this node belongs to
  errorMessage?: string;

  // Text node specific
  textMode?: 'menu' | 'editing'; // For Text nodes: current mode
  linkedVideoNodeId?: string; // For Text nodes: linked video node for prompt sync

  // Video node specific
  videoMode?: 'standard' | 'frame-to-frame' | 'motion-control'; // Video generation mode
  frameInputs?: { nodeId: string; order: 'start' | 'end' }[]; // For frame-to-frame: connected image nodes
  /**
   * 视频节点如何解释「父节点里的图片」，解决首帧与参考图的语义冲突：
   *  - auto（默认）：沿用旧逻辑，1 张图作首帧，2 张以上自动进首尾帧插值；
   *  - first-frame：第一张图强制作首帧，其余忽略；
   *  - frame-to-frame：第一张作首帧、第二张作尾帧，第 3 张起忽略；
   *  - reference：全部父图作「参考图」（reference_image），仅保持形象/场景一致性，
   *    由模型按提示词重新构图，不会把参考图原样贴成视频第一帧。
   * 分镜一键成片用 reference，避免角色+场景+道具三张参考图被误判成首尾帧。
   */
  videoInputMode?: 'auto' | 'first-frame' | 'frame-to-frame' | 'reference';
  videoModel?: string; // Video model version (e.g., 'veo-3.1', 'kling-v2-1')
  videoDuration?: number; // Video duration in seconds (e.g., 5, 6, 8, 10)
  generateAudio?: boolean; // Whether to generate native audio (Kling 2.6, Veo 3.1)
  inputUrl?: string; // Input URL for video generation (image-to-video)

  // Video Editor specific
  trimStart?: number; // Trim start time in seconds
  trimEnd?: number; // Trim end time in seconds

  // Video Merge specific（视频与视频拼接成片）
  mergeTransition?: string; // 转场 id（fade / dissolve / wipeleft / none …）
  mergeTransitionDuration?: number; // 转场时长（秒）
  mergeAudioMode?: 'keep' | 'tts' | 'mute'; // 音轨策略
  mergeAudioUrl?: string; // TTS 整集配音音频地址（mergeAudioMode='tts' 时生效）
  mergeEpisode?: number; // 所属集号（成片按集归档）
  mergeClipUrls?: string[]; // 参与拼接的片段地址（按顺序，快照用于展示）
  mergeClipDurations?: number[]; // 各片段时长（秒），用于估算成片时长
  mergeResultDuration?: number; // 成片实际时长（秒）
  /** 逐边界转场 id（长度 = 片段数 - 1），来自分镜的 transitionOut，可被用户覆盖 */
  mergeTransitions?: string[];
  /** 逐边界转场时长（长度 = 片段数 - 1） */
  mergeTransitionDurations?: number[];
  /** 分镜 AI 建议的「切入本镜头」转场 id（进入合并节点时作为默认转场） */
  shotTransitionOut?: string;

  // Settings
  model: string;
  imageModel?: string; // Image model version (e.g., 'gemini-pro', 'kling-v2')
  aspectRatio: string;
  resolution: string;
  isPromptExpanded?: boolean; // Whether the prompt editing area is expanded
  resultAspectRatio?: string; // Actual aspect ratio of the generated image (e.g., '16/9')
  generationStartTime?: number; // Timestamp when generation started (for recovery race condition prevention)

  // Kling V1.5 Image Reference Settings
  klingReferenceMode?: 'subject' | 'face'; // Reference type for image-to-image
  klingFaceIntensity?: number; // Face reference intensity (0-100)
  klingSubjectIntensity?: number; // Subject reference intensity (0-100)
  detectedFaces?: { x: number; y: number; width: number; height: number }[]; // Detected face bounding boxes
  faceDetectionStatus?: 'idle' | 'loading' | 'success' | 'error'; // Face detection status

  // Image Editor state persistence
  editorElements?: Array<{
    id: string;
    type: 'arrow' | 'text';
    // Arrow properties
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    color?: string;
    lineWidth?: number;
    // Text properties
    x?: number;
    y?: number;
    text?: string;
    fontSize?: number;
    fontFamily?: string;
  }>; // Elements (arrows, text) drawn in image editor
  editorCanvasData?: string; // Base64 brush/eraser canvas data
  editorCanvasSize?: { width: number; height: number }; // Size of the canvas when elements were saved (for scaling)
  editorBackgroundUrl?: string; // Clean background image URL (without elements) for re-editing

  // Change Angle mode (Image nodes only)
  angleMode?: boolean; // Whether the node is in angle editing mode
  angleSettings?: {
    rotation: number;  // Horizontal rotation in degrees (-180 to 180)
    tilt: number;      // Vertical tilt in degrees (-90 to 90)
    scale: number;     // Scale factor (0 to 100)
    wideAngle: boolean; // Whether to use wide-angle lens perspective
  };

  // Local Model node specific
  localModelId?: string;        // ID of the selected local model
  localModelPath?: string;      // Absolute path to model file on disk
  localModelType?: 'diffusion' | 'controlnet' | 'lora' | 'camera-control';
  localModelArchitecture?: string; // Model architecture (e.g., 'sd15', 'sdxl', 'qwen')

  // Storyboard Generator specific
  characterReferenceUrls?: string[]; // URLs of character images for reference in generation

  // 分镜溯源（由「分镜 → 画布」生成的节点携带，用于回写生成结果）
  shotEpisode?: number; // 该节点来自第几集的分镜
  shotNumber?: number; // 该节点对应第几个分镜
  shotRefFor?: number; // 参考图节点：为第几个分镜提供参考
}

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  type: 'global' | 'node-connector' | 'node-options' | 'add-nodes'; // 'global' = right click on canvas, 'add-nodes' = double click
  sourceNodeId?: string; // If 'node-connector' or 'node-options', which node originated the click
  connectorSide?: 'left' | 'right';
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SelectionBox {
  isActive: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface NodeGroup {
  id: string;
  nodeIds: string[];
  label: string;
  storyContext?: {
    story: string;
    scripts: any[];
    selectedCharacters?: any[]; // CharacterAsset[]
    sceneCount?: number;
    styleAnchor?: string;
    characterDNA?: Record<string, string>;
    compositeImageUrl?: string | null;
  };
}
