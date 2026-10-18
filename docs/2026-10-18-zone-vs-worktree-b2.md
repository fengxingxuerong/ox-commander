# B2 对照实验：zone 互斥 vs worktree 隔离（同一任务集各真跑一遍）

日期：2026-10-18（worktree 侧重修跨到 10-19 凌晨）
出处：`docs/2026-10-17-competitor-gap.md` B2 行——全赛道多数路线走 worktree
隔离、各自讲自己的代价；本项目走共享工作区 + zone 互斥。要拿数字说话，就得
对跑一次：**报两边各自的代价项，不下"快 X%"结论**。

## 一、方法与口径

- **任务集**：10-18 真演第 5 轮（全绿轮）的 6 个任务原样复用（workspace
  `ox-real-e2e-1018-2109` 的 journal）：t1 `src/core/csv.js` / t2
  `src/core/stats.js` / t5 `testdata/` / t3 `src/report/report.js`（依赖 t2）/
  t4 `src/cli.js`（依赖 t1,t3）/ t6 `tests/`（依赖 t1-t4）。六个 zone 互不相交。
- **zone 侧**：产品链路真跑（`scripts/run-multiagent-e2e.mjs --real`，loomy +
  sensenova-api 双执行器；zone 写闸、快照、契约路径检查、修复环全开）。数据源
  为该轮 receipt（`logs/e2e-real-1018-2109.log`）与 journal。
- **worktree 侧**：worktrunk v0.80.0（uzi 需 Go + tmux，本机不具备；选
  worktrunk）+ 实验执行器（`scripts/b2-worktree-run.mjs` /
  `scripts/b2-worktree-agent.mjs`）：**同模型池、同 failover 客户端、同
  `chatJson` + `parseFilePayload` 文件协议**；但为单发生成（无工具、不能读工作
  区），无 zone 写闸、无快照、无契约检查、无修复环、无验证。6 个 worktree
  一次性全并行。
- **两侧不对称先摊开**（读数据前必读）：① 执行器所处时代不同——zone 侧
  21:09 起跑（模型池换血**前**），worktree 侧 22:58 后（换血**后**，含
  kimi-k3 temperature 修复前后各半）；② 当晚供应商配额天气波动大，worktree
  侧末轮（t6 r4）恰逢恶化窗口；③ zone 侧执行器（sensenova-api 适配器）与
  worktree 侧同为"单发 chatJson"一类，差异不在生成方式，而在**外围机制**
  （写闸/仲裁/契约/重修/验证）——这正是 B2 要看的差别；t1 例外：zone 侧为
  loomy 真 agent，worktree 侧仍是单发。

## 二、zone 侧数据

| 任务 | zone | 尝试 | 时长 | 执行器 |
| --- | --- | --- | --- | --- |
| t1 | src/core/csv.js | 1 | 201.3s | loomy |
| t2 | src/core/stats.js | 1 | 388.3s | sensenova-api |
| t5 | testdata | 1 | 206.5s | sensenova-api |
| t3 | src/report/report.js | 1 | 43.8s | sensenova-api |
| t4 | src/cli.js | 1 | 40.8s | sensenova-api |
| t6 | tests | **2** | **238.0s** | sensenova-api |

- 任务时长合计 1118.6s（≈18.6 min）；全程约 36 min（21:09 起跑 → 21:45:24
  收据），差额在规划、批次间隙与终验。
- 批序列 `[t1,t2,t5] [t3] [t4] [t6]`（4 批，批宽 3/1/1/1）：批 2-4 全部为依赖
  驱动，**zone 冲突切刀 0 次**——本任务集没有跨任务共享文件，互斥没有付出串行
  代价。
- 收据：6/6 交付、conflicts 0、rounds 1、usage 110631 tokens / 8 calls（仅
  loomy 侧有计量）。t6 首战 600s 限流败，**修复环自动重修 238s 收敛**。
- 写闸/仲裁在本轮**零触发**（任务集自身合法）——其价值在 10-18 run 1 事故里
  已验（见 CHANGELOG「修复（执行器）」），本轮不记账于它。
- 终验：build/typecheck/test/smoke 全过，独立样本冒烟过，exit 0。

## 三、worktree 侧数据

- **创建**：6 × worktree 合计 4.2s（均 0.7s），磁盘各 1425 B（对象库共享）。
- **首跑（6 全并行）**：t1 714.0s ✓、t2 342.6s ✓、t3 327.8s ✓、t4 132.2s ✓、
  t5 4.6s ✓、t6 **900s 被实验器上限硬杀**（第一发恰在 kimi-k3 temperature 400
  风暴里空转——那是产品池 bug，当夜已修 `9e51f81`）。首跑墙钟 921.7s。
- **合并**：5 ×（均 3.3s），**冲突 0**、worktrunk 自动删 worktree+branch
  （5/5）；t6 无提交跳过。
