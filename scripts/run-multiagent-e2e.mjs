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
import { spawnSync } from "node:child_process";
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

const LOOMY_MANIFEST = {
  id: "loomy",
  displayName: "Loomy 工程师",
  adapter: "http-bridge",
  entry: { kind: "http", baseUrl: "http://127.0.0.1:8931" },
  capabilities: {
    protocolVersion: "ox-agent/2",
    roles: ["backend-dev", "fullstack-dev"],
    zoneGlobs: ["src/loomy", "src/loomy/**"],
    supports: ["read", "edit", "create"],
    artifactKinds: ["files"],
    maxConcurrency: 1,
    selfIsolated: false,
  },
  credential: { kind: "none" },
  limits: { runDeadlineMs: 420_000, idleTimeoutMs: 120_000, maxStdoutBytes: 2_097_152 },
  priority: 50,
  enabled: true,
};

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
    "const files = fs.existsSync('tests') ? fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')) : [];",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, `tests/${f}`], { stdio: 'inherit' });",
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

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ox-multiagent-"));
ensureWorkspace(workspace);
console.log("workspace:", workspace);

const spec = {
  requirement: [
    "做一个双模块演示工具：",
    "① 在 src/app 模块实现 src/app/greet.js（CommonJS 导出 greet(name)，返回 '你好, ' + name + '!'）;",
    "② 在 src/loomy 模块实现 src/loomy/math.js（CommonJS 导出 add(a,b) 与 mul(a,b)）;",
    "③ 在 tests/ 下用 node:test 写测试：greet 至少 2 个用例、math 至少 4 个用例，测试文件放 tests/greet.test.js 与 tests/math.test.js。",
    "禁止第三方依赖；禁止修改 package.json 与 ox-scripts 目录。",
  ].join("\n"),
  projectRoot: workspace,
  agents: [LOOMY_MANIFEST],
  maxParallelRuns: 2,
};

const headless = path.join(root, "dist-headless", "headless", "headless-main.js");
console.log("dispatching to commander via headless binary…\n");
const res = spawnSync(process.execPath, [headless], {
  input: JSON.stringify(spec),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  timeout: 14 * 60_000,
});

const lines = (res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
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
console.log("headless exit:", res.status);

fs.mkdirSync(path.join(root, "logs"), { recursive: true });
fs.writeFileSync(path.join(root, "logs", "multiagent-e2e.jsonl"), (res.stdout ?? ""), "utf8");
process.exit(res.status ?? 1);
