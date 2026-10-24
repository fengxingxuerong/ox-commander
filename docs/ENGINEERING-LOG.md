# 工程日志（对内）

> **这是什么**：门禁逐段数字、变异位点账、事故勘查与负结果全程 ——
> [CHANGELOG.md](../CHANGELOG.md) 里每一条「对用户/对维护者可见的变化」在这里都有一份
> 完整的工程过程记录（含写下当天的实测数字与论证链）。
>
> **分工**（2026-10-18 拆分，306KB 的 CHANGELOG 拆成两份）：CHANGELOG 保持简洁
> （做了什么、边界在哪、已知缺口）；本文件是台账与档案，只增不删。两边按日期与标题一一对应。
>
> **口径**：倒序（最新在上）。条目里的数字是**写下那一刻**的实测值，落笔即过时 ——
> 现值的真值来源永远是命令本身（README 与 gates.md 里那几个数由 `check:doc-claims` 对实物核，
> 本文件刻意不参与，因为它记的就是历史）。点历史报告在 `docs/2026-*.md`，本文件是它们的连续索引。
>
> **怎么找**：按日期（每个小节标题里带「· YYYY-MM-DD」）或关键词搜。近期的「为什么这么改」
> 浓缩版读 [docs/ARCHITECTURE.md](ARCHITECTURE.md) 与 [CHANGELOG.md](../CHANGELOG.md)；
> 完整论证在下面。

---

## [Unreleased · 竞品刷新第六轮（执行器接入）· 2026-10-25]

**动机**：用户要求对照本周 GitHub 同类热点做一轮全面吸收 + 全面测试。检索（trending 一周
区间）锁定两个深读对象：Orchestrator.inc（13.6k★，v0.14.6 于 10-24 发布，nightly 日更）
与 Ringer（303★，"parallel agents that prove their work"——与本项目命题同源）。

**勘查发现（本轮最有价值的一条）**：`agents.d/` 下躺着**从未接进探测表的 example 模板**
（qwen-code 即是）—— C6（执行器自动探测）落地时只接了 5 个。qwen-code 属于"模板先行、
探测没跟上"的欠账：守卫测试要求候选表与模板逐字一致，但它只钉**已登记**的候选 ——
没登记的模板就静默躺着，这正是"两处事实源"设计的盲区（守卫防漂移，不防缺登记）。
本轮把 qwen-code 接上；bridge/remote-runner 模板各有专属接入路径（bridge 脚本），不算欠账。

**接线时的核实账**：qwen 的安装命令（`@qwen-code/qwen-code`）与无头形态（`qwen -p`）
逐字核实于官方 README；`--yolo` 在其 README/docs 树 0 命中 —— 但**模板是仓库自己的
审定产物**（随 resilience 提交进仓），接线按守卫要求逐字复制模板，`--yolo` 的存废
留待实测反馈，不在接线时擅改（改了反而破坏两源一致）。opencode / crush / amp 考察过：
安装命令可核实、无头用法未见于官方 README —— 按 goose 判例不接，判据写进刷新文档。

**Ringer 对照的一个正反馈**：它的核心卖点是"不采信 worker 自述、跑 check 定胜负、失败
带上下文重试一次" —— 本项目的硬门禁 + repair loop（多轮、按 zone 归因、带基线区分）
**严格强于**它。这是第一次在竞品对照里确认我们领先的一格（之前都是追平缺口）。

**测试**：cli-detect 守卫 47/47；随后跑完整 `npm run verify`（全门禁链）。

---

## [0.3.0 · 远程常驻部署（C7）· 2026-10-24]

**动机**：10-17 盘点 C7 —— cezar `server-install`（HTTPS + 登录 + systemd）对位，
"夜里跑、合上笔记本继续"的 24/7 场景此前只有零件（serve 常驻 + SSE + 定时 + opt-in
token）没有装配图。勘查现状：鉴权底子其实已经在了（2026-10-10 的 OX_SERVE_TOKEN
前置所有路由 + 非回环无 token 拒启 fail-closed），真正缺的是**部署形态**：systemd
单元、TLS 终止、以及把安全默认值固化下来不让每个人重新踩一遍。

**形态取舍**：

- **生成器不是安装器**：拷贝/daemon-reload/enable 是改变机器状态的动权动作，人看着做；
  但单元里有一堆安全判据（回环、token 不落单元、strict 与写路径成对）—— 生成器把这些
  判据固化成同一份出处 + `--selftest` 逐条钉住，人只需要审一眼输出。
- **TLS 不进 serve 进程**：终结 TLS 是反代（caddy/nginx）的生态位；自签证书既难维护又
  容易配错。回环 + 代理是最少活动部件的形态，单元里 `--host=127.0.0.1` 因此是**唯一**
  取值（自检断言），改它必须是人手改单元。
- **多租户治理明确不做**：单 bearer token、无登录系统 —— 与盘点 D 类口径一致，写进
  部署文档的"安全模型"节，防止被读成遗漏。

**踩过的坑（自检首跑红的那条）**：判据 1 的断言"单元里不许出现 token 形态的赋值"
误伤了**注释行**（放置指引 `# OX_SERVE_TOKEN=<随机值>` 是刻意保留的）。修正为
结构性断言：含 `OX_SERVE_TOKEN` 的行必须全部以 `#` 开头。另：Git Bash 的 MSYS
路径改写会把 `--spec=/etc/...` 改成 Windows 路径 —— 本地测试加
`MSYS2_ARG_CONV_EXCL=*`，Linux 上无此问题。

**门禁面**：脚本接入 `npm run serve:unit`（check:scripts-wired 口径）；`--selftest`
5 组判据 + checklist 2 项；半对 `--every`/`--spec` 在生成器里就抛错（exit 2），不是
等运行时才露馅。无 TS 生产代码变更 —— 不涉变异目标与基线；README/CHANGELOG/部署
文档同批落，未新增受检数字声明。

---

## [0.3.0 · 成本对账（C4）· 2026-10-24]

**动机**：竞品盘点（docs/2026-10-17-competitor-gap.md C4）指出成本明细只到 run 级总量，
答不了"哪个模型最费/哪个项目最贵"。勘查发现更根本的一层：**数据本身不持久** ——
`UsageMeter` 的 byModel 只进 run 进行中的 `usage` 协议事件，`buildDeliveryReceipt`
落盘时把它裁掉（旧注释明写"byModel 明细留给 usage 协议事件"）。没有持久事实，
任何跨 run 视图都无从谈起 —— 所以这一笔是**先补数据，再补视图**。

**落地链**：

1. `shared/delivery-receipt.ts`：`ReceiptUsage` 增可选 `byModel`（空明细省略；
   旧凭据缺席 ≠ 空对象，与 `outcomeOk`/`repairs` 同一条"字段即承诺"纪律）。
   指纹键序由 `canonicalReceiptPayload` 排定，Map 插入顺序不影响。
   现有"projects usage without inventing a limit"用例（byModel: {} 输入断言输出无该键）
   正好钉住"空明细省略"这条路，无需改。
2. `electron/usage-cost.ts`（新，纯函数，tier 1）+ `src/usage-cost.test.ts`：
   聚合判据 —— 未上报边界（calls−measuredCalls）与总量同行；byModel 只从带明细的
   凭据累加（`detailed` 是分母，旧凭据不装作 0 进排名）；坏 JSON 计入 `broken`
   说破不吞；按任务不可归因这句话必须出现在每份报告末行。
3. `scripts/usage-cost-report.mjs`（`npm run usage:cost`）：--store（项目库，每项目
   最新一份）与 --receipts（文件/目录）双源；统计实现只在 TS 侧，脚本读 dist-electron
   产物（与 zone-cost 同约，先 `npm run build`）。

**逐位点审计账**：首跑 site 口径 16/17，存活 1 处 —— `isReceiptLike` 的
`"outcome" in value &&`（→||）。杀它的区分用例是 `{outcome: 42}`（键在、值非字符串）：
原判据拒收（broken+1），变异体当凭据收（receipts+1 且总量多计）。既有测试只用了
"没带键"的对象，两边同判 false 所以杀不死 —— 补"rejects a receipt whose outcome key
exists but is not a string"后 17/17 全杀。这处存活正好证明形状守卫的"值这一层"此前
没有被任何断言咬到。

**基线与文档数字**：TARGETS +1（113）· SITE_BASELINE 3080→3098（+17 新模块、
+1 凭据构建处新增位点）· 用例 2979→2991（+11 新文件、+1 凭据用例）· 文件 99→100。
`check:doc-claims` 与 `mutation:baseline` 双绿后落笔。

**边界（刻意不做）**：按任务的 token 归因 —— 把 run 级总量摊到任务头上就是编数字；
执行器自报的 usage 在 scheduler 里是 per-agent 账（预算闸用），多任务共 agent 时
无法不重复计数地映射到任务。什么时候凭据里有了 per-task 的事实，什么时候这张表才扩。

---

## [0.2.1] — 2026-10-23

### 安全（窗口与导航守卫 · 2026-10-23）

**动机**：这个窗口的内容是**不可信文本** —— 模型输出、第三方 MCP 工具返回、预览与审计。
`webPreferences` 里 `contextIsolation: true` + `nodeIntegration: false` 挡住了"页面里直接
require"，但挡不住两件事：

1. `window.open` 出来的子窗口**继承同一份 preload**（`window.ox` 照样能调）—— 而 IPC 那
   一侧的能力面是写文件、起进程、审批；
2. 页面里任何一次导航都会把应用带走（模型输出里有链接是常态）。

**判据（为什么敢一刀切）**：全仓 grep 过 `window.open` / `<a ` / `location.href=` —— 0 处；
对外打开统一走 `preview:open` IPC → `shell.openExternal`（带白名单、`ipc-handlers.test.ts`
有用例）。于是 `setWindowOpenHandler(() => ({ action: "deny" }))` 与"`will-navigate` 只放行
应用自身"对既有功能是零影响的。dev 下 Vite 的整页重载会走 `will-navigate`，所以 dev 分支
放行 `http://localhost:5173`（其它端口照样拦）。

**可测性**：`electron/main.ts` 本来就在变异 TARGETS 里（tier 1，配 `src/main-wiring.test.ts`
—— 那份用例把入口**真跑起来**）。给 fixture 的 `webContents` 补两个记录点
（`setWindowOpenHandler` / `will-navigate` 触发器）后新增三条断言：新窗口一律 deny、外部
地址被拦而自身 `file://` 放行、dev 下放行 5173 但 8787 照样拦。位点 6 → 7，**7/7 全杀**。

**窗口的迟到（记账，这条比代码更重要）**：两条守卫落地于 v0.2.0 打 tag **之后**（同日晚上），
所以 0.2.0 的安装包**不包含**这条加固 —— 0.2.1 才是带加固的那一版。教训：安全类改动与版本
发布之间要显式确认"谁包含谁"，而不是默认"推上去就在里面了"。发现过程也很典型：巡检查
CHANGELOG 时发现这条用户可见的安全改动**没有条目**（违反本仓"每条可见变化都要记"的纪律），
顺着往下才对上 tag 的时间线。

### 门禁与维护（等价白名单的失效检查 · 2026-10-23）

**动机（一天内被同一种缺陷拦了两轮）**：`EQUIVALENT_SITES` 的条目是
`{file, op, line}`，匹配是**精确**的（算子名 + 行号）。源码里插几行，条目就再也匹配
不到任何位点 —— 它豁免的是**空气**；而真正漂到新行的那一处位点无人认领，重新进入
分母。若它真的等价（本来就靠白名单活着），就会稳定存活：

- `ipc/context.ts` 的签名行 `agentRouter !== false`：表里同时躺着 177 / 208 / 222 三条
  历史锚点（每次漂移都"新增一条"而不是校回旧条目），M3c/M4b/P0 三轮 +9 行后真位点到
  225 —— 三条全失效，tier2 分片红。
- `sandbox/path-policy.ts` 的 `parent === cur`：P0 那笔加了 2 行注释，92 → 94，tier1
  分片红，**直接拦住 0.2.0 的发布**。而它上方的注释还写着"行号 92 在两端一致，无漂移
  风险"—— 这句话本身就是这条纪律的反面教材。

两次的定位成本都不小（一次 27 分钟、一次 51 分钟的分片审计），而且本机 win32 全绿
（前者 POSIX 不可达、后者 win32 有盘符用例会杀），只能靠 CI。

**判据（落在 `mutation:baseline` 段，不新增链段）**：`site-baseline.mjs` 早就逐目标
复用门禁自己的 `findSites` 算位点数，所以"某条条目还能不能匹配到真实位点"在同一趟里
就能算：对每个条目要求 `(op, line)` 在目标文件里存在，否则 **exit 1** 并逐条点名。
与 `check-unwired` / `check-script-wiring` 的"表项失效即红"同一条纪律；也避免另写一份
"哪儿有位点"的实现（那两份必然漂）。

**同批清理**：一次 `--json`/默认运行就列出 16 条死条目（serve 482、scheduler 346/352
各两条、http-bridge 315、sensenova-api 397/403、orchestration 267、run-spec
286/288/290、store 247、platform 288、ipc/chat 197/402），全部删除 —— 删除是**行为
中性**的（它们本就匹配不到位点，删了不改变任何审计结果），而留着会让人以为"这块有
等价锚点"。历史论证保留在原处注释里，重新登记时可复用。

**可诊断性配套**（同一轮加的）：`mutation-check` 把存活位点与基线失败写成 GitHub
**注解**（checks API 公开可读，job 日志正文匿名读不到）；另加一个**仅手动触发**的
单文件变异复核工作流（15 个目标 × 各自 runner）。path-policy 那一处就是靠这两样在
Linux 上一次点名的 —— 在此之前，"哪几处活着"只写在 step summary 与会话日志里，维护者
不在场时拿不到结论。

## [0.2.0] — 2026-10-23

### 新增（MCP client · M7 · 2026-10-23）

**动机**：M6 做完"技能"（只读的能力包）之后，缺的另一半是**能执行的第三方工具**。我们是
MCP *server*（`ox mcp`，外部可驱动我们）已经很久，方向反过来 —— 会话把外部 server 的工具
并进工具循环 —— 一直没做。这一轮补上，判据先窄后宽：**只做 stdio**，网络型（SSE /
streamable HTTP）留后。

**形态（三层，与 `agents.d` 同一个信任模型）**：

- `shared/mcp.ts`（新，tier 1，101 位点）：纯契约 —— 清单归一化、`mcp__<server>__<tool>`
  名字空间、JSON Schema 子集校验、`tools/call` 结果展平。
- `electron/mcp/`（新）：manifest 读盘（`manifest.ts`，13 位点）、stdio JSON-RPC 客户端
  （`client.ts`）、连接池与聚合上限（`pool.ts`）。
- 会话侧：`ChatSession` 在**首次发送时**发现动态工具（页面加载不拉外部进程）；`ToolRunner`
  以 `tool: "mcp"` 走审批，返回过脱敏 + 截断。

**四个值得单独记的设计点**：

1. **名字空间是唯一寻址**：模型只见 `mcp__server__tool` 一个名字，平台据此拆出 server 与
   tool，**永远不接受模型直接指定命令行**。server 名禁止 `__`，所以"第一个分隔符之后全是
   tool 名"无歧义。
2. **env 的值不出主机**：清单可以带 `env`（第三方 token），但界面与日志只露**变量名**；子
   进程环境是 `scopedEnv()` + 清单 env，宿主的 provider key 不进外部进程。
3. **业务错误不计熔断**：工具 `isError` 与 JSON-RPC error 都是"调用成功、业务失败"，只有
   **传输失败**（spawn 失败、进程退出、超时、管道断）才累加连续失败计数 —— 否则模型手滑
   调错三次就被冷却十分钟。
4. **翻页的三种停条件**：`nextCursor` 不是字符串、与上一页相同、**在本次发现里出现过**。
   第三条是成环（a → b → a）唯一能停的地方 —— 前两条都抓不到它。

**门禁与负结果（首轮 227 处新位点，24 处存活）**：

- 全杀：`shared/mcp.ts` 101/101、`electron/mcp/manifest.ts` 13/13、`chat/tool-runner.ts`
  86/86、`chat/runtime.ts` 17/17、`ipc/chat.ts` 140/140、`tools/policy.ts` 22/22、
  `chat-events.ts` 16/16。
- 首轮存活 24 处，逐条处置（没有一条加白名单）：
  1. `client.ts` 16 处：`asObject` 的 null/数组分支、`tools/list` 返回非对象、游标发没发出去、
     翻页停条件、反向请求回话、`badLines === 1` 只报第一条、空行不中断解析、噪音与响应同
     chunk、RPC 错误不熔断且 code 回落 -32603、错误文案取 message 还是整段 JSON、stderr
     尾巴的有无、`killChild` 的 null 分支。**其中 5 处按纪律简化源码而不是加断言**：
     `Pending` 的 `signal` + `onAbort` 两个恒同真假的字段收成 `abort: {signal, handler}`；
     request/write 各自一份三连合取收成唯一的 `stdinStream()`（用 `!x` 写，连布尔算子位点
     都不产生）；响应路径上多余的 id 早退删掉（紧接着的查表必然落空）；`killChild` 用
     真值判断；`errorText` 的三元改成 if/return。
  2. `protocol.ts` 5 处：畸形 schema 的渲染（`properties` 不是对象 / 属性值不是对象 /
     描述缺席）—— 第三方 schema 是任意子集，一个坏 server 能让整个提示拼不出来。
  3. `pool.ts` 2 处：坏 server 排**前面**时不许连坐后面的 server；达到会话上限后要继续把
     溢出项**数全**（中断只会记一条，"后 N 个未声明"会骗人）。
  4. `chat/session.ts` 1 处：发现只出问题（一个工具都没有）时也要落盘 —— 系统条目不能只活
     在内存里，否则重启后"为什么一个工具都没有"毫无痕迹。
- **夹具也跟着长**：`src/__fixtures__/mcp-echo-server.mjs` 加了 `--log=`（把**客户端写出去
  的每一行**记进文件）与一组模式（游标严格/同值/成环/空串/数字、RPC 错误、反向请求、
  tools/list 非对象、空行、噪音同 chunk、stderr 尾巴）。有些行为在 client API 上看不出差别，
  但都能在"真正过管道的那一行"上看到 —— 断言那一行比在客户端加注入点更诚实。
- 最终：**112 个目标 / 3079 处位点**（M7 新增 4 个目标文件、210 处位点）；全量
  **2976 通过 + 8 跳过**（99 个文件）；`check:doc-claims` PASS。

**边界（明说）**：不做网络型 MCP；不替 server 的行为背书（它跑在沙箱外）；不做 MCP
resources / prompts / sampling 的**正向**能力 —— 反向请求一律回 `-32601`，让 server 自己
降级，而不是假装支持。

### 新增（技能全文按需取 read_skill · M6b · 2026-10-23）

**动机**：M6a 把技能目录注入了会话提示，但**全文取不到** —— 目录块点名了 `read_skill`，
工具表却还是六件套。这不是漏写：M6a 那一轮刻意把它排到 M6b（"先做技能进来，后做取全文"，
写在页面、CHANGELOG 与提交信息里）。这一轮补的就是那半句承诺。动手前先确认过代价：
工具表是闭合集合，加一件会同时波及风险映射、裁决、执行分发、跨端映射与 UI 摘要 ——
少改一处都有门禁会红，这正好是它该有的样子。

**安全设计（三条，都不新造判据）**：

1. **名字永远不参与路径拼接**。模型给的 `name` 只在注入的技能表里查（表来自会话构造时
   那一次扫描），能读到的只能是扫描层见过的那几份。`../../etc/passwd` 得到的是
   「没有这个技能」+ 可用名字清单 —— 连"路径不存在"这种可探测信号都不给。
2. **项目级走 `read_file` 同一条判定**：`PathPolicy.assertReadable(rel)`，realpath 之后
   再判禁读地板。技能目录里放一个指向 `.env` 的软链，在 realpath 那一步现形 ——
   与 M6a 验收里点名的攻击面（"技能目录里放 .env 软链"）逐字对应。
3. **全局级另起一个界，但不另起实现**：全局技能在项目外，`pathPolicy` 拒绝绝对路径。
   解法是用**同一个 `PathPolicy` 类**以技能目录根构造一个实例，把技能路径相对根解析后
   过 `assertReadable`（包含判定 + realpath + 禁读地板全都白拿）。刻意**不吃**项目的
   `policy.d` 读覆盖：那份声明管的是项目根，让项目配置越界裁全局目录等于升权。

**两个实现细节值得记**：

- 相对路径必须按**原始根**算。第一版用 `policy.projectRoot`（realpath 后的长名）算
  `path.relative`，win32 的 8.3 短名（`ADMINI~1`）让扫描层给的原始路径与它算出一串
  `..`，全局技能的正常路径直接报"不允许读取"。症状是"happy path 红、安全用例绿"——
  这正是沙箱类改动最容易被误读的方向。
- 全局根与它的判据收成**一个字段**（`{ rootAbs, policy }`）。第一版写成两个可选字段
  再加 `a === undefined || b === undefined` 的守卫，site 审计当场判它等价（两者构造时
  同生同灭）—— 按本仓纪律"能简化源码就不要加白名单"，收成一个字段后那个位点消失。

**第三个负结果（verify 的 mutation:touched 抓出来的）**：`electron/ipc/chat.ts` 里我
把全局根用条件展开传进 runner（`...(root ? { root } : {})`），那个三元在桌面测试路径上
**恒等价** —— 测试工作区没有 `homeDir`，于是 `skillGlobalRootAbs` 恒为 `undefined`，
"传"与"不传"观察不到任何差别，位点存活。处置不是补一个测不到的用例，而是**去掉条件
展开、直接传属性**：`undefined` 与整个键缺席本就等价，同一份文件里 `reasoningEffort`
早有一条注释写着这条理由（"少一层永远等价的 && 位点"）。教训是"看起来更谨慎的写法"
会自己制造等价位点，而 site 审计只认行为差别。

**接线也有一条端到端用例**（`src/ipc-handlers.test.ts`）：`chat:send` 真工具循环里让
假大脑调 `read_skill`，断言①第一轮请求的 system prompt 里有这个技能名、②第二轮请求
里带着技能全文。少了它，把 `skills` 漏传给 runner 这种"删一行"的回归没有任何东西会红
—— 而症状是"提示里说有、工具说没有"。

**顺手清掉一条静默失效的白名单**：`EQUIVALENT_SITES` 里 `shared/tools/spec.ts`
`!== → ===` @204 那条从 2026-10-20 登记起就没匹配过任何位点（204 行是空行）。
精确行号匹配遇不上就静默跳过 —— 与"判据该红不红"是同一族，只是方向相反：它把一条
**一直在被 `validateArgsAgainstSpec` 合成 spec 用例杀掉**的位点挂成了"证明过等价"。
本轮删条目并记账。顺带记一个缺口：`EQUIVALENT_SITES` 没有"表项失效即红"的检查
（`check:unwired` / `check:script-wiring` 都有），要不要加是下一轮的事 —— 它得连
行号漂移一起裁，否则每次无关插行都会红。

**门禁**：定向 site 审计全杀 —— `shared/tools/spec.ts` 27/27、`shared/tools/policy.ts`
20/20、`shared/chat-events.ts` 15/15、`electron/chat/tool-runner.ts` 73/73、
`electron/chat/runtime.ts` 16/16、`electron/ipc/chat.ts` 139/139（约 15 分钟）。
新增/变化的用例 15 条；`check:exhaustive` 抓出 `describeToolCall` 的 switch 漏一档
（`read_skill` 掉进 default 就等于把工具名原样丢给界面），补 case 后转绿。
基线 108 个目标 / **2858 → 2869 处位点**；全量 **2900 通过 + 8 跳过**（95 个文件）；
`check:doc-claims` PASS。

**边界（明说）**：技能全文超过工具输出上限（8000 字符）会截断并说破，不做"分段续读"——
真需要长内容的技能应当把细节拆到资源文件里，由模型自己 `read_file`（设计文档 §M6 三级注入
的第 ③ 级，平台不预载）。

### 门禁与维护（M6a site 审计收口 + mutation:touched 口径修复 · 2026-10-23）

**动机（一次体检把两件事同时暴露出来）**：发布评估在 `feat/electron-upgrade`（41c2f8d，M6a
落笔处）跑 `npm run verify`，红在第 16 段 `check:doc-claims`——根因是 `SITE_BASELINE` 漂移
4 处：`electron/chat/runtime.ts` 12 → 14、`src/store.ts` 98 → 99、`shared/skills.ts`
缺失 → 38、`electron/engine/skills.ts` 缺失 → 6。**47 处新位点没人逐点验证过**，而 M6a 是
打着「基线 106 目标/2811 位点已同步」的旗号进来的（b230488），下一笔提交就把它甩在了身后
——这正是 2026-10-05 把漂移判定接进门禁要抓的形态。同一晚工作区里还有一枚**活体变异残留**
（上一轮 site 审计被强杀留下的）：`src/store.ts:556` 的三元被写反、台账 3 条记录里 1 条备份
已丢。`check:residue` 两步还原（第一步 exit 2 还原、第二步报干净）按设计工作，没有手工
`git checkout`。

**逐目标审计（先补断言，再写基线 —— 顺序不能反）**：

- `shared/skills.ts` 38/38、`electron/engine/skills.ts` 6/6、`electron/chat/runtime.ts`
  14/14、`src/store.ts` 99/99，全杀后才 `site-baseline --write`。若先写基线，等于把
  「没人验证过」正式登记成「已逐点验证」—— 那正是这套门禁存在的理由。
- 首轮存活 **9 处**，全部是断言缺口而非等价变异（所以一条白名单都没加）。逐条语义与处置：

  1. `engine/skills.ts` 三处「跳过 → 中断」（杂散文件档 / 无 SKILL.md 档 / 超大文件档）：
     既有夹具每次只放**一个**目录，坏条目不存在「排在谁前面」的问题，两种写法无差别。
     补「坏条目在最前、好技能在后」三条用例。**这三条各自钉的就是 CHANGELOG 里
     「一个手写坏的技能不会让整个目录读不出来」那句承诺** —— 写下承诺的那一轮并没有
     同时写下验证它的用例。
  2. `engine/skills.ts` 扫描排序的比较器三元互换存活：目录遍历顺序（字典序）是
     「同名技能先扫到的赢」可复现的前提，却从没被断言过（bad-skills 用例刻意按路径取
     issue、不按下标，等于把顺序让出了判据）。补「同一层重名、字典序在前的赢」。
  3. `engine/skills.ts` 读失败档的「跳过 → 中断」存活：`statSync` 对目录照样给 size
     （过得了上限检查），真正炸的是 `readFileSync`——「SKILL.md 是个目录」这个形态只有
     读失败档能接住，而它连坐时会挡住后面的技能。补「目录型 SKILL.md 只报那一条」。
  4. `shared/skills.ts` `unquote` 两处存活：引号不配对（首尾异种）时原样保留——剥一半
     等于替用户把正文吃掉一个字，连报错线索（那个孤引号）也一起没了。既有用例只测过
     成对引号。
  5. `shared/skills.ts` 目录预算循环的「跳过 → 中断」存活：既有用例两条**都**超预算，
     循环断在第几条结果都一样。补「第一条超、第二条短」——一份长描述把循环顶掉的话，
     用户看到的是「所有技能都没了」。
  6. `src/store.ts:556` `loadSkills` 的三元互换存活：挂着项目时必须把 `projectId` 带上
     （否则项目级技能连同「项目压过全局」整个静默消失），这个行为从没被断言过。
     **这正是那枚活体残留所在的行**——残留事故与断言缺口落在同一行不是巧合：那一行
     本来就没有判据，变异体才能全绿地活到被 residue 守卫点名。补「带/不带各断言一次
     + problem 落 state + 桥抛错不动列表」三条。

**`mutation:touched` 的未跟踪口径（同一晚踩到的第二个洞）**：`--list` 排查时它报
「基线=HEAD 改动文件=0」——工作区明明干净。根因：旧口径拿 `git status --porcelain` 非空当
「脏」，而未跟踪文件既算进 porcelain、又不进 `git diff HEAD`；当时盘上恰有一个未跟踪的
`audit.json`，基线就被顶成了 HEAD、待审集合为空，「最后一笔提交」整个没被审还报 PASS。
两处一起修：「脏」只看已跟踪/已暂存改动（`--untracked-files=no`）；未跟踪文件**恒并入
待审集合**（全新的生产文件在 diff 的两种形态里都看不见——M6a 的两个新文件当年就是这么
长大的）。判定区抽成 `resolveAuditScope`，由 `src/mutation-touched.test.ts` 按锚点抠出
注入假 git 钉住（6 例：干净/只有杂散文件/已跟踪改动/恒并入/目录尾斜杠/`--base` 覆盖但不
覆盖并入）。差分实测：放一个杂散未跟踪文件，基线不再被顶掉、文件进待审清单。

**门禁与数字**：全量 **2885 通过 + 8 跳过**（95 个有可执行用例的文件）；基线
**108 个目标 / 2858 处位点**（M6a 带来两个新目标文件，106/2811 → 108/2858，位点差额
47 = 38 + 6 + 2 + 1）；`check:doc-claims` PASS；`npm run verify` 全链 EXIT 0。
文档四处同步：README、gates.md（含逐段表第 16 段的口径描述）、CHANGELOG、本条目。

### 新增（桌面自动化 M5b · 2026-10-22）

**动机**：Codex 桌面把 Automations 做成一级公民。我们这一侧引擎其实早有定时能力 ——
`headless/schedule-core.ts` 的 `--every` 自投递 `POST /run`（2026-10-11 竞品刷新
第五轮，Orca scheduled automations 对位），但桌面端**零入口**，导航格 `automations`
从 IA-2 起就是诚实占位页。这一轮补的是"引擎有、界面没有"。

**形态（为什么不复用 serve 的调度环）**：serve 的环绑在 HTTP 自调用上（`POST /run`
+ 409 = 忙），桌面既没有 HTTP 服务，也不该为了定时起一个。所以拆成三层：

- `shared/schedule-core.ts`（`git mv` 自 `headless/`，内容零改动）：间隔解析 /
  补跑判定 / 忙时重试间隔 —— 两边共用一份算术，headless 行为零变化；
- `shared/automation.ts`：记录归一化、到期判定、唤醒延迟（纯逻辑，可逐位点审）；
- `electron/automations/`：记录仓（原子落盘）+ 调度环（定时器与 IO 在宿主层，
  时钟/定时器可注入，测试手动泵驱动）。

**两个硬点**：

1. **写盘尺子 = 读盘尺子**。`normalizeAutomationInput` 同时服务"创建/更新入参"和
   "读盘记录"（`normalizeAutomation` 只补 id / 时间戳 / 启停）。若两套尺子分叉，
   合法记录会在下次启动被判坏 —— 界面上"凭空少几条"，没有任何异常可查。

2. **`nextDelayMs` 对"从未触发"返回一个整间隔**（`lastFiredMs === undefined →
   everyMs`），直接拿它做到期判定**永远不得到点**：每轮醒来都发现"没到"，任务永不
   触发。首版就是这样（调度环能启动、日志正常、任务一次都没跑）。修法不是再造一套
   算术，而是引入 `scheduleBaseMs`：触发过的看 `lastFiredMs`，从未触发的看
   `updatedAt`（创建/启用/改间隔都会刷新它）。于是"首次触发在一个间隔之后"与 serve
   的 fresh 分支同义，到期判定与剩余时间回到同一个表达式。

**触发的复用（不做第二条执行路径）**：`orchestration:start` 的主体抽成
`runGate(projectId)` + `startProjectRun(projectId)`。前者是**同步**三态判定
（busy / no-plan / ready，顺带把 batches/smoke 带回来，避免闸门与启动读两份记录），
后者跑一次完整生命周期。调度器与「立即运行」都走它 —— 手动启动与自动触发对"能不能
起一个 run"永远给同一个答案。**同步**的理由是可判定性：`async function` 只能以
rejected promise 表达"忙"，调度器无法在不起火的前提下区分 busy 与 no-plan（嗅错误
消息是最脆的判据）。

**调度语义与 serve 逐条对齐**：首次在一个间隔之后 / 停机补跑至多一次 / 忙跳过不积压
（单飞闸是全局的，一个撞闸即不再逐个撞）/ 触发点按"上次触发 + 间隔"自校正。
**短重试独占**：失败或跳过后，下一次尝试就是 `busyRetryMs` 之后，不与常规排程取 min
—— 失败的任务 `nextDelayMs` 仍是 0，取 min 会立刻重试，把"稍后重试"变成 tight loop
（每轮事件循环真起一个 run）。记账失败也归这条：`lastFiredMs` 写不下去又不欠短重试时，
plan 会算出 0 延迟，同样自旋。

**持久事实**：每次触发尝试落审计 `automation` phase（三态都记，含名字与项目）。
名字单独落是因为它可改可删 —— 只留 id 的话删掉之后历史里全是看不懂的 `auto-<uuid>`。

**门禁与负结果**：

- 定向 site 审计：`shared/automation.ts` 47/47、`automation-store.ts` 18/18、
  `automation-scheduler.ts` 6/6、`ipc/automations.ts` 14/14、`ipc/orchestration.ts`
  14/14、`src/store.ts` 98/98。
- 首轮存活 7 处：5 处在 M5b 新代码里，2 处在 M5a 的 `exportChat`（`src/store.ts` 位点数
  89 → 98 后整文件重审才暴露 —— 这提醒一件事：**"新位点"里混着老代码里从来没被断言过的
  分支**，涨位点不是只审新增那几十行）。全部是**断言缺口**而不是等价变异（除第 1 条）：
  1. `dueAutomations` 的比较器三分支（`? -1 : a.id > b.id ? 1 : 0`）判等价 —— 插入
     排序只在比较结果为负时交换，"把大于判成相等"与"判成大于"行为相同。按本仓
     `zone-coverage` / `batch-guard` 的两分支写法消除（id 由 uuid 生成、天然唯一）。
  2. `nextWakeDelayMs` 的 `if (!a.enabled) continue;` → `break` 存活：夹具把停用项
     排在**最后**，break 与 continue 无差别。改成停用项在最前。
  3. `automation-store` 的 `patch.enabled !== undefined` → `===` 存活：改名用例没有
     断言 `enabled`；夹具又默认停用，"false 还是原值"分不出来。改成启用态起手 + 逐条
     断言"改名不顺手启停"。
  4. `automation-scheduler` 的 accepted 分支 `continue` → `break` 存活：`pump()`
     会把 break 之后立即排上的下一轮 tick 也烧掉，最终状态一致。改成**只烧这一批**
     timer，断言同一 tick 内两个都触发。这条最值得记：它说明"最终状态一致"的断言
     会系统性放过时序/轮次类的判据。
  5. `exportChat` 的 `if (!projectId || !sessionId)` → `&&` 存活：既有用例只走过
     "两个都缺"，于是"缺一半也该早退"这件事没人钉。补成"只有 sessionId / 只有
     projectId"两次调用 + 断言 `exportChat` **一次都没发**（只断 notice 不够 ——
     假分支里 IPC 会先抛错，notice 恰好也是"失败"，两种形态在文案上分不开）。
  6. `push.skipped === "no-remote"` → `!==` 存活：只测过"没有远端"一侧，
     `push.ok` 一侧只断言"有已推送"，没断言"不许同时出现未推送"。补一条真推送成功
     的整串文案比对。`filesCommitted !== undefined` 那一处则已被 chat-ui 的导出用例
     顺带杀死 —— 同一位点在不同文件里被覆盖，说明按文件审计（而不是按"我改了什么"）
     才看得见真实覆盖面。
- 全量测试 **2828 通过 + 8 跳过**（92 个有可执行用例的文件）；基线
  **106 个目标 / 2811 处位点**，`check:doc-claims` PASS。

**边界**：只做时间触发。事件触发（issue / 告警 / CI / PR 的 webhook）不做承诺 ——
需要常驻可达性，价值还没验证（蓝图 §五 可做档）。间隔下限 1 秒、上限 2147000000ms
（Node `setTimeout` 的极限）；界面只给预设档（1 分钟 ~ 24 小时）。页面上的"上次
N 秒前"由 15s tick 刷新，不是实时倒计时（定时任务的时间尺度不需要秒级刷新）。

### 新增（线程侧 commit/push M5a · 2026-10-21）

**动机**：Codex App 的右栏能直接 commit/push 线程改动；我们此前只有编排侧
`exportDeliveryBranch`（批次 zone 输入），会话线程侧零通道。线程的改动集本来就在
`shared/chat-changes` 里（右栏用它聚合、撤销也用 (turn, path)），复用它作为导出输入。

**实现**：

- `shared/chat-changes.ts`：`exportablePaths`（去重排序）、`threadBranchName`
  （session id 只留 git ref 安全字符，空 id 有兜底）、`threadExportMessage`（单行限长）。
- `electron/engine/git-export.ts`：新增可选 `paths` 入口。线程侧有精确文件集，直接
  `git add -- <paths>`；不扫 `git status`，因此新建目录里的新文件不会因为 git 只报
  `?? newdir/` 而漏掉。路径逐个自证（相对、无穿越、过 CommandPolicy），坏路径进
  `skippedPaths`；`zones` 旧入口原样保留。
- `electron/ipc/chat.ts` 的 `chat:export`：从 live 或落盘转录取 entries → 聚合
  `ChangedFileGroup` → 导出分支/commit；`unrevertable` 逐条回传；`push:true` 才调用
  `publishDeliveryRemote`（remote 取 settings.deliveryRemote.remote，默认 origin）。
- `ReviewRail`：有改动时出现「导出分支」+「推送」复选框（默认关），导出中禁用；
  结果进会话 notice，不在按钮上闪一下就算。
- 校验：`shared/chat-changes` 纯函数用例、`git-export` 注入 runner + 真 git 仓库
  （含显式 paths 导出新目录新文件）、IPC 真 git 仓库导出分支、ReviewRail 默认不推送
  与勾选后 push 的桥接参数。

**门禁**：全量测试 **2768 通过 + 8 跳过**（89 个有可执行用例的文件）；定向 site
审计 `chat-changes` 13/13、`git-export` 40/40、`ipc/chat` 139/139（全程 100%）；
基线 **102 个目标 / 2714 处位点**，`check:doc-claims` PASS。构建、`smoke:artifact`、
`smoke:chat-agent`、`smoke:chat-cli` 同批复跑通过。

**边界（写进界面/文档）**：导出会 `checkout -B` 到新分支；命令产生的改动不在
ReviewRail，也不进导出；push 使用本机 git 凭据链，永不 force，不建 PR。

### 新增（交互式编码会话 P0 · 2026-10-20）

**动机**：Codex 类产品的核心不是"一次吐整份文件"，而是"模型自己多轮取信息、改一处、
跑一遍验证"。本项目此前内置执行器是一问一答（平台塞 32k 快照 → 模型吐整份文件），
`docs/2026-10-06-real-decomposition-e2e.md` 的失败链正卡在"读不到就说没这个文件"。
本轮把会话循环、工具执行、审批、沙箱、会话记录、CLI 形态一次接通。

**实现要点**：

- `electron/chat/session.ts`：工具循环（轮次上限、可中断、过程可回放）；轮次是**会话累计**
  的 LLM 回合，另设 `userTurn` 作为用户回合号，供撤销分组。`onPersist` 在用户消息、
  工具批次与终态边界落快照，半更新状态不落盘。
- `electron/chat/tool-runner.ts`：六个工具全部落在既有沙箱内；读路径 realpath + 禁读
  密钥文件；命令走 `CommandPolicy` + `planSpawn` + `killTree` + `scopedEnv`；`apply_patch`
  改原子写，并把每文件 before/after 记入 `changes`。目录遍历固定排序，避免 readdir
  顺序漂移。
- `electron/chat/session-store.ts`：原子索引 + 每会话 JSON；坏文件跳过、索引坏了按文件
  重建；fork 新 id、delete 先看存在性；恢复时 status 重置 idle。
- `electron/chat/runtime.ts`：把项目 `AGENTS.md`/`OX.md` + 全局约定 + `.ox/config.json`
  + 全局/项目 `policy.d` 合成一次运行时边界与签名；签名变化触发会话重建。
- `electron/ipc/chat.ts`：首条消息建会话、设置/项目/中止后重建（同项目保留历史）、
  list/latest/load/resume/fork/delete/revert。`chat:revert` 只在当前内容仍等于补丁后
  内容时恢复；补丁后被改过的一律跳过。
- `headless/chat-main.ts`：CLI 三形态（REPL / exec / resume），与桌面共用会话记录与
  沙箱；非交互无审批通道 = fail-closed；`--base-url`/`--model` 支持本地端点与测试。

**安全修复（同批）**：`run_command` 之前继承 `process.env`（桌面主进程已把 keychain
播种进去），模型跑一个脚本就能打印 provider key；现在默认 `scopedEnv()`。读路径之前只做
字面 resolve，项目内链接可读到项目外；现在 realpath + 禁读 `.env*`/`.git/**` 等。
桌面/headless 生产装配此前都没传 `policyDir`，`policy.d` 只在测试里生效；现在桌面传
`<userData>/policy.d` + 项目 `.ox/policy.d`，headless 传项目 `.ox/policy.d`。

**测试与变异账**：

- 新增 `src/chat-{session,tools,store,security,runtime,ui,tool-runner}.test.ts(x)`、
  `src/policy-file.test.ts` 的 forbidRead/多目录、`src/http-clients.test.ts` 的原生工具
  映射、`scripts/chat-cli-it.mjs`（真子进程）。定向 site 审计（17 个漂移文件）逐点修到
  100%：project-config 16/16、policy-dir 5/5、chat-events 15/15、runtime 12/12、
  session 24/24、session-store 38/38、ipc/chat 77/77、tool-runner 59/59、patch 49/49、
  path-policy 48/48、store 43/43、http-clients 96/96、context 27/27、platform 38/38、
  spec 27/27、protocol 13/13、policy 20/20。过程中暴露并修掉：`delete` 对不存在会话
  返回 true、`apply_patch` 纯新增多插空行、`ChatSession` 恢复 seq 撞号/把 assistant 当
  user、store 空输入/删除分支缺测试、原生工具映射测试漏挂 http-clients 目标。
- 基线 1989 → **2396**（95 目标）；用例 2351 → **2530**（+8 跳过，82 个有可执行用例的
  文件）；`verify` 33 → **35 段**（新增 `smoke:chat-agent` / `smoke:chat-cli`）。

**明确未做（P1）**：流式 token、上下文压缩、多会话并行、MCP client、审批持久规则、
模型/推理档切换、`@` 文件补全、网络隔离；`danger-full-access` 仍受代码地板约束。
（其中「流式 token」已于同日稍后落地，见下一节。）

### 新增（流式 token · P1-1 · 2026-10-20）

**动机**：P0 的会话循环是"等模型把整段话说完再显示"，长答复期间界面看着像卡住；Codex 类
产品的手感就来自"字一个一个到"。而流式能不能用**不能靠端点文档声明** —— 兼容层把
`stream` 当未知字段忽略是常态，声明支持的也可能直接回一整段 JSON。

**实现**：

- `shared/sse.ts`（新，纯逻辑）：`createSseDecoder` 按行切（跨 chunk 边界、`\r\n`、
  多行 `data:`、`:` 心跳注释）；OpenAI 与 Anthropic 两套聚合器分别把 `choices[].delta`
  与 `content_block_*` 事件收成"正文 + reasoning + 工具碎片"，工具参数按 `index` 拼成
  字符串再整段 `JSON.parse`；坏帧进 `problems` 而不是抛异常 —— 解析器的错不该变成模型的错。
- `shared/http-clients.ts`：新增 `postSse`（拿不到流句柄的响应按同一条 SSE 口径再切一遍，
  否则整份 SSE 文本会被当成**一条** `data`）；两个客户端 `chat()` 改成**流式优先** ——
  给了 `onDelta` 且这条线没被判定过不支持时先发 `stream: true`，**零增量**即整段退回并
  按实例记住（端点覆盖让同一 provider id 可能指向不同服务器，能力不能跨 baseUrl 传染）；
  `looksLikeStreamUnsupported` 只让 400/404/405/415/422 退回，5xx 直接抛（服务端坏了不该
  静默变成第二次请求）；流里 `finish_reason=length` 与整段路径同一口径。
- `FailoverLlmClient`：`committed` 闸 —— 吐过字就地失败（换线路重试就是同一段话说两遍），
  但仍 `recordFailure` + 冷却；一个字都没吐时照常轮换（闸门没把 failover 关掉）。
- 接线：`ChatSession` 新增 `stream` 选项（默认开）把增量映射成 `chat:delta`；`src/store.ts`
  的 `streaming` 预览在 entry / done / error / 中止 / 切会话时清空；`ChatPage` 渲染实时行
  （`data-testid="chat-streaming"`，光标用 `::after` 画 —— 不进 DOM，免得污染文本断言）；
  `headless/chat-main.ts` 非 `--json` 形态逐字打到终端，并按"增量已显示过且与落定正文
  一致"去重（文本协议下正文会被剥掉围栏，两者不同就照常打印干净版本）。

**测试**：`src/sse.test.ts` 29 条（跨 chunk 拼接、工具碎片、Anthropic 事件、坏帧、
非 `tool_use` 的 start 不产生调用、缺 `partial_json` 的增量不拼字面量 undefined）；
`src/http-clients.test.ts` +13（真流 / 零增量退回 / 400 退回 / 500 不退回 / 已吐字断线
不重来 / usage 缺席不补 0 / 无流句柄退化 / Anthropic 两侧）；`failover` +3（committed
不轮换、没吐字照常轮换、committed 仍记账）；`chat-session` +3、`store` +6、`chat-ui` +2。
**真进程 IT**：假大脑支持真 SSE（`scripts/chat-agent-it.mjs` 新场景：一次请求 + 多块增量，
不开 SSE 时两次请求退回整段且一个增量都不发），`scripts/chat-cli-it.mjs` 断言 `--json`
真的带 `chat:delta` 且拼起来就是正文。

**变异账（site 逐点）**：http-clients 129/129（基线 96 → 129；首轮 126/129，存活的三处是
`onDelta && !streamUnsupported` 的 `&&`、`out.usageTokens !== undefined` 的条件与三元分支
—— 补"Anthropic 侧不给 onDelta 就不试流""流里带/不带 usage"两条杀掉）、stream.ts 51/51
（首轮 49/51）、chat-events 15/15、session 25/25（24 → 25）、store 44/44（43 → 44）。
基线 2396 → **2482**（96 目标）；用例 2530 → **2590**（+8 跳过，83 个有可执行用例的文件）。

**并发觉并修掉的 IT 假象（不是代码缺陷）**：流式默认开启后，假端点的脚本应答被
`replies.shift()` **按请求**消耗，而"先试流 + 退回整段"让同一轮来了两次请求 —— 脚本整体
错位一格，症状是"第二轮没拿到工具结果""审批只问了一次"。两处修正：假端点在流式尝试上
**只偷看不消耗**（重问那一次才拿走脚本），断言从"按请求下标"改成"按内容找"
（下标会漂，"工具结果有没有回到请求里"才是要钉的事实）。

**事故（本轮，值得记住）**：`mutation-check` 的"上次被强杀 → 恢复源码"逻辑拿
`scripts/.mutation-pending/*.orig` 还原文件，而那批 `.orig` 是**更早一轮**的快照 ——
`shared/http-clients.ts` / `electron/chat/session.ts` / `shared/chat-events.ts` 三处未提交的
流式改动被整份抹掉，且 `git status` 看不出来（等于静默回退到 HEAD）。教训：
**跑变异/审计类脚本前先提交**（或至少留一个可恢复的快照）；过期台账目录已清理。

**门禁现状（当轮）**：用例 2668 → **2689 通过 + 8 跳过**（86 个有可执行用例的文件）。
site 审计逐点：providers **7/7**、http-clients **137/137**、session **44/44**、
chat **105/105**、store **68/68** 全杀；基线 2554 → **2591 / 98 目标**。
一处等价白名单：`buildSession` 的 `pinned && profile?.reasoningEffort` —— 下游
`ChatSession` 构造函数对同一条件做了二次守卫，`undefined` 不会进 meta。

### 新增（技能目录 M6a · 2026-10-22）

**动机**：Codex 的能力扩展面第一块是 Skills。会话工具目录此前是硬编码六件套，
没有任何注入第三方能力的通道 —— 我们是 MCP *server*（能被集成），不是 client。
M6a 做的是"技能进来"这一半：目录扫描 + 编目 + 进提示。

**实现要点**：

- `shared/skills.ts`（新，tier 1）：解析 `---` front matter（只认 `key: value`，
  不支持嵌套/锚点 —— 半支持 YAML 比不支持更糟）、名字归一化（kebab-case，
  不静默改写）、同名去重（项目级压全局级）、目录块拼装（预算按**整条**累加，
  先拼后切会把最后一条描述剁掉一半）。
- `electron/engine/skills.ts`（新，tier 1）：读盘薄壳，与 `conventions.ts` 同形状。
  三条沿用：目录不存在 = 空（不是错误）；没有 SKILL.md 的子目录不是技能
  （可能装脚本）；坏技能进 `issues` 而不是消失。
- 注入：`resolveChatRuntime` 把目录块拼在约定块之后（两者都是背景），
  坏技能的原因进 `runtime.issues`（宿主会打日志）；
  `skills:list` IPC + 技能页真实化。
- **顺序上的一个决定**：先做"技能进来"，后做"取全文"（`read_skill` 在 M6b）。
  目录块里点名了 `read_skill`，但工具目录还是六件套 —— 这一条写在页面与
  CHANGELOG 上，**不假装它已经能取**。

**契约变了要让测试红一次**：IA-2 时期那条"技能占位页说清…界面在建"的用例
被 M6a 推翻（占位升级成真实列表），用例连同注释一起改写。

### 新增（并行写冲突检测 M4c · P1 · 2026-10-21）

**动机**：Codex 用 worktree 做物理隔离，我们按 D 类决议不走 worktree（会丢掉跨模块
协同与"一份交付物"）。于是并行之后立刻出现一个真问题：**两条线程改同一个文件时，
谁说了算？** §八 的裁决是 P1 默认（冲突检测 + 人拍板）、P2 进阶开关（zone 软提示）、
P3 不做（同项目写串行闸会删掉无摩擦手感）。本轮做 P1。

**实现要点**：

- `shared/chat-conflict.ts`（新，tier 1）：纯判据。四条边界各有理由 ——
  只认别人的写（自己接着打补丁被自己拦住是最蠢的假阳性）、窗口外不算并发
  （陈旧线索没有价值）、同一路径只报最近那一条（人要看的是"谁刚动过"，不是流水账）、
  时钟倒挂按"刚刚"处理（宁可多问一次）。
- `electron/chat/write-ledger.ts`（新，tier 1）：主进程按线程记"谁改了哪个文件、
  什么时候"。三个决定：上限 500 且**丢最旧的**（丢最新等于把最该拦的先扔掉）；
  线程退场连记录一起清（否则一个已不存在的线程继续拦人）；不持久化 ——
  重启后没有"刚才"，把陈旧记录当并发线索只会误伤。
- `ToolRunner`：写之前先查冲突、命中就问，且**排在 `guard` 之前** —— 人要先知道
  "这是别人的地盘"再决定批不批这次写。三点刻意与 `guard` 不同：不接"本次会话
  不再问"（记下来等于永久关闸）、没有审批通道按拒绝（fail-closed）、请求 id 带
  `conflict-` 前缀（它和同一次调用的写审批是两个问题，共用 id 会被第一个答复吃掉）。
  两个注入点（`sessionId` + `conflictWrites`）都给了才检测 —— CLI/headless 单线程
  形态不注入，于是天然不检测，不需要额外开关。

**边界（写进 CHANGELOG）**：只管线程与线程之间，人在 IDE 里的外部编辑不在判据里
（那是"文件在补丁之后又被改过"那条撤销判据的地盘）。越界只提示不回滚 —— 会话层
"人是最后的仲裁者"，编排层才是"门禁是仲裁者"，两者的回滚权限故意不同。

**site 审计**：chat-conflict **12/12**、write-ledger **3/3**、tool-runner **64/64**
全杀；基线 2661 → **2681 / 102 目标**（新目标 2 个）。用例 2722 → **2745 通过 +
8 跳过**（89 文件）。

首轮审计抓到五处，全是"顺序/边界"类的老面孔：

1. `conflictFacts` 的两条 `continue`：改成 `break` 只在"别人的写排在自己之后"
   与"新的写排在过期写之后"时暴露 —— 我的用例恰好把这两类都排在了前面。
2. 排序比较器的"相等"档：抽成 `compareConflictPaths` 单独测。**这是第二次踩同一条
   坑**（M2 的 `chat-changes` 已经踩过一次），教训成立但显然还不够自动化：
   要么给仓库加一条 lint（禁止在 `sort()` 里写裸三元比较器），要么在写聚合函数时
   默认就把比较器提出来。先按后者做，规则写进 SKILL 之前再观察两轮。
3. `conflictWindowMs` 的三元分支：没有一条用例真的传过自定义窗口 ——
   **"可配置"不等于"已接线"**，可选项至少要有一条用例证明它改变了行为。

### 新增（多线程并行·界面侧 M4b · 2026-10-21）

**动机**：M4a 让宿主能同时跑多条线程，但界面还只渲染当前这条 —— 后台线程跑完了、
在等审批了，操作者都看不见。M4b 补的是这一格：**同一份事件流走两条账**，视图只认
当前线程，状态位聚合每一条。

**实现要点**：

- `shared/chat-thread-status.ts`（新，tier 1）：纯归约
  `(上一条状态, 事件, 当前在看哪条) -> 新状态`。三条纪律各自对应一种错法：
  正在看的那条不该涨未读（否则你每收一个字就给自己一个红点）；`awaiting` 是独立
  一位而不是 `status` 的别名（审批答掉后线程回到 running，"刚刚有东西在等你"这件
  事得留过痕迹）；不认识的事件返回**原对象**（调用方可据引用相等跳过渲染）。
- store：`chat.threads` 与视图并列维护，事件先记状态位、再决定要不要进视图。
  恢复线程时状态以**转录 meta** 为准 —— 离开期间丢掉的 status 事件在那一次
  恢复里补齐，比逐个事件重放可靠。
- 左栏：状态点（在跑/等审批/完成/出错/中止）+ 未读数。**锁的范围变了**：
  M1 的"有线程在跑就禁用一切切换"作废（那时切线程会重建会话），现在只锁
  删除/分叉一条正在跑的线程。旧测试 `ui.test.tsx` 断言的正是被推翻的那条纪律，
  改测试时把"为什么推翻"写进了用例注释 —— 契约变了就要看见它变。
- 通知判据多一档 `chat:approval-request`：只有"不是当前正在看的那条"才弹。
  焦点由 `electron/chat/focus.ts` 持有（独立小模块，避免 `ipc/context`（send）
  与 `ipc/chat`（会话宿主）互相 import 成环）。**归属缺失时照弹** ——
  宁可多提醒一次，也不要因为一个字段缺失让真正的等待被静默吞掉。

**已知边界**：主进程不知道窗口焦点。窗口切走但正在看的还是同一条线程时，这条规则
不弹（对话框确实还开着）。"窗口失焦也提醒"与"只在失焦时提醒"是同一件事的两面，
留到通知策略下一轮一起做。

**site 审计**：chat-thread-status **13/13**、notify-rules **17/17**、
store **83/83** 全杀；基线 2635 → **2661 / 100 目标**（新目标 1 个）。
用例 2705 → **2722 通过 + 8 跳过**（88 文件）。

三处处置值得记：

1. **store 的 `&& sid !== ""` 是等价变异**（归约层对空串与非字符串都不改状态）。
   按纪律**重构消除**而不是白名单：删掉后半段，位点从 85 降到 83。
2. **`markThreadRead` 一度变成零调用导出**（`check:unwired` 抓到）—— 说明"切回去
   清未读"这条规则原本只在 resume 里实现，而"正在看的那条收到任何事件都该归零"
   没实现。接回去之后它既消掉了未接线告警，也补上了真正的行为缺口：**一个没人
   调用的防护等于没有防护**，这句话在门禁里是字面意思。
3. **一条旧契约被推翻**：`ui.test.tsx` 原本断言"运行中禁用一切切换"。M4a 之后
   这条不再成立（切线程不重建会话），用例连同注释一起改写。**契约变了要让测试
   红一次**，否则下一个人会以为那条纪律还在。

**又一次事故（同一天第二次）**：store 的重构写完没提交，随后一次被强杀的审计
从 `.mutation-pending` 的旧快照还原了 `src/store.ts`，把改动静默抹掉——文件回到
HEAD，`git status` 干净得像什么都没发生。重做后立刻提交。**结论不变且更硬：
任何要跑变异脚本的窗口里，先 commit，哪怕只是一行。**

### 新增（多线程并行·宿主侧 M4a · 2026-10-21）

**动机**：Codex App 的自我定位是"智能体指挥中心"，指挥的对象是复数。我们左栏线程树
已经摆好了"复数"的样子，但宿主里 `live` 是模块级单例 —— 复数只是历史，不是并发。
M4 是蓝图里最大的一轮，拆成三段做：**M4a 宿主侧并行与寻址**（本轮）、M4b 渲染层
多线程视图（左栏状态位 + 后台待审批通知）、M4c 冲突检测（P1 默认 + P2 进阶开关）。

**为什么先做宿主**：串台的根源在主进程的单例，不在界面。渲染层先改会把"事件归属"
和"状态位"混在一起调，出问题时说不清是寻址错还是渲染错。

**实现要点**：

- `chat/thread-registry.ts`（新，tier 1）：`Map` + 活跃指针。三条纪律各有对应的错法
  —— 同 id 覆盖必须**删后插**（`Map.set` 对已存在键不改位置，重建后会一直"最久没动"）、
  删活跃项必须退位到最后一个活着的（否则 `chat:latest` 返回不存在的线程）、
  `latestOf(project)` 绝不跨项目回退（拿别人的线程冒充本项目）。
- IPC 寻址：`chat:send` / `chat:abort` / `chat:transcript` 接受可选 `sessionId`，
  省略 = 本项目最近活跃的那条（旧调用语义不变）。`chat:new` / `chat:fork` 不再中止
  别人 —— 旧实现里那是"顺手收尾"，多线程下等于"开新会话就杀掉所有任务"。
- `ensureLiveSession` 重建时**只接自己的历史**：旧实现从 `live` 读快照，多线程下会把
  另一条线程的转录当成本条的 history（比丢历史更坏）。
- 审批归属：`pendingApprovals` 由 `requestId -> resolve` 变成
  `requestId -> {sessionId, resolve}`，中止只拒绝自己的那几个；对外 id 改成
  `会话#原id`。**这一条是测试逼出来的真 bug**：`requestId` 来自工具调用 id，文本协议
  是 `t-1`/`t-2`，两条线程同时问第一件事时键完全相同 —— 答一条会解析掉另一条的等待，
  被顶掉的那条 runner 永远挂着。单线程下这个碰撞不可能发生，所以此前一直没暴露。
- 渲染层：`isEventForChat` 三条规则（无归属收下 / 当前还没 id 收下 / 其余丢弃）。
  第三条真丢弃事件：后台线程在本轮不渲染，但**转录照常落盘**，切回去时从记录恢复。

**已知边界（写进 CHANGELOG，不在本轮假装）**：左栏状态位、后台线程待审批的系统通知、
线程切换不重建视图都留 M4b。本轮之后"两条线程能同时跑"是真的，只是界面还只看得见一条。

**site 审计抓到的四处**（三处真缺口 + 一处死代码）：

1. `latestOf` 的两条 `continue`：改成 `break` 之后，只有**特定顺序**才暴露 ——
   表里先出现异项目项、或被排除项不是最后一条。原用例（单项目、单线程）在两种
   变异下都绿。补两条顺序敏感用例：异项目项打头仍返回本项目那条；`except` 命中的
   是前一条时仍返回后一条（反过来也测）。**教训：遍历型判据要测"顺序"，不能只测
   "内容"** —— 集合式断言在 `break` 变异下往往恒等。
2. `sessionId` 的字符串判据（`typeof x === "string" && x !== ""`）宽一格：
   数字 id 被当真 id 丢给登记表 → `resumeIntoLive` 抛"会话不存在"；
   `chat:abort` 则传进 `undefined`，"停止"静默失效（点了没反应那类）。
   补一条"传 42"的用例，发送按缺省走、中止按缺省走。
3. store 的 `sessionId ? { sessionId } : undefined` 三元互换：没有当前线程时会把
   `{sessionId: undefined}` 发出去 —— 宿主只能猜。补一条"两次调用，第二次必须
   **不带参数**"的用例。
4. `resumeIntoLive` 里的 `if (already !== undefined) liveThreads.remove(sessionId)`
   是**死代码**：紧接着 `buildSession` 用同一个 id 登记，登记表的"同 id 覆盖"
   本来就包含删除。留着它只有两个后果 —— 多一个等价变异要论证、多一次误导性阅读。
   **处置不是白名单，是删掉。** 顺便把两处白名单锚点按新行号校回
   （172→197、345→402），fail-safe 正确地把"锚点漂移"报成了存活。

**一次事故记录**：审计进程被外部强杀时残留了变异体，脚本下次启动自动还原（台账
`.mutation-pending/*.orig` 生效）。诱因是我在审计进行中手工改同一文件做验证 ——
**审计期间不要碰被审文件**，要手工验证就等它跑完（或换一个没被审的文件）。
第一次跑出的"存活"名单因此不可信，全部重跑过。

**门禁现状**：用例 2689 → **2705 通过 + 8 跳过**（87 个有可执行用例的文件）。
site 审计逐点跑完：thread-registry **12/12**、chat **126/126**、store **79/79**
全部杀死；基线 2591 → **2635 / 99 目标**（新目标 1 个）。

### 新增（线程级推理强度 M3c-3 · 2026-10-21）

**动机**：M3c-2 收尾时明确写了「不碰推理强度」——各端点 reasoning 字段不统一，先不做
没有真实效果的开关。这一轮把「不统一」这件事本身做成数据：**能力表按 provider×model
登记，未登记就不发字段**。同一家端点既卖推理型也卖非推理型模型（`deepseek-v4-flash`
vs `sensenova-6.8-flash-lite`），按 provider 一刀切会把不认识的字段发给普通模型 ——
所以判据必须细到线路。

**实测先于代码**（2026-10-21 真请求）：

| 线路 | low | medium | high | 返回 `reasoning_content` |
| --- | --- | --- | --- | --- |
| `sensenova/deepseek-v4-flash` | 200 | 200 | 200 | 是 |
| `sensenova/glm-5.2` | 200（文档映射到 high） | 同左 | 200 | 是 |
| `sensenova/kimi-k3` | 探测 429、文档仅 `max` | — | — | 未验证 |

glm-5.2 只登记 `high`：把 low/medium 显示成三档 = 「选了低档实际跑高档」的假开关，
比不显示更坏。Kimi 与 Anthropic 本轮不开（后者需要保留带签名的 thinking blocks，
当前工具循环只存纯文本 reasoning，回灌会 400）。

**实现要点**：

- `REASONING_EFFORTS` / `isReasoningEffort` / `reasoningEffortsOf` 放在
  `shared/providers.ts`：UI 下拉与请求体共用**同一份**判定，不各写一套。
- `ChatRequest.reasoningEffort` 与 `enable_thinking: false` 互斥：显式选了强度就发
  `reasoning_effort` 并撤掉关闭开关；两者同时发实测仍会推理，但语义冲突不能靠端点
  「碰巧忽略」。未登记线路收到强度时**抛错**，不静默降级 —— 静默降级会让操作者以为
  自己在用高档。
- `ChatResponse.reasoning` 在整段与 SSE 两条路径都聚合（有的模型把答案写进
  `reasoning_content` 而 `content` 为空，这条此前已有兜底）；原生协议把上一轮
  reasoning 随 assistant 消息回灌，文本协议不存（避免会话体积翻倍）。
- 线程档位进 `ChatSessionMeta`：恢复、分叉、开新会话都从 meta 沿用；换线路时
  store 会**清掉**旧档位（`setChatModel` 里查能力表），否则会给新模型带上它不认识的档。
- 压缩摘要故意不带强度：维护动作不该变成第二次深思。

**审计抓到的三处「假绿」**（都不是编译错，是"没测到"）：

1. `isReasoningEffort` 两个位点存活（`&& → ||`、`=== → !==`）：原用例只经 IPC 走
   非法值，`typeof` 与 `includes` 两条腿从未被分开验证。补的直接单测里，`"max"`
   （字符串但不在表内）钉 `includes` 腿，`"high"` 被接受钉 `typeof` 腿。
2. `toOpenAiMessages` 的**无 tool_calls 助手分支**三元互换存活：既有用例只覆盖
   「带 tool_calls 的助手消息回灌 reasoning」，而工具循环**收尾那条**（正文已出、
   没有 tool_calls）是另一条 return。它丢字段不报错，只让下一轮追问丢掉推理上下文。
3. 这两处都属于同一类：**新加的分支要先问"哪条 assertion 只能由它满足"**，
   否则测的是邻居。

### 新增（线程级模型 M3c-2 · 2026-10-21）

**动机**：Codex 的模型选择在会话头，不在全局设置里 —— 一条线程用快模型摸现状、另一条
用强模型改代码，是真实工作流。M3c-1 已把沙箱/审批做成线程档；这一轮补上同一层的
provider × model，但**不碰推理强度**：各端点的 reasoning 字段不统一，先不做一个
没有真实效果的开关。

**实现要点**：

- `ChatRuntimeProfile` / `ChatSessionMeta` 增加可选 `providerId` + `model`；两者只在线程
  显式钉死时出现，缺席仍表示"跟随全局 provider/pool"。
- `buildLlmClient` 接受 `model`：SenseNova 仍用全部密钥但只带这一款模型（429 不会
  悄悄换模型），其他 provider 克隆配置后覆盖 `defaultModel`。
- `buildLlmPinned`（Electron 宿主）先按被选 provider 播种密钥仓，再用同一个
  `brainTimeoutMs` 建单线路客户端 —— 不经过全局池，也不丢掉密钥/超时。
- `chat:send` / `chat:new` 校验 `profile.providerId` 与 `profile.model`；恢复、分叉、
  中止后重建都从 `meta` 还原线路，避免"界面写着某模型、实际早换回全局池"。
- 线程头新增模型下拉（已登记线路，不支持任意输入）；切线路进 runtime signature，
  下一条消息重建会话并保留历史。

**门禁现状**：用例 2659 → **2668 通过 + 8 跳过**（86 个有可执行用例的文件）。M3c-2 触及的
8 个目标逐点审计全杀：runtime **12/12**、session **34/34**、chat **98/98**、context **27/27**、
build-llm **12/12**、chat-events **15/15**、providers **5/5**、store **59/59**；基线
2534 → **2554 / 98 目标**，README/gates 已同步。补的 5 条用例专钉半截线路（只给 provider 或
只给 model）、非字符串 provider、`isModelId` 的非字符串输入，以及中止后按 meta 重建线路。
两处等价变异入白名单：`profileOfMeta` 的早退条件（下游 `getProvider` + `isModelId` 兜底，
半截 meta 的返回值不变）与 `ensureAgentLayer` signature 里的布尔取反（只参与字符串相等比较，
取反保持相等类）。

### 新增（线程级运行档 M3c-1 · 2026-10-21）

**动机**：Codex 的线程头把"这条线程按什么边界跑"放在操作者眼前；我们此前只有设置页的全局
档位，改一次会影响所有项目，且会话页只能读、不能调。M3c 先做能复用现有运行时的一轴：
沙箱与审批。模型/推理强度涉及线路池与端点能力，单独一轮做，不在这里假装。

**实现要点**：

- `ChatRuntimeProfile`（shared/chat-events）+ `resolveChatRuntime({ profile })`：线程显式档位
  压过项目 `.ox/config.json` 与全局设置；档位进入 signature，宿主据此重建会话但保留历史。
- `chat:send` 接受可选 `profile`，只认已知枚举；拼错时抛 `profile.mode` /
  `profile.approvalPolicy`，不静默回退默认档。
- `ChatPage` 线程头：沙箱/审批两个下拉，运行中禁用；下方一句"只影响这条线程，下一条消息
  生效；历史保留"。
- 测试：`chat-ui` 钉切换写入 store 并随下一条消息带出；`ipc-handlers` 钉 profile 压过项目
  配置且真的拦住写盘、非法值报错；`chat-runtime` 钉优先级与签名变化。

**门禁现状**：用例 2655 → **2659 通过 + 8 跳过**（86 个有可执行用例的文件）。
site 审计逐点跑完：runtime **12/12**、chat-events **15/15**、store **57/57**、
chat **85/85**（其中 chat 位点 83 → 85）全部杀死；基线 2532 → **2534 / 98 目标**，
README/gates 已同步。

### 新增（@文件补全 M3b · 2026-10-21）

**动机**：M3a 解决了"指哪一行"，但"让它读哪个文件"仍靠手输完整相对路径。路径错一个字符，
模型就会收到一次 `read_file` 失败再自己猜。`@` 补全是把"人认识的文件"变成"工具认识的路
径"的最短路径。

**实现要点**：

- `chat:files`（electron/ipc/chat.ts）：递归列项目文件，逐条过
  `PathPolicy.assertReadable`，因此 `.env` / `.npmrc` / `.git/**` 等禁读项与链接都不会
  出现在候选里；`.git` / `node_modules` / `dist*` / `release*` / 缓存 / 虚拟环境目录跳过，
  封顶 2000 条（返回 `truncated`，界面明说只显示前 2000 个）。
- `src/chat-mention.ts`（UI 纯函数）：从光标往前找 `@token`，空格/邮箱处拒绝；候选按
  「文件名前缀 → 路径前缀 → 路径子串」排序；插入时替换 token 并补一个空格。
- `ChatPage`：`@` 打开下拉，↑↓ 移动、Enter/Tab 选中、Esc 关闭、鼠标点选；补全打开时
  Enter **不透传**给发送。文件列表按项目缓存一次，并用 in-flight 去重防止
  onChange + onSelect 两次请求互相覆盖。
- 测试：`src/chat-mention.test.ts` 钉 token/排序/插入；`chat-ui.test.tsx` 钉键盘选择与
  "不会误发送"；`ipc-handlers.test.ts` 钉禁读文件与重目录过滤。

**门禁现状**：用例 2648 → **2655 通过 + 8 跳过**（86 个有可执行用例的文件）；
`electron/ipc/chat.ts` 位点 77 → **83**（去掉两条 `continue` 后从 86 降下），
`src/store.ts` 位点 45 → 57。site 审计已逐点跑完：chat.ts **83/83**、store.ts **57/57**
全部杀死；`SITE_BASELINE` 写到 **2532 / 98 目标**，README/gates 已同步。
审计期间补出的断言：`dist-*`/`release-*` 目录独立过滤、含空白路径不进候选、
删除评论只命中 `(path, turn)` 同时相等的那一条。

### 新增（行级评论 M3a · 2026-10-21）

**动机**：M2 的右栏能看 diff、能撤销，但"改得不对"时人仍然只能回到输入框写一句
"上面那个函数第三行逻辑不对"—— 而 diff 来自**会话内快照**而不是盘上现状，模型只能
靠猜是哪一行。行级评论把"指哪一行"变成结构化数据。

**实现要点**：

- `InlineComment`（src/types.ts）：(path, turn, line, side, text)。`side` 不能省 ——
  同一个行号在 before/after 里是不同的代码；`turn` 不能省 —— 撤销那一轮之后评论
  就失去了指涉对象。
- `appendCommentAppendix`（src/store.ts，导出可测）：把评论拼成消息附录，四样定位
  信息一样不少，并写死"没有评论涉及的代码严格保持不动，不要顺手重构周边"。
  少了后半句 agent 会顺手重构周边（Codex 用户的经典抱怨）。
- 发送语义三改：① 空正文 + 有评论 = 合法发送；② 发完即清（一次性附录）；
  ③ **失败把评论与正文都还回去**（静默丢掉等于用户白写）。
- 撤销与清评论同一次点击完成（ReviewRail 的 onClick 里连着调 `dropInlineCommentsFor`）。
- 中栏待处理横幅带「去右栏看」「全部丢弃」—— 评论加在右栏、发送发生在中栏，
  两处必须互相看得见。

**门禁**：`src/store.ts` 位点 45 → 57（新增附录拼装、四个评论 action、发送语义分支），
site 口径 **57/57 逐点全杀**；用例 2640 → **2648**（85 个有可执行用例的文件）。

**为什么评论不落盘**：它是"这一刻对这一次 diff 的意见"，不是会话内容。落盘会让
恢复出来的会话顶着一堆指涉已失效改动的评论 —— 那种"看起来是数据其实是垃圾"的状态
比没有更难排查。转录里由系统条目留下"当时附了 N 条评论"的痕迹就够追溯了。

### 新增（右栏改动审查 M2 · 2026-10-21）

**动机**：M1 把线程树搬到了常驻位置，但"这个线程动过哪些文件"仍然摊在中栏几百行
工具输出中间 —— 要滚到底才看得见，而它恰恰是 Codex 工作台里右栏存在的全部理由。

**实现要点**：

- `shared/chat-changes.ts`（新，纯逻辑，已入 tier 1）：转录 → 文件组。两条容易写错
  且**错了不抛异常**的规则被钉住：① 同一文件多轮改动**每条都留**（撤销是按
  (turn, path) 做的，只留最后一次会让"撤销"恢复出一个谁都没见过的中间态）；
  ② 不可撤销的改动（超记录上限、没存 before/after）仍然列出来 —— 藏起来等于瞒。
- `src/components/ReviewRail.tsx`：右栏。文件行 + 逐行 diff + 撤销按钮 + 多轮列表。
  不新增任何 IPC —— 数据本来就在会话条目里，此前的问题只是位置。
- 收起/展开：右栏头部「收起」，中栏状态行「改动审查」回归入口。窄屏 <1080px 折到
  中栏下方并限高（审查是"停下来看一眼"，执行流是主线）。
- 行数统计单独一个 `countLines`：`"a\nb\n"` 是两行不是三行 —— 直接
  `split("\n").length` 会把结尾空串数进去，于是每个常规文件都多报一行
  （首轮 3 条断言就是这么红的：期望 3 实得 4）。

**变异账**：新目标 `shared/chat-changes.ts` 12 → 10 个位点（提取 `comparePaths`
后三元结构变了），site **10/10 全杀**；`src/store.ts`（reviewOpen）45/45 全杀。
基线 97 目标 / 2504 位点 → **98 / 2514**；用例 2619 → **2640**（85 个有可执行用例的文件）。

**site 口径抓到的两处覆盖缺口**（都是"小数组上碰巧正确"那一类）：

1. `continue → break`：遇到一个没有 changes 的 entry 就停止扫描。原 fixture 把无改动
   的条目全放在最前面，所以 break 与 continue 等价 —— 而真实转录里 assistant/user
   条目与 tool_result 交替，绝大多数都没有 changes。
2. 排序比较器的**内层三元**：`a.path > b.path ? 1 : 0` 被换成 `? 0 : 1`，只在
   "两个 path 相等"时不同 —— 而组来自 `Map`，同路径只有一个组，这个分支在
   `collectChangedFiles` 里**永不可达**。解法不是白名单，而是把比较器提成导出的
   `comparePaths` 并直接测 `comparePaths("a","a") === 0`：让不可达变可达，
   顺便钉住"自己不小于自己"这条排序公理。**教训**：比较器要单独可测，
   否则"相等"这一档永远测不到，而它恰是坏比较器最先烂掉的地方。

**已知缺口（诚实版）**：右栏只读会话内快照，不比较盘上现状（B1 的批次存档 diff 仍在
看板那一侧）；`run_command` 的改动不在审查范围；速览数字是行数量级；窄屏只验证了 CSS
折行，没有逐分辨率真机看过。

### 新增（桌面三栏工作台 M1 · 2026-10-21）

**动机**：用户看了 Codex 桌面端之后的原话是"桌面端的功能太少"。盘点下来结论是
**引擎层资产比 UI 层多得多** —— 会话、工具循环、审批三档、落盘/恢复/分叉、逐行 diff、
撤销、流式、上下文压缩全都已经落盘可用，缺的是"把这些能力摆成一个指挥台"。
本轮做三栏壳与线程树，不碰引擎。

**实现要点**：

- `src/components/SessionList.tsx`：从 ChatPage 中段**整体搬来**的线程列表，交互一字
  未改（标题行恢复 / 行尾分叉与删除 / 删除二次确认 / 运行与等审批时禁用切换）。
  搬的是位置不是逻辑 —— 原来每次换线程都要先滚过整段转录。
- `src/components/ThreadRail.tsx`：左栏。上半是项目列表，下半是当前项目的线程列表，
  底部一个"刷新线程列表"。三条纪律：**只导航不发起动作**（切项目不开始规划、切线程
  不发送东西）、切项目必须同时设 `activeProjectId` 与 `page`（没有当前项目时左栏点哪
  一行都不会有线程可看）、切线程不跳页（操作者可能正停在看板上瞄进度）。
- `App.tsx`：`page === "chat"` 时套 `.app-shell-three`，其余四页保持单栏。
  CSS 用**横向 flex 而不是 grid**：中栏的转录 + 输入框要能自己滚，grid 子项默认被内容
  顶高，滚起来的是整页而不是那一栏。窄屏（<1080px）折成单栏横带。
- `store.ts` 新增 `focusProject`：先落页面再取数（反过来一次慢的 `chatLatest` 会把
  点击表现得像没反应）；同项目重复点击直接 return（那会打断正在读的转录）。
- `ThreadRail` 自己管列表加载（空列表才取）：它现在是线程的一等入口，不能等中栏挂载
  才知道有哪些线。

**门禁**：`src/**` 整目录在变异豁免表里（UI 的正确性判据是"渲染出什么"而不是"分支
走向"），但 `src/store.ts` 不在豁免内 —— 新增的 `focusProject` 带 1 个位点，跑完
site 口径 **45/45 逐点全杀**，基线 44 → 45（总量 2503 → **2504**）。
用例 2615 → **2619**（84 个有可执行用例的文件；新增 3 条左栏断言 + 1 条三栏壳断言）。

**测试迁移的一条纪律**：`chat-ui.test.tsx` 里"历史会话可恢复 / 分叉 / 删除"那条的
`render(<ChatPage />)` 改成 `render(<ThreadRail />)` —— 契约没变，变的是组件位置。
同时新写两条"不会自然被发现"的断言：三栏壳**只在会话页**出现（防左栏被安到所有页），
以及 ThreadRail 无项目时"新线程"按钮是**禁用而不是隐藏**（摆一个按不动的按钮也比
藏起来更让人觉得这里能开线程）。

**已知缺口（诚实版）**：右栏（改动审查）、@文件补全、Skills、MCP client、Automations
桌面化都还在 M2–M4；左栏没有搜索与归档分组；窗口宽度 <1080px 时只验证了 CSS 折行
逻辑，没有在真窗口里逐分辨率看过。

### 新增（上下文压缩 · P1-2 · 2026-10-20）

**动机**：P0 的工具循环一旦真跑起来，长会话撞上下文窗口是**必然**而不是意外 —— 每轮
都可能是"读一个文件的全文并要求补全"。撞了之后的症状（"模型忘了开头说过什么"）在界面上
完全看不出成因，且与"模型能力差"不可区分。所以这一格在 P1 里排第二（紧接流式 token）。

**设计取舍**：

- **估算只用于触发，不用于计费**。刻意不做真 tokenizer：把词表带进 `shared/` 那一层
  会让纯逻辑层变重，而这里只要一个偏保守的信号 —— 估少了顶多多压一次，估多了会漏压。
  ASCII 按 4 字符/token、CJK 按 1 字/token，每条加固定结构开销。
- **切点不能劈开一个工具回合**。`assistant(tool_calls)` 后面必须紧跟它的 `tool` 结果，
  切开会让 OpenAI 兼容端点直接 400 —— 失败发生在平台之外，是最难查的一类。所以切点一律
  向后对齐到安全边界。
- **转录从不删条目**。被换掉的只是发给模型的那一段；"为什么这轮的正文忽然少了"必须
  能在本地回答，而不是靠猜。

**本轮抓到的问题**（都是"测试写完了才发现"这一类，没有一条由编译或 lint 拦住）：

1. **压缩原文漏掉最老的一条用户消息**。`planCompaction` 的契约写明"首条是 system"，
   而 `ChatSession.messages` 从来不含 system（每轮请求时才由 loop 现拼）⇒ 第一条普通
   消息被当成"要保留的头"跳过。症状写起来毫不起眼：`sources[0]` 收到的是第二条消息。
   修法是**传入含 systemPrompt 的完整序列**，顺带把工具目录很长时的系统性低估也修掉
   （此前压根没把 system 计入预算）。
2. **尾部能被压成空**。原算法从头部累加到"剩下的装得下"为止；当**最新一条本身**就已超
   预算时，循环会一路推到表尾，把尾部压成空序列 —— 压得最狠的一次反而既不报 stuck
   也不报错，模型下一轮只剩 system 与摘要。改为**从尾往前**找切点（留尽量多的近期内容，
   且至少留最后一条）。改完仍然满足原有六条 `planCompaction` 用例，一条没改。
3. 连带发现的**测试保真度**缺口：中止用例的假客户端只在 `abort` **事件**上拒，而一旦
   异步链上多了一层 `await`（压缩前置检查），abort 就可能早于请求建立 —— 假客户端会
   静默等满 5s 然后判 `done`，把"取消没生效"伪装成"模型答完了"。给假客户端补上
   "进来时已中止就拒"（真实 `http-clients` 的行为），并把用例里"赌同步段"的写法换成
   显式推进到 signal 转出为止。

**变异账**：`shared/chat-compress.ts` 14 个位点（逐点杀死 13 + 等价白名单 1）；
`electron/chat/session.ts` 32 个位点逐点全杀（基线 25 → 32）。BASELINE
从 96 目标 / 2482 位点 → **97 / 2503**；用例 2590 → **2615**（84 个有可执行用例的文件）。

**site 口径又抓出来的三条覆盖缺口**（本来是全绿的压缩实现）：

1. `renderCompactionSource` 的 assistant 分支把 `&&` 换成 `||` 时存活 ——
   一条**没带工具调用**的 assistant 也会被渲染成「调用了 …」的形状，把叙述说成调度动作。
2. 同一方法里 tool 分支的 `continue` 换成 `break` 也存活 —— 工具结果之后的
   所有消息会被静默丢掉，而现有 fixture 恰好都把 tool 摆在最后一条。
3. `keepTailRatio` 与压缩请求的中止信号**两条接线**都没钉：前者被变异成"永不透传"
   （用户给的值被默认 0.5 吞掉）时不红，后者少了它会让"停止"掐不掉整理上下文这一步。
   补的都是对象级证据（`Expect(seen).toBe(controller.signal)` 那种）。
4. `isSafeCut` 的 `index <= 0` 守卫是**可证明不可达**（唯一调用点的 cut 恒落在
   `[1, length-1]`），按"防御冗余、有意保留"入 `EQUIVALENT_SITES`，锚点漂移会重新暴露。

四处文档数字（README / CHANGELOG / ENGINEERING-LOG / gates.md）同批同步；
其中"变异账"这一段本身就是个教训：**写出来那一刻的数字会被自己的后续轮推翻**，
所以本轮又跑了一次全量与 site，把 2610 改成 2615。

**已知缺口（诚实版）**：桌面端仍走默认预算、没有 UI 开关；`--compact-tokens` 只有单元
覆盖，没有真进程 IT；默认压缩器复用会话同一个客户端，会消耗同一张冷却表，线路紧张时
"整理上下文"本身可能与主对话抢线。

### 新增（运行预览：dev server 保活 · 2026-10-20）

**动机**：交付成果面补到"文件能看"之后，前端任务的最后一步仍是"自己开目录、自己起
server"。dev-server 冒烟此前只证明端口活着，随后就把进程杀了（验证道具）。本轮把它
在**验证通过后**交给桌面宿主保活，看板给一个预览入口。

**实现**：

- `DevServerKeepInfo`（`engine/dev-server.ts`）：验证器把 child 所有权交出去时的事实
  （title/url/command/args/cwd/已收集日志）。`runSmokeChecks` 只有在
  `verdict.ok && page.ok` 时才调用接管器；返回 `true` 才不 kill，否则按老路径杀掉。
  接管失败/抛错只写进 digest，**不改冒烟结论**。
- **打通 devServer 的来源**（此前是断链）：`parseDecompose` 现在解析 smoke 的可选
  `devServer`（url 必须是回环 http(s)、timeoutMs 必须是正数，且与 stdin/expectContains
  互斥），规划提示词也教了这条；验证器在 spawn/fetch 前**再挡一次**回环 —— 桌面端从
  `smokeJson` 直接 JSON.parse，绕过了 schema，这一层是 SSRF 的真正执行面。探活与页面
  冒烟的 fetch 都设 `redirect: "manual"` —— 跟随重定向会把请求带出回环。
- `PreviewManager`（`electron/preview-manager.ts`）：单实例（新预览先停旧的）、日志尾部
  16KiB、close/error 保留退出码现场、30 分钟 TTL（旧定时器用 entry 身份判定，防止误停
  后来者）、stop 杀进程树。桌面宿主通过 `setDevServerKeeper` 安装；headless 不安装，
  行为不变。
- IPC：`preview:status/open/stop`。`open` **不接收 URL 入参**，只打开管理器里那条已探活
  的服务，且仅限本机 `http(s)`；`app.before-quit` 清进程；`buildEngine` 在新一轮规划/
  执行前先停旧预览。
- 看板 `PreviewPanel`：URL/命令/pid/到期时间/日志尾部 + 打开/停止；进程退出后打开按钮
  禁用、保留退出码现场；刷新跟随 receipt 事件与项目切换。

**测试**：`src/preview-manager.test.ts` 9 条（接管/替换/TTL 不误停/退出/停止/日志截断）；
`src/dev-server.test.ts` 新增 4 条（接管不杀、拒绝/抛错仍杀、页面红不许接管）；
IPC 5 条（状态/URL 白名单/已退出/打开失败/stop 与 before-quit）；UI 4 条。

**变异账**：首轮 site 暴露 preview-manager 2 处（`state()` 的 exitCode/killed 组合、
exitCode 回填条件）、delivery IPC 5 处（URL 协议/hostname 白名单的 `||` 与
`return false`）；补"exitCode 已变但 close 未到""被信号杀 exitCode 为 null""https
loopback / localhost / [::1] / file: / 非法 URL"等断言后：preview-manager 12/12、
delivery IPC 27/27、verifier 31/31、orchestration IPC 10/10（100%）。同时校回了
orchestration.ts approval-decide 的等价位点行号（232 → 267）：旧行号已漂到
`enginesOf().values()` 那行，fail-safe 在本次 site 审计里按预期暴露。
位点 1948 → **1989**（83 目标，`site-baseline --write`）；用例 2319 → **2351**
（75 个有可执行用例的文件），README / gates.md 同步，`check:doc-claims` PASS。

**明确未做**：内嵌 webview/iframe（用系统浏览器，避免把任意页面塞进渲染进程）；
页面不轮询（预览卡在 receipt/切项目时刷新）；headless/serve 无保活；kill 是尽力而为，
极端残留靠 TTL / 下次替换收口。

### 新增（交付成果面：本次产物 + 怎么验收 · 2026-10-19）

**动机**：竞品缺口盘点 B1 的最后一米——能证明"跑过了"、能看"改了哪些文件"，
但"成果长什么样"仍要用户自己打开工作目录。Codex 类产品把 changed files / diff /
preview 放进同一个面；本轮先补可交付的最近一格：**产物清单 + 只读全文 + 验收命令**。

**实现分层**：

- `shared/delivery-guide.ts`：纯函数。运行边界 = 最后一条 `stage=PRD`；若最后
  一份凭据之后还有派发/批次改动（无 PRD 的续跑），以凭据为界只取之后的事实。
  批次改动按 `isPathInZone` 归到凭据任务；同一路径跨批只留最后一次 op/bytes；
  对不上任何任务 zone 的进 `unassigned`。命令 = 凭据里带 `command` 的检查
  （去重）+ `package.json` 的 `dev/start/preview/serve`（去重；坏 JSON 不抛）。
- `electron/ipc/delivery.ts`：`delivery:guide`（审计 + workspace/package.json 的 IO）
  与 `delivery:read`。只读读取两道 containment：字面 `path.relative` + `realpath`，
  防符号链接逃逸；512KiB 上限、二进制探测、删除/目录/越界都以数据返回，
  不抛异常（"本批删除"是正常形态）。
- 看板 `DeliveryPanel`：按任务分组、点开只读全文、命令一键复制；刷新信号是
  `receipt`（主进程先落审计再推事件）。空交付（有凭据、零改动）也出卡并说破。
- headless：`onVerdict` 累积 `scope.changes`，凭据存在时在 `done/error` 前发
  `acceptance`；serve 存进 `state.acceptance`，状态页与 `/state` 直接渲染。
  取消/崩溃不发（半截现场不冒充成果）。

**测试**：`src/delivery-guide.test.ts` 24 条（边界/过滤/归组/去重/命令/坏 JSON）；
IPC 8 条（含跨项目过滤、二进制、截断、越界、符号链接 POSIX）；UI 3 条；
serve 5 条；headless 端到端 1 条（`receipt → acceptance → done` 顺序）。

**变异账**：首轮 site 暴露 delivery-guide 2 处存活（非 PRD stage 的 `&&`、
bytes 存在性的 `!==`）与 delivery IPC 4 处（非字符串 projectId、realpath 的
`||`、两个三元）；分别用"非 PRD stage / Object.keys 断言 / 42 入参 /
跨项目审计记录 / 拆分 containment 判定"杀掉。复跑：delivery-guide 31/31、
delivery IPC 15/15、run-spec 33/33（新位点 3）、serve 73/73（新位点 5）、
protocol 120/120。位点 1894 → **1948**（82 目标，`site-baseline --write`）；
用例 2275 → **2319**（74 个有可执行用例的文件），README / gates.md 同步，
`check:doc-claims` PASS。

**明确未做（下一轮已补保活 + 系统浏览器入口）**：dev server 保活/内嵌预览（当时探活后
进程照旧被杀）；内嵌 webview 仍未做。产物读的是
工作区现状而非批次存档，因此本批删除的文件只标「已删除」；跨任务共享文件的
归组按任务顺序先到先得（zone 互斥下不会出现双归属）。

### 新增（变体竞争 + 门禁裁决（B4） · 2026-10-19）

竞品缺口 B4（`docs/2026-10-17-competitor-gap.md`）：cezar「同一任务 ×2/×3 比 diff」、
orca「N 份 diff 人挑」。我们的翻译：**把"人挑 diff"换成"门禁挑 diff"**——同一任务
多方案 → 门禁裁决 → 交付赢家。

**拍板口径（三项）**：① 顺序就地 + 变体存档、批末回放裁决（不得像赛马那样并发写
同一 zone）；② 裁决门禁 = verify 命令（首败即停，与终验同口径）+ 契约路径检查，
各算一门、契约当最后一门；③ 池里没有第二候选时退回同一执行器补齐（采样层面的
第二次机会）。

**实现**：

- 新 `electron/engine/variant-store.ts`：`VariantWindow`（SnapshotToken + JournalToken）
  / `VariantCapture`（zone 内净变更 + 前向镜像 + `replayable`）/ `VariantBackend`
  接口 + `VariantStore` 实现。`beginWindow` = zone 内全量备份 + 全根变更基线；
  `capture` = 按 zone 过滤净变更 + 变更后内容（读不出 ⇒ `replayable=false` 并留
  note）；`revert` = 无选择器整窗复位（还原 + 删新建）；`apply` = 前向镜像
  （`null` = 删除）；`finish` = 丢备份目录。
- `scheduler.ts`：`variantCount` / `variantStore` / `rateVariant` 三件套齐才开变体
  路径（否则与从前一字不差）；`runVariantGroup` 顺序派发（成员 = 首选 + 池内去重
  补齐 + 同执行器回填；silent 派发、逐条如实记 breaker 与限流账）；批末
  `adjudicateVariants` → `adjudicateOne`（sticky 降级分支，或"回放评级 → 排序 →
  赢家回放"），裁决在 `guard.settle` **之前**——批账与存档看到的是赢家落盘后的状态。
  收尾纪律用 `keep`/`applied` 两个指针表达：只有确定已复位的窗口才 `finish` 丢备份；
  镜像失败/回退失败的窗口留盘保现场（收尾统一走 `finishWindows` 的豁免名单）。
- `platform.ts`：`fileExistsProbe` 上提（引擎契约检查与评级契约门共用同一事实源）；
  `VariantStore` 复用 guard 的 `SnapshotStore` 实例（同一 backupRoot、同一批号空间，
  防同毫秒撞目录名）；评级器抽成导出工厂 `createVariantRater({commands, verify,
  fileExists})`。
- 设置链：`ProjectSettings.variantCount`（默认 1）+ schema + headless spec 字段
  （≥1、floor，错误文案说破"1 = 关闭 / >1 = 顺序多派 + 批末裁决"）。

**测试**：`src/variant-store.test.ts` 4 条（真文件系统：全生命周期、顺序窗口隔离、
finish 丢备份、先建后删净空）；scheduler 变体 describe 16 条 + `compareVariantRank`
1 条；platform 评级器/接线 9 条；schema / headless 协议镜像用例若干。全量 2275
通过（73 文件），此前 2240（72）。

**变异账（这轮的主要工作）**：首轮 site 审计暴露 scheduler 9 处 + platform 7 处
存活位点——scheduler 全在旧裁决的 continue 循环与 digest 的两个三元上（全局
`toContain` 抓不住"赢家 / 已回退"整体对调，需要行级断言），platform 全部落在
`createPlatform` 体内的内联评级闭包上（单测够不着）。杀法：① 重写裁决（删
`cleanupVariants`、删槽位 `reverted` 字段、消灭裁决路径全部 continue 分支）；
② 抽出 `createVariantRater` 直接单测（命令全过 / 首败 / 契约缺 / 无命令四格局）；
③ 补杀点用例（行级 digest 断言、两条取消路径、两槽位 sticky 的收尾豁免、无 note
与空 note、两个回退失败路径、第三候选显形 `>=` 边界）。复跑：scheduler 64/64、
platform 37/37、protocol 120/120（新位点 6 处）、schema 62/62、types 6/6，全 100%。
位点 1861 → **1894**（`site-baseline --write`）；用例 2240 → **2275**（73 文件），
README / gates.md 同步，`check:doc-claims` PASS。

### 修复（zone 越权写盘前拒绝 + 测试文件条件化 · 2026-10-18）

**背景（10-18 真演终止事故）**：真跑复验第一轮，`zone=src/core/csv` 的 CSV 任务
被仲裁判越权——执行器系统提示词无条件命令"测试文件放 `tests/*.test.js`"，模型
老实地在 zone 外落了 `tests/csv.test.js`。事故链：越权落盘 → 批后仲裁
`unauthorized-write` 回滚（digest："已回滚 0 个文件、删除 1 个新增文件"）→
`markBatchFailed` 整批翻红 → 重修三轮复读同一句错误 → 升级终止。同一提示词下
多个执行尝试犯同一错，说明根因在提示词与写盘通道，不在模型。

**修复（两半）**：

- `electron/agents/sensenova-api.ts` 的 `writeFiles` 增加写前闸：
  `!isPathInZone(f.path, zone)` 直接拒绝（不落盘），拒绝理由逐条回传并进终态
  点名。判据刻意复用引擎的 `isPathInZone`（`shared/glob.ts`），与仲裁、批次
  审计同源——不新造第二套路径语义。**刻意不用 `PathPolicy` 严格前缀**：计划官
  产出的 zone 常是文件前缀形（`src/core/csv` 对应交付 `src/core/csv.js`），
  严格前缀会把合法兄弟文件误拒；"前缀 + 同名兄弟文件容忍"才是全链路一致的语义。
- 系统提示词同批条件化：默认不再命令"测试放 tests/*"，只有 zone 覆盖 `tests/`
  或任务描述明确要求时才创建，其余路径以"会被沙箱拒绝且不落盘"告知（zone 纪律）。
- 调用点把 `payload.zone` 下传；`TaskPayload.zone` 本就是必填字段。

**验证**：`src/sensenova-api.test.ts` +3（zone 外写前拒 + `continue` 不退化；前缀
zone 兄弟文件不误拒；提示词条件化防回归），44/44 绿；变异位点账 40→41 全杀
（`SITE_BASELINE` 同批更新）。CI 6/6 绿（含 tier2 分片对 sensenova-api 的
41 位点 ubuntu 审计）。

### 修复（模型池：SenseNova 轮转表换血 · 2026-10-18）

真演当晚反复出现 `SENSENOVA_API_KEY#i 线路级失败（404）`——不是网络抖动，是
`SENSENOVA_MODELS` 第三位的 `deepseek-v4-pro` 已被端点下架：`GET /models`
不再返回它，直连 `chat/completions` 稳定 404 `model is not found`。死线路每被
轮转摸到一次就吃 30s 冷却，12 条线里有一条纯在空转。

替补用 1-token 探针实测定（`token.sensenova.cn`）：`kimi-k3` 200 可用（跨家族）、
`glm-5.2` / `sensenova-6.8-flash-lite` 200（在役）、`deepseek-v4.1-flash` 403
（"not available in the current token plan"）、`deepseek-flash` 429（限流，未证
可用）、`sensenova-u1.5-lite` 404（在册却调不到）。**取 `kimi-k3` 顶上**——12
条线路数不变、家族更杂。

改动：`SENSENOVA_MODELS` 第三位 `deepseek-v4-pro` → `kimi-k3`；登记表
`SENSENOVA_MODELS_EXTRA` 由 kimi-k3 转记 `deepseek-v4.1-flash`；`check-unwired`
豁免文案、`docs/ARCHITECTURE.md` 与 `src/llm-pool.test.ts` 的钉子（EXTRA 精确值
+ 不在轮转里）同步；12 路线断言（`failover.test.ts` / `platform.test.ts`）零
改动即过。**登记表机制不动**：它仍是"登记 ≠ 入池"（生产代码零消费者），
kimi-k3 是走 `SENSENOVA_MODELS`（正当入口）入的池，欠账 #17 描述的机制问题
不因此改变。本地验证：153 用例过、eslint 0、`check:unwired` PASS、四 tsconfig
类型全过、touched 变异审计 providers.ts 3/3 逐位点全杀。

### 门禁与维护（改变异基线必须同批核文档数字 · 2026-10-18）

位点基线 40→41 的那笔提交（`d685a48`）漏跑 `check:doc-claims`，README 与
gates.md 的四行数字（用例 2231→2234、位点 1860→1861）未同步，verify
ubuntu / windows 双平台同红一轮；补记（`0ad1925`）后转绿。**规则**：改变异
基线 = 同批核文档判据（`check:doc-claims` 对 `vitest list` 现收集数与
SITE_BASELINE 实物核——落笔数字必须等于命令输出）。

### 实测（真链路复证：5 轮真演，前 4 轮死因也写下 · 2026-10-18）

同一 PRD（csvstat CLI：parseCsv + columnStats + renderReport + cli.run + 三个
`tests/*.test.js` + 样例数据），loomy（http-bridge）+ sensenova-api 双执行器，
`scripts/run-multiagent-e2e.mjs --real`：

- **第 1 轮**：上述 zone 越权事故，人工终止（修复动机）。
- **第 2 轮**（45 分钟预算）：供应商配额风暴吃满预算遭硬杀（`headless exit: null`）。
  但**全程零越权、零回滚**（日志里 "revert" 字样只剩握手配置名）；契约路径检查
  准确逮住 t5 只写了 3 个测试文件中的 1 个 → 标记未完成进重修——引擎行为全部
  正确，死因纯是预算。
- **第 3 轮**（120 分钟）：风暴升级为全线路 `fetch failed`（含 amd-radeon 自部署
  线路）→ 规划调用抛错、`exit 1`；遗留快照人工核对过（`%TEMP%\ox-commander-snapshots\
  batch-mvdojglu-51228-5-t1_t5`：只有 `package.json` 与 `tests/cli.test.js` 的
  重修前备份，全在 zone 内，无越权残留，可等自动过期回收）。
- **第 4 轮**（120 分钟）：6 任务交付 5 个；parse-csv 四连败（loomy timeout
  600s×2、sensenova rate-limit 600s×2）→ 重修上限 3 轮耗尽 → **升级事件**
  （跳过该任务 / 更换智能体重派 / 终止项目）→ 非交互宿主安全终止——失败语义
  按设计走完，不是缺陷。
- **第 5 轮**（120 分钟）：**全绿**。规划先被校验器打回一次（见下"误报"）、
  重试后落地；批 1 三任务并行全成（loomy 当晚首次交付：csv.js 201s；stats
  388s；testdata 206s）；批 2 / 3 各 40s 级；批 4 的 t6（写 `tests/*.test.js`——
  第 1 轮病根场景）首战 600s rate-limit 败，**重修 238s 落地**；契约路径 8/8、
  终验 build/typecheck/test/smoke 全过（含独立样本冒烟）、`headless exit: 0`。
  证据：`logs/e2e-real-1018-2109.log`（workspace `ox-real-e2e-1018-2109`）。
- **规划校验器实证与一次误报**：第 5 轮规划首次产出被校验拦下——t5 描述里的
  `console.log/console.error` 被斜杠启发式**误当路径**（"不属于任何 zone"），
  规划携校验错误重试分解后自愈。拦得对（守卫真实存在且工作）、这次拦错了
  （代码串不是产物路径）——误报本身记债，守卫的"点名路径必须落在某个 zone"
  这条规则按预期生效。
- **天气备注**：当晚 SenseNova 配额风暴周期性发作（429 / 300s timeout / 404 /
  fetch failed 混合），短请求仍能穿过、长生成（规划、整文件实现）必须等窗口；
  探针实测 `deepseek-v4-pro` 已下架（`/models` 不再返回、直连 404
  `model is not found`）、`deepseek-v4.1-flash` 403（"not available in the
  current token plan"）、`deepseek-flash` 429（限流，未证可用）、
  `sensenova-u1.5-lite` 404（在册但调用 404）、**`kimi-k3` 200 可用**（跨家族，
  当晚已换入轮转表——见「修复（模型池）」条目）。

### 修复（模型池：kimi-k3 强制 temperature=1 · 2026-10-18）

换血后 kimi-k3 入池仅半小时，B2 实验（见下）worktree 侧首跑就炸出新型死线路：
t6 被 900s 上限硬杀，stderr 里 kimi-k3 复读
`HTTP 400: field Temperature invalid, only 1 is allowed for this model`。
1-token 探针钉死：kimi-k3 `temperature=0.2` → 400，`temperature=1` → 200
（对照 `glm-5.2` 0.2 → 200，不是端点整体行为）。**关键**：400 是请求级错误，
不在 `ROUTE_LEVEL_4XX` 冷却集合里——每个轮到 kimi-k3 的调用照样先发出、白吃
一个 400 再换线，长生成场景下把预算烧成假超时（t6 首跑死因之一）。

修复：`shared/providers.ts` 新增模型级覆盖表
`MODEL_TEMPERATURE_OVERRIDES = { "kimi-k3": 1 }` 与唯一解析点
`resolveTemperature(model, requested)`（**覆盖优先于调用方显式传值**）；
`shared/http-clients.ts` 的 OpenAiCompatibleClient 改为调用它——此前默认
`req.temperature ?? 0.2`、而 `sensenova-api.ts` 明确传 0.2，两处都会踩雷，现在
解析收敛到一处。规则沉淀：**"某模型只接受固定取值"这类事实落覆盖表，不散落到
调用方**。

验证：`src/llm-pool.test.ts` +4、`src/http-clients.test.ts` +2（含"显式传值也
服从覆盖"），用例 2234→2240（72 文件）、README / gates.md 同步；
`mutation-touched --base=HEAD~1` 逐位点全杀（http-clients 61/61、providers 3/3）。
提交 `9e51f81`。

### 实测（B2：zone 互斥 vs worktree 隔离对照 · 2026-10-18/19）

B2 排期兑现（`docs/2026-10-17-competitor-gap.md`）：同一 6 任务集（10-18 第 5
轮真演原样，zone 互不相交）在本项目与 worktrunk 各真跑一遍。**专档**：
`docs/2026-10-18-zone-vs-worktree-b2.md`（含全部数字、复现命令与限制节）；
汇总脚本 `scripts/b2-zone-vs-worktree-report.mjs`（产物直算，不手抄）。

方法要点：worktree 侧执行器（`scripts/b2-worktree-agent.mjs`）复用产品同一构件
（`SENSENOVA_MODELS` × `SENSENOVA_KEY_VARS`、同 failover 客户端、同 `chatJson` +
`parseFilePayload` 协议），但为**单发生成**且无写闸/快照/契约检查/修复环/验证
——两侧差异刻意限定在"路线 + 外围机制"，并在报告限制节逐条列明执行时代（池
换血前后）、天气（r4 遇配额风暴）、任务集无冲突场景三类不对称。

主要数字：zone 侧 6/6、任务时长合计 1118.6s、批序列 `[t1,t2,t5] [t3] [t4] [t6]`
全依赖驱动（zone 冲突切刀 0 次）、t6 attempts=2（600s 限流败 → 重修 238s 收敛）、
终验全绿。worktree 侧创建 0.7s × 6、6 全并行首跑 5/6（t1 714s / t2 343s /
t3 328s / t4 132s / t5 4.6s；t6 被 900s 上限杀）、合并 3.3s × 5 冲突 0 自动清理、
**t6 人工重修 3 轮（重派 1 + 喂 digest 2；218s / 188s / 1260s）终态 tests/ 3 文件全红——
人工 3 轮未收敛**。结论只立"各自代价项清单"：zone 代价=批串行与机制复杂度、
worktree 代价（本轮观感）=验证与重修环缺失时全落在人身上；**不下"快 X%"结论**。

副产品：kimi-k3 temperature 死线路（见上条）、以及 worktree 侧执行器提示词里
"基线只有骨架"的过时文案（t6 晚跑、仓库已有全部文件——如实记在报告限制节）。

---

## [0.1.9] — 2026-10-18（v0.1.8 之后：2026-10-08 晚 → 10-18）

### 新增（页面冒烟：探活之外再看一眼首页正文 · 2026-10-18）

竞品缺口 C3「浏览器预览 / 端口」。此前 dev server 探活只看 **HTTP 状态码**，
2xx/3xx 即通过 —— "端口活着、路由可达"钉住了，**"页面有没有内容"没有**。
前端任务的验证闭环缺这一环：**跑起来 ≠ 页面没白屏**。

- **能做的**：HTTP 正文是现成的，明确的错误页在正文里有稳定标记 ——
  `Cannot GET`（webpack-dev-server / http-server）、`Internal Server Error`
  （Vite 编译错误 overlay / Express 默认错误页）、`Failed to compile`（CRA）、
  `This page could not be found` / `Runtime Error`（Next.js 404 与运行时）。
  这些能**证伪**。
- **不能做的**（边界写在 `shared/page-smoke.ts` 顶部）：**不做 DOM 渲染**。
  JS 崩在运行时、或 SPA 壳里什么都没渲染出来，HTTP 正文看不见 ——
  `index.html` 永远是那个壳。要断言它得上无头浏览器（几十 MB 依赖 +
  一个进程模型），**不进验证链**，与 `dev-server.ts` 里"不做页面截图 / DOM 断言"
  是同一条决定。
- **口径**：**只判红明确错误页**；空壳（SPA）**不判红**，但把"没法确认、
  需真浏览器"写进 digest；非 HTML 端点（`application/json`）判 `not-html`
  且不判红 —— 白屏判据对它不适用。**宁可放过，不误报**：一条误报的门禁会把
  好交付挡在门外，那比漏判更贵。
- **取不到正文 = 没看见**（`pageSmokeFor` 返回 `null`）：假 fetch / 断流 /
  读不出正文时不判红，也**不编一条"页面正常"**。
- **接线**：只在探活**成功**后才取正文（`verdict.ok ? … : null`）—— 探活都死了
  再去判页面没有意义；结果 `ok = verdict.ok && (page?.ok ?? true)`，
  digest 多一行 `[page] …`。

**site 审计抓出的两处**（都在 `pageSmokeFor` 的 headers 那一支）：把
`typeof res.headers?.get === "function"` 反过来、或互换三元分支，在"假件都带
headers 且 body 是 HTML"的用例下**没有任何可见差别** —— 真走到这一支要两种
输入：① Content-Type 真的影响判定（JSON 里带 `Cannot GET` 字样 ⇒
`not-html` 不红，而漏掉 Content-Type 会被当成错误页误红）；② 响应**没有**
headers（此时取 Content-Type 会抛、被 catch 吞成 `null`，等于把一次真实判定
改写成"没看见"）。两条用例补上后 30/30 全杀。

- 测试 14 条（判据 7 + 取正文那一层 5 + dev-server 真子进程真 HTTP 的
  2 条集成）；`shared/page-smoke.ts` site **5/5 全杀**、`electron/engine/verifier.ts`
  site **30/30 全杀**。位点 1848 → **1860**（目标 79 → **80**）；
  用例 2217 → **2231**（72 个文件）。`check:doc-claims` PASS。

### 新增（执行器自动探测：扫 PATH 出候选 + 一键接入 · 2026-10-17）

竞品缺口 C6，缺口文档里标的是"接入摩擦最大项"—— 以前接入外部执行器的
第一步是**手写 JSON manifest**，而项目自己 ship 的 `agents.d/*.example.json`
里已经躺着一份份带实测参数的模板。

- **扫 PATH 出候选**（`shared/cli-detect.ts` + `electron/agents/cli-detect.ts`）：
  Claude Code / Codex / Aider / Gemini CLI / Goose 五个候选，遍历 PATH 各目录
  找命令（Windows 额外试 `.cmd`/`.bat`/`.exe`，那是 npm 全局装出来的 shim 形态）。
  **不 spawn**：探测只是"PATH 里有没有这个文件"，跑 `<cmd> --version` 既慢又
  会把用户的 CLI 在不知情时被叫起来一次（有的首次运行会触发登录流）。
- **一键接入**：扫到的候选带一份**可直接注册**的 manifest（逐字取自
  `agents.d/*.example.json`；codex 那份复用 `exampleManifest()`，与界面
  "填入示例"同一事实源），点击即走 `agents:register` —— 落盘/覆盖/重启仍在
  与手写 JSON 完全一致，不是另开一条侧道。
- **没装的说怎么装**：安装命令 2026-10-17 逐条核实于官方文档 / npm 包页
  （`@anthropic-ai/claude-code`、`@openai/codex`、`aider-chat`、
  `@google/gemini-cli`）。**Goose 那一条没核实就不给命令** —— 一句装不上的
  安装命令比没有提示更糟。
- **没扫到的不给"接入"按钮**：派发与扫描用的是同一个 PATH，扫不到 = 接进来
  也必红；那种按钮是必然失败的邀请（与 B1 第二半同一条纪律）。
- **候选表与 `agents.d/*.example.json` 同源**：有一条守卫测试逐条比对
  `command` 与 `argsTemplate`（codex 除外，它的事实源是 `exampleManifest()`，
  只比 command）。参数写错的代价是"配好了但永远跑不起来"（2026-09-20 的
  codex `--prompt-file` 教训），这层防的就是它。
- **site 审计抓出的三处**（两处按纪律简化源码，一处补测试）：
  ① `splitPathEnv` 原先靠"字符串里有没有分号"**猜平台**，Windows 的
  `C:\bin` 会被切成 `C` + `\bin` ⇒ 什么都扫不到；改成平台由调用方传入。
  ② 路径拼接的"目录尾部是否已有分隔符"判断两支等价（两岸 fs 都吸收多余
  分隔符）⇒ 简化成正斜杠直拼。③ `existsSync` 外层 try/catch 是死分支
  （它的契约就是异常折成 false）⇒ 删掉。
- 测试 23 条（纯函数 / 模板守卫 / IPC / UI 各一层）；两个新目标 site
  **9/9 全杀**。位点 1839 → **1848**（目标 77 → **79**）；用例 2194 → **2217**
  （71 个文件）。`check:doc-claims` PASS。

### 新增（项目约定注入：项目根的 OX.md / AGENTS.md 自动进规划与执行 · 2026-10-17）

竞品缺口 B3「项目级约定注入（记忆）」。此前的跨 run 持久化只有 agent 成功率
总账 —— 每次 run 都从零推项目约定（技术栈偏好、目录纪律、禁改文件），而"推"
这件事既烧 token 又不稳定：同一句约定换个措辞，规划出来的任务边界就变了。

- **读什么**：项目根的 `OX.md` 与 `AGENTS.md`（按此顺序拼接）。单文件上限
  **256KB**（超了跳过并报字节数 —— 不把几百 MB 的笔记塞进提示）。
- **进哪两处**：
  - **规划**：`generatePrd(requirement, projectRoot)` 的 PRD 提示，约定块在
    `User requirement:` **之前**（先给项目背景，再读需求）。两个生产调用点
    （桌面 `orchestration:planning`、headless `run-spec`）都传项目根。
  - **执行**：每个任务的派发描述，顺序是 **任务描述 → 约定 → 平台契约 →
    操作者附言**。约定块自己声明"不覆盖契约"；附言仍在最后（run 级最新纠偏）。
- **缺席是常态、不是错误**：没有这两个文件的项目占多数 —— 空块不产段
  （空标题纯噪声），提示与历史逐字同形。读不动的文件（同名目录、权限）
  只进日志不抛；"这次注入了哪些约定、多少字符"写一行日志，因为
  "以为带进去了、其实没有"是这层最坏的失败形态（缺了就是缺了，模型不报警）。
- **超限必须说破**：总注入上限 **8000 字符**，截断时写明"约定原文共 N 字符、
  上限 M，后面的没进上下文"。
- **一个真缺陷被 site 审计抓住**：`buildPrdPrompt` 的第三参是可选参数，
  原写法用真值判定 `conventionsBlock && conventionsBlock !== ""` —— 换成
  `||` 的变异在 `undefined` 时会把**字面量 "undefined" 拼进提示**（真值判定
  把它当"有内容"）。改成先 `?? ""` 归一化再判空，并加断言钉住。
- **测试 25 条**：纯函数（空块/多文件顺序/截断说破/恰好在上限内）、读盘
  （只收存在的、缺一个不拦后面、超限跳过不拦后面、同名目录进 unreadable）、
  scheduler 三段顺序、orchestrator 提示位置与三段日志。site 逐位点审计：
  **5 个改动目标 139/139 全杀**（project-conventions 2 · conventions 2 ·
  prompts 6 · scheduler 46 · orchestrator 83）。
- 位点 1831 → **1839**（目标 75 → **77**）；用例 2176 → **2194**（70 个文件）。
  `check:doc-claims` PASS。

### 新增（逐行 diff + 单文件回滚：批次备份从"跑完即删"改成"存档" · 2026-10-17）

竞品缺口 B1 的**第二半**（第一半是 10-17 早些时候的「改动文件」面板）。
前一半回答了"这轮改了哪些文件"，这一半回答"**改了什么、能不能只撤这一个**"。

诚实的起点：旧设计里批次成功后快照立即 `commit` 回收 —— 于是逐行 diff 没有
before 数据源，单文件回滚没有备份，这也是第一半刻意"只有事实没有按钮"的原因。
本批改的是数据源本身：

- **批次存档**（`SnapshotStore.archive`）：成功的每一批把备份从
  `<backupRoot>/<runId>/` **移动**到 `<backupRoot>/archive/<batchId>/`
  （带 `meta.json`：runId / ts / rootAbs / zones / 备份文件清单）。
  容量策略 `pruneArchives` 只保留最近 **8 批**（按 ts，同毫秒用 id 尾部序号），
  删除发生在每次 archive 之后 —— 磁盘上限是可预期的，不是"只增不减"。
  纯新建批（没有 before 内容）不占存档位，空目录直接清掉。
- **存档失败的回退**：`rename` 跨设备（EXDEV）等失败时回退 `commit` 回收并在
  事件里说一声 —— 静默丢备份会让审计里的 `archiveId` 指向不存在的存档，那比
  没有存档更糟。
- **`archiveId` 进审计**（`batch-changes` 新字段）：`BatchScope.archiveId` 由
  `finishBatch` 写入，宿主落盘。没有存档时这个键**不出现**（字段即承诺）。
- **IPC 两个新通道**：`changes:file`（逐行 diff：存档 before × 盘上 after，
  返回 `diffText` 的结构化结果）与 `changes:revert`（单文件回滚）。
  请求形状与路径两道校验：IPC 层拒绝绝对路径与 `..`（**拒绝而不是洗白**），
  SnapshotStore 层再按"原始输入判绝对、分割后判 `..`、resolve 前缀双保险"
  三道拦；三道防护的 reason 措辞各自可区分（否则第二道会替第一道兜住，
  变异测试就杀不掉第一道 —— 这是本批 site 审计抓出来的真教训）。
- **删除分支的证据纪律**：本批新建的文件没有备份，撤销新建 = 删除盘上文件，
  而删除许可**只认**审计里该批同路径 `op === "create"`；审计里没有这条记录
  （被轮转/被截断 100 条上限/根本没有该批）时一律拒绝并说破 —— 与
  `SnapshotStore.revert` 的老纪律同源：宁可留一个脏文件，不删错一个既有文件。
- **逐行 diff 判据**（`shared/text-diff.ts`，纯函数）：LCS 行级 diff，
  先剥公共前后缀再对中间段 DP（`Uint32Array` 表）；大文件超 2000 行给
  `too-large`、含 NUL 给 `binary`，两者 `added`/`deleted` 是 **`null` 不是 0**
  （拿不出这个数时报 0 等于显示"无变化"的反话）；增删行带 `+`/`-` 与两侧
  行号（不只靠颜色）。
- **界面**：改动文件行在有 `archiveId` 时出现「diff」「回滚」；回滚过
  `window.confirm` 二次确认（写明"直接改工作区、不走 git、恢复的是本批旧内容"），
  成功/被拒都把结果摆出来并重新取数；没有存档的批次不显示按钮，卡片底部
  说清三种缺席（未配置快照存储 / 存档失败 / 纯新建批）与 8 批上限。
- **测试 55 条**（含 19 条 diff 判据、12 条 IPC、4 条 UI）；site 逐位点审计：
  四个改动目标 **137/137 全杀**（text-diff 38 · snapshot-store 31 ·
  ipc/agents 42 · ipc/context 26），过程中抓出并修掉 6 处真断言缺口
  （单侧 binary / 单侧超限 / created-deleted 行数为零、`hasBackupFor`
  三态、审计扫描的 `continue`、末尾 `return false`）。
  一处进 `EQUIVALENT_SITES`：`archivedFilePath` 的 `|| → &&`（后续 resolve
  前缀检查使两者返回同一个 `null`，逐输入核过，附论证）。
- **代价与已知边界**：① 磁盘 —— 存档含 zone 内文件副本（可能含 `.env` 一类
  敏感文件），与回滚窗口期同样落在 `userData` 下，靠 8 批上限约束；
  ② 回滚不跨批次：后续批次又改过同一文件时，恢复的是**这一批**的旧内容；
  ③ 存档只对本进程写出的 `meta.json` 可枚举，被外部改坏的目录会被跳过。
- 位点 1752 → **1831**（目标 74 → **75**，text-diff 入册）；用例 2121 → **2176**
  （69 个文件）。`check:doc-claims` PASS。

### 新增（贡献入口 + macOS CLI 通路证明 · 2026-10-17）

竞品缺口盘点第五轮（`docs/2026-10-17-competitor-gap.md`）A 类的前两项。
A 类的判断是「卡脖子——决定有没有人能装上、看得懂、留下来」，
本批补其中最便宜、且不需要动架构的两格：

- **CONTRIBUTING.md**（A5）：一份写给人的贡献指南，核心是把这个仓库的
  门禁文化讲清楚 —— 唯一验收入口 `npm run verify`（33 段）、新测试放
  `src/*.test.ts(x)`、新导出必须有生产调用者、新变异目标手工登记
  （漏挂的文件不参与变异统计，那个 PASS 对它没有含义）、动 verify 链
  四处文档同步、注释里不留裸算子字面量。**不复制门禁数字** ——
  那些数由 `check:doc-claims` 对实物核，复制一份就是第二处会腐烂的地方。
- **issue / PR 模板**：`bug-report.yml`（要求带 OS/Node/入口/复现步骤，
  门禁相关的必须写**哪一段红 + 退出码** —— 本项目 33 段失败语义各不相同，
  "verify 挂了"无法归因）与 `feature-request.yml`（先写"没有它时的代价"，
  并提醒先看缺口盘点里的「明确不补」表）；PR 模板是一份门禁自查清单。
  `config.yml` 关掉空白 issue，只留联系链接（指向 SKILL.md）。
- **macOS CLI 通路证明**（A4 的落地形态）：桌面端 macOS 产物**仍然不出** ——
  electron-builder.yml 顶部有完整论证（无签名凭据，未签名 .app 被 Gatekeeper
  拦下，出"用户打不开"的产物比不出更糟），这是刻意决策不是遗漏。
  但缺口盘点的结论是「桌面端缺口可以认，CLI 缺口不该认」，而
  `npx oxcommander`（纯 Node 包）此前从没在 mac 上验证过。
  新增 `cli-macos` CI job（只在 macos-latest）：`build:headless` +
  `build:cli` + `smoke:cli-pkg` + `smoke:demo`，零凭据零网络零固定端口。
  它证明的是分发通路本身，与 ubuntu/windows 的 verify 两格互补不重复。
- **文档同步**：README / README.en.md 加 PRs welcome 徽章、平台表 macOS 行
  改为「无桌面端安装包但 CLI 可用（CI 有 macOS job 盯着）」、文档索引加
  CONTRIBUTING 行；gates.md 的 CI 节与 SKILL.md 的平台分支节同步新 job。
- **门禁数字无变化**：未动 `verify` 串（段数仍 33）、未动测试与变异目标
  （位点 1752 / 用例 2121 不变），`check:doc-claims` 口径不变。

### 新增（任务附言：运行中给任务带一句话，下一次派发生效 · 2026-10-17）

竞品缺口 C2「运行中追加指令/接管」。诚实的边界先写：本项目执行器全是
一问一答形态（本地 LLM 池 / CLI / HTTP 桥），**没有"往在途生成里插话"的
通道** —— 所以附言到达的是**下一次派发**，界面文案与文档都按这个口径写，
不暗示"已实时送达"。最值钱的时刻是升级裁决：run 卡着等人时，"带话重派"
比干巴巴的 redispatch 强得多。

- **数据流**：`orchestration:task-note` IPC → 引擎 `operatorNotes` Map →
  派发前 `pendingWithNotes()` 拷进 Task **副本**（计划原件是 PRD 级输入，
  附言是 run 级，副本机制保证不互相污染）→ scheduler 把附言块拼进
  description，**恒在平台契约条款块下方**（附言块自己也声明不覆盖契约）。
- **生命周期**：任务成功后引擎自动退休附言并广播空串（旧指示不重复带进
  后续轮）；全空白 = 立即清除；对不上任何任务的附言被容纳但不抵达任何
  派发（UI 的任务清单即过滤器，引擎不重复建白名单）。
- **界面**：每个任务行「✏️ 附言」折叠编辑器 + 升级卡「带话重派」入口；
  保存/清除/退休都有 `task-note` 事件回声（人写的东西要即时确认生效）。
- **只对在跑的 run 有效**：没有 run 时主进程明确抛错 —— 落盘会 invent 一个
  跨 run 语义，而那正是 PRD 评审页的职责（运行前的 steering 归它）。
- **测试** 23 条：IPC 3（无 run 拒绝/透传含空串/坏形状拒）、引擎 5
  （副本注入/重修轮仍带/退休回声/空白清除/ghost 容纳）、scheduler 2
  （顺序即语义/无附言不产块）、prompts 2、store 3（合并/空串消键/终态可收）、
  UI 1（保存过桥 + 升级卡入口）、通道清单 +1。
- **踩坑记录**：附言折叠块起初复用 `.trail-details` 类名，把一条按
  「第 N 个折叠块」选元素的既有测试（openTrail(container, 1)）从
  "第二个任务的履历"变成"第一个任务的附言"—— 两类折叠块必须用不同类名，
  按序数选元素的测试随插入顺序漂移。已改 `task-note-details` 并补样式。
- **site 审计抓到的第二个真缺陷**：`orchestration:task-note` 的
  `return true → false` 稳定存活 —— 测试断言了"引擎被调用"，没断言
  handler 的返回值，调用发生了、返回值错了没人管。补返回值断言后 11/11 全杀。

### 新增（改动文件面板：批次改动首次有持久事实 + 看板出口 · 2026-10-17）

竞品缺口 B1「diff 面板」的第一半。完整 diff viewer（逐行 before/after）没做 ——
批次成功后快照即 commit 回收，此刻没有可靠的逐行对比数据源；本批先把
**「这轮到底改了哪些文件」**这条最基础的答案从"翻审计日志"变成看板上一块面板：

- **数据源**：`onVerdict` 的第二个参数（`BatchScope.changes`）此前被两个宿主
  全部丢弃 —— 它带着每批完整改动清单（含 clean 批），而 `batch-guard` phase
  只记越权路径。现在每批一条 `batch-changes` 审计（新 phase，不污染
  `zone-cost` 对 batch-guard 记录的越权统计），files 上限 100 + `filesTotal` 说破截断。
- **口径**：scope 缺席（无 guard 的装配 / 测试直调宿主回调）**不落记录** ——
  编一条 "0 个文件"比什么都不写更假。
- **界面**：`changes:list` IPC + 看板「改动文件」卡（按批次折叠、op 图标、
  截断提示）。**刻意没有回滚按钮**：备份已回收，放一个必然失败的按钮
  等于邀请人按它；边界写在卡片底部。
- **门禁**：5 条新测试（过滤/倒序/落审计/截断/无 scope 不编记录）；
  site 逐位点审计 6 个改动生产文件全 100% 全杀（含一个被 `site-baseline --write`
  前暴露的真问题：`changes:list` 里 `typeof x === "string" && x !== ""` 的
  `&& → ||` 存活 —— 换 `||` 后无参调用会把"无 projectId 的记录"当成"本项目的"，
  而当时的用例恰好全部无 projectId，两分支同结果。拆成两步判后两支各有断言盯着）。
  白名单锚点 `context.ts` 因本批插行漂移 212 → 221，按纪律校回。
- 位点 1723 → **1738**；用例 2090 → **2105**；`check:doc-claims` 同步 PASS。

### 新增（桌面通知：run 出结论 / 待决策 / 待审批时系统级提醒 · 2026-10-17）

竞品缺口 C1。serve 解决了"能看"，没解决"该看了"——长 run 后台跑、窗口被切走时，
操作者唯一还能收到的信号。判据是纯函数 `electron/notify-rules.ts`（可逐点审计），
弹窗本身只是 `send()` 里一行 `new Notification(...).show()`：

- **只弹三类**（判据保守是刻意的：通知的价值与频率成反比）：
  receipt（交付与未交付都弹 —— 没交付更要回来）/ escalation（三选一没人答就挂住）/
  approval-request（fail-closed，问不到人就不执行）。
  日志、任务进度、批次完成、线路健康**一律不弹**。
- `Notification.isSupported()` 为 false 时安静降级不抛；正文截断到 120 字符。
- 测试 10 条（判据 8 + 集成 2：receipt 真走一次 show、log 不弹）；
  site 8/8 全杀；目标 73 → **74**、位点 1738（含本轮新增 8 处）。
- **已知边界**：headless/serve 宿主没有通知通道（无 GUI），只有桌面端有。

### 新增（分发面三件套：npx CLI 包 / 英文 README / 首屏 demo GIF · 2026-10-17）

竞品缺口盘点（`docs/2026-10-17-competitor-gap.md`）的结论：技术差距在缩小，**分发差距在拉大**——
判据有 1723 处逐点验证，却没有任何一条路径让陌生人在 3 分钟内摸到它。本批补最便宜的三格，零架构改动：

- **CLI 分发包**（`npx oxcommander` 那一格）：`scripts/build-cli-pkg.mjs` 从 `dist-headless/` 产出
  `dist-cli/`（git 忽略）——只有 `bin/ox.js` + 不带 sourceMap 的 `dist-headless/` + 一份英文 README，
  不含 Electron / devDependencies。`bin` 提供 `ox`（run）/ `ox serve` / `ox mcp` / `ox receipt` 四个子命令，
  只做「找入口 + 转发」，退出码原样透传。验收是新增的 `smoke:cli-pkg`（verify 第 33 段，19 断言）：
  **非空转**两条——非法 spec 必须拿到协议层的 `error` 事件（CLI 自己编一条错也算 exit 1，所以认事件类型）、
  `receipt` 子命令必须拿到复核工具的报错而不是 run 的报错（证明子命令没被当成 run 转发）。
  段数 32 → 33，四处清单（README / gates.md / SKILL.md / 本文件）同批同步，`check:doc-claims` PASS。
- **英文 README**（`README.en.md`）：定位段 + `npx` 快速开始 + 差异表 + 两处诚实短板（无 macOS 签名、
  无终端 IDE 形态）。中文版顶部加语言切换。刻意**不复制段数/用例数**——那些数字由
  `check:doc-claims` 在中文版对实物核，英文版复制一份就是第二处会腐烂的地方，只链接不重复。
- **首屏 demo GIF**（`docs/demo.gif`，980×598 · 62 帧 · ~2MB）：素材是 `npm run demo` 的 stdout **原文**
  （不是手写剧本），由 `scripts/make-demo-gif.py`（Pillow，仅本脚本用，不进项目依赖）渲染成滚动
  终端动画——渲染而非录屏，是因为录屏不可复现而「stdout 原文 + 渲染脚本」在换机器后重跑两条命令即可再生。
  中英 README 首屏都挂上。

### 新增（`check:test-side-effects` —— 让顶层副作用躲不过门禁 · 2026-10-17）

上一条修的是**已经漏出来的** 18352 个目录；这一条修的是**为什么会漏而没人发现**：
副作用发生在断言之外，`Tests N passed` 里看不见它，只有 %TEMP% 一直膨胀。补一道
**不跑用例就能看见它**的静态检查（`verify` 第 32 段），判据两条，都 FAIL：

- **A** 顶层建目录/写文件，而全文件**没有任何** `rmSync` —— 每次导入泄漏一份
  （`vitest list` 只导入不执行，`afterAll` 不会被调度）。
- **B** 顶层有副作用，而文件带 `skipIf` / `skip` 门控 —— 门控跳过时 `afterAll` 不调度，
  清理不发生、副作用照常发生（就是 `sandbox-llm-call.smoke.test.ts` 那一档）。

刻意**不禁止**「顶层建 + `afterAll` 清」这个既有写法：`cli-agent` / `cli-agent-env` /
`sandbox-path` / `mutation-residue` 四处走的就是它，残留实测已归零。判据为难的是
**必漏**的两种形态，不是所有顶层副作用 —— 否则它会逼人把四处正在工作的测试改一遍。

- 验收：自检 6 例全过（含「注释里的调用不算」「缩进的调用不算」两个反向样本）；
  把 `sandbox-llm-call.smoke.test.ts` **退回修复前的版本**做反向注入，本段**红**
  （exit 2），修好的版本绿 —— 判据不是摆设，它认得出这一档退化。
- 段数 31 → 32，README / `references/gates.md` / `SKILL.md` 三处声明同步，
  `check:doc-claims` PASS。

⚠️ **已知边界**：`cli-agent.test.ts` 至今仍每次漏一个非空目录（`EBUSY ... rmdir`，
锁的是**目录本身**，12s 重试窗口也没用，手动删却立刻成功）。本段**抓不到它** ——
它有 `rmSync`、无门控，两条判据都不命中。**别把本段 PASS 读成「临时目录没有泄漏」**，
它只证明没有那两种必漏形态。

### 修复（测试临时目录不再永久泄漏 %TEMP% —— 单次收集 0 残留 · 2026-10-17）

5 个测试文件在**模块顶层** `fs.mkdtempSync` 建目录，清盘写在 `afterAll` 里 —— 于是
「建」总是发生，「清」却不一定。本机 %TEMP% 累计 **18352 个 `ox-*` 目录**
（15876 个为空）：这不是磁盘问题，是判据之外的**静默副作用**：全绿的测试报告里
看不到它，只有 %TEMP% 会一直膨胀。

最坏的一处是 `src/sandbox-llm-call.smoke.test.ts`：它的 3 条用例整体挂在
`skipIf(!enabled)` 下，**默认跑 0 条断言**，`afterAll` 根本不会被调度；但顶层建目录
**每次 `vitest list` 都执行**（list 只导入不执行用例）。一个从不执行任何断言的文件，
唯一的贡献是每次收集制造一个永久垃圾目录 —— 实测 499 个 `ox-sbx-llm-*`。

其余 4 处（`cli-agent` / `cli-agent-env` / `sandbox-path` / `mutation-residue`）的清盘
重试窗口只有 0.25–0.5s：win32 上子进程句柄未释放时 `rmSync` 抛 EBUSY，被 `catch`
静默吞掉，目录就此留下（`ox-cli-prompts` 1441 / `ox-policy` 266 / `ox-env-e2e` 266 /
`ox-residue-root` 55）。

- `sandbox-llm-call.smoke.test.ts`：临时目录改**惰性**建立（`ensureProbeDir()`），
  只在确认真要跑时建；非 enabled 时 `afterAll` 直接返回。修复后连跑 `vitest list`，
  %TEMP% 增量 **0**（原每次 +1）。
- 其余 4 处：重试窗口放大到 25×150ms ≈ 3.75s —— `mutation-residue` 的 `afterAll`
  原先**完全无重试**。清盘失败仍不让用例变红：判据已经跑完，清盘是卫生问题，
  不是结论问题。
- 验收：typecheck / eslint 全绿；`npm test` 2090 passed | 8 skipped（与改动前逐条一致）；
  `check:tests-collected` PASS；`check:mutation-targets` PASS（0 个生产文件改动）。

### 修复（变异分片是"超集"不是"分区" —— CI 重复跑 · 2026-10-16）

`--tier=N` 的实现是 `t.tier <= maxTier`（缺省 99＝全部），而脚本头注释与工作手册写的
是「`--tier=1` # 只跑 tier 1」（精确语义）——**实现与声明不符**。后果落在 CI：
`mutation (site, tier 2)` 那条 job 实际跑**全部 73 个目标**（含 33 个 tier 1），
与 tier 1 那条不是"分区"而是"超集"。run #153 的 tier1 23.4 min / tier2 54.8 min 里，
tier 2 有约 23 min 是重复跑 tier 1 —— 而它已经压过 runner ~35 min 被回收的窗口。

- `--tier=N` 改**精确**匹配（不传 ＝ 全部目标）；`--tier=99` 这类"旧默认"现在会明确
  exit 2 而不是被读成"全部"；内部 worker 也不再透传默认值（只透传显式给的 tier）。
- 新增 `--shard=i/n`：把（已按 `--tier` / `--file` 过滤后的）目标**轮转**均摊成 n 片，
  只跑第 i 片。越界参数 exit 2；**空分片也 exit 2，而不是空跑 PASS** —— 空跑的绿会
  被读成"这个分片全过"，而它一个位点都没验。分片由工具自己算，各片之并恒为全集；
  刻意不写死目标清单：写死清单漏一个目标 ＝ 那个目标永远不被审计，而它的 job 照样绿
  （本仓库反复踩过的「PASS 对它没有任何含义」）。
- CI `mutation-full` 从 `tier: [1, 2]` 两片改为 `include` 三分片：tier 1 单片 + tier 2 两片。
- 口径核对（本机 `--list` 实测）：tier 1 = 33 目标 / 737 位点，tier 2 = 40 / 980，
  `tier1 ∪ tier2 = 73`（＝全集）；tier 2 两片各 20 目标且 `∪ = 40`；全量三片 `∪ = 73`。
- 验收：`npm run verify` 全绿（31 段）。

### 文档（CI 分片时长实测回填 · 2026-10-16）

上一条的"分片"修完后首轮 CI 实测 @ `80946b0` run #38922557558 **五 job 全绿**：
`verify` ubuntu 3.4 min / windows 4.8 min、`mutation` tier 1 **17.6 min** / tier 2 两片
**12.7 + 13.7 min**。最长 job 从修前的 54.8 min 降到 17.6 min，重新落回 runner ~35 min
的回收窗口之内。README 与 `verify.yml` 注释里的"预期"已换成实测值 —— 这条的价值不在数字
本身（它落笔即过时），而在**分片终于真的是分区**：此前那条 job 的覆盖里含一段"重复跑
tier 1"的空转，现在 `tier1 ∪ tier2 = 全集` 且各片各自收敛。

### 修复（变异在跑时算基线 —— 假漂移会诱导人污染基线 · 2026-10-16）

本机在 tier 2 全量跑的途中跑 `check:doc-claims`，它内部的 `site-baseline.mjs --json`
读到**变异中的源码**，报「SITE_BASELINE 已漂移 1 处」。那 1 处是假象，但真正的害处在
下一步：该脚本的处置提示明写「跑完 audit 后 `--write`」—— 人照做，就把变异体的位点
当真值写进基线。**基线从此被污染，而且污染得很安静**：下一次比对会拿这个假数当基准。

- `site-baseline.mjs` 现在**拒绝算**而不是警告：`.mutation-pending` 里有 `.orig`
  （= 变异体正在生效）⇒ exit 2，`--write` 一并拒。判据按 `.orig` 认，不按"目录存在"
  认 —— 已还原干净、只剩 `.json` 台账的目录不能算变异在跑，否则基线永远算不出来。
- `check-doc-claims.mjs` 解析 `site-baseline --json` 失败时带上 **stderr**：原来只报
  `exit=2，输出 ""`，人读到的是"规模算坏了"，真因（并发）被吞掉。
- 承重测试 7 条进既有 `--selftest` 通道（不新增段，省掉四处段数同步）：用注入 fs 假件，
  不真造 `.mutation-pending` —— 那是仓库级全局路径，造假 `.orig` 会让另一轮正在跑的
  变异以为自己有残留要还原。退化成「目录存在就算」⇒ 已还原那格红；退化成「有文件就算」
  ⇒ 混杂那格红，两头都钉得住。

### 文档（CI 数字三处失真 · 2026-10-16）

README 里"全量 site 审计"那段靠人手同步，已经漂了：

- 「各约 20-25 分钟」→ run #153 实测 **tier 1 23.4 min / tier 2 54.8 min**，差一倍以上。
- 锚点 `c67d920` 落后 HEAD **32 个提交**（那是分片前最后一次记录，43 min）→ 改为 `94a7a59`。
- 「site 口径 60 min 上限」→ workflow 实际 `timeout-minutes: 100`。

同一轮在 `.github/workflows/verify.yml` 注释里回填实测：**分片注释③当初要躲的是
「runner ~35 min 被平台回收」，而 tier 2 单片现在就 54.8 min，已超那个窗口**
（这轮侥幸没被回收）—— ③只解决了"整轮"，没解决"tier 2 本身"。下一刀按目标名再均摊
（需要 `--file` 支持多值，现在 `args.find` 只取第一个），不是继续抬超时。

### 修复 + 新增门禁（WorkBuddy 桥进门禁：判定口径 + 真进程端到端 · 2026-10-15）

`scripts/workbuddy-bridge.mjs` 是对话式智能体被平台指挥的唯一入口（ox-agent/2 协议，
任务书落 `inbox/`、成果由人写回 `outbox/`）。此前它只有 `.workbuddy/` 里一份一次性手跑记录，
链里没有一格会真起它的进程 —— 于是本轮新增两段，并修掉三个只有跨进程才暴露的洞：

- **段 11（`check:workbuddy-bridge`）**：按锚点从桥里抠 `assertWritable` + `writeFiles` 注入假件，
  72 例钉住「放行谁 / 拦谁」+ 整批原子性，口径逐字对齐平台 `shared/glob.ts → isPathInZone`。
  首钉的是桥缺 `z.` 前缀规则那格：zone 取"文件名级"粒度（`src/parse`）时，契约点名的字面路径
  `src/parse.js` 被桥判成越权 —— 症状是任务全红在越权，而 zone 契约其实是对的。
- **段 11 的第三遍差分（推送后 CI 教会我们的）**：桥用 `path.isAbsolute` 判绝对路径，**那是宿主相关量** ——
  win32 上 `D:/evil/x.js` 报"拒绝绝对路径"，Linux 上它不算绝对路径，于是掉进 zone 判定报成"越权"。
  本机 27 例全绿、CI `verify (ubuntu-latest)` 红 2 条（`8e9895d`，2026-10-15）。修法不是给用例加平台早退，
  而是把绝对性改成**按字面判**（前导 `/`、盘符 `X:` / `X:\`、UNC `\\`），并把 `path.posix` 视图注进同一份
  判定代码把同一批用例再跑一遍 + 逐条要求两宿主理由一致 ⇒ 分叉在本机就红，不用等推送。
- **段 28（`smoke:workbuddy-bridge`）**：**真桥进程 × 真 `dist-headless` 进程**，测试扮演"人"读写
  inbox/outbox，6 场景 36 项断言。与段 26 `smoke:offline-e2e` 的分工是后者桥为内联假件、
  一行真桥代码都没碰过。随机端口、零配额，实测整段 11s。
- **修复一（整批原子性）**：`writeFiles` 原先边校验边写 —— 一批里第二份越权时，第一份已经落盘，
  而桥回给平台的只有 `failed`（不带文件清单），平台 `arbitration: revert-batch` 拿不到产物路径，
  回滚覆盖不到那半个文件；被拒的一批于是在目标项目里留下一份从未通过验证的半成品，下一轮踩着它。
  现在整批先校验后落盘，任一被拒 ⇒ 一个字节都不写。摘掉修复，段 11 里 2 条断言当场红。
- **修复二（队列泄漏）**：`outbox` 里的坏 JSON 不删不改名 ⇒ 永久躺在待消费目录；`abort` 与
  `deadline` 两条退出路径不删任务书 ⇒ `inbox` 无限涨（与交付路径那句"任务书只在运行期有用"矛盾）。
  现在坏 JSON 改名 `.bad` 留现场但不留在队列里，三条退出路径统一走 `dropTaskBook`。
  段 28 场景 5/6 各钉一条；改动前实测红 3 条。

### 修复（smoke-fullchain 漏接 fileExists 探针 · 2026-10-15）

`scripts/smoke-fullchain.mjs` 自建引擎时没喂 `fileExists`，而引擎对这条判据的口径是
**没喂就是没检查、不是检查通过** —— 它只打一行告警就继续，冒烟照样报绿。
契约路径合规（Stage 3.5）正是昨天修幽灵义务的那条防线，在这条「全链路」冒烟里却是断的。

- 接上真探针（`fs.existsSync(path.join(root, rel))`，与 `platform.ts` / `run-spec.ts`
  同一实现 —— 引擎已过 `isProbeableRel`，宿主不再重复判定）。
- **并加覆盖断言**：`probeCalls > 0` 且日志出现「契约路径合规：核了 N 条」才允许 exit 0。
  只接不断言，"接了但从未被调用"仍会静默绿。
- 真跑（4m07s，EXIT 0）：两轮各「核了 2 条点名路径，缺 0 条」，probeCalls=4。

模式（可推广）：引擎里凡是**可选注入**的能力（`fileExists` / `conflicts` /
`exportDeliveryBranch`）都是同一口径，写冒烟时要逐个问「这条冒烟有没有断言它真的跑了」。

### 修复（真跑 e2e 负结果的三个病灶：幽灵义务 / 路由不换线 / touched 并行互踩 · 2026-10-14）

2026-10-14 的 `run-multiagent-e2e.mjs --real` 真跑（35 min、12.5 万 token、exit 1）
把三个缺陷当场钉死，本轮全修：

- **幽灵义务（规划层）**：规划官在任务 description 里点名 `samples/sample.csv`，
  zone 却只给 `src/cli.js` —— 写了必被仲裁回滚，而 PRD 级 `findOrphanPaths`
  看不见它（samples 是分解时才发明的，PRD 里没有）。新增
  `findGhostObligations`（`shared/zone-coverage.ts`）：任务点名、无 zone 认领
  ⇒ 规划校验直接打回，带着缺口重分解。`checkContractPaths` 的归属同步修订：
  "无人认领"不再一律放过 —— 幽灵义务归**点名者**（`ghost` 字段说破根因是规划
  不是执行者），归属冲突仍不判。
- **路由不换线（调度层）**：t1 在 loomy 上两次 600s 超时，第三轮路由仍选它 ——
  role(100)+zone(40)+priority(50) 的结构分压过质量分（上限 ±20）。
  `RouteContext` 新增 `taskFailures`（本任务此前失败的 agent 账，宿主从 run
  履历喂入），评分减 `taskRetryPenalty`（默认 100/次）：一败翻盘、两败必换线；
  唯一候选仍中选（惩罚只排序不硬拦，拦了就饿死任务）。
- **mutation:touched 并行互踩（门禁层）**：JOBS=3 时并行审计各自往自己的目标
  文件写变异体，但多个目标的测试集共享 import 图 —— scheduler 的**基线**
  vitest 传递 import 了 router.ts，而 router 的并行审计正把变异体写在上面 ⇒
  别人的基线被我的变异体打红（fixture 期望 a1 实得 v1），目标被误判"基线失败"
  整轮跳过。串行化（JOBS=1）：并行只在"目标间无 import 耦合"时才成立，而
  耦合检查做不对就等于没做。

另有一段写完又删：曾给"验证未过但无失败任务"分支写契约定向翻红，位点审计 +
死代码推演一起判它不可达（Stage 3.5 在验证**之前**就翻红缺口，该分支的前提
"outcomes 全 ok 且有缺口"按构造不成立）—— 按本仓口诀删掉，全员重跑保留。

**测试**：新增 18 条（zone-coverage 幽灵 9 · router 换线 5 · orchestrator 4）。
逐位点审计：zone-coverage 36/36 · router 24/24（等价位点白名单行号 221→244 校回）·
orchestrator 78/78 · scheduler 42/42 · audit-log 33/33；基线 73 目标 / **1723 处
位点**。全量 **2078 通过 + 8 跳过 = 2086 条**零失败；verify 29 段全过。

### 修复（NSIS 与 portable 同名互相覆盖 · 2026-10-14）

`win.artifactName` 是 nsis / portable 两个 target 共用的同一个名字，于是先打的
NSIS 安装器被后打的 portable **原地覆盖**，留下的 `.blockmap` 还是 NSIS 那一轮的
旧版 —— 差量更新按 blockmap 对位，错位即坏；而看输出目录只会觉得"就一个 exe，
挺正常"。现在两个 target 各自命名（`-Setup-` / `-Portable-`），Setup 的
blockmap 与 Setup 的 exe 配对。

同轮首次真跑通打包（此前配置从未在本机出过产物）：`ELECTRON_MIRROR` 与
`ELECTRON_BUILDER_BINARIES_MIRROR` 指 npmmirror（github.com 直连被掐），
产出 `OxCommander-Setup-0.1.8-x64.exe` 与 `OxCommander-Portable-0.1.8-x64.exe`
两件，`smoke:artifact` 10 检全过。

### 新增（从 GitHub issue 建任务：摄入半边 · 2026-10-14）

竞品清单 P2-1 一直只有"读半边"：issue/PR 文本能进规划背景、diff 行批注能回传进上下文，
但**"从 issue 建任务"这条摄入通路始终是空的** —— 操作者得把 issue 的标题正文手抄进
新建项目框。本轮补上，两个创建面：

- **桌面**：项目页新增「从 GitHub Issue 创建」选择器（`github:list-issues` IPC，
  只读 `gh issue list`，白名单与字符集校验同 contextSources 那条通路）。选中一条 →
  `createProject(标题, 标题+正文)` → 与手填创建走同一条 `beginProject → runPlanning` 链路。
- **headless / serve**：spec 新增 `issue: {repo?, number}`（与 `requirement` **二选一**，
  同时给会被拒）。runner 开跑前用 `gh issue view`（只读）取回标题+正文当需求；
  **取不到整轮不启动**（exit 1 + error 事件），不会带着空需求烧 token。解析放在
  hello 之后、journal 之前 —— journal 拿**解析后的文本**做"需求匹配"，断点续跑才
  对得上一次。

三条设计纪律：

1. **一个成文模板**：`renderIssueRequirement` 住 `shared/github-issue.ts`，桌面种子与
   headless 解析共用。两处各写一串字符串，journal 的需求匹配就会因为一处标点改动而
   悄悄失配 —— 断点续跑从此认不出上一次运行。
2. **失败与空结果是两件事**：gh 没装 / 没登录 / 仓库不存在折进 reason 由选择器摆出来；
   "没有符合条件的 issue"是另一句。混为一谈，就是把"没拿到"演成了"没有需求"。
3. **IPC 入口过形状校验**（P0-3 同规矩）：repo/search/limit 在 handler 层校验，非法值
   一个都不进 gh；入参 null / 整个缺席按全部缺席处理（不炸 TypeError）。

**测试**：新增 23 条（成文模板 2 · 只读通路 6 · 协议校验与端到端 8 · IPC 守卫 4 ·
选择器 3）。六个生产文件逐位点审计全杀：`github-readonly` 54→**65**、`ipc/github`
（新）**22**、`store` 34→**35**、`protocol` 95→**114**、`run-spec` 26→**30**、
`github-issue`（新）**1**；其中 `run-spec` 首轮 3 个存活（`!== → ===` 与两处三元
互换）逼出两条缺省解析器的真路径用例 —— 注入假 resolver 的用例覆盖不到
`defaultResolveIssue`，这是"有注入缝就会漏默认路"的标准形态。基线 1652 → **1710**
（71 → **73** 个目标）。全量 2060 通过 + 8 跳过 = 2068 条零失败；verify 29 段全过。

### 修复（混合态要点名：回滚/隔离没做成的路径 · 2026-10-14）

**先确认了现状，再改**（这一项此前只记了一句"需确认现状"）：`SnapshotStore.revert`
**不是事务** —— 它逐个文件尽力恢复，遇到失败**继续**而不是中止（那是对的选择：中止会
让后面的文件连试都不试），代价是部分失败会留下**混合态**：有的文件回到了基线、有的没有。
所以"要不要做成事务"不是真问题（文件系统上做多文件原子替换需要一层日志，不值当），
**真问题是这个混合态有没有被如实说出来**。

答案是没有。每一处上报都只给**数量**：

- `batch-guard.ts` 事件流：`…，3 个未能回滚`
- 失败摘要（会拼进重修 prompt）：`…；3 个未能回滚，需要人工检查`
- 隔离分支更彻底：只报 `（N 个失败）`，连那几个路径都没接住就丢了

两个后果：① 操作员得把整个仓库 diff 一遍才知道是哪三个；② **更糟的是这段摘要会跟着
失败任务进重修 prompt 发给下一个执行器** —— 它拿着"3 个未能回滚"继续在**半回滚的工作区**
上干活，却不知道哪几个文件是脏的。

现在两处都点名路径，并把**原因**跟在路径后面（`skipped` 里混着"真失败"与"本来就不需要动"
两类，只列路径的话操作员还得回去翻源码猜是哪一类）。隔离分支同样点名，措辞不写"仍在原处"
—— 失败的一种常见原因是该文件**已被删除**（无档可隔），那时它并不在原处。

名单上限 8 条：失败面很大时把整份名单灌进 prompt 会把它撑爆，那比不列更糟；超限明确写
"另有 N 个未列出"，**宁可说清有多少没列，也不静默丢**。

**测试**：新增 4 条（路径 + 原因同时进事件流与失败摘要、超限截断但报出剩余数、隔离失败
点名、**负例**——干净回滚不许出现"未能回滚"）。逐位点审计 `batch-guard.ts` **19/19 全杀**
（位点 16 → 19）；基线 1649 → **1652**（71 目标不变）。全量 2035 通过 + 8 跳过 = 2043 条零失败。

### 新增（任务运行履历进看板 + 补上 IPC 通道的第三条边 · 2026-10-14）

**`audit:trail` 从"通道在、没人用"变成界面能力。** 这条通道此前是**静默不可用**的：
主进程 handler 在、preload 转发在、纯函数 `taskTrail` 也在（还用着 —— 重修上下文的
`priorAttempts` 一直在调它），但**渲染层的桥接类型里没声明这个方法** ⇒ 界面拿不到一个
有类型的句柄，于是从来没有人调用过它。不报错、不留日志，只是"这个能力没人用得上"。

看板上的落点：任务行原来那行 `第 N 次 / agentId / 耗时` 只反映**最后一次**派发
（看板视图回答"现在是什么状态"），新增的「📜 运行履历」展开回答"它**经历过什么**" ——
前几次换过谁、各自怎么没成的。取数三条纪律：

- **懒加载**：挂载时不打 IPC。每个 `audit:trail` 要在主进程 `read({limit:5000})` 全量
  审计，几十条任务行各打一次会成为看板打开时的固定成本；取数时机 = 操作者真的展开那一条。
- **每任务只取一次**：履历是归档事实，本次 run 里不会变。去重靠 `useRef` 而不是从 state
  派生 —— 它记的是"已经承诺过取数"，而 state 更新是异步的，连点两下会在两次渲染之间重复打。
- **失败不是终态**：取不到要说清（"读不到履历：<原因>"），并把该任务移出去重表，让再展开
  一次真的重试 —— IPC 抖一下不该让履历永久空白。

结局在界面是**四档**不是两档：`endedAt` 缺席 = 这次派发没有收尾（进程被腰斩 / 重派时前
一次还没回来），`ok` 缺席 = run-end 里没带裁决。把这两种折进"失败"就是替审计编造因果，
所以它们是「⚠️ 未收尾」与「结局未知」，且未收尾那一条在样式上单独标出来。

**根因堵口：`check:ipc-channels` 补上第三条边。** 那道门禁原来管的是
`preload ⇔ ipcMain.handle`，三角形还差一条边 —— **`preload ⇔ src/types.ts` 的
`oxCommander` 接口**。缺了它，"preload 暴露了、类型里没声明"完全无声。现在两个方向都查：

- preload 有、类型没声明 ⇒ 界面拿不到有类型的句柄（`taskTrail` 就是这么死的）；
- 类型声明了、preload 没有 ⇒ 渲染端一调就是 `undefined is not a function`，而那行代码在
  类型检查下**完全合法**（断言的是接口，不是实现），更坏。

**门禁被反向注入验证过**：摘掉 `taskTrail` 声明 → 报红并点名"界面拿不到有类型的句柄"；
注入一个幽灵方法 → 报红并点名"渲染端一调就 undefined"。两次都还原后 PASS。

顺带把 `src/ui.test.tsx` 里 `makeBridge()` 的 `as unknown as Bridge` 摘掉：那个强制转换正是
漏网的同族 —— 桩里少一个方法不会报错，直到有人调用它。现在桩必须完整实现 `Bridge`，
由 `typecheck`（在 `verify` 链里）守住。

**测试**：新增 6 条（四档结局打表、懒加载 + 只取一次、多条按序列出、取不到可重试、
空履历如实说、不同任务各取各的）。全量 2031 通过 + 8 跳过 = 2039 条零失败；
`check:ipc-channels` 三边一致（preload 31 invoke ⇔ ipcMain 31 注册 ⇔ 渲染层 32 方法）。

⚠️ 用例脚手架的一个坑（已写进用例注释）：**jsdom 会为同一次 `open` 变更自己再补发一个
`toggle` 事件**（按 spec，toggle 是异步排队的），所以一次展开会让 `onToggle` 跑两遍。
真实浏览器里用户展开只派发一次。后果是桩必须用**持久**实现，不能用 `…Once` ——
第一发会被第二个事件覆盖，断言会看到"另一个结局"。反过来它也顺带证明了去重是必要的。

### 修复（liveness：LLM 调用链透传 AbortSignal · 2026-10-13）

cancel 时延三分支的最后一支（在途请求）：

- `ChatRequest.signal` 的**设计本来就在**（providers.ts：取消是 run 级的，
  挂在请求上而不是客户端上），`chat()` 也早已把它并进 `AbortSignal.any` ——
  但**没人去 abort**：orchestrator 只有标志位。现在引擎持有本次 run 的
  `AbortController`，`cancel()` 同时 abort —— PRD/规划的在途 HTTP 立刻断。
- 补上 `sleepUnlessAborted`：combo 间的退避睡眠（封顶 80s）此前整段
  setTimeout 不听 signal，一次 cancel 要拖满一个 backoff。已 aborted 立即抛
  `signal.reason`（与 fetch 的 abort 同形，走"不计入冷却"那条处置）。
- `brainCall` 包一层取消翻译：已取消的 run 里，在途 abort / 冷却错一律以
  `CancelledError` 收尾 —— "用户叫停"不再被报成 AbortError/限流失败。
- **测试**：failover 新增"退避睡眠听 signal"（abort 即抛且**不换下一条
  线路** —— 取消不是重发的理由）；orchestrator 新增"cancel 断在途 PRD 生成"
  （50ms 取消 → CancelledError，不等 fetch 超时）。http-clients /
  orchestrator 逐位点重审；基线不变。全量 2007 通过 + 8 跳过 = 2015 条零失败。
- 仍未覆盖：**执行期**（agent 适配器的 LLM 调用）没有外部 signal 可接 ——
  那条链要穿过 AgentAdapter，更深，另记。（→ 已在本版下一条收口）

### 修复（liveness 收官：执行期 agent 调用也接上中止闸 · 2026-10-13）

上一条末尾记的"执行期没有外部 signal 可接"在此收口。引擎 → 调度器 → 适配器
三个适配器，一条链从上到下打通：

- `TaskPayload` 新增可选 `signal`：引擎的 `AbortController` 经
  `Scheduler.setAbortSignal()` 下发，随**每一条**派发载荷交给适配器。
- `RunSession` 新增 `abortSignal` = 本 run 的 `cancel` ∪ 调用方外部 signal
  （`AbortSignal.any`）。此前只有 `cancel`，而它只在 `abort(handle)` 被调用时
  才 abort —— 而 `abortInFlight()` 是一次性枚举，只掐当下已登记的句柄。
- 三个适配器各自接线：
  - `sensenova-api`：在途 `chatJson` 请求改挂 `session.abortSignal`。
  - `http-bridge`：投递那一跳与轮询每一跳都并入 `AbortSignal.any`（此前各自只有
    `AbortSignal.timeout`，取消只能等它自己超时）；轮询被中止时**收口**成
    `aborted`，而不是按"瞬时故障"继续重试到 run 时限。
  - `cli-agent`：进程适配器没有在途 HTTP 可掐，改为闸一落就杀进程树。
- **中止不是失败**（三个适配器同一口径）：`sensenova-api` catch 里的判据用
  `payload.signal?.aborted`，**不能**用 `session.abortSignal.aborted` ——
  后者是并集，看门狗超时走的也是 `session.cancel.abort()`，而超时是**失败**、
  不是"用户叫停"。判据取错会把超时误报成中止，修复轮与预算闸从此看不见超时
  这一类（本机实测：换错判据一次性打红 3 条既有用例）。
- `http-bridge` 的请求体不再带着 `signal` 上线（活对象不属于线路协议，JSON 里
  置 `undefined` 即不出现该字段）。

**为什么必须补这一层**：`abortInFlight()` 是"取消那一刻枚举一遍"，有两个窗口
它永远补不上 —— ① 派发已返回、句柄尚未入表时被取消；② 取消之后才排到的任务。
这两个窗口里的 run 会一路跑到自己的时限（默认 600s）还在改文件、还在烧 token。

**测试**（新增 15 条）：run-session 5 条钉住并集语义（内部中止不外溢、外部中止
不误触内部、构造时已中止则立刻是中止态）；三个适配器各覆盖"派发时闸已落下 /
派发后才叫停 / 不接闸不受影响"；scheduler 3 条（单派发、赛马组全员拿到同一个
闸、不挂闸则为 `undefined`）；orchestrator 2 条（接线本身 + 老 fake 没有
`setAbortSignal` 时构造与 cancel 都不抛）。

**逐位点审计**（本机 221/221 全杀）：新增位点 run-session 7/7、sensenova-api
40/40；改动文件回归 http-bridge 39/39、cli-agent 21/21、scheduler 42/42、
orchestrator 72/72。位点基线 1647 → **1649**（71 目标不变）。
全量 2025 通过 + 8 跳过 = 2033 条零失败。

### 修复（测试基建：清盘 hook 的预算 · 2026-10-13）

全量 67 个测试文件并行时，一堆文件的 `afterEach`/`afterAll` 要删自己造的临时目录，
实测撞破 vitest 的 10s hook 预算报 `Hook timed out in 10000ms` —— 而**单独跑那些文件
466ms 就全绿**。红的不是判据，是"清盘没赶上"。

代价被 `verify` 的串接方式放大：它是 `&&` 串联、首段失败即中断，所以一条清盘 flake
会让后面 14 段（`mutation:quick` / `mutation:touched` / 两个 build / 8 个 smoke）
**一次都跑不到**。本机连着三次全量分别红在 policy-dir / store / atomic-store /
main-wiring 四个**不同**文件 —— 逐个文件改是打地鼠，所以在 `vitest.config.mts` 里
一次性把 `hookTimeout` 放到 60s。

**判据**：这些 hook 里只有清盘、没有一条断言，放长预算不削弱任何判据 —— 它只是
不再让"卫生问题"有能力掐断链条。与上面 `testTimeout` 20s 同源（都是并行下的机器
负载），落在不同位置而已。

### 修复（liveness：调度器节流等待也听取消了 · 2026-10-13）

cancel 时延修复的执行期半边（规划期已修，这是最后一处）：

- `Scheduler` 的 429 节流等待是整段 setTimeout（指数退避**封顶 5min**），
  一次 `/cancel` 在执行期要等满封顶才落地。修为分片等待（1s 粒度）+
  `setShouldStop` 探针，orchestrator 构造时把自己的 `cancelled` 接进来。
- **顺带修一个真吞点**：`dispatchOne` 的 catch 把一切错误转成"任务失败" ——
  取消上抛后会被它变成一条 failed outcome（污染 breaker/限流账，runBatch
  以"任务全失败"而不是取消收尾）。现在 `isCancelled(err)` 原样上抛。
- **测试**：429 节流 describe 新增用例（名义 60s、取消即达 → CancelledError
  < 3s，onThrottle 可观测性不丢）。scheduler.ts 42/42、orchestrator.ts
  72/72 逐位点全杀；基线不变（位点数未变）。
- 至此三处睡眠（brain 冷却 / 调度节流）全部听取消；仅剩 http-clients
  combo 间退避睡眠（`chat()` 全链无外部 signal，需另开一轮做透传）。

### 测试（cancel 时延真实链路回归 + testTimeout 余量 · 2026-10-13）

- **orchestrator 真实链路回归**：上一条修复此前只有单元级覆盖
  （withCooldownRetry 的 tick）。新增 `generatePrd`（公开的 brainCall 入口）用例：
  llm 全路由冷却 → cancel 在 100ms 时到达 → 必须 ~1s 内以 `CancelledError`
  收尾（实测 1012ms），钉住 brainCall → withCooldownRetry → stopError 整条链。
  顺带补 fakeScheduler 的 `abortInFlight`（真实 Scheduler 有、fake 没有，
  cancel() 会调它 —— 不补就是未处理错误）。
- **vitest testTimeout 5s → 20s**：CI site 审计 `--jobs=3` 在 2 vCPU 上互撞时，
  重集成文件（orchestrator/gateway/import 那一档）超 5s 被判"基线失败"，
  fail-safe 串行复核一遍 = 双倍耗时（今天把 site job 顶破超时的直接推手）。
  给足余量后重文件在并行下不再假红。
- 用例 2004 通过 + 8 跳过 = 2012 条。

### 修复（liveness：LLM 冷却等待现在听取消 · 2026-10-13）

CLI 真进程实测抓到的真 bug：一次 `POST /cancel` 在全路由 429 风暴里
**7 分钟没落地**（`cancelled:true` 受理了，run 继续跑）。

- **根因**：`withCooldownRetry`（shared/llm-client.ts）的等待是**整段
  setTimeout**（封顶 120s），`shouldStop` 只在两次等待之间检查 —— 而
  orchestrator 的 brainCall 正是它的调用方，规划期被限流时一次取消要等满
  当前睡眠。同理"暂停 gate 无超时"是这一家的病。
- **修法**：等待改为 tick 切片（1s 粒度）轮询 `shouldStop`，叫停立刻收尾；
  新增 `stopError` 选项 —— orchestrator 传 `CancelledError` 工厂，"用户叫停"
  不再被报成"provider 限流失败"（两种结局分开）。注入的 `sleep` 替身不受影响
  （既有用例的单次全量断言照过）。
- **测试**：两条**真实计时**用例钉住新行为（名义等待 60s、cancel 100ms 时到达
  → 必须 ~1s 内抛 stopError；无 stopError 时抛原冷却错）。llm-client.ts
  15/15、orchestrator.ts 72/72 逐位点全杀；基线不变。
- **同模式未修（下轮，已记账）**：`http-clients.ts` combo 间退避睡眠
  （`chat()` 全链没有外部 signal 可接）与 `scheduler.ts` 节流睡眠
  （封顶 5min，Scheduler 无取消标志、需经 platform 接线）。

### 修复（前端：恢复路径上测试 + 凭据卡一键复核 · 2026-10-13）

评价报告的两个 P2 收尾项：

- **boardRecovery 测试盲区补齐**：ui.test 的 fake bridge 此前没有 `boardRecovery`
  —— `loadRecovery` 的 catch 恒被走到，"被杀进程后重开看板"这条主线的恢复成功
  路径、`interrupted` 横幅、恢复日志**零断言**。fake 补齐后新增正例：
  横幅、恢复日志行、恢复的任务行、最后活动时间全部上板。
- **`receipt:verify` 接上 UI**：凭据卡新增"🔍 复核凭据"按钮（默认 replay:false，
  fail-safe 不执行凭据里的命令），五档裁决（复现/未复跑/被改过/未盖章/矛盾）
  用操作员语言就地展示。`ReceiptVerifyResult` 类型从 `electron/ipc/receipt.ts`
  上移 shared（渲染层要消费）；`src/types.ts` 的 Window 桥声明补上缺失的
  `verifyReceipt`（此前 preload 有通道、渲染层类型没有 = "有接口没界面"的根因之一）。
- **测试**：src/store.ts 逐位点 **34/34 全杀**（33→34，复核守卫的 `||`→`&&`
  由两个负例杀死）；基线 1646 → **1647**。用例 2001 通过 + 8 跳过 = 2009 条。
  遗留：`taskTrail`（audit:trail）仍是 preload 有通道、UI 未消费，留待下轮。

### 修复（headless + 前端：protocolVersion 闸门 / 已耗时 / 渲染性能 · 2026-10-13）

评价报告的 P2 第一条 + P1 的性能与耗时项：

- **headless `protocolVersion` 从"只回声"变"闸门"**：此前任意非空串都接受（宿主写
  `ox-headless/999` 也照跑，语义漂了无人察觉）。现在缺席 = 当前版本；显式给出必须
  形如 `ox-headless/<整数>` 且主版本 = 1，否则 spec 校验失败（本引擎只按 1 的语义跑，
  拒绝猜测兼容）。
- **看板显示运行已耗时**：`runStartedAt`（confirmAndExecute 落）+ 运行态下流水线
  阶段标题旁 `⏱ 已耗时 Ns`（复用静默时钟的 5s tick）；有结论后消失。
- **渲染性能（评价里的首要稳定性风险）**：
  - `LogView` 从 BoardPage 拆出 + memo —— 此前 `logs` 整页订阅，日志风暴（每条
    事件一次 set）重渲染整页；现在 logs 变化只重渲染日志视图本身。
  - `AuditPanel` 的筛选与按 agent 聚合 useMemo 化（此前每次渲染重算）。
- **测试**：headless/protocol.ts 逐位点 **95/95 全杀**（93 → 95 位点，基线
  1644 → **1646**）；ui.test 新增已耗时正/负例与 runStartedAt 落值断言。
  用例 1998 通过 + 8 跳过 = 2006 条。

### 修复（前端：实时日志脱敏 + 控制按钮运行态联动 · 2026-10-13）

全栈评价的 P1 前两条：

- **实时日志流统一过脱敏**：`redactSecrets` 原本只盖 logDigest / receipt / audit
  detail 三处，`logLine` 直发渲染层的通道漏了 —— agent/沙箱/熔断报错里回显的
  token 会原样上屏且可复制。现在 `logLine` 统一过闸，且
  `orchestration` 的 `host.log` 回调改走 `logLine`（此前它绕开直发 `send`）。
- **看板控制按钮按运行态联动**：四个按钮此前恒可点 —— 没跑的时候取消/暂停是
  必报错的无效操作，跑的时候还能再点一次开始。运行态判据 =
  `stage ∈ {PLANNING, DEVELOPMENT, VERIFICATION, DELIVERY} && 无凭据`
  （凭据出现 = 本 run 已有结论，failed 也是结论）。配套把 `confirmAndExecute`
  补成**清掉上一轮的 receipt/verification**（它们属于上一次运行，混在板子上
  会让"这次跑到哪了"读不出真假）。
- **测试**：ui.test 55/55（新增按钮联动 + 重开清结论两条；"开始"用例按新语义
  改到未开工态点击）；ipc-handlers 102/102（新增 logLine 脱敏断言）。
  src/store.ts 33/33、electron/ipc/context.ts 23/23（白名单锚点
  209→212 校回，漂移由 fail-safe 依约暴露）、orchestration.ts 5/5 逐位点全杀；
  基线 1644 不变。用例 1997 通过 + 8 跳过 = 2005 条。

### 修复（安全：IPC 控制面零校验写入 · 2026-10-13）

全栈评价的 P0-3：渲染层来的三个写入口此前不做形状校验。

- **`settings:save`** 以前 `as ProjectSettings` 直接落盘 —— 畸形类型一路带进引擎
  （`switch + default` 静默吞）。现在 `shared/schema.ts` 新增 **`parseSettings`**：
  认识的字段必须形状合法（类型 + 非负整数域 + `arbitration`/`escalationPolicy` 枚举，
  复用运行时值域收窄器）；**缺席 ≠ 非法**（部分保存合法，绝不补默认值）；**未知键放行**
  （刻意不建白名单 —— 手写白名单与类型之间没有自动同步，漏登记一个字段 = 保存时
  静默丢字段，比"多了个没人读的键"严重）。校验失败抛 `SchemaValidationError`，不落盘，
  渲染层走既有 `settingsError` 横幅。
- **`orchestration:update-prd`** 的 PRD 现在过 `parsePrd`（渲染层编辑与 LLM 产出同闸）；
  既有守卫（项目不存在 / 执行中）在前，形状在后。
- **`keys:save`** 的 entries 形状校验（非数组 / 项缺字段 → 明确报错而不是 TypeError）。
  复核更正：此前评价里"任意 `envVar` 可写进 `process.env`"的说法**不成立** ——
  `KeysStore.set` 本来就有 `/^[A-Z0-9_]+$/` 校验，env 同步只发生在校验通过之后；
  本层补的是报错可读性，不是堵洞。
- 顺带重构：`parseDecompose` 的 `if (!title || !command) return;` 是冗余分支
  （`requireString` 已把 issue 推进同一数组，末尾必然抛错，跳过与否不可观察），
  它在逐位点审计里长出 `||`→`&&` 等价变异，按"首次遇到优先重构消除"的纪律删掉。
- **测试**：`shared/schema.ts` 逐位点 **62/62 全杀**（首轮 56/63，7 个存活 = 6 个真缺口
  补断言 + 1 个等价位点重构消除）、`electron/ipc/projects.ts` **12/12 全杀**（首轮 11/12）；
  基线 1599 → **1644** 处位点（71 目标不变）。新增 13 条用例。

### 修复（`--every` 定时运行从来没真跑过一次 · 2026-10-13）

给 serve 的定时那一支补**真进程端到端**用例时当场抓到的：

- **`parseSpec` 不幂等**：`agents` 缺省时输出里带着 `agents: []`，而把这个解析结果再投一次
  会被判 `manifest 校验失败：manifest 列表为空`。serve 的定时环投的正是解析后的对象 ⇒
  **每一次触发都被自己的 `/run` 判 400**，README 承诺的"到点自 POST /run"在任何一次上都没
  成功过。两处分别修：空数组与"没有这个键"同义（`headless/protocol.ts`），以及定时环改投
  **spec 文件原文**（归一化输出带着派生字段 `settings`/`warnings`，再投回去会被当未知字段
  丢掉用户写的 settings）。
- **310e6a7 那笔 serve 加固留下的 4 处变异存活位点**（`--host` 的条件展开、暴露提示的三元
  与两个 `===`、`hostFromArgv` 的 `continue`）已全部钉住。那笔提交没跑过 `mutation:audit`，
  而 CI 最后一次绿的是它之前的 `8d24511`。
- 新增用例 8 条：`parseSpec` 幂等 + 空/非数组/坏 manifest 对照（5）、serve 定时 fail-fast 与
  补跑差分（3）。`headless/protocol.ts` 位点 90 → 93，本机 site 口径逐位点 **93/93 全杀**。

### 修复（安全：serve 默认绑全域 + 无 body 上限 · 2026-10-13）

全栈评价（前端 UI + 全部接口面）揪出的两处"默认值不安全"：

- **`serve` 以前 `listen(port)` 不传 host = 绑所有网卡，而启动信息印的是 `127.0.0.1`** ——
  同一局域网任何人都能 `POST /run`（触发 LLM 调用、往任意 `projectRoot` 写盘、跑验证命令）、
  `/cancel`、`/approve`。现在默认绑回环；要对外必须显式 `--host=<地址>`，且
  **非回环 + 无 `OX_SERVE_TOKEN` 直接拒绝启动**（入口层与库入口 `startServe` 各一道守卫）。
  启动信息打印真实绑定地址（`srv.host`）并在非回环时附暴露面提醒；定时环自调用地址
  跟着绑定地址走（通配换算回环、具体网卡地址原样），不会再出现"绑到具体地址 → 定时环
  每次触发都连不上回环"。
- **`/run` 与 `/approve` 的 body 无界拼接**（一条慢连接即可打满内存）：上限 2 MiB，
  超限 `413` 且不交给下游；`server.requestTimeout` 显式 60s（只掐"发一半不发了"的连接，
  长跑的 run 与 SSE 不受影响）。
- **测试**：`headless/serve.ts` 逐位点 **68/68 全杀**、`headless/serve-main.ts` **43/43 全杀**；
  基线 1576 → **1596** 处位点（71 目标不变）。新增用例：回环真值表（把 `||` 写成 `&&`
  的存活变异由此杀死）、非回环拒绝启动、非回环 + token 的 401/放行、body 上限边界
  （恰好限内 vs 超一字节）、`/approve` 同受上限、`--host` 解析与自调用地址换算。

### 修复（安全：沙箱内联求值地板被 `npx` 别名绕过 · 2026-10-12）

- **`CommandPolicy` 的启动器内联求值地板有三条等价绕过**（全面测试的独立对抗性审计发现）。
  地板靠"精确拼写"匹配，而 npm 的 nopt 接受的拼写不止一种：`npx --c '<cmd>'`（`--call`
  的别名）、`npx -p X -c '<cmd>'`（`-p` 是 `--package` 别名，值选项表漏收）、
  `npx --pac X -c '<cmd>'`（`--package` 的缩写）—— 三者都被判 **ALLOW**，而同义规范写法
  `npx -c` / `npx --package X -c` 被正确拒绝。实测它们各自真能执行（`npx --c "node -p 6*7"`
  → 42），即把 `node -e` 禁令整段绕开。可达路径已核：`verifier.ts` 对**验证命令与智能体
  生成的 smoke 命令**都走 `policy.check`，而这道地板本就是为拦 AI 生成命令而设的安全边界。
- **修法（拼写无关，不枚举）**：`EXEC_VALUE_OPTIONS` 补 `-p`；并在 `launcherEvalHit` 末尾
  加一条**形态**兜底 —— 转发参数里出现"带空格的 token"即一整条命令行被塞进单个 argv
  （shell 串），一律拒绝。旗标拼写无法穷举（实测 `--cal` / `--pack` 反而报错，nopt 的缩写
  不成前缀规律），所以判据落在形态上，不落在拼写上。
- **测试**：`src/sandbox-runtime.test.ts` 的启动器用例补 6 条 —— 3 条绕过形态 + 2 条
  "值不带空格"（用于钉住被形态兜底遮蔽的 `isShellCallFlag` 两个 `||`）+ 1 条
  `npx -p X bin arg` 合法透传。逐位点审计 `command-policy.ts` **15/15 全杀**。

### 门禁（`TARGETS` 重复登记 · 2026-10-12）

- `electron/ipc/orchestration.ts` 在 `TARGETS` 里**登记了两次**（2026-10-05 的单测试条目
  与 2026-09-22 的双测试条目；前者被后者取代，属残留）。后果：全量 site 审计把它跑两遍、
  报告出现两行，审计实跑总数（1550）与 `SITE_BASELINE`（按文件去重计数）对不上。已删去
  旧条目并把来由并入保留条目；修复后 TARGETS 71 条目 / 71 唯一文件。

### diff 行批注回传（P2-1 远端半边，2026-10-12）

- **`settings.contextSources` 新 kind `"pr-comments"`**：竞品口径里"在 diff 行留批注
  回传给 agent"的**读半边** —— 人在 GitHub PR 的 diff 行留的批注（review comments），
  在下一轮规划/重修时作为**背景**进上下文（本地半边只拉了 issue 列表与 PR 描述，
  人留下的反馈此前没有通路）。复用同一层：`githubArgs` 多一种形态、`parsePrComments`
  / `renderPrComments` 两个纯函数、`fetchGithubContext` 多一个分支；platform 装配
  原样透传（新 kind 自动生效，桌面与 headless 同一口径）。
- **白名单里唯一一条 `gh api`**：`gh api --method GET repos/{repo}/pulls/{N}/comments`。
  路径每一段都由我们拼 —— repo 要么过 `REPO_RE`，要么缺席时用 gh 自己的
  `{owner}/{repo}` 占位符（它按 cwd 的仓库填）；PR 号是安全整数；`--method GET`
  显式钉死方法，不靠 gh 的默认值。用户串进不了路径，也不出这条命令以外的形态。
- **"没有批注"和"拉取失败"是两件事**：空数组是合法空结果（`ok=true, items=0`），
  渲染成一句"（该 PR 没有 diff 行批注）"的实话 —— 不返回空字符串（那会被引擎按
  "没拿到"记日志）；坏 JSON / 非数组 / `gh` 非零退出才折进 `reason`。失败原因里的
  命令名按 kind 映射成人话（api 形态下 argv[1] 是 `"--method"`，不能拿来当命令名）。
- **信任面不变**：批注内容和 issue 正文一样，是任何人都能写的不可信数据 ——
  围栏仍在 `externalContextBlock`（提示层声明为数据）+ schema 校验 + 沙箱三处，
  本层只如实标注来源与截断。"从 issue 建任务"（P2-1 的摄入半边）仍未做：
  它需要一个任务创建面（桌面表单或 serve/headless 的 spec 字段），已连同设计
  约束记进路线图文档，说破留着。
- **门禁**：`github-readonly.ts` 逐位点审计 **54/54 全杀 100%**（本机用一次性 fd
  绕法跑通 site 口径，原来的 32 处 + 新增 22 处）。审计逼出一处真缺口：
  `parsePrComments` 取 `user.login` 的 `user && typeof user === "object"` 被变异成
  `||` 时存活 —— 因为 `typeof null === "object"`，`user: null` 会去取 `null["login"]`
  抛错；补了 `user: null` 的断言（不是加等价白名单）。site 基线 1554 → **1576**，
  目标数 71 不变，漂移 0。用例 +17（合计 1965 条收集）。

### 规划前只读外部上下文（P2-1 本地半边，2026-10-12）

- **`settings.contextSources`（缺省不配 = 不拉）**：规划之前从本机已登录的 `gh`
  拉 GitHub 的 issue / PR 文本，作为**背景**喂给规划大脑（`buildPrdPrompt` 的新可选参数）。
  `electron/context/github-readonly.ts` 是纯判定核心（命令白名单 = `issue list` /
  `pr view` 枚举、`owner/repo` 与 PR 号字符集、条数/字符预算收敛、issue/PR 输出的解析与
  裁剪、`gh` 非零退出与坏 JSON 如实说破），spawn 由平台注入（引擎层零进程依赖）。
- **信任面说破**：拉来的内容来自远端仓库，任何人都能在 issue 正文里写"忽略上述规则"。
  三处一起做：`externalContextBlock`（提示层声明为**不可信数据**）、PRD 的 schema 校验、
  沙箱；只说"没人以为它是指令"，不说"拦得住"。**失败 ≠ 空上下文**：`gh` 不在 / 未登录 /
  网络失败一律如实报"没拿到"，绝不退化成"当作没有这项需求"。
- **顺带消掉 10 个不可观察的分支**：`contextSourcesFor` 原用 5 个
  `...(x !== undefined ? {x} : {})` 拼参数（每个 2 处位点在变异里必存活）—— 现在直接把
  配置对象（`GithubContextInput` 的超集）交给 `fetchGithubContext`，platform.ts 的位点
  从 38 降回 **28**。与 5.7 的 `deliveryRemoteArgs` 同款处置。
- 门禁数字：在册目标 70 → **71**（新增 github-readonly，tier 1）；site 基线 1518 →
  **1554**；本轮四个改动目标逐点审计全杀（github-readonly 32/32、orchestrator 72/72、
  platform 28/28、prompts 4/4）。新增 `src/github-context.test.ts`（27 条）+
  orchestrator / platform / prompts 补 12 条断言，全量 1940 通过 + 8 跳过。

### 交付后远端分发（2026-10-12，竞品刷新清单 5.7 的**远端半边**）

- **`settings.deliveryRemote`（缺省不做）**：本地半边（`git-export`，2026-10-11）
  只产本地分支且**永不 push**；这一层在操作者**显式开开关**时把那个分支推到
  指定 remote、可选开 PR、可选等 CI 结论。`electron/engine/git-remote.ts` 是纯
  判定核心（字符集自证、`gh pr checks` 解析、PR URL 提取、轮询停条件），spawn 由
  平台注入；orchestrator 的接线点在本地导出**真的产出分支**之后（导出跳过 = 不推）。
- **信任面说破**：`CommandPolicy` 的地板把 `git push` 判为拒绝，那是给**智能体
  生成/执行的验证命令**用的；这里是操作者授权的分发动作（remote 名、分支名、
  基分支全部字符集校验、全程 `shell: false`），走另一条信任面 —— 地板的语义不变。
- **刻意不做**：不碰凭据（push 走本机 git 凭据链、PR 走 `gh` 登录态；`gh` 不在
  或未登录如实说破，绝不退化成"把 token 交给某个参数"）；**永不 `--force`**；
  只推指定 remote 的指定分支。**CI 结论只回流进日志与返回值 —— 不自动触发重修**
  （"CI 红了要不要再派一轮"是策略问题，需要幂等与次数上限的设计，v1 不做）。
- **`gh pr checks` 解析不出结论一律 `unknown`**：这道闸的意义是"CI 说了什么"，
  不是"我们觉得它应该绿"；坏数据（`null` 元素、非 JSON、"no checks reported"）
  不许被读成绿。轮询到上限仍是 pending 就如实报 pending。
- 门禁数字：在册目标 69 → **70**（新增 git-remote，tier 1）；site 基线 1469 →
  **1518**；本轮四个改动目标逐点审计全杀（git-remote 39/39、orchestrator 70/70、
  platform 28/28、types 4/4）。
- **顺带消掉 10 个不可观察的分支**：platform 装配原本用一串
  `...(x !== undefined ? { k: x } : {})` 拼参数 —— 那些三元在变异审计里活下来
  （9 处存活）只能靠登记等价锚点糊过去，而"接不接"本就是引擎的判空语义。现在
  参数由纯函数 `deliveryRemoteArgs` 造（可逐点审），宿主直接把 `undefined` 交给
  deps（`publishRemote?: fn | undefined`），platform 的位点从 38 降到 **28 且全杀**。

### 本机环境：node 同步子进程的 stdio pipe 被阻断（EBUSY，2026-10-12 记录）

- 现象：本机 `spawnSync` / `execFileSync` 用默认 pipe 时返回 `status=null`、
  `stdout=undefined` 并报 EBUSY；同一命令换成 `stdio:'inherit'`、`'ignore'` 或
  **文件描述符**都正常 —— 被拦的是 pipe 那一种。受影响的段：`mutation:quick` /
  `mutation:touched` / `check:mutation-targets` / `check:doc-claims` 的规模核 /
  `smoke:artifact` 的 headless 段，以及 17 条真进程用例（`spawnSync git`）。
- **处置：不改生产代码去适配一台机器**（CI 上 pipe 正常）。本机审计改用一次性
  `--require` shim 把 pipe 换成临时文件 fd（不入版本库），语义不变：
  拿得到同样的 stdout/stderr 与退出码。结论照旧以 CI（Linux）为准。

### 门禁提速：变异按目标并行（2026-10-11，第七轮）

- **`--jobs=N`（默认 1 = 与历史逐字节同序）**：`>1` 时按**目标**分进程池——每个
  worker 子进程独占一个目标，复用全部单目标流程（基线、台账、还原、报告）。
  `testsPass` 是 `execFileSync`，进程内并行不可行；worker 之间互不共享源文件，
  所以并行是安全的。实测：`mutation:quick` 顺序 109s → 并行 **48s**（含一次
  基线复核），结果与顺序完全一致（同 29 目标 / 同杀死数 / 同位点数）。
  `mutation:quick` / `mutation:site` / `mutation:audit` 接 `--jobs=3`（CI 的
  43min 全量 site 审计预期降到 ~18min）；`mutation:touched` 自带同样的 3 并发池。
- **台账从单槽 `index.json` 改成按文件一条（`<备份名>.json`）**：单槽从根上
  假设"同一时刻只有一个源文件在被变异"，是并行化的前置改造。顺带修了一个
  真限制：过去两个会话即使改的是**不同文件**也无法同时跑变异（全场互斥），
  现在按文件判定——`check:residue` 的卫生检查仍是全场（任何文件的活体残留
  都拦），worker 只对"本轮要动的文件"上的外来台账拒启动。residue 测试
  （18 条）全部适配新形状，pid 所有权 / 备份清理 / 孤儿处置的语义逐条保留。
- **并行下的偶发基线失败：池排空后单跑复核**。真进程类测试（kill-tree 真杀
  树、dev-server 真起服务、serve 真 HTTP）并发时会互相打架——首跑基线失败的
  目标在池排空后**单跑复核一次**，单跑仍红才是真红（与 smoke:gateway 偶发红
  "单跑复现再归因"同一处置）。复核走顺序路径，结论确定。
- **报告顺序稳定化**：池的完成顺序是调度顺序，报告按 TARGETS 顺序输出；
  worker 异常退出（exit 2 / 被杀）按"基线失败"计红——宁可误红不可漏绿，
  它留下的台账由下一轮 `check:residue` 自愈。
- 门禁数字不变（本轮零生产代码改动：69 目标 / 1469 位点 / 1865+8 用例）；
  `check:masker` 的锚点提取未受影响（31/31）。

### 交付后 git 导出（2026-10-11，竞品刷新第六轮：5.7 的本地半边）

- **`exportDeliveryBranch`（settings，缺省关）**：交付过硬门禁后，把本次 run 的
  zone 内改动导出成 `git 分支 + commit`（`oxcommander/delivery-<时间戳>`），供
  操作者自行 review / 推送 / 建 PR。`electron/engine/git-export.ts`（porcelain -z
  解析、zone 过滤、分块 add、身份兜底、每条 git 调用过 CommandPolicy 拒绝地板、
  元字符怪文件名单条跳过）+ orchestrator 两处交付点接线（开关与实现缺一不可）
  + platform 注入（引擎保持零 spawn 依赖）。**永不 push**——PR 与 CI 失败回流是
  5.7 的远端半边，需要远端凭据，明确留下。
- **诚实边界**：commit 只收落在任务 zone 内的路径——"计划覆盖的改动"；zone 内
  的既有未提交改动会一并进 commit，要干净导出请从干净工作区起跑。导出失败只写
  `[git-export]` 日志并强调"不影响交付"，本地硬门禁在交付前已过，分发层坏了
  不追认门禁为假。
- 门禁数字：在册目标 68 → **69**（新增 git-export，tier 1）；site 基线 1437 →
  **1469**；用例数 1843+8 → **1865+8**（git-export 15 条 + orchestrator 接线 6 条）；
  四个改动目标 site 审计全部 100%（git-export 27/27、orchestrator 62/62、
  platform 26/26、types 6/6）。

### serve 定时运行（2026-10-11，竞品刷新第五轮）

- **`--every=<间隔> --spec=<文件>` 定时触发**（学 Orca 的 scheduled automations，
  刷新文档 §五 排定的下一候选）。`headless/schedule-core.ts` 纯判定核心
  （间隔/参数解析、补跑判定、忙时重试间隔）+ `serve-main.ts` 调度环接线。
  触发 = **自 `POST /run`**（127.0.0.1 自调用）：单 run 语义、409、SSE 广播、鉴权
  零改动复用，调度环不带任何绕过既有门的路径；配了 `OX_SERVE_TOKEN` 时自调用
  同样带 Bearer 头。语义与边界（首次触发在一个间隔后、忙时跳过不积压、
  中断补跑至多一次、坏账不拖垮调度）见 `docs/headless-protocol.md` §8.1。
- **两个顺手抓到的真缺陷**（site 审计逐位点逼出来的）：
  `Number.isInteger(1e25)` 是 true——超长数字串溢出根本拦不住，改用
  `Number.isSafeInteger` 并补了 Node setTimeout 上限（约 24.8 天）的第二道闸；
  scheduleStateIo 里的 `Number.isFinite` 对 JSON 边界是死防御（JSON.parse 产出的
  number 必然有限），按"能简化就简化"删除并留注。
- 门禁数字：在册目标 67 → **68**（新增 schedule-core，tier 1）；site 基线 1405 → **1437**；
  serve-main 的调度环位点挂进其既有目标的测试集。

### 竞品刷新第四轮：三项吸收（2026-10-11）

> 全文见 [docs/2026-10-11-competitor-refresh.md](docs/2026-10-11-competitor-refresh.md)。
> 口径照旧：只吸收真空白，每条动机可追溯，全部增量叠加、不动三层架构。

- **循环输出检测**（闭环 2026-10-02 遗留的 loop detection 软挂起项，学 agentguard-llm）。
  它补的是心跳补不上的那半边盲区：idle 超时只抓「不出声的挂死」，而**在出声但原地打转**的
  run（同一行日志反复刷）每条事件都在续约心跳、idle 永远不到、deadline 要烧满才收场。
  `electron/sandbox/loop-detector.ts` 纯函数判定器 + scheduler `collectToTerminal` 挂载，
  每次派发一个检测器；判据刻意保守——连续且逐字相同的长行（默认 8 条、每条 ≥16 字符）才判，
  行内数字不抹平（带时间戳的心跳是活着的证据）。触发即中止本 run，digest 带 `[loop]` 标记，
  `FailureClass` 新增 `loop` 档（看板标签「循环空转」）。`SchedulerOptions.loopDetection`
  显式 `false` 可关；已知边界：交替两行的循环不判（v1 只抓单行空转，误判代价 = 进修复轮换执行器）。
- **per-agent 预算闸**（学 paperclip 的 per-agent spending limits with automatic throttling）。
  manifest `limits.maxTokens` 声明单个执行器一个 run 里可烧的**上报**用量上限；
  内置执行器在 client 边界包计数器、终态事件带 `usage`（`RunSession.push` 加通路，
  消费了契约里一直没有通路的 usage 字段）；scheduler 按 agent 记账，`admitBudget` 链在
  熔断之后：到限的 agent 本 run 不再接新单——**节流的是派单，不是杀 run**（与 run 级
  maxTokensPerRun 同为软上限）。跳过经 `onBudgetGate` 可观测，no-agent 的 digest 写明
  「预算闸跳过：谁、到了多少」。诚实边界：只看得见执行器主动上报的用量（内置执行器真报；
  CLI/HTTP 桥不报就无约束力）；点名派发不过闸（与熔断同语义：显式意图优先）。
- **成功率跨 run 持久化**（ruflo「自适应记忆」的对位物）。路由给历史成功率打分，而这份账
  此前只活在进程内存里（headless 每 run 归零）。`CircuitBreaker` 接 `CircuitPersistence`：
  只恢复总账（successes/failures），consecutiveFailures 归零、一律 closed 起步——恢复的是
  「历史上靠不靠谱」的先验，不是「上一 run 挂没挂」的结论。每次 record 写回，总账超 500
  按比例淡出（先验要能被新事实改写）。桌面端落 `userData/agent-stats.json`（原子写，
  坏账从零开始）；headless 经 `PlatformHost.agentStatsFile` 显式给路径才接。
- **门禁数字同步**：在册目标 66 → 67（新增 loop-detector，tier 1）；site 基线 1379 → 1405
  （新增 26 处位点全部逐点全杀）；用例数 1794+8 → 1827+8（合计 1835）。本机按 `--file=` 分档对
  12 个改动目标逐点审计全绿，全量仍交 CI。

### 门禁失败信息指向正确的那一格（2026-10-11）

- **`src/sandbox-journal.test.ts` 的 `afterEach` 补 30s 超时**。性能用例（300×4KB）
  自己已经因为"写盘再扫两遍"拿到 30s，清盘的 hook 却还是默认的 10s —— 全量并行跑
  （60 个测试文件）时 `rmSync` 递归删 300 个文件撞上 hook 上限，而 vitest 把超时记在
  **那条用例头上**，报出来的是"性能断言失败"，真相是"清盘没赶上"。两处量级必须一致。
- **`src/mutation-residue.test.ts` 的 `recoverOnly()`：spawn 失败当场说破**。`status === null`
  不等于"它退了某个码"，那是**子进程根本没起来**（原因只在 `error` 里）。此前 10 条断言
  一律显示 `expected null to be 2`，读起来像判据脚本的退出码逻辑坏了。
  2026-10-11 在一台受管 Windows 上实测到 `spawnSync … EBUSY`：该环境阻断 `spawnSync` 的
  stdio 管道（同一个 node.exe 直接执行正常，`stdio: 'inherit'` 正常，异步 `spawn` 也正常），
  于是这 10 条在本机必红 —— **属环境限制，不是判据缺陷**，现在错误信息直接把它点出来。

### 门禁可观测（2026-10-11）

- **site 全量审计的结论与数字现在会写进 CI job 的 summary**：此前 `mutation (site, every site)`
  job 对外只有绿/红一个 bit，"这次到底验了多少处"要翻 log 才看得到，而 log 需要登录才能取。
  现在 `mutation-check.mjs` 检测到 `GITHUB_STEP_SUMMARY` 就把口径、杀死 N/M、耗时、
  存活清单（或漂移/基线失败清单）追加进去 —— PASS 与三种 FAIL 各有各的内容。
  **写失败只报一行提示、不影响判定**：summary 是给人读的旁证，不能反过来让门禁失明。
  放在脚本里而不是 workflow 里，是因为只有这里知道自己的口径（aggregate 的"全杀"不等于
  site 的"每处都验过"）。实测（同一个目标跑两遍）：PASS 写入 `杀死 3/3（100%）· 耗时 10.1s`；
  把路径指成目录 ⇒ 打印"EISDIR … 不影响本次判定"且退出码不变。
- **README 里"全量审计"那两处表述改为以 CI 为准**：原文停在「1312/1312 @ 2026-10-05，全量尚未重跑」，
  而 CI 每次 push 都跑全量（最近 @ `c67d920` success，43 min），只是那个数字没人能读到 ——
  表述落后于事实，等于把已经闭合的账记成欠账。现在分开写：基线 1379 是"有多少处该被逐点验过"，
  CI 那次是"这一批位点真跑全量的结果"。
- ⚠️ **本机 Windows 已跑不动 site 全量**：2026-10-11 实跑 54 分钟后崩在
  `EPERM: operation not permitted, open 'headless/serve-main.ts'` —— 还原源文件被本机杀软拦写，
  变异体留在工作区（`git diff` 一看就是三元算子被换），靠 `check:residue` 自愈才清掉。
  **结论：全量交 CI，本机只做单目标 `--audit`**（后者 10 秒级，稳定）。

### 加固（门禁盲区 · 2026-10-09）

- **`check:residue` 的台账盲区补上**：它过去只认 `scripts/.mutation-pending/index.json`，台账不在
  就直接宣布"工作区干净"。实弹（2026-10-09）：往那个目录塞一份没人引用的 `.orig`，
  `--recover-only` 打印"无变异残留"并 **exit 0** —— 而项目记忆 2026-10-08 那条
  "手工/丢台账的残留它看不见，只能靠下游断言偶然抓到"由此从"记着的事"变成有判据的东西。
  现在的规则是**逐份向备份要证据**：备份名带仓库相对路径（`electron__engine__verifier.ts.orig`，
  顺带解决不同目录同名文件顶掉同一份备份的问题），映射回源文件比内容 —— 一致 ⇒ 上一轮其实还原
  成功了，清掉并继续；对不上或映射不回去 ⇒ exit 2 且不许打印"干净"。
  **孤儿备份只点名不动手**：它可能是写盘写坏的一半，拿它覆盖源码会把好文件截断。
- **`armPendingRecord` 从"警告后继续跑"改成拒跑（exit 2）**：备份写不下去，或写完读回来不是原文
  （本机杀软会掏空刚写下的文件，见 `restoreSource` 同一段账）时，源码一律不动。
  那一刻源文件还没被碰过 ⇒ 退出零副作用；反过来，没有落盘台账的运行一旦被强杀，
  残留就正好落在上一条那个"看不见"的格子里。
- **`src/mutation-residue.test.ts` 的首条守卫用例改看实物，并解释了它 10-08 那次"归因未定"的红**：
  旧断言拿"`index.json` 在不在"当活体变异体的代理指标，于是**另一轮变异跑到两次改写的间隙**
  （源码已还原、台账还活着）时它必红 —— 2026-10-09 与另一个会话并行时当场撞到，机制就此定死。
  现在它直接比台账所指文件与备份的内容；刻意不调 `--recover-only`，因为那会把别人活着的台账
  连根清掉（`PENDING_DIR` 是仓库级全局路径，两轮并发本来就会互相清）。
  反向注入四处各自验过会变红：摘掉孤儿处置 ⇒ 3 条红；把"只点名"改成拿备份覆盖源码 ⇒ 1 条红；
  摘掉 `armPendingRecord` 的拒跑 ⇒ 2 条红（那两条都断言退出码）；摘掉写后校验 ⇒ 1 条红。
  用例数 9 → 14。
- **台账写进 pid：`clearPendingRecord` 从 `rm -rf` 整个目录改成只清自己这一轮的**。`PENDING_DIR` 是
  仓库级全局路径，旧实现下另一轮正在跑时那一句会连它的台账与备份一起删掉 —— 它那轮一旦被强杀，
  残留就同时躲过启动自愈与孤儿处置（"看不见"那一格的最后一格）。配套：启动时见到"pid 活着且不是
  我的"台账判为 `foreign-live`，既不还原也不清，`--recover-only` 与真跑都 exit 2 拒绝启动 ——
  那不是残留，是别人正在跑的现场；两轮在同一份源码上互踩，"杀死/存活"本来就没有可信结论。
   反向注入：摘掉 pid 归属 ⇒ 1 条红。用例 14 → 18。

### 收口合流（2026-10-09 晚 · 两个会话同仓合流）

同日两个智能体会话在同一仓库并行干活（对方提交里已自记"确有两个会话并行跑门禁"）。
本批按"只落自己、不碰对方未提交 WIP"协调，对方完工后由本会话统一落库、数字对齐、推送收口。

- **`dev-server` 托管检查的 spawn 失败由 `error` 竞速接住**（`00921a8`，本会话）：`verifier.ts`
  里同一件事有三条 spawn 路径（`runOnce` / 普通 smoke / dev-server），前两条都有 `error` 监听，
  唯独 dev-server 漏了 —— `buildSpawnSpec` 对不存在的命令不抛、失败在异步 emit，无监听器时
  Node 把它抛成**未处理异常、当场带崩宿主**（桌面端=整个应用没了）。补上后与 `close` 守卫同处置：
  error 一到立即判死，不再白等整个 HTTP 超时预算。先红后绿已验（摘掉监听器用例红在 uncaught ENOENT）。
- **冒烟样例的 stdin 送达有了归宿校验**（`20b12bb`，并行会话完成、本合流落库）：`SmokeOutcome`
  增 `stdinError`，`ok` 判定加"样例那一笔写有归宿"；stdin 的 write 回调与 error 监听器接住
  （子进程不读管道输入就退出时，挂起的写以 error 落在 stdin 流上、宿主进程当场退出）；
  `settle` 收口等写有归宿（超时自行解除）。真 spawn 用例三组：不看管道输入就退出 ⇒ 判失败且
  error 被接住；1MB 读到底 ⇒ 判过且 digest 带消费字节数；写回调不归宿 ⇒ 超时收口不挂起。
- **`npx` / `npm exec` 经启动器转发内联求值标志的拦截**（`04e3cd5`，并行会话完成、本合流落库）：
  `EVAL_FLAGS` 里 `npx` 曾是空表，空表守卫把整档跳过 —— `npx -c 'node -e …'` 从没被判定过。
  `launcherEvalHit` 按 npm 家族（npx/npm exec/pnpm dlx/bun x）从左到右读转发 argv：
  启动器自身位上的 `-c/--call` 是 shell 串；一旦普通 token 点名的嵌套程序，其后 argv 用同一张
  `EVAL_FLAGS` 表判。用例 11 个拒绝 + 合法透传（`npx eslint -c` / `npm exec vitest --coverage`）不误伤。
- **合流方式与数字**：对方两个 WIP 落库前各自全绿（stdin 用例先红后绿、command-policy 位点
  15/15 逐点审过）；`SITE_BASELINE` 随 command-policy 新位点补落到 **1369**；门禁数字
  1774+8 / 1369 与实物对齐（`check:doc-claims` 对实物核）。推送 `5f4e444..e758909` 共 8 个提交，
  CI 三 job 全绿（ubuntu / windows verify + site 全量变异）。

### 优化（清单收口 · 2026-10-09）

按 `docs/2026-10-09-duplicate-declarations.md` 的「下一步」逐项落地。

- **欠账 #18 结：`SettingsStore.load` 对 `arbitration` / `escalationPolicy` 接上边界收窄**（清单第 4 项收口）。
  `shared/types.ts` 新增运行时值域 `ARBITRATION_MODES` / `ESCALATION_POLICY_SETTINGS`（取
  `Record<Union, true>` 形状 —— 少一键是编译错，且被 `check:exhaustive-maps` 逐档登记）
  与收窄器 `isArbitrationMode` / `isEscalationPolicySetting`；`load()` 里两个同病字段一起收：
  未登记的值此前会一路带进引擎，那里 `switch + default`（`remedyFor`）把它**静默吞成 `fail-batch`**。
  非法 `arbitration` 落回 `DEFAULT_ARBITRATION_MODE`；非法 `escalationPolicy` **丢掉该键**
  （与"用户从没选过"同义，让装配侧 `?? DEFAULT_ESCALATION_POLICY` 生效）。
  `headless/protocol.ts` 同步丢掉自己那份 `ARBITRATION_MODES` 数组、改引共享真源（第 1 项的值域一并单一化）。
  两个字段一起做 —— 只做一个等于没做。
- **欠账 #16 结：`ReceiptTask.errorClass` 由裸 `string` 收成 `FailureClass`**（清单第 6 项）。
  纯类型收紧、**行为零变化**：生产者 `outcome.errorClass` 本就来自已经是 `FailureClass` 的
  `DispatchOutcome`，收口后新增一个未登记的类别会被编译器拦住，而不是靠"有人记得同步"。
- **#12 成对读代码：`cli-agent` vs `http-bridge` 的 `lastResult` 判据统一**（清单第 12 项）。
  bridge 对任何状态的 run 都报真实终态；cli 此前把 `session.finished` 也映成 `failed`，
  于是"已结束、但还没被 `collect` 移出追踪表"的一小段窗口里，一个 `completed` 的 run 会被读成 `failed`。
  判据统一为"在途 ⇒ 保守 `failed`；已结束 ⇒ 回 `results` 里那份真结果"。⚠️ `lastResult` 当前
  **无生产调用方**，所以这是潜伏分歧而非线上缺陷；统一后由用例双向钉住（正例 + 未知 run 不抛）。
- **盲区补扫：`check-exhaustive-maps` 的跳过项从"计数"改为"可列出"，并收口 2 处漏网映射表**。
  工具此前 `--list` 声称"打印跳过项"却只打印数量，且 `skipped` **跨 tsconfig 重复计**（实测 19/20 虚高）。
  改为按 `文件:行` 去重并逐条列出后，实际 **11 处**：9 处是真正动态键（`Record<string, …>` /
  `unknown` switch，正确跳过），2 处是漏网 —— `BoardPage.tsx` 的 `STAGE_LABELS` /
  `RECEIPT_TASK_ICON` 用了 `Record<string, string>`，按 `ERROR_LABELS` 同款收口成
  `Record<Stage, string>` / `Record<ReceiptTaskStatus, string>`（新增一档不再静默漏标签）。
  收口后跳过项降到 **9 处**，两张表进入逐档登记范围。

**实测**：`npm test` **1759 通过 + 8 跳过（1767，60 文件）**；四套 typecheck 干净；eslint 0；
29 段 verify 全绿（含 `mutation:quick` 与 `mutation:touched` 对本次改到的 5 个目标逐位点审计
**全部 100% 杀死**：`shared/types.ts` 6/6 · `electron/store.ts` 8/8 · `cli-agent.ts` 21/21 ·
`delivery-receipt.ts` 43/43 · `protocol.ts` 90/90）；位点基线 **1351 → 1355**（65 目标，
`mutation:baseline` 无漂移）。为避免新位点"没人逐点验证过"，把 `electron/store.test.ts`
挂进 `shared/types.ts` 目标的测试列表（新收窄器的断言在那里，否则那 4 处位点无人审）。

---

## [0.1.8] — 2026-10-08（含发布后补记）

> 本节内的「门禁」一节末尾 6 条（2026-10-08 / 10-09）为打 tag 之后的补记；
> 其余为该版本发布时的内容。

### 新增（引擎能力）

- **契约路径合规（Stage 3.5）：任务点名的文件必须真的在盘上**（2026-10-06）。

  起因是今天的 `run-multiagent-e2e.mjs --real` 负结果（逐条见
  [docs/2026-10-06-real-decomposition-e2e.md](docs/2026-10-06-real-decomposition-e2e.md)）：
  规划官把 `t1` 的 zone 划成**目录** `src/core/csv`，而契约要求的是**文件** `src/core/csv.js`。
  `isPathInZone` **刻意**把后者算作前者之内（`src/duration` vs `src/duration.js` 的既有取舍，
  见 `shared/glob.ts`），于是执行者交上 `src/core/csv/index.js` —— **zone 合法、等价布局、契约非法**，
  而四道现存的关口都看不见它：派发前的 zone 覆盖只问"有没有 zone 认领"（有）、靶项目的
  build/typecheck 只做语法检查（过）、`node --test` 那时因 `tests/` 为空而红（理由还不是这个）、
  交付凭据照抄前两者。最后是独立验收 `node src/cli.js` 一句 `Cannot find module` 才现形。

  判据 `checkContractPaths(tasks, exists)`（`shared/zone-coverage.ts`，纯函数、零 IO）：

  - 义务**只认任务自己的 description** —— 执行者拿到的是那段文字，PRD 或别人的描述里点名不算它的活儿；
  - 复用 `extractDeclaredPaths` 那套假阳防护（裸文件名如 `package.json`、`require/module.exports`
    这类代码概念、穿越与绝对形状都不算义务），**不另起第二个散文解析器**；
  - **归属不唯一就不判**（两个 zone 都认领 ⇒ 记 ambiguous）—— 误判的代价是一整轮修预算白烧；
  - 只判**存在性**，不判内容（内容对不对是 smoke / 验证那两层的职责，这里连文件都不读）；
  - 缺失 ⇒ 任务从 ok 翻成 `failed`（`errorClass=contract`），`logDigest` 直接点名
    "交付里是等价布局 `src/core/csv/index.js` —— 目录 + index **不等于**契约点名的文件"，
    下一轮执行者看到的根因就是这个；同时从 `allDone` 摘掉，否则重修轮会把它当已完成跳过。

  位置在 VERIFICATION **之前**：缺文件是"这个任务没做完"，不是"验证命令红" —— 放在之后就会表现成
  一条不归属任何 zone 的测试红。宿主两端都接了探针（`platform.ts` 默认 `existsSync`，
  headless 可注入假探针）；**没接探针时日志明说"这一轮没有执行"**，一条可核路径都没有时
  明说"什么都没检查" —— 不许静默给绿。

  判据侧的额外收获：变异门禁先判出一条**按构造不可达**的 `isProbeableRel` 守卫分支存活
  （提取器永远不会喂它可疑形状），按本仓口诀"答不上这支什么时候会走到就是死分支"
  **简化源码**而不是加白名单；那条保证改为钉在提取器上（新增性质用例）。
  另外门禁还指出原用例集每轮只喂得进**一条**路径，于是 `continue` 被换成 `break` 无人发现 ——
  补了三条多元素用例（先 out-of-zone 再 in-zone、先 ambiguous 再 unique、两条 gap 的排序稳定性）。

  实测：`zone-coverage.ts` 位点 21 → **29/29 全杀**、`orchestrator.ts` 51 → **55/55 全杀**，
  `SITE_BASELINE` 现值 **64 目标 / 1342 处位点**（`mutation:baseline` 无漂移）；
  `npm test` **1714 通过 + 9 跳过**（1723，61 文件收集）。

### 新增（交付凭据）

- **逐轮重修台账进凭据：`ReceiptTask.repairs`**（2026-10-07，审计「两套账打通」）。

  缺口：重修历史此前只活在 journal（`RunSnapshot.attempts`，按任务记次数）与事件流里 ——
  `attempts` 只说"派发过几次"，说不出**每一轮为什么没成**。而每轮的归因摘要
  （`repairOf` 里喂给执行器的那一份）**只在事件流里活一轮**，跑完就没了。
  2026-10-06 真实拆解端到端的负结果里，最花时间的一格正是"这一轮到底归因到了什么"。

  `shared/types.ts` 里的 `TaskState.repairHistory` 本来是这个形状，但它**自首版起
  零引用**（整个 `TaskState` 类型在全仓只有定义处那一行），接给它没有意义 ——
  所以真打通落在**有消费者的那一面**：`ReceiptTask`（交付凭据的逐任务账）。

  字段语义（每条 = 一轮重修）：

  | 字段 | 含义 |
  | --- | --- |
  | `round` | 第几轮重修（首轮不属于重修，不进这里） |
  | `reason` | **来路**：`上一轮验证未通过` 或 `上一轮该任务未派发成功` —— 两者排查路径不同（看归因摘要 vs 看执行器/沙箱），合并成"重修"就丢了这一半信息 |
  | `errorLogDigest` | 这一轮喂给执行器的归因摘要（按 zone 归属后那份） |
  | `dispatchedAt` | 派发时刻（ISO） |

  两条纪律沿用既有口径：**缺席 ≠ 空数组**（一次就过的任务连键都不出现 ——
  空数组分不清"没修过"与"修过但记录丢了"）；`attempts` 与 `repairs` 是**同源的两份事实**
  （前者含首轮，后者只含重修轮），对不上不是 bug。

  测试 3 条 + 反向注入：删掉 orchestrator 里那个 `list.push(...)` ⇒ 其中 2 条当场红
  （第 3 条断言"缺席"，注入后仍绿是对的）。

  **半步未做（明写）**：桌面看板**没有**渲染 `repairs` —— 凭据里有、界面上看不见。
  补渲染要动 `BoardPage` 的任务账区块，独立一轮。

### 新增（门禁）

- **新增 `check:exhaustive`：映射表与穷尽 switch 必须逐档登记**（2026-10-06，审计「第二十轮」第一项）。

  起因写在 `docs/2026-10-05-full-audit.md` §7：那张"分类点全表"是**手抄的**，人会漏。
  第一步是把其中一类点变成可枚举的判据 —— **凡是以联合类型为键的映射，键/分支数必须等于联合成员数**。

  为什么 tsc 不够：`ERROR_CLASS_LABEL` 那类声明成 `Record<Union, string>` 的表，缺键**编译错**，
  tsc 已经兜住；但 `remedyFor(mode: ArbitrationMode)` 是 **switch + default** ——
  新增第 5 档仲裁模式会**静默落到 default**，tsc 不报错、变异门禁看不出来（那条分支活着）、
  单测也不红。`default` 恰恰是掩盖点：**"没覆盖"被写成了"覆盖其余一切"。**

  判据（`scripts/check-exhaustive-maps.mjs`，用 TypeScript 编译器 API 取真联合成员，不靠正则猜）：

  - 映射表：`const X: Record<Union, …> = {…}` 的键集合 ≠ 成员集合 ⇒ 红（**键多了也算**：
    表里留着一个类型里已经没有的成员）；
  - 穷尽 switch：`case` 字面量没盖住全部成员 ⇒ 红；有 `default` 额外标一行「被 default 吞掉」；
  - 联合**含非字符串字面量成员** ⇒ 整体跳过并在 `--list` 里列出，不做"部分判定"；
  - 同一文件被多个 tsconfig 包含（`electron/` 就进了两份）按 `文件:行` 去重；
  - 命令串**带 `--selftest`**（同 `check:scripts-wired` 的做法）：4 例 fixture 先证明判据自己有效
    （漏一档 ⇒ 红 / 补齐 ⇒ 绿 / 表漏一键 ⇒ 红 / 对齐 ⇒ 绿），通过后接着跑全仓。

  **首跑命中 2 处，都修成了显式登记（行为零变化）**：

  - `electron/engine/batch-guard.ts:421` `remedyFor` —— 四档仲裁里**只有 `deny-all` 没写 case**，
    靠 default 拿到 `"fail-batch"`。动作恰好是对的（deny-all 的承诺就是"保留文件、整批判失败、
    不回滚"），所以**它不是缺陷，是巧合**：将来新增第 5 档会同样静默拿到 fail-batch，而那一档
    未必该是这个动作。
  - `src/App.tsx:27` —— `projects` 是默认页，只写在 `default` 里 ⇒ 将来新增 page 会静默渲染成项目页。

  ⚠️ **它管的是登记，不是行为**：把 `case` 写出来与让它掉进 default **运行时完全等价**，
  所以任何单测都不会变红 —— 证明它有效的只有两条：`--selftest` 的 4 例 fixture，
  和**删掉 `case "deny-all"` ⇒ 本段红并精确点名**（实测 exit 1）。

  **实测**：全仓修完后 0 命中、跳过 20 处（诚实标注：那 20 处的联合含非字面量成员，本判据不判）；
  链从 28 段 → **29 段**，四份文档（README / CHANGELOG / SKILL.md / `references/gates.md`）同批同步。
  顺手修掉 `SKILL.md` 里一个过期用例数（1694 → **1723**）。

- **`check:field-orphans` 从 `shared/` 扩到全仓导出接口，并新增「白名单失效也红」**（2026-10-06，审计「下一批」第二项）。

  审计原话是"两处没有 `shared/` 那样的公共契约地位，判据要另想"。所以先**量再改**：

  - 逐个目录量化（`--scan=electron` / `headless` / `src`）：**三个目录都是 0 命中**
    （electron 80 个 `export interface`、headless 11、src 13）⇒ 扩面不会新增假红；
  - **反向注入证明判据在新目录里仍然咬得住**（`0 命中` 也可能意味着"瞎了"）：
    往 `SaveManifestResult` 里塞一个没人读的可选字段 ⇒ 当场报出来；已还原。

  同批加**白名单失效检测**（与 `check-unwired` 的「豁免表项失效也红」同一条纪律）：
  ACCEPTED 里每条都写着"谁会读它"，若哪天真的接上了消费者、或字段被改名删掉，
  那条理由就过期了 —— 一个只增不减的白名单最后会变成"门禁绿得毫无信息"。
  两种失效形态各做了一次反向注入（指向不存在的字段 ⇒ 红；指向明明有消费者的
  `FileChange.op` ⇒ 红），均已还原。

### 修复

- **失败类别（`errorClass`）的值域收成一个类型 —— 此前它有 4 份互不打招呼的声明**（2026-10-07）。

  | 位置 | 值域 | 约束 |
  |---|---|---|
  | `shared/agent-contract.ts` `AgentRunResult.errorClass` | 6 档 | TS 联合 |
  | `electron/audit-log.ts` `classifyFailure` 返回值 | 8 档 | **返回 `string`，无约束** |
  | `electron/engine/scheduler.ts` `DispatchOutcome.errorClass` | 任意 | **无约束** |
  | `src/pages/BoardPage.tsx` `ERROR_LABELS` | 8 档（手抄） | 无约束 |

  代价不是理论上的：**引擎自写的 `contract`（契约路径违规，见上面 10-06 那条 Stage 3.5）
  不在任何一张表上**。它是 10-06 刚引入的新档，UI 词表写得更早 —— 中间这一段的衔接
  完全靠"有人记得"，而没人记得。于是这类失败在中文看板上走到
  `ERROR_LABELS[c] ?? c` 的兜底，吐出一个英文裸 token「contract」；
  偏偏那一档就是 10-06 真实拆解 e2e 里最花时间的场景。

  收口办法沿用本仓的老办法：**把手抄换成编译期事实**。新增 `shared/types.ts` 的
  `FailureClass`（9 档）+ 运行时值域 `FAILURE_CLASSES` + 边界收窄器 `isFailureClass`，
  四处全部引它。`BoardPage` 那张表改成 `Record<FailureClass, string>` 之后 ——
  **少一档就是编译错**。反向注入实测：删掉 `contract` 那个键 ⇒
  `tsc` 当场 `error TS2741: Property 'contract' is missing`（退出码 2）。
  以前这类漏登记要人工把两张表并排对照才能发现，现在编译器管。

  ⚠️ **值与类型之间刻意保留边界**：验证域那三档 `*-denied`
  （`VerificationReport.errorClass` 与 `routing.ts` 的 `ERROR_CLASS_LABEL`）**没并进来** ——
  它说的是"这条验证命令被沙箱/审批拒绝执行"，本 file 说的是"这个任务为什么没做出来"。
  合并会让"改代码有用"与"改代码没用"重新混起来，那正是 P2-3 当年要分开的东西。

- **用户选「终止」时的报错把派发次数念成了重修轮数**（2026-10-07，第十二轮的漏网之鱼）。

  `orchestrator.ts` 手上是**派发次数**（含首轮），而同一次失败交给 `stallReasonFor`
  的是 `maxRounds`（重修轮上限）。两个数量纲差 1，旧文案 `重修 ${attempts} 轮后仍未通过`
  直接把前者灌进了后者那个词。

  最刺眼的复现是 `maxRepairRounds: 0` —— **一次重修都不许有**的运行，终止时报的却是
  「重修 1 轮后仍未通过」，而同一处的另一句话说「重修 0 轮」。

  讽刺的是，就在上方 3 行处的注释（:900-904）**自己就写着**
  "`round + 1` 是派发次数口径，别把它当重修轮次"。第十二轮修的是升级弹窗
  （`shared/prompts.ts`，今天已有 `prompts.test.ts:114` 钉住），这一处漏了。

  改法不是换个变量，是**把两个量纲都写出来**：「已尝试 N 次（重修上限 M 轮）」。

- **`errorClass` 的边界收窄从来没有接上电 —— 未登记的值（包括非字符串）直写进联合类型字段**（2026-10-07）。

  `BoardPage.tsx` 的注释白纸黑字写着"值已在边界经 `isFailureClass` 收窄"，
  而**收窄器 `isFailureClass` 一直零调用者**。链路每一环都读过：

  ```
  electron/ipc/context.ts:324   outcome.errorClass（联合类型）
    → IPC 事件（序列化成 JSON，运行时不再有任何类型）
    → src/store.ts:414           errorClass?: string                ← 收窄器缺席
    → src/store.ts:430           next.errorClass = errorClass ?? "unknown"  ← 无检查直写
    → src/types.ts:60            errorClass?: FailureClass         ← 声称是联合类型
    → BoardPage.tsx:175          ERROR_LABELS[c] ?? c                ← 兜底吐裸 token
  ```

  实测经真实 `handleEvent` 喂进去：

  ```
  >>> TaskView.errorClass = "quantum-flux"
  >>> 非字符串时 TaskView.errorClass = 42
  ```

  **第二条更要紧**：连"是不是字符串"都没查。而这条数据来自审计 JSONL ——
  `electron/audit-log.ts:218` 是 `JSON.parse(line) as AuditRecord`，
  **旧版本写下的、被人手改过的一行都可能带出登记外的值**。

  `src/store.ts`（IPC 事件路径）与 `electron/board-derive.ts`（审计恢复路径）
  **是同一个缺陷的两个入口**，两处一起修成
  `isFailureClass(x) ? x : "unknown"`。

  `electron/board-derive.ts` 的 `DerivedTask.errorClass` 原先也声明成 `string`，
  一并收成 `FailureClass`（它同时修好了 `DerivedTask` 与 `TaskView` 不兼容的问题）。

- **收窄漏了第三个入口：`TrailRun.errorClass` —— 未登记的值会被印进给下一个执行器读的 prompt**（2026-10-07）。

  上一条修完两处之后，`TrailRun.errorClass` 仍是 `string`：它把 `AuditRecord.errorClass`
  原样搬进履历，而 `trailBriefForRepair` 会把 `${cls} × ${n}`
  **直接印进重修轮拼给执行器的那段文本**（`[前任履历] 这个任务之前被试过：…`）。

  与界面上的裸 token 同族，但更难发现：界面里的「contract」至少还有个人会看见、
  会报过来；prompt 里的 `quantum-flux × 2` **只有模型看得见**，
  而它拿一个没人登记过的词做不出任何判断 —— 履历那一句的全部价值是
  "换思路"，前提是它得知道**换过什么**。

  收窄同样发生在构造处（`taskTrail` 拼 `TrailRun` 时），类型一并收紧成 `FailureClass`。

  反向注入实测（把那一处改回 `record.errorClass ?? "unknown"`）：
  `src/board-derive.test.ts` 里「履历里的未登记 errorClass 归 unknown」与
  「压给下一个执行器的文本里不出现登记外的类别」两条**当场红** ——
  注意只回退**第一处**（履历）时红的正是这两条，只回退第二处（`deriveBoardView`）
  时红的是另外两条：两个入口各自有自己的判据，不是共用一条。

- **把 `errorClass` 的值域收成一个类型之后，`tsc` 一回就点出两处没收窄的边界**（2026-10-07）。

  ⚠️ **说法要准：这两条报错不是 HEAD 上就有的红**。本轮开工前 `npm run verify`
  在 `18ee758` 上 EXIT 0，而 `typecheck` 正是它的第 2 段 —— 也就是说 HEAD 干净。
  那两条是**收紧类型之后当场冒出来的**，属于改造过程的中间态。把它们写成
  "HEAD 上本就红着"会让后来人误以为那段门禁早就失灵，与实测相反。

  真正的收获是另一件事：**收紧类型这一手本身就是探针**。它一次逮到三个点 ——
  `store.ts` 的事件路径、`board-derive.ts` 的审计恢复路径、
  `DerivedTask` 与 `TaskView` 两个 view 类型的字段不一致 ——
  而这三处此前**全仓没有任何测试会红**。

  第二条 `DerivedTask | TaskView` 不兼容一开始看着像"别人的历史遗留"，
  是它把第三个收窄点（`board-derive.ts`）牵出来的 ——
  **连续两条同源报错指向同一个概念时，别把第二条当噪音**，
  它通常就是第一条的另一半。

- **一次网络抖动会让 bridge 报出「成功、失败原因是资源、而且值得重试」三句互相矛盾的话**（2026-10-05 并档全表审计）。

  `http-bridge.ts:328` 原本是
  `...(run.lastError ? { errorClass: "resource", retryable: true } : {})`。
  但 `lastError` 记的是**轮询途中的传输异常**，而那里的处理是"下一拍重试"
  （见 `:224` 的 catch 分支）—— **它根本不代表这次 run 失败了**。

  实测真实 bridge：断连一次、之后正常完成（也就是一次普通网络抖动）产出

  ```
  status     = "completed"      ← 后来正常完成了
  errorClass = "resource"       ← 却说失败原因是资源问题
  retryable  = true             ← 还说值得重试
  终态事件    = "completed"
  ```

  引擎读到 `completed` 就认成功，同时把 `retryable` 记进重修账 ——
  **一次抖动被算成了"可重试的失败"**。

  判据改成 `run.lastError && run.status === "failed"`，与 `cli-agent.ts:374`
  （`lastKind === "failed" && run.exitCode === null`）**同源**：
  只有真失败才谈失败类别。**同一个仓库里，两处写着一个意思、却用着不同判据** ——
  这正是"查全表"才看得见的东西。

  ⚠️ 顺带**改判了一条把缺陷钉住的既有测试**：
  `轮询抛错时结果标成 resource/可重试` 断言的正是上面那个矛盾形状。
  它是照着实现写的、不是照着语义写的，所以一直是绿的。已改为
  `轮询抛错不落 errorClass —— 抖动过去就过去了，不该留痕`，
  并补三条守住另一侧（真失败该贴还得贴 / aborted 不贴 / 断连后完成不带）。

  **只加"别乱贴"的断言是不够的** —— 那等于允许"永远不贴"。
  反向注入里专门有一条 `③ 永远不贴`，它被"真失败才带 resource/可重试"咬住。

  反向注入 4/4；`electron/agents/http-bridge.ts` **38/38**；
  位点基线 **1344**。

- **serve 状态页把"跑完了但门禁没过"和"中途崩了"印成同一句话 `未交付 / 出错`**（2026-10-05 状态标签审计）。

  `STATUS_LABEL` 只有四个键，`done(passed=false)` 与 `error` 两种结局共用
  `failed` 这一个标签。实测真实 run 的第一种形状（**最普通的一种红**）：

  ```
  status=failed  outcome=blocked  rounds=1   tasks 1/1 完成
  页面顶上印的是：「未交付 / 出错」
  ```

  两个方向的错都在这里：

  - 跑完了却被说成"出错" ⇒ 读者去找**崩溃日志**，而实际上一切正常跑完、
    该看的是验证输出；
  - 真崩时也只印这句 ⇒ **崩了这件事被藏了起来**，两边看不出差别。

  修法：判据取**凭据存不存在** —— 有凭据说明引擎走完了正常收尾流程
  （`receipt` 事件先于终态到达），无凭据才是崩在中途：

  ```
  未交付（已跑完，门禁未过）      ← done(passed=false)，有凭据
  出错（中途异常终止）            ← error，无凭据
  ```

  注意「有凭据但随后 error」（崩溃在收尾之后）**仍按有凭据算**：
  那时凭据仍是对这次运行的完整描述。这条形状此前就有测试，
  但只断言 `s.status === "failed"`，**没断言标签说什么** ——
  `serveIndexHtml` 对这段标签**零断言**（`grep「OxCommander ·」` 无命中）。

  两种结局的真实 run 都验过（crash 场景靠给不存在的 `projectRoot` 让引擎在
  收尾前炸；否则引擎重修成功后会正常收尾、进不了"崩"的分支 ——
  这是本轮观察脚本的第二次自骗）。

  反向注入 4/4；`headless/serve.ts` **58/58**（原 55，新增 3 处位点）。

- **补上"可选宿主钩子缺席时连键都不给"的断言**（2026-10-05，源自 `e01d3c5` 留下的 2 处变异存活）。

  `headless/run-spec.ts` 里两处内联三元（`requestApproval` / `onTaskActivity`）
  **各自零断言** —— "键不存在"和"键存在但值为 undefined"在行为上分不开，
  所以把三元翻面这条变异存活了。

  这**不是随手写的防御**，两处各有语义：
  `requestApproval` 缺席 = **fail-closed 拒绝**，改成给 `undefined` 会让
  `"requestApproval" in callbacks` 变成 `true`，**fail-closed 被静默绕过**；
  `onTaskActivity` 缺席 = 不发心跳。同文件 `onRunComplete` 里
  `...(outcome.agentId ? {agentId} : {})` 是同一条契约。

  处置是**抽出纯函数** `optionalHostHooks()`（内联三元埋在一个七百行的
  `runSpec` 里，外部无从断言），并**断言 `in` / `Object.keys` 而不是值** ——
  光断言"值是 undefined"两种写法都能过。

  补 6 条，反向注入 4/4；`headless/run-spec.ts` **24/26 → 26/26**，
  位点基线 **1342**。

  ⚠️ 这两处**不是本轮改的文件**，来自本轮进行中落地的 `e01d3c5`，
  是别人代码上这条链第一次逐位点走到。首次复现时按第十五轮的惯例
  先怀疑是环境噪声，单独重跑确认稳定后才当真缺口处理。

### 勘查（负结果：判据不做成门禁）

- **探针：「注释里提到的符号必须在被注释的文件里存在」—— 精确率 0，不启用**（2026-10-08）。

  来自 `docs/2026-10-05-full-audit.md` §7 的「二十一轮首选」待办。起因是
  `BoardPage.tsx` 那句「值已在边界经 `isFailureClass` 收窄」而收窄器零调用者 ——
  注释断言了一件从未发生的事，没有任何东西会红。

  **先量化再决定**：142 个源文件里，反引号指称「全仓已声明符号」407 处，
  其中**该文件代码里没有这个名字**的 87 处（`foo()` 6 · `Type.field` 16 · 裸名字 65）。
  最严的 `foo()` 那 6 处**逐个看全是合法跨文件指称**（描述别处的方法 / 字段 / 契约名），
  精确率 **0/6**；真缺陷那一格（`isFailureClass`，裸名字档）埋在 65 条同形态命中里。
  1/87 的信噪比做成门禁 = 每天派 86 次假活，而维持它要靠一张必然腐烂的豁免表
  （本仓已经踩过 `check-unwired` 的 ACCEPTED 腐烂）。

  **那一处真缺陷后来是被两道已有的便宜判据抓到的**：`check:unwired`（运行时导出
  生产零调用）与收紧类型后的 `tsc`（点出三处没收窄的边界）。再补一道精确率 0 的
  近似，只是把这两道已经能回答的问题换个方式再问一遍。

  归档见 `docs/2026-10-08-comment-claims-probe.md`，探针留在
  `docs/evidence/comment-claims-probe.mjs`（可复跑，**不进 `verify`**）。
  待办队列里这条划掉 —— 留档是为了下一个看到它的人不用再试一遍。

### 门禁

- **新增 `check:field-orphans`：检测「只有生产者、没有消费者」的接口字段**（2026-10-05）。

  第十五、十六两轮抓到的两处缺陷（越权被 headline 降级、`outcomeOk` 只喂给入参）
  **都属于同一形状** —— 某个字段/事实没有任何消费侧看着。
  `check-unwired.mjs` 管"导出的**符号**有没有人调"，接口**字段**一直是它的盲区。

  扫 `shared/` 里导出的 interface 字段，凡在任何非测试代码里都没有读取点的即报错；
  已评审项写进 `ACCEPTED` 并须说明**谁**会读它。已接入 `npm run verify`。

  首跑存量 23 项，逐个查证后 **6 项为真**（全部是"从未被读也从未被写"的可选字段，
  且都在**首版提交**里、此后从未被动过）—— 处置是**显式接受并留下名字，不删**：
  `agent-contract.ts` 是跨进程契约，外部适配器可能正按这个形状读，而仓内 grep 看不见仓外。

  **写这条门禁时我自己把它写瞎了三次，三次都是"永远绿"，全部由反向注入抓出**：
  ① 字段声明自己算消费（`injectedOrphan: number;` 本身就是字面量命中）；
  ② 不认 ES6 简写（真实代码写 `{ …, checksFailed, … }`，既没点也没冒号）；
  ③ 照搬 `check-unwired` 的"同文件不算消费者"——**那条规则针对的是导出符号，
  接口字段完全不同**（`checksFailed` 正是同文件里 `receiptHeadlineFor` 在用的）。
  教训：**规则的迁移要看清"规则针对的是哪一类实体"**。

  反向注入 3/3。已知盲区（整体序列化出口的凭据字段）写进了脚本头部，没有假装没有。

- **新增 `check:doc-claims`：文档里那几个门禁数字改为**由命令现算**（2026-10-06）。

  「四同步」这条纪律（碰 `verify` 链要同改 README / CHANGELOG / SKILL.md / gates.md）
  在本仓**违反了三次**：2026-09-28 序号漂、2026-10-03 `smoke:target-range` 进了串却在
  gates.md 没有行、2026-10-06 这一批未提交改动往链里加了 `check:field-orphans` /
  `check:ipc-channels` / `check:mutation-targets` 三段时间而三处文档一处没跟。
  当场实测的漂移量：链里 **26 段**而 README 与本手册写 **23 段**，`SKILL.md` 里同时存在
  `20 / 20 / 19 / 20 / 23 / 23` 六种段数声明；`npm test` 现跑 **1694 通过 + 9 跳过**
  而 README 写 1589。**漂移的方向是「数字看起来比实际强」** —— 读文档的人会以为门禁比代码严。

  三条判据，真值全部来自命令而不是上一版文档：

  - 段数 = `package.json` 的 `verify` 切出的段数；三份文档里**每一处**「N 段」都要等于它
    （「第 9 段」这种序数引用与「B-1 段」这种名字碎片显式排除 —— 两条都是实测踩出来的）；
  - 逐段有名：链里每一段的脚本名必须在 README 与 gates.md 都被提到，抓「进了串却没写行」。
    段名按 **token 边界**匹配：`build` 是 `build:headless` 的前缀，纯 `includes` 会把只写了
    后者的文档判成两段都有行（与 `check-script-wiring` 2026-10-05 那次改严同族）；
  - 用例数 = 默认配置下 `vitest list` 的输出行数（现跑约 4s，收集不执行用例）；
    两份文档的「A 通过 + B 跳过」要一致，写了「合计 T」就必须 `T == A+B`。

  任一处**读不到**声明同样 FAIL（措辞改了而正则不匹配 = 这道门禁变成永远绿的摆设）。
  判据自身 31 例自测随 `verify` 一起跑；**反向注入 7/7** 加正向对照：段数漂、用例数漂、
  算术漂、清单漏行、措辞漂到读不到、历史数字紧贴「段」字、`verify` 串里出现重复段 ——
  逐条造出来都按预期变红，注入后逐文件哈希还原。

  顺带被这条门禁牵出的两处实物：gates.md 的逐段表从 `#0` 起**整表按串里真实位置重排**
  （此前 `#` 是脚本序号、与位置差 1，README 与本手册各有三处序号已经漂过），
  并把所有「第 N 步 / 第 N 段」式交叉引用改成脚本名引用；`check:scripts-wired` 的自测例数
  文档写 8 例、实物 13 例。

  **写这条门禁时踩到的两个坑，都记进了判据**：① 讲历史时把旧数字紧贴「段」字
  （「停在 23 段」）会被当成一处声明 —— 判据分不清你在陈述实物还是回顾历史，所以历史数字
  一律写成「停在「23」这个旧数」，这条既是失败信息也是自测用例；② 工作树文档是 CRLF，
  多行锚点批量替换要先按实际换行归一，否则 0 命中而你以为改成功了。

  它**不管**的：`CHANGELOG.md` 与 `docs/*.md` 里的历史数字（那是 dated 记录，改它等于伪造历史）；
  某一段的判据好不好；「门禁节里有一行」这种版式约束（版式是最常改的东西，绑上去会让判据天天误报）。

- **新增 `mutation:baseline` 进 verify：漂移守卫此前"有实现、无入口"**（2026-10-06，链 27 → 28 段）。

  `SITE_BASELINE` 的**实现**是真的（2026-10-05 补的 site 口径逐目标判定），但
  `npm run mutation:baseline` **不在 verify 链里**，而本机 verify 从不跑 site 口径
  （只有 `mutation:quick` 那个 aggregate 最弱档，它按自己的文件头"aggregate 口径不查基线"）——
  合起来的效果：**本机全绿的那一刻，恰恰看不出"新增了没人逐点验证过的位点"这件事**，
  要推到 CI 等完 `mutation-full`（28 分钟）才知道。这道检查约 1s、不跑变异，没有任何理由留在门外。

  顺带三件：
  - `site-baseline.mjs` 加 `--json`（targets / baselineSites / currentSites / drifted，
    有漂移时照旧 exit 1 —— 换个输出格式不能把判据松掉）；
  - `check:doc-claims` 拿它当第三类真值，于是 README 顶上那句变异规模现在也是核过的：
    实物 **64 个目标 / 基线 1330 处位点**，上一版还写着「最新一次全量 881/881（51 目标，
    2026-09-28）」—— 漂了一千多个位点。这是同一天里第三个「文档数字比实物弱」的家族
    （段数、用例数、变异规模），所以判据自测从 31 例涨到 **36 例**；
  - `mutation-check.mjs` 文件头那句"这个常量一直**只存在于注释里**（2026-10-05 核实…）"
    在实现落地后没同步，读起来像这条防线至今是假的 —— 已补上"2026-10-05 实现、2026-10-06 进链"
    两个时间点。**修好了缺陷却不改回那句自我否定，等于缺陷还在**（同一文件的另一处
    "aggregate 口径不查基线"也是这类：口径两边刻意不对称，现已写进实现处与 gates.md）。

  **反向注入 9/9**（`node scripts/doc-claims-injection.mjs`：新增「在册目标数漂」「基线位点数漂」两条）。
  这一轮还暴露了体检脚本自己的毛病：它的注入锚点原本写死 `**27 段**`，链加到 28 段之后
  三条用例同时 0 命中，报的是"构造没成立"而不是"判据失效"——**体检脚本也是数字的副本**。
  现在段数从 `package.json` 现算、用例数与合计从 README 现读、规模从 `site-baseline --json` 现取，
  派生失败就 exit 1，而不是把没跑成的用例算进通过数。

- **核实那 9 个永久 skip 的 smoke 用例：8 个确属该跳，1 个是门控误伤**（2026-10-08）。

  `sensenova.smoke.test.ts` 6 + `sandbox-llm-call.smoke.test.ts` 3，全部是
  `describe.skipIf(!enabled)`（`OX_SMOKE=1` 且 `SENSENOVA_API_KEY` 存在才跑），
  文件头已写明理由、429 SOP 与手动跑法 —— **剩下 8 个确属"真 API + 花钱"，该跳**。

  但其中 `catalog contains sensenova entry` 只查 provider 目录的三个常量
  （`baseUrl` / `defaultModel` / `apiKeyEnvVar`），**不出网、不花钱、不需要 key**，
  却被锁在同一个门控块里 ⇒ 这三条契约只有"恰好设了 key 的那次运行"才被检查，
  默认等于没有守卫。已把它移到文件末尾一个**非门控** describe，从此默认跑
  （反向注入实测：把 `baseUrl` 断言改错 ⇒ 红；恢复 ⇒ 1 passed / 5 skipped）。

  教训与 `check:field-orphans` 同族：**门控的粒度要跟着"这条用例真的需要什么"
  走，而不是跟着文件走** —— 一个文件叫 smoke，里面未必每条都该被门控。

- **`remedyFor` 的 `default` 加编译期穷尽断言：新增仲裁档位必须让 tsc 先红**（2026-10-08）。

  `switch + default` 是 tsc 的盲区（`check-exhaustive-maps` 的动机原文即此）：新增第 5 档
  `ArbitrationMode` 忘了登记 `case` 时会静默拿到 `default` 的 `"fail-batch"`，只有门禁
  跑起来才红。现在 `default` 里多一行 `mode satisfies never;` —— **编译期**即报
  `TS1360: does not satisfy the expected type 'never'`（反向注入实测：删
  `case "quarantine"` ⇒ 精确报错；恢复 ⇒ 干净；位点基线 1351/1351 无漂移）。
  刻意**不**用抛错的 `assertNever`：`default` 在运行时仍**可达**（`settings.json` 可被
  外部改写，`SettingsStore.load` 对字段零校验），非登记值要的是 fail-safe 兜底
  （保留现场、整批判失败），而不是把整条裁决链炸掉。

- **默认仲裁模式收成单一真源：`DEFAULT_ARBITRATION_MODE`**（2026-10-09）。

  清单（`docs/2026-10-09-duplicate-declarations.md` 第 2 项）落地的第一项：
  "默认用回滚"这件事此前在**三处各写一遍**字面量 `"revert-batch"` ——
  `DEFAULT_SETTINGS.arbitration`、`BatchGuard` 的构造兜底（`opts.mode ?? …`）、
  agent 层装配（`opts.arbitration ?? …`），互不引用。改默认值要记得改三处，
  而漏掉任何一处**都不会有任何东西变红**（三处值相同、测试照过）—— 清单里
  把它归为"只散落"型。现在三处都引 `shared/types.ts` 的
  `DEFAULT_ARBITRATION_MODE`。

  刻意**不动**清单里那几处常量重复（`maxParallelRuns` / `maxStdoutBytes` /
  `300_000`）—— 抽公共常量会引入反向依赖，欠账 #9 已记下原因。

  验证：四套 typecheck 干净（只剩另一条工作线的 3 个 readonly 错）、eslint 0、
  相关单测 256/256、位点基线 1351 无漂移、check:exhaustive PASS。生产代码里
  剩下的 `"revert-batch"` 只有逻辑分支判断（`if (this.mode === …)` 与
  `case …`），那些本就该写字面量。

- **默认 provider 池收成单一真源：`DEFAULT_LLM_POOL`**（2026-10-09）。

  清单第 11 项。"默认池 = sensenova 打头、amd-radeon 兜底"此前在
  `shared/providers.ts:214`（`DEFAULT_LLM_POOL`，与 `PROVIDER_CATALOG` 同处）与
  `shared/types.ts` 的 `DEFAULT_SETTINGS.llmPool` **各写一份**
  `["sensenova","amd-radeon"]`，互不引用 —— 换池子要记得改两处，漏掉一处
  **不会有任何东西变红**（值相同、测试照过）。现在 `DEFAULT_SETTINGS.llmPool`
  引 `[...DEFAULT_LLM_POOL]`：**拷一份**而不是直接引用，因为 `DEFAULT_LLM_POOL`
  是 `as const` 只读元组，而 `SettingsStore.load()` 出来的数组允许调用方原地改
  （污染防护仍然只靠 `load()` 的 `structuredClone`）。

  `shared/types.ts` 因此第一次出现了 import（此前零依赖）。`providers.ts` 自身
  零 import、且早就被渲染层引用（`src/pages/SettingsPage.tsx`），所以既不产生
  循环也没有新的打包面。

  **新增两条断言，各自反向注入验过**：`src/store.test.ts` 钉住默认池的**字面量**
  —— 只写"与 `DEFAULT_LLM_POOL` 相等"是不够的，两边一起漂移照样全绿；
  `electron/store.test.ts` 把"改 `load()` 出来的 `llmPool` 不污染进程默认值"
  这条既有防护补到 `llmPool` 上。反向注入（把 `DEFAULT_LLM_POOL` 收窄成
  `["sensenova"]`）：**两条新断言都红**，另有 5 条既有断言连带红 ⇒ 连锁是真的，
  改真源必然牵动默认设置。

  验证：四套 typecheck（headless / node 干净，根与 electron 只剩另一条工作线的
  3 个 readonly 错）、eslint 全量 0、相关单测 **235/235**、位点基线 **1351 无漂移**
  （65 目标）、check:exhaustive PASS。全量 `npm test` 本机 12 条红全在既有的
  三个环境敏感文件里（`headless-entries` 5 / `mutation-residue` 6 /
  `sandbox-journal` 1 —— 360 拦 spawnSync 与清理 hook 超时），与本次改动无关。
  用例数真值 **1750 通过 + 8 跳过（合计 1758，61 个文件）**，已同步 README 与
  gates.md（新增两条用例 ⇒ `check:doc-claims` 的数字必须跟着走）。

- **`SENSENOVA_MODELS_EXTRA` 核实：它是登记表，不是开关**（2026-10-09）。

  清单第 10 项原本标"待看：追加数组是事实上的第二份值域"。核实结论是**不是
  两份值域同时参与计算**：这个常量在生产代码里**零消费者**（`build-llm.ts` 的
  models 装配只认 `SENSENOVA_MODELS`），所以把 `kimi-k3` 填进它**不等于入池** ——
  它是"一份参与、一份只登记"，与第 2 / 11 项那种"改一处漏一处"不是同一类。

  真正的缺陷在注释：`SENSENOVA_MODELS` 上方那段让人"add it to `LLM_POOL_EXTRA`"，
  而 **`LLM_POOL_EXTRA` 这个符号全仓不存在** —— 照它做的人只会找到一个空名字。
  已改指真名，并在常量上写明"零消费者 / 要真启用属功能变更（欠账 #17）"。
  顺手校准 `references/architecture.md` 线路池一节的三处过时行号
  （`:144-150` / `:153` / `:155-162` → `:180-186` / `:200` / `:202-209`）。

  验证：eslint 0、llm-pool / failover / sensenova-api **123/123**、headless 与 node
  两套 typecheck 干净。行为零变化（纯注释与文档）。

- **升级策略收口：协议侧 4 档由桌面 5 档派生，加档由编译器抓住**（2026-10-09）。

  清单第 3 / 4 项。`"ask"`（弹窗等人）是桌面端独有的第五档，无人值守场景没有
  意义，所以协议只要 4 档 —— 这是**有意**的。但两个类型此前**毫无引用关系**：
  协议加一档，`shared/types.ts` 必须同改，而改漏了只有"运行时少一档入口"
  这一个症状，没有任何东西会红。

  现在协议侧 `EscalationPolicy = Exclude<EscalationPolicySetting, "ask">`（派生），
  并把协议的值域常量 `ESCALATION_POLICIES` 从**数组改成 `Record<Union, true>`** ——
  数组少一档 tsc 不红，`Record` 少一键**编译错**（与 `FAILURE_CLASSES` 同形状）。
  反向注入：给桌面侧加一档 `defer` ⇒ `headless/protocol.ts` 立刻报
  `TS2741: Property 'defer' is missing` ⇒ "加档必须同改两处"由编译器守着。

  同一批收掉的还有**默认升级处置的"只散落"**：`?? "ask"` 此前写在 platform 装配
  （`electron/ipc/context.ts`）与设置页下拉框（`SettingsPage.tsx`）两处、互不引用，
  现在都引 `shared/types.ts` 的 `DEFAULT_ESCALATION_POLICY`（与第 2 项同型）。

  **未做的那一半**（清单第 4 项 → 欠账 #18）：`SettingsStore.load` 对
  `escalationPolicy`（以及 `arbitration`）**仍然零校验** —— 配置文件里写一个不在
  值域里的值会一路带进引擎。要加兜底就两个字段一起加，别只做一个。

  验证：两条新断言各自反向注入验过 —— `src/store.test.ts` 钉
  `DEFAULT_ESCALATION_POLICY` 的字面量（改成 `"abort"` ⇒ 红）；
  `src/headless-protocol.test.ts` 把值域串**锚到串尾**（补上 `defer` 键之后 ⇒ 红 ——
  用 `toContain` 的话末尾加档会漏，这条踩过一次才改成正则）。
  四套 typecheck（headless / node 干净，根与 electron 只剩另一条工作线的 3 个
  readonly 错）、eslint 全量 0、相关单测 **295/295**、位点基线 **1351 无漂移**
  （65 目标）。用例数真值 **1752 通过 + 8 跳过（合计 1760，61 个文件）**，
  已同步 README 与 gates.md。

### 实测（真链路复证，不进门禁）

- **真拆解那一格跑了一次，结论是负的**（2026-10-06，`run-multiagent-e2e.mjs --real`，
  6 任务 / 2 批次 / loomy 桥 + 内置执行器 / 30 分钟墙钟，逐条见
  [docs/2026-10-06-real-decomposition-e2e.md](docs/2026-10-06-real-decomposition-e2e.md)）。

  **机制层全部按设计工作**，而且是当场看到的：`t5` 两轮"合格候选全部满载 → 本轮不派，
  等修复轮重派"（第三轮换到空闲线路后 `ok=true 364071ms`）；429 `tpm/rpm` 与一次线路超时
  → 冷却 30s 换线；`t1` 首次 `600020ms err=timeout`（执行器 deadline 真掐）；
  两次 `unauthorized-write` 被 `revert`（`tests/report.test.js`、`sample-edge.csv`）；
  基线归因照旧说破"1 条命令在本次运行开始前就失败"；per-agent 质量分进了路由分数
  （`t2` 因此从 sensenova 改派给 loomy）。真实 LLM 的**拆解形状也是合格的**：按模块切 zone、
  测试套排在 `deps=["t1","t2","t3","t4"]` 之后、还给样例数据写了字节级契约。

  **但这单没交付出去**：`t6`（测试套）三轮都"依赖未就绪，本轮跳过"⇒ `tests/` 始终为空 ⇒
  `node --test` 三轮 `test:败 exit=1`（不是代码错，是测试从未被交付），20:21 被 `--max-minutes 30`
  硬杀，事件流里没有 `done`/`receipt`。

  **独立验收又抓到一条引擎自己的验证看不见的真缺陷**：契约点名 `src/core/csv.js`，
  智能体交的是 `src/core/csv/index.js` —— **zone 合法、契约非法**；靶项目的 build/typecheck
  只做语法检查所以**过**，而我直接点它 `node src/cli.js <csv>` 就断在
  `Error: Cannot find module './core/csv.js'`。这是 09-19 那类"跨智能体契约漂移"的**第二次现形**，
  形状不同、成因同类，且两次都是独立验收抓到的，不是平台自己。

  **待决（要人定，我没替他选）**：堵这条缝有两个位置 ——
  ① 派发侧合规检查（任务点名的字面路径必须在交付清单里；成本近零，但会把
  `csv/index.js` + `require("./core/csv")` 这种等价布局判成违规，严不严是策略）；
  ② 验证侧加一条真加载冒烟（拦"过了语法但起不来"，但它是项目类型相关的，
  且会改 `verifier` 的语义与基线归因口径）。两个都要配 site 变异目标 + 摘保护差分证明。

  **不能推广成"平台交付不了"**：同日简单形状是真绿的（`smoke-fullchain.mjs` EXIT 0 / 约 2 分钟、
  6 条真实 API 用例 11.0s、独立边界 11/11，见下一条）。差别就在**多智能体 + 严格跨模块契约**
  这一格；`--hard` 档与"给 60 分钟能不能绿"都**没测**，不下结论。

- **2026-10-06 真跑：真实 SenseNova 执行器全链路通过，独立边界验收 11/11**（上一次记录在案的真实交付是 2026-09-19）。

  三条实测，都是当场命令输出，不是文档抄文档：

  ```
  OX_SMOKE=1 npx vitest run src/sensenova.smoke.test.ts  → 6 passed，11.0s
      deepseek-v4-flash / sensenova-6.8-flash-lite / glm-5.2 连通性、
      chatJson → parsePrd 的真 JSON、整池 failover 各一次真请求
  node scripts/smoke-fullchain.mjs                        → EXIT 0，约 2 分钟
      两个任务都「第 1 次」就 done（本轮没有触发重修轮），
      基线验证明说「1 条命令在本次运行开始前就失败（不是智能体造成的）：test(exit=1)」，
      终态 build=true typecheck=true test=true，产物落在真实临时目录并被独立复跑
  独立边界验收（我自己按契约造的输入，不是智能体自写的那份测试）→ 11/11
      capitalize("") / capitalize("  spaced") / capitalize("éTÉ") / capitalize("1abc") /
      words("") / words("   ") / words("\tA\nB\r\nC") / words(" x ") …
  ```

  **为什么还要单独做那 11 条**：09-19 那次真跑出的缺陷正是「写代码的智能体自写测试自证」
  —— 交付实现把 `columnStats` 的行列口径做反，而它自带的 13 项测试全绿。这次特意用
  真实边界输入交叉验了一遍：**这一类没有复现**（`words` 那边它主动加了 `.filter(Boolean)`，
  空串与纯空白都回到 `[]`，是契约要的形状）。

  **仍然没证的那半，也是更要紧的那半**：`smoke-fullchain.mjs` 的任务计划是**硬编码**的
  （脚本自己注释着 "mirroring what decompose would produce"），所以真实 LLM 做
  **PRD → 任务 → 批次**这一段的拆解质量，记录在案的依然只有 2026-09-19 那一次
  （且那一轮 sensenova 侧预算耗尽、`cli.js` 由独立验收方手工补完）。要证它得跑
  `run-multiagent-e2e.mjs --real`：长跑、真实凭据、还需要外部桥真在跑。

  一次通过不等于稳定，所以这条**不是门禁也不该变成门禁**（要花钱，且账号级 429 窗口
  由不得 CI）。它证的是「管线 + 真实执行器 + 真验证」到今天仍然成立，不是「拆解可靠」。

### 工具事故（不是缺陷，但差点丢两轮工作）

- **`git checkout --` 抹掉了第十五、十六两轮的源码修复**（2026-10-05）。

  查门禁 bug 时用它"撤销注入"，实际撤销的是**相对 HEAD 的全部差异**。
  `conflictPart`、`outcomeOk` 字段、"验证命令未通过" 全部消失，
  **测试全在、源码全没了** —— 靠 `tsc` 报
  `Property 'outcomeOk' does not exist` 才暴露（运气：改动恰好被测试引用）。

  规矩写进了注入脚本头部：**`finally` 的恢复只许写回自己读进来的那份字节，
  绝不许碰 git** —— git 恢复的是 HEAD，不是"我进来时的样子"。

### 修复

### 门禁观察（非缺陷，但值得记）

- **`npm run verify` 没有"整体变慢 ⇒ 可能是环境问题"的判断**（2026-10-05）。
  一次跑 **42 分 01 秒**（平时 ~17 分）并 EXIT 1，两条用例各耗时 2485 秒；
  单独重跑是 **0.7s / 2.6s** 通过，两个文件都不在改动里。
  其中退出码那条实得 `[2,3,4,5,null]` 而非 `[0,2,3,4,5]` ——
  **`null` = 子进程被信号杀掉**，是负载掐断，不是逻辑错。

  处置顺序：**先看耗时 → 单独重跑隔离 → `git status` 确认失败文件不在改动里**。
  第 3 步最易被跳过 —— 人的默认假设是"我刚改的东西坏了"，
  而这次恰恰是**没改的东西坏了**。

  2.5 倍的耗时信号就摆在输出第一行，但输出被 `Tee-Object | Out-Null` 吞掉了。
  真要根治，该在 `verify` 脚本里加一条"耗时异常 ⇒ 提示可能是环境问题"的告警。

### 修复

- **凭据里 `status: "failed"` 与 `tasks[].outcomeOk` 缺席同时出现 —— 而后者这个字段压根没在类型里**（2026-10-05 分流审计）。

  第十五轮抓到"分类对了但对外表述丢了"。这轮顺着查下一个分类面：
  失败 / 跳过的分流。真实 run 一抓就中：

  ```
  tasks[0] = {"id":"A","status":"failed","attempts":2,"agentId":"c-bridge",
              "durationMs":89,"errorClass":"timeout"}
                                        ↑ 没有 outcomeOk
  ```

  根因在 `orchestrator.ts:459`：

  ```ts
  status: receiptTaskStatus({
    skipped: …, done: …,
    ...(outcome ? { outcomeOk: outcome.ok } : {}),   // ← 展开进了"入参"
  }),
  ```

  这个展开只参与了 `status` 的计算，**从没进过 `tasks[]`** ——
  而 `ReceiptTask` 里连 `outcomeOk` 字段都没有，所以 TypeScript **静默丢弃**，
  不报错。写那行的注释说"没有派发结果时不给 `outcomeOk`"，
  听起来是承诺，实际是**从没兑现过的承诺**。

  为什么没人发现：`grep outcomeOk` 全仓 6 处命中、**零消费侧**；
  已有凭据用例都只 `toMatchObject([...])` 断言 `status`/`agentId`，
  **没断言过任何"该出现/不该出现的键"**。

  为什么必须留着它：`status` 是四态归并结果，**丢掉了来路**。
  只有 `outcomeOk` 能区分"这次跑成了"与"上一轮跑成的、这次只是恢复" ——
  而这两者的排查路径完全不同。

  顺带补齐：`ReceiptTask.errorClass` 的文档写明"缺席 ≠ `unknown`"，
  因为看板 `store.ts:430` 会填 `"unknown"` —— 两套口径**不必统一**
  （看板要渲染，机器判读的原样更诚实），但差异必须可见。

  补测试时反注入 ④ 当场暴露了第二个缺口：凭据里的 `tasks[].attempts`
  **没有任何直接断言**（只有 journal 快照有），一并补上。

  反向注入 4/4；`electron/engine/orchestrator.ts` **51/51**。

- **凭据在非成功出口上整句不提越权：智能体改了 zone 外的文件，headline 一个字都不说**（2026-10-05 conflict 账审计）。

  第十五轮盯两条：恢复路径的另一半（**恢复会不会重跑已完成的任务**）与
  **conflict 链**（越权 → 仲裁 → `conflicts[]` → `counts.conflicts`）。

  前者**查出来是好的**（journal 里 A 已 `allDone`，第二趟真实派发 `[]`）。
  后者的两条账也都对：`counts.conflicts=1` == `conflicts[].length=1`，
  两种仲裁模式（`revert-batch` / `quarantine`）都检出了
  `unauthorized-write` + `package.json`。

  **但 headline 整句里没有它**：

  ```
  未交付：0/2 个任务完成，1 个失败、1 个未启动。改动已留在工作区，未通过门禁
  ```

  根因：`conflictPart` 只挂在 `delivered` 那条尾巴上，而 `blocked` 那条
  从来不带它。读者据此会当普通失败去看测试日志 —— 而真正发生的是
  "智能体试图改 zone 外的文件"。这是**安全事件**，不是交付瑕疵，
  不该只在成功路径顺带提一句。

  顺带补上第三条出口：`已交付但未经构建/测试验证` 那条同样漏了
  （同一处疏漏的两个面，是**断言**先发现的：我按"三条出口都要说"写完
  断言，它当场把这条抓出来——我只想着 blocked 和 delivered）。

  修后（真实 run 实测）：

  ```
  未交付：0/2 个任务完成，1 个失败、1 个未启动；发生 1 次越权并已处置。改动已留在工作区，未通过门禁
  ```

  反向注入 5/5；`shared/delivery-receipt.ts` **43/43**。

### 调查（无缺陷，但钉住了承重行为）

- **断点续跑：取消时烧掉的轮次会丢——查下来其实没丢**（2026-10-05 断点续跑审计）。

  上一轮修的是"重修 3 轮（上限 2）"那个量纲错配。这轮盯它的上游：
  **`attempts` 跨 run 到底接不接着算**。

  **静态读代码看像个缺陷**：`attempts.set()` 在派发前（`orchestrator.ts:635`），
  而 `save()`（落盘）只在**批次跑完之后**（:691）—— 于是"批次跑到一半被中止"
  ⇒ 那次派发从未落盘 ⇒ 恢复后从头算。第一版我正是这么判的，还准备去加 `save()`。

  **真跑一次（假桥挂住 + `POST /cancel` + 直接读 journal 文件）推翻了它**：

  ```
  派发中：journal = {"attempts": {}, "round": 0, "allDone": []}
  取消后：journal = {"attempts": {"slow": 1}, "round": 0, "allDone": []}
  恢复后：凭据 tasks[].attempts = 2   ·   真实派发 = 2 次
  ```

  关键在 `cancel()` 会调 `abortInFlight()`：它让在跑的批次**以 cancelled 收场
  而不是悬着**，于是控制流照常走到 :691，`attempts` 落盘了。

  所以那条 `save()` 是**承重的**，不是冗余。补了两条断言把它钉住：

  - 取消后批次收场时，`journal.attempts` 记着这次派发（少记 ⇒ 预算被遗忘）；
  - 计划快照里 `attempts` **是空的**（多记更糟：会让上限判断偏松）。

  反向注入 2/2 —— 两条断言都真咬得住（删掉 :691 的 `save`、或给计划快照
  预写派发数，分别被各自那条抓住）。

### 修复

- **升级弹窗印出一句不可能成立的话：「重修 3 轮（上限 2）」**（2026-10-05 多轮审计）。

  前两轮采样都只跑了 0–1 轮重修，而"轮次相关的数字"恰恰最容易互相对不上。
  造一个走满多轮的 agent 之后，实测输出：

  ```
  escalation：任务「唯一任务」重修 3 轮后仍未完成（上限 2）
  tasks[].attempts = 3     rounds = 2
  ```

  根因是**两个数字量纲不同**：`attemptsSoFar` 是**派发总次数**（含首次），
  `maxRepairRounds` 是**重修轮数**（不含首次）。并排印就必然差 1。

  而用户正是照这两个数判断"还剩没有机会再试一次" —— 一句自相矛盾的话
  会让他以为自己还有一轮预算，或者以为已经超支。

  改成同一口径：`已尝试 3 次（首次 + 重修 2 轮）（还能再重修 0 轮）`。
  顺手修掉一个边界：恰好用满上限时不再说"还能再重修 0 轮"，改说"已达重修上限 N"。

  **这条在 0–1 轮的测试里永远看不出来** —— attempts=1、maxRounds=0 时印出的是
  "重修 1 轮（上限 0）"，读着别扭但不含"超过上限"的荒谬。必须多轮场景才暴露。

- **凭据在最普通的一种"红"下自相矛盾：任务全做出来了、只有验证没过**（2026-10-05 凭据自洽性审计）。

  第十轮抓的是"凭据与它自己的 checks 打脸"。这轮换采样面：**凭据内部**的数字之间，
  以及 `headline` 与 `counts` 之间，讲不讲同一个故事。

  审计脚本起了六种形状的真实 run（真跑，不是构造对象），逐个核对 13 条不变量。
  抓到一处：

  ```
  counts = {"total":2,"done":2,"failed":0,"pending":0,"checksFailed":1,...}
  headline = "未交付：2/2 个任务完成，仍有任务未完成，重修 1 轮。改动已留在工作区，未通过门禁"
                                    ^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^
                                    任务全做出来了    却说还有任务没做完
  ```

  根因：`receiptHeadlineFor` 的 blocked 分支只从**任务账**里找原因
  （`failed` / `pending`），从不看 `checksFailed`。于是这个形状下两个数都是 0，
  兜底话术顶了上来——而它跟同一句前半截直接打架。

  **这不是边角**：`checksFailed>0 && failed==0 && pending==0` 是**最普通的一种红**
  （代码写完了，构建/测试没过）。而这条分支此前**一条断言都没有**——
  `grep「仍有任务未完成」` 零命中，`grep「条验证命令通过」` 同样零命中。

  修法：结论优先按验证说，因为那是"东西做了但门禁没过"——与"东西没做出来"
  是两回事，读者要据此决定下一步（改代码 vs 改配置）。三处都为 0 时才留兜底，
  且兜底话术改成"凭据里没有记录任何失败项"，不再与前半截矛盾。

- **一次真实交付里，三处对外表述互相打脸：都把"任务没做出来"说成"验证未通过"**（2026-10-05 运行时观察）。

  门禁和断言查得出"代码写得对不对"，查不出"同一时刻几个说法之间自相矛盾"。
  所以这轮不看代码，真起一次交付，把四个面（SSE 事件流 / `/state` / 状态页 /
  MCP `ox_status`）在**同一时刻**说的���排在一起看。观察到的真实输出：

  ```
  verification 事件 ×2，两次都 passed=true，results 里 ok:true exitCode:0
  log ×2：「警告：存在失败的开发任务，即使构建通过也不允许交付。」
  escalation ×2：「重修 2 轮后仍未通过验证（上限 1）」+ 摘要 "no agent available"
  receipt：checks[0].ok=true，同时 unverifiedReason="重修 1 轮后验证仍未通过"
  error："verification still failing after 1 repair rounds"
  ```

  死因是 `no-agent`（调度器没匹配到执行者）—— 项目文件压根没人动，基线本来就绿，
  于是验证**必然**全绿。而三处都把它说成"验证没通过"：

  | 位置 | 原文 | 问题 |
  |---|---|---|
  | `orchestrator.ts` exhausted 分支 | `重修 N 轮后验证仍未通过` | 与同一份凭据的 `checks[].ok=true` 直接矛盾 |
  | `VerificationExhaustedError` | `verification still failing…` | 进宿主日志与 SSE，读起来像验证命令挂了 |
  | `buildEscalationSummary` | `仍未通过验证（上限 N）` | **紧跟着下一行是 "no agent available"**，而用户正要照这三选一做决定 |

  最后一条最有害：用户会以为是代码坏了去选"重派"，于是又烧一整轮。

  引擎在 `orchestrator.ts:701` 自己就清楚这件事
  （"存在失败的开发任务，即使构建通过也不允许交付"），说明它**知道**两者不同，
  却没把这份知识带进凭据、错误和弹窗。

  修法：三处都按 `report.passed` 分成两种说法。验证全绿时明说"验证命令是通过的，
  卡住的是任务本身没做出来"。**class 名与退出码都不动**（它们是协议的一部分），
  只把话说准，并给 `VerificationExhaustedError` 加一个 `verificationFailed` 标志位
  供宿主分辨。

  顺带发现并改掉一条**测错了东西**的旧断言：`orchestrator.test.ts:2178` 的
  `toContain("验证仍未通过")` 配的引擎验证是**通过**的 —— 它一直绿，但绿得没有意义。

- **serve 形态没有中止入口，卡在等审批上的 run 永远出不来（2026-10-05 横向比对发现）**。
  桌面形态有 `orchestration:cancel`，serve 形态只有 pause/resume。实测坏处不是
  "少一个按钮"，而是一个**卡死**：

  ```
  state.status = "idle"           ← 引擎还没挂上，pause/resume 都答 409
  等待审批 = ["git"]
  POST /pause → 409   POST /resume → 409   POST /cancel → 404（修复前）
  再 POST /run → 409 "已经有一个 run 在跑"
  ```

  也就是说：一个等审批的 run 在 serve 形态下**永远出不来**，而后续 run 全被 busy
  挡住 —— 整个服务只剩"有人去批准那条命令"这一条出路。桌面点一下取消就解了。

  修法与桌面对齐：`POST /cancel`，且**必须把挂着的审批 fail-closed 放掉**
  （`resolve(false)`，不是 `true`）—— "没人回答"绝不能读成"批准"，这正是
  `orchestration:cancel` 里 `abortAllApprovals()` 的纪律。

  三处设计要一起看，否则会从一个坑掉进另一个：
  ① **判据是 `busy` 而不是 `engine`** —— 按 engine 判的话，从来没跑过任何 run 时
  它恒为 undefined，`/cancel` 会报 200 "已中止"而它什么都没中止；
  ② **引擎不支持中止时答 501**，不假装成功；
  ③ **中止要连审批一起放，哪怕引擎已挂上**（这是我第一版的 bug）。

  状态页措辞也分开：暂停说"当前任务跑完就停"，中止说"**已请求中止**：正在跑的
  任务不会被掐断" —— "已中止"三个字要等引擎真在检查点停下来才配得上。

- **MCP 侧也补上中止：此前 serve 有了 `/cancel`，MCP 客户端仍然中止不了**（2026-10-05）。
  这是上一条的**下游**：`ox_control` 的 action 枚举只有 `pause` / `resume`，
  而 pause 在卡住时恰恰不生效（引擎还没挂上）—— 等于"用 MCP 驱动的人永远解不开
  那个死锁"。现在三个动作齐全，且**措辞各不相同**（pause 可恢复、cancel 不可恢复
  且不掐断正在跑的任务），答复里必须说清这三件事。
  `ox_status` 此前只认 `paused`，中止后客户端看到的是"状态 running"，
  **完全看不出有人点了中止** —— 现在会报"已请求中止"。

  schema 与实现的一致性也有断言守着：枚举里没有 `cancel` 而实现认它，
  客户端就永远发现不了这个能力。变异 `mcp.ts` 71→**77/77**。

- **MCP 入口把拼错的 `--serve-url` 静默回落成默认 8787，而且 stderr 谎报（2026-10-05）**。

  ```
  node dist-headless/headless/mcp-main.js --serve=http://127.0.0.1:9999
  → [ox-mcp] serve-url=http://127.0.0.1:8787（stdout 是协议通道，本行在 stderr）
  ```

  **这个坑是本仓库第四轮我自己踩的**（写错了 flag，文档写的是 `--serve-url=`）：
  MCP 一路连默认端口，每个工具调用都失败，而我把矛头指向了 MCP 服务本身。

  原实现只 `find` 到就用、找不到就用默认值，于是 `--serve=` / `--serve_url=` /
  `--serve-url`（有 flag 无值）/ `--serve-url=`（空值）全部静默回落。最坏的一处是
  **它会照常打印 `serve-url=http://127.0.0.1:8787`** —— 那行 stderr 看起来像
  "我听懂了你的参数"，于是连"是不是我写错了"都很难怀疑。

  现在与 `serve-main` 的 `--port` 同一处置：拿不准就 exit 1 并说清实际收到的值，
  且非 http/https 也拒。**不给** `--serve-url` 仍是合法默认（本机 8787 是常规用法）。

- **serve 入口给了非法 `--port` 会静默回落成随机端口，还报"启动成功"（2026-10-05）**。

  ```
  node dist-headless/headless/serve-main.js --port=99999
  → OxCommander serve: http://127.0.0.1:58320/ （…）    # 端口变成随机数，exit 0
  ```

  `portFromArgv` 对"没给 `--port`"和"给了但非法"返回同一个 `undefined`，
  于是 `--port=99999` / `--port=abc` / `--port=` / `--ports=8080`（拼错）/
  `--port=8080x` 全部走同一条路：回落到端口 0（系统分配），照常打印启动横幅，
  退出码 0。

  为什么这条必须报错：`serve` 的契约是"我监听在你说的那个端口"。调用方拿到一个
  自己没选过的随机端口，之后每一步都连不上，**而服务自己看起来一切正常**——
  这正是第四轮 `--serve=` 那个坑的同构形态（拼错的 flag 不报错、静默用默认值、
  exit 0）。现在与本文件已有的 `runtimeGap` 分支同一处置：exit 1 并说清用户
  实际写的那个值。**不给** `--port` 仍然是合法默认（端口 0，且启动时打印真实端口）。

- **`argsTemplate` / `probeArgs` / `envTemplate` 现在校验占位符白名单（2026-10-05）**。

  这些模板渲染出的 argv 在 Windows 上会走 `cmd.exe /d /s /c`（`.cmd`/`.bat`
  shim 的硬约束），cmd 会**重新解析整行**；实测 `quoteForCmd` 的 `\"` 转义
  挡不住注入——参数 `say"hi&whoami` 里的 `&whoami` 真的执行了。所以 argv 的安全
  不能来自"把危险字符转义掉"，只能来自"**每个插进去的值都不是自由文本**"。

  而 `renderTemplate` 是 `vars[key] ?? whole`：**未知占位符既不报错也不留痕，
  原样 11 个字符进 argv**。实测给模板加一个绑到 LLM 文本的 `{{taskTitle}}`
  就静默开出一条注入路径（`.cmd` 路径下 `&` 真的执行），且**没有任何门禁会红**。

  现在 `manifest-schema.ts` 用**白名单**（不是黑名单）限定可用的五个占位符：
  `projectRoot` / `promptPath` / `taskId` / `runId` / `zone`——每一个都是生成物，
  逐条有据。未知占位符让整份清单被拒，理由里点名是哪个字段、哪个名字、允许什么。
  **不要**把 LLM 产出的自由文本加进来；传正文用 `{{promptPath}}`（任务书本来就
  该走文件，不该挤进 argv）。

### 门禁

- **新增门禁：改过的生产代码必须在变异 `TARGETS` 里，或在显式豁免表里**
  （`scripts/check-mutation-targets.mjs`，接进 `verify`）。
  `TARGETS` 表上面就写着"新文件必须显式入表 —— 漏挂 = 永远无人审计"，
  而我本轮改的三个文件**一个都没在表里**。漏挂的文件根本不参与变异统计，
  门禁照样报 PASS —— **而那个 PASS 对它没有任何含义**。
  与 `check-script-wiring.mjs`（写好的脚本没接进入口）是同一族缺陷，载体不同。

  判定不用"分支数阈值"猜哪些文件值得入表（启发式会被绕过），
  而是直接比对 **git diff × TARGETS**，防的就是"我改了它却忘了登记"这个动作本身。
  豁免表带失效检查（文件已删或已入表 → FAIL）：**腐烂的白名单比缺失的白名单更糟**。

  反向注入 4/4：漏挂 / 豁免失效 / 判据失配（改掉 `TARGETS` 的声明名）逐一证明会红。

  **它当场就回本了**：第一次跑就查出 `headless/receipt-verify-main.ts` 未登记
  （131 行，未入表文件里分支最多的一个，而它的退出码就是 CI 的判定），
  入表后暴露 3 处存活位点，补完 **8/8**。

- **新增门禁：preload 暴露的 IPC 通道必须与主进程注册的完全一致**
  （`scripts/check-ipc-channels.mjs`，接进 `verify`）。`electron/preload.ts` 的
  函数覆盖是 0%（被 import 但转发函数从未被调用），而它是渲染进程与主进程之间
  唯一的 API 表面。四个判定：preload 引用了没人注册的通道（渲染端一调就永远
  reject）、主进程注册了但 preload 没暴露（功能**静默不可用**，UI 上只是"点了没
  反应"）、同一通道 invoke 或 handle 多次，以及**读不到任何一侧必须 FAIL**
  ——解析失配当通过就是一道永远绿的摆设。

  今天实测 30/30 精确对应、无漂移，所以这不是修 bug，是**补一个守住不变量的
  守卫**。反向注入 6/6：五种失败模式逐一注入、逐一证明会红。

- **receipt-verify 的五档裁决 → 退出码映射表此前一处断言都没有**（2026-10-05）。
  `auditReceipt` 的五档在 `delivery-receipt.test.ts` 里测得很细，但
  **verdict → exit code 那一段完全没测** —— 而它的退出码就是 CI 的判定，
  文件头明写"每一档对应一个不同的处置，刻意不并档"。
  后果举例：把 `unsigned` 也报成 3（tampered）不会有任何测试变红，
  下游读到的却是"凭据被改过"，处置从"补盖章"变成"查差异来源"，方向直接错了。

  现在五档全部**真进程端到端**验证（0 / 2 / 3 / 4 / 5），外加一条
  "五档互不重叠"的机器检查（把五种情形的退出码收齐断言两两不同）——
  这是把文件头那句"不许并档"变成可执行断言。变异 **8/8**。

- **SettingsPage 的密钥写入/清除两处补上契约注释**（2026-10-05）。
  注释密度从 2.3% 到 5.4%。补的是"读代码第一反应一定猜错"的地方：
  `clearKey` 的**删除 = 用空值再存一次**（没有独立 delete 通道，
  因为删除与写入共用一条路径就不存在绕过审计直接抹掉的可能），
  以及 `handleSaveKeys` **过滤空串是刻意的**（清空输入框不等于删除密钥，
  否则用户只是把光标删干净就丢了盘上的凭据）。
  没有为了凑密度给自解释的代码加注释。

- **两个 headless 入口接入变异门禁，暴露 9 处真实断言缺口（2026-10-05）**。
  `headless/mcp-main.ts` 与 `headless/serve-main.ts` 此前不在 `TARGETS` 里 ——
  按该表的注释"新文件必须显式入表，漏挂=永远无人审计"，本轮的修复当时**没有被
  任何变异验证覆盖**。入表后逐位点跑，立刻暴露 9 处存活：空行没被跳过、非法
  JSON 没被忽略、`--port` 的 `||` 三条件只会触发其一、continue→break 会丢掉后续
  所有消息……全部补断言后：

  | 文件 | 结果 |
  |---|---|
  | `headless/mcp-main.ts` | **10/10** |
  | `headless/serve-main.ts` | **17/17** |
  | `electron/ipc/orchestration.ts` | **8/8** |

  其中 `onEngine` 那一处抽成了纯函数 `onEngineOption`：它原先内联在 `main()` 里，
  只有服务**真的在跑一个 run** 时才求值，而没有可用 LLM 的机器上那次 run 几百毫秒
  就结束（实测连续 11 次 `POST /pause` 全是 409），端到端根本够不到它。要端到端
  就得配真密钥，那在离线 CI 里必然失败 —— **假绿比缺测试更糟**。语义一字未改。

- **`coverage/` 没有进 `.gitignore`，`git add -A` 会把整个覆盖率产物收进去**
  （2026-10-05 全方面体检发现）。`.gitignore` 忽略了 `dist*` / `release/` /
  `logs/` / `.env`，唯独漏了 `coverage/`，而 `npm run test:coverage` 每次都重写它。
  已补上（带理由注释）。

- **serve 状态页：有审批在等时，实时事件流被追加进审批列表（2026-10-05 第四轮）**。
  页面脚本用 `document.querySelector("ul")` 取事件列表，而页面上有两个 `ul`：
  有审批在等时**先渲染的是审批列表**，于是新事件被追加到那里，与「批准 / 拒绝」
  按钮混在一条列表里。这页存在的唯一理由是「离开工位也能看一眼」，事件流落到
  别人的列表里正是它最不该出的错 —— 而它恰好只在**有人在等审批**时出错，也就是
  最需要你看清发生了什么的时候。

  jsdom 实测复现：一条 `LIVE-EVENT-FROM-SSE` 落在 `ul[0]`（approvals）里，
  而审批列表本该只有 1 条 `<li>`。改为两个列表各自带 class，脚本按
  `ul.events` 选取。回归测试**在 jsdom 里跑页面自己的 `<script>`**
  （断言 HTML 字符串只能证明 class 写对了，证明不了脚本按 class 选中了），
  并反向注入验证：把选择器改回 `querySelector("ul")` → 该用例转红。

- **`mutation-check` 承诺的 `SITE_BASELINE` 从来不存在（假承诺转成真防线）**。
  文件头从 2026-09 起写着「位点数与 SITE_BASELINE 不符 → exit 1（新增位点没人
  逐点审计过）」，而全仓 4 处提及**全是注释** —— 代码里没有这个常量。后果是
  "每个位点都验过了"这句话在源码改动后失效：往变异目标里加 3 个新 `&&`、
  没人重跑审计，门禁仍对着旧的 18 个位点报「全部 18 处已逐点验证」，新加的 3 处
  从未被单独验证过。

  现在 `site` 口径下比对每个目标的位点数，**只增不减**（位点变少是重构或等价
  变异收口，是好事），漂移即 exit 1 并打印基线值与当前值；确认新位点全杀后
  `npm run mutation:baseline:write` 更新基线。新增 `scripts/site-baseline.mjs`
  与 `mutation:baseline` / `mutation:baseline:write` 两个 npm 入口。

- **`check-unwired`：注释里提到符号名就算"已接线"**。原先拿 `word.test(原文)`
  打整份文件，于是 JSDoc 里写一句某个 helper 的名字就足以把它从"生产零调用"
  里洗白。实测 291 个导出里 **22 个**是这么被放过的 —— 其中
  `topologicalSort` / `CycleError` 只因 `shared/graph.ts:11` 的一句注释就算已接线，
  而它其实接在同文件 78 行（靠同文件内部引用那条规则），跟注释毫无关系。

  现在判定一律在**挖掉注释与字符串**的文本上做（复用 mutation-check 的
  `maskNonCode`，不另写第二份）。顺带修出一个真问题：改严后
  `shared/deliverable-format.ts::parseDeliverable` 被判死码，实则
  `scripts/loomy-bridge.mjs:149` 在真实消费它 —— 根因是 `scripts/` 不在扫描范围，
  那类"经 scripts/ 桥消费"的导出对门禁不可见。已把 `scripts/` 计入**消费侧**
  （不计入定义侧，否则本门禁会把自己提到的名字算成导出）。结果：未接线导出
  10 → **3**（全部已评审接受），并清掉 6 条因"桥消费"理由长期躺在白名单里的
  失效条目 —— 留着会让下一个人以为"白名单 = 已评审 = 没接线"。

- **`check-script-wiring`：注释里的脚本名仍算"已接入"**。边界匹配（避免
  `heck.mjs` 被 `mutation-check.mjs` 洗白）此前已修好，但注释这一半没修：
  实测 **17 条**引用边只靠注释成立，写一句"参见 x.mjs"就能让孤儿 x.mjs 永远
  "已接入"。现在在**去掉注释**的文本上判边。刻意**不**复用 `maskNonCode` ——
  它也挖空字符串，而 `spawn(node, [path.join(root, "scripts", "x.mjs")])` 里的
  名字就在字符串里，那是真接线（直接用 masker 会把三个 IT 脚本误判成孤儿）。
  自测从 8 例扩到 **13 例**，含"字符串里的 `//` 不是行注释"这类边界。

- **smoke 测试的 skip 门控无人看守**。9 个 skip（`sensenova.smoke.test.ts` 6 个 +
  `sandbox-llm-call.smoke.test.ts` 3 个）需要 `OX_SMOKE=1` 与真 key，**该**跳过。
  但把 `describe.skipIf(!enabled)` 改成 `describe` 不会让任何门禁变红，只会让
  `npm test` 在有网的机器上开始消耗真实额度。`check-tests-collected.mjs` 新增
  一项：`*.smoke.test.*` 必须有 `skipIf(` 且条件引用了 `process.env`。

- **zone 互斥的同 tick 漏检：一份越权写入可以被完全漏掉，且批次照常判 ok
  （2026-10-05 全量测试发现的最高危缺陷）**。`FileJournal.changed()` 判"文件是否
  被改"只看两个廉价信号：`size` 与 `mtimeMs`。但文件系统时间戳有分辨率（本机
  NTFS 实测约 1ms），`begin()` 与智能体首次写入**落在同一个 tick** 时，两个信号
  全同 → 判"没变"。后果不是"少报一次变更"：zone 外的越权写入因此既不会被裁决、
  也不会被回滚，而批次仍然以 `ok=true` 交付 —— 互斥在最需要它的场景下静默失效。
  实测漏检率约 **75%**（等长改写，立即写入场景 150 次试验）。

  修复用两道互补的措施，而不是只加一道：

  1. **基线拍摄后等一个时钟刻度**（`SETTLE_WINDOW_MS = 5`，可用
     `settleWindowMs: 0` 关掉）。让基线时间戳先"变旧"，之后任何写入的 mtime 必然
     大于基线 —— 同一 tick 这条路被从根上关掉。实测把漏检从 74.7% 降到 0/150。
     等待用**自旋**而非定时器：目的是把时间戳变旧，不是让任务延后；且带迭代上限，
     冻结时钟（测试的 fake timers）下会立刻返回而不是把运行卡死。
  2. **摘要兜底**：只有当两个廉价信号判"相同"时，才对 **zone 外**的文件读内容
     比对摘要 —— 而"廉价信号判没变"恰恰就是同 tick 重写的样子，zone 外漏检是安全
     问题。摘要只在 `begin()` 时对 zone 外文件各取一次，zone 内的留在廉价路径，
     所以整批的内容读取量约等于"zone 外文件数"，不是"全树文件数"
     （实测：2000 文件 × 2KB 的树全量哈希要 236ms/批，只哈希 zone 外则接近 0）。
     `JournalStats.contentRead` 报告这一次实际读了多少个文件。

  代价是显式的：内容相同、只是 mtime 动过的重写仍会被记为 `modify`（容忍
  false positive，换掉整树哈希）；这在"mtime 真变了"的场景下由廉价信号就判出，
  不会额外读内容。

  端到端复现（`BatchGuard` + `SnapshotStore` 真实产物，60 次/档）：修复前同 tick
  `detected=0/60, restored=0/60`；修复后三个时序档全部 `detected=60/60,
  restored=60/60`。连带修掉一个测试抖动：`src/sandbox-journal.test.ts` 此前
  **12 次跑挂 6 次**（50%，报 `expected [] to include 'package.json'`），
  根因就是它；现在 20 次连跑 0 失败。此前该抖动会让变异门禁一边打印
  `115/115（100%）` 一边判 `FAIL: 2 个目标的基线测试未通过`。

- **交付凭据带 BOM 时被判"读不了"（exit 1），复核能力在最常见的流转方式下失效**。
  `receipt-verify-main.ts` 直接 `JSON.parse(fs.readFileSync(...))`，而 `JSON.parse`
  不接受 U+FEFF。凭据是**给人看、给人转递**的文件：用记事本、PowerShell
  `Set-Content -Encoding UTF8`、Excel 打开再存回都会加上 BOM，于是同一份凭据仅差
  一个 BOM 就从 `unsigned`（4）变成"读不了凭据"（1）—— 而"任何持有者都能独立
  复核"正是这个工具存在的理由。现在复用 `electron/atomic-file.ts` 里已有的
  `stripBom`（该函数当初就是为 PowerShell BOM 写的），与读配置的纪律一致。
  回归用例在 `scripts/receipt-verify-smoke.mjs`（T9/T9b/T10），含对照组与盖章凭据。

- **`POST /run` 对任意 JSON 都回 `202 {"accepted":true}`，非法 spec 静默失败**。
  serve 层只验 JSON **语法**，spec 的**语义**校验（缺 `requirement`/`projectRoot`、
  枚举写错、数字越界）发生在 run 内部 —— 于是 `{"nope":1}` 也会先拿到 202，随后
  run 失败，`/state` 翻成 `failed` 而 `lastExitCode` 为空。CI 集成方看到 202 会
  以为任务已入队。现在 `startServe` 接受 `validate` 预检钩子，在写 202 **之前**
  用**同一份 `parseSpec`** 校验，无效即回 400 并附上与 CLI 入口完全相同的那句聚合
  报错（一个校验，两个宿主），且被拒的请求不占用并发名额、不产生事件。

- **`python3 -c` 这条内联求值禁令没有任何断言覆盖**（变异实测：把 `EVAL_FLAGS.python3`
  清空，`src/sandbox-runtime.test.ts` 43 个用例**全绿**）。`node` 与 `python` 有断言，
  同族的 `python3`、`node --print` 没有 —— 禁令表里的某个条目悄悄失效，没有任何测试
  会发现。现补齐断言，并对每个用例校验拒绝理由确实是"内联求值"而不是碰巧被别的
  规则拦下。

- **掩空器自测只数 4 个算子，且没有"真实靶位点 > 0"的探针**。变异门禁靠位点数
  判断有没有逐点验证过，而位点数来自掩空器 —— 掩空器一旦**判严**（把真代码当注释
  吞掉），位点会静默归零，自测却照样全绿。现按门禁实际启用的 9 个算子自测
  （补上 `return true`/`return false`/`continue;`/`??` 这几个**单词边界**算子，它们
  判错的形态与符号类不同），并新增一条探针：拿 4 个变异门禁的真实目标文件当靶子，
  断言掩空后仍有位点 —— 人造片段证明不了掩空器在这批代码上没判严。

### 新增

- **任务活性心跳（2026-10-03 竞品吸收，学 Orca 的 agent state heartbeats）**。
  修复一个观测盲区：此前"长任务在正常推进"与"可能挂死"在事件流里**长得一模
  一样** —— 都是 `status=running` 之后一片安静，看板无从区分。现在
  `SchedulerOptions.onTaskActivity` 在派发起点与每条 agent 事件时各触发一次，
  三层宿主全部接线（桌面 IPC `task-activity` 事件、headless 协议事件、serve 广播）；
  `TaskView.lastActivityTs` + 看板 running 任务静默超 30s 显示"⏸ 静默 Xs"
  （5s tick 走表，纯函数 `SILENCE_LABEL` 打表可测）。重新派发时心跳账本重置，
  终态任务收到迟到心跳不复活。

- **HTTP 请求追踪 id 透传（弹性库生态标准做法）**。`postJson` 逐个探测响应头
  `x-request-id` / `request-id` / `x-generation-id`（OpenAI / Anthropic /
  OpenRouter 三家的名字），失败时带进 `HttpLlmError.requestId`，错误摘要
  （`errorDigest`）追加 `[req=...]` —— 看板日志里看到失败即可复制 id 向服务商
  报障，一句话定位那一次请求。字段缺席 = 端点没给（不少 OpenAI 兼容代理不发），
  不是丢失。

- **竞品调研 2026-10-03 轮落库**（`docs/2026-10-03-competitor-refresh.md`）：
  Vibe Kanban 确认停摆（默认关审批 + 默认遥测被业界点名 —— 恰好是我们刻意
  相反的两件事，差异化叙述落档不改代码）；OpenRig / AO（Reaction 回环，留 5.7
  远期）新动态；LiteLLM `retry_policy` / MCP 2026-07-28 规范（sampling 弃用、
  MRTR 与 serve 审批同构但维持现握手）逐条对照结论。

- **离线全链路 e2e 不再与本机 Ollama 抢 11434（勘查欠账第 4 条，2026-10-03 记下）**。
  `offline-e2e-it.mjs` 此前**必须占住 11434** 才能冒充大脑层（ollama 的 baseUrl 在
  `shared/providers.ts` 里写死），于是本机真跑着 Ollama 时这条门禁**当场硬失败** ——
  而那与被测代码毫无关系。现在假大脑开在**随机端口**，用既有的
  `OX_LLM_BASE_URL_OLLAMA` 把端点指过去（`shared/providers.ts` 的 `baseUrlEnvVar`，
  demo 样例已在用），并删掉那段"端口被占就失败"的探测与排查提示。
  反向验证两条：**占住 11434 再跑 → 全 PASS**（改前会 exit 1）；
  **去掉覆盖变量 → 不通过**（证明这层覆盖真的在承重）。
  `references/gates.md` 第 21 段同步。

- **接线门禁的判据改严（勘查欠账第 4 项）：脚本名不再被"别家名字的后缀"洗白**。
  `check-script-wiring.mjs` 此前用纯 `s.text.includes(t)` 判引用边，方向是**漏报**：
  一个真孤儿只要名字是某个可达脚本名的子串，就被打成"已接入" —— 实测造一个
  `heck.mjs`（"mutation-check.mjs" 的后缀）当场被洗成已接入，门禁一声不响地绿。
  误报会当场红、漏报不会，所以这种方向的错更该修。改成**边界匹配**（命中位置的前后
  都不能是 `[\w.-]`），并给判据本身配了 8 例自测（`--selftest`，挂在
  `check:scripts-wired` 里）—— 门禁的判据也要有判据。改严后既有 21 个接入脚本
  判定不变（没把既有绿变红），探针孤儿当场红。

- **headless 三宿主补上 `raceRedundancy` / `disabledKeyVars`（协议面能力差收口）**。
  这两个开关桌面设置页早就有，headless 的 CLI / serve / MCP 三个宿主一个都没有 ——
  `KNOWN_FIELDS` 不认它们（宿主传了只会拿到一条"未知字段已忽略"），`HeadlessSpec`
  也没声明，于是"可编程"这条优势在**账号级停用**与**任务级赛马**两格上是断的。
  现在两字段进白名单与类型，并按协议层既有规矩校验（与 `maxTokensPerRun` 同风格）：
  `raceRedundancy` 只认 ≥1（0 与负数在调度器里会被夹成 1，"写错碰巧不出错"的巧合
  协议层不留），`disabledKeyVars` 去空白、去重。**多说一句而不是静默**：停用表里出现
  池子里没有的变量名时给 warning —— 那种输错的表现是"什么都没发生"，宿主会以为某个
  账号已下线，而它仍在消耗同一份配额，这比报错更危险。
  同批把此前只在 `KNOWN_FIELDS` 里、类型上没声明的 `runWallClockMs` /
  `brainTimeoutMs` / `executorTimeoutMs` 补进 `HeadlessSpec`（协议文档 §1 字段表同步）。
  两端接起来的证据不只看 settings：`platform.schedulerOptions().raceRedundancy` 与
  `platform.lineHealth()` 的线路条数各有一条断言 —— 防的是"协议认了字段、平台没读"
  这种断链重演。protocol.ts site 口径 **92/92 全杀**。

- **桌面把交付凭据的外部可验证性两半摆出来了（勘查欠账第 2 项）**。
  `receipt.checks[].command` 与 `fingerprint` 此前**只有 serve 状态页整份渲染**
  （`serve.ts:191-194`）：看板只渲染 kind / ok / exitCode / headline，于是"过了门禁"
  在桌面这条路上退回成一句自述 —— 想复核的人拿不到命令、也拿不到指纹，只能选择
  相信。现在每条检查把**实际跑过的命令**原样摆出（`command` + `args` 拼成一条能
  直接粘走执行的串），指纹放进折叠块**整串可见可选**（截短显示等于看得到但用不了），
  并把此前在桌面完全没有出口的 `receipt.tasks[]` 任务账补上（状态 / zone / 次数 /
  执行器 / 时长 / 错误类别）。缺席不摆空壳：没有命令的检查（纯逻辑判定）与没有
  指纹的凭据各自安静。三处渲染各做了反向注入（改成不渲染 → 对应用例红）。
  ⚠️ 这一格**还剩半步**：桌面没有"点一下就在本地重跑这些命令"的通道（preload 无
  verify 入口）—— 现在的可复核性是"人自己拿命令去跑"。自动重跑要经沙箱白名单与
  审批门，属独立一轮，不在本批。

### 修复

- **账号热切换的最后一块：换 key 值现在真的会生效（P1-5 收口）**。此前的语义链
  有个缝：`KeysStore.get` 是 env-wins（shell 注入优先），而 `keys:save` 只写
  store 不动 env —— 于是**更换已保存的 key** 时，进程 env 里残留的旧值会一直
  遮蔽 store 里的新值：设置页"测试连接"和下一次 run 都还在用旧 key，除非重启
  应用。现在 `keys:save` 在写 store 的同时同步更新进程环境（空值清除时同步
  删除）—— 保存动作就是最新意图，换 key / 停用 key 立即生效，无需重启。
  shell 注入的优先语义不变：没在设置页保存过时，env 里的 key 依然优先。
  线路池的停用（`disabledKeyVars`）与顺序（`llmPool`）此前已热切换生效
  （每次 run 现读 settings 重建池），本轮补的是 key **值**这一维。

### 新增

- **对外可复现样例：`npm run demo`（verify 第 16 段 `smoke:demo`）** —— 补的是"能跑"
  与"**能被看见**"之间的那道缝。此前 22 段门禁的读者都只有维护者自己：想快速了解
  这套东西能干什么的人只能读架构描述，想复现一次真交付的人得先看明白四个 IT 脚本。
  现在一条命令给出一次**真实的**交付，并把它跑成可读的 transcript：
  规划 → 派单 → 落盘 → 门禁 → 交付凭据 → 外部复核。
  它同时是三样东西：README 的演示、新人的上手路径、以及回归基线（自带 17 条断言）。
  - **零凭据、零网络、零固定端口**：假大脑与假执行器都由脚本在本进程起，端口取 0
    （随机）。不占 11434，也不会因本机真跑着 Ollama 而硬失败。
  - **顺手把凭据闭环第一次端到端走通**：产出凭据 → 默认复核判 `not-replayed`
    （退出码 5） → `--replay` 复跑判 `verified`（退出码 0）。这条链此前只有
    `smoke:receipt-verify` 用手工构造的凭据验过，从没有一次由**真引擎**产出的凭据
    走完过。
  - **非空转证据**：断言 `brainCalls >= 1`（大脑请求确实打在覆盖后的端点上）；
    反向注入实测 —— 去掉子进程 env 里的端点覆盖后 `brainCalls=0`、PLANNING 阶段
    即 exit 1、**14 条断言变红**。

- **LLM 端点可覆盖：`OX_LLM_BASE_URL_<ID>`（provider id 大写、连字符换下划线）** ——
  这是上面那个样例的前置能力，也是它自己的一个真缺口。此前目录里 ollama 的 baseUrl
  写死 `http://localhost:11434/v1`，于是"本地模型"只剩那一个端口能当大脑：跑在别的
  端口上的 LM Studio / vLLM、公司内网的网关、以及离线演示与回归用的假端点，**全都
  接不进来**。这不是"灵活性"问题，是本地部署接不进来。
  - 覆盖落在**唯一**的解析点（`getProvider`）生效，所以单客户端、跨 provider 池、
    桌面与 headless 四条构造路径一并受益。散在各处判断必然漏掉某一条，而漏掉的那条
    表现成"覆盖在某些形态下不生效"——最难查的一类。
  - 三处 `getProvider` 调用点补齐 `env` 线程（`buildLlmClient` / `buildPoolRoutes` /
    池与单 provider 的 failover 工厂）。此前它们对"调用方注入的 env"是**声明了却
    不用**：`buildLlmPool({ env })` 说的是一套 env，端点那一跳偷偷读 `process.env`。
    生产上默认值恰好是 `process.env`，所以这个缺陷只在测试与自定义 env 下可见 ——
    也正是它能活到现在的原因。
  - 空串不算覆盖（`baseUrl: ""` 是配置错误，不是端点）；未知 provider 照旧抛错。
  - `src/llm-pool.test.ts` 30 → 40 例，覆盖：默认取目录值 / 覆盖生效且其余字段不动 /
    不串台 / 空串不算 / 池路径吃覆盖 / 字符串入口吃覆盖 / 传 config 时不再二次解析。
    三次反向注入（把 `if (override)` 取反、两处去掉 env 线程）各自都精确打红了预期用例。
    `shared/providers.ts` · `shared/build-llm.ts` · `shared/http-clients.ts`
    site 口径 **3/3 · 12/12 · 58/58 全杀**。
  - 顺带发现一处**已知不对称**（记录未修）：`createFailoverClient` 的循环是
    `if (!apiKey) continue`，无密钥 provider 传 `[""]` 会被跳过（0 条线路），
    而池变体 `createMultiProviderFailover` 专门给 `keyVar === ""` 留了 `nokey` 一格。
    生产上该入口只喂 SensoNova（有密钥），所以是潜在限制而非现行缺陷 —— 用一条
    用例把它钉住，免得下次有人拿它接本地无鉴权端点时摸不着头脑。
  - **可选的后续（记下未做）**：`offline-e2e-it.mjs` 也可以改用这个覆盖开关把假大脑
    挪到随机端口，从而删掉"本机真跑着 Ollama 就硬失败"那个坑。本次不做，是为了让
    "样例 + 覆盖能力"这一笔保持可独立验证的边界。

- **交付凭据的外部可验证性（P0-② 收口）** —— 把"这份交付过了门禁"从一句自述，
  变成任何持有凭据的人都能自己复现的观察。三块分开做，因为它们回答三个不同的问题：
  - **① 记下命令**：`VerificationReport.results[]` 与 `ReceiptCheck` 新增
    `command` / `args`。此前凭据只写"typecheck 通过"，读的人无从知道跑的是哪条命令。
    四个 push 点（沙箱拒绝 / 升级拒绝 / 审批拒绝 / 真实结果）都补上 —— **被拒绝的命令
    尤其要记**，那是外部唯一能查"该调哪条策略"的线索。缺席 = 这条检查不经过命令。
  - **② 内容指纹**：`fingerprint` = `canonicalReceiptPayload` 的哈希，由宿主注入
    （桌面用 `node:crypto` sha256）。规范序列化是显式排序键 + 递归 + 过滤 `undefined`
    —— 依赖 JS 对象键序是不够的：一次 JSON 往返就可能改变键序，同一份凭据算出两个指纹，
    于是"被改过"变成噪声。**它不是签名**（能改凭据的人同样能重算指纹），字段注释里
    把这条写死了，免得验收时被误导。
  - **③ 复核工具**：`headless/receipt-verify-main.js`。默认只验指纹并列可复跑命令
    （不执行任何东西）；`--replay --cwd=<dir>` 才在本地重跑并逐条比对，
    走与生产同一套 `CommandPolicy` 沙箱。裁决五档**刻意不并档**：
    `verified` / `contradicted` / `tampered` / `unsigned` / `not-replayed`，
    对应退出码 0 / 2 / 3 / 4 / 5。`not-replayed` 不返回 0 是刻意的 ——
    **指纹一致不等于结论为真**，把"没复跑"报成"已核"就是给自述背书的橡皮图章。
    指纹不符时**早退不复跑**：拿一份假凭据去和环境比，比出来的"矛盾"是伪证的产物。
  - 测试：`src/delivery-receipt.test.ts` 16 → 45 例（规范序列化 / 盖章复核 / 逐条比对 /
    五档裁决），`scripts/receipt-verify-smoke.mjs` +8 例端到端（子进程跑真产物、
    真退出码），后者新增为 verify 第 16 段 `smoke:receipt-verify`。
    两条非空转证据：复跑用例断言命令留下的标记文件存在，`tampered + --replay`
    用例断言标记**不存在**。两处都做过反向注入实测（改退出码、去掉 mismatch 守卫）确认变红。
    三处测试自身的缺陷都在写完后被变异门禁/反向注入揪出来，记下来免得再犯：
    ① **空转用例**：`{...base, rounds: 2}` 里 `rounds` 已在 base 中，对已存在的键
    重新赋值**不改变插入顺序** —— 两个对象键序其实相同，取消排序也照样绿。
    改成显式反序插入 + 前置断言"两者键序确实不同"才真正生效。
    ② **只比两份输出相等**：序列化器内部改变分支时两边同步变坏，用例看不出来。
    补字面量钉住（空交付的完整字节串 + 数组内对象的递归结果）后才真正敏感。
    ③ **只断正面文案**：`auditReceipt` 的 `=== "unrunnable"` 变异成 `!==` 会把
    "复现的条数"当成"没法比的条数"，摘要多出一句"另有 N 条无命令可比"，
    而 `toContain("复现全部 1 条")` 照样通过 —— 补 `.not.toContain("无命令可比")` 才杀掉。
    另有一处**等价变异改由简化源码消除**：`sort` 比较器原来写
    `a < b ? -1 : a > b ? 1 : 0`，`a === b` 分支是死的（对象键天然唯一），
    且"三元分支互换"后的比较器仍满足"`< 0` 当且仅当 a < b"，实测 400 组 × n∈[2,1000]
    顺序全一致 —— 构造不出输入。按"死代码就简化源码"的优先级改成 `a < b ? -1 : 1`，
    残留的那个三元反而**可被字面量用例杀死**（互换即得降序）。
    `shared/delivery-receipt.ts` site 口径 **43/43 逐位点全杀**。

- **上下文回溯闭环（P1-3 收口）** —— 这是多agent 系统真正难的那一半。
  `audit:trail` 此前已经把每次派发"谁跑的、多久、为什么失败"全落盘了，但那份履历
  **只流到 UI（人看）**，下一个执行器读不到：重修轮的 `repairContext` 里只有
  "现在哪里错了"，没有"这条路已经走过"。于是 agent 每次重试都从零开始 ——
  同一个错误类已经失败 3 次，它只看到第 4 次的报错。
  新增 `trailBriefForRepair`，把履历压成一段进重修上下文的文本，三条纪律：
  只讲失败的事（成功过的过去没有接力价值）、按错误类**聚合计数**（prompt 体积与
  失败次数解耦，连挂 10 次不会撑爆上下文）、腰斩的派发单列（`endedAt` 缺席 = 没跑完，
  原因不可知，混进"失败 N 次"是编造因果）。文本末尾明确喊停：
  "不要再重复同一条路，换思路或换执行器" —— 只报数字不喊停，agent 会读成"第 3 次尝试"。
  接线沿用既有模式：引擎读不到审计日志（日志归长期存活的 audit-log 所有，同
  `usage` / `conflicts`），由宿主注入 `priorAttempts` 查询口，只在重修轮取一次。
  headless 与桌面共用同一条路径。测试：board-derive +10（判据真值表 / 计数守卫 /
  字段即承诺）、orchestrator +2（履历真进 prompt / 首轮不查），
  `electron/board-derive.ts` site 口径 **38/38 逐位点全杀**（原 27，本轮新增 11 个位点）。

- **验证失败的类别细分（竞品清单 P2-3 收尾）**。此前沙箱拒绝 / 升级拒绝 / 审批拒绝
  在报告里都是一个普通失败，重修循环读到后会把它们当成"项目本来就坏"让 agent 白修一轮——
  三道门里有两道是**改代码永远改不动结局**的。`VerificationReport.results[].errorClass`
  现在给这类结果打标（`sandbox-denied` / `escalation-denied` / `approval-denied`），
  字段即承诺：**没有这个键 = 一次真实的命令失败**。`shared/routing.ts` 的
  `environmentalRulingNote` 把它们摘成一段环境裁决说明，编排器在重修上下文里先说破
  "这不是代码造成的"，并指明出路（调 `policy.d` 或人工批准后重跑）。
  刻意不给 UI 弹窗留后门：报告的消费者是 agent 与日志，先把"要动的是什么"讲清楚。

- **审批 UI 面（P2-3 收口）**。审批门此前只有命令面，宿主只能"问不到人就不执行"，
  问得到却没出口。现在三条宿主形态都能答：**桌面**（看板审批区 + `resolveApproval` IPC，
  含 cancel 时把挂起的审批全部按拒绝收尾的 fail-closed 最后一环）、**serve**（状态挂
  `pendingApprovals` + `POST /approve` + 状态页按钮，无 pending 时**键消失**，字段即承诺）、
  **MCP**（第六个工具 `ox_approve`，requestId 取自 `approval-request` 事件，
  已答复/不存在如实报 404）。宿主回调的接线由 `createPlatform` 注入，headless 形态
  未装配 `policyDir` 时 `approvalCommands` 恒空、审批门根本不建——装配链本身因此可测。

- **反向 MCP server（竞品清单 5.5，学 Vibe Kanban 的双向集成）**。serve 形态
  的消费者此前只有人（浏览器）和 CI（POST /run）；现在把 serve 的 HTTP 面包装成
  **MCP stdio server**（`headless/mcp.ts` + `mcp-main.ts`，`npm run mcp:serve --
  --serve-url=http://127.0.0.1:8787`），Loomy 这类外部 agent 可以编程驱动本平台：
  `ox_status`（查状态，投递前先看一眼别撞 409）、`ox_receipt`（取最近一份交付凭据
  全文）、`ox_events`（最近 N 条事件）、`ox_run`（投递 spec，busy 时如实转述 409）、
  `ox_control`（暂停/继续）。五个工具、五个动作，每个都如实转述 serve 的响应 ——
  409 就说忙、不可达就说不可达，不把失败包装成成功。
  协议刻意手写（JSON-RPC 2.0 over stdio，零新依赖）：MCP 的 stdio 传输就是按行
  分割的 JSON-RPC 对话，SDK 背后没有魔法。纪律与 serve-main 一致：stdout 只出
  协议（混进一行日志整个会话就坏了），日志全走 stderr；不持状态、不跑 run ——
  只是 serve HTTP 面的 MCP 译码器，`--serve-url` 指向哪，看板就是哪一个。
  测试：`src/mcp.test.ts` 14 条（握手/协议错误/五工具 × 成败分支，HTTP 全注入）；
  产物冒烟加两段（真 stdio 握手 initialize + tools/list 五工具；非法 JSON 行
  被忽略且优雅退出）。

- **dev server 托管检查（竞品清单 5.4，学 Vibe Kanban）**。前端任务的验收此前
  止步于 build/typecheck/test —— "页面能不能打开"没人管。`SmokeCheck` 新增
  `devServer: { url, timeoutMs? }`：存在时该检查是**驻留进程** —— spawn 后不等
  退出，轮询 HTTP 探活（2xx/3xx 即活），进程树在检查结束时**无论成败都被杀掉**
  （dev server 是验证道具，不是长驻服务）。三道沙箱门（策略/升级/审批）与普通
  smoke 完全同一套；判定只看 HTTP 状态码（R1：dev server 无法往 stdout 写字
  把自己写绿，只能真的把端口服务起来）；404 刻意算死（探活路径配错不该被当成
  "起来了"）；进程在探活期间崩掉（端口被占、编译 panic）立即判死，不烧满超时
  预算。探活核心在 `electron/engine/dev-server.ts`（fetch/sleep/时钟全注入，
  纯逻辑进变异门禁）。刻意不做页面截图/DOM 断言 —— 那是无头浏览器的事，
  依赖与体积都不该进验证链。
  测试：`src/dev-server.test.ts` 12 条（判据真值表 / 轮询节奏 / 退出守卫 /
  runSmokeChecks 集成——真子进程 + 真 HTTP，与靶场同哲学）。

- **LLM 故障转移靶场（`smoke:target-range`，进 verify）**。verify 此前对 LLM 池的
  验证停留在函数层 stub（`failover.test.ts` 注入错误对象）——真实 HTTP 链路层
  （真 fetch、真 TCP、真 AbortSignal 超时、真 Retry-After 响应头、真截断字节流）
  从未测过。新增 `scripts/llm-target-range-it.mjs`：一个 node:http 服务器按路径
  扮演多 provider × 多端点故障注入矩阵（`/p<N>/v1/chat/completions`，每端点一份
  故障剧本：429 带/不带 Retry-After、401/402/404/410、500、挂起超时、慢响应、
  畸形 HTML、截断 JSON），被测对象是 `dist-headless` 编译产物里的**生产**
  `FailoverLlmClient`（不是测试替身）。18 个场景 33 项断言，含一条
  "429→500→402→挂起→成功"五连坏的混沌链。前置 `npm run build:headless`。

- **线路级永久错误 bench（竞品弹性库特性吸收）**。402（余额耗尽）/ 404·410
  （模型或路径退役，z-ai/glm-5.2 → 410 是实测案例）/ 405 / 413 现在会 bench
  本线路并轮换，而不是像之前那样走"不冷却"分支 —— 旧行为下每次调用都要重新
  撞一遍注定失败的慢请求才轮到健康线路。400 刻意保持请求级不冷却：不同模型对
  temperature / json_mode 的容忍不同，换一条线路可能就对了。与 401/403 的分工
  不变：认证错误另有 fail-fast 语义（`failFastOnAuth`）。

- **连续失败升级冷却（竞品弹性库标准语义）**。一条线路冷却到期后再次失败，
  说明它大概率还坏着 —— 冷却时长按 2^(streak-1) 指数升级（30s → 60s → 120s
  …，上限 `COOLDOWN_ESCALATION_CAP_MS` 10 分钟），成功一次即清零回档。
  Retry-After 存在时仍是服务端权威（它说等多久就等多久，升级公式不覆盖）。
  出口：`LineHealth.consecutiveFailures`（看板线路健康卡会显示"连续坏 N 轮"），
  `onEvent` 在升级发生时如实说"连续失败 N 轮，冷却升级至 Xs"（而不是让用户
  只看到同样的"冷却 30s"反复出现）。

- **agents.d 预设库扩容（竞品清单 5.6）**：补 aider / goose / qwen-code /
  gemini-cli 四个 CLI 预设。⚠️ 这批按公开文档的当前主参数写，**未在本机逐字
  实测**（本仓库没装这四个 CLI），接入前先 `--help` 核对每个参数 —— README
  警告过的"probe 依然绿但每次派单都因未知参数失败"的坑对它们同样适用。

### 变更

- **优化空间勘查轮（`docs/2026-10-03-optimization-survey.md`）：`AuditLog.read()`
  加单槽 memo，重修轮次的重复读盘从 O(任务数 × 整条履历) 降为 O(1) 次读**。
  `read()` 此前把留存内每个文件整读、逐行 `JSON.parse`，**最后才 `slice(-limit)`**
  —— `limit` 一个字节 I/O 都省不掉；而重修路径对**每个**待修任务各调一次
  （`context.ts` 的 `priorAttempts`，被 `orchestrator.ts` 在 `.map()` 里逐个调用）。
  按文档写明的留存上限（20 文件 × 2 MiB ≈ 40 MiB）实测：单次 **221 ms**，
  12 个失败任务 = 2.5 s、30 个 = 6.3 s，且每个字节能耗都在重复 parse 同一份文件。
  落地后对**生产类本身**测（38 MiB / 20 个真实滚动文件）：12 次读取
  **2609 ms → 6.2 ms（421×）**，且 memo 与冷读逐条比对完全一致。
  - **memo 的键是磁盘指纹（文件数 + 最新文件名 + 当前文件 `size:mtimeMs`），
    不是内存计数器** —— 这是实现时被自己的测试逼出来的：第一版用"每条写路径
    `version += 1`"，跨实例用例当场变红（实例 A 建 memo 后实例 B 往同目录 append，
    A 仍返回旧数组）。两个 `AuditLog` 指向同一目录是真实场景，内部计数器看不见
    外部写入。改成读磁盘指纹后这个洞**按构造关闭**。
  - **代价（明写）**：`read()` 返回的数组现在与 memo 共享引用，调用方只读。
    仓内全部调用方（`taskTrail` / `deriveBoardView` / IPC 读路径）已核对为只读，
    该约束写进了 `read()` 的注释。
  - 新增 7 条用例，重点**不是"更快"而是"没有 stale"**：append 后必须读到新记录、
    `limit`/`phase` 是键的一部分、轮转后旧 memo 失效、留存淘汰后不得把已删历史
    端回来、跨实例不泄漏。变异门禁 site 口径 **20/20** 杀。

- **三处门禁盲区补上（每处都做了反向注入证明，不是"加了断言后绿"）**：
  - `killTree` 的**默认** `graceMs`（2000 ms）此前无人断言 —— 那三个生产调用点
    （`verifier.ts` ×2 / `dev-server.ts` / `cli-agent.ts`）**全部不传** `graceMs`，
    而既有 18 条用例每条都显式传了自己的值，唯二不传的两条都在
    `pid === undefined` 守卫处提前 return，**永远走不到默认值**。
    把默认改成 50 ms → 新增 2 条红、**既有 0 条红**。
  - `abortAllEscalations` **一次只收第一条**：既有 `:924` 已覆盖单条场景
    （此前报"零断言"是按符号名 grep 导致的误判 —— 已按行为复核），
    但**只挂起一条**，"k 个同时挂起、只收第一条、其余永远挂着"无人能拦。
    改成只 resolve 第一条 → 整份既有套件全绿；新增的多条挂起用例是唯一变红的。
    同批补上两个 ghost 残渣用例（收尾后必须已清空）与"cancel 一次收两条通道"。
    ⚠️ 诚实记录：试过用"删掉 `.clear()`"证敏感度，**没变红** —— 迭代中 `delete`
    与事后 `clear()` 行为等价，属**等价变异**，不假装它是有效断言。
    `abortAllApprovals` 的 fail-closed 语义既有 `:964` **已覆盖**（注入 `true` 确实
    变红），不重复造。
  - `verificationCommandPaths`（`shared/zone-coverage.ts`）生产在调
    （`orchestrator.ts:327`）却**零测试引用**，且只含 `??`（默认关闭算子），
    变异门禁不兜底。补 5 条：去掉 `.sort()` → 2 红；去掉 `??` 守卫 → 1 红。

- 看板"线路健康"卡新增"连续坏 N 轮"展示（`consecutiveFailures ≥ 2` 时出现）。

- **`policy.d` 补齐路径面与预算面（竞品调研 P2-2 收尾）**。此前只落了命令面
  （`denyCommands` / 子命令 / `approvalCommands`），两类规则仍写在代码常量里。
  现在补上：

  · **路径面 `forbidWrite`**：追加到内置禁止写入清单（glob 口径）。
    ⚠️ 这里有个必须自己处理的陷阱：`PathPolicy` 的 `forbiddenWrite` 是**替换**
    语义（源码注释 "Overrides DEFAULT_FORBIDDEN_WRITE when provided"），
    策略层直接透传等于让一份 JSON **拆掉沙箱地板**（`package.json` / `.env` /
    `.git/**` / `node_modules/**`）。所以新增 `pathPolicyOverrides(policy, defaults)`
    在平台侧算好**并集**再传，且"没配策略"必须表现为**键不存在**而不是空数组 ——
    空数组在 `??` 下是"已提供"，同样会清空地板。
    适配器侧新增 `SensenovaAdapterOptions.forbiddenWrite` 承接（注释写明"必须是
    并集、不能是替换"），`createAgentLayer` → `createDefaultAdapters` 三层透传。

  · **预算面 `maxTokensPerRun`**：接通消费者。此前它只被解析、合并、并被
    `describePolicy` 念出来，**没有任何消费者** —— 日志说"token 上限 N"，
    而闸门读的是 `settings.maxTokensPerRun`，写进策略的预算不生效。
    新增 `effectiveTokenBudget(policy, settings)` 取**更小**者（两者都是上限，
    并存时以严的为准，否则更宽的设置值会静默架空更严的策略），
    并把日志改成如实念出两侧来源与生效值。
    平台内策略加载**前移到 `meter` 之前** —— 预算要参与 `UsageMeter` 构造，
    而 meter 是所有 LLM 客户端的共用上游（策略加载只读磁盘 JSON，可安全前置）。

  测试：`src/policy-file.test.ts` 35 条（含并集语义、去重、排序稳定、取更小值、
  非法值同口径）；`src/platform.test.ts` 新增 6 条端到端断言（**地板没被拆**、
  没配时不传该字段、策略上限真的进闸门、两侧取更小、单侧也生效、都没配则不启用）。

- **审批门（竞品调研 P2-3）**：`policy.d` 的第三种规则 —— 它回答的不是"能不能跑"
  （`CommandPolicy` 的静态地板）也不是"批次内发生过什么"（`ActionGate` 的跨动作
  状态机），而是**"跑之前要不要先问人"**。三者刻意分开，因为失败模式不同：
  地板漏了是越权，状态机漏了是上下文错判，审批门漏了是**该被看见的动作静默发生了**。

  用法：策略里写 `approvalCommands: ["deploy"]`（basename 口径，与白名单同口径），
  宿主通过 `PlatformHost.requestApproval` 接回调。两条纪律：
  - **问不到人就不执行**（fail-closed）：回调缺席时按拒绝处理，与 `EscalationPolicy`
    的 `exhaust` 同构 —— 无人可问的场景下"停下来"的唯一安全实现是不执行，
    而不是假装问过了。日志会当场说破"未接审批回调 ⇒ 这些命令会被拒绝"，避免用户
    以为审批在等他。反过来，**没配 `approvalCommands` 时本门零影响**（默认路径不该
    多出人工环节）。
  - **批准按批次缓存**：一次 run 里同一命令会被反复执行（每轮验证都跑一遍），
    逐次问人会把审批变成噪音，而噪音会被习惯性点掉 —— 那比没有审批更坏。
    批次边界由引擎与 `ActionGate` 一起 reset（"本批已批准"不跨批）。
    被**拒绝**的刻意不进缓存：一次误拒不该让该命令在本批内永久静默。

  接入位置在 verifier 链的**最后一道**（静态策略 → 跨动作升级 → 审批 → spawn）：
  前面几层拒掉的命令不该打扰人。`verifyProject` 与 `runSmokeChecks` 两条路径同实例。

  已知边界（如实记录）：审批拒绝会让**基线验证**也变红，于是日志出现
  "本次运行开始前就失败（不是智能体造成的）"—— 而审批拒绝其实是第三种原因
  （既不是智能体写坏的、也不是项目本来坏的，是**人按住了**）。当前靠同一串日志里
  的 `[审批]` 前缀让人看出实情。要正确区分三类原因，得让 `VerificationReport`
  带上失败类别，那属验证器契约变更，应与审批的 UI 面（审批队列）同批做。
  已有一条用例把这个行为**如实钉住**，避免被无声改动。

  测试：`src/approval-gate.test.ts` 18 条（纯函数真值表 / 三态 / fail-closed /
  批次缓存 / 可观测性）；`src/platform.test.ts` 5 条接线断言（拒绝时不执行、
  批准时照常跑、没配不建门、缺回调当场说破、批准缓存不跨批）。
  模块已登记变异门禁，site 口径 **3/3**。

- **策略即代码 `policy.d/`（竞品调研 P2-2）**：沙箱规则此前全写在代码常量里
  （`command-policy.ts` 的 `DEFAULT_*`、`path-policy.ts` 的 forbidden、`usage-meter`
  的预算），改一条规则要改代码重新打包 —— 而"这条命令能不能跑、这个预算是多少"
  恰恰是该被评审、该进版本库的东西。`shared/policy-file.ts`（契约与归一化，纯逻辑
  无 IO）+ `electron/sandbox/policy-dir.ts`（目录加载）+ `platform.ts` 接线，
  与 `agents.d/` 同构：只读 `*.json`、跳过 `*.example.json`、单个文件坏只记录并跳过。
  **刻意收紧**：未知版本整份丢弃（半懂不懂地执行一份安全策略比不执行更危险）；
  契约里**没有"允许某条命令"这一格**，只产出 `denyMore` / 子命令拒绝 ——
  只加严不放宽，一份 JSON 不该能把白名单地板拆掉。坏文件不拦 run，但每条问题都
  说出来（静默跳过会让"我以为禁掉了"变成假的）。现有 4 处断言（空目录不谎报已加载；
  有策略时规则真的管住验证命令）。

  ⚠️ **已知缺口（下面这段是接手前必读）**：`PolicyFile.maxTokensPerRun` 目前
  **只被解析、合并、并在 `describePolicy` 里被念出来，但没有任何消费者** ——
  `platform.ts` 构造 `UsageMeter` 时读的仍是 `settings.maxTokensPerRun`（该文件里
  `policy.*maxTokensPerRun` 零命中）。也就是说写进 `policy.d` 的预算**不生效**，
  而日志会照常打印"token 上限 N"，读起来像已生效。这与本次同时修掉的
  `[exit]0` 缺陷同属一类（说法跑在行为前面），处置方向也一致：要么接上消费者
  （取两者更小值，契约注释里已经这么写了），要么把该字段从契约里摘掉。
  在同一轮里选择"记录而非顺手接"的理由：接通它会改变预算语义（多一份配置来源、
  多一条 `Math.min` 归并），那属于预算面改造，应与 P2-2 的路径面一起做，
  不适合夹在文档补齐里悄悄发生。

- **验收约束 R1/R2/R3 落成代码（`docs/product-spec.md` 第 3 章的机制面）**。
  三条硬要求各锚定一种已被验证过的失败方式，现在都有断言与反证：
  - **R1 判据必须独立于被判定方**（`electron/engine/verifier.ts`，需修）：`runSmokeChecks`
    原先把退出码编码进子进程输出（`${log}\n[exit]${code}`）再用 `/\n\[exit\](\d+)/`
    取**第一个**匹配解析回来 —— 被检测程序只要在 stdout 打印一行 `[exit]0`，真实退出码
    即便是 1 也会被判通过。改为结构化事实 `SmokeOutcome{log, exitCode, timedOut}`：
    退出码只来自 `close` 事件，输出文本仅用于**正向**的期望片段匹配。主门禁 `runOnce`
    本就用真实 `code` 事件，未改。site 口径 13/13。
  - **R2 失败必须可归因到责任方**（`orchestrator.ts` 的 `preexisting` 按 kind 匹配）：
    此前零覆盖（现有断言全是手工构造输入的替身）。补 2 条配对断言，**双向**锁死 ——
    既不许把新失败洗成基线噪音，也不许把噪音冤判给智能体。
  - **R3 不误伤优先于多修复**（`snapshot-store.ts` 的 `revertOne`）：原用例只覆盖了
    `created` 留空的一格，而生产路径（`batch-guard`）永远传**显式数组**。补 3 条，
    关键一条构造"created 非空但不含目标"——任何把判据简化成"看数组空不空"的写法都会
    在此放行删除，把用户文件删掉且默认档下每轮重修再删一次。site 口径 13/13。

- **越权删除台账（一致性评审缺陷 #11 收尾）**：`report-only` / `deny-all` /
  `quarantine` 三档都不恢复被删文件，而下一批的基线从磁盘重建 —— 没有台账时同一次
  删除**只响一次**就从台账上消失，被删的源文件可以静默一路带到交付。新增纯函数
  `updateDeletionLedger`（销账看盘 / 入账看盘 / 首见批次不漂移），且**每条 settle
  出口都结算**（含 clean 批 —— 缺陷形态恰恰是"下一批干干净净，被删文件从此没人再提"）。
  批次失败后仍缺的文件进 `BatchVerdict.carried`，随事件流与交付凭据一起上报。

- **zone 路线的代价可量化了（竞品调研 P0-2）**。共享工作区 + zone 互斥是少数派路线
  （实测 15 个同类里 12 个走 git worktree），主张必须拿数字说话，否则会被读成"没做隔离"。
  分两步：① **补事实** —— `batch-guard` 这个 audit phase 此前在生产代码里**零生产者**
  （越权只走 IPC/协议事件流，重载即消失），现在 `AuditRecord` 增加 `conflictKind` /
  `remedy` 两个结构化字段，`context.ts` 的 verdict sink 在推看板的同时落一条审计事实
  （与 `conflict` 事件共用 `pairConflict`，处置口径只有一份）；
  ② **量化层** —— 新增纯逻辑 `electron/zone-cost.ts`（`summarizeZoneCost` 算越权次数 /
  种类分布 / 处置分布 / 涉及与已处置路径数 / 每 run 越权率；`planCost` 算规划期被切了
  几刀串行），`npm run zone:cost -- --audit=<dir> [--batches=<file>]` 出报告（`--selftest`
  自检）。**只报自己这一侧的实测数字**：worktree 那侧的代价需要真跑另一种架构，
  编一个"节省 X%"比不报更坏。模块已登记变异门禁（site 口径 9/9）；落地审计抓出
  两处问题：排序比较器的内层三在 V8 小数组二分插入下是等价变异（键互异 ⇒ 收敛成
  两分支）、非 zone 事实的"跳过"写成"中断"会让后半段历史静默消失 —— 均已补断言。

- **有状态前置策略（跨动作状态机，竞品调研 §5.1 学 Omnigent）**：批次不是一组互不
  相干的命令 —— agent 在批次内装过依赖，之后每条命令的含义都变了。静态 CommandPolicy
  逐条孤立判定看不见这层上下文，现在补上：`electron/sandbox/action-gate.ts` 的
  `ActionGate`（观察面 = scheduler 每条 agent 日志；执行面 = verifier 两条路径 spawn
  前查询；批次边界由引擎 reset），规则在纯函数里（`extractActionFacts` /
  `escalatedVerdict`，site 口径 13/13 逐位点全杀）：批次内出现过依赖安装/发布/推送
  痕迹 → `npx` 的隐式 registry 下载升级为拒绝；发生过对外发布/推送 → 追加依赖变更
  升级为拒绝。同批修补静态缺口：`npm publish` / `adduser` / `login` / `logout` /
  `token` / `config` 六个子命令此前无人拦（npm 在白名单、子命令未判定），AI 生成的
  冒烟命令 `npm publish` 会真的执行 —— 现在与 git 子命令同构落地为沙箱地板。
  `maxTokensPerRun` 的"动作前拦截"升级留待后续（用量记账当前是事后口径，独立事项）。

- **看板重开即恢复（facts/derived 分离，学 AO）**：此前看板状态只活在引擎内存推送里，
  窗口重载或进程树被腰斩（`--real` 演习两轮都栽在这）后就是一块空白板。现在审计 JSONL
  补齐三块事实 —— run-start/run-end 带 `projectId` + `title`，新增 `stage`（阶段推进）与
  `receipt`（交付凭据，落盘前过脱敏）两个 phase —— 配套纯函数推导层
  `electron/board-derive.ts`（`deriveBoardView`：无 IO 无时钟，审计事实 → 任务账/阶段/
  凭据/**interrupted 腰斩标记**），新 IPC `board:recovery` 在看板挂载时恢复上次运行的
  进度；被腰斩的运行在看板顶部亮横幅。attempts 从 run-start 次数推导，修复轮重派不清
  空归因，与实时推送同语义。模块已登记变异门禁 TARGETS（site 口径 18/18 逐位点全杀）；
  落地审计顺手抓出两处新代码存活（receipt 恢复三元、恢复提示行的 `||` 单真条件）均已
  补断言清零。

- **交付凭据（delivery receipt）**：一次 run 结束时**对外可验**的结构化结论。此前验证结论、
  任务账、越权处置、用量散在四类事件里，要看"这次到底交付了什么、凭什么"得自己拼时间轴；
  现在 `shared/delivery-receipt.ts` 把引擎已掌握的事实归一成一份凭据（纯函数、字段即承诺：
  拿不到就整个键不出现），headless 协议新增 `{ type: "receipt" }` 事件（只在交付成功与
  重修预算耗尽两条出口上发，且在 `done`/`error` 之前 —— 取消与崩溃的现场不完整，不发），
  看板同步展示。驱动力来自同日竞品调研：对位竞品的终点是"把 N 份 diff 摆给人挑"，
  本项目的终点应当是一份能自己说话的结论。模块已登记变异门禁 TARGETS（site 口径 16/16）；
  落地审计顺手抓出三处问题并已修复：orchestrator 的 verified/unverifiedReason 在三个
  构建点复制（一处无断言存活）→ 收敛为 `verifiedFieldsFor` 单实现并补「非空验证时键不出现」
  断言；checks headline 的分支互换无断言 → 新增「失败带首行 / 成功留空」双向用例；
  context 缓存 signature 白名单行号漂移（182 → 183）→ 校回。

- **账号热切换（竞品调研 P1-2 收尾）**：线路**看得见**之后还差**调得动**，这一项补上。
  `ProjectSettings.disabledKeyVars` 记停用的密钥变量名，线路组装（`buildPoolRoutes`，
  纯函数）把命中者整组摘掉 —— 一条线路是 provider × key × model，所以摘掉一个 key
  就是摘掉它名下的**整组**线路；某 provider 的 key 全被摘完时它整体离线（route 消失，
  而不是留一条空 route —— 空 route 会让"池里有这一家"看起来成立）。无密钥端点（ollama）
  没有账号可切，不受停用表影响。**密钥值不动**（还在盘上，随时能开回来）—— 停用与清除
  是两件事，UI 上也是两个按钮。设置页：每个密钥一行"停用这个账号"开关；线路池每个
  提供商有上移 / 下移（顺序即优先级，越靠前越先被试）。断言三层：纯函数（停用/全停/
  无密钥端点）、platform 把字段真的传进池、UI 保存的 payload。

- **用量可视化（竞品调研 P1-2）**：本次运行烧了多少 token，此前只在日志里落一行
  `[usage] …`（平台默认实现），界面上看不到。现在引擎 `onUsage` → IPC 事件 → 看板卡片
  全程接线：卡片给出 `tokens · 调用次数 · 未上报次数 · 模型明细`，配了预算时显示上限。
  **`calls - measuredCalls`（端点没上报用量的次数）必须和总数一起显示** —— 那部分是
  `maxTokensPerRun` 这道闸**看不见**的支出，不显示就会把"42 tokens"读成全部支出；
  配了预算又存在盲区时，卡片把这句话说破（复用 `budgetBlindNote`，与日志同一份措辞）。
  判定下沉到纯函数 `usageFact`（`shared/usage-meter.ts`），UI 不做判定，日志行与卡片
  共用同一份拼接（顺手消掉两处各写一遍的"N 次未上报用量"）。新增位点 site 口径
  `usage-meter` 18/18、`src/store.ts` 21/21、`orchestration` 4/4，逐位点全杀。

- **线路健康可视化（竞品调研 P1-2 后半）**：冷却表此前只活在故障转移客户端内部
  （`onEvent` 只落一行给人看的话），界面问不出"还有几条线能用、哪条在被限流"。现在
  `FailoverLlmClient` 记每条线路的失败账 —— **只有真的收到 429 才计限流那一格**
  （5xx / 超时只算失败，两个计数不是一个东西）—— 并通过新的结构化出口 `onHealth`
  推全表：客户端**建好就推一份**（池里一共几条线，宿主不必等第一次失败才知道），
  之后每次失败与"从冷却恢复"各推一次。判定收在纯函数 `lineHealthOf` 里：`until > now`
  才算冷却中，到期必须回到可用（否则一条线路会被永久判死）；没失败过的线路也要在表里
  （零值，不是缺行 —— 界面要能回答"还剩几条能用"）。宿主侧 platform → 桌面 IPC 事件 →
  看板「线路健康」卡片（状态 / 剩余秒 / 失败次数 / 限流次数）。site 口径
  `http-clients` 56/56、`build-llm` 8/8、`src/store.ts` 21/21，逐位点全杀。

- **补齐 CLI 与桌面的能力差（竞品调研 P1-5，部分）**，按"差在哪"分三处落地：

  - **CLI 的验证命令现在收第四种 `kind: smoke`**。协议层的校验表此前只写了
    `build / typecheck / test`，而 `VerificationKind` 有四种 —— 于是 CLI 宿主传一条
    冒烟命令会被整段拒掉，同样的命令在桌面端却是合法的（那边不经这层校验）。
    能力差不该长在校验表里。
  - **常驻服务有 `pause` / `resume` 了**（`POST /pause`、`POST /resume`）：引擎通过
    `runSpec` 的新出口 `onEngine` 交到服务手上（在规划**之前**就给 —— 晚给了 PRD/任务
    分解这两段最烧 token 的部分就永远暂停不了），没有 run 在跑时返回 409 并写清原因，
    暂停状态进 `/state` 与状态页，run 结束时键必须消失（字段即承诺）。此前只有桌面有
    暂停/继续，headless 一侧完全没有对等能力。
  - **CLI 的 `snapshotRoot` / `manifestDir` 补上"真的生效"的断言**。此前所有 headless
    用例都**注入 layer**（自带这两个值），于是"spec 里那个路径有没有真的交给快照层 /
    清单加载"这件事没人看 —— 断链了也不会红。现在两条用例走平台自建那条路，并都做了
    反向注入验证（把传参改成 undefined，用例当场变红）。

- **headless 常驻服务形态（竞品调研 P1-1，对标 orca serve）**：`ox serve` —— HTTP + SSE
  复用现有 JSONL 事件流，配轻量状态页，把「离开工位也能看」这一格补上。刻意**不做**移动
  原生 App（推送基建 + 双端发版成本远高于收益），Web 状态页拿走其主要价值，且能被 CI /
  远程复用。`headless/serve.ts`（状态派生 / 路由 / SSE / 状态页）+ `serve-main.ts` 入口，
  测试走真 HTTP + 动态端口（端口 0，不碰真实配置）。变异审计 site 口径 25/25 全杀。
  后续的 `pause` / `resume` 与第四种验证 kind 见上一条 P1-5。

- **远程执行器「边界说破」（竞品调研 P1-4）**：`http-bridge` 适配器本就支持任意
  `baseUrl`，这一格缺的不是"能不能连"，而是**没人说破代价**。新增
  `electron/agents/remote-endpoint.ts`（`isLoopbackBaseUrl` / `remoteExecutorNote`，
  site 口径 3/3），装配层在加载非回环 http 声明时发一条边界说明：本地的 zone 越权检测、
  冲突仲裁、快照回滚对远端改动**静默失效**（不是报错，是看不见），远端侧隔离由它自己
  负责。配 `agents.d/remote-runner.example.json` 与 README 一节（`runDeadlineMs` 要算
  网络往返、`pollMs` 调大、凭证不写进 manifest）。

- **任务运行履历 `audit:trail`（P1-3 上下文回溯 · 后端）**：`board-derive.ts` 新增
  `taskTrail` 纯函数 —— `deriveBoardView` 回答"现在是什么状态"，它回答"经历过什么"：
  每次派发谁跑的、多久、为什么失败（`errorClass` / 日志摘录）、重派后**真正跑完**的执行器
  是谁（以 run-end 为准，run-start 的计划值会过期）。配对规则与看板推导同源；被腰斩的
  那次没有 `endedAt` —— 那是唯一的诚实表达。桌面 IPC 通道 `audit:trail` + preload 暴露，
  非法 taskId 守卫直接空回执、不碰审计存储。断点续跑与 UI 消费属 P1-3 后续批次。
  变异审计 site 口径：`ipc/agents.ts` 17/17、`board-derive.ts` 32/32 全杀。

### 未做（P1-5 剩余）

- ~~桌面侧仍未暴露 `snapshotRoot` / `manifestDir` / `escalationPolicy`~~ **已补齐（见下一条
  「桌面侧三字段」）**。~~P1-2 的**账号热切换**（启用/禁用某条线路、调整线路顺序）仍未做。~~
  **已补齐（见上一条「账号热切换」）** —— P1-2 至此全部完成。

- **桌面侧三字段（P1-5 收尾）**：`ProjectSettings` 新增 `snapshotRoot` / `manifestDir` /
  `escalationPolicy` 三个可选字段，设置页「执行策略」加三个入口；此前 Electron 侧写死读
  `userData/agents.d` 与 `userData/snapshots`，设置页没有入口 —— CLI 宿主能配的东西
  桌面配不了，能力差长在了配置面上。

  - **两个路径**：省略或空串 = 内置默认（空串进输入框清空即回默认，`||` 回退）。改路径
    **不迁移**旧备份/旧清单 —— 它们留在原处。layer 是缓存单例而 SnapshotStore 与清单
    加载器在构造时就把根目录存成字段，所以两个路径都进了 layer 的缓存 signature
    （与 `executorTimeoutMs` 同一防漂移手法：改了设置必须真的重建，否则改的是摆设）；
    平台层每次 run 重建，路径改动对下一次运行即时生效。
  - **升级处置策略**：重修轮耗尽时的默认处置。桌面在此前只有"弹窗等人"一种语义的
    基础上，补齐与 headless 协议同义的四种自动策略（`abort` / `skip` / `redispatch_once` /
    `exhaust`），外加桌面特有的 `ask`（默认，现状不变）作为第五种 —— 无人值守跑长单
    不再被弹窗卡住。`redispatch_once` 的"每任务一次"账本挂在单次 platform 上（每次
    run 重建，天然 per-run，与 CLI 账本语义一致）；`exhaust` 刻意让决策回调整个缺席
    （字段即承诺），引擎随后把"预算耗尽"报成结构化错误而不是挂在一个永远不会有人
    回答的 Promise 上 —— escalation 事件照发，升级发生过这件事仍可见，只是没有决策入口。

  测试：`ensureAgentLayer` signature 三态（改→重建 / 同→复用 / 空串→默认路径）、
  `buildPlatformLayer` 传参、升级策略五格（ask 挂起可解 / skip·abort 自动且不进弹窗队列 /
  redispatch_once 一次账本按任务隔离 / exhaust 回调缺席）+ 设置页 UI 载荷断言（含
  trim 与空串→undefined）。

- **任务级冗余赛马（竞品调研 §5.3，学 Vibe Kanban）**：`raceRedundancy`（默认 1 = 关闭）
  让一个任务同时派给 N 个**不同**执行器，第一个到终态成功者赢、其余立即 abort。产物
  正确性不靠赛马 —— 批次后的统一硬门禁照旧把关，赛马是拿 token 换时间（等慢执行器的
  批次里快者先交付）。输家**静默**：不进审计、不记 breaker、不进任务账（输家被中止不是
  执行器的错，也不能让 aborted 事实污染看板恢复语义），全组归因由赢家的 `logDigest`
  承载（成员、各自结局与时长）；全员失败时汇总一份失败 outcome 进重修。池子不够
  （redundancy > 1 但可用执行器只有 1 个）时退化为单派发，与关闭时行为完全一致。
  设置项走 settings → platform → scheduler 全程接线，桌面设置页可配 1–6。

### 修复

- **变异门禁：`scheduler.ts` 9 处存活清零（2026-09-30）**。7 处来自赛马分支 —— 此前
  **没有任何用例开启过赛马**（功能写完了、判定的证据一格都没有）；2 处来自并发准入的
  改派分支，处置方式值得单列：端到端**构造不出**它的输入 —— `registry.candidates` 在
  评分层就把满载 agent 滤掉了，router 永远不会把「满载的声明 agent」递到准入闸（实测：
  池里只要有 legacy，router 就先选 legacy），于是这条二次防线拿不到"它守住了"的证据。
  按项目既有做法把入参显式化 —— `admitConcurrency` 从私有方法提为**模块级导出函数**，
  测试直接喂「上游失效」的组合（满载 wanted + available 里的 legacy / 未注册者），
  源码语义一行未改。赛马侧补四条用例覆盖三类终局（赢家交付 / 输家被中止 / 全员失败）
  与退化单派发，另补「输家晚于赢家完赛」「失败者无日志」两条边界。
  site 口径 **33/33**（此前 24/33）。

- **三元算子变异门禁 56 处存活清零收官**。`cond ? x : y` 分支互换算子首次全量评估
  露出的 56 处真缺口（回退三元、条件展开透传、排序比较器、错误信息取字段）分四批
  全部处置：多数以「接收侧容忍 `undefined` → 条件展开简化为直接传值」收口，其余补
  「字段真的到了接收侧」「错误消息带原始 message」「默认值回落」「排序结果」类断言。
  收官轮全量 audit 又抓到两条漏网（`file-journal` @140 是评估清单漏记）——同根因：
  **排序比较器的内层互换对键互异的数组在 V8 小数组二分插入排序下是行为等价变异**
  （`1` 与 `0` 都把较大元素插到右侧）。处置不硬凑断言，而是把两处比较器的不可达
  相等分支删掉（`? -1 : 1`），变异面从每行 2 个收敛为「整体反转」1 个，由顺序断言
  稳定杀死；`sensenova-api` 的指纹新增「枚举序 ≠ 字典序」（`a.txt` vs `a/x.txt`）
  反例断言，钉住「指纹按 rel 字典序」——否则同一工作区在枚举顺序不同的机器上指纹
  漂移、快照缓存失效。收官口径 `--ops=ternary --mode=site --limit=999`：
  **881/881 逐位点全杀**。
- **三元算子转正进 `verify` 门禁**。收官（881/881 逐位点全杀）当日把「三元分支互换」
  从 `extra`（评估中）转为默认算子：`mutation:quick` / `mutation:site` /
  `mutation:audit` 无需参数即包含三元位点，此后新增 `cond ? x : y` 形状的
  回退/默认值判定自动被门禁看守。`--ops=ternary` 保留兼容；`?? → ||`
  仍为评估中（未全量评估，不贸然进门禁）。转正基线：默认算子全量 site audit
  **881/881（21.0 min）**，`mutation:quick` 与 CI 同构抽样 341/341 同轮通过。
- **zone 互斥的判据从「同名」改成「重叠」**（`shared/graph.ts` 的分批 + `electron/engine/scheduler.ts`
  的批次不变量断言）。两处此前都只做字符串全等，于是 `src` 与 `src/util` 被当成互不相干而**同批并发**：
  两个智能体可以写同一个文件，而越权检测对这一形状是瞎的 —— 每条写入都落在本批**某个** zone 之内，
  `BatchGuard` 会放行。zone 是模型在规划期输出的（`shared/prompts.ts:69` 要 "a concrete directory this
  task owns"），所以不是理论风险：规划器给出 `src` + `src/store` 这种父子划分就会撞上，
  而旧用例只测了同名冲突（`scheduler.test.ts` 的 `same`/`same`）。
  新增 `shared/glob.ts` 的 `zonesOverlap(a, b)`：对称地问「两者会不会抢同一个文件」，
  即 `isPathInZone(a,b) || isPathInZone(b,a)` —— 复用仲裁门的宽松语义，所以
  `src/duration` 与 `src/duration.js` 也算同地盘。比较**刻意大小写不敏感**：Linux 上把
  `src/Store` 与 `src/store` 并成一个只是多串行一轮，Windows 上把它们当两个的代价是同批写同一文件；
  两种误判不对称，所以取便宜的那个。
  代价是并行度可能下降，这是有意的：`planBatches` 只顺延冲突的那个任务，同批其余照旧并行
  （`defers only the conflicting task` 一条钉住），另有一条反向守卫防止判据被写成"共享任何前缀都算重叠"。
  反向验证：把 `zonesOverlap` 退回旧的全等语义 → **11 条用例红**，横跨 glob / graph / scheduler 三层，
  而旧的"同名冲突"用例仍绿 —— 那正是原缺陷能活到今天的原因。
  site 口径逐位点：`shared/glob.ts` 24/24、`shared/graph.ts` 8/8、`electron/engine/scheduler.ts` 18/18 全杀。
  顺带把 `EQUIVALENT_SITES` 里 scheduler.ts 的两条行号锚点校回 345 → 346（同文件多了一行 import，
  校回时确认那两层防御原样仍在）。
- **还原写盘加了重试：写不进去时不再抛在 `finally` 里**。本机 2026-09-28 连续两次实测
  `fs.writeFileSync` 抛 `UNKNOWN (errno -4094)`（Windows 上杀软 / 索引器短暂占住刚被改写的文件），
  而那句正待在 `finally` 里 —— 它一抛，进程就带着**活体变异体**死掉。两次各砸在链条的不同段：
  第一次 `mutation:quick` 出裸栈，第二次 `mutation:touched` 报「`shared/glob.ts` 与 `shared/graph.ts`
  两个目标未通过」，而 graph 那一轮其实一行审计都没跑 —— 它只是启动时把 glob 的残留还原了。
  现在 `restoreSource()` 重试 4 次（200/400/600/800ms）、写后校验内容、尽力后返回 false 并点名，
  由 `runTarget` 末尾既有的「未还原」判定收口成 exit 2，台账留给第 1 段自愈；`restoreAll()` 同样走它。
  证明在 `src/mutation-residue.test.ts` 的 `restoreSource` 一节：按锚点从门禁脚本里抠出函数体
  （手法同 `masker-selftest.mjs`，不留第二份实现），故障用「父目录不存在」制造 —— 各平台确定性 ENOENT；
  没用 chmod 只读，因为 root 身份下它拦不住写。承重性验过：把 catch 改成重新抛出（等于回到旧行为）
  → 该用例红。
- **强杀自愈挪到了它该在的位置：`verify` 第 1 段 `check:residue`**。下一条的方向对、位置错 ——
  `recoverPendingRecord()` 只在 `mutation:quick` 里跑，而 `npm test` 排在它**前面**。2026-09-28 实测：
  工作区留着一处 `=== → !==` 残留时，编排器的升级判定空转，vitest 单进程堆涨到 4.6GB 后
  `Reached heap limit` OOM，**且父进程不退出**（挂住而不是失败；两次复现同一位置、几乎相同的堆轨迹）。
  于是"上一轮被超时杀掉"这件事，下一轮门禁不会红在相关处，而是崩在完全无关的地方。
  现在 `npm run check:residue`（= `node scripts/mutation-check.mjs --recover-only`）做同一件事，
  还原路径仍然只有 `recoverPendingRecord()` 一份，没有复制实现。`verify` 由 19 段变 **20 段**。
  顺带堵住一个会说谎的分支：台账 JSON 坏 / `.orig` 备份缺失时，旧逻辑静默清台账当无事发生，
  而目标文件**可能仍是变异体** —— 现在这种情形退出 2，且不许打印"工作区干净"。
- **`admission-gateway-it.mjs` 缺的一条断言**：合规交付的 `POST /result` 响应被接进 `result2` 却从未检查，
  "提交被接受"只由后续事件流间接证明。现在直接断 HTTP 200。这是 `scripts/**` 进 lint 后由
  `no-unused-vars` 抓出来的第 5 处，也是唯一一处**缺断言**（其余 4 处是死代码/未用 import）。
- **删掉 `admission-gateway.mjs` 里算了不用的 `agentId`**：`/result` 的契约（见该文件头）本来就没有 agent
  参数，运行归属靠全局唯一的 runId 认。留着会让读者以为交结果需要自报身份。

- **变异门禁被强杀时，变异体会永久留在工作区**（`scripts/mutation-check.mjs`）。
  此前靠内存里的 `pending` + `exit`/`SIGINT`/`SIGTERM` 钩子兜底还原，但 Windows 上
  进程被外部终止（任务管理器 / CI 超时 / IDE 关进程树 → `TerminateProcess`）时
  **这些钩子一个都不执行**：2026-09-27 实测，脚本被超时杀掉后
  `electron/sandbox/snapshot-store.ts` 的 `continue → break` 变异体留在了源码里，
  只有 `git diff` 才看得见。现在改写源文件**之前**先把原文落盘
  （`scripts/.mutation-pending/`，已 gitignore），下次启动时先自愈：发现残留就
  还原该文件并 **exit 2**（而不是带着刚恢复的未知状态继续给结论）。

### 新增

- **`scripts/**` 第一次有语义检查**。那 5.7k 行是 `verify` 的判据本身，而 `tsc` 一行都不看 ——
  此前唯一的保护是 `check:scripts` 的 `node --check`，那是**语法**。`eslint.config.mjs` 现在按
  `.mjs`（ESM）与 `.cjs` / `scripts/acceptance/*.js`（CommonJS）分两块覆盖它，node 全局名手写进
  `SCRIPT_GLOBALS`（不引未在 package.json 声明的 `globals` 包，避免幽灵依赖）。
  规则刻意比 TS 侧松：`no-console` 不开（脚本的职责就是打印与按退出码判定），`require-await` 不开
  （有一批"要形状不要 await"的 async 门面 `text()`/`json()`/`chat()`）。
  落地即抓到 4 处真死代码：`check-unwired.mjs` 的 `TYPE_RE` 声明后从未使用（改成注释记录"类型导出
  不参与零调用判定"的意图，别让人再加回来）、`import-headless-run.mjs` 的 `fileURLToPath`、
  `loomy-bridge.mjs` 的 `os`、上面那条 `agentId`；以及 `mutation-check.mjs` 里一处无用初始化赋值。
- **`src/mutation-residue.test.ts`（7 例）** 钉住自愈的四条出口（干净 / 内容已一致 / 台账不可用 / 真还原）。
  承重性反证过两次：摘掉写回那句 → "restores the mutated file" 变红；摘掉 `unknown` 守卫 →
  两条 "refuses to call the workspace clean" 变红。它同时把"带着残留跑测试"变成一次点名失败，而不是 OOM。

- **变异门禁新增两个目标**（`electron/audit-log.ts`、`electron/agents/index.ts`），
  逐位点审计各补齐断言：`audit-log` 11/11、`agents/index` 2/2。
  并删掉 `createAgentLayer` 旁的 `findAdapter` —— 生产零调用（调度器用的是自己的
  私有同名方法），它唯一的作用是贡献一个永远杀不死的位点。

- **`executorTimeoutMs` 打通最后一跳**（`electron/agents/sensenova-api.ts`）。
  这条链是 协议 → settings → `createAgentLayer` → 适配器，前三跳早有断言，
  **最后一跳没有出口可观测**：宿主设了超时而适配器仍用内置默认 300s 的断链，
  没有任何测试会发现（变异实测 `!== undefined` 改成 `=== undefined` 全绿）。
  现在 `requestTimeoutMs` 刻意不是 private（注释写明理由），并加了两条断言钉住
  「传入时真的用了它 / 省略时回落到 `EXECUTOR_TIMEOUT_MS`」。

- **快照二次防线第一次有了可执行的证明**（`readSnapshotContents`）。
  它里面的两处 `continue`（凭据文件 / 读不出来的文件）在真实调用链上不可达 ——
  Phase 1 的 walk 已经用**同一个** `isSecretLikeFile` 过滤过一遍，于是逐位点审计
  里这两处变异全绿，防线拿不到「守住了」的证据，只有「还没被需要」。
  现在把它从私有方法提成模块级导出函数（入参显式化成 `statEntries`），测试可以
  直接喂「上游漏过来的 / 读不出来的」条目 —— 两处变异均被杀死（已反证）。

- **全量逐位点基线刷新：`701/701（100%）`**
  （`docs/2026-09-23-mutation-site-baseline.md`「六轮快照」）。**51 个目标**、28.3 分钟、
  本机 Windows 全量 `--mode=site`。分母比上一轮（695）+6：第十一批三个 LLM 网关目标。
  ⚠️ **扩目标这条路已走到头**：剩余未纳管的模块逐个看过源码，全是纯类型 / 纯
  re-export / 纯注册 / 零算子的 IPC 桥 / 入口胶水 / 测试替身（清单见报告）。
  再提升只能动算子表 —— 现 7 个算子覆盖不到三元与 `??`，而本项目大量回退逻辑
  正是这个形状。

- **变异门禁第十一批：LLM 网关的线路组装三层**
  （`shared/providers.ts` 2/2、`shared/build-llm.ts` 3/3、`shared/agent-contract.ts` 1/1）。
  这三层是同一个问题的三个截面 —— **哪个 provider 带几个 key、几个模型进池**，
  判错都不抛异常，只表现为线路池悄悄少几条线 / 带错模型（sensenova 的 3×4=12 条
  塌成 3×1=3 条，或把 SenseNova 的模型名发给 AMD 的端点），真出 429 之前无人察觉。
  同批把线路组装提成 `buildPoolRoutes`（纯函数），「池里到底有什么」第一次可断言，
  补 4 条用例（默认池及顺序、空数组回落、各 provider 的 key/模型、单点名）。

- **变异算子表新增「三元分支互换」**（`cond ? A : B` → `cond ? B : A`，默认关闭，
  `--ops=ternary` 启用）。此前 7 个算子覆盖不到三元，而本项目大量「回退 / 默认值」
  逻辑正是这个形状 —— 首次全量评估 `875/931（94%）`，**56 处存活逐条看过 diff，
  无一是等价变异**（全部是真缺口，分类与清单见 `docs/2026-09-23-mutation-site-baseline.md`
  「三元算子评估」一节；基础算子仍是 701/701 全杀）。
  暂不进 `verify`：56 处处置完之前会让门禁长期红。同批按「冗余判定 → 简化源码」
  处置了抽样中暴露的两处（`build-llm.ts` 的 key 三元与 onEvent 条件展开）。

### 新增（承接上一轮）

- **CLI 智能体 dispatch 的环境裁剪诊断**（`electron/agents/cli-agent.ts`）：
  第三轮 `--real` 演习实测：PRD 大脑描述 CommonJS 接口时写出
  "require/module.exports"（斜杠连接的模块系统概念），两段形态恰好骗过
  "至少两段目录"启发式，被当成真实嵌套路径提取 → zone 覆盖校验永远失败 →
  规划带错重试 2/2 也纠不回来（分解层无法让 zone 覆盖一个不存在的文件），
  演习在 PLANNING 就 exit 1。现在提取器对路径段做代码概念黑名单（require /
  import / export / exports / module.exports / default，任何一段命中即判为
  代码引用），真实文件路径不受影响。同修一个认知：这类问题修在提取器
  （硬保证）而不是规划 prompt（软约束，模型可能再犯）——第三轮演习三连
  同错已经证明带错重试对它无能为力。

### 新增

- **CLI 智能体 dispatch 的环境裁剪诊断**（`electron/agents/cli-agent.ts`）：
  最小化子进程环境时裁掉了哪些密钥变量，现在会如实记入该 run 的事件流
  （只记名字、永不记值），操作员可核对"没有误裁、也没有漏裁"。

### 变更

- **文档口径同步**：README 门禁索引节改为 20 段并补第 1 段 `check:residue`；两处硬数字按实测刷新
  （用例 984 → 1142 通过 + 9 跳过、site 基线 603/603 → 701/701 并标注日期与"落笔即过时"）；
  README 架构表里 `shared/` 那行原写"目前只是约定，无 lint/tsconfig 机制强制"—— 该红线 2026-09-25 起
  已由 `no-restricted-imports` 强制，改为陈述事实而不是留旧说法。
  skill 手册同步三处：`references/gates.md` 加第 0 段与「表内 `#` ≠ `verify` 串位置，引用优先用脚本名」
  的约定、`references/architecture.md` 的「分层红线」一节（旧内容与同目录 gates.md 自相矛盾）、
  `SKILL.md` 的三条硬事实与红灯速查（残留那一行的症状从"红在无关文件"改为实测的 heap OOM + 挂住，
  处置从 `git checkout --` 改为 `npm run check:residue`，并说明前者会连同一文件里本轮的真实改动一起删）。

---

## [0.1.7] — 2026-09-27

### 新增

- **线路速度画像：快线路优先（池层，`shared/http-clients.ts` 的
  `FailoverLlmClient`）**。2026-09-27 `--real` 演习实测驱动：旧实现按构造
  顺序静态轮换，慢线路排前时每次先被试、一次吃满 attempt 预算（glm-5.2
  529s 才交付 vs 快线路 74.6s），快线路轮不到。现在每次调用把不在冷却的
  线路按「成功耗时画像」动态排序：已知快的先试、无历史保持原顺序排后
  （利用优先）、**失败从不记速度**（失败走冷却惩罚）；成功耗时按 EWMA
  （α=0.5）平滑单次抖动。安全语义不变：冷却跳过、backoff、auth fail-fast、
  取消不冷却，全部原样；任一线路只要前排失败就仍会被轮到（备用线路在快
  线路故障时自动接上，有专门用例钉住）。行为变化：冷却过期的慢/坏线路在
  快线路健康时不再被周期性探测——这是"利用优先"的取舍，CHANGELOG 如实
  记录。

- **文件级 zone 的交付约定**（`shared/deliverable-format.ts` + 桥）。同日 `--real`
  演习实测：规划官会划出**文件级 zone**（t1 的 zone 是 `src/core/csv.js` 这个
  文件本身），而桥的目录措辞（"修改 `${zone}/` 目录内的文件"）与路径示范
  （`${zone}/xxx.js`）把模型带偏成在 zone 下建子文件（`src/core/csv.js/index.js`）
  —— 解析器内容 7/7 合约全对，却因路径不合约败掉验收。现在三种约定各就各位：
  ① 示范直接写 zone 文件本身（`===OXFILE src/core/csv.js===`）并声明"zone 是
  一个文件不是目录"；② `resolveDeliverablePath` 对文件级 zone 做 fail-safe 归一
  （zone 下任何子路径/裸文件名/穿越企图的唯一合理解释都是 zone 文件本身——
  写不出 zone 以外，绝对路径仍交 assertWritable 拒绝）；③ 新增 `zoneWriteRule`
  按文件级/目录级给出各自正确的"只允许写什么"措辞。目录级 zone 行为完全不变。

- **桥接智能体的交付格式：OXFILE 分隔符原文块（零转义），JSON 保留为回退**
  （`shared/deliverable-format.ts` + `scripts/loomy-bridge.mjs`）。这是 2026-09-26
  实弹演习 t1（CSV 解析器）四发超时的根因治理：旧格式要求模型把完整代码文件
  内容作为 JSON 字符串输出，代码里的引号、反斜杠、换行全部要转义——而 CSV
  解析器恰恰是"引号处理本身就是业务逻辑"的任务，转义层叠转义（代码里的 `\"`
  进 JSON 要写成 `\\\"`），生成 token 膨胀、模型反复挣扎在 JSON 语法上，
  单次生成本身逼近/超过桥的单次尝试时限。新格式让模型**原样输出文件内容、
  无需任何转义**（`===OXFILE 路径===` … `===OXEND===` 块 + `===OXSUMMARY===`
  总结行），解析侧对未知 `===OX` 行防误伤、对未闭合/空内容块显式抛错（截断的
  半份代码不如明确失败，让平台修复轮拿到根因）。格式定义与解析器收敛在
  `shared/deliverable-format.ts` 单一事实来源，桥经编译产物消费（同
  `buildLlmPool` 模式）；25 条定向用例锁定块解析、回退、路径归一与指令-解析
  不漂移。实弹预检一发验证通过：模型对 OXFILE 格式服从良好（74.6s 出稿，
  对比旧格式 t1 同类任务挣扎 300s+ 超时），引号/正则/中文内容原样落盘，
  交付物 node:test 直接可跑。

### 变更

- 桥不再传 `maxTokens: 8192`：池层（`shared/http-clients.ts`）固定用端点声明
  的输出上限 65536 并显式检测 `finish_reason=length`，调用方传小值会被静默
  忽略——与其留一个不生效的参数误导后来者，不如不传（附注释说明）。

## [0.1.6] — 2026-09-27

### 新增

- **内置执行器（SenseNova API）单次调用的超时现在可以配**（`shared/types.ts` 的
  `ProjectSettings.executorTimeoutMs`、`electron/platform.ts` 的 `executorTimeoutMsFor`、
  `electron/agents/sensenova-api.ts`、设置页「执行器单次调用超时（秒）」）。
  这是 `brainTimeoutMs` 那条的同族项：同一段代码里另一个 300s 常量
  （`EXECUTOR_TIMEOUT_MS`），此前同样连环境变量都不读。它管的是**生成代码那一路**的
  单次 HTTP 请求 —— 与大脑层的拥塞表现同源，痛点也同源（被掐断只能改代码重新打包）。
  沿用同一套取值语义：`undefined` / `0` / 负数都归"用内置默认"，只有正数算用户设置。

  **这次特意把两条路一起打通**，不再留"只有桌面端能调"的半截：
  ① headless 协议（`headless/protocol.ts`）同步认 `executorTimeoutMs`，规矩与
  `brainTimeoutMs` 一致（只认正数，想用默认就省略）；
  ② 桌面端的 `ensureAgentLayer` 是**缓存的单例**，而适配器在构造时就把 `timeoutMs`
  存成了字段 —— 所以这个值必须进缓存 signature，否则"设置页改了、layer 还是旧的"，
  界面上有输入框却改不动。大脑层不需要进（它在 `buildLlm` 里每次现读）。

  用例：`executorTimeoutMsFor` 取值归属 4 条、真的传进 `createAgentLayer` 2 条、
  协议侧 4 条（含"协议与平台两头对得上"那条 `executorTimeoutMsFor(spec.settings)`）、
  设置页按秒填存毫秒 1 条、缓存 signature 1 条（改值重建 / 同值复用 / 再改再建）。

### 修复

- **并发准入：`maxConcurrency` 现在是硬上限，不再是软偏好**（`electron/engine/router.ts`、
  `electron/engine/scheduler.ts`）。2026-09-26 实弹演习实测：`maxConcurrency=1` 的
  loomy 在 t1 在飞时仍接下 t2 —— t2 评分时已打出 `load=1/1(-10)`，但 -10 的软惩罚
  压不过优先级/专属区的分差，照样胜出。设计文档（编排计划的三级限流）里白纸黑字的
  `inflight < maxConcurrency` 硬拦从未落地。现在分两层补齐：
  ① **评分层**（router）：满载的声明候选直接出局（与 `circuit=open` 同类的动态硬拦），
  评分理由里不再出现它的 `load=N/N` 明细；**合格候选全部满载时如实报"无人可派"，
  不回落 round-robin** —— "能力不匹配"回落是务实兜底（这单它永远做不了），
  "满载"回落则是把任务硬派回满载者，能力声明等于白写；
  ② **调度层**（scheduler）：新增并发准入闸，把关两条绕过评分的路径 ——
  round-robin 兜底（否则"无人可派"的决定会被兜底硬塞回满载者）与点名直派。
  点名满载时**不静默改派**（点名是显式意图），超出部分 no-agent。
  满载任务走既有的 no-agent → 修复轮重派链路（agent 空闲后自然排上），刻意不做
  批内排队等待 —— 排队会让整批墙钟不可预测，也不如复用结构化重试诚实。
  legacy（v1）池完全不受影响，round-robin 保真是明文承诺。
  边界：并发计数是批次局部的；跨 run 的真实在飞数走 `AgentLoadStats.inflight`
  接口（协议已预留，宿主尚未提供）。
  用例 10 条：router 4（满载出局 / 全满载不回落 / legacy bypass / 未满载参评）、
  scheduler 6（批内改派 / 唯一满载 no-agent / 点名超限 / legacy 池不变 /
  spare 命中 / 点名 legacy bypass）。构造要点：满载者必须带 `priority=50`
  复刻演习形态 —— 同权候选里 -10 恰好让空闲者反超，用例会在旧实现下就绿，
  钉不住硬拦语义（这条弯路本身记进了用例注释）。

## [0.1.5] — 2026-09-27

### 新增

- **headless 协议现在认 `brainTimeoutMs`**（`headless/protocol.ts`、
  字段表补进 `docs/headless-protocol.md`）。0.1.4 把大脑层单次调用超时做成了设置项，
  但**只有桌面端那条路走得通**：headless 的 spec 解析不认这个字段，宿主写进去会落进
  「未知字段已忽略」的 warning，于是无头调用方想调这个超时只能改代码重新打包 ——
  正是桌面端那条要解决的问题。现在它是 `KNOWN_FIELDS` 的一员，合法值流进 `settings`。
  **口径刻意与桌面端相反**：设置页里 `0` 与负数都按"用内置默认"处理（填框的人留空是常态），
  协议层只认正数、`0`/负数/非数字一律报 issue —— 宿主算出 0 通常是秒→毫秒换算漏了，
  静默当默认会让它以为设上了。想用默认就省略该字段，与 `maxTokensPerRun` 同一条规矩。
  用例 5 条（合法值落 settings、省略时无该字段无 warning、0/负数/NaN/字符串全拒、
  小数向下取整、`1e999` 溢出成 Infinity 也被拒），另有一条**把协议与平台两头接起来**的断言：
  传入时 `brainTimeoutMsFor(spec.settings)` 等于该值、省略时等于 `BRAIN_POOL_TIMEOUT_MS`
  —— 只断言"字段在不在"挡不住"协议认了字段、平台没读"这类断链。
  反证：摘掉 settings 里的透传一行 → 3 条用例红（`expected 300000 to be 45000`），已还原。
  顺带补上字段表里早先漏掉的 `maxTokensPerRun` 与 `runWallClockMs` 两行。

## [0.1.4] — 2026-09-27

### 新增

- **大脑层单次 LLM 调用的超时现在可以配**（`shared/types.ts` 的 `ProjectSettings.brainTimeoutMs`、
  `electron/platform.ts` 的 `brainTimeoutMsFor`、设置页「大脑层单次调用超时（秒）」）。
  此前这个值是硬编码常量 `BRAIN_POOL_TIMEOUT_MS`（300s），**连环境变量都不读** ——
  拥塞窗口下请求被掐断时，用户只能改代码重新打包。现在设置里按秒填、按毫秒存。
  两个刻意的语义：
  ① `0` 与省略都是**用内置默认**，不是"不限" —— 0 毫秒的超时没有意义，
     这里刻意**不**沿用 `runWallClockMs` 的"0 = 不限"（两者管的东西不同）；
  ② 它管的是**单次 HTTP 调用**：超时只掐掉卡住的那一次请求，线路轮换接着试下一条，
     与整轮墙钟上限（到点停下并保留现场）、token 预算是三件不同的事。
  取值抽成 `brainTimeoutMsFor()` 而不是内联，是因为"省略 / 0 / 负数 / 正常值"
  四种输入的归属很容易写错成 `v ?? 0`。
  用例 7 条：取值归属 4 条 + "真的传进了 buildLlmPool"2 条 + 设置页秒/毫秒换算 1 条。
  ⚠️ headless 协议侧还没开口子（`run-spec.ts` 暂不认这个字段），下一轮补。

## [0.1.3] — 2026-09-27

### 新增

- **运行时注册的智能体现在会落盘**（`electron/agents/manifest-loader.ts` 的 `saveManifestFile` /
  `removeManifestFile`、`electron/ipc/agents.ts` 的 register / unregister、
  `src/components/AgentsPanel.tsx`）。此前 `agents:register` 只把 manifest 塞进内存 Map，
  重启或崩溃就没了 —— UI 只能提示"自己把 JSON 抄到 agents.d"，而一次注销就把配置丢了。
  现在注册**同时**把 manifest 原子写进 `agents.d/<id>.json`，重启走 `loadManifestDir` 照样加载。
  三个刻意的取舍：
  ① **落盘失败不回滚注册** —— 这一轮的 agent 确实能用，但返回值带 `persisted.ok:false`，
     UI 必须说清"重启后会丢"，审计里也留一句"落盘失败：…"。只报"已注册"会让人以为记住了。
  ② **注销只在文件内容与注册时一致时才删** —— 用户手工改过的 JSON 是他的东西，
     注销一个智能体不该连带毁掉他改过的配置；那种情况不删，并把原因报出来。
     否则"注销"只在本轮生效，重启一看它又回来了，而用户完全不知道为什么。
  ③ 文件名由 id 决定（这样**重启之后还能定位**，注销时内存映射已经没了）；
     id 含非法字符时替换成 `_` 并追加一段短哈希，免得 `a/b` 与 `a b` 撞成同一个文件。
  用例 7 条，含缺陷注入反证（把 `sameManifest` 改成恒真 ⇒ "文件被改过就不删"那条变红）。

## [0.1.2] — 2026-09-26（首个可安装的分发包）

这是第一个**真的有安装包可下载**的版本：Windows `OxCommander-0.1.2-x64.exe`、
Linux `OxCommander-0.1.2-amd64.deb` 与 `OxCommander-0.1.2-x86_64.AppImage`，
由 `release` 工作流在打 `v*` tag 时产出并挂到 GitHub Release 上。
（打包链路本身是怎么被修通的，见下面「新增（CI / 分发）」那三条。）

### 新增
- **预算闸现在会自己承认看不见多少**（`shared/usage-meter.ts` 的 `onBudgetBlind` / `budgetBlindNote`、
  `electron/platform.ts` 接线）。缺口：闸门判断用的是端点上报的 `usage.total_tokens`，
  而有些端点根本不回报这个字段 —— 那些调用的 token 永远进不了 `totalTokens`，
  `maxTokensPerRun` 对它们等于不存在（此前的表现是"总量 = 0、闸从不拦"，看板上读起来像还很安全）。
  这次**只做宣告、不做估算**：第一跳没上报用量就 `[budget]` 说一句（含上限与"看不见几次"），
  终态那行 `[usage]` 在有预算且有未上报时同样带上这句；没配预算、或每跳都上报时不说，
  坏预算值（0/NaN/负）按"不限"处理也不说。估算那半为什么不做：没有本机校准过的
  "字符→token"分布，估出来的数会被当成账单口径读，比不估更坏 —— 要估算得先做校准实测。
  用例 6 条（含"摘掉 platform 接线 ⇒ 该用例红"的反证，实测 1 failed / 29 passed）。
- **跳过上游之后，它的下游不再被继续烧钱**（`shared/graph.ts` 的 `skippedDescendants` +
  `electron/engine/orchestrator.ts` 三处判定）。这是"点名下游"那条留下的后半段：
  提示说清楚了，钱照烧 —— 被跳过的上游在派发上视同已满足，下游失败后每一重修轮都再派一次，
  到了耗尽还要问一句"要不要重派"，而**重派永远补不上那份被跳过的产物**，用户每答一次"重派"
  就多花一整轮 run 的预算。现在按"人自担、但不任人烧预算"落地：
  ① 下游只给**第一次**机会（已试过 + 被传染 ⇒ 后续重修轮不再派发，并点名说清为什么）；
  ② 耗尽时**不再对它弹升级决策**（那里只有终止/跳过/重派三个答案，问它就是诱导再花钱），
  改成一句"要它就把上游补上重跑"；判定用传递闭包，多上游只要有一份被跳过就算传染，
  用户在循环里中途跳过的上游会立刻影响后面的任务（每处理一个都重算，不是开头算一次）；
  ③ 终局文案跟着改：从"所有失败任务已被跳过"改成"上游被跳过带累 N 个下游任务"。
  **一条旧断言随之作废并改了**：原来"跳过点名下游"那条用例期望终局是 `用户终止`
  （测试里对下游答了 abort）；现在下游根本拿不到那一问，终局变成"带累 1 个下游任务"——
  这是行为变化，不是用例写坏。
  门禁侧：`electron/engine/orchestrator.ts` 逐位点从 31/34 补到 **33/33**，三个存活变异
  两个补了断言（放弃声明必须晚于该任务真的被派发；被传染的任务排在前面时，后面的正常任务
  照样要拿到决策），一个靠**改写结构消掉**（去重从循环里的 `continue` 改成集合差 + 一条汇总）。
  顺带纠正那条勘误里的一个说法：site 审计的算子集**不止** `&&`/`||`/`===`/`!==`，
  `--list` 按文件打印，本仓库还出现过 `继续(continue) → 中断(break)` 与 `return true → false`；
  "数值比较（`>`/`<=`）不在算子集里"这半句仍然成立。
- **声明并检查 headless CLI 的 Node 下限**（`package.json` 的 `engines`、`headless/protocol.ts` 的
  `runtimeGap`、`headless/headless-main.ts` 入口）。上一笔接取消时用了 `AbortSignal.any` 合并
  "单请求超时 ∪ 调用方取消" —— 那是运行时路径上**第一个**把下限抬到 Node 20.3+ 的 API
  （此前只有 `structuredClone` 与 `AbortSignal.timeout`，17.x 就够），而仓库既没有 `engines`
  也没有任何版本要求文档。症状会很难看：宿主用旧 node 驱动 CLI，planning 的 token 花完之后
  第一次执行器调用才从 `postJson` 抛 `TypeError: AbortSignal.any is not a function`。
  现在判据是**特性而不是版本号**（发行版会回移特性），缺了什么直接说"当前 X，需要 >= 20.19，
  因为缺 AbortSignal.any"，并且**先于读 stdin** —— 宿主不关管道时，"跑到一半才崩"会变成"永远挂着"。
  桌面端不受影响（Electron 33 自带 Node 20.18+，且它总走自己的运行时）。
- **取消与超时现在真的掐得掉在途 LLM 请求**（`shared/providers.ts`、`shared/http-clients.ts`、
  `shared/llm-client.ts`、`electron/agents/{run-session,sensenova-api}.ts`）。
  此前 `postJson` 只把 `AbortSignal.timeout(300s)` 交给 fetch，**没有任何调用方取消的入口**：
  用户点"中止"或 run 撞到时限，事件流会立刻收口，但那一次请求继续跑完、继续花 token、
  回来后还要走一遍沙箱写入判定（上一轮靠"丢弃生成物"兜住副作用，钱是兜不住的）。
  现在 `ChatRequest` 带可选 `signal`，与内部超时合并后下传（谁先响谁算）；
  内置执行器按 run 挂一个 `AbortController`，`abort()` 与看门狗到点都会真的掐掉那一回合。
  连带修掉三个"接上取消之后才会出现"的坑：
  ① `isTransient` 对一切非 HTTP 错误返回 true ⇒ 取消会被当成线路故障，**换个 Key 把同一份 prompt
  再发 11 次**，所以 `FailoverLlmClient` 现在见到 `req.signal.aborted` 原样抛出、**不轮询也不冷却**
  （一次取消不该惩罚后面所有 run）；② `chatJson` 的自纠偏重试会重发已叫停的请求 ⇒ 加了同样的短路；
  ③ 并发槽位仍跟着真实请求释放，不因超时提前放行。
  用例：取消后只调用过第一条线路 / 零条"冷却 N 秒"处置 / 下一次正常调用仍先试同一条线路、
  signal 真的下传（不合并就是 5s 挂住）、不传 signal 时内部 `TimeoutError` 照旧、
  `abort()` 与超时时 `req.signal.aborted` 为真、自纠偏只发 1 次。
  反证四处各跑过：摘掉故障转移的取消分支 1 failed / 24 passed、摘掉 signal 合并 1 failed / 10 passed、
  摘掉执行器接线 2 failed / 27 passed、摘掉 `chatJson` 短路 1 failed / 19 passed。
- **内置执行器（`sensenova-api`）现在也有 run 级时限**（`electron/agents/sensenova-api.ts`）。
  在此之前三个适配器里只有它不带 `limits`、不接 `TimeoutGate`，唯一的上界是**单次 HTTP 请求** 300s
  （`EXECUTOR_TIMEOUT_MS`）—— 而它恰是 `DEFAULT_SETTINGS.enabledAgents` 里开箱默认的那一个。
  单任务最坏耗时 = chatJson 自纠偏重试 × 线路池排队 × (300s + 冷却等待)，冷却单次上限 120s、最多等 2 次，
  所以一个卡住的生成任务合法地可以占用十几分钟而没有任何东西拦它。
  现在按 `cli-agent` / `http-bridge` 的同一形态接 `TimeoutGate`，`limits.runDeadlineMs` 默认 600s（同 `DEFAULT_AGENT_LIMITS`），
  覆盖排队、重试与冷却等待；到点判 `failed: 超出总时限`、**迟到的那一回合不落盘**（与"run 已中止即丢弃生成物"同一条守卫），
  并发槽位仍跟着真实请求释放，不因超时提前放行。
  已知边界：**在途的那一次请求仍会跑完**（token 已花），要真掐掉得把 `AbortSignal` 接进 HTTP 客户端
  （~~同日已闭合~~，见下面"取消/超时真的掐掉在途请求"那条）；
  本适配器的 **idle 看门狗刻意关掉**（`idleTimeoutMs: Infinity`）—— 一次请求在途最长 300s 期间本来就不产生事件，
  开 idle 会把每一次健康的慢生成判死。用例两侧都钉：预算内照常落盘、超时限判 deadline 那一支且不写文件；
  反证是摘掉 `guard()` 后两条超时用例必须红（实测 2 failed / 27 passed）。
- **`verify` 增加第 19 步 `mutation:touched`：只审「本次真的改到的变异目标文件」**
  （`scripts/mutation-touched.mjs`）。缺口是我自己踩出来的：`mutation:quick` 是 aggregate 口径、每目标 1 个
  变异，抓不到"某个承判文件里新加的判断没人逐点验过"；能抓的全量 `mutation:audit` 约 15 分钟、只在
  CI 的 ubuntu job 上跑，本机没人肯跑 —— 于是出现过"只重跑了改动涉及的其中一个目标文件就交付"，
  远端红了几笔才定位到 `headless/protocol.ts` 里我新增的一个 === 位点没人验过。现在这一步按 diff
  自动圈范围，成本随改动大小走（没碰到目标文件秒过；实测"改到 1 个目标"= 15 个位点 / 约 65s）。
  基线默认取工作区改动，干净时取 HEAD~1..HEAD，--base=<ref> 可覆盖。反证：在目标文件里植入一个
  === 翻转后这一步 exit 1；拦下的原因是基线测试红，不是"存活"（我没另外造出"只存活不红基线"的
  等价变异，所以不那样写）。README 与门禁手册的步数/用例数一并校回 19 段 / 996。



- **`ProjectSettings.runWallClockMs`：一次 run 的墙钟上限**（`electron/engine/orchestrator.ts`）。
  在此之前只有两个局部上界（单次 HTTP 请求 300s、单条验证命令 300s）和各 agent 自己的
  `runDeadline`——总时长完全没有概念，重修轮可以一直追加，一次运行可以合法地跑几小时以上
  （本机实测单模型 PLANNING 就能 >170s 不返回）。`undefined` 或 `<= 0` 都是不限，
  与 `maxTokensPerRun` 同风格：要"不限"就省略字段。检查点在重修循环顶部，
  **只在批/轮边界生效**，不掐断在途请求（那归 agent 的时限与 HTTP 超时管）；到点抛
  `RunWallClockError` 且不动 journal 与快照备份，现场留着可断点续跑。
  headless 侧同步进了 `KNOWN_FIELDS` 与 settings 组装（不加会被判"未知字段已忽略"，设置传不进来）。
  设置页有对应输入口（`单次运行墙钟上限（分钟）`）：界面按分钟给、存的是毫秒，填 0 = 省略字段 = 不限。

- **勘误（针对上面 `runWallClockMs` 那条）**：实现时我说过"site 口径 29/29 全杀，含三个新位点的两侧"，
  这话只对一处 —— `limit === undefined` 属于 `=== → !==`，而 `limit <= 0`、`elapsed <= limit`
  以及下面"跳过点名下游"那条的 `downstream.length > 0` 都是**数值比较，不在 site 审计的算子集里**
  （`--list` 实测只有 `&&`/`||`/`===`/`!==`）。这三处由用例与差分钉住（把检查注释掉即红），
  但那个"全杀"数字从未覆盖它们，拿它背书是我自己的错。见
  `.qoder/skills/ox-commander-dev/references/gates.md` 新增的「边界」一节。

- **跳过任务时会点名它仍会被派出的下游**（`electron/engine/orchestrator.ts`）。升级决策答"跳过"以前只打一句
  「用户跳过任务「X」，不再重试。」，而把 X 列为依赖的下游任务照样被派出、随后因缺少 X 的产物而失败 ——
  看板上读起来像下游自己坏了，还照原样消耗重修轮预算。现在那句后面直接点名下游客体标题，并写明
  "那种失败不是下游自己的问题"。~~**判定语义刻意不动**~~ —— 同日已被下面"跳过不再为下游花修预算"
  那条改掉（下游现在只给一次机会、且拿不到升级决策）；这一术当时只把事实说出来。

### 修复

- **`Tests N` 这个头条数字此前虚报 28 条**（`src/router.test.ts`、`src/agent-registry.test.ts`、
  新文件 `src/__fakes__/agents.ts`、`scripts/check-tests-collected.mjs`）。起因是我补用例后核对差值：
  我只加了 8 条（registry 5 + prompts 3），总数却从 1020 跳到 1033。查出来是
  `router.test.ts` 写着 `import { fakeAgent } from "./agent-registry.test"` —— **测试文件把另一个
  测试文件当模块导入**，收集 router 时连带执行 agent-registry 的 `describe/it`，那 28 条被注册两次。
  同一份 `router.test.ts` 在不同 run 里报 40 和 45 行（取决于 worker 有没有复用到那份模块缓存），
  所以这不是"数字大一点"的小节：门禁的承判映射与头条都不可信，而变异审计跑某个 judge 文件时
  还能借到别人的断言（这次核过：`router.ts` 与 `registry.ts` 逐位点仍各 20/20 全杀，
  之前的绿**没有**被借来的断言撑着 —— 这条要说清，否则听起来像以前的门禁是假的）。
  修法：夹具进 `src/__fakes__/agents.ts`（仓库既有约定，`check-unwired` 的 `SKIP_DIR` 已含该目录），
  两边都从那里 import；并把它变成机器判据 —— 第 8 步现在扫"能解析到盘上测试文件的相对说明符"，
  命中即 FAIL 并指出夹具该住哪。差分跑过：临时造一个跨测试文件 import ⇒ RC=1 且点名文件与说明符，
  删掉探针 ⇒ RC=0 并多打一行「跨测试文件 import：0 处」。
  真值现在是 **1005 = 996 passed + 9 skipped**；今天各条 CHANGELOG/手册里写过的 996/999/1004/1006/
  1014/1020/1033 都被这 28 条虚报污染过（虚报幅度随那两个文件的规模而变），我不逐条改写历史条目，
  在这里统一更正一次口径：**以第 8 步修好之后的 `npm test` 输出为准**。

- **两处"没人断言的默认方向"补了用例**（`src/agent-registry.test.ts` +5、`src/prompts.test.ts` +3）。
  起点是覆盖率报告：`shared/agent-contract.ts` 的分支只有 75%，而它**不在变异门禁的承判文件里**，
  全量 site 审计也不会去看它 —— 这类文件的"翻转默认方向"没人守。
  ① `normalizeCapabilities` 的空数组回退（`roles:[] → ["*"]`、`zoneGlobs:[] → ["**"]`、
  `artifactKinds:[] → files+logs`）此前一行没断过。方向是刻意的（与 v1 适配器无限制的老语义一致，
  且 manifest schema 在解析层就拒空数组，走不到"声明为空还静默放宽"），但一次"顺手收紧"
  就会让一个声明不全的智能体**永远选不中或永远写不进**，而且不报错。用例除了看字段还看行为
  （`candidates()` 真的还能命中它）。差分验过：把 `length > 0` 翻成 `>= 0` ⇒ 2 failed / 26 passed
  —— 这正是 site 审计结构性看不见的数值边界（`>` 不在算子集里）。
  ② `maxConcurrency` 的取整与下界（0.7→1、2.7→2），以及"返回的是拷贝"——
  改它会污染调用方声明的数组、或让模块级 `LEGACY_CAPABILITIES` 被 push 脏，两条都断了。
  ③ `buildEscalationSummary` 是**人做处置决定时唯一的输入**（跳过 / 重派 / 终止），此前
  orchestrator 只数回调次数、从不读文案；现在断它点名三个真实可接受的动作、带上两个数字
  （已试轮数与上限）、带上错误原文，且空摘要写成「(空)」而不是留一行悬空标题。
  **两次我自己造出来的假缺陷要报备**（都被工具顶回来，没进代码）：
  一是为测"数组缺失"传了个没有 `roles` 的对象 ⇒ :207 抛 TypeError；二是为测"`selfIsolated` 缺省
  为 false"省略了该字段 ⇒ tsc 两条 2345 直接红。事实是 `selfIsolated` 在类型里必填、
  manifest 解析器（`manifest-schema.ts:105,116`）也总会写出布尔值，两条入口都到不了"缺失"形状，
  那个 `?? false` 只是给非 TS 调用方的兜底 —— 不该为不可能的形状写断言，更不该没读类型定义
  就断"缺省行为"。跑完整门禁时 typecheck 抓到它们，说明第 1 段就是该抓这个的位置。

- **把三处"睡固定时长再断言"的用例改成断言条件**（`src/sensenova-api.test.ts`、
  `src/audit-log.test.ts`）。这类写法把结果压在墙钟上，共享 runner 卡一下就红在一次抖动上：
  ① 两条 run 时限用例原来给 120ms / 40ms 的真预算 —— 判据是"**在途请求**被掐掉"，
  而机器慢时看门狗可能在请求**发出之前**就响，`sawSignal` 还是 `undefined`，
  于是红在抖动而不是行为上。现在用 `vi.useFakeTimers()`：先把微任务跑干（断言请求确已发出、
  signal 尚未 abort），再推进 `runDeadlineMs`，顺序被钉死；冷却那条同时多断一句
  "喊过'第 1 次等待约 5s 后重试'"，证明截断发生在**等待途中**而不是开始前。
  ② 并发上限那条原来睡 30ms 然后断 `peak <= 2` —— 调度器还没起跑时这个断言是**空的**。
  现在先 `vi.waitFor(() => peak === 2)`，再断 `activeRuns() === 2` 与上限，
  "上限"必须由"槽已占满 + 后面还在排队"共同证明；"0 = 不限"那条同样改成等条件。
  验证：摘掉看门狗 `guard()` 仍是 2 failed / 27 passed（假时钟没让断言变哑）；
  `scheduler.ts` 逐位点 **15/15** 全杀（改断言没有削弱并发门禁的覆盖面）。

- **CI 的两个 `verify` job 从 `2afd002` 起一直红，根因是 `mutation:touched` 在浅克隆里崩**
  （`scripts/mutation-touched.mjs`、`.github/workflows/{verify,release}.yml`）。
  它按 `package.json` 的顺序是第 11 段（共 19 段；那笔提交写的"第 19 步"说的是"新加的那一段"）。
  `actions/checkout@v4` 默认 `fetch-depth: 1`，那种仓库里**没有 `HEAD~1`**，而干净工作区下
  这一步正是拿 `HEAD~1..HEAD` 当基线 ⇒ `git diff` 直接 fatal，抛给 job 日志一坨裸 node 堆栈。
  本机永远是全历史，所以这一步在本机从没红过 —— 是我推完四笔去查远端结论才发现的。
  **归因**：`cde8075`（我开工前的一笔）两个 verify job 都是绿的，`2afd002`（引入第 19 步）起转红，
  我这四笔（`aa35f20`/`49e36d2`/`0c37f43`/`c5c995e`）不是成因；`mutation (site, every site)` 全程绿
  也对得上——它不跑这一步。
  两处一起改：① 跑 `npm run verify` 的两个 job 的 checkout 加 `fetch-depth: 0`；
  ② 脚本不再让 git 的堆栈裸奔 —— 基线解析不出来就 FAIL 并说明"浅克隆 ⇒ CI 加 fetch-depth: 0 /
  本机用 `--base=<ref>`"，`--base` 写错也走同一句。**不退化成审 `git diff HEAD`**：干净工作区下那是
  空集，会让这一步宣称 PASS 而一个位点都没审。
  验证：在 depth-1 克隆里用 `skip-worktree` 造出"干净树 + 无父提交"的 CI 原形，改前 RC=1 且是裸堆栈，
  改后 RC=1 且是那句人话；写错的 `--base=nope-not-a-ref` 同样一句。
  遗留一条（**不是 bug，是这一步的语义**）：CI 上一次推多笔时，`HEAD~1..HEAD` 只覆盖最后那一笔，
  其余靠 `mutation (site, every site)` 那个全量 job 兜。

- **零验证不再被念成"验证通过"**（`electron/engine/orchestrator.ts`）。`verificationCommands: []`
  是合法配置（headless 协议允许空集），而空集在 `verifyProject` 里恒为 `passed`，于是交付那一句日志
  写的是"全部验证通过，进入交付。"——实际什么都没验。**判定刻意不改**（纯文档类任务确实不需要构建，
  拒掉空集会让那类调用方红），改的是说法：`report.results` 为空时当场输出
  「没有配置任何验证命令，也没有冒烟样本运行过 —— 本次交付**未经构建/测试验证**」。
  冒烟样本算作验证（它会把条目落进 `results`），所以只有"命令为空且没有冒烟"才走这一句。
  site 口径实测 orchestrator 28/28 全杀（新位点的两侧都有断言）
- **`scripts/smoke-e2e.mjs` 的规划阶段一直是坏的**（真实 API 手动冒烟脚本）。它按
  `batches = await engine.decompose(prd)` 用，而 `decompose` 早就改成返回
  `{ batches, smoke }`（独立样本冒烟和计划一起产出）——于是第一个模型必抛
  `batches.reduce is not a function`，而脚本按模型逐个 catch 只打一行「❌ 失败」，
  **看起来在跑，实际从没验过规划**。现在解构取两个字段，并把冒烟项数一并打出来。
  这是"不进 CI 的手动工具会烂"的又一例：同一个 API 的三处生产调用都是类型化的，只有这个
  `.mjs` 脚本没人替它兜着
- **被沙箱拒绝的路径现在进终态**（`electron/agents/sensenova-api.ts`）。内置执行器过去只在**中间日志**
  说一句「跳过：〈原因〉」，终态事件仍写"写入 N 个文件"。而重修循环带进 prompt 的是那份终态摘要 ——
  模型以为全落了，下一轮原样再写同一条被拒路径，配额空烧、没人告诉它为什么红。现在 completed 带
  「沙箱拒绝 M 个：〈路径列表〉」，全部被拒时抛错直接点名这些路径（原来含糊说"模型未返回可写入的文件"，
  会把归因带到模型输出格式上去）
- **取消现在会真的中止在跑的 run**（`electron/engine/scheduler.ts` + `electron/engine/orchestrator.ts`）。
  `cancel()` 过去只置一个 `cancelled` 标志，而那个标志只在下一个检查点生效；结果是用户点了取消，
  已经在跑的外部 CLI 智能体仍按自己的 `runDeadline`（默认 600s）跑完并继续改文件。
  现在 Scheduler 登记在跑的句柄（`liveRuns`，出口在 `finally`），`cancel()` 下传
  `abortInFlight()` 逐个 `adapter.abort(handle)`，并把中止数量播报成
  `[取消] 已请求中止 N 个在跑的任务`（N=0 时不说这句话，不假装做了什么）；
  某个适配器的 abort 抛错不影响其余的仍被中止
- **内置执行器在中止之后不再落盘**（`electron/agents/sensenova-api.ts`）。模型那一回合是
  **算完了**的（token 已花，这一条本次改不了），但 `writeFiles` 之前有了守卫：
  生成物被丢弃并写日志。要真正省钱得把 `AbortSignal` 接进 HTTP 客户端，未做。
  顺带把 `scripts/mutation-check.mjs` 里该文件的两条行号锚点按新行号校回（337→346、343→352），
  site 口径实测 29/29 全杀；锚点旁散文里的旧坐标改成按构造点名，免得再漂一轮
- **两个 IT 不再往 `%TEMP%` 扔目录**（`scripts/admission-gateway-it.mjs`、
  `scripts/e2e-snapshot-secrets.cjs`）。它们建完目录没有任何清理，本机实测
  `ox-agents-it-*` / `ox-gw-it-*` / `ox-snap-*` 各 **45 个** = 跑 `verify` 的次数，
  其中 `ox-snap-*` 里还写着**长得像真 Key 的**哨兵字符串。现在都挂在 `process.on("exit")` 上，
  判定通过/失败/`process.exit` 三条路都会经过。复现核对：
  `npm run smoke:gateway` 前后各数一次 `ls -d $TEMP/ox-agents-it-* | wc -l`
- **未到期批备份从此要说出来**（`headless/run-spec.ts`）。批在中途死掉时 `BatchGuard.settle()` 从未执行，
  那一批的越权写入既没被仲裁也没被回滚，只留下一个 `batch-*` 备份目录 —— 而回收器对它
  "未到期所以保留"这一支**一声不吭**，于是"保留"读起来像"没事"。现在 `PruneResult` 带 `kept`，
  启动时点名这些目录并写明"本次运行不会自动回滚，请人工核对"。措辞刻意避开"回收"二字：
  离线 IT 有一条断言就是"没谎报回收"（两处都是 `includes` 子串判定，读码核过）。
  跨进程证明落在 `smoke:offline-e2e` 场景 D 的同一条检查里。**要不要在启动期自动补一次仲裁**
  仍是未定的策略，没做。

- **回滚不再删掉用户项目自己的 `package.json`**（`electron/sandbox/snapshot-store.ts` +
  `electron/engine/batch-guard.ts`）。默认档 `revert-batch` 的删除判据是"备份里没有 ⇒ 它是本批新建"，
  而快照只备份本批 zone 覆盖到的路径（通常 `src/`、`tests/`）—— 于是模型改根级 `package.json`
  （加依赖是最常见的一次越权）被仲裁检出之后，回滚把用户本来有的清单文件**当新增删掉**，
  每轮重修再删一次。现在两件事分开：
  ① `BatchGuard.begin` 把 `sharedPaths` 里的字面文件交给快照层的 `include`，它们从批开始就在备份里，
  回滚是**还原原内容**；② `revert` 的删除只认正面证据 —— 调用方传进来的 `created` 集合，
  来自 `FileJournal` 的 `create` 记录（日志看的是整棵树，不受 zone 限制），
  "没有备份"从此只记 `skipped`、不动文件。
  反证：把生产改动退回上一版，新用例 `shared file edited outside the zones is restored, not deleted`
  当场红；还原后 80/80 绿。同时留了反向用例（项目本来没有 `package.json`、是这一批生成的 → 仍删），
  避免把"不删"修成无条件
- **Windows 上每一条走 `.cmd` shim 的验证命令都是红的**（`electron/sandbox/spawn-plan.ts`）。
  cmd 包装过去只给每个 token 加引号：`/c "C:\Program Files\nodejs\npm.cmd" run build`。
  而 `/s` 的语义正是"去掉首尾两个引号字符、中间原样保留"，于是 cmd 把它解析成命令
  `C:\Program`，报「不是内部或外部命令」。Node 的**默认安装位置就带空格**，
  而 `DEFAULT_SETTINGS.verificationCommands` 是 `npm run build` / `typecheck` / `test` ——
  也就是桌面端开箱跑任何项目，第一次验证就必红、判"工作区受损"、全员重跑、重修预算烧光。
  现在整条 line 外层再套一对引号（`""<shim>" run build"`），实测四种形态全通：
  带空格路径、无空格路径、含空格的 arg、空 arg。
  **为什么 974 条用例没抓到**：`src/spawn-plan.test.ts` 那条包装用例断的是
  `args[3]` *包含* `npm.cmd` 子串，旧写法也包含；且它的 shim 建在没有空格的临时目录里。
  现在断整条形状，并加一条**真 spawn** 的用例（临时目录里刻意建 `with space` 子目录）。
  反证：把生产改动退回上一版，这两条当场红；还原后 16/16 绿
- **验证与冒烟的子进程不再继承宿主的凭证环境**（`electron/engine/verifier.ts`）。`runOnce` 与
  `runSmokeChecks` 此前都不传 `env`，于是每一次 `npm run build`、每一条冒烟脚本都拿到完整的
  `process.env` —— 那里面装着 3 把 SenseNova Key 和其余 provider 的 Key（桌面端把 keychain
  播种进 `process.env`，`electron/main.ts` 还会加载 `.env`）。而验证命令跑的是**智能体刚写下的
  项目脚本**：一句读环境的话就能把账单凭证带进它自己的输出。`cli-agent.dispatch` 早就用
  `scopedEnv()` 关掉了这个面，`verifier` 是漏掉的那个。现在两处都传 `env: scopedEnv()`
  （PATH / HOME / SystemRoot / TMP / `NPM_CONFIG_*` 仍透传；从**磁盘**读的 `.env`·`.npmrc` 不受影响）。
  实测：修复前沙箱内子进程报出 7 个凭证变量名，修复后 0 个，同一条命令
  （`src/sandbox-llm-call.smoke.test.ts`）就是复现方式。
  代价当场兑现：验证脚本读不到白名单外的宿主变量了 —— `src/orchestrator.test.ts` 里那条
  "用 `SMOKE_FIX` 环境变量翻转冒烟结果"的用例就是这么红的，已改成重修轮**改写样例脚本**，
  这也更接近智能体真实的修法
- **`CliAgentAdapter.probe()` 同样最小化环境**（`electron/agents/cli-agent.ts`）：探测就是拿
  `--version` 真跑一次那个二进制，它此前也继承全部 Key —— `dispatch` 做了收缩、`probe` 没做

### 新增（CI / 分发）

- **打包失败现在不再是无头案**（`.github/workflows/release.yml`）。此前 `package (windows)` 与
  `package (ubuntu)` 三次停在 `Package` 这一步，而本仓库读不到 job 日志
  （`GET .../actions/jobs/{id}/logs` → 403 Must have admin rights），失败原因只能靠猜 ——
  猜过「`files` 引用不存在的 `LICENSE`」「linux deb 需要 runner 上没有的 fpm」「产物目录为空触发
  `if-no-files-found`」三轮，一个都没落实（`LICENSE` 后来补上了，打包照样红）。
  现在失败时先把 `npm run build:dist` 的完整输出（`DEBUG=electron-builder` 开着，默认只打人话摘要）
  落成 `build-dist.log` 与 `diagnostics.txt`（含 node/npm 版本、`release/` 与三个 dist 目录的实际内容），
  再走两条**无需 admin** 的通道出去：① `packaging-diagnostics-<os>` artifact；
  ② check run 的 `output.text`（checks API 对公开仓库可读，截断在 60 KB 内）。
  判失败单独挪到最后一步 —— `continue-on-error` 不能把红灯吃掉，而 `| tee` 之后那条 `echo`
  会把退出码盖成 0（步骤 outcome 取最后一条命令），所以必须显式 `exit $code`。
  同一轮加了 `concurrency`（取消同 ref 上的旧 run）与每 job `timeout-minutes: 30`：
  2026-09-25 那次两个 package job 停在 checkout / setup-node 阶段 in_progress 三十多小时，
  既不失败也不结束、把后面的 run 全堵住 —— 宁可让它显式超时，留一条「卡在哪一步」的事实。

- **诊断通道第一次用到就抓到了根因**（`v0.1.2-rc1` / `078cbdb` 那次 run）。结果分两条，
  两条都不是"打包没配好"，而是**差在最后一步**：
  1. **Linux = deb 缺 maintainer**：`⨯ Please specify author 'email' in the application package.json`
     （`FpmTarget.computeFpmMetaInfoOptions`）。`package.json` 的 `author` 是裸字符串、没有邮箱，
     而 deb 用 fpm 打包、fpm 强制要 `Maintainer` 带 email。**AppImage 其实已经打成功了**
     （`OxCommander-0.1.1-x86_64.AppImage` 109 MB），是 deb 目标抛错把整个 build 带成非零退出 ——
     这就解释了为什么之前"看着像 Linux 打包全红"。修法放在 `electron-builder.yml` 的
     `linux.maintainer`（填 GitHub noreply 邮箱），不去动 `package.json` 的 `author` 语义。
  2. **Windows 打包成功、挂在建 Release**：`Package` 绿、`installers-windows-latest` artifact
     200 MB 也传上了，唯独 `gh release create` 红。`release/*` 会把 `win-unpacked/` 这类
     **目录**一起展开进 argv（ubuntu 侧诊断里 release/ 下就有 `__appImage-x64` 与 `linux-unpacked`
     两个目录），gh 收到目录参数会拒绝。改成先用 `find release -maxdepth 1 -type f` 收成数组再传，
     并且**文件数为零时显式报错退出**（免得建出一个没有任何安装包的 Release）。
     同一个 glob 问题也修在 `Upload installers (artifact)` 上 —— 加 `!release/*/**` 排除子目录树，
     否则 artifact 的 200 MB 里大半是 `win-unpacked`。
- **建 Release 这一步自己也接上了诊断通道**（`.github/workflows/release.yml`）。
  `v0.1.2-rc1` 上暴露了一个缺口：`Publish diagnostics to check run` 的条件是
  `steps.package.outcome == 'failure'`，**Package 之后的步骤挂掉就没有任何可读输出** ——
  恰恰是这次红的那一步。现在 `Create release` 也 `continue-on-error` + `tee` 到 `release-create.log`，
  失败时写进一个**独立命名**的 check run（`release-create-diagnostics (<os>)`，与
  `packaging-diagnostics` 分开，免得两份诊断混在同一个 output 里分不清），判失败同样挪到末尾单独一步。
- **第一个 Release 真的出来了**（`v0.1.2-rc3`）。三个目标全部打包成功：
  Windows `OxCommander-0.1.1-x64.exe` 80.7 MB、Linux `OxCommander-0.1.1-amd64.deb` 85.9 MB 与
  `OxCommander-0.1.1-x86_64.AppImage` 109.8 MB；日志里能看到
  `Setting from flags: maintainer=fengxingxuerong <...>` —— deb 那条修正确实生效了。
  中途还撞了两个坑，都不是打包本身的问题：
  ① 想给 artifact 排掉 `win-unpacked/` 而加的 `!release/*/**`，把 `release/` 下的文件
  **一起否掉了**，两个 OS 的 `Upload installers` 同时 failure（已回退到 `path: release/*`）；
  ② 诊断原本只在 `steps.package.outcome == 'failure'` 时才发，于是"打包成功但后续步骤红"
  又变成只能猜 —— 条件改成 `always()`，成功时也发一份 neutral check（不影响门禁）。
- **建 Release 的步骤改成幂等**（`.github/workflows/release.yml`）。两个 OS 的 job 都会跑到
  `gh release create`，而同一个 tag 只能有一个 Release：windows 先建好之后，ubuntu 撞上
  `a release with the same tag name already exists` → 打包全绿、整个 job 却红掉。
  现在先 `gh release view` 探一次，已存在就改用 `gh release upload --clobber` 追加；
  `create` 失败且报 already exists 时再回退 upload 一次（覆盖两个 job 同时判成"不存在"的竞态）。
  顺带排掉 `builder-debug.yml` —— 它是 electron-builder 写的 effective config 快照、给排查打包
  用的，rc3 上被当成安装包挂进了下载列表。
- ⚠️ **仍未处理**：`desktopName` 未设（Linux 桌面环境无法把运行中的窗口关联到 .desktop 条目）、
  icon 未设（分发版用默认 Electron 图标）。前者不是 build config 的字段 ——
  `scheme.json` 里只有 `linux.syncDesktopName`，而它读的是 **package.json 的 `desktopName`**，
  要修得两边一起加。非阻塞。

### 新增

- `src/sandbox-llm-call.smoke.test.ts`：**沙箱内的 LLM 可达性探针**（真实网络，刻意不进 `verify`，
  跑法写在文件头）。子进程走的是生产同一条路：`planSpawn`（CommandPolicy 检查 → buildSpawnSpec
  按平台包装）→ `spawn(shell:false, env: scopedEnv(...))`。它把"能不能调用"拆成三个各自成立的
  事实：① 显式 `allowProviders: ["sensenova"]` 时沙箱子进程拿到真实 200 与 `pong`；
  ② 默认最小化环境下凭证变量名为零，而端点仍回 401 —— 也就是**沙箱不掐网络**，
  它管的是路径与命令，不是防火墙；③ `verifyProject` 起的子进程必须与 ② 同源（修复前是红的）


## [0.1.1] — 2026-09-25（首个打 tag 的版本，**没有产出安装包**）

`0.1.0` 只在 CHANGELOG 里声明过、**从未打 tag 也从未产出安装包**，所以它描述的是
09-24 仓库公开那一刻的状态。本条是第一个真正打了 tag 的版本，但那次 `release`
工作流的两个 package job 都失败了（当时读不到失败原因，根因到下一条 0.1.2 才查清），
**这个版本号下从来没有可下载的安装产物**。第一个真正能装起来的是 0.1.2，
两者的内容不同，因此不合并为一条。

### 新增

- `.qoder/skills/ox-commander-dev/`：给 agent 的仓库工作手册（`verify` 16 步逐条机制、变异白名单的
  行号锚点、两张豁免表的双向失效规则、分层与放置约定、win32/POSIX 分支差异、红灯速查）
- `docs/2026-09-24-consistency-review.md`：一致性复核，含 10 条带复现方式的未修缺陷清单
- **每次运行前先跑一遍基线验证**（`electron/engine/orchestrator.ts`）。此前重修提示里只有
  "上一轮的失败日志"，所以**目标项目本来就坏着**（缺依赖、套件红）时，智能体看到的是一份与自己
  无关的失败，会去改不属于自己的文件。现在基线红的命令会随每一份重修上下文附上
  `[本次运行前就已失败] build(exit=1)` 这样的标注，日志里另附原因并当场说明"这不是智能体造成的"。
  断点续跑不跑基线（工作区已被上一轮改过，基线不成立）。代价是每次运行多一轮验证命令，
  换的是归因；重修预算的行为没有改（"验证未过但无失败任务 → 全员重跑"仍是原样）
- **`verify` 增加第 17 步 `smoke:offline-e2e`：零配额的离线全链路 E2E**
  （`scripts/offline-e2e-it.mjs`）。此前没有任何一步真的穿过进程边界——其余各步要么在函数层
  注入假件跑引擎，要么只查产物语法与协议退出码。这条用本地假大脑（冒充 `ollama`，占 11434）
  加假 http-bridge 智能体，经真 `dist-headless` 跑**三个场景共 27 项断言**：clean 钉阶段顺序、
  `hello` 首发与终态 `done`、run 归因条数、用量落账、stdout 每行都是合法 JSON；rogue 钉越权
  回滚是**外科手术式**的（zone 内的产出必须留下）、仲裁发出的 remedy 值与看板词表同源、
  重修轮只重派越权那个任务、退出码 0 与 2 的分野；prebroken 钉基线归因真的到了智能体手里。
  反证：把越权场景的处置临时改成 `report-only` → 5 项 FAIL、
  退出码 1（README 留在盘上、批次不改判、正常交付），也就是它真的在看行为而不是在跑流程。
  端口 11434 被占（本机跑着真 Ollama）时**直接失败并给出排查命令**，不静默跳过
- `typecheck` 现在覆盖第四套工程 `tsconfig.node.json`（`vite.config.mts` / `vitest.config.mts`）——
  这两个文件此前不在任何 npm script 里，改坏了要到 `vite build` 才暴露。接入时 verify 仍是 16 步
  （上面那条离线 E2E 才把它推到 17 步），实测 +1.7s；接入前先验过一次：现存配置干净，
  且故意注入的类型错误确实被抓出来
- **`headless/run-spec.ts` 登记进变异门禁**（tier 2，测试挂 `src/headless-protocol.test.ts`）。
  它此前不在 `TARGETS` 里，于是本轮新写的凭证闸与备份回收完全没机制保证"断言真的在看它们"。
  **首跑 6/15（40%）**：`&& → ||` 存活说明"手里恰好有一条 Key"那格没人跑过（那正是离线 IT 上误挡的场景），
  两处 `continue → break` 存活说明回收循环的"跳过这一条"从未与"到此为止"区分过，
  `run` 事件的 `durationMs` 从没断过（同一模式在 `orchestrator.ts` 早有断言，分层各抄一遍不等于两层都有门禁）。
  补 4 条用例后 **15/15**。为让"跳过"可跨平台判定，`pruneStaleBackups` 的遍历改成**显式排序** ——
  `readdirSync` 在 Linux 是 hash 序、Windows 是字典序，而 `failed` 是要给宿主比对的列表，不该随平台变
- **全仓 site 变异审计在 win32 本机复测：603/603（100%）· 14.3 min**。此前 README 引的是 CI 那一次的
  590/590，本机没复现过；同日 aggregate 口径也复测为 162/162（两个口径不可互换）。分母净 +13
  （新目标 `headless/run-spec.ts` 占 15 处，其余是这几轮新增与删除位点的净结果），**不是白名单放宽**——
  `EQUIVALENT_SITES` 按 `{file, op, line}` 精确匹配，任何行号漂移都会让那个位点重新计入分母且无断言而变红，
  所以一次全量绿同时兜住了那 9 条锚点当前仍然对得上
- **离线全链路 IT 加第四个场景：跑到一半被杀掉**（第 17 步从 27 项断言涨到 win32 39 / POSIX 41）。
  同一个工作区上连跑三个真进程：第一次派单刚落到桥端就杀进程 → 断 journal 已落盘、中断那批的
  `batch-*` 备份留在盘上（实测目录名 `batch-mufqn0fq-18476-1-t-impl`，带 pid 与序数，正是上一条提交
  修的碰撞面）；第二次 → 断它当场说出「断点续跑：恢复快照」、**大脑零调用**（规划真的被跳过）、
  没到 24h 的遗留备份一个都没删也没谎报回收；第三次把遗留目录 mtime 推到 48h 前 → 断它被回收且
  在日志里点名，且回收不影响这一次正常交付。原先这些只在函数层用假件测过，进程边界之上没人验过
- **`verify` 增加第 8 步 `check:tests-collected`：抓「盘上有、但 vitest 根本不收集」的测试文件**
  （`scripts/check-tests-collected.mjs`）。起因是 `vitest.config.mts` 的 `test.include` 不含 `headless/**`
  而 `coverage.include` 含它 —— 往 `headless/` 写一个测试文件会**一次都不执行**，却让 headless 的
  覆盖率数字继续统计。判据取自 `vitest list --filesOnly` 的**真实输出**而不是自己解析 include 再匹配
  glob（后者要重实现 picomatch 语义，一偏差门禁查的就不是它声称在查的东西，代价约 6s）。
  `vitest list` 失败或产出空集合一律 **FAIL**，不当作"没有未收集项"放过。反证：往 `headless/` 放一个
  `zz-probe.test.ts` → 门禁点名它并 exit 1；把 `headless/**/*.test.ts` 补进 include 后同一探针被收集，
  且 `npx vitest run headless/zz-probe.test.ts` 真跑出 `1 passed`
- **`check:scripts` 现在也检查 `.js`**（此前只认 `.mjs/.cjs`）。`scripts/acceptance/csvstat-acceptance.test.js`
  此前两层都不覆盖：vitest 不收它、语法门禁也不认它，一个语法坏掉的验收套件要等验收方真拿去用那天才炸。
  反证：注入一个语法坏的 `scripts/zz-probe.js` → `26/27` 且 exit 1 并打印 `SyntaxError`，删掉后 `26/26`
  （多出来的那 1 个就是它）。`.js` 按 CommonJS 解析，要 ESM 请改扩展名为 `.mjs` 而不是放宽门禁

- **分层红线第一次有了机制**：`eslint.config.mjs` 给 `shared/**/*.ts` 加 `no-restricted-imports` ——
  禁 `node:*` 与裸 node 内建、禁 `electron|react|react-dom|zustand`、禁 `../electron/**|../headless/**|../src/**`。
  这条红线此前只活在注释里（`atomic-file.ts:13`），没有任何机制保证；现在违反即 lint 红。
  落地时 `shared/` 对外 import 数为 **0**，所以是零违规的纯增量 —— 只拦未来，不改现状。
  反证：`shared/` 里临时 `import fs from "node:fs"` → lint 点名该文件；换成 `from "../electron/platform"` →
  两条规则同时红；删掉后 `npm run lint` EXIT 0。
  **故意没给 `headless/**` 加同类规则**：`run-spec.ts` 现在经 `electron/platform` 拉进 `electron/sandbox`，
  加了当场就红 —— 那条要先解依赖（或先承认它跨层），不能靠规则硬压下去

### 修正

- **`typecheck` 不再吃增量缓存**：四套工程全改成 `tsc -p … --noEmit --incremental false`。
  触发它的是实测到的假绿 —— 一个用了未导入标识符（`path`）的新函数被 `tsc -b` 放行，
  非增量立刻报 `TS2304` 等三处。代价约 +6s。`build` / `build:headless` 仍用 `tsc -b`（要产出）
- **headless 现在有信号处理了**。此前 `headless/` 一个 `process.on` 都没有：Ctrl-C 之后宿主只拿到
  被截断的 JSONL、没有终态事件。现在 SIGINT/SIGTERM 会把 `error` 作为**最后一条**事件发出去
  （消息里写明快照备份留在哪），刷完 stdout 再以退出码 1 结束；第二下不等排空直接退。
  **并且刻意不删快照备份** —— 被中断的那一批正停在"越界文件已写、还没仲裁"的状态，那份备份是人工
  恢复现场的唯一材料。回收改到下一次运行启动时（`pruneStaleBackups`：只认 `batch-*` 且超过 24h，
  宿主把 `snapshotRoot` 指到共享目录时别的东西一个都不碰），删不掉的会说出来而不是静默跳过
- **更正上一条里第一版的做法（`d06b9c9`，已推送未发布）**：那一版收到信号只 `process.exitCode = 1`
  并让 run 继续跑完，理由是"给在飞的仲裁一次落盘机会"。听起来合理，实际是把协议的终态说掉了 ——
  `error` 在事件表里写着"终态"，而宿主会先拿到 `error` 再拿到一串 `verification`/`done`。
  让它真的停下来之后才有得断言：POSIX 侧发一次 `SIGTERM`，最后一行必须是那条 `error`；
  Windows 投不进信号（`kill()` 就是 TerminateProcess），退化成"退出码 `null`、没有终态事件"，
  这一点写进协议文档 §2.1 而不是留给宿主猜
- 原判"journal 泄漏"更正为**预期行为**：`ox-run-journal.json` 是断点续跑的入口（`load()` 读它），
  成功后也不删，不算中断遗留
- **批号与 runId 不再依赖毫秒唯一**：`Scheduler` 的批号（同时是 `snapshots/<runId>` 目录名）加上
  `pid` 与进程内序数，runId 加上序数。原先 `batch-<ms36>-<taskIds>` 在两个进程同毫秒跑同一份需求时
  会撞成同一个备份目录（序数不够，跨进程都从 1 开始，所以批号必须带 pid；runId 只活在本进程的
  适配器里，序数即可）
- **发布流水线加门禁**：`release.yml` 新增 `verify` job，`build` 改为 `needs: verify`。
  此前打 tag 直接产出装进别人机器的 exe，且 tag 可以落在任何一次从未跑过 verify 的提交上。
  两个 workflow 都过了 `js-yaml` 结构校验；但 CI 是否按预期变绿只能等下一次 tag/dispatch 实证

- **headless 的 `llmProvider` 从此真的生效**。协议字段表写着"大脑层 provider"，但实现只把它
  echo 进 `hello` 事件，装配时用的仍是 `settings.llmProvider` 的默认值 —— 宿主写
  `"llmProvider": "ollama"` 而池为空时，打的还是 SenseNova。现在它进 `settings`，与
  `buildLlm` 的「池优先、池空退单 provider」口径一致（`headless/protocol.ts`）
- **headless 缺凭证时给一句能行动的话**。原先一路跑到第一次模型调用才炸，宿主看到
  `failover client has no groups` 无从下手。现在在 `hello` 之后就发 `error` 并以退出码 1 结束，
  消息里列出需要哪几个环境变量（`headless/run-spec.ts` 的 `requiredCredentialVars`）。
  口径跟着**实际会用的那组 provider** 走：池里是免密钥的本地 provider 时不拦 —— 我第一版
  按 `settings.llmPool`（永远等于默认池）判断，被离线 E2E 当场抓成假拦截，已改并补了单测
- **README 关于 `.env` 的说法纠正**：旧文案说"headless CLI 只认 `.env`"，实际加载 `.env` 的
  只有桌面端主进程（`electron/main.ts`），headless 从来就读不到它。现在写明：headless 的凭证
  只能来自宿主注入的进程环境变量，`docs/headless-protocol.md` 也补了这节
- **仲裁四档现在真的有四种行为**。`report-only` 与 `deny-all` 此前走同一分支（都标记批次失败、
  都不回滚），差别只在日志文案，于是设置页上「仅记录日志」那一档其实会判整批失败。
  现在按界面写下的那句分开：`report-only` 只记日志、不改判（裁决报 `pass`），
  `deny-all` 保留文件但整批判失败。默认档 `revert-batch` 与 `quarantine` 不变
- **同一条分支还漏了收尾**：不回滚的两档既不 `commit` 也不丢弃快照令牌，每跑一批就在
  `userData/snapshots` 下留一份备份目录。四档现在都在出口处 commit
- **看板念出的处置与引擎发出的值对齐了**。`src/store.ts` 的 remedy 词表写的是
  `revert`/`isolate`/`keep`，而生产端（`BatchGuard.remedyFor`）只会发 `revert`/`quarantine`/
  `fail-batch`/`pass` —— 那两个值从来没人发，所以"移入隔离区"和"保留文件判失败"两种处置
  在看板上都被念成"仅记录"。旧用例用的正是这套假词表，因此它绿着而链路坏。
  现在词表导出为 `REMEDY_VERB`，对账用例在引擎侧（真跑四档再比对），四档必须产出四种不同裁决
- `execToken` 的信任红线写进 `agents.d/README.md` 与 `shared/agent-contract.ts`：它由指挥机直接
  spawn，不过命令白名单也不过 spawn 规划，失败静默返回 undefined（请求照发、只是没凭证）。
  顺带按本机实测纠正了一条常被写错的 Windows 说法：裸名 `npm` 是 `ENOENT`，而 `npm.cmd` 是
  `EINVAL`（CVE-2024-27980 之后不带 `shell:true` 不能起批处理）—— 取令牌脚本在 Windows 上只能是 `.exe`
- `headless/protocol.ts` 头注释不再自称 "pure: no fs, no process"（它 import 了 `node:path`，
  还为 `snapshotRoot` 读 `process.env.TMPDIR/TEMP`）。改成准确的不变量：不落盘、不 spawn、不改全局
- 撤回一条误报：手册说「manifest 的 id 与适配器配不上会被静默丢弃」，复核 `manifest-loader.ts` 后
  不成立 —— 没能变成适配器的声明都会进 `skippedManifests`，`agents:list` 又把这份清单报给界面。
  手册已改正，真正静默的是上面那条 `execToken` 失败

- **构建产物不再被当成任务越权，也不再挤掉模型该看的源码**。跳过清单原本有四份副本，谁都不认识
  `dist/`/`coverage/`，于是两件事同时成立：批内跑一次项目自带的 `npm run build`，产物会被判
  `unauthorized-write` → 整批标记失败并在默认档里被回滚删除；执行器的工作区快照按路径序消耗 32k
  预算而 `coverage/`、`dist/` 正排在 `src/` 前面 → 本机实测修复前"进快照的 12 个文件里 11 个是产物、
  真实源码 0 个"，修复后 6 个文件全是要读的源码（快照 31.5k → 7.5k 字符）。`out`/`bin`/`target`
  刻意不列入（常是手写源码目录）
- **桌面端 run 现在真的能用「设置」里存的 Key**（P1）。播种器改挂在 `PlatformConfig.seedKeys` 上，
  `createPlatform` 内部构造引擎大脑时即生效；此前只有「设置 → 测试连接」那条一次性路径会读 keychain，
  正式 run 的大脑层与内置执行器都只看进程环境（日常被根目录 `.env` 掩盖）。优先级仍是
  进程环境 > `.env` > keychain，三者都只补缺失项。README 的凭证一节按此改写
- `scripts/check-script-wiring.mjs` 的豁免表改以数组登记并在建 Map 前查重复键：旧字面量里
  `loomy-bridge.mjs` 被写了两次，后一条理由静默顶掉前一条，而门禁本身察觉不到
- 两处"注释描述了代码没做的事"：`circuit-breaker.ts` 的 `record` 不再被说成会放过 `retryable: false`
  的失败（它只看布尔，行为本身保留）；`sensenova-api.ts` 写入不带 zone 的推迟理由从"等回滚落地"
  换成真实理由（写入门是严格前缀，在这里认 zone 会误拒模型按约定写的模块文件）
- 设置页线路池两处互不相符的说明文案（一处写 4 模型、另一处写 3 模型）改为从
  `SENSENOVA_KEY_VARS` / `SENSENOVA_MODELS` 派生，并加防漂移用例；`package.json` description 与
  两处代码注释同步去掉写死的数字
- README 门禁口径：16 步（原写 15）、940 用例（原写 930）、`mutation:quick` 是"每目标 1 个 aggregate 变异"
  的最弱档、覆盖率标注为"不设阈值、不是门禁"、审计轮转正为**按大小 2 MiB**（原写按天）、
  仲裁四档标注前两档行为相同、`shared/` 的纯逻辑约定标注"无机制强制"

## [0.1.0] — 2026-09-24（首个公开版本）

从 2026-08-26 起、128 个提交的第一对外发布。仓库在 GitHub 公开，
两个 CI job（verify 矩阵 + 全量 site 变异）随每次 push 运行。

### 新增

**平台能力**
- 六阶段编排：`需求 → PRD → PLANNING → DEVELOPMENT → VERIFICATION → DELIVERY`，
  按 zone 归因的 repair loop（失败任务带着"属于它的那部分错误"重修，而不是整份摘要）
- zone 互斥并行派发：批内任务按 zone 互斥分批，越权写入由 guard 裁决并默认回滚
- 能力路由：按 role / zone / tags 择优派发，与熔断共享一张状态表（冷却被降权、熔断被跳过）
- 三种执行器接入：`local-llm`（SenseNova 执行器池）/ `cli`（Codex 等）/ `http-bridge`（WorkBuddy 等）
- 线路池：商汤 3 密钥 × 4 模型 = 12 条 + AMD 1 条，共 13 条共享一张故障转移冷却表；
  429 只冷却命中线路本身
- 双入口：Electron 桌面端（单实例锁，重复启动提前台）+ headless JSONL 协议 CLI
- Token 用量可见性与 `maxTokensPerRun` 预算闸门（settings / UI / 协议三入口贯通）

**安全边界**
- 路径七级判定（穿越 / 越根 / 受保护路径）、命令白名单 + 元字符拦截、
  deadline/idle 双超时、连续失败熔断
- 越权默认回滚（内容备份，不用 git stash），可选隔离区 / 保留 / 仅日志
- JSONL 审计按大小轮转（单文件 2 MiB）；API Key 走 OS keychain（Electron safeStorage），
  不可用时明确回退明文并告知

**质量门禁**（本项目的核心差异化，见 README「质量门禁」）
- `npm run verify` 单一入口，14 步
- 变异门禁双口径：aggregate（每算子至少一处）与 **site（每一处位点单独验证）**；
  仅以 site 为准
- 产物层冒烟（`smoke:artifact`）：防"源码全绿但产物坏了"
- `check:unwired`（导出符号零调用 → FAIL）与 `check:scripts-wired`
  （写在 scripts/ 但不在任何自动入口的脚本 → FAIL，逼作者在"接进入口"和"显式接受"间选）

### 变更

- 依赖：vite 5 → 8、@vitejs/plugin-react 6，对齐 vitest 4 的 peer 要求
  （修 `npm ci` 的 `Missing esbuild@0.28`）
- 进程入口层从"刻意不纳入门禁"变成门禁目标：`main.ts` 补齐 `requestSingleInstanceLock`，
  并新增 `src/main-wiring.test.ts`
- CI 的 mutation job 从 aggregate 改成 site 口径（aggregate 会掩盖位点）

### 修复

- `store.ts`：项目 id 加同毫秒单调序数 + list 平局决胜（修 Linux CI 的
  newest-first flake —— `Date.now()` 毫秒粒度下同毫秒连建两项目会碰撞、排序随机）
- `sandbox/spawn-plan.ts`：resolve 漏传 platform，注入通道失效（真 bug，跨平台轮发现）
- `sandbox/kill-tree.ts`：补 `hasExited` 预检查（POSIX 直接路径的 pid 复用误杀，真缺口）
- Electron 单实例：两个实例驱动同一 projectRoot 会各自建快照、各自回滚，
  审计里出现互相矛盾的 run 记录；现在第二个实例直接退出并提前台

### 已知限制

- **安装需要自备 `.env`**：桌面端与 headless 都不会替你写入密钥
- 真实 LLM 链路（`OX_SMOKE=1` 与全链路脚本）需密钥、消耗配额，**不在门禁内**
- UI 层覆盖率是最低的一档（`src/pages` funcs 75.6%、`platform.ts` funcs 47%）；
  Electron GUI 无自动化 E2E（只有 jsdom 组件测试）
- macOS 打包未验证（release workflow 只产出 Windows / Linux 产物）

