# 多智能体编排器竞品调研：对位分析与可吸收清单（2026-09-29）

> 调研时点：2026-09-29，项目基线 `33f9336`（三元算子转正闭环）。
> 星数等热度数字来自第三方统计页，口径各异（GitTrend / ToolHunter / RepoCloud 等），
> 只用于量级判断，不做精确对比。
> 回答的问题：赛道里谁在对位、它们强在哪、哪些值得吸收进本项目、哪些刻意不跟。

## 一、本项目现状快照（对位基线）

| 维度 | 现状 |
| --- | --- |
| 编排核心 | 需求 → PRD → 任务 → **zone 互斥批次并行** → build/typecheck/test 硬门禁 → repair loop 六阶段闭环 |
| 执行器 | **自带 SenseNova LLM 池**（多 key × 多模型 failover、冷却表共享）+ Codex 等 CLI + HTTP 桥 |
| 质量门禁 | verify 20 段、1166 用例、**变异门禁 site 口径 881/881**（三元算子 2026-09-28 转正进 verify） |
| 沙箱 | 路径七级判定、命令白名单 + 元字符拦截、deadline/idle 双超时、熔断、快照回滚、仲裁四档 |
| 接入面 | headless JSONL 协议（宿主可编程驱动）、agents.d 声明式 manifest、3 类适配器 |
| 差异路线 | **共享工作区 + zone 互斥**（赛道其余全是 git worktree 隔离），README「设计定位」一节言明取舍 |

## 二、赛道格局

对位细分是「多 agent 并行编排器」。2026 年的格局：**worktree 隔离路线高度同质化**，
真正的头部差异在三家的"编排深度"上。

| 竞品 | 热度量级 | 技术栈 | 路线 | 一句话定位 |
| --- | --- | --- | --- | --- |
| Agent Orchestrator (AO) | 12k+★ | Go + TS，Apache-2.0 | worktree 隔离 + PR 流 | 编排 agent 车队从规划到 merge 的桌面工作区 |
| Vibe Kanban (BloopAI) | 20k+★ | Rust + JS | worktree 隔离 + 看板 | AI 编码 agent 的中央调度看板 |
| Omnigent (Databricks) | 9k+★ | Apache-2.0 alpha（2026-06 开源） | **meta-harness** | 把既有 harness 统一包装进治理层的控制平面 |

