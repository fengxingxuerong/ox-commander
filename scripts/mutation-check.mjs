/**
 * 变异验证门禁 —— 证明测试不是空转。
 *
 * ## 为什么需要它
 *
 * `check-unwired` 证明 helper **被调用**；这个脚本证明断言**真的会红**。
 * 两者合起来才能说「测试有效」：
 *   - 没被调用 → 代码是死的
 *   - 调用了但改坏不报 → 测试是死的
 *
 * 本项目实际踩过第二种：断言扫全文行首找 `"## "`，没考虑 Markdown 围栏上下文，
 * 围栏外的注入被漏检（假绿）。当时 `npm run verify` 全绿。
 *
 * ## 原理与判定
 *
 * 对目标源文件施加语义变异（改运算符、反转布尔），每个变异跑一次对应测试：
 *   - 测试**失败**（含编译失败）→ 变异被杀死 → 断言有效 ✓
 *   - 测试**仍通过** → 变异存活 → 该行为无断言覆盖 ✗
 *
 * 编译失败算「杀死」是正确语义：类型系统本身发现了改动，这属于有效防线。
 * 因此**不做单独的语法预检** —— 单文件 `tsc` 在 Windows 上一次要 40s，
 * 会让整个门禁慢到不可用。
 *
 * ## 安全
 *
 * 脚本会**临时改写源文件**。四重保护：
 *   1. 改写前后都读原文，结束时报文比对，不一致直接 exit 2
 *   2. 每个变异用 try/finally 恢复
 *   3. 进程退出钩子兜底恢复（防 SIGINT / 异常退出留脏文件）
 *   4. **落盘备份 + 启动自愈**：进程被外部强杀时 1~3 全部失效（Windows 上
 *      信号处理器不执行），变异体会永久留在工作区。见 `armPendingRecord`。
 *
 * ## 用法
 *
 *   node scripts/mutation-check.mjs              # 全部目标
 *   node scripts/mutation-check.mjs --file=glob
 *   node scripts/mutation-check.mjs --limit=4    # 每文件最多 4 个变异（默认 4）
 *   node scripts/mutation-check.mjs --tier=1     # 只跑 tier 1（快目标，verify 用这个）
 *   node scripts/mutation-check.mjs --shard=1/3  # 把（已按 --tier/--file 过滤后的）目标轮转均摊成
 *                                                #   3 片，只跑第 1 片（CI 按时长切片用）
 *   node scripts/mutation-check.mjs --list       # 只列变异（含位点数），不改文件不跑测试
 *   node scripts/mutation-check.mjs --mode=site  # **逐位点**变异（默认 aggregate，见下）
 *   node scripts/mutation-check.mjs --audit      # = --mode=site --limit=999，逐点全量
 *   node scripts/mutation-check.mjs --recover-only
 *       # 只做「启动自愈」这一件事：有残留就还原并退出 2，干净就退出 0，不跑变异。
 *         verify 把它放在 `npm test` **之前**——残留会让修复循环空转，症状是 vitest
 *         堆涨到 4GB 后 OOM 并挂住（2026-09-28 实测），而不是任何一条可读的失败。
 *
 * ## ⚠️ 两种口径：aggregate（默认）与 site
 *
 * 算子用 `replaceAll` 实现，所以一次变异会改掉源码里**该算子的全部位点**：
 *
 *   - **aggregate（默认）**：N 个算子 = N 个变异。一个"聚合变异被杀死"只证明
 *     「这 N 处里**至少有一处**有断言覆盖」—— **不能**说明其余处也被覆盖。
 *   - **site**：一处一个变异，逐点判定。只有它才能得出「每一处都被断言覆盖」。
 *
 * 这不是理论问题。2026-09-22 实测全仓 **153 个算子对应 540 个位点**（3.5 倍），
 * 而 `snapshot-store.ts` 报「2/2 全杀」时源码里有 12 个 `continue;` ——
 * 拆单点后 **5 个位点存活**。即聚合口径下「100% 全杀」曾系统性高估覆盖率。
 *
 * 成本分层：
 *   - `verify` 里的 `mutation:quick` 用 **aggregate**（每次改动都要跑，必须快）
 *   - `npm run mutation` 用 **aggregate**（成本 460s；CI 上限 20min）
 *   - `npm run mutation:site` 用 **site**（成本约 3.5 倍）——**周期性审计**用，
 *     不是每次改动都跑。审计后聚合计数的可信度才真正成立。
 *
 * 报告会**显式披露**聚合口径下有多少位点没被逐点验证，PASS 文案也区分两种口径 ——
 * 门禁可以慢、可以只覆盖子集，但不能让数字读起来比实际覆盖更强（这是本仓库
 * 反复踩过的「覆盖率数字骗人」，此处是同一教训在门禁自身上的体现）。
 *
 * 退出码：
 *   - 存活变异 > MAX_SURVIVORS → exit 1
 *   - **任何目标的基线测试未通过 → exit 1**（该目标完全没被验证，比存活更严重）
 *   - **位点数与 SITE_BASELINE 不符 → exit 1**（新增位点没人逐点审计过）
 *     判定是 site 口径下**逐目标**做的，且基线里缺键也算漂移；
 *     2026-10-06 起 `npm run mutation:baseline`（不跑变异，约 1s）把同一件事
 *     提进了 `verify`，所以漂移在本机链首就会现形，不用等 CI 的 mutation-full。
 *
 * ## 已知局限（不要误以为它覆盖全仓）
 *
 *   1. **只跑 TARGETS 里列的模块**，不是全仓。全仓会把 verify 从 ~75s 拉到小时级 ——
 *      跑不动的门禁等于没有门禁。选择标准：安全关键 + 逻辑密集。
 *      要扩就按这个标准加，别一次全铺开；新目标若单次测试超过 ~10s，放 tier 2，
 *      否则 `verify` 会被拖慢到没人愿意跑。
 *      （截至 2026-09-22：39 个目标 / 583 处位点，aggregate 全量约 6m30s。
 *      这个数字会变，**别在注释里写死**，用 `--list` 看当前实数。）
 *   2. **算子只覆盖布尔/比较/跳转**，抓不到「数值边界写错」（如 `>` 写成 `>=`）、
 *      「参数顺序颠倒」、「漏 await」。加算子前先确认不会引入等价变异噪声。
 *   3. **等价变异会存活**（语义未变的改写）。首次遇到时优先重构消除该分支；
 *      无法消除则在这里加白名单并附理由，**不要放宽 MAX_SURVIVORS**。
 *   4. **曾经静默容忍「基线失败」**（2026-09-20 修复）。原实现把「基线测试未通过」
 *      当作"无结论"打印一行、然后照常报 PASS —— 目标被跳过、不计入统计、门禁仍绿。
 *      三种诱因（测试路径写错 / 测试被改坏 / 源码有语法错）都会让整块覆盖静默归零，
 *      与「CI 里写错路径、从来没真正跑过的 job」同族。现在改为 exit 1 并点名。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 变异目标 —— 安全与正确性关键、逻辑密集的模块。
 *
 * 不做全仓：成本随变异数线性增长。挑判定逻辑最密集、改坏后果最严重的。
 *
 * `tier` 是成本分层，不是重要性分层：
 *   - tier 1（快，单个变异 ~2s）：`verify` 内的 `mutation:quick` 跑这些。
 *   - tier 2（慢，单个变异 ~25s）：仅 `npm run mutation` 全量扫描时跑。
 *
 * ⚠️ `--tier=N` 是**精确**匹配（只跑该层），不是"≤N"；不传 ＝ 全部目标。
 *   2026-10-16 修：此前实现是 `t.tier <= maxTier`，于是 CI 的 `--tier=2` 分片实际跑的是
 *   **全部**目标（含 tier 1）——那条 job 与 tier 1 那条不是"分区"而是"超集"，
 *   tier 2 的 54.8 min 墙钟里约 23 min 是重复跑 tier 1。脚本头注释与此处写的一直是
 *   "只跑 tier 1"（精确语义），是**实现与声明不符**，不是文档要改。
 *
 * `electron/engine/scheduler.ts` 于 2026-09-20 接入：此前它不在目标里，于是
 * 「类内缺陷」穿过三层门禁（`check:unwired` 只查导出符号、变异不覆盖引擎层，
 * 而测试恰好没有断言触碰真实路径）。接入当天实测存活 1 个 —— `&& → ||`，
 * 定位到 `admitBreaker` 的兜底查找：改成 `||` 后，**整池熔断时任务会被重新派给
 * 一个已熔断的 agent**，熔断静默失效，21 条用例全绿。补一条断言后 4/4 全杀。
 *
 * `electron/engine/orchestrator.ts` 于同日接入 tier 2。**实测 5/5 全杀，
 * 未发现断言缺口** —— 记录在此以说明「集成层盲区」这一判断已按模块逐一核查过，
 * 不是猜的。它进 tier 2 的理由纯粹是成本：`orchestrator.test.ts` 有 30 条用例且
 * 含多轮重修循环，单次约 20s，不是断言质量有问题。
 *
 * `src/store.ts` 于 2026-09-21 接入，配**三个**测试文件。它一个模块里装了三类
 * 逻辑：`handleEvent` 的事件映射（store.test.ts）、IPC 失败/并发的状态机
 * （store-errors.test.ts）、以及页面如何消费这些状态（ui.test.tsx）。
 * 只挂前两个时 `|| → &&` 存活了 —— 那个 `||` 是 `newProjectName.trim() ||
 * "未命名项目"`，唯一的断言在 ui.test.tsx 里。**漏挂测试文件 = 那部分逻辑
 * 没有门禁**，与「覆盖率数字骗人」是同一条教训的翻版。
 */
