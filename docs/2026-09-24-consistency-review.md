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

2. **P2 · `execToken` credential 不过 CommandPolicy**。`electron/agents/manifest-loader.ts:135-160` 直接
   `spawn(command, args, {shell:false})`，既不经命令白名单也不经 `buildSpawnSpec`（Windows 上 `.cmd` 还会 ENOENT）。
   它的定位是「指挥机自己的取令牌命令」，所以当前实际约束是"只加载自己写的 `agents.d`"——但这条红线**没写在 manifest 契约里**。
   要么在 `agents.d/README.md` 明示，要么给它过 CommandPolicy。
3. **P2 · `sensenova-api.ts` 写入时不传 zone 的推迟理由可能已过期**。同处注释写 "until rollback lands (P4)"，
   而 `revert-batch` 如今已在 `batch-guard.ts:139-150` 实现。要么删掉这句陈旧理由，要么补上写入期 zone 强制（后者会改变行为面）。
4. **P3 · `circuit-breaker.ts:113` 注释描述了未实现的行为**：「`retryable: false` outcomes close nothing」，
   但 `record(id, ok)` 只收布尔，认证失败照样计入连续失败并可开熔断。改注释还是改行为，取决于是否希望认证失败触发熔断。
5. **P3 · `headless/protocol.ts:6-7` 自称 "pure: no fs, no process"**，同文件 `:14` import `node:path`、`:364` 读 `process.env`。
6. **P3 · 分层红线仍无机制**：`tsconfig.headless.json` 的 include 已与真实依赖脱节（`run-spec.ts` 经
   `electron/platform` 拉进 `electron/sandbox`）；`tsconfig.node.json` 不在任何 script 里 → 两个 vite 配置文件从不 typecheck；
   `vitest.config.mts:16` 不收集 `headless/**/*.test.ts` 而 coverage 却统计它；`check-syntax.mjs:19` 不认 `.js`
   （`scripts/acceptance/csvstat-acceptance.test.js` 两层都不覆盖）。
   最小可行动作：给 eslint 加 `no-restricted-imports` 把 `shared/` 的 node API 拦成 error——**这是新增门禁，会让未来任何违规变红，需授权**。
7. **P4 · 确定性**：`Date.now()` 派生 id 的碰撞面仍在（`scheduler.ts:293` 批号即快照目录名、`:322` runId、
   `file-journal.ts:74`、`atomic-file.ts:30` tmp 名无计数器）。已修的只有项目 id（`store.ts:47` 的 `idSeq`，commit `f71ffbc`）。
8. **P4 · `file-journal` 把构建产物算成越权**：`walkStat` 的 skip 只跳 `node_modules/.git/.ox-quarantine`（`:6`），
   所以 `dist/`、`coverage/` 的变化会进 unauthorized-write 列表。
9. **P4 · headless 无信号处理**：Ctrl-C 之后快照备份目录与 `ox-run-journal.json` 都不清理（没有 `commit` 机会）。
10. **P4 · 发布流程**：`release.yml:44-45` 打 tag 直接 `build:dist`，**不先跑 verify**。

## 适用边界

- 所有数字（16 步 / 940 用例 / 92.06% stmts / 86.49% branch / 57.4s / mutation:quick 23.3s）都是
  **2026-09-24 本机 Windows 实测**，换机器或换日期要重测；README 里那些 CI 数字（590/590、16.1 min）引自
  `docs/2026-09-23-mutation-site-baseline.md`，本机**未复现**。
- **本机没有 `gh`**，所以本文所有关于 CI 的说法都是从 workflow 文件推断的，不代表 CI 跑过或绿。
- 本轮**没跑** `npm run mutation:audit`（site 全量，CI 实测 16 min）。所改文件均不在 `EQUIVALENT_SITES` 的
  9 个行号锚点内（`kill-tree.ts` / `path-policy.ts` / `router.ts` / `shared/schema.ts` / `spawn-plan.ts` /
  `http-bridge.ts` / `sensenova-api.ts` / `ipc/context.ts`），故白名单漂移风险为零；
  若后续要引用「每处位点都有断言」，必须另跑 audit。
- 单平台结论：本轮全部实测在 win32。POSIX 侧（CI ubuntu）未本地验证，凡涉及 `kill-tree` POSIX 分支、
  `SHELL_METACHARACTERS` 对 `! %` 的过度拦截、大小写不敏感 `forbidden` 判定的结论，仍以 CI 矩阵为准。