- **t6 重修时间线**（人工逐轮喂原始失败输出，模拟引擎 repair 的
  `errorLogDigest` 语义）：

| 轮 | 生成 | 交付 | 合并 | 终验 |
| --- | --- | --- | --- | --- |
| r2 | 218.3s | 3 个测试文件 | 2.4s | ✗（`require('../csv')` 等模块路径错） |
| r3 | 188.4s | 只修 cli.test.js | 2.6s | ✗（require 修好；stdout 捕获断言红） |
| r4 | 1260.1s（天气退化，stderr 满是 429/timeout 冷却） | 又改 cli.test.js | 2.8s | ✗（断言仍红，且前一例回归） |

- **终态**：build ✓ / smoke ✓ / **test ✗——`tests/` 3 个文件全红**
  （csv/stats 为模块路径错、cli 为 stdout 捕获断言）。**人工重修 3 轮未收敛**。
- 机器时间合计约 43.5 min（首跑 921.7s + 三重修 1667s + 各轮合并与终验），
  人工编排时间（看盘、判错、写 digest、跑命令）未计。

## 四、两边代价项（并列，不换算）

| 维度 | zone 互斥（产品链路） | worktree 隔离（worktrunk + 单发执行器） |
| --- | --- | --- |
| 并行单元 | 批次（本轮 4 批，尾链 t3→t4→t6 顺序锁死；全部依赖驱动） | 6 全并行，无批概念 |
| 隔离机制 | 写闸 + 批后仲裁（机制存在，本轮零触发；run 1 事故里真截住过越权） | 物理隔离，越权不可能——无需机制 |
| 验证闭环 | 契约路径检查 + 终验 + 修复环；t6 自动重修 2 次收敛、终验全过 | **工具层没有**——重修真人工 3 轮未收敛、终验红；"一份交付物"靠 merge 拼（本轮 0 冲突仅因 zone 不相交） |
| 运行开销 | 无 worktree 创建/合并开销；有批同步点与快照/仲裁簿记 | 创建 0.7s × 6、合并 3.3s × 5、自动清理 5/5 |
| 人力 | 全自动（修复/验证在环内） | 编排者=人：本轮为 t6 写 3 轮 digest、跑 4 次验证 |
| 本轮质量结果 | 6/6 交付 + 全门禁绿 | 5/6 首跑 + t6 终态红 |

**不下的结论**：任务时长不换算成"谁快 X%"（两侧执行时代、天气、编排投入都不同）；
"0 冲突"不是 worktree 路线的普适事实（任务集 zone 不相交是构造保证）；"zone
更好"也不由单次运行证明（样本 6 任务 × 单轮）。本对照能立的只有：**各自的
代价项清单**，以及 worktree 工具层缺失验证/重修环时，代价会落在人身上（本轮
t6：人工 3 轮，机器 28 min，仍未收敛）。

## 五、限制（必读）

1. 执行器不同构：zone 侧有全套外围机制，worktree 侧裸单发——这是**故意**的
   （B2 问的是"路线 + 工具"的代价，不是两家执行器赛跑）；但据此不能反推
   "worktree + 同款修复环"的收敛性，那需要另一次实验。
2. 时代不同：池换血、kimi 修复、天气三者都在两跑之间发生（r4 的 1260s 与
   天气相关）。
3. 任务集无共享文件冲突场景（zone 互不相交）——合并代价测的是空载。
4. worktree 侧执行器系统提示词沿用早期"基线只有骨架"的自主 profile 文案，
   对晚跑的 t6（仓库已有全部文件）过时；单发模式本来读不了盘，影响有限但如实记。
5. 单次运行、单任务集；人工重修计时不可比（人不是机制）。

## 六、复现

```bash
# zone 侧（真链路；凭据在 .env）
node scripts/run-multiagent-e2e.mjs --real --max-minutes 120 --workspace <dir>
# 汇总两侧数字（产物路径见下）
node scripts/b2-zone-vs-worktree-report.mjs \
  --zone-log=logs/e2e-real-1018-2109.log \
  --journal=<...>/ox-run-journal.json \
  --worktree-metrics=<...>/b2-worktree-metrics.json \
  --t6-attempts-dir=<...>   # 自动收集 b2-t6-*-result.json
# worktree 侧（需 worktrunk 二进制与真实凭据）
node scripts/b2-worktree-run.mjs --wt=<wt.exe> --journal=<...>
node scripts/b2-worktree-agent.mjs --worktree=<...> --task-file=<...>
```

产物：zone 侧 `logs/e2e-real-1018-2109.log`（logs/ 不入库，关键数字已内嵌本文）；
worktree 侧 metrics/各轮 result JSON 在实验会话的 `%TEMP%\opencode\`（同样已
内嵌）；实验仓库 `%TEMP%\opencode\b2-worktree\repo`（main 含全部合并）。
