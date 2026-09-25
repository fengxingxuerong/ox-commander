# `npm run verify` 的 19 步逐条机制

顺序即 `package.json` 的 `verify` 串（`&&` 串联，**首段失败即中断**）。本机实测基线：EXIT 0、19 段、1004 用例（995 passed + 9 skipped）。
README 曾写「15 步 / 930 用例」是过时的（每次往链里加一步都要同步，否则同类漂移会再发生一次）。

| # | 步骤 | 实际执行 | 失败语义 |
| --- | --- | --- | --- |
| 1 | `typecheck` | `tsc -p <proj> --noEmit --incremental false` ×4 套（renderer / electron / headless / vite 配置） | 编译错即红 |

> **为什么不是 `tsc -b`**：增量构建缓存会**跳过它认为没变的文件**并给绿。2026-09-24 实测：
> 一个用了未导入标识符（`path`）的新函数，`tsc -b` 全绿放行，`tsc -p --noEmit --incremental false`
> 立刻报 `TS2304: Cannot find name 'path'` 等三处。代价约 +6s（3.5s → 8.3s 三连）。
> `build` / `build:headless` 仍用 `tsc -b`，因为它们要产出 `dist-electron`/`dist-headless`。
| 2 | `lint` | `eslint .`（flat config） | error 即红；`react-hooks/exhaustive-deps` 只是 warn |
| 3 | `check:unwired` | `scripts/check-unwired.mjs` | 零生产调用导出 → 红；**豁免表项失效也红** |
| 4 | `check:scripts` | `scripts/check-syntax.mjs` | `scripts/**` 下 `.mjs/.cjs/.js` 逐个 `node --check` |
| 5 | `check:scripts-wired` | `scripts/check-script-wiring.mjs` | 不可达脚本 → 红；失效 `ACCEPTED` → 红 |
| 6 | `check:packaged-paths` | `scripts/check-packaged-paths.mjs` | 打包后必坏的读路径判定 |
| 7 | `check:masker` | `scripts/masker-selftest.mjs` | 从 `mutation-check.mjs` 抠函数失败 → **exit 2** |
| 8 | `check:tests-collected` | `scripts/check-tests-collected.mjs` | 盘上有但 vitest 不收集的测试文件 → 红；**收集不到任何文件也红** |
| 9 | `test` | `vitest run` | 用例失败即红；覆盖率**不**设阈值 |
| 10 | `mutation:quick` | `mutation-check.mjs --tier=1 --limit=1` | 最弱变异档，见下 |
| 11 | `build` | `tsc -b && vite build && tsc -b tsconfig.electron.json` | |
| 12 | `build:headless` | `tsc -b tsconfig.headless.json` | |
| 13 | `smoke:artifact` | `scripts/artifact-smoke.mjs` | 依赖 11/12 的产物 |
| 14-17 | `smoke:snapshot-secrets` / `smoke:gateway` / `smoke:coze` / `smoke:import` | 四个集成 IT | 读产物 + 占固定端口 |
| 18 | `smoke:offline-e2e` | `offline-e2e-it.mjs`：本地假大脑（占 **11434**，冒充 ollama）+ 假 http-bridge 智能体，经真 `dist-headless` 跑**四个场景**（win32 39 项 / POSIX 41 项断言，差的 2 项是 SIGTERM 投递） | 零配额；交付路径 / 越权回滚与重修范围 / 基线归因 / 中断-续跑；退出码 0、2 与被杀的 `null` |

**13-18 都读 `dist*/`**：手工单跑任何一条之前先 `npm run build && npm run build:headless`，否则红的是环境不是代码。

## 1. typecheck：三套互不相干的工程

- `tsconfig.json` → `src` + `shared`（strict，开 `noUnusedLocals` / `noUnusedParameters`，`noEmit`）
- `tsconfig.electron.json` → `electron` + `shared`，**会把 `electron/**/*.test.ts` 一起编进 `dist-electron`**
- `tsconfig.headless.json` → `headless,shared,electron/engine,electron/agents`（include 已与真实依赖脱节：
  `headless/run-spec.ts` 直接 import `../electron/platform`，传递拉进 `electron/sandbox`）
- `tsconfig.node.json`（管 `vite.config.mts` / `vitest.config.mts`）**不在任何 npm script 里 → 永不检查**

