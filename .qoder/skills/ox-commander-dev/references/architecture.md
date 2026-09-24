# 架构、契约与不变量

2026-09-24 逐条读代码核过（不是抄 README）。行号会漂，**判据以文件为准**。

## 一次 run 的端到端数据流

**两个入口**

- Electron：`orchestration:planning` → `generatePrd` → `decompose`，落 `ProjectStore` 的 `batchesJson` / `smokeJson`
  （`electron/ipc/orchestration.ts:132-145`）→ `orchestration:start` 读回并 `execute`（`:158-171`），
  `runningProjectId` 是单飞闸。renderer 只有一条事件通道 `ox:event`（`electron/preload.ts:38-42`）。
- headless：stdin 收全量 JSON → `parseSpec`（`headless/protocol.ts:208`）→ `runSpec`（`headless/run-spec.ts:33`）
  → stdout 打 JSONL；退出码 0 / 2 / 1。

**阶段**：6 个 Stage 定义在 `shared/types.ts:1-16`；PRD→PLANNING 由 `generatePrd` / `decompose` 各自 `onStage`
（`electron/engine/orchestrator.ts:169,192`），DEVELOPMENT→VERIFICATION→DELIVERY→DONE 在 `runPipeline`（`:308,400,419-422`）。
repair 循环 `while (round <= maxRounds + extraRounds)`（`:313`），默认 3 轮（`shared/types.ts:182`）。
循环**之前**先跑一次基线验证（只在全新 run 上，断点续跑不跑）：目标项目本来就红的命令会随
每一份重修上下文附上 `[本次运行前就已失败]`，避免智能体去修与自己无关的历史失败。代价是每次
运行多一轮验证命令（`verifier` 是首败即停，所以基线只报出第一条红）。

**任务态**：`pending→running→done|failed`，cancel 经 `inFlight` 补发 `cancelled`。
⚠️ `TaskStatus` 里的 `queued` / `verifying` / `repairing` **引擎从不发**（全仓找不到生产者）——别按它们写 UI 逻辑。

**三处落盘点**

1. checkpoint journal：`save()` 发生在计划完成 / 每批 / 每轮收尾（`orchestrator.ts:297-306,396,466,486`）。
   桌面写 `<userData>/runs/<projectId>.json`，headless 写 `<projectRoot>/ox-run-journal.json`
   （`electron/platform.ts:220-233`），都走 `writeFileAtomic`。
2. 审计 JSONL：**只有桌面有**，`run-start` / `run-end` 落 `<userData>/audit`（`electron/ipc/context.ts:227-242`），
   `detail` 先 `redactSecrets` 再截 300 字符。headless 明确不落盘，改发 `run` / `conflict` 协议事件。
   ⚠️ 轮转是**按大小**（`maxFileBytes` 默认 2 MiB，`electron/audit-log.ts:64,104,153`），文件名含日期但跨天不触发新文件
   ——README「按天轮转」的说法不准。
3. 快照备份 `<userData>/snapshots/<runId>`（`electron/sandbox/snapshot-store.ts:93-126`）——内容备份，**不用 git stash**。

## 分层红线：现状是"约定 + 人工盯"

| 事实 | 证据 |
| --- | --- |
| `shared/` 现在确实零 node import（唯一命中是 prompt 文本里的字符串） | `shared/prompts.ts:20` |
| 但没有机制强制：`tsconfig.json` 未设 `types: []`，`@types/node` 全局自动引入 → `shared/` 里 `import "node:fs"` 连 renderer 工程都能过 typecheck | `tsconfig.json` |
| eslint 无 `no-restricted-imports` / 无任何 import 边界规则；无 `paths` / `baseUrl` 别名 | `eslint.config.mjs` |
| 唯一真实保护是两套后端 tsconfig 的 `lib: ES2022`（无 DOM），所以碰 DOM 会红、碰 node 不会 | `tsconfig.electron.json` / `tsconfig.headless.json` |
| 跨层依赖已存在：`headless/protocol.ts:16` 让"纯协议层"依赖 `electron/agents/manifest-schema`；同文件头注释自称 "pure: no fs, no process" 却在 `:14` import `node:path`、`:364` 读 `process.env.TMPDIR/TEMP` | 两处 |

推论：**把纯逻辑放进 `shared/` 靠自觉**，评审时要自己 grep `node:` / `process.` / `require(`。

