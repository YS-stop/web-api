# 数据库文档（前端 + 后端）

本文档描述 Video Workflow 系统的全部持久化数据结构。

系统**不使用关系型数据库**，采用「JSON 文件 + 目录」的轻量存储：
- **后端**：数据落在 `library/` 目录下的 JSON 文件（路径可通过环境变量 `LIBRARY_DIR` 覆盖）
- **前端**：制作过程中的中间态落在浏览器 `localStorage`

> 约定
> - 时间字段统一为 ISO 8601 字符串，例如 `2026-10-19T08:02:16.695Z`
> - 主键 `id` 多为 `crypto.randomUUID()`
> - 标记 `?` 的字段为可选（可能不存在）

---

## 一、存储总览

### 1.1 后端文件存储

| 逻辑表 | 物理路径 | 类型 | 说明 |
|---|---|---|---|
| 用户 | `library/users.json` | 数组 | 飞书登录自动建号 |
| 公司配置 | `library/company.json` | 对象 | 锁定首个登录企业的 `tenantKey` |
| 项目 | `library/projects.json` | 数组 | 含剧本分集与资产分析结果 |
| 变更申请 | `library/change-requests.json` | 数组 | 项目字段修改审批流 |
| 自由画布工作流 | `library/workflows/{workflowId}.json` | 对象 | 一文件一工作流 |
| 项目分集画布 | `library/project-workflows/{projectId}_ep{集号}.json` | 对象 | 一文件一集 |
| 聊天会话 | `library/chats/{sessionId}.json` | 对象 | 一文件一会话 |
| 图片元数据 | `library/images/{id}.json` | 对象 | 与图片文件同 id |
| 视频元数据 | `library/videos/{id}.json` | 对象 | 与视频文件同 id |
| 素材库索引 | `library/assets/assets.json` | 数组 | 指向 `assets/{category}/` 下文件 |
| 内置公共工作流 | `public/workflows/*.json` | 对象 | 只读模板，随仓库发布 |
| 模型注册表 | `config/model-registry.json` | 对象 | 本地模型架构配置（遗留，代码未引用） |
| 社交发布临时文件 | `library/temp/twitter_upload_{ts}.{png\|mp4}`、`tiktok_upload_{ts}.mp4` | 二进制 | base64 媒体转存，**无清理逻辑** |

### 1.2 后端内存存储（不落盘，进程重启即失效）

| 名称 | 结构 | 用途 | TTL |
|---|---|---|---|
| `seedanceTaskRegistry` | `Map<taskId, SeedanceTask>` | Seedance 异步视频任务 | 30 分钟 |
| `sessionCache` | `Map<sessionId, {messages, topic, createdAt}>` | 聊天会话内存缓存，`getSession` 优先读缓存 | 进程生命周期 |
| `oauthSessions`（Twitter） | `Map<state, {codeVerifier, codeChallenge}>` | OAuth 防 CSRF | 请求级 |
| `authenticatedClients`（Twitter） | `Map<sessionId, {client, expiresAt}>` | 发布会话 | 按 token |
| `oauthSessions`（TikTok） | `Map<state, {createdAt}>` | OAuth 防 CSRF | 请求级 |
| `authenticatedClients`（TikTok） | `Map<sessionId, {accessToken, openId, expiresAt, user}>` | 发布会话 | 按 token |

**`SeedanceTask`（`seedanceTaskRegistry` 的值）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `apiKey` | string | 提交时使用的 API Key |
| `nodeId` | string \| null | 发起生成的节点 id，用于结果落盘时命名元数据 |
| `modelId` | string | 视频模型 id |
| `prompt` | string | 提示词 |
| `aspectRatio` | string | 画幅 |
| `resolution` | string | 分辨率 |
| `createdAt` | number | 提交时间戳（毫秒），用于 TTL 清理 |

### 1.3 前端 localStorage

| Key 模式 | 存储内容 | 写入方 |
|---|---|---|
| `twitcanva_auth_token` | JWT 字符串 | `useAuth` / `projectService` |
| `twitcanva-lang` | `'zh' \| 'en'` | `SettingsPanel` / `i18n` |
| `asset-confirm:{projectId}` | `EpisodeMap` 资产确认结果 | `AssetConfirmPanel` |
| `asset-confirm-jobs:{projectId}` | `AssetGenerationJob[]` | `AssetConfirmPanel` |
| `shot-editor:{projectId}` | `PanelStore` 分镜与视频结果 | `ShotEditorPanel` |
| `shot-editor:active-episode:{projectId}` | 集号字符串 | `ShotEditorPanel` / `WorkflowPage` |
| `dubbing:{projectId}` | `DubbingStore` 配音数据 | `dubbingService` |
| `episode-titles:{projectId}` | `Record<集号, 标题>` | `WorkflowPage` |
| `workflow-step:{projectId}` | 步骤下标字符串 | `WorkflowPage` |
| `project-started:{projectId}` | `'1'` 标记 | `ProjectListPage` / `projectProgress` |
| `tiktok_session_id` | TikTok 发布会话 id | `TikTokPostModal` |
| `twitter_session_id` | Twitter 发布会话 id | `TwitterPostModal` |

---

## 二、后端数据表

### 2.1 用户表 `users.json`

**数组，元素结构：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string(uuid) | 是 | 主键 |
| `feishuOpenId` | string | 是 | 飞书 open_id，登录唯一标识 |
| `feishuUnionId` | string | 否 | 飞书 union_id |
| `tenantKey` | string | 否 | 飞书企业标识，用于校验「仅本公司可登录」 |
| `companyName` | string | 否 | 企业名称 |
| `name` | string | 是 | 姓名（每次登录由飞书同步覆盖） |
| `avatarUrl` | string | 否 | 头像 URL |
| `role` | enum | 是 | `admin` / `project_manager` / `team_leader` / `user` |
| `status` | enum | 是 | `active` / 其他（非 `active` 会被鉴权中间件拒绝） |
| `permissions` | object | 是 | 功能权限开关，见下 |
| `createdAt` | string(ISO) | 是 | 首次登录时间 |
| `lastLoginAt` | string(ISO) | 是 | 最近登录时间 |
| `email` / `mobile` | — | 否 | **历史遗留字段，登录时会被删除**，勿使用 |