const TARGETS = [
  { file: "electron/sandbox/path-policy.ts", test: "src/sandbox-path.test.ts", tier: 1 },
  // 2026-10-20：交互式会话的**工具层契约**（工具表 / 参数校验 / 截断说破）与
  // **文本协议解析**（tool 块 → ToolCall）。入表理由：工具名或必填参数判错一次，
  // 模型那一轮调用的结果就是静默丢失 —— 表现是"模型假装读过了"，不落任何错误。
  { file: "shared/tools/spec.ts", tests: ["src/chat-tools.test.ts"], tier: 1 },
  { file: "shared/tools/protocol.ts", tests: ["src/chat-tools.test.ts", "src/mcp-session.test.ts"], tier: 1 },
  // 2026-10-20：补丁解析与应用。入表理由：上下文匹配是补丁的**唯一**防漂移机制，
  // 模糊匹配会把"改错地方"变成"改了别的地方"——而后者在验收里是一片绿。
  { file: "shared/tools/patch.ts", tests: ["src/chat-tools.test.ts"], tier: 1 },
  // 2026-10-20：工具裁决（沙箱三档 × 审批策略）。入表理由：这一层同时决定
  // "read-only 下能不能写"与"要不要先问人"，两件事判反都不报错、只漏防护。
  { file: "shared/tools/policy.ts", tests: ["src/chat-tools.test.ts", "src/chat-tool-runner.test.ts"], tier: 1 },
  // 2026-10-20：会话事件契约与转录派生（摘要/一行说明）。入表理由：摘要是用户
  // 决定"该不该停下来看一眼"的那一行，口径错了没人会发现。
  { file: "shared/chat-events.ts", tests: ["src/chat-tools.test.ts", "src/mcp-session.test.ts"], tier: 1 },
  // 2026-10-20（P1-1）：流式读取层（SSE 切分 / 两种端点形状的增量聚合 / 工具碎片
  // 拼接）。入表理由：切错一个 chunk 边界或少拼一段参数都不会抛错 —— 前者表现为
  // "模型偶尔不回话"，后者表现为"模型调用失败"，两条都会被当成模型的问题。
  { file: "shared/sse.ts", tests: ["src/sse.test.ts"], tier: 1 },
  // 2026-10-20：工具执行层（读/列/检索/补丁/命令）。入表理由：它是唯一真正
  // 落盘与起进程的一层，任何"放过"直接等于越权被执行。
  {
    file: "electron/chat/tool-runner.ts",
    tests: ["src/chat-session.test.ts", "src/chat-security.test.ts", "src/chat-tool-runner.test.ts"],
    tier: 1,
  },
  // 2026-10-20（P1-2）：上下文压缩的纯逻辑（估算 / 切点 / 拼装）。
  // 入表理由：这三样错了都不抛错 —— 估少了漏压（模型从第 N 轮开始看不见开头），
  // 切点劈开工具回合则是端点 400（失败发生在平台之外，最难归因），
  // 压不动却报"压过了"会让"已压缩"变成一句无法验证的话。
  { file: "shared/chat-compress.ts", tests: ["src/chat-compress.test.ts", "src/chat-session.test.ts"], tier: 1 },
  // 2026-10-21（M2）：右栏改动审查的聚合逻辑（转录 → 文件组）。入表理由：
  // 它错了不抛异常，而且错的方向全是"瞒"—— 同一文件多轮改动只留最后一次会让
  // "撤销"恢复出一个谁都没见过的中间态；不可撤销的改动被过滤掉则让操作者
  // 以为那个文件没被动过。顺序不稳定还会让列表抖动。
  { file: "shared/chat-changes.ts", tests: ["src/chat-changes.test.ts"], tier: 1 },
  // 2026-10-20：会话循环。入表理由：中断与 fail-closed 两条行为错了都不会抛错，
  // 只表现为"点了没反应"或"没人答却执行了"——后者是必须被证明不会发生的那类。
  { file: "electron/chat/session.ts", tests: ["src/chat-session.test.ts", "src/mcp-session.test.ts"], tier: 1 },
  // 2026-10-20：会话宿主编排（首条消息建会话、设置/项目切换重建、会话列表/恢复/
  // 分叉/撤销的 IPC）。入表理由：首条消息空指针与"恢复后消息序列错位"都是
  // 页面照样能点、只是行为错的那类缺陷。
  { file: "electron/ipc/chat.ts", tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"], tier: 1 },
  // 2026-10-20：会话运行时边界（项目约定 + .ox/config.json + 全局/项目 policy.d）。
  // 入表理由：任何一条合并不是"更严"而是"被静默放宽"时，界面仍显示旧档位。
  { file: "electron/chat/runtime.ts", tests: ["src/chat-runtime.test.ts", "src/ipc-handlers.test.ts"], tier: 1 },
  // 2026-10-20：会话记录仓（原子索引、坏文件跳过、fork/delete、重启恢复）。
  // 入表理由：恢复错一条消息或把源会话覆盖成分叉，都不会抛错。
  { file: "electron/chat/session-store.ts", tests: ["src/chat-store.test.ts", "src/ipc-handlers.test.ts"], tier: 1 },
  // 2026-10-20：项目级 `.ox/config.json` 归一化。入表理由：未知版本/非法档位
  // 必须整份忽略并说破，不能被半懂不懂地执行成一次放宽。
  { file: "shared/project-config.ts", tests: ["src/chat-runtime.test.ts"], tier: 1 },
  // 2026-10-23（M7）：MCP 契约（清单归一化 / 名空间 / 宽松 schema 校验 / 结果展平）。
  // 入表理由：名空间拆错一次，模型调的是另一个工具；schema 校验多拒一次，合法调用
  // 会被静默丢掉；返回展平把 base64 灌进上下文则是一次昂贵的上下文事故。
  { file: "shared/mcp.ts", tests: ["src/mcp-contract.test.ts"], tier: 1 },
  // 2026-10-23（M7）：mcp.d 容错加载与签名指纹。坏清单被静默丢弃 = "我配的 server
  // 没生效"且无迹可查；指纹漏项 = 改了配置却继续跑旧进程。
  { file: "electron/mcp/manifest.ts", tests: ["src/mcp-contract.test.ts"], tier: 1 },
  // 2026-10-23（M7）：stdio JSON-RPC 客户端。超时/中止/熔断三条错法都不会抛到
  // 会话层：分别是"界面卡死"、"子进程继续跑"、"坏 server 每轮拖满超时"。
  { file: "electron/mcp/client.ts", tests: ["src/mcp-client.test.ts"], tier: 1 },
  // 2026-10-23（M7）：连接池的目录上限与路由。静默截断工具目录会让模型"看不见
  // 某个工具"而人毫无线索；未声明工具被放行则越过了 tools/list 这道窄门。
  { file: "electron/mcp/pool.ts", tests: ["src/mcp-client.test.ts", "src/mcp-session.test.ts"], tier: 1 },
  // 2026-10-17：桌面通知判据（C1，竞品缺口「通知」格）——哪些事件值得打扰人
  // （receipt / escalation / approval-request 三档，其余全不弹）与文案裁剪。
  // 入表理由：弹窗是 Electron 副作用无法单测，**判据错了就等于通知全错**，
  // 而错的方向恰好是"该弹的不弹"——没有测试盯着它不会有任何人发现。
  { file: "electron/notify-rules.ts", test: "src/notify-rules.test.ts", tier: 1 },
  // 2026-09-29：board-recovery 的纯函数推导层（facts/derived split）。新文件
  // 必须显式入表 —— touched 口径靠这张表映射，漏挂=永远无人审计。
  { file: "electron/board-derive.ts", test: "src/board-derive.test.ts", tier: 1 },
  // 2026-10-07：`FailureClass` 的单一真源（union + FAILURE_CLASSES + isFailureClass）。
  // 入表理由不是"它有代码"，而是**两个边界都靠它**：`src/store.ts`（IPC 事件路径）
  // 与 `electron/board-derive.ts`（审计恢复路径）。这轮发现收窄器一直**零调用者**，
  // 而 BoardPage 的注释却写着"值已在边界经 isFailureClass 收窄" ——
  // 注释描述的是一条从未存在的接线。收窄器本身必须在表内，否则它退化成一个
  // 没人验证的 `includes`。
  { file: "shared/types.ts", tests: ["src/store.test.ts", "src/board-derive.test.ts", "electron/store.test.ts"], tier: 2 },
  // 2026-09-29：跨动作状态机（竞品调研 §5.1）—— 规则在纯函数里（escalatedVerdict /
  // extractActionFacts），ActionGate 是薄壳；同批接入 CommandPolicy 的 npm 子命令地板。
  { file: "electron/sandbox/action-gate.ts", test: "src/action-gate.test.ts", tier: 1 },
  // 2026-10-01：审批门（竞品调研 P2-3）—— needsApproval / approvalDeniedReason
  // 是纯函数，ApprovalGate 是持有"本批已批准"的薄壳（fail-closed：没回调即拒绝）。
  { file: "electron/sandbox/approval-gate.ts", test: "src/approval-gate.test.ts", tier: 1 },
  // 2026-10-11：循环输出检测（竞品刷新，闭环 loop detection 软挂起项）——纯函数
  // 判定器，判定挂载在 scheduler 的 collectToTerminal；同轮给 contract/scheduler/
  // circuit-breaker 加的位点随各自既有目标审计。
  { file: "electron/sandbox/loop-detector.ts", test: "src/loop-detector.test.ts", tier: 1 },
  // 2026-10-11：serve 定时运行的纯判定核心（竞品刷新第五轮，Orca scheduled
  // automations 对位）——间隔/参数解析、补跑判定、忙时重试间隔；调度环接线在
  // serve-main（注入式时钟/fetch，测试手动泵驱动）。
  { file: "shared/schedule-core.ts", test: "src/schedule-core.test.ts", tier: 1 },
  // 2026-10-11：交付后 git 导出（5.7 本地半边）——porcelain -z 解析、zone 过滤、
  // 分块 add、身份兜底重试；真 git 集成用例在 src/git-export.test.ts 尾部。
  { file: "electron/engine/git-export.ts", test: "src/git-export.test.ts", tier: 1 },
  // 2026-10-12：交付后的远端分发（5.7 远端半边）——remote/分支名字符集自证、
  // `gh pr checks` 的 JSON 解析（解析不出一律 unknown，绝不猜成绿）、PR URL 提取、
  // 轮询的停条件。spawn 由平台注入，所以判定核心在这里就能被逐点审计；
  // orchestrator/platform 的接线位点随各自既有目标审计。
  { file: "electron/engine/git-remote.ts", test: "src/git-remote.test.ts", tier: 1 },
  // 2026-10-12：规划前的只读外部上下文（P2-1 本地半边）——`gh` 命令构造白名单、
  // owner/repo 与 PR 号字符集、条数/字符预算收敛、issue/PR 输出解析与裁剪。
  // 全是纯函数 + 注入 runner（默认分支才真 spawn，测试不碰网络）。tier 1：整份 ~0.4s。
  { file: "electron/context/github-readonly.ts", test: "src/github-context.test.ts", tier: 1 },
  // 2026-10-01 补挂：策略即代码（P2-2）的契约层。落地时漏登记，本次与审批门同批补上 ——
  // 它承载"只加严不放宽"这条安全语义（归一化 / 合并 / 只产出 denyMore），
  // 在执行面接线位点之外还该有自己的逐位点保护。
  { file: "shared/policy-file.ts", tests: ["src/policy-file.test.ts", "src/platform.test.ts", "src/chat-runtime.test.ts"], tier: 2 },
  // 2026-10-20：策略目录多来源合并（全局 + 项目 `.ox/policy.d`）。入表理由：
  // 并集写错会静默丢规则，而日志仍会说"已加载 N 份"。
  { file: "electron/sandbox/policy-dir.ts", test: "electron/sandbox/policy-dir.test.ts", tier: 1 },
  { file: "shared/glob.ts", test: "src/glob.test.ts", tier: 1 },
  { file: "shared/redact.ts", test: "src/redact.test.ts", tier: 1 },
  { file: "shared/prompt-text.ts", test: "src/prompt-injection.test.ts", tier: 1 },
  // 2026-10-14 摄入半边：issue → 需求文本的成文模板。住 shared 是因为两个宿主
  // （桌面项目种子 / headless spec.issue）共用它，各写一份会让 journal 的需求
  // 匹配悄悄失配。位点少但它是"两处对同一句话"的唯一事实源，值得逐点盯着。
  { file: "shared/github-issue.ts", test: "shared/github-issue.test.ts", tier: 1 },
  { file: "electron/agents/scoped-env.ts", test: "src/scoped-env.test.ts", tier: 1 },
  // 2026-10-17（C6）：候选表与扫 PATH。它的守卫是那两条"与 agents.d 模板逐条
  // 比对"的断言 —— 漂移没有别的出口，只能靠门禁拦。
  { file: "electron/agents/cli-detect.ts", test: "src/cli-detect.test.ts", tier: 1 },
  { file: "shared/zone-coverage.ts", test: "src/zone-coverage.test.ts", tier: 1 },
  // 2026-10-17（B1 第二半）：行级 diff 纯函数。住 shared 是因为 diff 判据
  // （行号、增删统计、截断与二进制的"未知即 null"）双端共用；位点不密但
  // 每一处都是"面板上的数字对不对"的直接来源，值得逐点盯着。
  { file: "shared/text-diff.ts", test: "src/text-diff.test.ts", tier: 1 },
  // 2026-10-19（交付成果面）：本次运行边界的判定、按任务 zone 分组、跨批去重、
  // 凭据命令与 package.json 启动脚本。桌面看板与 serve 状态页共用这份推导 ——
  // 判错不抛异常，只会让"本次产物"混进上一次 run 或漏掉文件。
  { file: "shared/delivery-guide.ts", test: "src/delivery-guide.test.ts", tier: 1 },
  // 2026-10-17（B3）：项目约定注入。纯函数（拼接/截断/空块）与读盘
  // （OX.md / AGENTS.md、单文件上限、读不动只报不抛）各一条目标 ——
  // 拼错一个字符就是"约定带进了提示但读的人看不懂"，而它在测试之外不可见。
  { file: "shared/project-conventions.ts", test: "src/project-conventions.test.ts", tier: 1 },
  // 2026-10-25：规划备忘（项目级规划记忆，形态 A）。入表理由：三个判据全都不抛错 ——
  // 备忘块的"背景不是证据"声明被吃掉，人会以为它代表门禁结论；超限静默截断，模型
  // 以为自己看全了；背景总预算算错，提示悄悄变长或变短，两端都看不出来。
  // 2026-10-25：规划历史（形态 B：跨 run 的规划记忆走审计落盘事实）。入表理由：
  // 四条判据全都不会抛错 —— 指纹算错，「需求改过」被说成「没改」；历史取错条，
  // 注入的是上一版的上一版；差异算错，人会以为拆法一致而其实已经变了；
  // 超限静默截断，模型以为自己看全了。
  {
    file: "shared/plan-history.ts",
    tests: ["src/plan-history.test.ts", "src/prompts.test.ts", "src/orchestrator.test.ts"],
    tier: 1,
  },
  { file: "shared/plan-memo.ts", tests: ["src/plan-memo.test.ts", "src/prompts.test.ts"], tier: 1 },
  // 2026-10-25：可核事实汇总（规划备忘的"自动汇总"半）。入表理由：这一层错了都不抛错 ——
  // 计数错就给规划一份假账；**键序不稳定**会让同一份审计在不同进程里给出不同文字，
  // 而"可复现"正是这个特性敢进提示的前提；缺 errorClass 的失败若被丢掉，账会静默变少。
  {
    file: "shared/plan-facts.ts",
    tests: ["src/plan-facts.test.ts", "src/prompts.test.ts", "src/ipc-handlers.test.ts"],
    tier: 1,
  },
  { file: "electron/engine/conventions.ts", tests: ["src/project-conventions.test.ts", "src/chat-runtime.test.ts"], tier: 1 },
  // 2026-10-17（C6）：PATH 解析纯函数。位点少但每一处都是"能不能扫到"的分岔 ——
  // 分隔符猜错平台就表现为"明明装了却说没装"，而这在本机测不出来。
  { file: "shared/cli-detect.ts", test: "src/cli-detect.test.ts", tier: 1 },
  // 2026-10-18（C3）：页面冒烟判据。它决定"HTTP 200 的页面算不算交付"，
  // 误报会把好交付挡在门外 —— 所以"空壳不判红"那一格必须被逐点盯着。
  { file: "shared/page-smoke.ts", test: "src/page-smoke.test.ts", tier: 1 },
  // 2026-09-28：补挂 src/audit-log.test.ts —— 它里面除了 AuditLog，还有 Scheduler 的
  // 并发上限用例（`never exceeds maxParallelRuns` / `treats 0 as unlimited`），
  // 而 `maxParallel()` 的三元就在那个文件里被真实验证。此前只挂 scheduler.test.ts，
  // 于是「0 → 无限」那一格无人守（三元算子评估里 @121 存活即由此而来）。
  {
    file: "electron/engine/scheduler.ts",
    tests: ["src/scheduler.test.ts", "src/audit-log.test.ts"],
    tier: 1,
  },
  // kill-tree 是超时兜底的最后一道闸：A3 加固的 fallback/二次确认分支都在
  // 这里，一个算子翻转就意味着"杀不掉的进程"回来了。纯 mock 测试，毫秒级。
  { file: "electron/sandbox/kill-tree.ts", test: "src/kill-tree.test.ts", tier: 1 },
  // attention.ts 是看板「该你了」注意力条的判据（第六轮竞品刷新排期第 1 项）：
  // 优先级排序、去重（升级卡已覆盖的失败任务不双报）、空态不出条 —— 错了都是
  // 静默的（该喊的不喊 = 人错过裁决；不该喊的喊 = 教人忽略整条）。纯函数。
  { file: "src/attention.ts", test: "src/attention.test.ts", tier: 1 },
  {
    file: "src/store.ts",
    tests: ["src/store.test.ts", "src/store-errors.test.ts", "src/ui.test.tsx", "src/chat-ui.test.tsx"],
    tier: 1,
  },
  { file: "electron/engine/orchestrator.ts", test: "src/orchestrator.test.ts", tier: 2 },
  // 2026-09-21 接入 tier 2：agents 层 2259 行此前只有最小的 scoped-env.ts
  // 在册，而 sensenova-api 是 DEFAULT_SETTINGS 里的默认适配器 —— 即新装用户
  // 实际跑的那条路径（§9.4 的接线缺陷就出在这里）。先挂 tier 2 探成本。
  { file: "electron/agents/manifest-schema.ts", test: "src/manifest.test.ts", tier: 2 },
  { file: "electron/agents/registry.ts", test: "src/agent-registry.test.ts", tier: 2 },
  {
    file: "electron/agents/cli-agent.ts",
    tests: ["src/cli-agent.test.ts", "src/cli-agent-env.test.ts"],
    tier: 2,
  },
  { file: "electron/agents/sensenova-api.ts", test: "src/sensenova-api.test.ts", tier: 2 },
  { file: "electron/agents/http-bridge.ts", test: "src/http-bridge.test.ts", tier: 2 },
  // 2026-10-05（D11/D12）：两个 headless 入口的参数解析。它们的逻辑只有十几行，
  // 但**全是分支**（给错 / 不给 / 拼错 / 越界 / 协议不对），而这类代码的缺陷
  // 形状恰好是"静默回落默认值 + exit 0"——覆盖率数字完全看不出问题，
  // 只有把「回落」变异成「报错」（或反之）才会暴露断言够不够。
  // tier 1：测试是纯函数 + 少量 spawn，秒级。
  // 2026-10-11：定时运行调度环（schedule-core.test.ts 的 loop 用例直接驱动
  // startScheduleLoop）补挂 —— 触发/跳过/落盘语义的断言都在那份文件里。
  { file: "headless/serve-main.ts", tests: ["src/headless-entries.test.ts", "src/schedule-core.test.ts"], tier: 1 },
  { file: "headless/mcp-main.ts", test: "src/headless-entries.test.ts", tier: 1 },
  // 2026-10-10：桌面侧的交付凭据复核（receipt:verify，欠账 #7）。与命令行入口
  // `headless/receipt-verify-main.ts` 共用 `shared/delivery-receipt` 的判据，
  // 但本文件自己有承判逻辑（指纹三档门、canReplay 合取、BOM 剥离、裁决装配）——
  // 逻辑密集、可测，故独立挂表（挂 ipc-handlers.test.ts 的那组 receipt:verify 用例）。
  { file: "electron/ipc/receipt.ts", test: "src/ipc-handlers.test.ts", tier: 2 },
  // 2026-10-14 摄入半边：github:list-issues 的承判逻辑（入参形状校验 ——
  // 渲染层传来的 repo/search/limit 是不可信输入，与 settings:save 同一条
  // P0-3 规矩）。测试文件与 projects/receipt 共用 ipc-handlers.test.ts
  // （单跑 ~20s，故 tier 2）。
  { file: "electron/ipc/github.ts", test: "src/ipc-handlers.test.ts", tier: 2 },
  // 2026-10-05（D11 同批）：receipt-verify 是**退出码即 CI 判定**的那个入口，
  // 判据密集（它决定"这次重放到底算不算通过"）。此前完全不在表内 ——
  // 由 scripts/check-mutation-targets.mjs 查出来：那道门禁比对 git diff 与本表，
  // 漏挂的文件根本不参与变异统计，门禁照样报 PASS 而那个 PASS 对它是空的。
  { file: "headless/receipt-verify-main.ts", test: "src/headless-entries.test.ts", tier: 1 },
  // manifest-loader 与 manifest-schema 共用 src/manifest.test.ts —— 同一个测试
  // 文件挂两个目标是对的，不要为了"去重"只挂一个。
  { file: "electron/agents/manifest-loader.ts", test: "src/manifest.test.ts", tier: 2 },
  // 2026-09-21 接入 tier 2：LLM 通信层此前完全不在目标内。它是全项目最热的
  // 路径（每个适配器、每个 provider 都从这里出去），却从没被变异覆盖过。
  { file: "shared/llm-client.ts", test: "src/llm-client.test.ts", tier: 2 },
  {
    file: "shared/http-clients.ts",
    // 四个文件缺一不可：http-clients.test.ts 只覆盖两个 client 类，
    // FailoverLlmClient 的断言全在 failover.test.ts，池展开在 llm-pool.test.ts，
    // cap/Retry-After 在 retry-after.test.ts。首版只挂了两个，
    // 于是 11 个位点全"存活"—— 其中一半其实是断言挂在没跑的文件里。
    tests: [
      "src/http-clients.test.ts",
      "src/retry-after.test.ts",
      "src/failover.test.ts",
      "src/llm-pool.test.ts",
      // 原生 function calling 的映射/解析（OpenAI + Anthropic）住在 chat-tools.test.ts；
      // 漏挂它会把这 20+ 个位点全报成"存活"，而断言其实在没跑的文件里。
      "src/chat-tools.test.ts",
    ],
    tier: 2,
  },
  // schema.ts 的冒烟测试（sensenova.smoke.test.ts）刻意不挂：它要真实 API 凭据，
  // 挂进去会让变异验证依赖网络。parseDecompose 的注入断言在 prompt-injection.test.ts。
  {
    file: "shared/schema.ts",
    tests: ["src/schema.test.ts", "src/prompt-injection.test.ts"],
    tier: 2,
  },
  // verifier 的断言散在五个文件：runSmokeChecks 在 verifier.test.ts，
  // verifyProject 在 sandbox-runtime / spawn-plan 两个集成测试里，
  // dev server 托管分支在 dev-server.test.ts（2026-10-02），
  // 页面冒烟 `pageSmokeFor` 那一段在 page-smoke.test.ts（2026-10-18）。
  {
    file: "electron/engine/verifier.ts",
    tests: [
      "src/verifier.test.ts",
      "src/sandbox-runtime.test.ts",
      "src/spawn-plan.test.ts",
      "src/dev-server.test.ts",
      "src/page-smoke.test.ts",
    ],
    tier: 2,
  },
  // run-session 是三个适配器共用的等待-唤醒协议核心（消费者 await 一个
  // **没有超时**的 promise）。此前只在各适配器的集成测试里被间接覆盖，
  // 出问题时表现为"用例挂住直到超时"而非明确报错 —— 见 2026-09-21 的
  // `=== → !==` 挂住调查。
  { file: "electron/agents/run-session.ts", test: "src/run-session.test.ts", tier: 2 },

  // ---- 2026-09-21 第二批：沙箱层是安全边界，此前完全不在门禁内 ----
  // 挂载一律用「精确 import 匹配」的结果，不按文件名猜 —— 模块名与测试名
  // 常常不一致（electron/store.ts 的测试叫 atomic-store.test.ts）。
  {
    file: "electron/sandbox/command-policy.ts",
    tests: ["src/spawn-plan.test.ts", "src/sandbox-runtime.test.ts"],
    tier: 2,
  },
  {
    file: "electron/sandbox/spawn-plan.ts",
    tests: ["src/spawn-plan.test.ts", "src/sandbox-runtime.test.ts"],
    tier: 2,
  },
  // 2026-10-11：成功率持久化（ruflo「自适应记忆」对位）补挂 breaker-persistence
  // —— 恢复总账/写回/坏账从零/淡出封顶的断言都在那份新文件里，漏挂 = 新位点无人验证。
  { file: "electron/sandbox/circuit-breaker.ts", tests: ["src/sandbox-runtime.test.ts", "src/breaker-persistence.test.ts"], tier: 2 },
  { file: "electron/sandbox/timeout-gate.ts", test: "src/sandbox-runtime.test.ts", tier: 2 },
  { file: "electron/sandbox/file-journal.ts", test: "src/sandbox-journal.test.ts", tier: 2 },
  // ---- 2026-09-25：原子写是**持久化唯一通道**（store / keys-store / journal
  // 快照全走它）。它错起来不抛错：tmp 名撞车 → 一次写入凭空消失，磁盘上
  // 仍是"上一次的完整值"，所有读路径都绿。此前完全不在门禁内。
  // tier 1：测试 ~120ms。
  { file: "electron/atomic-file.ts", test: "src/atomic-store.test.ts", tier: 1 },
  // ⚠️ 2026-09-22 修正：原为 `test: "src/sandbox-journal.test.ts"`（单数），
  // **漏挂了 `scheduler.test.ts`** —— batch-guard 的集成路径就在那条文件里，
  // 未挂的那部分断言此前完全不参与判定（「漏挂测试文件 = 那部分逻辑没有门禁」）。
  {
    file: "electron/sandbox/snapshot-store.ts",
    tests: ["src/sandbox-journal.test.ts", "src/scheduler.test.ts"],
    tier: 2,
  },

  // ---- 2026-09-22 第三批：引擎层路由/仲裁 + 安全存储 ----
  // 挑这三个的标准是「算子位密度」：router 15 个、keys-store 13 个、batch-guard 7 个
  // —— 位点多意味着同样的接入成本能发现更多断言缺口。
  // batch-guard 挂**全部**三个测试文件：一个模块被多文件覆盖时只挂一个，
  // 另一半断言完全不参与判定（`store.ts` 上踩过这个坑）。
  { file: "electron/engine/router.ts", test: "src/router.test.ts", tier: 2 },
  { file: "electron/keys-store.ts", test: "src/keys-store.test.ts", tier: 2 },
  {
    file: "electron/engine/batch-guard.ts",
    tests: ["src/sandbox-journal.test.ts", "src/scheduler.test.ts", "src/audit-log.test.ts"],
    tier: 2,
  },
  { file: "shared/graph.ts", test: "src/graph.test.ts", tier: 2 },

  // ---- 2026-09-22 第四批：IPC handler 层试点（C1 拆分后行为测试补齐） ----
  // orchestration.ts 是任务下发主链路（规划/启动/取消/仲裁回流），也是全项目
  // 信任面最重的文件之一（2026-10-05 补测后 lines/functions/statements 均 100%，
  // update-prd 的两条 fail-closed 守卫分支是那批的主要目标）。
  // 挂行为测试 + 通道契约两个文件：前者杀行为变异，后者守住 handler 注册面。
  // ⚠️ 本文件在 TARGETS 里**只能出现这一处**：2026-10-12 全量审计发现曾有第二个
  //    条目（单测试的旧写法），导致该目标被审计两遍、审计总数与 SITE_BASELINE 对不上。
  {
    file: "electron/ipc/orchestration.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },
  // ---- 2026-09-22 第四批（续）：IPC 其余 handler 域 + 共享装配层 ----
  {
    file: "electron/ipc/projects.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },
  {
    file: "electron/ipc/agents.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },
  // 2026-10-19（交付成果面）：delivery:guide / delivery:read 的 IO 边界。
  // 只读预览的路径判定（字面 + realpath 两道）与截断/二进制边界是安全与可用性
  // 的交界；判错不抛异常，只会在界面上"读不到"或"读到树外"。
  {
    file: "electron/ipc/delivery.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },
  // 2026-10-25（C3 剩余半）：预览的浏览器身份隔离。判据只有"项目 id → profile 名"
  // 这一条，但它是"隔离"这个词的全部内容 —— 映射错了两个项目就共用一份 cookie，
  // 而界面上看不出任何异常；畸形身份若被放行，还会变成磁盘上的目录名。
  { file: "shared/preview-isolation.ts", test: "src/preview-isolation.test.ts", tier: 1 },
  // 2026-10-25（C3 剩余半）：应用内预览窗口 —— 隔离 profile、导航守卫、单例复用、
  // 关闭与存储清理。判错都不抛异常：换项目时复用了旧窗口，表现为"两个项目共用登录态"；
  // 守卫判反，表现为"预览页自己跳走了"，而主窗口的守卫拦不到它。
  {
    file: "electron/preview-window.ts",
    tests: ["src/preview-window.test.ts", "src/ipc-handlers.test.ts", "src/main-wiring.test.ts"],
    tier: 1,
  },
  // 2026-10-19（item 2）：dev server 保活的生命周期（单实例替换、TTL 防误停、
  // 日志尾部、退出/停止清理、已死进程不接管）。判错会表现为"旧进程占着端口"
  // 或"预览被别人的定时器停掉"，都不抛异常。
  { file: "electron/preview-manager.ts", test: "src/preview-manager.test.ts", tier: 1 },
  // context.ts 是全部单例状态与桌面装配的家：密钥播种、审计落盘、journal、
  // layer 缓存都在这里，变异一露头就说明装配语义可被悄悄改变。
  {
    file: "electron/ipc/context.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },

  // ---- 2026-09-22 第五批：门禁盲区扫描（覆盖率交叉比对找出的三个模块）----
  // 挑选口径：不在既有 37 个目标内，且**函数覆盖偏低**或**属于集成层**。
  // 三个目标首跑共 9 个位点存活、**零等价变异**（连续第三轮全真缺口）。
  //
  // platform.ts 是双入口的唯一装配点 —— P1-1「Electron 与 headless 装配漂移」
  // 就出在这里。它的 `agentRouter !== false` 曾整格无守护。
  {
    file: "electron/platform.ts",
    // platform.test.ts 覆盖 createPlatform/createFileJournal；ipc.test.ts 与
    // headless-protocol.test.ts 从两个宿主侧间接走同一条装配路径。
    tests: ["src/platform.test.ts", "src/ipc.test.ts", "src/headless-protocol.test.ts"],
    tier: 2,
  },
  // protocol.ts 是宿主与进程之间的契约面（326 行）。parseCommands 的四个
  // `continue` 此前零覆盖：旧用例只传单个非法项，「跳过本条」与「中止循环」
  // 行为相同，于是断不出差异。补的断言都让**非法项后面还有项**。
  { file: "headless/protocol.ts", tests: ["src/headless-protocol.test.ts"], tier: 2 },
  // zone-guard.ts 是 zone 沙箱的 before/after diff 实现。scanFiles 的四个
  // `continue` 同理：旧用例里被跳过的项永远是同级最后一项。
  {
    file: "electron/engine/zone-guard.ts",
    tests: ["src/zone-guard.test.ts", "src/scheduler.test.ts"],
    tier: 2,
  },

  // ---- 2026-09-23 第六批：进程入口（此前 0% 覆盖、且不在任何门禁内）----
  // main.ts 是唯一"错了整个应用都不可用"的文件：单实例锁守卫、窗口装配、
  // .env 装载优先级。它此前被列进"刻意不纳入"（需要起 Electron），但依赖是
  // 假的就成立 —— `src/__fakes__/electron.ts` 长出 whenReady / 单实例锁 /
  // 有行为的 BrowserWindow 之后，入口可以在 vitest 里**跑起来**再断言。
  // 挂 tier 1：整份测试 ~80ms，且算子是"守卫消失"型，坏了必须当场红。
  //
  // ⚠️ 已知覆盖边界：入口里两个最关键的守卫是 `if (!isPrimaryInstance)` 与
  // `if (!win)`，而算子表里**没有对应的取反算子**（只有 && / === / !==）——
  // 即这两处靠行为测试保证，不靠变异。要纳入得先给算子表加 `if (!x)` → `if (x)`，
  // 那会同时命中其余 26 个目标，属独立排期。
  { file: "electron/main.ts", test: "src/main-wiring.test.ts", tier: 1 },

  // ---- 2026-09-23 第七批：token 用量采集（此前零消费方）----
  // usageTokens 采集了很久却没有任何读取方（无汇总、无上限），长跑烧配额
  // 只能靠翻服务商账单。本模块是纯逻辑的累加器 + 装饰器，脏数据处理
  // （NaN/负数/缺字段不能污染总量）是它的全部价值所在 —— 这类"算错了也不报错"
  // 的逻辑正该进变异门禁。tier 1：整份测试 9ms。
  { file: "shared/usage-meter.ts", test: "src/usage-meter.test.ts", tier: 1 },

  // ---- 2026-09-24 第八批：headless 的两道纯逻辑闸 ----
  // 凭证闸（少 Key 就拒跑）与备份回收（`pruneStaleBackups`）都是"判错方向不报错"
  // 的逻辑：前者放行了会打到没密钥的 provider，后者删错了会吃掉唯一的中断现场。
  { file: "headless/run-spec.ts", tests: ["src/headless-protocol.test.ts"], tier: 2 },

  // ---- 2026-09-27 第九批：全量 site 基线（2026-09-23）之后新增/重写、
  //      却从未进过变异门禁的模块 ----
  // 挑选口径同第五批：先与 TARGETS 做差集，再按「错了也不报错」排序 ——
  // 这类判定坏了不会有异常，只会让调用方多绕一轮或白跑一轮。
  //
  // deliverable-format.ts 是 09-26/27 实弹演习逼出来的新模块：交付从「JSON
  // 字符串转义」换成「OXFILE 原文块」，并负责把模型给的路径归一到 zone 内
  // （`resolveDeliverablePath`）。**输入是模型输出 = 不可信输入**，且三条判定
  // （绝对路径 / 文件级 zone / 目录前缀）全是上述形状：归一错一格，写入要么被
  // assertWritable 拒掉白跑一轮，要么指向 zone 之外。tier 1：整份测试 11ms。
  {
    file: "shared/deliverable-format.ts",
    test: "shared/deliverable-format.test.ts",
    tier: 1,
  },
  // routing.ts 决定「验收失败后把错误摘要送给谁」：extractErrorFiles 从构建日志里
  // 抽路径、routeVerificationErrors 按 zone 归属投递。判错不抛异常，只是摘要
  // 投错任务（该修的拿不到、不相关的被灌满）—— 正是"很少有人盯"的那类逻辑。
  // tier 1：整份测试 7ms。
  { file: "shared/routing.ts", test: "src/routing.test.ts", tier: 1 },
  // prompts.ts 是给规划大脑与重修环节的提示词生成器。它不碰内存安全，但承担着
  // 「产出格式约束」：措辞一改，模型的输出形状跟着变（而这条链路上没有类型系统
  // 兜底）。能钉住它的只有字符串层面的 `includes(...)` 断言 —— 正好是现有算子
  // 能覆盖的形状。tier 1：6ms。
  {
    file: "shared/prompts.ts",
    // 2026-10-17（B3）：约定块的三元（空段不产）由 orchestrator.test.ts 的
    // 「项目约定注入」钉住 —— 只挂 prompts.test.ts 时那两格没人守。
    tests: ["src/prompts.test.ts", "src/orchestrator.test.ts"],
    tier: 1,
  },
  // electron/store.ts 是主进程的设置/持久层（108 行），桌面启动早期读的东西。
  // 它是迄今唯一「测试写在被测模块旁」的目标（electron/store.test.ts），
  // 会不会被 vitest 收集由 check-tests-collected 守着，不会漏挂。
  { file: "electron/store.ts", test: "electron/store.test.ts", tier: 2 },

  // ---- 2026-09-27 第十批 ----
  // 审计日志（`audit-log.ts`）。整个模块的注释自己就写着 "Auditing must never
  // take the pipeline down" —— 于是里面每一处判定都是「错了也不报错」的形状：
  //   · `enforceRetention` 的 `f !== this.current` 反向 → 正在写的那个文件被删，
  //     历史断一截，而它正是 `maxFiles` 要治的"只滚不删"泄漏的复发；
  //   · `read()` 的 `opts.phase && parsed.phase !== opts.phase` 放宽 → 过滤失效，
  //     看板把别的阶段的记录混进来，排查时指向错误的阶段；
  //   · `files()` 的 `startsWith("audit-") && endsWith(".jsonl")` 放宽 → 把别人的
  //     文件并进历史（导出时一起带走）。
  // 复盘材料被静默改坏，比报错难查得多。tier 2：`src/audit-log.test.ts` 里还
  // 挂着 Scheduler 的异步用例，比纯逻辑目标慢。
  { file: "electron/audit-log.ts", tests: ["src/audit-log.test.ts"], tier: 2 },
  // 智能体装配层（`agents/index.ts`）：一个函数决定这一轮 run 到底有没有
  // 路由器 / 有没有 BatchGuard。判错同样是静默的 ——
  // `enableRouter !== false` 反过来 = 显式要求开路由却被降级成轮询（能力匹配
  // 失效但不报错）；`!builtinIds.has(m.id)` 反过来 = 内置适配器被声明覆盖；
  // `opts.arbitration ?? "revert-batch"` 反向 = 越权写入不再回滚。
  // 它同时被桌面与 headless 两个入口共用以防漂移，所以这里的静默降级会
  // 两边一起静默。tier 2：需要跑多个集成测试文件。
  // 2026-09-30：远程执行器的边界提示也挂在这一层（P1-4），它的断言在
  // `src/remote-endpoint.test.ts` —— 一个模块被拆成多个测试文件时**都要挂**，
  // 只挂一个等于另一半没有门禁。
  {
    file: "electron/agents/index.ts",
    tests: ["src/headless-protocol.test.ts", "src/scheduler.test.ts", "src/remote-endpoint.test.ts"],
    tier: 2,
  },

  // ---- 2026-09-28 第十一批：LLM 网关的「线路组装」三层 ----
  // 这三层是同一个问题的三个截面：**哪个 provider 走哪条构造路径**。判错都不是
  // 异常，而是「线路池里少/多一条线」—— 表面照常跑，只是可用性和成本悄悄变了。
  //
  // providers.ts：provider 目录 + `getProvider` 的 id 匹配 + `providerKeyEnvVars`
  // 决定 sensenova 到底带几个 key 进池（3 个 vs 1 个 = 12 条线路 vs 1 条）。
  // 判错方向不报错：少带 key 只是 failover 的旋转面变窄，全池冷却时才知道。
  // tier 2：两个测试文件都跑池的构造。
  {
    file: "shared/providers.ts",
    tests: ["src/llm-pool.test.ts", "src/http-clients.test.ts"],
    tier: 2,
  },
  // skills.ts（M6a）：SKILL.md 的解析 / 归一化 / 同名去重 / 目录块。判错方向全是
  // 静默的 —— 坏技能被当成不存在、截断不说破（模型以为看全了）、覆盖方向反了
  // 就是"改了没用"。tier 1：纯函数。
  {
    file: "shared/skills.ts",
    tests: ["src/skills.test.ts"],
    tier: 1,
  },
  // engine/skills.ts（M6a）：技能目录扫描。错法同样静默：漏扫一边等于"我明明
  // 加了技能却看不见"、坏技能消失、项目级被全局级顶掉。tier 1：读盘薄壳，
  // 一个测试文件就能逐点杀。
  {
    file: "electron/engine/skills.ts",
    tests: ["src/skills-scan.test.ts"],
    tier: 1,
  },
  // chat-conflict.ts（M4c）：并行写冲突判据。它决定"要不要拦一下人"，判错方向
  // 全是静默的：只认别人的写（自己接着打补丁不能被自己拦）、窗外的不算并发、
  // 同一路径只报最近那一条、时钟倒挂按"刚刚"处理（宁可多问一次）。tier 1。
  {
    file: "shared/chat-conflict.ts",
    tests: ["src/chat-conflict.test.ts"],
    tier: 1,
  },
  // chat-thread-status.ts（M4b）：左栏状态位。错法全是**静默**的 —— 后台跑完
  // 不标完成、等审批不变橙、正在看的那条给自己涨未读。它决定"谁在等我"，
  // 判错之后人只是在错误的时间切到错误的线程。
  // tier 1：纯归约，一个测试文件逐点杀。
  {
    file: "shared/chat-thread-status.ts",
    tests: ["src/chat-thread-status.test.ts"],
    tier: 1,
  },
  // write-ledger.ts（M4c）：活跃线程的写台账。错法是"该拦的不拦 / 不该拦的乱拦"
  // —— 两种都不抛异常，前者是一次莫名其妙的覆盖，后者会训练人对着弹窗盲点，
  // 闸门也就废了。台账上限丢**最旧的**（丢最新等于把最该拦的先扔掉），
  // 线程退场要连记录一起清（否则已不存在的线程继续拦人）。tier 1。
  {
    file: "electron/chat/write-ledger.ts",
    tests: ["src/chat-conflict.test.ts"],
    tier: 1,
  },
  // thread-registry.ts（M4a）：活线程登记表替掉了 `let live` 单例。这里的错法
  // 全是**静默**的 —— 同 id 覆盖写成并存（get 返回旧会话）、删活跃项后指针
  // 指向已删除对象（chat:latest 返回不存在的线程）、latestOf 跨项目回退
  // （拿别人的线程冒充本项目的）。三种都不抛异常，只让中止/读转录打错人。
  // tier 1：纯内存结构，一个测试文件就能逐点杀。
  {
    file: "electron/chat/thread-registry.ts",
    tests: ["src/thread-registry.test.ts"],
    tier: 1,
  },
  // build-llm.ts 是 Electron 与 headless **共用**的大脑层构造点（工厂唯一），
  // `provider.id === "sensenova"` 决定走多 key×多模型 failover 还是普通单客户端。
  // 反过来 = sensenova 退化成单线路（failover 白设计）、别的 provider 却走
  // failover 构造 —— 两头都不抛异常，只在真出 429 时才表现为"不会换线"。
  { file: "shared/build-llm.ts", tests: ["src/failover.test.ts", "src/llm-pool.test.ts"], tier: 2 },
  // agent-contract.ts 的 `normalizeCapabilities` 是**权限默认值的产地**：
  // 声明里 `roles: []` / `zoneGlobs: []` 会被回填成 `["*"]` / `["**"]` ——
  // 也就是「任意角色、任意 zone」。这里判错 = 一个本该受限的智能体被静默放大成
  // 万能（或反过来被收死），而能力匹配表里看不出异常。tier 2：registry 测试。
  { file: "shared/agent-contract.ts", tests: ["src/agent-registry.test.ts"], tier: 2 },

  // ---- 2026-09-29 第十二批：交付凭据 ----
  // delivery-receipt.ts 是「这次运行到底交付了什么」的**唯一对外结论**，而它的
  // 每一处判定都是静默的：状态判错（跳过报成完成、未落地报成失败）只让凭据
  // 少说一句话，用量投影漏掉 limit 只让"有没有超预算"失去依据，headline 少算
  // 一项计数则让结论读起来比事实乐观。这类"读起来还是一句话"的错误不会有
  // 异常也不会有红 —— 正是变异门禁该盯的形状。tier 1：整份测试 8ms。
  {
    file: "shared/delivery-receipt.ts",
    tests: ["src/delivery-receipt.test.ts", "src/store.test.ts"],
    tier: 1,
  },
  // zone-cost.ts 是「少数派隔离路线」的**对外证据生成器**：越权次数、处置分布、
  // 涉及路径、批次被切了几刀。它的每一处判定错了都不报错，只让数字悄悄偏差 ——
  // 而那份数字是要拿去和 worktree 路线对比的，偏了就是拿错的证据下结论
  // （路径去重漏了 = 越权看起来更频繁；pass 算进"已处置" = 回滚覆盖率虚高；
  // 批次算成 0 段 = 互斥的代价凭空消失）。正该进变异门禁。tier 1：7ms。
  { file: "electron/zone-cost.ts", test: "src/zone-cost.test.ts", tier: 1 },
  // usage-cost.ts 是「成本对账」的对外证据生成器（C4）：凭据份数、未上报边界、
  // 按模型/按项目的聚合排名。与 zone-cost 同一类静默错：排序翻面 = 最贵的线路
  // 看起来最便宜；旧凭据被装作 0 进排名 = 分母边界凭空消失；坏 JSON 被吞 =
  // "这段历史丢了"看起来像"没发生过"。正该进变异门禁。tier 1。
  { file: "electron/usage-cost.ts", test: "src/usage-cost.test.ts", tier: 1 },
  // headless 的常驻服务形态（serve）：路由判据与状态派生全是"错了也不报错"的形状 ——
  // 404 兜底成首页、POST 当 GET 收下、receipt 一到就报"已交付"（崩溃也会留下半截
  // 事件流，只有终态能区分跑完与跑挂）、事件文本不转义（文本来自模型输出 = 不可信
  // 输入）。它同时是"离开工位也能看"这一格的唯一实现，静默错等于没有。
  // tier 1：整份测试 58ms（端口 0 由系统分配，不撞 smoke 的固定端口）。
  { file: "headless/serve.ts", test: "src/headless-serve.test.ts", tier: 1 },
  // mcp.ts 的 handleMcpMessage / callTool 是反向 MCP 的全部判定逻辑（协议分流、
  // 工具分发、响应转述）。判错的形态是静默的：把 409 说成受理、把不可达说成
  // 正常，agent 就会在忙时反复投递、把失败当成成功 —— 全部走注入 HTTP 的
  // 纯函数测试，逐位点审得到。
  { file: "headless/mcp.ts", test: "src/mcp.test.ts", tier: 1 },
  // dev-server.ts 是 dev server 托管检查的判据核心：probeVerdictOf 的状态码
  // 边界（2xx/3xx 算活）与轮询超时预算判错，会让"没起来的页面"被判成验收
  // 通过（或反过来把健康的慢 server 判死）—— 全部可注入，纯函数审计。
  { file: "electron/engine/dev-server.ts", test: "src/dev-server.test.ts", tier: 1 },
  // remote-endpoint.ts 判定"这个桥接在不在本机"。判错方向不报错，只改一句话的
  // 有无 —— 而那句话正是**唯一**提醒"本地越权检测对远端改动失效"的地方：
  // 把远端判成本机 = 担保变成假的（看板显示零越权，其实是没检测到）；
  // 把本机判成远端 = 每次加载都喊狼来了，真出事那句已经被淹没。
  // tier 1：整份测试 6ms。
  { file: "electron/agents/remote-endpoint.ts", test: "src/remote-endpoint.test.ts", tier: 1 },

  // ---- 2026-10-22（M5b）：桌面定时任务 ----
  // 三条入表理由都是同一类"错了不报错"：
  // ① 归一化（`automation.ts`）：写盘尺子与读盘尺子只要分叉一次，合法记录会在
  //    下次启动被判坏 —— 界面上就是"我的自动化凭空少了几条"，没有任何异常；
  // ② 到期/唤醒判定：`nextDelayMs === 0` 的判定一旦放宽成 `<=`，调度环会开始
  //    空转或永远不触发（后者表现为"定时任务从来没跑过"，而进程一切正常）；
  // ③ 调度环（`automation-scheduler.ts`）：记账与重试的组合判错，会把"忙时跳过
  //    不积压"变成 tight loop（每轮事件循环真起一个 run），或把"触发过"记成
  //    "没触发"（下一轮紧接着再跑一遍同一份工作）。
  // 触发器接线（`ipc/automations.ts`）另有一条：三态映射混成一个 false，界面只能
  // 说一句含糊的"没成功"，而"忙"与"没计划"对操作者的处置完全相反。
  { file: "shared/automation.ts", test: "src/automation.test.ts", tier: 1 },
  { file: "electron/automations/automation-store.ts", test: "src/automation-store.test.ts", tier: 1 },
  { file: "electron/automations/automation-scheduler.ts", test: "src/automation-scheduler.test.ts", tier: 1 },
  {
    file: "electron/ipc/automations.ts",
    tests: ["src/ipc-handlers.test.ts", "src/ipc.test.ts"],
    tier: 2,
  },
];

/**
 * 目标对应的测试文件。`tests`（数组）优先于 `test`（单个）。
 *
 * 一个模块被拆成两个测试文件时，只挂一个会让另一半完全没门禁。
 */
function testFilesOf(target) {
  return Array.isArray(target.tests) ? target.tests : [target.test];
}

/**
 * 允许的存活变异数量。
 *
 * 0 = 任何存活都失败。设为 0 的前提是这 6 个模块的测试已经过一轮补齐；
 * 若首次接入时存在大量存活，先记录基线数字再逐步收紧。
 */
const MAX_SURVIVORS = 0;

/**
 * 变异算子。
 *
 * 每个算子两个形态，回答的是**不同的问题**：
 *   - `find` / `to` + `siteMutant`：**逐位点**变异 —— 一次只改一处，
 *     能回答「**这一处**有断言吗」。
 *   - `aggregateMutant`：**聚合**变异 —— 一次改掉全部位点，
 *     只能回答「这些处里**至少有一处**有断言吗」。
 *
 * 只保留**语义明确变化**的替换。像 `> → >=` 这类在边界值上语义相同的
 * （没有等于边界的用例时）容易产生"等价变异"—— 它们存活不代表测试有问题。
 *
 * ⚠️ `find` 一律带 `\b` 或明确边界：`return true` 若不加边界会命中 `return trueX`，
 * 在逐位点口径下会造出一个"改了但语义没变"的假存活。
 */
const OPERATORS = [
  { name: "&& → ||", find: /&&/g, to: "||" },
  { name: "|| → &&", find: /\|\|/g, to: "&&" },
  { name: "=== → !==", find: /===/g, to: "!==" },
  { name: "!== → ===", find: /!==/g, to: "===" },
  { name: "return true → false", find: /\breturn true\b/g, to: "return false" },
  { name: "return false → true", find: /\breturn false\b/g, to: "return true" },
  { name: "继续(continue) → 中断(break)", find: /\bcontinue;/g, to: "break;" },
  /**
   * 三元分支互换：`cond ? A : B` → `cond ? B : A`。
   *
   * 为什么加它：本项目大量「回退 / 默认值」逻辑正是这个形状
   * （`caps.roles.length > 0 ? [...caps.roles] : [...LEGACY]`、
   * `id === "sensenova" ? SENSENOVA_MODELS : [provider.defaultModel]`），
   * 而上面 7 个算子**一个都覆盖不到** —— 这些判定此前从未被变异验证过。
   *
    * 它不是正则能表达的（三元会嵌套），所以走 `swap` 通道：位点由
    * `findTernarySites` 扫描给出，变异体交换 A/B 两段。
    *
    * 2026-09-28 评估收官：首次全量评估 56 处存活（875/931），分四批清零后
    * `--ops=ternary --mode=site --limit=999` 达 **881/881 逐位点全杀**，
    * 从 `extra`（评估中）转正为默认算子。保留 `--ops=ternary` 兼容旧调用。
    */
   { name: "三元分支互换", swap: true },
   /**
    * `?? → ||`：两者的差别只在 falsy（`0` / `""` / `false`）上 ——
    * 而"0 与留空是不是一回事"恰恰是配置类字段最容易搞错的地方
    * （`executorTimeoutMs` 那类口径讨论就是它）。默认同样不启用。
   */
  { name: "?? → ||", find: /\?\?/g, to: "||", extra: true, optName: "nullish" },
];

/**
 * 三元位点扫描。`cond ? A : B` 的三个边界都要给出，变异体才能交换 A/B。
 *
 * 用**栈**而不是正则：三元右结合且会嵌套（`a ? b : c ? d : e`），
 * 正则会把第一个 `?` 与第一个 `:` 错配，生成的代码语法就错了 —— 编译失败在本
 * 门禁里算"杀死"，那是**假阳性**（不是断言敏感，是变异体自己写坏了）。
 */
function findTernarySites(text) {
  const stack = [];
  const sites = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      continue;
    }
    if (c === "?") {
      // `??` / `?.` / TS 可选属性 `x?: T` 都不是三元
      if (text[i - 1] === "?" || text[i + 1] === "?" || text[i + 1] === "." || text[i + 1] === ":") continue;
      // TS 可选方法 `capabilities?(): AgentCapabilities` —— `?` 紧跟标识符，
      // 那个 `:` 是**返回类型**，交换它会生成语法错的变异体（假阳性"杀死"）。
      if (/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) continue;
      stack.push({ at: i, depth });
      continue;
    }
    if (c === ":" && stack.length > 0 && stack[stack.length - 1].depth === depth) {
      const q = stack.pop();
      const bEnd = ternaryBranchEnd(text, i + 1);
      sites.push({ index: q.at, end: bEnd, aStart: q.at + 1, aEnd: i, bStart: i + 1, bEnd });
    }
  }
  return sites;
}

/** B 分支的结束：回到深度 0 后遇到 `,` / `;` / `)` / `]` / `}` / 换行即止。 */
function ternaryBranchEnd(text, from) {
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return j;
      depth -= 1;
    } else if (depth === 0 && (c === "," || c === ";" || c === "\n")) return j;
  }
  return text.length;
}

/** 三元分支互换：把 `? A :` 与 B 整段对调。 */
function swapBranches(source, site) {
  const a = source.slice(site.aStart, site.aEnd);
  const b = source.slice(site.bStart, site.bEnd);
  return source.slice(0, site.aStart) + b + source.slice(site.aEnd, site.bStart) + a + source.slice(site.bEnd);
}

/** 聚合变异体：一次改掉该算子的**全部**位点。`replace` 带 /g 会重置 lastIndex，可复用。 */
function aggregateMutant(source, op) {
  if (op.swap) {
    // 从后往前改，前面的索引才不会漂移。
    let out = source;
    const sites = findTernarySites(out);
    for (let i = sites.length - 1; i >= 0; i--) out = swapBranches(out, sites[i]);
    return out;
  }
  return source.replace(op.find, op.to);
}

/** 逐位点变异体：只改 `site` 指出的那一处，其余原样。 */
function siteMutant(source, site, op) {
  if (op.swap) return swapBranches(source, site);
  return source.slice(0, site.index) + op.to + source.slice(site.end);
}

/**
 * 等价变异排除名单：这些位点替换后**语义不变**，存活不代表测试有缺口。
 * 格式：`{ file, op, line }`，line 为源文件 1-based 行号。
 *
 * - `electron/engine/router.ts:193` `&& → ||`：该 `&&` 门控的 tie-break 只在
 *   「两边 legacy 标记不同」时才有实际效果；换成 `||` 后分支会对
 *   legacy-legacy 对提前返回，但 declared 候选在任何情况下都 pairwise 压过
 *   legacy 候选，最终 winner 的 agentId/score/reason 均不变 —— 在公开 API
 *   （RoutingDecision / onDecision）上不可观察，属于等价变异。
 *
 * ⚠️ 行号是锚点：router.ts 该行如果移动，变异会重新出现并让门禁变红 ——
 * 那是故意的（fail-safe），届时重新评估是否仍是等价位点。
 */
/**
 * 逐位点审计基线：`文件 → 该文件当前的可执行代码位点数`。
 *
 * ## 它解决什么
 *
 * `--mode=site` 下"全部 N 处位点已逐点验证"这句话，**只有在 N 与上一次审计
 * 时一致时才有意义**。代码改了、位点从 18 变成 20，而没人重跑审计 —— 门禁会
 * 对着 18 个位点说"18/18 全杀"，新加的那 2 处从未被单独验证过。
 *
 * 文件头从 2026-09 就承诺"位点数与 SITE_BASELINE 不符 → exit 1"，但这个常量
 * 一直**只存在于注释里**（2026-10-05 全量测试核实：全仓 4 处提及全是注释）——
 * 假承诺比没有承诺更糟，因为它让人以为这条防线在。
 * 2026-10-05 把它实现成**真判据**（site 口径逐目标比 `SITE_BASELINE`，基线缺键也算漂移）；
 * 2026-10-06 又用 `npm run mutation:baseline`（不跑变异，约 1s）把同一件事提进 verify 的静态块，
 * 于是漂移在本机链首就现形，而不是等 CI 那 28 分钟的 mutation-full。
 *
 * ## 怎么用
 *
 * - 漂移 → `--mode=site` 判 FAIL，打印基线值与当前值；
 * - 跑 `npm run mutation:audit` 确认新位点也全杀之后，
 *   `node scripts/site-baseline.mjs --write` 更新本常量并提交。
 *
 * ⚠️ 基线**只加不减**：位点变少通常是重构或等价变异收口，是好事，自动接受。
 * 位点变多才是"有人加了新逻辑而没人验证"，必须停。
 *
 * ⚠️ aggregate 口径**不查**基线（它本来就不逐点验证，查它没有意义）；
 * 只有 site 口径查 —— 这也正是基线存在的理由。
 */
const SITE_BASELINE = {
  "electron/agents/cli-agent.ts": 21,
  "electron/agents/cli-detect.ts": 4,
  "electron/agents/http-bridge.ts": 39,
  "electron/agents/index.ts": 10,
  "electron/agents/manifest-loader.ts": 24,
  "electron/agents/manifest-schema.ts": 74,
  "electron/agents/registry.ts": 25,
  "electron/agents/remote-endpoint.ts": 3,
  "electron/agents/run-session.ts": 7,
  "electron/agents/scoped-env.ts": 5,
  "electron/agents/sensenova-api.ts": 41,
  "electron/atomic-file.ts": 2,
  "electron/audit-log.ts": 20,
  "electron/automations/automation-scheduler.ts": 6,
  "electron/automations/automation-store.ts": 18,
  "electron/board-derive.ts": 40,
  "electron/chat/runtime.ts": 17,
  "electron/chat/session-store.ts": 38,
  "electron/chat/session.ts": 47,
  "electron/chat/thread-registry.ts": 12,
  "electron/chat/tool-runner.ts": 86,
  "electron/chat/write-ledger.ts": 3,
  "electron/context/github-readonly.ts": 65,
  "electron/engine/batch-guard.ts": 19,
  "electron/engine/conventions.ts": 2,
  "electron/engine/dev-server.ts": 5,
  "electron/engine/git-export.ts": 44,
  "electron/engine/git-remote.ts": 39,
  "electron/engine/orchestrator.ts": 91,
  "electron/engine/router.ts": 25,
  "electron/engine/scheduler.ts": 64,
  "electron/engine/skills.ts": 6,
  "electron/engine/verifier.ts": 32,
  "electron/engine/zone-guard.ts": 6,
  "electron/ipc/agents.ts": 42,
  "electron/ipc/automations.ts": 14,
  "electron/ipc/chat.ts": 140,
  "electron/ipc/context.ts": 32,
  "electron/ipc/delivery.ts": 15,
  "electron/ipc/github.ts": 22,
  "electron/ipc/orchestration.ts": 34,
  "electron/ipc/projects.ts": 12,
  "electron/ipc/receipt.ts": 4,
  "electron/keys-store.ts": 21,
  "electron/main.ts": 7,
  "electron/mcp/client.ts": 44,
  "electron/mcp/manifest.ts": 13,
  "electron/mcp/pool.ts": 9,
  "electron/notify-rules.ts": 17,
  "electron/platform.ts": 47,
  "electron/preview-manager.ts": 12,
  "electron/preview-window.ts": 9,
  "electron/sandbox/action-gate.ts": 13,
  "electron/sandbox/approval-gate.ts": 3,
  "electron/sandbox/circuit-breaker.ts": 26,
  "electron/sandbox/command-policy.ts": 15,
  "electron/sandbox/file-journal.ts": 18,
  "electron/sandbox/kill-tree.ts": 11,
  "electron/sandbox/loop-detector.ts": 5,
  "electron/sandbox/path-policy.ts": 48,
  "electron/sandbox/policy-dir.ts": 5,
  "electron/sandbox/snapshot-store.ts": 33,
  "electron/sandbox/spawn-plan.ts": 8,
  "electron/sandbox/timeout-gate.ts": 3,
  "electron/store.ts": 8,
  "electron/usage-cost.ts": 17,
  "electron/zone-cost.ts": 9,
  "headless/mcp-main.ts": 10,
  "headless/mcp.ts": 78,
  "headless/protocol.ts": 123,
  "headless/receipt-verify-main.ts": 8,
  "headless/run-spec.ts": 33,
  "headless/serve-main.ts": 47,
  "headless/serve.ts": 73,
  "shared/agent-contract.ts": 5,
  "shared/automation.ts": 47,
  "shared/build-llm.ts": 12,
  "shared/chat-changes.ts": 13,
  "shared/chat-compress.ts": 14,
  "shared/chat-conflict.ts": 12,
  "shared/chat-events.ts": 16,
  "shared/chat-thread-status.ts": 13,
  "shared/cli-detect.ts": 5,
  "shared/deliverable-format.ts": 23,
  "shared/delivery-guide.ts": 31,
  "shared/delivery-receipt.ts": 44,
  "shared/github-issue.ts": 1,
  "shared/glob.ts": 25,
  "shared/graph.ts": 8,
  "shared/http-clients.ts": 137,
  "shared/llm-client.ts": 15,
  "shared/mcp.ts": 101,
  "shared/page-smoke.ts": 17,
  "shared/plan-facts.ts": 12,
  "shared/plan-history.ts": 12,
  "shared/plan-memo.ts": 9,
  "shared/policy-file.ts": 43,
  "shared/preview-isolation.ts": 1,
  "shared/project-config.ts": 16,
  "shared/project-conventions.ts": 2,
  "shared/prompt-text.ts": 1,
  "shared/prompts.ts": 10,
  "shared/providers.ts": 7,
  "shared/redact.ts": 1,
  "shared/routing.ts": 9,
  "shared/schedule-core.ts": 21,
  "shared/schema.ts": 77,
  "shared/skills.ts": 38,
  "shared/sse.ts": 51,
  "shared/text-diff.ts": 38,
  "shared/tools/patch.ts": 49,
  "shared/tools/policy.ts": 22,
  "shared/tools/protocol.ts": 35,
  "shared/tools/spec.ts": 27,
  "shared/types.ts": 8,
  "shared/usage-meter.ts": 19,
  "shared/zone-coverage.ts": 36,
  "src/attention.ts": 10,
  "src/store.ts": 99,
};

/**
 * 等价变异白名单。
 *
 * 每条附理由与行号锚点；行号移动会让变异重新出现并让门禁变红 —— 那是故意的
 * （fail-safe），届时重新评估是否仍是等价位点。
 */
const EQUIVALENT_SITES = [
  /*
   * 2026-10-23：表里 16 条**永远匹配不上任何位点**的死条目已删除（锚点漂移留下
   * 的）：serve 482、scheduler 346/352（各两条）、http-bridge 315、sensenova-api
   * 397/403、orchestration 267、run-spec 286/288/290、store 247、platform 288、
   * ipc/chat 197/402。删是**行为中性**的（它们本就豁免不到任何东西），但这张表
   * 的老问题不在删不删：漂移之后它既没红也没提示，于是"这块有等价锚点"成了错觉
   * —— 2026-10-23 一天内因此红了两轮 CI（context.ts 221→225、path-policy.ts
   * 92→94，后者直接拦住发布，靠 CI 注解才定位到）。
   *
   * 同日起 `mutation:baseline`（`site-baseline.mjs`）对**每一条**条目做存活检查：
   * 必须能在目标文件里找到 `(算子, 行号)` 完全对得上的真实位点，对不上即红。
   * 于是这张表只可能包含"确实还在原位"的条目；下一个人遇到漂移，当场就知道是哪
   * 一条、该校回哪一行，不必再等一轮 50 分钟的分片审计。
   *
   * ⚠️ 下面仍留着若干条只为**历史文献**的注释（讲的是某个位点当初为什么等价），
   * 对应的条目若已随上述清理删除，重新登记时可直接复用那套论证。
   */
  /**
   * `electron/sandbox/kill-tree.ts:37` 的 `&& → ||` —— **可证明等价**（一级）。
   *
   * 37 行是 win32 分支 post-grace double-check 的守卫
   * `if (child.exitCode === null && child.signalCode === null) portableKill(child, 0)`。
   * 2026-09-23 跨平台轮给 `portableKill` 开头补了 `if (hasExited(child)) return`
   * 预检查（修 POSIX 直接路径的 pid 复用误杀，CI ubuntu 首跑抓到的真缺口）——
   * 此后这个 `&&` 变 `||` 就是纯等价：变异把条件从 `!hasExited` 放宽成它的
   * 任意超集，而超集里多出来的部分（至少一个退出标志非 null）必然被
   * portableKill 的预检查拦下，**对 child.kill 的调用次数恒等**。
   *
   * 37 行的条件因此成了防御冗余 —— 但**刻意保留**：它是 win32 路径的
   * belt-and-braces（taskkill 报成功后的补刀守卫，36 行注释言明），与
   * portableKill 的预检查是两层独立防线，去掉任何一层都让"已退出误杀"防护
   * 只剩单点。等价变异白名单在这里的语义正是"防御冗余，有意保留"。
   *
   * ⚠️ 行号是锚点：kill-tree.ts 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认双层防线仍在。
   */
  { file: "electron/sandbox/kill-tree.ts", op: "&& → ||", line: 37 },
  /**
   * `electron/sandbox/path-policy.ts:92` 的 `parent === cur` → `!==`
   * —— **POSIX 域可证明不可达**（一级）。
   *
   * 92 行在 `resolveExistingReal` 的上溯循环 catch 里：realpath(cur) 抛错后
   * 取 parent，若 `parent === cur`（cur 已是 fs 根）则词法返回 target。
   * 它可达的前提是 **realpath(fs-root) 本身抛错** ——
   *   POSIX：`/` 恒可解析，不存在"根不可达"的输入，分支事实不可达；
   *   Windows：仅当盘符不存在（realpath("Q:\\") → ENOENT）才进入，
   *   本地 Windows 实测该场景可杀此位点（故 Windows 基线 33/33）。
   *
   * CI ubuntu 首跑暴露此存活（Linux 上 27/27 全绿），诊断输出
   * （diff + 变异下通过报告）确认变异体在 POSIX 上从未被执行 ——
   * 平台相关等价的又一实锤，与 workflow 注释里"两个 OS 合起来才是全集"
   * 的设计互为印证。
   *
   * ⚠️ 2026-10-23 更正上面那句"无漂移风险"：P0 交互式会话那一笔在
   * `path-policy.ts` 里加了 2 行（macOS 分支注释），92 → 94，位点重新进入分母
   * 并在 **CI 的 tier1 分片**上存活（win32 本机有盘符不存在的用例会杀掉它，
   * 所以本地全绿 —— 这正是"两个 OS 合起来才是全集"的反面教材）。
   * 同一轮还发现表里另有 12 条更早留下的漂移锚点（scheduler 346/352、
   * http-bridge 315、sensenova-api 397/403、store 247、ipc/chat 197/402、
   * serve 482、run-spec 286/288/290 …）：它们指向的行早已没有对应算子，
   * 属于**死条目**（不影响判定，因为 live 位点若没人杀会以存活形式自己红，
   * 本条的 94 就是这么暴露的）。彻底清理要求逐个确认"这条原本豁免哪一处"，
   * 留作下一轮的表维护；本轮只校回正在拦路的那一条。
   */
  { file: "electron/sandbox/path-policy.ts", op: "=== → !==", line: 94 },
  /**
   * `electron/engine/router.ts` tie-break 排序里的
   * `if (anyDeclared && a.descriptor.inferredLegacy !== b.descriptor.inferredLegacy)`
   * 的 `&& → ||` —— **可证明等价**（一级）。
   *
   * 记条件为 `A && X`，其中 `X = (两候选的 inferredLegacy 不同)`。X 为真要求
   * 一真一假 → 池中**必然存在声明候选** → `anyDeclared`（`scored.some(非 legacy)`）
   * 恒为真。由 `X ⇒ A` 得 `A && X ≡ X ≡ A || X` —— 放宽成 `||` 后多出的
   * 情况（A 真 X 假）里 tie-break 块内部的两个 if 都不成立，整块空转。
   * 行为逐输入恒等。
   *
   * ⚠️ 行号是锚点：router.ts 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认上面的蕴含关系仍成立。
   *
   * 2026-09-27：并发准入轮在评分循环里插入 28 行（满载 continue + 全满载
   * 不回落分支）→ 193 → 221。
   * 2026-10-14：taskFailures 评分块（+7 行）插入在 priority 之后 → 221 → 244。
   * 蕴含关系重核：X 为真 ⇒ 池中有声明候选 ⇒ A 恒真，不变。
   */
  { file: "electron/engine/router.ts", op: "&& → ||", line: 244 },
  /**
   * `electron/sandbox/snapshot-store.ts:402`（`archivedFilePath` 的路径校验）
   * 两处 `|| → &&` —— **可证明等价**（2026-10-17，B1 第二半落地时 site 审计抓出）。
   *
   * 记条件为 `E || D || A`（E = rel 为空，D = 以上级目录开头，A = 绝对路径）。
   * 这一行是**第一道**；紧接着的
   *   `const file = path.resolve(path.join(dir, rel)); if (!file.startsWith(dir + path.sep)) return null;`
   * 是**第二道**，而两者的失败返回值同为 `null`（本函数只返回 `string | null`，
   * 不返回原因，调用方 `readArchived` / `hasBackupFor` 都只看见 null）。
   * 于是"第一道放行了非法 rel"在行为上不可观测：任何越界的 rel 都会在
   * `resolve` 前缀检查处得到同一个 null。逐输入核过三种形态：
   *   - rel = ""：`path.resolve(join(dir, ""))` = dir，`dir.startsWith(dir + sep)` 为假 ⇒ null；
   *   - rel = ".." / "../x"：resolve 到 archive/ 之上或 dir 之外 ⇒ null；
   *   - rel = "C:/x"：win32 下 `path.join` 把盘符段当普通段拼在 dir 下，仍在 dir 内 ⇒ 只是查不到文件 ⇒ null。
   * 第一道换 `&&` 后每一支的返回值都不变。
   *
   * ⚠️ 行号是锚点：本函数结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认上面的"第二道兜住"仍成立。
   * 反向说明为什么 `restoreArchived` 的同类判据**不**进白名单：那边两道防护
   * 的 reason 措辞不同（`拒绝绝对路径与上级目录` / `备份路径越出存档目录`），
   * 第一道放行是**可观测**的（reason 变了），所以测试能杀，不该豁免。
   */
  { file: "electron/sandbox/snapshot-store.ts", op: "|| → &&", line: 402 },
  /**
   * `headless/serve.ts` 控制面里 `if (!busy && !engine)`
   * 的 `&& → ||` —— **可证明等价**（2026-10-05 反向注入时发现）。
   *
   * 记条件为 `!B && !E`（B = busy，E = engine 已挂上）。变异后是 `!B || !E`，
   * 两者不同的输入只有 `B=0, E=0`（`!B&&!E` 为真、`!B||!E` 也为真 —— 同）；
   * 真正需要比的是 `B=1, E=0`：`!B&&!E` 假（不进 409 那段），
   * `!B||!E` **真**（会进 409）。所以只要能证明 `B=1 ∧ E=0` 不可达或等价即可。
   *
   * 逐个赋值点核对（`serve.ts`：busy 仅在 418 置 true、427 置回 false；
   * engine 仅在 423 赋值、428 清空）：
   *   · B=1 期间：run 已接受但引擎还没挂上 → 走下面那个 `if (!engine)` 分支。
   *     两个分支在这一刻**都是 409**（或 cancel 都是 cancelWithoutEngine → 200），
   *     `cancelWithoutEngine` 的响应不读 busy。
   *   · 换句话说：唯一能区分两种写法的时刻是 B=1 ∧ E=0，而那一刻两种写法
   *     都落到 `if (!engine)` 那一支 —— 只是快慢差别，不是行为差别。
   *
   * 实测佐证（2026-10-05）：从来没跑过 run（B=0,E=0）→ 409；跑完一个 run 之后
   * （B=0,E=0）→ 409；run 在跑而引擎未挂上（B=1,E=0）→ 200。三态都对。
   *
   * ⚠️ 行号是锚点：serve.ts 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并**重新核对 busy 与 engine 的赋值顺序**（若将来 engine
   * 改为在 busy 之前清空，或 busy 在别处置 true，这个等价就不再成立）。
   */
  /**
   * `electron/engine/scheduler.ts` `admitConcurrency` 满载改派循环里的
   * `if (!d || d.inferredLegacy) return true;` —— **架构上不可达**（防御分支）。
   *
   * 两个半边都到不了：
   * 1. `!d`（registry 缺席者）—— spare 遍历的 available 列表来自 registry 注册
   *    结果（planPool 按注册表过滤），registry 缺席的适配器根本不进 available
   *    （src/scheduler.test.ts「registry 是准入事实来源」用例实证：ghost 塞进
   *    构造列表也轮不到 spare）。
   * 2. `d.inferredLegacy`（legacy 改派目标）—— router 评分带 inflight 惩罚：
   *    声明 agent 一满载，router 下一轮就把任务导向 legacy 候选（candidates 里
   *    legacy 恒匹配），任务在 346 行 `return wanted` 就被放行 —— spare 循环
   *    只在 router 推荐了满载者时才执行，而 legacy 在候选里时 router 的惩罚
   *    总在 spare 之前消化掉流量。探针实证：变异体下 dispatched 与原版逐位一致。
   *
   * 2026-09-29 touched 审计（本次 actionGate 接线触及 scheduler.ts）暴露。
   * **刻意保留**：registry 过滤或 router 评分若将来变化，这里是第二道闸。
   * ⚠️ 行号是锚点：scheduler.ts 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认上面的不可达论证仍成立。
   */
  /**
   * `electron/sandbox/spawn-plan.ts:96` `return false → true`（`isFile` 的 catch）。
   *
   * 该分支只在「`fs.existsSync(p)` 为真、紧接着 `fs.statSync(p)` 抛错」时可达 ——
   * 两次系统调用之间文件消失，典型 TOCTOU 竞态。它在测试里**无法构造**：
   * Windows 与 Linux 上都不存在"exists 为真但 stat 必抛"的稳定路径
   * （悬空符号链接会让 exists 直接返回 false，权限错误会让 exists 也返回 false）。
   *
   * 判定为等价的理由**不是"这个分支不重要"**，而是**"活不到能测的那一步"**：
   * `return false` 是安全方向（"不是可执行文件"，于是继续找下一个候选），
   * 改成 `return true` 只在竞态窗口内会误判。
   *
   * ⚠️ 若将来给 `spawn-plan` 加上 fs 注入点（同 `zone-guard` / `snapshot-store`
   * 的 `FsLike` 模式），**应删掉这条白名单**并补一条注入用例 ——
   * 那时的正确做法是让分支可测，而不是继续白名单。
   */
  { file: "electron/sandbox/spawn-plan.ts", op: "return false → true", line: 96 },
  /**
   * `electron/agents/http-bridge.ts:309` `if (settled === "timeout")` 的 `=== → !==`。
   *
   * **可证明的等价**（不是"测不出来"）：
   * 该条件是 `drain()` 里 `Promise.race([Promise.all(pending), timeout])` 的结果。
   * 走到 `drained` 一侧 ⟹ **每个 run 的 `done` 都已 resolve**；
   * 而 `markTerminal` 是先置 `run.session.finished = true` **再** `resolveDone()`，
   * 所以 done 已 resolve ⟹ `session.finished` 已为真。
   * 而 `abort(handle)` 的第一行就是 `if (!run || run.session.finished) return;` ——
   * 于是改 `!==` 后新增的那圈 abort 循环**每个都当场返回**，不产生任何请求。
   *
   * 已验证：`http-bridge.test.ts` 的「宽限期内成功收敛时不得中止任何 run」
   * 断言 drained 路径不发任何 /abort 请求 —— 该用例在两种写法下都通过，
   * 正说明差别不可观测。保留该用例（它仍是对 drained 路径的有效断言）。
   */
  // 锚点 309 → 315（2026-10-10 校准）：本文件在它之前多了 6 行（`probeTimeoutMs`
  // 选项 + 两处"为什么这么写"的注释），行号整体后移。**位点数未变**（1369 无漂移），
  // 漂的只是锚点 —— 这正是"行号是锚点"的 fail-safe：宁可重现让人重看一遍。
  /**
   * `electron/agents/sensenova-api.ts` 里 `readSnapshotContents` 的那行
   * `if (isSecretLikeFile(rel)) continue;` 的 `continue → break` —— **可证明不可达**（一级）。
   *
   * 这一行自称"二次防线：即使上层 walk 漏过某个凭据文件，这里也不读它的正文"。
   * 但 `statEntries` **只在同一个方法里的 `walkStat` 中被 push**，而那次 walk 在
   * push 之前用**同一个纯函数 `isSecretLikeFile`** 对**同一个 `rel`** 已经过滤过一次 ——
   * 所以进得了 `statEntries` 的条目必然不满足该谓词，这行永远不执行。
   *
   * 换句话说它是**防御性冗余**，注释里承诺的"二次防线"在当前结构下不成立。
   * 保留它没有坏处（万一将来多出别的 statEntries 来源），但门禁不该为一条
   * 不可达分支永远挂红 —— 故白名单，并把"为什么不可达"写在这里备查。
   *
   * 2026-09-23：usage 可见性轮在上方插入 14 行（meter 接线），行号 317 → 331，
   * 白名单曾因行号失配短暂失效、被全量 audit 抓到存活 —— 处置即校回行号。
   * 2026-09-24：快照跳过清单改接 file-journal 的共享表，上方插入 6 行 → 331 → 337。
   * 2026-09-25：中止守卫轮在 `dispatch` 里插入 9 行 → 337 → 346。
   * 同日「被沙箱拒绝要进终态」轮又在该方法里加 2 行注释 → 346 → 348。
   *   （这一轮起把描述改成**按构造点名**而不是"307 行/304 行"：锚点行号是机器判的，
   *    而散文里的行号没人判，上一轮就是这么漂掉两处还留着旧坐标。）
   * 两层防御仍在：walkStat 用**同一个** `isSecretLikeFile` 在同一个 rel 上先过滤过一次。
 * 2026-09-25（同日第二轮）：内置执行器 run 时限轮在上方插入 35 行 → 348 → 383。
 * 同日第三轮：取消下传在途请求，`run()` 的看门狗回调与 `chatFiles` 各加 1 行 → 383 → 385。
 * 2026-09-27：executorTimeoutMs 轮在上方插入 12 行（适配器 timeoutMs 选项/字段/构造归一）
 *   → 385 → 397。
 */
  /**
   * `readSnapshotContents` 中读文件失败的 `catch { continue; }` —— 二级。
   *
   * 要触发它需要「walk 阶段 statSync 成功、内容阶段 readFileSync 失败」——
   * 即两次系统调用之间文件被删（TOCTOU）。测试里构造不出确定性的触发：
   * walk 与 read 在同一个方法调用里紧邻（`readSnapshot` 直接调
   * `readSnapshotContents`），没有任何可插桩的间隙；
   * Windows 上也没有"可写但不可读"的稳定文件状态。
   *
   * ⚠️ 二级判定（经验性，不是证明）。若将来给该模块加 fs 注入点
   * （同 `zone-guard` / `snapshot-store` 的 `FsLike` 模式），
   * **应删掉这条白名单**并补一条注入用例 —— 那时正确做法是让分支可测。
   *
   * 2026-09-23：同上，usage 轮行号漂移 323 → 337，audit 抓到后校回。
   * 2026-09-24：快照跳过清单轮再下移 6 行 → 343；TOCTOU 在测试里仍构造不出。
 * 2026-09-25：中止守卫轮在其上方插入 9 行 → 343 → 352；
 * 同日「被沙箱拒绝要进终态」轮再加 2 行 → 352 → 354。
 * 2026-09-25（同日第二轮）：内置执行器 run 时限轮在上方插入 35 行 → 354 → 389。
 * 同日第三轮：取消下传在途请求，上方又各加 1 行 → 389 → 391。
 * 2026-09-27：executorTimeoutMs 轮同上（上方插入 12 行）→ 391 → 403。
 */
  /**
   * `shared/chat-compress.ts:62` 的 `return false → true` —— **可证明不可达**（一级）。
   *
   * 62 行是 `isSafeCut` 的头部守卫 `if (index <= 0) return false;`（index 指不到
   * 一条真实前置消息时不算安全切点）。唯一的调用点在 `planCompaction`：cut 初值是
   * `messages.length - 1`，循环下界守到 1，其后的对齐循环只增不减 —— 传进来的
   * index 恒落在 `[1, length-1]`，于是这个守卫的结论永远是 false 分支。
   *
   * 防御冗余，刻意保留：`isSafeCut` 是纯函数导出，将来若被别处的切点计算直接
   * 调用（那时 index 由外部给出，可能是 0），这一行是唯一拦住"下标 −1"的地方。
   * 删掉它会让"切点有效"这件事只剩调用侧的隐式约定。
   *
   * ⚠️ 行号锚点：该文件结构变化（改动 62 行以上）会让此位点重新暴露为存活，
   * 那时按新行号校回并再次确认调用点区间没有放宽 —— 这是 fail-safe 的方向。
   */
  { file: "shared/chat-compress.ts", op: "return false → true", line: 62 },
  /**
   * `electron/ipc/context.ts:177` 的 `settingsValue.agentRouter !== false` → `=== false`
   * —— **可证明等价**（一级）。
   *
   * 那一行只把取值拼进一个**仅用于相等比较**的缓存键：
   *   `const signature = \`router=${settingsValue.agentRouter !== false};arbitration=…\``
   * 下游只有 `if (agentLayer && layerSignature === signature)` 一处比较。
   *
   * 取反是 {true,false} 上的**双射**，因此"两组 settings 是否产生同一个键"
   * 这一等价关系完全不变 —— 缓存命中的边界一模一样，行为不可能有差异。
   *（同一行里的 `arbitration` 分量同理。）
   *
   * ⚠️ 注意区别：**同一表达式在 216 行是承重的**（那里它直接决定 enableRouter），
   * 所以 216 行必须是真断言、不能一起白名单。这正是"同一写法在不同位置
   * 语义不同"的例子 —— 判等价要按**使用点**判，不能按表达式形状判。
   *
   * 2026-09-27：executorTimeoutMs 轮在函数体开头插入 5 行（缓存 signature 说明注释
   *   4 行 + `executorTimeoutMsFor` 取值 1 行）→ 177 → 182。等价性论证不变：
   *   追加的 `;executorTimeoutMs=${…}` 分量与被取反的布尔分量各自独立，取反仍双射。
 * 2026-09-29：delivery-receipt 轮再 +1 行 → 182 → 183。论证不变；本轮教训是
 *   touched 口径抓住了全量 audit 间隔期的漂移（漂移窗口从"两次全量之间"缩短到
 *   "每批提交之间"）—— 改完 TARGETS 内文件必须顺手核对行号锚点。
 * 2026-09-30：P1-5 桌面三字段轮在 signature 上方插入 4 行（manifestDir/snapshotRoot
 *   取值 2 行 + 注释 2 行）→ 183 → 187。论证不变；同日独立推演曾试图用 A/B/A
 *   序列杀死它（值互换下 A→B→A 的第三次调用会命中第一次的键），但推演结论是
 *   杀不死 —— 双射下键与输入的绑定方向不可观察，缓存命中边界恒等，与上面的
 *   等价性论证互为印证。
 * 2026-10-23：M3c/M4b/P0 三轮在 context.ts 里净增 9 行 → 221 → 225。这一漂移
 *   是 **CI 的 tier2 分片抓出来的**（`mutation:touched` 只看最后一笔，看不到更早
 *   几笔的位移；漂移让位点重新进入分母并存活）。同时把此前为同一处重复登记过的
 *   两条陈旧锚点（187 / 222）一并折进这里 —— 历史上每次都"新增一条"而不是校回
 *   旧条目，于是表里躺着两条永远匹配不上的死条目，而真正的位点在 225 上无人认领。
 *   处置沿用本仓纪律：**校回行号 + 保留论证，不删表**（折掉的三条是同一位点）。
 */
  { file: "electron/ipc/context.ts", op: "!== → ===", line: 225 },
  /*
   * 2026-10-02 P2-3 审批 UI 面轮白名单（三条，各自论证）：
   * 1. `electron/ipc/context.ts:208` `agentRouter !== false` —— 层签名的
   *    router 分量（与 187 同文件同型）。取反只改缓存签名的一个比特：签名内容
   *    决定的是 layer 何时重建（缓存失效粒度），不是行为正确性 —— 双射下
   *    agentRouter 真假与签名比特的绑定方向不可观察，缓存命中边界恒等。
   * 2. `electron/ipc/orchestration.ts:265` approval-decide handler 的
   *    `return true`（`true → false`）。throw 路径（无 pending 的 requestId）
   *    由 ipc.test.ts 的 ghost 用例钉住；正常路径的返回值渲染端**不消费**
   *    （store 的 resolveApproval 只 await，不看结果）—— 变异只改 IPC 返回值，
   *    无可观察差异，与 escalation-decide 同构。
   * 3. `headless/run-spec.ts:286` `io.requestApproval ? {...} : {}` 三元 ——
   *    headless 形态未装配 policyDir（approvalCommands 恒空），ApprovalGate
   *    根本不建，host.requestApproval 有/无不可观察；serve 未来支持 policy.d
   *    时此位点随装配链一起验收（P2-2 的 headless 侧缺口，非本轮范围）。
   * 4. `src/store.ts:247` resolveApproval 的 `before` 抓取 `===` —— 回滚总是
   *    恢复到 resolved:false 的对象（before 是乐观 set 前抓的原始版本，与
   *    变异后 fallback 的 `a` 同值同形），zustand 浅合并下对象引用不可观察，
   *    变异无可观察差异。
   * 2026-10-03：P1-3 上下文回溯闭环在 `context.ts` 顶部插入 1 行 import
   *   （`taskTrail, trailBriefForRepair`）→ 208 → 209。论证不变；行号锚点的
   *   fail-safe 正常生效（漂移即自动暴露，不静默放过）。
   */
  /* 2026-10-13 校回：logLine 脱敏注释（+3 行）→ 209 → 212，锚点漂移在逐位点
   * 审计里以"存活"形式重新暴露（fail-safe 又立功）。187 的同型位点（第二处
   * 签名行）已在此前的装配收敛中消失，条目保留作历史锚；现存的
   * enableRouter: … !== false（216/274）是真行为、被用例杀死，不入表。 */
  /* 2026-10-17 再校回：通知接线在 context.ts 顶部加 1 行 import、send() 内加
   * 7 行 → 212 → 221。论证不变；fail-safe 再次以"存活"形式暴露漂移。
   * 187 的同型位点（第二处签名行）已在此前的装配收敛中消失，条目保留作历史
   * 锚；现存的 enableRouter: … !== false（225/283）是真行为、被用例杀死，不入表。
   * 2026-10-23：这一条已并入上方 `context.ts` 的 225 锚点（同一位点，不再重复登记）。 */
  /*
   * 2026-10-03 竞品吸收轮白名单（三条，同一论证）：
   * `electron/platform.ts:288` / `headless/run-spec.ts:288,290` 的
   * `...(host/io.X ? { X } : {})` 装配三元 —— 取反（有 X 时不接、无 X 时接
   * `{ X: undefined }`）只改变对象里**是否存在**这个键，而消费方
   * （platform → layer.schedulerOptions → Scheduler.opts、ApprovalGate 构造、
   * host 转发）全部只看值：`undefined` 与缺席在 `?.` / 展开 / 构造里的行为
   * 恒等。与上方 context.ts 签名位点同一论证：布尔分量取反 → 装配键有无 →
   * 双射不可观察。
   */
  /**
   * `electron/engine/scheduler.ts` `admitConcurrency` 的 spare 查找里
   * `if (!d || d.inferredLegacy) return true;` 的两个变异 —— **防御性冗余，
   * 生产装配不可达**。
   *
   * 该分支只在「spare 查找遍历到 legacy 或 registry 缺项的 adapter」时承重，
   * 而 spare 查找被触发的两条路径都到不了那里：
   * • decision 路径：router 已把满载声明者过滤出局（loadBlocked），decision
   *   不会指向满载者；指向 legacy 时 `admitConcurrency` 在 wantedDesc 检查处
   *   直接放行，根本不进 spare 查找；
   * • 兜底路径（decision 为 undefined）：candidates 为空或全部满载 ——
   *   `registry.candidates()` 对 legacy 恒放行，所以这两种情况都意味着
   *   **池里没有 legacy**，spare 查找遍历到的全是声明 agent。
   * 生产装配（agents/index.ts / headless）中 registry 与 available 同源构造，
   * `registry.get` 恒命中 → `!d` 同样不可达。
   *
   * 分支刻意保留：Scheduler 的 adapters 与 registry 在 API 上是两个独立入参，
   * 不强制同源；这行是装配方式未来变化时的 fail-safe —— 位点重回分母即提示
   * 重新核对同源假设（与 sensenova-api 快照"二次防线"同一处置逻辑）。
   *
   * 行号 2026-09-28 校回 345 → 346：同文件为 zone 重叠判定新增一条 import（`zonesOverlap`），
   * 整段下移一行。校回时确认过两层防御原样仍在（`!d` 与 `||` 的短路边仍不可达）。
   */
  /*
   * `electron/ipc/context.ts` 的 `ensureAgentLayer` 缓存 signature 位点 —— 已并入
   * 上方 `context.ts` 的 225 锚点（2026-10-23 折叠三条陈旧重复条目）。保留这条
   * 注释作为历史：它记录的是同一位点在 222 行时的论证（取反是单射 → 缓存命中
   * 边界恒等 → 无可观察差异），与上方那条逐字同义。
   */
  /**
   * `electron/ipc/chat.ts` `profileOfMeta` 的早退条件
   * `if (!meta.providerId || !meta.model) return base;` —— **可证明等价**。
   *
   * 改成 `&&` 后只有「两个字段都缺」才会提前返回；半截 meta 会多走一次
   * `getProvider` / `isModelId`，但两条路的返回值与副作用都相同：
   * • provider 有、model 缺：getProvider 成功，`isModelId(undefined)` 为假 → base；
   * • provider 缺、model 有：getProvider(undefined) 抛错，被 catch → base。
   * `getProvider` 是纯查表，没有可观测副作用；因此变异只影响执行路径，不影响
   * 任何返回结果。真正的完整性判断由后面的 getProvider + isModelId 兜底。
   *
   * ⚠️ 行号是锚点：`profileOfMeta` 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认下游两条校验仍在。
   *
   * 2026-10-21：M3c-3 在 `chatProfileOf` 里插入推理强度校验（+27 行），锚点
   * 318 → 345。论证不变：`getProvider` / `isModelId` 仍是同一对兜底。
   * 同日 M4a 又在其上方插入审批归属与寻址（+56 行）→ 401，随后删掉
   * `resumeIntoLive` 里一行死代码（登记表同 id 覆盖已含删除）→ 402。
   */
  /**
   * `electron/ipc/chat.ts` `buildSession` 里 `...(pinned && profile?.reasoningEffort ? … : {})`
   * 的 `&& → ||` —— **可证明等价**（下游二次守卫）。
   *
   * 变异体在「线路已钉死、但没选推理档」时不再短路，而是展开
   * `{ reasoningEffort: undefined }` 进 `ChatSessionOptions`。但 `ChatSession`
   * 构造函数自己又守了一次：
   * `...(opts.reasoningEffort && opts.providerId && opts.model ? { reasoningEffort } : {})`
   * —— `undefined` 在那里就被丢掉，**meta 里不会出现该键**（本轮的用例
   * 「chat:new 的推理强度……」直接断言 `"reasoningEffort" in meta === false`）。
   *
   * 另半边「pinned 真而 profile 假」不可达：`pinnedLineOf(profile, …)` 只有在
   * profile 给出完整 providerId + model 时才返回非空，`pinned` 真 ⟹ profile 非空，
   * 所以 `profile.reasoningEffort` 不会抛 TypeError。
   *
   * **刻意保留**：两层守卫各管一段职责 —— buildSession 不往选项里塞 undefined，
   * ChatSession 不信任调用方。任一层将来放宽，这个等价就不再成立。
   *
   * ⚠️ 行号是锚点：buildSession 结构变化使该行漂移时，变异会重新出现 ——
   * 届时按新行号校回，并重新确认 ChatSession 侧的二次守卫仍在。
   */
];

/** 逐行对比原文件与变异体，返回内容变化的 1-based 行号。 */
function changedLines(original, mutant) {
  const a = original.split("\n");
  const b = mutant.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) out.push(i + 1);
  }
  return out;
}

