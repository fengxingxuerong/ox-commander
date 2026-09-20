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
 *   node scripts/mutation-check.mjs --list       # 只列变异，不改文件不跑测试
 *
 * 退出码：
 *   - 存活变异 > MAX_SURVIVORS → exit 1
 *   - **任何目标的基线测试未通过 → exit 1**（该目标完全没被验证，比存活更严重）
 *
 * ## 已知局限（不要误以为它覆盖全仓）
 *
 *   1. **只跑 TARGETS 里列的模块**（8 个，分 tier 1/2），不是全仓。全仓会把 verify
 *      从 ~75s 拉到小时级 —— 跑不动的门禁等于没有门禁。选择标准：安全关键 + 逻辑密集。
 *      要扩就按这个标准加，别一次全铺开；新目标若单次测试超过 ~10s，放 tier 2，
 *      否则 `verify` 会被拖慢到没人愿意跑。
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
  {
    file: "src/store.ts",
    tests: ["src/store.test.ts", "src/store-errors.test.ts", "src/ui.test.tsx"],
    tier: 1,
  },
  { file: "electron/engine/orchestrator.ts", test: "src/orchestrator.test.ts", tier: 2 },
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
 * 只保留**语义明确变化**的替换。像 `> → >=` 这类在边界值上语义相同的
 * （没有等于边界的用例时）容易产生"等价变异"—— 它们存活不代表测试有问题。
 * 所以下面优先用语义必然变化的算子。
 */
const OPERATORS = [
  { name: "&& → ||", apply: (s) => s.replaceAll("&&", "||") },
  { name: "|| → &&", apply: (s) => s.replaceAll("||", "&&") },
  { name: "=== → !==", apply: (s) => s.replaceAll("===", "!==") },
  { name: "!== → ===", apply: (s) => s.replaceAll("!==", "===") },
  { name: "return true → false", apply: (s) => s.replaceAll("return true", "return false") },
  { name: "return false → true", apply: (s) => s.replaceAll("return false", "return true") },
  { name: "继续(continue) → 中断(break)", apply: (s) => s.replaceAll(/\bcontinue;/g, "break;") },
];

const args = process.argv.slice(2);
const onlyFile = args.find((a) => a.startsWith("--file="))?.slice(7);
const limit = Number(args.find((a) => a.startsWith("--limit="))?.slice(8) ?? "4");
const maxTier = Number(args.find((a) => a.startsWith("--tier="))?.slice(7) ?? "99");
const listOnly = args.includes("--list");

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
function testsPassAll(target) {
  return testFilesOf(target).every((f) => testsPass(f));
}

/** 跑测试。返回 true = 通过（变异存活）。 */
function testsPass(testFile) {
  try {
    execFileSync(
      process.execPath,
      ["./node_modules/vitest/vitest.mjs", "run", testFile, "--reporter=dot", "--coverage.enabled=false"],
      { cwd: ROOT, stdio: "pipe", timeout: 120_000, env: { ...process.env, CI: "1" } },
    );
    return true;
  } catch {
    return false;
  }
}

const results = [];

for (const target of targets) {
  const filePath = path.join(ROOT, target.file);
  const original = fs.readFileSync(filePath, "utf8");

  const all = OPERATORS.map((op) => ({ op: op.name, source: op.apply(original) })).filter(
    (m) => m.source !== original,
  );
  const mutants = all.slice(0, limit);

  if (listOnly) {
    console.log(
      `${target.file} → ${mutants.length}/${all.length} 个变异：${mutants.map((m) => m.op).join(", ")}`,
    );
    continue;
  }

  // 基线：原文件必须通过，否则后面结论不可信
  if (!testsPassAll(target)) {
    console.error(`基线失败：${testFilesOf(target).join(", ")} 在原始代码上不通过，跳过 ${target.file}`);
    results.push({ target, baselineFailed: true, ran: [] });
    continue;
  }

  pending.set(filePath, original);
  const ran = [];
  for (const m of mutants) {
    fs.writeFileSync(filePath, m.source, "utf8");
    let killed;
    try {
      killed = !testsPassAll(target);
    } finally {
      fs.writeFileSync(filePath, original, "utf8");
    }
    ran.push({ op: m.op, killed });
    process.stdout.write(killed ? "." : "X");
  }
  pending.delete(filePath);
  process.stdout.write("\n");

  if (fs.readFileSync(filePath, "utf8") !== original) {
    console.error(`严重：${target.file} 未还原！`);
    process.exit(2);
  }
  results.push({ target, baselineFailed: false, ran });
}

if (listOnly) process.exit(0);

// ---- 报告 ----
console.log("");
let totalKilled = 0;
let totalRan = 0;
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
  const rate = r.ran.length === 0 ? 0 : Math.round((killed / r.ran.length) * 100);
  console.log(`${r.target.file}   杀死 ${killed}/${r.ran.length}（${rate}%）`);
  const survived = r.ran.filter((m) => !m.killed);
  if (survived.length > 0) {
    console.log(`  存活：${survived.map((m) => m.op).join(", ")}`);
    for (const m of survived) survivors.push({ file: r.target.file, op: m.op });
  }
}

const overall = totalRan === 0 ? 0 : Math.round((totalKilled / totalRan) * 100);
console.log(`\n总计：杀死 ${totalKilled}/${totalRan}（${overall}%）`);

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
  for (const s of survivors) console.error(`  ${s.file}  ::  ${s.op}`);
  console.error("\n处置：给对应行为补断言；若确认是等价变异（语义未变），在脚本里换掉该算子。\n");
  process.exit(1);
}

console.log("\nPASS: 无存活变异，测试对目标模块的改动敏感");
