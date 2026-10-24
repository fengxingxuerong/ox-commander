# 缺口盘点 2026-10-17（第五轮竞品刷新：从「补特性」转向「补分发与叙事断点」）

> 前四轮（09-29 / 10-02 / 10-03 / 10-11）的主线是**逐条吸收标准特性**，到 10-11 时对照表里
> 「真空白且可落地」的项已经清空（loop 检测 / per-agent 预算 / 成功率持久化 / 定时运行 /
> git 导出 / PR 集成）。所以本轮换口径：**不再问"哪个特性没有"，改问"为什么有优势却没人用"**。
>
> **口径声明（与前几轮一致）**：
> - 竞品侧取各仓库 README 原文（下界：README 没写 ≠ 没做；写了 ≠ 做得好）。本轮对
>   `superset` / `firstmate` / `cezar` 做了 README 深读，`orca` / `AO` 沿用前轮结论。
> - 本项目侧是**读源码后的自评**，口径与竞品列不同，不可比数字。
> - star 数取于 2026-10-16 检索（orca 92.9k · ego-lite 17.5k · superset 15.2k · AO 13.2k ·
>   worktrunk 9.3k · firstmate 8k · emdash 6k · cezar 649），落笔即过时。
>
> **赛道变化（10-11 → 10-17）**：品类从「编排器」改名定型为 **ADE（Agent Development
> Environment）**，并且冒出一批**桌面 IDE 形态**的新进者（`superset` 带终端+diff+内嵌浏览器、
> `warpforge`、`moontors`、`crossweave`）。共同点是：**它们不比谁拆得更聪明，比谁更像一个
> 能坐进去干活的地方**。这对我们是一个坏消息——我们的差异化在"判得准"，而用户此刻在买"看得见、摸得着"。

---

## 一、结论先行

1. **技术差距在缩小，分发差距在拉大。** 前四轮补完的特性（定时/预算/循环检测/PR）竞品多数也有；
   而竞品在**分发面**做的（`npx`/brew、英文多语 README、首屏动图、macOS 优先、VPS 自托管）
   我们一格都没有。这是当前最大的缺口，且**不需要改架构**。
2. **叙事有一个断点**：我们交付"一份过了门禁的"，但**用户看不到改了什么**——`FileJournal`
   有完整的改动记录，零 IPC 暴露，桌面端没有 diff 面板。竞品全员有 diff 审阅
   （superset diff viewer / cezar variants / pupitre merge gate / AO PR review）。
   「自证交付」这条主张缺了最后一米：能证明"跑过了"，不能让人"看一眼"。
3. **少数派路线仍缺对照数字。** zone 互斥 vs worktree 的代价只报了自己一侧（`zone:cost`）。
   主张没被证伪，也没被证实——读起来仍是主张。
4. **运行中人是哑的**：无追加指令、无终端接管、无通知。长任务（5–15 min）只能干等。

---

## 二、缺口清单（按"缺了它会不会没人用"排序）

### A 类：卡脖子——决定有没有人能装上、看得懂、留下来

| # | 缺口 | 竞品 | 本项目现状（证据） | 最低可补形态 |
| --- | --- | --- | --- | --- |
| A1 | **英文 README** | cezar 三语（en/zh-CN/zh-TW）；全员英文 | 仅 `README.md`，34KB 全中文，无英文版 | 一份 `README.en.md`（不必全量翻译：定位段 + 快速开始 + 差异表 + 门禁数字），中文版顶部加 `English` |
| A2 | **零安装分发** | cezar `npx cezar-run`；superset `brew install` + `curl` 脚本；firstmate `git clone` 即用 | `package.json` `"private": true`、**无 `bin`**、无 `.npmignore`；只有几十 MB 的 Release 包 | 发 `@oxcommander/cli`（只含 `dist-headless/` + 一个 `bin`），`npx` 可达 = 门槛从"下安装包"降到"一条命令" |
| A3 | **首屏动图** | superset hero gif + 5 个功能 gif；cezar YouTube demo + 12 张截图 | `docs/` 只有 8 张 `.png`，**全仓零 gif/mp4** | 录 `npm run demo` 一条 60s gif（零凭据零网络，现成可录），放首屏 |
| A4 | **macOS 产物** | superset macOS primary、cmux/conductor mac only、firstmate mac+linux | README 明示「不产出」：无签名凭据 | 两条路：找签名（成本/资质）或发 **未签名 CLI + 手写 Gatekeeper 绕过说明**。桌面端缺口可以认，CLI 缺口不该认 |
| A5 | **贡献入口** | cezar「PRs welcome」徽章 + CONTRIBUTING 段 | 无 `CONTRIBUTING.md`，`.github/` 只有两个 workflow，无 issue/PR 模板 | 一份 CONTRIBUTING（"改判据前先读 SKILL.md"）+ issue 模板 |

### B 类：叙事断点——决定主张能不能成立

