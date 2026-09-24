# 2026-09-24 一致性复核：新增 agent 工作手册 + 口径修正

## 方法与前提

两只只读子代理分别调研「架构与不变量」「门禁与工作流」，主代理**逐条回代码复核后才采信**。
这一步不是形式：子代理回报里有两条被当场推翻——

- 「测试实际 897 用例」来自一份旧留档日志；本机现跑 `npx vitest run` 得 **939（933 passed + 6 skipped）**。
- 「`scoped-env.ts` 头注释与代码自相矛盾」是**假缺陷**：注释里的 allowlist 指规则 2 的 `isRequired`，
  而 `grants`（规则 1）优先于 denylist 是同文件 `:126-129` 明确写的另一层。两层都叫 allowlist 是措辞陷阱，不是 bug。

复核基线：`npm run verify` → **EXIT 0 / 57.4s**（2026-09-24 本机，Windows）。

## 本轮新增：`.qoder/skills/ox-commander-dev/`

给以后在本仓库干活的 agent 用的工作手册。之所以要它：这个仓库的关键约定几乎只存在于代码注释里
（变异白名单为什么不能删、`resolveCommand` 第三参为什么必须透传、两处 zone 判据为什么故意不同），
而违反它们的代价是"门禁静默变红"或"注释骗过检查器"。

| 文件 | 内容 |
| --- | --- |
| `SKILL.md` | 铁律（行号锚点清单、双向豁免表、算子字面量污染、平台分支）、命令档位、加东西放在哪、红灯速查 |
| `references/gates.md` | `verify` 16 步逐条机制：每个检查脚本扫哪些目录、判据、失败语义、CI 与本机口径差 |
| `references/architecture.md` | 端到端数据流、分层红线现状、三类适配器契约、沙箱实际判据、确定性隐患、已知不一致 |

## 本轮已修（全部带反证）

| 改动 | 为什么 | 反证 |
| --- | --- | --- |
| `src/pages/SettingsPage.tsx` 两处线路池文案改由 `SENSENOVA_KEY_VARS` / `SENSENOVA_MODELS` 派生 | 同一页面两处互不相符：`:195` 写「3 密钥 × 4 模型 = 12 条」、`:289` 写「3 组密钥 × 3 个模型」；`shared/providers.ts:144-150` 实际是 4 模型 | 把 `:289` 手改回硬编码「3 × 3」→ `src/ui.test.tsx` 新增用例当场红（`1 failed \| 933 passed`）；恢复后全绿 |
| `src/ui.test.tsx` 加防漂移用例 | 断言渲染文本里的密钥数/模型数/线路数/模型名全部来自常量，手抄即红 | 见上一行 |
| `package.json` description、`electron/agents/index.ts:17`、`shared/build-llm.ts:28` 去掉写死的「3 × 3」 | 同类陈旧文案；改成「多密钥 × 多模型」而不是换成另一个数字——**换数字只是把漂移时间推迟到下次扩池** | `npm run typecheck` + `verify` EXIT 0 |
| `src/sensenova.smoke.test.ts:89` 用例名去掉「3 keys x 3 models」 | 该用例实际用 `SENSENOVA_KEY_VARS` + `SENSENOVA_MODELS` 构造，名字与实现无关 | 默认跳过（`OX_SMOKE` 门控），不影响门禁 |
| `README.md` 门禁节：15 步→16 步、930→940 用例、`mutation:quick` 描述改为「每目标 1 个 aggregate 变异」、覆盖率改为实测 92.06%/86.49% 并标注「不设阈值、不是门禁」 | `package.json:35` 实为 16 个 `npm run` 段；`mutation-check.mjs` 自己的输出就写着「aggregate 口径：134 处位点里约 5 处未逐点验证」 | `node -e` 数 `verify` 段数 = 16；`npm run mutation:quick` 实跑 23.3s 的输出文案 |
| `README.md` 安全边界：审计「按天轮转」→「按大小 2 MiB」；仲裁四档标注前两档行为相同；七级判定标注内置执行器不带 zone；`shared/` 行标注「无机制强制」 | `electron/audit-log.ts:64,104` 是 `maxFileBytes`；`electron/engine/batch-guard.ts:133-138` 让 `report-only` 与 `deny-all` 走同一分支；`electron/agents/sensenova-api.ts:362-367` 注释言明写入时不传 zone；`shared/` 无 `types: []`、eslint 无 import 边界规则 | 逐条读代码，见上表路径 |

