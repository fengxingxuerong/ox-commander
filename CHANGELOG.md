# 更新日志

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循语义化版本。**未发布前的版本只记"对用户/对维护者可见的变化"**，
纯内部重构若改变了行为仍会记入。

## [0.1.3] — 2026-09-27

### 新增

- **运行时注册的智能体现在会落盘**（`electron/agents/manifest-loader.ts` 的 `saveManifestFile` /
  `removeManifestFile`、`electron/ipc/agents.ts` 的 register / unregister、
  `src/components/AgentsPanel.tsx`）。此前 `agents:register` 只把 manifest 塞进内存 Map，
  重启或崩溃就没了 —— UI 只能提示"自己把 JSON 抄到 agents.d"，而一次注销就把配置丢了。
  现在注册**同时**把 manifest 原子写进 `agents.d/<id>.json`，重启走 `loadManifestDir` 照样加载。
  三个刻意的取舍：
  ① **落盘失败不回滚注册** —— 这一轮的 agent 确实能用，但返回值带 `persisted.ok:false`，
     UI 必须说清"重启后会丢"，审计里也留一句"落盘失败：…"。只报"已注册"会让人以为记住了。
  ② **注销只在文件内容与注册时一致时才删** —— 用户手工改过的 JSON 是他的东西，
     注销一个智能体不该连带毁掉他改过的配置；那种情况不删，并把原因报出来。
     否则"注销"只在本轮生效，重启一看它又回来了，而用户完全不知道为什么。
  ③ 文件名由 id 决定（这样**重启之后还能定位**，注销时内存映射已经没了）；
     id 含非法字符时替换成 `_` 并追加一段短哈希，免得 `a/b` 与 `a b` 撞成同一个文件。
  用例 7 条，含缺陷注入反证（把 `sameManifest` 改成恒真 ⇒ "文件被改过就不删"那条变红）。

## [0.1.2] — 2026-09-26（首个可安装的分发包）

这是第一个**真的有安装包可下载**的版本：Windows `OxCommander-0.1.2-x64.exe`、
Linux `OxCommander-0.1.2-amd64.deb` 与 `OxCommander-0.1.2-x86_64.AppImage`，
由 `release` 工作流在打 `v*` tag 时产出并挂到 GitHub Release 上。
（打包链路本身是怎么被修通的，见下面「新增（CI / 分发）」那三条。）

### 新增
- **预算闸现在会自己承认看不见多少**（`shared/usage-meter.ts` 的 `onBudgetBlind` / `budgetBlindNote`、
  `electron/platform.ts` 接线）。缺口：闸门判断用的是端点上报的 `usage.total_tokens`，
  而有些端点根本不回报这个字段 —— 那些调用的 token 永远进不了 `totalTokens`，
  `maxTokensPerRun` 对它们等于不存在（此前的表现是"总量 = 0、闸从不拦"，看板上读起来像还很安全）。
  这次**只做宣告、不做估算**：第一跳没上报用量就 `[budget]` 说一句（含上限与"看不见几次"），
  终态那行 `[usage]` 在有预算且有未上报时同样带上这句；没配预算、或每跳都上报时不说，
  坏预算值（0/NaN/负）按"不限"处理也不说。估算那半为什么不做：没有本机校准过的
  "字符→token"分布，估出来的数会被当成账单口径读，比不估更坏 —— 要估算得先做校准实测。
  用例 6 条（含"摘掉 platform 接线 ⇒ 该用例红"的反证，实测 1 failed / 29 passed）。
- **跳过上游之后，它的下游不再被继续烧钱**（`shared/graph.ts` 的 `skippedDescendants` +
  `electron/engine/orchestrator.ts` 三处判定）。这是"点名下游"那条留下的后半段：
  提示说清楚了，钱照烧 —— 被跳过的上游在派发上视同已满足，下游失败后每一重修轮都再派一次，
  到了耗尽还要问一句"要不要重派"，而**重派永远补不上那份被跳过的产物**，用户每答一次"重派"
  就多花一整轮 run 的预算。现在按"人自担、但不任人烧预算"落地：
  ① 下游只给**第一次**机会（已试过 + 被传染 ⇒ 后续重修轮不再派发，并点名说清为什么）；
  ② 耗尽时**不再对它弹升级决策**（那里只有终止/跳过/重派三个答案，问它就是诱导再花钱），
  改成一句"要它就把上游补上重跑"；判定用传递闭包，多上游只要有一份被跳过就算传染，
  用户在循环里中途跳过的上游会立刻影响后面的任务（每处理一个都重算，不是开头算一次）；
  ③ 终局文案跟着改：从"所有失败任务已被跳过"改成"上游被跳过带累 N 个下游任务"。
  **一条旧断言随之作废并改了**：原来"跳过点名下游"那条用例期望终局是 `用户终止`
  （测试里对下游答了 abort）；现在下游根本拿不到那一问，终局变成"带累 1 个下游任务"——
  这是行为变化，不是用例写坏。
  门禁侧：`electron/engine/orchestrator.ts` 逐位点从 31/34 补到 **33/33**，三个存活变异
  两个补了断言（放弃声明必须晚于该任务真的被派发；被传染的任务排在前面时，后面的正常任务
  照样要拿到决策），一个靠**改写结构消掉**（去重从循环里的 `continue` 改成集合差 + 一条汇总）。
  顺带纠正那条勘误里的一个说法：site 审计的算子集**不止** `&&`/`||`/`===`/`!==`，
  `--list` 按文件打印，本仓库还出现过 `继续(continue) → 中断(break)` 与 `return true → false`；
  "数值比较（`>`/`<=`）不在算子集里"这半句仍然成立。
- **声明并检查 headless CLI 的 Node 下限**（`package.json` 的 `engines`、`headless/protocol.ts` 的
  `runtimeGap`、`headless/headless-main.ts` 入口）。上一笔接取消时用了 `AbortSignal.any` 合并
  "单请求超时 ∪ 调用方取消" —— 那是运行时路径上**第一个**把下限抬到 Node 20.3+ 的 API
  （此前只有 `structuredClone` 与 `AbortSignal.timeout`，17.x 就够），而仓库既没有 `engines`
  也没有任何版本要求文档。症状会很难看：宿主用旧 node 驱动 CLI，planning 的 token 花完之后
  第一次执行器调用才从 `postJson` 抛 `TypeError: AbortSignal.any is not a function`。
  现在判据是**特性而不是版本号**（发行版会回移特性），缺了什么直接说"当前 X，需要 >= 20.19，
  因为缺 AbortSignal.any"，并且**先于读 stdin** —— 宿主不关管道时，"跑到一半才崩"会变成"永远挂着"。
  桌面端不受影响（Electron 33 自带 Node 20.18+，且它总走自己的运行时）。
