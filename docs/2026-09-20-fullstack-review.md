# OxCommander 全栈评审：架构分析 · 风险诊断 · 优化方案

> 评审对象：`D:\ox\ox-commander`（HEAD `295c9a6`）
> 约束：保持现有技术栈（Electron 33 / React 18 / Vite 5 / TS 5.5 / Vitest 4）与对外功能不变，禁止大范围重写。
> 所有问题标注 `文件:行号` 证据，行号对应当前工作区代码。

---

## 一、架构分析

### 1.1 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 33 | `contextIsolation: true` + `nodeIntegration: false`，preload 白名单 26 个 channel |
| 前端 | React 18 + Zustand 4 | 四页路由（projects / prd-review / board / settings）+ AgentsPanel，事件驱动 |
| 构建 | Vite 5 + tsc 三套 project | renderer / electron / headless 各自 tsconfig，`npm run verify` 串行串起 |
| 双入口 | Electron 桌面 + headless CLI（JSONL） | `headless/` 三层：protocol / run-spec / headless-main |
| 测试 | Vitest 4 + jsdom + v8 coverage | 400+ 用例，真实 API smoke 由 `OX_SMOKE=1` 门控 |
| 持久化 | JSON 文件 + JSONL 审计 | 均在 `app.getPath("userData")`，密钥经 OS safeStorage |

### 1.2 模块职责

| 目录 | 职责 | 评价 |
| --- | --- | --- |
| `shared/` | LLM 客户端与 failover 池、契约、schema、graph（分批）、routing（错误归因）、prompts | 设计最好：纯 TS，不碰 node/DOM，双入口共用 |
| `electron/engine/` | orchestrator（六阶段 + repair loop）、scheduler（zone 互斥 + 并发闸 + 429 节流）、router（能力路由）、verifier、batch-guard、zone-guard | 编排决策集中，无 UI 依赖 |
| `electron/agents/` | sensenova-api / cli / http-bridge 三适配器 + registry + manifest（schema + loader） | 适配器模式到位，声明式接入（agents.d） |
| `electron/sandbox/` | PathPolicy / CommandPolicy / TimeoutGate / CircuitBreaker / FileJournal / SnapshotStore / spawn-plan / kill-tree | 副作用唯一出口 |
| `electron/ipc.ts` | **装配 + 26 个 handler + 事件转发 + 生命周期** | 唯一的上帝对象（494 行），本次重构重点 |
| `headless/` | JSONL 协议、run-spec 装配、headless-main 胶水 | 与 ipc.ts 存在装配重复（见 P1-1） |
| `src/` | Zustand store + 四页 + AgentsPanel | 事件消费完整，但状态收敛有缺陷（见 P1-2） |

### 1.3 数据流

```
需求 → generatePrd(chatJson+parsePrd) → decompose(planBatches) → batches[][]
     → execute() 逐批：planPool(router/breaker) → acquireSlot(并发闸) → awaitThrottle(429 退避)
     → agent.dispatch → collect(terminal event) → BatchGuard.settle(回滚/仲裁)
     → verifyProject(build/typecheck/test) [+ runSmokeChecks 独立样本]
     → 失败：routeVerificationErrors 按 zone 归因 → repair loop
     → 重修耗尽：escalation → 人工 skip / redispatch / abort
```

**持久化写入点**：`projects.json`（阶段/PRD/batches 全量重写）、`settings.json`、`keys.json`（safeStorage 加密）、`audit-YYYY-MM-DD-NNN.jsonl`（体积轮转）、`snapshots/`（回滚备份）、`runs/`（CLI prompt 文件）。

---

## 二、风险诊断（按严重程度）

### P0 — 会在真实运行中造成事故

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0-1 | **工作区快照把 `.env` 送进 LLM prompt**。跳过目录只有 `node_modules/.git/ox-scripts`，读文件时无任何文件名过滤 | `electron/agents/sensenova-api.ts:28`、`readSnapshotContents :274-303` | headless 模式 `projectRoot` 由外部传入，任意项目的 `.env` / `credentials` / `*.pem` 会被读进 prompt 发往第三方端点；`shared/llm-client.ts:141` 还会把上一轮 `lastRaw` 回喂模型，形成二次扩散 |
| P0-2 | **`Retry-After` 未加帽**，`sleep` 直接用服务端给的值；`RETRY_AFTER_COOLDOWN_CAP_MS` 只作用于冷却表，不作用于这次 sleep | `shared/http-clients.ts:289` vs `:299`、`parseRetryAfterMs :35-42` | 一个 `retry-after: 86400` 让单次 `chat()` 挂 24 小时，整条流水线假死 |
| P0-3 | **failover 无总耗时/总次数预算**：12 条线路 × 单请求 300s，再乘 `maxRetries` 与 `withCooldownRetry` 轮数 | `shared/http-clients.ts:253-291`、`shared/llm-client.ts:136` | 一次 `chatJson` 最坏墙钟可达小时级，UI 无法感知"卡住还是慢" |
| P0-4 | **`killTree` 的 `taskkill` 未监听异步 error**：`try/catch` 只覆盖同步抛出，`spawn` 失败会异步 emit `error` | `electron/sandbox/kill-tree.ts:15-20` | Windows 上 `taskkill` 缺失/被拦截 → 未监听的 `error` 事件直接崩进程；且超时后只 kill 一次（`verifier.ts:58-62`），杀不掉则 `runOnce` 永不 settle |

### P1 — 功能缺失 / 双端漂移 / 状态错误

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| P1-1 | **Electron 与 headless 两套装配漂移**：Electron 缺 `journal`（断点续跑）、缺 `onVerdict`（越权裁决回流）、缺 LLM 超时覆盖、第三参 `ZoneGuard` 是死参 | `ipc.ts:206-236` / `:130` / `:209` vs `run-spec.ts:130-162` / `:173` / `:178`；`scheduler.ts:279-281` guard 优先 | 同一份 spec 两条链路行为不同；桌面端长运行被杀后从零开始；越权回滚在 UI 不可见 |
| P1-2 | **前端 `taskStatus` 重建对象，清空归因**：未 spread `prev` | `src/store.ts:164-170` | 重修轮再次派发时，`agentId / durationMs / errorClass / failureDigest` 被清零，看板"谁跑了多久、为何失败"在第二轮后消失 |
| P1-3 | **取消/暂停无终态事件**：`cancel()` 只置标志位并抛 `CancelledError`，从不发终态 | `orchestrator.ts:111-127`、`ipc.ts:385-396` | 取消后任务永久停在 `running`（`BoardPage.tsx:95`）；迟到事件无屏障（`store.ts:159` 一律覆盖） |
| P1-4 | **退出码契约与实现不符**：protocol 声明 skip/redispatch 失败 exit 1，实现是 `report.passed ? 0 : 2` | `protocol.ts:32-34` vs `run-spec.ts:230` | 宿主脚本化时拿到 2 而非 1 |
| P1-5 | **路径判定纯词法**：无 `realpath`，junction/symlink 指向外部目录判定为内部；禁止清单无 `i` 标志、无 8.3 短名归一 | `path-policy.ts:125`、`:57-60`、`:129` → `shared/glob.ts:51` | `PACKAGE.JSON` / `.ENV` / `NODE_M~1` 绕过受保护清单 |
| P1-6 | **Windows 元字符集缺 `^ % !`**：参数拼进 `cmd.exe /d /s /c` 单行，`%SENSENOVA_API_KEY%` 会被 cmd 展开进 argv；子进程完整继承 `process.env` | `command-policy.ts:105`、`spawn-plan.ts:130-134`、`cli-agent.ts:146` | 环境变量注入 → 密钥经子进程命令行外泄的组合链 |
| P1-7 | **错误原文直出**：`logDigest` 原样推前端、写审计 JSONL，无脱敏层 | `ipc.ts:250`、`:226`、`scheduler.ts:337`、`sensenova-api.ts:175` | 一旦上游 message 携带凭据，前端与磁盘双份留存 |
| P1-8 | **静默吞错 + 无提示**：settings 保存无 catch、无失败提示 | `src/store.ts:123-126`、`SettingsPage.tsx:350-358` | 保存失败时界面无提示、不跳转、按钮照常复位 |

### P2 — 性能 / 资源 / 可维护性

| # | 问题 | 证据 |
| --- | --- | --- |
| P2-1 | `ProjectStore` 每次 update 全量读+全量写 `projects.json`；`audit.read()` 先把所有文件全量读入内存再 `slice(-limit)` | `store.ts:38-40`、`audit-log.ts:104-122` |
| P2-2 | 审计按体积轮转（默认 2 MiB）但**无保留/清理策略**，磁盘与内存单调增长 | `audit-log.ts:141-154` |
| P2-3 | 快照目录无配额，未 commit 的残留永不清理；`newlyCreated` 走查后删除并发新建文件 | `snapshot-store.ts:144-149`、`:183-214` |
| P2-4 | 验证输出无字节上限（`log +=` 无预算），HTTP `res.text()` 无 Content-Length 上限 | `verifier.ts:64-65`、`http-clients.ts:62/65` |
| P2-5 | `ipc.ts` 一个文件承担装配 + 26 handler + 事件转发，无 service 层 | `ipc.ts:269-490` |
| P2-6 | HTTP bridge 轮询无重入保护；取消路径下 `collect` 的 `finally` 只 `delete`，`poller` 继续跑 | `http-bridge.ts:202`、`:260-270`（`markTerminal` 有 clearInterval，但仅在终态触发） |
| P2-7 | 测试缺口：escalation 决策、cancel 竞态、settings 失败提示、`redispatch`/`abort` 按钮、headless-main 异常路径、`redispatch_once`/`skip` 策略 | `ui.test.tsx` / `store.test.ts` / `headless-protocol.test.ts` |

---

## 三、优化方案（分阶段，按收益/风险排序）

### 阶段 A — 止血（高收益 / 低风险，改动 ≤ 5 文件，不动结构）

| A# | 改动 | 涉及文件 | 验证方式 |
| --- | --- | --- | --- |
| A1 | 快照文件黑名单：`.env`、`.env.*`、`*token*`、`*.pem`、`*.key`、`credentials*`、`*.pfx`、`id_rsa*`，并新增 `SNAPSHOT_SKIP_FILES` 正则集；跳过隐藏 dotfile 目录 | `electron/agents/sensenova-api.ts` | 新增用例：临时目录含 `.env` → 断言 prompt 不含其正文；`npx vitest run src/sensenova-api.test.ts` |
| A2 | `Retry-After` 加帽：`Math.min(retryAfterMs, RETRY_AFTER_SLEEP_CAP_MS)`（建议 60s），并给 `chat()` 加总预算 `deadlineMs`（超时抛 `HttpLlmError` 而非继续换线） | `shared/http-clients.ts` | 新增用例：`retry-after: 86400` → 实际等待 ≤ cap；`src/failover.test.ts` |
| A3 | `killTree` 监听 `spawn` 的 `error` 事件并回退 `child.kill()`；`verifier` 超时后二次确认（1.5s 后若未退出再强杀一次） | `electron/sandbox/kill-tree.ts`、`electron/engine/verifier.ts` | 新增用例：mock `spawn` 抛错 → 不崩溃且回退到 `child.kill`；`src/sandbox-runtime.test.ts` |
| A4 | `taskStatus` 分支 spread `prev`，保留 `agentId/durationMs/errorClass/failureDigest` | `src/store.ts` | 新增用例：先 `taskOutcome` 后 `taskStatus`，归因字段仍在；`src/store.test.ts` |
| A5 | 脱敏函数 `redactSecrets(text)`：抹 `sk-`/`nvapi-`/`rc-` 前缀串与 `Bearer xxx`，在 `ipc.ts` 推前端与写审计前统一过一遍 | 新增 `shared/redact.ts`，改 `electron/ipc.ts:226,250` | 新增用例：含 `sk-` 的 digest 被抹除 |

**阶段 A 回归风险**：低。A2 改变等待行为（有测试钉住），A5 会改变日志文本（需确认无断言硬编码原文）。
**阶段 A 验收**：`npm run verify` 全绿 + 新增 5 组用例通过。

### 阶段 B — 收敛双端与状态（中收益 / 中风险）

