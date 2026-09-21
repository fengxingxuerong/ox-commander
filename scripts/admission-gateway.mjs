/**
 * OxCommander 通用接入网关（Admission Gateway）
 * ================================================
 * 一个本地端口，让**任何**智能体加入总指挥官的指挥——不需要实现完整桥协议。
 *
 * 智能体侧只需两个 URL（拉模式）：
 *   GET  /pull?agent=<id>   → 领取派给该智能体的下一个任务（无任务 204）
 *   POST /result            → 提交 {runId, files:[{path,content}], summary}
 *
 * 平台侧照旧：manifests 指向本网关（每个智能体一个独立 runsPath，
 * 如 /v1/runs/<agentId>），ox-agent/2 协议由本网关代为应答——
 * 包括任务被领取期间的自动心跳（喂平台的空闲看门狗）。
 *
 * 自助注册：POST /register {id, displayName?, zones, roles?}
 *   → 生成 manifest 写入 agents.d 目录（重启桌面端生效，或运行时粘贴）
 *
 * 自描述：GET / 返回接入说明（发给任何智能体即可照做）。
 *
 * 环境变量：ADMISSION_PORT（默认 8940）、OX_AGENTS_DIR（agents.d 目录，
 *           默认 %APPDATA%/ox-commander/agents.d）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PORT = Number(process.env.ADMISSION_PORT ?? 8940);

function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const AGENTS_DIR =
  process.env.OX_AGENTS_DIR ??
  path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "ox-commander", "agents.d");

const FORBIDDEN_TOPS = ["node_modules", ".git", "ox-scripts", "dist", "dist-electron", "dist-headless"];
const FORBIDDEN_FILES = ["package.json", "package-lock.json", ".env"];
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 20_000);

/** agentId → { queue: TaskRequest[], runs: Map<runId, RunState> } */
const agents = new Map();
function agentState(id) {
  if (!agents.has(id)) agents.set(id, { queue: [], runs: new Map() });
  return agents.get(id);
}

function emit(run, kind, text) {
  run.events.push({ kind, text });
}

