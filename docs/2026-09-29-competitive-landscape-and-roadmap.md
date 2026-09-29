# 竞品地形与 OxCommander 优化方案

> 日期：2026-09-29
> 取数方式：GitHub REST API（star / 语言 / 建库时间 / license）+ 各仓库 README 原文关键词命中统计。
> **口径声明（重要，别当能力有无的定论）**：
>
> - 「README 命中」= 该仓库 README 里出现了某维度关键词，**是"它自己宣称"的下界**，不是"它有没有做"的结论。
>   README 没写 ≠ 没做；写了 ≠ 做得好。要看真实能力得读源码，本文只对 Orca 做了一层深读。
> - OxCommander 那一列不是关键词命中，是**读本项目源码与 README 后的自评**，口径与竞品列不同，不可直接比数字。
> - star 数取于 2026-09-29 02:5x (GMT+8)，落笔即过时。

---

## 1. 结论先行

1. **赛道已经分层，且每层都有 8 万星级的占位者**：组织层 `paperclip`(92k)、壳层 `orca`(80k)、框架层 `ruflo`(73k)。
   三者都不是"和 OxCommander 同一个命题"，但都在抢同一个用户心智——**"多 agent 怎么管"**。
2. **Orca 是最直接的对位**（同为 Electron + TS + 桌面/CLI 双入口 + 并行派发），但它的 README 里
   `sandbox` `permission` `verify` `plan` `token` `budget` `PRD` 命中数**全是 0** —— 它只做「跑起来 + 看得见」，
   不做规划、不做验证、不做沙箱、不做预算。这恰好是 OxCommander 已经有东西的地方。
3. **OxCommander 的三条独有占位**：① 唯一自带 LLM 执行器（全部竞品都是 BYO 订阅）；
   ② 唯一「共享工作区 + zone 互斥」（11/12 竞品走 worktree）；③ 唯一有**变异测试门禁**自证（881/881 逐位点全杀）。
   **优化方案的主线是：把这三条从"README 里的一句话"变成"别人拿不走的证据与产品面"。**

---

## 2. 赛道地图（15 个同类项目，star 降序）

| 项目 | ★ | 语言 | 建库 | 隔离路线 | 一句话定位 |
| --- | --- | --- | --- | --- | --- |
| `paperclipai/paperclip` | 92,373 | TS | — | — | 管 AI 员工团队：**org chart / 预算 / 治理 / 审批 / 成本**看板；"OpenClaw 是员工，Paperclip 是公司" |
| `stablyai/orca` | 80,564 | TS | 2026-03-17 | **git worktree** | ADE：一条 prompt 扇给 N 个 CLI agent，比完合并赢家 |
| `ruvnet/ruflo`（原 claude-flow） | 73,439 | TS | 2025-06-02 | docker / swarm | 多模型 swarm 框架：记忆 + MCP + 自适应 |
| `BloopAI/vibe-kanban` | 28,215 | Rust | 2025-06-14 | worktree / docker | 看板驱动，"让规划与 review 更快" |
| `gastownhall/gastown` | 18,205 | Go | 2025-12-16 | worktree + 容器 | 多智能体 workspace + **持久工作追踪** + 验证门 + Bors 式二分合并队列 |
| `smtg-ai/claude-squad` | 8,540 | Go (AGPL) | 2025-03-09 | worktree + tmux | 多终端 agent 会话管理，改前可 review |
| `spinabot/brigade` | 7,380 | TS | — | crew | 有人格/凭证/记忆的 crew，组织层级决定谁能跟谁说话 |
| `coderabbitai/git-worktree-runner` | 1,784 | Shell | 2025-08-07 | worktree | 按分支自动建 worktree + 装依赖（PR review 场景） |
| `preset-io/agor` | 1,412 | TS | 2025-10-04 | worktree + **zone** | 团队指挥中心，MCP + 审计 + 失败即闭的沙箱 |
| `awslabs/cli-agent-orchestrator` | 1,355 | Python | 2025-07-29 | tmux | 层级委派（shogun → karo → ashigaru） |
| `sipyourdrink-ltd/bernstein` | 1,309 | Python | 2026-03-22 | worktree + docker | **policy as code** 治理框架 + HMAC 链式审计 + 审批流 |
| `dohooo/helmor` | 1,307 | TS | 2026-04-02 | worktree | 本地多智能体工作台 |
| `johannesjo/parallel-code` | 1,024 | TS | 2026-02-18 | worktree + docker | 三 agent 并排跑，比 diff 挑赢家 |
| `devflowinc/uzi` | 583 | Go | — | worktree | 大规模并行 CLI agent |
| `h0x91b/dev-3.0` | 299 | TS | 2026-02-18 | worktree + kanban | "一人工作室" mission control |
| **ox-commander（本项目）** | 0 | TS | 2026-09-23 | **共享工作区 + zone 互斥** | 总指挥智能体：自动拆解 → 并行下发 → 硬门禁 → 归因修复 → 交付 |

