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
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildLlmPool } = require(path.join(root, "dist-electron", "shared", "build-llm.js"));
// 交付格式（OXFILE 分隔符原文块 + JSON 回退）的单一事实来源在 shared/，
// 这里只 require 编译产物 —— 改格式改 shared/deliverable-format.ts 一处。
const { buildOutputRules, parseDeliverable, resolveDeliverablePath, zoneWriteRule } = require(
  path.join(root, "dist-electron", "shared", "deliverable-format.js"),
);

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
// Two-layer timeout, 2026-09-26 live-run lessons:
// 1. Run budget (MAX_RUN_MS): the first 300s ceiling was below the real
//    completion time of same-provider calls (the builtin executor landed in
//    307s while 4/4 bridge runs died at ~300.2s) — raised to 600s.
// 2. Per-attempt timeout (PER_ATTEMPT_MS) must stay BELOW the run budget:
//    with the budget conflated into the per-attempt timeout, one hung HTTP
//    attempt consumed the whole 600s and the failover table never got a
//    second chance (t1 timed out 4/4 at the ceiling; the builtin executor
//    cuts attempts at EXECUTOR_TIMEOUT_MS=300s and rotates to the next
//    route). 300s ≈ the slowest legitimate single generation observed
//    (t2 landed in 259s).
// LOOMY_BRIDGE_MAX_RUN_MS / LOOMY_BRIDGE_ATTEMPT_MS override without edits.
const MAX_RUN_MS = Number(process.env.LOOMY_BRIDGE_MAX_RUN_MS ?? 600_000);
const PER_ATTEMPT_MS = Number(process.env.LOOMY_BRIDGE_ATTEMPT_MS ?? 300_000);
const pool = buildLlmPool({
  timeoutMs: PER_ATTEMPT_MS,
  // Route rotation / cooldown decisions from the shared pool carry no run
  // attribution — they go to the bridge console (evidence trail), not into
  // any single run's event stream.
  onEvent: (t) => console.log(`[pool] ${new Date().toISOString()} ${t}`),
});

function emit(run, kind, text) {
  run.events.push({ kind, text });
  console.log(`[run ${run.id}] ${kind}: ${text.slice(0, 160)}`);
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
      "你是「Loomy 工程师」，OxCommander 多智能体平台的外聘执行者。",
      `任务：${task.title ?? ""}`,
      `说明：${task.description ?? ""}`,
      `你的专属目录（zone）：${task.zone}（项目根：${task.projectRoot}）`,
      task.repairContext?.errorLogDigest
        ? `上一轮失败根因（务必避免重蹈覆辙）：${task.repairContext.errorLogDigest}`
        : "",
      "",
      "硬性规则：",
      // zoneWriteRule 区分文件级/目录级 zone（2026-09-27 --real 演习实测：
      // 文件级 zone 用目录措辞会把模型带偏成在 zone 下建子文件）。
      `1. ${zoneWriteRule(String(task.zone ?? ""))}；禁止触碰 node_modules、.git、.env、package.json、ox-scripts。`,
      "2. 代码用 CommonJS（module.exports），禁止任何第三方依赖。",
      // 2026-09-27 t1 超时根因治理：旧格式要求模型把代码塞进 JSON 字符串，
      // 引号密集型任务（CSV 解析）转义层叠转义，生成本身被拖到尝试时限外。
      // 新格式原样输出、零转义；模型偶尔无视指令输出 JSON 时 parseDeliverable
      // 仍会回退接住（shared/deliverable-format.ts，测试锁定两格式行为）。
      buildOutputRules(task.zone ?? ""),
    ].filter(Boolean).join("\n");

    const deadline = task.deadlineMs ?? 420_000;
    // 不传 maxTokens：池层（shared/http-clients.ts）固定用端点声明的输出上限
    // 65536 并显式检测 finish_reason=length，调用方传小值会被忽略 —— 与其留
    // 一个不生效的参数误导后来者，不如不传。
    const chat = pool.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });
    const effectiveDeadline = Math.min(deadline, MAX_RUN_MS);
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Loomy 超过 ${Math.round(effectiveDeadline / 1000)}s 未完成`)), effectiveDeadline),
    );
    const started = Date.now();
    // 心跳：平台按 idleTimeoutMs 判定桥是否卡死（无事件即 idle），
    // 长推理期间必须定期上报进度，否则 120s 就会被看门狗收割。
    const model = "（推理中）";
    const heartbeat = setInterval(() => {
      emit(run, "log", `思考中… ${Math.round((Date.now() - started) / 1000)}s ${model}`);
    }, 20_000);
    let res;
    try {
      res = await Promise.race([chat, timer]);
    } finally {
      clearInterval(heartbeat);
    }
    if (run.abortFlag) throw new Error("已中止");
    emit(run, "log", `思考完成（${((Date.now() - started) / 1000).toFixed(1)}s，model=${res.model ?? "?"}），落盘中…`);

    const parsed = parseDeliverable(res.content ?? "");
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    if (files.length === 0) throw new Error("模型未返回任何文件");
    for (const f of files) {
      if (run.abortFlag) throw new Error("已中止");
      // 宽容归一：模型可能把路径写成相对 zone 的形式（hello.js），归一成
      // zone 内路径后再过安全闸 —— assertWritable 的全部检查原样保留。
      const rel = assertWritable(
        task.projectRoot,
        task.zone,
        resolveDeliverablePath(String(f.path ?? ""), String(task.zone ?? "")),
      );
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
