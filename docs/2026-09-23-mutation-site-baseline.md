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

| 口径 | 2026-09-22（§16.1） | 2026-09-23（本文件） | 2026-09-23 二轮（usage 两轮后） | **2026-09-24 CI 终章** | 2026-09-25 本机复测（win32） | 2026-09-27 本机复测（win32） |
| --- | --- | --- | --- | --- | --- |
| aggregate（`npm run mutation`） | 152/152（100%） | 未重跑；verify 内 `mutation:quick` 为 10/10 | 未重跑（verify 内 `mutation:quick` 持续参与门禁） | 同左 | 162/162（100%） |
| **site（`--mode=site`）** | 486/581（**84%**） | **577/577（100%）** | **594/594（100%）**（处置后） | **590/590（100%）· CI 三 job 首次全绿** | **603/603（100%）** | **701/701（100%）**（09-28 六轮，见下） |
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

## 四轮快照：2026-09-27 本机 Windows 全量（680/680）

基线数字最后一次更新是 2026-09-25 的 603/603，而 09-25～09-27 之间
（v0.1.5→v0.1.7，含执行器超时可配、并发硬上限、交付改 OXFILE 原文块、
线路速度画像、PRD 路径提取器）**新增/重写了大量判定逻辑**。本轮重跑全量，
并按第九批口径把 4 个从未进过变异门禁的模块纳管：

```
node scripts/mutation-check.mjs --mode=site --limit=999
# 总计：杀死 680/680（100%）   耗时 1740.5s（29.0 min）
#   其中 单点杀死 680 · 聚合杀死 0
```

分母 603 → 680 的来路：新登记 `shared/deliverable-format.ts`（17）、
`shared/routing.ts`（4）、`shared/prompts.ts`（1）、`electron/store.ts`（6），
加上既有目标在这几轮里长出来的新位点（protocol / scheduler / http-clients / orchestrator 等）。

**本轮唯一的存活点全在新模块 `shared/deliverable-format.ts`（首跑 12/17，5 处存活）**，
且全部是真缺口而非等价变异 —— 这个模块是 09-26/27 实弹演习逼出来的，写完之后
只有行为测试、**从没有过变异门禁**：

| 位点 | 变异 | 为什么是缺口 | 补的断言 |
| --- | --- | --- | --- |
| 92 | `\|\| → &&` | `pathIsAbsolute` 三条判定里只有盘符形态被测到；POSIX 根 `/etc/passwd` 与 UNC 改坏后被拼成 `zone//etc/passwd`，逃逸判定根本不发生 | 原样返回 POSIX 根与 UNC |
| 131 | `continue → break` | summary 行出现在文件块**之前**时（模型常见吐法），`break` 让后面的块整段丢失；旧用例 summary 永远在最后 | summary 先于块、summary 夹在两个块之间，都要解析到后续块 |
| 159 | `&& → \|\|` | `files` 不是数组（漏方括号）或为空数组时会被当成合法交付往下传 | 两种形状都要求抛错 |
| 162 | `=== → !==` | `summary` 非字符串时原样透传，类型契约没人守 | `summary: 42` → 期望 `""` |
| 183 | `\|\| → &&` | 「有 `}` 无 `{`」这类畸形文本不再报统一根因，而是漏出 `JSON.parse` 的原生错 | 两种畸形都断言同一条消息 |

5 条补完后复测 **17/17**；另三个新目标首跑即全杀（routing 4/4、prompts 1/1、electron/store 6/6）。

**这一轮的教训是"新模块不会自己进门禁"**：交付格式这种解析**模型输出（不可信输入）**
的模块，写完时配套的 35 条用例看着很全，但位点里 29% 是裸的。
以后每新增一个 `shared/` 或 `electron/` 下的纯逻辑模块，登记 TARGETS 应作为**收尾动作**，
而不是等下一次全量 audit 才被发现。

## 五轮快照：2026-09-27 第二轮 · 本机 Windows 全量（695/695）

