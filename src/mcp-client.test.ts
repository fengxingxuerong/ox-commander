import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  McpAbortError,
  McpClient,
  McpRpcError,
  McpTimeoutError,
  MCP_COOLDOWN_MS,
  MCP_MAX_CONSECUTIVE_FAILURES,
} from "../electron/mcp/client";
import { McpPool, type McpClientLike } from "../electron/mcp/pool";
import { MAX_MCP_TOOLS_PER_SERVER, MAX_MCP_TOOLS_PER_SESSION, type McpServerManifest, type McpToolDef } from "../shared/mcp";

const fixture = path.resolve(__dirname, "__fixtures__", "mcp-echo-server.mjs");
const clients: McpClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function manifest(mode = "normal", overrides: Partial<McpServerManifest> = {}): McpServerManifest {
  return {
    name: "fixture",
    command: process.execPath,
    args: [fixture, `--mode=${mode}`],
    env: {},
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeClient(
  mode = "normal",
  overrides: Partial<McpServerManifest> = {},
  opts: { now?: () => number; spawn?: typeof spawn; onEvent?: (text: string) => void } = {},
): McpClient {
  const client = new McpClient({
    manifest: manifest(mode, overrides),
    cwd: process.cwd(),
    ...opts,
  });
  clients.push(client);
  return client;
}

/** 带 `--log=` 的客户端：夹具把**客户端写出去的每一行**记进文件，供"管道上到底发了什么"的断言。 */
function makeLoggedClient(mode: string, logPath: string, opts: { onEvent?: (text: string) => void } = {}): McpClient {
  const client = new McpClient({
    manifest: { ...manifest(mode), args: [fixture, `--mode=${mode}`, `--log=${logPath}`] },
    cwd: process.cwd(),
    ...opts,
  });
  clients.push(client);
  return client;
}

/** 一次性的临时目录 + 读日志。 */
async function withLog<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mcp-log-"));
  const logPath = path.join(dir, "client.log");
  try {
    return await fn(logPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const readLog = (logPath: string): string => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("McpClient · 真实 stdio 进程", () => {
  it("握手 + tools/list + tools/call 走通", async () => {
    const client = makeClient();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "fail", "secret", "big", "hang"]);
    await expect(client.callTool("echo", { text: "hello" })).resolves.toEqual({
      text: "echo:hello",
      isError: false,
    });
  });

  it("工具自己的 isError 是业务失败，不触发熔断", async () => {
    const client = makeClient();
    const result = await client.callTool("fail", {});
    expect(result).toEqual({ text: "registered failure", isError: true });
    // 还能继续用同一个进程。
    await expect(client.callTool("echo", { text: "still alive" })).resolves.toMatchObject({ text: "echo:still alive" });
  });

  it("分页 tools/list 会翻页；stdout 里的非 JSON 噪音不影响连接", async () => {
    const paged = makeClient("paged");
    expect((await paged.listTools()).map((t) => t.name)).toEqual(["echo", "fail"]);

    const noisy = makeClient("noisy");
    expect((await noisy.listTools()).map((t) => t.name)).toContain("echo");
  });

  it("server 进程起不来时 connect 拒绝，并进入连续失败计数/冷却", async () => {
    let spawns = 0;
    let now = 1_000;
    const spawnCounted = ((...args: Parameters<typeof spawn>) => {
      spawns += 1;
      return spawn(...args);
    }) as typeof spawn;
    const client = makeClient("exit-immediately", {}, { now: () => now, spawn: spawnCounted });
    for (let i = 0; i < MCP_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await expect(client.connect()).rejects.toThrow(/MCP server fixture/);
    }
    expect(spawns).toBe(MCP_MAX_CONSECUTIVE_FAILURES);
    await expect(client.connect()).rejects.toThrow(/冷却/);
    // 冷却窗口内不再起新进程。
    expect(spawns).toBe(MCP_MAX_CONSECUTIVE_FAILURES);
    now += MCP_COOLDOWN_MS;
    // 窗口过后允许重试一次（仍然失败，说明冷却不是永久拉黑）。
    await expect(client.connect()).rejects.toThrow();
    expect(spawns).toBe(MCP_MAX_CONSECUTIVE_FAILURES + 1);
  });

  it("调用超时会拒绝并杀掉 server（下一次调用重新起进程）", async () => {
    const client = makeClient("normal", { timeoutMs: 500 });
    const started = Date.now();
    await expect(client.callTool("hang", {})).rejects.toBeInstanceOf(McpTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
    // 超时的那条进程已被杀：新调用会重新握手（echo 仍可用）。
    await expect(client.callTool("echo", { text: "after timeout" })).resolves.toMatchObject({
      text: "echo:after timeout",
    });
  });

  it("中止会把在途调用以 McpAbortError 收尾，而不是等满超时", async () => {
    const client = makeClient("normal", { timeoutMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 40);
    await expect(client.callTool("hang", {}, controller.signal)).rejects.toBeInstanceOf(McpAbortError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("未声明的工具直接拒（即使 server 内部存在）", async () => {
    const client = makeClient();
    await client.listTools();
    await expect(client.callTool("not-listed", {})).rejects.toThrow("没有声明工具");
  });

  it("dispose 后不再接受调用", async () => {
    const client = makeClient();
    await client.listTools();
    client.dispose();
    await expect(client.connect()).rejects.toThrow("已关闭");
  });
});

/* ───────────────────────── McpClient · JSON-RPC 边界 ───────────────────────── */

/**
 * 这一组钉的是"只有在异常路径上才成立"的行为，而且尽量断言**管道上真正流过的东西**
 * （夹具的 `--log=`）而不是客户端内部状态：游标有没有带出去、通知有没有多发一条、
 * 反向请求有没有回话 —— 那些在 API 上看起来都"没差别"，却正是对方 server 会踩的坑。
 */
describe("McpClient · JSON-RPC 边界", () => {
  it("翻页时把 cursor 真的发出去（不带 cursor 的第二次请求会永远拿到第一页）", async () => {
    await withLog(async (logPath) => {
      const client = makeLoggedClient("cursor-strict", logPath);
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", "fail"]);
      const listLines = readLog(logPath)
        .split("\n")
        .filter((l) => l.includes("tools/list"));
      expect(listLines.some((l) => l.includes('"cursor":"page-2"'))).toBe(true);
    });
  });

  it("游标不前进就停下；形状不对（空串 / 数字）当作没有下一页；成环靠「见过的游标」停", async () => {
    // cursor-same：服务端每页都回同一个游标 —— 客户端必须自己停（否则十页）。
    expect((await makeClient("cursor-same").listTools()).map((t) => t.name)).toEqual(["echo", "echo"]);
    // cursor-empty / cursor-number：不算合法游标，一页就结束。
    expect((await makeClient("cursor-empty").listTools()).map((t) => t.name)).toEqual(["echo"]);
    expect((await makeClient("cursor-number").listTools()).map((t) => t.name)).toEqual(["echo"]);
    // cursor-cycle：a → b → a，只能靠"见过"发现，靠"与上次相同"发现不了。
    await withLog(async (logPath) => {
      const client = makeLoggedClient("cursor-cycle", logPath);
      expect((await client.listTools()).map((t) => t.name)).toEqual(["echo", "echo", "echo"]);
      const listCalls = readLog(logPath)
        .split("\n")
        .filter((l) => l.includes("tools/list"));
      expect(listCalls).toHaveLength(3);
    });
  });

  it("stdout 噪音只报第一条；噪音与正常响应同 chunk 时后面那行照常解析", async () => {
    const events: string[] = [];
    const noisy = makeClient("noisy-many", {}, { onEvent: (text) => events.push(text) });
    expect((await noisy.listTools()).map((t) => t.name)).toContain("echo");
    // 三行噪音只报一次（每行都报会把界面刷满，等于没有信息）。
    expect(events.filter((e) => e.includes("输出了非 JSON 行"))).toHaveLength(1);

    // 坏行在前、响应紧随其后（同一个 chunk）：把坏行当"中断"处理的话响应就丢了。
    const mixed = makeClient("noise-then-response");
    await expect(mixed.callTool("echo", { text: "after noise" })).resolves.toMatchObject({
      text: "echo:after noise",
    });
  });

  it("空行不中断解析（消息之间垫空行是第三方 server 的常态）", async () => {
    const client = makeClient("blank-lines");
    await expect(client.callTool("echo", { text: "after blank" })).resolves.toMatchObject({
      text: "echo:after blank",
    });
  });

  it("关闭原因带 stderr 尾巴；stderr 为空时不留一个空的「尾部」", async () => {
    const silent = makeClient("exit-immediately");
    const silentErr = (await silent.connect().catch((e: unknown) => e)) as Error;
    expect(silentErr.message).not.toContain("stderr 尾部");

    const noisy = makeClient("stderr-then-exit");
    const noisyErr = (await noisy.connect().catch((e: unknown) => e)) as Error;
    expect(noisyErr.message).toContain("stderr 尾部");
    expect(noisyErr.message).toContain("端口占用");
  });

  it("tools/list 的 result 不是对象 → 连接失败并说清（不是当成空工具表放过）", async () => {
    await expect(makeClient("tools-list-array").connect()).rejects.toThrow(/tools\/list 返回的不是对象/);
    await expect(makeClient("tools-list-null").connect()).rejects.toThrow(/tools\/list 返回的不是对象/);
  });

  it("JSON-RPC 错误是业务失败：不触发熔断，没数字 code 时回落 -32603，非字符串 message 回落整段 JSON", async () => {
    const events: string[] = [];
    const client = makeClient("rpc-error", {}, { onEvent: (text) => events.push(text) });
    for (let i = 0; i < MCP_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await expect(client.callTool("echo", {})).rejects.toMatchObject({ code: -32603 });
    }
    // 业务错误不计入连续失败 —— 否则 model 手滑调错三次就被冷却十分钟。
    expect(events.some((e) => e.includes("冷却"))).toBe(false);
    // 文案用 server 给的 message 原文，而不是包一层 JSON。
    const err = (await client.callTool("echo", {}).catch((e: unknown) => e)) as McpRpcError;
    expect(err).toBeInstanceOf(McpRpcError);
    expect(err.message).toContain("返回错误：boom");

    const numeric = makeClient("rpc-error-numeric");
    const numericErr = (await numeric.callTool("echo", {}).catch((e: unknown) => e)) as McpRpcError;
    expect(numericErr.message).toContain('{"message":42}');
  });

  it("反向请求回 method not found；不带 id 的通知不回话", async () => {
    await withLog(async (logPath) => {
      const client = makeLoggedClient("reverse", logPath);
      await client.listTools();
      await wait(120);
      const replies = readLog(logPath)
        .split("\n")
        .filter((l) => l.includes("-32601"));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("4242");
    });
  });

  it("中止一个已经完成的调用：不再补发 cancelled，也不因此杀掉 server", async () => {
    await withLog(async (logPath) => {
      const client = makeLoggedClient("normal", logPath);
      await client.listTools();
      const controller = new AbortController();
      await expect(client.callTool("echo", { text: "done" }, controller.signal)).resolves.toMatchObject({
        text: "echo:done",
      });
      controller.abort();
      await wait(120);
      expect(readLog(logPath)).not.toContain("notifications/cancelled");
      // 还能继续用同一个进程。
      await expect(client.callTool("echo", { text: "alive" })).resolves.toMatchObject({ text: "echo:alive" });
    });
  });

  it("连接失败后 dispose 不炸（child 已为空时不再去杀它）", async () => {
    const client = makeClient("exit-immediately");
    await expect(client.connect()).rejects.toThrow();
    expect(() => client.dispose()).not.toThrow();
  });
});

/* ───────────────────────── McpPool（假 client，专注聚合逻辑） ───────────────────────── */

interface FakeOptions {
  tools?: McpToolDef[];
  fail?: string;
  text?: string;
}

function fakeClient(name: string, opts: FakeOptions = {}): McpClientLike & { calls: string[]; disposed: number } {
  const calls: string[] = [];
  let disposed = 0;
  return {
    calls,
    get disposed() {
      return disposed;
    },
    async listTools() {
      if (opts.fail !== undefined) throw new Error(opts.fail);
      return opts.tools ?? [];
    },
    async callTool(tool) {
      calls.push(`${name}/${tool}`);
      return { text: opts.text ?? `${name}:${tool}`, isError: false };
    },
    dispose() {
      disposed += 1;
    },
  };
}

function tool(name: string): McpToolDef {
  return { name, description: `${name} desc`, inputSchema: { type: "object", properties: {} } };
}

function pool(manifests: McpServerManifest[], fakeFor: (name: string) => McpClientLike): McpPool {
  return new McpPool({
    rootAbs: process.cwd(),
    manifests,
    clientFactory: (m) => fakeFor(m.name),
  });
}

describe("McpPool · 发现上限与路由", () => {
  it("失败的 server 变成问题，健康 server 的工具照常声明（坏的那个排前面也一样）", async () => {
    const p = pool(
      // 坏的排**前面**：一个 server 连不上不该让后面所有 server 都不被发现。
      [manifest("normal", { name: "bad" }), manifest("normal", { name: "good" })],
      (name) => (name === "bad" ? fakeClient(name, { fail: "ENOENT" }) : fakeClient(name, { tools: [tool("echo")] })),
    );
    const d = await p.discover();
    expect(d.specs.map((s) => s.name)).toEqual(["mcp__good__echo"]);
    expect(d.issues.join()).toContain("bad 不可用：ENOENT");
    p.dispose();
  });

  it("单 server 与单会话的工具上限都会说破，且顺序稳定", async () => {
    const many = Array.from({ length: MAX_MCP_TOOLS_PER_SERVER + 10 }, (_, i) => tool(`t${String(i).padStart(3, "0")}`));
    const p = pool(
      [manifest("normal", { name: "a" }), manifest("normal", { name: "b" })],
      (name) => fakeClient(name, { tools: many }),
    );
    const d = await p.discover();
    expect(d.specs).toHaveLength(MAX_MCP_TOOLS_PER_SESSION);
    expect(d.specs[0]?.name).toBe("mcp__a__t000");
    expect(d.issues.some((i) => i.includes(`单 server ${MAX_MCP_TOOLS_PER_SERVER} 个上限`))).toBe(true);
    expect(d.issues.some((i) => i.includes(`单会话 ${MAX_MCP_TOOLS_PER_SESSION} 个上限`))).toBe(true);
    // 溢出**数量**也要对：达到上限就中断的话只会记下一条，而"后 N 个未声明"会骗人。
    const overflow = 2 * MAX_MCP_TOOLS_PER_SERVER - MAX_MCP_TOOLS_PER_SESSION;
    expect(d.issues.some((i) => i.includes(`后 ${overflow} 个未声明`))).toBe(true);
    // 只发现一次：第二次调用拿缓存。
    expect(await p.discover()).toEqual(d);
    p.dispose();
  });

  it("调用按 server 路由；未声明/未知 server 不触达 client", async () => {
    const a = fakeClient("a", { tools: [tool("echo")] });
    const b = fakeClient("b", { tools: [tool("echo")] });
    const p = pool([manifest("normal", { name: "a" }), manifest("normal", { name: "b" })], (name) =>
      name === "a" ? a : b,
    );
    await p.discover();
    await expect(p.call("a", "echo", {})).resolves.toEqual({ ok: true, output: "a:echo" });
    await expect(p.call("b", "echo", {})).resolves.toEqual({ ok: true, output: "b:echo" });
    await expect(p.call("a", "not-declared", {})).resolves.toMatchObject({ ok: false });
    await expect(p.call("missing", "echo", {})).resolves.toMatchObject({ ok: false });
    expect(a.calls).toEqual(["a/echo"]);
    expect(b.calls).toEqual(["b/echo"]);
    expect(p.commandOf("a")).toBe(process.execPath);
    expect(p.commandOf("missing")).toBeUndefined();
    p.dispose();
    p.dispose();
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);
    await expect(p.call("a", "echo", {})).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("已关闭") });
  });

  it("工具 isError 变成失败结果，异常也变成失败结果（不抛出到会话层）", async () => {
    const failing: McpClientLike = {
      async listTools() {
        return [tool("bad")];
      },
      async callTool() {
        return { text: "nope", isError: true };
      },
      dispose() {},
    };
    const throwing: McpClientLike = {
      async listTools() {
        return [tool("boom")];
      },
      async callTool() {
        throw new Error("pipe closed");
      },
      dispose() {},
    };
    const p = pool(
      [manifest("normal", { name: "f" }), manifest("normal", { name: "t" })],
      (name) => (name === "f" ? failing : throwing),
    );
    await p.discover();
    await expect(p.call("f", "bad", {})).resolves.toEqual({ ok: false, output: "", reason: "nope" });
    await expect(p.call("t", "boom", {})).resolves.toEqual({ ok: false, output: "", reason: "pipe closed" });
    p.dispose();
  });

  it("没有清单时发现是空操作", async () => {
    const p = pool([], () => fakeClient("none"));
    expect(await p.discover()).toEqual({ specs: [], issues: [] });
    p.dispose();
  });
});
