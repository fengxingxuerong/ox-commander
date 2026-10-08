# 2026-10-05 全方面体检报告

> 前置：`docs/2026-10-04-optimization-survey.md` 记的是**逐项修复**的过程。
> 这份记的是**一次横向体检的结论**：不看登记表，把项目当成陌生代码通读一遍，
> 回答「还有什么需要做的」。
>
> 原则不变：**每条结论都要能落到 file:line 或可重跑的实测**，说不出证据的
> 不写进来；被证伪的假设也写。

## 0. 一句话结论

工程质量的基线很高（测试/生产行数比 1.33、变异门禁 1265/1265、运行时只有 3 个
依赖），**没有发现新的高危缺陷**。剩下的是三件**维护面**的事，按性价比排序：

| 优先级 | 事项 | 性质 | 状态 |
|---|---|---|---|
| P1 | 5 个入口胶水文件 0% 覆盖 | 测试盲区 | **已闭合**：四个入口全部有入口级测试（第六、七轮） |
| P2 | `cli-agent.ts` 不查 CommandPolicy | 安全论证的**脆弱耦合** | **建议已被实测推翻并撤销**（§3.3）；真风险改由 D10 占位符白名单闭合 |
| P3 | `coverage/` 未进 `.gitignore` | 工程卫生 | **已修** |
| — | preload ↔ IPC 通道一致性 | 缺守卫 | **已加门禁**（第五轮） |

---

## 1. 体量与结构

```
生产源文件 85 个 / 19,404 行（其中非注释 13,446 行）
测试文件   60 个 / 25,814 行
测试/生产行数比 1.33
目录分布   electron/ 44 · shared/ 18 · src/ 13 · headless/ 8
```

最大的生产文件（都带 25–45% 的注释密度，说明是有意识维护的）：

| 行数 | 文件 | 注释 |
|---|---|---|
| 837 | `electron/engine/orchestrator.ts` | 28% |
| 766 | `shared/http-clients.ts` | 36% |
| 683 | `electron/engine/scheduler.ts` | 34% |
| 560 | `electron/agents/sensenova-api.ts` | 29% |
| 555 | `src/pages/SettingsPage.tsx` | **8%** |
| 549 | `headless/protocol.ts` | 35% |

**观察**：`SettingsPage.tsx` 是唯一注释密度低于 10% 的大文件（8%），而它恰好
也是覆盖率最低的一档（74.4%）。UI 里最容易出"忘了更新分支"的地方。

## 2. 覆盖率：整体 93.38%，但有 5 个文件是 0%

分档（取 stmts/branch/functions 的**最小值**，避免"某一项拉高平均"）：

```
ZERO  (0%)        5 个
LOW   (<50%)      0 个
MID   (50-80%)    8 个
OK    (>=80%)     68 个
总体  lines 4760/5097 = 93.38%
```

### P1：5 个文件 0% 覆盖，全是入口胶水

| 文件 | stmts | branch | func |
|---|---|---|---|
| `electron/preload.ts` | 0% | 100% | **0%** |
| `headless/headless-main.ts` | 0% | 0% | 0% |
| `headless/mcp-main.ts` | 0% | 0% | 0% |
| `headless/receipt-verify-main.ts` | 0% | 0% | 0% |
| `headless/serve-main.ts` | 0% | 0% | 0% |

**为什么这值得管**：这 5 个文件是**进程边界**——参数解析、`argv` → 配置的映射、
错误 → 退出码的转换。第四轮已经亲眼见过这类代码的行为差异：我用 `--serve=`
（文档写的是 `--serve-url=`）启动 MCP，它**静默回落**到默认端口，所有工具调用
返回「serve 不可达」，全程 exit 0、不报错。

这类"错了但不报错"的行为，只能靠**入口级测试**发现，而它们目前一条都没有。
注意 `preload.ts` 的 branch 覆盖是 100% 而 func 是 0% —— 典型的
"结构被 import 到了，函数从没被调用过"。

**成本估算**：4 个 headless 入口各 10–20 行可测逻辑（argv 解析 / 退出码），
合计约半天的测试量。

`preload.ts` 的优先级见 §3.3b：实测 30/30 通道精确对应、**无漂移**，
所以它不需要 31 个转发函数各写一条测试，需要的是一条
"preload 引用的通道 ⊆ ipcMain.handle 注册的通道"的**静态断言** ——
那才是能防住真正会咬人的变化（新增 handler 却忘了暴露给渲染端）。

### MID 档（8 个）里值得看的两个

| 文件 | 最小值 | 说明 |
|---|---|---|
| `electron/ipc/orchestration.ts` | 66.7% | **IPC 控制面**：approval-decide / cancel / pause / resume / escalation-decide 都在这里 |
| `src/pages/BoardPage.tsx` | 73.4% | 主看板 |