| B# | 改动 | 涉及文件 | 验证方式 |
| --- | --- | --- | --- |
| B1 | 抽 `createPlatform(config)` 统一装配（agentLayer + engine + journal + verdict sink + LLM 超时），`ipc.ts` 与 `run-spec.ts` 同时改为调用它 | 新增 `electron/platform.ts`；改 `ipc.ts`、`headless/run-spec.ts` | 新增用例：两条链路装配出的 engine 选项快照一致（journal/verdict/timeout 三项） |
| B2 | Electron 补 `journal`（断点续跑，落 `userData/runs/<projectId>.json`）+ `onVerdict`（越权裁决推 `ox:event` type `conflict`） | `ipc.ts`、`src/types.ts`、`src/store.ts` | 杀进程重开，项目从上次批次继续；BoardPage 显示 conflict 提示 |
| B3 | 取消/暂停终态：`cancel()` 前对未终态任务发 `taskStatus(cancelled)`；store 增加 `runId` 屏障，丢弃过期事件 | `orchestrator.ts`、`ipc.ts`、`src/store.ts` | 新增竞态用例：cancel 后迟到 `taskOutcome` 不覆盖 `cancelled` |
| B4 | 输出字节上限：`verifier` log 截断（复用 `digest()`），HTTP 响应体加 Content-Length 校验 | `verifier.ts`、`http-clients.ts` | 新增用例：超长输出被截断且不影响判定 |
| B5 | IPC 错误统一包装：`ipcMain.handle` 包 try/catch 返回 `{ok:false,error}`，前端 store action 补 catch + 错误态 | `ipc.ts`、`src/store.ts`、`SettingsPage.tsx` | 新增用例：settings 保存失败时 UI 显示错误 |
| B6 | 退出码对齐：以实现为准修正 `protocol.ts` 文档（或反之），二者择一并写进测试 | `headless/protocol.ts` 或 `run-spec.ts` | 新增用例钉住 skip/redispatch/abort 三种退出码 |

**阶段 B 回归风险**：中。B1 触及双入口装配，必须以"装配快照对比测试"钉住；B3 改事件时序，需回归 `ui.test.tsx` 全部用例。
**阶段 B 验收**：`npm run verify` + `node scripts/artifact-smoke.mjs` + 手工跑一次 `node scripts/run-multiagent-e2e.mjs`。

### 阶段 C — 结构与性能（长期收益 / 需单独排期）

| C# | 改动 | 涉及文件 | 风险 |
| --- | --- | --- | --- |
| C1 | `ipc.ts` 拆为 `handlers/projects.ts`、`settings.ts`、`agents.ts`、`orchestration.ts`、`audit.ts` + `platform.ts` | `electron/` | 中：纯移动，逐个 channel 迁移并用既有测试兜底 |
| C2 | 持久化原子写（tmp + rename）+ audit 保留策略（默认保留 14 天 / 200 MiB）+ `read()` 改为从尾部流式读 | `electron/store.ts`、`audit-log.ts` | 中：文件格式不变，需兼容旧文件 |
| C3 | `path-policy` 加 `fs.realpathSync` 解析与大小写/短名归一；`command-policy` 补 `^ % !` 与 `forfiles/rundll32/msiexec/wscript/certutil` 拒绝项 | `sandbox/path-policy.ts`、`command-policy.ts` | 中高：可能改变既有通过/拒绝判定，需先把现有行为写成"黄金用例"再改 |
| C4 | 子进程 env 最小化：只透传白名单变量，不再 `{...process.env}` | `cli-agent.ts`、`spawn-plan.ts` | 中：某些 CLI 依赖 PATH/HOME，白名单需实测 |
| C5 | 补齐测试：escalation 三分支、cancel 竞态、headless-main 异常路径、`maxParallelRuns`、smoke 层 | 各 `*.test.ts` | 低 |

---

## 四、验收标准（可复现）

```bash
npm run verify                 # typecheck + lint + vitest + build + headless build + artifact smoke 全绿
npx vitest run src/store.test.ts src/failover.test.ts src/sensenova-api.test.ts
node scripts/artifact-smoke.mjs
git diff --stat                # 每个阶段单独一次提交，便于二分回滚
```

每一阶段独立提交、独立跑 `npm run verify`，任一阶段红则只回滚该阶段。

---

## 五、实施记录

### 阶段 A —— 止血（commit `4803793`，14 文件 +581/−7）

| A# | 问题（原文证据） | 修法 | 钉住它的测试 |
| --- | --- | --- | --- |
| A1 | `sensenova-api.ts:28` 快照遍历只跳目录，不做文件名过滤 → 项目 `.env` 进 LLM prompt | 新增 `SNAPSHOT_SECRET_FILE_PATTERNS`（dotenv / *rc / 私钥 / `id_rsa*` / `*.pem·key·p12` / 命名含 token·secret·password / `.aws`·`.ssh`·`.kube` 等）+ `isSecretLikeFile(rel)`，在 `walkStat` 与 `readSnapshotContents` **两处**拦截 | `src/snapshot-secrets.test.ts`（7 例，含反向样例：`tokenizer.js`、`secretsanta.js` 不得误杀） |
| A2 | `http-clients.ts:289` `Retry-After` 未加帽（cap 只在 `:299` 作用于冷却表）→ 单次 chat 可挂 24h | 拆 `parseRawRetryAfterMs`（保原值给冷却表）与 `parseRetryAfterMs`（`min(cap)` 给 sleep），sleep 帽 60s、冷却帽 300s | `src/retry-after.test.ts`（5 例） |
| A3 | `kill-tree.ts:15` taskkill `spawn` 未监听异步 `error` → Windows 可崩整个进程 | 补 `killer.on("error", fallback)` + `on("exit", code !== 0 && fallback())` + grace 窗口后 verify 定时器兜底；抽出可移植 `portableKill`（SIGTERM → SIGKILL） | `src/cli-agent.test.ts`（+2 例） |
| A4 | `src/store.ts:164` `taskStatus` 重建对象未 spread `prev` → 重修轮 `running` 事件抹掉 `agentId`/`durationMs`/`errorClass` | 先 `...prev` 再覆盖 status/attempts | `src/store.test.ts`「keeps attribution across a repair-round re-dispatch」 |
| A5 | 凭据可经审计 JSONL 与前端 digest 外泄 | 新增 `shared/redact.ts`（`sk-`/`nvapi-`/`ghp_`/JWT/AWS AKIA/`Bearer`/具名 secret 等），套在 `ipc.ts` 两个出口 | `src/redact.test.ts`（9 例） |

**A 阶段的额外产出**：`scripts/e2e-snapshot-secrets.cjs` —— 真实 `dispatch()` 端到端：拦截 `globalThis.fetch` 抓实际 prompt，断言密钥不在其中（6 项断言），已串入 `npm run verify`。

**A 阶段验收**：`npm run verify` 全绿 —— 478 测试（472 通过 / 6 真实 API smoke 跳过）。

### 阶段 B1 —— 双端装配收敛（commit `a5086f1`，8 文件 +787/−194）

**根因**：`ipc.ts` 与 `run-spec.ts` 各维护一份引擎装配代码，已实测漂移出 **4 处**：

| 漂移点 | headless | 桌面（修复前） |
| --- | --- | --- |
| `journal`（断点续跑） | 有（`ox-run-journal.json`） | **无** |
| `onVerdict`（越权裁决出口） | 有（`setVerdictSink` → `conflict` 事件） | **无** → 回滚/隔离在 UI 完全不可见 |
| LLM `timeoutMs` | 300s（拥堵窗口必需） | **默认 120s** → 大脑在生成完成前被掐断 |
| `Scheduler` 第三参 | `undefined`（已修） | `new ZoneGuard()` —— **死参**，永远被 BatchGuard 遮蔽 |

**修法**：新增 `electron/platform.ts` 作为**唯一装配点**。
- `createPlatform(config)` 内部负责：agent layer（含注入复用 + verdict sink 后挂）、`schedulerOptions()`（`maxParallelRuns` + run 归因回调）、`buildLlm()`（先播种 env 再建池，统一 300s）、engine（`new Scheduler(layer.adapters, enabledAgents, undefined, …)` —— 死参彻底消失）。
- 双端现在只描述**策略**（日志去哪、审计去哪、升级策略是什么），不再各自描述**结构**。
- 导出的 `BRAIN_POOL_TIMEOUT_MS = 300_000` 与 `createFileJournal(projectRoot, requirement)`（返回 `{path, save, load, mismatched, corrupted}`）供两端共用。

**顺带补齐桌面侧缺口（原 B2）**：
- journal → `userData/runs/<projectId>.json`，与 headless 同款恢复语义。
- `onVerdict` → 逐条 conflict 经 `ox:event` 推给前端，`remedy` 映射为 `revert/isolate/keep/none`。
- LLM 线路池与 headless 共用 300s 预算。

**前端新增 conflict 链路**：
- `src/types.ts`：`ConflictView { kind, paths[], remedy, ts }` + `AppState.conflicts`。
- `src/store.ts`：初值、`confirmAndExecute` reset、`case "conflict"`（remedy 映射「已回滚/已隔离/保留改动/仅记录」，conflicts 环形截断 50 条，日志截断 500 行）。

**钉住漂移的测试**：`src/platform.test.ts`（17 例），含 **desktop/headless parity** 测试块 —— 直接断言两侧装配出的选项在 journal / verdict / timeout 三项上一致。这正是本次修掉的那类漂移的回归防线。

**B1 验收**：
```bash
npm run verify                     # 493 passed / 6 skipped（真实 API smoke）
                                   # artifact smoke all checks passed
                                   # e2e snapshot secrets all checks passed
node scripts/run-multiagent-e2e.mjs  # 真实多智能体链路（真实 LLM + HTTP 桥接）
```

### 一次必须记录的操作失误

期间我在清理 e2e 残留文件时执行了 `git checkout -- .`，**误回退了阶段 B 尚未提交的 6 个文件改动**（`ipc.ts` / `run-spec.ts` / `store.ts` / `types.ts` / `store.test.ts` / `ui.test.tsx`）。
未跟踪的 `platform.ts` 与 `platform.test.ts` 不受影响，阶段 A 的提交 `4803793` 也不受影响。

**教训（已写进本文件）**：清理临时文件**绝不能**对工作区使用 `git checkout -- .`；要按具体路径、且先 `git status --short` 确认。所有改动逐文件重建后，`npm run verify` 恢复全绿。

### 阶段 B 收尾（B3–B6）

| 项 | 状态 |
| --- | --- |
| B3 取消/暂停终态事件 | **已完成**（commit `d0f8717`） |
| B4 输出字节上限（HTTP 响应体校验） | **已完成**（commit `1db27a1`） |
| B5 IPC 错误统一包装 | **已完成**（commit `d6b50c7`） |
| B6 退出码契约对齐 | **已核实无需改动** —— `docs/headless-protocol.md:13,65-75` 的退出码表与 `run-spec.ts:187,191-196` 实现一致 |
| C3 path-policy 大小写归一 | **已实测定性**：`SRC/a.js` 在 zone「src」下被**拒绝**（fail-closed，误拒而非放行），属 P2 误伤风险，非安全洞 |

#### B3 —— 取消终态（`d0f8717`）

`execute()` 包一层 catch：捕获 `CancelledError` 时，对 `inFlight` 中每个任务补发
`taskStatus("cancelled", 上次 attempt)` 再原样抛出。新增 `TaskStatus = "cancelled"`
（与 `failed` 区分：取消是操作员动作）+ `.status-cancelled` 灰色无脉冲样式。

**变异验证**：把补终态分支改成死代码后，第 1 例真红；恢复后 25 例全绿。

#### B4 —— 失败响应体上限（`1db27a1`）

`HttpLlmError` 只展示 300 字符，但 `await res.text()` 先把整个 body 读进内存。
新增 `readCappedErrorBody()`：超 64 KiB 只留头部并标注截断长度。
**变异验证**：导出 `ERROR_BODY_BYTE_CAP` 钉住"恰好等于 cap 时不得截断"的边界。

#### B5 —— 设置读写错误处理（`d6b50c7`）

`loadSettings`/`saveSettings` 原是 store 里仅剩的无 catch IPC 调用。
改为：捕获 + 日志；`saveSettings` **只在写成功后**提交本地状态并记录
`settingsError`。`SettingsPage` 有错误时不再跳回项目页，并显示 `role="alert"` 错误条。

**变异验证**：把 `settingsError` 赋值改成常量、成功后置 `undefined` 改成乱值后，
后两例真红；恢复后 25 例全绿。

---

### 一次必须记录的操作失误

清理 e2e 残留时对工作区跑了 `git checkout -- .`，回退了阶段 B 尚未提交的 6 个文件改动。
**教训**：清理临时文件只能按路径精确 `rm`，绝不能对工作区用 `git checkout -- .`。

**C3 实测命令与结果**（可复现）：
```bash
node -e "const {PathPolicy}=require('./dist-electron/electron/sandbox/path-policy.js');
const p=new PathPolicy({projectRoot:'C:\\\\Proj\\\\App'});
console.log(p.assertWritable('SRC/a.js','src'));"
# → { ok: false, reason: 'zone 越权：SRC/a.js 不在 zone「src」内' }
```

---

## 六、阶段 B 之后：规划器 zone 覆盖缺陷（commit `a38e991`）

### 6.1 怎么发现的

**真实多智能体 e2e**（`scripts/run-multiagent-e2e.mjs`，真实 LLM + loomy 桥接），不是 mock：

