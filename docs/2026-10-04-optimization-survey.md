# 优化空间勘查 · 2026-10-04

> 方法学：`codebase-optimization-survey` skill。
> 纪律：结论分 `[事实]`（有 `文件:行号`，亲自读过源码）/ `[推断]`（标注）；
> 子代理产出只当"线索"，每条高风险结论**自己回读源码复核**；
> 性能结论先量后写；每条改动都要有**反向注入**证明（改坏源码 → 只有目标测试变红 → 还原）。
> 基线：`10bf281` = 1553 passed / 9 skipped（1562 用例，59 文件），verify EXIT 0 / 23 段 / 3m02s。

---

## 0. 这一轮的入口

上一轮（2026-10-03）已把"扫 TODO / 对路线图找缺口"这条路走死了（全仓 TODO 命中 0）。
本轮换个入口：**审门禁自身**——一个 23 段的门禁里，有没有哪一段"声称在管某件事、其实管不到"。

派出的勘查子代理报了 12 条，我逐条回读源码后：**4 条属实并落地、3 条判定为部分错并更正、
5 条属实但本轮不动（登记）**。更正过程写在 §3，不藏。

---

## 1. 已落地（5 项，全部有反向注入证明）

### 1.1 `loadPolicyDir` —— 安全边界的 IO 层，此前一条断言都没有 `[事实]`

`electron/sandbox/policy-dir.ts:32`，生产由 `electron/platform.ts:217` 调用，
**全仓没有任何测试 import 过它**，也不在变异门禁的 TARGETS 里（变异不兜底）。

它是"策略即代码"的入口，30 行里决定了三件安全语义：
坏文件会不会拖垮整个 run、坏到什么程度算没生效、样例文件会不会被当真策略。

新增 `electron/sandbox/policy-dir.test.ts`（12 条），重点钉**读不出来时的行为**：

| 分支 | 行号 | 用例 |
|---|---|---|
| `dir === undefined` / 目录不存在 → 静默空集，不抛 | `:33` `:37-40` | 没写策略 = 用内置规则 |
| `*.example.json` 跳过 | `:36` | 样例不是策略 |
| 坏 JSON 只记错、不算生效，其余照常 | `:47-51` | 一个坏文件不许掀翻整份策略 |
| 有 issues 的文件**整份不生效** | `:55-57` | 半懂不懂地执行安全策略比不执行更危险 |
| 数组形式（一份文件多份策略） | `:52` | 坏的那份带 `[i]` 下标 |
| 合成语义：清单并集、预算取最小 | `:60` | 保护只叠加、不被另一份抹掉 |

**反向注入**（两次，各自独立）：
- 去掉 `:57` 的 `if (issues.length === 0)` → **3 条红**（半坏文件不生效 ×2 + 数组下标 ×1），其余 9 条绿；
- 去掉 `:36` 的 `&& !f.endsWith(".example.json")` → **1 条红**（example 跳过），其余 11 条绿。

**诚实记录一条失败**：我还注入过"去掉 `:43` 的 `.sort()`"，**没变红** ——
本机 NTFS 的目录索引本身按名字有序，`readdirSync` 返回顺序已排序，属**等价变异**。
用例保留（CI 的 ubuntu runner 是 ext4，哈希序下它才真正有效），
但**不把它算进"有反向注入证明"的那组**。

### 1.2 `buildEscalationSummary` 的两个数字 —— 断言构造错，互换全绿 `[事实]`

`src/prompts.test.ts:76-77` 写的是 `expect(s).toContain("3"); expect(s).toContain("2")`。
而 `shared/prompts.ts:104` 渲染的是 `重修 ${attemptsSoFar} 轮后仍未通过验证（上限 ${maxRepairRounds}）`。

两处失效叠加：
① 分开断言两个数字 → 字段互换（重修 4 / 上限 7）仍然全绿；
② 用例里的 `lastErrorDigest` 是 `"AssertionError: expected 1 to be 2"` —— **它自己就含 "2"**，
所以 `toContain("2")` 即使 maxRepairRounds 根本没被渲染也会通过。

这段摘要是**人做处置决定时唯一的输入**（跳过 / 重派 / 终止），用户照着它选动作。

