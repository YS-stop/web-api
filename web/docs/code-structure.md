# 代码分布文档（前端 + 后端）

本文档记录 Video Workflow 系统**每一个目录和文件的职责**，用于快速定位代码、评估改动影响面、避免重复实现。

## 推送地址

| 端 | 本地路径 | 远程地址 | 分支 |
|---|---|---|---|
| **前端** | `.repos/video-web` | `https://codeup.aliyun.com/69256e30dec569489f6ef5a1/AI-Agent/Video-Object/Video-workflow/video-web/Founder-web.git` | `hys` |
| **后端** | `.repos/video-api` | `https://codeup.aliyun.com/69256e30dec569489f6ef5a1/AI-Agent/Video-Object/Video-workflow/video-api/Founder-api.git` | `hys` |

> `video-web` / `Founder-web` → 前端（React + TypeScript + Vite）
> `video-api` / `Founder-api` → 后端（Node.js + Express）

> **维护约定（重要）**
> 新增文件、删除文件、移动文件、或改变文件职责时，**必须同步更新本文档**，并与代码改动放在同一次提交中推送。
> 提交前自检：`docs/code-structure.md` 中的文件清单是否与 `git status` 新增/删除的文件一致。
> 完整的仓库归属与推送流程见 [AGENTS.md](../AGENTS.md)。

---

## 一、整体架构

```
浏览器 (React SPA, :8025)
        │  Vite dev proxy: /api、/library → http://localhost:8024
        ▼
后端 Express (:8024)
        ├── /api/*            业务接口
        ├── /library/*        静态文件（图片/视频/素材）
        └── library/*.json    文件型持久化存储
```

**三层结构：**

| 层 | 前端 | 后端 |
|---|---|---|
| 入口 | `src/index.tsx` → `src/App.tsx` | `server/index.js` |
| 路由/页面 | `App.tsx` 内基于 `location.pathname` 分发 | `server/routes/*.js` |
| 业务服务 | `src/services/*.ts` | `server/services/*.js` |
| 状态/逻辑 | `src/hooks/*.ts` | `server/agent/*`、`server/tools/*` |
| 视图 | `src/components/**` | 无（纯 API） |

---

## 二、前端代码分布（`.repos/video-web`）

### 2.1 仓库根目录

| 文件 | 职责 |
|---|---|
| `package.json` | 依赖与脚本（`dev` / `build` / `preview`） |
| `vite.config.ts` | Vite 配置：端口 `8025`、代理 `/api` 与 `/library` 到 `8024`、`@` 别名、watch 忽略规则 |
| `tsconfig.json` | TypeScript 配置 |
| `index.html` | SPA 挂载点（`#root`） |
| `metadata.json` | 项目元信息 |
| `.env.example` | 环境变量样例 |
| `LICENSE` / `NOTICE` | 开源许可与声明 |
| `docs/video-editor-node.md` | 视频编辑器节点说明 |
| `dist/` | 构建产物，**不入库** |
| `node_modules/` | 依赖，**不入库** |

### 2.2 `src/` 根文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.tsx` | 18 | 应用入口：加载 polyfill、i18n，挂载 `BrowserRouter` + `App` |
| `App.tsx` | 1562 | **总控组件**。基于 `location.pathname` 分发页面，组装画布、节点、连线、全部弹窗与面板 |
| `types.ts` | 177 | 全局类型定义：`NodeData`、`NodeType`、`NodeStatus`、`ContextMenuState` 等 |
| `vite-env.d.ts` | 1 | Vite 类型声明 |

**`App.tsx` 的页面分发规则：**

| 路径 | 渲染组件 |
|---|---|
| `/` | `ProjectListPage` |
| `/users` | `UserManagementPage` |
| `/approvals` | `ApprovalsPage` |
| `/canvas/:projectId` | `ProjectCanvasPage` |
| `/workflow/:projectId` | `WorkflowPage` |
| `/canvas` | 自由画布（App 内联渲染） |

### 2.3 `src/components/` — 页面级组件