- ✅ agent 路由正确 —— `src/loomy` 任务派给外部 loomy 桥接，loomy 接单 2 次全成功
- ✅ zone 越权裁决全链路可见 —— headless `conflict` 事件触发 3 次
- ✅ B4 已生效 —— 单次 run 出现 **676900ms**，仍被 300s 线路池预算 + failover 兜住
- ❌ **流水线不可能收敛**：落盘只剩 `tests/unit/greet.test.js`（被重命名后的文件），
  而 smoke 命令要求 `src/cli.js` → 永远失败

### 6.2 根因

不是守卫的错，是**规划器与 PRD 对不上**：

| 来源 | 内容 |
| --- | --- |
| PRD `acceptanceCriteria` | `tests/greet.test.js`、`tests/math.test.js`（在 `tests/` **根下**） |
| 规划器产出的 zone | `tests/unit`、`tests/runner` |
| `shared/prompts.ts:69` | 强制 "zone: a concrete directory"（目录名） |

模型被两边夹住：想满足文件的**父目录**语义就得写 `tests`，但 prompt 明说要 concrete
directory，于是它选了看起来更"目录"的 `tests/unit`。结果每次写 `tests/greet.test.js`
都被判越权 → 沙箱回滚 → 验证永远缺文件 → 重修烧光预算，**且报的是错误的原因**
（"测试文件不存在"而不是"zone 覆盖不到"）。

### 6.3 修法：把不可能的计划挡在规划阶段

新增 `shared/zone-coverage.ts`（纯 TS，`shared/` 不许碰 node/DOM，三端共用）：

| 导出 | 职责 |
| --- | --- |
| `extractDeclaredPaths(text)` | 从文本里提取**被显式点名**的嵌套文件路径 |
| `declaredArtifactPaths(prd)` | 扫 `goal` + `features` + `acceptanceCriteria` |
| `findOrphanPaths(prd, tasks, protectedPrefixes?)` | 找出没有 zone 认领的声明路径 |
| `describeZoneGaps(gaps)` | 生成给人看的摘要 |

`decompose()` 末尾接 `assertZoneCoverage`：命中即 `onLog("[规划校验] …")` + throw
`SchemaValidationError`。

**刻意单向**：只拒绝，**绝不自动放宽 zone**。自动把 zone 提到父目录等于凭空授予
规划器没打算给的写权限 —— 那正是 zone 模型存在的意义。

**代价对比**：在这里失败 = **1 次 decompose 调用**；拖到运行期失败 = 整轮重修预算
+ 误导性归因。差 2~3 个数量级。

### 6.4 提取规则为什么长这样（两个真阳性教训）

写第一版正则时踩了两个坑，都是**测试先红**才发现的：

| 输入 | 错误行为 | 修法 |
| --- | --- | --- |
| `../outside/secret.txt` | 提取出 `outside/secret.txt`（退化成看似合法的路径） | 前瞻断言 `(?!\.)` 挡不住 —— 引擎会退一格重新匹配。改判**前置字符** `prev === "." \|\| "/" \|\| "\\"` 就 continue |
| `package.json` | 被当成产物路径，毙掉正常计划 | 裸文件名几乎都是散文里提到的**受保护**路径（"不要改 package.json"）。改为一律要求 `segments.length >= 2` |

**取向**：偏向漏报。漏报只是少校验一次；误报会毙掉本来能跑的合法计划。

### 6.5 验证

- `src/zone-coverage.test.ts` — **11 例**，含真实回归：zones `tests/unit`+`tests/runner`
  vs PRD `tests/greet.test.js` → 报 2 个 orphan，并断言 `gaps[0].zones` 列出全部现有 zone
- `src/orchestrator.test.ts` — **+2 例**（拒 / 收各一）
- **变异验证**：把 `this.assertZoneCoverage(prd, plan.tasks);` 换成死代码后，
  「rejects a plan whose zones orphan a PRD-declared file」**真红**；恢复后 27/27 通过
- `npm run verify` 全绿：**514 passed / 6 skipped**，typecheck 3 套 + lint + build
  + `smoke:artifact`（45 个 dist-electron 文件 `node --check` 0 错误）+ `smoke:snapshot-secrets`

### 6.6 本轮新发现（→ 已在第九章处理并更正定级）

`shared/prompts.ts` 把 `${payload.zone}` / `${payload.title}` 原文插进提示词。
我最初记为"模板注入通道"，暗示可提权 —— **该定级是错的**，已在 §9.1 更正为
**P2 健壮性/可诊断性**（畸形 zone 是 fail-closed，不会放宽沙箱）。
修复见第九章（`9935ec1`）。

---

## 七、阶段 C 实施记录

### C1 —— ipc.ts 上帝对象拆分（commit `81b3e3c`）

原文件 **554 行**，同时承担装配、状态持有、5 个域共 26 个 channel 的注册；
**整个项目没有任何测试碰过它**。改错一个 channel 名只会在打包后表现为
`No handler registered`，现场无法定位。

拆成 `electron/ipc/`：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `context.ts` | 294 | 共享状态 + 单例工厂（stores / agentLayer / audit / platform / engine） |
| `orchestration.ts` | 187 | PRD / 规划 / 启动 / 取消 + workspace 脚手架 + escalation |
| `agents.ts` | 121 | agent 池 + 可观测性（breaker stats / audit） |
| `projects.ts` | 78 | 项目生命周期 + settings / keys + `llm:test` |
| `ipc.ts` | **31** | 只做编排：`ensureStores()` + 5 个 `register*` |

**关键约束**：只有 `context.ts` 持有 `let` 绑定，handler 模块是无状态注册器。
原 `let settingsStore` 与新的 `settingsStore()` getter 撞名（TS2395），
内部变量改名 `settingsHolder` / `keysHolder`。

### C5a —— 补 ipc 契约测试（此前零覆盖）

`src/ipc.test.ts` 从**两个方向**钉死契约，对称所以能同时抓漏注册与多余注册：

1. `preload.ts` 里每个 `ipcRenderer.invoke("x")` 都必须有 handler；
2. 每个 handler 都必须能被 `preload.ts` 到达。

外加「26 个 channel 全集快照」与「重复注册检测」。

配套 `src/__fakes__/electron.ts` —— **必须存在**，因为
`node_modules/electron/index.js` 是 `module.exports = getElectronPath()`，
在 vitest 里 import 得到的是一个**字符串**，所有具名导出都是 `undefined`，
主进程模块根本 import 不进来。`vitest.config.mts` 加 alias 指向它。
替身按 Electron 语义**拒绝重复 handle**，让"拆模块拆出双注册"变成真红。

### C2 —— 持久化原子写 + audit 保留（commit `81b3e3c`）

新增 `electron/atomic-file.ts`：`writeFileAtomic`（同目录 tmp + rename）+ `readJsonFile`。

原实现是就地 `writeFileSync` 截断，进程中途死掉会留下 0 字节或半截文件：

| 文件 | 损坏后果 |
| --- | --- |
| `projects.json` | **全部项目记录静默消失**，UI 无法恢复 |
| `settings.json` | 操作员整套配置（含 LLM 池）被重置 |
| `ox-run-journal.json` | 下次 `load()` 报 `corrupted`，丢掉可用断点 |

`readJsonFile` 刻意**不**对"文件存在但解析失败"回退默认值 —— 那正是把截断写
变成"项目凭空消失且无任何报错"的原因，现在让 JSON 错误上抛。

`audit-log.ts` 加 `maxFiles`（默认 20）：原来只按大小滚动、**从不删除**，
长期项目无限堆积 JSONL。`enforceRetention` 计的是**文件总数（含当前文件）**，
不是"保留 N 个之外" —— 后者在 `maxFiles: 1` 时会永远停在 2 个文件。

### C4 —— 子进程 env 最小化（commit `743c9fb`）

`cli-agent.ts` 的 `dispatch()` 原本是 `const env = { ...process.env }`，
于是每个 CLI agent 子进程都能读到**所有**已配置 provider 的密钥。
这与 A5/B4 修的快照密钥是同一威胁模型的两个出口。

新增 `electron/agents/scoped-env.ts`，两条规则：

1. **显式授权优先**（`envTemplate` 的 key，或 `allowProviders` 指定的 provider）；
2. 其余按名字判定：像凭据的一律丢弃，剩下只留进程基本运行所需。

`REQUIRED_EXACT` 是 allowlist —— 未列出的不流动，新增 provider 无需改这里。
`SECRET_NAME_PATTERN` 走命名约定，尚未注册的 provider 也自动被挡。
`CliAgentOptions.allowProviders` 默认空：CLI agent 靠自己的配置文件认证。

**两个自己踩出来的真 bug（都是测试先红）**：

| bug | 症状 | 修法 |
| --- | --- | --- |
| `allowProviders` 是死参数 | 我把 secret denylist 放在 provider allowlist 之前，而所有 provider key 都长得像密钥 → 永远无法放行 | 授权判定提到 denylist 之前 |
| `SystemRoot` 被误删 | `REQUIRED_EXACT` 写 `"SystemRoot"`，但 Windows 实际暴露的是大写 `SYSTEMROOT`，Set 区分大小写 → 被丢弃。**正是注释里写"掉了会让很多 Windows 工具起不来"的那个变量** | 全大写存储 + 大小写不敏感比较 |

顺带修正：`providerKeyEnvVars` 只对 sensenova 返回多 key 槽位，不是通用查询；
取单个 key 要用 `getProvider(id).apiKeyEnvVar`。

### 阶段 C 验证汇总

| 项 | 结果 |
| --- | --- |
| `src/ipc.test.ts` | 5 例 |
| `src/atomic-store.test.ts` | 11 例 |
| `audit-log.test.ts` | +4 例（原 12 → 16） |
| `src/scoped-env.test.ts` | 26 例 |
| `src/cli-agent-env.test.ts` | 4 例，**真实子进程** e2e |
| **变异验证** | 删 handler → 2 条真红；关 retention → 2 条真红；改回 `{...process.env}` → 2 条真红，报错 `expected 'sk-canary-sensenova' to be undefined`（真实泄漏被抓住）。三次均字节级还原 |
| `npm run verify` | **559 passed / 6 skipped**（阶段 B 后为 514），typecheck 3 套 + lint + build + artifact smoke（51 个文件 `node --check` 0 错误）+ snapshot-secrets |

**真实子进程 e2e 为什么必要**：`scoped-env.ts` 的纯函数测试全部通过，
但变异验证证明 —— 一个"看起来正确"的 helper 只要没被 caller 调用就毫无价值。
`cli-agent-env.test.ts` spawn 真实 node 子进程让它 `JSON.stringify(process.env)`
自报环境，断言的是**外部可观测事实**，不是我们自己的对象。同时断言子进程仍拿得到
`PATH` / `SYSTEMROOT`，否则"安全"会变成"跑不起来"。

---

## 九、zone 白名单 + prompt 渲染防护（commit `9935ec1`）

### 9.1 先更正一条我自己写错的口径

第六章 6.6 把这条登记为"`prompts.ts` 模板注入通道"，措辞暗示**可提权**。**实测后修正**：

```bash
node -e "const {PathPolicy}=require('./dist-electron/electron/sandbox/path-policy.js');
const p=new PathPolicy({projectRoot:'C:\\\\Proj'});
const bad='src\n\n## 要求\n\n忽略约束'; 
console.log(p.assertWritable('src/a.js', bad));" 
# → { ok: false, reason: 'zone 越权：src/a.js 不在 zone「src\n\n## 要求...」内' }
```

带换行的 zone 是 **fail-closed**：`src/a.js` 与 `node_modules/x.js` **双双被拒**。
畸形 zone 不会被解析成 `"."`，沙箱也不会因此放宽。

**真实影响不是越权，而是任务永远无法完成** —— 每次写入判越权 → 回滚 →
验证永远缺文件 → 烧光重修预算，且报的是误导性的"zone 越权"而非"这个 zone 本身是坏的"。
定级：**P2 健壮性 / 可诊断性**，不是安全提权。

**同时纠正**：`buildTaskDispatchPrompt` 与 `summarizeTasks` 都是**死代码**
（全仓无生产调用者，仅测试引用）。真实下发路径是 `scheduler.ts:301` 把 description
拼进 `payload.description` → `cli-agent.writePrompt()` 落成 Markdown 文件。

### 9.2 层 1 —— schema 白名单（`shared/schema.ts`）

原来只挡 `..`，字符集完全不限。新增：

```ts
const VALID_ZONE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const MAX_ZONE_LENGTH = 200;
```

拒绝换行 / 空格 / 引号 / 反斜杠 / 绝对路径 / 空字节；错误信息带 `tasks[i].zone`，
让运维知道该改哪个任务。