### 2.1 三条路线的事实分布

| 路线 | 采用者 | 代价（各项目自己承认或社区公认） |
| --- | --- | --- |
| git worktree 物理隔离 | 12/15 | 合并冲突消解吃掉并行收益的 30–50%（第三方测算）；多份全量副本吃磁盘；**跨模块接口改动无法协同** |
| 共享工作区 + 互斥 | OxCommander、`agor`（提到 zone） | 必须自建越权检测与回滚，否则就是"互相覆盖" |
| 组织/治理层（不管代码） | `paperclip`、`brigade`、`bernstein` | 不解决"代码怎么合"，只解决"谁批准、花多少" |

---

## 3. 能力矩阵（README 关键词命中，分子=命中维度词数）

| 项目 | 规划拆解 | 路由派发 | 隔离 | 验证门禁 | 修复循环 | 沙箱安全 | 预算成本 | 协议可编程 | 可观测 | 多端远程 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `orca` | 0/7 | 0/6 | 2/5 | 2/6 | 1/7 | **0/6** | 2/7 | 2/8 | 2/6 | **5/5** |
| `ruflo` | 4/7 | 5/6 | 2/5 | 4/6 | 2/7 | 1/6 | 4/7 | 4/8 | 5/6 | 1/5 |
| `gastown` | 1/7 | 5/6 | **4/5** | 4/6 | **3/7** | 2/6 | 2/7 | 2/8 | 3/6 | 1/5 |
| `bernstein` | 3/7 | 2/6 | 3/5 | 4/6 | 2/7 | **4/6** | 3/7 | 4/8 | 4/6 | 1/5 |
| `agor` | 2/7 | 3/6 | 4/5 | 3/6 | 1/7 | 2/6 | 2/7 | 4/8 | 4/6 | 2/5 |
| `vibe-kanban` | 3/7 | 1/6 | 2/5 | 2/6 | 1/7 | 0/6 | 1/7 | 3/8 | 3/6 | 2/5 |
| `CAO`(aws) | 2/7 | 3/6 | 3/5 | 3/6 | 1/7 | 2/6 | 0/7 | 3/8 | 0/6 | 0/5 |
| `claude-squad` | 1/7 | 0/6 | 2/5 | 3/6 | 0/7 | 0/6 | 1/7 | 1/8 | 0/6 | 0/5 |
| `dev-3.0` | 1/7 | 1/6 | 2/5 | 3/6 | 1/7 | 1/6 | 4/7 | 4/8 | 5/6 | 2/5 |
| `helmor` | 1/7 | 0/6 | 2/5 | 1/6 | 1/7 | 0/6 | 1/7 | 3/8 | 2/6 | 1/5 |
| `parallel-code` | 2/7 | 1/6 | 4/5 | 3/6 | 0/7 | 1/6 | 4/7 | 1/8 | 2/6 | 2/5 |
| `git-worktree-runner` | 1/7 | 1/6 | 1/5 | 4/6 | 0/7 | 2/6 | 2/7 | 3/8 | 1/6 | 1/5 |
| **OxCommander（自评）** | ✅ 六阶段自动拆解 | ✅ 能力路由 | ✅ zone 重叠判定 | ✅ 基线+build/typecheck/test | ✅ repair loop 按 zone 归因 | ✅ 四件套 + 四档仲裁 | ✅ 软上限闸门 | ✅ headless JSONL | ✅ JSONL 审计 + 看板 | ⚠️ 仅桌面 + CLI |

