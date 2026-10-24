# 竞品刷新 2026-10-25（第六轮：本周热点深读 —— Orchestrator.inc 与 Ringer）

> 前五轮（09-29 / 10-02 / 10-03 / 10-11 / 10-17）见各自日期文档。10-17 之后 A/B 类与
> C1/C2/C4/C6/C7 已全部落地（见 10-17 文档的闭环标注），本轮口径回到**刷新**：
> 深读本周 GitHub 热门榜上与本项目同赛道的两个项目，逐项判定吸收 / 排期 / 不做。
>
> **口径声明（与前几轮一致）**：
> - 竞品侧取官方 README 与 GitHub Releases 原文（2026-10-25 经 API 拉取；下界：README
>   没写 ≠ 没做；写了 ≠ 做得好）。
> - 本项目侧是读源码后的自评。
> - star 数取于 2026-10-25（Orchestrator.inc 13.6k · Ringer 303），落笔即过时。

---

## 一、本周热点盘点（检索于 2026-10-25，GitHub trending 区间一周）

本周赛道的主导趋势是 **meta-harness**：管理"多编码智能体并行"的壳。同类上榜：

| 项目 | 热度事实 | 一句话定位 |
| --- | --- | --- |
| [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)（Orchestrator.inc） | 13.6k★，2026-02 建仓，v0.14.6 **昨天**（10-24）发布、nightly 日更，本周 trending | "Plan, run and supervise agent teams from task to merged PR"，桌面端（三平台）+ 手机 App，40+ 执行器 |
| [NateBJones-Projects/ringer](https://github.com/NateBJones-Projects/ringer) | 303★，本周 trending | 并行 swarm："贵模型规划与评审，便宜 worker 干活"；**不采信 worker 的自述**，跑 check 命令定胜负；Ringside HUD 自动弹出 |
| [awesome-cli-coding-agents](https://github.com/bradagi/awesome-cli-coding-agents) | 目录类，本周更新 | 150+ CLI 编码智能体清单 —— 生态面事实源 |

（Orca / superset / cezar 本周无新发布可读；上一轮结论仍有效。）

## 二、Orchestrator.inc 深读（对本项目最有对照价值的一个）

**它与我们的根本分野**：worker = 一个任务 + 一个执行器 + **独立 branch+worktree** +
**常驻会话**（attach 终端、续对话）；我们 = 共享工作区 + zone 互斥 + 一次一派。它的终点是
**merged PR**，我们的终点是**过了门禁的一份交付 + 凭据**。这个分野不变，吸收的是它的
**运营面**。

逐项判定：

| 它的长处 | 本项目现状 | 判定 |
| --- | --- | --- |
| **40+ 执行器**（claude/codex/cursor/opencode/aider/copilot/grok/kimi/pi/amp/auggie/droid/crush/cline/goose/qwen/continue/devin/kiro/kilocode/…） | 探测表 5 个 + 仓内还有 8 份未接线的 example 模板 | **本轮吸收一格**：qwen-code 接进探测表（见下）；opencode/crush/amp 考察过——安装命令可核实但**无头用法未见于官方 README**，按 goose 判例不接 |
| **常驻规划智能体**：项目级规划对话持久化（目标/决策/约束/历史），规划上下文与 live 状态（worker/PR/CI）合流 | 规划是 per-run 的 PRD + 评审页；chat 有线程但不与 run 规划打通 | **排期**：规划会话持久化（跨 run 记住"为什么这么拆"）——动引擎层，单独立项 |
| **Kanban 四泳道**从 PR/CI/评审事实派生（Working / Needs you / In review / Ready to merge） | 看板有状态派生（board-derive）+ 升级卡 + 通知判据，但泳道语义没有"Needs you"这类**注意力分组** | **排期（小）**：看板按"该你了"聚合（待审批/失败 CI/缺输入）——纯派生层改动 |
| **评审反馈回给同一个 owner**（requested changes → 原 agent 会话） | CI 结论只回流不自动重修（刻意）；人在回路有"带话重派"（附言下一次派发生效） | **不做架构改动**：一次性派发模型下"带话重派"已是等价物；常驻会话是 worktree 路线的特产 |
| **每 worker 隔离浏览器**（临时 profile 隔离 / 命名 profile 复用 cookies） | dev server 探活 + 页面冒烟 + 系统浏览器打开预览（C3 半闭） | **排期（中）**：会话/预览的浏览器 profile 隔离 —— C3 的下一半 |
| 手机 App（iPhone/Android） | 无 | **不做**（10-17 D 类已有结论：serve Web + 通知覆盖主场景） |
| 7 语言 README、nightly 日更 | 中英双语、release 按 tag | 语言扩面**暂缓**（受众先验证再说）；nightly 无此需求 |

**本周发布逐条扫**（v0.14.6 + nightlies）：会话中途换执行器、chat 内渲染 html、滑动合并 PR、
worker 更新进 orchestrator chat 行、clone 失败恢复、孤儿 daemon 身份确认后才停 —— 全是
运营体验打磨，无架构新意，无吸收项。

## 三、Ringer 深读

定位与我们**命题同源**（"parallel agents that prove their work"），规模小但三个想法值得记：

1. **角色分工定价**："贵模型写 spec 与评审、便宜 worker 干活" —— 我们的能力路由 +
   LLM 池已支持（规划模型 ≠ 执行模型），**已有**；差的是把它写成**默认推荐配置**而不是
   用户自己想到 —— 记入产品叙事，不改代码。
2. **不采信 worker 自述，跑 check 定胜负 + 失败带上下文重试一次** —— 我们的硬门禁 +
   repair loop（多轮、按 zone 归因）**已强于它**（它只重试一次）。这一格我们领先。
3. **Ringside HUD**：每次 run 自动弹本地网页、live 展示所有 swarm、token 燃烧、历史版本库
   —— serve 状态页 + SSE + usage 事件已覆盖大半；"**run 开始自动打开状态页**"是廉价好点子，
   **排期（小）**：serve/headless 加 `--open`（或事件提示 URL），不进桌面端默认行为。

## 四、本轮实际吸收（已落地）

**Qwen Code 接进执行器探测表**：仓内 `agents.d/qwen-code.example.json` 模板早已存在
（随 resilience 提交进仓）但一直没接进 CANDIDATES —— 属于"模板先行、探测没跟上"的欠账。
本轮补接线，并补核实：无头形态 `qwen -p "..."` 与安装命令 `@qwen-code/qwen-code`
均逐字核实于官方 README（2026-10-25）。守卫测试（候选表 ⇔ 模板逐条比对）自动钉住两源。

**考察过但明确不接的**（记录判据，防止下次重查）：
- opencode / crush / amp：安装命令可核实，但**无头（一次性传 prompt）用法未见于官方 README**
  —— 按 goose 判例（"没核实就不给"），接进探测表等于给用户一份可能必红的参数。
  下次刷新若其文档补齐无头用法，再接。

## 五、排期清单（按投入产出排）

1. 看板"该你了"注意力分组（纯派生层，小）
2. serve/headless run 开始时打印/打开状态页 URL（小）
3. 会话/预览浏览器 profile 隔离（中，C3 剩余半）
4. 规划会话持久化（动引擎，单独立项）

## 六、数字与事实的来源

- Orchestrator.inc：README + v0.14.6 release notes（GitHub API，2026-10-25）
- Ringer：README（GitHub API raw，2026-10-25）
- qwen-code：README（GitHub API raw，2026-10-25）—— 安装与 `-p` 均逐字引用
