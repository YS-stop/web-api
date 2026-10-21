/**
 * db/projectState.js
 *
 * 项目制作过程状态的读写封装（原前端 localStorage）。
 *
 * 存储粒度：
 *   资产确认 / 分镜 / 配音 / 场景合并 → 每个「项目 + 集」一行
 *   镜头历史                          → 每个「项目 + 集 + 镜头」一行
 *   零散 UI 状态                      → 每个「项目 + key」一行
 *   生成任务台账                      → 每个任务一行（kind 区分来源）
 *
 * 对外暴露两种写法：
 *   1. 按集 / 按镜头增量写（推荐，冲突面最小）
 *   2. saveProjectState(整包 patch)：只覆盖传入的分片，用于前端一次性上迁
 *
 * 并发：jsonb 表都带 version。传入 baseVersion 且与库中不一致时抛 StateConflictError，
 * 由路由层转 409 并把服务端当前值一起返回，避免旧实现的「后写覆盖先写」静默丢数据。
 */

import { many, one, exec, transaction } from './index.js';

/** 版本冲突（乐观锁） */
export class StateConflictError extends Error {
    constructor(currentVersion) {
        super(`版本冲突：服务端已是 v${currentVersion}`);
        this.name = 'StateConflictError';
        this.currentVersion = currentVersion;
    }
}

/** 前端传入的 episodeNo 校验（NaN、0、负数一律拒绝） */
function assertEpisode(episodeNo) {
    const n = Number(episodeNo);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`非法的集号: ${episodeNo}`);
    }
    return n;
}

function toIso(value) {
    return value instanceof Date ? value.toISOString() : value || null;
}

/** 数字键统一转字符串，方便前端直接当 Record<number, T> 用 */
function keyOf(value) {
    return String(value);
}

// ============================================================================
// 读
// ============================================================================

/**
 * 读取项目全部制作状态（前端首屏一次拉取）。
 * @returns {Promise<{assets:object, shots:object, history:object, dubbing:object,
 *                    sceneMerges:object, ui:object, jobs:object, updatedAt:string|null}>}
 */
export async function loadProjectState(projectId) {
    const [assetRows, shotRows, historyRows, dubbingRows, mergeRows, uiRows, jobRows] = await Promise.all([
        many('SELECT episode_no, categories, version, updated_at FROM project_asset_states WHERE project_id = $1 ORDER BY episode_no', [projectId]),
        many('SELECT episode_no, shots, version, updated_at FROM project_shots WHERE project_id = $1 ORDER BY episode_no', [projectId]),
        many('SELECT episode_no, shot_no, urls, video_id, video_url, updated_at FROM project_shot_history WHERE project_id = $1 ORDER BY episode_no, shot_no', [projectId]),
        many('SELECT episode_no, payload, version, updated_at FROM project_dubbing WHERE project_id = $1 ORDER BY episode_no', [projectId]),
        many('SELECT episode_no, payload, updated_at FROM project_scene_merges WHERE project_id = $1 ORDER BY episode_no', [projectId]),
        many('SELECT state_key, value, updated_at FROM project_ui_state WHERE project_id = $1 ORDER BY state_key', [projectId]),
        many(
            `SELECT id, kind, episode_no, status, payload, started_at, updated_at
             FROM project_jobs WHERE project_id = $1 ORDER BY started_at DESC NULLS LAST`,
            [projectId],
        ),
    ]);

    const state = {
        assets: {},
        shots: {},
        history: {},
        dubbing: {},
        sceneMerges: {},
        ui: {},
        jobs: { asset: [], 'shot-video': [], 'canvas-video': [] },
        updatedAt: null,
    };

    let latest = null;
    const touch = (value) => {
        const iso = toIso(value);
        if (iso && (!latest || iso > latest)) latest = iso;
    };

    for (const row of assetRows) {
        state.assets[keyOf(row.episode_no)] = { categories: row.categories, version: row.version };
        touch(row.updated_at);
    }
    for (const row of shotRows) {
        state.shots[keyOf(row.episode_no)] = { shots: row.shots, version: row.version };
        touch(row.updated_at);
    }
    for (const row of historyRows) {
        state.history[`${row.episode_no}:${row.shot_no}`] = {
            urls: row.urls || [],
            videoId: row.video_id || null,
            videoUrl: row.video_url || null,
        };
        touch(row.updated_at);
    }
    for (const row of dubbingRows) {
        state.dubbing[keyOf(row.episode_no)] = { payload: row.payload, version: row.version };
        touch(row.updated_at);
    }
    for (const row of mergeRows) {
        state.sceneMerges[keyOf(row.episode_no)] = { payload: row.payload };
        touch(row.updated_at);
    }
    for (const row of uiRows) {
        state.ui[row.state_key] = row.value;
        touch(row.updated_at);
    }
    for (const row of jobRows) {
        const bucket = state.jobs[row.kind] || (state.jobs[row.kind] = []);
        bucket.push({
            id: row.id,
            kind: row.kind,
            episode: row.episode_no,
            status: row.status,
            payload: row.payload,
            startedAt: row.started_at === null ? null : Number(row.started_at),
            updatedAt: toIso(row.updated_at),
        });
        touch(row.updated_at);
    }

    state.updatedAt = latest;
    return state;
}

