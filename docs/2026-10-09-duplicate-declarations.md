# 2026-10-09 「同一概念的多处声明」清单（第一轮：列全 + 标状态）

> 起因：`docs/2026-10-05-full-audit.md` §7 记的待办 ——
> 「两处写着一个意思、用着不同判据」**静态门禁查不出来**：两边的代码都正确，
> "意图相同"这件事本身不可静态判定，只能靠人成对地看。值得做的是**先列出所有
> "同一概念的多处声明"**，再逐对看。本文件是那份清单。
>
> 本轮只完成**列全 + 标状态**；逐对**处置**另起一轮（清单里已标优先级）。
> **2026-10-09 已落地第一批处置**：第 3 / 4 / 6 / 12 项 + 盲区补扫（见文末「下一步」与
> `CHANGELOG.md` 的「优化（清单收口 · 2026-10-09）」）。

## 口径

"同一概念的多处声明" = 一个语义概念在全仓有**两处以上互不引用的独立声明**：
可以是两个类型、类型 + 值域数组、或同一个默认值散落多处。判据不一致有三态：

- **值域不同**（一边 4 档一边 5 档）；
- **约束强度不同**（一边有运行时收窄、一边没有）；
- **只散落**（值相同但没有单一真源 ⇒ 改一处漏两处）。

**现有门禁能兜住的部分**：`check:exhaustive-maps` 管"以联合类型为键的映射表
与穷尽 switch"逐档登记。**它管不了**"两处并列的类型声明"和"散落的默认值"。

**它的盲区**：联合类型**含非字面量成员**（`string` / `undefined` /
对象）时整体跳过。⚠️ 计数口径已修（2026-10-09）：此前 `--list` 只打印数量、
且 `skipped` 跨 tsconfig 重复计 —— 实测虚报成 **19/20 处**；改为按 `文件:行`
去重并列出后是 **11 处**，人工过完收口 2 处（`STAGE_LABELS` / `RECEIPT_TASK_ICON`），
余 **9 处** 是真正动态键。详见文末「下一步」第 4 条。

## 清单

