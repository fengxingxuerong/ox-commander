#!/usr/bin/env node
/**
 * Test fixture: a real stdio MCP server (JSON-RPC 2.0, one message per line).
 *
 * Kept dependency-free and outside `scripts/` on purpose: the script-wiring gate
 * only accepts scripts reachable from npm entries, and this is test infrastructure,
 * not an operator entry point. Tests spawn this file with the current Node binary,
 * so the client is exercised against a real child process rather than a fake.
 */
import process from "node:process";
import { appendFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length) ?? "normal";
if (mode === "exit-immediately") process.exit(1);
if (mode === "noisy") process.stdout.write("fixture: starting up (this is not JSON)\n");
if (mode === "noisy-many") {
  // 三行噪音：客户端只该报**第一条**（一个把日志写 stdout 的 server 会每行都坏）。
  for (let i = 1; i <= 3; i += 1) process.stdout.write(`noise line ${i}: not JSON\n`);
}

/**
 * 可选：把**客户端发来的**每一行原文追加到文件。
 *
 * 有些行为无法从 client API 观察（翻页时到底有没有带 cursor、中止后有没有多发
 * 一条 cancelled、反向请求有没有被回话），但都能在"客户端写出去的那一行"上看到。
 * 夹具侧记日志比在客户端上加注入点更诚实：断言的是真正过管道的东西。
 */
const logPath = process.argv.find((a) => a.startsWith("--log="))?.slice("--log=".length);
function log(line) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // 夹具写日志失败不改变被测行为。
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "text to echo" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description: "Always returns an MCP tool error",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "secret",
    description: "Returns a fake credential",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "big",
    description: "Returns more than the tool output budget",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hang",
    description: "Never answers",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function send(message) {
  // blank-lines：每条消息前面垫一个空行（空行必须被跳过，而不是中断整段解析）。
  const prefix = mode === "blank-lines" ? "\n" : "";
  process.stdout.write(`${prefix}${JSON.stringify(message)}\n`);
}

/** 噪音与正常响应写进**同一个 chunk**：客户端遇到坏行后必须继续解析后面的行。 */
function sendNoiseThen(message) {
  process.stdout.write(`fixture noise: not JSON\n${JSON.stringify(message)}\n`);
}

let listPage = 0;

function listTools(params) {
  const cursor = params && typeof params.cursor === "string" ? params.cursor : undefined;
  if (mode === "paged") {
    listPage += 1;
    if (listPage === 1) return { tools: [TOOLS[0]], nextCursor: "page-2" };
    return { tools: [TOOLS[1]] };
  }
  // 游标由服务端**按请求内容**决定（不是按调用次数）：没带 cursor 就永远给第一页。
  // 客户端漏传 cursor 时于是会拿到与上一页相同的 nextCursor，被判为"没有前进"。
  if (mode === "cursor-strict") {
    if (cursor === undefined) return { tools: [TOOLS[0]], nextCursor: "page-2" };
    if (cursor === "page-2") return { tools: [TOOLS[1]] };
    return { tools: [TOOLS[2]], nextCursor: "page-2" };
  }
  // 游标不前进：客户端必须自己停，否则会把一次发现变成十页。
  if (mode === "cursor-same") return { tools: [TOOLS[0]], nextCursor: "same" };
  // 游标成环（a → b → a）：靠"见过的游标"停，而不是靠"与上次相同"。
  if (mode === "cursor-cycle") {
    if (cursor === undefined) return { tools: [TOOLS[0]], nextCursor: "a" };
    if (cursor === "a") return { tools: [TOOLS[0]], nextCursor: "b" };
    return { tools: [TOOLS[0]], nextCursor: "a" };
  }
  // 形状不对的游标：空串 / 数字都该被当作"没有下一页"。
  if (mode === "cursor-empty") return { tools: [TOOLS[0]], nextCursor: "" };
  if (mode === "cursor-number") return { tools: [TOOLS[0]], nextCursor: 42 };
  return { tools: TOOLS };
}

function callTool(name, args) {
  if (name === "echo") return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] };
  if (name === "fail") return { content: [{ type: "text", text: "registered failure" }], isError: true };
  if (name === "secret") {
    return { content: [{ type: "text", text: "token=sk-abcdefghijklmnopqrstuvwxyz." }] };
  }
  if (name === "big") return { content: [{ type: "text", text: "x".repeat(9_000) }] };
  if (name === "hang") return undefined;
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  log(trimmed);
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    continue;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ox-fixture", version: "1.0.0" },
      },
    });
    if (mode === "exit-on-initialize") process.exit(2);
    if (mode === "stderr-then-exit") {
      // 先同步写 stderr（留出时间让客户端收下），下一次请求再退出 ——
      // 这样"关闭原因带 stderr 尾巴"这条断言不会靠运气。
      writeSync(2, "fixture: 端口占用，起不来\n");
    }
    if (mode === "reverse") {
      // 一条**带 id 的反向请求**（期待 client 回 method not found）+
      // 一条**不带 id 的通知**（不该有任何回话）。
      send({ jsonrpc: "2.0", id: 4242, method: "sampling/createMessage", params: {} });
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    }
    continue;
  }
  if (message.method === "notifications/initialized") continue;
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    continue;
  }
  if (message.method === "tools/list") {
    if (mode === "stderr-then-exit") process.exit(3);
    if (mode === "tools-list-array") {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
      continue;
    }
    if (mode === "tools-list-null") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
      continue;
    }
    send({ jsonrpc: "2.0", id: message.id, result: listTools(message.params) });
    continue;
  }
  if (message.method === "tools/call") {
    if (mode === "rpc-error") {
      // 没有数字 code 的 JSON-RPC 错误：客户端应回落到 -32603，且**不计入熔断**。
      send({ jsonrpc: "2.0", id: message.id, error: { message: "boom" } });
      continue;
    }
    if (mode === "rpc-error-numeric") {
      // message 不是字符串：错误文案应回落到整段 error 的 JSON。
      send({ jsonrpc: "2.0", id: message.id, error: { message: 42 } });
      continue;
    }
    const result = callTool(message.params?.name, message.params?.arguments ?? {});
    if (result === undefined) continue;
    const response = { jsonrpc: "2.0", id: message.id, result };
    if (mode === "noise-then-response") sendNoiseThen(response);
    else send(response);
    continue;
  }
  if (message.method === "notifications/cancelled") continue;
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}
