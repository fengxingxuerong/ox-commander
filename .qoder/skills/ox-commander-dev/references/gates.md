# `npm run verify` 的 16 步逐条机制

顺序即 `package.json:35` 的 `verify` 串（`&&` 串联，**首段失败即中断**）。本机实测基线：EXIT 0、943 用例、约 2 分钟。
README 写「15 步 / 930 用例」是过时的（`check:packaged-paths` 加进来后没同步）。

| # | 步骤 | 实际执行 | 失败语义 |
| --- | --- | --- | --- |
| 1 | `typecheck` | `tsc -b` ×3 套 tsconfig | 编译错即红 |
| 2 | `lint` | `eslint .`（flat config） | error 即红；`react-hooks/exhaustive-deps` 只是 warn |
| 3 | `check:unwired` | `scripts/check-unwired.mjs` | 零生产调用导出 → 红；**豁免表项失效也红** |
| 4 | `check:scripts` | `scripts/check-syntax.mjs` | `scripts/**` 下 `.mjs/.cjs` 逐个 `node --check` |
| 5 | `check:scripts-wired` | `scripts/check-script-wiring.mjs` | 不可达脚本 → 红；失效 `ACCEPTED` → 红 |
| 6 | `check:packaged-paths` | `scripts/check-packaged-paths.mjs` | 打包后必坏的读路径判定 |
| 7 | `check:masker` | `scripts/masker-selftest.mjs` | 从 `mutation-check.mjs` 抠函数失败 → **exit 2** |
| 8 | `test` | `vitest run` | 用例失败即红；覆盖率**不**设阈值 |
| 9 | `mutation:quick` | `mutation-check.mjs --tier=1 --limit=1` | 最弱变异档，见下 |
| 10 | `build` | `tsc -b && vite build && tsc -b tsconfig.electron.json` | |
| 11 | `build:headless` | `tsc -b tsconfig.headless.json` | |
| 12 | `smoke:artifact` | `scripts/artifact-smoke.mjs` | 依赖 10/11 的产物 |
| 13-16 | `smoke:snapshot-secrets` / `smoke:gateway` / `smoke:coze` / `smoke:import` | 四个集成 IT | 读产物 + 占固定端口 |

**12-16 都读 `dist*/`**：手工单跑任何一条之前先 `npm run build && npm run build:headless`，否则红的是环境不是代码。

## 1. typecheck：三套互不相干的工程

- `tsconfig.json` → `src` + `shared`（strict，开 `noUnusedLocals` / `noUnusedParameters`，`noEmit`）
- `tsconfig.electron.json` → `electron` + `shared`，**会把 `electron/**/*.test.ts` 一起编进 `dist-electron`**
- `tsconfig.headless.json` → `headless,shared,electron/engine,electron/agents`（include 已与真实依赖脱节：
  `headless/run-spec.ts` 直接 import `../electron/platform`，传递拉进 `electron/sandbox`）
- `tsconfig.node.json`（管 `vite.config.mts` / `vitest.config.mts`）**不在任何 npm script 里 → 永不检查**

三套**没有 `references`**，`tsc -b` 是三个独立工程。两套后端 tsconfig 的 `lib` 只有 `ES2022`（无 DOM）——
这是 `shared/`  purity 唯一的机制保护。

> **假绿来源**：`tsc -b` 吃 `*.tsbuildinfo`（已 gitignore）。改过 tsconfig、删过文件之后，本地可能跳过重编而绿，
> CI 全新 checkout 不复现。怀疑时先删 buildinfo。

## 2. lint 的覆盖面

`eslint.config.mjs:16-23` 忽略 `docs/**` 与 `scripts/**` → **脚本层没有 lint，只有第 4 步的 `node --check` 一层保护**。
`no-undef` 与 `no-explicit-any` 关掉；未用变量允许 `_` 前缀；`react-hooks` 只作用在 `src/**/*.tsx`。

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

- `check-syntax.mjs:19` 只认 `.mjs|.cjs` → **`scripts/**/*.js` 两层都不覆盖**（例：`scripts/acceptance/csvstat-acceptance.test.js`）
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

## 8. vitest

- include 仅 `src/**/*.test.{ts,tsx}`、`shared/**/*.test.ts`、`electron/**/*.test.ts`
  → **`headless/**/*.test.ts` 与 `scripts/*.test.js` 静默不被收集**，而 `coverage.include` 却含 `headless/**`
- **没有 `thresholds` / `enforceThresholds`** → 覆盖率永不致红，别把它当门禁
- 没有 `setupFiles`、没有全局 environment；jsdom 靠文件首行 `// @vitest-environment jsdom`
- `resolve.alias.electron` → `src/__fakes__/electron.ts`（否则测试里 `require("electron")` 拿到的是二进制路径字符串，`ipcMain` 为 undefined）
- 真实 API 用例门控：`src/sensenova.smoke.test.ts` 要求 `OX_SMOKE==="1" && SENSENOVA_API_KEY`，`describe.skipIf` 默认跳过
- 平台条件用例的写法是**用例内早退** `if (process.platform === "win32") return;`，不是 `skipIf`

## 9. 变异门禁：四个口径，数字不可互换

`scripts/mutation-check.mjs`：`TARGETS` 是手工登记的 `{file, test|tests, tier}`（`:119-298`），7 个算子（`:332-340`），
`MAX_SURVIVORS = 0`（`:315`，任何存活位点即红），还会做"掩空自洽校验"（`siteTotal + maskedTotal === rawTotal`，`:956`）。

| 命令 | 语义 | 强度 |
| --- | --- | --- |
| `mutation:quick` | `--tier=1 --limit=1`：每个 tier-1 目标**只跑 1 个 aggregate 变异** | 最弱，verify 用的是它 |
| `mutation` | aggregate，`--limit=8` | 每算子至少一处被覆盖即算过 |
| `mutation:site` | site，`--limit=8` | 逐位点 |
| `mutation:audit` | `--mode=site --limit=999`：全 tier 全位点 | 最强，**本机 verify 完全不覆盖** |

`--limit=N` 是**每个目标** `all.slice(0,N)`，不是全局。aggregate 用 `replaceAll` 一次改掉某算子全部位点，
"任一处被杀"就报杀死 → **它报的 100% 可能是假象**。

**白名单 `EQUIVALENT_SITES`（`:365-496`，9 条）** 语义是"可证明等价 / 有意保留的防御冗余"，
条目形状 `{file, op, line}`，`op` 用算子**中文名原文精确串**匹配，**行号是锚点**：

- site 模式精确匹配行号；aggregate 用 `changedLines` 近似
- **在锚定文件里插行/删行使行号漂移 → 变异重新出现 → 门禁红**。处置是"按新行号校回 + 重新确认那两层防御仍在"，
  并保留条目里的论证注释（那些注释就是"为什么这条不该被杀"的唯一记录）
- 当前锚定：`kill-tree.ts:37`、`path-policy.ts:92`、`router.ts:193`、`shared/schema.ts:184`、
  `spawn-plan.ts:96`、`http-bridge.ts:309`、`sensenova-api.ts:331` / `:337`、`ipc/context.ts:177`

> `mutation-check` 会**临时改写源文件**再还原；中途被打断或崩溃可能留脏 → 跑完 `git status` 必查。

## 12-16. 产物与集成 IT

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