/**
 * 判断 `i` 处的 `/` 是否可能是**正则字面量**的开头（而不是除法）。
 *
 * 用通行的启发式：看 `out`（已掩空）里前一个**有效字符**。
 * 它是 `(` `,` `=` `:` `[` `!` `&` `|` `?` `{` `}` `;` `+` `-` `*` `%` `<` `>` `~` `^`
 * 之一、或位于文件开头 → 正则；是标识符/`)`/`]`/`.` 结尾 → 除法。
 *
 * 为什么必须做：正则体里可以出现任何字符，**包括反引号与引号**。本仓库实测
 * `electron/sandbox/command-policy.ts:114` 的 `/[;&|`$<>^!]/` 里就有反引号 ——
 * 不识别正则时，掩空器会把那个反引号当模板字符串开头，**跨行不闭合，吞掉整个
 * 文件剩余部分**，于是该文件的位点数静默归零（比没有门禁更糟：它看起来是绿的）。
 */
function regexMayStartAt(src, out, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = out[j];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") continue;
    return "(,=:[!&|?{};+-*%<>~^".includes(c);
  }
  return true; // 文件开头
}

/**
 * 从 `i`（`/`）扫描正则字面量的结束位置，返回「闭斜杠 + 标志位」之后的索引。
 *
 * 找不到合法的收尾（跨行、或没闭合）时返回 -1 —— 此时按普通字符处理。
 * 这个回退把"启发式猜错"的损害限制在**一行以内**，不会吞掉整份文件。
 */
function scanRegexEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  let closed = -1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return -1; // 正则不能跨行 → 不是正则
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      closed = j;
      break;
    }
    j += 1;
  }
  if (closed < 0) return -1;
  let k = closed + 1;
  while (k < n && /[a-z]/i.test(src[k])) k += 1; // 标志位 gimsuy
  return k;
}

/**
 * 把注释、字符串与正则字面量「挖空」（**保留长度与换行**），只留可执行代码的位置。
 *
 * 为什么必须做：变异是**纯文本**替换，注释里写一个 `||` 字面量也会被命中。
 *   - 聚合口径下：产生"改了注释、行为不变"的**假存活**（本仓库踩过一次，
 *     见 `snapshot-store.ts` 里那段"注释里刻意不写会命中变异算子的运算符字面量"）。
 *   - 逐位点口径下更糟：每个注释位点都是一个**永远存活**的变异，
 *     会让 `--mode=site` 直接变红，而且是假红。
 *
 * 挖空之后注释/字符串里的算子不再算位点，同时把「挖掉了几个命中」报出来 ——
 * 它就是「注释里不要留算子字面量」这条约定的自动体检。
 *
 * ⚠️ 状态未闭合时**抛错**，不静默继续。掩空器一旦出错就是"位点归零"——
 * 门禁照常报 PASS 却说不出任何事，与「CI 里路径写错、从没跑过的 job」同族。
 */