| # | 概念 | 声明处 | 形态 | 是否同源 | 状态 |
|---|---|---|---|---|---|
| 1 | 仲裁模式 | `shared/types.ts:259`（类型，4 档）· `headless/protocol.ts:237`（值域数组） | 类型 + 数组 | ✅ 数组引类型 | ✅ 有门禁（`check:exhaustive` 管 switch）+ 协议层运行时校验 |
| 2 | **默认仲裁模式** | 三处入口共用 `shared/types.ts` 的 `DEFAULT_ARBITRATION_MODE`（`DEFAULT_SETTINGS` / `BatchGuard` 构造兜底 / agent 层装配） | 常量（单一真源） | ✅ 已收口 | ✅ **2026-10-09 收口完成**（清单里第一项落地的） |
| 3 | 升级策略 | 协议侧 `EscalationPolicy` = `Exclude<shared/types.ts` 的 `EscalationPolicySetting`, `"ask">`（派生） | 类型（派生） | ✅ 协议引桌面 | ✅ **2026-10-09 收口完成**：加档只改桌面那一处；协议侧值域常量改 `Record<Union, …>` ⇒ 少一键 **tsc 编译错**（反向注入验过） |
| 4 | 升级策略值域 | 协议侧 `ESCALATION_POLICIES`（`Record`，4 键）· 桌面侧 `ESCALATION_POLICY_SETTINGS`（`Record`，5 键） | Record × 2 | ✅ 各自引类型 + `load` 收窄 | ✅ **2026-10-09 收口完成**：`SettingsStore.load` 对 `arbitration` / `escalationPolicy` 一起接上 `is*` 收窄（欠账 #18 结） |
| 5 | 失败类别 | `shared/types.ts`：`FailureClass` + `FAILURE_CLASSES` + `isFailureClass` | 类型 + 值域 + 收窄器 | ✅ 单一真源 | ✅ 已收口（收口长什么样的样例） |
| 6 | 失败类别（跨版本产物） | `shared/delivery-receipt.ts` 的 `ReceiptTask.errorClass: FailureClass` | 类型（引单一真源） | ✅ 已收口 | ✅ **2026-10-09 收口完成**（欠账 #16 结，纯类型收紧、行为零变化） |
| 7 | 并发上限 | `electron/engine/scheduler.ts:29` · `shared/types.ts:305` | 两处 `4` | ❌ | ⚠️ 欠账 #9 |
| 8 | stdout 截断 | `shared/agent-contract.ts:73` · `electron/engine/verifier.ts:51` | 两处常量 | ❌ | ⚠️ 欠账 #9 |
| 9 | 300_000（超时） | `electron/platform.ts:53` · `shared/http-clients.ts:145,274` · `electron/engine/verifier.ts:41` | 四处常量 | ❌ | ⚠️ 欠账 #9 |
| 10 | SenseNova 模型清单 | `shared/providers.ts:180` `SENSENOVA_MODELS` · `:200` `SENSENOVA_MODELS_EXTRA` · `:186` `SENSENOVA_KEY_VARS` | 三个数组 | 部分 | ✅ **2026-10-09 已看清**：`_EXTRA` **不是**"两份值域同时参与计算"，它是**零消费的登记表**（生产代码无人把它并进轮转）。真缺陷是注释把人指向**根本不存在**的 `LLM_POOL_EXTRA` —— 已改回真名并写明"填进去不等于入池"。**要真启用属功能变更**（欠账 #17） |
| 11 | 默认 LLM 池 | `shared/types.ts` 的 `DEFAULT_SETTINGS.llmPool` 引 `shared/providers.ts:214` 的 `DEFAULT_LLM_POOL`（`[...]` 拷贝） | 常量（单一真源） | ✅ 已收口 | ✅ **2026-10-09 收口完成**（清单里第二项落地的） |
| 12 | `cli-agent` vs `http-bridge` | `lastResult` 的终态判据 | 两处各写一套判据 | ❌→✅ | ✅ **2026-10-09 成对读完**：对"已结束、但尚未被 `collect` 移出追踪表"的 run，两边一个报真终态、一个报 `failed` —— 已统一为同判据并双向钉住（⚠️ `lastResult` 当前无生产调用方，属潜伏分歧非线上缺陷） |
| 13 | 两个 agent 适配器的**默认能力兜底** | `cli-agent.ts` 的 `capabilities()` · `http-bridge.ts` 的 `capabilities()` | 两处各写一套字面量 | ❌ | ⚠️ **2026-10-10 成对读完**：值不同 —— CLI 侧 `run-test` + 并发 1，HTTP 侧 `review` + 并发 2。可能**有意**（本地 CLI 抢资源 / 远程桥可并行），也可能各写各的。✅ **2026-10-10 判断：差异是有意的** —— 值不动，已把理由写成注释钉在两个 `capabilities()` 上（含"别改用 `LEGACY_CAPABILITIES` 补齐 ⇒ 会放大到 `delete` / `run-command"）。**第三处**（`LEGACY_CAPABILITIES`，`supports` 全 7 项）其实**不参与路由**（legacy 候选 bypass 一切能力检查） |
| 14 | **探测超时** | `cli-agent.ts`：`opts.probeTimeoutMs ?? 10_000`（可配）· `http-bridge.ts`：硬编码 `AbortSignal.timeout(5000)` | 可配 vs 硬编码 | ❌ | ⚠️ 同一件事（"探测等多久"）两种**形态**且两个值（10s / 5s）。✅ **2026-10-10 已统一"形态"**：HTTP 侧也读 `opts.probeTimeoutMs ?? 5_000`（默认仍是 5s，**行为零变化**）。**值不统一**（10s / 5s）—— 起一次子进程 vs 一次 HTTP GET，语义不同 |
| 15 | 验证侧 spawn 的两条主路径 | `verifier.ts` 的 `runOnce` · `runSmokeChecks` | 两条各写一遍 spawn + 预算 | ✅ 关键项同源 | ⚠️ **2026-10-10 成对读完**：三道门 / `scopedEnv` / `windowsVerbatimArguments` / `MAX_LOG_BYTES` / 默认超时**全部对齐**（注释还互相指认），剩余差异属**语义不同**（`ok` 判据、dev-server 探活 30s），**不强行统一**。残留小重复：「输出超预算」提示文案两处各写一遍 |

## 说明

### 第 2 项：默认仲裁模式的三处字面量

同一个"默认用回滚"这件事，在三处各写了一遍 `"revert-batch"`：

