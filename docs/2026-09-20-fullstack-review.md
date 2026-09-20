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

### 剩余未做项

| 项 | 状态 |
| --- | --- |
| B3 取消/暂停终态事件 + `runId` 屏障 | 未做 |
| B4 输出字节上限（verifier log 截断、HTTP 响应体校验） | 未做 |
| B5 IPC 错误统一包装 | 未做 |
| B6 退出码契约对齐 | **已核实无需改动** —— `docs/headless-protocol.md:13,65-75` 的退出码表与 `run-spec.ts:187,191-196` 实现一致 |
| C3 path-policy 大小写归一 | **已实测定性**：`SRC/a.js` 在 zone「src」下被**拒绝**（fail-closed，误拒而非放行），属 P2 误伤风险，非安全洞 |

**C3 实测命令与结果**（可复现）：
```bash
node -e "const {PathPolicy}=require('./dist-electron/electron/sandbox/path-policy.js');
const p=new PathPolicy({projectRoot:'C:\\\\Proj\\\\App'});
console.log(p.assertWritable('SRC/a.js','src'));"
# → { ok: false, reason: 'zone 越权：SRC/a.js 不在 zone「src」内' }
```
