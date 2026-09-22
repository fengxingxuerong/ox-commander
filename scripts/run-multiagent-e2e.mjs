/**
 * Multi-agent E2E: the OxCommander commander (SenseNova deepseek-v4-flash)
 * plans a two-module project, then dispatches by capability — the src/loomy
 * zone task MUST be routed to the external "Loomy 工程师" HTTP-bridge agent,
 * the rest to the builtin SenseNova executor. Verification runs real
 * build/typecheck/test in the temp workspace.
 *
 * Prereq: node scripts/loomy-bridge.mjs already listening on 127.0.0.1:8931.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const WORKSPACE_SCRIPTS = {
  "build.js": [
    "const { execFileSync } = require('node:child_process');",
    "let failed = 0;",
    "for (const f of require('node:fs').readdirSync('src')) {",
    "  if (!f.endsWith('.js')) continue;",
    "  try { new (require('node:vm').Script)(require('node:fs').readFileSync(`src/${f}`, 'utf8'), { filename: f }); } catch (e) { console.error(`${f}: ${e.message}`); failed++; }",
    "}",
    "if (failed) process.exit(1);",
    "console.log('syntax check passed');",
  ].join("\n"),
  "test.js": [
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "// 递归收集 tests/ 下所有 *.test.js（含子目录）—— 兼容 planner 发明的子目录布局",
    "const files = [];",
    "(function walk(d) {",
    "  if (!fs.existsSync(d)) return;",
    "  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {",
    "    const p = path.join(d, entry.name);",
    "    if (entry.isDirectory()) walk(p);",
    "    else if (entry.name.endsWith('.test.js')) files.push(p);",
    "  }",
    "})('tests');",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, f], { stdio: 'inherit' });",
    "  if (r.status !== 0) process.exit(r.status ?? 1);",
    "}",
  ].join("\n"),
};

function ensureWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ["src", "tests"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "ox-multiagent-it",
        version: "0.0.0",
        private: true,
        scripts: {
          build: "node ox-scripts/build.js",
          typecheck: "node ox-scripts/build.js",
          test: "node ox-scripts/test.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    fs.mkdirSync(path.join(dir, "ox-scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ox-scripts", name), content, "utf8");
  }
}

if (!process.env.SENSENOVA_API_KEY) {
  console.log("SKIP: no SENSENOVA_API_KEY");
  process.exit(0);
}

// 断点续跑：--workspace <dir> 复用上一次运行的工作区（含 ox-run-journal.json）
// → headless 检测到日志且需求匹配时自动恢复进度，跳过规划与已完成任务。
const wsIdx = process.argv.indexOf("--workspace");
const workspace =
  wsIdx > -1 && process.argv[wsIdx + 1]
    ? path.resolve(process.argv[wsIdx + 1])
    : fs.mkdtempSync(path.join(os.tmpdir(), "ox-multiagent-"));
ensureWorkspace(workspace);
console.log("workspace:", workspace);
if (fs.existsSync(path.join(workspace, "ox-run-journal.json"))) {
  console.log("发现运行日志 → headless 将自动断点续跑（跳过规划与已完成任务）");
}

const SIMPLE_REQUIREMENT = [
  "做一个双模块演示工具：",
  "① 在 src/app 模块实现 src/app/greet.js（CommonJS 导出 greet(name)，返回 '你好, ' + name + '!'）;",
  "② 在 src/loomy 模块实现 src/loomy/math.js（CommonJS 导出 add(a,b) 与 mul(a,b)）;",
  "③ 在 tests/ 下用 node:test 写测试：greet 至少 2 个用例、math 至少 4 个用例，测试文件放 tests/greet.test.js 与 tests/math.test.js。",
  "禁止第三方依赖；禁止修改 package.json 与 ox-scripts 目录。",
].join("\n");

/**
 * Hard mode (--hard): 6 tasks / 3 zones / cross-agent dependency — the src/calc
 * zone is reserved for the loomy bridge agent, src/text goes to the builtin
 * executor, and src/index.js + tests depend on BOTH modules, so any interface
 * drift between the two agents surfaces in VERIFICATION.
 */
