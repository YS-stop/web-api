/**
 * projectStateService.ts
 *
 * 项目制作过程状态的统一存储层（原 localStorage → 服务端 PostgreSQL）。
 *
 * 设计：
 *   1. 服务端为准：进入工作流/画布页时 `hydrateProjectState()` 一次拉全量，
 *      并把它回填到 localStorage（同 key 同结构），这样现有所有同步读取函数
 *      （loadAssetStore / loadShotStore / loadDubbing / loadEpisodeTitles …）无需改动。
 *   2. localStorage 降级为「同步缓存」：仍是唯一同步可读源，但不再是唯一副本，
 *      换设备/换浏览器时由 hydrate 从数据库恢复。
 *   3. 写入走穿：save* 之后调用 persist*，按集 / 按镜头增量落库（带防抖合并），
 *      失败只记日志，不阻塞 UI；下次 hydrate 会以服务端数据为准。
 *   4. 首次 hydrate 时若服务端为空而本地有数据，自动整体上迁（一次性迁移）。
 */

const TOKEN_KEY = 'twitcanva_auth_token';

// ============================================================================
// 类型
// ============================================================================

export interface EpisodeCategories {
    characters: unknown[];
    scenes: unknown[];
    props: unknown[];
}

export interface ProjectStateBundle {
    assets: Record<string, { categories: EpisodeCategories; version: number }>;
    shots: Record<string, { shots: unknown[]; version: number }>;
    history: Record<string, { urls: string[]; videoId: string | null; videoUrl: string | null }>;
    dubbing: Record<string, { payload: Record<string, unknown>; version: number }>;
    sceneMerges: Record<string, { payload: Record<string, unknown> }>;
    ui: Record<string, unknown>;
    jobs: Record<string, unknown[]>;
    updatedAt: string | null;
}

/** 上迁用的 patch：jobs 这里是扁平的待插入数组，与读取侧的分组结构不同 */
export interface LocalPatch extends Partial<Omit<ProjectStateBundle, 'jobs'>> {
    jobs?: unknown[];
}

const emptyBundle = (): ProjectStateBundle => ({
    assets: {},
    shots: {},
    history: {},
    dubbing: {},
    sceneMerges: {},
    ui: {},
    jobs: { asset: [], 'shot-video': [], 'canvas-video': [] },
    updatedAt: null,
});

// ============================================================================
// 基础
// ============================================================================

