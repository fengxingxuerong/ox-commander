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
 * 脚本会**临时改写源文件**。三重保护：
 *   1. 改写前后都读原文，结束时报文比对，不一致直接 exit 2
 *   2. 每个变异用 try/finally 恢复
 *   3. 进程退出钩子兜底恢复（防 SIGINT / 异常退出留脏文件）
 *
 * ## 用法
 *
 *   node scripts/mutation-check.mjs              # 全部目标
 *   node scripts/mutation-check.mjs --file=glob
 *   node scripts/mutation-check.mjs --limit=4    # 每文件最多 4 个变异（默认 4）
 *   node scripts/mutation-check.mjs --tier=1     # 只跑 tier 1（快目标，verify 用这个）
 *   node scripts/mutation-check.mjs --list       # 只列变异（含位点数），不改文件不跑测试
 *   node scripts/mutation-check.mjs --mode=site  # **逐位点**变异（默认 aggregate，见下）
 *   node scripts/mutation-check.mjs --audit      # = --mode=site --limit=999，逐点全量
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
import { execFileSync } from "node:child_process";
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
  { file: "shared/glob.ts", test: "src/glob.test.ts", tier: 1 },
  { file: "shared/redact.ts", test: "src/redact.test.ts", tier: 1 },
  { file: "shared/prompt-text.ts", test: "src/prompt-injection.test.ts", tier: 1 },
  { file: "electron/agents/scoped-env.ts", test: "src/scoped-env.test.ts", tier: 1 },
  { file: "shared/zone-coverage.ts", test: "src/zone-coverage.test.ts", tier: 1 },
  { file: "electron/engine/scheduler.ts", test: "src/scheduler.test.ts", tier: 1 },
  // kill-tree 是超时兜底的最后一道闸：A3 加固的 fallback/二次确认分支都在
  // 这里，一个算子翻转就意味着"杀不掉的进程"回来了。纯 mock 测试，毫秒级。
  { file: "electron/sandbox/kill-tree.ts", test: "src/kill-tree.test.ts", tier: 1 },
  {
    file: "src/store.ts",
    tests: ["src/store.test.ts", "src/store-errors.test.ts", "src/ui.test.tsx"],
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
  // verifier 的断言散在三个文件：runSmokeChecks 在 verifier.test.ts，
  // verifyProject 在 sandbox-runtime / spawn-plan 两个集成测试里。
  {
    file: "electron/engine/verifier.ts",
    tests: ["src/verifier.test.ts", "src/sandbox-runtime.test.ts", "src/spawn-plan.test.ts"],
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
  { file: "electron/sandbox/circuit-breaker.ts", test: "src/sandbox-runtime.test.ts", tier: 2 },
  { file: "electron/sandbox/timeout-gate.ts", test: "src/sandbox-runtime.test.ts", tier: 2 },
  { file: "electron/sandbox/file-journal.ts", test: "src/sandbox-journal.test.ts", tier: 2 },
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
  // orchestration.ts 是任务下发主链路（规划/启动/取消/仲裁回流）。
  // 挂行为测试 + 通道契约两个文件：前者杀行为变异，后者守住 handler 注册面。
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
];

/** 聚合变异体：一次改掉该算子的**全部**位点。`replace` 带 /g 会重置 lastIndex，可复用。 */
function aggregateMutant(source, op) {
  return source.replace(op.find, op.to);
}

/** 逐位点变异体：只改 `site` 指出的那一处，其余原样。 */
function siteMutant(source, site, op) {
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
const EQUIVALENT_SITES = [
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
  { file: "electron/engine/router.ts", op: "&& → ||", line: 193 },
  // `if (!title || !command) return;` —— 改成 `&&` 后，"只缺一个字段"的 smoke 条目
  // 不再被提前 return，会带着 `undefined` 被 push 进 smoke 数组。
  //
  // 但**观察不到**：`requireString` 在缺字段时已经把问题写进 `issues`，
  // 函数末尾 `if (issues.length) throw new SchemaValidationError(issues)` 必然抛错，
  // 那个数组随之被丢弃。抛错的类型与消息在两种版本下完全一致。
  //
  // 换句话说这是"副作用发生了但被后续抛错抹掉"的等价 —— 要让它可观测，
  // 得改生产代码（例如让校验失败也回传已解析的部分），代价不对。
  { file: "shared/schema.ts", op: "|| → &&", line: 184 },
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
  { file: "electron/agents/http-bridge.ts", op: "=== → !==", line: 309 },
  /**
   * `electron/agents/sensenova-api.ts:331` `if (isSecretLikeFile(rel)) continue;`
   * 的 `continue → break` —— **可证明不可达**（一级）。
   *
   * 这一行自称"二次防线：即使上层 walk 漏过某个凭据文件，这里也不读它的正文"。
   * 但 `statEntries` **只在 `walkStat` 里被 push**（301 行），而 walk 在 298 行
   * 用**同一个纯函数 `isSecretLikeFile`** 在**同一个 `rel`** 上已经过滤过一次 ——
   * 所以进得了 `statEntries` 的条目必然不满足该谓词，这行永远不执行。
   *
   * 换句话说它是**防御性冗余**，注释里承诺的"二次防线"在当前结构下不成立。
   * 保留它没有坏处（万一将来多出别的 statEntries 来源），但门禁不该为一条
   * 不可达分支永远挂红 —— 故白名单，并把"为什么不可达"写在这里备查。
   *
   * 2026-09-23：usage 可见性轮在上方插入 14 行（meter 接线），行号 317 → 331，
   * 白名单曾因行号失配短暂失效、被全量 audit 抓到存活 —— 处置即校回行号。
   */
  { file: "electron/agents/sensenova-api.ts", op: "继续(continue) → 中断(break)", line: 331 },
  /**
   * `electron/agents/sensenova-api.ts:337` `catch { continue; }`（读文件失败）—— 二级。
   *
   * 要触发它需要「walk 阶段 statSync 成功、内容阶段 readFileSync 失败」——
   * 即两次系统调用之间文件被删（TOCTOU）。测试里构造不出确定性的触发：
   * walk 与 read 在同一个方法调用里紧邻（317 行循环调用 `readSnapshotContents`），
   * 没有任何可插桩的间隙；Windows 上也没有"可写但不可读"的稳定文件状态。
   *
   * ⚠️ 二级判定（经验性，不是证明）。若将来给该模块加 fs 注入点
   * （同 `zone-guard` / `snapshot-store` 的 `FsLike` 模式），
   * **应删掉这条白名单**并补一条注入用例 —— 那时正确做法是让分支可测。
   *
   * 2026-09-23：同上，usage 轮行号漂移 323 → 337，audit 抓到后校回。
   */
  { file: "electron/agents/sensenova-api.ts", op: "继续(continue) → 中断(break)", line: 337 },
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
   */
  { file: "electron/ipc/context.ts", op: "!== → ===", line: 177 },
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
const maxTier = Number(args.find((a) => a.startsWith("--tier="))?.slice(7) ?? "99");
const listOnly = args.includes("--list");

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

const targets = TARGETS.filter((t) => t.tier <= maxTier).filter((t) =>
  onlyFile ? t.file.includes(onlyFile) : true,
);
if (targets.length === 0) {
  console.error(`没有匹配的目标：--file=${onlyFile} --tier=${maxTier}`);
  process.exit(2);
}

/** 已改写的文件 → 原始内容。进程退出时兜底恢复。 */
const pending = new Map();
let restoring = false;

function restoreAll() {
  if (restoring) return;
  restoring = true;
  for (const [file, original] of pending) {
    try {
      fs.writeFileSync(file, original, "utf8");
    } catch {
      console.error(`无法恢复 ${file} —— 请手动执行 git checkout -- ${path.relative(ROOT, file)}`);
    }
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

for (const target of targets) {
  const startedAt = Date.now();
  const filePath = path.join(ROOT, target.file);
  const original = fs.readFileSync(filePath, "utf8");

  const excluded = EQUIVALENT_SITES.filter((e) => e.file === target.file);
  const masked = maskNonCode(original);

  // 每个算子的真实位点（只数可执行代码里的），聚合与逐位点两种口径共用。
  // ⚠️ 统计用 `perOpAll`（含 0 位点的算子）—— 否则"全部位点都在注释里"这种
  // 情况会因为过滤而丢掉"另有 N 处被排除"的提示，看起来像"这个文件没有算子"。
  const perOpAll = OPERATORS.map((op) => ({ op, ...findSites(original, masked, op) }));
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

  // 位点归零 = 这个目标对门禁**毫无贡献**（以前会静默地什么都不验证）。
  if (siteTotal === 0) {
    console.error(
      `⚠️  ${target.file} 在可执行代码里没有任何算子位点（原文命中 ${rawTotal} 处，全在注释/字符串里）` +
        `—— 该目标目前不验证任何东西。`,
    );
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
    continue;
  }

  // 基线：原文件必须通过，否则后面结论不可信。这里用长超时 —— 要的是
  // 「这套测试本来是好的」这个事实，不是「它有多快」。
  if (!testsPassAll(target, BASELINE_TIMEOUT_MS, BASELINE_VITEST_TEST_TIMEOUT_MS)) {
    console.error(`基线失败：${testFilesOf(target).join(", ")} 在原始代码上不通过，跳过 ${target.file}`);
    results.push({ target, baselineFailed: true, ran: [], ms: Date.now() - startedAt });
    continue;
  }

  pending.set(filePath, original);
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
      fs.writeFileSync(filePath, original, "utf8");
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
  results.push({ target, baselineFailed: false, ran, ms: Date.now() - startedAt, siteTotal });
}

if (listOnly) process.exit(0);

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

// 基线失败必须 FAIL，而不是"无结论"然后照常 PASS。
//
// 曾经是后者：目标被静默跳过、不计入 totalRan、门禁照样绿。后果是**这个目标
// 完全没有门禁**却看不出来 —— 测试文件路径写错、测试被改坏、源码有语法错误，
// 三种情况都会让整块覆盖静默归零。这与「CI 里写错路径、从来没跑过的 job」同族。
if (baselineFailures.length > 0) {
  console.error(`\nFAIL: ${baselineFailures.length} 个目标的基线测试未通过 —— 这些目标**完全没被验证**：`);
  for (const r of baselineFailures)
    console.error(`  ${r.target.file}  ::  ${testFilesOf(r.target).join(", ")}`);
  console.error(
    "\n基线失败的常见原因：测试文件路径写错 / 测试被改坏 / 被测源码有语法错误。\n" +
      "不要让它跳过就算了 —— 那等于这个目标从来没有门禁。\n",
  );
  process.exit(1);
}

if (survivors.length > MAX_SURVIVORS) {
  console.error(`\nFAIL: ${survivors.length} 个变异存活 —— 这些行为没有断言覆盖：`);
  for (const s of survivors) {
    const where = s.line ? `@${s.line} 行` : `(聚合 ${s.siteCount} 处)`;
    console.error(`  ${s.file}  ::  ${s.op} ${where}`);
  }
  console.error(
    "\n处置：给对应行为补断言；若确认是等价变异（语义未变），" +
      "在 EQUIVALENT_SITES 里加白名单并附理由。\n" +
      (mode === "site"
        ? ""
        : "提示：这是 aggregate 口径。若存活项标着「聚合 N 处」，用 --audit 逐点定位是哪一处。\n"),
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