**`permissions` 子结构**（全部为 boolean）：

| 键 | 含义 | admin | project_manager | team_leader | user |
|---|---|---|---|---|---|
| `project_manage` | 项目管理 | true | true | false | false |
| `image_generate` | 图片生成 | true | true | true | true |
| `video_generate` | 视频生成 | true | true | true | true |
| `storyboard` | 分镜脚本 | true | true | true | false |
| `social_post` | 社交发布 | true | true | false | false |
| `asset_library` | 素材库 | true | true | true | false |
| `member_manage` | 成员管理 | true | false | false | false |

**索引 / 唯一约束：**
- `id` 唯一
- `feishuOpenId` 唯一（`findUserByOpenId` 依据）
- 数组为空时首个创建者自动为 `admin`

**对外返回**：`sanitizeUser()` 会剥离 `feishuOpenId`、`feishuUnionId`、`tenantKey`、`email`、`mobile`。

---

### 2.2 公司配置 `company.json`

**单对象：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `tenantKey` | string | 已锁定的企业标识；为空表示尚未锁定，由首个登录用户写入 |

---

### 2.3 项目表 `projects.json`

**数组，元素结构：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string(uuid) | 是 | 主键 |
| `code` | string | 是 | 项目编号，格式 `XM-P-{序号}`，序号自动递增 |
| `name` | string | 是 | 项目名称 |
| `category` | string | 否 | 内容类型，见枚举 |
| `department` | string | 否 | 制作部门 |
| `owner` | string | 否 | 项目负责人 |
| `productionMode` | string | 是 | 生产模式，默认 `人工逐节点` |
| `aspectRatio` | string | 是 | 默认画幅，默认 `9:16` |
| `targetDuration` | number | 是 | 单集目标时长（秒），默认 90 |
| `scriptSource` | string | 否 | 剧本来源 |
| `scriptName` | string | 否 | 锁定剧本文件名 |
| `dramaName` | string | 否 | 剧目名 |
| `totalEpisodes` | number | 是 | 总集数 |
| `stage` | string | 是 | 生产阶段初始值 `等待确认拆集`（**实际展示值由前端动态计算**） |
| `doneEpisodes` | number | 是 | 已完成集数初始值 0（同上，前端动态计算） |
| `abnormal` | number \| null | 否 | 异常数初始值 `null`（同上） |
| `status` | string | 是 | 状态初始值 `待启动`（同上） |
| `createdAt` | string(ISO) | 是 | 创建时间 |
| `updatedAt` | string(ISO) | 是 | 更新时间，列表按此倒序 |
| `createdBy` | string | 否 | 创建人 `users.id` |
| `scriptAnalysis` | object \| null | 否 | 剧本分析结果，见 2.3.1 |

**注意：** `GET /api/projects` 列表接口会剔除 `scriptAnalysis`（体积大），仅详情接口返回。

**可编辑字段白名单**（`EDITABLE_FIELDS`，直接编辑与申请修改共用）：
`name`、`category`、`department`、`owner`、`productionMode`、`aspectRatio`、`targetDuration`、`scriptSource`、`scriptName`、`dramaName`、`totalEpisodes`

#### 2.3.1 `scriptAnalysis` 子结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `totalEpisodes` | number | 总集数 |
| `episodes` | array | 分集列表，见下 |
| `assets` | object | 全局去重资产 `{characters, scenes, props}` |

**`episodes[]`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `episode` | number | 集号 |
| `title` | string | 集标题 |
| `summary` | string | 剧情概要 |
| `wordCount` | number | 字数 |
| `durationSeconds` | number | 预估时长（秒） |
| `content` | string | 该集对应剧本原文片段 |
| `startText` | string | 原文起始片段（**历史字段，前端类型未声明**） |
| `assets` | object | 该集资产 `{characters, scenes, props}` |

**`AssetItem`（资产元素）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 资产名称（同分类下同名视为同一资产） |
| `description` | string | 描述 |
| `imageUrl` | string | 生成的设定图 URL |
| `looks` | `AssetLook[]` | 造型列表 |
| `voiceName` | string | 已配置音色名（角色用） |
| `bio` | string | 人物小传（仅角色，展示用，不进提示词） |
| `visual` | string | 视觉特征（仅角色，唯一进入生图提示词的人物字段） |

**`AssetLook`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 造型 id |
| `name` | string | 造型名，如 `造型 1` |
| `imageUrl` | string | 造型图 URL |

---

### 2.4 变更申请表 `change-requests.json`

**数组，元素结构：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string(uuid) | 是 | 主键 |
| `projectId` | string | 是 | 外键 → `projects.id` |
| `projectCode` | string | 是 | 冗余：项目编号 |
| `projectName` | string | 是 | 冗余：项目名称 |
| `requesterId` | string | 是 | 外键 → `users.id` |
| `requesterName` | string | 是 | 冗余：申请人姓名 |
| `requesterRole` | enum | 是 | 申请人角色，决定谁能审批 |
| `changes` | object | 是 | 期望的新值，键受 `EDITABLE_FIELDS` 限制 |
| `reason` | string | 否 | 申请原因 |
| `status` | enum | 是 | `pending` / `approved` / `rejected` |
| `approverId` | string \| null | 否 | 审批人 `users.id` |
| `approverName` | string \| null | 否 | 审批人姓名 |
| `createdAt` | string(ISO) | 是 | 提交时间 |
| `reviewedAt` | string(ISO) \| null | 否 | 审批时间 |

**状态机：** `pending` →（通过）`approved` /（拒绝）`rejected`，已处理不可重复审批。
**审批通过时**：`changes` 被 `Object.assign` 到对应项目，并刷新项目 `updatedAt`。

**可见性规则：**
- `admin`：全部
- `project_manager`：仅 `requesterRole === 'team_leader'`
- 其他角色：空列表

---

### 2.5 自由画布工作流 `workflows/{id}.json`

