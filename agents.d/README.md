# agents.d — 声明式智能体接入

把符合 `ox-agent/2` 契约的智能体写成一份 JSON，放进**运行时的 agents.d 目录**，重启 OxCommander 后自动加载：

| 平台 | 实际目录 |
| --- | --- |
| Windows | `%APPDATA%\OxCommander\agents.d\` |
| macOS | `~/Library/Application Support/OxCommander/agents.d/` |
| Linux | `~/.config/OxCommander/agents.d/` |

也可以在「设置 → 智能体池」里直接粘贴 JSON 注册（运行时生效，不需要重启）。

> 本目录（仓库内的 `agents.d/`）只存放示例与文档；运行时只读用户数据目录下的同名目录。
> 以 `.example.json` 结尾的文件永远不会被加载。

## 加载规则

- 只读 `*.json`，跳过 `*.example.json`。
- 一个文件可以是一个对象，也可以是数组（一次声明多个智能体）。
- **单个文件校验失败只记录错误并跳过**，不会影响其它智能体（错误会显示在设置页）。
- 内置适配器（`local-llm`，即 SenseNova 执行器）优先占用 id；同一 id 的声明不会覆盖它。
- 未在 manifest 里声明能力、且适配器自己也没有 `capabilities()` 的智能体，会被当作 "未声明"，
  参与**原有轮询分发**——这样接入新智能体不会改变单智能体场景的行为。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 唯一标识，`[A-Za-z0-9._-]` |
| `displayName` | | 显示名，缺省用 `id` |
| `adapter` | ✅ | `cli` / `http-bridge` / `local-llm` |
| `entry` | ✅（非 local-llm） | `{kind:"cli",...}` 或 `{kind:"http",...}` |
| `capabilities` | ✅ | 见下 |
| `credential` | | `env` / `bearerFile` / `execToken` / `none`（默认 none） |
| `limits` | | `runDeadlineMs` / `idleTimeoutMs` / `maxStdoutBytes` |
| `priority` | | 同分时优先，默认 0 |
| `enabled` | | 默认 true |

### capabilities

| 字段 | 说明 |
| --- | --- |
| `roles` | 可承担的任务角色：`frontend-dev` / `backend-dev` / `fullstack-dev` / `test-writer` / `docs-writer` / `*` |
| `zoneGlobs` | 可操作的目录范围（相对项目根，posix glob）；`["**"]` 表示不限 |
| `supports` | 能做的动作：`read` / `edit` / `create` / `delete` / `run-command` / `run-test` / `review`。任务默认要求 `edit` |
| `artifactKinds` | 产出类型：`files` / `diff` / `logs` / `report` |
| `maxConcurrency` | 该智能体并行上限 |
| `selfIsolated` | 是否自带隔离（容器/子进程策略）；false 时由平台的沙箱兜底 |

分派打分（分数=命中项之和）：角色精确命中 +100、角色 `*` +60、目录被**具体** glob 覆盖 +40、
仅被 `**` 覆盖 +20、历史成功率 ×20、半开熔断 −15、负载 −10×(在跑/并发上限)、优先级 ×1。

## CLI 智能体

`argsTemplate` 支持占位符：`{{projectRoot}}` `{{promptPath}}` `{{taskId}}` `{{runId}}` `{{zone}}`。

- 任务正文会写入 `{{promptPath}}` 指向的 Markdown 文件（不会挤进命令行，避免参数超长）。
- 子进程以 `shell: false` 启动，命令元字符不会被执行。
- `probe()` 默认执行 `probeArgs`（缺省 `--version`），退出码 0 视为可用。
- 注销时会先 `drain`（默认 5 秒），超时则杀掉整棵进程树。

## HTTP 桥接

协议很小：

```
GET  {baseUrl}{healthPath}                    → 2xx 视为健康（默认 /health）
POST {baseUrl}{runsPath}      TaskRequest     → { runId } 或 { events, status }
GET  {baseUrl}{runsPath}/{id}/events?since=N  → { events: [{kind,text}], status }
POST {baseUrl}{runsPath}/{id}/abort           → 2xx
```

`TaskRequest` 即 `TaskPayload` 的超集，额外带 `protocolVersion: "ox-agent/2"` 与 `deadlineMs`。
事件流采用**轮询**（`pollMs`，默认 500ms）而非 SSE，保持零依赖、易测试；
事件 `kind` 取 `log` / `completed` / `failed` / `aborted`。

### GUI 智能体（如 Marvis）怎么接

> **要给任何外部智能体发接入说明，直接发 [`onboarding-universal.md`](onboarding-universal.md)**——
> 自包含的通用任务书：桌面助手/CLI 走路径 A（自实现 ox-agent/2），云端 bot/LLM API 走路径 B
> （平台方架桥）。本文下面是协议速查，Marvis 专用实例见 `marvis-onboarding.md`。

没有 CLI 的桌面智能体走 **HTTP 桥接**：让它在本地起一个实现上面四个接口的小服务
（参考 `scripts/loomy-bridge.mjs`，约 200 行），然后二选一注册：

1. **运行时注册（推荐，不用重启）**：OxCommander → 设置 → 智能体池 → 粘贴 manifest JSON。
2. **声明式注册**：把填好的 JSON 存为 `%APPDATA%\OxCommander\agents.d\marvis.json`，重启自动加载。

模板见 `marvis.example.json`（`.example.json` 永远不会被加载，需去掉后缀）。
需要按 Marvis 实际能力改的三处：`entry.baseUrl`（它的服务端口）、
`capabilities.zoneGlobs`（允许它工作的目录）、`capabilities.roles`。
注册后立刻在智能体池里点「🩺 健康检查」，显示「可达」即接入成功；
之后能力路由会自动把命中其 zone/角色的任务派给它。

## 示例

- `codex.example.json` — 子进程型（Codex CLI）
- `claude-code.example.json` — 子进程型（Claude Code，`-p` 非交互）
- `workbuddy-bridge.example.json` — HTTP 桥接型（WorkBuddy / MCP 网关）

> **CLI 型的 `argsTemplate` 必须逐字核对目标 CLI 的真实参数。**
> 2026-09-20 实测踩到：本目录的 Codex 示例曾写 `--prompt-file`，而 `codex exec`
> 根本没有这个参数（它只接受位置参数 PROMPT 或 stdin）。照抄的后果是
> **probe 依然绿**（只跑 `--version`），但每次派单都因未知参数失败 ——
> 配好了却永远跑不起来。加新 CLI 时先跑一遍 `--help` 核对每个参数。