- **取消与超时现在真的掐得掉在途 LLM 请求**（`shared/providers.ts`、`shared/http-clients.ts`、
  `shared/llm-client.ts`、`electron/agents/{run-session,sensenova-api}.ts`）。
  此前 `postJson` 只把 `AbortSignal.timeout(300s)` 交给 fetch，**没有任何调用方取消的入口**：
  用户点"中止"或 run 撞到时限，事件流会立刻收口，但那一次请求继续跑完、继续花 token、
  回来后还要走一遍沙箱写入判定（上一轮靠"丢弃生成物"兜住副作用，钱是兜不住的）。
  现在 `ChatRequest` 带可选 `signal`，与内部超时合并后下传（谁先响谁算）；
  内置执行器按 run 挂一个 `AbortController`，`abort()` 与看门狗到点都会真的掐掉那一回合。
  连带修掉三个"接上取消之后才会出现"的坑：
  ① `isTransient` 对一切非 HTTP 错误返回 true ⇒ 取消会被当成线路故障，**换个 Key 把同一份 prompt
  再发 11 次**，所以 `FailoverLlmClient` 现在见到 `req.signal.aborted` 原样抛出、**不轮询也不冷却**
  （一次取消不该惩罚后面所有 run）；② `chatJson` 的自纠偏重试会重发已叫停的请求 ⇒ 加了同样的短路；
  ③ 并发槽位仍跟着真实请求释放，不因超时提前放行。
  用例：取消后只调用过第一条线路 / 零条"冷却 N 秒"处置 / 下一次正常调用仍先试同一条线路、
  signal 真的下传（不合并就是 5s 挂住）、不传 signal 时内部 `TimeoutError` 照旧、
  `abort()` 与超时时 `req.signal.aborted` 为真、自纠偏只发 1 次。
  反证四处各跑过：摘掉故障转移的取消分支 1 failed / 24 passed、摘掉 signal 合并 1 failed / 10 passed、
  摘掉执行器接线 2 failed / 27 passed、摘掉 `chatJson` 短路 1 failed / 19 passed。
- **内置执行器（`sensenova-api`）现在也有 run 级时限**（`electron/agents/sensenova-api.ts`）。
  在此之前三个适配器里只有它不带 `limits`、不接 `TimeoutGate`，唯一的上界是**单次 HTTP 请求** 300s
  （`EXECUTOR_TIMEOUT_MS`）—— 而它恰是 `DEFAULT_SETTINGS.enabledAgents` 里开箱默认的那一个。
  单任务最坏耗时 = chatJson 自纠偏重试 × 线路池排队 × (300s + 冷却等待)，冷却单次上限 120s、最多等 2 次，
  所以一个卡住的生成任务合法地可以占用十几分钟而没有任何东西拦它。
  现在按 `cli-agent` / `http-bridge` 的同一形态接 `TimeoutGate`，`limits.runDeadlineMs` 默认 600s（同 `DEFAULT_AGENT_LIMITS`），
  覆盖排队、重试与冷却等待；到点判 `failed: 超出总时限`、**迟到的那一回合不落盘**（与"run 已中止即丢弃生成物"同一条守卫），
  并发槽位仍跟着真实请求释放，不因超时提前放行。
  已知边界：**在途的那一次请求仍会跑完**（token 已花），要真掐掉得把 `AbortSignal` 接进 HTTP 客户端
  （~~同日已闭合~~，见下面"取消/超时真的掐掉在途请求"那条）；
  本适配器的 **idle 看门狗刻意关掉**（`idleTimeoutMs: Infinity`）—— 一次请求在途最长 300s 期间本来就不产生事件，
  开 idle 会把每一次健康的慢生成判死。用例两侧都钉：预算内照常落盘、超时限判 deadline 那一支且不写文件；
  反证是摘掉 `guard()` 后两条超时用例必须红（实测 2 failed / 27 passed）。
- **`verify` 增加第 19 步 `mutation:touched`：只审「本次真的改到的变异目标文件」**
  （`scripts/mutation-touched.mjs`）。缺口是我自己踩出来的：`mutation:quick` 是 aggregate 口径、每目标 1 个
  变异，抓不到"某个承判文件里新加的判断没人逐点验过"；能抓的全量 `mutation:audit` 约 15 分钟、只在
  CI 的 ubuntu job 上跑，本机没人肯跑 —— 于是出现过"只重跑了改动涉及的其中一个目标文件就交付"，
  远端红了几笔才定位到 `headless/protocol.ts` 里我新增的一个 === 位点没人验过。现在这一步按 diff
  自动圈范围，成本随改动大小走（没碰到目标文件秒过；实测"改到 1 个目标"= 15 个位点 / 约 65s）。
  基线默认取工作区改动，干净时取 HEAD~1..HEAD，--base=<ref> 可覆盖。反证：在目标文件里植入一个
  === 翻转后这一步 exit 1；拦下的原因是基线测试红，不是"存活"（我没另外造出"只存活不红基线"的
  等价变异，所以不那样写）。README 与门禁手册的步数/用例数一并校回 19 段 / 996。



- **`ProjectSettings.runWallClockMs`：一次 run 的墙钟上限**（`electron/engine/orchestrator.ts`）。
  在此之前只有两个局部上界（单次 HTTP 请求 300s、单条验证命令 300s）和各 agent 自己的
  `runDeadline`——总时长完全没有概念，重修轮可以一直追加，一次运行可以合法地跑几小时以上
  （本机实测单模型 PLANNING 就能 >170s 不返回）。`undefined` 或 `<= 0` 都是不限，
  与 `maxTokensPerRun` 同风格：要"不限"就省略字段。检查点在重修循环顶部，
  **只在批/轮边界生效**，不掐断在途请求（那归 agent 的时限与 HTTP 超时管）；到点抛
  `RunWallClockError` 且不动 journal 与快照备份，现场留着可断点续跑。
  headless 侧同步进了 `KNOWN_FIELDS` 与 settings 组装（不加会被判"未知字段已忽略"，设置传不进来）。
  设置页有对应输入口（`单次运行墙钟上限（分钟）`）：界面按分钟给、存的是毫秒，填 0 = 省略字段 = 不限。

- **勘误（针对上面 `runWallClockMs` 那条）**：实现时我说过"site 口径 29/29 全杀，含三个新位点的两侧"，
  这话只对一处 —— `limit === undefined` 属于 `=== → !==`，而 `limit <= 0`、`elapsed <= limit`
  以及下面"跳过点名下游"那条的 `downstream.length > 0` 都是**数值比较，不在 site 审计的算子集里**
  （`--list` 实测只有 `&&`/`||`/`===`/`!==`）。这三处由用例与差分钉住（把检查注释掉即红），
  但那个"全杀"数字从未覆盖它们，拿它背书是我自己的错。见
  `.qoder/skills/ox-commander-dev/references/gates.md` 新增的「边界」一节。

- **跳过任务时会点名它仍会被派出的下游**（`electron/engine/orchestrator.ts`）。升级决策答"跳过"以前只打一句
  「用户跳过任务「X」，不再重试。」，而把 X 列为依赖的下游任务照样被派出、随后因缺少 X 的产物而失败 ——
  看板上读起来像下游自己坏了，还照原样消耗重修轮预算。现在那句后面直接点名下游客体标题，并写明
  "那种失败不是下游自己的问题"。~~**判定语义刻意不动**~~ —— 同日已被下面"跳过不再为下游花修预算"
  那条改掉（下游现在只给一次机会、且拿不到升级决策）；这一术当时只把事实说出来。

### 修复