| 文件 | 行数 | 职责 |
|---|---|---|
| `ProjectListPage.tsx` | 555 | 项目列表首页，进入画布/工作流 |
| `ProjectCanvasPage.tsx` | 1510 | 项目分集画布页，按集加载 `project-workflows`；含「分镜」Tab（拆分镜、单条/批量一键成片）与 `VIDEO_MERGE` 合并成片 |
| `WorkflowPage.tsx` | 460 | 项目工作流页（4 步引导：基本信息 → 剧本分集 → 资产确认 → 进入画布） |
| `AssetConfirmPanel.tsx` | 1179 | 资产确认页：角色/场景/道具设定图生成、造型管理、音色配置 |
| `ShotPanel.tsx` | 361 | **分镜面板**（画布「分镜」Tab）：分镜列表/详情、AI 或本地拆分镜、参考图匹配、单条与批量一键成片、添加分镜到画布 |
| `ShotEditorPanel.tsx` | 1911 | 分镜编辑器：拆镜、图片/视频生成、配音、字幕、裁剪（数据写入 `shot-editor:<projectId>`，供分镜面板与画布导入读取） |
| `DubbingPanel.tsx` | 514 | 配音面板，调用 TTS 生成语音 |
| `AssetLibraryPanel.tsx` | 248 | 素材库面板，浏览/删除 `library/assets` |
| `AssetDetailDrawer.tsx` | 669 | 素材详情抽屉 |
| `ChatPanel.tsx` | 607 | AI 对话面板，含会话列表与消息流 |
| `ChatMessage.tsx` | 170 | 单条聊天消息渲染（含媒体） |
| `WorkflowPanel.tsx` | 408 | 工作流列表/封面/公开模板面板 |
| `TemplateLibraryPanel.tsx` | 146 | 内置公共工作流模板列表 |
| `HistoryPanel.tsx` | 342 | 图片/视频历史记录（`/api/assets/{type}`） |
| `Toolbar.tsx` | 100 | 画布左侧工具栏 |
| `TopBar.tsx` | 256 | 顶部导航栏（用户、项目名、入口） |
| `ContextMenu.tsx` | 368 | 画布右键菜单 |
| `SettingsPanel.tsx` | 165 | 设置面板（语言等） |
| `StoryInput.tsx` | 162 | 剧本输入框 |
| `LoginPage.tsx` | 52 | 飞书登录页 |
| `UserManagementPage.tsx` | 722 | 用户管理页（角色、权限、状态） |
| `UserManagementModal.tsx` | 113 | 用户管理弹窗（轻量版） |
| `ApprovalsPage.tsx` | 175 | 变更申请审批页 |
| `LazyImage.tsx` | 87 | 懒加载图片组件 |

### 2.4 `src/components/canvas/` — 画布核心

| 文件 | 行数 | 职责 |
|---|---|---|
| `CanvasNode.tsx` | 998 | **节点容器**：渲染、拖拽、选中、状态、连接点；含 `VIDEO_MERGE` 成片节点与本地模型节点 |
| `NodeContent.tsx` | 321 | 节点内容区（按 `NodeType` 渲染图片/视频/文本、本地模型占位） |
| `NodeControls.tsx` | 1415 | 节点控制条（模型、画幅、分辨率、生成按钮、本地模型选择） |
| `ConnectionsLayer.tsx` | 235 | 节点连线渲染层（SVG） |
| `NodeConnectors.tsx` | 48 | 单个节点的连接锚点 |
| `SelectionBoundingBox.tsx` | 412 | 框选与批量操作 |
| `OrbitCameraControl.tsx` | 653 | 3D 环绕相机控制（镜头角度） |
| `ChangeAnglePanel.tsx` | 135 | 镜头角度切换面板 |

### 2.5 `src/components/modals/` — 弹窗