**单对象：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 主键，同时是文件名 |
| `title` | string | 工作流标题 |
| `nodes` | `Node[]` | 节点数组，见 2.5.1 |
| `groups` | `NodeGroup[]` | 节点分组，见 2.5.2 |
| `viewport` | object | `{x: number, y: number, zoom: number}` 画布视口 |
| `coverUrl` | string | 封面图 URL（保存时若已存在会保留旧值） |
| `description` | string | 描述（公共工作流模板用） |
| `createdAt` | string(ISO) | 创建时间 |
| `updatedAt` | string(ISO) | 更新时间 |

**注意：** 保存前会对节点执行 `sanitizeWorkflowNodes()`，把 base64 数据转成文件 URL 后再落盘。

#### 2.5.1 `Node`（节点）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 节点 id |
| `type` | enum | 节点类型，见枚举 |
| `title` | string | 自定义标题 |
| `x` / `y` | number | 画布坐标 |
| `prompt` | string | 提示词 |
| `status` | enum | `idle` / `loading` / `success` / `error` |
| `resultUrl` | string | 生成结果 URL |
| `resultAspectRatio` | string | 结果实际画幅，如 `16/9` |
| `errorMessage` | string | 错误信息 |
| `parentIds` | string[] | 上游节点 id（支持多输入） |
| `groupId` | string | 所属分组 id |
| `model` | string | 模型标识 |
| `imageModel` | string | 图片模型版本 |
| `videoModel` | string | 视频模型版本 |
| `aspectRatio` | string | 画幅 |
| `resolution` | string | 分辨率 |
| `generationStartTime` | number | 生成开始时间戳（恢复竞态判断用） |
| `isPromptExpanded` | boolean | 提示词编辑区是否展开 |
| `lastFrame` | string | 视频节点：末帧图（作为下游输入） |
| `inputUrl` | string | 图生视频输入图 URL |
| `textMode` | enum | 文本节点：`menu` / `editing` |
| `linkedVideoNodeId` | string | 文本节点：关联的视频节点 |
| `videoMode` | enum | 视频节点：`standard` / `frame-to-frame` / `motion-control` |
| `videoInputMode` | enum | 视频节点如何解释父图：`auto`（默认，1 张作首帧、2 张以上首尾帧）/ `first-frame`（强制作首帧）/ `frame-to-frame`（首帧+尾帧，第 3 张起忽略）/ `reference`（全部作参考图 `reference_image`，按提示词重新构图；Seedance 2.0 最多 9 张、2.5 最多 30 张） |
| `frameInputs` | `{nodeId, order}[]` | 首尾帧输入，`order` 为 `start` / `end` |
| `videoDuration` | number | 视频时长（秒） |
| `generateAudio` | boolean | 是否生成原生音频 |
| `trimStart` / `trimEnd` | number | 视频编辑节点：裁剪起止（秒） |
| `klingReferenceMode` | enum | `subject` / `face` |
| `klingFaceIntensity` | number | 人脸参考强度 0-100 |
| `klingSubjectIntensity` | number | 主体参考强度 0-100 |
| `detectedFaces` | `{x,y,width,height}[]` | 检测到的人脸框 |
| `faceDetectionStatus` | enum | `idle` / `loading` / `success` / `error` |
| `editorElements` | array | 图片编辑器元素，见下 |
| `editorCanvasData` | string | 画笔/橡皮画布 base64 |
| `editorCanvasSize` | `{width, height}` | 画布尺寸（用于缩放还原） |
| `editorBackgroundUrl` | string | 无标注的干净底图 URL |
| `angleMode` | boolean | 是否处于改角度模式（仅图片节点） |
| `angleSettings` | object | `{rotation, tilt, scale, wideAngle}` |
| `characterReferenceUrls` | string[] | 分镜生成的角色参考图 URL |
| `shotNumber` | number | 分镜溯源：来源镜头号（分镜导入的节点才有） |
| `shotEpisode` | number | 分镜溯源：该节点来自第几集的分镜（用于生成完成后回写分镜） |
| `shotRefFor` | number | 分镜溯源：参考图节点为第几个分镜提供参考图 |
| `shotTransitionOut` | string | 分镜溯源：从上一镜头切入本镜头的转场 id |
| `mergeEpisode` | number | 合并节点 / 分镜节点：所属集号（按集隔离与去重用） |
| `mergeTransition` | string | 合并节点：统一转场 id（`mergeTransitions` 未覆盖时生效） |
| `mergeTransitionDuration` | number | 合并节点：统一转场时长（秒） |
| `mergeTransitions` | string[] | 合并节点：逐边界转场 id，长度 = 片段数 - 1 |
| `mergeTransitionDurations` | number[] | 合并节点：逐边界转场时长（秒） |
| `mergeAudioMode` | enum | 合并节点：`keep` / `tts` / `mute` |
| `mergeAudioUrl` | string | 合并节点：TTS 配音地址（`mergeAudioMode='tts'` 时生效） |
| `mergeClipUrls` | string[] | 合并节点：参与拼接的片段地址快照（按播放顺序） |
| `mergeClipDurations` | number[] | 合并节点：各片段时长（秒），用于估算成片时长 |
| `mergeResultDuration` | number | 合并节点：成片实际时长（秒） |
| `localModelId` | string | 本地模型节点：模型 id（对应 `/api/local-models` 列表项） |
| `localModelPath` | string | 本地模型节点：模型文件绝对路径 |
| `localModelType` | string | 本地模型节点：`diffusion` / `controlnet` / `lora` / `camera-control` |
| `localModelArchitecture` | string | 本地模型节点：模型架构，如 `sd15` / `sdxl` / `qwen` |

**`editorElements[]`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 元素 id |
| `type` | enum | `arrow` / `text` |
| `startX` / `startY` / `endX` / `endY` | number | 箭头起止点 |
| `color` | string | 颜色 |
| `lineWidth` | number | 线宽 |
| `x` / `y` | number | 文本位置 |
| `text` | string | 文本内容 |
| `fontSize` | number | 字号 |
| `fontFamily` | string | 字体 |

**`angleSettings`：**

| 字段 | 类型 | 范围 | 说明 |
|---|---|---|---|
| `rotation` | number | -180 ~ 180 | 水平旋转角度 |
| `tilt` | number | -90 ~ 90 | 垂直俯仰角度 |
| `scale` | number | 0 ~ 100 | 缩放系数 |
| `wideAngle` | boolean | — | 是否广角透视 |

