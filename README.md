# OxCommander

[English](README.en.md) | 简体中文

[![verify](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml/badge.svg)](https://github.com/fengxingxuerong/ox-commander/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
![mutation gate](https://img.shields.io/badge/mutation-逐位点全杀-blueviolet)

<img src="docs/demo.gif" alt="npm run demo：一次真实交付（规划 → 派单 → 门禁 → 交付凭据 → 外部复核）" width="100%">

> **别的编排器给你 N 份 diff 让你挑；OxCommander 交付一份过了门禁的。**
>
> 判错逻辑本身被**逐位点**证明过：当前在册 **116 个目标** / 基线 **3122 处位点**。
> **全量** site 审计由 CI 的 `mutation (site, tier …)` 三个分片 job 每次 push 跑（Linux，片内 `--jobs=1` 串行）：
> tier 1 单片 + tier 2 轮转两片。2026-10-16 修掉一处**分片假象** —— `--tier` 此前实现为 `t.tier <= N`，
> 于是 `--tier=2` 那片实际跑的是**全部「73」个目标（该次当时的在册数）**（含 33 个 tier 1），run #153 的 tier1 23.4 min / tier2 54.8 min
> 里，tier 2 有约 23 min 是**重复跑 tier 1**。现在 `--tier` 是精确匹配、tier 2 再按 `--shard` 轮转切 2 片
> （分片由工具自己算，各片之并恒为全集，不漏目标）。修后首轮实测 @ `80946b0` run #38922557558 **五 job 全绿**：
> tier 1 单片 17.6 min · tier 2 两片 12.7 / 13.7 min · `verify` ubuntu 3.4 min / windows 4.8 min ——
> 最长的 job 从 54.8 min 降到 17.6 min，重新落回 runner ~35 min 回收窗口之内。
> 结论与数字（杀死 N/M、存活清单）写进该 job 的 **summary**，不用翻 log。这两个数里的"基线"由 `check:doc-claims` 对实物核（取自
> `mutation-check.mjs` 的 `SITE_BASELINE`）—— 它随 TARGETS 增长，而增长是加代码的自然结果，
> 所以**落笔即被检查**（上一版这里停在「881/881」那个时期的规模）。⚠️ 基线现值与全量审计结果是
> 两个数：前者说"有多少处该被逐点验过"，后者说"这一批位点真跑全量是什么结果" —— 混着写就是自证。

**总指挥智能体**：把项目需求拆解为 PRD → 任务 → zone 互斥批次，按能力路由并行下发给执行器
（SenseNova API 池 / Codex 等 CLI / HTTP 桥接智能体），经 build + typecheck + test 多轮硬性验证后交付。
Electron 桌面端 + headless CLI 双入口。

> **设计定位（与同类编排器的差异）**
>
> 同类项目大多走「git worktree 隔离」路线——每个智能体在独立目录里互不干扰
> （2026-09-29 实测：15 个同类项目里 12 个走这条路，[调研报告](docs/2026-09-29-competitive-landscape-and-roadmap.md)）。
> OxCommander 走的是**共享工作区 + zone 互斥**：智能体像真实团队一样在同一棵树里
> 按目录分派并行，越权由仲裁层回滚/隔离。另一条路线，两种取舍：
>
> | 特征 | OxCommander | Orca（80k★） | paperclip（92k★） | ruflo（73k★） |
> | --- | --- | --- | --- | --- |
> | 命题 | 自动拆解 → 并行 → **硬门禁闭环** → 交付 | ADE：把 N 个 CLI agent 摆在一个桌面里跑 | 管 AI 员工团队（组织/审批/预算） | 多模型 swarm 框架 |
> | 谁拆解需求 | **引擎自动 PRD → 任务 → 批次** | 人手动扇出 prompt | 人建 org chart 与目标 | 工作流自编排 |
> | 终点 | 一份过了门禁的交付 + 凭据 | N 份 diff，人挑赢家 | 审批与成本看板 | 任务执行结果 |
> | 执行器 | **自带 LLM 池**，不依赖订阅 | 带你自己订阅 | 带你自己订阅 | 带你自己订阅 |
> | 隔离 | zone 互斥（可跨模块协同改接口） | worktree 物理隔离 | 不涉及代码合并 | docker / swarm |
> | 沙箱 | 路径七级判定 + 白名单 + 双超时 + 熔断 | README 零命中 | 治理层策略 | 有 |
> | 谁适合 | 要**可担保的交付结果** | 要同时跑很多 agent 自己比 | 要管一支 AI 团队 | 要搭 swarm 应用 |
>
> 本项目自身的能力面：
>
> | 特征 | OxCommander |
> | --- | --- |
> | 交付凭据 | 每次运行产一份 **delivery receipt**：验证结论 + 逐任务账 + 越权处置 + token 用量，桌面落盘并**把外部可验证性的两半摆出来**（`checks[].command` 原样可见、`fingerprint` 整串可选），headless 发 `receipt` 事件、serve 状态页整份渲染 |
> | 改动可见 | 看板「改动文件」卡：每批改动（含干净批）落 `batch-changes` 审计，按批次折叠展示 op/字节数 —— 「交付一份过了门禁的」之外，再回答"它动了什么"。**逐行 diff + 单文件回滚**（B1 第二半）：批次成功后备份转**存档**（容量策略只保留最近 8 批），diff 是"存档旧内容 × 盘上现状"；回滚从该批存档恢复，新建文件须有审计里的 `create` 证据才肯删（没证据宁可留一个脏文件）；存档过期或未配置快照存储时按钮不出现，边界写在卡片上。**本次产物 + 怎么验收**（最后一米）：run 收束后按任务分组列出产物路径，点开即读只读全文（不用开工作目录）；同时给出凭据里的复跑命令与 `package.json` 的 `dev/start/preview/serve` 启动命令，一键复制。同一份结构（`shared/delivery-guide`）经 `acceptance` 事件进 serve 状态页，两端不会各说各的 |
> | 项目约定 | 项目根的 **`OX.md` / `AGENTS.md`** 自动进上下文：规划（PRD 提示）与每个任务的派发描述都带，顺序是 **任务描述 → 约定 → 平台契约 → 操作者附言**。约定块自己声明"不覆盖契约"；单文件上限 256KB、总注入上限 8000 字符，截断时**说破**原长度；读不动的文件只报不抛 |
> | 执行器自动探测 | 智能体页「扫描本机执行器」：扫 `PATH` 找已装的编码 CLI（Claude Code / Codex / Aider / Gemini / Goose / Qwen Code），命中即可**一键接入** —— 参数取仓内带实测参数的模板，不用手写 JSON manifest。扫描**只读 PATH、不执行任何命令**（候选 CLI 不会因为"被扫了一下"就启动一次）；没装的那条给安装命令，且**不显示"接入"**（派发与扫描用同一个 PATH，扫不到 = 接进来也必红） |
> | 交互式编码会话 | 桌面「会话」页与 CLI（`ox chat` / `exec` / `resume`）共用同一套工具循环：模型自己 `read_file` / `grep_files` / `apply_patch` / `run_command`，平台逐条展示并审批。会话落盘可恢复/分叉；补丁带逐行 diff 与单文件/整轮撤销；沙箱读路径走 realpath、禁读 `.env`，命令子进程走 `scopedEnv`，批准后的命令可被停止真杀。项目根的 `AGENTS.md`/`OX.md`、`.ox/config.json` 与全局/项目 `policy.d` 一起进边界；正文**流式**逐块到达（桌面实时行 + CLI 逐字；端点不支持时自动退回整段；长会话到预算后自动压缩历史：旧消息换成摘要并当场说明压掉了几条，转录原文一条不少，`ox chat --compact-tokens 0` 可整条关掉）；会话页为**三栏工作台**（左：项目与线程树，中：执行流，右：改动审查 —— 逐行 diff、行级评论（随下一条消息发出，带文件/轮次/改前改后/行号四样定位）、按 (turn, path) 撤销、不可撤销的改动照实列出；切项目/切线程只导航不发起动作）；输入框 **`@` 引用项目文件**（键盘上下选择/Enter 插入，文件列表跳过 `.env`/`.git`/`node_modules`/`dist` 等重目录并封顶 2000 条）；**线程头**可直接切本线程的沙箱（只读/工作区/完全）、审批（都问/按策略/从不）、模型（已登记 provider × model，钉死单线路、不走全局池）与推理强度（只对实测登记线路开放：`sensenova/deepseek-v4-flash` 的 low/medium/high、`sensenova/glm-5.2` 的 high；未登记线路不显示开关，默认不主动开思考），下一条消息生效且历史保留；**多条线程可同时跑**（宿主侧按 `sessionId` 寻址：开新线程/分叉不再中止别人，审批归属到线程且 id 带会话前缀 —— 工具调用 id 只在会话内唯一，两条线程同时问第一件事会撞键；界面仍只渲染当前这条；左栏为每条线程显示状态点（在跑/等审批/完成/出错/中止）与"离开后新增条目数"，切回去即清零，且**别处在跑不再锁住切换**（锁只留给删除/分叉一条正在跑的线程）；后台线程等审批会弹系统通知，正看着的那条不弹；**并行写冲突检测**：写文件前查别的活跃线程的写台账，命中就弹审批并写明"哪条线程 30 秒前改过"，人拒绝就不写，自己的写不算冲突，无审批通道按拒绝）；右栏可把本线程的补丁改动**导出为 git 分支 + commit**（默认不 push，勾选后才推；不可审阅的改动逐条列出，不静默混入）；**技能目录**（项目 `.ox/skills` + 全局 `~/.ox/skills` 扫进会话提示，只给"名字+用途"、全文由 `read_skill` 按需取 —— 项目级走与 `read_file` 同一条沙箱读判定，全局级以技能目录根为界，名字只在注入表里查、不参与路径拼接；同名时项目级压过全局级；坏技能以"路径+原因"列在技能页上）；**MCP client**（清单放 `<userData>/mcp.d/<server>.json`，**会话首次发送时**才起进程 —— 页面加载不拉起外部进程；工具以 `mcp__<server>__<tool>` 并入工具循环，调用前按 `tool: "mcp"` 走审批、返回过脱敏与截断、超时有硬上限、连续传输失败进冷却；server 是**外部进程**（沙箱外），平台不为它的行为背书，这句话写在技能页上）；**尚未做**多线程同屏分栏（当前是"一条在前台、其余在左栏亮状态"） |
> | 人在回路 | 任务附言：运行中给任务挂一句纠偏指示，**下一次派发生效**（执行器是一问一答形态，没有在途插话通道，界面不暗示实时送达）；任务行与升级卡（"带话重派"）都有入口；成功后自动退休。只对在跑的 run 有效 —— 运行前的 steering 归 PRD 评审页 |
> | 通知 | 桌面系统通知（只三类：run 出结论 / 任务待决策 / 命令待审批）—— 长任务切走后"该回工位了"由操作系统喊，判据是纯函数可逐点审计；`isSupported` 为 false 安静降级。回到工位后由看板顶部**「该你了」注意力条**接棒：把"不来就卡住"的事按 升级卡 > 命令审批 > 静止的失败任务 聚成一条（纯派生、升级卡已覆盖的失败任务不双报、空态不出条），判据同进变异门禁 |
> | 执行器 | **自带 SenseNova LLM 池执行器** + Codex/Claude CLI + HTTP 桥（不依赖订阅） |
> | 并行隔离 | zone 互斥批 + 冲突仲裁（回滚/隔离/报告四档） |
> | 验证 | **动手前先跑基线** + build/typecheck/test 硬门禁 + repair loop 归因重修 + 产物冒烟 + **dev server 探活**（前端任务可选：规划器可在 smoke 里声明 `devServer: {url, timeoutMs?}`，只接受回环 http(s)；驻留进程轮询 HTTP；桌面端在探活与页面冒烟都通过后**保活为运行预览**，默认 30 分钟自动停止，看板可在应用内预览窗口打开、看日志尾部、手动停止）+ **页面冒烟**（探活 2xx 后再取一次首页正文，**只判红明确错误页**：Vite/webpack/CRA/Next 的失败页、`Cannot GET`；SPA 空壳不判红但把"没法确认"写进 digest —— 不做 DOM 渲染，那要无头浏览器，不进验证链） |
> | 运行预览 | dev server 冒烟（探活 + 页面冒烟）通过后，桌面主进程把它保活为预览：单实例（新预览替换旧的）、日志尾部 16KiB、默认 30 分钟自动停止，应用退出/新一轮开始前清理；看板可**在应用内预览窗口打开**（窗口的浏览器 profile 按项目隔离：cookie / localStorage 各归各的，关窗不丢登录态，清除是显式动作；窗口不给 preload 桥、开沙箱、导航与重定向只放行本机回环）、看日志、手动停止。地址只接受本机回环 `http(s)`；headless/serve 不保活（仍跑完即杀） |
| 沙箱 | 路径七级判定、命令白名单 + 元字符拦截、双超时、熔断、循环输出检测（卡死空转即中止）、快照回滚 |
> | 预算 | token 用量可见性 + `maxTokensPerRun` 软上限闸门（**只看得见端点上报的用量**；遇到不回报 usage 的调用会当场说破"这道闸看不见它们"，刻意不估算） |
> | 交付分发（可选，默认关） | 过硬门禁后把 zone 内改动导出成 **git 分支 + commit**（**默认不 push**）；显式开关后可推到指定 remote / 开 PR / 等 CI 结论 —— **CI 结论只回流，不自动重修**；不碰凭据、永不 `--force` |
> | 协议 | headless JSONL 协议（外部宿主可编程驱动）+ **反向 MCP server**（agent 生态节点：查状态/取凭据/派单/暂停继续） |
> | 代价可量化 | `npm run zone:cost` 从审计事实算出越权次数与并行度代价 —— 少数派路线要拿数字说话；`npm run usage:cost` 跨 run / 跨项目对账 token 成本（按模型排名、按凭据逐份、未上报边界同行）—— 凭据自 2026-10-24 起随 `usage.byModel` 落盘，聚合只认持久事实，按任务的归因不存在就不摊派 |

```
需求 → PRD → PLANNING → DEVELOPMENT（zone 互斥并行） → VERIFICATION（build/typecheck/test） → DELIVERY → DONE
                ↑______________ repair loop（按 zone 归因重修）______________|
```

## 一条命令先跑起来（不 clone、不 build）

```bash
npx oxcommander --help
echo '{"requirement":"...","projectRoot":"."}' | npx oxcommander   # 一次交付，stdout 出 JSONL 事件
npx oxcommander serve --port=8787    # 常驻服务：状态页 + SSE + POST /run
npx oxcommander mcp                  # MCP stdio server，接进 agent 生态
npx oxcommander chat                 # 交互式编码智能体（REPL）
npx oxcommander chat exec "修好失败的测试" --json
npx oxcommander receipt receipt.json --replay   # 独立复核一份交付凭据
```

> CLI 包由 `npm run build:cli` 从 `dist-headless/` 产出（`dist-cli/`，git 忽略），
> `smoke:cli-pkg` 负责把关：bin 指向的文件真的在盘上、五个入口齐全、转发真的到达协议层。
> 发布：`cd dist-cli && npm publish`。桌面安装包见下方「获取与安装」。

## 快速开始

```bash
npm install
npm run verify        # 唯一验收门禁（见下）
npm run dev           # 浏览器开发模式（无 Electron 壳）
npm run dev:electron  # 桌面端开发模式
npm start             # 运行已构建的桌面端
```

### 先跑一遍看看（零凭据、零网络）

```bash
npm run build:headless
npm run demo
```

它会现场造一个小目标项目（一个 CSV 统计工具），用**本进程起的假大脑与假执行器**
（都开在随机端口上）驱动真的 headless 引擎跑完一次交付，再把产出的**交付凭据**
交给独立复核工具核一遍：

```
规划 → 派单 → 落盘 → 门禁（node --test） → 交付凭据 → 外部复核
```

一条命令全过，不需要任何 API key，也不需要联网。命令、事件流与断言都是可读的 ——
不必先读完四个 IT 脚本才能明白这套东西到底在做什么。`--keep` 保留现场（临时项目、
事件流、凭据），`--quiet` 只看结论。

> 需要 **Node >= 20.19**（`package.json` 的 `engines`）。运行时这一侧真正的依赖是
> `AbortSignal.any` —— 没有它就没法把取消/超时下传给在途 LLM 请求。headless 入口按**特性**判，
> 缺了会先发一条 `error` 事件再说清"换哪个版本"，不会跑到一半抛 `TypeError` 堆栈。

> 桌面端是**单实例**应用：重复启动不会开第二个指挥台，而是把已有窗口提到前台。
> 这是有意为之 —— 两个实例驱动同一个 projectRoot 会各建快照、各自回滚，
> 审计里会出现互相矛盾的 run 记录。

headless（供外部宿主以 JSONL 协议驱动整个平台）：

```bash
npm run build:headless
echo '{"requirement":"...","projectRoot":"D:/path/to/project"}' | node dist-headless/headless/headless-main.js
# 协议字段、事件与退出码见 docs/headless-protocol.md
```

**或者起一个常驻服务**（浏览器/CI/远程都能看，同一套事件语义）：

```bash
node dist-headless/headless/serve-main.js --port=8787
# → http://127.0.0.1:8787/ 看状态与交付凭据
#   /events 是 SSE 事件流（后连上的客户端会先补齐历史）
#   POST /run 投递 spec（一次只跑一个，第二个拿 409）
```

**再进一步：定时运行**（2026-10-11，学 Orca 的 scheduled automations）：

```bash
node dist-headless/headless/serve-main.js --port=8787 \
  --every=30m --spec=./nightly.json --schedule-state=./schedule-state.json
# 到点自 POST /run（单 run 语义/409/SSE/鉴权零改动复用）；忙时跳过不积压；
# 停机期间错过的触发点重启补跑一次（至多一次）；语义详见 docs/headless-protocol.md §8.1
```

**再进一步：VPS 常驻部署**（2026-10-24，C7 —— 夜里跑、合上笔记本继续看）：
`npm run serve:unit` 生成带安全判据的 systemd 单元（token 永不落单元、服务永远只听
`127.0.0.1`、`ProtectSystem=strict` 与状态目录可写成对、定时参数成对或都不出现），反代终结
TLS 指回回环 —— 公网入口与业务服务各管一段。完整步骤（建用户 / 环境文件 / caddy 或 nginx /
验证清单）见 [docs/serve-deploy.md](docs/serve-deploy.md)。

**或者把它接进 agent 生态**（反向 MCP，竞品调研 5.5）：

```bash
node dist-headless/headless/mcp-main.js --serve-url=http://127.0.0.1:8787
# MCP stdio server：ox_status / ox_receipt / ox_events / ox_run / ox_control
# Loomy 等 MCP 宿主把它注册成 server，即可编程驱动整个平台
```

> serve 形态补的是「离开工位也能看」这一格 —— 实测 15 个同类项目里只有我们缺它
> （Orca 有桌面 + 手机伴生 + SSH worktree）。MCP server 再补一格：编排层自己
> 成为 agent 生态的一个节点（Vibe Kanban 的双向集成路线）。⚠️ **默认**无鉴权、无 TLS：
> 本机/内网/SSH 隧道后用 —— 若要直接暴露，设 `OX_SERVE_TOKEN` 即开启 opt-in 的 Bearer 校验
> （serve 全路由生效，MCP 侧自动带上；SSE 与浏览器页面可走 `?token=`），不设则行为与以前一致。

**再进一步：拿到凭据的人可以自己复核它**（不依赖我们，也不依赖这个仓库）：

```bash
node dist-headless/headless/receipt-verify-main.js receipt.json
#   只验内容指纹 + 列出凭据记下的可复跑命令（默认不执行任何东西）
#   注意 not-replayed（退出码 5）不等于验证通过 —— 指纹一致只说明"没被改过"
node dist-headless/headless/receipt-verify-main.js receipt.json --replay --cwd=<项目目录>
#   在本地重跑那些命令并逐条比对：0=复现 / 2=矛盾 / 3=被改过 / 4=没盖章
```

> 别的编排器说"过了门禁"，你只能选择相信；这里凭据自带**跑过的命令**与**内容指纹**，
> 复核工具据此在**你的**环境里重跑。这是 `checks[].command` + `fingerprint` 存在的
> 全部理由（详见 `docs/headless-protocol.md` 第 9 节）。

## 获取与安装

**方式一：下载安装包**（推荐，不用装 Node）

到 [Releases](https://github.com/fengxingxuerong/ox-commander/releases) 取对应平台的产物，
或到 [Actions 页](https://github.com/fengxingxuerong/ox-commander/actions) 取任意一次
`release` 运行的 artifact（手动触发也会产出，不需要打 tag）：

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows | `OxCommander-<ver>-x64.exe`（nsis 安装版）/ `…-x64.exe`（portable 免安装） | 两种都出，portable 解压即用 |
| Linux | `OxCommander-<ver>-x64.AppImage` / `.deb` | AppImage 直接 `chmod +x` 后运行 |
| macOS | **无桌面端安装包** | 无签名凭据；未签名 .app 会被 Gatekeeper 拦下，故宁缺（桌面端缺口认了）。但 **`npx oxcommander` CLI 在 macOS 可用** —— 纯 Node 包、无原生依赖，`verify` 工作流的 `cli (macOS)` job 每次 push 都在 macos-latest 上造包并冒烟 |

⚠️ **跑起来之前要有凭证**：桌面端在「设置」里填即可（加密进 OS keychain），也可以放一份 `.env`。
至少给一把商汤的 key：

```dotenv
SENSENOVA_API_KEY=sk-...          # 必填，一条 key 就能跑
# SENSENOVA_API_KEY_2=sk-...      # 选填：多把 key = 12 条线路，429 时可 failover
# SENSENOVA_API_KEY_3=sk-...
# AMD_API_KEY=...                 # 选填：加第 13 条（DeepSeek-V4-Flash）
```

规则：`.env` **只补缺失项**，宿主环境里已设的值不会被覆盖；无 key 的 provider
（本地 Ollama 之类）照样保留其线路。

> 桌面端**可以不备 `.env`**：「设置」里填的 key 经 OS keychain 加密落盘，构建引擎时按池内 provider
> 补回进程环境（大脑层与内置执行器同一来源）。优先级是 **进程环境 > `.env` > keychain**，三者都只补缺失项。
> headless CLI **不读 `.env`** —— 加载 `.env` 的是桌面端主进程（`electron/main.ts`）。
> 由宿主驱动时请把凭证放进它 spawn 子进程的环境里；缺失时 runner 会在 `hello` 之后立刻报
> 需要哪几个变量并以退出码 1 结束，而不是等到第一次模型调用才吐内部错误。

**方式二：从源码跑**（开发者）

见上方「快速开始」的四条命令；headless CLI 用法也在那一节。

**方式三：自己打包**

```bash
npm run build:dist    # → release/，只打**当前平台**的原生目标
```

`build:dist` 刻意**只打当前平台**：Windows 上的 AppImage/deb 需要 Docker、Linux 上的 NSIS
需要 wine，写死 `--win --linux` 会让每个平台都有一半目标站不住（首次真跑就是这么红的，
两个 CI job 各在 30 秒内失败）。全平台产物由 `release` 工作流的 windows + ubuntu 矩阵各自产出。
确实装了 wine / Docker 的人可以 `node scripts/build-dist.mjs --targets=win,linux` 显式跨平台。

首次打包会下载 Electron 二进制与各平台工具链（几百 MB，本机需代理），
所以**推荐让 CI 出产物**：推 `v*` tag 会自动建 Release 并挂上安装包，
也可以在 Actions 页手动触发 `release` 来验证打包配置本身。

## 质量门禁

`npm run verify` 是唯一验收入口，任何改动以它全绿为准（**35 段**，3–11 min —— 时长几乎全挂在
`mutation:touched` 上，改动面越大越久。2026-10-06 逐段实测：链首到 `mutation:baseline` 的 16 个静态段
+ `npm test` + `build` + `build:headless` + `smoke:demo` 全 EXIT 0）：

```
check:residue（首段，卫生预检：上一次变异运行被强杀时，活体变异体会留在源码里 ——
  它让修复循环空转，症状是链里的 `npm test`（vitest）堆涨到 4.6GB 后 OOM 且不退出，完全不像"工作区脏"。
  有残留就还原并退出 2 逼人重跑；台账坏掉也退出 2，因为它无法证明工作区干净；
  台账丢了而备份还在时，逐份按备份名映射回源码核内容 —— 对得上才算干净，对不上退出 2 且只点名不动手；
  台账上写着"别的进程还在跑"（pid 活着）时，那是别人正在跑的现场而不是残留 —— 不清它、本轮也不启动）
→ typecheck（renderer / electron / headless / vite 配置 四套 tsconfig）
→ lint（eslint flat config，含 react-hooks 规则；不覆盖 docs/；
  `scripts/**` 自 2026-09-28 起也进 lint —— 那 5.7k 行是门禁判据本身，而 tsc 一行都不看；
  `shared/**` 另有分层红线：禁 node API、禁依赖宿主层与上层）
→ check:unwired（导出符号在生产代码里零调用 → FAIL；豁免表项失效同样 FAIL）
→ check:field-orphans（接口字段只有生产者、没有消费者 → 报候选；`shared/` 内的真孤儿 FAIL）
→ check:exhaustive（以联合类型为键的映射表 / 穷尽 switch 少登记一档 → FAIL。
  tsc 只兜得住 `Record<Union, …>` 缺键，**兜不住 `switch + default`**
  —— 那一家的"没覆盖"被写成了"覆盖其余一切"；命令串带 `--selftest`，判据自己先过 4 例）
→ check:scripts / check:scripts-wired / check:packaged-paths / check:masker
  （工具脚本语法与接线、打包路径缺陷判定、掩空器自测 24 例）
→ check:workbuddy-bridge（`scripts/workbuddy-bridge.mjs` 的沙箱判定：放行谁、拦谁，外加
  `writeFiles` 的整批原子性。口径与平台 `shared/glob.ts → isPathInZone` 逐字对齐 —— 2026-10-15
  桥缺 `z.` 前缀规则，zone 取“文件名级”粒度时契约要求的字面路径被判越权；同日 CI 又暴露
  `path.isAbsolute` 的宿主分叉。72 例按锚点抠函数注入 `path`/`fs` 跑，其中判定用例在宿主视图与
  `path.posix` 视图上各跑一遍并逐条要求理由一致）
→ check:tests-collected（盘上有、但 vitest 根本不收集的测试文件 → FAIL；
  vitest 收集不到任何文件也 FAIL —— 收集过程坏了不许报绿）
→ check:ipc-channels（preload 引用的通道 ⇔ `ipcMain.handle` 注册的通道，两个方向的漂移都拦；
  一侧解析为空也 FAIL —— 解析失配当通过就等于一道永远绿的摆设）
→ check:mutation-targets（改过的生产文件既不在变异 `TARGETS` 也不在显式豁免里 → FAIL。
  漏挂的文件根本不参与统计，那个 PASS 对它没有任何含义）
→ check:doc-claims（本节这几个数字**由命令现算**：段数、每段在文档里有没有行、
  用例数是否等于 `vitest list` 的收集结果、变异规模是否等于 `site-baseline --json`）
→ mutation:baseline（约 1s，不跑变异：把 TARGETS 的逐目标位点数与 `SITE_BASELINE` 对一遍。
  **变异正在跑时它拒绝算**（检测到 `scripts/.mutation-pending` 里有 `.orig` 就 exit 2）：那一刻读到的是
  变异中的源码，报出的"漂移"是假象 —— 而照着假象去 `--write` 会把变异体的位点写进基线，污染得很安静。
  位点数涨了而基线没更新 = 新位点**没人逐点审计过**，此时「全部 N 处已逐点验证」是假象。
  这道漂移检查此前只在 site 口径里判，而 site 口径本机 verify 从不跑 ⇒ 漂移只有 CI 才知道。
  它同时自测「把新基线写回源码」这一步（`--selftest`：连写两次逐字节相同 / 块尾攒出的
  空语句一次收敛 / 无漂移时不误伤，条数由脚本自己打印）—— 旧实现每跑一次 `--write` 就多一个
  空语句，而 `check:scripts` 视空语句为合法，所以它只会静默累积）。
  同批还校验 **`EQUIVALENT_SITES` 每一条都还能匹配到真实位点**（`(算子, 行号)` 逐条比对，复用门禁
  自己的 `findSites`）：失效条目豁免的是空气，而漂到新行的那个位点无人认领 —— 2026-10-23 一天内
  因此红了两轮 CI（`context.ts` 221→225、`path-policy.ts` 92→94，后者直接拦住发布）
→ vitest（2026-10-25 现跑 3022 通过 + 8 跳过，合计 3030 条，分布在 103 个有可执行用例的文件；
  同一条 `npm test` 由 CI 在 ubuntu + windows 两个 job 各跑一次，本文件不复制它的结论。
  ⚠️ 本机 win32 上**间歇**出现真进程用例红，集中在 git-export / headless-entries /
  mutation-residue 三个文件，原因是宿主阻断子进程 stdio 管道（`spawnSync EBUSY`）而不是判据坏；
  2026-10-13 本机这三个文件全绿。别把间歇红当本地基线 —— 判据是当场重跑那三个文件看是否复现。
  真实 API smoke 由 OX_SMOKE=1 + SENSENOVA_API_KEY 门控，默认跳过）
→ mutation:quick（tier 1 目标，每目标 1 个 aggregate 变异——最弱档，别读成"变异全过"）
→ vite build + tsc headless 构建
→ smoke:artifact（产物层离线冒烟：dist 产物存在性、dist-electron 全量语法检查、
   headless 二进制协议退出码——防止"源码全绿但产物坏了"）
→ smoke:chat-agent（交互式会话**真进程** IT：假 HTTP 大脑 + 真工具循环/补丁落盘/
   审批拒绝理由回灌/会话中止；零配额、随机端口）
→ smoke:chat-cli（CLI 会话**真进程** IT：`exec --json` 工具结果回灌、第二个进程
   `--session` 恢复、项目 policy.d 拦命令、非交互 untrusted fail-closed、REPL `/help`）
→ smoke:receipt-verify（交付凭据复核工具 `receipt-verify-main.js` 的端到端冒烟：
   8 例覆盖五档裁决与五个退出码，含"复跑的命令真的执行了"与
   "指纹不符时即使给了 --replay 也不复跑"两条非空转证据）
→ smoke:demo（对外可复现样例 `demo-deliver.mjs`：零凭据零网络的**一次完整交付**，
   顺带把凭据闭环走通 —— 产出凭据 → 独立复核默认模式判 not-replayed（指纹一致
   ≠ 结论为真）→ `--replay` 复跑判 verified。它同时是 README 的演示与回归基线）
→ smoke:snapshot-secrets / smoke:gateway / smoke:coze / smoke:import / smoke:offline-e2e（五条集成链路，最后一条是零配额的离线全链路 E2E）
→ smoke:target-range（LLM 故障转移靶场：本地故障注入端点矩阵，18 场景走真实 HTTP 验证 failover/冷却/升级/恢复全行为）
→ smoke:workbuddy-bridge（对话式智能体桥 `workbuddy-bridge.mjs` 的**真进程**端到端：真起桥 +
   真起 dist-headless，由测试扮演"人"读写 inbox/outbox，6 场景钉住协议字段、越权整批拒、
   失败终态映射、deadline 收口与队列清理；随机端口、零配额）
→ smoke:cli-pkg（`npx oxcommander` 那一格的分发包冒烟：自己构建 `dist-cli/`，再断言
  bin 指向的文件真在盘上、五个入口（含 `chat-main.js`）齐全、版本不与仓库漂移、非法 spec 真转发到协议层、
  `receipt` 子命令真路由到复核入口、包内不带 sourceMap 与 node_modules。
  它盯的是「包自洽」这一类**表面正常**的坏法：`--version` 照样打印、包照样能 pack，
  但 `dist-headless` 少拷一个入口时只有真从 dist-cli 里启动才现形）
→ check:test-side-effects（测试文件的**顶层副作用**：顶层建目录却没人清、或清理写在
   `skipIf` 门控的块里而门控没开 —— 两种都必漏。判据见下，自检 6 例）
```

> **`check:test-side-effects` 为什么存在**（2026-10-17）：体检在 `%TEMP%` 里发现
> **18352 个 `ox-*` 目录**（15876 个为空）。根因是测试文件在**模块顶层** `fs.mkdtempSync`
> —— 而 `vitest list` 只导入不执行用例，`afterAll` 永远不会被调度：目录建了，没人清。
> 最坏的一处默认跑 **0 条断言**（3 条用例整体挂在 `skipIf` 下），却每次收集制造一个
> 永久垃圾目录。**这类缺陷躲得过全绿的测试报告**：副作用发生在断言之外，`Tests N passed`
> 里看不到它，只有 %TEMP% 一直膨胀。所以它是一道**不跑用例就能看见它**的静态检查。
> 两条判据都 FAIL：顶层建了东西而全文件无 `rmSync`；顶层有副作用而文件带 `skipIf` 门控。
> 它**不禁止**「顶层建 + `afterAll` 清」这个既有写法（那 4 个文件实测残留已归零）。

⚠️ 本机（WorkBuddy 宿主）跑**整链**时，`build` 段可能红在
`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":51,...}` —— 那不是项目缺陷：
宿主按**单次工具调用**累计删除数（阈值 50），变异阶段清台账 + vite 清空 `dist/assets`
同属一个调用就超线。分段跑（每段一次调用）即可；非要一个调用跑完，对该命令加
`CODEBUDDY_SAFE_DELETE_ENABLED=0`（只关这一条命令的守卫，不动全局配置）——
`dist/` 是 git 忽略的构建产物，删它没有个人文件风险。

覆盖率：`npm run test:coverage`（v8 provider，模块级报告；2026-10-05 复测 92.89% stmts（5580/6007）/
89.11% branch（3661/4108），**不设阈值**，所以它不是门禁）。

**变异门禁有两个口径，数字不可互换**：

| 口径 | 命令 | 含义 | 最近实测 |
| --- | --- | --- | --- |
| aggregate | `npm run mutation` | 每个算子**至少一处**被覆盖 | 162/162（会掩盖位点，见下） |
| **site** | `npm run mutation:audit` | **每一处位点**单独验证 | CI 每次 push 全量跑（`mutation (site, tier …)` 三分片：tier 1 单片 + tier 2 轮转两片。2026-10-16 起 `--tier` 精确匹配、`--shard` 真均摊 —— 此前 `--tier=2` 是超集，会重复跑 tier 1）。**修后** @ `80946b0` run #38922557558 五 job 全绿（tier 1 17.6 min · tier 2 12.7 / 13.7 min）。修前整轮 @ `94a7a59` run #153 两片全绿（tier 1 23.4 min / tier 2 54.8 min，tier 2 含约 23 min 重复）。本机最新：tier 1 737/737 全杀（2026-10-16 win32，45.8 min）。本机历史最好记录 1330/1330（2026-10-05 win32 全量，当时在册「64」个目标） |

aggregate 用 `replaceAll` 一次改掉某算子的全部位点，"任一处被杀"即报杀死 ——
所以它报的 100% 可能是假象。**site 才回答"每处是否真有断言"**。

CI 是两份 workflow：`verify.yml`（`verify` ubuntu + windows 矩阵、`mutation` site 口径三分片各 100 min 上限、
外加一个只在 macos-latest 的 `cli (macOS)` job —— 造 npx 包并冒烟，证明 CLI 分发通路在 mac 上通），
`release.yml`（`verify` → `build` 两 OS 矩阵，2026-09-24 起打包前必须先过门禁）。仓库托管在 GitHub
（公开仓库），`verify.yml` 随每次 push 运行。**修后 @ `80946b0` run #38922557558 五 job 全绿**
（`verify` ubuntu 3.4 min / windows 4.8 min、`mutation` tier 1 17.6 min / tier 2 两片 12.7 + 13.7 min）。
此前 @ `94a7a59` run #153 是四 job 全绿（当时分片是 tier 1/2 两片，其中 tier 2 是超集 —— 见上文）。
这类状态数字落笔即过时，CI 结论以 Actions 页为准，别拿 README 当 CI 状态。

`mutation (site, tier …)` 分片 job 的结论与数字（杀死 N/M / 口径 / 存活清单 / 耗时）会由
`mutation-check.mjs` 自己写进 job 的 **summary**（`GITHUB_STEP_SUMMARY`）：绿/红只有一个 bit，
而真正要读的是"这次到底验了多少处、哪几处活着"。写不进去只报一行提示，**不参与判定** ——
summary 是旁证，不能反过来让门禁失明。

> 基线出处：[docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md)
> （含 577 → 594 → 590 → 603 → 695 → 701 六轮快照、白名单行号漂移与平台相关等价的发现-处置记录，
> 以及三元算子的首次全量评估 875/931）。

### zone 互斥的代价（对外对比用的数字）

共享工作区 + zone 互斥是少数派路线（实测 15 个同类项目里 12 个走 git worktree），
主张要拿数字说话。审计事实里已经落了结构化的越权记录（`batch-guard` phase 带
`conflictKind` / `remedy`），所以代价可以直接算出来：

```bash
npm run build && npm run zone:cost -- --audit=<userData>/audit [--batches=<tasks.json>] [--selftest]
# → 越权 N 次（每 run X 次）· 涉及路径 M 个 · 其中 K 个已处置
# → 批次 B 段（最多并行 W 个任务）· 相对全并行多出 B-1 段串行 —— 这就是互斥切下去的刀数
```

⚠️ 只报**本项目这一侧**的实测数字：worktree 那侧的代价需要真跑另一种架构，
而一次对照实验的结论高度依赖任务集与机器 —— 编一个"节省 X%"比不报更坏。
报告给的是**口径**（两边各自的代价项是什么）+ 自己这一侧的实测。

真实链路冒烟（需密钥、消耗配额，不进门禁）：

```bash
OX_SMOKE=1 npx vitest run src/sensenova.smoke.test.ts   # 6 个真实 API 用例
node scripts/smoke-fullchain.mjs                        # 真实 LLM 全链路 + 真实验证命令
node scripts/probe-endpoints.cjs                        # 端点/模型探测（临时工具）
```

> **429 SOP**：SenseNova 多把 Key 共享账号级滑动窗口（本机其他流水线也消耗同一窗口）。
> smoke 撞 429 `insufficient_quota` 表示限流而非密钥失效——冷却 ≥5 分钟后只重跑失败用例一次。

## 架构

| 目录 | 职责 |
| --- | --- |
| `src/` | Renderer（React18 + Zustand）：projects / prd-review / board / chat / settings 五页 + AgentsPanel；会话页为三栏工作台（`components/ThreadRail` 左栏：项目与线程树 + `components/SessionList` 线程列表；`components/ReviewRail` 右栏：改动审查，逐行 diff + 按 (turn, path) 撤销） |
| `electron/engine/` | 编排器（六阶段 + repair loop）、调度器（批内 zone 互斥 + 并发闸）、能力路由、验证器、仲裁 |
| `electron/chat/` | 交互式编码智能体：`ChatSession` 工具循环、`ToolRunner` 沙箱执行、会话记录仓、运行时边界（项目配置/约定/policy.d） |
| `electron/agents/` | 统一适配层：`local-llm`（SenseNova 执行器）/ `cli`（Codex 等）/ `http-bridge`（WorkBuddy 等）+ 注册表 + manifest 校验 |
| `electron/sandbox/` | PathPolicy / CommandPolicy / TimeoutGate / CircuitBreaker / FileJournal / SnapshotStore / spawn 规划 |
| `shared/` | 双端共享大脑层：LLM 客户端与 failover、契约、glob、routing、prompt、schema（纯逻辑，不碰 node/DOM API —— 这条由 `eslint.config.mjs` 的 `no-restricted-imports` 机制强制，不是约定） |
| `headless/` | JSONL 协议三层：protocol（契约）/ run-spec（执行）/ headless-main（胶水）；`chat-main` 是同一套会话的 CLI 形态 |
| `agents.d/` | 声明式智能体接入文档与示例（运行时读 `%APPDATA%\OxCommander\agents.d\`） |

智能体接入契约（capabilities / credential / limits）见 [agents.d/README.md](agents.d/README.md)。

## LLM 线路池

线路池 = `shared/providers.ts` 里「每把 key × 每个模型」的笛卡尔积，再加不带多线路的 provider
（当前实际条数由那两个表决定，界面文案同样从它们派生），全部共享一张故障转移冷却表。
429 只冷却命中线路本身，请求立即落到同 key 其他模型 → 其他 key → 其他 provider；
跨 provider 时认证失败不做整池 fail-fast。全部可在「设置 → 线路池」勾选配置。

冷却语义（2026-10-02 起对齐竞品弹性库标准）：

- **429/5xx/超时/畸形响应**：冷却该线路（429 带 Retry-After 时按服务端说的等，封顶 5 分钟）
- **402/404/405/410/413（线路级永久错误）**：余额耗尽、模型退役、路径配错 —— 同样 bench 本线路；
  400 刻意不冷却（换一个模型可能就对了）
- **连续失败升级**：冷却到期又失败 → 冷却时长翻倍（上限 10 分钟），成功一次清零 ——
  持续坏掉的线路不会被每 30s 重撞一次
- **线路健康可见**：每条线路的冷却剩余、失败/限流账、连续失败轮数都在看板与协议事件里
- 上述行为由**本地故障注入靶场**逐条验证（`npm run smoke:target-range`，真实 HTTP，18 场景）

## 安全边界

- 所有智能体副作用强制过沙箱：路径七级判定（穿越/越根/受保护路径，realpath 后再判）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
  （deadline 三个适配器都有：内置执行器 2026-09-25 才接上 `TimeoutGate`，默认 600s；**idle 只对外部两个开**——
  内置执行器一次请求在途最长 300s 期间本来不产生事件，开 idle 会把健康的慢生成判死。
  中止与超时现在会把在途那一次请求**真的掐掉**（`ChatRequest.signal` 与内部超时合并后下传给 fetch），
  已经花掉的那一笔 token 不退回；取消不计成线路故障——故障转移池既不轮下一条也不把它拉进冷却）
  （注：内置执行器写入时不带 zone，zone 约束由事后仲裁兜，见 `docs/2026-09-24-consistency-review.md`）
- 沙箱**不管网络**：它是"能写哪个路径、能跑哪个程序"的判定层，不是防火墙。命令黑名单里有
  `curl`/`wget`/`nc`，但 `node` 在白名单里——智能体自己发 HTTP 请求是拦不住的，
  出网目标也不做任何限制。凭证侧的边界是：验证/冒烟子进程与 CLI 智能体都走最小化环境
  （`scopedEnv`），默认拿不到宿主的其他 provider Key；要给它 Key 必须显式写 `allowProviders`
  （探针与实测结论见 `src/sandbox-llm-call.smoke.test.ts`）
- zone 越权默认**回滚**（内容备份，不用 git stash），可选隔离区 / 保留 / 仅日志
  （四档 `report-only`/`deny-all`/`revert-batch`/`quarantine` 各自对应一种行为：仅记录不改判 /
  保留文件但判批次失败 / 回滚越权路径 / 移入隔离区）
- 构建/测试产物（`dist/`、`coverage/`、`__pycache__` …）不参与越权归因，也不进发给模型的工作区快照：
  它们排在 `src/` 之前，会占满快照的 32k 字符预算而把真实源码挤出去（`out`/`bin`/`target` 刻意不列入）
- 全程 JSONL 审计（**按大小轮转**，单文件 2 MiB；文件名含日期但不跨天触发），run 与 agent 归因、冲突、回滚留痕
- API Key 经 OS keychain（Electron safeStorage）加密落盘，不可用时明确回退明文并告知

## 文档索引

- [CHANGELOG.md](CHANGELOG.md) — 对外变更日志：做了什么、边界在哪、已知缺口（每个条目的完整工程过程在
  [docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md)）
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南：本地开发、提交前的门禁纪律、PR 与 issue 要求
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — **架构与不变量**（面向人）：一次 run 的端到端数据流、
  三处 zone 判据为什么故意不同、三条承重不变量、平台分支、当前的口径陷阱
- [docs/ENGINEERING-LOG.md](docs/ENGINEERING-LOG.md) — 对内工程日志：门禁逐段数字、变异位点账、
  事故勘查与负结果全程（CHANGELOG 的历史档案版）
- [.qoder/skills/ox-commander-dev/SKILL.md](.qoder/skills/ox-commander-dev/SKILL.md) — **给 agent 的仓库工作手册**：
  门禁逐条机制、会让门禁静默变红的行号锚点与豁免表规则、分层与放置约定、win32/POSIX 分支差异
  （`references/gates.md` 是它的门禁详表；原 `references/architecture.md` 已提升为上面的 docs/ARCHITECTURE.md）
- [docs/2026-09-24-consistency-review.md](docs/2026-09-24-consistency-review.md) — 一致性复核：本轮改了什么、
  以及逐条带证据的**未修**缺陷清单
- [docs/2026-09-19-real-task-e2e.md](docs/2026-09-19-real-task-e2e.md) — 真实任务交付验收记录（csvstat 第一次真跑，
  抓到"智能体自写测试自洽地实现错口径"那一类盲区）
- [docs/2026-10-06-real-decomposition-e2e.md](docs/2026-10-06-real-decomposition-e2e.md) — 真实拆解端到端第二跑（**负结果**）：
  编排机制全部按设计工作（满载让路 / 429 换线 / 600s deadline 真掐 / 两次越权 revert / 三轮重派），
  但这单被 30 分钟墙钟截断没交付；独立验收抓到**契约点名的字面路径没人检查**——
  智能体交 `src/core/csv/index.js`，语法检查过，`node src/cli.js` 直接 `Cannot find module`
- [docs/2026-09-19-multi-agent-orchestration-plan.md](docs/2026-09-19-multi-agent-orchestration-plan.md) — 多智能体平台 P0–P6 设计与实施全记录
- [docs/2026-09-20-fullstack-review.md](docs/2026-09-20-fullstack-review.md) — 全栈评审：架构 / 风险诊断 / 优化记录（§十七 为最近一轮复核）
- [docs/2026-09-23-mutation-site-baseline.md](docs/2026-09-23-mutation-site-baseline.md) — 变异门禁 site 口径基线（577→594→590 三轮，含逐目标报告与适用边界）
- [docs/2026-09-29-competitor-research.md](docs/2026-09-29-competitor-research.md) — 多智能体编排器竞品调研（AO / Vibe Kanban / Omnigent 对位分析与可吸收清单）
- [docs/2026-09-29-competitive-landscape-and-roadmap.md](docs/2026-09-29-competitive-landscape-and-roadmap.md) — 竞品地形与优化方案（GitHub API 取数 + README 关键词命中口径，含 Orca 深读）
- [docs/2026-10-02-competitor-refresh.md](docs/2026-10-02-competitor-refresh.md) — 竞品特性刷新与吸收记录（Agent HQ//fleet 动态 + 弹性库标准特性逐条对照与落地）
- [docs/2026-10-03-competitor-refresh.md](docs/2026-10-03-competitor-refresh.md) — 竞品刷新 2026-10-03（Vibe Kanban 停摆与差异化、Orca 心跳/OpenRig/AO 动态、MCP 2026-07-28 评估；request-id 透传与任务活性心跳落地）
- [docs/2026-10-11-competitor-refresh.md](docs/2026-10-11-competitor-refresh.md) — 竞品刷新 2026-10-11（ADE 品类成型与 Conductor/Podium 新入、paperclip 预算面、ruflo 联邦与记忆；循环输出检测 / per-agent 预算闸 / 成功率跨 run 持久化三项落地）
- [docs/headless-protocol.md](docs/headless-protocol.md) — headless JSONL 协议
- [docs/2026-08-26-sensenova-smoke-defects.md](docs/2026-08-26-sensenova-smoke-defects.md) — 真实 API 接入缺陷记录
- [docs/2026-09-19-quality-hardening.md](docs/2026-09-19-quality-hardening.md) — 质量加固（覆盖率/UI 测试/lint 门禁/产物冒烟）

## 许可证

[MIT](LICENSE) © 2026 fengxingxuerong —— 可自由使用、修改、分发与商用，
唯一要求是保留版权与许可声明。本项目的贡献者许可与第三方依赖各自遵循其原有许可。
