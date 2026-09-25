---
name: ox-commander-dev
description: 在 OxCommander 仓库（多智能体编排平台：Electron 桌面端 + headless JSONL CLI，TypeScript / React18 / Zustand / vitest）内改代码、修缺陷、加功能或做验收时使用。凡触及 electron/、shared/、headless/、src/、scripts/、agents.d/ 或 package.json 的改动，以及涉及 npm run verify、变异测试白名单、check:unwired 接线、zone 互斥、沙箱路径判定、线路池的判定，先加载本 skill。它给出唯一门禁的 19 步机制、会让门禁静默变红的行号锚点、win32 与 POSIX 分支差异，以及 README 与代码不一致的已知口径。
---

# OxCommander 开发

## Overview

这个仓库的门禁系统比多数项目强，而它的**约定几乎都只写在代码注释里**：改错一行注释能让变异位点数变化，
加一个只被测试引用的导出能让 `check:unwired` 红，在 `electron/sandbox/` 里插几行会让等价白名单的行号锚点漂移。
先按本 skill 定档，再动手。

三条最容易踩的硬事实：

1. **唯一验收入口是 `npm run verify`，只认退出码**（17 个 `npm run` 段 `&&` 串联，首段失败即中断）。
   本机实测基线：EXIT 0 / 19 段 / 用例数**现查**（`npm test` 末尾那行 `Tests`；2026-09-25 末次实测 1005 = 996 passed + 9 skipped。
   同日曾报 1020/1033 —— 那是"测试文件互相 import"把一份夹具的用例注册了两次，第 8 步现在会拦它）。
2. **`verify` 里的变异档是最弱的**：`mutation:quick` = `--tier=1 --limit=1`，每个 tier-1 目标只跑 1 个
   aggregate 变异。它过了**不等于**"每处位点都有断言"——那要 `npm run mutation:audit`（site 口径全位点，CI 实测 16 min）。
3. **README 的数字会过时**（它历史上写的是 15 步 / 930 用例，本轮实测是 19 步 / 996）。任何数字现跑现查。

## 铁律

- **改这些文件前先查行号锚点**：`electron/sandbox/kill-tree.ts`(:37)、`path-policy.ts`(:92)、`spawn-plan.ts`(:96)、
  `electron/engine/router.ts`(:193)、`electron/agents/http-bridge.ts`(:309)、`sensenova-api.ts`(:337,343)、
  `electron/ipc/context.ts`(:177)、`shared/schema.ts`(:184)。它们在 `scripts/mutation-check.mjs` 的
  `EQUIVALENT_SITES` 里以 **`{file, op, line}` 行号锚点**登记（op 是算子中文名的原文精确串）。
  在锚点行上方插/删行 → 白名单失配 → site 口径当场红。**处置是"按新行号校回并重新确认那两层防御仍在"，不是删表项。**
- **但用例名里的 `[NNN]` 是标签、不是坐标**：`src/*.test.ts` 有几十个 `it("[375] …")`，数字编码的是
  **写下那天**那一行的行号，代码一挪就过期（`[375]` 那段现在在 `orchestrator.ts:432`）。按名字读它，
  别拿它定位；真正承重的行号只有上一条那一组，因为 site 审计会自动盯它。
- **两张豁免表都有"失效即红"的双向检查**：`scripts/check-unwired.mjs` 的 `ACCEPTED`、
  `scripts/check-script-wiring.mjs` 的 `ACCEPTED`。新增未接线会 FAIL，**表项指向的符号/脚本已消失也 FAIL**。
  改完代码顺手清对应条目；`check:unwired` 有 `--list` 可维护。别复制出重复键（Map 字面量会静默覆盖）。
- **新导出必须有"生产代码"调用者**：`check:unwired` 不认测试文件（既不算导出者也不算消费者），
  只被测试用到的新 `export function/const/class` 必红。要么接到生产路径，要么进 `ACCEPTED` 并写理由。
- **新 `scripts/*.mjs|.cjs` 必须接线**：入口只认 package.json 里引用的脚本，边是"被可达脚本的文本包含脚本名"
  （注释里提一句就算边，`docs/*.md` 不算）。没接线就红。
- **别在注释/字符串里留裸算子字面量**（`&&`、`||`、`===`、`!==`、`continue`、`return false`）。
  `mutation-check.mjs` 的 `maskNonCode` 会把它们当代码位点统计，**位点总数会变**，跨版本数字不可比。
- **平台分支**：`electron/` 与沙箱判据大量区分 win32 / POSIX，而 `verify` 在 CI 是 **ubuntu + windows 矩阵**。
  Windows 本地全绿不代表 Linux 绿（POSIX 上"不可达分支""pid 复用误杀"两类缺陷都真出现过）。
  平台条件用例本仓库的写法是**用例内早退** `if (process.platform === "win32") return;`，不是 `skipIf`。
- **碰 `verify` 链（加/删步骤）必须同步 `README.md` 的门禁索引节 + `CHANGELOG.md`**。
- **构建产物门禁**：`smoke:artifact` 与 4 个 `smoke:*` IT 读 `dist*/`，**单独跑它们之前必须先 `npm run build`**。
  两个 IT 用固定端口（8941 / 8933 / 8934）+ 固定 sleep，**别并发跑、别在别的流水线占端口时跑**。

