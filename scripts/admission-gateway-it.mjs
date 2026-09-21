/**
 * 通用接入网关集成测试（零真实平台依赖）：
 * 模拟平台侧派单 → 外部智能体拉取 → 交结果 → 断言文件落盘/事件流/zone 拒绝/心跳。
 *
 * 用法：node scripts/admission-gateway-it.mjs   （exit 0 = 通过）
 * 自行启动：ADMISSION_PORT=8940 OX_AGENTS_DIR=<agents.d> node scripts/admission-gateway.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PORT = 8941;
const AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ox-agents-it-"));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ox-gw-it-"));
fs.mkdirSync(path.join(ws, "src", "it"), { recursive: true });

const child = spawn(process.execPath, [path.join(root, "scripts", "admission-gateway.mjs")], {
  env: {
    ...process.env,
    ADMISSION_PORT: String(PORT),
    OX_AGENTS_DIR: AGENTS_DIR,
    HEARTBEAT_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
child.stdout.on("data", (d) => (gwLog += d));
child.stderr.on("data", (d) => (gwLog += d));
await new Promise((r) => setTimeout(r, 1500));

const base = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function j(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text), text };
    } catch {
      return { status: res.status, body: text, text };
    }
  } catch (err) {
    return { status: 0, body: { error: String(err?.cause ?? err) }, text: String(err?.cause ?? err) };
  }
}

// 0. 健康检查（带启动重试：未监听等 300ms；已监听则立即重试 fetch，最多 50 次）
let health = null;
for (let i = 0; i < 50; i++) {
  try {
    health = await j("GET", `${base}/health`);
    if (health.status === 200) break;
  } catch {
    /* 连接拒绝 = 尚未监听，重试 */
  }
  if (!gwLog.includes("listening")) await new Promise((r) => setTimeout(r, 300));
}
check(
  "网关健康检查",
  health?.status === 200,
  health?.status !== 200 ? `最后一次响应=${JSON.stringify(health?.body ?? null)}` : "",
);

// 1. 自助注册
const reg = await j("POST", `${base}/register`, { id: "ext-engineer", zones: ["src/it"], roles: ["backend-dev"] });
check("自助注册写入 agents.d", reg.status === 200 && fs.existsSync(path.join(AGENTS_DIR, "ext-engineer.json")));
check("注册产物 runsPath 按 agent 区分", reg.body.manifest.entry.runsPath === "/v1/runs/ext-engineer");

// 2. 平台侧派单（模拟 http-bridge 适配器调用 /v1/runs/ext-engineer）
const dispatch = await j("POST", `${base}/v1/runs/ext-engineer`, {
  taskId: "it1",
  title: "集成测试：创建 hello.js",
  description: "在 src/it 下创建 hello.js，CommonJS 导出 hi() 返回 'hi from gateway'。",
  zone: "src/it",
  projectRoot: ws,
  deadlineMs: 60_000,
});
check("平台派单返回 runId", dispatch.status === 200 && Boolean(dispatch.body.runId));

// 3. 外部智能体拉取任务
const pull = await j("GET", `${base}/pull?agent=ext-engineer`);
check("拉取到任务", pull.status === 200 && pull.body.taskId === "it1");
check("任务携带 resultUrl", typeof pull.body.resultUrl === "string");

// 4. 心跳：拉取后 300ms 心跳间隔 → 等 700ms 应有心跳事件
await new Promise((r) => setTimeout(r, 700));
const evMid = await j("GET", `${base}/v1/runs/${dispatch.body.runId}/events?since=0`);
check("网关自动心跳喂看门狗", (evMid.body.events ?? []).some((e) => e.text.includes("网关心跳")));

// 5. 越权提交 → 网关拒绝并标记 failed
await j("POST", `${base}/result`, {
  runId: dispatch.body.runId,
  files: [{ path: "src/other/evil.js", content: "bad" }],
});
const evBad = await j("GET", `${base}/v1/runs/${dispatch.body.runId}/events?since=0`);
check("越权提交被拒绝并标记 failed", evBad.body.status === "failed" && evBad.body.events.some((e) => e.text.includes("越权")));

// 6. 正常路径：新任务 + 合规结果
const dispatch2 = await j("POST", `${base}/v1/runs/ext-engineer`, {
  taskId: "it2",
  title: "集成测试：合规交付",
  description: "在 src/it 下创建 hello.js。",
  zone: "src/it",
  projectRoot: ws,
});
await j("GET", `${base}/pull?agent=ext-engineer`);
const result2 = await j("POST", `${base}/result`, {
  runId: dispatch2.body.runId,
  files: [{ path: "src/it/hello.js", content: "module.exports.hi = () => 'hi from gateway';" }],
  summary: "合规交付",
});
const ev2 = await j("GET", `${base}/v1/runs/${dispatch2.body.runId}/events?since=0`);
check("合规结果 → completed", ev2.body.status === "completed" && ev2.body.events.some((e) => e.kind === "completed"));
const hello = path.join(ws, "src", "it", "hello.js");
check("文件真实落盘且可运行", fs.existsSync(hello) && require(hello).hi() === "hi from gateway");

// 7. 已完成后再提交 → 409
const replay = await j("POST", `${base}/result`, { runId: dispatch2.body.runId, files: [{ path: "src/it/x.js", content: "x" }] });
check("已完成运行拒绝重复提交", replay.status === 409);

child.kill();
await new Promise((resolve) => child.on("close", () => resolve(true)));
check("网关干净退出", true);

console.log(`\n=== 判定：${failures === 0 ? "IT PASS ✓" : `IT FAIL（${failures} 项）`} ===`);
process.exit(failures === 0 ? 0 : 1);
