# 贡献指南

OxCommander 是一个**门禁比功能更严**的项目：判错逻辑本身被逐位点变异测试证明过，
而这一切几乎都写在代码注释与 `.qoder/skills/ox-commander-dev/SKILL.md` 里。
改错一行注释能让位点数变化，加一个只被测试引用的导出能让门禁红 ——
**动手前花十分钟读那本手册，比提交后猜半小时为什么红便宜。**

## 环境要求

- Node.js **>= 20.19**（CI 用 22）
- Windows / macOS / Linux 均可开发；沙箱与 kill-tree 有平台分支，
  本地全绿不代表另一个 OS 绿（CI 是 ubuntu + windows 矩阵）

## 本地开发

```bash
npm install
npm run dev            # 渲染层（vite，:5173）
npm run dev:electron   # 桌面端（先 tsc 编 electron 再起 Electron）
npm test               # vitest 全量
```

## 提交前：唯一验收入口是 `npm run verify`

33 段串联，首段失败即中断，只认退出码。改动以它全绿为准。
迭代时用快档省时间，**但 PR 合并前必须在干净树上跑过整链**：

```bash
# 迭代快档（~20s）
npm run typecheck && npm run lint && npm run check:unwired && npx vitest run <改动的测试文件>
```

几条本仓库实测出来的纪律（完整版在 SKILL.md）：

- **新测试放 `src/*.test.ts(x)`**，与被测源码不同目录；需要 DOM 的文件首行加
  `// @vitest-environment jsdom`。`scripts/*.test.js` 不被 vitest 收集。
- **新导出必须有生产代码调用者** —— 只被测试引用的 `export` 会被 `check:unwired` 拦。
- **新写的变异目标要自己登记**：`scripts/mutation-check.mjs` 的 `TARGETS` 是手工挂的，
  漏挂的文件不参与变异统计，那个 PASS 对它没有含义。
- **新 `scripts/*.mjs|.cjs` 必须接线**：入口只认 package.json 里引用的脚本。
- **动 `verify` 链（加/删/换序步骤）必须同批改四处**：README 门禁索引节、
  CHANGELOG、SKILL.md、`references/gates.md` —— 漏一处的后果由 `check:doc-claims` 判红。
- **别在注释里留裸算子字面量**（`&&`、`||`、`===` 等）—— 它们会被当作位点统计，
  位点总数会变，跨版本数字不可比。
- 改 `electron/sandbox/` 下的锚点文件前先查 SKILL.md 的行号锚点清单，
  在锚点行上方插行会让等价白名单失配、site 口径当场红。

## PR 要求

1. **CHANGELOG.md 记账**：只记对用户/维护者可见的变化，写清边界与已知缺口，
   不写营销话。本项目的历史记录风格是"诚实的负面事实也写进去"。
2. 跑过 `npm run verify` 整链并在 PR 里给出退出码（或说明卡在哪一段、为什么）。
3. 动 verify 链时确认四处文档已同步；动了 `TARGETS` / 白名单时说明登记理由。
4. 一个 PR 一件事。跨多个不相关改动的 PR 会被要求拆分 —— 归因是这条仓库的
   一切机制（repair loop、mutation:touched、zone:cost）的地基。

## Issue

- **Bug**：用 bug report 表单。带上 OS、Node 版本、复现步骤，以及如果与门禁相关，
  是哪一段红、退出码多少。门禁红请附上该段输出的关键几行，不要只写"verify 挂了"。
- **特性建议**：用 feature request 表单，先写"没有它时的代价"再提方案。
  竞品缺口盘点在 `docs/2026-10-17-competitor-gap.md`，提新特性前值得先看一眼
  清单里它是不是已被判定"明确不补"（附理由的那张表）。

## 许可

MIT。提交即表示你的贡献按 MIT 许可发布。
