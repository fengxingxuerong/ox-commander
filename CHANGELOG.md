# 更新日志

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循语义化版本。**未发布前的版本只记"对用户/对维护者可见的变化"**，
纯内部重构若改变了行为仍会记入。

## [未发布]

### 新增

- `.qoder/skills/ox-commander-dev/`：给 agent 的仓库工作手册（`verify` 16 步逐条机制、变异白名单的
  行号锚点、两张豁免表的双向失效规则、分层与放置约定、win32/POSIX 分支差异、红灯速查）
- `docs/2026-09-24-consistency-review.md`：一致性复核，含 10 条带复现方式的未修缺陷清单

### 修正

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