**修复**：数字换成 7/4（避开错误摘要里的数字），断言改成钉住绑定关系的完整片段
`"重修 7 轮后仍未通过验证（上限 4）"`，并补一条"只改其中一个、另一个不许跟着变"。

**反向注入**：把 `prompts.ts:104` 两个字段互换 → **2 条红（新增的），既有 0 条红**。
"既有 0 条红"正是原来那条断言不敏感的证据。

### 1.3 零位点变异目标会被算作 PASS —— 静默空转 `[事实]`

`scripts/mutation-check.mjs:1511-1516`：`siteTotal === 0` 时只 `console.error` 提示，不 FAIL。
它意味着"某个被列为重点的文件，在可执行代码里一个算子都没有 → 一个变异都没验证 → 仍算 PASS"，
混在几百行输出里没人看得见。与"漏挂测试文件"是同一族空转。

**改前的探测**（先量后改）：`node scripts/mutation-check.mjs --mode=site --limit=999 --list`
→ 全部 61 个目标**均非零位点**，故改成 FAIL 不会波及既有绿灯。

**改后**：`siteTotal === 0` → FAIL，并给出处置路径（从 TARGETS 移除 / 让它有可执行分支）。

### 1.4 `check-packaged-paths` 恒绿且无法自证 —— 加判据自检 `[事实]`

这道门禁管的形态（只从 `app.getAppPath()` 读配置，打包后指向 asar 内部）**已于 2026-09-24 修掉**，
于是它现在恒绿。恒绿的门禁与没有的门禁，区别只在它会让人以为"这件事有人看着"。

**改法**：把判定抽成 `isSuspect(src)`（判据与自检共用同一份代码，不会出现"自检测的是另一套正则"），
每次执行先用 4 条构造样例验证：可疑样例必须判可疑、userData/exe 落点与"只读不写"必须豁免。

**反向注入**：把 `READ_ACTIONS` 正则改成永不匹配 → **自检立刻 FAIL（exit 1）**。
修改前这个改动只会让门禁变成"永远 PASS"——这正是要消灭的形态。

### 1.5 `mutation:touched` 认不到 `src/` 以外的测试归属 `[事实]`

`scripts/mutation-touched.mjs:39` 的正则只收 `src/[^"]+\.test.tsx?`，
于是挂在 `shared/deliverable-format.test.ts`（mutation-check.mjs:354）与
`electron/store.test.ts`（:370）的两个目标，永远被打印成 `← (没挂测试文件)`。

后果不是审计错（审计仍按 site 口径跑，正确），而是**误导**：
读的人会以为那里没有断言、从而不去补，而断言其实一直在跑。

**改后**：认 4 个宿主目录，实测 **89 → 91**。

---

## 2. 复核后更正子代理结论（3 条）

| 子代理提法 | 我的复核结论 | 依据 |
|---|---|---|
| `check-packaged-paths` "名不副实：不校验路径存在，OUTSIDE_ASAR 按整文件豁免" | **部分错** | 文件头 `:13` 明写"宁可漏报，不可误报阻塞"，`:49-50` 明写"命中任一即认为作者已考虑打包形态" —— 是**有意的保守口径**，不是缺陷。真缺口是它恒绿无自检，已按 1.4 修 |
| `check-tests-collected` "只看文件名差不统计用例数" | **不算缺陷，但抓到真问题** | 它的职责就是"检测未被收集的文件"。真问题是文件头 `:5-6` 仍写"include 现在**不含 headless/**"——`vitest.config.mts:23` 早已含。**文档过期**，已重写该段并写明它现在的职责是"守住包含关系不被回退" |
| `mutation:quick` 只跑 1 个算子/目标 | **属实，但不动** | `package.json:42` = `--tier=1 --limit=1`。CI 有独立 job `mutation-full`（`.github/workflows/verify.yml`）跑 `mutation:audit`，已抵消。登记为本机 verify 的已知弱点 |

---

## 3. 属实但本轮不动（登记，按建议顺序）