`orchestration.ts` 是引擎与渲染进程之间唯一的命令通道（含审批答复），
66.7% 是整个项目里**信任面最重**的文件的最低覆盖率。这不是缺陷，是下一个
该投入测试的地方。

## 3. 信任面审计

### 3.1 IPC：30 个 handle 通道，全部经 preload 收敛

`electron/ipc/{projects,agents,orchestration}.ts` 共 30 个通道，
preload 暴露 31 个 API 名。通道命名规范（`域:动作`）一致，无裸通道。

### 3.2 进程创建面：15 个文件、26 处 `spawn`

集中在 4 个非测试文件：`cli-agent.ts`（2）、`verifier.ts`（2）、
`spawn-plan.ts`（2，定义处）、`manifest-loader.ts` / `action-gate.ts` /
`kill-tree.ts` / `serve-main.ts`（各 1）。**面很窄**，这是好事。

### 3.3 P2：`cli-agent.ts` 是唯一不查 CommandPolicy 的 spawn 调用点 ——
**⚠️ 这条建议在实施时被实测推翻，已撤销**（2026-10-05 第五轮）

`electron/sandbox/spawn-plan.ts` 的文件头把安全论证写得很明确：

> The fix is safe **only** because `CommandPolicy` has already rejected shell
> metacharacters… So: check first, wrap second. Never call this on unchecked input.

实测各调用点：

| 调用点 | 是否先 `policy.check` |
|---|---|
| `electron/engine/verifier.ts:66` | ✅ `:154` 查了 |
| `electron/engine/verifier.ts:321` | ✅ `:274` 查了 |
| `electron/agents/cli-agent.ts:115`（probe） | ❌ 没查 |
| `electron/agents/cli-agent.ts:182`（dispatch） | ❌ 没查 |

**`quoteForCmd` 本身挡不住注入**——在真 cmd.exe 上实测：

```
输入 "say\"hi&whoami"  →  cmd 实际执行了 whoami
输入 "with space"      →  cmd 看到的是 "with space"（引号进了参数值）
```

即 `\、` 转义在 cmd.exe 语义下不成立。表面看，安全性完全依赖上游 policy。

**但我实施这条建议时才发现：它会让所有 CLI 智能体不可用。**

`CommandPolicy` 的白名单是 `DEFAULT_ALLOWED_COMMANDS`
（`command-policy.ts:7`）= **构建/测试工具链**：node、npm、npx、pnpm、yarn、
tsc、vitest、jest、mocha、eslint、prettier、make、cmake、cargo、go、dotnet、
mvn、gradle、python、pip、ruff、mypy、git。

而 CLI 智能体的 command 是 codex / claude / aider / goose / qwen / gemini。
实测 `agents.d/` 下**带 command 的清单 11/11 全部被默认策略拒绝**：

```
codex.example.json   codex  → 拒绝: 命令不在白名单内：codex
claude-code.example.json claude → 拒绝: 命令不在白名单内：claude
aider.example.json   aider  → 拒绝: 命令不在白名单内：aider
...（11/11）
```

加上那个检查 = **所有 CLI 智能体全部不可用**。已撤销。

**正确的结论分层**（这才是这一节的收获）：

| 命令面 | 谁执行 | 该用哪套约束 |
|---|---|---|
| **验证命令**（构建/测试） | `verifier.ts`，跑用户项目里的命令 | `CommandPolicy`：白名单 + 元字符 + `-e` 内联求值 |
| **agent argv** | `cli-agent.ts`，跑**操作员显式注册的** manifest 里的 CLI | 靠**取值来源**：见下 |

agent argv 的安全来自三个前提，**全部是"生成物"而非"自由文本"**：

- `{{promptPath}}` — `writePrompt` 生成
- `{{zone}}` — `shared/schema.ts:81` 白名单 `^[A-Za-z0-9_][A-Za-z0-9_./-]*$`（不含元字符）
- `{{projectRoot}}` — `workspaceRoot(projectId)` = `userData/workspaces/<id>`，
  `projectId` 由 store 铸造
- `argsTemplate` 本身来自 manifest，而 manifest 是**操作员在本机显式注册**的

**真正的未来风险**：给 `argsTemplate` 加一个绑到 LLM 自由文本的占位符
（`{{taskTitle}}` 是最明显的候选）。防它的正确位置是
`manifest-loader.ts`（占位符白名单），**不是**把验证阶段的策略套到这里。

**已落地的守卫**（`src/cli-agent.test.ts` 的 D9 组，3 条）：
- `CommandPolicy` 白名单服务构建工具链（npm/vitest 通过，codex 不通过）
- `agents.d/` 每个带 command 的清单都**不该**通过 CommandPolicy
- `{{zone}}` 经 `parseDecompose` 拒绝元字符