function maskNonCode(src) {
  // 必须用数组承接：字符串不可变，逐字符挖空需要一个可写的容器。
  const out = src.split("");
  const n = src.length;
  const BLANK = (i) => {
    if (i >= 0 && i < n && src.charCodeAt(i) !== 10) out[i] = " ";
  };
  let i = 0;
  let state = "code"; // code | line | block | single | double | template
  /**
   * 模板表达式栈：每个 `${` 压一层，记录该层里 `{` 的嵌套深度。
   *
   * 为什么需要它：`` `${a === "x" ? 1 : 2}` `` 里的 `a === "x"` 是**真代码**，
   * 掩掉整个模板会**漏掉真实位点**（本仓库实测：`cli-agent.ts:219`、
   * `http-bridge.ts:150/185/220-222` 都有这种 `${x === "..."}`）。
   * 加栈之后模板**文本**被挖空、`${...}` 里的表达式按代码处理。
   */
  const tmplStack = [];
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      // `${` 的收尾 `}`：深度为 0 时它关闭表达式、回到模板文本态。
      // 必须排在正常代码处理之前，否则会把 `}` 当普通字符。
      if (tmplStack.length > 0) {
        if (c === "{") {
          tmplStack[tmplStack.length - 1].braces += 1;
        } else if (c === "}") {
          if (tmplStack[tmplStack.length - 1].braces > 0) tmplStack[tmplStack.length - 1].braces -= 1;
          else {
            tmplStack.pop();
            state = "template";
            i += 1;
            continue;
          }
        }
      }
      if (c === "/" && c2 === "/") {
        state = "line";
        BLANK(i);
        BLANK(i + 1);
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        BLANK(i);
        BLANK(i + 1);
        i += 2;
        continue;
      }
      // 正则字面量必须排在字符串判定**之前**：正则体里可能出现反引号或引号
      // （command-policy.ts:114 实测有反引号），漏判会让状态机吞掉整个文件。
      if (c === "/" && regexMayStartAt(src, out, i)) {
        const end = scanRegexEnd(src, i);
        if (end > 0) {
          for (let k = i; k < end; k++) BLANK(k);
          i = end;
          continue;
        }
      }
      if (c === "'" || c === '"') {
        state = c === "'" ? "single" : "double";
        BLANK(i);
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "template";
        BLANK(i);
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        i += 1;
        continue;
      }
      BLANK(i);
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        BLANK(i);
        BLANK(i + 1);
        i += 2;
        state = "code";
        continue;
      }
      BLANK(i);
      i += 1;
      continue;
    }
    // 模板**文本**段：只有 `${` 会切回代码态，反引号收尾；换行合法。
    if (state === "template") {
      if (c === "\\") {
        BLANK(i);
        BLANK(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        BLANK(i);
        i += 1;
        state = "code";
        continue;
      }
      if (c === "$" && c2 === "{") {
        BLANK(i);
        BLANK(i + 1);
        tmplStack.push({ braces: 0 });
        i += 2;
        state = "code";
        continue;
      }
      BLANK(i);
      i += 1;
      continue;
    }
    // 单/双引号字符串内
    if (c === "\\") {
      BLANK(i);
      BLANK(i + 1);
      i += 2;
      continue;
    }
    const closer = state === "single" ? "'" : '"';
    if (c === closer) {
      BLANK(i);
      i += 1;
      state = "code";
      continue;
    }
    // 未闭合的引号（单引号/双引号跨行在 TS 里不合法）→ 遇换行退出字符串态，
    // 避免一个笔误把后面整段代码都当成字符串而漏掉全部位点。
    if (c === "\n") {
      state = "code";
      i += 1;
      continue;
    }
    BLANK(i);
    i += 1;
  }
  // ⚠️ 失效保护：停在非 code 态 = 掩空器有 bug（引号/正则识别失败），
  // 后果是"该文件的位点静默归零、门禁照常报 PASS"。宁可炸掉也不能静默。
  if (state !== "code" || tmplStack.length > 0) {
    throw new Error(
      `maskNonCode 状态未闭合（state=${state}, 未闭合模板表达式=${tmplStack.length}）—— ` +
        `掩空器识别失败会让位点数静默归零。请修 maskNonCode 的引号/正则/模板处理，` +
        `不要绕过这个检查。`,
    );
  }
  return out.join("");
}

