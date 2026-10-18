# 架构与不变量（面向人）

这份文档回答三个问题：**系统怎么跑起来**、**哪些边界是刻意的**、**改哪些地方容易踩雷**。
面向新人和未来的维护者；2026-10-18 从 `.qoder/skills/ox-commander-dev/references/architecture.md`
（agent 版详表）与 README 提炼而成，**引用只到文件与符号级**（行号会漂，判据以代码为准）。

相关文档的分工：

| 文档 | 读它做什么 |
| --- | --- |
| [README.md](../README.md) | 定位、快速开始、门禁索引节（权威数字都在这里，由 `check:doc-claims` 对实物核） |
| [.qoder/skills/ox-commander-dev/SKILL.md](../.qoder/skills/ox-commander-dev/SKILL.md) | 改代码前的操作手册（红灯速查、改验证链的四处同步纪律） |
| [gates.md](../.qoder/skills/ox-commander-dev/references/gates.md) | `npm run verify` 逐段机制（失败语义各不相同） |
| [CHANGELOG.md](../CHANGELOG.md) | 对外可见的变化（简洁） |
| [ENGINEERING-LOG.md](ENGINEERING-LOG.md) | 每一条变化的完整工程过程（事故、负结果、数字台账） |

## 一次 run 的端到端

**两个入口**

- **Electron**：`orchestration:planning` → `generatePrd` → `decompose`，落 `ProjectStore` 的
  `batchesJson` / `smokeJson`；`orchestration:start` 读回并 `execute`。`runningProjectId` 是单飞闸
  （同一时刻只跑一个 run）；renderer 只有一条事件通道 `ox:event`。
- **headless**：stdin 收全量 JSON → `parseSpec` → `runSpec` → stdout 打 JSONL；退出码 0 / 2 / 1。
  `ox serve` 是它的常驻形态（HTTP + SSE）；`ox mcp` 是反向 MCP server。

**六阶段**：`需求 → PRD → PLANNING → DEVELOPMENT → VERIFICATION → DELIVERY`（定义在
`shared/types.ts`）。PRD / PLANNING 各自有 `onStage`，其余阶段在 `orchestrator.ts` 的 `runPipeline`。

**Stage 3.5（2026-10-06）**：DEVELOPMENT 与 VERIFICATION 之间还有一步 —— `checkContractPaths`
（`shared/zone-coverage.ts`）拿任务**自己 description** 里点名的路径逐个查存在性，缺就把该任务从
ok 翻成 `failed`（`errorClass=contract`）并摘出 `allDone`，让重修轮拿到"路径不符"这条根因。

- 为什么需要它：`isPathInZone` 刻意让 `x/y.js` 属于 zone `x/y`，所以"目录 + `index.js`"这种
  **zone 合法、契约非法**的布局漂移既不会被沙箱拦、也过得了语法级验证 —— 真实事故见
  `docs/2026-10-06-real-decomposition-e2e.md`。
- 顺序是承重的：放在 VERIFICATION 之后，它会表现成一条不归属任何 zone 的测试红。
- 探针经 `OrchestratorDeps.fileExists` 注入；**没注入 = 没检查**，日志会明说，不会静默给绿。

**重修循环**：`while (round <= maxRounds + extraRounds)`，默认 3 轮。循环**之前**先跑一次基线验证
（只在全新 run 上，断点续跑不跑）：目标项目本来就红的命令会标 `[本次运行前就已失败]`，避免智能体
去修与自己无关的历史失败。代价是每次运行多一轮验证命令（首败即停，基线只报第一条红）。

**任务态**：`pending → running → done | failed`，cancel 经 `inFlight` 补发 `cancelled`。
⚠️ `TaskStatus` 里的 `queued` / `verifying` / `repairing` **全仓没有生产者** —— 写 UI 逻辑前先 grep。

**三处落盘点**

1. **checkpoint journal**（断点续跑的入口）：计划完成 / 每批 / 每轮收尾时 `save()`。桌面写
   `<userData>/runs/<projectId>.json`，headless 写 `<projectRoot>/ox-run-journal.json`，都走原子写。
2. **审计 JSONL**：只有桌面有（`run-start` / `run-end`，`detail` 先脱敏再截断）。**按大小轮转**
   （单文件 2 MiB，文件名含日期但跨天不触发新文件）。headless 明确不落盘，改发 `run` / `conflict`
   协议事件。