## 未修清单（按优先级，每条都给复现方式）

这些是**读了代码但没动**的项——改动会涉及引擎语义或需要设计拍板，列出来供点单。

1. **P1 · 桌面端 run 拿不到 keychain 里的 Key（大脑层与执行器层同时缺）**。`electron/ipc/context.ts:268-271` 的
   `buildLlm()`（「设置 → 测试连接」）传了 seeder；而 run 路径的 `buildPlatformLayer`（`:202-221`）不传，于是
   `electron/platform.ts:190` 的 `buildLlm()` 在无 seeder 下建池，`shared/build-llm.ts:63` 的
   `buildLlmPool` 只读 `opts.env ?? process.env`。执行器侧同源：`electron/agents/sensenova-api.ts:123` 的
   并发闸与 `:167` 的就绪判定都只看 `process.env`（无 key 时并发退化成 1，但请求仍会因缺凭证失败）。
   README:66-74 说「桌面端也可以在『设置』里填，走 OS keychain」——存储确实加密落盘，但**读取路径没接上**。
   本机被根目录 `.env`（`electron/main.ts:45` 只补缺失项）掩盖。
   复现：删/改名 `.env` → 只在设置里存 Key → 跑 run，大脑层与内置执行器都无凭证。
   三种修法（**要先定哪种**）：① `PlatformConfig` 加 `seedKeys`，由 `createPlatform` 在建引擎前注入；
   ② 在 `buildPlatformLayer` 里先 `seedKeysFromStore` 再建平台（改动最小，但把副作用推给调用顺序）；
   ③ 给 `buildLlmPool` 传一个合并过 keychain 的 `env` 视图（最干净，但要同步覆盖执行器侧那两处 `process.env` 直读）。
   **已按 ① 修**：`seedKeys` 挂在 `PlatformConfig` 上、`buildLlm` 内部按「调用点优先、否则用 config」取用，
   `buildPlatformLayer` 传 `seedKeysFromStore`。执行器侧那两处仍读 `process.env`，但播种本身就是写
   `process.env`（只补缺失项），所以并发闸与就绪判定同步拿到 Key。反证：分别切断 `config.seedKeys` 的
   取用与 `buildPlatformLayer` 的传入，`src/platform.test.ts` / `src/ipc-handlers.test.ts` 各自变红。

2. **P2 · `execToken` credential 不过 CommandPolicy**。`electron/agents/manifest-loader.ts:135-160` 直接
   `spawn(command, args, {shell:false})`，既不经命令白名单也不经 `buildSpawnSpec`（Windows 上 `.cmd` 还会 ENOENT）。
   它的定位是「指挥机自己的取令牌命令」，所以当前实际约束是"只加载自己写的 `agents.d`"——但这条红线**没写在 manifest 契约里**。
   要么在 `agents.d/README.md` 明示，要么给它过 CommandPolicy。
3. **P2 · `sensenova-api.ts` 写入时不传 zone 的推迟理由可能已过期**。同处注释写 "until rollback lands (P4)"，
   而 `revert-batch` 如今已在 `batch-guard.ts:139-150` 实现。要么删掉这句陈旧理由，要么补上写入期 zone 强制（后者会改变行为面）。
   **已按"改注释"处理**：那句推迟理由换成了真实理由——写入门用的是严格前缀判据，在这里认 zone 会把模型按约定写的
   `src/duration.js`（zone 为 `src/duration`）在写入前就拒掉，而仲裁门刻意接受它（`shared/glob.ts:85-89` 给了理由）。
4. **P3 · `circuit-breaker.ts:113` 注释描述了未实现的行为**：「`retryable: false` outcomes close nothing」，
   但 `record(id, ok)` 只收布尔，认证失败照样计入连续失败并可开熔断。改注释还是改行为，取决于是否希望认证失败触发熔断。
   **已改注释、保留行为**：凭证坏掉的智能体同样关闸是想要的语义，否则它会在每个任务上再烧一次注定失败的请求。