#### 2.5.2 `NodeGroup`（节点分组）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 分组 id |
| `nodeIds` | string[] | 成员节点 id |
| `label` | string | 分组标签 |
| `storyContext` | object | 故事上下文，见下 |

**`storyContext`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `story` | string | 故事文本 |
| `scripts` | any[] | 剧本片段 |
| `selectedCharacters` | any[] | 选中的角色资产 |
| `sceneCount` | number | 场景数 |
| `styleAnchor` | string | 风格锚点 |
| `characterDNA` | `Record<string,string>` | 角色 DNA |
| `compositeImageUrl` | string \| null | 合成图 URL |

> 实际数据核查：`library/workflows/` 与 `public/workflows/` 中现有文件的 `groups` 均为空数组，`storyContext` 尚未在任何文件中出现，上表字段来自前端类型定义 `NodeGroup`。

---

### 2.6 项目分集画布 `project-workflows/{projectId}_ep{集号}.json`

**单对象：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `projectId` | string | 外键 → `projects.id` |
| `episode` | number | 集号 |
| `nodes` | `Node[]` | 结构同 2.5.1 |
| `viewport` | object | `{x, y, zoom}` |
| `createdAt` | string(ISO) | 创建时间 |
| `updatedAt` | string(ISO) | 更新时间 |

**唯一约束：** `(projectId, episode)` 唯一，由文件名保证。
**访问路径：** `GET/POST /api/project-workflows/:projectId/:episode`

---

### 2.7 聊天会话 `chats/{sessionId}.json`

**单对象：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主键，同时是文件名 |
| `scope` | string | 归属域，见下；旧文件缺省按 `free` |
| `topic` | string \| null | 会话主题，未设置时列表展示 `New Chat` |
| `createdAt` | string(ISO) | 创建时间 |
| `updatedAt` | string(ISO) | 更新时间 |
| `messages` | `Message[]` | 消息列表 |

**`Message`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | enum | `user` / `assistant` |
| `content` | string | 消息文本 |
| `media` | array | 媒体附件 `{type, url, base64?}`，仅用户消息 |
| `timestamp` | string(ISO) | 时间戳 |

**`scope` 取值（由前端传入）：**

| 值 | 来源 | 说明 |
|---|---|---|
| `free` | `App.tsx` 自由画布 `<ChatPanel scope="free" />` | 全局聊天 |
| `project-{projectId}` | `ProjectCanvasPage.tsx` | 项目画布聊天，带项目 id 后缀 |

> 后端只做字符串等值过滤，不解析前缀。`useChatAgent` 默认值为 `free`。

**列表接口返回的摘要字段**：`id`、`scope`、`topic`、`createdAt`、`updatedAt`、`messageCount`。

---

### 2.8 图片元数据 `images/{id}.json`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主键，**必须与文件名一致**（删除接口据此定位） |
| `filename` | string | 实际图片文件名，如 `img_1791961799832_ai6vwp5jy.jpg` |
| `prompt` | string | 生成提示词 |
| `model` | string | 图片模型，默认 `gemini-pro`；**素材保存来源无此字段** |
| `createdAt` | string(ISO) | 生成时间 |
| `type` | string | 固定 `images` |

**id 取值规则：** 请求带 `nodeId` 时用 `nodeId`（支持刷新后恢复结果），否则用文件 id。
**唯一约束：** 同一 `nodeId` 重复生成会覆盖同名元数据（后写覆盖）。

**三种写入来源：**

| 来源 | 接口 | `id` 规则 | 文件名前缀 | `model` |
|---|---|---|---|---|
| 图片生成 | `POST /api/generate-image` | `nodeId` 或文件 id | `img_` | 传入的 `imageModel`，默认 `gemini-pro` |
| 素材保存 | `POST /api/assets/images` | `Date.now()` | 纯时间戳 | **无** |
| 分镜合成图 | `POST /api/storyboard/generate-composite` | 无元数据文件 | `storyboard_composite_` | **无元数据** |

> 注意：分镜合成图只写图片文件，**不写 `.json` 元数据**，因此不会出现在历史面板。
> 工作流节点中的 base64 会被 `sanitizeWorkflowNodes()` 转存为文件（前缀 `wf_img_` / `wf_vid_`），同样**不写元数据**。

---

### 2.9 视频元数据 `videos/{id}.json`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 主键，**必须与文件名一致** |
| `filename` | string | 实际视频文件名，如 `vid_1792137736693_aenedkoph.mp4` |
| `prompt` | string | 生成提示词 |
| `model` | string | 视频模型，如 `doubao-seedance-2-0-260128`；裁剪为 `video-editor`，TikTok 导入为 `tiktok-import` |
| `aspectRatio` | string | 画幅，默认 `Auto` |
| `resolution` | string | 分辨率，默认 `Auto` |
| `createdAt` | string(ISO) | 生成时间 |
| `type` | string | 固定 `videos` |
| `sourceUrl` | string | **仅裁剪 / TikTok 导入**：源视频 URL |
| `trimStart` | number | **仅视频裁剪**：裁剪起点（秒） |
| `trimEnd` | number | **仅视频裁剪**：裁剪终点（秒） |
| `author` | string | **仅 TikTok 导入**：原视频作者 |

**五种写入来源（结构不完全一致）：**

| 来源 | 接口 | 特有字段 | `model` 值 |
|---|---|---|---|
| 同步视频生成 | `POST /api/generate-video` | — | 传入的 `videoModel`，默认 `veo-3.1` |
| Seedance 异步完成 | `GET /api/generate-video/status/:taskId` | — | 提交时的 `videoModel` |
| 素材保存 | `POST /api/assets/videos` | — | **无 `model` 字段** |
| 视频裁剪 | `POST /api/trim-video` | `sourceUrl`、`trimStart`、`trimEnd` | `video-editor` |
| TikTok 导入 | `POST /api/tiktok/import` | `sourceUrl`、`author` | `tiktok-import` |

> 注意：`POST /api/assets/videos` 写入的元数据**没有** `model`、`aspectRatio`、`resolution` 三个字段，读取时需容错。

