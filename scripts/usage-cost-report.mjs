/**
 * 跨 run / 跨项目的 token 成本报告（C4 · 2026-10-24）。
 *
 * 数据源是**落盘凭据**，两种给法（可同时给）：
 *   --store=<projects.json>    桌面项目库：每个项目读**最新一份**凭据（label = 项目名）
 *   --receipts=<dir|file>      凭据 JSON 文件（headless/导出产物），目录则按名序收 *.json
 *
 * 为什么读凭据而不是审计：用量是 run 级的，持久事实只有凭据里那份 `usage`
 * （`byModel` 明细 2026-10-24 起随凭据落盘）；审计里没有用量字段。
 *
 * `--selftest` 用合成凭据核对判据（不碰盘上的任何真实数据）。
 *
 * ⚠️ 统计逻辑在 `electron/usage-cost.ts`（纯函数，进变异门禁），脚本读的是
 * `dist-electron` 的构建产物 —— 所以**跑它之前要先 `npm run build`**。
 * 不在这里复制一份统计实现：两份实现会各自漂移，而漂移没人测得到。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function args() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a === "--selftest") out.selftest = "1";
  }
  return out;
}

function loadModule() {
  const built = path.join(ROOT, "dist-electron", "electron", "usage-cost.js");
  if (!fs.existsSync(built)) {
    console.error(
      `FAIL: 找不到构建产物 ${path.relative(ROOT, built)} —— 先跑 npm run build。\n` +
        "（统计逻辑只有一份实现，在 TS 侧；脚本刻意不复制它。）",
    );
    process.exit(2);
  }
  return require(built);
}

/** 项目库 → 凭据输入：没有 receiptJson 的项目不产生输入（从没跑过 ≠ 解析失败）。 */
function inputsFromStore(storePath) {
  const projects = JSON.parse(fs.readFileSync(storePath, "utf8"));
  if (!Array.isArray(projects)) {
    console.error(`FAIL: 项目库不是数组：${storePath}`);
    process.exit(2);
  }
  return projects
    .filter((p) => p && typeof p.receiptJson === "string")
    .map((p) => ({ label: typeof p.name === "string" && p.name ? p.name : p.id, receiptJson: p.receiptJson }));
}

/** 凭据文件（单个或目录下按名序的 *.json）→ 凭据输入。 */
function inputsFromReceipts(target) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(target, f))
    : [target];
  return files.map((f) => ({ label: path.basename(f), receiptJson: fs.readFileSync(f, "utf8") }));
}

function selftest(mod) {
  const receipt = (usage) =>
    JSON.stringify({ outcome: "delivered", verified: true, rounds: 0, checks: [], tasks: [], conflicts: [], usage });
  const inputs = [
    { label: "b-proj", receiptJson: receipt({ totalTokens: 70, calls: 2, measuredCalls: 1, byModel: { "sensenova/glm-5.2": 70 } }) },
    { label: "a-proj", receiptJson: receipt({ totalTokens: 30, calls: 3, measuredCalls: 3, byModel: { "coze/worker": 30 } }) },
    { label: "broken", receiptJson: "{not json" },
  ];
  const s = mod.summarizeUsageCost(inputs);
  const failures = [];
  if (s.receipts !== 2) failures.push(`凭据=${s.receipts}（期望 2）`);
  if (s.broken !== 1) failures.push(`解析失败=${s.broken}（期望 1）`);
  if (s.totalTokens !== 100) failures.push(`总量=${s.totalTokens}（期望 100）`);
  // 只有 1 次调用没上报 ⇒ 可信边界必须是 1，不是丢掉。
  if (s.unmetered !== 1) failures.push(`未上报=${s.unmetered}（期望 1）`);
  // 模型排名按 token 降序；项目行按 label 升序（a 在 b 前）。
  if (s.byModel[0].key !== "sensenova/glm-5.2") failures.push(`模型榜首=${s.byModel[0] && s.byModel[0].key}（期望 sensenova/glm-5.2）`);
  if (s.byProject[0].label !== "a-proj") failures.push(`项目首行=${s.byProject[0] && s.byProject[0].label}（期望 a-proj）`);
  const lines = mod.formatUsageCostReport(s);
  if (lines.length === 0) failures.push("报告为空");
  if (!lines.some((l) => l.includes("按任务的归因今天不存在"))) failures.push("缺按任务不可归因的边界行");
  if (failures.length > 0) {
    console.error("FAIL: usage-cost 自检未通过：\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("PASS: usage-cost 自检通过（" + lines.length + " 行报告）");
}

const opts = args();
const mod = loadModule();

if (opts.selftest) {
  selftest(mod);
  process.exit(0);
}

const inputs = [];
if (opts.store) {
  if (!fs.existsSync(opts.store)) {
    console.error(`FAIL: 项目库不存在：${opts.store}`);
    process.exit(2);
  }
  inputs.push(...inputsFromStore(opts.store));
}
if (opts.receipts) {
  if (!fs.existsSync(opts.receipts)) {
    console.error(`FAIL: 凭据路径不存在：${opts.receipts}`);
    process.exit(2);
  }
  inputs.push(...inputsFromReceipts(opts.receipts));
}
if (inputs.length === 0) {
  console.error(
    "用法：node scripts/usage-cost-report.mjs --store=<projects.json> [--receipts=<dir|file>] [--selftest]\n" +
      "（至少给一个数据源；项目库路径通常在 <userData>/store/projects.json）",
  );
  process.exit(2);
}

const summary = mod.summarizeUsageCost(inputs);
for (const line of mod.formatUsageCostReport(summary)) console.log(line);