5. **P3 · `headless/protocol.ts:6-7` 自称 "pure: no fs, no process"**，同文件 `:14` import `node:path`、`:364` 读 `process.env`。
6. **P3 · 分层红线仍无机制**：`tsconfig.headless.json` 的 include 已与真实依赖脱节（`run-spec.ts` 经
   `electron/platform` 拉进 `electron/sandbox`）；`tsconfig.node.json` 不在任何 script 里 → 两个 vite 配置文件从不 typecheck；
   `vitest.config.mts:16` 不收集 `headless/**/*.test.ts` 而 coverage 却统计它；`check-syntax.mjs:19` 不认 `.js`
   （`scripts/acceptance/csvstat-acceptance.test.js` 两层都不覆盖）。
   最小可行动作：给 eslint 加 `no-restricted-imports` 把 `shared/` 的 node API 拦成 error——**这是新增门禁，会让未来任何违规变红，需授权**。

   **后两条已修（2026-09-25，各带反证）**——它们同属"漏挂"族，修法是把缺陷类变成门禁，而不是改一次：

   | 缺口 | 修法 | 反证 |
   | --- | --- | --- |
   | `test.include` 不含 `headless/**`，而 `coverage.include` 含它 | include 补 `headless/**/*.test.ts` | 往 `headless/` 放一个 `zz-probe.test.ts` → 新门禁点名它且 **exit 1**；补上 glob 后同一探针被收集，且 `npx vitest run headless/zz-probe.test.ts` 真跑出 `1 passed`（证明"被收集"确实等于"被执行"，不只是 glob 对上了） |
   | `check-syntax.mjs:19` 只认 `.mjs/.cjs` | 扩到 `.js`（按 CJS 解析；要 ESM 请改扩展名为 `.mjs`，而不是放宽门禁） | 往 `scripts/` 放一个语法坏的 `zz-probe.js` → `26/27 通过`、exit 1 并打印 `SyntaxError`；删掉后 `26/26`（多出来的那 1 个就是 `csvstat-acceptance.test.js`，它此前完全不在任何一层里） |
   | 上面两条都只是"修一次"，下次再漏照样没人报 | 新增门禁 `scripts/check-tests-collected.mjs`（verify 第 8 步） | 见上一行第一格。另外它把「`vitest list` 失败或产出空集合」当 **FAIL** 而不是"没有未收集项"——收集过程坏了却报绿，是"基线失败被静默容忍"的同一类空转 |

   该门禁的判据刻意取自 **`vitest list --filesOnly` 的真实输出**，而不是自己解析 include 再匹配 glob：
   后者要重实现 picomatch 语义，任何偏差都会让门禁查的东西与 vitest 的真实行为分叉。代价 ~6s。
   `scripts/acceptance/csvstat-acceptance.test.js` 进它的 `ACCEPTED`（它 require 的是**被验收项目**的
   `scripts/src/{core,report,cli}`，本仓库没有那几个文件 → 它在本仓库跑不起来）——**理由写进白名单**，
   不再是"没人知道它靠什么跑"。

   仍未修的只有前两条（tsconfig 的 include 与真实依赖脱节、分层红线无机制），后者要新增 eslint 规则，需授权。
7. **P4 · 确定性**：`Date.now()` 派生 id 的碰撞面仍在（`scheduler.ts:293` 批号即快照目录名、`:322` runId、
   `file-journal.ts:74`、`atomic-file.ts:30` tmp 名无计数器）。已修的只有项目 id（`store.ts:47` 的 `idSeq`，commit `f71ffbc`）。