| 文件 | 行数 | 职责 |
|---|---|---|
| `CreateProjectModal.tsx` | 1061 | 创建项目：剧本输入 → 分集 → 资产解析全流程 |
| `ProjectDetailModal.tsx` | 228 | 项目详情 |
| `ChangeRequestModal.tsx` | 141 | 提交字段变更申请 |
| `StoryboardGeneratorModal.tsx` | 827 | 分镜脚本生成器（brainstorm / optimize / generate） |
| `StoryboardVideoModal.tsx` | 470 | 分镜转视频（含图片描述与提示词优化） |
| `ImageEditorModal.tsx` | 790 | 图片编辑器（裁剪、绘制、文字、箭头、AI 局部重绘） |
| `VideoEditorModal.tsx` | 301 | 视频编辑器（裁剪） |
| `VideoMergePanel.tsx` | 574 | 视频合并成片面板（片段排序、逐镜头转场、音轨策略） |
| `ExportVideoModal.tsx` | 205 | 视频导出 |
| `ExpandedMediaModal.tsx` | 205 | 媒体大图/大屏预览 |
| `CreateAssetModal.tsx` | 149 | 新建素材 |
| `TikTokImportModal.tsx` | 253 | TikTok 视频导入 |
| `TikTokPostModal.tsx` | 412 | TikTok 发布 |
| `TwitterPostModal.tsx` | 400 | X/Twitter 发布 |

### 2.6 `src/components/modals/imageEditor/` — 图片编辑器子模块

| 文件 | 行数 | 职责 |
|---|---|---|
| `BottomToolbar.tsx` | 229 | 底部工具栏 |
| `DrawingToolbar.tsx` | 161 | 绘制工具（画笔、形状） |
| `PromptBar.tsx` | 267 | AI 提示词输入条 |
| `imageEditor.types.ts` | 97 | 编辑器类型定义 |

### 2.7 `src/components/icons/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `BrandIcons.tsx` | 57 | 品牌图标（飞书、TikTok、X 等） |

### 2.8 `src/hooks/` — 状态与逻辑

**画布与节点：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `useCanvasNavigation.ts` | 107 | 画布平移/缩放 |
| `useCanvasEffects.ts` | 95 | 画布副作用（尺寸、resize 监听） |
| `useCanvasTitle.ts` | 28 | 画布标题编辑 |
| `useNodeManagement.ts` | 163 | 节点增删改 |
| `useNodeDragging.ts` | 134 | 节点拖拽 |
| `useConnectionDragging.ts` | 264 | 连线拖拽与创建 |
| `useGroupManagement.ts` | 206 | 节点分组 |
| `useSelectionBox.ts` | 147 | 框选 |
| `usePointerHandlers.ts` | 185 | 指针事件统一处理 |
| `useKeyboardShortcuts.ts` | 143 | 快捷键（删除、复制、撤销） |
| `useHistory.ts` | 85 | 撤销/重做栈 |

**生成与资产：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `useGeneration.ts` | 411 | 图片/视频生成调度与轮询；视频节点支持 `videoInputMode='reference'` 参考图模式、本地模型节点生成 |
| `useGenerationRecovery.ts` | 78 | 刷新后恢复进行中的生成任务 |
| `useAssetHandlers.ts` | 277 | 素材保存/删除/入库 |
| `useImageNodeHandlers.ts` | 167 | 图片节点专属操作 |
| `useTextNodeHandlers.ts` | 92 | 文本节点专属操作 |
| `useVideoFrameExtraction.ts` | 58 | 视频抽帧（首/尾帧） |
| `useVideoEditor.ts` | 121 | 视频裁剪 |
| `useVideoMerge.ts` | 317 | 视频合并成片（多父节点片段收集、排序、逐边界转场） |
| `useLocalModelNodeHandlers.ts` | 174 | 本地模型节点操作（模型列表加载、节点属性更新） |
| `useImageEditor.ts` | 115 | 图片编辑器入口 |
| `useFaceDetection.ts` | 90 | 人脸检测（图片编辑器辅助） |