| # | 问题 | 证据 | 为什么不动 |
|---|---|---|---|
| 1 | `check-unwired` 在**注释/字符串**里出现符号名也算"已接线" | `scripts/check-unwired.mjs:110-127` 用 `word.test(text)` 打整份文件原文；对比 mutation-check 自己有 `maskNonCode`（:955） | 方向是**漏报**。改严需先量化会新增多少红，否则会把既有绿变红 |
| 2 | 9 个 smoke 用例**永久 skip** | `src/sensenova.smoke.test.ts:44`（6 个）、`src/sandbox-llm-call.smoke.test.ts:103`（3 个）；本轮门禁日志实测确认：`3 skipped` + `6 skipped` | 未核实"该不该 skip"：需确认是否真依赖外网/真 LLM。若是，应显式登记而不是静默跳过 —— 它们让 `Test Files 58 passed / 2 skipped` 这行看着是全绿 |
| 3 | `masker-selftest` 只测 4 个算子，且不校验真实靶位点 >0 | `scripts/masker-selftest.mjs:38-43` | 与 1.3 是同一族缺口（"0 位点仍 PASS"），建议与 1.3 同批收口 |
| 4 | `mutation-check` 文件头承诺"位点数与 SITE_BASELINE 不符 → exit 1"，代码里**没有** SITE_BASELINE | `:72` 注释 vs 全仓仅注释 | 待核实后二选一：实现它，或删掉这句承诺（**假承诺比没有更糟**） |
| 5 | `check-script-wiring.mjs:100` 纯子串匹配 | 上轮已登记 | 同 #1，改严前先量化 |

**继承上轮的欠账（仍未动）**：headless 协议缺 `raceRedundancy`/`disabledKeyVars`
等 5 个字段；桌面不渲染 `receipt.checks[].command` 与 `fingerprint`；
常量重复（`maxParallelRuns` / `maxStdoutBytes` / `300_000`）。

---

## 4. 落地记录

| 文件 | 性质 | 验证 |
|---|---|---|
| `electron/sandbox/policy-dir.test.ts` | **新建** +12 用例 | 注入①去 `issues.length === 0` → 3 红；注入②去 example 过滤 → 1 红；注入③去 `.sort()` → **不红（NTFS 有序，等价变异，已如实标注）** |
| `src/prompts.test.ts` | +1 用例、改 1 条断言 | 注入：互换 `prompts.ts:104` 两字段 → 新 2 红 / 既有 0 红 |
| `scripts/mutation-check.mjs` | 生产改动（零位点 → FAIL） | 改前探测 61 个目标全非零位点；改后 `--list` EXIT 0 |
| `scripts/check-packaged-paths.mjs` | 生产改动（抽 `isSuspect` + 自检） | 注入：破坏 `READ_ACTIONS` 正则 → 自检 FAIL exit 1 |
| `scripts/mutation-touched.mjs` | 生产改动（正则放宽） | 实测识别数 89 → 91 |
| `scripts/check-tests-collected.mjs` | 注释（文档过期） | 与 `vitest.config.mts:23` 现状核对 |

生产代码（`policy-dir.ts` / `prompts.ts`）**改回原样**，
`git diff --stat` 在改动前后核对过：不含这两个文件。

---

## 5. 我自己的错（本轮）

写 `check-tests-collected.mjs` 的注释时，我在块注释里原样写了 `headless/**/*.test.ts` ——
其中 `**/` 的末两字符是 `*/`，**提前闭合了块注释**，eslint 直接 parsing error，门禁第一段就红。
更讽刺的是我补的那句"注释里别写这种 glob"里又写了一次，于是又红了一遍。
教训写进代码注释了（`check-tests-collected.mjs:10-11`）：
**注释里出现 glob 片段时要转义或改写**，这不是风格问题，是语法问题。

## 6. 最终门禁

`npm run verify` = **EXIT 0 / 23 段 / 3m17s**（直读退出码，未走管道）。

- **1589 passed / 9 skipped（1598 用例，60 文件）**；
- `mutation:quick` PASS（无存活变异）；
- `mutation:touched`：本次改动未触及任何变异目标文件；
- `check-packaged-paths` 输出新增一行 `判据自检：4/4`。

**基线归因说明（不糊）**：上轮记录的 1553/9 是 @ 勘查轮（b1cfb9a 系），此后又有
`d5ac271`/`ed0ffff`/`10bf281` 三个提交，本轮**没有实测 10bf281 的裸基线**（那要
`git stash` 整轮改动，风险大于收益）。所以不把 1589−1553=36 全算成本轮 ——
**本轮净新增是 13 条用例（policy-dir 12 + prompts 1）、1 个新测试文件**。