3. **快照备份** `<userData>/snapshots/<runId>` —— **内容备份，不用 git stash**。

## 分层与依赖红线

| 层 | 约定 | 强制手段 |
| --- | --- | --- |
| `shared/` | 纯逻辑：零 node 内建、零宿主层依赖、零反向依赖上层 | **lint 强制**（`eslint.config.mjs` 给 `shared/**` 加的 `no-restricted-imports`，2026-09-25 起，落地时零违规） |
| `electron/engine/` | 编排核心，不直连 fs/process（靠注入） | 约定 + 评审 |
| `electron/sandbox/` | 一切文件 / 命令进出的唯一闸门 | 判据自测 + 变异门禁 |
| `headless/` | 跨层依赖已存在且刻意未拦（`run-spec.ts` 经 `electron/platform` 拉进 `electron/sandbox`） | **没有机制，靠人盯** |

两个容易误判的点：

- **red line 的承重件是 lint，不是 tsc**：`shared/` 没设 `types: []`，`@types/node` 仍全局可见，
  tsc 拦不住 node API；真正的 DOM 保护是两套后端 tsconfig 的 `lib: ES2022`。
- 评审 `shared/` 改动时仍自己 grep 一遍 `node:` / `process.` / `require(`。

## 三类执行器与 manifest

契约类型在 `shared/agent-contract.ts`（`adapter` 三值、`AgentEntry` 判别式联合、`credential` 四型、
`limits` 默认值）。

| | `local-llm` | `cli` | `http-bridge` |
| --- | --- | --- | --- |
| 文件 | `electron/agents/sensenova-api.ts` | `electron/agents/cli-agent.ts` | `electron/agents/http-bridge.ts` |
| 能力 | 只有 read / edit / create（**不跑命令**） | 声明什么就跑什么 | 由宿主实现决定 |
| 并发 | `maxConcurrency` = 已配 key 数 | — | 4 端点轮询（`pollMs` 默认 500） |
| 超时 | `limits` + TimeoutGate，**只认 deadline**；idle 判据在这里必假阳（一次请求在途最长 300s，本来不出事件） | TimeoutGate + `killTree` | 同左 |
| 入参 | files-protocol JSON 输出 | prompt 文件走 stdin（不用 argv），`shell:false` + `buildSpawnSpec`，env 经 `scopedEnv` 最小化 | `credential` 在这里才真被消费 |

**manifest 校验只有三个入口**：`agents.d` 目录、IPC 运行时注册、headless stdin `agents`。
`AgentRegistry.register()` **不再校验** —— 绕过那三处就没有任何校验。加载器把每条配不上适配器的
声明记进 `skippedManifests` 并报给界面（不是静默丢弃）；真正静默的只有 `execToken` 取令牌失败
（返回 `undefined`，请求照发、没有凭证）。

**`execToken` 红线**：它的 `tokenResolver` 直接 `spawn(..., {shell:false})`，**不经 CommandPolicy、
不经 buildSpawnSpec**（Windows 上 `.cmd` 会 ENOENT）。定位是"指挥机自己的取令牌命令"——
**只加载自己写的 `agents.d`，别把外来 manifest 放进目录**。

## 沙箱判据（为什么三处 zone 判据故意不同）

`PathPolicy.assertWritable`（`electron/sandbox/path-policy.ts`）七级顺序：

1. 空路径 deny；2. 绝对路径 deny；3. `..` 穿越 deny；4. **realpath 后**越出项目根 deny
（看穿 junction 与 8.3 短名，`NODE_M~1` 会命中 `node_modules/**`）；5. 受保护路径 deny
（对 realpath 结果匹配，Windows 大小写不敏感）；6. 越出可写根 deny（同样 realpath）；
7. **zone 匹配的是"输入路径"而非 realpath** —— 4–6 级已经把物理逃逸拦掉了。

两处必须知道的语义：

- **写入门不传 zone**：内置执行器调 `assertWritable(f.path)` 不带 zone，`zoneMode` 默认 `legacy`，
  于是第 7 级恒 allow —— **zone 约束完全靠事后 `BatchGuard`**。这是结构性的：写入门用严格前缀，
  若在这里认 zone，模型按约定写的 `src/duration.js`（zone 为 `src/duration`）会在写入前就被拒 ——
  那才是回归。
