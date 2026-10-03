# 竞品特性刷新与吸收记录（2026-10-03）

> 调研时点：2026-10-03，项目基线 `ed0ffff`（遗留缺陷台账清零）。
> 前情：[2026-10-02 刷新](2026-10-02-competitor-refresh.md)（弹性库特性吸收 + 5.4/5.5 收官）、
> [2026-09-29 全景](2026-09-29-competitor-research.md)。本轮三件事：赛道格局更新、
> 弹性库/MCP 新标准对照、两处小特性落地。

## 一、赛道格局更新（2026-10 初）

| 动态 | 对本项目的影响 |
| --- | --- |
| **Vibe Kanban 确认死亡**：bloop 于 2026-04-10 关闭，仓库 117 天无提交，社区维护止于 v0.1.44 | 赛道前辈退场。第三方评测点名它的两个问题：**默认关闭 agent 的审批提示** + **默认开启遥测上报** —— 恰好是本项目刻意相反的两件事（审批 fail-closed、无任何遥测）。差异化叙述更强了，不需要改代码 |
| **OpenRig**（mvschwarz/openrig，10 月 trending，+683 stars/日）：tmux pane 隔离 + **共享通信总线**（消息路由/任务分配/冲突解决）、角色、上下文共享 | 对等协作路线。本项目是**中心化编排**（router 统一 decision），"回合感知/Agent Discovery"这类对等痛点在本架构下不存在 —— 不吸收，定位不同 |
| **Agent Orchestrator（AO，12.6k stars，Go）**：CI 失败/审查意见 **Reaction 回环**自动路由回执行器、role-based model routing | Reaction 回环 = 外部反馈（PR/CI）进重修循环，即清单 5.7 的 PR/CI 折中版 —— 留在远期。**role-based model routing 本项目已有**（大脑层 settings.llmProvider 与执行器 manifest 分层，roles 路由）✓ |
| **Orca 9-30 更新**：usage 可视（rate-limit resets、账号级限额）+ Codex 账号一键切换免重认证；1.4.193 加 **agent state heartbeats** + wait-for-setup 启动策略 | 用量/账号切换我们 P1-2/P1-5 已覆盖 ✓。**心跳是真空白** → 本轮吸收（见 §三.2）。wait-for-setup 的对应物（workspace 先 scaffold 再派发）已有 ✓ |

## 二、弹性库与 MCP 新标准对照

| 标准实践 | 本项目判定 |
| --- | --- |
| **请求 id 透传**（"log the request-id header on every response so a support ticket takes one message"——OpenRouter `x-generation-id` / OpenAI `x-request-id` / Anthropic `request-id`） | **真空白 → 本轮吸收**。此前 `HttpLlmError` 不带任何追踪 id，报障要在时间戳里猜 |
| LiteLLM `retry_policy` 逐错误类型重试（`NotFoundErrorRetries: 0`、认证类 3） | 本项目语义更干净：401/403 fail-fast、402/404/405/410/413 bench 本线路、400 请求级不冷却（10-02 已落地），✓ 已覆盖 |
| LiteLLM `allowed_fails` 断路器 + Redis 共享冷却 | 断路器 = 10-02 的连续失败升级冷却 ✓；Redis 共享冷却 N/A（单进程架构） |
| 跨 vendor fallback 的 tokenizer 陷阱（primary 装得下的 prompt 在 fallback 可能超限） | ✓ 已被 `ROUTE_LEVEL_4XX` 覆盖（413 bench 本线路，自动落到更大窗口的线路） |
| **MCP 2026-07-28 规范**：sampling 弃用（SEP-2577）、Multi Round-Trip Requests（MRTR，工具执行中途 `InputRequiredResult` 问人后继续）、正式 extensions 框架 | sampling 我们没用，无影响 ✓。**MRTR 与我们 serve 审批语义同构**（问人→作答→继续），但我们的审批走 HTTP 层 + `ox_approve` 工具，已可用；升级 MCP 握手版本反而会缩小兼容客户端面 —— 维持 `2024-11-05` 握手不动 |

## 三、本轮落地

1. **HTTP 请求追踪 id 透传**（`shared/http-clients.ts`）：`postJson` 逐个探测
   `x-request-id` / `request-id` / `x-generation-id`，失败时进 `HttpLlmError.requestId`；
   错误摘要（`errorDigest`）带上 `[req=...]` —— 看板日志里看到失败即可复制 id 报障。
   字段缺席 = 端点没给，不是丢失。测试 5 条（三个头名 / 缺席 / 摘要携带）。
2. **任务活性心跳**（学 Orca 的 agent state heartbeats，修复"长任务与挂死在事件流里
   长得一模一样"的观测盲区）：`SchedulerOptions.onTaskActivity` —— 派发起点与每条
   agent 事件各触发一次，三层宿主全部接线（桌面 IPC `task-activity` 事件、headless
   协议事件、serve 广播）；`TaskView.lastActivityTs` + 看板 running 任务静默超 30s
   显示"⏸ 静默 Xs"（5s tick 走表，纯函数 `SILENCE_LABEL` 打表可测）。重新派发时
   心跳账本重置，终态任务收到迟到心跳不复活。测试 7 条。
3. **差异化叙述落档**：Vibe Kanban 的死亡把"默认 fail-closed 审批 + 零遥测"从设计
   品味变成了赛道教训 —— 写进本文档，不改代码。

## 四、参考链接（本轮新增）

- OpenRig：https://github.com/mvschwarz/openrig
- Agent Orchestrator（AO）：https://github.com/Untrivial-ai/agent-orchestrator
- Orca changelog（heartbeats / wait-for-setup / usage+account switching）：
  https://www.onorca.dev/changelog/1-4-193 、https://aicrier.com/post/4deltzojvvg178d2w02o
- Vibe Kanban 停摆评测（审批关闭 + 默认遥测的批评）：https://greenlitbooks.com/field-notes/should-you-still-use-vibe-kanban
- MCP 2026-07-28 规范发布：https://blog.modelcontextprotocol.io/posts/2026-07-28/
- LiteLLM retry_policy / allowed_fails：https://docs.litellm.ai/docs/proxy/config_settings
- 跨 vendor fallback 的 tokenizer 陷阱：https://continuumcode.ai/guides/llm-failover