- **`Tests N` 这个头条数字此前虚报 28 条**（`src/router.test.ts`、`src/agent-registry.test.ts`、
  新文件 `src/__fakes__/agents.ts`、`scripts/check-tests-collected.mjs`）。起因是我补用例后核对差值：
  我只加了 8 条（registry 5 + prompts 3），总数却从 1020 跳到 1033。查出来是
  `router.test.ts` 写着 `import { fakeAgent } from "./agent-registry.test"` —— **测试文件把另一个
  测试文件当模块导入**，收集 router 时连带执行 agent-registry 的 `describe/it`，那 28 条被注册两次。
  同一份 `router.test.ts` 在不同 run 里报 40 和 45 行（取决于 worker 有没有复用到那份模块缓存），
  所以这不是"数字大一点"的小节：门禁的承判映射与头条都不可信，而变异审计跑某个 judge 文件时
  还能借到别人的断言（这次核过：`router.ts` 与 `registry.ts` 逐位点仍各 20/20 全杀，
  之前的绿**没有**被借来的断言撑着 —— 这条要说清，否则听起来像以前的门禁是假的）。
  修法：夹具进 `src/__fakes__/agents.ts`（仓库既有约定，`check-unwired` 的 `SKIP_DIR` 已含该目录），
  两边都从那里 import；并把它变成机器判据 —— 第 8 步现在扫"能解析到盘上测试文件的相对说明符"，
  命中即 FAIL 并指出夹具该住哪。差分跑过：临时造一个跨测试文件 import ⇒ RC=1 且点名文件与说明符，
  删掉探针 ⇒ RC=0 并多打一行「跨测试文件 import：0 处」。
  真值现在是 **1005 = 996 passed + 9 skipped**；今天各条 CHANGELOG/手册里写过的 996/999/1004/1006/
  1014/1020/1033 都被这 28 条虚报污染过（虚报幅度随那两个文件的规模而变），我不逐条改写历史条目，
  在这里统一更正一次口径：**以第 8 步修好之后的 `npm test` 输出为准**。

- **两处"没人断言的默认方向"补了用例**（`src/agent-registry.test.ts` +5、`src/prompts.test.ts` +3）。
  起点是覆盖率报告：`shared/agent-contract.ts` 的分支只有 75%，而它**不在变异门禁的承判文件里**，
  全量 site 审计也不会去看它 —— 这类文件的"翻转默认方向"没人守。
  ① `normalizeCapabilities` 的空数组回退（`roles:[] → ["*"]`、`zoneGlobs:[] → ["**"]`、
  `artifactKinds:[] → files+logs`）此前一行没断过。方向是刻意的（与 v1 适配器无限制的老语义一致，
  且 manifest schema 在解析层就拒空数组，走不到"声明为空还静默放宽"），但一次"顺手收紧"
  就会让一个声明不全的智能体**永远选不中或永远写不进**，而且不报错。用例除了看字段还看行为
  （`candidates()` 真的还能命中它）。差分验过：把 `length > 0` 翻成 `>= 0` ⇒ 2 failed / 26 passed
  —— 这正是 site 审计结构性看不见的数值边界（`>` 不在算子集里）。
  ② `maxConcurrency` 的取整与下界（0.7→1、2.7→2），以及"返回的是拷贝"——
  改它会污染调用方声明的数组、或让模块级 `LEGACY_CAPABILITIES` 被 push 脏，两条都断了。
  ③ `buildEscalationSummary` 是**人做处置决定时唯一的输入**（跳过 / 重派 / 终止），此前
  orchestrator 只数回调次数、从不读文案；现在断它点名三个真实可接受的动作、带上两个数字
  （已试轮数与上限）、带上错误原文，且空摘要写成「(空)」而不是留一行悬空标题。
  **两次我自己造出来的假缺陷要报备**（都被工具顶回来，没进代码）：
  一是为测"数组缺失"传了个没有 `roles` 的对象 ⇒ :207 抛 TypeError；二是为测"`selfIsolated` 缺省
  为 false"省略了该字段 ⇒ tsc 两条 2345 直接红。事实是 `selfIsolated` 在类型里必填、
  manifest 解析器（`manifest-schema.ts:105,116`）也总会写出布尔值，两条入口都到不了"缺失"形状，
  那个 `?? false` 只是给非 TS 调用方的兜底 —— 不该为不可能的形状写断言，更不该没读类型定义
  就断"缺省行为"。跑完整门禁时 typecheck 抓到它们，说明第 1 段就是该抓这个的位置。

- **把三处"睡固定时长再断言"的用例改成断言条件**（`src/sensenova-api.test.ts`、
  `src/audit-log.test.ts`）。这类写法把结果压在墙钟上，共享 runner 卡一下就红在一次抖动上：
  ① 两条 run 时限用例原来给 120ms / 40ms 的真预算 —— 判据是"**在途请求**被掐掉"，
  而机器慢时看门狗可能在请求**发出之前**就响，`sawSignal` 还是 `undefined`，
  于是红在抖动而不是行为上。现在用 `vi.useFakeTimers()`：先把微任务跑干（断言请求确已发出、
  signal 尚未 abort），再推进 `runDeadlineMs`，顺序被钉死；冷却那条同时多断一句
  "喊过'第 1 次等待约 5s 后重试'"，证明截断发生在**等待途中**而不是开始前。
  ② 并发上限那条原来睡 30ms 然后断 `peak <= 2` —— 调度器还没起跑时这个断言是**空的**。
  现在先 `vi.waitFor(() => peak === 2)`，再断 `activeRuns() === 2` 与上限，
  "上限"必须由"槽已占满 + 后面还在排队"共同证明；"0 = 不限"那条同样改成等条件。
  验证：摘掉看门狗 `guard()` 仍是 2 failed / 27 passed（假时钟没让断言变哑）；
  `scheduler.ts` 逐位点 **15/15** 全杀（改断言没有削弱并发门禁的覆盖面）。

- **CI 的两个 `verify` job 从 `2afd002` 起一直红，根因是 `mutation:touched` 在浅克隆里崩**
  （`scripts/mutation-touched.mjs`、`.github/workflows/{verify,release}.yml`）。
  它按 `package.json` 的顺序是第 11 段（共 19 段；那笔提交写的"第 19 步"说的是"新加的那一段"）。
  `actions/checkout@v4` 默认 `fetch-depth: 1`，那种仓库里**没有 `HEAD~1`**，而干净工作区下
  这一步正是拿 `HEAD~1..HEAD` 当基线 ⇒ `git diff` 直接 fatal，抛给 job 日志一坨裸 node 堆栈。
  本机永远是全历史，所以这一步在本机从没红过 —— 是我推完四笔去查远端结论才发现的。
  **归因**：`cde8075`（我开工前的一笔）两个 verify job 都是绿的，`2afd002`（引入第 19 步）起转红，
  我这四笔（`aa35f20`/`49e36d2`/`0c37f43`/`c5c995e`）不是成因；`mutation (site, every site)` 全程绿
  也对得上——它不跑这一步。
  两处一起改：① 跑 `npm run verify` 的两个 job 的 checkout 加 `fetch-depth: 0`；
  ② 脚本不再让 git 的堆栈裸奔 —— 基线解析不出来就 FAIL 并说明"浅克隆 ⇒ CI 加 fetch-depth: 0 /
  本机用 `--base=<ref>`"，`--base` 写错也走同一句。**不退化成审 `git diff HEAD`**：干净工作区下那是
  空集，会让这一步宣称 PASS 而一个位点都没审。
  验证：在 depth-1 克隆里用 `skip-worktree` 造出"干净树 + 无父提交"的 CI 原形，改前 RC=1 且是裸堆栈，
  改后 RC=1 且是那句人话；写错的 `--base=nope-not-a-ref` 同样一句。
  遗留一条（**不是 bug，是这一步的语义**）：CI 上一次推多笔时，`HEAD~1..HEAD` 只覆盖最后那一笔，
  其余靠 `mutation (site, every site)` 那个全量 job 兜。

