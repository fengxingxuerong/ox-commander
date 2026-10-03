# 更新日志

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式，
版本号遵循语义化版本。**未发布前的版本只记"对用户/对维护者可见的变化"**，
纯内部重构若改变了行为仍会记入。

## [未发布]

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
