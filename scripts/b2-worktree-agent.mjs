/**
 * B2 对照实验 · worktree 侧的单任务执行器（实验用，不进产品链路）。
 *
 * 为什么存在：B2（docs/2026-10-17-competitor-gap.md）要求同一任务集在
 * 本项目（共享工作区 + zone 互斥）与一个 worktree 工具（worktrunk）各跑一遍。
 * 本文件是 worktree 侧的“执行器”：复用产品同一套构件 —— 同一模型池
 * （`SENSENOVA_MODELS` × `SENSENOVA_KEY_VARS`）、同一 failover 客户端、
 * 同一 `chatJson` + `parseFilePayload` 文件协议 —— 但**不含** zone 写闸、
 * 快照、修复环与验证（那些是产品执行器的增强，两侧差异在报告中列明）。
 *
 * 用法：node scripts/b2-worktree-agent.mjs --worktree=<abs> --task-file=<json>
 * 输出：stdout 一行 JSON（{taskId, ok, wallMs, genMs, files, rejected, error?}）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const worktree = arg("worktree");
const taskFile = arg("task-file");
if (!worktree || !taskFile) {
  console.error("用法：node scripts/b2-worktree-agent.mjs --worktree=<abs> --task-file=<json>");
  process.exit(2);
}

const dist = (rel) => path.join(ROOT, "dist-electron", rel);
const { parseFilePayload } = require(dist("electron/agents/sensenova-api.js"));
const { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } = require(dist("shared/providers.js"));
const { createFailoverClient, EXECUTOR_TIMEOUT_MS } = require(dist("shared/http-clients.js"));
const { chatJson } = require(dist("shared/llm-client.js"));

const SYSTEM_PROMPT = [
  "你是 OxCommander 的代码执行智能体。",
  "根据任务描述直接产出代码文件，只输出一个 JSON 对象，不要 markdown 代码围栏：",
  '{"files":[{"path":"相对路径","content":"完整文件内容"}]}',
  "工作区基线只有项目骨架（package.json 与 ox-scripts/）；直接按任务描述里的路径与接口契约产出文件。",
  "files 只包含需要新增或修改的文件，未列出的文件保持不变；修改时给出该文件的完整新内容。",
  "禁止输出 package.json、package-lock.json、ox-scripts/ 下的文件。",
].join("\n");

const FORBIDDEN = new Set(["package.json", "package-lock.json"]);

function writeFiles(task, payload) {
  const written = [];
  const rejected = [];
  for (const f of payload) {
    const rel = f.path.replace(/\\/g, "/");
    const norm = path.posix.normalize(rel);
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || norm.startsWith("..")) {
      rejected.push(rel);
      continue;
    }
    if (FORBIDDEN.has(norm) || norm.startsWith("ox-scripts/")) {
      rejected.push(rel);
      continue;
    }
    const abs = path.join(worktree, norm);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, "utf8");
    written.push(norm);
  }
  return { written, rejected };
}

const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
const t0 = Date.now();

const llm = createFailoverClient("sensenova", SENSENOVA_KEY_VARS, SENSENOVA_MODELS, {
  timeoutMs: EXECUTOR_TIMEOUT_MS,
  onEvent: (text) => console.error(`[llm] ${text}`),
});

const userMessage = [
  `任务：${task.title}`,
  "",
  task.description,
  "",
  "全局约定：CommonJS（require/module.exports）、Node >= 18、禁止任何外部 npm 依赖。",
].join("\n");

let result;
try {
  const genStart = Date.now();
  const payload = await chatJson(
    llm,
    { messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage }] },
    {
      schemaName: "files",
      validate: (value) => parseFilePayload(value),
      maxRetries: 2,
    },
  );
  const genMs = Date.now() - genStart;

  const { written, rejected } = writeFiles(task, payload);
  if (written.length === 0) throw new Error("模型没有产出任何文件");

  const git = (args) => spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
  const add = git(["add", "-A"]);
  if (add.status !== 0) throw new Error(`git add 失败：${add.stderr}`);
  const commitStart = Date.now();
  const commit = git(["commit", "-qm", `b2 ${task.id}: ${task.title}`]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${commit.stderr}`);
  const commitMs = Date.now() - commitStart;

  result = { taskId: task.id, ok: true, wallMs: Date.now() - t0, genMs, commitMs, files: written, rejected };
} catch (e) {
  result = { taskId: task.id, ok: false, wallMs: Date.now() - t0, files: [], rejected: [], error: String(e && e.message ? e.message : e) };
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
