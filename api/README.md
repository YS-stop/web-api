# Founder-api — Video Workflow 后端

TwitCanva Video Workflow 的**后端服务**，提供 AI 剧本解析、图片/视频生成、语音合成、素材管理、工作流持久化与社交平台发布接口。

> 前端代码在独立仓库 `Founder-web`，本仓库**只包含后端**。

## 技术栈

| 项目 | 说明 |
|---|---|
| 运行时 | Node.js ≥ 20（ES Module） |
| Web 框架 | Express 5 |
| AI 编排 | LangChain + LangGraph |
| 存储 | JSON 文件（`library/` 目录），无数据库 |
| 端口 | `8024` |

## 快速开始

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# 编辑 .env 填入 API Key
npm run dev               # 开发模式（--watch 热重载）
npm start                 # 生产模式
```

服务启动后监听 `http://localhost:8024`。

## 环境变量

完整清单见 [`.env.example`](.env.example)，关键项：

| 变量 | 必填 | 用途 |
|---|---|---|
| `PORT` | 否 | 服务端口，默认 `8024` |
| `GEMINI_API_KEY` | 是 | Gemini / Veo 默认模型 |
| `SEEDREAM_API_KEY` | 是 | 豆包 Seedream 图片生成 |
| `SEEDANCE_API_KEY` | 是 | 豆包 Seedance 视频生成 |
| `DRAMA_API_KEY` | 是 | 剧本智能解析（火山方舟 DeepSeek） |
| `VLM_DOUBAO_API_KEY` | 是 | AI 聊天助手 |
| `TTS_APP_ID` / `TTS_ACCESS_TOKEN` | 是 | 豆包语音合成（配音） |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` | 否 | 可灵图片/视频 |
| `HAILUO_API_KEY` | 否 | 海螺视频 |
| `OPENAI_API_KEY` | 否 | GPT Image |
| `FAL_API_KEY` | 否 | Kling V2.6 动作控制 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 是 | 飞书登录 |
| `JWT_SECRET` | 生产必填 | JWT 签名密钥 |
| `LIBRARY_DIR` | 否 | 数据目录，默认 `./library` |
| `CHANNEL_MAX_CONCURRENT` | 否 | 每通道每模型并发数，默认 `3` |

**三通道 Key 分流：** 支持 `free`（自由画布）/ `project`（项目画布）/ `workflow`（工作流）三套通道，可用 `XXX_API_KEYS=key1,key2` 或 `XXX_API_KEY_WORKFLOW=keyA` 配置。

## 目录结构

```
server/
├── index.js              应用入口：路由挂载、静态托管、通用接口
├── routes/               路由层（auth/users/projects/drama/generation/storyboard/tts/twitter/tiktok-post/local-models/videoMerge）
├── services/             业务服务（各 AI 模型接入、数据读写、JWT、社交发布、视频拼接、本地推理）
├── agent/                AI 对话代理（LangGraph）
│   ├── graph/            对话图定义
│   ├── prompts/          系统提示词
│   └── tools/            工具注册
├── middleware/           requireAuth 鉴权
├── tools/                TikTok 视频解析
├── utils/                图片处理
└── python/camera-angle/  镜头角度推理服务（Flask）
config/model-registry.json  本地模型架构配置（遗留）
modal/camera_angle.py       Modal 云平台部署脚本
public/workflows/           内置公共工作流模板
```

**详细代码分布见 [docs/code-structure.md](docs/code-structure.md)。**

## API 概览

| 前缀 | 模块 |
|---|---|
| `/api/auth` | 飞书 OAuth 登录 |
| `/api/users` | 用户与权限管理 |
| `/api/projects` | 项目 CRUD、变更审批 |
| `/api/drama` | 剧本解析、拆集、资产识别、拆分镜 |
| `/api/generate-image`、`/api/generate-video` | 图片/视频生成与异步任务 |
| `/api/storyboard` | 分镜脚本生成 |
| `/api/tts` | 语音合成 |
| `/api/chat` | AI 对话 |
| `/api/library`、`/api/assets` | 素材库 |
| `/api/workflows`、`/api/project-workflows` | 工作流持久化 |
| `/api/twitter`、`/api/tiktok-post` | 社交平台发布 |
| `/api/video-merge` | 视频拼接成片：`/presets`、`/status`、`/merge`、`/shots-to-nodes` |
| `/api/local-models` | 本地开源模型：列表、生成、状态 |
| `/library/*` | 静态文件（图片/视频/素材） |

### 图片 / 视频模型路由

`routes/generation.js` 按模型名前缀分流，前端默认值由 `src/constants/modelDefaults.ts` 统一提供：

| 模型前缀 | 分支 | 服务文件 | 密钥 |
|---|---|---|---|
| `doubao-seedream` | 豆包图片 | `services/doubao.js` → `generateSeedreamImage` | `SEEDREAM_API_KEY` |
| `doubao-seedance` | 豆包视频 | `services/doubao.js` → `generateSeedanceVideo` | `SEEDANCE_API_KEY` |
| `gpt-image-` | OpenAI 图片 | `services/openai.js` | `OPENAI_API_KEY`（未配置则 500） |
| `kling-` | 可灵 | `services/kling.js` | `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` |
| `hailuo-` | 海螺 | `services/hailuo.js` | `HAILUO_API_KEY` |

> Seedream 支持 `image` 数组多参考图（最多 10 张），`generateSeedreamImage` 会统一转成数组，无参考图时按文生图处理。

## 数据存储

无数据库，全部为 JSON 文件，默认落在 `library/`：

| 路径 | 内容 |
|---|---|
| `library/users.json` | 用户表 |
| `library/company.json` | 公司租户锁定 |
| `library/projects.json` | 项目（含剧本分集与资产） |
| `library/change-requests.json` | 变更审批 |
| `library/workflows/{id}.json` | 自由画布工作流 |
| `library/project-workflows/{pid}_ep{n}.json` | 项目分集画布 |
| `library/chats/{id}.json` | 聊天会话 |
| `library/images/{id}.json` | 图片元数据 |
| `library/videos/{id}.json` | 视频元数据 |
| `library/assets/assets.json` | 素材库索引 |

**完整字段说明见 [docs/database-schema.md](docs/database-schema.md)。**

## 维护脚本

```bash
node server/fix-metadata-ids.js    # 修复元数据 id 与文件名不一致
node server/migrate-workflows.js   # 工作流内联 base64 转文件 URL
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/code-structure.md](docs/code-structure.md) | 前后端代码分布、接口对应表 |
| [docs/database-schema.md](docs/database-schema.md) | 数据结构与字段、API 请求契约 |
| [docs/deployment-guide.md](docs/deployment-guide.md) | 部署步骤 |
| [docs/camera-angle-control.md](docs/camera-angle-control.md) | 镜头角度控制 |
| [docs/modal-camera-integration.md](docs/modal-camera-integration.md) | Modal 集成 |
| [docs/post-to-x.md](docs/post-to-x.md) | X / Twitter 发布 |
| [docs/tiktok-integration.md](docs/tiktok-integration.md) | TikTok 集成 |

> **文档更新约定：新增 / 删除 / 移动文件，或改字段、改接口入参时，必须同步更新文档，与代码在同一提交中推送。**

## 安全

- 所有 API Key 通过 `.env` 注入，**不得硬编码或提交**
- `.env`、`library/`、`node_modules/`、`dist/` 已在 `.gitignore` 中排除
- 除 `/api/tts/*` 与 `/api/library` 外，其余接口需 `Authorization: Bearer <JWT>`

## License

见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