/** 单集资产确认 */
export async function getAssetState(projectId, episodeNo) {
    const row = await one(
        'SELECT categories, version, updated_at FROM project_asset_states WHERE project_id = $1 AND episode_no = $2',
        [projectId, assertEpisode(episodeNo)],
    );
    return row ? { categories: row.categories, version: row.version, updatedAt: toIso(row.updated_at) } : null;
}

/** 单集分镜 */
export async function getShots(projectId, episodeNo) {
    const row = await one(
        'SELECT shots, version, updated_at FROM project_shots WHERE project_id = $1 AND episode_no = $2',
        [projectId, assertEpisode(episodeNo)],
    );
    return row ? { shots: row.shots, version: row.version, updatedAt: toIso(row.updated_at) } : null;
}

// ============================================================================
// 写（按集 / 按镜头）
// ============================================================================

/**
 * 写入单集资产确认结果。
 * @param {object} categories { characters, scenes, props }
 * @param {number} [baseVersion] 传了则做乐观锁校验
 */
export async function saveAssetState(projectId, episodeNo, categories, baseVersion) {
    const ep = assertEpisode(episodeNo);
    return transaction(async (client) => {
        const current = await client.query(
            'SELECT version FROM project_asset_states WHERE project_id = $1 AND episode_no = $2 FOR UPDATE',
            [projectId, ep],
        );
        const currentVersion = current.rows[0]?.version || 0;
        if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== currentVersion) {
            throw new StateConflictError(currentVersion);
        }
        const result = await client.query(
            `INSERT INTO project_asset_states (project_id, episode_no, categories, version)
             VALUES ($1, $2, $3::jsonb, 1)
             ON CONFLICT (project_id, episode_no) DO UPDATE SET
                categories = EXCLUDED.categories,
                version    = project_asset_states.version + 1,
                updated_at = now()
             RETURNING version, updated_at`,
            [projectId, ep, JSON.stringify(categories || {})],
        );
        return { version: result.rows[0].version, updatedAt: toIso(result.rows[0].updated_at) };
    });
}

/** 写入单集分镜列表 */
export async function saveShots(projectId, episodeNo, shots, baseVersion) {
    const ep = assertEpisode(episodeNo);
    return transaction(async (client) => {
        const current = await client.query(
            'SELECT version FROM project_shots WHERE project_id = $1 AND episode_no = $2 FOR UPDATE',
            [projectId, ep],
        );
        const currentVersion = current.rows[0]?.version || 0;
        if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== currentVersion) {
            throw new StateConflictError(currentVersion);
        }
        const result = await client.query(
            `INSERT INTO project_shots (project_id, episode_no, shots, version)
             VALUES ($1, $2, $3::jsonb, 1)
             ON CONFLICT (project_id, episode_no) DO UPDATE SET
                shots      = EXCLUDED.shots,
                version    = project_shots.version + 1,
                updated_at = now()
             RETURNING version, updated_at`,
            [projectId, ep, JSON.stringify(Array.isArray(shots) ? shots : [])],
        );
        return { version: result.rows[0].version, updatedAt: toIso(result.rows[0].updated_at) };
    });
}