/** 1-based 行号。 */
function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * 列出算子在**可执行代码**里的全部位点。
 * 返回 `{ sites, rawHits, maskedHits }`：
 *   - `rawHits`   —— 原文（含注释/字符串）里的全部命中
 *   - `maskedHits`—— 被挖空掉的命中数（在注释/字符串/正则里的）
 * 恒有 `sites.length + maskedHits === rawHits`，这是掩空器的自洽校验。
 */
function findSites(source, masked, op) {
  const sites = [];
  if (op.swap) {
    for (const s of findTernarySites(masked)) {
      sites.push({ ...s, line: lineOf(source, s.index) });
    }
    return { sites, rawHits: sites.length, maskedHits: 0 };
  }
  for (const m of masked.matchAll(op.find)) {
    sites.push({ index: m.index, end: m.index + m[0].length, line: lineOf(source, m.index) });
  }
  let rawHits = 0;
  for (const _ of source.matchAll(op.find)) rawHits += 1;
  return { sites, rawHits, maskedHits: rawHits - sites.length };
}

const args = process.argv.slice(2);
const onlyFile = args.find((a) => a.startsWith("--file="))?.slice(7);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? "4");

/**
 * `--tier=N`：**精确**匹配该成本层（不是"≤N"）。不传 ＝ 全部目标。
 *
 * 2026-10-16 修：此前是 `t.tier <= maxTier`（缺省 99＝全部），于是 CI 的 `--tier=2`
 * 分片跑的是**全部**目标（含 tier 1）——它与 tier 1 那条 job 不是"分区"而是"超集"：
 * tier 2 的 54.8 min 里有约 23 min 是重复跑 tier 1。而脚本头注释写着
 * 「--tier=1 # 只跑 tier 1」——声明与实现不符。改精确后 `tier 1 ∪ tier 2` 才真是
 * 全集，下面的 `--shard` 也才有意义（分片必须建立在分区之上）。
 */
const tierRaw = args.find((a) => a.startsWith("--tier="))?.slice("--tier=".length);
const tierFilter = tierRaw === undefined ? null : Number(tierRaw);
if (tierFilter !== null && (!Number.isInteger(tierFilter) || tierFilter < 1)) {
  console.error(`--tier=${tierRaw} 非法（要正整数，如 --tier=1；不传＝全部目标）`);
  process.exit(2);
}

/**
 * `--shard=i/n`：把（已按 --tier / --file 过滤后的）目标**轮转**均摊成 n 片，只跑第 i 片
 * （i 从 1 起）。用途：CI 的全量 site 审计按时长切片 —— 单片超过 runner 的回收窗口就会被
 * 平台掐掉，而**被掐就没有存活清单**，那是这条 job 唯一的产出。
 *
 * 为什么是"轮转"而不是"CI 手写目标清单"（2026-09-29 roadmap 记的下一刀形式）：手写清单
 * 漏掉一个目标 ＝ 那个目标**永远不被审计**，而它所在的 job 照样绿 —— 正是本仓库反复踩的
 * 「漏挂的文件根本不参与统计，那个 PASS 对它没有任何含义」。轮转由工具自己算，
 * 各片之并恒为全集，新增目标自动落进某一片，不需要人去维护清单。
 */
const shardRaw = args.find((a) => a.startsWith("--shard="))?.slice("--shard=".length);
let shardIndex = 1;
let shardCount = 1;
if (shardRaw !== undefined) {
  const m = /^(\d+)\/(\d+)$/.exec(shardRaw);
  if (!m) {
    console.error(`--shard=${shardRaw} 非法（要形如 i/n，如 --shard=1/3）`);
    process.exit(2);
  }
  shardIndex = Number(m[1]);
  shardCount = Number(m[2]);
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardIndex < 1 || shardIndex > shardCount) {
    console.error(`--shard=${shardRaw} 非法（要求 1 ≤ i ≤ n 且 n ≥ 1）`);
    process.exit(2);
  }
}

const listOnly = args.includes("--list");
const recoverOnly = args.includes("--recover-only");
// 并行度：>1 时按**目标**分进程池（每个 worker 子进程独占一个目标，复用全部
// 单目标流程——基线/台账/还原）。worker 之间互不共享源文件，台账按文件一条，
// 谁也顶不掉谁。默认 1 = 完全串行（与历史行为逐字节一致）；npm scripts 与 CI
// 传 --jobs=3。--file 单目标时并行没有意义，强制走内联路径。
const jobs = Math.max(1, Number(args.find((a) => a.startsWith("--jobs="))?.slice(7) ?? "1") || 1);
const noReport = args.includes("--no-report");
const resultJson = args.includes("--result-json");

/**
 * 变异口径（见文件头「两种口径」）：
 *   - `aggregate`（默认）：一个算子一个变异，改掉全部位点。
 *   - `site`：一个位点一个变异。
 *
 * `--audit` 是 `--mode=site --limit=999` 的简写 —— 逐点全量，用来给一个模块出
 * 「每一处都有断言」的结论。
 */
const auditMode = args.includes("--audit");
const mode = auditMode ? "site" : (args.find((a) => a.startsWith("--mode="))?.slice(7) ?? "aggregate");
if (mode !== "aggregate" && mode !== "site") {
  console.error(`未知 --mode=${mode}（只能是 aggregate 或 site）`);
  process.exit(2);
}
const effectiveLimit = auditMode ? 999 : limit;

/**
 * 两档超时，因为两种情况要问的问题不同。
 *
 * **基线**问的是「这套测试在这个模块上本来是好的吗」—— 值得等，给足余量。
 * **变异体**问的是「改了这一处，测试还会通过吗」——**挂住本身就等于不通过**，
 * 没有任何理由陪它等满。
 *
 * 实测（2026-09-21）：`llm-client.ts` 的 `|| → &&` 变异让测试挂到 timeout —— 基线
 * 0.9s、变异体 200s（正好是上限）。全量 8m37s 里 81% 花在这种"等它自己放弃"上。
 * 而所有基线轮最慢也只要 ~6s（含四文件目标），所以 20s 对变异体有 3 倍余量。
 *
 * 若某个模块的正常测试确实需要更久，用 `--mutant-timeout=` 调高它 ——
 * 但先确认那是"正常慢"而不是"挂住"。
 */
const BASELINE_TIMEOUT_MS = Number(
  args.find((a) => a.startsWith("--baseline-timeout="))?.slice("--baseline-timeout=".length) ?? "60000",
);
const MUTANT_TIMEOUT_MS = Number(
  args.find((a) => a.startsWith("--mutant-timeout="))?.slice("--mutant-timeout=".length) ?? "20000",
);

/**
 * vitest 自己的 per-test 超时（`--test-timeout=`）。这是**第二层**时限：
 * `execFileSync` 的 timeout 管整个进程，这一层管单个用例。
 *
 * 挂住时**先撞这一层**：单文件里几个用例各挂满它，串行累加就是几十秒。
 * 实测 `sensenova-api.ts` 的 `=== → !==` 变异 —— 5 个 adapter 用例各
 * `Test timed out in 5000ms`，一轮 60s，而正常一轮只要 1.2s。
 *
 * - 变异体：调小到 2s（正常用例在该文件里是 1-6ms 级，10 倍以上余量）
 * - 基线：保持宽裕（15s）—— 它的任务是证明"这套测试本来是好的"
 *
 * **只在这里传参，不改 `npm test` 的默认值**：开发者本地跑测试的体验不该被动。
 */
const MUTANT_VITEST_TEST_TIMEOUT_MS = Number(
  args.find((a) => a.startsWith("--mutant-test-timeout="))?.slice("--mutant-test-timeout=".length) ?? "1200",
);
const BASELINE_VITEST_TEST_TIMEOUT_MS = Number(
  args.find((a) => a.startsWith("--baseline-test-timeout="))?.slice("--baseline-test-timeout=".length) ?? "15000",
);

/**
 * 默认只启用「基础」算子 + 已转正的三元分支互换；`extra: true` 的
 * `?? → ||` 仍要用 `--ops=nullish` 显式打开 —— 它是**评估中**的新算子，
 * 先量过存活量才决定是否进 `verify`，避免一次性给门禁压上几十个存活点。
 * （三元互换 2026-09-28 转正：881/881 逐位点全杀后不再需要 `--ops=ternary`。）
 */
const opsArg = args.find((a) => a.startsWith("--ops="))?.slice("--ops=".length);
const enabledExtra = new Set(String(opsArg ?? "").split(",").filter(Boolean));
if (opsArg && enabledExtra.has("all")) for (const op of OPERATORS) if (op.optName) enabledExtra.add(op.optName);
const ACTIVE_OPERATORS = OPERATORS.filter((op) => !op.extra || (op.optName && enabledExtra.has(op.optName)));

const matched = TARGETS.filter((t) => tierFilter === null || t.tier === tierFilter).filter((t) => {
  if (!onlyFile) return true;
  // 匹配语义（2026-09-29 收紧）：全路径精确优先；短名回退按「路径末段」。
  // 此前是 `t.file.includes(onlyFile)` —— touched 审 `src/store.ts` 时传
  // `--file=store`，却把 keys-store / snapshot-store / electron-store 全拖进
  // 同一轮审计：任何一个的基线失败都会让 `src/store.ts` 的审计段整体退出
  // 非 0（2026-09-29 CI windows verify 即被 snapshot-store 的基线拖红，
  // 且本地无法复现）。短名仍可能同名（两个 store.ts），那是手动用法的
  // 冗余，可接受；touched 已改为传完整路径，走精确分支。
  return t.file === onlyFile || t.file === `${onlyFile}.ts` || t.file.endsWith(`/${onlyFile}.ts`);
});
if (matched.length === 0) {
  console.error(
    `没有匹配的目标：--file=${onlyFile ?? "（未指定）"} ` +
      `--tier=${tierFilter ?? "（未指定，＝全部目标）"}`,
  );
  process.exit(2);
}
// 分片：轮转切片（见 --shard 的注释）。i=1 取第 0、n、2n… 个，i=n 取第 n-1、2n-1… 个；
// 各片之并恒等于 matched。
const targets =
  shardCount === 1 ? matched : matched.filter((_, i) => i % shardCount === shardIndex - 1);
if (targets.length === 0) {
  console.error(
    `分片 ${shardIndex}/${shardCount} 里没有目标（--tier / --file 过滤后只有 ${matched.length} 个）。\n` +
      "  这多半是分片数大于目标数。刻意让它 exit 2 而不是空跑 PASS ——\n" +
      "  空跑的绿会读成「这个分片全过」，而它一个位点都没验过。",
  );
  process.exit(2);
}
if (shardCount > 1) {
  // 走 stderr：stdout 是 `--list` / worker `##MUTATION_RESULT##` 的机器可读面，
  // 一行提示混进去就是"输出多一行把下游砸了"的那类事故。
  console.error(`分片 ${shardIndex}/${shardCount}：命中 ${targets.length}/${matched.length} 个目标`);
}

/**
 * 已改写的文件 → 原始内容。进程退出时兜底恢复。
 *
 * 注意：这只覆盖**进程自己收到信号**的死法。Windows 上被外部强杀
 * （TerminateProcess，任务管理器 / CI 超时 / IDE 关进程树）时，SIGINT、
 * SIGTERM 处理器和 `exit` 事件**一个都不会执行**，内存里的 pending 随进程
 * 一起消失 —— 变异体就永久留在工作区里，且 `git diff` 之前无人察觉。
 *
 * 2026-09-27 实测：脚本被工具超时杀掉后，`electron/sandbox/snapshot-store.ts`
 * 的 `continue → break` 变异体留在了源码里。所以下面这套**落盘**机制是必需的，
 * 不是冗余：把原始内容写进磁盘，下次启动时先自愈。
 */
const pending = new Map();
let restoring = false;

/** 落盘备份目录（git 已忽略，见 .gitignore）。台账按文件一条：`<备份名>.json`。 */
const PENDING_DIR = path.join(ROOT, "scripts", ".mutation-pending");

