/**
 * WorkBuddy HTTP-bridge agent —— 对话式智能体接入 OxCommander 沙箱。
 *
 * 与 loomy-bridge 的唯一本质差别：**干活的不是 LLM 调用，而是人（对话里的
 * WorkBuddy）**。所以 doRun 不发起任何模型请求，而是把任务书落盘到 inbox/，
 * 然后轮询 outbox/：
 *
 *   inbox/{runId}.json   平台派来的 TaskRequest（原样，含 repairContext）
 *   outbox/{runId}.json  人写回的成果 { files:[{path,content}], summary?, logs? }
 *   outbox/{runId}.fail.json 人主动判失败 { reason }
 *
 * 为什么要落盘而不是让服务直接回调某个进程：对话式智能体没有可被 spawn 的入口，
 * 唯一的通道是文件系统 —— 服务负责协议与超时，人负责思考与产出，两边靠盘解耦。
 *
 * 协议（electron/agents/http-bridge.ts，ox-agent/2）：
 *   GET  /health                     → { ok, agent, runs, pending }
 *   POST /v1/runs   TaskRequest      → { runId }（立即返回，不等做完）
 *   GET  /v1/runs/:id/events?since=N → { events, status }（精确切片）
 *   POST /v1/runs/:id/abort          → 200
 *   POST /shutdown                   → 收摊（测试用）
 *
 * 用法：
 *   node scripts/workbuddy-bridge.mjs [--port=18666] [--dir=<工作目录>]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = Number(process.env.WORKBUDDY_BRIDGE_PORT ?? argValue("port", "18666"));
const DIR = process.env.WORKBUDDY_BRIDGE_DIR || argValue("dir", "") || path.join(ROOT, ".workbuddy", "bridge");
const INBOX = path.join(DIR, "inbox");
const OUTBOX = path.join(DIR, "outbox");

for (const d of [INBOX, OUTBOX]) fs.mkdirSync(d, { recursive: true });

const FORBIDDEN_TOPS = ["node_modules", ".git", "ox-scripts", "dist", "dist-electron", "dist-headless"];
const FORBIDDEN_FILES = ["package.json", "package-lock.json", ".env"];

const runs = new Map();

function emit(run, kind, text) {
  run.events.push({ kind, text });
  console.log(`[run ${run.id}] ${kind}: ${String(text).slice(0, 160)}`);
}

/**
 * zone 合规判定。
 *
 * ⚠️ Windows 分隔符坑（onboarding-universal.md §6，前人 3 连败熔断换来的）：
 * `path.normalize` 吐反斜杠，而 zone 字符串是正斜杠 —— 直接比较会把每一次
 * 合法写入都判成越权。统一在正斜杠空间里比。
 */
function assertWritable(zone, rel) {
  const norm = path
    .normalize(String(rel))
    .replace(/\\/g, "/")
    .replace(/^(?:\.\.\/)+/, "");
  if (path.isAbsolute(String(rel))) throw new Error(`拒绝绝对路径: ${rel}`);
  if (norm.includes("..")) throw new Error(`拒绝路径穿越: ${rel}`);
  const top = norm.split("/")[0];
  if (FORBIDDEN_TOPS.includes(top)) throw new Error(`拒绝受保护目录: ${rel}`);
  if (FORBIDDEN_FILES.includes(norm)) throw new Error(`拒绝受保护文件: ${rel}`);
  // 与平台口径 `shared/glob.ts → isPathInZone` 逐字对齐（含 `z.` 前缀规则）：
  // zone 取 "src/parse" 这种"文件名级"粒度时，契约要求的字面路径 src/parse.js
  // 在平台侧算 zone 内；桥若无这条就会把合法交付判成越权。
  const zoneNorm = String(zone).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (zoneNorm && zoneNorm !== ".") {
    const rest = norm.startsWith(`${zoneNorm}.`) ? norm.slice(zoneNorm.length + 1) : null;
    const inside =
      norm === zoneNorm || norm.startsWith(`${zoneNorm}/`) || (rest !== null && rest !== "" && !rest.includes("/"));
    if (!inside) throw new Error(`越权: ${rel} 不在 zone ${zone} 内`);
  }
  return norm;
}

/** 读 outbox 里人写回的成果；没有就返回 null。 */
function takeResult(run) {
  const okFile = path.join(OUTBOX, `${run.id}.json`);
  const failFile = path.join(OUTBOX, `${run.id}.fail.json`);
  if (fs.existsSync(failFile)) {
    let reason = "未说明原因";
    try {
      reason = String(JSON.parse(fs.readFileSync(failFile, "utf8")).reason ?? reason);
    } catch {
      reason = fs.readFileSync(failFile, "utf8").slice(0, 300) || reason;
    }
    fs.rmSync(failFile, { force: true });
    return { kind: "failed", reason };
  }
  if (fs.existsSync(okFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(okFile, "utf8"));
      fs.rmSync(okFile, { force: true });
      return { kind: "done", files: Array.isArray(parsed.files) ? parsed.files : [], summary: parsed.summary, logs: parsed.logs };
    } catch (err) {
      // 坏 JSON 永远不会被再次解析成功，不能继续躺在待消费队列里；但那是人写的字节，
      // 也不能扔 —— 改名成 .bad 停在原地当现场。
      try {
        fs.renameSync(okFile, `${okFile}.bad`);
      } catch {
        /* 改名不动判定：这一轮已经判失败了 */
      }
      return { kind: "failed", reason: `outbox JSON 无法解析：${err?.message ?? err}` };
    }
  }
  return null;
}

