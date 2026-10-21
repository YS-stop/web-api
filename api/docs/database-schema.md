# 数据库文档（PostgreSQL）

本文档描述 Video Workflow 系统当前的持久化结构与读写约定。

> 版本：2026-10-21（迁移版本 `001_p0_init` + `002_project_state`）
> 目标库：`video_workflow` @ `127.0.0.1:5432`（本机 PostgreSQL 18.6）
> 引擎：PostgreSQL 16+（Docker 方案已移除，不再使用容器数据库）

---

## 一、总体设计

系统已从「JSON 文件 + 浏览器 localStorage」完全切换到 PostgreSQL：

| 数据类别 | 存储位置 | 说明 |
|---|---|---|
| 业务结构化数据 | PostgreSQL | 用户、项目、分集、资产、画布、任务、媒体元数据、聊天 |
| 制作过程状态 | PostgreSQL | 资产确认、分镜、镜头历史、配音、场景合并、零散 UI 状态 |
| 媒体文件本体 | 磁盘 `api/library/` | jpg / png / mp4 / mp3，数据库只存文件名与 URL |
| 内置资源与配置 | 磁盘 | 公共画布模板、本地模型注册表 |

设计原则：

1. **id 由应用层生成**（`crypto.randomUUID()`），不使用数据库默认值，导入历史数据时可原样保留 id。
2. **时间字段统一 `timestamptz`**；仅 `video_tasks` 与 `project_jobs.started_at` 沿用毫秒时间戳（前端直接当数字用）。
3. **按「项目 + 集」拆行**，不再整份 JSON 覆盖写，两个人改不同集不会互相覆盖。
4. **jsonb 状态表带 `version`**，写入时自增；客户端可传 `baseVersion` 做乐观锁，冲突返回 409。
5. **删项目即级联清理**：子表外键 `ON DELETE CASCADE`（历史 JSON 时代会残留）。
6. **幂等迁移**：所有建表语句 `IF NOT EXISTS`，可重复执行。

---

## 二、连接与配置

配置在 `api/.env`，按优先级：

```
DATABASE_URL=            # 留空则走后下方离散配置；非空时优先（含占位值/格式非法会自动回退）
PGHOST=localhost
PGPORT=5432
PGDATABASE=video_workflow
PGUSER=postgres
PGPASSWORD=123456
PGSSL=false
PG_POOL_MAX=10
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECTION_TIMEOUT_MS=5000
PG_STATEMENT_TIMEOUT_MS=0
DB_DRIVER=db             # file / db / dual
```

`DB_DRIVER` 语义：

| 值 | 行为 |
|---|---|
| `db` | 全部读写 PostgreSQL（**当前使用**） |
| `dual` | 以 PG 为准写入，同时保留文件副本（过渡用） |
| `file` | 只读写 `library/*.json`（历史模式，**当前不可用**，文件已归档） |

连接池实现：`api/server/db/index.js`

- 惰性创建，只在真正执行 SQL 时连接；`DB_DRIVER=file` 时不连库。
- 自带 `dotenv` 加载 `api/.env`，脚本、`node -e`、服务都能取到配置。
- `DATABASE_URL` 为空 / 含 `CHANGE_ME` / 缺 host / 缺库名时自动回退到 `PG*`，同一份配置只告警一次。
- 对外暴露：`query` / `one` / `many` / `exec` / `transaction` / `healthCheck` / `closePool` / `describeTarget`（脱敏）。

---

## 三、迁移机制

```
api/server/db/
├─ schema.sql                              001_p0_init       P0 业务表（12 张）
├─ migrations/002_project_state.sql        002_project_state 制作过程状态（7 张）
├─ migrate.js                              迁移执行器（多版本、按序、事务）
├─ importLegacy.js                         library/*.json → PG（一次性导入）
├─ mediaAssets.js                          media_assets 读写封装
├─ projectState.js                         制作状态读写 + 乐观锁
└─ projectProgress.js                      项目进度 SQL 聚合
```

命令（在 `api/` 下）：

```bash
npm run db:migrate                 # 执行所有未应用的迁移
node server/db/migrate.js --dry-run  # 只看清单与校验和，不连库
node server/db/migrate.js --to 002   # 只执行到指定版本
node server/db/migrate.js --force    # 忽略已应用记录，重跑全部
npm run db:import                  # 从 library/*.json 导入（数据源需先解压备份）
npm run db:setup                   # migrate + import
```

