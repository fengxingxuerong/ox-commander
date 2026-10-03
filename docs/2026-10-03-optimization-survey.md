# 优化空间勘查 · 2026-10-03

> 方法学：`codebase-optimization-survey` skill。
> 纪律：结论分 `[事实]`（有 `文件:行号`，我亲自读过源码）/ `[推断]`（标注）；
> 子代理产出只当"线索"，每条高风险结论**自己回读源码复核过**；
> 性能结论**先量后写**，不靠"应该会慢"。
> 基线：`b1cfb9a` = 1533 passed / 9 skipped（1542 用例，59 文件），verify 23 段 EXIT 0 / 5m20s。
> **本轮结果**：`verify` **EXIT 0 / 23 段 / 3m02s**，
> **1553 passed / 9 skipped（1562 用例，59 文件）** —— 比基线 +20。

---

## 0. 这次勘查的特别之处：文档里没有未登记的优化项

`docs/2026-09-29-competitive-landscape-and-roadmap.md` 的现状是 P0 全 ✅、P1 全 ✅、
P2-2/P2-3 ✅，只剩 P2-1（GitHub/Linear 集成）未开工；§5.1 还明确列了"不做"清单
（git worktree / swarm / mobile native / org goals）。

另一件事：**全仓 `TODO|FIXME|HACK|XXX` 命中 0 处**（18828 行非测试代码）。

两个结论叠在一起意味着：靠"扫标记"或"对着路线图找缺口"都找不到东西。
本次所有发现都来自**逐文件读源码**，而不是检索 —— 这也是为什么最终只有 4 条落地：
读出来的候选远多于落地的，其余要么是已登记、要么经复核后判定不是问题。

---

## 1. 已落地的改动（4 项，全部有反向注入证明）

### 1.1 `AuditLog.read()` 的单槽 memo —— 把重修轮次的重复读盘打掉

**问题** `[事实]`：`electron/audit-log.ts:153` 的 `read()` 是 O(整条履历) ——
它把留存内每个文件整读、逐行 `JSON.parse`，**最后才 `slice(-limit)`**，
所以 `limit` 一个字节的 I/O 都省不掉。而 `electron/ipc/context.ts:282` 的
`priorAttempts` 是个闭包，被 `electron/engine/orchestrator.ts:615` 在
**每个待修任务的 `.map()` 里各调一次** → k 个失败任务 = k 次全量读盘。

**量化（先量后写，不是估计）**：
用手写的同构复刻（40 MiB / 34291 条记录，恰好顶到文档写明的留存上限
20 文件 × 2 MiB）测得**单次 221 ms**；12 次 = 2494 ms，30 次 = 6269 ms，
而"读一次复用给 30 个任务"只要 221 ms。**线性增长本身就证明了零缓存。**

**落地**：给 `read()` 加单槽 memo，键 = **磁盘指纹**（文件数 + 最新文件名 +
当前文件 `size:mtimeMs`）+ `(limit, phase)`。

**为什么键是磁盘而不是内存计数器** —— 这是实现过程中被自己的测试逼出来的：
第一版用"每次写路径 `version += 1`"，我写的跨实例用例当场变红
（实例 A 建 memo 后，实例 B 往同目录 append，A 仍返回旧数组）。
两个 `AuditLog` 指向同一目录是真实场景（桌面单例 + 任何第二次构造），
内部计数器看不见外部写入。改成读磁盘指纹后，这个洞**按构造关闭**，
也不再依赖"记得在每条写路径 bump"这种容易漏的约定。

**落地后的真实收益**（对**生产类本身**测，38 MiB / 20 个真实滚动文件）：
12 次读取 **2609 ms → 6.2 ms（421×）**，且逐条比对 memo 与冷读结果完全一致。

**代价（必须说清）**：`read()` 返回的数组现在**与 memo 共享引用**。
仓内所有调用方（`taskTrail` / `deriveBoardView` / IPC 读路径）都只读不写，已核对；
这条约束写进了 `read()` 的注释里。

新增 7 条用例（`src/audit-log.test.ts`），重点**不是"更快"而是"没有 stale"**：
append 后必须读到新记录、limit/phase 是键的一部分、轮转后旧 memo 失效、
留存淘汰后不得把已删历史端回来、跨实例不泄漏、连续读内容稳定。