- `shared/types.ts:384` —— `DEFAULT_SETTINGS.arbitration`
- `electron/engine/batch-guard.ts:160` —— `this.mode = opts.mode ?? "revert-batch"`
- `electron/agents/index.ts:162` —— `const mode = opts.arbitration ?? "revert-batch"`

三处**互不引用**。改默认值要记得改三处，而漏掉任何一处都不会有任何东西变红
（值相同，测试照过）—— 这正是"只散落"型。

### 第 3 项：升级策略 4 档 vs 5 档

`headless/protocol.ts:61` 是 4 档（无人值守场景）；`shared/types.ts:371` 是 5 档
（多一个桌面端独有的 `"ask"` = 弹窗等人）。注释已写明这是**有意**的：
`"ask"` 在无人值守场景下无意义，所以不进协议。**它不是缺陷，但它是耦合** ——
将来协议新增一档，`shared/types.ts:371` 必须同改，而两处之间没有类型引用，
改漏了只有"运行时少一档入口"这一个症状。

### 第 5 项：FailureClass 是"收口长什么样"的样例

同一个概念此前有四处互不打招呼的声明（联合类型 / 裸 `string` / 无约束 /
手抄词表），收口做法是**把手抄换成编译期事实**：类型 + 值域常量 + 边界收窄器，
词表改 `Record<Union, string>`（少一档即编译错）。收窄器此前零调用者由
`check:unwired` 抓出。清单里其余各项的收口可以照这个形状做。

### 第 13 / 14 项：判断过程（2026-10-10）

**第 13 项**先找齐了声明处 —— 不止两处：`shared/agent-contract.ts` 的
`LEGACY_CAPABILITIES` 是**第三处**（`supports` 全 7 项 + 并发 1）。但它在路由里
**不生效**：legacy 候选 bypass 一切 capability 检查（`router.ts` 同口径），真正参与
过滤（`:140`）与并发准入（`:155`）的只有两个 adapter 的默认值。统一它们会**改派发
结果**（CLI 拿到 `review` / HTTP 拿到 `run-test`）；而且**不能**改成用
`normalizeCapabilities` 补齐 —— `LEGACY_CAPABILITIES` 含 `delete` / `run-command`，
那会把"没声明"变成"什么都能做"。⇒ 结论：**值不动**，理由写进注释。

**第 14 项**统一的是**形态**而不是值：让 HTTP 侧也读 `probeTimeoutMs`（默认仍 5s，
行为零变化）。两个默认值刻意不同（起一次子进程跑 `--version` vs 一次 HTTP GET）。

## 下一步（按优先级）

1. **机械重复**：第 2 项（默认仲裁模式）、第 11 项（默认 LLM 池）✅ 均已收口
   （2026-10-09）；第 7 / 8 / 9 项（`maxParallelRuns` / `maxStdoutBytes` /
   `300_000`）**仍不动** —— 抽公共常量会引入反向依赖（欠账 #9 已记原因）；
   第 10 项已看清并修掉指引错误（真启用属功能变更，欠账 #17）；
2. **需要决策**：第 3 / 4 项 ✅ 均已收口（2026-10-09）—— 第 3 项协议侧派生 +
   值域 `Record` 化；第 4 项 `SettingsStore.load` 对 `arbitration` /
   `escalationPolicy` **一起**接上收窄（欠账 #18 结）。
3. **需要成对读代码**：第 12 项 ✅ 已读（2026-10-09）—— 命中 `lastResult` 的终态判据分歧，
   已统一并双向钉住。第 15 项（`verifier.ts` 两条 spawn 路径）✅ **2026-10-10 已读**：
   结论是**同源做得好** —— 三道门 / 凭证 / `windowsVerbatimArguments` / 预算 /
   默认超时全部对齐（注释互相指认），剩余差异属语义不同，**不强行统一**。
   同族新挑出两对：**第 13 项（两个适配器的默认能力兜底）**、**第 14 项
   （探测超时：可配 10s vs 硬编码 5s）** —— 都需先判断"差异是有意还是漂移"再动。
4. **盲区补扫** ✅ 已完成（2026-10-09）：工具先修准（`--list` 从"计数"改为"可列出" +
   按 `文件:行` 去重），实际跳过项从虚高的 19/20 修到 **11 处**；人工过完 ——
   9 处是真正动态键（`Record<string, …>` / `unknown` switch），2 处漏网已收口
   （`STAGE_LABELS` / `RECEIPT_TASK_ICON`），余 **9 处** 正确跳过。