| # | 缺口 | 竞品 | 本项目现状（证据） | 备注 |
| --- | --- | --- | --- | --- |
| B1 | **diff / 改动审阅面板** | superset diff viewer、cezar variants 比 diff、pupitre merge gate、AO PR 状态 | `electron/sandbox/file-journal.ts` 有 `FileChange`/`JournalStats`，但 **IPC 侧那个 `journal` 是 checkpoint 续跑快照**（`electron/ipc/context.ts:67 journalDir()`，写的是 `RunSnapshot`），**改动记录零通道**；BoardPage 无改动展示；回滚只由 `BatchGuard` 自动处置 | **最大断点**：交付凭据证明"跑过了"，但用户要"看一眼改了什么、能不能只撤这一个文件"。补法：新增 journal IPC + 看板一个改动区（只读 + 单文件回滚） |
| B2 | **zone vs worktree 对照实验** | 全赛道 13/16 走 worktree，各自都在讲自己的代价 | `scripts/zone-cost-report.mjs` 只算**本侧**（越权次数/并行度损失），worktree 侧明确「不编数字」 | 主张要拿数字说话，就得跑一次真对照：同一任务集在本项目与一个 worktree 工具（uzi / worktrunk）各跑一遍，报**两边各自的代价项**，不下"快 X%"结论 |
| B3 | **项目级约定注入（记忆）** | cezar `.ai/skills/*.md`（`project-conventions` 作为 step 的 skill）、firstmate `AGENTS.md` distro、superset 内置 skills | 跨 run 持久化只有 agent 成功率总账（`electron/sandbox/circuit-breaker.ts`）；**无架构说明/约定文档注入机制** | 每次 run 从零推约定是质量天花板。最低形态：项目根一份 `OX.md`/`AGENTS.md`，自动进规划与执行上下文 |
| B4 | **变体竞争 + 门禁裁决** | cezar「同一任务 ×2/×3 比 diff」、orca「N 份 diff 人挑」 | 无变体；一次一方案 | 与我们的命题**不冲突反而加强**：把"人挑 diff"换成"**门禁挑 diff**"（同一任务两方案 → 门禁裁决 → 交付赢家）。这是把竞品卖点翻译成我们语言的格子 |

> **B4 已于 2026-10-19 落地**（门禁挑 diff，不是人挑）：`variantCount > 1` 时同任务
> **顺序**派 N 个执行器（就地 + 变体存档），批末统一回放裁决——评级 = 验证命令
> （首败即停）+ 契约路径检查各算一门，赢家回放、输家回退；前向镜像失败降级
> "单派发 + 保留现场"并把事实写进 digest。settings 文件与 headless spec 可用；
> 桌面 SettingsPage 开关记为后续。

### C 类：产品面空白——一比就缺

| # | 缺口 | 竞品 | 本项目现状 | 代价 |
| --- | --- | --- | --- | --- |
| C1 | **通知**（完成/失败/待审批） | superset completion chimes + dock badge；cezar dashboard "what needs you" | `electron/main.ts` 无 `Notification`，全仓零命中 | serve 解决"能看"，没解决"该看了"。Electron 原生通知是廉价的 |
| C2 | **运行中追加指令 / 接管** | superset 终端 + follow-up prompt；firstmate "watch or type into"；cezar "send notes back" | 人为动作只有审批与三选一仲裁（`EscalationAction = skip\|redispatch\|abort`） | 长任务中途不能纠偏，只能等它跑完再重派；一次重派 = 一遍 token |
| C3 | **浏览器预览 / 端口** | superset in-app browser + per-workspace 端口；warpforge port forwards | `electron/engine/dev-server.ts` 只有 `ProbeVerdict = "alive"\|"dead"`；无 webview/iframe | 前端任务的验证闭环缺一环：跑起来 ≠ 页面没白屏 |
| C4 | **成本明细** | cezar「Usage & cost by project」+ 项目维度对比 | `shared/usage-meter.ts` run 级；`zone-cost` 是越权/并行度统计，非金额非按模型 | 预算这条优势只到"看得见总数"，不能回答"哪个模型最费/哪个任务最贵" |
| C5 | **任务队列 / 多 run 并发** | cezar 队列 + 一 cockpit 管所有项目 + 子任务派发（上限 4） | `headless/serve.ts` 注释明写「不做队列，第二个 POST 拿 409」；桌面单实例锁 | 单 run 语义是刻意的取舍，但对外读作"不能排队" |
| C6 | **执行器自动探测** | superset/cezar/firstmate：选一个已登录的 CLI 即用，缺工具还会提示装 | `AgentRegistry` 只消费外部传入的 `AgentSpec[]`，无 PATH 扫描；`agents.d/` 是 `*.example.json` 静态模板 | **接入摩擦最大项**：第一步就是手写 JSON manifest。扫 PATH 出候选 + 一键生成 manifest 即可 |
| C7 | **远程 / 自托管常驻** | cezar `server-install`（HTTPS + 登录 + systemd）；superset remote access | http-bridge 只把**执行器**放远端；编排侧仍是本机单实例，鉴权只有单个 `OX_SERVE_TOKEN` | 24/7 场景（夜里跑、合上笔记本继续）完全够不着 |
| C8 | **IDE handoff / SDK** | superset「Open in your IDE」+ `@superset_sh/sdk`；cezar HTTP API | 有 MCP + JSONL（很强），无 SDK 包、无 VS Code 扩展、无 TUI | MCP 已覆盖可编程性，SDK 优先级低于 A 类 |