`schema_migrations` 记录每个版本的 `checksum`：同一版本内容变化会告警而不会自动改表，正确做法是新增 `003_xxx.sql` 并在 `migrate.js` 的 `MIGRATIONS` 数组追加一项。

---

## 四、表清单

当前共 **20 张表**（含 `schema_migrations`），分五组：

| 分组 | 表 | 行数（2026-10-21） |
|---|---|---|
| 账号与企业 | `users`、`company_settings` | 1 / 1 |
| 项目与剧本 | `projects`、`project_episodes`、`project_assets`、`change_requests` | 3 / 10 / 102 / 0 |
| 画布 | `workflows`、`project_workflows` | 0 / 8 |
| 生成与素材 | `video_tasks`、`media_assets`、`library_assets` | 9 / 63 / 0 |
| 制作过程状态 | `project_asset_states`、`project_shots`、`project_shot_history`、`project_dubbing`、`project_scene_merges`、`project_ui_state`、`project_jobs` | 0（新建项目后产生） |
| 系统 | `chat_sessions`、`schema_migrations` | 0 / 2 |

---

## 五、表结构详解

### 5.1 `users` — 用户

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | uuid | PK，应用层生成 |
| `feishu_open_id` | text | NOT NULL，**唯一**（登录依据） |
| `feishu_union_id` | text | NOT NULL default '' |
| `tenant_key` | text | NOT NULL default ''，企业标识 |
| `company_name` | text | NOT NULL default '' |
| `name` / `avatar_url` | text | 姓名每次登录由飞书覆盖 |
| `role` | text | `admin` / `project_manager` / `team_leader` / `user` |
| `status` | text | `active` 才允许登录，其余被鉴权中间件拒绝 |
| `permissions` | jsonb | 7 个功能开关（`project_manage` / `image_generate` / …） |
| `created_at` / `last_login_at` | timestamptz | |

索引：`uq_users_open_id`(unique)、`idx_users_role`、`idx_users_tenant`、`users_pkey`。
读写：`services/userService.js`（首个用户自动成为 admin；对外返回会剥离飞书 id 与 tenant_key）。

### 5.2 `company_settings` — 企业配置（单行表）

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | smallint | PK，`CHECK (id = 1)` |
| `tenant_key` | text | 锁定首个登录企业的 tenantKey |
| `name` | text | 企业名 |
| `updated_at` | timestamptz | default now() |

### 5.3 `projects` — 项目

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `code` | text | `XM-P-{序号}`，自动递增 |
| `name` | text | default `未命名项目` |
| `category` / `department` / `owner` | text | 内容类型 / 部门 / 负责人 |
| `production_mode` | text | 默认 `人工逐节点` |
| `aspect_ratio` | text | 默认 `9:16` |
| `target_duration` | integer | 单集目标时长（秒），默认 90 |
| `script_source` / `script_name` / `drama_name` | text | 剧本来源 / 文件名 / 剧目名 |
| `total_episodes` | integer | 总集数 |
| `stage` / `status` / `done_episodes` / `abnormal` | text / text / integer / jsonb | 初始值字段；真实进度由 `projectProgress.js` 动态计算 |
| `created_by` | text | `users.id`（不设外键，避免用户注销导致项目无法保留） |
| `created_at` / `updated_at` | timestamptz | 列表按 `updated_at DESC` |

索引：`idx_projects_updated`、`idx_projects_status`、`idx_projects_code`。
读写：`services/projectService.js`（`EDITABLE_FIELDS` 白名单与旧版一致）。**列表接口不返回 `scriptAnalysis`**，详情接口才组装分集与资产。

### 5.4 `project_episodes` — 分集（原 `projects[].scriptAnalysis.episodes[]`）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK | identity |
| `project_id` | uuid | FK → projects，CASCADE |
| `episode_no` | integer | 集号，与 project_id 组成唯一键 |
| `title` / `summary` / `content` / `start_text` | text | 标题 / 概要 / 剧本原文 / 原文起始片段（历史字段） |
| `word_count` / `duration_seconds` | integer | 字数 / 预估时长 |
| `assets` | jsonb | 该集资产 `{characters, scenes, props}` |

约束：`uq_project_episode`(unique project_id+episode_no)、`idx_project_episodes_project`。

