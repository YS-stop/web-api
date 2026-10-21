/**
 * db/projectProgress.js
 *
 * 项目进度聚合（服务端计算，供项目列表一次拉取）。
 *
 * 判定口径与前端 projectProgress.ts 完全一致：
 *   - 资产「完成一集」= 该集人物/场景/道具全部已有生成图（imageUrl 或任一造型图）
 *   - 视频「完成一集」= 该集所有片段都有 videoUrl
 *   - 项目「完成」= 视频完成集数达到总集数
 *
 * 全部在 SQL 里对 jsonb 聚合，避免把每个项目的状态整包拉到 Node 再遍历。
 */

import { many } from './index.js';

/** 视频任务超过该时长仍未完成，视为异常（与前端保持一致） */
const ABNORMAL_TIMEOUT_MS = 15 * 60 * 1000;

/** 资产：每集资产数 / 已有图数 */
async function loadAssetStats(projectIds) {
    const rows = await many(
        `WITH base AS (
            SELECT project_id,
                   coalesce(categories->'characters', '[]'::jsonb)
                 || coalesce(categories->'scenes', '[]'::jsonb)
                 || coalesce(categories->'props', '[]'::jsonb) AS items
            FROM project_asset_states
            WHERE project_id = ANY($1::uuid[])
         ), counted AS (
            SELECT project_id,
                   jsonb_array_length(items) AS total,
                   (SELECT count(*) FROM jsonb_array_elements(items) AS item
                     WHERE coalesce(item->>'imageUrl', '') <> ''
                        OR EXISTS (
                            SELECT 1 FROM jsonb_array_elements(coalesce(item->'looks', '[]'::jsonb)) AS look
                            WHERE coalesce(look->>'imageUrl', '') <> ''
                        )
                   ) AS done
            FROM base
         )
         SELECT project_id,
                count(*) FILTER (WHERE total > 0) AS episodes,
                count(*) FILTER (WHERE total > 0 AND done = total) AS done_episodes
         FROM counted
         GROUP BY project_id`,
        [projectIds],
    );
    return new Map(rows.map((row) => [row.project_id, {
        episodes: Number(row.episodes) || 0,
        doneEpisodes: Number(row.done_episodes) || 0,
    }]));
}

/** 分镜：每集片段数 / 已出片数 / 待确认片段数 */
async function loadShotStats(projectIds) {
    const rows = await many(
        `WITH counted AS (
            SELECT project_id,
                   jsonb_array_length(shots) AS total,
                   (SELECT count(*) FROM jsonb_array_elements(shots) AS shot
                     WHERE coalesce(shot->>'videoUrl', '') <> ''
                   ) AS done
            FROM project_shots
            WHERE project_id = ANY($1::uuid[])
         )
         SELECT project_id,
                count(*) FILTER (WHERE total > 0) AS episodes,
                count(*) FILTER (WHERE total > 0 AND done = total) AS done_episodes,
                coalesce(sum(total - done) FILTER (WHERE total > 0), 0) AS pending
         FROM counted
         GROUP BY project_id`,
        [projectIds],
    );
    return new Map(rows.map((row) => [row.project_id, {
        episodes: Number(row.episodes) || 0,
        doneEpisodes: Number(row.done_episodes) || 0,
        pendingConfirm: Number(row.pending) || 0,
    }]));
}

/** 运行中 / 异常的视频任务 */
async function loadJobStats(projectIds, now = Date.now()) {
    const rows = await many(
        `SELECT project_id,
                count(DISTINCT episode_no) FILTER (WHERE episode_no IS NOT NULL) AS running_episodes,
                count(*) FILTER (WHERE started_at IS NOT NULL AND started_at < $2) AS abnormal
         FROM project_jobs
         WHERE project_id = ANY($1::uuid[])
           AND status = 'running'
           AND kind IN ('shot-video', 'canvas-video')
         GROUP BY project_id`,
        [projectIds, now - ABNORMAL_TIMEOUT_MS],
    );
    return new Map(rows.map((row) => [row.project_id, {
        runningEpisodes: Number(row.running_episodes) || 0,
        abnormal: Number(row.abnormal) || 0,
    }]));
}

/** 点过「开始」的项目 */
async function loadStartedFlags(projectIds) {
    const rows = await many(
        `SELECT project_id FROM project_ui_state
         WHERE project_id = ANY($1::uuid[]) AND state_key = 'project-started' AND value IS NOT NULL`,
        [projectIds],
    );
    return new Set(rows.map((row) => row.project_id));
}

/**
 * 批量计算项目进度。
 * @param {{id:string,totalEpisodes:number}[]} projects
 * @returns {Promise<Record<string, object>>} projectId → ProjectProgress
 */
export async function loadProjectProgress(projects) {
    const list = (projects || []).filter((p) => p && p.id);
    if (list.length === 0) return {};

    const ids = list.map((p) => p.id);
    const now = Date.now();
    const [assetStats, shotStats, jobStats, startedFlags] = await Promise.all([
        loadAssetStats(ids),
        loadShotStats(ids),
        loadJobStats(ids, now),
        loadStartedFlags(ids),
    ]);

    const result = {};

    for (const project of list) {
        const assets = assetStats.get(project.id) || { episodes: 0, doneEpisodes: 0 };
        const shots = shotStats.get(project.id) || { episodes: 0, doneEpisodes: 0, pendingConfirm: 0 };
        const jobs = jobStats.get(project.id) || { runningEpisodes: 0, abnormal: 0 };

        const hasAssetData = assets.episodes > 0;
        const hasShotData = shots.episodes > 0;
        const started = hasAssetData || hasShotData || startedFlags.has(project.id);

        const total = Math.max(0, Number(project.totalEpisodes) || 0);
        let stage = '等待确认拆集';
        let status = '待启动';

        if (started) {
            if (!hasShotData) {
                stage = hasAssetData ? '资产确认' : '等待确认拆集';
                status = assets.doneEpisodes > 0 ? '审核中' : '制作中';
            } else if (total > 0 && shots.doneEpisodes >= total) {
                stage = '已完成';
                status = '已完成';
            } else {
                stage = '视频生成';
                status = '制作中';
            }
        }

        result[project.id] = {
            started,
            stage,
            status,
            doneEpisodes: total > 0 ? Math.min(shots.doneEpisodes, total) : shots.doneEpisodes,
            totalEpisodes: total,
            assetDoneEpisodes: assets.doneEpisodes,
            videoDoneEpisodes: shots.doneEpisodes,
            runningEpisodes: jobs.runningEpisodes,
            pendingConfirm: shots.pendingConfirm,
            abnormal: jobs.abnormal,
        };
    }

    return result;
}

export default { loadProjectProgress };
