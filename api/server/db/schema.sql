-- ============================================================================
-- TwitCanva P0 表结构
--
-- 对应改造前 library/*.json 的全部持久化点：
--   company.json                 → company_settings
--   users.json                   → users
--   projects.json                → projects / project_episodes / project_assets
--   change-requests.json         → change_requests
--   workflows/*.json             → workflows
--   project-workflows/*.json     → project_workflows
--   video-tasks.json             → video_tasks
--   images|videos/*.json         → media_assets
--   assets/assets.json           → library_assets
--   chats/*.json                 → chat_sessions
--
-- 约定：
--   * 主键 id 由应用层（crypto.randomUUID）生成，不使用数据库默认值，
--     这样 JSON 导入时可以原样保留原有 id，前端记录不受影响。
--   * 时间字段统一 timestamptz；video_tasks 继续沿用毫秒时间戳（bigint），
--     因为前端直接把它当数字用。
--   * 所有语句幂等（IF NOT EXISTS），可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 迁移记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 公司（原 company.json，单行表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
    id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    tenant_key TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 用户（原 users.json）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             UUID PRIMARY KEY,
    feishu_open_id TEXT NOT NULL,
    feishu_union_id TEXT NOT NULL DEFAULT '',
    tenant_key     TEXT NOT NULL DEFAULT '',
    company_name   TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL DEFAULT '',
    avatar_url     TEXT NOT NULL DEFAULT '',
    role           TEXT NOT NULL DEFAULT 'user',
    status         TEXT NOT NULL DEFAULT 'active',
    permissions    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_open_id ON users (feishu_open_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_key);

-- ---------------------------------------------------------------------------
-- 项目（原 projects.json 的顶层字段，不含 scriptAnalysis）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY,
    code            TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '未命名项目',
    category        TEXT NOT NULL DEFAULT '',
    department      TEXT NOT NULL DEFAULT '',
    owner           TEXT NOT NULL DEFAULT '',
    production_mode TEXT NOT NULL DEFAULT '',
    aspect_ratio    TEXT NOT NULL DEFAULT '9:16',
    target_duration INTEGER NOT NULL DEFAULT 0,
    script_source   TEXT NOT NULL DEFAULT '',
    script_name     TEXT NOT NULL DEFAULT '',
    drama_name      TEXT NOT NULL DEFAULT '',
    total_episodes  INTEGER NOT NULL DEFAULT 0,
    stage           TEXT NOT NULL DEFAULT '',
    done_episodes   INTEGER NOT NULL DEFAULT 0,
    abnormal        JSONB,
    status          TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_projects_code ON projects (code);

-- ---------------------------------------------------------------------------
-- 项目分集（原 projects[].scriptAnalysis.episodes[]）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_episodes (
    id               BIGSERIAL PRIMARY KEY,
    project_id       UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    episode_no       INTEGER NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    summary          TEXT NOT NULL DEFAULT '',
    word_count       INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    start_text       TEXT NOT NULL DEFAULT '',
    content          TEXT NOT NULL DEFAULT '',
    assets           JSONB,
    CONSTRAINT uq_project_episode UNIQUE (project_id, episode_no)
);

CREATE INDEX IF NOT EXISTS idx_project_episodes_project ON project_episodes (project_id, episode_no);

-- ---------------------------------------------------------------------------
-- 项目资产（原 projects[].scriptAnalysis.assets，全局角色/场景/道具）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_assets (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,               -- character / scene / prop
    name        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    bio         TEXT NOT NULL DEFAULT '',
    visual      TEXT NOT NULL DEFAULT '',
    episode_no  INTEGER,                     -- 预留：按集资产
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets (project_id, kind, sort_order);

-- ---------------------------------------------------------------------------
-- 变更申请（原 change-requests.json）
-- project_id 不设外键：历史申请对应的项目可能已被删除，不能因此丢数据。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_requests (
    id             UUID PRIMARY KEY,
    project_id     TEXT NOT NULL DEFAULT '',
    project_code   TEXT NOT NULL DEFAULT '',
    project_name   TEXT NOT NULL DEFAULT '',
    requester_id   TEXT NOT NULL DEFAULT '',
    requester_name TEXT NOT NULL DEFAULT '',
    requester_role TEXT NOT NULL DEFAULT '',
    changes        JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason         TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending',
    approver_id    TEXT,
    approver_name  TEXT,
    created_at     TIMESTAMPTZ,
    reviewed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_requests_project ON change_requests (project_id);

-- ---------------------------------------------------------------------------
-- 自由画布工作流（原 workflows/*.json）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
    id          UUID PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    nodes       JSONB NOT NULL DEFAULT '[]'::jsonb,
    groups      JSONB NOT NULL DEFAULT '[]'::jsonb,
    viewport    JSONB,
    cover_url   TEXT,
    node_count  INTEGER NOT NULL DEFAULT 0,
    user_id     TEXT,
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows (updated_at DESC);

-- ---------------------------------------------------------------------------
-- 项目画布（原 project-workflows/{projectId}_ep{episode}.json）
-- 不设外键：画布可能先于项目清理而残留，保留内容比强一致更重要。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_workflows (
    project_id TEXT NOT NULL,
    episode_no INTEGER NOT NULL,
    nodes      JSONB NOT NULL DEFAULT '[]'::jsonb,
    groups     JSONB NOT NULL DEFAULT '[]'::jsonb,
    viewport   JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    PRIMARY KEY (project_id, episode_no)
);

CREATE INDEX IF NOT EXISTS idx_project_workflows_project ON project_workflows (project_id);

-- ---------------------------------------------------------------------------
-- 视频生成任务（原 video-tasks.json，{taskId: task} 的 map）
-- api_key 属于内部凭据：查询接口必须走 publicTask 剔除，禁止直接 SELECT * 返回前端。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_tasks (
    task_id      TEXT PRIMARY KEY,
    node_id      TEXT,
    status       TEXT NOT NULL DEFAULT '',
    model_id     TEXT NOT NULL DEFAULT '',
    prompt       TEXT NOT NULL DEFAULT '',
    aspect_ratio TEXT NOT NULL DEFAULT '',
    resolution   TEXT NOT NULL DEFAULT '',
    duration     INTEGER NOT NULL DEFAULT 0,
    channel      TEXT NOT NULL DEFAULT '',
    api_key      TEXT NOT NULL DEFAULT '',
    error_count  INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    result_url   TEXT,
    created_at   BIGINT,      -- 毫秒时间戳（沿用原 JSON 语义）
    updated_at   BIGINT,
    finished_at  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_video_tasks_status ON video_tasks (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_tasks_node ON video_tasks (node_id);

-- ---------------------------------------------------------------------------
-- 生成素材元数据（原 images/<id>.json、videos/<id>.json）
-- 媒体文件本身仍存放在 library/images|videos，这里只存元数据与访问 URL。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,              -- image / video
    filename      TEXT NOT NULL DEFAULT '',
    url           TEXT NOT NULL DEFAULT '',
    prompt        TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    aspect_ratio  TEXT,
    resolution    TEXT,
    meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_media_assets_kind ON media_assets (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- 精选素材库（原 assets/assets.json）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS library_assets (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT '',
    url        TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'image',
    meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_library_assets_category ON library_assets (category, created_at DESC);

-- ---------------------------------------------------------------------------
-- AI 会话（原 chats/<sessionId>.json）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL DEFAULT 'free',
    topic      TEXT,
    messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_scope ON chat_sessions (scope, updated_at DESC);