三套**没有 `references`**，`tsc -b` 是三个独立工程。两套后端 tsconfig 的 `lib` 只有 `ES2022`（无 DOM）——
这是 `shared/`  purity 唯一的机制保护。

> **曾经的假绿来源（2026-09-24 起已由门禁本身解决）**：`tsc -b` 吃 `*.tsbuildinfo`（已 gitignore），
> 改过 tsconfig、删过文件之后本地可能跳过重编而绿，CI 全新 checkout 不复现。现在第 1 步走
> `--incremental false`，所以**本地绿与 CI 绿是同一件事**。仍会产 `.tsbuildinfo` 的是
> `build` / `build:headless`（它们要产出），怀疑产物脏就删 buildinfo 重跑。

## 2. lint 的覆盖面

`eslint.config.mjs:16-23` 忽略 `docs/**` 与 `scripts/**` → **脚本层没有 lint，只有第 4 步的 `node --check` 一层保护**。
`no-undef` 与 `no-explicit-any` 关掉；未用变量允许 `_` 前缀；`react-hooks` 只作用在 `src/**/*.tsx`。

**`shared/**/*.ts` 有一条 `no-restricted-imports` 红线**（2026-09-25 立）：禁 `node:*` 与裸 node 内建、
禁 `electron|react|react-dom|zustand`、禁 `../electron/**|../headless/**|../src/**`。
落地时该层对外 import 数为 0，所以是零违规的纯增量，**只拦未来**。
反向验证：`shared/` 里临时 `import fs from "node:fs"` 或 `from "../electron/platform"` → lint 立刻红并点名。
**故意没给 `headless/**` 加同类规则**：`run-spec.ts` 现在经 `electron/platform` 拉进 `electron/sandbox`，
加了当场就红 —— 那条要先解依赖，不能靠规则硬压。

## 3. `check:unwired` 的判据细节

- 扫描目录 `["shared","electron","src","headless"]`（`:25`），跳过 `node_modules|dist*|coverage|.git|__fakes__`（`:38`）
- 只查**运行时导出**：`function` / `const` / `class` / `let` / `var` / `enum` 以及 `export {}` 列表
- `type` / `interface` / `export default` **不查**
- 消费者判定**排除测试文件**（既不当导出者也不当消费者）→ **只被测试引用的新导出必红**
- 同一文件内的二次引用算已接线
- 豁免表 `ACCEPTED: Map<`文件::符号`, 理由>`（`:44-52`，当前 4 条）：
  新增未接线 FAIL，**表项指向的符号消失也 FAIL**（`:150-158`）→ 删代码要顺手删条目
- `node scripts/check-unwired.mjs --list` 打印当前真实命中项，用于维护

> 反向坑：生产文件的**注释里提一次符号名**就能满足"全文词匹配"从而骗过它。别把门禁当设计审查用。

## 4-5. 脚本层的两道门

- `check-syntax.mjs:19` 认 `.mjs|.cjs|.js`（`.js` 是 2026-09-25 加的，此前 `scripts/acceptance/csvstat-acceptance.test.js` 两层都不覆盖）。
  `.js` 按 **CommonJS** 解析（本仓库 package.json 无 `"type":"module"`）→ `scripts/` 下要写 ESM 就**改成 `.mjs`**，别放宽门禁
- `check-script-wiring.mjs`：
  - 入口 = package.json 各 script 值里出现的 `scripts/<name>.mjs|cjs`
  - 边 = **纯子串 `text.includes(另一个脚本名)`**（注释里提一句就成边；`docs/**` 的提及不算）
  - 从入口 BFS 求可达；门禁自身排除
  - 不可达脚本 FAIL（`:147-157`），失效 `ACCEPTED` FAIL（`:138-145`）
  - 白名单以 `ACCEPTED_ENTRIES` 数组登记，建 Map **之前**先查重复键 → 重复即红
    （旧版是 Map 字面量，里面同时登记过两次 `loomy-bridge.mjs`，被覆盖的那条理由静默消失）

## 6. `check:packaged-paths`

只扫 `electron` + `shared` 的 ts/mts/cts。三条**同时**命中才 FAIL：出现 `getAppPath` + 出现
`readFileSync|existsSync|readFile` + **没有** `getPath("userData"|"exe")`。它的 `ACCEPTED` 是空 Set 且**无失效检查**。
用途是钉死"打包后 `__dirname` 变化导致读不到文件"这一类缺陷。