**图片编辑器子 hooks：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `useImageEditorCrop.ts` | 284 | 裁剪 |
| `useImageEditorSelection.ts` | 243 | 选区 |
| `useImageEditorHistory.ts` | 237 | 编辑器撤销栈 |
| `useImageEditorArrows.ts` | 228 | 箭头绘制 |
| `useImageEditorDrawing.ts` | 163 | 自由绘制 |
| `useImageEditorText.ts` | 123 | 文字编辑 |

**面板与业务：**

| 文件 | 行数 | 职责 |
|---|---|---|
| `usePanelState.ts` | 138 | 面板开关与 z-index 管理 |
| `useContextMenu.ts` | 118 | 右键菜单状态 |
| `useContextMenuHandlers.ts` | 119 | 右键菜单动作 |
| `useAuth.ts` | 37 | 登录态（JWT + `/api/auth/me`） |
| `useAutoSave.ts` | 46 | 工作流自动保存 |
| `useWorkflow.ts` | 142 | 工作流读写（`/api/workflows`、`/api/public-workflows`） |
| `useWorkflowTracking.ts` | 76 | 步骤进度记录 |
| `useChatAgent.ts` | 348 | AI 对话（会话列表、消息、媒体） |
| `useStoryboardGenerator.ts` | 436 | 分镜脚本生成流程 |
| `useTikTokImport.ts` | 80 | TikTok 导入流程 |

### 2.9 `src/services/` — 后端接口封装

| 文件 | 行数 | 职责 | 调用接口 |
|---|---|---|---|
| `generationService.ts` | 154 | 图片/视频生成 | `/api/generate-image`、`/api/generate-video`、`/api/generate-video/submit`、`/api/generate-video/status/:id`、`/api/generation-status/:nodeId` |
| `scriptAnalysisService.ts` | 172 | 剧本解析、拆集、资产识别、拆分镜 | `/api/drama/analyze-script`、`/split-episodes`、`/analyze-assets`、`/split-shots` |
| `projectService.ts` | 188 | 项目 CRUD、变更申请 | `/api/projects`、`/api/projects/:id`、`/api/projects/change-requests` |
| `dubbingService.ts` | 258 | 配音（TTS） | `/api/tts`、`/api/tts/status`、`/api/tts/synthesize` |
| `assetService.ts` | 46 | 素材上传保存 | `/api/assets/:type` |
| `cameraAngleService.ts` | 161 | 镜头角度推理 | 本地 Python 服务 |
| `projectProgress.ts` | 144 | 项目进度计算（localStorage 派生） | 无 |
| `stylePresets.ts` | 335 | 画面风格预设常量 | 无 |
| `mergeService.ts` | 243 | 视频拼接成片 | `/api/video-merge/presets`、`/api/video-merge/status`、`/api/video-merge/merge` |
| `shotImportService.ts` | 358 | 分镜片段导入画布（读 localStorage + 后端转换） | `/api/video-merge/shots-to-nodes` |
| `shotService.ts` | 285 | 分镜数据层：读写 `shot-editor:<projectId>`、AI/本地拆分镜、提示词组装、参考图匹配、成片回写 | `/api/drama/split-shots` |
| `shotToCanvasService.ts` | 264 | 分镜 → 画布链路：生成参考图节点 + 视频节点（`videoInputMode='reference'`），支持批量建链 | 无 |
| `localModelService.ts` | 308 | 本地开源模型发现与生成调用 | `/api/local-models`、`/api/local-models/generate` |

### 2.10 `src/constants/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `modelDefaults.ts` | 15 | 画布新建节点的默认模型常量：`DEFAULT_IMAGE_MODEL`（Seedream 5.0 Pro）、`DEFAULT_VIDEO_MODEL`（Seedance 2.0）；集中收口避免各文件硬编码 |

### 2.11 `src/utils/` 与 `src/i18n/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `utils/concurrency.ts` | 52 | 并发限流 |
| `utils/connectionHelpers.ts` | 56 | 连线几何计算 |
| `utils/polyfill.ts` | 17 | 运行时 polyfill |
| `utils/videoHelpers.ts` | 46 | 视频抽帧工具 |
| `i18n/index.ts` | 16 | i18next 初始化 |
| `i18n/locales/zh.ts` | 301 | 中文文案 |
| `i18n/locales/en.ts` | 301 | 英文文案 |