const HARD_REQUIREMENT = [
  "做一个工具集合项目，接口契约必须严格遵守：",
  "① 在 src/calc 模块实现 src/calc/calc.js：CommonJS 导出 { add, sub, mul, divide }；divide(a,b) 当 b===0 时必须 throw new Error('division by zero')，其余为标准四则运算。",
  "② 在 src/text 模块实现 src/text/text.js：CommonJS 导出 { toKebab, toCamel }；toKebab('HelloWorldTest') === 'hello-world-test'；toCamel('hello-world-test') === 'helloWorldTest'。",
  "③ 在 src 下实现 src/index.js：module.exports = { calc: require('./calc/calc'), text: require('./text/text') }，作为聚合入口（依赖①②完成后进行）。",
  "④ 在 tests/ 下用 node:test 写测试：tests/calc.test.js 至少 6 个用例（必须覆盖 divide 除零抛错）、tests/text.test.js 至少 4 个用例、tests/index.test.js 至少 2 个用例验证聚合入口转发正确。",
  "禁止第三方依赖；禁止修改 package.json 与 ox-scripts 目录。",
].join("\n");

/**
 * Real mode (--real): a genuinely usable deliverable — a CSV statistics CLI.
 * The loomy agent owns src/core (CSV parser + stats engine), the builtin
 * executor owns report/cli/tests; final acceptance runs the delivered CLI on
 * a sample CSV. Contracts below are cross-agent: every signature is binding.
 */
const REAL_REQUIREMENT = [
  "做一个真实可用的命令行工具 csvstat：读取 CSV 文件，输出每列的统计报告。接口契约必须逐字遵守：",
  "① 在 src/core 模块实现 src/core/csv.js：CommonJS 导出 { parseCsv(text) }；text 为 CSV 字符串，返回 string[][]；支持双引号字段（字段内可含逗号与换行），双引号转义为单个双引号；\\r\\n 与 \\n 均视为行分隔；忽略末尾空行；中文字段原样保留。",
  "② 在 src/core 模块实现 src/core/stats.js：CommonJS 导出 { columnStats(rows) }；rows 为 string[][]；rows[0] 视为表头行不计入统计（total 为数据行数，不含表头）；按列返回统计对象数组，每列对象形如 { index, type, total, missing, min, max, mean, unique }；type 为 'number' 当且仅当该列在数据行中存在非空值且所有非空值 trim 后可被 Number() 解析为有限数字，否则为 'string'；missing 为数据行中空字符串计数；数值列 min/max 为该列最小/最大数字、mean 为平均值保留 2 位小数；字符串列 min/max/mean 为 null、unique 为非空值去重计数；全空列（数据行中该列全为空）type 为 'string' 且 unique 为 0、min/max/mean 为 null。",
  "③ 在 src/report 模块实现 src/report/report.js：CommonJS 导出 { renderReport(rows) }；返回多行字符串，每列一行，格式：col{index}: type={type} total={total} missing={missing} min={min} max={max} mean={mean}（数值列）或 col{index}: type={type} total={total} missing={missing} unique={unique}（字符串列）。",
  "④ 在 src 下实现 src/cli.js：CommonJS 导出 { run(argv) }；argv[2] 为 CSV 文件路径，读取文件并 console.log 输出 renderReport 结果；文件不存在或未给参数时 console.error 提示并设置 process.exitCode = 1；仅当 require.main === module 时才自动执行。",
  "⑤ 在 tests/ 下用 node:test 写测试：tests/csv.test.js 至少 5 个用例（覆盖带引号逗号字段、双引号转义、CRLF、末尾空行、中文字段）；tests/stats.test.js 至少 5 个用例（覆盖数值列、混合列、全空列、missing 计数、unique 计数）；tests/cli.test.js 至少 2 个用例（正常路径输出包含 col0；文件不存在时 exitCode 为 1，通过临时写文件与 try/finally 清理）。",
  "禁止第三方依赖；禁止修改 package.json 与 ox-scripts 目录。",
].join("\n");

const hard = process.argv.includes("--hard");
const real = process.argv.includes("--real");
const requirement = real ? REAL_REQUIREMENT : hard ? HARD_REQUIREMENT : SIMPLE_REQUIREMENT;