---

### 2.10 素材库索引 `assets/assets.json`

**数组，元素结构：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string(uuid) | 主键 |
| `name` | string | 素材名称（原值，未做文件名清洗） |
| `category` | enum | `Character` / `Scene` / `Item` / `Style` |
| `url` | string | 访问路径 `/library/assets/{category}/{filename}` |
| `type` | enum | `image` / `video` |
| `createdAt` | string(ISO) | 入库时间 |
| `description` | string | 描述（前端读取时若缺失回退为空串） |
| `...meta` | any | 调用方传入的扩展元数据，**展开写入顶层** |

**物理文件：** `library/assets/{category}/{safeName}{ext}`
- `safeName = name` 经 `/[^a-z0-9]/gi` 替换为 `_` 后转小写
- 扩展名由 data URL 的 MIME 决定：`image/png` → `.png`、`image/jpeg` → `.jpg`、`video/mp4` → `.mp4`，默认 `.png`
- 若 `sourceUrl` 是 `/library/...` 本地路径，则直接复制文件并沿用原扩展名

**写入来源：** `POST /api/library`，请求体 `{sourceUrl, name, category, meta?}`
**当前前端调用**（`useAssetHandlers.ts`）只传 `sourceUrl`、`name`、`category`，**不传 `meta`**，因此实际数据无 `meta` 展开字段。

**删除行为：** 同时删除索引项与物理文件（`DELETE /api/library/:id`）。

---

### 2.11 内置公共工作流 `public/workflows/*.json`

随仓库发布的只读模板，结构与 2.5 一致，额外字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 标题，缺失时展示 `Untitled Workflow` |
| `description` | string | 描述，缺失时按节点类型统计自动生成 |
| `coverUrl` | string | 封面 |

**列表接口附加字段**：`nodeCount`（节点数），`id` 取文件名去掉 `.json`。

---

### 2.12 模型注册表 `config/model-registry.json`

**单对象，只读配置（由 `server/routes/local-models.js` 读取，用于识别本地权重架构与默认参数）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | 配置版本，如 `1.0.0` |
| `lastUpdated` | string | 更新日期，如 `2024-01-13` |
| `architectures` | object | 架构字典，键为架构 id |
| `defaultArchitecture` | string | 默认架构，`sd15` |
| `detectionOrder` | string[] | 检测优先级：`flux` → `sdxl` → `svd` → `animatediff` → `sd15` |
| `fileExtensions` | string[] | 可识别权重扩展名：`.safetensors` / `.ckpt` / `.pt` / `.bin` / `.pth` |

**`architectures.{id}` 子结构：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 显示名，如 `Stable Diffusion XL` |
| `pipeline` | string | diffusers 类名 |
| `type` | enum | `image` / `video` |
| `detection.sizeRange` | `[number, number]` | 权重体积区间（字节） |
| `detection.patterns` | string[] | 文件名匹配模式 |
| `defaults` | object | 默认参数（`steps` / `guidance` / `scheduler` / `width` / `height` / `frames` / `fps` / `motionBucketId`） |
| `resolutions` | `Record<画幅, [宽, 高]>` | 各画幅对应分辨率 |
| `supported` | boolean | 是否已支持 |
| `note` | string | 备注（依赖说明） |

**已内置架构**：`sd15`、`sdxl`、`flux`、`animatediff`、`svd`。

> `local-models.js` 通过 `path.join(process.cwd(), 'config', 'model-registry.json')` 读取该文件，
> 按 `detection.sizeRange` / `detection.patterns` 识别权重架构，并把 `defaults`、`resolutions` 下发给前端。

---

### 2.13 社交发布临时目录 `library/temp/`

**无索引、无元数据，纯二进制临时文件：**

| 文件模式 | 产生方 | 内容 |
|---|---|---|
| `twitter_upload_{timestamp}.png` | `services/twitter.js` 上传图片 | base64 解码后的图片 |
| `twitter_upload_{timestamp}.mp4` | `services/twitter.js` 上传视频 | base64 解码后的视频 |
| `tiktok_upload_{timestamp}.mp4` | `services/tiktok-post.js` 上传视频 | base64 解码后的视频 |

**触发条件：** 仅当媒体是 `data:` 开头的 base64 时才转存；若已是 `/library/...` 本地路径则直接复用原文件。

> **重要：** 这三个写入点**没有任何清理逻辑**，`library/temp/` 会持续膨胀，需人工或运维定期清理。

---

## 三、前端 localStorage 结构

### 3.1 `asset-confirm:{projectId}` — 资产确认结果

**`EpisodeMap`：**

```
Record<集号(number), {
  characters: EditableAsset[],
  scenes:     EditableAsset[],
  props:      EditableAsset[]
}>
```

**`EditableAsset`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 跨集稳定 id，格式 `{category}:{name}` |
| `name` | string | 资产名称 |
| `description` | string | 描述 |
| `imageUrl` | string | 主图 URL |
| `looks` | `Look[]` | 造型列表 |
| `voiceName` | string | 音色名（角色用） |
| `bio` | string | 人物小传（仅角色） |
| `visual` | string | 视觉特征（仅角色） |

**`Look`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 造型 id，格式 `{category}:{name}:look{n}` |
| `name` | string | 造型名 |
| `imageUrl` | string | 造型图 URL |

> **设计要点：** 同一分类下同名资产 `id` 相同，因此跨集共享同一张设定图，只生成一次。

### 3.2 `asset-confirm-jobs:{projectId}` — 资产生成任务

`AssetGenerationJob[]`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 任务 id |
| `episode` | number | 集号 |
| `category` | enum | `characters` / `scenes` / `props` |
| `assetId` | string | 目标资产 id |
| `lookId` | string | 目标造型 id（可选） |
| `startedAt` | number | 开始时间戳（毫秒） |

### 3.3 `shot-editor:{projectId}` — 分镜与视频

**`PanelStore`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `shots` | `Record<集号, ShotState[]>` | 每集分镜列表 |
| `history` | `Record<string, string[]>` | 某分镜的历史视频 URL 列表 |
| `videoIds` | `Record<string, string>` | URL → 服务端元数据 id |
| `pendingVideoJobs` | `VideoGenerationJob[]` | 进行中的视频任务 |