反向注入 3/3：把 codex 改成 npm、或把 `VALID_ZONE` 放宽成 `/^.*$/` → 本组转红。

### 3.3b preload ↔ IPC 通道：无漂移，已加门禁

`preload.ts` 0% 函数覆盖，所以先确认它本身没坏：

```
preload invoke 通道: 30
ipcMain.handle 通道: 30
preload 有、handle 没有（会永远 reject）: 无
handle 有、preload 没暴露（渲染端用不到）: 无
重复 invoke 同一通道: 无
```

**30/30 精确对应，无孤儿无重复** —— 转发层没有漂移。
安全开关：`contextIsolation: true`、`nodeIntegration: false`（都正确）；
`sandbox` / `webSecurity` 未显式设置，取默认（`sandbox` 默认 true，
`webSecurity` 默认 true，**不是问题**，但显式写出来更清楚）。

补测试的优先级因此可以下调：它没有漂移，风险是"将来漂移没人发现"，
不是"现在就是错的"。

**已落地**（`scripts/check-ipc-channels.mjs`，接进 `verify` 第 10 段）：
四个判定 —— ① preload 引用未注册通道 ② 主进程注册但未暴露
③ 同一通道 invoke 多次 ④ 同一通道 handle 多次，外加"读不到任何一侧必须 FAIL"
（解析失配当通过 = 一道永远绿的摆设）。

反向注入 **6/6**：五种失败模式逐一注入，逐一证明会红。

### 3.4 网络出口面：5 个非测试文件

`shared/providers.ts`（11 处）、`electron/agents/http-bridge.ts`（5）、
`headless/mcp-main.ts`（4）、`electron/main.ts` / `headless/serve-main.ts`（各 1）。
面窄。`serve.ts` 明确写了"不做鉴权，这是本机/CI 调试面"——这是**有意识的
取舍并写了理由**，不是遗漏。

### 3.5 密钥面

`process.env.*` 里带 KEY/TOKEN/SECRET 的读取点集中在 `shared/providers.ts` 与
`electron/agents/scoped-env.ts`。`cli-agent.ts` 用 `scopedEnv()` 做**最小化环境**
（子进程只拿到 `allowProviders` 明确授权的密钥），且 `droppedSecretNames` 把
裁掉了哪些变量名记进日志（只记名不记值）——这是**做对了**的。

## 4. 依赖 / 配置 / CI

| 项 | 结果 |
|---|---|
| 运行时依赖 | **3 个**（react / react-dom / zustand），打包面很干净 |
| devDependencies | 18 个 |
| 声明 vs 实装版本漂移 | **0 个**（逐个比对 package-lock） |
| verify 链 | **23 段**：静态检查 7 · 测试 1 · 变异 2 · 构建 2 · 冒烟 9 |
| CI | `verify.yml`（Windows + Linux 双矩阵）· `release.yml` |
| CI 是否跑全量变异 | 是，`mutation-full` job，Linux，timeout 60 分 |
| docs | 15 篇；README 344 行 |

**CI 值得表扬的一点**：`verify.yml:32-36` 有一段注释记录了真实事故——
浅克隆里没有父提交，`mutation:touched` 的 `HEAD~1..HEAD` 会直接崩，
2026-09-25 两个 job 常红。修复是 `fetch-depth: 0`。**把踩过的坑写进配置注释**
比只写"为什么要 full history"有用得多。

`verify.yml:57-63` 还记了 timeout 从 35 分提到 60 分的理由：被 timeout 掐掉
等于**丢掉整份存活清单**（那个 job 的唯一产出），那时"CI 红了"分不清是代码
问题还是太慢。这个论证可以直接复用。

## 5. P3：`coverage/` 未进 `.gitignore`（**已修**）

`.gitignore` 忽略了 `dist*` / `release/` / `logs/` / `.env`，但**没有** `coverage/`。
实测 `git status --untracked-files=all` 会把整个 `coverage/` 列为待添加，
而 `npm run test:coverage` 每次都重写它。

**已修**：`.gitignore` 增加 `coverage/`（带理由注释）。
修完复核：`git add -A` 不再看到 coverage 下任何文件。

> 顺带一提：PowerShell 里 `Get-Content .gitignore` 把中文显示成乱码
> （`杩愯` 之类）。用 `read` 工具读原文件是正常的 —— **是控制台编码问题，
> 不是文件坏了**。已核实。

## 6. 一个被证伪的担忧

体检时我一度怀疑 `headless/serve.ts` 的状态页有存储型 XSS
（`requestId` 插进 `onclick="settle('${p.requestId}', true)"`，而 `esc()`
只转义 `& < >`，不转义引号）。**第四轮已完整证伪**：`requestId` 由
`serve.ts:297` 服务端自造，引擎无法指定；其余 agent 可控字段都过了 `esc()`
且落在文本上下文。结论是**潜在**风险（该属性 sink 没有可用的引号转义），
详见调查文档 §17.3。