### 3.1 从矩阵读出来的三件事

- **沙箱是全赛道最稀缺的能力**：12 个竞品里 4 个 `0/6`、4 个 `1–2/6`，只有 `bernstein` 做到 `4/6`。
  OxCommander 的四件套（PathPolicy / CommandPolicy / TimeoutGate / CircuitBreaker）+ 四档仲裁，
  **在同类里是头部水平，但对外完全没讲**——README 的「安全边界」一节藏在文档中部。
- **验证门禁没人做成闭环**：`gastown`（验证门 + Bors 队列）与 `bernstein`（policy 校验）最接近，
  但没有任何一个做到「动手前先跑基线 → 失败按 zone 归因 → 重修 → 产物冒烟」。
- **多端/远程是 Orca 唯一碾压的维度**（5/5：mobile / iOS / Android / SSH / remote），
  也是 OxCommander 唯一的空白格（⚠️）。这是**最真实的短板**，不是口味问题。

---

## 4. OxCommander 的五项优势（每条给证据路径）

| # | 优势 | 证据 | 竞品对照 |
| --- | --- | --- | --- |
| **A1** | **唯一自带执行器，不依赖订阅**：SenseNova 池 = 每 key × 每模型的笛卡尔积 + 共享冷却表，429 只冷却命中线路 | `shared/providers.ts`、`shared/build-llm.ts`；README「LLM 线路池」 | **全部 15 个竞品都是 BYO 订阅/Key**。无 Claude/Codex 订阅的用户用不了它们，但能跑 OxCommander —— 这是可接入性的独占位，对国内用户 / 私有化场景是决定性的 |
| **A2** | **共享工作区 + zone 互斥，而非物理隔离**：`zonesOverlap(a,b)` 对称判定（含父子目录、大小写不敏感），越权四档处置 | `shared/glob.ts`、`shared/graph.ts`、`electron/engine/scheduler.ts`；CHANGELOG 2026-09-29「判据从同名改成重叠」 | worktree 路线**无法让两个 agent 协同改一个跨模块接口**（物理隔离 = 各改各的）；共享工作区 + 互斥可以。代价是必须自建越权检测与回滚——我们已经建了 |
| **A3** | **唯一有"验证闭环"**：动手前跑基线 → build/typecheck/test → 按 zone 归因 → repair loop → 产物冒烟 | `electron/engine/verifier.ts`、`shared/routing.ts`、README「质量门禁」20 段 | Orca 交付 N 份 diff 让人挑；OxCommander 交付一份过了门禁的。`vibe-kanban` 自己也承认"工程师的时间花在 planning 和 review 上"——我们直接把 review 的一半自动化了 |
| **A4** | **唯一自证的可信度**：变异测试 site 口径 **881/881 逐位点全杀**（51 目标，21 min），外加 20 段 `verify` | `scripts/mutation-check.mjs`、`docs/2026-09-23-mutation-site-baseline.md` | 竞品没有一家敢宣称"我的判错逻辑每一处都有断言盯着"。Orca 6,985 个 open issue 说明它跑得快但没这层。**这是对外最有杀伤力的硬证据，现在却只写在 CHANGELOG 里** |
| **A5** | **可编程而非只能手点**：headless JSONL 协议，外部宿主可驱动全流程（spec in → events out → exit 0/1/2） | `headless/`、 `docs/headless-protocol.md` | Orca 是 `orca` CLI + `orca serve`（脚本化）；协议层的可编程性意味着能进 CI、能被别的 Agent 驱动，这是"编排器之上的编排器"入口 |

### 4.1 必须诚实说出的劣势

