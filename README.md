# OxCommander

**总指挥智能体**：把项目需求拆解为 PRD → 任务 → zone 互斥批次，按能力路由并行下发给执行器
（SenseNova API 池 / Codex 等 CLI / HTTP 桥接智能体），经 build + typecheck + test 多轮硬性验证后交付。
Electron 桌面端 + headless CLI 双入口。

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

## 质量门禁

`npm run verify` 是唯一验收入口，任何改动以它全绿为准（实测 EXIT 0 / ~1m50s，14 步）：

```
typecheck（renderer / electron / headless 三套 tsconfig）
→ lint（eslint flat config，含 react-hooks 规则）
→ check:unwired（导出符号在生产代码里零调用 → FAIL）
→ check:scripts / check:scripts-wired / check:masker（工具脚本语法、接线、掩空器自测 24 例）
→ vitest（888 用例；真实 API smoke 由 OX_SMOKE=1 + SENSENOVA_API_KEY 门控，默认跳过）
→ mutation:quick（tier 1 目标逐点变异，~30s）
→ vite build + tsc headless 构建
→ smoke:artifact（产物层离线冒烟：dist 产物存在性、dist-electron 全量语法检查、
   headless 二进制协议退出码——防止"源码全绿但产物坏了"）
→ smoke:snapshot-secrets / smoke:gateway / smoke:coze / smoke:import（四条集成链路）
```

覆盖率：`npm run test:coverage`（v8 provider，模块级报告；当前 91.4% stmts / 86.0% branch）。

**变异门禁有两个口径，数字不可互换**：

| 口径 | 命令 | 含义 | 最近实测 |
| --- | --- | --- | --- |
| aggregate | `npm run mutation` | 每个算子**至少一处**被覆盖 | 152/152（会掩盖位点，见下） |
| **site** | `npm run mutation:audit` | **每一处位点**单独验证 | **577/577（100%）**，22.9 min |

aggregate 用 `replaceAll` 一次改掉某算子的全部位点，"任一处被杀"即报杀死 ——
所以它报的 100% 可能是假象。**site 才回答"每处是否真有断言"**。

CI（`.github/workflows/verify.yml`）两个 job：`verify`（ubuntu + windows 矩阵）、
`mutation`（site 口径，35 min 上限）。

> **注意：仓库目前没有远端**，这两个 job 一次都没跑过 —— 本地绿不等于 CI 绿。

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
| `shared/` | 双端共享大脑层：LLM 客户端与 failover、契约、glob、routing、prompt、schema（纯逻辑，不碰 node/DOM API） |
| `headless/` | JSONL 协议三层：protocol（契约）/ run-spec（执行）/ headless-main（胶水） |
| `agents.d/` | 声明式智能体接入文档与示例（运行时读 `%APPDATA%\OxCommander\agents.d\`） |

智能体接入契约（capabilities / credential / limits）见 [agents.d/README.md](agents.d/README.md)。

## LLM 线路池

13 条线路共享一张故障转移冷却表：商汤 3 密钥 × 4 模型 = 12 条 + AMD 1 条。
429 只冷却命中线路本身，请求立即落到同 key 其他模型 → 其他 key → 其他 provider；
跨 provider 时认证失败不做整池 fail-fast。全部可在「设置 → 线路池」勾选配置。

## 安全边界

- 所有智能体副作用强制过沙箱：路径七级判定（穿越/越根/受保护路径）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
- zone 越权默认**回滚**（内容备份，不用 git stash），可选隔离区 / 保留 / 仅日志
- 全程 JSONL 审计（按天轮转），run 与 agent 归因、冲突、回滚留痕
- API Key 经 OS keychain（Electron safeStorage）加密落盘，不可用时明确回退明文并告知

## 文档索引

- [docs/2026-09-19-multi-agent-orchestration-plan.md](docs/2026-09-19-multi-agent-orchestration-plan.md) — 多智能体平台 P0–P6 设计与实施全记录
- [docs/2026-09-20-fullstack-review.md](docs/2026-09-20-fullstack-review.md) — 全栈评审：架构 / 风险诊断 / 优化记录（§十七 为最近一轮复核）
- [docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md) — 变异门禁 site 口径基线（577/577，含逐目标报告与适用边界）
- [docs/headless-protocol.md](docs/headless-protocol.md) — headless JSONL 协议
- [docs/2026-08-26-sensenova-smoke-defects.md](docs/2026-08-26-sensenova-smoke-defects.md) — 真实 API 接入缺陷记录
- [docs/2026-09-19-quality-hardening.md](docs/2026-09-19-quality-hardening.md) — 质量加固（覆盖率/UI 测试/lint 门禁/产物冒烟）
