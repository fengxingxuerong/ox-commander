/**
 * Marvis HTTP-bridge agent — 以 `ox-agent/2` 协议加入 OxCommander 沙箱。
 *
 * 协议（见 agents.d/README.md 与 marvis-onboarding.md）：
 *   GET  /health                     → 200 {"ok":true,"agent":"marvis"}
 *   POST /v1/runs   TaskRequest      → { runId }（异步执行，立即返回）
 *   GET  /v1/runs/:id/events?since=N → { events:[{kind,text}], status }
 *   POST /v1/runs/:id/abort          → 200（补一条 aborted 事件）
 *   POST /shutdown                   → 运维便利接口，非协议要求
 *
 * 干活通道（两选一，可叠加）：
 *   1) inbox/out 文件通道：任务落到 <queue>/inbox/<taskId>.json，
 *      Marvis 侧把产物包写入 <queue>/out/<taskId>.json：
 *        { "files":[{"path":"<zone 内相对或绝对路径>","content":"..."}], "summary":"..." }
 *   2) 可选推理后端：配置 MARVIS_BRIDGE_LLM_BASE_URL / _KEY / _MODEL
 *      （OpenAI 兼容 /chat/completions），任务可全自动完成。
 *
 * 落盘前由本服务自行做 zone 校验（平台 PathPolicy/ZoneGuard 会独立复核）。
 * 零第三方依赖，Node 18+ / ESM。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_ID = "marvis";
const PORT = Number(process.env.MARVIS_BRIDGE_PORT ?? 18666);
const HOST = process.env.MARVIS_BRIDGE_HOST ?? "127.0.0.1";

const APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const QUEUE_ROOT = process.env.MARVIS_BRIDGE_QUEUE ?? path.join(APPDATA, "OxCommander", "marvis-bridge");
const INBOX_DIR = path.join(QUEUE_ROOT, "inbox");
const OUT_DIR = path.join(QUEUE_ROOT, "out");
const LOG_FILE = path.join(QUEUE_ROOT, "bridge.log");

const LLM_BASE_URL = String(process.env.MARVIS_BRIDGE_LLM_BASE_URL ?? "").replace(/\/+$/, "");
const LLM_API_KEY = String(process.env.MARVIS_BRIDGE_LLM_KEY ?? "");
const LLM_MODEL = String(process.env.MARVIS_BRIDGE_LLM_MODEL ?? "deepseek-chat");

const FORBIDDEN_DIRS = ["node_modules", ".git", "ox-scripts", "dist", "dist-electron", "dist-headless"];
const FORBIDDEN_FILES = ["package.json", "package-lock.json", ".env"];

const runs = new Map();
let counter = 0;

for (const dir of [INBOX_DIR, OUT_DIR]) fs.mkdirSync(dir, { recursive: true });

/* ------------------------------ 工具函数 ------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toPosix = (p) => String(p).replace(/\\/g, "/");
const trimSlash = (p) => toPosix(p).replace(/\/+$/, "");
const isInside = (target, root) => {
  const t = toPosix(target).toLowerCase();
  const r = trimSlash(root).toLowerCase();
  return t === r || t.startsWith(`${r}/`);
};
const safeName = (s) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "task";

function writeLog(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(LOG_FILE, `${text}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
  console.log(text);
}

function emit(run, kind, text) {
  run.events.push({ kind, text: String(text) });
  writeLog(`[run ${run.id}] ${kind}: ${String(text).slice(0, 200)}`);
}

/**
 * 解析并校验目标文件路径。
 * 注意事项（前人踩过）：path.normalize 在 Windows 产出反斜杠，而 zone 用正斜杠，
 * 比较前必须统一替换，否则会把自己的合法写入误判成越权。
 */
function resolveTarget(projectRoot, zone, rawPath) {
  const rel = String(rawPath ?? "").trim();
  if (!rel) throw new Error("产物包中的 path 为空");
  if (rel.includes("\0")) throw new Error(`非法路径: ${rel}`);
  if (!projectRoot) throw new Error("TaskRequest 缺少 projectRoot");

  const zoneAbs = trimSlash(path.isAbsolute(zone) ? path.resolve(zone) : path.resolve(projectRoot, zone));
  if (!zoneAbs) throw new Error("TaskRequest 缺少 zone");

  let abs;
  if (path.isAbsolute(rel)) {
    abs = path.resolve(rel);
  } else {
    const fromRoot = path.resolve(projectRoot, rel);
    abs = isInside(fromRoot, zoneAbs) ? fromRoot : path.resolve(zoneAbs, rel);
  }

  const absPosix = trimSlash(abs);
  if (!isInside(absPosix, zoneAbs)) throw new Error(`越权: ${rel} 不在 zone ${zone} 内`);

  const relToZone = absPosix.slice(zoneAbs.length).replace(/^\/+/, "");
  const parts = relToZone.split("/").filter(Boolean);
  if (!parts.length) throw new Error(`非法目标路径: ${rel}`);
  if (parts.includes("..")) throw new Error(`拒绝路径穿越: ${rel}`);
  for (const seg of parts) {
    if (FORBIDDEN_DIRS.includes(seg)) throw new Error(`拒绝受保护目录: ${rel}`);
  }
  if (FORBIDDEN_FILES.includes(parts[parts.length - 1])) throw new Error(`拒绝受保护文件: ${rel}`);

  return { abs: path.join(zoneAbs, ...parts), rel: `${trimSlash(zone)}/${relToZone}` };
}