function token(): string {
    try {
        return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

function authHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

async function handle<T>(resp: Response): Promise<T> {
    if (!resp.ok) {
        let message = `HTTP ${resp.status}`;
        try {
            const body = await resp.json();
            if (body?.error) message = body.error;
        } catch {
            /* 非 JSON 错误体，保留状态码 */
        }
        throw new Error(message);
    }
    return (await resp.json()) as T;
}

const stateUrl = (projectId: string, suffix = '') => `/api/projects/${projectId}/state${suffix}`;

/** 本地缓存（同步可读） */
const cache = new Map<string, ProjectStateBundle>();
/** 已完成水合的项目（避免重复请求） */
const hydrated = new Set<string>();
/** 进行中的水合 Promise（并发调用共用一次请求） */
const inflight = new Map<string, Promise<ProjectStateBundle>>();

export function isHydrated(projectId: string): boolean {
    return hydrated.has(projectId);
}

/** 同步取缓存（未水合返回 undefined） */
export function getCachedState(projectId: string): ProjectStateBundle | undefined {
    return cache.get(projectId);
}

// ============================================================================
// 读取
// ============================================================================

/** 拉取服务端全量状态（不走缓存） */
export async function fetchProjectState(projectId: string): Promise<ProjectStateBundle> {
    const data = await handle<Partial<ProjectStateBundle>>(
        await fetch(stateUrl(projectId), { headers: authHeaders() }),
    );
    return { ...emptyBundle(), ...data } as ProjectStateBundle;
}

/**
 * 水合：拉服务端状态 → 回填 localStorage → 标记已水合。
 * 若服务端为空且本地有历史数据，则把本地数据上迁。
 */
export async function hydrateProjectState(projectId: string, opts: { force?: boolean } = {}): Promise<ProjectStateBundle> {
    if (!projectId) return emptyBundle();
    if (!opts.force && hydrated.has(projectId)) return cache.get(projectId)!;

    const running = inflight.get(projectId);
    if (running && !opts.force) return running;

    const task = (async () => {
        let bundle = emptyBundle();
        try {
            bundle = await fetchProjectState(projectId);
        } catch (error) {
            // 后端不可用时不阻塞页面，退化为纯本地缓存
            console.warn('[projectState] 拉取服务端状态失败，使用本地缓存:', (error as Error).message);
            const local = cache.get(projectId) || emptyBundle();
            cache.set(projectId, local);
            hydrated.add(projectId);
            return local;
        }

        const serverEmpty = isBundleEmpty(bundle);
        const localPatch = serverEmpty ? collectLocalPatch(projectId) : null;

        if (localPatch && hasPatchContent(localPatch)) {
            // 首次迁移：本地有数据、服务端为空 → 上迁
            try {
                await fetch(stateUrl(projectId), {
                    method: 'PUT',
                    headers: authHeaders(true),
                    body: JSON.stringify(localPatch),
                });
                bundle = await fetchProjectState(projectId);
                console.info('[projectState] 已将本地历史数据上迁到数据库:', projectId);
            } catch (error) {
                console.warn('[projectState] 历史数据上迁失败（下次进入重试）:', (error as Error).message);
            }
        }

        cache.set(projectId, bundle);
        applyBundleToLocalStorage(projectId, bundle);
        hydrated.add(projectId);
        return bundle;
    })();

    inflight.set(projectId, task);
    try {
        return await task;
    } finally {
        inflight.delete(projectId);
    }
}

/** 服务端状态是否为空 */
function isBundleEmpty(bundle: ProjectStateBundle): boolean {
    return (
        Object.keys(bundle.assets).length === 0 &&
        Object.keys(bundle.shots).length === 0 &&
        Object.keys(bundle.history).length === 0 &&
        Object.keys(bundle.dubbing).length === 0 &&
        Object.keys(bundle.sceneMerges).length === 0 &&
        Object.keys(bundle.ui).length === 0 &&
        Object.values(bundle.jobs || {}).every((list) => !list || list.length === 0)
    );
}

function hasPatchContent(patch: LocalPatch): boolean {
    return (
        !!(patch.assets && Object.keys(patch.assets).length) ||
        !!(patch.shots && Object.keys(patch.shots).length) ||
        !!(patch.history && Object.keys(patch.history).length) ||
        !!(patch.dubbing && Object.keys(patch.dubbing).length) ||
        !!(patch.sceneMerges && Object.keys(patch.sceneMerges).length) ||
        !!(patch.ui && Object.keys(patch.ui).length) ||
        !!(patch.jobs && patch.jobs.length)
    );
}

// ============================================================================
// localStorage ⇄ bundle 适配
// ============================================================================

const key = {
    assets: (pid: string) => `asset-confirm:${pid}`,
    assetJobs: (pid: string) => `asset-confirm-jobs:${pid}`,
    shots: (pid: string) => `shot-editor:${pid}`,
    dubbing: (pid: string) => `dubbing:${pid}`,
    titles: (pid: string) => `episode-titles:${pid}`,
    step: (pid: string) => `workflow-step:${pid}`,
    started: (pid: string) => `project-started:${pid}`,
    sceneMerge: (pid: string) => `scene-merge:${pid}`,
};

function readLocal<T>(k: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(k);
        if (!raw) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function writeLocal(k: string, value: unknown): void {
    try {
        localStorage.setItem(k, JSON.stringify(value));
    } catch (error) {
        console.warn(`[projectState] 写入本地缓存失败 ${k}:`, (error as Error).message);
    }
}

/** 读取本地各 key，组成可上迁的 patch */
export function collectLocalPatch(projectId: string): LocalPatch {
    const patch: LocalPatch = {};

    const assetMap = readLocal<Record<string, EpisodeCategories>>(key.assets(projectId), {});
    if (Object.keys(assetMap).length) {
        patch.assets = {};
        for (const [episode, categories] of Object.entries(assetMap)) {
            patch.assets[episode] = { categories, version: 1 };
        }
    }

    const shotStore = readLocal<{
        shots?: Record<string, unknown[]>;
        history?: Record<string, string[]>;
        videoIds?: Record<string, string>;
    }>(key.shots(projectId), {});
    if (shotStore.shots && Object.keys(shotStore.shots).length) {
        patch.shots = {};
        for (const [episode, shots] of Object.entries(shotStore.shots)) {
            patch.shots[episode] = { shots, version: 1 };
        }
    }
    if (shotStore.history && Object.keys(shotStore.history).length) {
        patch.history = {};
        for (const [shotKey, urls] of Object.entries(shotStore.history)) {
            patch.history[shotKey] = { urls, videoId: null, videoUrl: urls?.[0] || null };
        }
    }

    const dubbingStore = readLocal<Record<string, Record<string, unknown>>>(key.dubbing(projectId), {});
    if (Object.keys(dubbingStore).length) {
        patch.dubbing = {};
        for (const [episode, payload] of Object.entries(dubbingStore)) {
            patch.dubbing[episode] = { payload, version: 1 };
        }
    }

    const merges = readLocal<Record<string, Record<string, unknown>>>(key.sceneMerge(projectId), {});
    if (Object.keys(merges).length) {
        patch.sceneMerges = {};
        for (const [episode, payload] of Object.entries(merges)) {
            patch.sceneMerges[episode] = { payload };
        }
    }

    const ui: Record<string, unknown> = {};
    const titles = readLocal<Record<string, string>>(key.titles(projectId), {});
    if (Object.keys(titles).length) ui['episode-titles'] = titles;
    const step = readLocal<number | null>(key.step(projectId), null);
    if (step !== null && step !== undefined) ui['workflow-step'] = step;
    const started = localStorage.getItem(key.started(projectId));
    if (started) ui['project-started'] = started;
    if (Object.keys(ui).length) patch.ui = ui;

    const jobs: unknown[] = [];
    const assetJobs = readLocal<unknown[]>(key.assetJobs(projectId), []);
    for (const job of assetJobs) jobs.push({ ...(job as object), kind: 'asset' });
    if (jobs.length) patch.jobs = jobs;

    return patch;
}

/** 把服务端 bundle 回填到 localStorage，供既有同步读取函数使用 */
export function applyBundleToLocalStorage(projectId: string, bundle: ProjectStateBundle): void {
    // 资产确认
    const assetMap: Record<string, EpisodeCategories> = {};
    for (const [episode, value] of Object.entries(bundle.assets || {})) {
        assetMap[episode] = value.categories || { characters: [], scenes: [], props: [] };
    }
    if (Object.keys(assetMap).length) writeLocal(key.assets(projectId), assetMap);

    // 分镜 + 历史 + URL→id
    const shots: Record<string, unknown[]> = {};
    for (const [episode, value] of Object.entries(bundle.shots || {})) {
        shots[episode] = value.shots || [];
    }
    const history: Record<string, string[]> = {};
    const videoIds: Record<string, string> = {};
    for (const [shotKey, value] of Object.entries(bundle.history || {})) {
        if (value.urls?.length) history[shotKey] = value.urls;
        if (value.videoUrl && value.videoId) videoIds[value.videoUrl] = value.videoId;
    }
    if (Object.keys(shots).length || Object.keys(history).length) {
        writeLocal(key.shots(projectId), { shots, history, videoIds });
    }

    // 配音
    const dubbing: Record<string, unknown> = {};
    for (const [episode, value] of Object.entries(bundle.dubbing || {})) {
        dubbing[episode] = value.payload || {};
    }
    if (Object.keys(dubbing).length) writeLocal(key.dubbing(projectId), dubbing);

    // 场景合并
    const merges: Record<string, unknown> = {};
    for (const [episode, value] of Object.entries(bundle.sceneMerges || {})) {
        merges[episode] = value.payload || {};
    }
    if (Object.keys(merges).length) writeLocal(key.sceneMerge(projectId), merges);

    // 零散 UI
    const ui = bundle.ui || {};
    if (ui['episode-titles']) writeLocal(key.titles(projectId), ui['episode-titles']);
    if (ui['workflow-step'] !== undefined && ui['workflow-step'] !== null) {
        try {
            localStorage.setItem(key.step(projectId), String(ui['workflow-step']));
        } catch {
            /* 忽略配额错误 */
        }
    }
    if (ui['project-started']) {
        try {
            localStorage.setItem(key.started(projectId), String(ui['project-started']));
        } catch {
            /* 忽略配额错误 */
        }
    }
    for (const [uiKey, value] of Object.entries(ui)) {
        // 自动识别标记：库里的 key 是 shot-canvas-auto:ep<N>，本地是 shot-canvas-auto:<pid>:<N>
        if (uiKey.startsWith('shot-canvas-auto')) {
            const episode = uiKey.split(':')[1]?.replace(/^ep/, '');
            if (!episode) continue;
            try {
                localStorage.setItem(`shot-canvas-auto:${projectId}:${episode}`, String(value));
            } catch {
                /* 忽略配额错误 */
            }
        }
    }

    // 任务台账
    const assetJobs = (bundle.jobs?.asset || []) as Array<Record<string, unknown>>;
    if (assetJobs.length) {
        writeLocal(
            key.assetJobs(projectId),
            assetJobs.map((job) => ({ ...(job.payload as object), id: job.id })),
        );
    }
    const canvasJobs = (bundle.jobs?.['canvas-video'] || []) as Array<Record<string, unknown>>;
    if (canvasJobs.length) {
        writeLocal(
            `canvas-jobs:${projectId}`,
            canvasJobs.map((job) => ({ ...(job.payload as object), startedAt: job.startedAt })),
        );
    }
}

// ============================================================================
// 写入（防抖 + 增量）
// ============================================================================

type PendingFn = () => Promise<void>;
const pending = new Map<string, PendingFn>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 600;

/** 合并同一 key 的多次写入，只保留最后一次 */
function schedule(projectId: string, tag: string, fn: PendingFn): void {
    const merged = `${projectId}|${tag}`;
    pending.set(merged, fn);
    const prev = timers.get(merged);
    if (prev) clearTimeout(prev);
    timers.set(
        merged,
        setTimeout(() => {
            timers.delete(merged);
            const run = pending.get(merged);
            pending.delete(merged);
            if (!run) return;
            run().catch((error) => console.warn('[projectState] 落库失败:', (error as Error).message, merged));
        }, DEBOUNCE_MS),
    );
}

/** 立即冲刷所有待写（离开页面前调用） */
export async function flushProjectState(): Promise<void> {
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [merged, run] of entries) {
        const timer = timers.get(merged);
        if (timer) clearTimeout(timer);
        timers.delete(merged);
        try {
            await run();
        } catch (error) {
            console.warn('[projectState] 冲刷失败:', (error as Error).message);
        }
    }
}

/** 单集资产确认 */
export function persistAssetState(projectId: string, episode: number | string, categories: EpisodeCategories): void {
    schedule(projectId, `assets:${episode}`, async () => {
        await fetch(stateUrl(projectId, `/assets/${episode}`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify({ categories }),
        });
    });
}

/** 单集分镜 */
export function persistShots(projectId: string, episode: number | string, shots: unknown[]): void {
    schedule(projectId, `shots:${episode}`, async () => {
        await fetch(stateUrl(projectId, `/shots/${episode}`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify({ shots }),
        });
    });
}

/** 单镜头视频结果 / 历史 */
export function persistShotHistory(
    projectId: string,
    episode: number,
    shotNumber: number,
    payload: { urls?: string[]; videoId?: string; videoUrl?: string },
): void {
    schedule(projectId, `shot-history:${episode}:${shotNumber}`, async () => {
        await fetch(stateUrl(projectId, `/shots/${episode}/${shotNumber}/history`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify(payload),
        });
    });
}

/** 单集配音 */
export function persistDubbing(projectId: string, episode: number | string, payload: Record<string, unknown>): void {
    schedule(projectId, `dubbing:${episode}`, async () => {
        await fetch(stateUrl(projectId, `/dubbing/${episode}`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify({ payload }),
        });
    });
}

/** 单集场景合并 */
export function persistSceneMerge(projectId: string, episode: number | string, payload: Record<string, unknown>): void {
    schedule(projectId, `scene-merge:${episode}`, async () => {
        await fetch(stateUrl(projectId, `/scene-merges/${episode}`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify({ payload }),
        });
    });
}

/** 零散 UI 状态（episode-titles / workflow-step / project-started / active-episode …） */
export function persistUiState(projectId: string, uiKey: string, value: unknown): void {
    schedule(projectId, `ui:${uiKey}`, async () => {
        await fetch(stateUrl(projectId, `/ui/${encodeURIComponent(uiKey)}`), {
            method: 'PUT',
            headers: authHeaders(true),
            body: JSON.stringify({ value }),
        });
    });
}

/** 任务台账：新增/更新 */
export function persistJob(
    projectId: string,
    job: { id: string; kind: string; episode?: number; status?: string; payload?: unknown; startedAt?: number },
): void {
    schedule(projectId, `job:${job.id}`, async () => {
        await fetch(stateUrl(projectId, '/jobs'), {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ ...job, payload: job.payload || {} }),
        });
    });
}