- **三处 zone 判据故意不同**：
  - 写入门 `zoneAllows`：严格前缀 `rel === z || rel.startsWith(z + "/")`；
  - 仲裁门 `isPathInZone`（`shared/glob.ts`）：**额外**认 `src/duration.js` 属于 zone
    `src/duration`（否则模型写同名文件会被回滚、拖垮整批）；
  - 分批次 `zonesOverlap`：对称地问"两个 zone 会不会抢同一个文件"，且大小写不敏感 ——
    **必须比两者都宽**（宁可多串行），因为同批父子 zone 会让越权检测变瞎（每条写入都落在本批
    某个 zone 之内，`BatchGuard` 全放行）。

→ **写入门比仲裁门严是设计，不是要修的不一致。** `zoneMode: strict` 下 `"."` 只拥有根级文件；
`legacy` 下 `"."` 与 `""` 同义。

`CommandPolicy`（`electron/sandbox/command-policy.ts`）顺序：空 → denied program → **不在白名单** →
元字符（命令本身 + 每个 arg）→ eval flag（内联求值地板）→ git 子命令。两个边界：
`npm run <script>` 的**任意脚本不设防**（脚本内容不审）；`SHELL_METACHARACTERS` 没有平台开关，
POSIX 上也拒 `^ ! %`，`foo!.js`、`a%b` 这类合法文件名在 Linux 会被拦。

## 三条承重不变量（2026-09-25 加，别改回去）

- **验证与冒烟的子进程走 `scopedEnv()`**（`verifier.ts`、`cli-agent.ts` 的 `probe()`）。它们跑的是
  智能体刚写下的项目脚本，而桌面端把 keychain 播种进 `process.env`、`main.ts` 还加载 `.env` ——
  不传 env 等于把每一把 provider Key 交给模型代码。副作用：验证脚本读不到宿主自定义变量，
  依赖环境变量的构建 / 冒烟脚本会行为不同（这是取舍，不是缺陷）。
- **Windows 的 cmd 包装必须给整条 line 再套一层引号**（`spawn-plan.ts` 的 win32 分支）。cmd 的
  `/s` 语义是去掉首尾两个引号字符；只给每个 token 加引号时，Node 默认安装路径的空格会让
  `"C:\Program Files\nodejs\npm.cmd" run build` 被解析成命令 `C:\Program`。`.exe` 是直 spawn，
  所以这个 bug 只在走 `.cmd` shim 的命令上现形 —— 回归用例真 spawn 一个路径含空格的 `.cmd`。
- **回滚只删"有 create 证据"的文件**（`snapshot-store.ts` 的 `revertOne` + `batch-guard.ts`）。
  快照只采集本批 zone，"备份里没有"推不出"原本不存在"—— 旧逻辑据此把被模型改过的根级
  `package.json` 当新增删掉，且每轮重修再删一次。删除要调用方传 `created`（来自看整棵树的
  `FileJournal`）；`DEFAULT_SHARED_PATHS` 里的字面文件交给快照 `include`，让"还原"而不是
  "删除"成为默认。

## 平台分支（写跨平台断言前必看）

| 位置 | win32 | POSIX |
| --- | --- | --- |
| `spawn-plan.ts` | PATHEXT 解析 + `cmd.exe /d /s /c "<整条 line 再套一层引号>"` + `windowsVerbatimArguments`（外层引号承重） | 直通 |
| `kill-tree.ts` | `taskkill /F /T` + post-grace double-check | `SIGTERM → SIGKILL`，开头 `hasExited` 预检查防 pid 复用误杀 |
| `path-policy.ts` | 大小写不敏感判定已抽成可注入函数并导出（`isCaseInsensitiveFs`） | 构造期读常量 |

⚠️ `resolveCommand` 的第三参（platform）**必须显式透传** —— 漏传曾让注入通道直接失效（该处有踩坑注释）。

## 并发与确定性

- **全仓零 `Math.random`**。顺序靠显式 tie-break：路由按"declared > legacy → score →
  preferredRank → registry index"；调度器用稳定 sort。
