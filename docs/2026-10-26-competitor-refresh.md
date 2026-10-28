# 竞品刷新 2026-10-26（第七轮：本周同赛道热点 —— 证据、归因、账目）

> 前六轮（09-29 / 10-02 / 10-03 / 10-11 / 10-17 / 10-25）见各自日期文档。本轮口径是**热点扫描**：
> 只看 2026-10-19 ~ 10-26 这一周**在动**的项目（新上榜 + 本周有发版），判定三档：
> **吸收 / 排期 / 不做**。本轮**不改代码** —— 先把方向拍下来，动手另起一笔。
>
> **口径声明（与前几轮一致）**：
> - 竞品侧取 README 与 Releases 原文（GitHub API，2026-10-26 拉取）。下界：
>   README 没写 ≠ 没做；写了 ≠ 做得好。
> - 本项目侧是**读源码后的自评**，每个判定都给文件位置。
> - star 取于 2026-10-26，落笔即过时。

---

## 一、本周盘点（10-19 ~ 10-26）

| 项目 | 本周热度事实 | 一句话定位 | 与我们的关系 |
| --- | --- | --- | --- |
| [paperclip](https://github.com/paperclipai/paperclip) | 107.4k★，**v2026.1023.0（10-24，200 commits）** | 管一支 AI 员工团队：私密工作、自带模型网关、**每个 agent 一把持久加密身份**、成本变**精确台账**、GitHub 评审机器人发布 **Paperclip Review 检查（分支保护可要求）** | **同赛道，本周最响的信号**（见 §二） |
| [Tracely-ai](https://github.com/jwuthri-cloud/Tracely-ai) | 1.2k★，2026-10-11 建仓，本周仍在推 | "**Production failures become regression tests**"：trace → 失败聚类 → 冻成 hermetic 回归用例 → 挡 PR → 告警 | **同源**：它拿 trace 当证据，我们拿凭据当证据 |
| [git-ai](https://github.com/feder-cr/git-ai) | 988★，本周 v0.2.0 → v0.4.0 **四发** | "Git designed for AI agents"：CAS 落地、**每处改动带 agent 名**、`verify.command` 必须在**将要落地的树**上通过 | 邻接：我们刚够到分发层（zone 过滤的本地分支） |
| [planning-with-files](https://github.com/OthmanAdi/planning-with-files) | 27.6k★，本周 v3.25.0/.1/.2 **三发** | 三份计划文件落盘 + 每轮 hook 注入，"计划熬过 `/clear`、崩溃与压缩" | 邻接：`OX-PLAN.md` 昨天刚落地，正好同一个念头 |
| [pullboard](https://github.com/pullboard-dev/pullboard) | 276★，本周 v0.9.1 / v0.9.2 | vision → specification → **第二个 agent 按 spec 查**，board 记"过了 / 没过 / 为什么" | **同源**：它查的东西我们没查 |
| [Tellurion](https://github.com/steventsvik/Tellurion) | 130★，本周四发，Trendshift Zig 周榜 #4 | Ghostty fork：多 agent 实时看板 + review inbox + 手机上答话 | 邻接：操作面已覆盖 |
| [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | 13.6k★，nightly 日更（v0.14.7-nightly 10-25） | 上轮已深读；本周 release 全是运营打磨 | 同赛道，**无吸收项** |
| [ruflo](https://github.com/ruvnet/ruflo) | 79.3k★，v3.63.0（10-25）"Managed Agents: bounded workflows, **gated controls**" | 多模型 swarm | 同赛道；"bounded / gated"我们已有（zone + 预算 + 门禁） |
| [omnigent](https://github.com/omnigent-ai/omnigent) | 11.0k★，v0.19.0/.1（10-20/21） | meta-harness（编排 Claude Code / Codex / Cursor …） | 同赛道，架构面不冲突 |
| [cc-haha](https://github.com/NanmiCoder/cc-haha) | 15.2k★，v0.7.5（10-20） | 本地优先桌面工作台（worktree / diff / 技能市场 / computer use） | 同赛道；桌面形态已收敛，差值仍在 worktree 路线 |
| jcode / DeepSeek-Reasonix / Codewhale | 21.2k / 36.0k / 41.1k★ | 执行器本体（Rust harness、编码 agent） | **不是编排层**，只当执行器供给侧看 |

（Orca / superset / cezar 本周无新发布可读，上轮结论继续有效。）

---

## 二、本周真正值得记的三条线

三条都不是我挑的措辞，是本周两个以上独立项目用不同办法说同一件事；**领头的那个（paperclip，
107k★）这周的发布说明几乎是逐条命中**：

1. **证据要能挡下一步**。paperclip 把评审结论发成 **Paperclip Review 检查**，并明说"分支保护可以
   要求它"；Tracely 的终点是"PR 被挡住"；git-ai 的终点是"模型给的冲突解法只有在 `verify.command`
   于**将要落地的那棵树**上通过才自己落地"；ruflo 3.63.0 的标题就叫 `gated controls`。
   —— 共识已经不是"给我看 dashboard"，而是"这条证据能不能被别人的流水线**要求**"。
2. **归因跟着改动走**。git-ai 横幅原话（`alt` 文本）："every change carrying the name of the agent
   that made it"；paperclip 更硬一层：**每个 agent 一把持久加密身份**，并把 agent 权限与 run 的
   负责用户求交（复用 agent 不会带出别人的权限）。—— 谁改的，要挂在改动/身份上，不是挂在别人的日志里。
3. **账目要精确，看不见就按已到上限**。paperclip 把 Costs 做成"精确台账（含月度订阅费）"，并给
   预算策略加了一条默认 **`block`**：用量**没有可靠计价**时，视为已达上限，直到通过有审计的成本调整
   流程解决；想继续跑得显式改成 `allow`。—— 这是"不采信自述"推到成本面：不知道 ≠ 免费。

**对照到我们**：第 1 条我们**底子最硬**（硬门禁 + 凭据 + 五档复核），但凭据**只活一次、谁也不认**；
第 2 条我们有归因（`tasks[].agentId` + 审计逐批 op），但它**没走出到 commit**；第 3 条我们只有
**一句说破**（`budgetBlindNote`：闸看不见未上报的用量），**没有 fail-closed 的那一档**。

---

## 三、逐项判定

| 它的长处（本周事实） | 我方现状（读源码） | 判定 |
| --- | --- | --- |
| paperclip：评审结论发成 commit 检查，分支保护可**要求**它 | 凭据是给人看的 JSON：桌面凭据卡、`receipt:verify` 五档退出码。但**没有任何东西能被外部流水线要求** —— 一次 run 过没过门禁，GitHub 那边看不见 | **吸收（第一优先）** |
| paperclip：每个 agent 一把持久加密身份 | 归因是 `tasks[].agentId`（字符串）+ 审计 op；导出 commit 里一个字都没有 | **吸收（小，先做）**：先挂索引，签名身份记未来 |
| paperclip：未定价用量默认 `block`（看不见就按已到上限） | `shared/usage-meter.ts` 的 `budgetBlindNote` 只**说破**："已有 N 次调用端点未上报用量 ⇒ `maxTokensPerRun` 这道闸看不见它们"；`UsageMeter.record` 遇到没上报就记一笔，**不阻断**。于是：换一个不回 usage 的端点，预算形同虚设 | **吸收（小）**：加 fail-closed 档 |
| Tracely：「**复现的 run 就是测试**」，失败 run 冻成可回放用例，$0 复跑 | 凭据里 `checks[].command/args` 是**真命令**，`receipt:verify --replay` 能本地重跑并五档裁决（`headless/receipt-verify-main.ts` 与 `electron/ipc/receipt.ts` 共用一套判据）。但 `electron/ipc/orchestration.ts:159` 每次 run **覆盖**项目记录的 `receiptJson` —— **只留最新一份**；headless 的 `receipt` 事件由宿主自己存文件（只有 demo 存了 `receipt.json`）；**没有"一叠凭据"的目录约定，也没有聚合门** | **排期（中）** |
| git-ai：`verify` 跑在**将要落地的树**上，通过才落地 | 门禁跑在**共享工作区**，导出是交付后的另一步（zone 过滤 + 永不 push，`electron/engine/git-export.ts`）。两者之间没有"树指纹"绑定 | **记边界，暂不做**（绑树＝导出前置验证，与"一次性派发、交付即终"的模型打架；先把指针绑上，见吸收 2） |
| pullboard：第二个 agent 按**已批准的 spec** 逐条查 | 硬门禁只回答"能不能 build/typecheck/test 过"；`shared/zone-coverage.ts` 只回答"PRD 声明的测试文件被没被改到"。**没有一层回答"做的是不是 PRD 要的那件事"** | **排期（中）**，且**不进硬门禁** |
| pullboard：每 agent 一条 lane（worktree 隔离） | zone 互斥 + 冲突仲裁（路线差异，10-18 文档已定） | **不做**（老结论不变） |
| planning-with-files：计划文件 + 每轮 hook + 抗 `/clear` | `OX-PLAN.md` 进规划与执行两处上下文（`shared/plan-memo.ts`，10-25 落地），"每轮注入"**已有等价物**；差的是"任务状态回写进计划文件" | **不做回写**：事实只从审计来（`plan-history` / `plan-facts` 都是纯判定层）。让文件写状态＝再造一个不可核的源 |
| Tellurion：live 看板 / review inbox / 按轮撤销 / 手机答话 | serve 状态页 + SSE + 应用内预览窗口 + 按 (turn, path) 回滚 + 三类通知 + 「该你了」注意力条 | **已覆盖 / 不做**（手机端 10-17 已有结论） |
| ruflo："bounded workflows" | `maxTokensPerRun` 软上限 + zone 互斥 + 门禁 | 已覆盖（但预算的盲区见上） |

---

## 四、建议吸收（按投入产出排；动手另起一笔）

### 吸收 1 · 归因随笔据走进 commit（小，建议先做）—— **已于 2026-10-26 落地**

现在导出分支的 commit message 就是 `OxCommander delivery <stamp>`（`electron/platform.ts:619`），
`git-export.ts` 里 `Ox-` 零命中 —— 一次交付落地之后，commit 不知道自己是哪次 run、哪份凭据、哪些 zone。

**形态**：

```
OxCommander delivery 20261026-123456

Ox-Run: <runId>
Ox-Receipt: <fingerprint>
Ox-Zones: src/engine, shared
```

导出结果回填凭据指纹，写进审计事件 —— 三样东西互指：凭据 ← 指纹 → commit → zone。
**判据**：`git log --format='%(trailers)'` 能原样读出；一条用例钉"导出结果里的指纹与凭据一致"；
一条钉"没有凭据时不编造 trailer"。**代价小**。**边界**：trailer 是文本，不签名，改得动 —— 它是
**索引**不是**认证**（paperclip 那种加密身份是另一个量级，记在「以后」）。

> **落地时改掉的一格（2026-10-26，写在这里防止下一个读文档的人去找不存在的字段）**：
> `Ox-Run` **没做** —— 这个仓到现在没有"一次 run"这个一等公民标识：`scheduler.ts` 里的 `runId`
> 是**每次派发**自己的 id（`${task.id}-${Date.now()}-…`），拿它当 run id 会指向一个任务而不是一次交付。
> 实际落地的是 `Ox-Receipt`（凭据指纹）+ `Ox-Zones`；要 `Ox-Run` 得先有 run 级标识，单独立项。
> 另：审计事件里**没有**再抄一份指纹 —— 日志仍只记分支/commit/文件数，绑定只在 commit 自己身上
> （抄两处就有两处会漂）。

### 吸收 2 · 预算 fail-closed 档（小）—— **已于 2026-10-26 落地**

现在的诚实边界是"说破不阻断"。paperclip 这周给出的正是另一半：**看不见 ⇒ 按已到上限**。

**形态**：预算配置加一档 `onUnpricedUsage: "block" | "allow"`；`block` 时，本次 run 一旦出现
未上报用量的调用（`UsageMeter` 已有 `unmeasuredCalls`），**下一批派发起拒绝**并给出凭据里的
`headroom: "unmeasurable"` 事实 —— 不是"猜个数"，是"拒绝在看不见的情况下继续花"。
**判据**：一条用例钉"block 档下第 N+1 批不派发，凭据带 unmeasurable"；一条钉"allow 档行为与今天
逐字相同"（不回退既有用户）。**代价小**。**边界**：默认档要拍 —— 默认 `block` 会让"端点不回 usage"
的用户第一次撞墙，这条得写进 CHANGELOG。

> **落地时改掉的两格（2026-10-26）**：
> 1. **拒绝点落在 meter（调用级）而不是批次级**：闸门就架在 `assertWithinBudget`（每次 LLM 调用
>    发出之前），所以"下一批派不出去"是结果而不是新机制 —— 少一处与批次循环耦合的判据。
>    代价是**在途那一批会随下一跳失败**（不是等批次边界干净收尾），这一点写进了 CHANGELOG。
> 2. **没有新增凭据字段 `headroom`**：凭据的 `usage` 段本来就带 `calls` / `measuredCalls`
>    （未上报 = 两者之差），再加一个派生字段等于同一事实两个来源。**缺省档也拍了**：配了预算时
>    默认 `block`（没配预算时这一档无意义，返回 undefined），并把"这是缺省还是你配的"写进启动横幅。

### 吸收 3 · 凭据变成能被要求的东西（中，最值钱）—— **已于 2026-10-26 落地**

这是本周唯一"别人已经做了、而我们**命题上最该做**"的一格：我们的卖点是"交付一份过了门禁的凭据"，
可这份结论只有**看得见我们界面的人**才认。

**形态**：`electron/engine/git-remote.ts` 已有 push / 开 PR / 轮询 CI 的全套纪律（`parseChecks`
**解析不出来一律 unknown，绝不猜成绿**）。在同一层加一步可选的 **commit status**：把凭据结论发成
`oxcommander/delivery` 检查（success = `outcome: delivered` 且指纹可核；否则 failure，`description`
里带指纹前 12 位与失败档位）。于是分支保护可以**要求**它 —— 这才是"证据挡下一步"。
**判据**：一条用例钉"blocked 的凭据只能发 failure，不许成功"；一条钉"没有凭据时不发检查"（不编造绿）；
一条钉"网络失败只报 unknown/失败，不重试成绿"。**代价中**（走已有的 GitHub 客户端 + 一串新测试 +
变异目标）。**边界**：需要 remote 凭据与显式开关（默认关，与 push/PR 同一条纪律）。

> **落地时拍板的三格（2026-10-26）**：
> 1. **三档不是两档**：`error`（没指纹 / 指纹不符 —— 我**判不了**）与 `failure`（判了，没过）分开。
>    两者在分支保护上都不绿，但排查路径完全不同：一个去修交付，一个去查凭据有没有被改过。
> 2. **判据与发送分开**：`deliveryStatusFor` 是纯函数（逐位点可审），`publishDeliveryStatus` 只送，
>    `orchestrator.maybePublishStatus` 只管"递给谁"。三层里只有第一层含判断。
> 3. **顺序**：只在**推送真的成功**之后发（挂不上远端 commit 就没意义），且没凭据就不发。
>    落成 `git-status.ts` + `settings.deliveryStatus`（TARGETS 120 / 基线 3233）。
>    **headless 一侧本轮没接** —— 它的分发本来只到本地导出，没有 push 通道，要加得先给 headless
>    加远端分发，单独立项。

---

## 五、排期（本轮不动）

1. ~~**凭据库 + 回放门**（中）~~ —— **已于 2026-10-26 落地**：凭据按
   `<时间戳>-<指纹前 8 位>.json` 累积落 `<workspace>/.ox/receipts/`，新入口
   `npm run receipt:regress --dir=.ox/receipts [--replay] [--limit=N]`。
   落地时改掉/拍板的三格：
   - **文件名里不放 `runId`**（这一仓没有 run 级标识，见吸收 1 的落地注）：改成"落盘时刻 +
     凭据自己的指纹前 8 位"—— 两样都是可核的；没指纹的凭据干脆**进不了库**。
   - **整批裁决取最严重那一档**（`tampered > contradicted > unsigned > not-replayed > verified`）：
     定义必须唯一，否则同一叠凭据两次跑能给两个结论。
   - **退出码表收成一处**（`shared/receipt-lib.verdictExitCode`），单份工具改读它 ——
     "CI 只学一套"得靠一处定义保证，而不是靠两处恰好一致。
   判据**没有**重写：一律调 `auditReceipt` / `compareChecks`。
   **诚实边界不变**：回放的是**门禁命令**，不是整次 agent 运行 —— Tracely 能录 fixture 复现
   LLM 调用，我们只复现"同一批命令在同一环境下重新观察"，别吹成 trace 级。
2. **PRD 一致性观察**（中，advisory）：门禁回答"能不能跑"，不回答"是不是要的那个"。若做，结论进
   凭据一个 `advisory` 段，**永不参与 delivered/blocked 判定**（模型判断不可复现，不能当闸门）。

---

## 六、明确不做（写下来防止下次重查）

1. **worktree 隔离路线**：10-18 文档的取舍不变（zone 互斥换的是"能跨模块协同改接口"）。
2. **计划文件状态回写**：与"事实只从审计来"直接冲突。
3. **自建 trace 观测栈**（OTLP / ClickHouse 那一套）：Tracely 的护城河在"录制 → 回放 → 挡 PR"，
   不在存储；我们只借它的最后一步。
4. **手机端 / live 多窗口看板**：serve + 通知 + 应用内预览已覆盖主场景。
5. **agent 加密身份**（paperclip 那档）：现在做等于在没有签名体系的地基上加装饰；先有 trailer 索引，
   等"凭据要不要签名"这个问题真被提出再议。

---

## 七、口径与来源

- paperclip：v2026.1023.0 release notes（GitHub API，2026-10-26）—— "persistent cryptographic identity"、
  "exact ledger that also shows monthly subscription fees"、"unpriced usage ... defaults to `block`"、
  "publish a **Paperclip Review** check ... that branch protection can require" 均为原文。
- Tracely-ai：README（同上）—— "Production failures become regression tests"、"The recorded run _is_
  the test"、"$0 — recorded tool/LLM fixtures" 为原文引语。
- git-ai：README（同上）—— 横幅 `alt` 文本与 `verify.command` 那段为原文；版本号取 Releases。
- planning-with-files：README（同上）—— "survives `/clear`"、blind A/B 3/3、29/30 为原文数字。
- pullboard：README（同上）—— vision / specification / inspection 三段式与"第二个 agent 复核"为原文。
- 本项目现状：`shared/delivery-receipt.ts`、`headless/receipt-verify-main.ts`、`electron/ipc/receipt.ts`、
  `electron/ipc/orchestration.ts:159`、`electron/platform.ts:619`、`electron/engine/git-export.ts`、
  `electron/engine/git-remote.ts`、`shared/usage-meter.ts`、`shared/plan-memo.ts`、`shared/zone-coverage.ts`。