- **零验证不再被念成"验证通过"**（`electron/engine/orchestrator.ts`）。`verificationCommands: []`
  是合法配置（headless 协议允许空集），而空集在 `verifyProject` 里恒为 `passed`，于是交付那一句日志
  写的是"全部验证通过，进入交付。"——实际什么都没验。**判定刻意不改**（纯文档类任务确实不需要构建，
  拒掉空集会让那类调用方红），改的是说法：`report.results` 为空时当场输出
  「没有配置任何验证命令，也没有冒烟样本运行过 —— 本次交付**未经构建/测试验证**」。
  冒烟样本算作验证（它会把条目落进 `results`），所以只有"命令为空且没有冒烟"才走这一句。
  site 口径实测 orchestrator 28/28 全杀（新位点的两侧都有断言）
- **`scripts/smoke-e2e.mjs` 的规划阶段一直是坏的**（真实 API 手动冒烟脚本）。它按
  `batches = await engine.decompose(prd)` 用，而 `decompose` 早就改成返回
  `{ batches, smoke }`（独立样本冒烟和计划一起产出）——于是第一个模型必抛
  `batches.reduce is not a function`，而脚本按模型逐个 catch 只打一行「❌ 失败」，
  **看起来在跑，实际从没验过规划**。现在解构取两个字段，并把冒烟项数一并打出来。
  这是"不进 CI 的手动工具会烂"的又一例：同一个 API 的三处生产调用都是类型化的，只有这个
  `.mjs` 脚本没人替它兜着
- **被沙箱拒绝的路径现在进终态**（`electron/agents/sensenova-api.ts`）。内置执行器过去只在**中间日志**
  说一句「跳过：〈原因〉」，终态事件仍写"写入 N 个文件"。而重修循环带进 prompt 的是那份终态摘要 ——
  模型以为全落了，下一轮原样再写同一条被拒路径，配额空烧、没人告诉它为什么红。现在 completed 带
  「沙箱拒绝 M 个：〈路径列表〉」，全部被拒时抛错直接点名这些路径（原来含糊说"模型未返回可写入的文件"，
  会把归因带到模型输出格式上去）
- **取消现在会真的中止在跑的 run**（`electron/engine/scheduler.ts` + `electron/engine/orchestrator.ts`）。
  `cancel()` 过去只置一个 `cancelled` 标志，而那个标志只在下一个检查点生效；结果是用户点了取消，
  已经在跑的外部 CLI 智能体仍按自己的 `runDeadline`（默认 600s）跑完并继续改文件。
  现在 Scheduler 登记在跑的句柄（`liveRuns`，出口在 `finally`），`cancel()` 下传
  `abortInFlight()` 逐个 `adapter.abort(handle)`，并把中止数量播报成
  `[取消] 已请求中止 N 个在跑的任务`（N=0 时不说这句话，不假装做了什么）；
  某个适配器的 abort 抛错不影响其余的仍被中止
- **内置执行器在中止之后不再落盘**（`electron/agents/sensenova-api.ts`）。模型那一回合是
  **算完了**的（token 已花，这一条本次改不了），但 `writeFiles` 之前有了守卫：
  生成物被丢弃并写日志。要真正省钱得把 `AbortSignal` 接进 HTTP 客户端，未做。
  顺带把 `scripts/mutation-check.mjs` 里该文件的两条行号锚点按新行号校回（337→346、343→352），
  site 口径实测 29/29 全杀；锚点旁散文里的旧坐标改成按构造点名，免得再漂一轮
- **两个 IT 不再往 `%TEMP%` 扔目录**（`scripts/admission-gateway-it.mjs`、
  `scripts/e2e-snapshot-secrets.cjs`）。它们建完目录没有任何清理，本机实测
  `ox-agents-it-*` / `ox-gw-it-*` / `ox-snap-*` 各 **45 个** = 跑 `verify` 的次数，
  其中 `ox-snap-*` 里还写着**长得像真 Key 的**哨兵字符串。现在都挂在 `process.on("exit")` 上，
  判定通过/失败/`process.exit` 三条路都会经过。复现核对：
  `npm run smoke:gateway` 前后各数一次 `ls -d $TEMP/ox-agents-it-* | wc -l`
- **未到期批备份从此要说出来**（`headless/run-spec.ts`）。批在中途死掉时 `BatchGuard.settle()` 从未执行，
  那一批的越权写入既没被仲裁也没被回滚，只留下一个 `batch-*` 备份目录 —— 而回收器对它
  "未到期所以保留"这一支**一声不吭**，于是"保留"读起来像"没事"。现在 `PruneResult` 带 `kept`，
  启动时点名这些目录并写明"本次运行不会自动回滚，请人工核对"。措辞刻意避开"回收"二字：
  离线 IT 有一条断言就是"没谎报回收"（两处都是 `includes` 子串判定，读码核过）。
  跨进程证明落在 `smoke:offline-e2e` 场景 D 的同一条检查里。**要不要在启动期自动补一次仲裁**
  仍是未定的策略，没做。

- **回滚不再删掉用户项目自己的 `package.json`**（`electron/sandbox/snapshot-store.ts` +
  `electron/engine/batch-guard.ts`）。默认档 `revert-batch` 的删除判据是"备份里没有 ⇒ 它是本批新建"，
  而快照只备份本批 zone 覆盖到的路径（通常 `src/`、`tests/`）—— 于是模型改根级 `package.json`
  （加依赖是最常见的一次越权）被仲裁检出之后，回滚把用户本来有的清单文件**当新增删掉**，
  每轮重修再删一次。现在两件事分开：
  ① `BatchGuard.begin` 把 `sharedPaths` 里的字面文件交给快照层的 `include`，它们从批开始就在备份里，
  回滚是**还原原内容**；② `revert` 的删除只认正面证据 —— 调用方传进来的 `created` 集合，
  来自 `FileJournal` 的 `create` 记录（日志看的是整棵树，不受 zone 限制），
  "没有备份"从此只记 `skipped`、不动文件。
  反证：把生产改动退回上一版，新用例 `shared file edited outside the zones is restored, not deleted`
  当场红；还原后 80/80 绿。同时留了反向用例（项目本来没有 `package.json`、是这一批生成的 → 仍删），
  避免把"不删"修成无条件
- **Windows 上每一条走 `.cmd` shim 的验证命令都是红的**（`electron/sandbox/spawn-plan.ts`）。
  cmd 包装过去只给每个 token 加引号：`/c "C:\Program Files\nodejs\npm.cmd" run build`。
  而 `/s` 的语义正是"去掉首尾两个引号字符、中间原样保留"，于是 cmd 把它解析成命令
  `C:\Program`，报「不是内部或外部命令」。Node 的**默认安装位置就带空格**，
  而 `DEFAULT_SETTINGS.verificationCommands` 是 `npm run build` / `typecheck` / `test` ——
  也就是桌面端开箱跑任何项目，第一次验证就必红、判"工作区受损"、全员重跑、重修预算烧光。
  现在整条 line 外层再套一对引号（`""<shim>" run build"`），实测四种形态全通：
  带空格路径、无空格路径、含空格的 arg、空 arg。
  **为什么 974 条用例没抓到**：`src/spawn-plan.test.ts` 那条包装用例断的是
  `args[3]` *包含* `npm.cmd` 子串，旧写法也包含；且它的 shim 建在没有空格的临时目录里。
  现在断整条形状，并加一条**真 spawn** 的用例（临时目录里刻意建 `with space` 子目录）。
  反证：把生产改动退回上一版，这两条当场红；还原后 16/16 绿