8. **P4 · `file-journal` 把构建产物算成越权**：`walkStat` 的 skip 只跳 `node_modules/.git/.ox-quarantine`（`:6`），
   所以 `dist/`、`coverage/` 的变化会进 unauthorized-write 列表。
   **已修，且实测比 P4 重**：用构建产物直接跑一遍真实 `BatchGuard`（默认 `revert-batch` 档）确认了两条后果——
   ① 批内跑一次项目自带构建 → 整批 `ok:false` 且产物进回滚清单（任务本身完全没越界）；
   ② 同名的第四份跳过清单在执行器快照里，而快照按路径序消耗 32k 预算、`coverage|dist` 正排在 `src` 前面 →
   实测"进快照 12 个文件里 11 个是产物、真实源码 0/5"。两处改接同一张 `DEFAULT_SKIP_DIRS`，反证是把清单
   换回旧的三项 → 两条新用例各自变红。
9. **P4 · headless 无信号处理**：Ctrl-C 之后快照备份目录与 `ox-run-journal.json` 都不清理（没有 `commit` 机会）。
   **已修（并且其中一半原判不准）**：`ox-run-journal.json` 是**续跑记录**，留着是设计如此
   （`load()` 靠它恢复），不算泄漏 —— 这条要从"泄漏"改记为"预期行为"。真正泄漏的是快照备份目录，
   而"退出时删"是错的做法：被中断的那一批正停在"越界文件已写、还没仲裁"的状态，那份备份是人工
   恢复现场的唯一材料。所以改成两件事：`headless-main` 装 SIGINT/SIGTERM 处理器（发一条 `error`
   事件 + 置退出码 1，第二下才硬退出），回收放到**下一次运行启动时**
   （`run-spec.ts:pruneStaleBackups`，只认 `batch-*` 且超过 24h，宿主共享目录里的别的东西一个不碰）。
   **覆盖边界（第三轮更新）**：构建产物里确实带了这段（`dist-headless/headless/headless-main.js` 里
   `process.on` 与那句提示都在）。信号**投递**在 win32 观测不到（`kill()` 即 TerminateProcess，
   来不及发事件），所以离线 IT 场景 D 只在 POSIX 分支断言"最后一行是那条 `error`、且之后没有别的事件"，
   Windows 分支改断"被杀的那次没有 `done`、journal 与备份留在盘上"并在日志里说明为什么跳过。
   也就是说：**POSIX 那两条本机跑不到**，交给 CI ubuntu job 验 —— **已验：run 15（`77bc033`）的
   `verify (ubuntu-latest)` job 绿**，即"第一下 SIGTERM → `error` 是最后一条事件、之后再无 `verification`/`done`"
   在真 Linux runner 上成立过一次。Windows job 走的是"没有终态事件、退出码 `null`"那条分支。
10. **P4 · 发布流程**：`release.yml:44-45` 打 tag 直接 `build:dist`，**不先跑 verify**。
    **已修**：release 工作流加了 `verify` job（ubuntu，一次），`build` 改成 `needs: verify`。
    没有跨文件复用 verify.yml（它只有 push 触发器，`workflow_call` 要改那个文件），所以步骤重复了十行。
    两个 workflow 都过了 `js-yaml` 解析（`jobs: verify,build` / `build.needs="verify"`）；
    **但这只是语法与结构层面的验证，CI 是否真按预期变绿，要等下一次 tag 或手动 dispatch**。

11. **P2 · 一批的越权删除只响一次，之后那个文件从台账上消失**（本轮新发现，已用构建产物实测）。
    `FileJournal` 每批重建基线：批1 里 t1（zone `src/x`）删掉 `src/a.js` → 基线有它、现在没有 →
    报 `delete:src/a.js` 越权，整批失败但**文件保留**（`report-only`/`deny-all` 都不回滚）。
    批2 的基线里 `a.js` 本来就不存在 → 同一个删除不再产生任何冲突；实测两批输出为
    `批1 conflicts:[unauthorized-write(src/a.js)]` 与 `批2 zones=["src/x"] conflicts:[]`，
    盘上 `src/a.js` 已没了。于是被删的源文件可以一路带到交付，而后续验证报
    `Cannot find module './a.js'` 时也没有任何任务的 zone 覆盖它（归属按任务自己的 zone 算）。
    为什么本轮没顺手修：试过把越权路径并进 `scope.zones`，但它修不了归因（`routeVerificationErrors`
    用的是任务自己的 zone），而且等于悄悄扩大 zone 集合 —— 正是本文档另一处"写入门比仲裁门严"
    刻意保持的不对称反着来。需要拍板的是一句话：**被失败批次删掉的文件，此后归谁负责**。