同日紧接着再跑一次全量（上一节 680/680 的数据在提交 `da825e4` 之前）。本轮
新增第十批两个目标，并处置了因改动 `sensenova-api.ts` 而被 `mutation:touched`
翻出来的两个存活点：

```
node scripts/mutation-check.mjs --mode=site --limit=999
# 总计：杀死 695/695（100%）   耗时 1791.9s（29.9 min）
#   其中 单点杀死 695 · 聚合杀死 0
```

分母 680 → 695 的来路：新登记 `electron/audit-log.ts`（11）、
`electron/agents/index.ts`（2），以及 `sensenova-api.ts` 的 32 → 34
（`readSnapshotContents` 从私有方法提成模块级函数后，原先被类方法形态排除的
两处位点进入了统计）。

**这三个存活点都不是「断言不敏感」，而是「根本没有输入能走到那一行」** ——
按原样补断言一条也加不出来：

| 位点 | 变异 | 为什么此前是绿的 | 处置 |
| --- | --- | --- | --- |
| `readSnapshotContents` 的凭据 `continue → break` | 二次防线 | Phase 1 的 walk 已用**同一个** `isSecretLikeFile` 过滤一遍，凭据文件永远到不了这一层 —— 防线拿不到「守住了」的证据，只有「还没被需要」 | 私有方法提成模块级导出函数，入参显式化成 `statEntries`，测试可直接喂「上游漏过来的」条目 |
| 同上，读不出来时的 `continue → break` | 二次防线 | `stat` 成功到 `readFileSync` 失败之间只能靠 TOCTOU（文件被删/权限变），确定性输入构造不出来 | 同上；条目直接给一个不存在的 `rel` |
| `createDefaultAdapters` 的 `!== undefined → === undefined` | 配置透传末跳 | 协议 → settings → `createAgentLayer` 前三跳都有断言，**最后一跳没有出口可观测**：宿主设了 `executorTimeoutMs` 而适配器仍用内置默认 300s，没有任何测试会发现 | `requestTimeoutMs` 刻意改为非 private（可测化），补「传入生效 / 省略回落」两条断言 |

另删掉 `electron/agents/index.ts` 的 `findAdapter` —— 生产零调用（调度器用的是
自己的私有同名方法），它唯一的作用是贡献一个永远杀不死的位点。

**教训**：存活变异的处置顺序应该是「先问有没有输入能走到这一行」，再谈断言够
不够狠。上面三处里，两处是纵深防御不可达、一处是链路末跳不可观测 —— 正确解法
都是**把入参/落点显式化**（让它可测），而不是写进 `EQUIVALENT_SITES`。

同批还修了**门禁自身**的一个洞：进程被强杀时（`TerminateProcess`）内存里的
还原钩子一个都不执行，变异体会永久留在工作区（本轮实锤：`--file=store.ts`
子串误命中一堆 store、命令超时被杀后 `snapshot-store.ts` 留着 `continue → break`）。
现在改写源文件前先把原文落盘（`scripts/.mutation-pending/`），下次启动自愈。
## 六轮快照：2026-09-28 · 本机 Windows 全量（701/701）

```
node scripts/mutation-check.mjs --mode=site --limit=999
# 总计：杀死 701/701（100%）   耗时 1699.7s（28.3 min）
#   其中 单点杀死 701 · 聚合杀死 0
```

**这一轮把「扩目标」这条路走到了头**：新增第十批 3 个目标后 TARGETS 48 → 51，
剩下的未纳管模块逐个看过源码，确认都不该纳管 ——

| 类别 | 模块 | 为什么不该纳管 |
| --- | --- | --- |
| 纯类型 | `shared/types.ts`、`src/types.ts` | 无运行时逻辑 |
| 纯 re-export | `electron/sandbox/index.ts`、`electron/engine/index.ts` | 只有 export 语句 |
| 纯注册器 | `electron/ipc.ts` | 554 行拆薄后只剩 5 行调用，零判定 |
| 零算子位点 | `electron/preload.ts` | IPC 桥，全是 `ipcRenderer.invoke("channel")`，算子表里没有一个能匹配 |
| 入口胶水 | `headless/headless-main.ts` | 判定要 stdin / 信号才能驱动 |
| 测试替身 | `src/__fakes__/*` | 不是生产逻辑 |