**本轮新增的观察**：`esc()` 的这个局限在 `mcp-main.ts` 那类"注入 HTTP 面"的
文件里**没有对应物**——MCP 输出全是 JSON-RPC 文本，不拼 HTML。唯一拼 HTML 的
地方就是 serve 状态页。所以这个潜在风险是**单点**的，边界清楚。

## 7. 我建议接下来做的（按性价比）

### 已完成（第五轮，2026-10-05）

1. **✅ 加静态断言：preload ↔ IPC 通道两侧一致**（`scripts/check-ipc-channels.mjs`，
   接进 `verify`）。四种失败判定 + 判据失配必须 FAIL。反向注入 6/6。

2. **✅ 推翻并撤销了自己上一节 P2 的建议**（`cli-agent` + CommandPolicy）。
   实测证据：11/11 个 agent 清单被默认白名单拒绝，加检查 = 全部不可用。
   改为落地 3 条**前提守卫**测试，反向注入 3/3。

3. **✅ `coverage/` 进 `.gitignore`**（见 §5）。

### 已完成（第六轮，2026-10-05）

4. **✅ D10：`argsTemplate` 占位符白名单**（`manifest-schema.ts`）。
   P2 撤销后浮上来的真风险，已落地。白名单 5 个生成物占位符，覆盖
   `argsTemplate` / `probeArgs` / `envTemplate` 三条 argv。
   `manifest-schema.ts` 变异 **72/72**。反向注入 3/3。

5. **✅ D11：`serve-main` 非法 `--port` 静默回落 → 已修**。
   实测证据：修复前 `--port=99999` 打印
   `OxCommander serve: http://127.0.0.1:58320/` 且 exit 0。
   新增 `src/headless-entries.test.ts`（12 条）闭合 P1 的入口级测试，
   顺带覆盖 `receipt-verify-main` 的退出码契约。反向注入 3/3。

### 已完成（第七轮，2026-10-05）

6. **✅ D12：`mcp-main` 的 `--serve-url` 静默回落**（与 D11 同构）。
   **第四轮我自己踩过的那个坑**（写错 flag → 连默认端口 → 以为 MCP 坏了）。
   最坏的一处是它会照常打印 `serve-url=http://127.0.0.1:8787` ——
   那行 stderr 看起来像"我听懂了你的参数"。反向注入 3/3。

7. **✅ `orchestration.ts` 覆盖率补到 100%**
   （lines 91.35→100 · functions 66.66→100 · statements 88.29→100），
   变异 **8/8**。

8. **✅ 三个文件接入变异门禁**，暴露并修掉 **9 处真实断言缺口**：
   `mcp-main.ts` **10/10** · `serve-main.ts` **17/17** · `orchestration.ts` **8/8**。
   （此前它们都不在 `TARGETS` 里 —— 按该表的注释"漏挂=永远无人审计"，
   本轮修复当时没有被任何变异验证覆盖。）

### 已完成（第八轮，2026-10-05）

11. **✅ `TARGETS` 漏挂从注释变成门禁**（`scripts/check-mutation-targets.mjs`）。
    上一轮我自己就漏挂了三个文件 —— 而门禁照样报 PASS，**那个 PASS 对漏挂的
    文件没有任何含义**。这是最坏的一类门禁失效：它不报警，它撒谎。
    反向注入 4/4；**当场回本**（查出 `receipt-verify-main.ts` 未登记）。

12. **✅ `receipt-verify-main.ts` 接入变异** → 暴露 3 处存活，补完 **8/8**。
    五档裁决 → 退出码的映射表此前**一处断言都没有**，而那是 CI 的判定。
    现在 0/2/3/4/5 五档全部真进程端到端验证，外加"五档互不重叠"的机器检查。

13. **✅ SettingsPage 注释密度 2.3% → 5.4%**（只在"读代码第一反应一定猜错"处补：
    `clearKey` 的"删除 = 空值再存一次"、`handleSaveKeys` 的"过滤空串是刻意的"）。

14. **✅ 全量逐位点审计**：64 目标 / 1312 位点，**全部 100%，EXIT 0**。

### 下一批（第九轮起）

审计清单已空，已转入**换维度**而非继续加门禁。

- **✅ 横向比对（第九轮）**：`electron/engine` 与 `headless/serve.ts` 的编排语义。
  pause 两边一致且措辞准确；**cancel 是真差异** —— 桌面有、serve 没有，
  导致等审批的 run 永久卡死。已修（见 CHANGELOG），反向注入 6/6，
  `serve.ts` 变异 47→**55/55**。