**`ShotState` = `ShotItem` + 生成结果：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `shotNumber` | number | 分镜序号 |
| `description` | string | 画面描述 |
| `prompt` | string | AI 视频提示词 |
| `cameraAngle` | string | 景别 |
| `cameraMovement` | string | 运镜 |
| `lighting` | string | 光线 |
| `mood` | string | 情绪氛围 |
| `durationSeconds` | number | 时长，仅 5 / 10 |
| `videoUrl` | string | 已生成视频 URL |
| `imageUrl` | string | 参考图 URL |

**`VideoGenerationJob`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 任务 id |
| `episode` | number | 集号 |
| `shotNumber` | number | 分镜序号 |
| `previousUrl` | string | 生成前的旧视频 URL |
| `taskId` | string | Seedance 异步任务 id（刷新后继续轮询） |
| `startedAt` | number | 开始时间戳 |

### 3.4 `dubbing:{projectId}` — 配音数据

**`DubbingStore` = `Record<集号, EpisodeDubbing>`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `narratorVoice` | string | 旁白音色名 |
| `volume` | number | 音量 0 ~ 1 |
| `speed` | number | 语速 0.5 ~ 2 |
| `lines` | `DubbingLine[]` | 台词列表 |

**`DubbingLine`：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 台词 id |
| `role` | string | 说话角色名，`旁白` 表示旁白 |
| `text` | string | 台词文本 |
| `audioUrl` | string | 合成音频 URL |

### 3.5 其余简单键

| Key | 值类型 | 说明 |
|---|---|---|
| `episode-titles:{projectId}` | `Record<集号, string>` | 用户改写的集标题 |
| `workflow-step:{projectId}` | string(整数) | 当前工作流步骤下标 |
| `shot-editor:active-episode:{projectId}` | string(整数) | 当前选中集号 |
| `project-started:{projectId}` | `'1'` | 是否点过「开始」 |
| `twitcanva_auth_token` | string | JWT |
| `twitcanva-lang` | `'zh' \| 'en'` | 界面语言 |

---

## 四、枚举汇总

| 枚举 | 取值 |
|---|---|
| 用户角色 `role` | `admin` / `project_manager` / `team_leader` / `user` |
| 用户状态 `status` | `active` / 其他（非 active 拒绝访问） |
| 项目状态 `status`（前端计算） | `待启动` / `制作中` / `审核中` / `已完成` |
| 项目阶段 `stage`（前端计算） | `等待确认拆集` / `资产确认` / `视频生成` / `已完成` |
| 变更申请状态 | `pending` / `approved` / `rejected` |
| 节点类型 `NodeType` | `Text` / `Image` / `Video` / `Audio` / `Image Editor` / `Video Editor` / `Video Merge` / `Storyboard Manager` / `Camera Angle` / `Local Image Model`（历史） / `Local Video Model`（历史） |
| 转场 `transition` | `fade` / `fadeblack` / `fadewhite` / `dissolve` / `wipeleft` / `wiperight` / `wipeup` / `wipedown` / `slideleft` / `slideright` / `slideup` / `slidedown` / `circleopen` / `circleclose` / `radial` / `smoothleft` / `smoothright` / `pixelize` / `hblur` / `distance` / `none`（硬切） |
| 音轨策略 `mergeAudioMode` | `keep`（保留原音） / `tts`（配音覆盖） / `mute`（静音） |
| 图片模型 `model`（实测值） | `doubao-seedream-5-0-pro-260628` / `seedream` / `seedream-3.0` / `gemini-pro` |
| 视频模型 `model`（实测值） | `doubao-seedance-2-0-260128` / `doubao-seedance-2-0-mini-260615` / `seedance-2.0` / `veo-3.1` / `video-editor` / `tiktok-import` |
| 节点状态 `NodeStatus` | `idle` / `loading` / `success` / `error` |
| 视频生成模式 `videoMode` | `standard` / `frame-to-frame` / `motion-control` |
| 素材分类 `category` | `Character` / `Scene` / `Item` / `Style` |
| 资产分类（前端） | `characters` / `scenes` / `props` |
| 内容类型 `category`（项目） | `国内真人` / `2D动画` / `2D精致韩漫` / `3D国漫古风` / `3D建模` / `3D皮克斯` / `3D拟真人国内` |
| 聊天域 `scope` | `free` / `project` / `workflow` |
| 聊天角色 | `user` / `assistant` |
| 元数据类型 `type` | `images` / `videos` |

> 说明：`Local Image Model` / `Local Video Model` 已在前端下线，但历史 `workflows/*.json` 中仍可能存在该 `type` 值，读取时需容错。

---

## 五、关联关系

```
users.id ─┬─→ projects.createdBy
          ├─→ change-requests.requesterId / approverId
          └─→ (JWT payload: userId)

projects.id ─┬─→ project-workflows.projectId
             └─→ change-requests.projectId

projects.scriptAnalysis.episodes[].episode
             └─→ project-workflows.episode（同一集）

workflows.id / project-workflows 的 node.id
             └─→ images|videos 的元数据 id（nodeId 复用，用于刷新恢复）

images/{id}.json.filename ─→ /library/images/{filename}
videos/{id}.json.filename ─→ /library/videos/{filename}
assets.json.url            ─→ /library/assets/{category}/{filename}
```

**注意：** JSON 文件存储没有外键约束，删除项目/用户时**不会级联清理**关联数据（`project-workflows`、`change-requests` 会残留）。

---

## 六、字段来源与落地情况核查

下表说明每个字段的**权威来源**，用于排查「类型里有、数据里没有」的问题。

### 6.1 后端 `scriptAnalysis` 资产字段

| 字段 | 由后端生成 | 由前端补齐 | 说明 |
|---|---|---|---|
| `name` | 是 | — | AI 解析产出 |
| `description` | 是 | — | AI 解析产出 |
| `bio` | 是 | — | 仅角色，`drama.js` 提示词要求 AI 输出 |
| `visual` | 是 | — | 仅角色，同上 |
| `imageUrl` | 否 | 是 | 资产确认页生成后写入 localStorage，**不回写后端** |
| `looks` | 否 | 是 | 同上 |
| `voiceName` | 否 | 是 | 同上 |

