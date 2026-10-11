# 竞品刷新 2026-10-11（第四轮）

> 方法与前几轮一致（见 [2026-09-29-competitor-research.md](2026-09-29-competitor-research.md) 的吸收方法论）：
> 不重做全景，只做「赛道新动态补记 + 标准特性逐条对照」，**只吸收真空白**，
> 每条吸收要求动机可追溯。本轮取数以公开网络检索为主（GitHub 项目近况、对比评测），
> 未做逐项目源码深读——宣称口径的下界照旧成立：README 没写 ≠ 没做。

## 一、赛道新动态（2026-10-04 → 10-11）

| 动态 | 内容 | 对本项目的含义 |
| --- | --- | --- |
| Orca（stablyai）站稳 ADE 叙事 | 「ADE（Agent Development Environment）」成为独立品类名；Orca 桌面 + 手机 + 远程 runtime + swarm CLI，第三方对比文把它与 Conductor 并列为 ADE 双子 | 「监督 agent 与写代码是两种工作」的品类叙事与我们「总指挥」定位同向；serve + MCP 已覆盖其「离开工位能看/能派」的格子 |
| Conductor / Podium 新入 | Conductor：开源 ADE、每任务一 worktree、**Mac only**；Podium：HN 自述的新 ADE | worktree 多数派继续扩员（13/16），不改判定：共享工作区 + zone 互斥的差异化在「跨模块协同改接口」与「一份可自证的交付」 |
| paperclip 预算面成型 | 第三方评测点名它的 **per-agent spending limits with automatic throttling**——预算执行到单个 agent 粒度并自动节流 | **真空白**：本项目预算只有 run 级 `maxTokensPerRun`，agent 级无上限、无节流 → 本轮吸收（见 §三.2） |
| ruflo v3.6 federation + 记忆 | 跨机器实例联邦（5 月 stable）、adaptive memory / 自学习叙事继续 | federation 不吸收（中心化编排，无多实例痛点）；「记忆」可落地的一格是**路由的历史成功率跨 run 保留**——本项目它只活在进程内存里，headless 每 run 归零 → 本轮吸收（§三.3） |
| agentguard-llm loop 检测 | 弹性库生态把 agent 循环检测列为标准特性（10-02 刷新曾判「部分覆盖，暂不单做」） | 挂起项转正：repair 轮上限与 chatJson 重试上限都不是「卡死在重复输出上」的检测 → 本轮闭环（§三.1） |
| Orca scheduled automations | 定时/触发式自动化运行（dev.to 介绍其 agent 可自建定时任务） | 真空白，**本轮不做**：需要调度器、错过触发补跑、持久化三件套，工程量一整轮；列入下一候选（§五） |

## 二、逐条对照表

| 标准特性 | 本项目现状 | 判定 | 本轮动作 |
| --- | --- | --- | --- |
| agent 循环检测 | repair 轮上限 / chatJson 重试上限，无重复输出检测 | **真空白**（10-02 软挂起项） | ✅ 吸收：LoopDetector（§三.1） |
| per-agent 预算 + 节流 | run 级 maxTokensPerRun；agent 级无；`AgentEventV2.usage` 有字段无通路 | **真空白** | ✅ 吸收：limits.maxTokens + 预算闸（§三.2） |
| 历史"记忆"跨 run | 成功率只在本进程内存（桌面跨 run、headless 每 run 归零） | **真空白**（映射 ruflo 记忆到路由质量分） | ✅ 吸收：熔断器总账持久化（§三.3） |
| 定时/触发自动化 | 无（serve 只有一欠两还的 run 投递） | 真空白 | ✅ 同日第五轮吸收（§六） |
| 跨机器 federation | 远程执行器走 http-bridge（边界已说破） | 冲突取舍：中心化编排无多实例对等问题 | ❌ 不吸收（维持 10-03 对 OpenRig 的判定逻辑） |
| Omnigent YAML 导入 | agents.d JSON 预设库 | 低价值（条件触发：等其格式成事实标准） | ⏸ 维持原判 |
| PR/CI 折中版（5.7） | 交付凭据 + 复核工具，无 PR 导出 | 真空白（三份文档连续点名的大项） | ✅ 本地半边同日第六轮吸收（§七）；远端半边（push/PR/CI 回流）留待 |
| GitHub/Linear 只读集成（P2-1） | 无 | 真空白，P2 层 | ⏸ 维持 |
| worktree 隔离 / swarm / 原生移动端 | — | 冲突取舍 | ❌ 维持不吸收 |

