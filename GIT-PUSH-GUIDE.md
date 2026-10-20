# Git 推送前必读（模型 / 协作者强制执行）

> **谁能读、什么时候读**：任何准备执行 `git add` / `git commit` / `git push` 的模型或人，动手前先读完本文。
>
> **来源**：《博远中台项目编码与 Git 协作规范》§3.1（文件与安全）、§7（Git 分支）、§8（Commit Message）、§9（合并请求）、§11（DoD）。
> 本文只保留"推送前"必须执行的部分，并把其中的 .NET / Vue 命令替换为本项目实际命令。规范冲突时，以更具体、更新的项目约定为准。

---

## 0. 先搞清楚仓库形态（最容易踩的坑）

```
ShipWorkflow/            ← 根目录【不是】git 仓库，任何 git 命令都会 fatal
├── api/                 ← 独立仓库：后端（Express + ESM，Node >= 20）
│   └── .git             origin: .../video-api/Founder-api.git
└── web/                 ← 独立仓库：前端（React + Vite + TS）
    └── .git             origin: .../video-web/Founder-web.git
```

硬性要求：

- **所有 git 命令必须先 `cd api` 或 `cd web`**，在根目录执行必然失败。
- 前后端改动属于两个仓库，必须**分别提交、分别推送**，不能指望一次 push 覆盖两端。
- 两个仓库当前工作分支都是 `hys`，`origin/HEAD` 指向 `master`。

---

## 1. 推送前的硬性闸门（任一不通过即禁止推送）

| 仓库 | 必跑命令 | 通过标准 |
|---|---|---|
| `api/` | `npm test` | 全绿（当前基线 **68 例**，不得减少） |
| `api/` | `node -e "import('./server/index.js')"` 或实际启动 | 能启动、无 import / 语法错误 |
| `web/` | `npm run typecheck` | 0 错误 |
| `web/` | `npm run build` | 构建通过（改动涉及构建配置或依赖时必跑） |

规则：

- 测试失败**不允许**推送；**禁止**通过删除、跳过（`.skip`）、放宽断言让流水线变绿。
- 修 bug 的提交必须带能复现该 bug 的回归测试，或在提交正文里写明无法自动化的原因。
- 退出码为 `0` 才算通过；不要把"命令没跑完/被取消"当作成功。

---

## 2. 绝对禁止进入版本库的内容

- `.env`、`.env.*`（除 `.env.example`）、任何密钥 / Access Token / AppID 组合 / 数据库连接串
- 日志（`*.log`）、`.tmp-build/`、`dist/`、`build/`、`node_modules/`
- `api/library/`、`api/models/`、`venv/`、模型权重（`.bin/.pt/.safetensors/.onnx`）
- 临时脚本（`tmp-*.mjs`、`server/_*.js`）、调试用的 `console.log`、被注释掉的大段代码
- IDE 配置（`.vscode/`、`.idea/`）、系统文件（`Thumbs.db`、`.DS_Store`）

推送前自查：

```powershell
cd api;  git status --short; git diff --cached --stat
cd web;  git status --short; git diff --cached --stat
```

暂存区里出现上面任何一类文件，**先 `git restore --staged <file>` 再提交**。

---

## 3. 分支规范

- `master` / `main` / `release/*` 是受保护分支：**只能通过合并请求进入，禁止直接 push，禁止 force push**。
- 工作分支命名：`<type>/<issue-id>-<short-description>`
  - `type` 取值：`feat` `fix` `hotfix` `refactor` `perf` `docs` `test` `chore`
  - 说明部分小写英文 + 连字符，不用中文、空格、下划线
  - 无问题编号时省略 `issue-id`，例：`feat/tts-bidirection`
- **一个分支只做一个主题**：功能、顺手重构、无关格式化不得混在一起。
- `hys` 是当前团队的集成分支（两仓库同名）。往 `hys` 推送时同样遵守本文全部规则；不得改写他人已基于其开发的历史。

---

## 4. Commit Message 规范（Conventional Commits）

格式：

```
<type>(<scope>): <summary>

[body：为什么改、关键权衡，不要逐条复述 diff]

[footer：Refs: / Closes: / BREAKING CHANGE:]
```

要求：

- `type`、`scope` 用小写英文；`summary` 用祈使语气描述**实际结果**，不以句号结尾。
- 同一仓库的语言保持一致：**本仓库统一使用中文 summary**（历史提交如此）。
- 禁止 `wip` / `tmp` / `update` / `update code` / `123` 这类无信息标题。
- 破坏性变更加 `!` 并在 footer 写 `BREAKING CHANGE:`。
- 一个提交只表达一个可独立理解和回滚的逻辑变化；**代码与对应测试、必要文档放在同一提交**。
- 重命名/格式化与业务逻辑改动尽量拆开提交。

本项目的 `scope` 建议：