> 关键结论：`projects.json` 里的 `scriptAnalysis.assets` **只有 `name` / `description` / `bio` / `visual`**，`imageUrl`、`looks`、`voiceName` 仅存在于前端 localStorage 的 `asset-confirm:*`。

### 6.2 `episodes[]` 字段

| 字段 | 实际存在 | 前端类型声明 | 说明 |
|---|---|---|---|
| `episode` / `title` / `summary` / `wordCount` / `durationSeconds` / `content` | 是 | 是 | 正常 |
| `startText` | 是 | **否** | 历史遗留，前端类型 `AnalyzedEpisode` 未声明，读取时被忽略 |
| `assets` | 是 | 是 | 该集资产 |

### 6.3 前端类型有、实际数据暂无的字段

| 表 / 类型 | 字段 | 状态 |
|---|---|---|
| `NodeGroup.storyContext` | 全部子字段 | 现有 `groups` 均为空数组 |
| `NodeData.editorElements` 等图片编辑器字段 | — | 现有工作流无 `Image Editor` 节点 |
| `NodeData.detectedFaces` / `faceDetectionStatus` | — | 现有数据无 Kling 人脸检测记录 |
| `NodeData.characterReferenceUrls` | — | 现有数据无该字段 |
| `NodeData.klingReferenceMode` / 强度字段 | — | 现有数据无该字段 |
| `NodeData.trimStart` / `trimEnd` | — | 现有工作流无 `Video Editor` 节点 |
| `NodeData.textMode` / `linkedVideoNodeId` | — | 现有文本节点未写入 |
| `NodeData.groupId` | — | 现有数据无分组 |
| `NodeData.errorMessage` | — | 仅失败时写入 |
| `NodeData.isPromptExpanded` | — | 现有数据未写入 |
| `NodeData.inputUrl` | — | 现有数据未写入 |
| `NodeData.generateAudio` | — | 现有数据未写入 |
| `NodeData.videoMode` | — | 现有数据未写入 |

### 6.4 实际数据有、文档首版遗漏的字段（已补）

| 表 | 字段 | 来源 |
|---|---|---|
| `workflows` 节点 | `localModelId` / `localModelPath` / `localModelType` / `localModelArchitecture` | 本地模型节点（`NodeType.LOCAL_IMAGE_MODEL` / `LOCAL_VIDEO_MODEL`，配合 `/api/local-models` 使用） |
| `videos` 元数据 | `sourceUrl` / `trimStart` / `trimEnd` | 视频裁剪 |
| `videos` 元数据 | `author` / `sourceUrl` | TikTok 导入 |
| `assets` 索引 | `description` | 前端读取时使用 |
| 内存表 | `SeedanceTask` 全部 7 个字段 | `generation.js` |
| 内存表 | `sessionCache` | `agent/index.js` |
| 配置 | `config/model-registry.json` 全部字段 | 本地模型配置 |

### 6.5 数据维护脚本

两个一次性脚本，手动执行，**不参与运行时**：

| 脚本 | 命令 | 作用 | 操作对象 |
|---|---|---|---|
| `server/fix-metadata-ids.js` | `node server/fix-metadata-ids.js` | 修复 `id` 与文件名不一致的元数据（否则删除接口失效） | `images/*.json`、`videos/*.json` |
| `server/migrate-workflows.js` | `node server/migrate-workflows.js` | 把工作流里的 base64 内联数据转存为文件 URL | `workflows/*.json`，写 `images/`、`videos/` |

> `migrate-workflows.js` 生成的文件前缀为 `wf_img_` / `wf_vid_`，与 `sanitizeWorkflowNodes()` 运行时行为一致。

---

---

## 七、API 请求契约（写入数据的入参）

本节记录**写入型接口的请求体字段**，它们是数据的实际来源。所有接口除 `POST /api/tts/*` 与 `/api/library` 外均需 `Authorization: Bearer <JWT>`。

### 7.1 剧本解析系列（`/api/drama/*`）

统一入参 `AnalyzeScriptParams`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 剧本全文 |
| `title` | string | 否 | 剧本标题 |
| `genre` | string | 否 | 题材 |
| `episodeCount` | number | 否 | 期望集数 |
| `targetDuration` | number | 否 | 单集目标时长（秒） |
| `preSplit` | `{episode, content}[]` | 否 | 前端已切好的分集片段，后端只补标题/概要 |
| `channel` | string | 否 | 模型通道，默认 `workflow` |

| 接口 | 特有入参 | 返回 |
|---|---|---|
| `POST /api/drama/analyze-script` | — | `ScriptAnalysis` |
| `POST /api/drama/split-episodes` | — | `{totalEpisodes, episodes: EpisodeBrief[]}` |
| `POST /api/drama/analyze-assets` | `episodes: EpisodeBrief[]` | `{assets, episodes: EpisodeAssetResult[]}` |
| `POST /api/drama/split-shots` | `episode`、`characters?: string[]`、`style?`、`aspectRatio?`、`targetDuration?` | `{shots: ShotItem[]}` |

**`ShotItem`（分镜，写入 `shot-editor` 的数据源）：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `shotNumber` | number | 分镜序号 |
| `description` | string | 画面描述 |
| `cameraAngle` | string | 景别 |
| `cameraMovement` | string | 运镜 |
| `lighting` | string | 光线 |
| `mood` | string | 情绪氛围 |
| `durationSeconds` | number | 时长 |
| `prompt` | string | AI 提示词 |

### 7.2 项目系列（`/api/projects`）

`POST /api/projects` 与 `PUT /api/projects/:id` 共用 `ProjectEditableFields`（见 2.3 可编辑字段白名单），额外可传 `scriptAnalysis`。

`POST /api/projects/:id/change-requests`：`{changes: ProjectEditableFields, reason: string}`

`PUT /api/projects/change-requests/:id`：`{approve: boolean}`

### 7.3 生成系列（`/api/generate-*`）