## 7. `check:masker`

用 `indexOf("function regexMayStartAt")` 和 `indexOf("/** 1-based 行号。 */")` 从 `mutation-check.mjs` 里抠函数体，
锚点字符串一改就 **exit 2**；随后跑 24 个位点用例。**改 `mutation-check.mjs` 时这两个锚点不能动。**

## 8. `check:tests-collected`（2026-09-25 新增）

扫 `src|shared|electron|headless|scripts` 下所有 `*.test.{ts,tsx,js,mjs,cjs}`（跳过 `node_modules|dist*|coverage|release|.git`），
与 **`vitest list --filesOnly` 的真实输出**做差集。差集里的每一项必须在 `ACCEPTED`（当前 1 条：
`scripts/acceptance/csvstat-acceptance.test.js`，理由是它 require 的是被验收项目的文件，在本仓库跑不起来），
否则 FAIL。`ACCEPTED` 重复键 / 失效条目同样 FAIL。

- 刻意**不**自己解析 `vitest.config.mts` 的 include 再匹配 glob：那要重实现 picomatch 语义，
  一旦与 vitest 的真实行为分叉，这道门禁查的就不是它声称在查的东西。代价是 ~6s（spawn 一个 vitest）
- **`vitest list` 失败或产出空集合 → FAIL**（不是"没有未收集项"）：收集过程坏了却报绿，
  是"基线失败被静默容忍"的同一类空转
- 与第 5 步同族：那边抓"写好的脚本没接进入口"，这边抓"写好的测试没进收集范围"

## 9. vitest

- include 为 `src/**/*.test.{ts,tsx}`、`shared/**/*.test.ts`、`electron/**/*.test.ts`、**`headless/**/*.test.ts`**
  （最后一项 2026-09-25 补上；此前 `coverage.include` 含 `headless/**` 而 include 不含 →
  往 headless 加测试会"不执行但计入覆盖率"）。`scripts/*.test.js` 仍不被收集，靠第 8 步的 ACCEPTED 兜住
- **没有 `thresholds` / `enforceThresholds`** → 覆盖率永不致红，别把它当门禁
- 没有 `setupFiles`、没有全局 environment；jsdom 靠文件首行 `// @vitest-environment jsdom`
- `resolve.alias.electron` → `src/__fakes__/electron.ts`（否则测试里 `require("electron")` 拿到的是二进制路径字符串，`ipcMain` 为 undefined）
- 真实 API 用例门控：`src/sensenova.smoke.test.ts` 要求 `OX_SMOKE==="1" && SENSENOVA_API_KEY`，`describe.skipIf` 默认跳过
- 平台条件用例的写法是**用例内早退** `if (process.platform === "win32") return;`，不是 `skipIf`

## 10. 变异门禁：四个口径，数字不可互换

`scripts/mutation-check.mjs`：`TARGETS` 是手工登记的 `{file, test|tests, tier}`（`:119-303`），7 个算子（`:337-345`），
`MAX_SURVIVORS = 0`（`:320`，任何存活位点即红），还会做"掩空自洽校验"（`siteTotal + maskedTotal === rawTotal`，`:964`）。

| 命令 | 语义 | 强度 |
| --- | --- | --- |
| `mutation:quick` | `--tier=1 --limit=1`：每个 tier-1 目标**只跑 1 个 aggregate 变异** | 最弱，verify 用的是它 |
| `mutation` | aggregate，`--limit=8` | 每算子至少一处被覆盖即算过 |
| `mutation:site` | site，`--limit=8` | 逐位点 |
| `mutation:audit` | `--mode=site --limit=999`：全 tier 全位点 | 最强，**本机 verify 完全不覆盖** |

`--limit=N` 是**每个目标** `all.slice(0,N)`，不是全局。aggregate 用 `replaceAll` 一次改掉某算子全部位点，
"任一处被杀"就报杀死 → **它报的 100% 可能是假象**。

**白名单 `EQUIVALENT_SITES`（`:370-504`，9 条）** 语义是"可证明等价 / 有意保留的防御冗余"，
条目形状 `{file, op, line}`，`op` 用算子**中文名原文精确串**匹配，**行号是锚点**：

