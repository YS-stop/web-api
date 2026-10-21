-- ============================================================================
-- 图片生成任务（服务端后台队列）
--
-- 来源：library/image-tasks.json（{taskId: task} 的 map）
-- 用途：图片生成从「前端同步等待」改为「提交即返回 + 服务端后台执行」，
--       任务参数与状态持久化，进程重启后可恢复未完成任务。
--
-- params 存非核心参数（参考图 base64 / Kling 参考设置等），
-- 查询接口必须走 publicTask 剔除，禁止直接 SELECT * 返回前端。
-- ============================================================================

CREATE TABLE IF NOT EXISTS image_tasks (
    task_id      TEXT PRIMARY KEY,
    node_id      TEXT,
    status       TEXT NOT NULL DEFAULT 'running',
    model_id     TEXT NOT NULL DEFAULT '',
    prompt       TEXT NOT NULL DEFAULT '',
    aspect_ratio TEXT NOT NULL DEFAULT '',
    resolution   TEXT NOT NULL DEFAULT '',
    channel      TEXT NOT NULL DEFAULT '',
    params       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_count  INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    result_url   TEXT,
    created_at   BIGINT,      -- 毫秒时间戳（与 video_tasks 一致）
    updated_at   BIGINT,
    finished_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_tasks_node ON image_tasks (node_id);