/** 写入单镜头历史与当前结果 */
export async function saveShotHistory(projectId, episodeNo, shotNo, { urls, videoId, videoUrl }) {
    const ep = assertEpisode(episodeNo);
    const shot = Number(shotNo);
    if (!Number.isInteger(shot) || shot <= 0) throw new Error(`非法的镜头号: ${shotNo}`);

    const row = await one(
        `INSERT INTO project_shot_history (project_id, episode_no, shot_no, urls, video_id, video_url)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (project_id, episode_no, shot_no) DO UPDATE SET
            urls       = COALESCE(EXCLUDED.urls, project_shot_history.urls),
            video_id   = COALESCE(EXCLUDED.video_id, project_shot_history.video_id),
            video_url  = COALESCE(EXCLUDED.video_url, project_shot_history.video_url),
            updated_at = now()
         RETURNING urls, video_id, video_url, updated_at`,
        [projectId, ep, shot, urls === undefined ? null : JSON.stringify(urls), videoId || null, videoUrl || null],
    );
    return {
        urls: row.urls || [],
        videoId: row.video_id || null,
        videoUrl: row.video_url || null,
        updatedAt: toIso(row.updated_at),
    };
}

/** 写入单集配音 */
export async function saveDubbing(projectId, episodeNo, payload, baseVersion) {
    const ep = assertEpisode(episodeNo);
    return transaction(async (client) => {
        const current = await client.query(
            'SELECT version FROM project_dubbing WHERE project_id = $1 AND episode_no = $2 FOR UPDATE',
            [projectId, ep],
        );
        const currentVersion = current.rows[0]?.version || 0;
        if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== currentVersion) {
            throw new StateConflictError(currentVersion);
        }
        const result = await client.query(
            `INSERT INTO project_dubbing (project_id, episode_no, payload, version)
             VALUES ($1, $2, $3::jsonb, 1)
             ON CONFLICT (project_id, episode_no) DO UPDATE SET
                payload    = EXCLUDED.payload,
                version    = project_dubbing.version + 1,
                updated_at = now()
             RETURNING version, updated_at`,
            [projectId, ep, JSON.stringify(payload || {})],
        );
        return { version: result.rows[0].version, updatedAt: toIso(result.rows[0].updated_at) };
    });
}

/** 写入单集场景合并结果 */
export async function saveSceneMerge(projectId, episodeNo, payload) {
    const ep = assertEpisode(episodeNo);
    const row = await one(
        `INSERT INTO project_scene_merges (project_id, episode_no, payload)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (project_id, episode_no) DO UPDATE SET
            payload = EXCLUDED.payload, updated_at = now()
         RETURNING updated_at`,
        [projectId, ep, JSON.stringify(payload || {})],
    );
    return { updatedAt: toIso(row.updated_at) };
}

