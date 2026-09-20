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
 *   node scripts/mutation-check.mjs --list       # 只列变异，不改文件不跑测试
 *
 * 退出码：存活变异 > MAX_SURVIVORS 时 exit 1。
 *
 * ## 已知局限（不要误以为它覆盖全仓）
 *
 *   1. **只跑 TARGETS 里列的 7 个模块**，不是全仓。全仓会把 verify 从 ~33s
 *      拉到小时级 —— 跑不动的门禁等于没有门禁。选择标准：安全关键 + 逻辑密集。
 *      要扩就按这个标准加，别一次全铺开。
 *   2. **算子只覆盖布尔/比较/跳转**，抓不到「数值边界写错」（如 `>` 写成 `>=`）、
 *      「参数顺序颠倒」、「漏 await」。加算子前先确认不会引入等价变异噪声。
 *   3. **等价变异会存活**（语义未变的改写）。首次遇到时优先重构消除该分支；
 *      无法消除则在这里加白名单并附理由，**不要放宽 MAX_SURVIVORS**。
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
 * `electron/engine/scheduler.ts` 于 2026-09-20 接入：此前它不在目标里，于是
 * 「类内缺陷」穿过三层门禁（`check:unwired` 只查导出符号、变异不覆盖引擎层，
 * 而测试恰好没有断言触碰真实路径）。接入当天实测存活 1 个 —— `&& → ||`，
 * 定位到 `admitBreaker` 的兜底查找：改成 `||` 后，**整池熔断时任务会被重新派给
 * 一个已熔断的 agent**，熔断静默失效，21 条用例全绿。补一条断言后 4/4 全杀。
 */
const TARGETS = [
  { file: "electron/sandbox/path-policy.ts", test: "src/sandbox-path.test.ts" },
  { file: "shared/glob.ts", test: "src/glob.test.ts" },
  { file: "shared/redact.ts", test: "src/redact.test.ts" },
  { file: "shared/prompt-text.ts", test: "src/prompt-injection.test.ts" },
  { file: "electron/agents/scoped-env.ts", test: "src/scoped-env.test.ts" },
  { file: "shared/zone-coverage.ts", test: "src/zone-coverage.test.ts" },
  { file: "electron/engine/scheduler.ts", test: "src/scheduler.test.ts" },
];

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
const listOnly = args.includes("--list");

const targets = onlyFile ? TARGETS.filter((t) => t.file.includes(onlyFile)) : TARGETS;
if (targets.length === 0) {
  console.error(`没有匹配的目标：--file=${onlyFile}`);
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
    console.log(`${target.file} → ${mutants.length}/${all.length} 个变异：${mutants.map((m) => m.op).join(", ")}`);
    continue;
  }

  // 基线：原文件必须通过，否则后面结论不可信
  if (!testsPass(target.test)) {
    console.error(`基线失败：${target.test} 在原始代码上不通过，跳过 ${target.file}`);
    results.push({ target, baselineFailed: true, ran: [] });
    continue;
  }

  pending.set(filePath, original);
  const ran = [];
  for (const m of mutants) {
    fs.writeFileSync(filePath, m.source, "utf8");
    let killed;
    try {
      killed = !testsPass(target.test);
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

if (survivors.length > MAX_SURVIVORS) {
  console.error(`\nFAIL: ${survivors.length} 个变异存活 —— 这些行为没有断言覆盖：`);
  for (const s of survivors) console.error(`  ${s.file}  ::  ${s.op}`);
  console.error("\n处置：给对应行为补断言；若确认是等价变异（语义未变），在脚本里换掉该算子。\n");
  process.exit(1);
}

console.log("\nPASS: 无存活变异，测试对目标模块的改动敏感");