---

## 三、后端代码分布（`.repos/video-api`）

### 3.1 仓库根目录

| 文件/目录 | 职责 |
|---|---|
| `package.json` | 依赖与脚本（`start` / `dev`），`type: module`，Node ≥ 20 |
| `server/index.js` | **应用入口**：Express 装配、静态托管、通用接口、路由挂载、SPA fallback |
| `config/model-registry.json` | 本地模型架构配置（遗留，代码未引用） |
| `public/workflows/*.json` | 内置公共工作流模板（只读） |
| `modal/camera_angle.py` | Modal 平台镜头角度推理部署脚本 |
| `docs/*.md` | 文档 |
| `.env.example` | 环境变量样例 |

### 3.2 `server/index.js` 职责划分

| 区块 | 内容 |
|---|---|
| 静态托管 | `app.use('/library', ...)`：`library/` 目录对外暴露 |
| 素材库 | `POST/GET /api/library`、`DELETE /api/library/:id` |
| 工作流 | `POST /api/workflows`、`GET /api/workflows`、`GET/PUT/DELETE /api/workflows/:id`、`PUT /api/workflows/:id/cover` |
| 公共工作流 | `GET /api/public-workflows`、`GET /api/public-workflows/:id` |
| 项目画布 | `GET/POST /api/project-workflows/:projectId/:episode` |
| Gemini | `POST /api/gemini/describe-image`、`POST /api/gemini/optimize-prompt` |
| 素材元数据 | `POST/GET /api/assets/:type`、`DELETE /api/assets/:type/:id` |
| TikTok 导入 | `POST /api/tiktok/import`、`POST /api/tiktok/validate` |
| 视频裁剪 | `POST /api/trim-video` |
| AI 对话 | `GET /api/chat/models`、`POST /api/chat`、`GET /api/chat/sessions`、`GET/DELETE /api/chat/sessions/:id` |
| 兜底 | `GET *` → 返回 `dist/index.html`（生产环境 SPA） |

### 3.3 `server/routes/` — 路由层

| 文件 | 行数 | 挂载前缀 | 职责 |
|---|---|---|---|
| `auth.js` | 75 | `/api/auth` | 飞书 OAuth：`/feishu/login-url`、`/feishu/callback`、`/me` |
| `users.js` | 90 | `/api/users` | 用户列表、`/permissions-meta`、改资料/角色/权限/状态、删除 |
| `projects.js` | 89 | `/api/projects` | 项目 CRUD + 变更申请（`/change-requests`） |
| `drama.js` | 1037 | `/api/drama` | 剧本 AI 解析：`/analyze-script`、`/split-episodes`、`/analyze-assets`、`/split-shots`（含分镜 `transitionOut` 转场建议与白名单校验） |
| `generation.js` | 701 | `/api` | 图片/视频生成、异步任务、状态查询、`/export-videos` |
| `local-models.js` | 551 | `/api/local-models` | 本地开源模型：`/`（列表）、`/generate`（推理）、模型注册与状态 |
| `storyboard.js` | 671 | `/api/storyboard` | 分镜脚本：`/generate-scripts`、`/brainstorm-story`、`/optimize-story`、`/generate-composite` |
| `tts.js` | 72 | `/api/tts` | 语音合成：`/status`、`/synthesize` |
| `twitter.js` | 216 | `/api/twitter` | X 发布：`/auth`、`/callback`、`/status`、`/post`、`/logout` |
| `tiktok-post.js` | 205 | `/api/tiktok-post` | TikTok 发布：`/auth`、`/callback`、`/status`、`/post`、`/logout` |
| `videoMerge.js` | 435 | `/api/video-merge` | 视频拼接：`/presets`、`/status`、`/merge`、`/shots-to-nodes` |

