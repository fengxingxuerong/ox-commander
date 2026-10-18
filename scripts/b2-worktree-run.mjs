/**
 * B2 对照实验 driver —— 同一任务集在 **worktrunk（worktree 路线）** 上真跑一遍。
 *
 * 流程（与产品引擎的批调度形成对照）：
 *   1. 建一个临时 git 仓库，提交与 e2e 完全相同的脚手架（package.json + ox-scripts/）；
 *   2. 每个任务 `wt switch --create` 一个 worktree（计时/计磁盘）；
 *   3. 全并行起 6 个执行器（scripts/b2-worktree-agent.mjs），各自在自己 worktree 里落盘+提交；
 *   4. 按依赖拓扑序逐个 `wt merge` 回主干（计时/检测冲突）；
 *   5. 主干上跑 build/test/smoke 终验。
 *
 * 输出：一份 metrics JSON（--out）+ 控制台摘要。不做“快 X%”结论，只落数字。
 *
 * 用法：node scripts/b2-worktree-run.mjs --wt=<wt.exe> --journal=<journal.json> --out=<metrics.json> [--repo=<dir>] [--agent-timeout-seconds=900]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const wtBin = arg("wt");
const journalPath = arg("journal");
const outPath = arg("out");
const repoDir = arg("repo", fs.mkdtempSync(path.join(os.tmpdir(), "b2-worktree-")));
const agentTimeoutSeconds = Number(arg("agent-timeout-seconds", "900"));
if (!wtBin || !journalPath || !outPath) {
  console.error("用法：node scripts/b2-worktree-run.mjs --wt=<wt.exe> --journal=<journal.json> --out=<metrics.json> [--repo=<dir>]");
  process.exit(2);
}

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

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function setupRepo() {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args) => sh("git", args, { cwd: repoDir });
  const init = git(["init", "-qb", "main"]);
  if (init.status !== 0 && init.status !== 128) throw new Error(`git init 失败：${init.stderr}`);
  git(["config", "user.email", "b2@experiment.local"]);
  git(["config", "user.name", "b2-experiment"]);
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        name: "ox-multiagent-it",
        version: "0.0.0",
        private: true,
        scripts: { build: "node ox-scripts/build.js", typecheck: "node ox-scripts/build.js", test: "node ox-scripts/test.js" },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.mkdirSync(path.join(repoDir, "ox-scripts"), { recursive: true });
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    fs.writeFileSync(path.join(repoDir, "ox-scripts", name), content, "utf8");
  }
  git(["add", "-A"]);
  const commit = git(["commit", "-qm", "scaffold"]);
  if (commit.status !== 0) throw new Error(`scaffold 提交失败：${commit.stderr}`);
}

function worktreePathOf(branch) {
  const list = sh("git", ["worktree", "list", "--porcelain"], { cwd: repoDir });
  for (const block of list.stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((l) => l.startsWith("worktree "));
    const br = lines.find((l) => l === `branch refs/heads/${branch}`);
    if (wt && br) return wt.slice("worktree ".length).replace(/\\/g, "/");
  }
  return null;
}

function diskBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const orderedTasks = journal.snapshot.batches.flat().map((t) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  zone: t.zone,
  dependencies: t.dependencies,
}));
const smoke = journal.snapshot.smoke?.[0];
console.log(`任务 ${orderedTasks.length} 个 · 合并顺序 ${orderedTasks.map((t) => t.id).join(" → ")}`);

const metrics = {
  startedAt: new Date().toISOString(),
  wtBin,
  journalPath,
  repo: repoDir,
  taskOrder: orderedTasks.map((t) => t.id),
  worktrees: {},
  agents: {},
  merges: {},
  finalVerify: {},
};

const t0 = Date.now();
setupRepo();
console.log(`仓库脚手架就绪：${repoDir}`);

for (const task of orderedTasks) {
  const branch = `b2-${task.id}`;
  const t = Date.now();
  const res = sh(wtBin, ["switch", "--create", branch, "-y"], { cwd: repoDir });
  const createMs = Date.now() - t;
  const wtPath = worktreePathOf(branch);
  metrics.worktrees[task.id] = { branch, path: wtPath, createMs, ok: res.status === 0, output: (res.stdout + res.stderr).trim().split("\n").slice(-2).join(" | ") };
  console.log(`[wt] ${task.id}: 创建 ${createMs}ms ok=${res.status === 0} @ ${wtPath}`);
  if (res.status !== 0 || !wtPath) throw new Error(`worktree 创建失败（${task.id}）：${res.stdout}${res.stderr}`);
}
for (const task of orderedTasks) {
  metrics.worktrees[task.id].diskBytes = diskBytes(metrics.worktrees[task.id].path);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b2-tasks-"));
const agentScript = path.join(here, "b2-worktree-agent.mjs");
const runAgent = (task) =>
  new Promise((resolve) => {
    const taskFile = path.join(tmp, `${task.id}.json`);
    fs.writeFileSync(taskFile, JSON.stringify(task), "utf8");
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [agentScript, `--worktree=${metrics.worktrees[task.id].path}`, `--task-file=${taskFile}`],
      { cwd: root },
    );
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), agentTimeoutSeconds * 1000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      const wallMs = Date.now() - started;
      let parsed = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (line.trim().startsWith("{")) {
          try {
            parsed = JSON.parse(line);
          } catch {}
        }
      }
      resolve(parsed ?? { taskId: task.id, ok: false, wallMs, error: `无 JSON 输出（exit=${code}）`, stderr: stderr.slice(-500) });
    });
  });

console.log(`\n=== 全并行起 ${orderedTasks.length} 个执行器（worktree 各自隔离）===`);
const agentStarted = Date.now();
const agentResults = await Promise.all(orderedTasks.map(runAgent));
metrics.agentsWallMs = Date.now() - agentStarted;
for (const r of agentResults) {
  metrics.agents[r.taskId] = r;
  console.log(`[agent] ${r.taskId}: ok=${r.ok} wall=${r.wallMs}ms gen=${r.genMs ?? "-"}ms files=${(r.files ?? []).join(",") || "-"}${r.error ? ` err=${r.error}` : ""}`);
}

console.log(`\n=== 按拓扑序逐个 wt merge 回主干 ===`);
for (const task of orderedTasks) {
  const wtPath = metrics.worktrees[task.id].path;
  if (!metrics.agents[task.id]?.ok) {
    metrics.merges[task.id] = { ok: false, skipped: true, reason: "任务未产出提交" };
    console.log(`[merge] ${task.id}: 跳过（任务失败）`);
    continue;
  }
  const t = Date.now();
  const res = sh(wtBin, ["-C", wtPath, "merge", "-y"], { cwd: repoDir });
  const ms = Date.now() - t;
  const out = (res.stdout + res.stderr).trim();
  const conflict = /conflict/i.test(out);
  const gone = !fs.existsSync(wtPath);
  metrics.merges[task.id] = { ok: res.status === 0, ms, conflict, worktreeRemoved: gone, outputTail: out.split("\n").slice(-4).join(" | ") };
  console.log(`[merge] ${task.id}: ok=${res.status === 0} ${ms}ms conflict=${conflict} worktreeRemoved=${gone}`);
}

console.log(`\n=== 主干终验 ===`);
const verify = {};
const runCheck = (key, cmd, args) => {
  const t = Date.now();
  const res = sh(cmd, args, { cwd: repoDir });
  verify[key] = { exitCode: res.status, ms: Date.now() - t, ok: res.status === 0 };
  console.log(`[verify] ${key}: exit=${res.status}`);
};
runCheck("build", "node", ["ox-scripts/build.js"]);
runCheck("test", "node", ["ox-scripts/test.js"]);
if (smoke) {
  const res = sh("node", ["src/cli.js", "testdata/sample.csv"], { cwd: repoDir });
  const missing = (smoke.expectContains ?? []).filter((s) => !res.stdout.includes(s));
  verify.smoke = { exitCode: res.status, ok: res.status === 0 && missing.length === 0, missing };
  console.log(`[verify] smoke: exit=${res.status} 缺=${missing.length ? missing.join(";") : "无"}`);
}
metrics.finalVerify = verify;
metrics.totalWallMs = Date.now() - t0;
metrics.finishedAt = new Date().toISOString();

fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), "utf8");
console.log(`\nmetrics → ${outPath}`);
console.log(`总墙钟：${(metrics.totalWallMs / 1000).toFixed(1)}s（创建+全并行执行+逐个合并+终验）`);