/** 任务书只在运行期有用；三条退出路径（交付、超时、中止）都得清，否则 inbox 无限涨。 */
function dropTaskBook(run) {
  fs.rmSync(path.join(INBOX, `${run.id}.json`), { force: true });
}

function writeFiles(run) {
  const { task } = run;
  const files = run.result.files;
  if (files.length === 0) throw new Error("成果里没有文件（files 为空数组）");
  // 整批先校验、后落盘。边验边写时，被拒的一批会把 zone 内那几份留在盘上，
  // 而 failed 事件不带文件清单 —— 平台的 revert-batch 仲裁看不到这些产物。
  const planned = files.map((f) => {
    const content = String(f.content ?? "");
    return { rel: assertWritable(task.zone, String(f.path ?? "")), content };
  });
  const written = [];
  for (const { rel, content } of planned) {
    const abs = path.join(task.projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    written.push(`${rel}（${Buffer.byteLength(content)} bytes）`);
  }
  return written;
}

function startRun(run) {
  const deadlineMs = Number(run.task.deadlineMs ?? 420_000);
  const started = Date.now();
  emit(run, "log", `接单: ${run.task.title ?? run.task.taskId}（zone=${run.task.zone}）`);
  emit(run, "log", `任务书已落盘 → ${path.join(INBOX, `${run.id}.json`)}（等人写回 outbox/${run.id}.json）`);
  if (run.task.repairContext?.errorLogDigest) {
    emit(run, "log", `上一轮失败根因：${String(run.task.repairContext.errorLogDigest).slice(0, 200)}`);
  }

  // 心跳：平台按 idleTimeoutMs 判定桥是否卡死 —— 人在思考的几分钟里必须持续
  // 有事件，否则被看门狗收割成 failed（onboarding §3.1 ③）。
  const heartbeat = setInterval(() => {
    if (run.status !== "running") return;
    emit(run, "log", `等待人写回… 已 ${Math.round((Date.now() - started) / 1000)}s`);
  }, 20_000);

  const poll = setInterval(() => {
    if (run.status !== "running") return;
    if (run.abortFlag) {
      clearInterval(poll);
      clearInterval(heartbeat);
      emit(run, "aborted", "收到中止");
      run.status = "aborted";
      dropTaskBook(run);
      return;
    }
    const got = takeResult(run);
    if (!got) {
      if (Date.now() - started > deadlineMs) {
        clearInterval(poll);
        clearInterval(heartbeat);
        emit(run, "failed", `超过 deadline ${Math.round(deadlineMs / 1000)}s 未收到人写回的成果`);
        run.status = "failed";
        dropTaskBook(run);
      }
      return;
    }
    clearInterval(poll);
    clearInterval(heartbeat);
    try {
      if (got.kind === "failed") throw new Error(got.reason);
      run.result = got;
      for (const l of got.logs ?? []) emit(run, "log", String(l));
      const written = writeFiles(run);
      for (const w of written) emit(run, "log", `写入 ${w}`);
      emit(run, "completed", got.summary ?? `完成 ${written.length} 个文件`);
      run.status = "completed";
    } catch (err) {
      emit(run, "failed", err?.message ?? String(err));
      run.status = "failed";
    } finally {
      dropTaskBook(run);
    }
  }, 500);
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
      res.end(
        JSON.stringify({
          ok: true,
          agent: "workbuddy",
          runs: runs.size,
          pending: [...runs.values()].filter((r) => r.status === "running").length,
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.taskId || !body.zone || !body.projectRoot) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "taskId/zone/projectRoot 必填" }));
        return;
      }
      const id = `workbuddy-${Date.now()}-${runs.size + 1}`;
      const run = { id, status: "running", events: [], abortFlag: false, task: body, result: null };
      fs.writeFileSync(path.join(INBOX, `${id}.json`), JSON.stringify(body, null, 2), "utf8");
      runs.set(id, run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: id }));
      startRun(run);
      return;
    }
    const m = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
    if (m) {
      const run = runs.get(decodeURIComponent(m[1]));
      if (!run) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown run" }));
        return;
      }
      if (req.method === "GET" && m[2] === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ events: run.events.slice(since), status: run.status }));
        return;
      }
      if (req.method === "POST" && m[2] === "/abort") {
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
  console.log(`[workbuddy-bridge] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.log(`[workbuddy-bridge] inbox=${INBOX}`);
  console.log(`[workbuddy-bridge] outbox=${OUTBOX}`);
});
