# OxCommander

[![verify](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml/badge.svg)](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![mutation gate](https://img.shields.io/badge/mutation-逐位点全杀-blueviolet)

> **别的编排器给你 N 份 diff 让你挑；OxCommander 交付一份过了门禁的。**
>
> 判错逻辑本身被**逐位点**证明过：当前在册 **64 个目标** / 基线 **1342 处位点**。
> 最近一次**全量** site 审计是 **1312/1312（100%）**（2026-10-05 本机 win32，EXIT 0）；此后基线随
> 逐文件审计累加到 1342，**全量尚未重跑**。这两个数由 `check:doc-claims` 对实物核（基线取自
> `mutation-check.mjs` 的 `SITE_BASELINE`）—— 它们随 TARGETS 增长，而增长是加代码的自然结果，
> 所以**落笔即被检查**（上一版这里停在「881/881」那个时期的规模）。⚠️ 基线现值与全量审计结果是
> 两个数：前者说"有多少处该被逐点验过"，后者说"上一次真跑全量是什么时候" —— 混着写就是自证。

**总指挥智能体**：把项目需求拆解为 PRD → 任务 → zone 互斥批次，按能力路由并行下发给执行器
（SenseNova API 池 / Codex 等 CLI / HTTP 桥接智能体），经 build + typecheck + test 多轮硬性验证后交付。
Electron 桌面端 + headless CLI 双入口。

> **设计定位（与同类编排器的差异）**
>
> 同类项目大多走「git worktree 隔离」路线——每个智能体在独立目录里互不干扰
> （2026-09-29 实测：15 个同类项目里 12 个走这条路，[调研报告](docs/2026-09-29-competitive-landscape-and-roadmap.md)）。
> OxCommander 走的是**共享工作区 + zone 互斥**：智能体像真实团队一样在同一棵树里
> 按目录分派并行，越权由仲裁层回滚/隔离。另一条路线，两种取舍：
>
> | 特征 | OxCommander | Orca（80k★） | paperclip（92k★） | ruflo（73k★） |
> | --- | --- | --- | --- | --- |
> | 命题 | 自动拆解 → 并行 → **硬门禁闭环** → 交付 | ADE：把 N 个 CLI agent 摆在一个桌面里跑 | 管 AI 员工团队（组织/审批/预算） | 多模型 swarm 框架 |
> | 谁拆解需求 | **引擎自动 PRD → 任务 → 批次** | 人手动扇出 prompt | 人建 org chart 与目标 | 工作流自编排 |
> | 终点 | 一份过了门禁的交付 + 凭据 | N 份 diff，人挑赢家 | 审批与成本看板 | 任务执行结果 |
> | 执行器 | **自带 LLM 池**，不依赖订阅 | 带你自己订阅 | 带你自己订阅 | 带你自己订阅 |
> | 隔离 | zone 互斥（可跨模块协同改接口） | worktree 物理隔离 | 不涉及代码合并 | docker / swarm |
> | 沙箱 | 路径七级判定 + 白名单 + 双超时 + 熔断 | README 零命中 | 治理层策略 | 有 |
> | 谁适合 | 要**可担保的交付结果** | 要同时跑很多 agent 自己比 | 要管一支 AI 团队 | 要搭 swarm 应用 |
>
> 本项目自身的能力面：
>
> | 特征 | OxCommander |
> | --- | --- |
> | 交付凭据 | 每次运行产一份 **delivery receipt**：验证结论 + 逐任务账 + 越权处置 + token 用量，桌面落盘并**把外部可验证性的两半摆出来**（`checks[].command` 原样可见、`fingerprint` 整串可选），headless 发 `receipt` 事件、serve 状态页整份渲染 |
> | 执行器 | **自带 SenseNova LLM 池执行器** + Codex/Claude CLI + HTTP 桥（不依赖订阅） |
> | 并行隔离 | zone 互斥批 + 冲突仲裁（回滚/隔离/报告四档） |
> | 验证 | **动手前先跑基线** + build/typecheck/test 硬门禁 + repair loop 归因重修 + 产物冒烟 + **dev server 探活**（前端任务可选：驻留进程轮询 HTTP，跑完即杀） |
> | 沙箱 | 路径七级判定、命令白名单 + 元字符拦截、双超时、熔断、快照回滚 |
> | 预算 | token 用量可见性 + `maxTokensPerRun` 软上限闸门（**只看得见端点上报的用量**；遇到不回报 usage 的调用会当场说破"这道闸看不见它们"，刻意不估算） |
> | 协议 | headless JSONL 协议（外部宿主可编程驱动）+ **反向 MCP server**（agent 生态节点：查状态/取凭据/派单/暂停继续） |
> | 代价可量化 | `npm run zone:cost` 从审计事实算出越权次数与并行度代价 —— 少数派路线要拿数字说话 |

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

### 先跑一遍看看（零凭据、零网络）

```bash
npm run build:headless
npm run demo
```

它会现场造一个小目标项目（一个 CSV 统计工具），用**本进程起的假大脑与假执行器**
（都开在随机端口上）驱动真的 headless 引擎跑完一次交付，再把产出的**交付凭据**
交给独立复核工具核一遍：

```
规划 → 派单 → 落盘 → 门禁（node --test） → 交付凭据 → 外部复核
```

一条命令全过，不需要任何 API key，也不需要联网。命令、事件流与断言都是可读的 ——
不必先读完四个 IT 脚本才能明白这套东西到底在做什么。`--keep` 保留现场（临时项目、
事件流、凭据），`--quiet` 只看结论。

> 需要 **Node >= 20.19**（`package.json` 的 `engines`）。运行时这一侧真正的依赖是
> `AbortSignal.any` —— 没有它就没法把取消/超时下传给在途 LLM 请求。headless 入口按**特性**判，
> 缺了会先发一条 `error` 事件再说清"换哪个版本"，不会跑到一半抛 `TypeError` 堆栈。

> 桌面端是**单实例**应用：重复启动不会开第二个指挥台，而是把已有窗口提到前台。
> 这是有意为之 —— 两个实例驱动同一个 projectRoot 会各建快照、各自回滚，
> 审计里会出现互相矛盾的 run 记录。

headless（供外部宿主以 JSONL 协议驱动整个平台）：

```bash
npm run build:headless
echo '{"requirement":"...","projectRoot":"D:/path/to/project"}' | node dist-headless/headless/headless-main.js
# 协议字段、事件与退出码见 docs/headless-protocol.md
```

**或者起一个常驻服务**（浏览器/CI/远程都能看，同一套事件语义）：

```bash
node dist-headless/headless/serve-main.js --port=8787
# → http://127.0.0.1:8787/ 看状态与交付凭据
#   /events 是 SSE 事件流（后连上的客户端会先补齐历史）
#   POST /run 投递 spec（一次只跑一个，第二个拿 409）
```

**或者把它接进 agent 生态**（反向 MCP，竞品调研 5.5）：

```bash
node dist-headless/headless/mcp-main.js --serve-url=http://127.0.0.1:8787
# MCP stdio server：ox_status / ox_receipt / ox_events / ox_run / ox_control
# Loomy 等 MCP 宿主把它注册成 server，即可编程驱动整个平台
```

> serve 形态补的是「离开工位也能看」这一格 —— 实测 15 个同类项目里只有我们缺它
> （Orca 有桌面 + 手机伴生 + SSH worktree）。MCP server 再补一格：编排层自己
> 成为 agent 生态的一个节点（Vibe Kanban 的双向集成路线）。⚠️ 两者都无鉴权、
> 无 TLS：本机/内网/SSH 隧道后用。

**再进一步：拿到凭据的人可以自己复核它**（不依赖我们，也不依赖这个仓库）：

```bash
node dist-headless/headless/receipt-verify-main.js receipt.json
#   只验内容指纹 + 列出凭据记下的可复跑命令（默认不执行任何东西）
#   注意 not-replayed（退出码 5）不等于验证通过 —— 指纹一致只说明"没被改过"
node dist-headless/headless/receipt-verify-main.js receipt.json --replay --cwd=<项目目录>
#   在本地重跑那些命令并逐条比对：0=复现 / 2=矛盾 / 3=被改过 / 4=没盖章
```

> 别的编排器说"过了门禁"，你只能选择相信；这里凭据自带**跑过的命令**与**内容指纹**，
> 复核工具据此在**你的**环境里重跑。这是 `checks[].command` + `fingerprint` 存在的
> 全部理由（详见 `docs/headless-protocol.md` 第 9 节）。

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

`npm run verify` 是唯一验收入口，任何改动以它全绿为准（**28 段**，3–11 min —— 时长几乎全挂在
`mutation:touched` 上，改动面越大越久。2026-10-06 逐段实测：链首到 `mutation:baseline` 的 14 个静态段
+ `npm test` + `build` + `build:headless` + `smoke:demo` 全 EXIT 0）：

```
check:residue（首段，卫生预检：上一次变异运行被强杀时，活体变异体会留在源码里 ——
  它让修复循环空转，症状是链里的 `npm test`（vitest）堆涨到 4.6GB 后 OOM 且不退出，完全不像"工作区脏"。
  有残留就还原并退出 2 逼人重跑；台账坏掉也退出 2，因为它无法证明工作区干净）
→ typecheck（renderer / electron / headless / vite 配置 四套 tsconfig）
→ lint（eslint flat config，含 react-hooks 规则；不覆盖 docs/；
  `scripts/**` 自 2026-09-28 起也进 lint —— 那 5.7k 行是门禁判据本身，而 tsc 一行都不看；
  `shared/**` 另有分层红线：禁 node API、禁依赖宿主层与上层）
→ check:unwired（导出符号在生产代码里零调用 → FAIL；豁免表项失效同样 FAIL）
→ check:field-orphans（接口字段只有生产者、没有消费者 → 报候选；`shared/` 内的真孤儿 FAIL）
→ check:scripts / check:scripts-wired / check:packaged-paths / check:masker
  （工具脚本语法与接线、打包路径缺陷判定、掩空器自测 24 例）
→ check:tests-collected（盘上有、但 vitest 根本不收集的测试文件 → FAIL；
  vitest 收集不到任何文件也 FAIL —— 收集过程坏了不许报绿）
→ check:ipc-channels（preload 引用的通道 ⇔ `ipcMain.handle` 注册的通道，两个方向的漂移都拦；
  一侧解析为空也 FAIL —— 解析失配当通过就等于一道永远绿的摆设）
→ check:mutation-targets（改过的生产文件既不在变异 `TARGETS` 也不在显式豁免里 → FAIL。
  漏挂的文件根本不参与统计，那个 PASS 对它没有任何含义）
→ check:doc-claims（本节这几个数字**由命令现算**：段数、每段在文档里有没有行、
  用例数是否等于 `vitest list` 的收集结果、变异规模是否等于 `site-baseline --json`）
→ mutation:baseline（约 1s，不跑变异：把 TARGETS 的逐目标位点数与 `SITE_BASELINE` 对一遍。
  位点数涨了而基线没更新 = 新位点**没人逐点审计过**，此时「全部 N 处已逐点验证」是假象。
  这道漂移检查此前只在 site 口径里判，而 site 口径本机 verify 从不跑 ⇒ 漂移只有 CI 才知道）
→ vitest（2026-10-06 现跑 1714 通过 + 9 跳过，合计 1723 条，分布在 59 个有可执行用例的文件；
  真实 API smoke 由 OX_SMOKE=1 + SENSENOVA_API_KEY 门控，默认跳过）
→ mutation:quick（tier 1 目标，每目标 1 个 aggregate 变异——最弱档，别读成"变异全过"）
→ vite build + tsc headless 构建
→ smoke:artifact（产物层离线冒烟：dist 产物存在性、dist-electron 全量语法检查、
   headless 二进制协议退出码——防止"源码全绿但产物坏了"）
→ smoke:receipt-verify（交付凭据复核工具 `receipt-verify-main.js` 的端到端冒烟：
   8 例覆盖五档裁决与五个退出码，含"复跑的命令真的执行了"与
   "指纹不符时即使给了 --replay 也不复跑"两条非空转证据）
→ smoke:demo（对外可复现样例 `demo-deliver.mjs`：零凭据零网络的**一次完整交付**，
   顺带把凭据闭环走通 —— 产出凭据 → 独立复核默认模式判 not-replayed（指纹一致
   ≠ 结论为真）→ `--replay` 复跑判 verified。它同时是 README 的演示与回归基线）
→ smoke:snapshot-secrets / smoke:gateway / smoke:coze / smoke:import / smoke:offline-e2e（五条集成链路，最后一条是零配额的离线全链路 E2E）
→ smoke:target-range（LLM 故障转移靶场：本地故障注入端点矩阵，18 场景走真实 HTTP 验证 failover/冷却/升级/恢复全行为）
```

覆盖率：`npm run test:coverage`（v8 provider，模块级报告；2026-10-05 复测 92.89% stmts（5580/6007）/
89.11% branch（3661/4108），**不设阈值**，所以它不是门禁）。

**变异门禁有两个口径，数字不可互换**：

| 口径 | 命令 | 含义 | 最近实测 |
| --- | --- | --- | --- |
| aggregate | `npm run mutation` | 每个算子**至少一处**被覆盖 | 162/162（会掩盖位点，见下） |
| **site** | `npm run mutation:audit` | **每一处位点**单独验证 | **1330/1330（100%）**（2026-10-05 本机 win32 全量，64 个目标）；28.3 min 是目标更少那阵子的记录 |

aggregate 用 `replaceAll` 一次改掉某算子的全部位点，"任一处被杀"即报杀死 ——
所以它报的 100% 可能是假象。**site 才回答"每处是否真有断言"**。

CI 是两份 workflow：`verify.yml`（`verify` ubuntu + windows 矩阵、`mutation` site 口径 35 min 上限），
`release.yml`（`verify` → `build` 两 OS 矩阵，2026-09-24 起打包前必须先过门禁）。仓库托管在 GitHub
（公开仓库），`verify.yml` 随每次 push 运行。**已推送到 `77bc033`：run 14 三 job 全绿；run 15 的两个
`verify` job 已绿，它的 `mutation` job 落笔时仍在跑** —— 这类状态数字落笔即过时，CI 结论以 Actions
页为准，别拿 README 当 CI 状态。

> 基线出处：[docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md)
> （含 577 → 594 → 590 → 603 → 695 → 701 六轮快照、白名单行号漂移与平台相关等价的发现-处置记录，
> 以及三元算子的首次全量评估 875/931）。

### zone 互斥的代价（对外对比用的数字）

共享工作区 + zone 互斥是少数派路线（实测 15 个同类项目里 12 个走 git worktree），
主张要拿数字说话。审计事实里已经落了结构化的越权记录（`batch-guard` phase 带
`conflictKind` / `remedy`），所以代价可以直接算出来：

```bash
npm run build && npm run zone:cost -- --audit=<userData>/audit [--batches=<tasks.json>] [--selftest]
# → 越权 N 次（每 run X 次）· 涉及路径 M 个 · 其中 K 个已处置
# → 批次 B 段（最多并行 W 个任务）· 相对全并行多出 B-1 段串行 —— 这就是互斥切下去的刀数
```

⚠️ 只报**本项目这一侧**的实测数字：worktree 那侧的代价需要真跑另一种架构，
而一次对照实验的结论高度依赖任务集与机器 —— 编一个"节省 X%"比不报更坏。
报告给的是**口径**（两边各自的代价项是什么）+ 自己这一侧的实测。

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
| `shared/` | 双端共享大脑层：LLM 客户端与 failover、契约、glob、routing、prompt、schema（纯逻辑，不碰 node/DOM API —— 这条由 `eslint.config.mjs` 的 `no-restricted-imports` 机制强制，不是约定） |
| `headless/` | JSONL 协议三层：protocol（契约）/ run-spec（执行）/ headless-main（胶水） |
| `agents.d/` | 声明式智能体接入文档与示例（运行时读 `%APPDATA%\OxCommander\agents.d\`） |

智能体接入契约（capabilities / credential / limits）见 [agents.d/README.md](agents.d/README.md)。

## LLM 线路池

线路池 = `shared/providers.ts` 里「每把 key × 每个模型」的笛卡尔积，再加不带多线路的 provider
（当前实际条数由那两个表决定，界面文案同样从它们派生），全部共享一张故障转移冷却表。
429 只冷却命中线路本身，请求立即落到同 key 其他模型 → 其他 key → 其他 provider；
跨 provider 时认证失败不做整池 fail-fast。全部可在「设置 → 线路池」勾选配置。

冷却语义（2026-10-02 起对齐竞品弹性库标准）：

- **429/5xx/超时/畸形响应**：冷却该线路（429 带 Retry-After 时按服务端说的等，封顶 5 分钟）
- **402/404/405/410/413（线路级永久错误）**：余额耗尽、模型退役、路径配错 —— 同样 bench 本线路；
  400 刻意不冷却（换一个模型可能就对了）
- **连续失败升级**：冷却到期又失败 → 冷却时长翻倍（上限 10 分钟），成功一次清零 ——
  持续坏掉的线路不会被每 30s 重撞一次
- **线路健康可见**：每条线路的冷却剩余、失败/限流账、连续失败轮数都在看板与协议事件里
- 上述行为由**本地故障注入靶场**逐条验证（`npm run smoke:target-range`，真实 HTTP，18 场景）

## 安全边界

- 所有智能体副作用强制过沙箱：路径七级判定（穿越/越根/受保护路径，realpath 后再判）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
  （deadline 三个适配器都有：内置执行器 2026-09-25 才接上 `TimeoutGate`，默认 600s；**idle 只对外部两个开**——
  内置执行器一次请求在途最长 300s 期间本来不产生事件，开 idle 会把健康的慢生成判死。
  中止与超时现在会把在途那一次请求**真的掐掉**（`ChatRequest.signal` 与内部超时合并后下传给 fetch），
  已经花掉的那一笔 token 不退回；取消不计成线路故障——故障转移池既不轮下一条也不把它拉进冷却）
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
  门禁逐条机制、会让门禁静默变红的行号锚点与豁免表规则、分层与放置约定、win32/POSIX 分支差异
  （`references/gates.md` 与 `references/architecture.md` 是它的两份详表）
- [docs/2026-09-24-consistency-review.md](docs/2026-09-24-consistency-review.md) — 一致性复核：本轮改了什么、
  以及逐条带证据的**未修**缺陷清单
- [docs/2026-09-19-real-task-e2e.md](docs/2026-09-19-real-task-e2e.md) — 真实任务交付验收记录（csvstat 第一次真跑，
  抓到"智能体自写测试自洽地实现错口径"那一类盲区）
- [docs/2026-10-06-real-decomposition-e2e.md](docs/2026-10-06-real-decomposition-e2e.md) — 真实拆解端到端第二跑（**负结果**）：
  编排机制全部按设计工作（满载让路 / 429 换线 / 600s deadline 真掐 / 两次越权 revert / 三轮重派），
  但这单被 30 分钟墙钟截断没交付；独立验收抓到**契约点名的字面路径没人检查**——
  智能体交 `src/core/csv/index.js`，语法检查过，`node src/cli.js` 直接 `Cannot find module`
- [docs/2026-09-19-multi-agent-orchestration-plan.md](docs/2026-09-19-multi-agent-orchestration-plan.md) — 多智能体平台 P0–P6 设计与实施全记录
- [docs/2026-09-20-fullstack-review.md](docs/2026-09-20-fullstack-review.md) — 全栈评审：架构 / 风险诊断 / 优化记录（§十七 为最近一轮复核）
- [docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md) — 变异门禁 site 口径基线（577→594→590 三轮，含逐目标报告与适用边界）
- [docs/2026-09-29-competitor-research.md](docs/2026-09-29-competitor-research.md) — 多智能体编排器竞品调研（AO / Vibe Kanban / Omnigent 对位分析与可吸收清单）
- [docs/2026-09-29-competitive-landscape-and-roadmap.md](docs/2026-09-29-competitive-landscape-and-roadmap.md) — 竞品地形与优化方案（GitHub API 取数 + README 关键词命中口径，含 Orca 深读）
- [docs/2026-10-02-competitor-refresh.md](docs/2026-10-02-competitor-refresh.md) — 竞品特性刷新与吸收记录（Agent HQ//fleet 动态 + 弹性库标准特性逐条对照与落地）
- [docs/2026-10-03-competitor-refresh.md](docs/2026-10-03-competitor-refresh.md) — 竞品刷新 2026-10-03（Vibe Kanban 停摆与差异化、Orca 心跳/OpenRig/AO 动态、MCP 2026-07-28 评估；request-id 透传与任务活性心跳落地）
- [docs/headless-protocol.md](docs/headless-protocol.md) — headless JSONL 协议
- [docs/2026-08-26-sensenova-smoke-defects.md](docs/2026-08-26-sensenova-smoke-defects.md) — 真实 API 接入缺陷记录
- [docs/2026-09-19-quality-hardening.md](docs/2026-09-19-quality-hardening.md) — 质量加固（覆盖率/UI 测试/lint 门禁/产物冒烟）

## 许可证

[MIT](LICENSE) © 2026 fengxingxuerong —— 可自由使用、修改、分发与商用，
唯一要求是保留版权与许可声明。本项目的贡献者许可与第三方依赖各自遵循其原有许可。
