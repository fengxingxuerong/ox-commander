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
import { handleMcpMessage, serveAuthHeaders, type ServeHttp } from "./mcp";

/**
 * 解析 `--serve-url=`。
 *
 * ⚠️ **拼错不能静默回落**（2026-10-05，D11 同构修复）：原实现只 `find` 到就
 * 用、找不到就用默认 `http://127.0.0.1:8787`，于是
 *
 *   --serve=http://x   （本仓库第四轮我自己踩过的那一个：文档写 --serve-url=）
 *   --serve_url=http://x
 *   --serve-url        （有 flag 无值）
 *
 * 全部回落到默认端口，**stderr 还照常打印 `serve-url=http://127.0.0.1:8787`** ——
 * 那行看起来像"我听懂了"，实际是默认值，于是每次工具调用都失败，而我把
 * 矛头指向了 MCP 服务本身。实测就是那么查了半天才发现是自己的 flag 写错。
 *
 * 与 `serve-main` 的 `--port` 同一处置：拿不准就 exit 1 并说清实际收到的值。
 * **不给** `--serve-url` 仍然是合法默认（本机 8787 就是常规用法）。
 */
export function serveArgv(argv: string[]): { base?: string; error?: string } {
  for (const a of argv) {
    if (a === "--serve-url") {
      return { error: "--serve-url 需要一个值（正确写法：--serve-url=http://127.0.0.1:8787）" };
    }
    if (a.startsWith("--serve-url=")) {
      const raw = a.slice("--serve-url=".length).trim();
      if (raw === "") return { error: "--serve-url= 后面是空的（正确写法：--serve-url=http://127.0.0.1:8787）" };
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return { error: `--serve-url 不是合法 URL：${JSON.stringify(raw)}` };
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { error: `--serve-url 只支持 http/https，实际收到：${u.protocol}` };
      }
      return { base: raw };
    }
  }
  // 拼错的近似 flag 也要报错：--serve / --serve_url / --serveurl 都曾经
  // 静默回落（本仓库第四轮真踩过 --serve=）。宁可多问一句。
  for (const a of argv) {
    if (/^-{1,2}serve[-_]?url/i.test(a) || a.startsWith("--serve=")) {
      return { error: `无法识别的参数：${JSON.stringify(a)}（正确写法：--serve-url=<http(s)://host:port>）` };
    }
  }
  return {};
}

function makeServeHttp(base: string, token?: string): ServeHttp {
  const url = (path: string) => `${base.replace(/\/$/, "")}${path}`;
  // 与 serve 侧的 opt-in 鉴权配对：设了 token（`OX_SERVE_TOKEN`）就给每个请求带上。
  // 不带的话，开了鉴权的 serve 会对 MCP 的每一次 get/post 回 401，看板整个哑掉。
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    ...serveAuthHeaders(token),
    ...extra,
  });
  return {
    async get(path) {
      const res = await fetch(url(path), { headers: headers() });
      return { status: res.status, body: await res.text() };
    },
    async post(path, body) {
      const res = await fetch(url(path), {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}

async function main(): Promise<void> {
  const parsedArgv = serveArgv(process.argv.slice(2));
  if (parsedArgv.error) {
    process.stderr.write(`[ox-mcp] ${parsedArgv.error}\n`);
    process.exit(1);
  }
  const base = parsedArgv.base ?? "http://127.0.0.1:8787";
  const token = process.env.OX_SERVE_TOKEN;
  const http = makeServeHttp(base, token);
  process.stderr.write(`[ox-mcp] serve-url=${base}（stdout 是协议通道，本行在 stderr）\n`);
  // 单独一行而不是把它塞进上一条模板的三元里：模板三元会多出一个"没人断言的
  // 日志文案位点"（逐位点审计里只会撒出存活、又不值得为一句 stderr 写 spawn 测试）。
  if (token) process.stderr.write("[ox-mcp] 已启用 OX_SERVE_TOKEN 鉴权（每个请求带 Authorization）\n");

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