### 5.5 `project_assets` — 项目全局资产

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK | |
| `project_id` | uuid | FK → projects，CASCADE |
| `kind` | text | `character` / `scene` / `prop` |
| `name` / `description` / `bio` / `visual` | text | 名称 / 描述 / 人物小传 / 视觉特征 |
| `episode_no` | integer | 预留按集资产，当前为空 |
| `sort_order` | integer | 展示顺序 |

索引：`idx_project_assets_project`(project_id, kind, sort_order)。
注意：`imageUrl` / `looks` / `voiceName` **不在本表**，它们属于前端资产确认结果（`project_asset_states`）。

### 5.6 `change_requests` — 变更申请与审批

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `project_id` / `project_code` / `project_name` | text | **不设外键**，历史申请需在项目删除后仍可追溯 |
| `requester_id` / `requester_name` / `requester_role` | text | 申请人信息（冗余，避免联表） |
| `changes` | jsonb | 期望变更字段（受 EDITABLE_FIELDS 限制） |
| `reason` | text | 申请原因 |
| `status` | text | `pending` / `approved` / `rejected` |
| `approver_id` / `approver_name` | text | 可空 |
| `created_at` / `reviewed_at` | timestamptz | |

索引：`idx_change_requests_status`(status, created_at DESC)、`idx_change_requests_project`。
审批通过时在同一事务内 `UPDATE change_requests` 并把 `changes` 应用到 `projects`。

### 5.7 `workflows` — 自由画布工作流

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `title` / `description` | text | |
| `nodes` / `groups` | jsonb | 节点数组 / 分组数组（结构与前端 `Node` / `NodeGroup` 一致） |
| `viewport` | jsonb | `{x, y, zoom}` |
| `cover_url` | text | 保存时若已存在则保留旧值 |
| `node_count` | integer | 冗余计数，列表页免解析 jsonb |
| `user_id` | text | 可空 |
| `created_at` / `updated_at` | timestamptz | |

索引：`idx_workflows_updated`。
读写：`routes/workflows.js`（保存前会执行 `sanitizeWorkflowNodes`，把 base64 转成文件 URL）。

### 5.8 `project_workflows` — 项目分集画布

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | text | **不设外键**（画布可能早于项目清理残留，保留内容优先） |
| `episode_no` | integer | |
| `nodes` / `groups` | jsonb | |
| `viewport` | jsonb | |
| `created_at` / `updated_at` | timestamptz | |

主键：`(project_id, episode_no)`；索引：`idx_project_workflows_project`。
接口：`GET/POST /api/project-workflows/:projectId/:episode`。

### 5.9 `video_tasks` — Seedance 异步任务

| 列 | 类型 | 说明 |
|---|---|---|
| `task_id` | text PK | 厂商任务 id |
| `node_id` | text | 发起节点（索引） |
| `status` | text | `running` / `succeeded` / `failed` |
| `model_id` / `prompt` / `aspect_ratio` / `resolution` / `duration` | text/int | 提交参数 |
| `channel` | text | 渠道分流 |
| `api_key` | text | **内部凭据，任何接口都不许返回** |
| `error_count` / `error` / `result_url` | int / text / text | 连续失败计数、错误信息、结果地址 |
| `created_at` / `updated_at` / `finished_at` | bigint | 毫秒时间戳 |

索引：`idx_video_tasks_status`(status, updated_at DESC)、`idx_video_tasks_node`。
读写：`services/videoTaskRunner.js`（提交→落库→后台轮询→下载落盘→写 `media_assets`→更新状态；进程重启时 `restoreVideoTasks()` 从本表恢复未完成任务）。

### 5.10 `media_assets` — 生成产物元数据

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | 有 `nodeId` 时用 nodeId（前端靠它恢复结果），否则用文件 id |
| `kind` | text | `image` / `video` |
| `filename` | text | 实际文件名 |
| `url` | text | `/library/images|videos/<filename>` |
| `prompt` / `model` | text | 生成提示词与模型 |
| `aspect_ratio` / `resolution` | text | 可空（手动保存素材时没有） |
| `meta` | jsonb | 其余扩展字段（`sourceUrl` / `trimStart` / `trimEnd` / `author` 等） |
| `created_at` | timestamptz | |

