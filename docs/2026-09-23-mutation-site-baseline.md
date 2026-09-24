# 变异门禁 site 口径基线（2026-09-23，2026-09-24 CI 全绿终章）

**这条基线解决的问题**：`docs/2026-09-20-fullstack-review.md` §16.1 记录的
`486/581（84%）` 是**积压清理之前**的快照，此后 8 个提交清掉了全部 95 处，
但只做过 25 次逐目标审计、没有连续全量快照，产物也没有留存 ——
于是"现在到底是多少"无法回答，引用 84% 又已经过时。本文件是第一次可复现的连续快照。

## 终章：CI 三 job 首次全绿（2026-09-24，run 35888029233）

上云首日 CI 十轮 runs：3 轮计费拒绝、6 轮问题迭代、**1 轮全绿**——问题全部收敛，无未解释失败。

| 发现 | 处置 |
| --- | --- |
| 私有仓库 Actions 计费拒绝 ×3 | 转**公开仓库**（推送前完成泄漏扫描与提交作者占位复核） |
| npm ci 失败：lock 失步（npm 11 给嵌套 vite@8 配错 esbuild，arborist reify 缺陷） | **vite 5→8 + plugin-react 6** 对齐 vitest 4 peer；esbuild 依赖随 vite rolldown 化整体消失（commit 168d93b） |
| ubuntu 7 测试失败：spawn-plan 漏传 platform（真 bug）、portableKill 无预检查（pid 复用误杀，真缺口）、sandbox-journal 断言平台假设 | 逐案修复（commit e74af63） |
| store 同毫秒 id 碰撞 flake | id 加单调序数 + list 平局决胜，假时钟用例钉死（commit f71ffbc） |
| mutation 存活 4 → 1 → 0 | kill-tree @37/@32 补断言杀死（ee80eb2 / 11790fb）；path-policy @92 诊断定性 **POSIX 域不可达**（realpath(fs-root) 恒成功，仅 Windows 不存在盘符可达）入白名单（commit 4885690） |

**位点总数 594 → 590**：白名单 +2（kill-tree @37 防御冗余等价化、path-policy @92 POSIX 不可达），
最终以 **CI 实测 590/590（run 35888029233）** 为基线——Windows 本地与 CI-Linux 双口径合流。

**工具沉淀**：`mutation-check.mjs` 存活位点现自动打印**变异 diff + 测试输出尾部**——
"为什么没杀死"（平台差异 / 断言盲区 / 等价）从此远程可判读。path-policy @92 正是靠它在
没有 Linux 本机的情况下完成定性。

## 命令与结果

```bash
node scripts/mutation-check.mjs --mode=site --limit=999
# 总计：杀死 577/577（100%）   耗时 1371.2s（22.9 min）
#   其中 单点杀死 577 · 聚合杀死 0
```

| 口径 | 2026-09-22（§16.1） | 2026-09-23（本文件） | 2026-09-23 二轮（usage 两轮后） | **2026-09-24 CI 终章** | 2026-09-25 本机复测（win32） |
| --- | --- | --- | --- | --- | --- |
| aggregate（`npm run mutation`） | 152/152（100%） | 未重跑；verify 内 `mutation:quick` 为 10/10 | 未重跑（verify 内 `mutation:quick` 持续参与门禁） | 同左 | 162/162（100%） |
| **site（`--mode=site`）** | 486/581（**84%**） | **577/577（100%）** | **594/594（100%）**（处置后） | **590/590（100%）· CI 三 job 首次全绿** | **603/603（100%）** |
| 聚合杀死数 | 未区分 | **0**（全部逐点判定） | **0**（全部逐点判定） | **0**（全部逐点判定） | **0**（全部逐点判定） |

**位点总数 581 → 577 的原因**：这批清理里有若干处是按"简化源码"收口的
（冗余合取项删除后位点本身消失，而不是被白名单挡住）。
净变化 = `-9 处删除 + 5 处新增（electron/main.ts）`。

## 二轮快照：usage 两轮代码后的全量 audit（同日）

usage 可见性轮（`7f853ed`）与 maxTokensPerRun 闸门轮（`3b4d513`）落地后重跑全量：

```bash
node scripts/mutation-check.mjs --mode=site --limit=999
# 处置前实测：杀死 591/594（99%）   耗时 787.5s（13.1 min）
# 处置后三目标复测全杀 → 最终口径 594/594（100%）
```