- **✅ 横向比对的第二跳**：`headless/mcp.ts` 与 `serve.ts`。
  serve 补了 `/cancel` 之后，**MCP 客户端仍然中止不了**（`ox_control` 枚举只有
  pause/resume）—— 下游缺口也得堵，否则等于"用 MCP 驱动的人永远解不开那个死锁"。
  同时 `ox_status` 只认 `paused`，中止在 MCP 里完全不可见。均已修，
  `mcp.ts` 变异 71→**77/77**。

- **✅ 运行时（第十轮）**：真起一次交付（假大脑 + 假桥，`serve-main` 跑完整流程），
  同时从 SSE / `/state` / 状态页 / MCP 四个面采样。抓到**三处自相矛盾**：
  凭据 `unverifiedReason`、`VerificationExhaustedError.message`、
  `buildEscalationSummary` —— 在"死因是 no-agent、验证必然全绿"的 run 里，
  三处都说"验证未通过"，而同一份凭据的 `checks[0].ok` 就是 `true`。
  全部按 `report.passed` 分成两种说法（class 名与退出码不动）。
  反向注入 5/5；`orchestrator.ts` **51/51**、`shared/prompts.ts` 1→**2/2**。

- **✅ 运行时 · 凭据自洽性（第十一轮）**：采样面从"编排期"移到"凭据内部" ——
  `counts` 六个数 / `tasks[]` / `checks[]` / `rounds` 与 `headline` 那一句。
  写成 13 条可从一份凭据算出的不变量，起六种形状的**真 run** 核对。
  抓到：`headline` 的 blocked 分支只从任务账找原因、不看 `checksFailed`，
  于是"任务全做完、只有验证红着"（**最普通的一种红**）时输出
  `"未交付：2/2 个任务完成，仍有任务未完成"` —— 自相矛盾。
  而这条分支此前**一条断言都没有**（两个关键短语 grep 均零命中）。
  反向注入 5/5；`shared/delivery-receipt.ts` **43/43**。

- **✅ 运行时 · 重修轮的账（第十二轮）**：采样面移到"轮次相关的数字" ——
  造一个走满多轮的 agent，把 `attempts` / `rounds` / escalation 那句 / usage
  四处排在一起对。抓到：升级弹窗印出 **"重修 3 轮（上限 2）"** ——
  `attemptsSoFar` 是**派发总次数**（含首次），`maxRepairRounds` 是**重修轮数**
  （不含首次），**两个数量纲不同**，并排印必然差 1。而用户正是照这两个数
  判断"还剩没有机会再试一次"。同一轮还**查实** usage 那条线是好的
  （`measuredCalls ≤ calls` 由 `UsageMeter.record()` 结构保证，`calls - measuredCalls`
  不可能为负）—— 查过与没查过要分开记。
  反向注入 5/5；`shared/prompts.ts` **2/2**。

- **✅ 运行时 · 断点续跑（第十四轮）**：采样面移到"计数器跨 run 是否接得上"。
  **查完是好的 —— 但静态推理说的是缺陷**：`attempts.set()` 在派发前（:635）
  而 `save()` 只在批次跑完后（:691），取消路径（:373）不调 save ——
  三条单看全对，合起来推出"取消会丢失已烧的轮次"。真跑（假桥挂住 +
  `POST /cancel` + 直接读 journal 文件）推翻了它：`cancel()` 调
  `abortInFlight()` 让批次**以 cancelled 收场**，控制流照常走到 :691。
  实测恢复后 `attempts=2` == 真实派发 2 次。
  结论落到**断言**而非修复：那��� `save()` 是承重的，补两条钉住它
  （少记 / 多记两个方向）。反向注入 2/2。
  `src/orchestrator.test.ts` 75 测试。

- **✅ 运行时 · conflict 账 + 恢复的反面（第十五轮）**：
  - **恢复不重跑已完成任务**：查实是好的（journal 里 `allDone` 后第二趟真实派发 `[]`）。
  - **conflict 链**：两条结构化账都对（`counts.conflicts == conflicts[].length`，
    两种仲裁模式都检出 `unauthorized-write`），**但 headline 整句不提越权** ——
    `conflictPart` 只挂在 `delivered` 那条尾巴上。这是**安全事件被降级成普通失败**。
    补测试时又发现第三条出口（"已交付但未经验证"）同样漏了，是断言先发现的。
  - 反向注入 5/5；`shared/delivery-receipt.ts` **43/43**；
    `src/delivery-receipt.test.ts` **54 测试**。

### 门禁自身的缺口（本轮顺带发现）

`npm run verify` **没有"整体变慢 ⇒ 可能是环境问题"的判断**。
第十五轮有一次跑 **42 分 01 秒**（平时 ~17 分）并 EXIT 1，两条用例各耗时 2485 秒；
单独重跑是 **0.7s / 2.6s** 通过，两个文件都不在本轮改动里。
其中退出码那条实得 `[2,3,4,5,null]` 而非 `[0,2,3,4,5]` ——
**`null` = 子进程被信号杀掉**，是负载掐断，不是逻辑错。