## 命令档位

| 目的 | 命令 | 量级 |
| --- | --- | --- |
| 迭代快档 | `npm run typecheck && npm run lint && npm run check:unwired && npx vitest run <改动的测试文件>` | ~20s |
| 中档（脚本层/测试文件改动） | 再加 `npm run check:scripts && npm run check:scripts-wired && npm run check:packaged-paths && npm run check:masker && npm run check:tests-collected` | +11s（最后一步会 spawn 一次 vitest，约 6s） |
| **验收** | `npm run verify` | ~2min |
| 变异 site 口径 | `npm run mutation:site`（limit 8）/ `npm run mutation:audit`（全位点，慢） | 分钟~16min |
| 真实链路 | `OX_SMOKE=1 npx vitest run src/sensenova.smoke.test.ts`、`node scripts/smoke-fullchain.mjs` | 花钱、不进门禁 |

撞 429 `insufficient_quota` 是**限流不是密钥失效**：账号级滑动窗口，冷却 ≥5 分钟再重跑失败用例一次。

## 加东西放在哪

- **测试**：全放 `src/*.test.ts(x)`（45 个文件在这），与被测源码**不同目录**；需要 DOM 的文件首行加
  `// @vitest-environment jsdom`。`vitest.config.mts` 的 include 只有 `src/** shared/** electron/**` ——
  **`headless/**/*.test.ts` 与 `scripts/*.test.js` 静默不被收集**（coverage 却统计 `headless/**`，别把覆盖率当收集证据）。
- **新变异目标**：`mutation-check.mjs` 的 `TARGETS` 是手工挂 `{file, test|tests, tier}` 的，测试写完要自己登记，
  否则新代码不进变异门禁。`MAX_SURVIVORS = 0`，任何存活位点直接红。
- **纯逻辑**归 `shared/`（大脑层，双端共享）。注意这条红线**没有机制强制**：`@types/node` 全局自动引入，
  `shared/` 里 `import "node:fs"` 在 renderer 工程也能过 typecheck，eslint 无 import 边界规则，
  只有 `lib: ES2022`（无 DOM）会拦住碰 DOM 的情况。所以**自己盯**。
- 声明式智能体：manifest 契约在 `shared/agent-contract.ts`，校验只在三个入口（`agents.d` 目录 / IPC 注册 / headless stdin），
  `AgentRegistry.register()` **不校验**，id 与 `adapter.meta.id` 配不上的 manifest 会被静默丢弃。

## 红灯速查

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| typecheck 绿但产物/运行不对 | 第 1 步已是 `--incremental false`（不再吃 tsbuildinfo 假绿），所以问题多半在 `build`/`build:headless`（仍用 `tsc -b` 产出） | 删 `*.tsbuildinfo` 重跑 build |
| `check:unwired` 红，符号确实只有测试在用 | 设计如此 | 接到生产或进 `ACCEPTED` 写理由 |
| `check:unwired` 红在"表项失效" | 你删/改了被豁免的符号 | 同步删该条 |
| mutation 位点总数和你预期不符 | 注释/文档里留了算子字面量 | 改掉措辞，别去动基线 |
| site 口径冒出"等价位点未命中" | 白名单行号漂移 | 按新行号校回 + 确认防御仍在 |
| `smoke:gateway` / `smoke:coze` 偶发红 | 固定端口被占 / 机器慢过固定 sleep | 单跑复现，别看一次就归因代码 |
| `mutation-check` 中途被打断后工作区脏 | 它会临时改写源文件（SIGKILL 时还原钩子跑不到，**活体变异会留在盘上**，下一轮门禁红在无关文件上像假回归） | `git status` 必查；`git diff` 只有单处算子翻转即判定残留，`git checkout --` 还原。**别用后台跑全量 `mutation:audit`（约 15min > 后台 10min 上限），按 `--file=` 分档跑，单档 13–60s** |
| 门禁跑不完就红在 `check:masker` | 它靠 `indexOf` 锚点从 `mutation-check.mjs` 抠函数 | 那两个锚点字符串不能改 |

## 别信文档，以代码为准（2026-09-24 逐条核过）

README/docs 与代码有几处口径不一致，动相关文件前先读
[references/architecture.md](references/architecture.md) 的「已知不一致」节。最要紧的三条：

- 桌面端把 Key 存进 OS keychain 后，**正式 run 的大脑层拿不到它**（只有「设置 → 测试连接」那条路径做了 seeding）。
  日常被 `.env` 掩盖，`.env` 一缺就现形。
- zone 越权仲裁**四档实际只有三种行为**：`deny-all` 与 `report-only` 都不回滚，差异只在日志文案。
- 内置执行器调 `assertWritable` **不传 zone**，所以"路径七级判定"对它实际只生效到第 4 级，
  zone 约束完全靠事后 `BatchGuard`。

## Resources

- [references/gates.md](references/gates.md) — 19 步逐条机制（每个检查脚本扫哪些目录、判据、豁免表、失败语义）与门禁维护规则
- [references/architecture.md](references/architecture.md) — 一次 run 的端到端数据流、分层现状、三类适配器契约、沙箱实际判据、平台分支、确定性隐患、已知不一致