/** 相对路径，仅用于打印。 */
function relFromRoot(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

/** 备份文件名：把仓库相对路径里的分隔符换成 `__`。
 *  用 basename 会让不同目录的同名文件（`router.ts` / `agents/router.ts`）顶掉同一份备份，
 *  而孤儿处置要靠文件名映射回源文件，名字里必须带着路径。
 */
function pendingBackupName(filePath) {
  return `${relFromRoot(filePath).split("/").join("__")}.orig`;
}

/**
 * 备份文件名 → 源文件绝对路径；映射不回去（源文件已改名或删除、或是旧命名留下的）时返回 null。
 */
function sourceFromBackupName(backupName) {
  const rel = backupName.slice(0, -".orig".length).split("__").join(path.sep);
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

/** 台账目录里没被 `index.json` 指着的那些 `.orig`：上一轮丢了台账，或清目录时删除失败。 */
function listOrphanBackups() {
  let names;
  try {
    names = fs.readdirSync(PENDING_DIR);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".orig")).map((n) => path.join(PENDING_DIR, n));
}

/**
 * 没有可用台账时，逐份向孤儿备份要证据：内容与它映射回的源文件一致 → 这一份可证干净，清掉；
 * 不一致或映射不回去 → 返回 false，调用方就**不许**说工作区干净。
 *
 * 刻意不拿孤儿备份去覆盖源码：备份可能是写盘写坏的一半，拿它"自愈"会把好文件截断。
 */
function settleOrphanBackups(orphans) {
  let provablyClean = true;
  for (const backup of orphans) {
    const file = sourceFromBackupName(path.basename(backup));
    let same = false;
    if (file) {
      try {
        same = fs.readFileSync(backup, "utf8") === fs.readFileSync(file, "utf8");
      } catch {
        same = false;
      }
    }
    if (same) {
      try {
        fs.rmSync(backup);
      } catch {
        /* 清不掉就留给下一轮再看 */
      }
      continue;
    }
    provablyClean = false;
    console.error(
      `无法证明干净：${relFromRoot(backup)} 是台账已丢失的变异备份，` +
        (file ? `而 ${relFromRoot(file)} 的内容与它不一致` : "且按命名映射不回源文件") +
        "。请自己核对那个文件（别用 git 按文件还原，那会连本轮真实改动一起删），" +
        "确认后删除 scripts/.mutation-pending/ 再重跑。",
    );
  }
  return provablyClean;
}

/** 进程号是否还活着。`signal 0` 只做存在性探测；`EPERM` 同样算活着（进程属于别人）。 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * 取一个进程的命令行；拿不到（权限/平台/已退出）返回 null。
 *
 * ⚠️ **"取到但为空" 必须当成取不到**（2026-10-25 实测修正）。
 *
 * 现场：`wmic` 在新版 Windows 上已经不存在（ENOENT，立刻返回），所以这条链实际只有
 * PowerShell CIM 那一次调用。它平时 ~1.4s 就有输出，但**重负载下会间歇性地返回
 * `status === 0` 而 stdout 为空**（实测一次 `status 0 / outLen 0`，错开再测 25 次又全有
 * 输出）。原判据只看 `status === 0 && 非空` 才对，所以空输出会往下走完两种命令、
 * 最终返回 `null` ⇒ 调用方 `isForeignMutationRun` 走"查不到就保守按活着算" ⇒
 * **一份早已还原干净的台账被判成"另一轮变异正在运行"** ⇒ `check:residue` 退出 2 ⇒
 * verify 链首红。
 *
 * 归因极难：单跑那个测试文件必绿（空输出是偶发），只有整链跑、机器被 104 个测试文件
 * 占满时才红，且断言只看到 `expected 2 to be 0`。所以这里做两件事：
 *   1. **空输出不是答案**：一次取不到就重试（至多 `PID_COMMANDLINE_ATTEMPTS` 次），
 *      因为"取到空"与"这个 pid 属于别人"完全不是一回事；
 *   2. 预算给足 `PID_COMMANDLINE_TIMEOUT_MS`，别让冷启动的 ~1.4s 在重负载下被截断。
 * 判据本身不放松：仍然要求命令行里**真有** mutation-check。
 */
const PID_COMMANDLINE_TIMEOUT_MS = 30_000;
/** 空输出时的重试次数（含首次）。偶发空输出是实测事实，一次就下结论会误判。 */
const PID_COMMANDLINE_ATTEMPTS = 3;

function pidCommandLine(pid) {
  if (process.platform === "win32") {
    // wmic 已弃用但仍在；退化到 PowerShell CIM。都失败返回 null（调用方保守处理）。
    for (let attempt = 0; attempt < PID_COMMANDLINE_ATTEMPTS; attempt += 1) {
      for (const [cmd, args] of [
        ["wmic", ["process", "where", `processid=${pid}`, "get", "commandline"]],
        [
          "powershell",
          ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        ],
      ]) {
        try {
          const out = spawnSync(cmd, args, { encoding: "utf8", timeout: PID_COMMANDLINE_TIMEOUT_MS });
          if (out.status === 0 && typeof out.stdout === "string" && out.stdout.trim() !== "") return out.stdout;
        } catch {
          /* 换下一种 */
        }
      }
    }
    return null;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

/**
 * pid 是否属于**另一个还在跑的 mutation-check 实例**。
 *
 * ⚠️ 不能只用 `isPidAlive`：pid 会复用。2026-10-15 实测 —— 凌晨一轮变异被强杀，
 * 台账里的 pid 35512 后来被微信（Weixin.exe）复用，`check:residue` 于是把一堆
 * 早已还原干净的残留判成"另一轮正在运行"，拒绝清理且拒绝启动，`npm test` 也跟着红
 * （那条卫生断言的本意是抓活体变异体，不是抓 pid 撞车）。所以活着之外还要看身份：
 * 命令行里得真是这个脚本。查不到命令行时保守按"活着算"—— 把不确定当已退出会更糟。
 */
function isForeignMutationRun(pid) {
  if (!isPidAlive(pid)) return false;
  const cmd = pidCommandLine(pid);
  if (cmd === null) return true;
  return cmd.includes("mutation-check");
}

/** 一条台账的落盘路径：按文件一条（备份名 + .json）。
 *  旧设计是单槽 `index.json`——它从根上假设"同一时刻只有一个源文件在被变异"，
 *  并行 worker（按目标分进程）会互相顶掉记录。按文件一条后，谁写谁都互不干扰，
 *  残留自愈与跨会话并发也按文件判定，而不是全场互斥。
 */
function recordPathFor(filePath) {
  return path.join(PENDING_DIR, `${pendingBackupName(filePath)}.json`);
}

/** 改写源文件**之前**调用：把原文落到磁盘。 */
function armPendingRecord(filePath, original) {
  const backup = path.join(PENDING_DIR, pendingBackupName(filePath));
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(backup, original, "utf8");
    // 备份自己也可能是坏的（Windows 上杀软会掏空刚写下的文件）。拿坏备份去自愈等于把
    // 源码写成截断的原文，比没有备份更糟，所以这里做写后校验。
    if (fs.readFileSync(backup, "utf8") !== original) throw new Error("备份写后校验不一致");
    // pid 让台账能分出"谁的"：PENDING_DIR 是仓库级全局路径，两轮并发时没有 pid 就分不清
    // 该谁清、该不该动别人的凭据。
    fs.writeFileSync(recordPathFor(filePath), JSON.stringify({ file: filePath, backup, pid: process.pid }, null, 2), "utf8");
  } catch (e) {
    // 2026-10-09 改判：原为"警告后继续跑"，而那正是盲区的来源 —— `check:residue` 只认台账，
    // 没有落盘记录还照样改写源码，强杀之后留下的活体变异体就会被下一轮判成"工作区干净"。
    // 此刻源文件还没被动过，退出 2 是零副作用的。
    console.error(
      `严重：无法建立变异备份（${e?.message ?? e}）—— 没有可自愈的台账就不改写源码。` +
        `请确认 ${relFromRoot(PENDING_DIR)} 可写（它已被 git 忽略，杀软常占它），再重跑本命令。`,
    );
    process.exit(2);
  }
}

/** 同步等待（毫秒）。还原路径都在同步流程里，不能用 await。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 把原文写回源文件，**带重试**。
 *
 * 为什么不能直接 `fs.writeFileSync`：Windows 上杀软 / 搜索索引会短暂占住刚被改写文件的
 * 句柄，实测 2026-09-28 两次 `UNKNOWN (errno -4094)`，打在不同文件上。而这个调用点在
 * `finally` 里 —— 它一抛，进程就带着**活体变异体**死掉，下一轮门禁的症状会变成
 * 「无关目标红」或干脆 vitest OOM，看着像代码坏了。
 *
 * 返回 false 表示尽力了：调用方（`runTarget` 末尾的写后校验）会把这一条判成严重并退出 2，
 * 台账留在原地，下一次启动由 `recoverPendingRecord()` 还原。
 */
function restoreSource(filePath, original) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.writeFileSync(filePath, original, "utf8");
      if (fs.readFileSync(filePath, "utf8") === original) return true;
      lastErr = new Error("写后校验不一致");
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 5) sleepSync(200 * attempt);
  }
  console.error(
    `严重：反复无法还原 ${relFromRoot(filePath)}（${lastErr?.message ?? lastErr}）—— ` +
      "台账已保留，下一次启动会自愈；现在先重跑本命令，或手动 git checkout 该文件。",
  );
  return false;
}

/** 一个目标跑完、源码已确认还原后调用：**只清自己这一条**（按文件一条台账）。
 *
 * 旧实现是 `rm -rf` 整个 `PENDING_DIR`，而那个目录是仓库级全局路径 —— 另一轮变异正在跑时，
 * 这一句会把它的台账连同备份一起删掉，它那轮的启动自愈与 `check:residue` 于是同时失明
 * （正是"残留看不见"那一格的最后一格；2026-10-09 本机就有两个会话并行跑门禁的场景）。
 * 按文件一条记录后这条纪律由结构保证：清的只是自己那份记录与备份。
 *
 * @param ownsIt 调用方已确认这份台账不属于任何活着的进程（启动自愈走这条），
 *               此时连"pid 不是我的"的旧台账也一起收 —— 否则还原完了台账还挂在原地。
 */
function clearPendingRecord(filePath, ownsIt = false) {
  // 记录路径在这里就地计算（不用 recordPathFor）：按锚点抠出本函数的测试只注入
  // fs/path/PENDING_DIR/pendingBackupName，切片区域必须自包含。
  const record = path.join(PENDING_DIR, `${pendingBackupName(filePath)}.json`);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(record, "utf8"));
  } catch {
    /* 没有台账，或台账读不动：按"无可清之处"处理 */
  }
  // 没有 pid 的旧格式台账按"我的"处理：本仓脚本自带 pid，只有混用两个版本才可能读到它。
  if (!ownsIt && rec?.pid !== undefined && rec.pid !== process.pid) return;
  if (rec?.backup) {
    try {
      fs.rmSync(rec.backup, { force: true });
    } catch {
      /* 清不掉留给下一轮的孤儿处置 */
    }
  }
  try {
    fs.rmSync(record, { force: true });
  } catch {
    /* 清不掉不影响结论 */
  }
}

/**
 * 启动自愈：上一次运行被强杀 → 这里把变异体还原，并**失败退出**。
 *
 * 退出而不是继续跑，是刻意的：源码刚被从未知状态改回来，此时得出的
 * 「杀死/存活」结论可信度存疑，让人重跑一次比给一个脏的 PASS 强。
 *
 * 返回值给 `--recover-only` 用，由它决定「能说工作区干净」的那几种情形：
 *   - `clean`            —— 根本没有台账，且目录里也没有任何还活着的备份。
 *   - `already-restored` —— 有台账，但源文件内容与备份一致（上次其实还原成功了，
 *                           只是没来得及清台账）。
 *   - `unknown`          —— 有台账却读不出可用记录（JSON 坏 / 备份文件没了），或台账丢了
 *                           而备份还在且证不了一致。这时**不能**声称干净：目标文件可能仍是
 *                           变异体，而我们已经没有还原它的手段。让人去 `git status` 自查。
 *   - `restored`         —— 刚从变异体还原回来（内部已 exit 2，不会真的返回）。
 *   - `foreign-live`     —— 台账属于**还活着的另一个进程**：那不是残留，是别人正在跑的现场，
 *                           还原它、清它都是破坏证据。同一份源码上两轮互踩也没有可信结论，
 *                           所以调用方一律拒绝启动（exit 2）。
 *
 * `myFiles`：本轮要动的目标文件集合，或 `"all"`（`check:residue` 的卫生检查——
 * 任何文件的活体残留都算）。**按文件判定**是并行化的前提：worker 各管各的文件，
 * 别的文件上活着的外来台账既不动它也不判它 —— 旧的单槽台账全场互斥，两轮
 * 连"改的是不同文件"都不允许。
 */
function recoverPendingRecord(myFiles) {
  const records = fs.existsSync(PENDING_DIR)
    ? fs
        .readdirSync(PENDING_DIR)
        .filter((n) => n.endsWith(".json"))
        .map((n) => path.join(PENDING_DIR, n))
    : [];
  const recordedBackups = new Set();
  let sawUnknown = false;
  let sawAlreadyRestored = false;
  for (const record of records) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(record, "utf8"));
    } catch {
      rec = null;
    }
    if (rec?.pid !== undefined && rec.pid !== process.pid && isForeignMutationRun(rec.pid)) {
      // 别的文件上活着的外来台账：不是残留，也不是本轮的事，跳过不判。
      // 本轮要动的文件上有 → 拒绝启动（同一份源码两轮互踩，谁的结果都不可信）。
      if (myFiles === "all" || (rec.file && myFiles.has(rec.file))) {
        console.error(
          `另一轮变异正在运行（pid ${rec.pid}，目标 ${relFromRoot(rec.file ?? record)}）—— ` +
            "那份台账是它被强杀后唯一的凭据，本轮既不动它也不判它。等它跑完再跑：" +
            "两轮在同一份源码上互踩，谁的结果都不可信。",
        );
        return "foreign-live";
      }
      recordedBackups.add(rec.backup ?? "");
      continue;
    }
    if (!rec?.file || !rec.backup || !fs.existsSync(rec.backup)) {
      try {
        fs.rmSync(record, { force: true });
      } catch {
        /* 清不掉留给下一轮 */
      }
      console.error(
        "警告：变异备份台账存在但不可用（JSON 损坏或备份文件缺失）—— 已清掉台账，" +
          "但无法确认工作区是否还留着变异体。请执行 `git status` 与 `git diff` 自查。",
      );
      sawUnknown = true;
      continue;
    }
    recordedBackups.add(rec.backup);
    const original = fs.readFileSync(rec.backup, "utf8");
    const current = fs.existsSync(rec.file) ? fs.readFileSync(rec.file, "utf8") : null;
    if (current === original) {
      try {
        fs.rmSync(rec.backup, { force: true });
      } catch {
        /* 清不掉留给下一轮的孤儿处置 */
      }
      try {
        fs.rmSync(record, { force: true });
      } catch {
        /* 清不掉不影响结论 */
      }
      sawAlreadyRestored = true;
      continue;
    }
    try {
      fs.writeFileSync(rec.file, original, "utf8");
      try {
        fs.rmSync(rec.backup, { force: true });
      } catch {
        /* 清不掉留给下一轮的孤儿处置 */
      }
      try {
        fs.rmSync(record, { force: true });
      } catch {
        /* 清不掉不影响结论 */
      }
    } catch (e) {
      console.error(`严重：无法还原 ${relFromRoot(rec.file)}（${e?.message ?? e}）—— 请手动 git checkout 该文件。`);
      process.exit(2);
    }
    console.error(
      [
        `检测到上一次变异运行被强杀：${relFromRoot(rec.file)} 残留变异体，已自动还原。`,
        `（Windows 上进程被外部终止时 SIGINT/SIGTERM 处理器不执行，内存兜底失效）`,
        `源码已恢复 —— 请重新运行本命令；若 CI 上出现，说明上一轮是被超时杀掉的。`,
      ].join("\n"),
    );
    process.exit(2);
  }
  // 没被任何台账指着的 `.orig`：上一轮丢了台账，或清目录时删除失败。
  // 逐份向备份要证据，比"没有台账 = 干净"的旧盲区严格。
  const orphans = listOrphanBackups().filter((b) => !recordedBackups.has(b));
  if (records.length === 0 && orphans.length === 0) return "clean";
  if (orphans.length > 0 && !settleOrphanBackups(orphans)) return "unknown";
  if (sawUnknown) return "unknown";
  return sawAlreadyRestored ? "already-restored" : "clean";
}

const myTargetFiles = new Set(targets.map((t) => path.join(ROOT, t.file)));
const recovery = recoverPendingRecord(recoverOnly ? "all" : myTargetFiles);

// 别人正在跑：卫生检查与真跑都拒绝启动 —— 一句"工作区干净"不能拿别人的现场换。
if (recovery === "foreign-live") {
  console.error("另一轮变异运行仍在场，本轮不启动。");
  process.exit(2);
}

if (recoverOnly) {
  // 只做卫生检查。`unknown` 不能当成干净 —— 那句「工作区干净」必须是可证的。
  if (recovery === "unknown") {
    console.error("台账不可用，无法证明工作区没有残留变异体 —— 请按上面提示自查后重跑。");
    process.exit(2);
  }
  console.log(
    recovery === "already-restored"
      ? "无变异残留：源文件与备份一致，台账已清理。"
      : "无变异残留：工作区干净。",
  );
  process.exit(0);
}

function restoreAll() {
  if (restoring) return;
  restoring = true;
  for (const [file, original] of pending) {
    restoreSource(file, original);
  }
  pending.clear();
}

process.on("exit", restoreAll);
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreAll();
  process.exit(143);
});

/**
 * 跑一个目标对应的全部测试。任一失败即视为「杀死」。
 * 多文件的目标：只挂一个文件会让另一半逻辑没有门禁。
 */
function testsPassAll(target, execTimeoutMs, vitestTestTimeoutMs, capture) {
  return testFilesOf(target).every((f) => testsPass(f, execTimeoutMs, vitestTestTimeoutMs, capture));
}

/** 取字符串最后 limit 行 —— 存活诊断只用尾部，整份 vitest 输出太吵。 */
function tailLines(text, limit = 30) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-limit).join("\n");
}

/**
 * 跑测试。返回 true = 通过（变异存活）。
 *
 * 超时算「不通过」：一个挂住的变异体**没有**让测试照样绿，它就是被发现了。
 * 见 `MUTANT_TIMEOUT_MS` 的注释 —— 这正是省下 80% 时间的地方。
 *
 * `capture`（可选）：存活位点的诊断收集器。变异跑测试的输出默认被丢弃，
 * 于是「为什么没杀死」只能靠猜 —— 2026-09-23 path-policy @92 在 Linux 上
 * 存活而本地 Windows 实证可杀，远程无法判读。带上 capture 后，报告区对
 * 存活位点打印变异 diff 与测试输出尾部，平台差异直接可见。
 */
function testsPass(
  testFile,
  timeoutMs = MUTANT_TIMEOUT_MS,
  vitestTestTimeoutMs = MUTANT_VITEST_TEST_TIMEOUT_MS,
  capture,
) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "./node_modules/vitest/vitest.mjs",
        "run",
        testFile,
        "--reporter=dot",
        "--coverage.enabled=false",
        // 挂住的用例会在**这一层**先耗时间：vitest 默认 testTimeout 5000ms，
        // 单个文件里几个用例各挂满它就会串行累加出几十秒。
        //
        // 实测（sensenova-api.ts，`=== → !==` 变异）：5 个 adapter 用例各
        // `Test timed out in 5000ms` → 一轮 60s，而该模块的正常一轮只要 1.2s。
        //
        // 门禁里调到 2s：正常用例在此文件里是 1-6ms 级（10 倍以上余量），
        // 而挂住的用例更快暴露。**只在这里调，不改 `npm test` 的默认值** ——
        // 开发者本地跑测试的体验不该被动。
        // ⚠️ 参数名是 camelCase `--testTimeout`。写成 kebab-case `--test-timeout`
        // 会被 vitest **静默忽略**（不报错、不警告），于是这一层优化看着接上了
        // 却毫无效果 —— 修完必须用"挂住的变异"实测超时信息真的变成 2000ms。
        `--testTimeout=${vitestTestTimeoutMs}`,
      ],
      {
        cwd: ROOT,
        stdio: "pipe",
        timeout: timeoutMs,
        env: { ...process.env, CI: "1" },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (capture) capture.outputs.push({ file: testFile, tail: tailLines(stdout, 20) });
    return true;
  } catch (err) {
    if (capture) {
      capture.outputs.push({
        file: testFile,
        tail: tailLines(err.stdout ?? "", 30) + tailLines(err.stderr ?? "", 15),
        failed: true,
        status: err.status ?? "timeout",
      });
    }
    return false;
  }
}

const results = [];

// ---- 目标级并行池（--jobs > 1）----
// 每个 worker 是**一个子进程**跑一个目标（testsPass 是 execFileSync，进程内并行
// 不可行）。子进程复用全部单目标流程（基线、台账、还原、--file 过滤），只多两样：
// `--no-report`（跳过报告/summary/漂移检查——那是父进程聚合后的事，N 份重复只会
// 把 summary 写花）与 `--result-json`（终局打印一行机器可读结果）。
// 子进程失败（exit 2 / 被杀）按"基线失败"计红：宁可误红不可漏绿——它的台账会让
// 下一轮 check:residue 自愈。
const poolEligible = jobs > 1 && !onlyFile && !listOnly && !recoverOnly;

function runOneChild(target) {
  return new Promise((resolve) => {
    const childArgs = [
      path.join("scripts", "mutation-check.mjs"),
      `--mode=${mode}`,
      auditMode ? "--audit" : `--limit=${limit}`,
      // 只在显式给了 --tier 时透传：worker 只跑 `--file=` 那一个目标，tier 已是冗余，
      // 但传空会让子进程的 tierFilter 变成 null（＝全部），语义失真。
      ...(tierFilter !== null ? [`--tier=${tierFilter}`] : []),
      `--file=${target.file}`,
      "--no-report",
      "--result-json",
    ];
    const child = spawn(process.execPath, childArgs, { cwd: ROOT, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      console.error(`worker 启动失败：${target.file}（${e.message}）—— 按"基线失败"计红`);
      resolve({ target, baselineFailed: true, ran: [], ms: 0 });
    });
    child.on("close", (code) => {
      const marker = out.lastIndexOf("##MUTATION_RESULT##");
      if (marker >= 0) {
        try {
          resolve(JSON.parse(out.slice(marker + "##MUTATION_RESULT##".length).trim()));
          return;
        } catch {
          /* JSON 解析失败按 worker 失败处理 */
        }
      }
      console.error(
        `worker 异常退出（exit ${code}）：${target.file}\n${tailLines(err || out, 20)}\n` +
          "—— 按\"基线失败\"计红。若源码被留在变异态，下一轮 check:residue 会自愈。",
      );
      resolve({ target, baselineFailed: true, ran: [], ms: 0 });
    });
  });
}

async function runTargetPool() {
  const queue = [...targets];
  const aggregated = [];
  const worker = async () => {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      aggregated.push(await runOneChild(target));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, targets.length) }, worker));
  // 并行下的偶发基线失败：真进程类测试（kill-tree 真杀树、dev-server 真起服务、
  // serve 真 HTTP）会互相打架 —— 池排空后对这些目标**单跑复核**，单跑仍红才是
  // 真红（与 smoke:gateway 偶发红"单跑复现再归因"同一处置）。复核走顺序路径，
  // 此时已无并发，结论确定。
  const redo = aggregated.filter((r) => r.baselineFailed).map((r) => r.target);
  for (const t of redo) {
    console.log(`\n[pool] ${t.file} 并行下基线失败 —— 单跑复核一次`);
    const i = aggregated.findIndex((r) => r.target.file === t.file);
    aggregated[i] = await runTargetSequential(t);
  }
  // 并行下的偶发**存活**同理（2026-10-11 全量审计实测：headless-entries 会在测试内
  // 重建共享的 dist-headless 并 spawn 真进程——多个 worker 的 tsc -b 抢同一目录，
  // spawn 测试可能跑到旧/半成品构建上，杀手断言空转成假存活）。有存活位点的目标
  // 一律单跑复核，单跑仍存活才计入 FAIL——宁可多花几分钟，不可让并行把门禁变松。
  const survivorTargets = aggregated
    .filter((r) => !r.baselineFailed && r.ran.some((m) => !m.killed))
    .map((r) => r.target);
  for (const t of survivorTargets) {
    console.log(`\n[pool] ${t.file} 并行下有存活位点 —— 单跑复核一次`);
    const i = aggregated.findIndex((r) => r.target.file === t.file);
    aggregated[i] = await runTargetSequential(t);
  }
  // 报告按 TARGETS 顺序输出：完成顺序是调度顺序，报告顺序必须是稳定顺序。
  const order = new Map(targets.map((t, i) => [t.file, i]));
  aggregated.sort((a, b) => (order.get(a.target.file) ?? 0) - (order.get(b.target.file) ?? 0));
  return aggregated;
}