索引：`idx_media_assets_kind`(kind, created_at DESC)。
写入方：图片/视频生成、视频裁剪、TikTok 导入、Seedance 异步完成、手动保存素材（统一走 `db/mediaAssets.js` 的 `upsertMediaAsset`）。
读取方：`/api/assets/:type` 列表、`/api/generation-status/:nodeId`（**DB 优先，文件回退**）。
磁盘上**不再生成** `<id>.json` 元数据文件。

### 5.11 `library_assets` — 精选素材库索引

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `name` / `category` / `url` / `type` | text | `Character` / `Scene` / `Item` / `Style`；`image` / `video` |
| `meta` | jsonb | 调用方扩展元数据 |
| `created_at` | timestamptz | |

索引：`idx_library_assets_category`。物理文件仍在 `library/assets/<category>/`，删除索引时会一并删文件。

### 5.12 `chat_sessions` — AI 会话

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | 会话 id |
| `scope` | text | `free` / `project-{id}` 等，后端只做等值过滤 |
| `topic` | text | 未设置时列表展示 `New Chat` |
| `messages` | jsonb | `[{role, content, media?, timestamp}]` |
| `created_at` / `updated_at` | timestamptz | 列表按 updated_at DESC |

索引：`idx_chat_sessions_scope`(scope, updated_at DESC)。
读写：`server/agent/index.js`（内存 `sessionCache` 仅做单进程加速，落库为准；非法 sessionId 仍会被 `resolveInside` 拦截）。

### 5.13 `project_asset_states` — 资产确认（每集一行）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | FK → projects，CASCADE |
| `episode_no` | integer | `CHECK (> 0)` |
| `categories` | jsonb | `{characters: [], scenes: [], props: []}`，元素含 `id/name/imageUrl/looks/voiceName/bio/visual` |
| `version` | integer | 乐观锁，默认 1 |
| `updated_at` | timestamptz | |

主键 `(project_id, episode_no)`。原 localStorage `asset-confirm:<projectId>`。

### 5.14 `project_shots` — 分镜（每集一行）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | FK，CASCADE |
| `episode_no` | integer | `CHECK (> 0)` |
| `shots` | jsonb | `[{shotNumber, description, prompt, cameraAngle, cameraMovement, lighting, mood, durationSeconds, videoUrl?, imageUrl?}]` |
| `version` / `updated_at` | int / timestamptz | |

主键 `(project_id, episode_no)`。原 `shot-editor:<projectId>.shots`。

### 5.15 `project_shot_history` — 单镜头视频结果与历史

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | FK，CASCADE |
| `episode_no` / `shot_no` | integer | 均 `CHECK (> 0)` |
| `urls` | jsonb | 该镜头历史生成过的视频 URL（最新在前） |
| `video_id` | text | URL → `media_assets.id` 映射（原 `videoIds`） |
| `video_url` | text | 当前采用的视频 |
| `updated_at` | timestamptz | |

主键 `(project_id, episode_no, shot_no)`，对应前端的 `shotKey = episode:shotNumber`。

### 5.16 `project_dubbing` — 配音（每集一行）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` / `episode_no` | uuid / int | 主键，FK CASCADE |
| `payload` | jsonb | `{narratorVoice, volume, speed, lines: [{id, role, text, audioUrl}]}` |
| `version` / `updated_at` | int / timestamptz | |

`lines` 整体读写（拆行只会增加往返次数），原 `dubbing:<projectId>`。

### 5.17 `project_scene_merges` — 场景成片合并（每集一行）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` / `episode_no` | uuid / int | 主键，FK CASCADE |
| `payload` | jsonb | `{sceneNo: {url, sources: [片段URL]}}` |
| `updated_at` | timestamptz | |

原 `scene-merge:<projectId>`。

### 5.18 `project_ui_state` — 零散 UI 状态（键值）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | FK，CASCADE |
| `state_key` | text | 键名，见下表 |
| `value` | jsonb | 任意 JSON；为 NULL 视为删除 |
| `updated_at` | timestamptz | |

主键 `(project_id, state_key)`。

| `state_key` | 值 | 来源 |
|---|---|---|
| `episode-titles` | `{"1": "第一集标题"}` | 工作流页集标题编辑 |
| `workflow-step` | 数字（步骤下标） | 工作流页进度记忆 |
| `active-episode` | 数字（集号） | 画布/工作流「当前集」 |
| `project-started` | `"1"` | 点过「开始」的标记 |
| `shot-canvas-auto:ep<N>` | 毫秒时间戳 | 第 N 集「自动识别分镜只做一次」标记 |