12. **P3 · 本轮新增的两段 headless 逻辑原本完全在变异门禁之外**（已登记为目标并补齐断言）。
    `headless/run-spec.ts` 不在 `TARGETS` 里 → 凭证闸（`missingCredentials`）与备份回收（`pruneStaleBackups`）
    两处"判错方向不报错"的逻辑没有任何机制保证断言真的在看它们。登记为 tier 2 目标后**首跑 6/15（40%）**，
    9 处存活，全部补了断言后 **15/15（100%）**，其中三处值得记下：
    - `&& → ||` @`wanted.length > 0 && present.length === 0`：存活原因就是旧用例只有"全缺"和"全不缺"两格，
      手里恰好有一条 Key 的那一格没人跑过 —— 而那正是我自己在离线 IT 上撞到的误挡场景。
    - `continue → break` @回收循环的两处跳过：`readdirSync` 在 Linux 是 hash 序、Windows 是字典序，
      只要待删目录排在跳过项之前，两种写法就看不出区别。**修法是给遍历显式排序**（`failed` 是给宿主比对的
      列表，本来就不该随平台变），再把用例里的目录名排成"两条跳过在前、两个待删在后"。
    - `=== → !==` @`outcome.durationMs !== undefined ? …`：`run` 事件的耗时字段没断过，
      而同一个模式在 `orchestrator.ts` 早就有断言（用例名 `[375]`，它编码的是**当时**那一行的行号 ——
      那段代码现在在 `:432`）。这种标签会漂，只当名字用、别当坐标用。这里说的是：分层各抄一遍不等于两层都有门禁。

## 适用边界

- 所有数字（92.06% stmts / 86.49% branch / 57.4s / mutation:quick 23.3s）都是
  **2026-09-24 本机 Windows 实测**，换机器或换日期要重测。（覆盖率在 09-25 复测为 **92.00% / 86.68%**，
  README 用的是新值。**为什么变的没查**：两次都没有留下"哪些文件掉了几个点"的明细，
  只凭这两个总数归因就是编故事 —— 要看归因得存一份模块级报告再比。
  同日第二轮把门禁加到 **17 步**、用例加到 **962**（956 passed + 6 skipped），并按 `--mode=site` 逐目标复测了
  本轮改到的两个文件：`electron/engine/scheduler.ts` **14/14**、`headless/run-spec.ts` **15/15**（补断言前 6/15）。
  随后**全仓 site 全量也在 win32 复测过：603/603（100%）· 14.3 min**（分母从 CI 那次的 590 涨到 603，
  涨的是新目标与新位点，不是断言变松）—— 数字与来路记在
  `docs/2026-09-23-mutation-site-baseline.md` 的"三轮快照"一节。
- **本机没有 `gh`**：CI 状态是用 GitHub 的 REST API（`repos/.../actions/runs`、`.../jobs`）查的，
  只对**已推送**的提交有效；本地领先的提交 CI 没见过，那部分说法是从 workflow 文件推断的。
- 第一轮**没跑** `npm run mutation:audit`，当时写的是"所改文件均不在 `EQUIVALENT_SITES` 的 9 个行号锚点内
  （`kill-tree.ts` / `path-policy.ts` / `router.ts` / `shared/schema.ts` / `spawn-plan.ts` /
  `http-bridge.ts` / `sensenova-api.ts` / `ipc/context.ts`），故白名单漂移风险为零"。**第二轮把全量跑了**
  （603/603）—— 这一步顺带兜住了那个假设：白名单是按 `{file, op, line}` 精确匹配的，任何一次行号漂移
  都会以"位点重新计入分母且无断言"的形式变红，全量绿即说明这 9 条锚点当前全部对得上。
- 单平台结论：本轮全部实测在 win32。POSIX 侧（CI ubuntu）未本地验证，凡涉及 `kill-tree` POSIX 分支、
  `SHELL_METACHARACTERS` 对 `! %` 的过度拦截、大小写不敏感 `forbidden` 判定的结论，仍以 CI 矩阵为准。