function assertWritable(zone, rel) {
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

function writeFiles(run, files) {
  const written = [];
  for (const f of files) {
    if (run.abortFlag) throw new Error("已中止");
    const rel = assertWritable(run.task.zone, String(f.path ?? ""));
    const abs = path.join(run.task.projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(f.content ?? ""), "utf8");
    emit(run, "log", `写入 ${rel}（${Buffer.byteLength(String(f.content ?? ""))} bytes）`);
    written.push(rel);
  }
  if (written.length === 0) throw new Error("结果未包含任何文件");
  return written;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const ONBOARDING = `# OxCommander 通用接入网关

你是被邀请加入的外聘工程师智能体。接入只需两个 URL：

1. 领任务：GET http://127.0.0.1:${PORT}/pull?agent=<你的id>
   - 204 = 暂无任务（隔几秒再拉）
   - 200 = 返回 {runId, taskId, title, description, zone, projectRoot, resultUrl}
2. 交结果：POST http://127.0.0.1:${PORT}/result
   body: {"runId":"...","files":[{"path":"zone内路径","content":"文件内容"}],"summary":"一句话总结"}

硬性规则：
- 只允许在返回的 zone 目录内写文件；禁止 node_modules/.git/.env/package.json/ox-scripts
- CommonJS；禁止第三方依赖；description 的契约逐字遵守
- 完成后提交 result（会过平台沙箱与构建/测试验证），失败也提交并写明根因

自助注册（让平台认识你）：POST /register {"id":"你的id","zones":["src/你的目录"],"roles":["backend-dev"]}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // 健康探针：平台的 http-bridge 适配器派单前会先探测 healthPath
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, gateway: "admission", agents: agents.size });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(ONBOARDING);
      return;
    }

    // ── 智能体侧：拉任务 ──
    if (req.method === "GET" && url.pathname === "/pull") {
      const agentId = url.searchParams.get("agent") ?? "";
      if (!agentId) return json(res, 400, { error: "agent 必填" });
      const st = agentState(agentId);
      const next = st.queue.shift();
      if (!next) return json(res, 204, {});
      next.claimedBy = agentId;
      next.claimedAt = Date.now();
      // 自动心跳：任务被领取期间每 20s 喂平台空闲看门狗
      next.heartbeat = setInterval(() => {
        emit(next, "log", `执行中… ${Math.round((Date.now() - next.claimedAt) / 1000)}s（网关心跳）`);
      }, HEARTBEAT_MS);
      json(res, 200, {
        runId: next.id,
        taskId: next.task.taskId,
        title: next.task.title,
        description: next.task.description,
        zone: next.task.zone,
        projectRoot: next.task.projectRoot,
        ...(next.task.repairContext ? { repairContext: next.task.repairContext } : {}),
        resultUrl: `http://127.0.0.1:${PORT}/result`,
      });
      return;
    }

    // ── 智能体侧：交结果 ──
    if (req.method === "POST" && url.pathname === "/result") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const agentId = url.searchParams.get("agent") ?? body.agent ?? "";
      const run = [...agents.values()].flatMap((a) => [...a.runs.values()]).find((r) => r.id === body.runId);
      if (!run) return json(res, 404, { error: "unknown run" });
      clearInterval(run.heartbeat);
      if (run.status !== "running") return json(res, 409, { error: `运行已处于 ${run.status}` });
      try {
        if (body.files && body.files.length > 0) {
          const written = writeFiles(run, body.files);
          emit(run, "completed", `${body.summary ?? "完成"}（${written.join(", ")}）`);
          run.status = "completed";
        } else {
          throw new Error(body.error ?? body.summary ?? "结果未包含文件");
        }
      } catch (err) {
        emit(run, "failed", err?.message ?? String(err));
        run.status = "failed";
      }
      json(res, 200, { ok: true, status: run.status });
      return;
    }

    // ── 自助注册 ──
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = String(body.id ?? "").trim();
      const zones = Array.isArray(body.zones) ? body.zones.filter((z) => typeof z === "string" && z) : [];
      if (!id || zones.length === 0) return json(res, 400, { error: "id 与 zones 必填" });
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      const manifest = {
        id,
        displayName: body.displayName ?? id,
        adapter: "http-bridge",
        entry: {
          kind: "http",
          baseUrl: `http://127.0.0.1:${PORT}`,
          healthPath: "/health",
          runsPath: `/v1/runs/${id}`,
          pollMs: 500,
        },
        capabilities: {
          protocolVersion: "ox-agent/2",
          roles: Array.isArray(body.roles) && body.roles.length > 0 ? body.roles : ["backend-dev", "fullstack-dev"],
          zoneGlobs: zones.flatMap((z) => [z, `${z}/**`]),
          supports: ["read", "edit", "create"],
          artifactKinds: ["files"],
          maxConcurrency: 1,
          selfIsolated: false,
        },
        credential: { kind: "none" },
        limits: { runDeadlineMs: 420_000, idleTimeoutMs: 180_000, maxStdoutBytes: 2_097_152 },
        priority: 40,
        enabled: true,
      };
      const file = path.join(AGENTS_DIR, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
      json(res, 200, {
        ok: true,
        manifestFile: file,
        note: "重启 OxCommander 生效；或立刻在 设置→智能体池 粘贴本 manifest 运行时注册",
        manifest,
      });
      return;
    }

    // ── 平台侧：ox-agent/2 协议（runsPath 按 agentId 区分） ──
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
    // 按 agent 派单：POST /v1/runs/<agentId>（平台 http-bridge 适配器的调用形状）
    if (req.method === "POST" && runMatch && !runMatch[2]) {
      const agentId = decodeURIComponent(runMatch[1]);
      const task = JSON.parse((await readBody(req)) || "{}");
      if (!task.taskId || !task.zone || !task.projectRoot) {
        json(res, 400, { error: "taskId/zone/projectRoot 必填" });
        return;
      }
      const st = agentState(agentId);
      const id = `${agentId}-${Date.now()}-${++gatewayCounter}`;
      const run = { id, status: "running", events: [], abortFlag: false, task, queueAgent: agentId };
      st.runs.set(id, run);
      st.queue.push(run);
      emit(run, "log", `已进入 ${agentId} 的任务队列（zone=${task.zone}）`);
      json(res, 200, { runId: id });
      return;
    }
    if (runMatch) {
      // 在所有 agent 的 runs 里找（runId 全局唯一）
      let run = null;
      for (const st of agents.values()) {
        run = st.runs.get(decodeURIComponent(runMatch[1]));
        if (run) break;
      }
      if (!run) return json(res, 404, { error: "unknown run" });
      if (req.method === "GET" && runMatch[2] === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        json(res, 200, { events: run.events.slice(since), status: run.status });
        return;
      }
      if (req.method === "POST" && runMatch[2] === "/abort") {
        run.abortFlag = true;
        clearInterval(run.heartbeat);
        if (run.status === "running") {
          emit(run, "aborted", "平台中止");
          run.status = "aborted";
        }
        // 从队列移除未领取的同任务
        const q = agentState(run.queueAgent).queue;
        const qi = q.indexOf(run);
        if (qi >= 0) q.splice(qi, 1);
        json(res, 200, { ok: true });
        return;
      }
    }

    json(res, 404, { error: "not found", hint: `GET ${url.origin}/ 查看接入说明` });
  } catch (err) {
    json(res, 500, { error: err?.message ?? String(err) });
  }
});

let gatewayCounter = 0;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[admission-gateway] 通用接入网关 on http://127.0.0.1:${PORT}`);
  console.log(`[admission-gateway] agents.d 目录: ${AGENTS_DIR}`);
  console.log(`[admission-gateway] 把 http://127.0.0.1:${PORT}/ 发给任何智能体即可自助入伙`);
});