| 劣势 | 事实 |
| --- | --- |
| 无移动端 / 无远程 | Orca 5/5，我们 0/5。长任务（5–15 min）离开工位就断联 |
| 无用量与限流可视化 | Orca 有 usage tracking + 账号热切换；我们的 `usage` 事件**连协议文档都还没写**（`docs/headless-protocol.md` 缺 `llmPool` 与 `usage`） |
| 无人知晓 | star 0 vs 92k/80k/73k。技术优势不等于被看见 |
| zone 路线是少数派 | 11/12 走 worktree。**少数派必须说清"为什么更好"，否则会被读成"没做隔离"** |
| CLI 与桌面能力不齐 | CLI 缺 `snapshotRoot`/`manifestDir`/`escalationPolicy`；桌面缺 `pause`/`resume` |

---

## 5. 优化方案

主线：**先让已有优势变成可展示的证据（P0），再补品类标配里的空白格（P1），最后做生态（P2）**。
全部为增量叠加，不动 L1/L2/L3 三层架构。

### P0 — 把优势变成证据（建议先做，成本最低、收益最高）

| # | 做什么 | 为什么（竞品对照） | 落在哪 | 验收 |
| --- | --- | --- | --- | --- |
| **P0-1** | **交付凭据（delivery receipt）**：每次 run 结束产出一份结构化报告——门禁逐段结果、验证命令与输出摘要、越权/回滚事件、token 用量、改动文件清单。可在 UI 与 headless 协议里取 | Orca 的终点是"人看 diff 挑赢家"，我们的终点应该是"一份能自证的交付"。A3 + A4 的价值全靠它外化 | `electron/engine/` 交付阶段 + `shared/` 契约 + `src/pages/board`（或新增 receipt 面板） | 新增协议事件 + 一条集成 smoke；`mutation:touched` 审新目标 |
| **P0-2** | **把 zone 路线相对 worktree 的优势量化**：用审计 JSONL 统计「越权拦截次数 / 回滚次数 / 冲突顺延的任务数 / 并行度损失」，出一张可复现的对照实验脚本 | A2 现在是主张，不是证据。少数派路线必须拿数字说话，否则被读成"没做隔离" | `scripts/` 新增统计脚本（复用 `electron/audit-log.ts` 轮转文件） | 脚本自检用例；README 引用实测数字（注明机器与任务集） |
| **P0-3** | **README 重写定位段**：把「设计定位」那一节改成「与 Orca / paperclip / ruflo 的差异表 + 各自适合谁」，并把 **881/881 site 全杀**放到顶部做可信度徽章 | 竞品 README 都在讲"你能跑多少 agent"，没人讲"你怎么知道它改对了"。这是唯一能让人停下来自看的差异点 | `README.md` | — |
| **P0-4** | **补协议文档**：`docs/headless-protocol.md` 缺 `llmPool` 与 `usage` 事件 | A1/A5 的价值依赖协议可被外部消费；文档缺字段 = 别人接不进来 | `docs/headless-protocol.md` | 与 `headless/protocol.ts` 逐字段核对（可加一条契约测试钉住文档与代码一致） |

### P1 — 补空白格（对标品类标配，避免"一比就缺")

