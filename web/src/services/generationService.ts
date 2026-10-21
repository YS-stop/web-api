/**
 * generationService.ts
 * 
 * Frontend service layer for AI content generation.
 * Proxies requests to backend API which handles multiple providers:
 * - Image: Gemini Pro, Kling AI
 * - Video: Veo 3.1, Kling AI
 */

export interface GenerateImageParams {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  imageBase64?: string | string[]; // Supports single image or array of images
  imageModel?: string; // Image model version (e.g., 'gemini-pro', 'kling-v2')
  nodeId?: string; // ID of the node initiating generation
  channel?: string; // 模型调用通道：free / project / workflow
  // Kling V1.5 reference settings
  klingReferenceMode?: 'subject' | 'face';
  klingFaceIntensity?: number; // 0-100
  klingSubjectIntensity?: number; // 0-100
}

export interface GenerateVideoParams {
  prompt: string;
  imageBase64?: string; // For Image-to-Video (start frame)
  lastFrameBase64?: string; // For frame-to-frame interpolation (end frame)
  referenceImages?: string[]; // Multi-reference images (Seedance 多参参考图)
  aspectRatio?: string;
  resolution?: string; // Add resolution to params
  duration?: number; // Video duration in seconds (e.g., 5, 6, 8, 10)
  videoModel?: string; // Video model version (e.g., 'veo-3.1', 'kling-v2-1')
  motionReferenceUrl?: string; // For Kling 2.6 motion control
  generateAudio?: boolean; // For Kling 2.6 and Veo 3.1 native audio (default: true)
  nodeId?: string; // ID of the node initiating generation
  channel?: string; // 模型调用通道：free / project / workflow
}

/**
 * 查询一个已提交生成任务的服务端落盘结果。页面刷新或离开后用于恢复结果。
 * status 为 failed 表示服务端任务已明确失败（带 error 原因），调用方应停止轮询并展示失败。
 */
export const getGenerationStatus = async (
  nodeId: string
): Promise<{ status: 'success' | 'pending' | 'failed'; resultUrl?: string; error?: string }> => {
  const response = await fetch(`/api/generation-status/${encodeURIComponent(nodeId)}`);
  if (!response.ok) throw new Error('查询生成状态失败');
  return response.json();
};

// ============================================================================
// ASYNC IMAGE（图片生成：提交 / 轮询分离）
// ============================================================================

export interface SubmitImageTaskResult {
  taskId: string;
  nodeId?: string | null;
  status: string;
}

export type ImageTaskStatus = 'running' | 'succeeded' | 'failed' | 'notfound';

export interface ImageTaskStatusResult {
  status: ImageTaskStatus;
  resultUrl?: string;
  error?: string;
}

/**
 * 提交图片生成任务：只创建任务并立即返回 taskId，不等生成完成。
 * 批量生成时先并发提交全部任务，再统一轮询，避免「一个跑完才提交下一个」。
 */
export const submitImageTask = async (params: GenerateImageParams): Promise<SubmitImageTaskResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30 * 1000);

  try {
    const response = await fetch('/api/generate-image/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

/** 查询一次图片任务状态（由调用方控制轮询节奏）。404 归一到 notfound，便于前端区分「需重新提交」。 */
export const getImageTaskStatus = async (taskId: string): Promise<ImageTaskStatusResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30 * 1000);

  try {
    const response = await fetch(`/api/generate-image/status/${encodeURIComponent(taskId)}`, {
      signal: controller.signal
    });

    if (response.status === 404) {
      return { status: 'notfound' };
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Generates an image by calling the backend API
 */
export const generateImage = async (params: GenerateImageParams): Promise<string> => {
  try {
    const response = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    const data = await response.json();
    if (!data.resultUrl) {
      throw new Error("No image data returned from server");
    }
    return data.resultUrl;

  } catch (error) {
    console.error("Image Generation Error:", error);
    throw error;
  }
};

/**
 * Generates a video by calling the backend API
 */
export const generateVideo = async (params: GenerateVideoParams): Promise<string> => {
  // 后端 Seedance 轮询默认最多 10 分钟（600s），前端留 60s 余量，超时给明确提示
  const timeoutMs = 11 * 60 * 1000; // 11 分钟
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('/api/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    const data = await response.json();
    if (!data.resultUrl) {
      throw new Error("No video data returned from server");
    }
    return data.resultUrl;

  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      const msg = '视频生成超时（超过 11 分钟未完成），请稍后重试或更换模型';
      console.error("Video Generation Error:", msg);
      throw new Error(msg);
    }
    console.error("Video Generation Error:", error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

// ============================================================================
// SEEDANCE ASYNC VIDEO（提交 / 轮询分离）
// ============================================================================

export interface SubmitVideoTaskResult {
  taskId: string;
  nodeId?: string | null;
}

export interface VideoTaskStatusResult {
  status: 'running' | 'succeeded' | 'failed';
  resultUrl?: string;
  error?: string;
  rawStatus?: string;
}

/**
 * 提交 Seedance 视频任务：只创建任务并立即返回 taskId，不等生成完成。
 * 批量生成时先并发提交全部任务，再统一轮询，避免「一个跑完才提交下一个」。
 */
export const submitVideoTask = async (params: GenerateVideoParams): Promise<SubmitVideoTaskResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120 * 1000); // 与后端 createTask 的 120s 对齐

  try {
    const response = await fetch('/api/generate-video/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

/** 查询一次 Seedance 任务状态（由调用方控制轮询节奏）。 */
export const getVideoTaskStatus = async (taskId: string): Promise<VideoTaskStatusResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30 * 1000);

  try {
    const response = await fetch(`/api/generate-video/status/${encodeURIComponent(taskId)}`, {
      signal: controller.signal
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || response.statusText);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
};