### 5.19 `project_jobs` — 生成任务台账

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | 资产任务用 `workflow-asset-*`，画布任务用 `nodeId` |
| `project_id` | uuid | FK，CASCADE |
| `kind` | text | `asset` / `shot-video` / `canvas-video` |
| `episode_no` | integer | 可空 |
| `status` | text | `running` / `succeeded` / `failed` |
| `payload` | jsonb | 任务原始结构（taskId、prompt 摘要、nodeId 等） |
| `started_at` | bigint | 毫秒时间戳（画布任务 30 分钟 TTL、异常判定都靠它） |
| `updated_at` | timestamptz | |

索引：`idx_project_jobs_project`(project_id, kind, status)、`idx_project_jobs_started`。
自动裁剪：同一 `(project_id, kind)` 只保留最近 200 条（`upsertJob` 内执行）。原 `asset-confirm-jobs:<pid>` 与 `canvas-jobs:<pid>`。

### 5.20 `schema_migrations` — 迁移记录

| 列 | 类型 | 说明 |
|---|---|---|
| `version` | text PK | 例如 `001_p0_init` |
| `checksum` | text | 迁移文件 sha256，用于发现「改历史版本」 |
| `applied_at` | timestamptz | 应用时间 |

---

## 六、制作过程状态 API

路由：`api/server/routes/projectState.js`，挂在 `/api/projects`，全部需 `Authorization: Bearer <JWT>`。
`projectId` 必须是 UUID 且项目存在，否则 400/404。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:projectId/state` | 整包：`{assets, shots, history, dubbing, sceneMerges, ui, jobs, updatedAt}` |
| PUT | `/api/projects/:projectId/state` | 整包分片覆盖（只覆盖传入的键），用于历史数据上迁 |
| GET/PUT | `.../state/assets/:episode` | 单集资产确认，PUT 体 `{categories, baseVersion?}` |
| GET/PUT | `.../state/shots/:episode` | 单集分镜，PUT 体 `{shots, baseVersion?}` |
| PUT | `.../state/shots/:episode/:shotNo/history` | 单镜头历史，体 `{urls?, videoId?, videoUrl?}` |
| GET/PUT | `.../state/dubbing/:episode` | 单集配音，体 `{payload, baseVersion?}` |
| PUT | `.../state/scene-merges/:episode` | 单集场景合并，体 `{payload}` |
| PUT/DELETE | `.../state/ui/:key` | 零散 UI 状态，体 `{value}`；value 为 null 等同删除 |
| GET/POST | `.../state/jobs` | 任务台账查询 / upsert |
| DELETE | `.../state/jobs/:jobId` | 删除任务 |

乐观锁：PUT 带 `baseVersion` 且与库中 `version` 不一致时返回
```json
{ "error": "版本冲突：服务端已是 v3", "currentVersion": 3 }
```
客户端应重新拉取后再写，而不是盲目覆盖。

另有批量进度接口（定义在 `routes/projects.js`，必须早于 `/:id`）：

```
GET /api/projects/progress → { progress: { [projectId]: {started, stage, status,
      doneEpisodes, totalEpisodes, assetDoneEpisodes, videoDoneEpisodes,
      runningEpisodes, pendingConfirm, abnormal} } }