- **验证与冒烟的子进程不再继承宿主的凭证环境**（`electron/engine/verifier.ts`）。`runOnce` 与
  `runSmokeChecks` 此前都不传 `env`，于是每一次 `npm run build`、每一条冒烟脚本都拿到完整的
  `process.env` —— 那里面装着 3 把 SenseNova Key 和其余 provider 的 Key（桌面端把 keychain
  播种进 `process.env`，`electron/main.ts` 还会加载 `.env`）。而验证命令跑的是**智能体刚写下的
  项目脚本**：一句读环境的话就能把账单凭证带进它自己的输出。`cli-agent.dispatch` 早就用
  `scopedEnv()` 关掉了这个面，`verifier` 是漏掉的那个。现在两处都传 `env: scopedEnv()`
  （PATH / HOME / SystemRoot / TMP / `NPM_CONFIG_*` 仍透传；从**磁盘**读的 `.env`·`.npmrc` 不受影响）。
  实测：修复前沙箱内子进程报出 7 个凭证变量名，修复后 0 个，同一条命令
  （`src/sandbox-llm-call.smoke.test.ts`）就是复现方式。
  代价当场兑现：验证脚本读不到白名单外的宿主变量了 —— `src/orchestrator.test.ts` 里那条
  "用 `SMOKE_FIX` 环境变量翻转冒烟结果"的用例就是这么红的，已改成重修轮**改写样例脚本**，
  这也更接近智能体真实的修法
- **`CliAgentAdapter.probe()` 同样最小化环境**（`electron/agents/cli-agent.ts`）：探测就是拿
  `--version` 真跑一次那个二进制，它此前也继承全部 Key —— `dispatch` 做了收缩、`probe` 没做

### 新增（CI / 分发）

- **打包失败现在不再是无头案**（`.github/workflows/release.yml`）。此前 `package (windows)` 与
  `package (ubuntu)` 三次停在 `Package` 这一步，而本仓库读不到 job 日志
  （`GET .../actions/jobs/{id}/logs` → 403 Must have admin rights），失败原因只能靠猜 ——
  猜过「`files` 引用不存在的 `LICENSE`」「linux deb 需要 runner 上没有的 fpm」「产物目录为空触发
  `if-no-files-found`」三轮，一个都没落实（`LICENSE` 后来补上了，打包照样红）。
  现在失败时先把 `npm run build:dist` 的完整输出（`DEBUG=electron-builder` 开着，默认只打人话摘要）
  落成 `build-dist.log` 与 `diagnostics.txt`（含 node/npm 版本、`release/` 与三个 dist 目录的实际内容），
  再走两条**无需 admin** 的通道出去：① `packaging-diagnostics-<os>` artifact；
  ② check run 的 `output.text`（checks API 对公开仓库可读，截断在 60 KB 内）。
  判失败单独挪到最后一步 —— `continue-on-error` 不能把红灯吃掉，而 `| tee` 之后那条 `echo`
  会把退出码盖成 0（步骤 outcome 取最后一条命令），所以必须显式 `exit $code`。
  同一轮加了 `concurrency`（取消同 ref 上的旧 run）与每 job `timeout-minutes: 30`：
  2026-09-25 那次两个 package job 停在 checkout / setup-node 阶段 in_progress 三十多小时，
  既不失败也不结束、把后面的 run 全堵住 —— 宁可让它显式超时，留一条「卡在哪一步」的事实。

- **诊断通道第一次用到就抓到了根因**（`v0.1.2-rc1` / `078cbdb` 那次 run）。结果分两条，
  两条都不是"打包没配好"，而是**差在最后一步**：
  1. **Linux = deb 缺 maintainer**：`⨯ Please specify author 'email' in the application package.json`
     （`FpmTarget.computeFpmMetaInfoOptions`）。`package.json` 的 `author` 是裸字符串、没有邮箱，
     而 deb 用 fpm 打包、fpm 强制要 `Maintainer` 带 email。**AppImage 其实已经打成功了**
     （`OxCommander-0.1.1-x86_64.AppImage` 109 MB），是 deb 目标抛错把整个 build 带成非零退出 ——
     这就解释了为什么之前"看着像 Linux 打包全红"。修法放在 `electron-builder.yml` 的
     `linux.maintainer`（填 GitHub noreply 邮箱），不去动 `package.json` 的 `author` 语义。
  2. **Windows 打包成功、挂在建 Release**：`Package` 绿、`installers-windows-latest` artifact
     200 MB 也传上了，唯独 `gh release create` 红。`release/*` 会把 `win-unpacked/` 这类
     **目录**一起展开进 argv（ubuntu 侧诊断里 release/ 下就有 `__appImage-x64` 与 `linux-unpacked`
     两个目录），gh 收到目录参数会拒绝。改成先用 `find release -maxdepth 1 -type f` 收成数组再传，
     并且**文件数为零时显式报错退出**（免得建出一个没有任何安装包的 Release）。
     同一个 glob 问题也修在 `Upload installers (artifact)` 上 —— 加 `!release/*/**` 排除子目录树，
     否则 artifact 的 200 MB 里大半是 `win-unpacked`。
- **建 Release 这一步自己也接上了诊断通道**（`.github/workflows/release.yml`）。
  `v0.1.2-rc1` 上暴露了一个缺口：`Publish diagnostics to check run` 的条件是
  `steps.package.outcome == 'failure'`，**Package 之后的步骤挂掉就没有任何可读输出** ——
  恰恰是这次红的那一步。现在 `Create release` 也 `continue-on-error` + `tee` 到 `release-create.log`，
  失败时写进一个**独立命名**的 check run（`release-create-diagnostics (<os>)`，与
  `packaging-diagnostics` 分开，免得两份诊断混在同一个 output 里分不清），判失败同样挪到末尾单独一步。
- **第一个 Release 真的出来了**（`v0.1.2-rc3`）。三个目标全部打包成功：
  Windows `OxCommander-0.1.1-x64.exe` 80.7 MB、Linux `OxCommander-0.1.1-amd64.deb` 85.9 MB 与
  `OxCommander-0.1.1-x86_64.AppImage` 109.8 MB；日志里能看到
  `Setting from flags: maintainer=fengxingxuerong <...>` —— deb 那条修正确实生效了。
  中途还撞了两个坑，都不是打包本身的问题：
  ① 想给 artifact 排掉 `win-unpacked/` 而加的 `!release/*/**`，把 `release/` 下的文件
  **一起否掉了**，两个 OS 的 `Upload installers` 同时 failure（已回退到 `path: release/*`）；
  ② 诊断原本只在 `steps.package.outcome == 'failure'` 时才发，于是"打包成功但后续步骤红"
  又变成只能猜 —— 条件改成 `always()`，成功时也发一份 neutral check（不影响门禁）。
- **建 Release 的步骤改成幂等**（`.github/workflows/release.yml`）。两个 OS 的 job 都会跑到
  `gh release create`，而同一个 tag 只能有一个 Release：windows 先建好之后，ubuntu 撞上
  `a release with the same tag name already exists` → 打包全绿、整个 job 却红掉。
  现在先 `gh release view` 探一次，已存在就改用 `gh release upload --clobber` 追加；
  `create` 失败且报 already exists 时再回退 upload 一次（覆盖两个 job 同时判成"不存在"的竞态）。
  顺带排掉 `builder-debug.yml` —— 它是 electron-builder 写的 effective config 快照、给排查打包
  用的，rc3 上被当成安装包挂进了下载列表。