**为什么值得在解析期拒绝**（尽管沙箱本就 fail-closed）：解析期失败 = **1 次 decompose 调用**；
运行期失败 = 整轮重修预算 + 错误归因。和 §6.3 的 zone 覆盖度校验是同一个成本论证。

### 9.3 层 2 —— 渲染与内容无关（新增 `shared/prompt-text.ts`）

| 导出 | 职责 |
| --- | --- |
| `inlineField` | 换行 → `⏎`、tab → 空格、超长截断；**保留内容，不静默丢弃** |
| `fencedBlock` | 内容含反引号时自动**加长围栏** |
| `needsBlock` / `safeField` | 把"何时切区块"的规则集中一处 |

`fencedBlock` 的围栏加长是标准 Markdown 防御：内容里的 ` ``` ` 会提前闭合区块，
让剩余部分逃逸成正文。围栏被加到比内容里最长的反引号串更长。

应用到 `cli-agent.writePrompt()` 的 title/zone/taskId，以及 `prompts.ts` 的
`buildRepairPrompt` / `buildTaskDispatchPrompt` / `summarizeTasks`。

**`description` 刻意不白名单** —— 它按设计就是自由文本（要写接口签名、口径、边界），
无法白名单，只能靠层 2 兜住文档结构。

**踩坑记录**：我一度在 `prompts.ts` 里用了 `path.resolve`，但 `shared/` 必须保持
**不依赖 node**（要编译给 renderer），已改回原样。

### 9.4 层 2 的接线缺陷（本轮修复，`9935ec1` 的补正）

上一轮的层 2 **有两处没接上生产路径**，都是"helper 正确但没被调用"：

| 缺陷 | 详情 |
| --- | --- |
| `fencedBlock` / `needsBlock` / `safeField` 零调用 | 三个导出只被测试引用，生产代码一次没调。`cli-agent.ts` 的 digest 区块仍用**硬编码三反引号**，所以 digest 里自带 ` ``` ` 时会提前闭合，剩余内容逃逸成正文 |
| `sensenova-api.ts` 完全没防护 | `payload.title` / `payload.zone` **连 `inlineField` 都没有**，digest 也是裸拼。这是**默认适配器**（`DEFAULT_SETTINGS.enabledAgents = ["sensenova-api"]`，`agents/index.ts:20` 兜底），即新装用户实际跑的路径 |

**修复**：

- `cli-agent.ts`：digest 区块改走 `fencedBlock(tail(...))`
- `sensenova-api.ts`：title/zone 走 `inlineField`，digest 走 `fencedBlock`

**同时纠正我的测试口径**：原断言扫**全文行首**找 `## `，没考虑围栏上下文 ——
围栏内的 `##` 是数据不是结构。改为 `headingsOutsideFences()`，只统计**围栏外**的标题行。

### 9.5 死代码清理（本轮）

`buildTaskDispatchPrompt` / `summarizeTasks` 经全仓 grep 确认零生产调用者。删除后
`buildRepairPrompt` 的唯一调用者（`buildTaskDispatchPrompt:113`）也消失，一并成为孤儿 ——
真实修复路径是 `cli-agent.ts:381` 与 `sensenova-api.ts:178` 各自内联拼装，与它无关。

三个函数全部删除。**测试覆盖没有丢**：原 3 条针对死函数的断言，改写为针对
`CliAgentAdapter.writePrompt()` 产出的**真实 prompt 文件**与 `SensenovaApiAdapter`
发出的**真实 chat message**。

### 9.6 验证

| 项 | 结果 |
| --- | --- |
| `src/prompt-injection.test.ts` | **32 例**：schema 13 例（8 类非法字符 / traversal / 超长 / 错误定位）；`prompt-text` 9 例；**真实路径 10 例** —— `CliAgentAdapter` 7 例（title/zone/taskId 注入、真实标题集合、digest 注入、digest 自带围栏）+ `SensenovaApiAdapter` 3 例 |
| **变异验证（层 1+2）** | 关白名单 + `inlineField` 直通 → **13 条真红** |
| **变异验证（层 2 接线）** | ①`cli-agent` title 回退裸值 + digest 回退硬编码围栏 → **3 条真红**；②`sensenova-api` title/zone 回退裸值 → **2 条真红**。恢复后字节级一致 |
| `npm run verify` | **596 passed / 6 skipped**（上一轮 590），typecheck 3 套 + lint + build + artifact smoke（52 文件 `node --check` 0 错误）+ snapshot-secrets |

**方法论再确认**：`fencedBlock` 这一轮的教训是 —— 纯函数测试全绿**不代表产能**。
若当时只跑 `npm run verify`（590 全绿）就收工，这个缺陷会被完整地带进主干。
发现它靠的是**给真实路径写断言时，真路径的行为和 helper 的承诺对不上**。

---

## 十、剩余工作

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| C1 | `ipc.ts` 拆 handlers | ✅ `81b3e3c` |
| C2 | 持久化原子写 + audit 保留策略 | ✅ `81b3e3c` |
| C3 | path-policy realpath / 大小写归一 | 已定性 **P2**（fail-closed 误拒，不改） |
| C4 | 子进程 env 最小化 | ✅ `743c9fb` |
| C5 | 补测试 | ✅ C5a（ipc 契约 + env e2e）+ 本轮 32 例 |
| — | zone 白名单 + 渲染防护 | ✅ `9935ec1`（原 6.6 条，已更正定级） |
| — | 层 2 接线修复（`fencedBlock` / `sensenova-api`） | ✅ 本轮 §9.4 |
| — | 死代码清理（3 个函数） | ✅ 本轮 §9.5 |
| — | **未接线检测门禁**（`check:unwired`） | ✅ 本轮 §9.7 |
| — | **变异验证门禁**（`mutation:quick`）+ 修复 `glob.ts` 断言缺口 | ✅ 本轮 §9.8 |
| — | Renderer 错误边界 + 状态回滚（7 处）+ `zone-coverage` 三处 `continue` 缺口 | ✅ 第十二章 `221923b` |

**第十一章（独立复核）新增项**：

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| — | 熔断器重复记账 → 阈值 3 实际 2 次即熔断 | ✅ §11.2 |
| — | legacy `ZoneGuard` 分支生产不可达 + 死参 | ✅ §11.3 |
| — | `admitBreaker` 兜底查找的 `&&` 断言缺口 | ✅ §11.4 |
| — | `scheduler.ts` 接入变异目标（6 → 7 个） | ✅ §11.6 |
| — | `orchestrator.ts` 是否同属集成层盲区 | ✅ 已核查：5/5 全杀，**无缺口** §11.8 |
| — | 变异目标成本分层（tier 1/2，`--tier=`） | ✅ §11.8 |
| — | 门禁自身缺陷：基线失败被静默容忍 | ✅ §11.9 |

**`verify` 当前全链路**（每步都可复现，耗时实测 80s）：

```
typecheck(3 套 tsconfig) → lint → check:unwired → vitest → mutation:quick
  → vite build → build:headless → smoke:artifact → smoke:snapshot-secrets
```

### 9.7 把「未接线」变成门禁（本轮）

§9.4 的缺陷（helper 写了但生产零调用）**无法靠 `npm run verify` 发现** ——
当时 590 项全绿。既然如此，就不该指望下一轮靠运气再撞见它。

新增 `scripts/check-unwired.mjs`，接进 `verify`（在 lint 与 test 之间）：

```
npm run typecheck && npm run lint && npm run check:unwired && npm test && ...
```

**判定口径**：

| 维度 | 规则 |
| --- | --- |
| 查什么 | 只查**运行时**导出（`function` / `const` / `class` / `enum`）。`interface` / `type` 零引用通常无害，不查 |
| 算接线 | ①同文件内部有调用（`topologicalSort` 被同文件 `planBatches` 调）②存在**非测试**文件引用 |
| 不算接线 | **测试文件引用** —— 这正是要抓的「单测全绿但生产零调用」 |
| 已接受项 | 写在 `ACCEPTED` 白名单，每项附理由。**新增未接线项 → exit 1** |

**当前扫描结果**：104 个源文件，11 个生产零调用的运行时导出，**全部已评审接受**
（测试辅助 4 个、便利包装 4 个、诊断/封装 2 个、测试 fake 1 个）。

**本轮清掉的 3 个真死代码**：`isLegacyAdapter`、`nextStage`、`getAgentLayer`、
`pendingEscalationMap`（4 个）。删除后测试数**不变**（596）—— 反证它们确实零覆盖。

**变异验证**：临时加一个未接线导出 → 门禁 **exit 1** 并精确点名；恢复后 PASS。

**设计取舍（记录一次失败尝试）**：曾想用 fixpoint 迭代抓「链式死代码」
（A 只被死代码 B 调用）。实测**误报 74 个**在用的符号（`inlineField` / `Scheduler` /
`parsePrd`…），因为「引用者都死」的判定在有循环依赖时失控。
误报比漏检更消耗信任 —— **回退到单层判定**，把局限写进脚本注释。
这条记在这里，是为了下次不要重复踩。

### 9.8 把「测试空转」变成门禁（本轮）

§9.7 解决的是「**没有测试看着它**」。
还剩一类更难看的形态：**有测试，测试也全绿，但断言根本不敏感** ——
把生产代码的 `&&` 改成 `||`，测试照样绿。`check:unwired` 抓不到这个，
因为符号确实被生产代码调用了。**调用 ≠ 被验证。**

新增 `scripts/mutation-check.mjs`，接进 `verify`（在 test 之后）：

```
... && npm test && npm run mutation:quick && npm run build && ...
```

**做法**：对每个目标模块逐个施加变异算子 → 跑对应测试 → 测试变红记「杀死」，
仍绿记「存活」。**存活即失败**（`MAX_SURVIVORS = 0`）。

**目标模块与算子**：

| 维度 | 内容 |
| --- | --- |
| 目标（6 个安全关键模块） | `sandbox/path-policy` · `shared/glob` · `shared/redact` · `shared/prompt-text` · `agents/scoped-env` · `shared/zone-coverage` |
| 算子（7 个） | `&&→\|\|` · `\|\|→&&` · `===→!==` · `!==→===` · `return true→false` · `return false→true` · `continue→break` |
| 杀死判定 | 测试非零退出**即算杀死** —— 含类型错误。**编译失败是有效防线**，不需要先跑一遍语法预检 |
| 安全保护 | ①改写前后比对 ②`try/finally` 恢复 ③`process.on("exit"/"SIGINT"/"SIGTERM")` 兜底恢复 |

**本轮变异验证发现的真实缺陷（这是门禁的价值证明）**：

`shared/glob.ts:91` 的 `isPathInZone` 模块文件规则：

```ts
if (p.startsWith(`${z}.`)) {
  const rest = p.slice(z.length + 1);
  return rest !== "" && !rest.includes("/");   // ← 两个半句都是承重的
}
```

把 `&&` 变异成 `||` 后，**全部用例仍然绿**。手工复现三个差异点：

| 输入 | 原版 | `&&→\|\|` 后 | 后果 |
| --- | --- | --- | --- |
| `isPathInZone("src/duration.", "src/duration")` | `false` | `true` | 空后缀被当成模块文件 |
| `isPathInZone("src/duration.sub/x.js", "src/duration")` | `false` | `true` | **嵌套路径被错误纳入 zone** |
| `isPathInZone("src/duration./x.js", "src/duration")` | `false` | `true` | 同上 |

后两条是**沙箱 zone 边界被放宽** —— 与函数注释里明写的 "bounded" 意图相反。
两个半句在整个测试集里**从未被单独触发过**，所以谁都发现不了。

**修法**：在 `src/glob.test.ts` 新增一个用例，把三个差异点各钉一条断言
（含注释写明「由变异测试发现」）。变异从**存活 → 杀死**。

**验证**：

| 项 | 结果 |
| --- | --- |
| `npm run mutation`（limit=8，全目标） | **杀死 22/22（100%）**，33–36s |
| `npm run mutation:quick`（limit=1，verify 内） | 6/6，14s |
| `npm run verify` 全流程 | **全绿**，80s（含两个新门禁） |
| 测试数 | 596 passed / 6 skipped |

**性能取舍（记录一次失败实现）**：首版每个变异先跑一次 `tsc` 单文件语法检查，
Windows 上单次约 40s，6 个变异 5.5 分钟跑不完被 SIGTERM。
**根因是把「类型错误」误当成需要排除的噪音** —— 实际上类型错误正是类型系统抓到了改动，
属于有效防线。删掉预检后 33s 跑完全部 22 个变异，**提速约 20 倍**，
行为语义反而更正确。同时消除了预检 `finally` 未生效留下的 `.mutation-probe.ts` 脏文件。

**方法论**：这是本轮的第三层，三层递进关系值得记牢 ——

