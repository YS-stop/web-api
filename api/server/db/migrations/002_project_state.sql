-- ============================================================================
-- TwitCanva 制作过程状态（原前端 localStorage 持久化点）
--
-- 迁移来源（web/src 里的 key → 表）：
--   asset-confirm:<projectId>             → project_asset_states
--   asset-confirm-jobs:<projectId>        → project_jobs (kind='asset')
--   shot-editor:<projectId>.shots         → project_shots
--   shot-editor:<projectId>.history       → project_shot_history
--   shot-editor:<projectId>.pendingVideoJobs → project_jobs (kind='shot-video')
--   canvas-jobs:<projectId>               → project_jobs (kind='canvas-video')
--   dubbing:<projectId>                   → project_dubbing
--   scene-merge:<projectId>               → project_scene_merges
--   episode-titles / workflow-step /
--   active-episode / project-started /
--   shot-canvas-auto:<projectId>:<ep>     → project_ui_state
--
-- 设计取舍：
--   * 按「项目 + 集」拆行（不再一整份 JSON），单集读写只碰一行，
--     也天然支持两个人分别改不同集，不会互相覆盖整份数据。
--   * 所有 jsonb 表带 version：写入时 version+1，客户端可带 baseVersion 做乐观锁，
--     冲突返回 409 而不是静默覆盖（旧实现是 last-write-wins）。
--   * 任务台账统一进 project_jobs，用 kind 区分来源，避免三张结构相似的表。
--   * 全部 ON DELETE CASCADE：删项目自动清干净，不会像 JSON 时代那样残留。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 资产确认结果（每集一份：characters / scenes / props 三个数组）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_asset_states (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    categories JSONB NOT NULL DEFAULT '{"characters":[],"scenes":[],"props":[]}'::jsonb,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, episode_no)
);

-- ---------------------------------------------------------------------------
-- 分镜列表（每集一份 ShotState[]，含 videoUrl / imageUrl）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_shots (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    shots      JSONB NOT NULL DEFAULT '[]'::jsonb,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, episode_no)
);

-- ---------------------------------------------------------------------------
-- 单镜头视频结果与历史版本
--   urls      = 该镜头历史生成过的视频 URL（最新在前）
--   video_id  = URL → 服务端 images/videos 元数据 id（原 videoIds 映射）
--   video_url = 当前采用的视频
-- 唯一键对应前端的 shotKey = `${episode}:${shotNumber}`
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_shot_history (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    shot_no    INTEGER NOT NULL CHECK (shot_no > 0),
    urls       JSONB NOT NULL DEFAULT '[]'::jsonb,
    video_id   TEXT,
    video_url  TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, episode_no, shot_no)
);

-- ---------------------------------------------------------------------------
-- 配音（每集一份：{ narratorVoice, volume, speed, lines[] }）
-- lines 作为整体读写，拆行反而增加 N 次往返，故保留 jsonb。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_dubbing (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, episode_no)
);

-- ---------------------------------------------------------------------------
-- 场景成片合并结果（每集一份）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_scene_merges (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, episode_no)
);

-- ---------------------------------------------------------------------------
-- 项目级零散 UI 状态（键值对）
--   state_key 取值：episode-titles / workflow-step / active-episode /
--                   project-started / shot-canvas-auto:ep<N>
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_ui_state (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    state_key  TEXT NOT NULL,
    value      JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, state_key)
);

-- ---------------------------------------------------------------------------
-- 生成任务台账（资产 / 分镜视频 / 画布视频）
--   kind    = asset | shot-video | canvas-video
--   status  = running | succeeded | failed
--   started_at 沿用毫秒时间戳（前端直接当数字用，canvas-jobs 还靠它做过期判断）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_jobs (
    id         TEXT PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    episode_no INTEGER,
    status     TEXT NOT NULL DEFAULT 'running',
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_jobs_project ON project_jobs (project_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_project_jobs_started ON project_jobs (started_at DESC);