处置顺序（本轮实际走的，详见 survey §22.26）：
**先看耗时 → 单独重跑隔离 → `git status` 确认失败文件不在改动里**。
第 3 步最易被跳过，人的默认假设是"我刚改的东西坏了"，
而这次恰恰是**没改的东西坏了**。

### 第十八轮 ✅ 状态标签并档（2026-10-05）

**一处真缺陷**：`serve` 状态页把 `done(passed=false)`（**跑完了**，只是门禁没过）
和 `error`（**崩了**，可能连凭据都没有）印成同一句 `未交付 / 出错`。

两个方向的错都在这里：跑完了却被说成"出错"，读者去找崩溃日志；
真崩时也只印这句 —— **崩了这件事被藏了起来**，最需要被看见的那种失败
恰恰被合并掉了。

判据取**凭据存不存在**（有凭据 = 引擎走完了正常收尾流程），修后两种结局
真实 run 都验过。`serveIndexHtml` 对这段标签此前**零断言**。
反向注入 4/4；`headless/serve.ts` 位点 55 -> **58**。

**两个被推翻的假设**（这轮一个真缺陷都没靠推理找出来）：

- "MCP `ox_status` 是 headline 的第二个渲染点" => **不成立**。
  它只报状态/事件数/审批数/退出码；`ox_receipt` 原样 `JSON.stringify` 透传。
- "crash 场景造得出来" => **第一次没造出来**。只让 bridge 报 failed 时，
  引擎会重修、重修成功后就正常收尾，根本进不了"崩"的分支。
  得给不存在的 `projectRoot`，让引擎在收尾前就炸。**观察脚本第五次自骗。**

### 第十九轮 ✅ 并档全表（2026-10-05）

把第十八轮的结论**从查一处升级为查全表**：既然"五档不许并档"是有成文原则
加测试的，那就该列出全仓所有做分类/定档的地方，逐个确认档位互不重叠。

**七个分类点，六个早就合规**（`auditReceipt`、`receipt-verify` 退出码、
`ERROR_CLASS_LABEL`、`remedyFor`、drainPool，以及刚修的 `STATUS_LABEL`）。
**这个"排除"结果本身是本轮的主要产出** —— 它把"并档"从系统性毛病
降级成了个别问题。一份清单能同时说"这里有问题"和"这里没问题"，才叫清单。

**命中的那处**：`http-bridge.ts:328` 的
`...(run.lastError ? { errorClass: "resource", retryable: true } : {})`。
但 `lastError` 记的是轮询途中的传输异常，而那里的处理是"下一拍重试"，
**它从头到尾就没打算代表这次 run 失败了**。真实 bridge 实测（断连一次、
之后正常完成）产出三句互相矛盾的话：

```
status     = "completed"      ← 后来正常完成了
errorClass = "resource"       ← 却说失败原因是资源问题
retryable  = true             ← 还说值得重试
```

引擎读到 completed 就认成功，同时把 retryable 记进重修账 ——
**一次普通网络抖动被算成了"可重试的失败"**。
判据改成 `run.lastError && run.status === "failed"`，与
`cli-agent.ts:374` **同源**：同一个仓库里两处写着一个意思、却用着不同判据，
这正是"查全表"才看得见的东西。

**又一条把缺陷钉住的既有测试**：`轮询抛错时结果标成 resource/可重试`
断言的正是那个矛盾形状，而它一直是绿的 ——
**因为它是照着实现写的，不是照着语义写的**。
判别法：标题念一遍，作为**事实描述**通顺、作为**应当如此**不通顺，就是照抄实现的信号。

反向注入 4/4；`electron/agents/http-bridge.ts` **38/38**；位点基线 **1344**。

**观察脚本第六次自骗**：第一版探针调的是 `adapter.result?.()`，
**这个方法不存在**（真名 `lastResult`，还是 async），于是 `res` 恒为 undefined，
四个场景全打 ✅ —— **一个从不失败的检查不是检查**。

### 第二十轮 ✅ 收窄器有没有接上电（2026-10-07）

**两处（同一缺陷的两个入口）**：`src/store.ts`（IPC 事件路径）与
`electron/board-derive.ts`（审计恢复路径）都把**未登记的 `errorClass`
直写进声明为 `FailureClass` 的字段**。

而 `BoardPage.tsx` 的注释写着"值已在边界经 `isFailureClass` 收窄" ——
**收窄器一直零调用者，那句注释描述的是一条从未存在的接线。**
实测经真实 `handleEvent` 喂进 `"quantum-flux"` 与 `42`，
两者都原样落进 `TaskView.errorClass`（数据源是 `JSON.parse(line) as AuditRecord` 的
审计 JSONL，旧版本写的、人手改过的都算数）。