## 三类适配器契约

契约类型在 `shared/agent-contract.ts`：`manifest.adapter` 三值（`:97`）、`AgentEntry` 判别式联合（`:69-91`）、
`credential` 四型（`:44-48`）、`limits` 三字段默认 600s / 120s / 2MiB（`:59-63`）。

| | local-llm | cli | http-bridge |
| --- | --- | --- | --- |
| 文件 | `electron/agents/sensenova-api.ts` | `electron/agents/cli-agent.ts` | `electron/agents/http-bridge.ts` |
| 能力 | 只有 `read/edit/create`（注释言明**不跑命令**，`:86-106`） | 声明什么就跑什么 | 由宿主实现决定 |
| 并发 | `maxConcurrency` = 已配 key 数（`:103,129`） | | 4 端点轮询，`pollMs` 默认 500 |
| 超时 | **无 limits、无 TimeoutGate**，只有 per-request `EXECUTOR_TIMEOUT_MS`（`:155`） | TimeoutGate + `killTree`（`:209-223,293`） | |
| 入参 | files-protocol JSON 输出（`:420-425`） | 走 prompt 文件不用 argv（`:359-399`），`shell:false` + `buildSpawnSpec`，env 经 `scopedEnv` 最小化，stdout 有字节预算 | `credential` 在这里才真被消费（`authHeaders` `:343-369`） |

**manifest 校验只有三个入口**：`agents.d` 目录（`manifest-loader.ts:42`，单文件解析失败只跳过并计入 `manifestErrors`）、
IPC 运行时注册（`electron/ipc/agents.ts:52`）、headless stdin `agents`（`protocol.ts:311`）。
`AgentRegistry.register()` **不再校验**（`registry.ts:101-115`）→ 绕过那三处就没有任何校验。
`createRegistry` 按 `adapter.meta.id` 配对 manifest；**配不上的声明不是静默丢弃**：加载器把每条
没能变成适配器的声明都记进 `skippedManifests`，`agents:list` 又把这份清单报给界面
（2026-09-24 复核 `manifest-loader.ts:118-127` 后校正了本手册的旧说法）。真正静默的是
`execToken` 取令牌失败——它返回 `undefined`，请求照发，只是没有凭证。

## 沙箱实际判据

`PathPolicy.assertWritable`（`electron/sandbox/path-policy.ts:169-204`）顺序：

1. 空路径 deny
2. 绝对路径 deny（`path.isAbsolute` 或 `/^[A-Za-z]:/`）
3. `..` 段穿越 deny（`hasTraversal`）
4. **realpath 后**越出项目根 deny（`resolveExistingReal` 看穿 junction 与 8.3 短名，所以 `NODE_M~1` 会命中 `node_modules/**`）
5. 受保护路径 deny（对 **realpath 结果**匹配 `forbidden`，Windows 大小写不敏感）
6. 越出可写根 deny（也是 realpath）
7. **zone / delegated 匹配的是"输入路径"而非 realpath**（`:197` 注释言明：第 4-6 级已经把物理逃逸拦掉了）

两处必须知道的语义：

- **写入门不传 zone**：内置执行器调的是 `policy.assertWritable(f.path)`（`sensenova-api.ts:374`），
  `zoneMode` 默认 `legacy` → `undefined` zone 视同 `""` → 第 7 级恒 allow。
  即 zone 约束**完全靠事后 `BatchGuard`**。理由是**结构性的**而不是"等回滚"（旧注释那句 "until rollback
  lands (P4)" 已按实际判据改掉）：写入门用严格前缀，若在这里认 zone，模型按约定写的
  `src/duration.js`（zone 为 `src/duration`）会在写入前就被拒 —— 那才是回归。
- **两处 zone 判据故意不同**：写入门 `zoneAllows`（`:219-228`）用严格前缀 `rel===z || rel.startsWith(z+"/")`；
  仲裁门 `isPathInZone`（`shared/glob.ts:91-101`）**额外**认 `src/duration.js` 属于 zone `src/duration`
  （`glob.ts:85-89` 注释给了理由：否则模型写同名文件会被回滚、拖垮整批）。
  → **写入门比仲裁门严是设计**，不是要修的不一致。`zoneMode: strict` 下 `"."` 只拥有根级文件，`legacy` 下 `"."` 与 `""` 同义。