分母 577 → 594 的构成：usage-meter 新模块 9 处（tier 1，第七批）、
`headless/protocol.ts` 协议字段校验 +5、其余零散 3 处（platform 等）。

**这一轮最大的价值是抓到 3 个真问题**——逐目标跑单文件全绿掩盖不了它们，
只有全量才暴露：

1. **白名单行号漂移（2 处）**：`sensenova-api.ts` 的两条白名单
   （317/323 行，"可证明不可达" + "TOCTOU 构造不出"）因 usage 轮插入
   14 行漂移到 331/337，按行号匹配失配 → 位点重新计入分母且无断言 → 存活。
   两条例由经核对**依然成立**（walkStat 仍在 298 行用同一谓词过滤后才 push；
   模块仍无 fs 注入点），处置即校回行号并在 `EQUIVALENT_SITES` 注释里
   记下"漂移曾被抓到"备查。
2. **可杀而未杀的等价错觉（1 处）**：`headless/protocol.ts:250`
   `|| → &&`——三段条件对**普通输入**全部等价，但 `1e999` 是合法 JSON
   且 `JSON.parse` 产出 `Infinity`，只有 `!Number.isFinite` 段能拦住它。
   补一条 1e999 断言后变异被杀。教训：判断"等价"必须枚举**输入域的边界**
   （JSON 数字溢出），不能只看常规取值。

**流程教训**：改了 TARGETS 内文件的行号分布后，白名单是按行号精确匹配的
——一轮收口时应当把受影响文件的 `EQUIVALENT_SITES` 行号一并核对；
否则只有全量 audit 能兜底，而它一次要十几分钟。

## 三轮快照：2026-09-25 本机 Windows 复测（603/603）

上面几轮的 site 数字（577 / 594 / 590）里，最后一格引自 CI。**本轮在 win32 本机重跑全量**，
把"每处位点都有断言"这句重新变成有出处的事实：

```
node scripts/mutation-check.mjs --mode=site --limit=999
# 总计：杀死 603/603（100%）   耗时 857.5s（14.3 min）
#   其中 单点杀死 603 · 聚合杀死 0
```

分母 590 → 603 的来路不是测试变松，而是这几轮里新增了真实位点：新登记的变异目标
`headless/run-spec.ts` 占 15 处（首跑只有 6 处被杀，补 4 条用例后才到 15/15），
其余来自基线验证、批号防碰撞与仲裁四档那些改动。同日 aggregate 口径复测为
**162/162（100%）**——它仍然只回答"每个算子至少有一处被覆盖"，与 603 不可互换。

另记一条本轮踩到的判定坑：`pruneStaleBackups` 的循环有两处 `continue`（跳过非 `batch-*`
项、跳过没过期项），而 `readdirSync` 在 Linux 是 hash 序、Windows 是字典序 —— 只要待删项
恰好排在跳过项之前，`continue` 与 `break` 就**测不出区别**。这类"存活"不是断言不够，是
被测对象的遍历顺序本身不确定。修法是给遍历显式排序，而不是把位点写进白名单。

## 适用边界（引用本基线时必须一起说）

1. **只在 Windows 上成立**。`path-policy` 的平台判断已做成"平台参数化"
   （`isCaseInsensitiveFs(platform)`），但 `kill-tree` 的 taskkill 路径、
   `.cmd` 启动等平台相关分支的可杀性——**CI ubuntu 矩阵已验证**（2026-09-24
   首跑暴露 6 处平台假设后逐案修复，spawn-plan/kill-tree 现由 `withPlatform`
   注入双端语义，Linux 上逐点可杀）。
2. **白名单 9 条不计入 590**（`scripts/mutation-check.mjs` 的 `EQUIVALENT_SITES`）：
   7 条一级（可证明等价／可证明不可达）、2 条二级（TOCTOU，构造不出输入）。
   2026-09-24 新增：kill-tree @37（portableKill 预检查使防御冗余等价化，双防线刻意保留）、
   path-policy @92（POSIX 域不可达，realpath(fs-root) 恒成功）。
   它们是**已评审的排除项**，不是分母里的水分。
