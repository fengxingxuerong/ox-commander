# 2026-10-09 「同一概念的多处声明」清单（第一轮：列全 + 标状态）

> 起因：`docs/2026-10-05-full-audit.md` §7 记的待办 ——
> 「两处写着一个意思、用着不同判据」**静态门禁查不出来**：两边的代码都正确，
> "意图相同"这件事本身不可静态判定，只能靠人成对地看。值得做的是**先列出所有
> "同一概念的多处声明"**，再逐对看。本文件是那份清单。
>
> 本轮只完成**列全 + 标状态**；逐对**处置**另起一轮（清单里已标优先级）。

## 口径

"同一概念的多处声明" = 一个语义概念在全仓有**两处以上互不引用的独立声明**：
可以是两个类型、类型 + 值域数组、或同一个默认值散落多处。判据不一致有三态：

- **值域不同**（一边 4 档一边 5 档）；
- **约束强度不同**（一边有运行时收窄、一边没有）；
- **只散落**（值相同但没有单一真源 ⇒ 改一处漏两处）。

**现有门禁能兜住的部分**：`check:exhaustive-maps` 管"以联合类型为键的映射表
与穷尽 switch"逐档登记。**它管不了**"两处并列的类型声明"和"散落的默认值"。

**它的盲区（本轮实测）**：联合类型**含非字面量成员**（`string` / `undefined` /
对象）时整体跳过；`--list` 报告跳过项 **19 处**。那 19 处正是"漂移了也没人报警"
的位置 —— 下一轮要人工扫的面。

## 清单

| # | 概念 | 声明处 | 形态 | 是否同源 | 状态 |
|---|---|---|---|---|---|
| 1 | 仲裁模式 | `shared/types.ts:259`（类型，4 档）· `headless/protocol.ts:237`（值域数组） | 类型 + 数组 | ✅ 数组引类型 | ✅ 有门禁（`check:exhaustive` 管 switch）+ 协议层运行时校验 |
| 2 | **默认仲裁模式** | `shared/types.ts:384` · `electron/engine/batch-guard.ts:160` · `electron/agents/index.ts:162` | 三处字面量 `"revert-batch"` | ❌ 各写各的 | ⚠️ 待收口（优先级高） |
| 3 | 升级策略 | `headless/protocol.ts:61`（4 档）· `shared/types.ts:371`（5 档，多桌面独有的 `"ask"`） | 两个类型 | ❌ 无引用关系 | ⚠️ 有意为之，但**加档必须同改两处** |
| 4 | 升级策略值域 | `headless/protocol.ts:236` 数组 · 桌面侧**无对应数组** | 数组 vs 无 | — | ⚠️ 桌面侧 escalationPolicy 与 arbitration 同病：`SettingsStore.load` 对字段零校验 |
| 5 | 失败类别 | `shared/types.ts`：`FailureClass` + `FAILURE_CLASSES` + `isFailureClass` | 类型 + 值域 + 收窄器 | ✅ 单一真源 | ✅ 已收口（收口长什么样的样例） |
| 6 | 失败类别（跨版本产物） | `shared/delivery-receipt.ts:99` 仍是裸 `string` | 裸类型 | ❌ | ⚠️ 欠账 #16 |
| 7 | 并发上限 | `electron/engine/scheduler.ts:29` · `shared/types.ts:305` | 两处 `4` | ❌ | ⚠️ 欠账 #9 |
| 8 | stdout 截断 | `shared/agent-contract.ts:73` · `electron/engine/verifier.ts:51` | 两处常量 | ❌ | ⚠️ 欠账 #9 |
| 9 | 300_000（超时） | `electron/platform.ts:53` · `shared/http-clients.ts:145,274` · `electron/engine/verifier.ts:41` | 四处常量 | ❌ | ⚠️ 欠账 #9 |
| 10 | SenseNova 模型清单 | `shared/providers.ts:180` `SENSENOVA_MODELS` · `:189` `SENSENOVA_MODELS_EXTRA` · `:186` `SENSENOVA_KEY_VARS` | 三个数组 | 部分 | ⚠️ 待看：`_EXTRA` 这种"追加数组"是事实上的第二份值域 |
| 11 | 默认 LLM 池 | `shared/providers.ts:214` · `shared/types.ts:387` | 两处 `["sensenova","amd-radeon"]` | ❌ | ⚠️ 待收口 |
| 12 | `cli-agent` vs `http-bridge` | — | 两处各写一套命令面 | ❌ | ⚠️ §7 原记的那一对，**本轮未展开**（需成对读代码，下一轮） |

## 说明

### 第 2 项：默认仲裁模式的三处字面量

同一个"默认用回滚"这件事，在三处各写了一遍 `"revert-batch"`：

- `shared/types.ts:384` —— `DEFAULT_SETTINGS.arbitration`
- `electron/engine/batch-guard.ts:160` —— `this.mode = opts.mode ?? "revert-batch"`
- `electron/agents/index.ts:162` —— `const mode = opts.arbitration ?? "revert-batch"`

三处**互不引用**。改默认值要记得改三处，而漏掉任何一处都不会有任何东西变红
（值相同，测试照过）—— 这正是"只散落"型。

### 第 3 项：升级策略 4 档 vs 5 档

`headless/protocol.ts:61` 是 4 档（无人值守场景）；`shared/types.ts:371` 是 5 档
（多一个桌面端独有的 `"ask"` = 弹窗等人）。注释已写明这是**有意**的：
`"ask"` 在无人值守场景下无意义，所以不进协议。**它不是缺陷，但它是耦合** ——
将来协议新增一档，`shared/types.ts:371` 必须同改，而两处之间没有类型引用，
改漏了只有"运行时少一档入口"这一个症状。

### 第 5 项：FailureClass 是"收口长什么样"的样例

同一个概念此前有四处互不打招呼的声明（联合类型 / 裸 `string` / 无约束 /
手抄词表），收口做法是**把手抄换成编译期事实**：类型 + 值域常量 + 边界收窄器，
词表改 `Record<Union, string>`（少一档即编译错）。收窄器此前零调用者由
`check:unwired` 抓出。清单里其余各项的收口可以照这个形状做。

## 下一步（按优先级）

1. **机械重复、有明确单一真源可归**：第 2 / 7 / 8 / 9 / 11 项；
2. **需要决策**：第 3 / 4 项（`"ask"` 是桌面独有的第五档，怎么收口要定形状）；
3. **需要成对读代码**：第 12 项（`cli-agent` vs `http-bridge`）；
4. **盲区补扫**：`check:exhaustive-maps` 跳过的那 19 处联合类型，人工过一遍。