### 3.4 `server/services/` — 业务服务

**AI 模型接入（图/视频生成）：**

| 文件 | 行数 | 职责 | 被谁引用 |
|---|---|---|---|
| `doubao.js` | 299 | 豆包（Seedream/Seedance）图片与视频生成；Seedream 支持 `image` 数组多参考图（≤10 张） | `generation.js` |
| `kling.js` | 639 | 可灵视频生成 | `generation.js` |
| `hailuo.js` | 296 | 海螺视频生成 | `generation.js` |
| `fal.js` | 326 | fal.ai（运动控制、图生视频） | `generation.js`（动态 import） |
| `gemini.js` | 233 | Gemini 图片描述与提示词优化 | `generation.js` |
| `openai.js` | 126 | OpenAI 文本模型 | `generation.js` |

**模型通道调度：**

| 文件 | 行数 | 职责 | 被谁引用 |
|---|---|---|---|
| `modelChannel.js` | 119 | 按 `channel`（`free`/`project`/`workflow`）选择 API Key 与模型 | `drama.js`、`generation.js` |

**数据与鉴权：**

| 文件 | 行数 | 职责 | 被谁引用 |
|---|---|---|---|
| `userService.js` | 261 | 用户/公司配置读写（`users.json`、`company.json`） | `auth.js`、`users.js` |
| `projectService.js` | 241 | 项目与变更申请读写（`projects.json`、`change-requests.json`） | `projects.js` |
| `jwt.js` | 31 | JWT 签发与校验 | `auth.js` |
| `feishu.js` | 100 | 飞书 OAuth 与用户信息 | `auth.js` |

**媒体与发布：**

| 文件 | 行数 | 职责 | 被谁引用 |
|---|---|---|---|
| `tts.js` | 149 | 语音合成实现 | `tts.js` 路由 |
| `videoMerge.js` | 611 | 视频拼接：xfade 逐边界转场、concat 兜底、TTS 音轨覆盖 | `videoMerge.js` 路由 |
| `local-inference.js` | 265 | 本地开源模型推理（子进程调用 Python/diffusers，进度与产物回传） | `local-models.js` 路由 |
| `twitter.js` | 308 | X OAuth、媒体上传、发帖 | `twitter.js` 路由 |
| `tiktok-post.js` | 353 | TikTok OAuth、视频上传、发帖 | `tiktok-post.js` 路由 |

### 3.5 `server/agent/` — AI 对话代理

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 431 | 会话管理（内存 `sessionCache` + `chats/*.json`）、LangGraph 调用、消息序列化 |
| `graph/chatGraph.js` | 194 | LangGraph 对话图定义 |
| `prompts/system.js` | 77 | 系统提示词 |
| `tools/index.js` | 40 | 工具注册（供 Agent 调用） |

### 3.6 `server/middleware/` 与 `server/utils/`

| 文件 | 行数 | 职责 |
|---|---|---|
| `middleware/auth.js` | 34 | `requireAuth`：校验 `Authorization: Bearer <JWT>` |
| `utils/imageHelpers.js` | 159 | 图片下载、base64 转换、落盘、缩略图 |
| `utils/ffmpeg.js` | 305 | ffmpeg/ffprobe 调用封装（含 shell 参数转义、环境自检） |

### 3.7 `server/tools/` — 外部工具封装

| 文件 | 行数 | 职责 | 被谁引用 |
|---|---|---|---|
| `tiktok.js` | 349 | TikTok 视频下载、解析、元数据写入 | `index.js`（`/api/tiktok/*`） |

### 3.8 `server/python/` 与 `modal/` — Python 侧

| 文件 | 行数 | 职责 |
|---|---|---|
| `server/python/camera-angle/app.py` | 151 | 镜头角度推理 HTTP 服务（Flask） |
| `server/python/camera-angle/inference.py` | 237 | 模型推理实现 |
| `server/python/camera-angle/prompts.py` | 78 | 提示词模板 |
| `server/python/camera-angle/__init__.py` | 5 | 包声明 |
| `modal/camera_angle.py` | — | Modal 云平台部署脚本 |