其余（Conductor 家族、Claude Squad、Crystal/Nimbalyst、Emdash、Baton、Bernstein、
Agent Kanban 等）均为 worktree 编排变体，无本质新意；综述见
[augmentcode 的 2026-04 评述](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
与 [openorchestrators.org 目录](https://openorchestrators.org/)（31 个项目）。

## 三、三家头部逐个拆解

### 3.1 Agent Orchestrator (AO, Untrivial-ai/agent-orchestrator)

2026-02 由 Composio 开源、6 月独立运营，30 天 +2.4k★ 的赛道顶流。
架构解析见[第三方深度文](https://xuqi2024.github.io/2026/09/01/2026-09-01-agent-orchestrator-26-coding-agent-orchestration-workspace-architecture-deep-dive)。

**值得学的三件事**：

1. **OBSERVE-UPDATE-DERIVE 三段式事实管道**：持久事实（durable facts：任务/会话/PR/CI/
   review 事件）与派生状态（derived status：看板卡片显示什么）严格分离，SQLite CDC 出
   实时事件流。看板不是"被引擎更新的 UI"，而是**从事实推导的视图** —— 天然获得崩溃恢复、
   审计重放、多端一致。
2. **反馈回环成体系**：10 个观察/回环把 CI 失败、review 评论、merge 冲突**自动路由回
   对应 agent 会话**；PR merge 自动收尾会话。协调逻辑是"事实驱动的路由"，不是人工盯梢。
3. **接入广度**：26 种 harness（Claude Code/Codex/Cursor/Aider/Goose/Copilot/Qwen…），
   靠的是"每个 harness 一层薄适配"的工厂化接入。

**它的短板（本项目的机会）**：无自带执行器（完全依赖外部订阅型 CLI）、无本地硬验证门禁
（质量靠 CI + 人审 PR）、沙箱只有 worktree 隔离这一层（无命令/路径级判定）。

### 3.2 Vibe Kanban (BloopAI/vibe-kanban)

Rust 后端 + local-first SQLite，2025 末上线、2026 年成为看板路线事实标准。

**值得学的三件事**：

1. **dev server 托管端口 + browser preview**：前端任务的验收不止 build/test —— 每个
   worker 可起托管 dev server，看板里直接预览页面。
2. **双向 MCP 集成**：看板本身暴露为 MCP server，**其他 agent 可以编程驱动看板**（建卡/
   派单/查状态），编排层自己成为 agent 生态的一个节点。
3. **同任务多 agent 赛马**：同一任务让不同 agent 各跑一份，谁好用谁 —— 用冗余换质量的
   显式玩法。

**它的短板**：验证深度止步于"跑起来看看"，无变异/覆盖级质量门禁；无命令级沙箱；
故障处理靠人工换 agent。

### 3.3 Omnigent (Databricks)

meta-harness：把 Claude Code / Codex / Cursor / Pi / YAML 自定义 agent 统一包装进
沙箱会话与统一 API。产品哲学见[官方博客](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents)。

**最值得学的一件事：有状态策略在基础设施层执行，而不是写在 prompt 里**：

- cost-budget 策略：会话每花 $100 → **暂停并要求确认**（动作发生前拦截，不是事后记账）；
- permission 策略：**"刚装了未审查 npm 包"之后的那次 git push 被基础设施层拦下**——
  无论模型有没有"记住"系统提示里的规则。原文的论证很锋利：prompt 指令无法跟踪动态状态，
  "一个 prompt instruction 不知道 agent 刚装了未审查的包"。

这正是 OxCommander 的 CommandPolicy / 仲裁层已经站住的位置——但我们的策略目前是
**无状态的**（白名单/元字符/路径判定都只看当下这一次动作），没有跨动作的状态机。

**它的短板**：alpha 阶段；不碰验证/质量（完全信任底层 harness）。

## 四、刻意不跟的（保持差异化）

| 差异点 | 为什么不跟 |
| --- | --- |
| worktree 隔离 | zone 互斥共享工作区是本项目的定位差异（智能体像真实团队在同一棵树里按目录分派），README 已言明取舍；改路线等于换项目 |
| 依赖订阅型 CLI | 自带 LLM 池执行器 + failover 是真实壁垒：429 自愈、多 key 线路、不绑定任何订阅 |
| 移动端/云 agent（AO 的多端） | 远期；桌面 + headless 的双入口已覆盖当前场景 |
| PR 流为默认交付形态 | 与共享工作区路线有张力（PR 天然配 worktree）；见 §5.7 的折中方案 |

## 五、可吸收清单（按性价比排序）

### 5.1 有状态前置策略（学 Omnigent）⭐⭐ 推荐

**映射**：`electron/sandbox/` 的 CommandPolicy/仲裁层加"跨动作状态机"——例如：
批次内出现过 `npm install <新包>` → 后续 `git push` / `npm publish` 类命令升级为
强制确认或拒绝；验证子进程白名单动态收紧。
`maxTokensPerRun` 软上限闸门可顺势升级为"动作前拦截"语义（当前是事后记账口径）。
**成本**：中。沙箱已是所有副作用的必经层，加状态查询即可，无需新通道。

### 5.2 看板状态改为「从审计事实推导」（学 AO 的 facts/derived 分离）⭐⭐ 推荐

**映射**：JSONL 审计（按 2MiB 轮转）已是 durable facts；把 `src/` board 页的状态来源
从引擎内存推送改为"审计事实推导"。免费获得：**runner 被腰斩后重开即恢复**（--real 演习
两轮都栽在进程树清杀上，这是刚需）、审计可重放验证、为多端/多消费者打地基。
**成本**：中。审计事件形状已稳定（`droppedSecretNames` 等事件流已接线），主要是加
"事件 → 状态"的纯函数推导层（正好是变异门禁喜欢的形状）。

### 5.3 同任务多执行器赛马（学 Vibe Kanban）

**映射**：`AgentAdapterV2` 适配层已统一，加"同任务 N 个执行器并行、谁先过硬门禁谁交付"
的编排模式。验收判据是现成的（build/typecheck/test 硬门禁 + 产物冒烟），比 VK 的
"人眼看谁好"更硬。token 池的用量可见性天然支持赛后归因。
**成本**：中低。调度器已有批内并发闸，加"任务级冗余组"一种批次形状即可。
✅ **已完成（2026-09-30，`e52de2a`）**：`SchedulerOptions.raceRedundancy`（默认 1 =
关闭，设置页 1–6 档）—— >1 时每任务并行派给 min(N, 可用执行器) 个**不同**执行器，
首个终态成功者赢、其余立即 abort 且静默（不污染审计/breaker/任务账），全员失败汇总
进重修；批次后的统一硬门禁照旧把关（产物正确性不靠赛马，赛马是拿 token 换时间）。

### 5.4 前端 zone 的 dev server 托管 + 探活/预览（学 VK）

**映射**：验证器 plan 机制已支持自定义命令，加预置策略"起 dev server（托管端口）+
HTTP 探活/截图留证"作为前端任务的可选验证段。与现有快照回滚兼容（预览进程要纳入
超时/清理管理）。
**成本**：低中。主要是端口托管与进程清理的工程细节。
✅ **已完成（2026-10-02）**：`SmokeCheck.devServer`（驻留进程 + HTTP 探活，2xx/3xx
即活；三道沙箱门同套；进程树无论成败都被杀掉；探活期间进程崩掉立即判死）。刻意
不做截图/DOM 断言（无头浏览器的依赖与体积不进验证链），"能打开"由 HTTP 200 钉住。

### 5.5 反向 MCP server（学 VK 的双向集成）

**映射**：headless JSONL 是"宿主 → 平台"单向；包一层 MCP server（查看板/派单/取
交付物）让 Loomy 等外部 agent 也能编程驱动。AI 交接看板项目的 `kanban_context`
工具已有成熟先例可抄。
**成本**：低。协议层都是现成的，是包装问题。
✅ **已完成（2026-10-02）**：`headless/mcp.ts` + `mcp-main.js`（`npm run mcp:serve`）——
手写 JSON-RPC 2.0 over stdio（零新依赖），五工具（ox_status / ox_receipt /
ox_events / ox_run / ox_control）如实转述 serve HTTP 面的响应；stdout 只出协议、
日志走 stderr；产物冒烟加真 stdio 握手段。

### 5.6 agents.d 预设库扩容（学 AO 的工厂化接入 + Omnigent 的 YAML）

**映射**：补常见 CLI（aider/goose/qwen-code 等）的 manifest 预设模板；考虑**兼容
Omnigent 的 agent YAML 定义格式**作为导入路径 —— 它 9k+★ 的定义格式有成为事实标准的
势头，兼容它等于免费接入其生态。
**成本**：低。manifest 校验器已在，纯数据工作。
✅ **已完成（2026-10-02）**：补 aider / goose / qwen-code / gemini-cli 四个 CLI
预设（标注"未在本机实测，接入前 --help 核对"）；Omnigent YAML 兼容导入暂不做
（YAML 解析引入新依赖，价值未到）。

### 5.7 远期：PR/CI 生命周期的折中版（学 AO）

共享工作区路线下不做"每 agent 一个 worktree/PR"，但可以：交付过硬门禁后**可选**导出
`分支 + commit + PR`，CI 失败回流 repair loop（按 zone 归因重修已有）。本地硬门禁
先行、PR 流程只做分发层 —— 与 AO 的"PR/CI 推导一切"形成互补卖点。
**成本**：高（git 集成、远端凭据、回流路由都是新面），暂列远期。

## 六、结论

赛道在 2026 年已从"能不能跑"卷到"怎么协调"，但**协调深度与验证深度是两个正交轴**：
AO/VK/Omnigent 在协调轴上远超本项目，在验证轴上（变异门禁、命令级沙箱、硬性验证文化）
全部空白。上述清单里 5.1/5.2 直接加厚护城河，5.3-5.6 是低成本补协调轴短板，
都不动"共享工作区 + 自带执行器"的根基。

## 附：主要参考链接

- AO 仓库：https://github.com/Untrivial-ai/agent-orchestrator （Apache-2.0，Go+TS）
- AO 架构深度解析：https://xuqi2024.github.io/2026/09/01/2026-09-01-agent-orchestrator-26-coding-agent-orchestration-workspace-architecture-deep-dive
- Vibe Kanban 仓库：https://github.com/BloopAI/vibe-kanban （Rust+JS）
- VK 评述（含赛马/双向 MCP）：https://aicoolies.com/reviews/vibe-kanban-review
- Omnigent 官方博客：https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents
- Omnigent 策略层分析：https://www.c114pro.com/ai/171798.html
- 赛道综述（9 编排器对比）：https://www.augmentcode.com/tools/open-source-agent-orchestrators
- 编排器目录：https://openorchestrators.org/
