/**
 * Loomy HTTP-bridge agent — an external engineer joining OxCommander's
 * sandbox through the `ox-agent/2` wire protocol.
 *
 * Protocol (see electron/agents/http-bridge.ts):
 *   GET  /health                     → 200
 *   POST /v1/runs   TaskRequest      → { runId }
 *   GET  /v1/runs/:id/events?since=N → { events: [{kind,text}], status }
 *   POST /v1/runs/:id/abort          → 200
 *   POST /shutdown                   → teardown (test convenience)
 *
 * The worker "thinks" with the project's own 13-line failover pool
 * (buildLlmPool: SenseNova 3 keys × 4 models + AMD fallback), then writes the
 * files it produced — strictly inside the zone the commander assigned. The
 * platform's PathPolicy/ZoneGuard re-checks every write independently.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildLlmPool } = require(path.join(root, "dist-electron", "shared", "build-llm.js"));

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const PORT = Number(process.env.LOOMY_BRIDGE_PORT ?? 8931);
const FORBIDDEN_TOPS = ["node_modules", ".git", "ox-scripts", "dist", "dist-electron", "dist-headless"];
const FORBIDDEN_FILES = ["package.json", "package-lock.json", ".env"];

const runs = new Map();
let counter = 0;
const pool = buildLlmPool();

function emit(run, kind, text) {
  run.events.push({ kind, text });
  console.log(`[run ${run.id}] ${kind}: ${text.slice(0, 160)}`);
}

function extractJson(text) {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("响应中没有 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function assertWritable(projectRoot, zone, rel) {
  // Compare in pure forward-slash space: path.normalize() emits backslashes on
  // Windows while the zone string uses posix separators — comparing them
  // directly rejects every in-zone write (the exact bug this run caught).
  const norm = path
    .normalize(rel)
    .replace(/\\/g, "/")
    .replace(/^(?:\.\.\/)+/, "");
  if (path.isAbsolute(rel)) throw new Error(`拒绝绝对路径: ${rel}`);
  if (norm.includes("..")) throw new Error(`拒绝路径穿越: ${rel}`);
  const top = norm.split("/")[0];
  if (FORBIDDEN_TOPS.includes(top)) throw new Error(`拒绝受保护目录: ${rel}`);
  if (FORBIDDEN_FILES.includes(norm)) throw new Error(`拒绝受保护文件: ${rel}`);
  const zoneNorm = zone.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const prefix = zoneNorm.includes("/") ? `${zoneNorm}/` : `${zoneNorm}/`;
  if (!norm.startsWith(prefix) && norm !== zoneNorm) {
    throw new Error(`越权: ${rel} 不在 zone ${zone} 内`);
  }
  return norm;
}

async function doRun(run) {
  const task = run.task;
  try {
    emit(run, "log", `接单: ${task.title}（zone=${task.zone}）`);
    const prompt = [
      `你是「Loomy 工程师」，OxCommander 多智能体平台的外聘执行者。`,
      `任务：${task.title}`,
      `说明：${task.description}`,
      `你的专属目录（zone）：${task.zone}（项目根：${task.projectRoot}）`,
      ``,
      `硬性规则：`,
      `1. 只允许创建/修改 ${task.zone}/ 目录内的文件；禁止触碰 node_modules、.git、.env、package.json、ox-scripts。`,
      `2. 用 CommonJS（module.exports），禁止任何第三方依赖。`,
      `3. 输出必须是且仅是一个 JSON 对象（不要 markdown 围栏、不要解释文字）：`,
      `{"files":[{"path":"${task.zone}/xxx.js","content":"文件完整内容"}],"summary":"一句话总结"}`,
    ].join("\n");

    const deadline = task.deadlineMs ?? 420_000;
    const chat = pool.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      maxTokens: 8192,
    });
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Loomy 超过 ${Math.round(deadline / 1000)}s 未完成`)), deadline),
    );
    const res = await Promise.race([chat, timer]);
    if (run.abortFlag) throw new Error("已中止");
    emit(run, "log", `思考完成（model=${res.model ?? "?"}），落盘中…`);

    const parsed = extractJson(res.content ?? "");
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    if (files.length === 0) throw new Error("模型未返回任何文件");
    for (const f of files) {
      if (run.abortFlag) throw new Error("已中止");
      const rel = assertWritable(task.projectRoot, task.zone, String(f.path ?? ""));
      const abs = path.join(task.projectRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(f.content ?? ""), "utf8");
      emit(run, "log", `写入 ${rel}（${Buffer.byteLength(String(f.content ?? ""))} bytes）`);
    }
    emit(run, "completed", parsed.summary ?? `完成 ${files.length} 个文件`);
    run.status = "completed";
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (run.abortFlag) {
      emit(run, "aborted", msg);
      run.status = "aborted";
    } else {
      emit(run, "failed", msg);
      run.status = "failed";
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: "loomy", runs: runs.size }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.taskId || !body.zone || !body.projectRoot) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "taskId/zone/projectRoot 必填" }));
        return;
      }
      const id = `loomy-${Date.now()}-${++counter}`;
      const run = { id, status: "running", events: [], abortFlag: false, task: body };
      runs.set(id, run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: id }));
      void doRun(run);
      return;
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
    if (runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (!run) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown run" }));
        return;
      }
      if (req.method === "GET" && runMatch[2] === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: run.events.slice(since), status: run.status }));
        return;
      }
      if (req.method === "POST" && runMatch[2] === "/abort") {
        run.abortFlag = true;
        res.writeHead(200);
        res.end("ok");
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      res.writeHead(200);
      res.end("bye");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err?.message ?? String(err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[loomy-bridge] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
});