### 1.2 `killTree` 的默认 `graceMs` —— 生产真正在跑的值此前无人断言

**问题** `[事实]`：`electron/sandbox/kill-tree.ts:14` 与 `:45` 的
`opts.graceMs ?? 2_000` 是生产值 —— `verifier.ts:96/406`、`dev-server.ts:84`、
`cli-agent.ts:313` 三个调用点**全部不传** `graceMs`。
而既有 18 条用例每条都显式传了自己的值（1/5/10/30/50/500）；
唯二不传的两条（`guards` 里）都在 `pid === undefined` 守卫处提前 `return`，
**永远走不到默认值**。

**证明**（反向注入）：把默认改成 50 ms → 新增 2 条红，**既有 0 条红**。
判据用"默认窗口内不升级、窗口后才升级"夹逼，既钉住量级（不是 20ms 也不是 20s），
又不用让门禁多跑 2 秒。两条用例各真等满 2 s（文件耗时 4760 ms 是真实等待）。

### 1.3 `abortAllEscalations` 一次只收一条 —— 收不全就是永久挂死

**问题** `[事实]`：`electron/ipc/context.ts:109` 的 `abortAllEscalations`
是 `orchestration:cancel` 唯一的解挂路径。

**这里我推翻了子代理的结论** —— 它报"全仓搜不到符号名 → 零断言"。
我回读后发现**既有 `:924` "cancels every engine and aborts parked escalations"
已经覆盖了单条场景**。子代理按符号名 grep，漏掉了按行为覆盖的用例。
教训照旧成立：子代理产出是线索，不是事实。

**但复核过程中挖出既有覆盖的真实缺口**：既有用例**只挂起一条** escalation。
把实现改成"只 resolve 第一条"（`[...values()].slice(0, 1)`）→ 整份既有套件**全绿**。
也就是说"k 个任务同时挂起、只收第一条，其余永远挂着"这个形态无人能拦。
新增的多条挂起用例是唯一变红的那条（5 s 超时）。

**另一条附带发现**：`abortAllApprovals` 的 fail-closed 语义（收成 `false` 而非 `true`）
**既有 `:964` 已覆盖**（我注入 `true` 时它确实变红）。所以那条不算缺口 ——
诚实记录：查了，发现已有，不重复造。

**同批落地的还有**（这两条是真的没有）：
- 两个 ghost 残渣用例：cancel 收尾后 `pendingEscalations` / `pendingApprovals`
  必须已清空（再答一次必须是 ghost）。
  ⚠️ 我试过用"删掉 `.clear()`"来证敏感度，**没变红** ——
  因为迭代中 `delete` 与事后 `clear()` 行为等价，属**等价变异**，
  按纪律归入"不必强杀"，不假装它是有效断言。
- "cancel 一次把两条通道都收掉"：分开测会漏掉"只收一条通道"的回归。

### 1.4 `verificationCommandPaths` —— 生产在调、零测试引用

**问题** `[事实]`：`shared/zone-coverage.ts:155`，生产由
`electron/engine/orchestrator.ts:327` 调用，全仓**没有任何测试 import 过它**。
它只含 `??`（默认关闭算子），变异门禁**不兜底**。纯函数，钉它成本近零。

**落地** 5 条用例（`src/zone-coverage.test.ts`）：取嵌套路径、忽略裸文件名
（判据与 `extractDeclaredPaths` 同源）、无 `args` 不炸、跨命令去重+稳定排序、
以及"**不自己过滤**"（它是事实提取，zone 匹配归 `findOrphanPaths` ——
若有人在这里塞过滤判断，返回空数组后越权写入就再也不会被报出来）。

**证明**：去掉 `.sort()` → 2 条红；把 `?? []` 改成 `!`（去掉守卫）→ 1 条红。
后者正是变异门禁覆盖不到的盲区，现已补上。

写这组用例时我先写错了一条：以为 `vitest.config.mts` 会被取出。
**是代码对、我错** —— 裸文件名按设计被忽略（注释里写明）。
改成 `config/vitest.config.mts` 后通过。这类"以为代码错、其实自己对"的
纠正，正是必须真跑测试而不是读一遍就下结论的直接理由。

---

## 2. 复核后判定"不是问题"的（登记以免下次重查）

子代理提的这些，我逐条读源码后**否决**：

