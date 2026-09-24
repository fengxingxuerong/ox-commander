# 更新日志

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循语义化版本。**未发布前的版本只记"对用户/对维护者可见的变化"**，
纯内部重构若改变了行为仍会记入。

## [未发布]

### 新增

- `.qoder/skills/ox-commander-dev/`：给 agent 的仓库工作手册（`verify` 16 步逐条机制、变异白名单的
  行号锚点、两张豁免表的双向失效规则、分层与放置约定、win32/POSIX 分支差异、红灯速查）
- `docs/2026-09-24-consistency-review.md`：一致性复核，含 10 条带复现方式的未修缺陷清单
- **`verify` 增加第 17 步 `smoke:offline-e2e`：零配额的离线全链路 E2E**
  （`scripts/offline-e2e-it.mjs`）。此前没有任何一步真的穿过进程边界——其余各步要么在函数层
  注入假件跑引擎，要么只查产物语法与协议退出码。这条用本地假大脑（冒充 `ollama`，占 11434）
  加假 http-bridge 智能体，经真 `dist-headless` 跑两遍完整 run，21 项断言钉住：六个阶段的顺序、
  `hello` 首发与终态事件、run 归因条数、越权回滚是**外科手术式**的（zone 内的产出必须留下）、
  仲裁发出的 remedy 值与看板词表同源、重修轮只重派越权那个任务、退出码 0 与 2 的分野、
  stdout 每行都是合法 JSON。反证：把越权场景的处置临时改成 `report-only` → 5 项 FAIL、
  退出码 1（README 留在盘上、批次不改判、正常交付），也就是它真的在看行为而不是在跑流程。
  端口 11434 被占（本机跑着真 Ollama）时**直接失败并给出排查命令**，不静默跳过
- `typecheck` 现在覆盖第四套工程 `tsconfig.node.json`（`vite.config.mts` / `vitest.config.mts`）——
  这两个文件此前不在任何 npm script 里，改坏了要到 `vite build` 才暴露。verify 的步数当时不变，
  本轮因下面这条离线 E2E 才成为 17 步，
  实测 +1.7s；接入前先验过一次：现存配置干净，且故意注入的类型错误确实被抓出来

### 修正

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
