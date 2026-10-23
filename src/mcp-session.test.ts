import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChatSession } from "../electron/chat/session";
import { ToolRunner, type McpToolExecutor } from "../electron/chat/tool-runner";
import { McpPool } from "../electron/mcp/pool";
import { parseToolTurn, toolCatalogBlock } from "../shared/tools/protocol";
import { toMcpToolSpec } from "../shared/mcp";
import type { LlmClient } from "../shared/llm-client";
import type { ChatRequest, ChatResponse } from "../shared/providers";
import type { ToolCall, ToolResult, DynamicToolSpec } from "../shared/tools/spec";

class ScriptedClient implements LlmClient {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly replies: ChatResponse[]) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (!next) throw new Error("脚本用完");
    return next;
  }
}

class ScriptedRunner {
  readonly seen: ToolCall[] = [];
  async run(call: ToolCall): Promise<ToolResult> {
    this.seen.push(call);
    return { id: call.id, name: call.name, ok: true, output: "ok" };
  }
  /** 会话收尾会调它（真 runner 在这里关 MCP 子进程）；脚本壳没有可关的东西。 */
  dispose(): void {}
}

function assistant(text: string): ChatResponse {
  return { content: text, provider: "fake", model: "fake-1", usageTokens: 10 };
}

const TOOL_BLOCK = (o: unknown): string => `\`\`\`tool\n${JSON.stringify(o)}\n\`\`\``;
const SESSION_ID = "s-mcp-session";
const fixture = path.resolve(__dirname, "__fixtures__", "mcp-echo-server.mjs");

const poolDisposers: Array<() => void> = [];

function realPool(): McpPool {
  const pool = new McpPool({
    rootAbs: process.cwd(),
    manifests: [
      {
        name: "fixture",
        command: process.execPath,
        args: [fixture, "--mode=normal"],
        env: {},
        timeoutMs: 5_000,
      },
    ],
  });
  poolDisposers.push(() => pool.dispose());
  return pool;
}

afterEach(() => {
  for (const dispose of poolDisposers.splice(0)) dispose();
});

