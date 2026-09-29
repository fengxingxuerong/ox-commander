/**
 * zone 互斥的代价报告（可复现）。
 *
 * 输入是**审计事实**（`<userData>/audit/*.jsonl`）—— 不是引擎内存推送，因为内存
 * 推送重载即消失，而"这套互斥到底拦下过什么、切了几刀串行"要跨运行对比才有意义。
 *
 * 用法：
 *   node scripts/zone-cost-report.mjs --audit=<dir> [--batches=<tasks.json>] [--selftest]
 *
 * `--batches` 是 `planBatches` 的产物（`Task[][]` 的 JSON），给得出就多打一行
 * 并行度代价；给不出也不影响其余数字（那两件事本来就该分开看：
 * 批次是预防，越权是漏网）。
 *
 * ⚠️ 统计逻辑在 `electron/zone-cost.ts`（纯函数，进变异门禁），脚本读的是
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

/** 审计目录里的 JSONL，按文件名排序（与 AuditLog.files() 同序：oldest first）。 */
function auditFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => path.join(dir, f));
}

function readRecords(files) {
  const records = [];
  let broken = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 坏行要说出来：静默跳过会让"这一段历史丢了"看起来像"这一段没发生过"。
        broken += 1;
      }
    }
  }
  return { records, broken };
}

function loadModule() {
  const built = path.join(ROOT, "dist-electron", "electron", "zone-cost.js");
  if (!fs.existsSync(built)) {
    console.error(
      `FAIL: 找不到构建产物 ${path.relative(ROOT, built)} —— 先跑 npm run build。\n` +
        "（统计逻辑只有一份实现，在 TS 侧；脚本刻意不复制它。）",
    );
    process.exit(2);
  }
  return require(built);
}

function selftest(mod) {
  const records = [
    { ts: "t1", phase: "run-start", taskId: "a" },
    { ts: "t2", phase: "run-end", taskId: "a", ok: true },
    { ts: "t3", phase: "run-start", taskId: "b" },
    {
      ts: "t4",
      phase: "batch-guard",
      ok: false,
      conflictKind: "unauthorized-write",
      remedy: "revert",
      paths: ["outside/x.js"],
    },
    {
      ts: "t5",
      phase: "batch-guard",
      ok: false,
      conflictKind: "unauthorized-write",
      remedy: "pass",
      paths: ["outside/x.js", "outside/y.js"],
    },
  ];
  const cost = mod.summarizeZoneCost(records);
  const plan = mod.planCost([[{ id: "a", zone: "src" }], [{ id: "b", zone: "tests" }]]);
  const failures = [];
  if (cost.runs !== 2) failures.push(`runs=${cost.runs}（期望 2）`);
  if (cost.conflicts.total !== 2) failures.push(`越权=${cost.conflicts.total}（期望 2）`);
  // 同一路径被两条记录命中 ⇒ 去重后是 2 个（x 与 y），不是 3 个。
  if (cost.conflicts.paths !== 2) failures.push(`路径=${cost.conflicts.paths}（期望 2）`);
  // 只有 revert 那条算"处置掉"，pass 那条文件留在原地。
  if (cost.conflicts.handledPaths !== 1) failures.push(`已处置=${cost.conflicts.handledPaths}（期望 1）`);
  if (plan.extraBatches !== 1) failures.push(`串行段=${plan.extraBatches}（期望 1）`);
  const lines = mod.formatZoneCostReport(cost, plan);
  if (lines.length === 0) failures.push("报告为空");
  if (failures.length > 0) {
    console.error("FAIL: zone-cost 自检未通过：\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("PASS: zone-cost 自检通过（" + lines.length + " 行报告）");
}

const opts = args();
const mod = loadModule();

if (opts.selftest) {
  selftest(mod);
  process.exit(0);
}

if (!opts.audit) {
  console.error("用法：node scripts/zone-cost-report.mjs --audit=<dir> [--batches=<tasks.json>] [--selftest]");
  process.exit(2);
}
if (!fs.existsSync(opts.audit)) {
  console.error(`FAIL: 审计目录不存在：${opts.audit}`);
  process.exit(2);
}

const files = auditFiles(opts.audit);
const { records, broken } = readRecords(files);
const cost = mod.summarizeZoneCost(records);

let plan;
if (opts.batches) {
  const parsed = JSON.parse(fs.readFileSync(opts.batches, "utf8"));
  plan = mod.planCost(parsed);
}

console.log(`审计文件 ${files.length} 个 · 记录 ${records.length} 条${broken > 0 ? ` · 解析失败 ${broken} 行（未计入）` : ""}`);
for (const line of mod.formatZoneCostReport(cost, plan)) console.log(line);
if (records.length === 0) {
  console.log("（没有记录：这轮没有可统计的事实 —— 零越权不等于没跑过。）");
}