function readPayload(outFile) {
  try {
    if (!fs.existsSync(outFile)) return null;
    const raw = fs.readFileSync(outFile, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) return null;
    return parsed;
  } catch (err) {
    writeLog(`产物包解析失败（${outFile}）: ${err?.message ?? err}`);
    return null;
  }
}

function extractJson(text) {
  const cleaned = String(text ?? "").replace(/^\uFEFF/, "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("推理后端响应中没有 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ------------------------------ 干活逻辑 ------------------------------ */

async function thinkWithLlm(task, deadlineMs) {
  const prompt = [
    "你是「Marvis」，OxCommander 多智能体平台的外聘执行者。",
    `任务：${task.title ?? ""}`,
    `说明：${task.description ?? ""}`,
    `你的专属目录（zone）：${task.zone}（项目根：${task.projectRoot}）`,
    "",
    "硬性规则：",
    `1. 只允许创建/修改 ${task.zone}/ 目录内的文件；禁止触碰 node_modules、.git、.env、package.json、ox-scripts。`,
    "2. 代码用 CommonJS（module.exports），禁止任何第三方依赖。",
    "3. 输出必须是且仅是一个 JSON 对象（不要 markdown 围栏、不要解释文字）：",
    `{"files":[{"path":"${task.zone}/xxx.js","content":"文件完整内容"}],"summary":"一句话总结"}`,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(deadlineMs, 300_000));
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LLM_API_KEY ? { authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`推理后端返回 HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    return extractJson(content);
  } finally {
    clearTimeout(timer);
  }
}

async function doRun(run) {
  const task = run.task ?? {};
  const deadlineMs = Number(task.deadlineMs ?? 420_000);
  const startedAt = Date.now();
  const taskKey = safeName(task.taskId ?? run.id);
  const inboxFile = path.join(INBOX_DIR, `${taskKey}.json`);
  const outFile = path.join(OUT_DIR, `${taskKey}.json`);

  try {
    emit(run, "log", `接单: ${task.title ?? "(无标题)"}（taskId=${task.taskId ?? "?"}, zone=${task.zone}）`);
    fs.writeFileSync(
      inboxFile,
      JSON.stringify({ receivedAt: new Date().toISOString(), runId: run.id, task }, null, 2),
      "utf8",
    );
    emit(run, "log", `任务已入队 ${inboxFile}，等待产物包 ${outFile}`);

    let payload = readPayload(outFile);
    if (payload) emit(run, "log", "命中已投递的产物包，直接落盘");

    if (!payload && LLM_BASE_URL) {
      emit(run, "log", `调用推理后端 ${LLM_BASE_URL}（model=${LLM_MODEL}）`);
      payload = await thinkWithLlm(task, deadlineMs);
      emit(run, "log", "推理完成，进入落盘");
    }

    while (!payload) {
      if (run.abortFlag) throw new Error("任务已被中止");
      if (Date.now() - startedAt > deadlineMs) {
        throw new Error(
          `等待产物超时（${Math.round(deadlineMs / 1000)}s）：未在 ${outFile} 收到产物包`,
        );
      }
      await sleep(500);
      payload = readPayload(outFile);
    }
    if (run.abortFlag) throw new Error("任务已被中止");

    const files = payload.files;
    for (const file of files) {
      if (run.abortFlag) throw new Error("任务已被中止");
      const { abs, rel } = resolveTarget(task.projectRoot, task.zone, file.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const content = String(file.content ?? "");
      fs.writeFileSync(abs, content, "utf8");
      emit(run, "log", `写入 ${rel}（${Buffer.byteLength(content, "utf8")} bytes）`);
    }

    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
    emit(run, "completed", payload.summary ?? `完成 ${files.length} 个文件`);
    run.status = "completed";
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (run.abortFlag) {
      if (run.status !== "aborted") {
        emit(run, "aborted", msg);
        run.status = "aborted";
      }
    } else {
      emit(run, "failed", msg);
      run.status = "failed";
    }
  }
}

/* ------------------------------ HTTP 服务 ------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        agent: AGENT_ID,
        runs: runs.size,
        mode: LLM_BASE_URL ? "llm+inbox" : "inbox",
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/runs") {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "请求体不是合法 JSON" });
      }
      if (!body.taskId || !body.zone || !body.projectRoot) {
        return json(res, 400, { error: "taskId/zone/projectRoot 必填" });
      }
      const id = `${AGENT_ID}-${Date.now()}-${++counter}`;
      const run = { id, status: "running", events: [], abortFlag: false, task: body };
      runs.set(id, run);
      json(res, 200, { runId: id });
      void doRun(run);
      return;
    }

    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
    if (runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      if (!run) return json(res, 404, { error: "unknown run" });

      if (req.method === "GET" && runMatch[2] === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
        return json(res, 200, { events: run.events.slice(from), status: run.status });
      }

      if (req.method === "POST" && runMatch[2] === "/abort") {
        run.abortFlag = true;
        if (run.status === "running") {
          emit(run, "aborted", "收到中止指令，已停止任务");
          run.status = "aborted";
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end("ok");
      }
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("bye");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (err) {
    json(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(PORT, HOST, () => {
  writeLog(`[marvis-bridge] listening on http://${HOST}:${PORT} (pid ${process.pid})`);
  writeLog(`[marvis-bridge] queue root: ${QUEUE_ROOT}`);
});
