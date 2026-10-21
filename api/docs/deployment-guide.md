# TwitCanva 环境说明

> 本文档记录本机当前的环境状态、两种 AI 生成方式的区别。
> 用途：方便以后快速回顾、重启环境。

---

## 1. 项目是干什么的

TwitCanva = 基于节点的生成式 AI 工作流编辑器（React + TypeScript + Vite 前端，Node + Express 后端），在无限画布上拖节点、连线，串联多个 AI 模型生成图片/视频，并可发布到 X/TikTok。

技术栈概览：

- 前端：React 19 + TypeScript + Vite 6 + Tailwind + Three.js
- 后端：Node + Express + LangGraph.js（聊天 Agent）
- 本地模型：Python（uv 管理）+ PyTorch + diffusers
- 云端：Gemini / Veo / Kling / Hailuo / OpenAI / Fal.ai

---

## 2. 两种 AI 生成方式（务必分清）

### 2.1 本地模型（venv + SD 模型 + GPU）

- **做什么**：只生成 **图片**（文生图），在你本机显卡上跑。
- **组成**：
  - GPU：NVIDIA RTX 5060（8GB 显存，Blackwell sm_120）
  - venv（4.36GB）：Python 3.12.14 + torch 2.11.0+cu128 + diffusers 等（引擎）
  - SD 模型（3.97GB）：`models/checkpoints/v1-5-pruned-emaonly.safetensors`（Stable Diffusion 1.5 权重，大脑）
- **特点**：免费、离线、隐私；只支持图片，**不支持视频**，没有动作控制/相机角度/故事板等高级功能。

### 2.2 云端 API（Gemini / Veo / Kling / Hailuo / OpenAI / Fal）

- **做什么**：图片 + **视频** + 所有高级功能（动作控制、相机角度、故事板、图生图等）。
- **特点**：付费（按量）、需要联网、需要 API Key、跑在对方服务器。
- **视频生成只走云端**（本地没有可用的视频模型）。

### 2.3 一句话对比

| | 本地 | 云端 |
|---|---|---|
| 生成 | 只图片 | 图片 + 视频 + 高级功能 |
| 费用 | 免费 | 付费 |
| 联网 | 不需要 | 需要 |
| 隐私 | 图不出本机 | 上传服务器 |
| 依赖 | GPU + venv + 模型 | 只需 API Key |

---

## 3. 当前环境状态（已配好）

| 项 | 状态 | 说明 |
|---|---|---|
| Node 依赖 | ✅ 894 包 | `node_modules/` |
| Python venv | ✅ 4.36GB | uv 管理，torch cu128 适配 RTX 5060 |
| SD1.5 模型 | ✅ 3.97GB | `models/checkpoints/` |
| .env | ✅ 已建模板 | 密钥仍为空，需自行填写 |
| 端口 | ✅ 已改 | 见下节 |
| 前端地址 | ✅ 相对路径 | 无 IP/localhost 硬编码 |

### 关键依赖版本

- Node v26、npm 11.12.1（Windows 下用 `npm.cmd`）
- uv 0.12.5
- Python 3.12.14（uv 管理的）
- torch 2.11.0+cu128、torchvision 0.26.0+cu128
- diffusers 0.41.0、transformers 5.19.0、accelerate 1.15.0

### 重要：HuggingFace 镜像

本机连不上 huggingface.co，已配置国内镜像（在 `.env`）：

```
HF_ENDPOINT=https://hf-mirror.com
HF_HUB_DISABLE_XET=1
```

---

## 4. 端口一览

| 服务 | 端口 |
|---|---|
| 后端 API | 8024 |
| 前端（开发 Vite） | 8025 |
| 相机角度（本地，需 24GB 显存，本机跑不了） | 8026 |

---

## 5. 本地启动

```bash
# 一键启动前后端（开发模式）
npm.cmd run dev

# 访问
http://localhost:8025           # 本机
http://192.168.20.239:8025      # 局域网 IP
```

- 前端 Vite：8025（host 已设 0.0.0.0，局域网可访问）
- 后端 API：8024
- 前端请求走相对路径 + Vite 代理，IP 怎么变都不用改代码

⚠️ 云端生成需要先在 `.env` 填 API Key（`GEMINI_API_KEY` 至少必填）；本地 SD1.5 无需 Key 直接用。

---

## 6. 常用命令速查

```bash
# 本地开发
npm.cmd run dev                # 前后端一起起（8025 + 8024）
npm.cmd run server             # 只起后端（8024）
npm.cmd run build              # 构建生产前端到 dist/

# 本地模型
npm.cmd run setup:local-models # 用 uv 重建 venv + 装依赖（已改成 uv 版）
venv\Scripts\python.exe scripts\inference.py --model_path models\checkpoints\v1-5-pruned-emaonly.safetensors --prompt "..." --output out.png
```

---

## 7. 注意事项

- **别删** `venv/`（4.36GB，本地生成靠它）和 `models/`（SD 模型）。
- 系统 Python（3.12/3.11）磁盘上已不存在，`python` 命令报错属正常，项目已完全不依赖它，走 uv。
- 相机角度控制本机显存不够（需 24GB），要走云端 Modal（`modal deploy modal/camera_angle.py`）。
