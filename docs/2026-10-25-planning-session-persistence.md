# 规划会话持久化 · 立项调研（竞品刷新排期第 4 项）

日期：2026-10-25
出处：[docs/2026-10-25-competitor-refresh.md](2026-10-25-competitor-refresh.md) §五 排期清单第 4 项
（动引擎、单独立项）；竞品侧对位是 Orchestrator.inc 的**常驻规划智能体**——
项目级规划对话持久化（目标 / 决策 / 约束 / 历史），并与 live 状态（worker / PR / CI）合流。

口径：本项目侧是**读源码后的自评**，行号写的是落笔当天的事实；竞品侧只有 README 与
release notes 的宣称下界。这份文档是**立项调研**，不是设计定稿 —— 它要回答的是
"该不该做、做哪一形态、代价在哪、边界在哪"，好让下一次动手不必从零重推。

---

## 一、现状（读源码）

### 1. 规划的输入只有一个字符串

- 项目记录里跟规划有关的只有 `requirement`（`electron/store.ts:15`），**每次规划用它当前的值**；
  PRD 落在 `prdJson`（`electron/store.ts:17`），批次与冒烟清单同生共死（`:18`、`:20`）。
- 规划入口 `orchestration:planning`（`electron/ipc/orchestration.ts:219`）→
  `engine.generatePrd(rec.requirement, workspaceRoot(projectId))`（`:226`）→ 落回 `prdJson`。
- **覆盖式、无历史**：重新规划一次，上一份 PRD 与它当时的理由就没了。`receiptJson` 是
  刻意不清的那一个（`electron/store.ts:21-26`），因为它是"上一次运行的结论"而不是"下一次的输入"。

### 2. 规划提示有三个入参，没有一个是"上次"

`buildPrdPrompt(userRequirement, externalContext?, conventionsBlock?)`（`shared/prompts.ts:60`）；
分解提示更窄，只吃 PRD（`shared/prompts.ts:111`）。于是"为什么这么拆"从不进入下一次规划。

### 3. 跨 run 已经能带进上下文的东西（做过的不必重做）

| 通路 | 位置 | 形态 |
| --- | --- | --- |
| 项目约定 `OX.md` / `AGENTS.md` | `shared/project-conventions.ts`（上限 `MAX_CONVENTIONS_CHARS`，超限说破） | **人写的静态文件**，进规划与执行两处 |
| 外部上下文 `settings.contextSources` | `shared/types.ts:484`、`shared/prompts.ts:12` | 只读拉 GitHub issue / PR / diff 行批注，声明为**不可信数据** |
| 执行器成功率总账 | `electron/sandbox/circuit-breaker.ts` | 跨 run 的**统计量**，不是语义 |
| 技能目录 / MCP | `electron/ipc/skills.ts` 等 | 能力面，不是项目记忆 |
| 审计事实 | `electron/audit-log.ts:6`（`run-start` / `stage` / `batch-*` / `receipt` / `automation`） | 有"跑过什么、结果如何"，**没有 PRD 内容、没有规划期决策** |

### 4. 交互式会话已经有一套真持久化，但它与规划是两条不相交的线

- `ChatSessionStore` 按 `projectId` + `sessionId` 落盘，快照含 meta（会话 id、根路径、
  起止时间、轮数、运行档、provider / model、用量）与对话条目（`shared/chat-events.ts:62`、`:101`）；
  通道有 `chat:new` / `latest` / `list` / `resume` / `fork` / `revert` / `export`。
- 恢复时喂给模型的是**全量模型消息**（`electron/ipc/chat.ts:370`），靠上下文压缩兜住长度：
  阈值 `DEFAULT_MAX_PROMPT_TOKENS = 48_000`、保留尾部比例 `DEFAULT_KEEP_TAIL_RATIO = 0.5`
  （`electron/chat/session.ts:112`、`shared/chat-compress.ts:98`），压缩后的摘要**没有独立持久字段**，
  落盘的就是被替换过的 `messages` —— 也就是说"对话里曾经有过什么结论"在压缩后不再可核。
- 但：**chat 不喂 PRD，PRD 不读 chat**。规划页（PRD 编辑走 `orchestration:update-prd`，
  `electron/ipc/orchestration.ts:236`）与会话页各自独立。

**一句话结论**：我们有**对话历史**，没有**规划记忆**；有"每次 run 的现场"，没有"为什么这么拆"。

> 顺带核实到的一条（**不属于本项**，标出来给下一个读的人）：断点续跑的 journal 桌面端
> **只写不读** —— 快照照常落 `userData/runs/<projectId>.json`（`electron/ipc/context.ts:453`），
> 但 `execute` 只收到 `{ smoke }`（`electron/ipc/orchestration.ts:212`），读回那条路在
> headless（`headless/run-spec.ts:317`）。桌面是否**有意**不做中断续跑，需要单独核实；
> 这里只记事实，不当结论用。

## 二、缺口值多少（代价要能观察）

1. **隔天/换人再跑，理由不可查**：需求一改，上一版 PRD 与当时的取舍（zone 怎么切、契约口径
   怎么钉）全没了，只能凭记忆重推 —— 而重推的结论未必与上次一致（同样的分歧会再吵一遍）。
2. **重修的教训只在 run 内**：`repairHistory` / `lastErrorDigest` 活在本次运行里
   （`shared/types.ts:146-158`），下一次从零开始。同类失败（zone 覆盖不全、契约留白）
   会重复烧配额 —— 这是 repair loop 已经在做但只做在半条路上的事。