```
判定口径：资产全部有图 → 该集资产完成；分镜全部有 `videoUrl` → 该集完成；`project_jobs` 中 `running` 超 15 分钟计为异常。项目状态由这些计数推导，不依赖 `projects.stage/status` 静态字段。

---

## 七、前端的读写方式

前端不再直接依赖 localStorage 作为唯一存储，`web/src/services/projectStateService.ts` 实现三层：

1. **水合**：进入工作流页 / 画布页时 `hydrateProjectState(projectId)` 调 `GET .../state`，把服务端数据按原 key 结构回填 localStorage，因此既有同步读取函数（`loadAssetStore` / `loadShotStore` / `loadDubbing` / `loadEpisodeTitles` …）无需改签名即可拿到数据库数据。
2. **写穿**：各 `save*` 函数先写 localStorage（同步缓存，UI 立即生效），再按集/按镜头防抖 600ms 增量 `PUT` 到服务端；失败只告警，不阻塞操作。
3. **自动上迁**：首次水合时若服务端为空而本地有数据，自动 `PUT` 整包上迁（已执行过，线上当前以数据库为准）。

仍保留在 localStorage 的内容（不属于业务数据）：登录 token `twitcanva_auth_token`、语言偏好 `twitcanva-lang`。

---

## 八、磁盘上保留的文件

数据库不接管二进制与静态资源，以下路径**不能删**：

| 路径 | 内容 | 谁在用 |
|---|---|---|
| `api/library/images/` | 生成的图片（.jpg/.png） | `saveBufferToFile`、导出、前端展示 |
| `api/library/videos/` | 生成的视频（.mp4） | 同上 |
| `api/library/audio/` | TTS 产物 | 配音、成片合成 |
| `api/library/merged/` | 拼接成片 | `/api/video-merge/merge` |
| `api/library/assets/<category>/` | 素材库物理文件 | `/api/library` |
| `api/library/temp/` | 社交发布临时文件（无自动清理，需人工清理） | `services/twitter.js`、`services/tiktok-post.js` |
| `api/public/workflows/*.json` | 内置公共画布模板（含节点 prompt），通过 `GET /api/public-workflows` 扫描目录 | 只读，随代码发布 |
| `api/config/model-registry.json` | 本地模型架构注册表（sd15/sdxl/flux/animatediff/svd） | `routes/local-models.js` |

已废弃（2026-10-21 归档并删除，备份见 `api/library/_legacy-json-backup-20261021.zip`）：

`library/users.json`、`company.json`、`projects.json`、`video-tasks.json`、`project-workflows/*.json`、`assets/assets.json`、`images/*.json`、`videos/*.json`、`chats/*.json`、`workflows/*.json`。

> 因为数据源已归档，`npm run db:import` 需要先解压备份才能再跑。

---

## 九、常用运维命令

```bash
# 结构
npm run db:migrate
node server/db/migrate.js --dry-run

# 数据
npm run db:import          # 从归档的 library/*.json 重新导入（会按项目重建分集/资产）
npm run db:setup           # migrate + import

# 连库排查（本机）
psql -h 127.0.0.1 -p 5432 -U postgres -d video_workflow
```

常用查询：

```sql
-- 各表行数（按大小排序）
SELECT table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int AS rows
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY rows DESC;

-- 某项目已确认资产覆盖情况
SELECT episode_no, jsonb_array_length(categories->'characters') AS chars,
       jsonb_array_length(categories->'scenes') AS scenes
FROM project_asset_states WHERE project_id = '<uuid>' ORDER BY episode_no;

-- 未完成任务
SELECT task_id, node_id, status, error_count, updated_at
FROM video_tasks WHERE status = 'running' ORDER BY updated_at DESC;

-- 卡住的画布任务（超过 30 分钟）
SELECT id, episode_no, started_at FROM project_jobs
WHERE kind = 'canvas-video' AND status = 'running'
  AND started_at < (extract(epoch FROM now()) * 1000 - 1800000);
```

---

## 十、注意事项

1. **`video_tasks.api_key` 是内部凭据**：查询接口必须剔除，禁止 `SELECT *` 直接返回前端（`publicTask()` 已处理）。
2. **`media_assets.id` = 节点 id 时会覆盖历史**：同一节点重复生成只保留最新一条元数据（旧媒体文件仍在磁盘，但索引丢失）。
3. **`project_workflows` / `change_requests` 的 `project_id` 无外键**：这是有意为之，项目删除后画布与审批记录仍可追溯。
4. **`projects.stage` / `status` / `done_episodes` / `abnormal` 只是初始值**，真实进度看 `GET /api/projects/progress`。
5. **`project_jobs` 会持续增长**：按 `(project, kind)` 保留 200 条，`pruneJobs` 可按时间清理，建议运维定期清理 `library/temp/`。
6. **jsonb 表写入必须走 `projectState.js`**，它负责 `version` 自增与冲突检测；直接在路由里拼 SQL 会绕过乐观锁。
7. **禁止把 `DB_DRIVER` 改回 `file`**：历史 JSON 已归档删除，服务会读到空数据（表结构仍在库中）。
8. 所有时间列遵循：结构化业务时间用 `timestamptz`，与前端数值语义绑定的时间戳（任务 `started_at` / `video_tasks.created_at`）用 `bigint` 毫秒。