describe("ChatSession · MCP 动态工具（M7）", () => {
  it("真实 stdio server：目录进提示 → 模型调用 → 真进程返回 → 结果回灌", async () => {
    const client = new ScriptedClient([
      assistant(TOOL_BLOCK({ tool: "mcp__fixture__echo", arguments: { text: "hello from mcp" } })),
      assistant("收到 MCP 的回复"),
    ]);
    const pool = realPool();
    const runner = new ToolRunner({ rootAbs: process.cwd(), approvalPolicy: "never", mcp: pool });
    const session = new ChatSession({
      client,
      runner,
      rootAbs: process.cwd(),
      sessionId: SESSION_ID,
      toolProtocol: "text",
      dynamicTools: () => pool.discover(),
    });

    const transcript = await session.send("用 MCP 工具回显");
    expect(client.requests[0].messages[0]?.content).toContain("mcp__fixture__echo");
    const toolCall = transcript.entries.find((e) => e.kind === "tool_call");
    expect(toolCall?.text).toContain("MCP fixture");
    const result = transcript.entries.find((e) => e.kind === "tool_result");
    expect(result?.result).toMatchObject({ ok: true, output: "echo:hello from mcp" });
    // 工具结果真的回到了下一轮请求里（不是"模型假装调用过"）。
    expect(JSON.stringify(client.requests[1]?.messages ?? [])).toContain("echo:hello from mcp");

    session.dispose();
  });

  it("原生协议：发现的工具进 tools 数组，tool_calls 能按名寻址", async () => {
    const client = new ScriptedClient([
      {
        content: "",
        provider: "fake",
        model: "fake-1",
        toolCalls: [{ id: "call-1", name: "mcp__demo__echo", args: { text: "native" } }],
      },
      assistant("完成"),
    ]);
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const executor: McpToolExecutor = {
      async call(server, tool, args) {
        calls.push([server, tool, args]);
        return { ok: true, output: "native-ok" };
      },
      commandOf: () => "node",
      dispose() {},
    };
    const spec = toMcpToolSpec("demo", {
      name: "echo",
      description: "回声",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    const session = new ChatSession({
      client,
      runner: new ToolRunner({ rootAbs: process.cwd(), approvalPolicy: "never", mcp: executor }),
      rootAbs: process.cwd(),
      sessionId: "s-native-mcp",
      toolProtocol: "native",
      dynamicTools: async () => ({ specs: [spec] }),
    });

    const transcript = await session.send("用原生工具");
    expect(client.requests[0].tools?.map((t) => t.name)).toContain("mcp__demo__echo");
    expect(calls).toEqual([["demo", "echo", { text: "native" }]]);
    expect(transcript.entries.find((e) => e.kind === "tool_result")?.result).toMatchObject({
      ok: true,
      output: "native-ok",
    });
  });

  it("发现失败只降级：内置工具照用，转录里留下原因", async () => {
    const client = new ScriptedClient([assistant("没有 MCP 也能答")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner() as unknown as ToolRunner,
      rootAbs: process.cwd(),
      sessionId: "s-mcp-fail",
      dynamicTools: async () => {
        throw new Error("连接被拒绝");
      },
    });
    const transcript = await session.send("hi");
    expect(transcript.entries.some((e) => e.kind === "system" && e.text.includes("工具发现失败"))).toBe(true);
    expect(client.requests[0].messages[0]?.content).not.toContain("mcp__");
    expect(transcript.entries.at(-1)?.text).toContain("没有 MCP 也能答");
  });

  it("发现阶段的问题逐条进系统条目；只发现一次", async () => {
    let discovers = 0;
    const spec: DynamicToolSpec = toMcpToolSpec("demo", {
      name: "echo",
      description: "回声",
      inputSchema: { type: "object", properties: {} },
    });
    const client = new ScriptedClient([assistant("一"), assistant("二")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner() as unknown as ToolRunner,
      rootAbs: process.cwd(),
      sessionId: "s-mcp-issues",
      dynamicTools: async () => {
        discovers += 1;
        return { specs: [spec], issues: ["MCP server bad 不可用：ENOENT"] };
      },
    });
    await session.send("第一句");
    await session.send("第二句");
    expect(discovers).toBe(1);
    expect(session.transcript().entries.some((e) => e.text.includes("MCP server bad 不可用"))).toBe(true);
    expect(session.transcript().entries.some((e) => e.text.includes("已接入 MCP 工具 1 个"))).toBe(true);
  });

  it("文本协议解析接受动态工具名；参数不合 schema 时把理由回灌而不是执行", () => {
    const spec = toMcpToolSpec("demo", {
      name: "echo",
      description: "回声",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    const ok = parseToolTurn(TOOL_BLOCK({ tool: "mcp__demo__echo", arguments: { text: "x" } }), {
      extraSpecs: [spec],
    });
    expect(ok.calls.map((c) => c.name)).toEqual(["mcp__demo__echo"]);
    expect(ok.problems).toEqual([]);

    const missing = parseToolTurn(TOOL_BLOCK({ tool: "mcp__demo__echo", arguments: {} }), {
      extraSpecs: [spec],
    });
    expect(missing.calls).toEqual([]);
    expect(missing.problems[0]).toContain("缺少必填参数：text");

    const unknown = parseToolTurn(TOOL_BLOCK({ tool: "mcp__demo__nope", arguments: {} }), {
      extraSpecs: [spec],
    });
    expect(unknown.problems[0]).toContain("未登记的工具名");
  });

  it("文本协议目录能渲染 MCP 的任意 JSON Schema（不做最小子集假设）", () => {
    const spec = toMcpToolSpec("demo", {
      name: "search",
      description: "搜索",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词" },
          limit: { type: "integer", description: "条数" },
          mode: { type: ["string", "number"], description: "模式" },
        },
        required: ["query"],
      },
    });
    const block = toolCatalogBlock(["mcp__demo__search"], [spec]);
    expect(block).toContain("mcp__demo__search");
    expect(block).toContain("query（string，必填）");
    expect(block).toContain("limit（integer，可选）");
    expect(block).toContain("mode（string|number，可选）");
  });

  it("畸形 schema 也不炸：properties 不是对象 → 「无参数」；属性值不是对象 → any；描述缺席 → 无说明", () => {
    // 第三方 server 的 inputSchema 是任意 JSON Schema 子集，这三类形状都真出现过：
    // 把它们当"最小子集假设"成立的话，目录渲染会在会话启动时抛异常 —— 一个坏
    // server 的 schema 就能让整个提示拼不出来。
    const notObject = {
      name: "mcp__demo__not-object",
      description: "properties 是字符串",
      parameters: { properties: "不是对象", required: "也不是数组" },
    };
    expect(toolCatalogBlock(["mcp__demo__not-object"], [notObject as never])).toContain("（无参数）");

    const arrayProps = {
      name: "mcp__demo__array",
      description: "properties 是数组",
      parameters: { properties: [] },
    };
    expect(toolCatalogBlock(["mcp__demo__array"], [arrayProps as never])).toContain("（无参数）");

    const oddProps = {
      name: "mcp__demo__odd",
      description: "属性值畸形",
      parameters: {
        properties: {
          nullProp: null,
          stringProp: "x",
          typed: { type: "string" },
        },
        required: ["typed"],
      },
    };
    const block = toolCatalogBlock(["mcp__demo__odd"], [oddProps as never]);
    // 非对象的属性值按空对象处理：类型 any、说明「无说明」，而不是原样打印或抛错。
    expect(block).toContain("nullProp（any，可选）：（无说明）");
    expect(block).toContain("stringProp（any，可选）：（无说明）");
    // 描述缺席时也要给占位说明（否则界面上是一行空白）。
    expect(block).toContain("typed（string，必填）：（无说明）");
  });

  it("发现只出来问题（一个工具都没有）时也要落盘：系统条目不能只活在内存里", async () => {
    const snapshots: Array<{ entries: Array<{ kind: string; text: string }> }> = [];
    const failing = new McpPool({
      rootAbs: process.cwd(),
      manifests: [
        {
          name: "gone",
          command: process.execPath,
          args: [fixture, "--mode=exit-immediately"],
          env: {},
          timeoutMs: 2_000,
        },
      ],
    });
    poolDisposers.push(() => failing.dispose());
    const discovery = await failing.discover();
    expect(discovery.specs).toEqual([]);
    expect(discovery.issues.length).toBeGreaterThan(0);

    const session = new ChatSession({
      client: new ScriptedClient([assistant("知道了")]),
      runner: new ScriptedRunner() as unknown as ToolRunner,
      rootAbs: process.cwd(),
      sessionId: "s-mcp-issues-only",
      toolProtocol: "text",
      dynamicTools: () => Promise.resolve(discovery),
      onPersist: (snap) => snapshots.push(snap as never),
    });
    await session.send("试试 MCP");

    // 第一条含 MCP 问题的快照必须**在模型回话之前**就落过盘 —— 也就是发现阶段
    // 自己触发了持久化。只有"有工具"才落盘的话，这条线索会随进程一起消失。
    const firstWithIssue = snapshots.find((s) =>
      s.entries.some((e) => e.kind === "system" && e.text.includes("MCP server gone")),
    );
    expect(firstWithIssue).toBeDefined();
    expect(firstWithIssue?.entries.filter((e) => e.kind === "assistant")).toHaveLength(0);
    session.dispose();
  });
});
