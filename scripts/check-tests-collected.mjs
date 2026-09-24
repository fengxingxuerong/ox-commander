/**
 * 门禁：检测「盘上有、但 vitest 根本不收集」的测试文件 —— 从来没跑过的测试。
 *
 * 为什么需要它：本仓库已经踩过一次「漏挂测试文件」（一个模块有两份测试，没被挂上的
 * 那份断言完全不参与判定），而 `vitest.config.mts:16` 的 `include` 现在**不含 `headless/`**，
 * 同时 `coverage.include` 却含 `headless/**`。也就是说：今天往 `headless/` 下写一个
 * `*.test.ts`，它会 ① 从不被执行 ② 让 headless 的覆盖率凭空变高（未覆盖也算"统计过"）。
 * 两份数字都好看，而那里的断言一个都没跑过 —— 比没有测试更误导。
 *
 * 与 `check-script-wiring.mjs`（写好的脚本没接进入口）是同一族缺陷，差别只是载体不同：
 * 那边是「只跑过一次」，这边是「一次都没跑过」。所以沿用同一套约定：
 * 要么接进收集范围，要么进 ACCEPTED 白名单写清理由。
 *
 * 判定口径：**实际收集集合**，不是"我按 glob 推断它应该被收集"。
 * 收集集合取自 `vitest list --filesOnly`（6s）。这里刻意不自己解析
 * `vitest.config.mts` 的 include 再做 glob 匹配 —— 那样必须重新实现 picomatch 的
 * 语义（`**` 是否跨目录、前导 `./`、Windows 反斜杠），任何一点偏差都会让门禁的
 * 判据与 vitest 的真实行为分叉，而分叉正是本文件要消灭的东西。
 *
 * ⚠️ 收集过程失败必须 FAIL，不能当作"没有未收集项"放过：vitest 起不来时
 * `--filesOnly` 会输出空集合，若把空集合当通过，这道门禁就变成了一个永远绿、
 * 且让人以为"测试文件都挂上了"的摆设（基线失败被静默容忍的同一类空转）。
 *
 * 用法：node scripts/check-tests-collected.mjs
 *       node scripts/check-tests-collected.mjs --list   # 打印每个测试文件的状态
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 测试文件可能出现的目录。`scripts/` 也在内：那里有用 node:test 写的验收套件。 */
const CANDIDATE_DIRS = ["src", "shared", "electron", "headless", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "dist-headless",
  "coverage",
  "release",
  ".git",
  ".ox-quarantine",
]);
const TEST_FILE = /\.test\.(?:ts|tsx|js|mjs|cjs)$/;

/**
 * 已评审、明确接受「不被 vitest 收集」的测试文件。
 *
 * 加项前必须能说清**它靠什么跑**（多数是另一套 runner：node:test、人工验收）。
 * 说不清就该把它挪进 vitest 的 include，而不是加进这里。
 */
const ACCEPTED_ENTRIES = [
  [
    "scripts/acceptance/csvstat-acceptance.test.js",
    "独立验收套件**模板**（见同目录 README）：用 node:test 写的，require 的是被验收项目的 " +
      "scripts/src/{core,report,cli}，本仓库没有那几个文件，它在本仓库里跑不起来；" +
      "由验收方拷进目标项目后手动 `node --test` 跑。它不是本仓库的门禁，是本仓库的样板。",
  ],
];

/** 同 check-script-wiring：`new Map()` 对重复键静默覆盖，理由会凭空消失。 */
const duplicateAccepted = ACCEPTED_ENTRIES.map(([k]) => k).filter((k, i, all) => all.indexOf(k) !== i);
const ACCEPTED = new Map(ACCEPTED_ENTRIES);

const listOnly = process.argv.includes("--list");

// ---- ① 盘上的候选测试文件 -------------------------------------------------
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), out);
      continue;
    }
    if (e.isFile() && TEST_FILE.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const onDisk = CANDIDATE_DIRS.flatMap((d) => collect(path.join(ROOT, d)))
  .map((p) => path.relative(ROOT, p).replace(/\\/g, "/"))
  .sort();

// ---- ② vitest 实际收集的文件 -----------------------------------------------
function runVitestList() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const r = await runVitestList();
const collected = new Set(
  r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // vitest 会打印进度/统计行，只收看起来像路径的行（以某个候选目录开头）
    .filter((l) => CANDIDATE_DIRS.some((d) => l === d || l.startsWith(`${d}/`)))
    .map((l) => l.replace(/\\/g, "/")),
);

const notCollected = onDisk.filter((f) => !collected.has(f));

if (listOnly) {
  console.log("=== 被 vitest 收集 ===");
  for (const f of [...collected].sort()) console.log(`  ${f}`);
  console.log(`\n=== 未被收集（${notCollected.length}）===`);
  for (const f of notCollected) {
    const reason = ACCEPTED.get(f);
    console.log(`  ${f.padEnd(46)} ${reason ? `已接受：${reason}` : "✗ 未接受"}`);
  }
  process.exit(0);
}

// 基线失败先报：收集不到任何文件 == vitest 起不来/配置坏了，此时"未收集 0 个"毫无意义。
if (r.code !== 0 || collected.size === 0) {
  console.error(
    `FAIL: \`vitest list --filesOnly\` 没产出任何文件（exit=${r.code}）—— ` +
      "收集过程本身坏了，本门禁的判定不可用。\n" +
      "不允许把它当成「没有未收集项」放过：那样这道门禁永远绿，而它承诺的事情一件也没查。\n",
  );
  if (r.err.trim()) console.error(r.err.trim().split(/\r?\n/).slice(-15).join("\n"));
  process.exit(1);
}

console.log(`测试文件收集检查：盘上 ${onDisk.length} 个，vitest 收集 ${collected.size} 个`);

if (duplicateAccepted.length > 0) {
  console.error(`\nFAIL: ACCEPTED 里有 ${duplicateAccepted.length} 个重复键 —— Map 静默覆盖，只有一条理由生效：`);
  for (const k of duplicateAccepted) console.error(`  ${k}`);
  process.exit(1);
}

const stale = [...ACCEPTED.keys()].filter((k) => !notCollected.includes(k));
if (stale.length > 0) {
  console.error(
    `\nFAIL: ACCEPTED 里有 ${stale.length} 条已失效（该测试文件已被收集，或已不存在）—— 请删除：`,
  );
  for (const k of stale) console.error(`  ${k}`);
  console.error("\n白名单腐烂比白名单缺失更糟：它会让人以为这里已经被维护过。\n");
  process.exit(1);
}

const unaccepted = notCollected.filter((f) => !ACCEPTED.has(f));
if (unaccepted.length > 0) {
  console.error(`\nFAIL: ${unaccepted.length} 个测试文件 vitest 根本不收集 —— 它们一次都没跑过：`);
  for (const f of unaccepted) console.error(`  ${f}`);
  console.error(
    "\n后果：那里的断言不参与任何判定，而 `coverage.include` 可能仍然统计它的源码目录，\n" +
      "于是覆盖率数字照涨、门禁照绿。\n\n处置二选一：\n" +
      "  1. 让 vitest 收集它 —— 往 `vitest.config.mts` 的 `test.include` 加对应 glob；\n" +
      "  2. 若它靠另一套 runner（node:test / 人工验收）跑，加进本文件的 ACCEPTED 并写明靠什么跑。\n",
  );
  process.exit(1);
}

console.log("\nPASS: 每个测试文件要么被 vitest 收集，要么已显式登记由另一套 runner 执行");