| # | 做什么 | 对标 | 落在哪 | 验收 |
| --- | --- | --- | --- | --- |
| **P1-1** | **headless serve 模式**：HTTP + SSE 复用现有 JSONL 事件流，配一个轻量 Web 看板（复用 `src/` 的 React + vite 产物） | Orca 的 `orca serve` + 手机伴生。移动端原生 App 成本高，**Web 看板能拿到它 80% 的"离开工位也能看"的价值**，且能被 CI/远程复用 | `headless/` 新增 serve 入口 + `src/` 静态产物 | 新增一条 smoke（`scripts/`）：起服务 → 投递 spec → 收事件 → 断言退出码 |
| **P1-2** | **用量 / 限流可视化 + 账号热切换**：run 级 token、每条线路的冷却与 429 计数、剩余额度可视 | Orca 的 usage tracking + account switcher。我们有 `usage` 事件与冷却表，只差一层 UI | `src/pages/settings`（线路池页已有）+ 协议事件 | UI 断言（`@testing-library/react`）+ 协议字段断言 |
| **P1-3** | **断点续跑 + 上下文回溯**：按 `runId` 续跑未完成任务；提供"查前任 agent 的决策与改动"接口 | gastown 的持久工作追踪 + "agent 可查前任 jsonl 日志"。我们有 JSONL 审计，缺查询接口 | `electron/engine/` + `electron/audit-log.ts` | 续跑 E2E（离线零配额，复用 `smoke:offline-e2e` 路子） |
| **P1-4** | **远程执行器**：把现有 `http-bridge` 适配器扩成 remote runner（远端机器跑执行器，本地只做编排与审计） | Orca 的 SSH Worktree。我们是共享工作区，不需要 SSH worktree，但需要"算力在哪 agent 在哪" | `electron/agents/http-bridge` | 契约测试（不打真实远端，走离线桩） |
| **P1-5** | **补齐 CLI / 桌面能力差**：CLI 补 `snapshotRoot`/`manifestDir`/`escalationPolicy`；桌面补 `pause`/`resume` 与第 4 种 smoke kind | 自己的欠账，不是竞品压力。CLI 与桌面不对齐会让"可编程"这条优势打折 | `headless/run-spec.ts`、`electron/ipc.ts` | 两侧各一条断言 + `check:packaged-paths` 复查 |

### P2 — 生态与治理外延（等 P0/P1 站稳再做）

| # | 做什么 | 对标 | 备注 |
| --- | --- | --- | --- |
| P2-1 | GitHub / Linear 原生集成：从 issue 建任务、在 diff 行留批注回传给 agent | Orca、vibe-kanban | 需要 OAuth 与权限模型，先做只读 |
| P2-2 | **策略即代码**：把 `agents.d/` 的声明式思路扩到 `policy.d/`（路径/命令/预算/审批写成文件，可评审、可版本化） | bernstein 的 policy as code | 与 A2/A3 同源，是我们能做且别人没在编码场景做的 |
| P2-3 | 审批门（高风险改动停下等人确认） | paperclip 的 approvals、bernstein 的 approval | 与 P2-2 同批做 |

### 5.1 明确不做（附理由，别被带着跑）

| 不做 | 理由 |
| --- | --- |
| 转 git worktree 隔离 | 会同时失去 A2（跨模块协同）与"一份交付物"的叙事，而换来的是全赛道都在做的东西。要补的是"共享工作区的证据"，不是换路线 |
| 做 swarm 框架 | `ruflo` 73k 已占位，且它不是我们的命题（我们是"总指挥"，不是"群体智能框架"） |
| 做移动原生 App | 推送基建 + 双端发版成本远高于收益；P1-1 的 Web 看板覆盖主要场景 |
| 跟 paperclip 抢"组织/业务目标"层 | 那是管理层产品，我们的纵深在代码交付的可验证性 |
| 为了 star 数改定位 | 三个占位者的热度来自"让人跑更多 agent"，我们的价值是"让人少看 diff"。这是**不同的价值主张**，不是落后 |

---

## 6. 一句话定位建议（用于 README 顶部）

> **别的编排器给你 N 份 diff 让你挑；OxCommander 交付一份过了门禁的。**
>
> 自带执行器（不依赖订阅）· 共享工作区 zone 互斥（不是各改各的 worktree）·
> 基线 + build/typecheck/test + 归因重修 + 产物冒烟 · 沙箱四件套与四档仲裁 ·
> 判错逻辑本身有 881 处变异位点逐个证明被断言盯着。

---

## 7. 复现命令

```bash
# 竞品 star / 元数据（GitHub REST API）
curl -s https://api.github.com/repos/stablyai/orca | grep -E '"stargazers_count"|"language"|"created_at"'

# 维度命中：抓 README 原文后统计关键词（本文 §3 的口径）
# raw.githubusercontent.com/<owner>/<repo>/<default_branch>/README.md

# 本项目自身证据
npm run verify                      # 20 段门禁
npm run mutation:audit              # site 口径全量（881/881）
```