| 提法 | 判定 | 依据 |
|---|---|---|
| `abortAllEscalations` / `abortAllApprovals` 零断言 | **部分错** | 既有 `:924` / `:964` 已按行为覆盖（见 1.3） |
| `verificationCommandPaths` 无断言 | **对**，已落地 | 1.4 |
| `check-script-wiring.mjs:100` 纯子串匹配会把真孤儿洗成可达 | 保留观察 | 方向确实是**漏报**，但改严会先动既有绿灯；本轮不动 |
| `orchestration.ts:144` `catch {}` 吞掉落盘失败 | 保留观察 | 注释明写"recovery bookkeeping 不许打断 run"，是有意设计 |
| `verifier.ts:145` 每轮重跑全部验证命令 | **有意为之** | 硬性验证语义就是"每轮重新验"，不是缺陷 |
| 状态派生两份（`store.ts:291` vs `board-derive.ts:207`） | **已登记** | `board-derive.ts:24-27` 明写"intentionally two copies"，理由是内存事件流 vs 审计事实源 |
| `MAX_LOG_BYTES` / `300_000` 等常量重复 | 保留观察 | 都是各模块自治的默认值，抽公共常量会引入反向依赖；本轮只记录 |

---

## 3. 还没动的（按建议顺序）

1. **headless 缺 `raceRedundancy` / `disabledKeyVars`** `[事实]`：
   `headless/protocol.ts` 的 `KNOWN_FIELDS:183-203` 与 `HeadlessSpec:63-105`
   都没有这两个字段，而引擎消费它们（`platform.ts:314` / `:346`、
   `scheduler.ts:451`）。桌面设置页有（P0-3 建的），headless 三宿主没有。
   这是**能力不对等**，与记忆里"CLI/桌面对齐"那条欠账同源。
   ⚠️ 属协议面改动，要动 `docs/headless-protocol.md`，建议单独一轮。
2. **桌面不渲染 `receipt.checks[].command` 与 `fingerprint`**
   `[事实]`：`src/BoardPage.tsx:208-215` 只渲染 kind/ok/exitCode/headline；
   preload 无 verify 通道。而 serve 状态页（`serve.ts:191-194`）整份渲染。
   外部可验证性的两根基石在桌面这条路上是断的 —— **可考虑**不等于**能看到**。
3. **`raceRedundancy` / `disabledKeyVars` 的白名单与 `HeadlessSpec` 漏声明
   `runWallClockMs` / `brainTimeoutMs` / `executorTimeoutMs`**（同上，协议面）。
4. `check-script-wiring.mjs` 的子串匹配改严（会让门禁从"漏报"变成"能报"，
   但要先确认不会把既有绿变成红）。

---

## 4. 落地记录

| 文件 | 性质 | 验证 |
|---|---|---|
| `electron/audit-log.ts` | 生产改动（memo + 磁盘指纹） | 变异 site **20/20**；既有 24 条 + 新增 7 条全绿；真实类实测 421× |
| `electron/sandbox/kill-tree.ts` | **未改**（只加测试） | 变异 site **10/10** |
| `shared/zone-coverage.ts` | **未改**（只加测试） | 变异 site **21/21** |
| `src/audit-log.test.ts` | +7 用例 | 反向注入：跨实例用例逼出实现缺陷并修正 |
| `src/kill-tree.test.ts` | +2 用例 | 注入默认 50ms → 2 红（既有 0 红） |
| `src/zone-coverage.test.ts` | +5 用例 | 去 sort → 2 红；去 `??` → 1 红 |
| `src/ipc-handlers.test.ts` | +7 用例 | 注入"只收第一条" → 1 红（既有 0 红） |

四条生产/测试改动**全部经过反向注入**（改坏源码 → 必须变红 → 还原 →
`git diff` 干净），没有一个是"加了断言后绿"就算数。

**最终门禁**：`npm run verify` = **EXIT 0 / 23 段 / 3m02s**，
**1553 passed / 9 skipped（1562，59 文件）**。
`mutation:quick` 24/24 杀、`mutation:touched` 自动认出本轮唯一生产改动
（`electron/audit-log.ts`）并以 site 口径 20/20 通过。

**门禁纪律提醒**：变异运行时独占工作区（它 `writeFileSync` 改写源文件）。
本轮严格做到变异期间不并行跑任何其他命令。