| 层 | 门禁 | 挡住的形态 | 抓不到 |
| --- | --- | --- | --- |
| 1 | `tsc` / `lint` | 类型错、风格错 | 逻辑错 |
| 2 | `check:unwired` | helper 生产零调用 | 调用了但没验证 |
| 3 | `mutation` | 断言不敏感（测试空转） | 未纳入目标的模块 |

**未覆盖范围（诚实记录）**：变异只跑 6 个模块，不是全仓。理由是变异验证的成本是
「每变异一次跑一遍测试」，全仓会从 33s 涨到小时级，将无法容忍地拖慢 `verify`。
选择标准是**安全关键 + 纯逻辑密集**；后续可按此标准增补目标。

---

## 十一、第四类盲区：集成层的类内缺陷（独立复核发现 + 本阶段修复）

### 11.1 为什么要单独记这一章

本章不是自我评审的续写，而是**换一个视角独立复核**的产物：不复述第七章结论，
直接读代码 + 实测。结果在三层门禁之上暴露了第四类形态 —— 而它**不是**
「未接线」（门禁 2 管）也不是「断言不敏感」（门禁 3 管）。

**共同特征**：缺陷既不在「导出符号」维度上，也不在「纯逻辑模块」维度上，
而在**有状态、有 IO 的集成层（调度器/引擎）**，而门禁 2 与变异目标恰好都不覆盖这一层。
实测命中三处。

### 11.2 缺陷一：熔断器重复记账（真实路径，有量化后果）

`scheduler.ts` 的 `catch` 分支里 `breaker.record(agent.meta.id, false)` **被调用两次**
（`:333` 与 `:343`）。`CircuitBreaker.recordFailure` 每次都会 `consecutiveFailures += 1`。

实测（构造 `dispatch()` 抛错的 adapter，用 `dist-electron` 真跑 `Scheduler.runBatch`）：

| 时点 | 修复前 | 期望 |
| --- | --- | --- |
| 第 1 次 runBatch 后 | `consecutive = 2` | `1` |
| 第 2 次 runBatch 后 | `state = open`（越过阈值 3） | 仍 `closed` |
| `allow(id)` | `false` —— agent 被跳过 60s | `true` |

**后果**：dispatch 失败路径（真实网络失败 / 子进程启动失败都会走）下，
agent 被**提前一次**熔断。不是安全洞，是可用性与归因偏差。

**为什么三层门禁全漏**：

- `check:unwired` 只扫**导出符号**，`Scheduler` 类内的私有分支不在扫描面内；
- 变异目标只有 6 个纯逻辑模块，**不含 `scheduler.ts`**；
- 全仓只有 **1 处**断言 `stats.failures`（`sandbox-runtime.test.ts:365`，测的是
  CircuitBreaker 自己的单次 `record`）—— **没有任何断言触碰 Scheduler 集成层的记账次数**。

**修法**：删掉重复调用，补注释说明「一次失败恰好记账一次」。

### 11.3 缺陷二：legacy `ZoneGuard` 分支生产不可达，却被测试殷勤覆盖

`runBatch` 里的 `const before = !guard && this.zoneGuard ? … : null`，其后整块 legacy
判定（原 `:359-372`）在 `this.zoneGuard` 为 `undefined` 时永不进入。全仓 grep
`new Scheduler(`：**生产只有一处** —— `platform.ts:168`，第三参写死 `undefined`
（正是 B1 那次"死参彻底消失"的修改本身留下的尾巴）。`new ZoneGuard()` 作第三参
**只出现在测试**（`scheduler.test.ts:154/186`、`sandbox-journal.test.ts:328`）。

这是比"纯死代码"更麻烦的形态：**测试在给一条生产不可达的路径背书**，
覆盖率数字因此好看，门禁 2（非导出）与门禁 3（不在目标）都碰不到它。
该块里还有一处 `o.ok ? {…} : {…}`，**两个分支表达式完全相同**，三元纯属冗余 ——
也是"写的时候没有真正检查"的留痕。

**修法（按 §9.5 的既有流程，不是跟着删覆盖）**：

| 动作 | 说明 |
| --- | --- |
| 删分支 + 删死参 | `Scheduler` 第三参 `zoneGuard` 与整块 legacy 判定删除；类注释写明**为什么删** |
| 迁移 `sandbox-journal.test.ts` 的 legacy 用例 | 改写为「无 guard ⇒ 不做批量越权判定」（真实行为的边界），断言 `ok === true` 且文件留盘 |
| 迁移 `scheduler.test.ts` 的越权用例 | 删掉 `ZoneGuard` 版（语义已由 `sandbox-journal.test.ts:300` 的真实 guard 路径覆盖，且那条更强：还断言了回滚）；把「合法写入不被误伤」改写到 **真实 BatchGuard 路径**，并断言文件内容未被回滚 |

**保留 `ZoneGuard` 类本身**：它仍是 `FileJournal` 方案的性能基准对照物
（`sandbox-journal.test.ts:100` 断言 journal 比全量内容扫描便宜），删除会连带削弱
`shared/glob.ts`（变异目标之一）的边界覆盖 —— 收益不抵风险。

### 11.4 缺陷三：熔断兜底查找的 `&&`（由门禁增强当场抓出）

见 §11.6 —— 把 `scheduler.ts` 接入变异目标后，首个实验就抓到它。

### 11.5 变异验证（三处改动逐一钉死）

| 变异 | 预期 | 实测 |
| --- | --- | --- |
| 恢复重复记账（`record` 调两次） | 新断言真红 | ✅ `expected 2 to be 1`，**仅**该条失败，退出码 1 |
| 无 guard 时伪造失败（`zones.length > 0 → ok: false`） | 迁移后的边界断言真红 | ✅ `expected false to be true` |
| `admitBreaker` 的 `&& → \|\|` | 新断言真红 | ✅ 存活 1 个 → 定位 → 补断言 → 4/4 全杀 |

三次变异均**字节级恢复**（`cp` 回备份 + `md5sum` 比对一致，不靠手改）。

### 11.6 门禁增强：把 `scheduler.ts` 接入变异目标

§11.2 的结论是「门禁 3 只覆盖纯逻辑模块，集成层是盲区」。既然如此，就让门禁覆盖它。

**接入当天第一个实验就抓到真缺陷**（这就是门禁的价值证明）：

`admitBreaker` 的兜底查找 `available.find((a) => a.meta.id !== wanted.meta.id && breaker.allow(a.meta.id))`
把 `&&` 改成 `||` 后，**21 条用例全绿**。语义差异：

| 场景 | 原版 | `&& → \|\|` 后 | 后果 |
| --- | --- | --- | --- |
| `wanted` 被熔断，替代品 `a2` 也被熔断 | 返回 `undefined` → "no agent available" | 返回 `a2` | **任务被派给一个已熔断的 agent，熔断静默失效** |

补一条断言（两个 agent 的熔断都被打开 → 断言 `no agent available` 且 `dispatched` 为空）
后，该变异由**存活 → 杀死**，`--file=scheduler` 从 3/4 变为 **4/4（100%）**。

**成本**：`scheduler.ts` 接入后 `verify` 内仍是 `--limit=1`（每目标 1 个变异），
`npm run mutation` 全 7 目标实测 **33s 量级**，与接入前同阶。

### 11.7 四层递进关系（本章更新）

| 层 | 门禁 | 挡住的形态 | 抓不到 |
| --- | --- | --- | --- |
| 1 | `tsc` / `lint` | 类型错、风格错 | 逻辑错 |
| 2 | `check:unwired` | helper 生产零调用 | 调用了但没验证 |
| 3 | `mutation` | 断言不敏感（测试空转） | 未纳入目标的模块 |
| 4 | **`mutation` 扩展目标（本轮）** | **集成层类内缺陷** | 仍未纳入的模块（如 `orchestrator.ts`） |

**第三 → 第四层的区别不在机制，而在覆盖对象。** 第四类缺陷被抓住，靠的不是新工具，
而是把门禁 3 的目标从"纯逻辑"扩到"有状态集成层"。

### 11.8 `orchestrator.ts` 已核查：**不在盲区**，但需要成本分层

§11.7 留下的问题是"`orchestrator.ts` 是否也在这片盲区里"。既然假设提出来了，就去验。

实测（`--file=orchestrator --limit=8`）：

| 项 | 结果 |
| --- | --- |
| 变异 | `&&→\|\|` · `\|\|→&&` · `===→!==` · `!==→===` · （`return true→false` 无命中，过滤） |
| 结果 | **5/5 全杀（100%）**，无存活 |
| 耗时 | **2 分 7 秒**（对比 `scheduler.ts` 的 4 个变异只用 9s） |

**结论：不在盲区。** 它那 30 条用例（happy path / repair loop / escalation 三分支 /
依赖守卫 / journal 续跑 / 独立样本冒烟 / 取消补终态 / zone 覆盖校验）的断言足够敏感 ——
这才是"集成层盲区"批评的**正确处置方式**：逐个模块测，而不是整体断言一句"引擎层没覆盖"。

**但它太贵**：`orchestrator.test.ts` 30 条用例含多轮重修循环，单次约 20s。
直接加进 `TARGETS` 会让 `verify` 从 75s 涨到 ~100s（+33%），
而 `npm run mutation` 从 35s 涨到 ~2m47s。

**修法：给目标加 `tier` 成本分层**（这是成本分层，不是重要性分层）：

| tier | 目标 | 单次测试 | 谁来跑 |
| --- | --- | --- | --- |
| 1 | path-policy · glob · redact · prompt-text · scoped-env · zone-coverage · scheduler | ~2s | `mutation:quick`（verify 内，`--tier=1 --limit=1`）+ 全量 |
| 2 | orchestrator | ~20s | 仅 `npm run mutation`（全量） |

**实测**：全量 8 目标 **31/31（100%）**，2m47s；`verify` 内仍是 7 个变异，**耗时不变**。

### 11.9 顺带修掉门禁自身的缺陷：基线失败被静默容忍

做 §11.8 的反向实测时（往 `orchestrator.ts` 注入语法错误，验证 `--tier=1` 是否真的不碰它）
撞见了这个：

```
$ node scripts/mutation-check.mjs --tier=1 --limit=1     # 期望：完全不受影响
总计：杀死 7/7（100%）
PASS: 无存活变异，测试对目标模块的改动敏感

$ node scripts/mutation-check.mjs --limit=1              # 期望：报 orchestrator 基线失败
electron/engine/orchestrator.ts
  基线失败，无结论
总计：杀死 7/7（100%）
PASS: 无存活变异，测试对目标模块的改动敏感                # ← 照样 PASS，exit 0
```

**注意 orchestrator 那 5 个变异一个都没跑** —— 它被静默容忍了。
原实现把「基线测试未通过」当作"无结论"打印一行 `continue` 掉：不计入 `totalRan`、
不影响 `survivors`、不影响退出码。

**为什么这是真问题（而不是"少跑一个目标"）**：

| 诱因 | 后果 |
| --- | --- |
| 测试文件路径写错（改名 / 移动） | 该目标**覆盖静默归零**，门禁永远绿 |
| 测试被改坏（或误删断言） | 同上，且没人会知道 |
| 被测源码有语法错误 | 同上 |

三种诱因的共同点是：**"这个目标没有被验证"这件事本身不会让门禁变红**。
这与「CI 里写错路径、从来没有真正跑过的 job」是同一族问题 —— 空转门禁。

**修法**：`baselineFailures` 非空 → `exit 1`，点名到 `文件 :: 测试文件`，
并列出常见诱因。理由与 §6.3/§9.2 的成本论证一致：
**在这里失败 = 一次定位；静默跳过 = 覆盖永久归零且不可见。**

**实测（双向）**：

```bash
#注入语法错误后
$ node scripts/mutation-check.mjs --limit=1 ; echo "exit=$?"
FAIL: 1 个目标的基线测试未通过 —— 这些目标**完全没被验证**：
  electron/engine/orchestrator.ts  ::  src/orchestrator.test.ts
exit=1

#恢复后
$ npm run mutation
总计：杀死 31/31（100%）
PASS: 无存活变异，测试对目标模块的改动敏感
exit=0
```

**方法论教训（值得单独记）**：给门禁**增加能力**时，必须同时验证
**"门禁自己失灵的时候，它会不会红"**。本节的两项工作顺序恰好说明了这点 ——
我本来是去做"验证 `--tier` 隔离生效"的反向实测，结果反向实测抓出了门禁的另一处失灵。
只做正向验证（"加了目标之后仍然全绿"）永远发现不了它。

### 11.10 四层递进关系（本章终版）

| 层 | 门禁 | 挡住的形态 | 抓不到 |
| --- | --- | --- | --- |
| 1 | `tsc` / `lint` | 类型错、风格错 | 逻辑错 |
| 2 | `check:unwired` | helper 生产零调用 | 调用了但没验证 |
| 3 | `mutation` | 断言不敏感（测试空转） | 未纳入目标的模块 |
| 4 | `mutation` 扩展目标 | 集成层类内缺陷 | 未纳入目标的模块（**已按模块逐个核查**） |