- ⚠️ **仍未处理**：`desktopName` 未设（Linux 桌面环境无法把运行中的窗口关联到 .desktop 条目）、
  icon 未设（分发版用默认 Electron 图标）。前者不是 build config 的字段 ——
  `scheme.json` 里只有 `linux.syncDesktopName`，而它读的是 **package.json 的 `desktopName`**，
  要修得两边一起加。非阻塞。

### 新增

- `src/sandbox-llm-call.smoke.test.ts`：**沙箱内的 LLM 可达性探针**（真实网络，刻意不进 `verify`，
  跑法写在文件头）。子进程走的是生产同一条路：`planSpawn`（CommandPolicy 检查 → buildSpawnSpec
  按平台包装）→ `spawn(shell:false, env: scopedEnv(...))`。它把"能不能调用"拆成三个各自成立的
  事实：① 显式 `allowProviders: ["sensenova"]` 时沙箱子进程拿到真实 200 与 `pong`；
  ② 默认最小化环境下凭证变量名为零，而端点仍回 401 —— 也就是**沙箱不掐网络**，
  它管的是路径与命令，不是防火墙；③ `verifyProject` 起的子进程必须与 ② 同源（修复前是红的）


## [0.1.1] — 2026-09-25（首个打 tag 的版本，**没有产出安装包**）

`0.1.0` 只在 CHANGELOG 里声明过、**从未打 tag 也从未产出安装包**，所以它描述的是
09-24 仓库公开那一刻的状态。本条是第一个真正打了 tag 的版本，但那次 `release`
工作流的两个 package job 都失败了（当时读不到失败原因，根因到下一条 0.1.2 才查清），
**这个版本号下从来没有可下载的安装产物**。第一个真正能装起来的是 0.1.2，
两者的内容不同，因此不合并为一条。

### 新增

- `.qoder/skills/ox-commander-dev/`：给 agent 的仓库工作手册（`verify` 16 步逐条机制、变异白名单的
  行号锚点、两张豁免表的双向失效规则、分层与放置约定、win32/POSIX 分支差异、红灯速查）
- `docs/2026-09-24-consistency-review.md`：一致性复核，含 10 条带复现方式的未修缺陷清单
- **每次运行前先跑一遍基线验证**（`electron/engine/orchestrator.ts`）。此前重修提示里只有
  "上一轮的失败日志"，所以**目标项目本来就坏着**（缺依赖、套件红）时，智能体看到的是一份与自己
  无关的失败，会去改不属于自己的文件。现在基线红的命令会随每一份重修上下文附上
  `[本次运行前就已失败] build(exit=1)` 这样的标注，日志里另附原因并当场说明"这不是智能体造成的"。
  断点续跑不跑基线（工作区已被上一轮改过，基线不成立）。代价是每次运行多一轮验证命令，
  换的是归因；重修预算的行为没有改（"验证未过但无失败任务 → 全员重跑"仍是原样）
- **`verify` 增加第 17 步 `smoke:offline-e2e`：零配额的离线全链路 E2E**
  （`scripts/offline-e2e-it.mjs`）。此前没有任何一步真的穿过进程边界——其余各步要么在函数层
  注入假件跑引擎，要么只查产物语法与协议退出码。这条用本地假大脑（冒充 `ollama`，占 11434）
  加假 http-bridge 智能体，经真 `dist-headless` 跑**三个场景共 27 项断言**：clean 钉阶段顺序、
  `hello` 首发与终态 `done`、run 归因条数、用量落账、stdout 每行都是合法 JSON；rogue 钉越权
  回滚是**外科手术式**的（zone 内的产出必须留下）、仲裁发出的 remedy 值与看板词表同源、
  重修轮只重派越权那个任务、退出码 0 与 2 的分野；prebroken 钉基线归因真的到了智能体手里。
  反证：把越权场景的处置临时改成 `report-only` → 5 项 FAIL、
  退出码 1（README 留在盘上、批次不改判、正常交付），也就是它真的在看行为而不是在跑流程。
  端口 11434 被占（本机跑着真 Ollama）时**直接失败并给出排查命令**，不静默跳过
- `typecheck` 现在覆盖第四套工程 `tsconfig.node.json`（`vite.config.mts` / `vitest.config.mts`）——
  这两个文件此前不在任何 npm script 里，改坏了要到 `vite build` 才暴露。接入时 verify 仍是 16 步
  （上面那条离线 E2E 才把它推到 17 步），实测 +1.7s；接入前先验过一次：现存配置干净，
  且故意注入的类型错误确实被抓出来
- **`headless/run-spec.ts` 登记进变异门禁**（tier 2，测试挂 `src/headless-protocol.test.ts`）。
  它此前不在 `TARGETS` 里，于是本轮新写的凭证闸与备份回收完全没机制保证"断言真的在看它们"。
  **首跑 6/15（40%）**：`&& → ||` 存活说明"手里恰好有一条 Key"那格没人跑过（那正是离线 IT 上误挡的场景），
  两处 `continue → break` 存活说明回收循环的"跳过这一条"从未与"到此为止"区分过，
  `run` 事件的 `durationMs` 从没断过（同一模式在 `orchestrator.ts` 早有断言，分层各抄一遍不等于两层都有门禁）。
  补 4 条用例后 **15/15**。为让"跳过"可跨平台判定，`pruneStaleBackups` 的遍历改成**显式排序** ——
  `readdirSync` 在 Linux 是 hash 序、Windows 是字典序，而 `failed` 是要给宿主比对的列表，不该随平台变
- **全仓 site 变异审计在 win32 本机复测：603/603（100%）· 14.3 min**。此前 README 引的是 CI 那一次的
  590/590，本机没复现过；同日 aggregate 口径也复测为 162/162（两个口径不可互换）。分母净 +13
  （新目标 `headless/run-spec.ts` 占 15 处，其余是这几轮新增与删除位点的净结果），**不是白名单放宽**——
  `EQUIVALENT_SITES` 按 `{file, op, line}` 精确匹配，任何行号漂移都会让那个位点重新计入分母且无断言而变红，
  所以一次全量绿同时兜住了那 9 条锚点当前仍然对得上
- **离线全链路 IT 加第四个场景：跑到一半被杀掉**（第 17 步从 27 项断言涨到 win32 39 / POSIX 41）。
  同一个工作区上连跑三个真进程：第一次派单刚落到桥端就杀进程 → 断 journal 已落盘、中断那批的
  `batch-*` 备份留在盘上（实测目录名 `batch-mufqn0fq-18476-1-t-impl`，带 pid 与序数，正是上一条提交
  修的碰撞面）；第二次 → 断它当场说出「断点续跑：恢复快照」、**大脑零调用**（规划真的被跳过）、
  没到 24h 的遗留备份一个都没删也没谎报回收；第三次把遗留目录 mtime 推到 48h 前 → 断它被回收且
  在日志里点名，且回收不影响这一次正常交付。原先这些只在函数层用假件测过，进程边界之上没人验过
- **`verify` 增加第 8 步 `check:tests-collected`：抓「盘上有、但 vitest 根本不收集」的测试文件**
  （`scripts/check-tests-collected.mjs`）。起因是 `vitest.config.mts` 的 `test.include` 不含 `headless/**`
  而 `coverage.include` 含它 —— 往 `headless/` 写一个测试文件会**一次都不执行**，却让 headless 的
  覆盖率数字继续统计。判据取自 `vitest list --filesOnly` 的**真实输出**而不是自己解析 include 再匹配
  glob（后者要重实现 picomatch 语义，一偏差门禁查的就不是它声称在查的东西，代价约 6s）。
  `vitest list` 失败或产出空集合一律 **FAIL**，不当作"没有未收集项"放过。反证：往 `headless/` 放一个
  `zz-probe.test.ts` → 门禁点名它并 exit 1；把 `headless/**/*.test.ts` 补进 include 后同一探针被收集，
  且 `npx vitest run headless/zz-probe.test.ts` 真跑出 `1 passed`