**`check:unwired` 第一跑就指着答案**，处置建议原文是
"接到真实路径（推荐）—— 一个没被调用的防护等于没有防护"。

**顺带牵头的是同一件事**：那些报错是本轮把 `DerivedTask.errorClass` 收紧成
`FailureClass` 之后**当场**冒出来的（三条：两个没收窄的边界 + 一个 view 类型不兼容）。

⚠️ 口径纠偏：**`typecheck` 在本轮之前一直是绿的**。本轮开工前 `npm run verify` 在
`18ee758` 上 EXIT 0（`typecheck` 是它的第 2 段）。把它写成"HEAD 上本就红着"
会让后来人以为那段门禁失灵了 —— 与实测相反。真正值得记的是另一件事：
**收紧类型这一手本身就是探针**，一回找出三处此前全仓沒有任何测试会红的地方。

而 3 条报错里第二条（`DerivedTask | TaskView` 不兼容）一开始看着像历史遗留，
是它把第三个收窄点牵了出来 ——
**连续两条同源报错指向同一个概念时，第二条通常不是噪音，是第一条的另一半**。

反向注入 6/6；变异 `store.ts` **33/33**、`board-derive.ts` **39/39**、
新入表的 `shared/types.ts` **2/2**；位点基线 **1350**、目标 **65**。

### 下一批（第二十一轮起）

审计清单再次清空。**十轮采样抓到 10 处缺陷**，共同形状是
"几个各自正确的东西放在一起不成立"；第十九轮给这个形状找到了第二个名字
——**并档**，第二十轮又补上一个：**注释描述了一条不存在的接线**。

- **还没盯过的面**（按预期产出排序）：
  - **"注释与实物不符"值得单独做成一条判据**（二十一轮首选）：
    > **2026-10-08 已结（负结果，不做）**：探针跑了 142 个文件 —— 407 处反引号指称
    > 本仓符号，87 处"不在本文件"，最严那一档（`foo()`，6 处）**全是**合法跨文件
    > 指称，精确率 0。数据与逐条点名见
    > `docs/2026-10-08-comment-claims-probe.md`，探针在
    > `docs/evidence/comment-claims-probe.mjs`。**别再拿这条当待办。**
    本轮最大的收获是发现**代码注释可以断言一件从未发生过的事，而没有任何东西会红**。
    `BoardPage.tsx:26` 那句话如果为真，一切正常；它为假，缺陷一路通到界面。
    与"四同步"（数字漂移）同源 —— **都是"关于事实的声明没有任何守卫"**。
    可行的判据：注释里出现的**本仓符号名**（`xxx()` / `Type.field`），
    必须真的在被注释的那个文件里存在。`check:doc-claims` 已经会解析文档里的声明，
    把同一套判据扩到源码注释是自然的下一步。
  - **"两处写着一个意思、用着不同判据"**（十九轮起记下，两轮未做）：
    `cli-agent` vs `http-bridge` 只是已找到的一对。静态门禁查不出来 ——
    两边的代码都正确，"意图相同"这件事本身不可静态判定，只能靠人成对地看。
    值得做的是**先列出所有"同一概念的多处声明"**（`errorClass` 就是一例：
    4 处声明、2 个值域、3 种约束强度），再逐对看。
  - **`check:field-orphans` 扩到 `electron/` 与 `headless/`**。
    > **2026-10-07 已结**：`2296b8e` 扩到 `shared`+`electron`+`headless`+`src`。
    > 先 `--scan=<目录>` 逐目录量化（electron 80 个导出 interface / headless 11 / src 13，
    > 三处全 0 命中 ⇒ 扩面不带来假红），再反向注入证明判据仍咬得住；同批加
    > **白名单失效也红**（两种失效形态各注入一次）。
  - **`repairHistory` 两套账打通**（十七轮记下，20 轮仍未动 —— 三轮未动的
    待办要么这轮做掉，要么删掉，别一直挂着）。
    > **2026-10-08 已结（换落点）**：`TaskState.repairHistory` 自首版起零引用
    > （整个 `TaskState` 在全仓只有定义处一行），接给它没有意义 —— 真打通落在
    > **有消费者的那一面**：`ReceiptTask.repairs`（`4234510`），每条含
    > `round` / `reason`（来路：验证未通过 vs 未派发成功）/ `errorLogDigest` / `dispatchedAt`；
    > 缺席 ≠ 空数组。原待办「两套账」的意图由「凭据侧有账可查」满足，源码侧死字段
    > 由 `check:field-orphans` 继续盯。
- **横向第三跳（收益已明显递减）**：三宿主能力三方对照表。

### 值得排期（这个季度）