**第 4 层已核实的结论**：`scheduler.ts` 有三处缺陷（§11.2–11.4），
`orchestrator.ts` 无（§11.8）。**没有第 5 层** —— 剩下的只是"还没纳入的目标"，
按 §11.8 的 tier 机制可以低成本继续扩。

---

## 十二、第五类盲区：Renderer 层的错误边界（commit `221923b`）

### 12.1 为什么这一层是盲区

第十一章结束时，门禁覆盖的是 `shared/`（纯逻辑）、`electron/`（引擎与沙箱）。
**Renderer 层（`src/store.ts` + 4 个页面 + 1 个面板）几乎不在门禁里** ——
`ui.test.tsx` 只做"每个页面能渲染出来、按钮能调到 bridge"的冒烟，
**没有一个用例问过"IPC 失败之后，状态机停在哪种状态"**。

按 §11 的口径：这不是"还没纳入的目标"那么简单，而是**整层没有断言维度** ——
错误路径零覆盖。

### 12.2 做法：先写探测用例，再修

沿用第九章的纪律：**不凭代码形状推断**。先写 6 个探测用例（新建
`src/store-errors.test.ts`），跑一遍 —— **6 个全部真红**，逐条修。

| # | 缺陷 | 实测后果 |
| --- | --- | --- |
| 1 | `refreshProjects` 无 try/catch | 挂载即调用，reject → unhandled rejection，列表静默为空（与"还没有项目"无法区分） |
| 2 | `createAndOpen` 无 try/catch | 创建失败时抛出，无任何用户可见错误 |
| 3 | `deleteProject` 无 try/catch | 同上；失败时不该从列表移除（工作区仍在磁盘上） |
| 4 | `loadSettings` 失败**不写** `settingsError` | 见 12.3 |
| 5 | `resolveEscalation` 乐观更新不回滚 | 见 12.4 |
| 6 | `runPlanning` 并发无守卫 | 慢的旧请求覆盖新的，看板显示过期 PRD |
| 7 | 无 React ErrorBoundary | 任何 render 抛错 = 整页白屏，只能重启应用（§12.5） |

### 12.3 #4 值得单独说：注释承诺了，实现没做到

`loadSettings` 的函数注释白纸黑字写着：

> Unguarded before: a rejected IPC call … escaped as an unhandled rejection and
> the settings page **silently showed defaults — indistinguishable from
> "nothing configured yet"**.

但实现里 catch 分支**只写了日志，没有写 `settingsError`**。而设置页：

- `settings === undefined` → 渲染 `DEFAULT_SETTINGS`
- `disabled={saving || !settings}` → **保存按钮永久禁用**

于是失败的真实后果是：用户看到一份默认值、改一堆配置、点不了保存，
**且没有任何提示解释为什么**。注释要解决的那个问题，一个字都没解决。

**教训**：**注释不是证据。** 它对"已修复"的承诺，只有断言能兑现。
这条与 §9.4 同族（helper 写了但没接线），不同之处在于这里**注释本身就是误导源** ——
读代码的人会以为已经处理过了。

修法：catch 里写 `settingsError`；UI 文案按 `settings` 是否加载成功区分
「读取失败 / 保存失败」—— load 失败时说"保存失败"会让人去找一次
根本没发生过的写操作。

### 12.4 #5 乐观更新不回滚 = 操作入口消失

```ts
set(...)                              // 先把 escalation 标成 resolved
await api().resolveEscalation(...)    // 失败 → 只加一条日志
```

`resolved: true` 之后，BoardPage 把三个按钮（跳过 / 重派 / 终止）
替换成一行 `已处理`。**IPC 失败后入口消失，用户再也点不到**，
而引擎其实没收到这次决策。

修法：catch 里把该项回滚成 `before`（乐观更新前先存一份）。

### 12.5 #7 ErrorBoundary

新增 `src/components/ErrorBoundary.tsx` 包住整个 `App`。
render 期抛错原本会卸载整棵树 —— 空白窗口，只能重启。
现在降级成一个可恢复的面板（显示 message + 「重试渲染」/「重启界面」）。

### 12.6 变异门禁的两个新教训（本轮最有价值的产出）

#### ① 漏挂测试文件 = 那部分逻辑没有门禁

把 `src/store.ts` 加进变异目标时只挂了两个测试文件，**`|| → &&` 存活**。
那个 `||` 是 `newProjectName.trim() || "未命名项目"` ——
**唯一的断言在 `ui.test.tsx` 里**，没挂上。

> 这是「覆盖率数字骗人」的翻版：**挂了测试，但只覆盖了这个文件的一半。**

修法：目标支持 `tests` 数组，把一个模块的**所有**测试文件都挂上，任一失败即杀死。

#### ② `replaceAll` 变异必须拆单点（三处全中，零等价变异）

`shared/zone-coverage.ts` 的 `continue → break` 存活。全局替换**命中 3 处**，
拆开逐处验：**三处全部是真缺口，一个等价变异都没有**。

| 处 | 守卫 | 改成 break 的后果 |
| --- | --- | --- |
| 1 | `prev` 是 `.` / `/` / `\` | 遇到 `../x/y.js` 就终止提取 |
| 2 | `cleaned` 含 `..` | 遇到 `a..b/c.js` 就终止 |
| 3 | `segments.length < 2`（裸文件名） | **遇到 `package.json` 就终止** |

共同根因：所有既有用例要么全是有效 token、要么全是无效 token，
**没有一个让「被跳过的 token」出现在「有效路径」之前**。

第 3 处最危险，因为 PRD 里**几乎必然**会先提到 `package.json`
（"不要改动 package.json" 是最常见的约束句式）：

```
PRD: "不要改动 package.json；新增 src/cli.js"
原版  → 跳过 package.json，提取 src/cli.js     → 覆盖校验正常
变异版 → 在 package.json 处 break，src/cli.js 丢失
       → 校验认为"没有声明路径" → 放行
       → 该计划会永远产生 zone 越权，正是本模块为之所写的那个事故