/** 写零散 UI 状态（value 传 null 等于删除该键） */
export async function setUiState(projectId, key, value) {
    if (!key) throw new Error('缺少 state_key');
    if (value === null || value === undefined) {
        await exec('DELETE FROM project_ui_state WHERE project_id = $1 AND state_key = $2', [projectId, key]);
        return { key, value: null };
    }
    await exec(
        `INSERT INTO project_ui_state (project_id, state_key, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (project_id, state_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [projectId, key, JSON.stringify(value)],
    );
    return { key, value };
}

// ============================================================================
// 任务台账
// ============================================================================

/** 台账条数上限（防止 canvas-jobs 无限增长） */
const JOB_KEEP = 200;

export async function listJobs(projectId, kind) {
    const rows = await many(
        `SELECT id, kind, episode_no, status, payload, started_at, updated_at,
                created_by, created_by_name, created_by_role
         FROM project_jobs
         WHERE project_id = $1 AND ($2::text IS NULL OR kind = $2)
         ORDER BY started_at DESC NULLS LAST`,
        [projectId, kind || null],
    );
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        episode: row.episode_no,
        status: row.status,
        payload: row.payload,
        startedAt: row.started_at === null ? null : Number(row.started_at),
        updatedAt: toIso(row.updated_at),
        // 触发人快照：created_by 为空说明是系统任务或 005 之前的历史任务
        createdBy: row.created_by || '',
        createdByName: row.created_by_name || '',
        createdByRole: row.created_by_role || '',
    }));
}

/**
 * 新增或更新一条任务（按 id upsert）。
 *
 * actor 由调用方传入 req.user（后端按 token 认定，不接受前端自报），
 * 只在 INSERT 时写入触发人；ON CONFLICT 刻意不更新 created_by*，
 * 这样「A 发起、B 回来轮询收尾」不会把任务改记到 B 名下。
 */
export async function upsertJob(projectId, job, actor = null) {
    const id = String(job.id || '').trim();
    if (!id) throw new Error('任务缺少 id');
    const kind = job.kind || 'canvas-video';
    const episodeNo = job.episode ? Number(job.episode) : null;
    const startedAt = job.startedAt === undefined || job.startedAt === null ? null : Number(job.startedAt);
    const actorId = String(actor?.id || '');
    const actorName = String(actor?.name || '');
    const actorRole = String(actor?.role || '');

    const row = await one(
        `INSERT INTO project_jobs (
            id, project_id, kind, episode_no, status, payload, started_at,
            created_by, created_by_name, created_by_role
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
            status     = EXCLUDED.status,
            payload    = EXCLUDED.payload,
            started_at = COALESCE(EXCLUDED.started_at, project_jobs.started_at),
            updated_at = now()
         RETURNING id, kind, episode_no, status, payload, started_at, updated_at,
                   created_by, created_by_name, created_by_role`,
        [
            id,
            projectId,
            kind,
            episodeNo,
            job.status || 'running',
            JSON.stringify(job.payload || {}),
            startedAt,
            actorId,
            actorName,
            actorRole,
        ],
    );
    // 顺带裁剪：同一项目同一 kind 只保留最近 JOB_KEEP 条
    await exec(
        `DELETE FROM project_jobs
         WHERE project_id = $1 AND kind = $2 AND id NOT IN (
            SELECT id FROM project_jobs
            WHERE project_id = $1 AND kind = $2
            ORDER BY started_at DESC NULLS LAST, updated_at DESC
            LIMIT $3
         )`,
        [projectId, kind, JOB_KEEP],
    );
    return {
        id: row.id,
        kind: row.kind,
        episode: row.episode_no,
        status: row.status,
        payload: row.payload,
        startedAt: row.started_at === null ? null : Number(row.started_at),
        updatedAt: toIso(row.updated_at),
        createdBy: row.created_by || '',
        createdByName: row.created_by_name || '',
        createdByRole: row.created_by_role || '',
    };
}

export async function deleteJob(projectId, jobId) {
    const result = await exec('DELETE FROM project_jobs WHERE project_id = $1 AND id = $2', [projectId, jobId]);
    return result.rowCount > 0;
}

/** 清理过期任务（毫秒时间戳，给 canvas-jobs 的 30 分钟 TTL 用） */
export async function pruneJobs(projectId, olderThanMs) {
    const cutoff = Number(olderThanMs);
    if (!Number.isFinite(cutoff)) return 0;
    const result = await exec(
        'DELETE FROM project_jobs WHERE project_id = $1 AND started_at IS NOT NULL AND started_at < $2',
        [projectId, cutoff],
    );
    return result.rowCount;
}

// ============================================================================
// 整包写入（前端一次性上迁用）
// ============================================================================

/**
 * 只覆盖 patch 里出现的分片，其余保持不动。
 * 每个数组/对象分片内部语义是「全量替换」，便于前端直接传当前 store。
 *
 * @param {string} projectId
 * @param {{assets?:object, shots?:object, history?:object, dubbing?:object,
 *          sceneMerges?:object, ui?:object, jobs?:object}} patch
 */
export async function saveProjectState(projectId, patch) {
    const summary = { assets: 0, shots: 0, history: 0, dubbing: 0, sceneMerges: 0, ui: 0, jobs: 0 };

    await transaction(async (client) => {
        if (patch.assets) {
            await client.query('DELETE FROM project_asset_states WHERE project_id = $1', [projectId]);
            for (const [episode, value] of Object.entries(patch.assets)) {
                const categories = value?.categories || value || {};
                await client.query(
                    `INSERT INTO project_asset_states (project_id, episode_no, categories, version)
                     VALUES ($1, $2, $3::jsonb, $4)
                     ON CONFLICT (project_id, episode_no) DO UPDATE SET
                        categories = EXCLUDED.categories, version = EXCLUDED.version, updated_at = now()`,
                    [projectId, assertEpisode(episode), JSON.stringify(categories), Number(value?.version) || 1],
                );
                summary.assets += 1;
            }
        }

        if (patch.shots) {
            await client.query('DELETE FROM project_shots WHERE project_id = $1', [projectId]);
            for (const [episode, value] of Object.entries(patch.shots)) {
                const shots = Array.isArray(value) ? value : value?.shots || [];
                await client.query(
                    `INSERT INTO project_shots (project_id, episode_no, shots, version)
                     VALUES ($1, $2, $3::jsonb, $4)
                     ON CONFLICT (project_id, episode_no) DO UPDATE SET
                        shots = EXCLUDED.shots, version = EXCLUDED.version, updated_at = now()`,
                    [projectId, assertEpisode(episode), JSON.stringify(shots), Number(value?.version) || 1],
                );
                summary.shots += 1;
            }
        }

        if (patch.history) {
            await client.query('DELETE FROM project_shot_history WHERE project_id = $1', [projectId]);
            for (const [shotKey, value] of Object.entries(patch.history)) {
                const [episode, shot] = String(shotKey).split(':');
                await client.query(
                    `INSERT INTO project_shot_history (project_id, episode_no, shot_no, urls, video_id, video_url)
                     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
                     ON CONFLICT (project_id, episode_no, shot_no) DO UPDATE SET
                        urls = EXCLUDED.urls, video_id = EXCLUDED.video_id,
                        video_url = EXCLUDED.video_url, updated_at = now()`,
                    [
                        projectId,
                        assertEpisode(episode),
                        Number(shot),
                        JSON.stringify(Array.isArray(value?.urls) ? value.urls : value?.urls || []),
                        value?.videoId || null,
                        value?.videoUrl || null,
                    ],
                );
                summary.history += 1;
            }
        }

        if (patch.dubbing) {
            await client.query('DELETE FROM project_dubbing WHERE project_id = $1', [projectId]);
            for (const [episode, value] of Object.entries(patch.dubbing)) {
                const payload = value?.payload || value || {};
                await client.query(
                    `INSERT INTO project_dubbing (project_id, episode_no, payload, version)
                     VALUES ($1, $2, $3::jsonb, $4)
                     ON CONFLICT (project_id, episode_no) DO UPDATE SET
                        payload = EXCLUDED.payload, version = EXCLUDED.version, updated_at = now()`,
                    [projectId, assertEpisode(episode), JSON.stringify(payload), Number(value?.version) || 1],
                );
                summary.dubbing += 1;
            }
        }

        if (patch.sceneMerges) {
            await client.query('DELETE FROM project_scene_merges WHERE project_id = $1', [projectId]);
            for (const [episode, value] of Object.entries(patch.sceneMerges)) {
                const payload = value?.payload || value || {};
                await client.query(
                    `INSERT INTO project_scene_merges (project_id, episode_no, payload)
                     VALUES ($1, $2, $3::jsonb)
                     ON CONFLICT (project_id, episode_no) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
                    [projectId, assertEpisode(episode), JSON.stringify(payload)],
                );
                summary.sceneMerges += 1;
            }
        }

        if (patch.ui) {
            await client.query('DELETE FROM project_ui_state WHERE project_id = $1', [projectId]);
            for (const [key, value] of Object.entries(patch.ui)) {
                if (value === null || value === undefined) continue;
                await client.query(
                    `INSERT INTO project_ui_state (project_id, state_key, value)
                     VALUES ($1, $2, $3::jsonb)
                     ON CONFLICT (project_id, state_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
                    [projectId, key, JSON.stringify(value)],
                );
                summary.ui += 1;
            }
        }
    });

    // 任务台账单独处理（保留幂等 upsert，不做全删）
    // 注意：这里刻意不传 actor。整包 PUT 用于历史数据上迁，
    // 若是把老任务归到执行迁移的人名下，人员归属就直接错了，
    // 这类任务应保持 created_by 为空（前端显示「未记录」）。
    if (Array.isArray(patch.jobs)) {
        for (const job of patch.jobs) {
            await upsertJob(projectId, job);
            summary.jobs += 1;
        }
    }

    return summary;
}

export default {
    StateConflictError,
    loadProjectState,
    getAssetState,
    getShots,
    saveAssetState,
    saveShots,
    saveShotHistory,
    saveDubbing,
    saveSceneMerge,
    setUiState,
    listJobs,
    upsertJob,
    deleteJob,
    pruneJobs,
    saveProjectState,
};