## 三、本轮吸收（三项，全部增量叠加、不动三层架构）

### 1. 循环输出检测（闭环 10-02 软挂起项）

- **来源**：agentguard-llm 的 loop 检测（弹性库品类标准特性）。
- **盲区**：idle 超时只抓「不出声的挂死」；**在出声但原地打转**的 run（同一行日志反复刷）
  每条事件都在续约心跳、idle 永远不到、deadline 要烧满才收场——agent 活着，token 与墙钟在空转。
- **实现**：`electron/sandbox/loop-detector.ts`（纯函数判定器）+ scheduler `collectToTerminal` 挂载
  （与 ActionGate 同一观察面）。每**一次派发**一个检测器（作用域 = 单 run，无需 reset 接线）。
  判据刻意保守：连续且 trim 后**逐字相同**的长行（默认 8 条、每条 ≥16 字符）才判——
  行内数字不抹平，带时间戳的心跳是"活着"的证据。触发即 abort 本 run，
  digest 写 `[loop]` 与触发行，`FailureClass` 新增 `"loop"` 档（types/audit-log/BoardPage 同步）。
- **配置**：`SchedulerOptions.loopDetection`（`false` 关闭；缺省默认参数开启，装配即生效）。
- **已知边界**：交替两行的循环（A B A B）不判——滑窗指纹的误伤面大，v1 只抓最便宜的单行空转；
  误判代价可控（digest 写明原因，任务进修复轮，路由可换执行器）。
- **测试**：`src/loop-detector.test.ts` 11 条 + scheduler 集成 2 条；site 口径 5/5 全杀。

### 2. per-agent 预算闸（学 paperclip 的 budget + throttling）

- **来源**：paperclip 第三方评测点名的 per-agent spending limits with automatic throttling。
- **实现**：`AgentLimits.maxTokens`（manifest 可选声明，最小 1000）→ 内置执行器在 client 边界
  包计数器把本 run 每次调用的上报 token 累起来、终态事件带 `usage`（`RunSession.push` 加通路，
  消费了契约里一直无通路的 usage 字段）→ scheduler 每 agent 记账 → `admitBudget` 链在
  admitBreaker 之后：累计上报到达上限的 agent 本 run 不再接新单（**节流的是派单，不是杀 run**，
  与 run 级 maxTokensPerRun 同为软上限）。跳过动作经 `onBudgetGate` 可观测，
  no-agent 的 digest 写明「预算闸跳过：谁、到了多少」。
- **诚实边界**（与 run 级预算同一口径）：只看得见执行器主动上报的用量——内置执行器真实上报；
  CLI/HTTP 桥不报就没有约束力，这是事实不是缺陷。点名路径不过闸（与熔断同语义：显式意图优先）。
- **测试**：manifest 校验 1 条 + scheduler 集成 5 条（改派/全超/no-agent 归因/点名豁免/
  onBudgetGate/兜底双闸）；scheduler site 42/42、index 10/10、sensenova 39/39 全杀。

### 3. 成功率跨 run 持久化（ruflo「自适应记忆」的对位物）

- **来源**：ruflo 的 adaptive memory 叙事——映射到本架构里真实存在的一格：路由给历史成功率
  打分（quality × successRate），但这份账只活在进程内存里。
- **实现**：`CircuitBreaker` 接 `CircuitPersistence`（load/save 总账）：构造时恢复
  **只恢复总账**（successes/failures），`consecutiveFailures` 归零、一律 closed 起步——
  恢复的是"历史上靠不靠谱"的先验，不是"上一 run 挂没挂"的结论。每次 record 写回；
  总账超 500 按比例淡出（先验要能被新事实改写）。桌面端装配 `userData/agent-stats.json`
  （`ensureAgentLayer`），headless 经 `PlatformHost.agentStatsFile` 显式给路径才接
  （每 run 独立进程，默认不接——说破的事实边界）。文件持久化走 `atomic-file`
  原子写；坏账（缺文件/损坏/形状不对）一律从零开始，账本是增强不是权威。
- **测试**：`src/breaker-persistence.test.ts` 9 条 + 装配 2 条；circuit-breaker site 26/26 全杀。

## 四、门禁数字同步