// The manifest's zoneGlobs MUST track the requirement's reserved zone, or the
// capability router will hard-exclude loomy from every task (verified live:
// a declared-zones-don't-cover-task agent is silently filtered out).
const LOOMY_ZONE = real ? "src/core" : hard ? "src/calc" : "src/loomy";
const LOOMY_MANIFEST = {
  id: "loomy",
  displayName: "Loomy 工程师",
  adapter: "http-bridge",
  entry: { kind: "http", baseUrl: "http://127.0.0.1:8931" },
  capabilities: {
    protocolVersion: "ox-agent/2",
    roles: ["backend-dev", "fullstack-dev"],
    zoneGlobs: [LOOMY_ZONE, `${LOOMY_ZONE}/**`],
    supports: ["read", "edit", "create"],
    artifactKinds: ["files"],
    maxConcurrency: 1,
    selfIsolated: false,
  },
  credential: { kind: "none" },
  limits: { runDeadlineMs: 420_000, idleTimeoutMs: 180_000, maxStdoutBytes: 2_097_152 },
  priority: 50,
  enabled: true,
};

const spec = {
  requirement,
  projectRoot: workspace,
  agents: [LOOMY_MANIFEST],
  maxParallelRuns: 2,
};

const headless = path.join(root, "dist-headless", "headless", "headless-main.js");
console.log("dispatching to commander via headless binary…\n");
// 流式管道：事件实时打到控制台（运行中即可看到 router/run/验证事件，
// 不再是"运行中一片空白"的假卡住）。25 分钟硬超时兜底。
const child = spawn(process.execPath, [headless], { stdio: ["pipe", "pipe", "pipe"] });
child.stdin.write(JSON.stringify(spec));
child.stdin.end();
let stdout = "";
child.stdout.on("data", (d) => {
  stdout += d;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => process.stderr.write(d));
const maxMinIdx = process.argv.indexOf("--max-minutes");
const maxMinutes = maxMinIdx > -1 ? Number(process.argv[maxMinIdx + 1]) || 25 : 25;
const hardKill = setTimeout(() => child.kill("SIGKILL"), maxMinutes * 60_000);
const status = await new Promise((resolve) => {
  child.on("close", (code) => {
    clearTimeout(hardKill);
    resolve(code);
  });
});

const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    /* ignore partial */
  }
}

console.log("=== 事件流水 ===");
for (const e of events) {
  if (e.type === "log") console.log(`  [log] ${e.text.slice(0, 150)}`);
  else if (e.type === "run") console.log(`  [run] ${e.taskId} → ${e.agentId} ok=${e.ok} ${e.durationMs}ms${e.errorClass ? ` err=${e.errorClass}` : ""}`);
  else if (e.type === "conflict") console.log(`  [conflict] ${e.kind} ${JSON.stringify(e.paths)} remedy=${e.remedy}`);
  else if (e.type === "stage") console.log(`  [stage] ${e.stage}`);
  else if (e.type === "agents") console.log(`  [agents] ${e.agents.map((a) => `${a.id}(${a.adapter},roles=${a.roles.join("/")})`).join(", ")}`);
  else if (e.type === "verification") console.log(`  [verification] passed=${e.passed} ${e.results.map((r) => `${r.kind}:${r.ok ? "过" : `败(exit=${r.exitCode})`}`).join(" ")}`);
  else if (e.type === "hello") console.log(`  [hello] protocol=${e.protocolVersion} warnings=${JSON.stringify(e.warnings)}`);
  else if (e.type === "done") console.log(`  [done] passed=${e.passed}`);
  else if (e.type === "error") console.log(`  [error] ${e.message?.slice(0, 200)}`);
}

console.log("\n=== 归因汇总 ===");
const runs = events.filter((e) => e.type === "run" && typeof e.ok === "boolean");
for (const r of runs) console.log(`  ${r.taskId}: ${r.agentId} ok=${r.ok} ${r.durationMs}ms${r.errorClass ? ` (${r.errorClass})` : ""}`);
const loomyRuns = runs.filter((r) => r.agentId === "loomy");
const files = [];
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && ent.name !== "node_modules") walk(p);
    else if (ent.isFile()) files.push(path.relative(workspace, p).replace(/\\/g, "/"));
  }
};
walk(workspace);
console.log("落盘文件:", files.filter((f) => !f.startsWith("ox-scripts/") && f !== "package.json").join(", ") || "（无）");
console.log("loomy 接单数:", loomyRuns.length, "| 全部成功:", loomyRuns.every((r) => r.ok) && loomyRuns.length > 0);
console.log("headless exit:", status);

fs.mkdirSync(path.join(root, "logs"), { recursive: true });
fs.writeFileSync(path.join(root, "logs", "multiagent-e2e.jsonl"), stdout, "utf8");
process.exit(status ?? 1);