分母 695 → 701 的来路：第十一批三个 LLM 网关目标 `shared/providers.ts`（2）、
`shared/build-llm.ts`（3）、`shared/agent-contract.ts`（1）。

**`build-llm.ts` 首跑 1/3（2 处存活），处置方式和上一轮同源**：线路组装只活在
`buildLlmPool` 内部 —— 判错不抛异常（sensenova 的 3×4=12 条线路塌成 3×1=3 条，
或把 SenseNova 的模型名发给 AMD 的端点），且没有出口可观测。提成纯函数
`buildPoolRoutes` 后补 4 条断言（默认池及顺序 / 空数组回落 / 各 provider 的 key 与
模型 / 单点名），两处均被杀死。

**下一步只能动算子表**：现 7 个算子（`&&` `||` `===` `!==` `return true`/`false`
`continue`）覆盖不到三元、`??`、取反与比较符 —— 而本项目大量回退逻辑正是
`cond ? x : y` 与 `a ?? default` 的形状（例如 `normalizeCapabilities` 里 4 处
「空数组回填默认值」的判定，当前**一个都测不到**）。加算子的代价是位点数与
存活量同步上涨，需要先在子集上试跑评估。
## 三元算子评估：2026-09-28（875/931，94% · 56 处待处置）

新增「三元分支互换」算子（`cond ? A : B` → `cond ? B : A`）后的**首次全量评估**。
算子默认关闭，用 `--ops=ternary` 显式打开 —— 目的是先量存活量，再决定要不要进 `verify`。

```
node scripts/mutation-check.mjs --ops=ternary --mode=site --limit=999
# 总计：杀死 875/931（94%）   耗时 2544.2s（42.4 min）
# FAIL: 56 个变异存活
```

**基础算子仍是 701/701 全杀 —— 56 处存活全部来自新算子，且逐条看过 diff，无一是等价变异。**
也就是说：这一刀砍下去，露出来的全是真缺口，`cond ? x : y` 这一族判定此前从未被验证过。

### 分类与处置路径

| 类别 | 数量 | 代表位点 | 处置路径 |
| --- | --- | --- | --- |
| **A 条件展开透传** `...(x ? { x } : {})` | 38 | `manifest-loader` @186/@187/@189、`agents/index` @139、`platform` @174、`scheduler` @408 | 以**简化源码**为主：接收侧容忍 `undefined` 时直接 `x: x` 与条件展开等价（一行消灭一个位点，`onEvent` 那次已验证）；不能简化的补「字段真的到了接收侧」断言 |
| **B 默认值 / 回退三元** | 9 | `manifest-schema` @113（artifactKinds 回填默认）、@133（bearerFile 凭据构造）、`path-policy` @209（`d.ok ? 规范化 : d`） | 补断言 —— 这正是「错了也不报错」的核心族（凭据被判成 `undefined` = 静默不鉴权） |
| **C 排序比较器** | 3 | `run-spec` @89、`sensenova-api` @428（嵌套两层） | 补断言：断言**排序结果**（谁在前），不要断言比较器实现 |
| **D 错误信息取字段** | 4 | `http-clients` @466（`e instanceof Error ? e.message : String(e)`）、`deliverable-format` @169 | 补断言：畸形输入下错误消息里要带上原始 message，而不是 `[object Object]` |
| **E 装配分支** | 2 | `agents/index` @106（`manifestDir ? 加载 : 空集`）、@108（`m.source ? m : 补 source`） | 补断言 |

### 启用前置条件

56 处处置完之前**不要**把三元算子放进 `verify`（`mutation:quick` 会跑 aggregate，
任何一处存活都会让门禁长期红）。建议分批：按文件处置 → 该文件复跑 `--ops=ternary` 全杀 →
再进下一批。A 类那 38 处如果集中在少数几个透传链模块上，用简化源码的方法批量消灭最快。