3. **变体竞争（B4）与验收口径的取舍没留痕**：门禁挑了哪个变体、为什么，只在那一轮的 digest 里。
4. **竞品那一格是真的**：Orchestrator.inc 把"目标 / 决策 / 约束 / 历史"做成项目级常驻，
   我们的对位物是"一个 requirement 字符串 + 一份会被覆盖的 PRD"。

## 三、三种形态（按改动面从小到大）

### A. 项目级规划备忘（推荐先做）

- **形态**：项目根一份**人可读**的结构化备忘（例如 `OX-PLAN.md`，或 `OX.md` 里一个约定段），
  规划与执行时注入。它与 `OX.md` 的区别只是**内容层次**：`OX.md` 讲"这个项目的规矩"，
  备忘讲"这一版我们决定了什么、为什么、被否掉了什么"。
- **判据（沿用 `project-conventions` 那三条纪律，一条不改）**：marker 可辨认、总量上限、
  超限说破；缺席是常态、零副作用；"背景不是合同"的声明保留。
- **成本**：`shared/` 一个纯函数 + 一个 store 字段（或复用约定读取）+ 两处注入点
  （`generatePrd` 与任务 description 构造）＋ 变异登记。**不动引擎结构**。
- **风险**：备忘会随轮次越写越长 → 上限与"说破"必须一起上；写进备忘的东西是**人写的**，
  与 OX.md 同一信任级（不需要 `externalContextBlock` 那套不可信围栏）。

### B. 规划历史（A 之上加事实）

- **形态**：每次规划落一条快照（requirement + PRD + 决策摘要 + 结果指向），保留最近 N 条；
  下一次规划注入"上一版的摘要与这次的差异"。数据源可以是项目 store 的新字段，
  也可以复用审计事实（**注意审计里今天没有 PRD**，要新增 `phase`）。
- **价值**：回答"上次为什么这么拆"和"这次改了什么"，且**可核**（落盘事实，不是模型自述）。
- **成本**：中等。新 `phase` 进审计意味着 `AuditPhase` 与逐段文档、门禁数字一起动。

### C. 规划会话（把规划变成有状态对话）

- **形态**：规划不再是"一次生成 PRD"，而是一次可续的会话（复用 chat 那套持久化与追加指令），
  结论固化成 PRD。
- **为什么单独立项**：它与本项目"**一次一派、结论靠门禁**"的取舍正面相撞 —— 常驻会话是
  worktree 路线的特产（每 worker 一个 branch + 一个能 attach 的终端），我们没有那个形态，
  硬搬会把"交付物只有一份、判据只有一门"的地基换成"对话里说什么算什么"。
- **结论**：**不做**。要的是"记忆"，不是"常驻"。

## 四、如果做 A（边界先写清楚）

- **记忆是提示，不是证据**。交付是否可信仍由门禁、凭据与指纹回答；备忘写错了，
  影响的是规划的起点，不能影响"这份交付过没过门禁"。
- **必须补一个总量上限**：规划提示今天只有**分源**上限（约定 8000 字符、
  外部上下文每份 8000，`shared/project-conventions.ts:28`、`electron/context/github-readonly.ts:46`），
  **没有总预算常量**（装配顺序为 约定 → 外部上下文 → 需求，`shared/prompts.ts:92`）。
  再加一路"记忆"而不立总量，等于允许三者相加无限长 —— 这是这份调研里唯一一处
  **现在就存在的判据缺口**，做记忆时一并补上（超限说破，沿用约定那一套措辞）。
- **绝不让模型自己改备忘**（不做"自动学习"）：把模型的推测固化进下一次规划，等于给
  漂移装上加速度。自动那一侧只允许汇总**可核事实**（例如"上次 red 在哪个验证命令"），
  且必须标明来源。
- **不跨项目共享**：项目边界就是信任边界（与本仓库 zone / 工作区的一贯口径一致）。
- **不整段喂 chat 转录**：token 与噪声都不可控，且会话里有过期结论 —— 人的结论要进备忘，
  得由人自己写进去（或由他在会话里显式"存为决策"）。

## 五、建议

1. **先做 A，形态是文件而不是数据库**：零架构改动、可人读可 diff、与 `OX.md` 同一套读取与
   上限纪律（连测试都能复用 `project-conventions` 的形态）。
   → **已于 2026-10-25 落地**：`shared/plan-memo.ts`（`OX-PLAN.md` 的块格式与截断）、
   `electron/engine/conventions.ts` 的 `readPlanMemo`、规划（`generatePrd`）与执行
   （`scheduler.runBatch` 的 description）两处注入，以及背景块总预算
   `MAX_BACKGROUND_CHARS = 24000`（超预算从后往前退让并说破）。逐位点 9/9 全杀。
2. **A 落地后再评估 B**：B 的增量价值在"可核的历史"，而它需要动审计 phase 与文档四同步，
   单独一笔做。
3. **C 不做**（理由见 §三.C，与 D 类"明确不补"同源）。
4. **需要维护者拍板的一件事**：备忘的所有权 —— 只允许人写（最保守、判据最干净），
   还是同时允许平台把**可核事实**（验证失败命令分布、zone 冲突次数）自动汇总成一段只读摘要。
   后者不是"学习"，是"把已有的账摆到规划面前"，但它会让注入内容随 run 变化，
   削弱"同一条需求 → 同一份提示"的可复现性。
   → **已落地的版本按最保守口径实现**（只允许人写，`formatPlanMemoBlock` 的注释里写死了
   "平台不自动写"）。要不要加自动汇总，仍是待拍板项。

排期建议：**排在预览浏览器 profile 隔离（C3 剩余半，已落地）之后、SDK（C8）之前**；
它与 A/B 类的分发工作互不依赖。
