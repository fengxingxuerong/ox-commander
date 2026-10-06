# 2026-10-06 真实拆解端到端记录（`run-multiagent-e2e.mjs --real`）

> 目的：补 `docs/2026-10-05-full-audit.md` §9 里那句"真实 LLM 做 PRD→任务→批次拆解的质量，
> 记录在案的只有 2026-09-19 一次"。**这次的结论是负的**，所以更要留全。
> 原则不变：每条都带可复跑的命令或当场事件原文，说不出证据的不写。

## 0. 一句话结论

编排层的机制在真实模型下**全部按设计工作**（拆解、zone 互斥、能力路由、满载让路、
429 冷却与换线、执行器 deadline 真掐、越权回滚、基线归因、重修轮重派）；
**但这一单没有交付出去**：30 分钟墙钟到点被 runner 硬杀，三轮验证全红，
而且我独立验收发现**"build/typecheck 过"的项目其实 `require` 就断**。
跨智能体契约漂移第二次现形，形状和 09-19 不同，成因同类：**平台不检查智能体
是否按契约点名的字面路径交付，而靶项目的验证命令也看不见这件事。**

## 1. 运行设置

| 项 | 值 |
| --- | --- |
| 命令 | `node scripts/run-multiagent-e2e.mjs --real --workspace <临时目录> --max-minutes 30` |
| 前置 | `node scripts/loomy-bridge.mjs` 监听 127.0.0.1:8931（`GET /health` → `{"ok":true,"agent":"loomy"}`；桥本身是本仓代码 + 真实线路池，不需要外部产品） |
| 凭据 | `.env`（3 把 SenseNova key + AMD），由启动的 shell 导出后传给子进程 |
| 起止 | 19:51 建工作区 → 20:21 进程消失（`--max-minutes 30` 的 `SIGKILL`），事件流里**没有** `done` / `receipt` |
| 产物 | 事件流落 `logs/multiagent-e2e.jsonl`（已被 `.gitignore` 的 `logs/` 挡着，
  所以当场复制了一份进仓库：`docs/evidence/2026-10-06-real-decomposition-e2e.jsonl`；26,577 B，1 次 hello / 1 次 prd / 1 次 tasks / 26 次 task / 24 次 run / 2 次 conflict / 3 次 verification / 30 条 log） |

## 2. 真实 LLM 拆出来的计划（6 任务 / 2 批次）

```
批次1（并行，zone 互斥）：
  t1  CSV parser module (src/core/csv.js)        zone=src/core/csv
  t2  Column statistics module (src/core/stats.js) zone=src/core/stats
  t3  Report renderer (src/report/report.js)      zone=src/report
  t4  CLI entrypoint (src/cli.js)                 zone=src/cli
  t5  Sample data fixtures for smoke runs         zone=sample-data
批次2：
  t6  Test suite (tests/csv.test.js, tests/stats.t…) deps=["t1","t2","t3","t4"]
```

拆解本身是**合格**的：按模块切 zone、把测试套排在依赖 t1-t4 之后、还给 t5 写了
"EXACT byte content"的字节级样例数据契约（含引号逗号、中文、空值行）。
它没有把 t6 与实现混在一个批次里，也没有发明依赖环。

## 3. 机制层当场看到的真行为（事件原文摘录）

```
[router] t1（zone=src/core/csv, role=backend-dev）→ loomy · score=190 ·
        role=backend-dev(+100) zone=src/core,src/core/**(+40) load=0/1(-0) priority=+50
[router] t5（zone=sample-data, role=fullstack-dev）→ 无可用智能体 · score=0 ·
        合格候选全部满载（1 个），本轮不派，等修复轮重派        ← 两轮都是这句
基线验证：1 条命令在本次运行开始前就失败（不是智能体造成的）：test(exit=1)
sensenova:SENSENOVA_API_KEY#0 失败（LLM HTTP 429: inference exceeds tpm/rpm limit … 429003）
sensenova:SENSENOVA_API_KEY#1 失败（The operation was aborted due to timeout），冷却 30s
t1 → loomy ok=false 600020ms err=timeout                        ← 执行器 deadline 真掐了
[conflict] unauthorized-write ["tests/report.test.js"] remedy=revert
[conflict] unauthorized-write ["sample-edge.csv"] remedy=revert
[sandbox] 已回滚 0 个文件、删除 1 个新增文件                     ← 两次
依赖未就绪，本轮跳过（等待上游修复后自动解锁，不烧配额）：t6      ← 三轮都是这句
── 重修第 1/3 轮 ── / 2/3 / 3/3
[router] t2（zone=src/core/stats …）→ loomy · score=203 · quality=0.67(+13)   ← 质量反馈在改路由
批次 1/2 完成：0/5 → 3/5 → 0/2
[verification] passed=false build:过 typecheck:过 test:败 exit=1                ← 三轮同形
[snapshots] 保留 1 个未到期批备份：batch-muvp1126-26520-1-slow —— 来自没有结算完的批
```