```

补 1 个用例（3 条断言）后三处全部由存活转杀死。

**操作法**：`cp` 备份 → 只改一处 → 跑测试 → `cp` 回去 →
`git diff --stat` 确认源文件干净。本次用临时脚本一次跑完三处，
末尾自己校验"字节级一致"，用完即从临时目录删除。

### 12.7 验证

| 项 | 结果 |
| --- | --- |
| 探测用例 | 写时 **6/6 真红**，修后 6/6 绿 |
| `npx vitest run` | **609 passed / 6 skipped**（596 → 609，+13） |
| `npm run mutation` | **35/35 全杀** |
| `npm run verify` | 全绿 |

### 12.8 五层递进关系（终版）

| 层 | 门禁 | 挡住的形态 | 抓不到 |
| --- | --- | --- | --- |
| 1 | `tsc` / `lint` | 类型错、风格错 | 逻辑错 |
| 2 | `check:unwired` | helper 生产零调用 | 调用了但没验证 |
| 3 | `mutation` | 断言不敏感（测试空转） | 未纳入目标的模块 |
| 4 | `mutation` 扩展目标 | 集成层类内缺陷 | 未纳入目标的模块 |
| 5 | `mutation` 扩展目标 + **挂全测试文件** | **整层无断言维度**（如 Renderer 错误路径） | 未纳入目标的模块 |

---

## 十三、agents 层接入变异门禁（commit `72b4987`）

### 13.1 动机

第十二章结束时门禁覆盖 `shared/` + `electron/engine/` + `src/store.ts`。
**`electron/agents/` 2259 行里只有最小的 `scoped-env.ts`（160 行）在册** ——
而 `sensenova-api` 是 `DEFAULT_SETTINGS` 里的**默认适配器**，
即新装用户实际跑的那条路径（§9.4 的接线缺陷就出在这里）。

按 §11.8 的 tier 机制新增 4 个 tier 2 目标：`manifest-schema` / `registry` /
`cli-agent` / `sensenova-api`。

### 13.2 首跑 5 个变异存活，拆单点后 7 处全是真缺口

存活算子只有 5 个，但拆开位点后有 7 处 —— **全部是真缺口，零等价变异**
（§12.6 的教训再次应验：连中两轮，3/3 与 7/7）。

| 文件 | 位点 | 变异后的真实后果 |
| --- | --- | --- |
| cli-agent | `!run \|\| finished` → `&&` | abort 未知 runId 时 `run.session` 抛 TypeError |
| cli-agent | `lastKind === "failed" && exitCode === null` → `\|\|` | 任何未退出的 run（含正在跑的）被标成 retryable timeout |
| cli-agent | `oldest !== undefined` → `===` | **results 永不淘汰 → 无限增长**（非空 Map 的 key 不是 undefined） |
| sensenova | `!session \|\| finished` → `&&` | 同上 TypeError |
| sensenova | files 载荷校验三选一 → 三者兼具 | 校验几乎永不触发，模型返回什么都照收 |
| sensenova | `start < 0 \|\| end <= start` → `&&` | 落到 `JSON.parse("")`，报 JSON 解析错而非可行动的提示 |
| sensenova | `return false` → `true` | 每次都声称"并发槽位已满排队"，误导排查 |

### 13.3 补断言的三条写法（可复用）

**① 私有方法用反射，别硬跑真实流程。**
验"结果缓存会淘汰"真跑 51 个子进程要几十秒，反射调私有方法 1ms。

**② 断言错误消息，而不是"是否抛错"。**
变异版常换个地方抛 —— `parseFiles("} {")` 原版抛「找不到 JSON 对象」，
变异版落到 `JSON.parse("")` 抛 SyntaxError。**两者都抛，只断言 `toThrow()` 会假绿。**

**③ 补反向断言。**
`return false → true` 存活时，测试里**已经有**「排队的任务会报排队」。
缺的是反面：**槽位空闲时绝不能出现排队提示**。

> 一个布尔标志位被断言了「真」的那一面，不等于「假」的那一面有守护。
> 看到存活变异时先问：**这个条件的反面有人测吗？**

### 13.4 tier 分层的价值兑现

4 个新目标全放 tier 2（慢），`verify` 的 quick 档**仍是 8/8、耗时零增长**
（1m21s，与加目标前完全一致）。全量扫描从 35/35 涨到 **44/44**。

> 分层是**成本维度**，不是重要性维度。新目标慢就别塞进快速门禁 —— 这条判断成立。

### 13.5 验证

| 项 | 结果 |
| --- | --- |
| `npx vitest run` | **616 passed / 6 skipped**（609 → 616） |
| `npm run mutation -- --file=agents` | **24/24 全杀** |
| `npm run mutation`（全量） | **44/44 全杀** |
| `npm run verify` | 全绿，耗时未变 |

### 13.6 当前门禁覆盖全景

> ⚠️ 本节随门禁扩张**多次过时**。截至 2026-09-22 晚，`TARGETS` 共 **40 个目标**
> （权威来源是 `scripts/mutation-check.mjs` 的 `TARGETS` 数组，不要在文档里数）。
> 最近一次更新见 §14.3。历史遗留的一句「仍未纳入 `http-bridge` / `manifest-loader` /
> `run-session`」已失效 —— 三者分别在 `944baf5`、`944baf5`、`3cd4b74` 接入。

| 区域 | 目标模块 |
| --- | --- |
| `shared/` | `glob` · `redact` · `prompt-text` · `zone-coverage` · `graph` · `llm-client` · `http-clients` · `schema` |
| `electron/sandbox/` | `path-policy` · `command-policy` · `spawn-plan` · `circuit-breaker` · `timeout-gate` · `file-journal` · `snapshot-store` · `kill-tree` |
| `electron/agents/` | `scoped-env` · `manifest-schema` · `manifest-loader` · `registry` · `cli-agent` · `sensenova-api` · `http-bridge` · `run-session` |
| `electron/engine/` | `scheduler` · `orchestrator` · `router` · `batch-guard` · `verifier` · `zone-guard` |
| `electron/ipc/` | `orchestration` · `projects` · `agents` · `context` |
| `electron/`（根） | `keys-store` · `platform` |
| `headless/` | `protocol` |
| `src/`（Renderer） | `store` |

---

## 十四、测试与优化：门禁盲区扫描（2026-09-22 晚）

### 14.1 方法：用覆盖率反查门禁盲区

前十三章的扩张方式是「按区域逐个纳入」（沙箱层 → agents 层 → 引擎层 → IPC 层）。
本轮换一个入口：**先跑覆盖率，再和 `TARGETS` 清单做差集**，找
「不在门禁内 **且** 覆盖偏低」的模块。比按区域扫更省力，因为它自带优先级排序。

跑法（两次，**必须串行** —— 见 §14.5）：

```
npx vitest run --coverage       # 拿到各文件 stmts/branch/funcs
```

筛出的三个模块，共同特征是**都在关键路径上、却不在 40 个目标内**：

| 模块 | 行数 | stmts | funcs | 为什么值得纳入 |
| --- | --- | --- | --- | --- |
| `electron/platform.ts` | 235 | 77.08% | **47.36%** | 双入口唯一装配点，P1-1 双端漂移就出在这里 |
| `headless/protocol.ts` | 326 | 82.82% | — | 宿主 ↔ 进程的契约面，326 行 |
| `electron/engine/zone-guard.ts` | — | 91.3% | — | zone 沙箱的 before/after diff 实现 |

### 14.2 首跑 9 个位点存活 —— **零等价变异**（连续第三轮）

把三个模块临时接入门禁（先不改测试）跑全量算子：

```
electron/platform.ts          杀死 2/3（67%）   存活：!== → ===
headless/protocol.ts          杀死 4/5（80%）   存活：continue → break
electron/engine/zone-guard.ts 杀死 2/3（67%）   存活：continue → break
```

聚合结果是 3 个存活，但**变异算子用 `replaceAll` 全局替换**，`continue → break`
在 `protocol.ts` 命中 4 处、在 `zone-guard.ts` 命中 4 处。按 §12.6 的纪律拆单点：

| 文件 | 位点 | 拆开后 |
| --- | --- | --- |
| `zone-guard.ts` | 48 / 50 / 52 / 57 | **4/4 全真缺口** |
| `protocol.ts` | 158 / 163 / 167 / 172 | **4/4 全真缺口** |
| `platform.ts` | 114 | **1/1 真缺口** |

**9 个位点全部是真缺口，没有一个等价变异。** 这已经是连续第三轮出现这个结果
（§12.6 的 3/3、§13.2 的 7/7，现在 9/9）——
**「多半是等价变异」这个直觉不可靠，必须真拆。**

### 14.3 缺口的共同形态：**「被跳过的项永远是最后一项」**

九处缺口其实只有两种根因，都指向同一个测试设计缺陷。

**根因 A：`continue` vs `break` 分不开，因为循环里最后一个元素才触发跳过。**

`scanFiles`（zone-guard）和 `parseCommands`（protocol）里都有若干
「跳过这一项、继续下一项」的 `continue`。旧用例的通病是：只放**一个**触发跳过的项，
或者让触发跳过的项**排在同级最后**。这两种情况下 `continue` 与 `break` 行为完全相同，
于是测试断不出任何差异 —— 而实际后果是**同类项被静默丢弃**：

| 位点 | 变异后的真实后果 |
| --- | --- |
| `zone-guard:48` | 遇到 `node_modules` 直接终止整个目录遍历，同级的其他文件全部漏掉 |
| `zone-guard:50` | 递归进第一个子目录后就停，同级后续文件消失 |
| `zone-guard:52` | 遇到一个非普通文件（fifo/socket）就放弃整个目录 |
| `zone-guard:57` | 一个文件读失败（EACCES）→ 同目录其余文件全部不进快照 → **zone diff 出现假新增** |
| `protocol:158` | verificationCommands 里第一个非对象项 → 后面所有项不再校验 |
| `protocol:163/167/172` | 同上，宿主拿到不完整的诊断，得改几轮才能把 spec 改对 |

**`zone-guard:57` 是这批里唯一有安全含义的**：读文件失败被当成"目录扫完了"，
会让 diff 误报新增/删除，进而可能把**误判的** zone 越权算到任务头上（或反过来漏掉真实的越权）。

**根因 B：三态写成两态，缺省值那一格没人测。**

`platform.ts:114` 的 `settings.agentRouter !== false` 表达的是**三态**：
缺省（true）/ 显式 true / 显式 false 才关。现有用例全用默认 settings（true），
于是 `!==` 与 `===` 只在「缺省」这一格分开 —— 而那一格恰好没人测。
变异版会把**默认配置**判成"关闭路由"，即新装用户静默失去能力路由。

> **可复用的判据**：看到一个布尔表达式带 `!== false` / `!== undefined` 这类写法时，
> 先问「有没有三态？缺省那一格谁在测？」

### 14.4 补断言的两条写法

**① 让「被跳过的项」后面还有兄弟。** 这是拆开 `continue`/`break` 的唯一办法：

```ts
// 48 行：aaa 排在 node_modules 之前，保证 node_modules 不是最后一项
write("aaa/keep.js", "keep");
write("node_modules/pkg/index.js", "x");
write("zzz/also-kept.js", "kept");   // continue→break 时它会被整棵漏掉
expect(files).toEqual(["aaa/keep.js", "zzz/also-kept.js"]);
```

**② 用注入的 `FsLike` 造出真实文件系统里难复现的形态**（fifo、EACCES、EPERM）。
`ZoneGuard` 的构造函数接受 `fsImpl`，这是现成的测试缝：

```ts
const fakeFs = {
  existsSync: () => true,
  readdirSync: () => [
    { name: "bad.js",  isDirectory: () => false, isFile: () => true },
    { name: "good.js", isDirectory: () => false, isFile: () => true },  // 必须活下来
  ],
  readFileSync: (p: string) => { if (p.endsWith("bad.js")) throw new Error("EACCES"); return "ok"; },
};
```

注意**断言诊断文本而不是"是否抛错"**（§13.3 的教训）：`parseCommands` 的错误是
拼进 `ParseResult.message` 的，断言要落在 `message` 的具体片段上。

### 14.5 ⚠️ 操作纪律：**不要并发跑两个门禁**

本轮踩了一个，值得单独记：

`npm run mutation`（后台）与 `npx vitest run --coverage`（前台）**同时跑**，
coverage 那边报出 `src/kill-tree.test.ts` 失败（`hasExited` 断言翻转）。
看起来很像是真缺陷 —— 但真因是**变异脚本正在按设计改写源文件**
（`fs.writeFileSync(filePath, m.source)` → 跑测试 → 再写回）。
两个门禁同时读同一个工作区，必然互相污染。

**判据**：源文件 `git status` 干净 + 单独复跑该测试全绿 → 确认是并发污染。
**纪律**：变异门禁**独占**工作区，任何时候都不与另一个跑测试的命令并行。

### 14.6 验证

| 项 | 结果 |
| --- | --- |
| `npx vitest run` | **736 passed / 6 skipped**（716 → 736，**+20 例**） |
| `zone-guard.ts` 变异 | 2/3 → **3/3** |
| `protocol.ts` 变异 | 4/5 → **5/5** |
| `platform.ts` 变异 | 2/3 → **3/3** |
| **拆单点独立验证** | **9/9 全杀**，源文件 md5 字节级还原 |
| `npm run mutation`（全量 40 目标） | **152/152（100%）**，399.3s |
| `npm run verify` | 全绿（1m47s） |
| `check:unwired` | 109 源文件，4 个已接受，PASS |

覆盖率变化（`npx vitest run --coverage`，串行）：

| 模块 | stmts | branch | funcs |
| --- | --- | --- | --- |
| `zone-guard.ts` | 91.3 → **97.82** | 86.66 → **93.33** | 100 |
| `protocol.ts` | 82.82 → **88.88** | 80.64 → **83.87** | — → **100** |
| `platform.ts` | 77.08（未变） | 91.11 | 47.36 |
| 全仓 | 89.38 → **89.6** | 83.1 → **83.3** | 84.11 |

> **`platform.ts` 覆盖数字一点没动、变异却从 2/3 变成 3/3** —— 这是
> 「覆盖率数字骗人」的又一次实证：缺口在**断言敏感度**，不在**行覆盖**。
> 只补行覆盖、不补断言敏感度，等于没补。

### 14.7 剩余未纳入

`electron/engine/index.ts` · `electron/sandbox/index.ts` · `electron/main.ts` ·
`electron/preload.ts` · `headless/headless-main.ts` 仍是 0% 覆盖，
**刻意不纳入变异门禁** —— 它们是进程入口与 re-export barrel，
纳入需要起 Electron / 独立进程，成本与收益不成比例。

`electron/sandbox/snapshot-store.ts` 已在第十五章完成补强。

---

## 十五、第二轮盲区扫描：`snapshot-store.ts` 与**「聚合掩盖位点」**（2026-09-22 晚）

### 15.1 起手：覆盖率反查（同 14.1 的方法，换了目标）

`snapshot-store.ts` 是本轮唯一候选（沙箱层覆盖最低）。补强前：

| 指标 | 前 |
| --- | --- |
| Stmts | 80.64% |
| Branch | 73.91% |
| Funcs | 76.92% |
| Lines | 83.03% |

用 JSON reporter 精确定位未覆盖行（面板的 `Uncovered Line #s` 列被截断，
要么加宽终端，要么走 `--coverage.reporter=json` 自行解析 —— 后者可靠）。

缺口分七组：4 处 catch 分支 · `newlyCreated` 的三重过滤 · `collect` 的
`statSync` 单文件分支 · `include` 去重 · **两个零调用公开符号**。

### 15.2 两个公开符号：`hasBackup` 与 `withinZones`

- **`hasBackup`**：全仓 **零调用**（连测试都没有）。公开 API，无人使用。
- **`withinZones`**：只在 `electron/sandbox/index.ts:54` 被 **re-export**，
  而那个 barrel **没有任何模块 import** —— 生产代码全部走深路径直接引用
  （`./path-policy`、`./file-journal`）。

两者都不是 `check:unwired` 能抓的（`withinZones` 有 export 链，
`hasBackup` 是类方法）。这是「**barrel 无人消费**」这一类盲区：
barrel 本身 0% 覆盖被 14.7 列为"刻意不纳入"，但它**把模块内符号的覆盖拉低了**。

处理：为两者补直接断言（`hasBackup` 含反斜杠/`./` 归一化；`withinZones` 含
空数组恒假、`srcsibling` 与 `src` 前缀相同但不同目录）。是否删除 barrel 留给后续决策。

### 15.3 🔑 本轮最重要发现：**变异门禁的「聚合掩盖位点」**

`snapshot-store.ts` 的变异目标首跑 **2/2「全杀」** —— 但 **12 个 `continue;` 位点**
只产生了 **2 个变异**。原因：`continue → break` 算子用 `replaceAll` 全局替换，
**把 12 处一起改掉**，只要任意一处被杀死就报「杀死」。

**拆单点后实测：5 个位点存活。** 即「2/2 全杀」是**聚合假象**。

这与既有两条教训同族但形态不同：

| 教训 | 形态 | 门禁是否可见 |
| --- | --- | --- |
| `check:unwired` 抓不到断言不敏感 | 调用了但没验证 | 否 |
| **漏挂测试文件** | 挂了 A 文件，B 文件的断言不参与 | 否 |
| **聚合掩盖位点**（本轮新增） | 算子同时命中 N 处，只报聚合结果 | **否** |

**判别手法**：`--list` 看**算子数**，与源码里**算子字符的出现次数**比对。
数量不符（本例 2 vs 12）就说明存在聚合。**算子数与位点数不一致 = 必须拆单点。**

**拆单点的临时脚本要点**（`_tmp-snapshot-sites.mjs`，用完即删）：
`cp` 备份 → 逐行号改一处 → 跑测试 → `cp` 回去 →
末尾 md5 自校验「字节级一致」→ 打印杀死/存活清单。

### 15.4 存活位点的分类判据

5 个存活位点里 **4 真缺口 + 1 次误判**：

| 行 | 代码 | 判定 | 依据 |
| --- | --- | --- | --- |
| 217 | `walk(abs); continue;` | **真缺口** | 父目录里先有子目录时，改 break 会让**其余同级项全丢** |
| 253 | 同上（`collect` 里） | **真缺口** | 同形代码，必须独立断言 |
| 279 | `if (seen.has(rel)) continue;` | **真缺口** | `include` 里重复项永远是最后一项 |
| 280 | `if (!existsSync(...)) continue;` | **真缺口** | 不存在项永远是最后一项 |
| 111 | `begin` 超预算 `continue` | **真缺口**（我最初判成等价变异） | 见下 |

**⚠️ 111 那次误判值得记**：我第一反应是「`size >= maxFiles` 恒成立，改 break 等价」。
**错在只看控制流，没看副作用的内容。** `continue` 会让 `skipped` 收集**每一个**
超预算文件，`break` 只收第一个 —— `token.skipped` 是可观测输出。
既有那条 `maxFiles: 1` 用例超预算后**只剩 1 个文件**，正好看不出差别。

**判据修正**：判等价变异前，先列出该分支的**全部副作用**（不只是"是否执行"，
还有"执行几次、收集了什么"）。**副作用是累积型的，continue 与 break 几乎不等价。**

### 15.5 为补 6 处跨平台不可达路径：加 `fsImpl` 测试缝

`readdirSync` 抛 EACCES · dirent 既非文件也非目录（fifo/socket）·
`rmSync` 被权限拒绝 —— 这三类在 **Windows 上无法构造**，6 处分支长期零覆盖。