### 完整清单（56 处，按文件分组）

```
存活总计 56 处，分布在 18 个文件

## electron/agents/manifest-schema.ts  (8)
  @109
    - ...(protocolVersion ? { protocolVersion } : {}),
    + ...(protocolVersion ? {}: { protocolVersion } ),
  @113
    - artifactKinds: artifactKinds.length > 0 ? artifactKinds : ["files", "logs"],
    + artifactKinds: artifactKinds.length > 0 ? ["files", "logs"]: artifactKinds ,
  @133
    - return tokenFile ? { kind: "bearerFile", tokenFile } : undefined;
    + return tokenFile ? undefined: { kind: "bearerFile", tokenFile } ;
  @186
    - ...(probeArgs ? { probeArgs } : {}),
    + ...(probeArgs ? {}: { probeArgs } ),
  @187
    - ...(envTemplate ? { envTemplate } : {}),
    + ...(envTemplate ? {}: { envTemplate } ),
  @200
    - const headers = isObj(raw.headers) ? (raw.headers as Record<string, string>) : undefined;
    + const headers = isObj(raw.headers) ? undefined: (raw.headers as Record<string, string>) ;
  @205
    - ...(healthPath ? { healthPath } : {}),
    + ...(healthPath ? {}: { healthPath } ),
  @208
    - ...(headers ? { headers } : {}),
    + ...(headers ? {}: { headers } ),

## electron/agents/manifest-loader.ts  (7)
  @186
    - ...(m.entry.probeArgs ? { probeArgs: m.entry.probeArgs } : {}),
    + ...(m.entry.probeArgs ? {}: { probeArgs: m.entry.probeArgs } ),
  @187
    - ...(m.entry.envTemplate ? { envTemplate: m.entry.envTemplate } : {}),
    + ...(m.entry.envTemplate ? {}: { envTemplate: m.entry.envTemplate } ),
  @189
    - ...(limits ? { limits } : {}),
    + ...(limits ? {}: { limits } ),
  @201
    - ...(m.entry.healthPath ? { healthPath: m.entry.healthPath } : {}),
    + ...(m.entry.healthPath ? {}: { healthPath: m.entry.healthPath } ),
  @204
    - ...(m.entry.headers ? { headers: m.entry.headers } : {}),
    + ...(m.entry.headers ? {}: { headers: m.entry.headers } ),
  @205
    - ...(m.credential ? { credential: m.credential } : {}),
    + ...(m.credential ? {}: { credential: m.credential } ),
  @207
    - ...(limits ? { limits } : {}),
    + ...(limits ? {}: { limits } ),

## electron/agents/index.ts  (7)
  @32
    - ...(meter ? { meter } : {}),
    + ...(meter ? {}: { meter } ),
  @106
    - const loaded = opts.manifestDir ? loadManifestDir(opts.manifestDir) : { manifests: [], errors: [] };
    + const loaded = opts.manifestDir ? { manifests: [], errors: [] }: loadManifestDir(opts.manifestDir) ;
  @108
    - ...(opts.manifests ?? []).map((m) => (m.source ? m : { ...m, source: "declared" as const })),
    + ...(opts.manifests ?? []).map((m) => (m.source ? { ...m, source: "declared" as const }: m )),
  @112
    - ...(opts.promptDir ? { promptDir: opts.promptDir } : {}),
    + ...(opts.promptDir ? {}: { promptDir: opts.promptDir } ),
  @138
    - ...(opts.sharedPaths ? { sharedPaths: opts.sharedPaths } : {}),
    + ...(opts.sharedPaths ? {}: { sharedPaths: opts.sharedPaths } ),
  @139
    - ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    + ...(opts.onEvent ? {}: { onEvent: opts.onEvent } ),
  @140
    - ...(opts.onVerdict ? { onVerdict: opts.onVerdict } : {}),
    + ...(opts.onVerdict ? {}: { onVerdict: opts.onVerdict } ),

## headless/run-spec.ts  (5)
  @89
    - for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    + for (const entry of entries.sort((a, b) => (a.name < b.name ? 1: -1 ))) {
  @196
    - ...(r.ok ? {} : { logDigest: r.logDigest.slice(0, 400) }),
    + ...(r.ok ? { logDigest: r.logDigest.slice(0, 400) }: {} ),
  @234
    - ...(spec.manifestDir ? { manifestDir: spec.manifestDir } : {}),
    + ...(spec.manifestDir ? {}: { manifestDir: spec.manifestDir } ),
  @258
    - ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
    + ...(outcome.errorClass ? {}: { errorClass: outcome.errorClass } ),
  @271
    - ? { requestEscalationDecision: callbacks.requestEscalationDecision }
    + ? {}: { requestEscalationDecision: callbacks.requestEscalationDecision }

## electron/agents/sensenova-api.ts  (4)
  @163
    - maxConcurrency: Number.isFinite(limit) ? Math.max(1, limit) : SENSENOVA_KEY_VARS.length,
    + maxConcurrency: Number.isFinite(limit) ? SENSENOVA_KEY_VARS.length: Math.max(1, limit) ,
  @241
    - this.sharedFailover = this.meter ? meteredLlm(failover, this.meter) : failover;
    + this.sharedFailover = this.meter ? failover: meteredLlm(failover, this.meter) ;
  @428
    - statEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    + statEntries.sort((a, b) => (a.rel < b.rel ? a.rel > b.rel ? 1 : 0: -1 ));
  @428
    - statEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    + statEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 0: 1 ));

## electron/platform.ts  (4)
  @174
    - ...(config.manifests ? { manifests: config.manifests } : {}),
    + ...(config.manifests ? {}: { manifests: config.manifests } ),
  @175
    - ...(config.manifestDir ? { manifestDir: config.manifestDir } : {}),
    + ...(config.manifestDir ? {}: { manifestDir: config.manifestDir } ),
  @233
    - ? { requestEscalationDecision: host.requestEscalationDecision }
    + ? {}: { requestEscalationDecision: host.requestEscalationDecision }
  @247
    - ...(config.journal ? { journal: config.journal } : {}),
    + ...(config.journal ? {}: { journal: config.journal } ),

## electron/engine/scheduler.ts  (3)
  @121
    - return n <= 0 ? Number.POSITIVE_INFINITY : n;
    + return n <= 0 ? n: Number.POSITIVE_INFINITY ;
  @244
    - this.opts.registry.candidates({ task, ...(requiredTags ? { requiredTags } : {}) }).map((d) => d.manifest.id),
    + this.opts.registry.candidates({ task, ...(requiredTags ? {}: { requiredTags } ) }).map((d) => d.manifest.id),
  @408
    - ...(repair ? { repairContext: repair } : {}),
    + ...(repair ? {}: { repairContext: repair } ),

## electron/agents/registry.ts  (3)
  @73
    - ? { credential: spec.manifest?.credential ?? adapter.credential }
    + ? {}: { credential: spec.manifest?.credential ?? adapter.credential }
  @76
    - ? { limits: spec.manifest?.limits ?? adapter.limits }
    + ? {}: { limits: spec.manifest?.limits ?? adapter.limits }
  @230
    - return declared ? { adapter, manifest: declared } : { adapter };
    + return declared ? { adapter }: { adapter, manifest: declared } ;

## electron/sandbox/path-policy.ts  (2)
  @209
    - return d.ok ? { ok: true, abs: d.abs } : d;
    + return d.ok ? d: { ok: true, abs: d.abs } ;
  @241
    - return new PathPolicy({ projectRoot, ...(zone ? { zoneMode: zone } : {}) });
    + return new PathPolicy({ projectRoot, ...(zone ? {}: { zoneMode: zone } ) });

## electron/engine/orchestrator.ts  (2)
  @483
    - ...(o.agentId ? { agentId: o.agentId } : {}),
    + ...(o.agentId ? {}: { agentId: o.agentId } ),
  @484
    - ...(o.errorClass ? { errorClass: o.errorClass } : {}),
    + ...(o.errorClass ? {}: { errorClass: o.errorClass } ),

## electron/agents/http-bridge.ts  (2)
  @164
    - ...(this.limits ? { deadlineMs: this.limits.runDeadlineMs } : {}),
    + ...(this.limits ? {}: { deadlineMs: this.limits.runDeadlineMs } ),
  @328
    - ...(run.lastError ? { errorClass: "resource" as const, retryable: true } : {}),
    + ...(run.lastError ? {}: { errorClass: "resource" as const, retryable: true } ),

## shared/http-clients.ts  (2)
  @455
    - const retryAfterMs = e instanceof HttpLlmError ? e.retryAfterMs : undefined;
    + const retryAfterMs = e instanceof HttpLlmError ? undefined: e.retryAfterMs ;
  @466
    - const msg = e instanceof Error ? e.message : String(e);
    + const msg = e instanceof Error ? String(e): e.message ;

## electron/engine/verifier.ts  (2)
  @58
    - ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    + ...(plan.windowsVerbatimArguments ? {}: { windowsVerbatimArguments: true } ),
  @210
    - ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    + ...(plan.windowsVerbatimArguments ? {}: { windowsVerbatimArguments: true } ),

## electron/agents/cli-agent.ts  (1)
  @170
    - ...(this.opts.allowProviders ? { allowProviders: this.opts.allowProviders } : {}),
    + ...(this.opts.allowProviders ? {}: { allowProviders: this.opts.allowProviders } ),

## electron/ipc/agents.ts  (1)
  @80
    - detail: `register（${manifest.adapter}）${res.replaced ? "覆盖原注册" : ""}${
    + detail: `register（${manifest.adapter}）${res.replaced ? "": "覆盖原注册" }${

## electron/ipc/context.ts  (1)
  @233
    - ...(overrides.journal ? { journal: overrides.journal } : {}),
    + ...(overrides.journal ? {}: { journal: overrides.journal } ),

## shared/deliverable-format.ts  (1)
  @169
    - jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
    + jsonErr instanceof Error ? String(jsonErr): jsonErr.message

## electron/audit-log.ts  (1)
  @212
    - return m ? Number(m[1]) : 0;
    + return m ? 0: Number(m[1]) ;
```

## 适用边界（引用本基线时必须一起说）

1. **只在 Windows 上成立**。`path-policy` 的平台判断已做成"平台参数化"
   （`isCaseInsensitiveFs(platform)`），但 `kill-tree` 的 taskkill 路径、
   `.cmd` 启动等平台相关分支的可杀性——**CI ubuntu 矩阵已验证**（2026-09-24
   首跑暴露 6 处平台假设后逐案修复，spawn-plan/kill-tree 现由 `withPlatform`
   注入双端语义，Linux 上逐点可杀）。
2. **白名单 11 条不计入 701**（`scripts/mutation-check.mjs` 的 `EQUIVALENT_SITES`，
   2026-09-27 复核）：kill-tree @37、path-policy @92、router @221、schema @184、
   spawn-plan @96、http-bridge @309、sensenova-api @397/@403、context @182、
   scheduler @345（两条：`return true → false` 与 `|| → &&` 同一行）。
   它们是**已评审的排除项**，不是分母里的水分。
   ⚠️ scheduler @345 两条共用同一行号 —— 白名单缺 `occ`（该行第几个位点）字段，
   同行的另一处位点会被连带关掉。
3. `electron/main.ts` 的 5 处里，`if (!isPrimaryInstance)` 与 `if (!win)`
   **不在算子表内**（没有 `if (!x)` → `if (x)` 这个算子），靠行为测试保证。
4. 本报告是**快照，不是现状**：引用前先 `git log --date=iso -1` 核对提交时间。

## 原始报告

以下为脚本原始输出（逐目标一行：杀死数 / 总数、耗时）：

electron/sandbox/path-policy.ts   杀死 32/32（100%）   35.1s
shared/glob.ts   杀死 23/23（100%）   27.8s
shared/redact.ts   杀死 1/1（100%）   2.3s
shared/prompt-text.ts   杀死 1/1（100%）   3.3s
electron/agents/scoped-env.ts   杀死 5/5（100%）   7.8s
shared/zone-coverage.ts   杀死 19/19（100%）   24.4s
electron/engine/scheduler.ts   杀死 19/19（100%）   54.7s
electron/sandbox/kill-tree.ts   杀死 10/10（100%）   21.7s
src/store.ts   杀死 10/10（100%）   30.3s
electron/engine/orchestrator.ts   杀死 33/33（100%）   172.5s
electron/agents/manifest-schema.ts   杀死 55/55（100%）   89.2s
electron/agents/registry.ts   杀死 20/20（100%）   21.2s
electron/agents/cli-agent.ts   杀死 15/15（100%）   58.4s
electron/agents/sensenova-api.ts   杀死 34/34（100%）   109.1s
electron/agents/http-bridge.ts   杀死 27/27（100%）   75.0s
electron/agents/manifest-loader.ts   杀死 16/16（100%）   26.2s
shared/llm-client.ts   杀死 15/15（100%）   35.3s
shared/http-clients.ts   杀死 40/40（100%）   114.4s
shared/schema.ts   杀死 17/17（100%）   20.4s
electron/engine/verifier.ts   杀死 9/9（100%）   22.7s
electron/agents/run-session.ts   杀死 5/5（100%）   5.8s
electron/sandbox/command-policy.ts   杀死 6/6（100%）   16.5s
electron/sandbox/spawn-plan.ts   杀死 7/7（100%）   15.8s
electron/sandbox/circuit-breaker.ts   杀死 15/15（100%）   39.7s
electron/sandbox/timeout-gate.ts   杀死 2/2（100%）   8.1s
electron/sandbox/file-journal.ts   杀死 11/11（100%）   71.3s
electron/atomic-file.ts   杀死 1/1（100%）   2.3s
electron/sandbox/snapshot-store.ts   杀死 13/13（100%）   88.7s
electron/engine/router.ts   杀死 22/22（100%）   23.3s
electron/keys-store.ts   杀死 19/19（100%）   22.3s
electron/engine/batch-guard.ts   杀死 9/9（100%）   64.1s
shared/graph.ts   杀死 8/8（100%）   27.6s
electron/ipc/orchestration.ts   杀死 3/3（100%）   8.0s
electron/ipc/projects.ts   杀死 4/4（100%）   9.6s
electron/ipc/agents.ts   杀死 6/6（100%）   13.2s
electron/ipc/context.ts   杀死 7/7（100%）   16.0s
electron/platform.ts   杀死 9/9（100%）   24.5s
headless/protocol.ts   杀死 66/66（100%）   133.1s
electron/engine/zone-guard.ts   杀死 6/6（100%）   10.1s
electron/main.ts   杀死 6/6（100%）   7.5s
shared/usage-meter.ts   杀死 13/13（100%）   13.3s
headless/run-spec.ts   杀死 15/15（100%）   50.0s
shared/deliverable-format.ts   杀死 17/17（100%）   17.8s
shared/routing.ts   杀死 4/4（100%）   4.9s
shared/prompts.ts   杀死 1/1（100%）   2.0s
electron/store.ts   杀死 6/6（100%）   7.7s
electron/audit-log.ts   杀死 11/11（100%）   19.3s
electron/agents/index.ts   杀死 2/2（100%）   12.0s
shared/providers.ts   杀死 2/2（100%）   4.0s
shared/build-llm.ts   杀死 3/3（100%）   7.1s
shared/agent-contract.ts   杀死 1/1（100%）   1.9s

总计：杀死 701/701（100%）   耗时 1699.7s
  其中 单点杀死 701 · 聚合杀死 0
口径：site —— 本次为**逐位点**判定，701 个变异各自只改一处。
最慢：electron/engine/orchestrator.ts 172.5s · headless/protocol.ts 133.1s · shared/http-clients.ts 114.4s

PASS: 无存活变异 —— 全部 701 处位点已**逐点**验证（每处单独变异都被断言发现）。