`CommandPolicy`（`electron/sandbox/command-policy.ts:177-216`）实际顺序：空 → `denied program` → **不在白名单** →
元字符（命令本身 + 每个 arg）→ eval flag → git 子命令。deny 先于白名单查（`:184-189`）。
两个边界：`EVAL_FLAGS`（`:122-127`）只对 node / python / python3 / npx 生效，**`npm run <script>` 任意脚本不设防**；
`SHELL_METACHARACTERS`（`:114`）没有平台开关，POSIX 上也拒 `^ ! %`，所以 `foo!.js`、`a%b` 这类合法文件名在 Linux 会被拦。

**`execToken` credential 不过沙箱**：`manifest-loader.ts:135-160` 的 `tokenResolver` 直接
`spawn(command, args, {shell:false})`，**不经 `CommandPolicy`、不经 `buildSpawnSpec`**（Windows 上 `.cmd` 会 ENOENT）。
它的定位是"指挥机自己的取令牌命令"，所以红线是：**只加载自己写的 `agents.d`**，别把外来 manifest 放进目录。

## 平台分支（写跨平台断言前必看）

| 位置 | win32 | POSIX |
| --- | --- | --- |
| `spawn-plan.ts:121-139` | PATHEXT 解析 + `cmd.exe /d /s /c` + `windowsVerbatimArguments` | 直通 |
| `kill-tree.ts:13-45` | `taskkill /F /T` + post-grace double-check | `SIGTERM→SIGKILL`，开头 `hasExited` 预检查防 pid 复用误杀（`:49-64`） |
| `path-policy.ts:66-70` | `isCaseInsensitiveFs(platform)` 已抽成可注入函数并导出；常量是 `CASE_INSENSITIVE_FS` | 构造期读常量，`forbiddenLower` 分支（`:148`）仍依赖真实 OS |

⚠️ `resolveCommand` 的第三参（platform）必须显式透传（`spawn-plan.ts:124-128` 有踩坑注释：漏传曾让注入通道直接失效）。

## 并发与确定性

- 全仓**零 `Math.random`**。顺序性靠显式 tie-break：`router.ts:192-203`（declared>legacy → score → preferredRank → registry index）、
  `scheduler.ts:181-188` 稳定 sort。
- **`Date.now()` 派生 id 会撞**：`scheduler.ts:293`（`batch-<ms36>-<taskIds>`，同时是快照目录名）、`:322`（`runId`）、
  `file-journal.ts:74`。已修的只有项目 id：`electron/store.ts:47` 加 `idSeq` 单调序数 + `:63-66` `list()` 用 id 决胜
  （commit `f71ffbc` 修的是 CI ubuntu 的 newest-first flake）。**新增 id 生成要么带序数要么带计数器。**
- `atomic-file.ts:30` tmp 名只含 `pid + Date.now()`，无计数器（当前调用点都同步，未触发）。
- **mtime 判据有已知盲区**：`file-journal.ts:127` 用 `size + mtimeMs`——同 size 同 mtime 的改动漏检，
  `touch` 不改内容会误报（`:81-84` 注释承认）。
- **构建产物既不算越权、也不进快照**：跳过清单只有一张（`file-journal.ts` 导出的 `DEFAULT_SKIP_DIRS`，
  2026-09-24 起内置执行器的快照也复用它）。此前是四张副本（journal / snapshot-store / 执行器快照 / zone-guard），
  代价有两处：**批内跑一次 `npm run build` 会让整批被判 unauthorized-write 并被回滚删掉产物**；
  以及执行器快照按路径序消耗 32k 预算、`coverage/` 与 `dist/` 排在 `src/` 前面，
  本机实测修复前"12 个文件里 11 个是产物、真实源码进 prompt 0 个"，修复后 6 个文件全是要读的源码。
  `out` / `bin` / `target` **刻意不在表里**（它们常是手写源码目录）。
- 时钟/定时器注入点：`timeout-gate.ts:16-18`、`circuit-breaker.ts:9`、`audit-log.ts:41` 可注入；
  **`scheduler.ts` 的 throttle（`:156,169`）与 cli-agent / http-bridge 的 `Date.now()` 不可注入** → 测 429 退避只能靠假时钟。