3. `electron/main.ts` 的 5 处里，`if (!isPrimaryInstance)` 与 `if (!win)`
   **不在算子表内**（没有 `if (!x)` → `if (x)` 这个算子），靠行为测试保证。
4. 本报告是**快照，不是现状**：引用前先 `git log --date=iso -1` 核对提交时间。

## 原始报告

以下为脚本原始输出（逐目标一行：杀死数 / 总数、耗时）：
electron/sandbox/path-policy.ts   杀死 33/33（100%）   34.2s
shared/glob.ts   杀死 23/23（100%）   22.6s
shared/redact.ts   杀死 1/1（100%）   1.9s
shared/prompt-text.ts   杀死 1/1（100%）   2.2s
electron/agents/scoped-env.ts   杀死 5/5（100%）   5.1s
shared/zone-coverage.ts   杀死 18/18（100%）   16.5s
electron/engine/scheduler.ts   杀死 14/14（100%）   26.6s
electron/sandbox/kill-tree.ts   杀死 11/11（100%）   19.9s
src/store.ts   杀死 13/13（100%）   27.5s
electron/engine/orchestrator.ts   杀死 25/25（100%）   129.9s
electron/agents/manifest-schema.ts   杀死 55/55（100%）   92.8s
electron/agents/registry.ts   杀死 20/20（100%）   23.1s
electron/agents/cli-agent.ts   杀死 15/15（100%）   56.3s
electron/agents/sensenova-api.ts   杀死 29/29（100%）   89.2s
electron/agents/http-bridge.ts   杀死 27/27（100%）   74.1s
electron/agents/manifest-loader.ts   杀死 11/11（100%）   19.7s
shared/llm-client.ts   杀死 15/15（100%）   36.0s
shared/http-clients.ts   杀死 39/39（100%）   112.3s
shared/schema.ts   杀死 17/17（100%）   20.0s
electron/engine/verifier.ts   杀死 9/9（100%）   20.9s
electron/agents/run-session.ts   杀死 5/5（100%）   5.5s
electron/sandbox/command-policy.ts   杀死 6/6（100%）   14.3s
electron/sandbox/spawn-plan.ts   杀死 7/7（100%）   14.6s
electron/sandbox/circuit-breaker.ts   杀死 15/15（100%）   38.4s
electron/sandbox/timeout-gate.ts   杀死 2/2（100%）   7.4s
electron/sandbox/file-journal.ts   杀死 11/11（100%）   113.3s
electron/sandbox/snapshot-store.ts   杀死 13/13（100%）   113.3s
electron/engine/router.ts   杀死 20/20（100%）   18.7s
electron/keys-store.ts   杀死 19/19（100%）   19.7s
electron/engine/batch-guard.ts   杀死 10/10（100%）   57.5s
shared/graph.ts   杀死 5/5（100%）   4.9s
electron/ipc/orchestration.ts   杀死 3/3（100%）   6.6s
electron/ipc/projects.ts   杀死 4/4（100%）   8.0s
electron/ipc/agents.ts   杀死 4/4（100%）   8.1s
electron/ipc/context.ts   杀死 7/7（100%）   13.5s
electron/platform.ts   杀死 4/4（100%）   12.3s
headless/protocol.ts   杀死 50/50（100%）   71.3s
electron/engine/zone-guard.ts   杀死 6/6（100%）   7.8s
electron/main.ts   杀死 5/5（100%）   5.2s

总计：杀死 577/577（100%）   耗时 1371.2s
  其中 单点杀死 577 · 聚合杀死 0
口径：site —— 本次为**逐位点**判定，577 个变异各自只改一处。
最慢：electron/engine/orchestrator.ts 129.9s · electron/sandbox/snapshot-store.ts 113.3s · electron/sandbox/file-journal.ts 113.3s

PASS: 无存活变异 —— 全部 577 处位点已**逐点**验证（每处单独变异都被断言发现）。

## 二轮原始报告（处置后三目标复测）

electron/agents/sensenova-api.ts   杀死 29/29（100%）   73.4s
headless/protocol.ts   杀死 55/55（100%）   63.6s
shared/usage-meter.ts   杀死 9/9（100%）   6.2s

（其余 39 个目标处置前实测即全杀，逐目标行见一轮报告；处置只触碰上述三处，
未改动其他目标的源码与测试，故不重复罗列。）