| 接口 | 入参 | 落库 |
|---|---|---|
| `POST /api/generate-image` | `prompt`、`imageModel?`、`nodeId?`、`aspectRatio?`、`referenceImages?`、`channel?` | `images/{id}.json` |
| `POST /api/generate-video` | `prompt`、`videoModel?`、`nodeId?`、`aspectRatio?`、`resolution?`、`imageBase64?`、`referenceImages?`、`channel?` | `videos/{id}.json` |
| `POST /api/generate-video/async` | 同上 | 内存 `seedanceTaskRegistry` |
| `POST /api/trim-video` | `videoUrl`、`startTime`、`endTime` | `videos/{id}.json`（含 `trimStart`/`trimEnd`/`sourceUrl`） |

> `channel` 用于多 key 分流，取值 `free` / `project` / `workflow`，不落库。

### 7.3.1 视频拼接系列（`/api/video-merge`）

| 接口 | 入参 | 落库 |
|---|---|---|
| `GET /api/video-merge/presets` | 无 | 无（返回转场预设与音轨模式） |
| `GET /api/video-merge/status` | 无 | 无（ffmpeg/ffprobe 自检） |
| `POST /api/video-merge/merge` | `videos[]`、`transition?`、`transitionDuration?`、`transitions[]?`、`transitionDurations[]?`、`audioMode?`、`audioUrl?`、`episode?`、`prompt?`、`width?`、`height?`、`fps?` | `library/merged/[ep01_]merged_<ts>.mp4` |
| `POST /api/video-merge/shots-to-nodes` | `shots[]`、`episode`、`originX?`、`originY?`、`aspectRatio?`、`includeImages?`、`createMergeNode?`、`existingUrls[]?` | 无（纯转换，返回节点由前端写入画布） |

`POST /api/video-merge/merge` 返回：

| 字段 | 说明 |
|---|---|
| `url` | 成片地址，形如 `/library/merged/xxx.mp4` |
| `duration` | 成片时长（秒） |
| `mode` | 拼接模式：`fast`（全硬切无损） / `xfade`（含转场） / `concat`（兜底） |
| `boundaries[]` | 逐边界转场明细 `{from, to, transition, duration}` |
| `spec` | 输出规格 `{width, height, fps, pixFmt, sampleRate, channels}` |
| `clips[]` | 各片段探测信息 `{index, name, duration, width, height, fps, hasAudio}` |

`POST /api/video-merge/shots-to-nodes` 入参 `shots[]` 元素：

| 字段 | 类型 | 说明 |
|---|---|---|
| `shotNumber` | number | 镜头号，决定节点排列与播放顺序 |
| `description` | string | 分镜描述，写入节点 `prompt` |
| `prompt` | string | 完整提示词（优先使用） |
| `cameraAngle` / `cameraMovement` / `lighting` / `mood` | string | 拼入节点 `prompt` |
| `durationSeconds` | number | 片段时长，写入 `videoDuration` |
| `transitionOut` | string | 从上一镜头切入本镜头的转场，写入合并节点 `mergeTransitions` |
| `videoUrl` | string | 已生成视频地址，有值则建 `Video` 节点 |
| `imageUrl` | string | 仅图片时建 `Image` 节点（`includeImages=false` 时跳过） |

返回：`{success, nodes[], videoCount, imageCount, skipped, mergeNodeId}`。
`mergeNodeId` 仅在视频片段 ≥ 2 且 `createMergeNode=true` 时有值。

### 7.4 素材与工作流

| 接口 | 入参 | 落库 |
|---|---|---|
| `POST /api/library` | `sourceUrl`、`name`、`category`、`meta?` | `assets/assets.json` |
| `POST /api/assets/:type` | `data`（base64）、`prompt?` | `images|videos/{id}.json` |
| `POST /api/workflows` | `{id?, title, nodes, groups?, viewport?, coverUrl?}` | `workflows/{id}.json` |
| `POST /api/project-workflows/:projectId/:episode` | `{nodes, viewport?}` | `project-workflows/{pid}_ep{n}.json` |
| `POST /api/chat` | `sessionId`、`message`、`media?`、`scope`、`model?` | `chats/{id}.json` |

### 7.5 前端关键组件入参

`ShotEditorPanel` props（决定分镜生成行为）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `projectId` | string | 存储键隔离依据 |
| `episodes` | `AnalyzedEpisode[]` | 分集数据 |
| `aspectRatio` | string | 画幅 |
| `targetDuration` | number | 单集目标时长 |
| `genre` | string | 题材 |
| `episodeGate` | `Record<number, boolean>` | 权限阶梯，`false` 表示该集资产未完成、不可生成视频 |

`AssetConfirmPanel` props 中的 `contentType`（string）：内容类型，用于统一画面风格。

---

## 八、一致性约束与注意事项

1. **元数据 id = 文件名**
   `images/{id}.json`、`videos/{id}.json` 的文件名必须与内部 `id` 一致，否则 `GET /api/generation-status/:nodeId` 与删除接口找不到记录。

2. **`nodeId` 复用会覆盖历史**
   同一节点重复生成时，元数据文件名相同，旧记录被覆盖（图片/视频文件本身保留，仅索引丢失）。

3. **项目进度字段是「初始值」**
   `stage` / `doneEpisodes` / `abnormal` / `status` 后端只写初始值，真实展示值由前端 `computeProjectProgress()` 从 localStorage 的 `asset-confirm:*` 与 `shot-editor:*` 推导。**这意味着进度数据只存在于操作者本机浏览器**，换设备不可见。

4. **列表接口裁剪**
   `GET /api/projects` 不返回 `scriptAnalysis`，需要详情接口获取。

5. **演示数据自动清理**
   读取项目时会过滤并删除 `id` 以 `seed-` 开头的历史种子数据。

6. **聊天会话 scope 兼容**
   旧会话文件无 `scope` 字段，统一按 `free` 处理。

7. **本地存储容量**
   `shot-editor` / `asset-confirm` 含大量 URL 与提示词，`saveStore` 采用 `try/catch` 静默失败，超限时不会报错但会丢数据。

8. **并发写入风险**
   所有 JSON 存储均为「读-改-写」全量覆盖，无文件锁。多进程或多请求并发写同一文件时后写覆盖先写。