> **C4 已于 2026-10-24 落地**（v0.3.0，`usage:cost`）：勘查发现缺口比表格记的更深一层 ——
> 不是没有视图，是**数据不持久**（byModel 只活在 run 进行中的 usage 协议事件里，凭据落盘时
> 被裁掉）。所以先补数据（凭据随 `usage.byModel` 落盘，键序由 canonical 序列化排定），再补
> 跨 run / 跨项目聚合（`electron/usage-cost.ts`，tier 1，17/17 逐位点全杀）。"哪个任务最贵"
> 仍未回答且**刻意不回答**：按任务的归因不存在于任何持久事实，摊派就是编数字 —— 报告把
> 这句话打出来（工程日志有完整账）。
>
> **C7 已于 2026-10-24 落地**（v0.3.0，`serve:unit` + [serve-deploy.md](serve-deploy.md)）：
> 勘查发现鉴权底子已在（2026-10-10 的 token 前置所有路由 + 非回环无 token 拒启），缺的是
> 部署形态。补的是**单租户自托管**：systemd 单元生成器（判据：token 永不落单元、
> `--host=127.0.0.1` 唯一取值、strict 与可写路径成对）+ 反代 TLS（caddy/nginx，SSE 关缓冲）
> + 四条验收清单。多租户登录体系明确不做（与 D 类口径一致）。
>
> **C8 暂缓**（2026-10-24 决定）：SDK 的公开 API 一旦发布就难改，而 npm 包尚未发布
> （等维护者 `npm login`）—— 没有消费者的 API 设计是空转。npm 通道开通后再设计，
> MCP + JSONL 在此之前覆盖可编程性。

### D 类：明确不补（附理由，别被带着跑）

| 不做 | 理由 |
| --- | --- |
| 转 git worktree 隔离 | 会丢掉跨模块协同与"一份交付物"；要补的是 B2 的数字，不是换路线 |
| 移动端原生 App | 推送基建 + 双端发版成本远高于收益；C1 通知 + 已有 serve Web 覆盖主要场景 |
| "人挑 diff" 的 variants UI | 与命题冲突。要补的是 B4：门禁挑，不是人挑 |
| swarm / 群体智能框架 | ruflo 73k 已占位，不是我们的命题 |
| 组织/预算治理层 | paperclip 92k 已占位，我们的纵深在"代码交付可验证" |
| 为 star 改定位 | 三个占位者的热度来自"能跑更多 agent"，我们的价值是"少看 diff"——不同主张，不是落后 |

---

## 三、如果只做三件事

按「投入产出 × 不动架构」排序：

1. **A2 + A1 + A3**（一条 npx 命令 + 一份英文 README + 一张 demo gif）。
   全部零架构改动，直接决定陌生人能不能在 3 分钟内跑起来。当前最大的浪费是：
   有 1723 处逐点验证过的判据，却没有任何一条路径能让陌生人低成本验证它。
2. **B1**（diff 面板）。把"过了门禁"从凭据里的断言变成屏幕上的改动 —— 这是
   「交付一份过了门禁的」这句话唯一缺的那一米。
3. **C1 + C2**（通知 + 追加指令）。人从"等结果"变成"在场"，长任务的体验分水岭。

B2（对照实验）单独排期：它不是工程量问题，是**要不要为少数派路线做一次真实验**的问题——
不做，zone 互斥永远是主张；做了，才有资格在 README 里说"为什么更好"。
→ **已于 2026-10-18 执行**（worktrunk 路线）：结果与两侧代价项见
[2026-10-18-zone-vs-worktree-b2.md](2026-10-18-zone-vs-worktree-b2.md)（不下"快 X%"结论）。

---

## 四、复现与核对

```bash
# 本项目侧的事实核对（本轮盘点所用）
grep -rn "Notification" electron/main.ts        # C1：零命中
grep -rn "journal\|diff" electron/ipc/*.ts      # B1：无通道
grep -rn "requestSingleInstanceLock" electron/  # C5：单实例
node -e "const p=require('./package.json');console.log(p.private, !!p.bin)"   # A2

# 竞品侧取数
curl -s https://api.github.com/repos/superset-sh/superset | grep stargazers_count
```

声明：本轮对 superset / firstmate / cezar 的判定来自其 README 原文（10-16 抓取），
**未做源码深读**——竞品列的"有"是宣称下界，如同我们对外的 README 也只是我们的宣称下界。
