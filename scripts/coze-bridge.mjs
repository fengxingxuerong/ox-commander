/**
 * Coze（扣子）HTTP-bridge agent —— 字节扣子 bot 以 ox-agent/2 协议加入
 * OxCommander 沙箱的外聘工程师通道。
 *
 * 与 loomy-bridge 的区别：worker 的"大脑"在云端（扣子 OpenAPI），本地只做
 * 协议转换 + zone 校验 + 落盘。需要环境变量（写入项目 .env）：
 *   COZE_API_TOKEN  —— coze.cn 控制台生成的 PAT（Bearer 鉴权）
 *   COZE_BOT_ID     —— 已发布为 API 的 bot id
 *   COZE_API_BASE   —— 可选，默认 https://api.coze.cn
 *
 * 协议：GET /health · POST /v1/runs · GET /v1/runs/:id/events?since=N ·
 *       POST /v1/runs/:id/abort · POST /shutdown
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const PORT = Number(process.env.COZE_BRIDGE_PORT ?? 8932);
const API_BASE = process.env.COZE_API_BASE ?? "https://api.coze.cn";
const FORBIDDEN_TOPS = ["node_modules", ".git", "ox-scripts", "dist", "dist-electron", "dist-headless"];
const FORBIDDEN_FILES = ["package.json", "package-lock.json", ".env"];

const runs = new Map();
let counter = 0;

function emit(run, kind, text) {
  run.events.push({ kind, text });
  console.log(`[run ${run.id}] ${kind}: ${text.slice(0, 160)}`);
}

function assertWritable(zone, rel) {
  // 统一正斜杠空间比较（Windows path.normalize 会吐反斜杠，历史教训）
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
  if (!norm.startsWith(`${zoneNorm}/`) && norm !== zoneNorm) {
    throw new Error(`越权: ${rel} 不在 zone ${zone} 内`);
  }
  return norm;
}

/** 从扣子回答文本中提取 JSON（容忍 markdown 围栏与前后杂讯）。 */
function extractJson(text) {
  const cleaned = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("回答中没有 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 调扣子 OpenAPI 拿回答文本。v3 非流式 + message/list 兜底轮询。 */
async function askCoze(prompt, deadlineMs) {
  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;
  if (!token || !botId) {
    throw new Error(
      "缺少 COZE_API_TOKEN / COZE_BOT_ID：请在 coze.cn 创建 PAT 与已发布 bot，并写入项目 .env",
    );
  }
  const startedAt = Date.now();
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    bot_id: botId,
    user_id: "ox-commander",
    additional_messages: [{ role: "user", content_type: "text", content: prompt }],
    auto_save_history: false,
    stream: false,
  });

  const res = await fetch(`${API_BASE}/v3/chat`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(Math.min(deadlineMs, 360_000)),
  });
  if (!res.ok) throw new Error(`Coze chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const contentType = res.headers.get("content-type") ?? "";

  let answer = "";
  if (contentType.includes("text/event-stream")) {
    // SSE 兜底：累积 message 事件里的 answer
    const raw = await res.text();
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.event === "conversation.message.completed" && evt.data?.type === "answer") {
          answer += evt.data.content ?? "";
        }
      } catch {
        /* 忽略非 JSON 行（如 event: ping） */
      }
    }
  } else {
    const chat = await res.json();
    const chatId = chat?.data?.id ?? chat?.data?.chat_id ?? chat?.id;
    const status = chat?.data?.status ?? chat?.status;
    if (status && status !== "completed") {
      // 非流式未直接带消息 → 轮询 message/list 直到 completed 或超时
      const listUrl = `${API_BASE}/v1/chat/message/list?chat_id=${encodeURIComponent(chatId)}`;
      while (Date.now() - startedAt < deadlineMs) {
        await new Promise((r) => setTimeout(r, 2000));
        const lr = await fetch(listUrl, { headers, signal: AbortSignal.timeout(30_000) });
        if (!lr.ok) continue;
        const msgs = await lr.json();
        const answerMsg = (Array.isArray(msgs) ? msgs : msgs?.data ?? []).find(
          (m) => m.type === "answer",
        );
        if (answerMsg?.content) return answerMsg.content;
      }
      throw new Error("轮询 message/list 超时未拿到 answer");
    }
    // 某些部署在非流式响应里直接携带消息
    const msgs = chat?.data?.messages ?? chat?.messages ?? [];
    const answerMsg = msgs.find((m) => m.type === "answer");
    answer = answerMsg?.content ?? chat?.data?.content ?? "";
  }
  if (!answer) throw new Error("扣子回答为空");
  return answer;
}

async function doRun(run) {
  const task = run.task;
  try {
    emit(run, "log", `接单: ${task.title ?? ""}（zone=${task.zone}）`);
    const prompt = [
      "你是「扣子工程师」，OxCommander 多智能体平台的外聘执行者。",
      `任务：${task.title ?? ""}`,
      `说明：${task.description ?? ""}`,
      `你的专属目录（zone）：${task.zone}（项目根：${task.projectRoot}）`,
      task.repairContext?.errorLogDigest
        ? `上一轮失败根因（务必避免重蹈覆辙）：${task.repairContext.errorLogDigest}`
        : "",
      "",
      "硬性规则：",
      `1. 只允许创建/修改 ${task.zone}/ 目录内的文件；禁止触碰 node_modules、.git、.env、package.json、ox-scripts。`,
      "2. 代码用 CommonJS（module.exports），禁止任何第三方依赖。",
      "3. 输出必须是且仅是一个 JSON 对象（不要 markdown 围栏、不要解释文字）：",
      `{"files":[{"path":"${task.zone}/xxx.js","content":"文件完整内容"}],"summary":"一句话总结"}`,
    ]
      .filter(Boolean)
      .join("\n");

    const deadline = task.deadlineMs ?? 420_000;
    const answer = await askCoze(prompt, deadline);
    if (run.abortFlag) throw new Error("已中止");
    emit(run, "log", `思考完成，落盘中…`);

    const parsed = extractJson(answer);
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    if (files.length === 0) throw new Error("扣子回答未包含任何文件");
    for (const f of files) {
      if (run.abortFlag) throw new Error("已中止");
      const rel = assertWritable(task.zone, String(f.path ?? ""));
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
      res.end(JSON.stringify({ ok: true, agent: "coze", runs: runs.size }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.taskId || !body.zone || !body.projectRoot) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "taskId/zone/projectRoot 必填" }));
        return;
      }
      const id = `coze-${Date.now()}-${++counter}`;
      const run = { id, status: "running", events: [], abortFlag: false, task: body };
      runs.set(id, run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: id }));
      void doRun(run);
      return;
    }
    const m = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
    const run = m && runs.get(decodeURIComponent(m[1]));
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
  const ready = process.env.COZE_API_TOKEN && process.env.COZE_BOT_ID;
  console.log(
    `[coze-bridge] listening on http://127.0.0.1:${PORT}（pid ${process.pid}）` +
      (ready ? " · 凭据已就绪" : " · ⚠ 缺 COZE_API_TOKEN/COZE_BOT_ID：协议可用，worker 将拒绝任务"),
  );
});