值得单独记的两条：**满载让路**（t5 前两轮不被派而不是硬塞，第三轮换到空闲线路后 `ok=true 364071ms`）
和 **per-agent 质量分进了路由分数**（t2 从 sensenova 改派给 loomy）。都不是我改出来的行为，是它自己跑出来的。

## 4. 为什么这单注定交付不了

`t6`（测试套）依赖 t1/t2/t3/t4，而批次 1 每轮都有任务不结算成功 →
`node --test` 永远看到**空的 tests/**（`ox-scripts/test.js` 打印 `no test files found in tests/` 并 exit 1）。
所以三轮验证的 `test:败` 不是"代码错了"，是**测试从未被交付**；墙钟 30 分钟不够走完 6 个任务 ×3 轮。

## 5. 独立验收抓到的真缺陷（引擎自己的验证看不见）

```
契约点名                                  实际交付
src/core/csv.js            ✗ 缺    →    src/core/csv/index.js        （zone 合法，契约非法）
src/core/stats.js          ✓ 在         （另外还多出 src/core/stats/{index,stats,stats.test}.js）
```

- 靶项目的 `build` / `typecheck` 只做 `vm.Script` 语法检查 → **过**；
- 我直接点它：`node src/cli.js <带引号逗号+中文+空值的 CSV>` →
  `Error: Cannot find module './core/csv.js'`，`CLI_EXIT=1`；
  `require("./src/core/csv.js")` 同样 `MODULE_NOT_FOUND`。

⇒ **「过了门禁」与「能跑」之间还有缝。** 缝的具体形状：模型把"实现 src/core/csv.js"
解释成目录 + `index.js`，这在 `require("./core/csv")`（无扩展名）下能解析，
而 `t4` 的实现按契约写了带 `.js` 的字面路径，于是断在加载期。

## 6. 与 2026-09-19 那次对照

| | 09-19 | 10-06 |
| --- | --- | --- |
| 漂移形状 | `columnStats` 行列口径做反，实现与自写测试自洽 | 模块布局换成 `index.js`，`require` 字面路径断 |
| 谁发现的 | 独立验收方用真实数据跑契约样例 | 同样是独立验收（引擎的 build/typecheck/test 三轮都看不见） |
| 交付结局 | 7 文件落盘，sensenova 侧预算耗尽后由人工补完 `cli.js` | 未交付：墙钟硬杀、无凭据、`test` 因 tests/ 为空而红 |

两次共同点：**"写代码的智能体自写测试自证"这个结构性盲区没有被动过**。
不同的是这次多暴露一层——**任务契约里明明写着字面路径，平台却没有任何一致性检查**。

## 7. 待决（要人定的那件事，我没替他选）

要堵这条缝，有两个位置、语义不同：

1. **派发侧合规检查**：任务描述点名的字面路径必须出现在该任务的交付清单里 →
   在 t1 第一次交付时就拦下 `index.js` 布局漂移，成本近乎零（不跑任何东西），
   代价是把"等价布局"（`csv/index.js` + `require("./core/csv")`）判成违规——是否要这么严是个策略选择。
2. **验证侧加一条真加载冒烟**：对被交付项目跑 `node -e "require('<每个模块>')"` 之类的
   可加载性检查 → 拦住"过了语法但起不来"，但它是**项目类型相关**的（不是所有项目都能这样探），
   且会改变 `verifier` 的语义与基线归因口径。

两个都要配套：site 口径变异目标 + 一条"摘掉保护是否变红"的差分证明。
在拿到取向之前，我只把事实钉在这份文档里。

## 8. 诚实标注（这次没证到的）

- 这是**单次**真实运行，且是被墙钟截断的一次；不能推广成"平台交付不了"——
  同日简单形状的对照跑是通的：`node scripts/smoke-fullchain.mjs` **EXIT 0 / 约 2 分钟**，
  `OX_SMOKE=1` 的 6 条真实 API 用例 11.0s 全过，我另做的 11 条契约边界 11/11
  （见 `CHANGELOG.md`「实测（真链路复证，不进门禁）」）。
  差别就在**多智能体 + 严格跨模块契约**这一格。
- 没有跑 `--hard`（6 任务 / 3 zone / 跨智能体依赖）那一档，也没跑 `--real` 的更长墙钟版本；
  "给它 60 分钟能不能绿"是**未验证**的，我这次没测，不下结论。
- 429 与线路超时说明这一跑撞在账号级滑动窗口上（本机其他流水线共享同一窗口），
  时长数字因此不可与空闲窗口下的跑对比。
