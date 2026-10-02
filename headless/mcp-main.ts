/**
 * 反向 MCP server 的 IO 胶水：stdin 按行读 JSON-RPC，stdout 写回响应。
 *
 * 与 serve-main 的分工：serve 是"人/CI 看与投"，这里是"agent 驱动"。两者
 * 指向**同一个** serve 实例（本进程不跑 run、不持状态 —— 只是 serve HTTP 面
 * 的 MCP 译码器），所以 `--serve-url` 指向哪，看板就是哪一个。
 *
 * 协议纪律：stdout 只写 JSON-RPC 响应（一行一个），日志走 stderr —— stdout
 * 被客户端当作协议通道，混进一行日志整个会话就坏了。
 *
 * 用法：
 *   node dist-headless/headless/mcp-main.js --serve-url=http://127.0.0.1:8787
 * 客户端（如 Loomy）把本进程注册为 MCP stdio server 即可；stdin 关闭即退出。
 */
import * as readline from "node:readline";
import { handleMcpMessage, type ServeHttp } from "./mcp";

function serveArgv(): string {
  const arg = process.argv.find((a) => a.startsWith("--serve-url="));
  return arg ? arg.slice("--serve-url=".length) : "http://127.0.0.1:8787";
}

function makeServeHttp(base: string): ServeHttp {
  const url = (path: string) => `${base.replace(/\/$/, "")}${path}`;
  return {
    async get(path) {
      const res = await fetch(url(path));
      return { status: res.status, body: await res.text() };
    },
    async post(path, body) {
      const res = await fetch(url(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}

async function main(): Promise<void> {
  const base = serveArgv();
  const http = makeServeHttp(base);
  process.stderr.write(`[ox-mcp] serve-url=${base}（stdout 是协议通道，本行在 stderr）\n`);

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[ox-mcp] 非法 JSON 行已忽略（长度 ${trimmed.length}）\n`);
      continue;
    }
    const out = await handleMcpMessage(msg, http);
    if (out !== undefined) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`[ox-mcp] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