- 在册目标 66 → **67**（新增 `electron/sandbox/loop-detector.ts`，tier 1）；
  site 基线 1379 → **1405**（本轮新增 26 处位点，全部逐点验证全杀）。
- 用例数 1794+8 → **1827+8**（合计 1835；本轮净增 24 条 + 当日早前 2 条，跳过档不进 list 收集）。
- 本机按 `--file=` 分档逐目标跑 site 审计（12 个改动目标全部 100%），
  全量 site 审计仍交 CI（2026-10-11 早前记录：本机 Windows 跑不动全量）。

## 五、刷新后剩余清单（更新版）

| 项 | 状态 |
| --- | --- |
| 5.7 PR/CI 折中版 | ✅ 本地半边同日第六轮落地（分支 + commit，settings `exportDeliveryBranch`）；push/PR/CI 回流留作远端半边 |
| P2-1 GitHub/Linear 只读集成 | P2 层待办 |
| 定时/触发自动化（Orca scheduled automations） | ✅ 同日第五轮落地（见 §六） |
| loop detection 专项 | ✅ 本轮闭环 |
| Omnigent YAML 导入 | 条件触发（维持） |
| 云 agent / 原生移动端 | 远期（维持） |

## 六、同日加轮：serve 定时运行（第五轮，2026-10-11）

§二对照表里唯一剩下的「真空白、可落地」项——Orca 的 scheduled automations——
当天就做掉了。形态与边界：

- **入口**：`serve-main --every=<间隔> --spec=<spec.json> [--schedule-state=<文件>]`。
  触发 = **自 `POST /run`**（127.0.0.1 自调用）：单 run 语义、409、SSE 广播、鉴权零改动
  复用，serve.ts 一行未改——调度环不自带任何绕过既有门的路径。
- **纯逻辑**：`headless/schedule-core.ts`（间隔/参数解析、补跑判定、忙时重试间隔），
  调度环在 serve-main 里以注入式时钟/fetch 承载，测试手动泵驱动（不 sleep）。
- **调度语义**（刻意简单，边界说破）：首次触发在一个间隔之后；忙时跳过不积压
  （不计已触发，min(间隔, 30s) 短重试）；中断补跑至多一次（补最近错过的一次，
  不积压补齐）；状态文件坏账按"从未触发"处理。
- **site 审计逼出的两个真缺陷**：`Number.isInteger(1e25)` 是 true——溢出闸改
  `Number.isSafeInteger`，并补 Node setTimeout 上限（约 24.8 天）第二道闸；
  `Number.isFinite` 对 JSON 边界是死防御（等价变异，实证后删除留注）。
- **门禁数字**：在册目标 67 → **68**；site 基线 1405 → **1437**；测试 +16 条
  （src/schedule-core.test.ts，全绿）；schedule-core 21/21、serve-main 28/28 全杀。

## 七、同日加轮（第六轮）：交付后 git 导出——5.7 的本地半边

§二对照表里最后一个可落地项当天收掉一半。5.7 的完整形态是"本地硬门禁先行 →
可选导出分支 + commit + PR → CI 失败回流 repair loop"；本轮落地**本地半边**：

- **开关**：settings `exportDeliveryBranch`（缺省关）。交付过硬门禁后，把本次 run
  的 zone 内改动导出成 `oxcommander/delivery-<时间戳>` 分支 + commit，日志带
  分支/commit/文件数；失败只写 `[git-export] 失败（不影响交付）`。
- **归属口径**：commit 只收落在任务 zone 内的路径（porcelain -z → zone 过滤）。
  zone 内既有未提交改动会一并进 commit——边界写在 settings 注释里：要干净导出，
  从干净工作区起跑。zone 外的操作者脏文件绝不碰。
- **纪律**：每条 git 调用过 CommandPolicy 拒绝地板（push/reset/config… 对自己的
  导出同样生效）；元字符怪文件名单条跳过不拖垮导出；commit 身份缺失走一次性
  `-c` 兜底，绝不写仓库配置；引擎保持零 spawn 依赖（导出由 platform 注入）。
- **远端半边（push / PR / CI 回流）留待**：需要远端凭据与回流路由，是独立的
  信任面；v1 的导出物已经可以被操作者手动 push/建 PR。
- **门禁数字**：目标 68 → **69**（git-export，tier 1）；位点 1437 → **1469**；
  测试 +22（git-export 16 + orchestrator 接线 6）；四个改动目标 site 全杀 100%。