### 3.9 `server/` 根下的维护脚本

| 文件 | 行数 | 职责 | 执行方式 |
|---|---|---|---|
| `fix-metadata-ids.js` | 53 | 修复元数据 `id` 与文件名不一致 | `node server/fix-metadata-ids.js` |
| `migrate-workflows.js` | 166 | 工作流内联 base64 转文件 URL | `node server/migrate-workflows.js` |

---

## 四、前后端接口对应表

| 前端调用方 | 接口 | 后端处理文件 |
|---|---|---|
| `useAuth.ts` | `GET /api/auth/me` | `routes/auth.js` |
| `LoginPage.tsx` | `GET /api/auth/feishu/login-url` | `routes/auth.js` |
| `App.tsx` | `POST /api/auth/feishu/callback` | `routes/auth.js` |
| `UserManagementPage.tsx` / `UserManagementModal.tsx` | `/api/users/*` | `routes/users.js` |
| `projectService.ts` | `/api/projects/*` | `routes/projects.js` |
| `scriptAnalysisService.ts` | `/api/drama/*` | `routes/drama.js` |
| `generationService.ts` / `useGeneration.ts` | `/api/generate-*`、`/api/generation-status/*` | `routes/generation.js` |
| `useStoryboardGenerator.ts` | `/api/storyboard/*` | `routes/storyboard.js` |
| `dubbingService.ts` | `/api/tts/*` | `routes/tts.js` |
| `TwitterPostModal.tsx` | `/api/twitter/*` | `routes/twitter.js` |
| `TikTokPostModal.tsx` | `/api/tiktok-post/*` | `routes/tiktok-post.js` |
| `TikTokImportModal.tsx` | `/api/tiktok/import`、`/validate` | `index.js` → `tools/tiktok.js` |
| `AssetLibraryPanel.tsx` / `useAssetHandlers.ts` | `/api/library` | `index.js` |
| `HistoryPanel.tsx` / `useAssetHandlers.ts` | `/api/assets/*` | `index.js` |
| `WorkflowPanel.tsx` / `useWorkflow.ts` | `/api/workflows/*`、`/api/public-workflows/*` | `index.js` |
| `ProjectCanvasPage.tsx` | `/api/project-workflows/*` | `index.js` |
| `useChatAgent.ts` | `/api/chat*` | `index.js` → `agent/index.js` |
| `StoryboardVideoModal.tsx` | `/api/gemini/*` | `index.js` → `services/gemini.js` |
| `ShotEditorPanel.tsx` / `useVideoEditor.ts` | `POST /api/trim-video` | `index.js` |
| `WorkflowPage.tsx` | `POST /api/export-videos` | `routes/generation.js` |
| `useVideoMerge.ts` / `mergeService.ts` | `/api/video-merge/presets`、`/status`、`/merge` | `routes/videoMerge.js` → `services/videoMerge.js` |
| `shotImportService.ts` / `ProjectCanvasPage.tsx` | `POST /api/video-merge/shots-to-nodes` | `routes/videoMerge.js` |
| `ShotEditorPanel.tsx`（整集合并成片） | `POST /api/video-merge/merge` | `routes/videoMerge.js` → `services/videoMerge.js` |
| `ShotPanel.tsx` / `shotService.ts` | `POST /api/drama/split-shots` | `routes/drama.js` |
| `localModelService.ts` / `useLocalModelNodeHandlers.ts` / `NodeControls.tsx` | `/api/local-models`、`/api/local-models/generate` | `routes/local-models.js` → `services/local-inference.js` |

---

## 五、改动定位指南