- **`check:scripts` 现在也检查 `.js`**（此前只认 `.mjs/.cjs`）。`scripts/acceptance/csvstat-acceptance.test.js`
  此前两层都不覆盖：vitest 不收它、语法门禁也不认它，一个语法坏掉的验收套件要等验收方真拿去用那天才炸。
  反证：注入一个语法坏的 `scripts/zz-probe.js` → `26/27` 且 exit 1 并打印 `SyntaxError`，删掉后 `26/26`
  （多出来的那 1 个就是它）。`.js` 按 CommonJS 解析，要 ESM 请改扩展名为 `.mjs` 而不是放宽门禁

- **分层红线第一次有了机制**：`eslint.config.mjs` 给 `shared/**/*.ts` 加 `no-restricted-imports` ——
  禁 `node:*` 与裸 node 内建、禁 `electron|react|react-dom|zustand`、禁 `../electron/**|../headless/**|../src/**`。
  这条红线此前只活在注释里（`atomic-file.ts:13`），没有任何机制保证；现在违反即 lint 红。
  落地时 `shared/` 对外 import 数为 **0**，所以是零违规的纯增量 —— 只拦未来，不改现状。
  反证：`shared/` 里临时 `import fs from "node:fs"` → lint 点名该文件；换成 `from "../electron/platform"` →
  两条规则同时红；删掉后 `npm run lint` EXIT 0。
  **故意没给 `headless/**` 加同类规则**：`run-spec.ts` 现在经 `electron/platform` 拉进 `electron/sandbox`，
  加了当场就红 —— 那条要先解依赖（或先承认它跨层），不能靠规则硬压下去

### 修正

- **`typecheck` 不再吃增量缓存**：四套工程全改成 `tsc -p … --noEmit --incremental false`。
  触发它的是实测到的假绿 —— 一个用了未导入标识符（`path`）的新函数被 `tsc -b` 放行，
  非增量立刻报 `TS2304` 等三处。代价约 +6s。`build` / `build:headless` 仍用 `tsc -b`（要产出）
- **headless 现在有信号处理了**。此前 `headless/` 一个 `process.on` 都没有：Ctrl-C 之后宿主只拿到
  被截断的 JSONL、没有终态事件。现在 SIGINT/SIGTERM 会把 `error` 作为**最后一条**事件发出去
  （消息里写明快照备份留在哪），刷完 stdout 再以退出码 1 结束；第二下不等排空直接退。
  **并且刻意不删快照备份** —— 被中断的那一批正停在"越界文件已写、还没仲裁"的状态，那份备份是人工
  恢复现场的唯一材料。回收改到下一次运行启动时（`pruneStaleBackups`：只认 `batch-*` 且超过 24h，
  宿主把 `snapshotRoot` 指到共享目录时别的东西一个都不碰），删不掉的会说出来而不是静默跳过
- **更正上一条里第一版的做法（`d06b9c9`，已推送未发布）**：那一版收到信号只 `process.exitCode = 1`
  并让 run 继续跑完，理由是"给在飞的仲裁一次落盘机会"。听起来合理，实际是把协议的终态说掉了 ——
  `error` 在事件表里写着"终态"，而宿主会先拿到 `error` 再拿到一串 `verification`/`done`。
  让它真的停下来之后才有得断言：POSIX 侧发一次 `SIGTERM`，最后一行必须是那条 `error`；
  Windows 投不进信号（`kill()` 就是 TerminateProcess），退化成"退出码 `null`、没有终态事件"，
  这一点写进协议文档 §2.1 而不是留给宿主猜
- 原判"journal 泄漏"更正为**预期行为**：`ox-run-journal.json` 是断点续跑的入口（`load()` 读它），
  成功后也不删，不算中断遗留
- **批号与 runId 不再依赖毫秒唯一**：`Scheduler` 的批号（同时是 `snapshots/<runId>` 目录名）加上
  `pid` 与进程内序数，runId 加上序数。原先 `batch-<ms36>-<taskIds>` 在两个进程同毫秒跑同一份需求时
  会撞成同一个备份目录（序数不够，跨进程都从 1 开始，所以批号必须带 pid；runId 只活在本进程的
  适配器里，序数即可）
- **发布流水线加门禁**：`release.yml` 新增 `verify` job，`build` 改为 `needs: verify`。
  此前打 tag 直接产出装进别人机器的 exe，且 tag 可以落在任何一次从未跑过 verify 的提交上。
  两个 workflow 都过了 `js-yaml` 结构校验；但 CI 是否按预期变绿只能等下一次 tag/dispatch 实证

- **headless 的 `llmProvider` 从此真的生效**。协议字段表写着"大脑层 provider"，但实现只把它
  echo 进 `hello` 事件，装配时用的仍是 `settings.llmProvider` 的默认值 —— 宿主写
  `"llmProvider": "ollama"` 而池为空时，打的还是 SenseNova。现在它进 `settings`，与
  `buildLlm` 的「池优先、池空退单 provider」口径一致（`headless/protocol.ts`）
- **headless 缺凭证时给一句能行动的话**。原先一路跑到第一次模型调用才炸，宿主看到
  `failover client has no groups` 无从下手。现在在 `hello` 之后就发 `error` 并以退出码 1 结束，
  消息里列出需要哪几个环境变量（`headless/run-spec.ts` 的 `requiredCredentialVars`）。
  口径跟着**实际会用的那组 provider** 走：池里是免密钥的本地 provider 时不拦 —— 我第一版
  按 `settings.llmPool`（永远等于默认池）判断，被离线 E2E 当场抓成假拦截，已改并补了单测
- **README 关于 `.env` 的说法纠正**：旧文案说"headless CLI 只认 `.env`"，实际加载 `.env` 的
  只有桌面端主进程（`electron/main.ts`），headless 从来就读不到它。现在写明：headless 的凭证
  只能来自宿主注入的进程环境变量，`docs/headless-protocol.md` 也补了这节
- **仲裁四档现在真的有四种行为**。`report-only` 与 `deny-all` 此前走同一分支（都标记批次失败、
  都不回滚），差别只在日志文案，于是设置页上「仅记录日志」那一档其实会判整批失败。
  现在按界面写下的那句分开：`report-only` 只记日志、不改判（裁决报 `pass`），
  `deny-all` 保留文件但整批判失败。默认档 `revert-batch` 与 `quarantine` 不变
- **同一条分支还漏了收尾**：不回滚的两档既不 `commit` 也不丢弃快照令牌，每跑一批就在
  `userData/snapshots` 下留一份备份目录。四档现在都在出口处 commit
- **看板念出的处置与引擎发出的值对齐了**。`src/store.ts` 的 remedy 词表写的是
  `revert`/`isolate`/`keep`，而生产端（`BatchGuard.remedyFor`）只会发 `revert`/`quarantine`/
  `fail-batch`/`pass` —— 那两个值从来没人发，所以"移入隔离区"和"保留文件判失败"两种处置
  在看板上都被念成"仅记录"。旧用例用的正是这套假词表，因此它绿着而链路坏。
  现在词表导出为 `REMEDY_VERB`，对账用例在引擎侧（真跑四档再比对），四档必须产出四种不同裁决