`SnapshotStore` 原先用模块级 `import fs`，没有注入点。加了第二个构造参数：

```ts
constructor(opts: SnapshotStoreOptions, fsImpl: SnapshotFsLike = fs as unknown as SnapshotFsLike)
```

**与 `ZoneGuard` 的 `FsLike` 是同一既有模式**（`electron/engine/zone-guard.ts:74`）。
`SnapshotFsLike` 需要 7 个方法（比 `FsLike` 多 `statSync`/`mkdirSync`/`copyFileSync`/`rmSync`），
所以**没有复用** —— 各模块定义自己需要的子集，避免为了复用而扩大接口。

这是**纯加法**：可选参数 + 默认真 fs，生产行为零变化（`tsc` 过、全量测试零回归）。
**判断"加测试缝算不算改生产代码"**：只要默认值保持原行为、且不改变任何调用点，
就属于测试基础设施而非逻辑改动。

### 15.6 顺带修正：**一个目标漏挂了测试文件**

`snapshot-store.ts` 的目标原为 `test: "src/sandbox-journal.test.ts"`（单数），
**漏挂了 `scheduler.test.ts`** —— `batch-guard → snapshot-store` 的集成路径就在那里。
这正是既有教训「漏挂测试文件 = 那部分逻辑没有门禁」的同一形态。

改为 `tests: [...]` 数组（脚本支持 `tests` 优先于 `test`，见 `mutation-check.mjs:252`）。

### 15.7 验证

| 项 | 前 → 后 |
| --- | --- |
| `snapshot-store.ts` Stmts | 80.64 → **100** |
| Branch | 73.91 → **95.74** |
| Funcs | 76.92 → **100** |
| Lines | 83.03 → **100** |
| `continue → break` 拆单点 | **12/12 全杀**，源文件 md5 字节级一致 |
| `&& → ||` 单点 | 注入 `||` 后 **8 条用例变红**（敏感） |
| 该目标测试文件 | 24 → **80 passed**（+56） |
| 全量 vitest | 736 → **757 passed** / 6 skipped |
| 变异门禁 | 单目标 PASS（无存活） |

`branch 95.74%` 的剩余 2 处（行 233/269 附近）是 V8 对**单行 `if` + `continue`**
产生的隐式 else 分支，其位置报 `undefined`，两个方向实际都走到了 —— **不可消除、
也不是缺口**。判定方法：把它当 `continue→break` 位点跑一次，能被杀死即证明断言敏感
（15.7 的拆单点结果已证明）。

### 15.8 仍未纳入（无变化）

五个进程入口 / barrel 文件同 14.7。
`electron/sandbox/index.ts` 的 barrel 是否该删（无人 import），
与 14.7 那条合并为**一个待决策项** —— 删 barrel 需先确认无外部消费者
（含打包配置与 headless 入口）。


---

## 十六、全量 site 审计：**真实覆盖率 84%，不是 100%**（2026-09-23）

### 16.1 第一次拿到可比的数字

第十五章修好工具（`fc14427`）之后，第一次跑通**全量逐位点审计**：

```
node scripts/mutation-check.mjs --mode=site --limit=999
总计：杀死 486/581（84%）   耗时 1251.0s（20.9 min）
```

对照同一份代码的聚合口径：**152/152（100%）**。

差值就是 `replaceAll` 造成的聚合：583 处位点被压成 153 个变异，
"任一处被杀死"即报杀死。**84% 才是这个项目当前的真实断言敏感度。**

| 口径 | 数字 | 证明力 |
| --- | --- | --- |
| `aggregate`（CI / verify） | 152/152（100%） | 每个算子**至少一处**被覆盖 |
| `site`（周期性审计） | 486/581（**84%**） | 每一处分别验证 |

### 16.2 成本与口径定位

- 实测 **1.6–2.2s / 变异**，全量 581 个约 21 分钟。
- CI 的 `mutation-full` job 是 `timeout-minutes: 20` → **`npm run mutation` 仍走 aggregate**。
- `mutation:audit`（`--mode=site --limit=999`）定位为**周期性审计**，不进每次 push。
- 因此：**aggregate 是快门禁，site 是审计**。两者的数字不可互换、不可混读。

### 16.3 掩空器（`maskNonCode`）：三个实测踩坑

定位位点前必须挖空注释 / 字符串 / 正则，否则注释里的算子字面量在 site 口径下
是**永远存活**的假红。实现过程中踩的三坑：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | `Cannot assign to read only property` | `src.slice()` 是字符串（不可变），要 `split("")` + `join("")` |
| 2 | `command-policy.ts` 位点 6 → **0** | `/[;&\|`$<>^!]/` **正则里含反引号** → 状态机进模板态后**跨行不闭合，吞掉整个文件** |
| 3 | 模板 `${a === b}` 的真代码被挖掉 | 模板表达式要按代码处理 → 加 `tmplStack` 表达式栈（含 `{}` 嵌套深度） |

坑 2 是本轮最有价值的发现：**它正是这个门禁要防的「静默归零」，发生在门禁自己身上。**

三道防线：正则启发式识别（失败则回退为普通字符，损害限制在一行）·
结束时状态未闭合则**抛错** · `位点数 + 掩掉数 === 原文命中数` 自洽校验。

自测转正为 `scripts/masker-selftest.mjs`（**24 例**，含"未闭合注释必须抛错"），
以 `check:masker` 接进 `verify`。

### 16.4 ⚠️ 两个自踩的坑

1. **门禁运行时连"读源文件"都不可靠**。后台审计跑着的时候 `sed` 读
   `path-policy.ts` 得到 `return rel === z && rel.startsWith(...)`，
   差点据此报一个不存在的 bug —— 那是**正在生效的变异体**（真源码是 `||`）。
2. **审计结论会过时**。20:35 那份 tier 1 审计（25 存活）早于 `fc14427`，
   而 22:19–00:26 的提交已修掉其中大部分。**引用审计数字前先核对时间戳。**

### 16.5 已修（本轮与紧接的一批提交）

| 文件 | site 口径 | 说明 |
| --- | --- | --- |
| `keys-store.ts` | 18/19 → **19/19** | `isEncryptedAtRest` 的 catch：探测失败不能谎报"已加密" |
| `scoped-env.ts` | 3/5 → **5/5** | 两处 `continue`：被跳过项排在**最前**时后续变量不能丢 |
| `schema.ts` | → **17/17** | `isObject` 守卫 |
| `kill-tree.ts` | → **11/11** | |
| `path-policy.ts` | → 27/33 | 仍有 6 处（见积压） |
| `scheduler.ts` | → 11/15 | |
| `batch-guard.ts` | → **10/10** | |

沙箱核心已全绿：`command-policy` 6/6 · `snapshot-store` 13/13 ·
`file-journal` 11/11 · `kill-tree` 11/11 · `verifier` 9/9 · `zone-guard` 6/6。

### 16.6 剩余积压（95 处，按安全影响半径排序）

| 文件 | 存活 | 性质 |
| --- | --- | --- |
| `electron/agents/manifest-schema.ts` | 14 | 清单校验（决定能否接单） |
| `headless/protocol.ts` | 11 | 宿主↔进程契约面 |
| `electron/engine/orchestrator.ts` | 9 | 调度主链路 |
| `shared/http-clients.ts` | 7 | LLM 通信 + 响应体预算 |
| `electron/agents/sensenova-api.ts` | 7 | 默认适配器（新装用户走这条） |
| `electron/agents/http-bridge.ts` | 7 | |
| `electron/sandbox/path-policy.ts` | **6** | **写入允许落在哪（安全边界）** |
| `shared/glob.ts` | **5** | **zone 匹配依赖的路径匹配** |
| `electron/engine/scheduler.ts` | 4 | |
| `electron/engine/router.ts` | 4 | |
| `shared/zone-coverage.ts` | **3** | **zone 强制执行** |
| 其余 12 个文件 | ≤3 | |

**建议下一轮顺序**：`path-policy` → `glob` → `zone-coverage` → `protocol`
→ `orchestrator` → `manifest-schema`。

### 16.7 ⚠️ 一个待解决的工具缺口：平台相关等价变异

`path-policy.ts:54`：

```ts
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
```

在 Windows 上跑审计时，第二个 `===`（`=== "darwin"`）改成 `!==` 后整式仍为
`true || true = true` —— **在 Windows 上与原文等价，但在 Linux CI 上会被杀死**。

现有 `EQUIVALENT_SITES` 按 `{file, op, line}` 匹配，会**把同一行上两个位点一起
白名单化**，其中一个是本机可杀的。需要给白名单加"该行第几个位点"（`occ`）才能精确表达。

在此之前，平台相关分支的存活项**只能靠在另一 OS 上跑一次审计**来区分 ——
这是 site 口径目前已知的最大盲区。

### 16.8 积压清理进度（2026-09-23 续）

按 16.6 的顺序推进，已清 **32 / 95** 处。当前状态：

| 文件 | site 口径 | 收口方式 |
| --- | --- | --- |
| `electron/sandbox/path-policy.ts` | **33/33** | 5 处补断言（strict 分支 + `via` 语义）；1 处**平台判断可测化** |
| `shared/glob.ts` | **23/23** | 5 处补断言（分支互斥，需构造"只有一个成立"的输入） |
| `shared/zone-coverage.ts` | **18/18** | 3 处补断言（`describeZoneGaps` 此前零断言） |
| `headless/protocol.ts` | **50/50** | 10 处补断言（多条件校验只触发第一条）；1 处**简化冗余守卫** |
| `electron/keys-store.ts` | **19/19** | 1 处补断言（加密探测失败不能谎报已加密） |
| `electron/agents/scoped-env.ts` | **5/5** | 2 处补断言（被跳过项排最前） |
| `shared/graph.ts` | **5/5** | **简化源码**（循环条件冗余合取项） |
| `electron/sandbox/spawn-plan.ts` | **7/7** | **白名单**（`isFile` catch 是 TOCTOU，测不到） |
| `electron/sandbox/circuit-breaker.ts` | **15/15** | 1 处补断言（只断言了兄弟字段） |
| `electron/agents/manifest-loader.ts` | **11/11** | 1 处补断言（`pollMs` 透传） |

**存活变异的三类处理（本轮定型，值得后续沿用）**：

1. **能加断言 → 加断言**（首选）
2. **条件冗余 / 死代码 → 简化源码**，不要白名单（`graph.ts` 是范例：
   删掉冗余合取项后位点直接消失）
3. **分支可达但测试构造不出来 → 白名单 + 写清"不是不重要，是活不到能测那一步"**，
   并注明将来什么条件下应删掉它

**平台相关一律"可测化"，不白名单** —— 白名单按 `{file, op, line}` 生效，
在另一个 OS 上会把可杀的位点一起排除（16.7）。

**剩余 ~63 处**：`manifest-schema` 14 · `orchestrator` 9 · `http-clients` 7 ·
`sensenova-api` 7 · `http-bridge` 7 · `scheduler` 4 · `router` 4 · `registry` 3 ·
`store` 2 · `llm-client` 2 · `context` 2 · `cli-agent` 2 · 其余零散。

全量测试 785 → **839 passed** / 6 skipped。

### 16.9 继续清理（2026-09-23 第三批，累计 45 / 95）

| 文件 | site 口径 | 收口方式 |
| --- | --- | --- |
| `electron/engine/router.ts` | **20/20** | 4 处补断言：候选复查（注册表已滤过，只能直接构造 `candidates`）+ 等分 tie-break |
| `electron/agents/registry.ts` | **20/20** | 3 处补断言：`ui` 适配器推断（两个函数各一处，须分别验）|
| `shared/llm-client.ts` | **15/15** | 2 处补断言：残缺 JSON 块跳过 + system 消息非首位 |
| `electron/engine/scheduler.ts` | **14/14** | 2 处补断言（失败事件被后续 completed 洗白 / 熔断兜底找不到人）+ 1 处简化源码 |

**第四类死代码：「同生共死的守卫」**（`a && b` 中两条件互为蕴含）——
已见三例（`protocol` / `scheduler` / `graph`），**处理一律是简化源码**。
`scheduler` 那例的写法最通用：把同源的两个值打成 `{ guard, scope }` pair，
判一次真值即可，且不需要类型断言。

**补断言前先问「既有用例为什么走不到这一支」**，三种成因各有对策：
① 前面有别的校验先返回 → 补上前置条件的合法值；
② 排序恒定（如 system 消息恒在首位）→ 把目标项挪到非首位；
③ 两种写法结果恰好相同 → 构造能区分它们的最小场景。

**剩余 ~50 处**：`manifest-schema` 14 · `orchestrator` 9 · `http-clients` 7 ·
`sensenova-api` 7 · `http-bridge` 7 · `store` 2 · `context` 2 · `cli-agent` 2 · 其余零散。