/** 任务台账：删除 */
export function removePersistedJob(projectId: string, jobId: string): void {
    schedule(projectId, `job:${jobId}`, async () => {
        await fetch(stateUrl(projectId, `/jobs/${encodeURIComponent(jobId)}`), {
            method: 'DELETE',
            headers: authHeaders(true),
        });
    });
}

/**
 * 批量拉取项目进度（服务端对 jsonb 聚合，避免前端逐项读 localStorage）。
 * 失败时返回空对象，调用方退回本地推导。
 */
export async function fetchProjectProgress(): Promise<Record<string, unknown>> {
    try {
        const data = await handle<{ progress?: Record<string, unknown> }>(
            await fetch('/api/projects/progress', { headers: authHeaders() }),
        );
        return data.progress || {};
    } catch (error) {
        console.warn('[projectState] 拉取项目进度失败，回退本地推导:', (error as Error).message);
        return {};
    }
}

/** 项目状态清空（调试/重置用） */
export async function resetProjectState(projectId: string): Promise<void> {
    await fetch(stateUrl(projectId), {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ assets: {}, shots: {}, history: {}, dubbing: {}, sceneMerges: {}, ui: {} }),
    });
    cache.delete(projectId);
    hydrated.delete(projectId);
}

export default {
    isHydrated,
    getCachedState,
    fetchProjectState,
    fetchProjectProgress,
    hydrateProjectState,
    applyBundleToLocalStorage,
    collectLocalPatch,
    persistAssetState,
    persistShots,
    persistShotHistory,
    persistDubbing,
    persistSceneMerge,
    persistUiState,
    persistJob,
    removePersistedJob,
    flushProjectState,
    resetProjectState,
};
