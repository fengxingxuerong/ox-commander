/**
 * Coze 桥集成测试（无需真实凭据）：
 * 起一个 mock 扣子 API（校验 Bearer 鉴权 + v3 非流式响应形状），
 * 以注入环境变量启动 coze-bridge 子进程，派单 → 轮询事件 →
 * 断言 worker 全路径：扣子调用 → JSON 解析 → zone 校验 → 落盘 → completed。
 *
 * 用法：node scripts/coze-bridge-it.mjs   （exit 0 = 集成通过）
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PORT_MOCK = 8933;
const PORT_BRIDGE = 8934;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ox-coze-it-"));
fs.mkdirSync(path.join(ws, "src", "coze"), { recursive: true });

const ANSWER = JSON.stringify({
  files: [{ path: "src/coze/hello.js", content: "module.exports.hi = () => 'hi from coze';" }],
  summary: "集成测试交付 hello.js",
});

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/v3/chat") {
      if (req.headers.authorization !== "Bearer pat_it_test") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!body.includes('"bot_id":"bot_it_test"')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "bot_id missing" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            id: "chat_it_1",
            status: "completed",
            messages: [{ role: "assistant", type: "answer", content: ANSWER }],
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});
await new Promise((r) => mock.listen(PORT_MOCK, "127.0.0.1", r));
console.log(`[it] mock coze api on :${PORT_MOCK}`);

const child = spawn(process.execPath, [path.join(root, "scripts", "coze-bridge.mjs")], {
  env: {
    ...process.env,
    COZE_BRIDGE_PORT: String(PORT_BRIDGE),
    COZE_API_BASE: `http://127.0.0.1:${PORT_MOCK}`,
    COZE_API_TOKEN: "pat_it_test",
    COZE_BOT_ID: "bot_it_test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
child.stdout.on("data", (d) => (bridgeLog += d));
child.stderr.on("data", (d) => (bridgeLog += d));
await new Promise((r) => setTimeout(r, 1200));

const health = await fetch(`http://127.0.0.1:${PORT_BRIDGE}/health`).then((r) => r.json());
console.log("health:", JSON.stringify(health));
if (!health.ok) {
  console.error("FAIL: 桥健康检查未通过");
  console.error(bridgeLog);
  process.exit(1);
}

const dispatch = await fetch(`http://127.0.0.1:${PORT_BRIDGE}/v1/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    taskId: "it1",
    title: "集成测试：创建 hello.js",
    description: "在 src/coze 下创建 hello.js，导出 hi() 返回 'hi from coze'。CommonJS。",
    zone: "src/coze",
    projectRoot: ws,
    deadlineMs: 60_000,
  }),
}).then((r) => r.json());
console.log("dispatch:", JSON.stringify(dispatch));

let events = { events: [], status: "running" };
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  events = await fetch(
    `http://127.0.0.1:${PORT_BRIDGE}/v1/runs/${encodeURIComponent(dispatch.runId)}/events?since=0`,
  ).then((r) => r.json());
  if (events.status !== "running") break;
}

console.log("--- 事件流 ---");
for (const e of events.events) console.log(`  ${e.kind}: ${e.text.slice(0, 110)}`);

const helloPath = path.join(ws, "src", "coze", "hello.js");
const exists = fs.existsSync(helloPath);
let hiResult = "未落盘";
if (exists) {
  const mod = require(helloPath);
  hiResult = typeof mod.hi === "function" ? mod.hi() : "hi 不是函数";
}

const completed = events.events.some((e) => e.kind === "completed");
const failures = events.events.filter((e) => e.kind === "failed");

child.kill();
mock.close();
try {
  fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
} catch {
  /* 清理尽力而为 */
}

console.log("--- 判定 ---");
console.log("completed 事件:", completed ? "✓" : "✗");
console.log("hello.js 落盘且可运行:", exists ? `✓ hi()=${hiResult}` : "✗ 未落盘");
console.log("失败事件:", failures.length === 0 ? "无 ✓" : failures.map((f) => f.text).join(" | "));
if (!completed || !exists || hiResult !== "hi from coze") {
  console.error("\nIT FAIL");
  process.exit(1);
}
console.log("\nIT PASS：Coze 桥全路径集成验证通过（鉴权/调用/解析/落盘/事件流）");
