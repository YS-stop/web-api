# Founder-web — Video Workflow 前端

TwitCanva Video Workflow 的**前端应用**，提供无限画布、节点式视频创作、剧本分集、资产确认、分镜编辑与配音等界面。

> 后端代码在独立仓库 `Founder-api`，本仓库**只包含前端**。

## 技术栈

| 项目 | 说明 |
|---|---|
| 框架 | React 19 + TypeScript |
| 构建 | Vite 6 |
| 路由 | React Router 7 |
| 3D | Three.js + React Three Fiber（环绕相机控制） |
| 国际化 | i18next（中文 / 英文） |
| 图标 | lucide-react、@lobehub/icons |
| 端口 | `8025` |

## 快速开始

```bash
npm install
npm run dev          # 开发服务器 http://localhost:8025
npm run build        # 生产构建 → dist/
npm run preview      # 预览构建产物
npm run typecheck    # TypeScript 类型检查
```

**必须先启动后端 `Founder-api`（`http://localhost:8024`）**，否则接口全部 404。

Vite 已配置代理：

| 前端路径 | 转发到 |
|---|---|
| `/api/*` | `http://localhost:8024` |
| `/library/*` | `http://localhost:8024` |

## 环境变量

复制 `.env.example` 为 `.env.local`（已被 `.gitignore` 排除）：

| 变量 | 必填 | 用途 |
|---|---|---|
| `VITE_MODAL_CAMERA_ENDPOINT` | 否 | 云端镜头角度服务地址；留空则走本地 `/api/camera-angle` |

## 页面路由

| 路径 | 页面 | 组件 |
|---|---|---|
| `/` | 项目列表 | `ProjectListPage` |
| `/canvas` | 自由画布 | `App.tsx` 内联 |
| `/canvas/:projectId` | 项目分集画布 | `ProjectCanvasPage` |
| `/workflow/:projectId` | 项目工作流 | `WorkflowPage` |
| `/users` | 用户管理 | `UserManagementPage` |
| `/approvals` | 变更审批 | `ApprovalsPage` |

## 目录结构

```
src/
├── index.tsx         应用入口（polyfill、i18n、Router）
├── App.tsx           总控组件：路径分发、画布组装、弹窗挂载
├── types.ts          全局类型（NodeData / NodeType / NodeStatus）
├── components/       页面级组件
│   ├── canvas/       画布核心（节点、连线、框选、相机控制）
│   ├── modals/       弹窗（创建项目、分镜、编辑器、发布）
│   │   └── imageEditor/  图片编辑器子模块
│   └── icons/        品牌图标
├── hooks/            状态与逻辑（画布交互、生成调度、编辑器子 hooks）
├── services/         后端接口封装（生成、剧本、项目、配音、素材、分镜）
├── constants/        常量（画布默认模型等）
├── utils/            并发限流、连线几何、视频抽帧
└── i18n/             多语言（zh / en）
```

**详细代码分布见 [docs/code-structure.md](docs/code-structure.md)。**

## 核心流程

```
创建项目 → 剧本解析分集 → 资产确认（角色/场景/道具设定图）
        → 进入画布 → 分镜面板拆分镜 → 一键成片 → 合并成片
```

> 工作流为 4 步（基本信息 / 剧本分集 / 资产确认 / 进入画布）；原「视频生成」步骤已移除，
> 分镜拆分与成片能力内聚到项目画布的「分镜」Tab，视频拼接由画布的 `VIDEO_MERGE` 节点完成。

### 画布默认模型

新建图片 / 视频节点时不再硬编码模型名，统一由 `src/constants/modelDefaults.ts` 提供：

| 常量 | 值 | 依赖密钥 |
|---|---|---|
| `DEFAULT_IMAGE_MODEL` | `doubao-seedream-5-0-pro-260628` | `SEEDREAM_API_KEY` |
| `DEFAULT_VIDEO_MODEL` | `doubao-seedance-2-0-260128` | `SEEDANCE_API_KEY` |

Seedream 支持多图参考（后端 `generateSeedreamImage` 接收 `image` 数组，最多 10 张），
因此 `NodeControls` 中该模型的 `supportsImageToImage` / `supportsMultiImage` 均为 `true`。

制作过程的中间态保存在浏览器 `localStorage`（按 `projectId` 隔离）：

| Key | 内容 |
|---|---|
| `asset-confirm:{projectId}` | 资产确认结果 |
| `shot-editor:{projectId}` | 分镜与视频结果 |
| `dubbing:{projectId}` | 配音数据 |
| `twitcanva_auth_token` | 登录 JWT |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/code-structure.md](docs/code-structure.md) | 前后端代码分布、接口对应表 |
| [docs/video-editor-node.md](docs/video-editor-node.md) | 视频编辑器节点说明 |

> **文档更新约定：新增 / 删除 / 移动文件，或改变文件职责时，必须同步更新 `docs/code-structure.md`，与代码在同一提交中推送。**

## 相关仓库

- 后端：`Founder-api`（Express + AI 模型接入）

## License

见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
