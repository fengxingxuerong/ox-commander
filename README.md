# OxCommander

[![verify](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml/badge.svg)](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**总指挥智能体**：把项目需求拆解为 PRD → 任务 → zone 互斥批次，按能力路由并行下发给执行器
（SenseNova API 池 / Codex 等 CLI / HTTP 桥接智能体），经 build + typecheck + test 多轮硬性验证后交付。
Electron 桌面端 + headless CLI 双入口。

> **设计定位（与同类编排器的差异）**
>
> 同类项目大多走「git worktree 隔离」路线——每个智能体在独立目录里互不干扰。
> OxCommander 走的是**共享工作区 + zone 互斥**：智能体像真实团队一样在同一棵树里
> 按目录分派并行，越权由仲裁层回滚/隔离。另一条路线，两种取舍：
>
> | 特征 | OxCommander |
> | --- | --- |
> | 执行器 | **自带 SenseNova LLM 池执行器** + Codex/Claude CLI + HTTP 桥（不依赖订阅） |
> | 并行隔离 | zone 互斥批 + 冲突仲裁（回滚/隔离/报告四档） |
> | 验证 | **动手前先跑基线** + build/typecheck/test 硬门禁 + repair loop 归因重修 + 产物冒烟 |
> | 沙箱 | 路径七级判定、命令白名单 + 元字符拦截、双超时、熔断、快照回滚 |
> | 预算 | token 用量可见性 + `maxTokensPerRun` 软上限闸门 |
> | 协议 | headless JSONL 协议（外部宿主可编程驱动）|

```
需求 → PRD → PLANNING → DEVELOPMENT（zone 互斥并行） → VERIFICATION（build/typecheck/test） → DELIVERY → DONE
                ↑______________ repair loop（按 zone 归因重修）______________|
```

## 快速开始

```bash
npm install
npm run verify        # 唯一验收门禁（见下）
npm run dev           # 浏览器开发模式（无 Electron 壳）
npm run dev:electron  # 桌面端开发模式
npm start             # 运行已构建的桌面端
```

> 桌面端是**单实例**应用：重复启动不会开第二个指挥台，而是把已有窗口提到前台。
> 这是有意为之 —— 两个实例驱动同一个 projectRoot 会各建快照、各自回滚，
> 审计里会出现互相矛盾的 run 记录。

headless（供外部宿主以 JSONL 协议驱动整个平台）：

```bash
npm run build:headless
echo '{"requirement":"...","projectRoot":"D:/path/to/project"}' | node dist-headless/headless/headless-main.js
# 协议字段、事件与退出码见 docs/headless-protocol.md
```

## 获取与安装

**方式一：下载安装包**（推荐，不用装 Node）

到 [Releases](https://github.com/fengxingxuerong/ox-commander/releases) 取对应平台的产物，
或到 [Actions 页](https://github.com/fengxingxuerong/ox-commander/actions) 取任意一次
`release` 运行的 artifact（手动触发也会产出，不需要打 tag）：

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows | `OxCommander-<ver>-x64.exe`（nsis 安装版）/ `…-x64.exe`（portable 免安装） | 两种都出，portable 解压即用 |
| Linux | `OxCommander-<ver>-x64.AppImage` / `.deb` | AppImage 直接 `chmod +x` 后运行 |
| macOS | **不产出** | 无签名凭据；未签名 .app 会被 Gatekeeper 拦下，故宁缺 |

⚠️ **跑起来之前要有凭证**：桌面端在「设置」里填即可（加密进 OS keychain），也可以放一份 `.env`。
至少给一把商汤的 key：

```dotenv
SENSENOVA_API_KEY=sk-...          # 必填，一条 key 就能跑
# SENSENOVA_API_KEY_2=sk-...      # 选填：多把 key = 12 条线路，429 时可 failover
# SENSENOVA_API_KEY_3=sk-...
# AMD_API_KEY=...                 # 选填：加第 13 条（DeepSeek-V4-Flash）
```

规则：`.env` **只补缺失项**，宿主环境里已设的值不会被覆盖；无 key 的 provider
（本地 Ollama 之类）照样保留其线路。

> 桌面端**可以不备 `.env`**：「设置」里填的 key 经 OS keychain 加密落盘，构建引擎时按池内 provider
> 补回进程环境（大脑层与内置执行器同一来源）。优先级是 **进程环境 > `.env` > keychain**，三者都只补缺失项。
> headless CLI **不读 `.env`** —— 加载 `.env` 的是桌面端主进程（`electron/main.ts`）。
> 由宿主驱动时请把凭证放进它 spawn 子进程的环境里；缺失时 runner 会在 `hello` 之后立刻报
> 需要哪几个变量并以退出码 1 结束，而不是等到第一次模型调用才吐内部错误。

**方式二：从源码跑**（开发者）

见上方「快速开始」的四条命令；headless CLI 用法也在那一节。

**方式三：自己打包**

```bash
npm run build:dist    # → release/，只打**当前平台**的原生目标
```

`build:dist` 刻意**只打当前平台**：Windows 上的 AppImage/deb 需要 Docker、Linux 上的 NSIS
需要 wine，写死 `--win --linux` 会让每个平台都有一半目标站不住（首次真跑就是这么红的，
两个 CI job 各在 30 秒内失败）。全平台产物由 `release` 工作流的 windows + ubuntu 矩阵各自产出。
确实装了 wine / Docker 的人可以 `node scripts/build-dist.mjs --targets=win,linux` 显式跨平台。

首次打包会下载 Electron 二进制与各平台工具链（几百 MB，本机需代理），
所以**推荐让 CI 出产物**：推 `v*` tag 会自动建 Release 并挂上安装包，
也可以在 Actions 页手动触发 `release` 来验证打包配置本身。

## 质量门禁

`npm run verify` 是唯一验收入口，任何改动以它全绿为准（2026-09-25 本机实测 EXIT 0，19 步）：

```
typecheck（renderer / electron / headless / vite 配置 四套 tsconfig）
→ lint（eslint flat config，含 react-hooks 规则；不覆盖 docs/ 与 scripts/；
  `shared/**` 另有分层红线：禁 node API、禁依赖宿主层与上层）
→ check:unwired（导出符号在生产代码里零调用 → FAIL；豁免表项失效同样 FAIL）
→ check:scripts / check:scripts-wired / check:packaged-paths / check:masker
  （工具脚本语法与接线、打包路径缺陷判定、掩空器自测 24 例）
→ check:tests-collected（盘上有、但 vitest 根本不收集的测试文件 → FAIL；
  vitest 收集不到任何文件也 FAIL —— 收集过程坏了不许报绿）
→ vitest（984 用例；真实 API smoke 由 OX_SMOKE=1 + SENSENOVA_API_KEY 门控，默认跳过）
→ mutation:quick（tier 1 目标，每目标 1 个 aggregate 变异——最弱档，别读成"变异全过"）
→ vite build + tsc headless 构建
→ smoke:artifact（产物层离线冒烟：dist 产物存在性、dist-electron 全量语法检查、
   headless 二进制协议退出码——防止"源码全绿但产物坏了"）
→ smoke:snapshot-secrets / smoke:gateway / smoke:coze / smoke:import / smoke:offline-e2e（五条集成链路，最后一条是零配额的离线全链路 E2E）
```

覆盖率：`npm run test:coverage`（v8 provider，模块级报告；2026-09-25 复测 92.00% stmts（3843/4177）/
86.68% branch（2356/2718），**不设阈值**，所以它不是门禁）。

**变异门禁有两个口径，数字不可互换**：

| 口径 | 命令 | 含义 | 最近实测 |
| --- | --- | --- | --- |
| aggregate | `npm run mutation` | 每个算子**至少一处**被覆盖 | 162/162（会掩盖位点，见下） |
| **site** | `npm run mutation:audit` | **每一处位点**单独验证 | **603/603（100%）**，14.3 min（2026-09-25 本机 win32 实测） |

aggregate 用 `replaceAll` 一次改掉某算子的全部位点，"任一处被杀"即报杀死 ——
所以它报的 100% 可能是假象。**site 才回答"每处是否真有断言"**。

CI 是两份 workflow：`verify.yml`（`verify` ubuntu + windows 矩阵、`mutation` site 口径 35 min 上限），
`release.yml`（`verify` → `build` 两 OS 矩阵，2026-09-24 起打包前必须先过门禁）。仓库托管在 GitHub
（公开仓库），`verify.yml` 随每次 push 运行。**已推送到 `77bc033`：run 14 三 job 全绿；run 15 的两个
`verify` job 已绿，它的 `mutation` job 落笔时仍在跑** —— 这类状态数字落笔即过时，CI 结论以 Actions
页为准，别拿 README 当 CI 状态。

> 基线出处：[docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md)
> （含 577 → 594 → 590 → 603 四轮快照、白名单行号漂移与平台相关等价的发现-处置记录）。

真实链路冒烟（需密钥、消耗配额，不进门禁）：

```bash
OX_SMOKE=1 npx vitest run src/sensenova.smoke.test.ts   # 6 个真实 API 用例
node scripts/smoke-fullchain.mjs                        # 真实 LLM 全链路 + 真实验证命令
node scripts/probe-endpoints.cjs                        # 端点/模型探测（临时工具）
```

> **429 SOP**：SenseNova 多把 Key 共享账号级滑动窗口（本机其他流水线也消耗同一窗口）。
> smoke 撞 429 `insufficient_quota` 表示限流而非密钥失效——冷却 ≥5 分钟后只重跑失败用例一次。

## 架构

| 目录 | 职责 |
| --- | --- |
| `src/` | Renderer（React18 + Zustand）：projects / prd-review / board / settings 四页 + AgentsPanel |
| `electron/engine/` | 编排器（六阶段 + repair loop）、调度器（批内 zone 互斥 + 并发闸）、能力路由、验证器、仲裁 |
| `electron/agents/` | 统一适配层：`local-llm`（SenseNova 执行器）/ `cli`（Codex 等）/ `http-bridge`（WorkBuddy 等）+ 注册表 + manifest 校验 |
| `electron/sandbox/` | PathPolicy / CommandPolicy / TimeoutGate / CircuitBreaker / FileJournal / SnapshotStore / spawn 规划 |
| `shared/` | 双端共享大脑层：LLM 客户端与 failover、契约、glob、routing、prompt、schema（纯逻辑，不碰 node/DOM API —— 目前只是约定，无 lint/tsconfig 机制强制） |
| `headless/` | JSONL 协议三层：protocol（契约）/ run-spec（执行）/ headless-main（胶水） |
| `agents.d/` | 声明式智能体接入文档与示例（运行时读 `%APPDATA%\OxCommander\agents.d\`） |

智能体接入契约（capabilities / credential / limits）见 [agents.d/README.md](agents.d/README.md)。

## LLM 线路池

线路池 = `shared/providers.ts` 里「每把 key × 每个模型」的笛卡尔积，再加不带多线路的 provider
（当前实际条数由那两个表决定，界面文案同样从它们派生），全部共享一张故障转移冷却表。
429 只冷却命中线路本身，请求立即落到同 key 其他模型 → 其他 key → 其他 provider；
跨 provider 时认证失败不做整池 fail-fast。全部可在「设置 → 线路池」勾选配置。

## 安全边界

- 所有智能体副作用强制过沙箱：路径七级判定（穿越/越根/受保护路径，realpath 后再判）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
  （注：内置执行器写入时不带 zone，zone 约束由事后仲裁兜，见 `docs/2026-09-24-consistency-review.md`）
- 沙箱**不管网络**：它是"能写哪个路径、能跑哪个程序"的判定层，不是防火墙。命令黑名单里有
  `curl`/`wget`/`nc`，但 `node` 在白名单里——智能体自己发 HTTP 请求是拦不住的，
  出网目标也不做任何限制。凭证侧的边界是：验证/冒烟子进程与 CLI 智能体都走最小化环境
  （`scopedEnv`），默认拿不到宿主的其他 provider Key；要给它 Key 必须显式写 `allowProviders`
  （探针与实测结论见 `src/sandbox-llm-call.smoke.test.ts`）
- zone 越权默认**回滚**（内容备份，不用 git stash），可选隔离区 / 保留 / 仅日志
  （四档 `report-only`/`deny-all`/`revert-batch`/`quarantine` 各自对应一种行为：仅记录不改判 /
  保留文件但判批次失败 / 回滚越权路径 / 移入隔离区）
- 构建/测试产物（`dist/`、`coverage/`、`__pycache__` …）不参与越权归因，也不进发给模型的工作区快照：
  它们排在 `src/` 之前，会占满快照的 32k 字符预算而把真实源码挤出去（`out`/`bin`/`target` 刻意不列入）
- 全程 JSONL 审计（**按大小轮转**，单文件 2 MiB；文件名含日期但不跨天触发），run 与 agent 归因、冲突、回滚留痕
- API Key 经 OS keychain（Electron safeStorage）加密落盘，不可用时明确回退明文并告知

## 文档索引

- [.qoder/skills/ox-commander-dev/SKILL.md](.qoder/skills/ox-commander-dev/SKILL.md) — **给 agent 的仓库工作手册**：
  门禁 19 步逐条机制、会让门禁静默变红的行号锚点与豁免表规则、分层与放置约定、win32/POSIX 分支差异
  （`references/gates.md` 与 `references/architecture.md` 是它的两份详表）
- [docs/2026-09-24-consistency-review.md](docs/2026-09-24-consistency-review.md) — 一致性复核：本轮改了什么、
  以及逐条带证据的**未修**缺陷清单
- [docs/2026-09-19-multi-agent-orchestration-plan.md](docs/2026-09-19-multi-agent-orchestration-plan.md) — 多智能体平台 P0–P6 设计与实施全记录
- [docs/2026-09-20-fullstack-review.md](docs/2026-09-20-fullstack-review.md) — 全栈评审：架构 / 风险诊断 / 优化记录（§十七 为最近一轮复核）
- [docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md) — 变异门禁 site 口径基线（577→594→590 三轮，含逐目标报告与适用边界）
- [docs/headless-protocol.md](docs/headless-protocol.md) — headless JSONL 协议
- [docs/2026-08-26-sensenova-smoke-defects.md](docs/2026-08-26-sensenova-smoke-defects.md) — 真实 API 接入缺陷记录
- [docs/2026-09-19-quality-hardening.md](docs/2026-09-19-quality-hardening.md) — 质量加固（覆盖率/UI 测试/lint 门禁/产物冒烟）

## 许可证

[MIT](LICENSE) © 2026 fengxingxuerong —— 可自由使用、修改、分发与商用，
唯一要求是保留版权与许可声明。本项目的贡献者许可与第三方依赖各自遵循其原有许可。