- `execToken` 的信任红线写进 `agents.d/README.md` 与 `shared/agent-contract.ts`：它由指挥机直接
  spawn，不过命令白名单也不过 spawn 规划，失败静默返回 undefined（请求照发、只是没凭证）。
  顺带按本机实测纠正了一条常被写错的 Windows 说法：裸名 `npm` 是 `ENOENT`，而 `npm.cmd` 是
  `EINVAL`（CVE-2024-27980 之后不带 `shell:true` 不能起批处理）—— 取令牌脚本在 Windows 上只能是 `.exe`
- `headless/protocol.ts` 头注释不再自称 "pure: no fs, no process"（它 import 了 `node:path`，
  还为 `snapshotRoot` 读 `process.env.TMPDIR/TEMP`）。改成准确的不变量：不落盘、不 spawn、不改全局
- 撤回一条误报：手册说「manifest 的 id 与适配器配不上会被静默丢弃」，复核 `manifest-loader.ts` 后
  不成立 —— 没能变成适配器的声明都会进 `skippedManifests`，`agents:list` 又把这份清单报给界面。
  手册已改正，真正静默的是上面那条 `execToken` 失败

- **构建产物不再被当成任务越权，也不再挤掉模型该看的源码**。跳过清单原本有四份副本，谁都不认识
  `dist/`/`coverage/`，于是两件事同时成立：批内跑一次项目自带的 `npm run build`，产物会被判
  `unauthorized-write` → 整批标记失败并在默认档里被回滚删除；执行器的工作区快照按路径序消耗 32k
  预算而 `coverage/`、`dist/` 正排在 `src/` 前面 → 本机实测修复前"进快照的 12 个文件里 11 个是产物、
  真实源码 0 个"，修复后 6 个文件全是要读的源码（快照 31.5k → 7.5k 字符）。`out`/`bin`/`target`
  刻意不列入（常是手写源码目录）
- **桌面端 run 现在真的能用「设置」里存的 Key**（P1）。播种器改挂在 `PlatformConfig.seedKeys` 上，
  `createPlatform` 内部构造引擎大脑时即生效；此前只有「设置 → 测试连接」那条一次性路径会读 keychain，
  正式 run 的大脑层与内置执行器都只看进程环境（日常被根目录 `.env` 掩盖）。优先级仍是
  进程环境 > `.env` > keychain，三者都只补缺失项。README 的凭证一节按此改写
- `scripts/check-script-wiring.mjs` 的豁免表改以数组登记并在建 Map 前查重复键：旧字面量里
  `loomy-bridge.mjs` 被写了两次，后一条理由静默顶掉前一条，而门禁本身察觉不到
- 两处"注释描述了代码没做的事"：`circuit-breaker.ts` 的 `record` 不再被说成会放过 `retryable: false`
  的失败（它只看布尔，行为本身保留）；`sensenova-api.ts` 写入不带 zone 的推迟理由从"等回滚落地"
  换成真实理由（写入门是严格前缀，在这里认 zone 会误拒模型按约定写的模块文件）
- 设置页线路池两处互不相符的说明文案（一处写 4 模型、另一处写 3 模型）改为从
  `SENSENOVA_KEY_VARS` / `SENSENOVA_MODELS` 派生，并加防漂移用例；`package.json` description 与
  两处代码注释同步去掉写死的数字
- README 门禁口径：16 步（原写 15）、940 用例（原写 930）、`mutation:quick` 是"每目标 1 个 aggregate 变异"
  的最弱档、覆盖率标注为"不设阈值、不是门禁"、审计轮转正为**按大小 2 MiB**（原写按天）、
  仲裁四档标注前两档行为相同、`shared/` 的纯逻辑约定标注"无机制强制"

## [0.1.0] — 2026-09-24（首个公开版本）

从 2026-08-26 起、128 个提交的第一对外发布。仓库在 GitHub 公开，
两个 CI job（verify 矩阵 + 全量 site 变异）随每次 push 运行。

### 新增

**平台能力**
- 六阶段编排：`需求 → PRD → PLANNING → DEVELOPMENT → VERIFICATION → DELIVERY`，
  按 zone 归因的 repair loop（失败任务带着"属于它的那部分错误"重修，而不是整份摘要）
- zone 互斥并行派发：批内任务按 zone 互斥分批，越权写入由 guard 裁决并默认回滚
- 能力路由：按 role / zone / tags 择优派发，与熔断共享一张状态表（冷却被降权、熔断被跳过）
- 三种执行器接入：`local-llm`（SenseNova 执行器池）/ `cli`（Codex 等）/ `http-bridge`（WorkBuddy 等）
- 线路池：商汤 3 密钥 × 4 模型 = 12 条 + AMD 1 条，共 13 条共享一张故障转移冷却表；
  429 只冷却命中线路本身
- 双入口：Electron 桌面端（单实例锁，重复启动提前台）+ headless JSONL 协议 CLI
- Token 用量可见性与 `maxTokensPerRun` 预算闸门（settings / UI / 协议三入口贯通）

**安全边界**
- 路径七级判定（穿越 / 越根 / 受保护路径）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
- 越权默认回滚（内容备份，不用 git stash），可选隔离区 / 保留 / 仅日志
- JSONL 审计按大小轮转（单文件 2 MiB）；API Key 走 OS keychain（Electron safeStorage），
  不可用时明确回退明文并告知

**质量门禁**（本项目的核心差异化，见 README「质量门禁」）
- `npm run verify` 单一入口，14 步
- 变异门禁双口径：aggregate（每算子至少一处）与 **site（每一处位点单独验证）**；
  仅以 site 为准
- 产物层冒烟（`smoke:artifact`）：防"源码全绿但产物坏了"
- `check:unwired`（导出符号零调用 → FAIL）与 `check:scripts-wired`
  （写在 scripts/ 但不在任何自动入口的脚本 → FAIL，逼作者在"接进入口"和"显式接受"间选）

### 变更

- 依赖：vite 5 → 8、@vitejs/plugin-react 6，对齐 vitest 4 的 peer 要求
  （修 `npm ci` 的 `Missing esbuild@0.28`）
- 进程入口层从"刻意不纳入门禁"变成门禁目标：`main.ts` 补齐 `requestSingleInstanceLock`，
  并新增 `src/main-wiring.test.ts`
- CI 的 mutation job 从 aggregate 改成 site 口径（aggregate 会掩盖位点）

### 修复

- `store.ts`：项目 id 加同毫秒单调序数 + list 平局决胜（修 Linux CI 的
  newest-first flake —— `Date.now()` 毫秒粒度下同毫秒连建两项目会碰撞、排序随机）
- `sandbox/spawn-plan.ts`：resolve 漏传 platform，注入通道失效（真 bug，跨平台轮发现）
- `sandbox/kill-tree.ts`：补 `hasExited` 预检查（POSIX 直接路径的 pid 复用误杀，真缺口）
- Electron 单实例：两个实例驱动同一 projectRoot 会各自建快照、各自回滚，
  审计里出现互相矛盾的 run 记录；现在第二个实例直接退出并提前台

### 已知限制

- **安装需要自备 `.env`**：桌面端与 headless 都不会替你写入密钥
- 真实 LLM 链路（`OX_SMOKE=1` 与全链路脚本）需密钥、消耗配额，**不在门禁内**
- UI 层覆盖率是最低的一档（`src/pages` funcs 75.6%、`platform.ts` funcs 47%）；
  Electron GUI 无自动化 E2E（只有 jsdom 组件测试）
- macOS 打包未验证（release workflow 只产出 Windows / Linux 产物）