- site 模式精确匹配行号；aggregate 用 `changedLines` 近似
- **在锚定文件里插行/删行使行号漂移 → 变异重新出现 → 门禁红**。处置是"按新行号校回 + 重新确认那两层防御仍在"，
  并保留条目里的论证注释（那些注释就是"为什么这条不该被杀"的唯一记录）
- 当前锚定：`kill-tree.ts:37`、`path-policy.ts:92`、`router.ts:193`、`shared/schema.ts:184`、
  `spawn-plan.ts:96`、`http-bridge.ts:309`、`sensenova-api.ts:337` / `:343`、`ipc/context.ts:177`

> `mutation-check` 会**临时改写源文件**再还原；中途被打断或崩溃可能留脏 → 跑完 `git status` 必查。
>
> ⚠️ **改动引擎控制流（多跑一次 `deps.verify` 之类）之后，必须复跑 site 口径**：
> `mutation-check` 的 `verify` 桩是按**调用次序**脚本化的，多一次调用会让某些用例
> 悄悄不再触达它要钉的属性 —— 用例照样全绿，位点却从此存活。2026-09-24 加基线验证时
> 实测到：`[413]`（待修任务只算"没完成且没跳过"的）被缴械，症状是
> `&& → || @463` 稳定存活，而 `npm test` 一句都不红。
> 另一个同类陷阱：往重修上下文里**复制失败摘要**会冲掉"这条线索归谁"的断言依据，
> 所以基线注记只报命令名与退出码，原因留在给操作者的日志里。

## 13-18. 产物与集成 IT

- `artifact-smoke.mjs`：累计 `failed` 不早退；查 `dist/index.html` 存在、`dist-electron/**/*.js` 全量 `node --check`、
  headless 两次 stdin 协议退出码
- `e2e-snapshot-secrets.cjs`：直接 `require` 构建产物 `dist-electron/electron/agents/sensenova-api.js`，
  mock fetch 断言外发 prompt 不含密钥（6 项）
- `admission-gateway-it.mjs`：spawn 真网关子进程，**硬编码端口 8941 + 固定 1500ms sleep**
- `coze-bridge-it.mjs`：占 **8933 / 8934**
- `import-headless-run-it.mjs`：`spawnSync` 打 `scripts/import-headless-run.mjs`，断退出码与 stderr 文案

固定端口 + 固定 sleep ⇒ **并发跑、或机器负载高时会假红**。判定方法是单跑复现，而不是"重跑一次绿了就归因环境"。

## CI 与本机 verify 的口径差

`.github/workflows/verify.yml`：

- `verify` job：矩阵 `ubuntu-latest` + `windows-latest`，node 22，`ELECTRON_SKIP_BINARY_DOWNLOAD=1`，
  `npm ci` + `npm run verify`，**无 `timeout-minutes`**
- `mutation-full` job：**只在 ubuntu**、`timeout-minutes: 35`、跑 `npm run mutation:audit`
  → site 口径全位点在本机 verify 里**从不执行**，锚定文件改动的真实回归面只有推上去才知道

`.github/workflows/release.yml`：打 tag 直接 `build:dist`，**不先跑 verify**。

> 本机没装 `gh`：读 workflow 只能推断，别把"文件里写了"当成"CI 跑过"。要结论就去 Actions 页看，或先装 `gh`。

## 边界：site 审计的算子集不含数值比较

`--list` 实测（2026-09-25）：`electron/engine/orchestrator.ts` 的 29 个位点只来自
`&& → ||`、`|| → &&`、`=== → !==`、`!== → ===` 四种算子。**`<=` / `>=` / `<` / `>` 不在算子集内**
（脚本文件头「已知局限 2」自己写了"抓不到数值边界写错"）。

所以 `PASS: 无存活变异 —— 全部 N 处位点已逐点验证` 这句话**不能给数值边界类断言作证**。
引用它之前先问：我新写的那几处是不是那四种算子之一？不是的话，该位点根本不在审计范围内，
"全杀"与它无关。这类判据的机制只能靠**差分**（摘掉实现必须红）或扩算子集
（脚本要求扩之前先确认不会引入等价变异噪声，且那会改变位点总数）。