| 要改什么 | 前端位置 | 后端位置 |
|---|---|---|
| 新增画布节点类型 | `types.ts`（`NodeType`）→ `canvas/NodeContent.tsx` → `canvas/NodeControls.tsx` | 无 |
| 新增页面 | `App.tsx` 的 `pathname` 分发 + 新建 `components/XxxPage.tsx` | 无 |
| 新增弹窗 | `components/modals/` + `App.tsx` 挂载 | 无 |
| 新增画布交互 | `src/hooks/use*.ts` | 无 |
| 接入新 AI 模型 | `components/canvas/NodeControls.tsx`（模型列表） | `server/services/` 新建文件 + `routes/generation.js` 分支 |
| 改画布默认模型 | `src/constants/modelDefaults.ts` | 无 |
| 改分镜拆分/成片逻辑 | `ShotPanel.tsx`、`shotService.ts`、`shotToCanvasService.ts` | `routes/drama.js`（`/split-shots`） |
| 新增业务接口 | `src/services/` 新建封装 | `server/routes/` 新建路由 + `index.js` 挂载 |
| 改数据结构 | `types.ts`、对应 `service` | `services/*Service.js` + 同步更新 `docs/database-schema.md` |
| 改鉴权逻辑 | `useAuth.ts` | `middleware/auth.js`、`services/jwt.js` |
| 加多语言 | `i18n/locales/zh.ts`、`en.ts` | 无 |

---

## 六、仓库划分与文档归属

### 6.1 两个独立仓库

| 仓库 | 远程地址 | 内容 | 禁止包含 |
|---|---|---|---|
| `Founder-api` | `.../video-api/Founder-api.git` | 后端：`server/`、`config/`、`modal/`、`public/` | 任何 `src/`、`.tsx`、`vite.config.ts`、`index.html` |
| `Founder-web` | `.../video-web/Founder-web.git` | 前端：`src/`、`index.html`、`vite.config.ts`、`tsconfig.json` | 任何 `server/`、`.js` 后端代码、`.py`、`library/`、`models/` |

**两个仓库各自独立，互不嵌套，不共享 package.json。**

### 6.2 文档归属

| 文档 | 所在仓库 | 内容 | 何时必须更新 |
|---|---|---|---|
| `docs/code-structure.md`（本文） | **两个仓库都有** | 前后端目录与文件职责、接口对应表 | **新增/删除/移动文件、改变文件职责** |
| `docs/database-schema.md` | 后端 | 数据结构与字段、API 请求契约 | **改字段、加表、改接口入参** |
| `docs/deployment-guide.md` | 后端 | 部署步骤 | 改端口、依赖、环境变量、构建方式 |
| `docs/camera-angle-control.md` | 后端 | 镜头角度功能 | 改该功能 |
| `docs/modal-camera-integration.md` | 后端 | Modal 集成 | 改该集成 |
| `docs/post-to-x.md` | 后端 | X 发布 | 改该流程 |
| `docs/tiktok-integration.md` | 后端 | TikTok 集成 | 改该流程 |
| `docs/video-editor-node.md` | 前端 | 视频编辑器节点 | 改该节点 |

> `code-structure.md` 在两个仓库中**内容完全相同**，改动后需同步到另一仓库。

---

## 七、提交前检查清单

**前端仓库（Founder-web）推送前：**

1. `git status` 新增/删除的文件，是否已反映到本文档第二章
2. 是否误提交后端文件（`server/`、`.py`、`library/`）——应为空
3. `npm run typecheck` 是否通过
4. `docs/code-structure.md` 是否与后端仓库同步

**后端仓库（Founder-api）推送前：**

1. `git status` 新增/删除的文件，是否已反映到本文档第三章
2. 是否误提交前端文件（`src/`、`.tsx`、`vite.config.ts`）——应为空
3. 是否误提交 `.env`、`library/`、`node_modules/`、`models/`
4. `npm run dev` 启动无 import 报错
5. 若改了字段或接口入参，`docs/database-schema.md` 是否同步
6. 若改了环境变量或端口，`docs/deployment-guide.md` 与 `.env.example` 是否同步
7. `docs/code-structure.md` 是否与前端仓库同步

> **强制约定：文档必须与代码在同一提交中更新，不允许先推代码后补文档。**