- **`Date.now()` 派生 id 会撞**（同毫秒并发用例）：项目 id 已加同毫秒单调序数 + list 平局决胜
  （修的是 Linux CI 的 newest-first flake）；批量号 / runId / journal 的 id 仍要注意 ——
  **新增 id 生成要么带序数要么带计数器**。
- **mtime 判据有已知盲区**：`file-journal.ts` 用 `size + mtimeMs` —— 同 size 同 mtime 的改动漏检，
  `touch` 不改内容会误报。
- **构建产物既不算越权、也不进快照**：跳过清单只有一张（`file-journal.ts` 导出的
  `DEFAULT_SKIP_DIRS`，所有消费者复用）。`out` / `bin` / `target` 刻意不在表里（它们常是手写源码
  目录）。
- 时钟 / 定时器注入点：TimeoutGate、熔断器、审计日志可注入；**调度器 throttle 与
  cli-agent / http-bridge 的 `Date.now()` 不可注入** —— 测 429 退避只能靠假时钟。
- `shared/glob.ts` 的 RegExp cache **无上限无淘汰**，而 key 来自模型写的 glob。

## 线路池（LLM failover）

由 `shared/providers.ts` 的两张表决定：`SENSENOVA_MODELS`（模型）× `SENSENOVA_KEY_VARS`（key）
= 商汤线路，加 AMD 一条兜底；共享一张故障转移冷却表。**别在文档里写死条数** —— 换成另一个数字
只是把漂移推到下次扩池（README 与设置页现在都表述为"由两张表决定"）。

- `SENSENOVA_MODELS_EXTRA`（当前登记 `deepseek-v4.1-flash` 候补）**刻意不进默认轮转**，有测试守着；**它是登记表不是开关**
  （生产代码零消费者，填进去 ≠ 入池）。
- 默认池是 `DEFAULT_LLM_POOL`（单一真源）；NVIDIA / OpenRouter 被排除的理由写在 `providers.ts`
  注释里（实测无响应 / 账号被锁推理）。
- 连续失败会升级冷却（一条线路冷却到期后再次失败 → 更久冷却）；402 / 404 / 410 属线路级永久
  错误，不当可重试。

## 当前的口径陷阱（改这些文件前先确认）

| 说法 / 直觉 | 实际 |
| --- | --- |
| `scoped-env.ts` 头注释 "a denylist that wins over the allowlist" | **别读成缺陷**：这里的 allowlist 指规则 2 的 `isRequired`（进程基础变量），denylist 确实压过它；而规则 1 的显式 `grants` 优先于 denylist（否则 `allowProviders` 永远放不了行）。两层都叫 "allowlist" 是措辞陷阱，改之前先分清是哪一层 |
| `TaskStatus` 里的 `queued` / `verifying` / `repairing` | 类型里有、**引擎从不发** —— 写 UI 之前先 grep 生产者 |
| `npm run <script>` | 白名单放行的是命令形状，**脚本内容不审** —— 这是真边界不是漏洞，但要知道 |
| `SHELL_METACHARACTERS` | 无平台开关，POSIX 上也拒 `^ ! %` |
| 砂箱 realpath 处理 | 第 7 级 zone 匹配的是输入路径；靠 4–6 级的 realpath 拦住物理逃逸 —— 别把两级混着读 |
| `execToken` | 不经 CommandPolicy / buildSpawnSpec 的**刻意**例外；红线是只加载自己写的 `agents.d` |
| journal 里的 `attempts` 与凭据里的 `repairs` | **同源的两份事实**（前者含首轮，后者只含重修轮），对不上不是 bug |
| 凭据字段"缺席" | `ReceiptTask.repairs` 等字段**缺席 ≠ 空数组**（空数组分不清"没发生"与"记录丢了"） |

## 数字去哪查

段数 / 用例数 / 变异规模这些数字**只住在命令里**：README 门禁索引节、`gates.md` 与 SKILL.md 的
声明由 `check:doc-claims` 对实物核（`package.json` 的 verify 串、`vitest list`、`site-baseline`）。
本文档与 CHANGELOG 刻意不写这些数 —— 抄一份就是第二处会腐烂的地方。历史数字（当时的实测值）
去 [ENGINEERING-LOG.md](ENGINEERING-LOG.md)。