if (poolEligible) {
  results.push(...(await runTargetPool()));
}
if (!poolEligible) {
  for (const target of targets) {
    results.push(await runTargetSequential(target));
  }
}

/** 单个目标的完整判定（基线 → 逐个变异 → 还原 → 记账）。顺序路径与 worker 的
 * 内联复核共用；pool 模式下父进程对并行基线失败的目标也会调它单跑复核。 */
async function runTargetSequential(target) {
  const startedAt = Date.now();
  const filePath = path.join(ROOT, target.file);
  const original = fs.readFileSync(filePath, "utf8");

  const excluded = EQUIVALENT_SITES.filter((e) => e.file === target.file);
  const masked = maskNonCode(original);

  // 每个算子的真实位点（只数可执行代码里的），聚合与逐位点两种口径共用。
  // ⚠️ 统计用 `perOpAll`（含 0 位点的算子）—— 否则"全部位点都在注释里"这种
  // 情况会因为过滤而丢掉"另有 N 处被排除"的提示，看起来像"这个文件没有算子"。
  const perOpAll = ACTIVE_OPERATORS.map((op) => ({ op, ...findSites(original, masked, op) }));
  const perOp = perOpAll.filter((s) => s.sites.length > 0);
  const siteTotal = perOpAll.reduce((n, s) => n + s.sites.length, 0);
  const maskedTotal = perOpAll.reduce((n, s) => n + s.maskedHits, 0);
  const rawTotal = perOpAll.reduce((n, s) => n + s.rawHits, 0);

  // 自洽校验：掩空只应"减少"命中，不应凭空增删。
  if (siteTotal + maskedTotal !== rawTotal) {
    throw new Error(
      `掩空自洽校验失败：${target.file} 位点 ${siteTotal} + 掩掉 ${maskedTotal} ≠ 原文命中 ${rawTotal}`,
    );
  }

  // 位点归零 = 这个目标对门禁**毫无贡献**，却在报告里占一行 PASS。
  // 以前只 `console.error` 提示：混在几百行输出里没人看得见，而它意味着
  // "这个被列为重点的文件，一个变异都没被验证过" —— 与漏挂测试是同一族空转。
  // 当前全量目标均有位点（2026-10-04 实测 `--mode=site --limit=999 --list`），
  // 故此处改 FAIL 不会波及既有绿灯。
  if (siteTotal === 0) {
    console.error(
      `FAIL: ${target.file} 在可执行代码里没有任何算子位点（原文命中 ${rawTotal} 处，全在注释/` +
        `字符串里）—— 它对该门禁零贡献，却会被算作 PASS。`,
    );
    console.error(
      "      处置：把它从 TARGETS 里删掉（它验证不了任何东西），或让它拥有可执行分支。\n" +
        "      留着它只会让报告里的目标数好看。",
    );
    process.exit(1);
  }

  /**
   * 生成变异体列表。
   *
   * aggregate：每算子 1 个变异，`siteCount` 记录它压掉了多少位点 ——
   *   这个数字进报告，让"聚合只证明至少一处"这件事对读者可见。
   * site：每处 1 个变异，`siteCount` 恒为 1，`line` 记下位点行号。
   */
  let all;
  if (mode === "site") {
    all = [];
    for (const s of perOp) {
      for (const site of s.sites) {
        // 等价变异白名单在逐位点口径下是**精确**匹配（算子 + 行号），
        // 不像聚合口径需要"只触碰白名单行"那种近似判断。
        if (excluded.some((e) => e.op === s.op.name && e.line === site.line)) continue;
        all.push({
          op: s.op.name,
          source: siteMutant(original, site, s.op),
          siteCount: 1,
          line: site.line,
        });
      }
    }
  } else {
    all = perOp
      .map((s) => ({
        op: s.op.name,
        source: aggregateMutant(original, s.op),
        siteCount: s.sites.length,
        line: s.sites.length === 1 ? s.sites[0].line : undefined,
      }))
      .filter((m) => m.source !== original)
      // 等价变异排除：只有当变异**只**触碰名单内的位点时才跳过；
      // 同时命中非等价位点的变异照常参与判定。
      .filter((m) => {
        const sites = excluded.filter((e) => e.op === m.op);
        if (sites.length === 0) return true;
        const lines = changedLines(original, m.source);
        return !lines.every((l) => sites.some((e) => e.line === l));
      });
  }
  const mutants = all.slice(0, effectiveLimit);

  if (listOnly) {
    const maskedNote = maskedTotal > 0 ? `，另有 ${maskedTotal} 处在注释/字符串里已排除` : "";
    console.log(
      `${target.file} → ${mode} 口径：${mutants.length}/${all.length} 个变异` +
        `（位点 ${siteTotal}${maskedNote}）：${mutants
          .map((m) => (m.siteCount > 1 ? `${m.op}(×${m.siteCount})` : m.op))
          .join(", ")}`,
    );
    return { target, baselineFailed: false, ran: [], ms: Date.now() - startedAt, siteTotal };
  }

  // 基线：原文件必须通过，否则后面结论不可信。这里用长超时 —— 要的是
  // 「这套测试本来是好的」这个事实，不是「它有多快」。
  // 失败时带出 vitest 输出尾部：2026-09-29 CI windows 上 snapshot-store
  // 基线失败只留一句「基线失败，无结论」，本地无法复现、远程无法判读。
  const baselineCapture = { outputs: [] };
  if (!testsPassAll(target, BASELINE_TIMEOUT_MS, BASELINE_VITEST_TEST_TIMEOUT_MS, baselineCapture)) {
    console.error(`基线失败：${testFilesOf(target).join(", ")} 在原始代码上不通过，跳过 ${target.file}`);
    for (const o of baselineCapture.outputs) {
      console.error(`[baseline:${o.file}] status=${o.status ?? "ok"}\n${o.tail}`);
    }
    return { target, baselineFailed: true, ran: [], ms: Date.now() - startedAt };
  }

  // 内存兜底（正常退出 / 收到信号）+ 磁盘备份（被强杀）。两者都要：
  // 前者快，后者是 Windows 上唯一有效的那层。
  pending.set(filePath, original);
  armPendingRecord(filePath, original);
  const origLines = original.split("\n");
  const ran = [];
  for (const m of mutants) {
    fs.writeFileSync(filePath, m.source, "utf8");
    let killed;
    let diag;
    try {
      diag = { outputs: [] };
      killed = !testsPassAll(target, undefined, undefined, diag);
      // 变异 diff（原行 vs 变异行）：变异只改一处、行数不变，按行号直接对齐。
      if (m.line !== undefined) {
        const idx = m.line - 1;
        diag.diff =
          `- ${m.line} | ${(origLines[idx] ?? "").trim()}\n` +
          `+ ${m.line} | ${(m.source.split("\n")[idx] ?? "").trim()}`;
      }
    } finally {
      restoreSource(filePath, original);
    }
    ran.push({ op: m.op, killed, siteCount: m.siteCount, line: m.line, diag });
    process.stdout.write(killed ? "." : "X");
  }
  pending.delete(filePath);
  process.stdout.write("\n");

  if (fs.readFileSync(filePath, "utf8") !== original) {
    console.error(`严重：${target.file} 未还原！`);
    process.exit(2);
  }
  clearPendingRecord(filePath);
  return { target, baselineFailed: false, ran, ms: Date.now() - startedAt, siteTotal };
}

if (listOnly) process.exit(0);

// worker 模式（--no-report）：报告/summary/漂移检查全部归父进程聚合后做一次，
// 子进程只交结果。这里打印结果行后即退，后面整段报告都不属于子进程。
if (noReport) {
  for (const r of results) {
    if (resultJson) process.stdout.write(`##MUTATION_RESULT##${JSON.stringify(r)}\n`);
  }
  process.exit(0);
}

// ---- 报告 ----
console.log("");
const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;
let totalKilled = 0;
let totalRan = 0;
// 单点变异（siteCount === 1）被杀死 = 该位点确实有断言。
// 聚合变异（siteCount > 1）被杀死只证明「至少一处有覆盖」，其余处仍未验证。
let strictKilled = 0;
let aggregateKilled = 0;
let unverifiedSites = 0;
let totalSites = 0;
const survivors = [];
const baselineFailures = results.filter((r) => r.baselineFailed);

for (const r of results) {
  if (r.baselineFailed) {
    console.log(`${r.target.file}\n  基线失败，无结论\n`);
    continue;
  }
  const killed = r.ran.filter((m) => m.killed).length;
  totalKilled += killed;
  totalRan += r.ran.length;
  totalSites += r.siteTotal ?? 0;
  for (const m of r.ran) {
    if (m.siteCount === 1) {
      if (m.killed) strictKilled += 1;
    } else if (m.killed) {
      aggregateKilled += 1;
      // 聚合变异身上：只有「至少一处」被证明，其余 siteCount-1 处没被逐点验证。
      unverifiedSites += m.siteCount - 1;
    }
  }
  const rate = r.ran.length === 0 ? 0 : Math.round((killed / r.ran.length) * 100);
  // Per-mutation cost = (1 baseline + N mutants) vitest subprocesses, so the
  // wall clock is dominated by process startup, not by the assertions. The
  // timing column exists to keep that visible: a target whose per-mutant cost
  // balloons is a candidate for `tier` re-sorting or dropping into the
  // slow-only tier.
  console.log(`${r.target.file}   杀死 ${killed}/${r.ran.length}（${rate}%）   ${fmtMs(r.ms ?? 0)}`);
  const survived = r.ran.filter((m) => !m.killed);
  if (survived.length > 0) {
    console.log(
      `  存活：${survived
        .map((m) => (m.line ? `${m.op} @${m.line} 行` : `${m.op}(聚合 ${m.siteCount} 处)`))
        .join(", ")}`,
    );
    for (const m of survived) {
      survivors.push({ file: r.target.file, op: m.op, line: m.line, siteCount: m.siteCount });
      // 存活的多位于变异：它压掉的每一处都没被证明
      if (m.siteCount > 1) unverifiedSites += m.siteCount;
      // 存活诊断：变异体跑测试时捕获的输出尾部 + 变异 diff。
      // 存活 = 测试在变异下全绿 —— 打印「绿报告说了什么」和「改了哪一行」，
      // 让「为什么没杀死」（平台差异 / 断言盲区 / 等价）可以远程判读，
      // 不再需要猜。本地与 CI 的判定分歧（path-policy @92 案）就是靠它定位的。
      if (m.diag) {
        if (m.diag.diff) console.log(`    ${m.diag.diff.split("\n").join("\n    ")}`);
        for (const o of m.diag.outputs ?? []) {
          const mark = o.failed ? "失败输出" : "通过输出";
          console.log(`    ── ${o.file}（${mark}${o.status !== undefined ? ` status=${o.status}` : ""}）──`);
          if (o.tail) console.log(`    ${o.tail.split("\n").join("\n    ")}`);
        }
      }
    }
  }
}

const overall = totalRan === 0 ? 0 : Math.round((totalKilled / totalRan) * 100);
const totalMs = results.reduce((sum, r) => sum + (r.ms ?? 0), 0);
console.log(`\n总计：杀死 ${totalKilled}/${totalRan}（${overall}%）   耗时 ${fmtMs(totalMs)}`);
console.log(`  其中 单点杀死 ${strictKilled} · 聚合杀死 ${aggregateKilled}`);

// ⚠️ 这一行是本次改动的核心：把「这个百分比究竟证明了什么」写清楚。
// 聚合口径下 100% 只意味着「每个算子里至少有一处被覆盖」，不等于每处都被覆盖。
if (mode === "aggregate" && totalSites > 0) {
  const covered = totalSites - unverifiedSites;
  const pct = Math.round((covered / totalSites) * 100);
  console.log(
    `口径：aggregate —— 源码共 ${totalSites} 处位点，本次**逐点证明**了约 ${covered} 处（${pct}%），` +
      `其余 ${unverifiedSites} 处只落在"至少一处被覆盖"的聚合变异里，未单独验证。`,
  );
  console.log(`     要拿到「每一处都有断言」的结论，跑：npm run mutation:site（成本约 3.5 倍）`);
} else if (mode === "site") {
  console.log(`口径：site —— 本次为**逐位点**判定，${totalRan} 个变异各自只改一处。`);
}

// 最慢的三个目标点名 —— 全量跑一次要几分钟，瓶颈通常集中在一两个目标。
const slowest = [...results].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 3);
if (slowest.length > 0 && slowest[0].ms > 0) {
  console.log(
    `最慢：${slowest
      .filter((r) => (r.ms ?? 0) > 0)
      .map((r) => `${r.target.file} ${fmtMs(r.ms)}`)
      .join(" · ")}`,
  );
}

// 基线漂移检查（只在 site 口径下有意义 —— aggregate 本来就不逐点验证）。
//
// 这一段实现的是文件头从 2026-09 起就承诺、但一直**只存在于注释里**的那条
// 退出码（2026-10-05 核实：SITE_BASELINE 全仓只出现在注释里）。
//
// ⚠️ 口径与 `site-baseline.mjs` 有一处**刻意的不对称**：这里只在 `was < now`（位点变多）
// 时报错，因为"新位点没人验证过"才是本文件要防的事，位点变少是重构或等价变异收口；
// 而 `npm run mutation:baseline`（verify 的静态段）对**任何**不等都红 —— 它的职责是让
// 基线始终是实物的镜像，位点变少也要有人显式 `--write` 认一次。两边都不是误报。
//
// 为什么必须在**报告之后**判：漂移不影响"这次的变异有没有被杀死"，它说的是
// "被验证的那批位点，和源码里现在的位点，是不是同一批"。放在存活检查之后，
// 是为了让最严重的两个原因（存活变异 / 基线测试失败）先报出来。
// GitHub Actions 的 job 对外只有绿/红一个 bit，而这次运行真正的产出是
// 「杀死 N/M」和存活清单 —— 写进 $GITHUB_STEP_SUMMARY，让人在 job 页面直接
// 读到数字，不必去翻 log（log 要登录才能取，且 job 被 timeout 掐掉时它最有用
// 的那部分会一起丢）。
//
// 放在脚本里而不是 workflow 里：只有这里知道自己的口径（aggregate 的"全杀"
// 不等价于 site 的"每处都验过"）与存活清单的格式。workflow 保持只认
// `npm run mutation:audit`，不复制日志格式。
/**
 * 把一条失败写成 GitHub Actions **注解**。
 *
 * 为什么需要它（2026-10-23 实弹）：job 的日志正文匿名读不到（`GET …/jobs/{id}/logs`
 * → 403），而"哪几处位点活着"此前只写在 step summary 与日志里 —— 维护者不在场、
 * 手上没有 token 时拿不到结论，只能靠人把日志贴回来。注解走 checks API，公开仓库
 * 无需 admin 即可读（README 里 release.yml 的打包诊断用的就是同一条通道）。
 *
 * 只在 Actions 里发（本机跑纯噪声）。单步注解有上限（约 10 条），超出的仍在
 * summary 与日志里 —— 注解是**旁证通道**，不改变判定。
 */
function annotateFailure(message, file, line) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const hasFile = typeof file === "string" && file !== "";
  const loc = hasFile ? ` file=${file}${line ? `,line=${line}` : ""}` : "";
  const text = String(message).replace(/\r?\n/g, " ").slice(0, 320);
  console.log(`::error${loc}::${text}`);
}

function writeStepSummary(verdict, extra) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  const lines = [
    `杀死 ${totalKilled}/${totalRan}（${overall}%）· 耗时 ${fmtMs(totalMs)}`,
    `口径 ${mode} · 本次参与 ${results.length} 个目标${
      shardCount > 1 ? ` · 分片 ${shardIndex}/${shardCount}` : ""
    }`,
    ...extra,
  ];
  try {
    fs.appendFileSync(
      p,
      `## 变异审计（${mode} 口径）\n\n**${verdict}**\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`,
    );
  } catch (e) {
    // summary 是给人读的旁证，写不进去不能反过来让门禁失明。
    console.error(`（job summary 写入失败：${e.message} —— 不影响本次判定）`);
  }
}

if (mode === "site") {
  const drifted = [];
  for (const r of results) {
    if (r.baselineFailed) continue; // 基线失败已经单独报过了，别混进漂移
    const now = r.siteTotal ?? 0;
    const was = SITE_BASELINE[r.target.file];
    if (was === undefined) drifted.push({ file: r.target.file, was: "缺失", now });
    else if (was < now) drifted.push({ file: r.target.file, was, now });
  }
  if (drifted.length > 0) {
    console.error(`\nFAIL: ${drifted.length} 个目标的位点数比逐位点审计基线多 —— 这些新位点**没人逐点验证过**：`);
    for (const d of drifted) console.error(`  ${d.file}  基线 ${d.was} → 当前 ${d.now}`);
    console.error(
      "\n「全部 N 处位点已逐点验证」这句话只有在 N 与上次审计一致时才成立：\n" +
        "位点涨了却仍然 PASS，等于" +
        '"每个位点都验过了"的假象。\n' +
        "处置：跑 `npm run mutation:audit` 确认新位点也全杀，\n" +
        "      然后 `node scripts/site-baseline.mjs --write` 更新基线并提交。\n",
    );
    writeStepSummary(
      `FAIL · ${drifted.length} 个目标的位点数比基线多`,
      drifted.map((d) => `${d.file}  基线 ${d.was} → 当前 ${d.now}`),
    );
    process.exit(1);
  }
}

// 基线失败必须 FAIL，而不是"无结论"然后照常 PASS。
//
// 曾经是后者：目标被静默跳过、不计入 totalRan、门禁照样绿。后果是**这个目标
// 完全没有门禁**却看不出来 —— 测试文件路径写错、测试被改坏、源码有语法错误，
// 三种情况都会让整块覆盖静默归零。这与「CI 里写错路径、从来没跑过的 job」同族。
if (baselineFailures.length > 0) {
  console.error(`\nFAIL: ${baselineFailures.length} 个目标的基线测试未通过 —— 这些目标**完全没被验证**：`);
  for (const r of baselineFailures) {
    console.error(`  ${r.target.file}  ::  ${testFilesOf(r.target).join(", ")}`);
    annotateFailure(
      `基线测试未通过：${r.target.file}（${testFilesOf(r.target).join(", ")}）—— 该目标完全没被验证`,
      r.target.file,
      0,
    );
  }
  console.error(
    "\n基线失败的常见原因：测试文件路径写错 / 测试被改坏 / 被测源码有语法错误。\n" +
      "不要让它跳过就算了 —— 那等于这个目标从来没有门禁。\n",
  );
  writeStepSummary(
    `FAIL · ${baselineFailures.length} 个目标的基线测试未通过`,
    baselineFailures.map((r) => `${r.target.file}  ::  ${testFilesOf(r.target).join(", ")}`),
  );
  process.exit(1);
}

if (survivors.length > MAX_SURVIVORS) {
  console.error(`\nFAIL: ${survivors.length} 个变异存活 —— 这些行为没有断言覆盖：`);
  for (const s of survivors) {
    const where = s.line ? `@${s.line} 行` : `(聚合 ${s.siteCount} 处)`;
    annotateFailure(`变异存活：${s.file} :: ${s.op} ${where}`, s.file, s.line ?? 0);
    console.error(`  ${s.file}  ::  ${s.op} ${where}`);
  }
  console.error(
    "\n处置：给对应行为补断言；若确认是等价变异（语义未变），" +
      "在 EQUIVALENT_SITES 里加白名单并附理由。\n" +
      (mode === "site"
        ? ""
        : "提示：这是 aggregate 口径。若存活项标着「聚合 N 处」，用 --audit 逐点定位是哪一处。\n"),
  );
  writeStepSummary(
    `FAIL · ${survivors.length} 个变异存活`,
    survivors.map((s) => `${s.file}  ::  ${s.op} ${s.line ? `@${s.line} 行` : `(聚合 ${s.siteCount} 处)`}`),
  );
  process.exit(1);
}

// PASS 也要分清口径 —— 「无存活」在两种口径下证明力不同。
if (mode === "site") {
  console.log(
    `\nPASS: 无存活变异 —— 全部 ${totalRan} 处位点已**逐点**验证（每处单独变异都被断言发现）。`,
  );
} else {
  console.log("\nPASS: 无存活变异 —— 每个算子至少有一处被断言覆盖。");
  if (unverifiedSites > 0) {
    console.log(
      `  ⚠️ 这是 aggregate 口径：${totalSites} 处位点里约 ${unverifiedSites} 处**未逐点验证**，` +
        `不能读成"每一处都有断言"。`,
    );
    console.log(`     需要完整结论时跑：npm run mutation:site`);
  }
}

writeStepSummary(
  "PASS · 无存活变异",
  mode === "site"
    ? [`全部 ${totalRan} 处位点已逐点验证（每处单独变异都被断言发现）`]
    : [
        "每个算子至少有一处被断言覆盖",
        ...(unverifiedSites > 0
          ? [
              `⚠️ aggregate 口径：${totalSites} 处位点里约 ${unverifiedSites} 处未逐点验证，不能读成"每一处都有断言"`,
            ]
          : []),
      ],
);