- headless **无任何 `process.on`**：Ctrl-C 之后快照备份目录与 `ox-run-journal.json` 都不清理（没有 `commit` 机会）。
- `shared/glob.ts:54` 的 RegExp `cache` 无上限无淘汰，而 key 来自模型写的 glob。

## 线路池（README 这条核实为真）

`shared/providers.ts:144-150`：`SENSENOVA_MODELS` **4 个模型** × `SENSENOVA_KEY_VARS` **3 把 key** = 12 条，
加 AMD 1 条 = 13。`SENSENOVA_MODELS_EXTRA`（`:153`，kimi-k3）**刻意不进默认轮转**，有测试守着；
NVIDIA 与 OpenRouter 排除的理由写在 `:155-162`（实测 280s 无响应 / 账号被锁推理）。
**陈旧文案**：`package.json:7`、`electron/agents/index.ts:17`、`shared/build-llm.ts:28`、
`src/pages/SettingsPage.tsx` 的界面文案、以及 `README.md` 的「LLM 线路池」一节曾长期写死
"3 密钥 × 3 模型"或"13 条线路"。现在这些都表述为"由 `shared/providers.ts` 的两张表决定"——
**换成另一个数字只是把漂移推到下次扩池**。

## 已知不一致（改这些文件前先读）

| 说法 | 实际 | 证据 |
| --- | --- | --- |
| ~~桌面端 keychain 的 Key 进不了 run~~ | **已修**：播种器挂在 `PlatformConfig.seedKeys` 上，`createPlatform` 内部**无参**构造引擎大脑时也会播种 | `electron/platform.ts`（`const seed = seedKeys ?? config.seedKeys`）+ `electron/ipc/context.ts`（`buildPlatformLayer` 传 `seedKeysFromStore`）；由 `src/platform.test.ts` 与 `src/ipc-handlers.test.ts` 两侧分别钉住 |
| ~~README「回滚/隔离/报告四档」~~ | **已修**：`deny-all` 与 `report-only` 曾走同一分支（都 `markBatchFailed`、都不回滚），四档只有三种行为。现在按设置页写下的那句分开：`report-only` 只记日志不改判（remedy `pass`），`deny-all` 保留文件但判批次失败。四档=四种行为由 `src/sandbox-journal.test.ts` 真跑四档钉住 | `electron/engine/batch-guard.ts` 的两条独立分支 |
| 看板念出的处置 | `src/store.ts` 的 remedy 词表曾照抄成 `isolate` / `keep`，而生产端只发 `revert`/`quarantine`/`fail-batch`/`pass` —— 于是"移入隔离区"与"保留文件判失败"都被念成"仅记录"，而 `store.test.ts` 用的正是这套假词表（测试绿、链路坏）。现在词表导出为 `REMEDY_VERB`，四档对账放在引擎侧用例里 | `src/store.ts` + `src/sandbox-journal.test.ts` |
| 不回滚的两档收尾 | `report-only` / `deny-all` 分支曾**既不 commit 也不丢**快照令牌 → 每批在 `userData/snapshots` 留一份备份目录。四档现在都在出口处 `commit` | `batch-guard.ts` 各分支末尾 |
| README「审计按天轮转」 | 按大小 2 MiB | `electron/audit-log.ts:64,104` |
| `electron/agents/scoped-env.ts` 头注释「a denylist that wins over the allowlist」 | **别读成缺陷**：这里的 allowlist 指规则 2 的 `isRequired`（进程基础变量），代码确实让 denylist 压过它；而规则 1 的显式 `grants` 优先于 denylist（`:126-129` 内联注释言明，否则 `allowProviders` 永远放不了行）。两层都叫"allowlist"是措辞陷阱，改之前先分清是哪一层 | `electron/agents/scoped-env.ts:11-17` vs `:121-135` |
| ~~`circuit-breaker.ts` 注释「`retryable: false` outcomes close nothing」~~ | **已修（改的是注释不是行为）**：`record(id, ok)` 只收 `ok: boolean`、确实不看 `retryable`，认证失败照样计入连续失败并可开熔断 —— 现在注释写的就是这个真实语义（把凭证坏掉的智能体同样关闸，避免每个任务再烧一次配额） | `electron/sandbox/circuit-breaker.ts` 的 `record` |
| README 旧版「15 步 / 930 用例」 | 17 步 / 954 用例（2026-09-24 本机实测） | `package.json:35` |