| scope | 覆盖范围 |
|---|---|
| `tts` | 语音合成（v1 / v3 / 双向 WS / 试听） |
| `voices` | 音色目录、音色分配 |
| `drama` | 剧本 / 资产 / 角色分析 |
| `dubbing` | 配音编排与合成 |
| `video` | 视频生成、任务队列 |
| `model` | 模型注册表与推理接入 |
| `assets` | 前端资产确认面板 |
| `ui` | 通用界面与样式 |
| `deps` | 依赖变动 |

示例（本仓库真实风格）：

```
feat(tts): 接入豆包语音合成 2.0 与角色音色体系
fix(tts): 英文音色试听误用中文示例句导致返回空音频
fix(assets): 修正自定义音色下拉框在深色主题下选项不可见
refactor(voices): 音色映射收敛为单一目录
chore(deps): 新增 ws 依赖以支持双向流式
```

---

## 5. 标准推送序列（模型照此执行）

```powershell
# 1) 进入正确的仓库
cd e:/pythonData/Python/ShipWorkflow/api      # 后端；前端用 web

# 2) 先看远端有没有新提交，避免非快进
git fetch origin

# 3) 自查工作区
git status --short
git diff                                     # 确认没有夹带无关改动

# 4) 过闸门
npm test                                     # api
npm run typecheck                            # web

# 5) 逐个文件暂存（禁止 git add -A / git add .）
git add server/services/tts.js server/config/voices.js test/voices.test.js

# 6) 提交
git commit -m "fix(tts): ..." -m "原因与关键权衡"

# 7) 推送当前分支
git push origin hys
```

补充：

- 远端有新提交时先 `git pull --rebase origin <branch>`，解决冲突后**重新跑闸门**再推送。
- **禁止 `git push --force` / `--force-with-lease`**，除非用户明确要求且分支是个人分支。
- 禁止 `git commit --amend` 已推送的提交（除用户明确要求）。
- 禁止修改 `git config`（用户名、邮箱、hooks 一律不动）。
- 提交前用 `git log -1 --format='%an %ae'` 确认身份符合预期。

---

## 6. 冲突处理

- 由工作分支负责人解决；解决后重新执行受影响的测试。
- **逐段理解双方意图**再改，禁止整文件选 `ours` / `theirs`，禁止 `-X ours` 批量覆盖。
- 契约文档（接口说明、README）只允许追加或定点编辑，禁止读旧快照后整文件重写。
- 路由、公共类型、迁移编号冲突时，先找对应改动的负责人确认。

---

## 7. 合并请求说明模板

```markdown
## 变更目的
<!-- 为什么需要这次变更 -->

## 主要改动
-

## 影响范围
- 前端：
- 后端：
- 数据库/配置：

## 验证结果
- [ ] api `npm test`（__ 例通过）
- [ ] web `npm run typecheck`
- [ ] web `npm run build`（如涉及构建）
- [ ] 手工验证关键路径：__

## 风险与回滚
<!-- 兼容性、监控点、回滚方式 -->

## 关联事项
Refs:
```

不涉及某一端时写"不涉及"，**不得虚假勾选未执行的验证项**。

合并策略：`feat/*` `fix/*` `refactor/*` 默认 **Squash Merge**，squash 后标题必须重新整理为合规的 Conventional Commit；`release/*` `hotfix/*` 用 Merge Commit。提交人不得自行批准自己的 MR。

---

## 8. 本项目已知易错点

1. **根目录没有 `.git`** —— 在 `ShipWorkflow/` 执行 git 命令一定报 `not a git repository`。
2. **前后端双仓库** —— 改了 `api/` 和 `web/` 就要提交两次、推两次。
3. **`api/.env` 存着 TTS 凭证**（AppID / Access Token）——已被 `.gitignore` 忽略，永远不要 `git add -f`。
4. **`api/library/audio` 是运行时产物**（试听、探针生成的 mp3），不要提交；对照用音频验证完即删。
5. **`web/.tmp-build/`** 是构建临时目录，出现时不要提交，必要时补进 `web/.gitignore`。
6. **端口**：后端 8024，前端 8025（`vite.config.ts` 里的 `server.port`，不是 5173）。
7. **临时验证脚本**用 `tmp-*.mjs` 命名（已被忽略），验证完立即删除，不要留在工作区。

---

## 9. 提交前自查清单

- [ ] 在 `api/` 或 `web/` 目录下执行，而不是根目录
- [ ] `git status` 里没有 `.env` / 日志 / 构建产物 / 临时脚本
- [ ] 改动只包含一个主题，没有夹带无关重构或格式化
- [ ] 新逻辑有测试；修 bug 有回归测试
- [ ] `npm test`（api）/ `npm run typecheck`（web）通过
- [ ] 没有调试代码、注释掉的代码、无用 import
- [ ] Commit Message 符合 `<type>(<scope>): <summary>`，中文祈使语气
- [ ] 没有 force push，没有 amend 已推送的提交
- [ ] 推送目标分支正确（当前为 `hys`），且已 `git fetch` 确认无落后