3. **`electron/ipc/orchestration.ts` 补到 80%+**（66.7% → 80%）。
   审批答复（`approval-decide`）是 fail-closed 链条的一环，
   它的测试密度不该是全项目最低的那个。

4. **`src/pages/SettingsPage.tsx` 的注释密度**（8%，全项目大文件最低）。
   密钥设置页是安全相关 UI，"哪一项对应哪个 env 变量"这类知识值得写下来，
   或者干脆抽成常量表让代码自解释。

### 不用做

5. **不需要给 `serve.ts` 的 `esc()` 加引号转义**。加了就成"转义了但没用上"的
   死代码，比留着一条明确记录的潜在风险更糟 —— 只要没人往那个属性里塞
   外部可控字段，它就是安全的；真要加字段的人会先撞到 `SITE_BASELINE` 之外的
   code review。

6. **不需要拆分大文件**。`orchestrator.ts` 837 行看着大，但注释密度 28%、
   变异门禁 47/47 逐点全杀、拆分会让"一个变更要同时读三个文件"。
   体量大不是缺陷的证据，**没有测试的体量大才是**。

## 8. 体检的局限（诚实标注）

- 这次是**静态 + 局部实测**，不是完整的安全审计：
  - 没有做模糊测试 / 依赖漏洞扫描（`npm audit` 未跑）
  - 没有真实凭据的端到端演练（smoke 里那 9 条真跑的要钱）
  - 没有多平台交叉验证（本机 Windows；Linux 侧靠 CI）
  - **没有审 React 渲染进程本身**（`src/**` 的 UI 逻辑只有覆盖率数字，没有行为审查）
- 因此"没发现新的高危缺陷"应读作"**在我这次体检的范围内没发现**"，
  而不是"不存在"。

## 9. 事后补充（2026-10-06）：§8 那条"没有真实凭据的端到端演练"闭合了一半

上面 §8 里我列的四条局限，今天闭合了第二条的一半，另半仍开着。记在这儿是因为
**"体检范围"这件事本身会随时间失效**，不写清哪条被谁在什么时候补上，下一轮又会当成新的。

- **闭合的**：真实凭据的端到端真跑。`OX_SMOKE=1 npx vitest run src/sensenova.smoke.test.ts`
  → 6 passed（三条线路连通 + chatJson 真 JSON + 整池 failover）；
  `node scripts/smoke-fullchain.mjs` → EXIT 0，真实 SenseNova 执行器写盘、zone 判定、
  真 `node --test` 验证全绿，两个任务都是第 1 次就完成（本轮没触发重修轮）。
  我按 09-19 那次的教训另做了 **11 条独立边界验收**（契约输入由我自己造，不用智能体
  自写的那份测试）→ 11/11，"自写测试自洽地实现错口径"那一类**没有复现**。
  逐条数字与命令在 `CHANGELOG.md` 的「实测（真链路复证，不进门禁）」一节。
- **仍开着的，而且是更要紧的那半**：`smoke-fullchain.mjs` 的任务计划是**硬编码**的
  （脚本自己写着 "mirroring what decompose would produce"），所以**真实 LLM 做
  PRD → 任务 → 批次这段拆解的质量，至今只有 2026-09-19 一次记录**（那一轮 sensenova
  侧预算耗尽、`cli.js` 由人工补完）。补它要跑 `run-multiagent-e2e.mjs --real`：长跑 +
  真实凭据 + 需要外部桥在跑，所以它既不进门禁、也不能靠一次绿就变成结论。
- **§9.1 当天补跑的那半，结果是负的**：真拆解那一格今天跑了 `run-multiagent-e2e.mjs --real`
  （6 任务 / 2 批次 / 两个智能体 / 30 分钟墙钟）——编排机制**全部按设计工作**
  （满载让路、429 冷却换线、执行器 600s deadline 真掐、两次越权 revert、基线归因、三轮重派），
  但**这单没交付**：测试套 t6 因上游未结算而三轮"依赖未就绪"，`tests/` 始终为空 ⇒ `test` 三轮全红，
  最后被墙钟硬杀、没有凭据。独立验收又抓到一条引擎自身验证看不见的真缺陷：契约点名
  `src/core/csv.js`，智能体交的是 `src/core/csv/index.js`（zone 合法、契约非法），
  项目自己的 build/typecheck **过**，而 `node src/cli.js <csv>` 直接
  `Cannot find module './core/csv.js'`。逐条事件原文与两个修法取向见
  [2026-10-06-real-decomposition-e2e.md](2026-10-06-real-decomposition-e2e.md)。
  ⇒ 上面"仍开着的另一半"从"没有记录"变成"**有一次记录，且那次没交付**"。
- §8 其余三条（模糊测试 / `npm audit` / 多平台 / React 渲染进程行为审查）**原样未闭合**。