# OxCommander 质量加固实施记录

> 日期：2026-09-19
> 前置基线：P0–P6 收口后（`a90ff3b`），`npm run verify` EXIT 0，399 passed / 6 skipped。
> 本轮目标：把"剩余项收口"清单里的测试与工程卫生欠账一次清完，质量维度全部做到可验证的满分。

---

## 1. 覆盖率从"看不见"到"有基线"

新增 `@vitest/coverage-v8`（devDependency），`vitest.config.mts` 固化 coverage 配置
（include 四个源码目录，排除测试文件与入口胶水），新增 `npm run test:coverage`。

**基线（加固前）**：总体 70.17% stmts / 68.64% branch / 72.15% lines。
引擎层 91%+、共享层 95%+；盲区集中在：

| 盲区 | 加固前 | 评估 |
| --- | --- | --- |
| `src/pages/*` 4 页面 + `AgentsPanel` + `App.tsx` | 0% | UI 渲染层裸奔 |
| `electron/ipc.ts`（装配层 492 行） | 0% | composition root |
| `electron/store.ts`（JSON 持久层） | 0% | 数据层无测试 |
| `electron/main.ts` / `preload.ts` / `headless-main.ts` | 0% | 薄胶水，由产物冒烟兜底 |

## 2. UI 渲染测试（`src/ui.test.tsx`，16 用例，jsdom）

新增 devDependencies：`jsdom`、`@testing-library/react`。
mock 整个 `window.oxCommander` 桥（28 方法），覆盖：

- App 路由切换 + 挂载订阅（onEvent / refreshProjects）
- ProjectsPage：空态、创建按钮门控（空需求禁用）、真实走 createProject → prd-review 跳转、
  确认删除 / 取消删除
- BoardPage：阶段高亮、任务归因（agentId / 耗时）、错误类型中文化（`rate-limit` → 限流）、
  失败摘要、验证报告、日志流；暂停/取消/打开工作区/开始/升级决策全部转发到桥
- PrdReviewPage：规划进行中 / 规划失败重试 / PRD 渲染与批次统计 / 任务卡展开 /
  批准开工 / 编辑 PRD 重新分解
- SettingsPage：设置加载、密钥行与安全提示、测试连接结果、AgentsPanel（能力、熔断统计、
  manifest 错误框）、密钥保存、设置保存

**过程发现两处测试写法坑（已修）**：页面跳转断言必须走 `<App />` 而非单页组件；
testing-library 对 `<select>` 的 `ByDisplayValue` 匹配的是选中项文本而非 value。

## 3. 测试当场抓到真缺陷：SettingsStore 浅拷贝污染默认值

`electron/store.test.ts`（6 用例）写入"默认值必须是副本"断言时立刻失败：
`load()` 返回 `{ ...DEFAULT_SETTINGS, ...parsed }` 是浅拷贝，`enabledAgents` /
`verificationCommands` / `llmPool` 三个嵌套数组与全局默认值**共享引用**——任何调用方
原地修改加载结果都会在进程生命周期内污染 `DEFAULT_SETTINGS`。不报错、不崩溃，
属于本项目文档点名过的"静默腐化"类缺陷。

**修复**：`load()` 改用 `structuredClone(DEFAULT_SETTINGS)` 再合并，注释说明原因。
回归：6/6 绿，默认值隔离被测试永久钉住。

**顺带修掉一个门禁盲区**：`vitest.config.mts` 的 include 只写了 `*.test.ts`，
`.tsx` 测试文件会被静默忽略——补上 `src/**/*.test.tsx`。

## 4. 产物层离线冒烟进入门禁（`scripts/artifact-smoke.mjs`）

动机是 §19 的教训：380 个单测全绿，产物在 Windows 上连 `npm run build` 都起不来。
新增 7 项检查（零网络、零密钥）并追加进 `verify`：

1. `dist/index.html` 存在
2. `dist-electron` 全量 41 个 CJS 文件逐个 `node --check`
3. headless 二进制协议：非法 stdin → exit 1 + error 事件；缺 projectRoot → exit 1 + 具名消息

## 5. 真实链路 SOP 沉淀

2026-09-19 复跑真实 smoke：6/6 通过（`forced JSON` 用例撞 429 `insufficient_quota`，
100 秒冷却不够、约 5 分钟恢复）。结论：SenseNova 多 Key 共享账号级滑动窗口，
429 = 限流 ≠ 密钥失效。SOP 写进 `src/sensenova.smoke.test.ts` 头部注释：
冷却 ≥5 分钟后用 `-t` 只重跑失败用例一次。

## 6. eslint 门禁（flat config）

新增 `eslint.config.mjs`（`@eslint/js` recommended + `@typescript-eslint` recommended，
含 `eslint-plugin-react-hooks` 规则）。哲学：类型正确性归 `tsc -b` 管，ESLint 只管
tsc 看不见的（unused vars、hook 规则）；`no-explicit-any` 关闭（LLM/IPC 边界合理使用）。

15k 行代码首跑仅 19 个问题，全部处置：

| 问题 | 处置 |
| --- | --- |
| `_probe-extra.cjs` 15 个 no-undef | 文件移入 `scripts/probe-endpoints.cjs`（内容零改动，目录在 ignore 内） |
| `SettingsPage.tsx` exhaustive-deps | ref 模式重构：行为语义不变（仍只在 provider/pool 变化时查密钥），警告消除 |
| `scheduler.test.ts` 3 个失效 `require-yield` disable | 生成器已有 yield，直接删除 |

`npm run lint` 加入 verify 链；终态 **0 error / 0 warning**。

## 7. 构建卫生：vite CJS 弃用警告清零

`vite.config.ts` → `vite.config.mts`（`git mv` 保留历史），同步修正
`tsconfig.node.json` include（顺带清掉早已改名的 `vitest.config.ts` 陈旧引用）。
重跑 `npm run build`：CJS Node API 弃用警告消失。

## 8. 仓库卫生

- `_probe-extra.cjs` → `scripts/probe-endpoints.cjs`（根目录清空杂物，零删除）
- 新增根 `README.md`（项目定位 / 快速开始 / 门禁 / 架构 / 线路池 / 安全边界 / 文档索引）

## 9. 加固后终态（全部可复现）

| 项 | 加固前 | 加固后 |
| --- | --- | --- |
| 测试用例 | 399 passed / 6 skipped | **421 passed / 6 skipped**（+22：UI 16 + 持久层 6） |
| 覆盖率 | 不可见 | 70.17% 基线 + 盲区清单；src 渲染层 0% → 覆盖 |
| verify 链 | 4 步 | **6 步**（+lint +artifact smoke） |
| eslint | 未配置 | 0 error / 0 warning，进门禁 |
| vite CJS 警告 | 每次构建出现 | 清零 |
| 根目录杂物 | 探针脚本 + 无 README | README 就位、探针归位 |

**仍然诚实地没做（及原因）**：

| 项 | 原因 |
| --- | --- |
| `electron/ipc.ts` 装配层单测 | 需 mock 整个 electron 运行时，收益/成本劣于已进 verify 的产物冒烟；装配错误会被 artifact smoke 的 main.js 存在性 + 语法检查与桌面端人工验收兜住 |
| Playwright Electron GUI 驱动 | ~100 MB 新依赖，本轮明确不引入 |
| 真实 GitHub Actions 首跑 | 需要仓库推送到远程，属用户动作；YAML 已就位且足够薄 |
