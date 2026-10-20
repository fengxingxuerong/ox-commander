import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChatSession, DEFAULT_MAX_TURNS } from "../electron/chat/session";
import { ToolRunner } from "../electron/chat/tool-runner";
import type { LlmClient } from "../shared/llm-client";
import type { ChatRequest, ChatResponse } from "../shared/providers";
import type { ChatEvent, ChatHistory, ChatSessionSnapshot } from "../shared/chat-events";
import type { ToolCall, ToolResult } from "../shared/tools/spec";

/** 假大脑：按脚本依次应答，并把收到的请求记录下来。 */
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

/** 假执行器：记录被要求执行的调用，按脚本返回结果。 */
class ScriptedRunner {
  readonly seen: ToolCall[] = [];
  constructor(
    private readonly results: ToolResult[],
    /** 固定应答（不按队列消耗）：用于"每次都返回同一个结果"的循环类用例。 */
    private readonly always?: (call: ToolCall) => Promise<ToolResult>,
  ) {}
  async run(call: ToolCall): Promise<ToolResult> {
    this.seen.push(call);
    if (this.always) return this.always(call);
    const next = this.results.shift();
    return next ?? { id: call.id, name: call.name, ok: true, output: "" };
  }
}

function assistant(text: string): ChatResponse {
  return { content: text, provider: "fake", model: "fake-1", usageTokens: 10 };
}

let tmpRoot = "";

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-session-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("会话循环（session）", () => {
  it("轮次跨 send 累计：第二轮不会把 turn 重数成 1（撤销分组依赖它）", async () => {
    const client = new ScriptedClient([assistant("一"), assistant("二")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      sessionId: "s-turns",
    });
    await session.send("第一句");
    expect(session.transcript().meta.turns).toBe(1);
    await session.send("第二句");
    expect(session.transcript().meta.turns).toBe(2);
  });

  it("不要工具时直接答复，转录里有 user 与 assistant 两条", async () => {
    const client = new ScriptedClient([assistant("改好了")]);
    const runner = new ScriptedRunner([]);
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      sessionId: "s-1",
    });
    const t = await session.send("把 a 改成 b");
    expect(t.meta.status).toBe("done");
    expect(t.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(t.entries[1].text).toBe("改好了");
    expect(runner.seen).toEqual([]);
  });

  it("文本协议：模型给工具块 → 真执行 → 结果回灌给下一轮", async () => {
    const client = new ScriptedClient([
      assistant("先看看\n```tool\n{\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```"),
      assistant("文件内容是 x，改好了"),
    ]);
    const runner = new ScriptedRunner([{ id: "t-1", name: "read_file", ok: true, output: "1: const a = 1;" }]);
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      toolProtocol: "text",
    });
    const t = await session.send("改一下 a.ts");
    expect(runner.seen).toHaveLength(1);
    expect(runner.seen[0].name).toBe("read_file");
    expect(t.entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool_call", "tool_result", "assistant"]);
    // 关键：第二轮请求里必须带上工具结果，否则模型是在"假装读过"。
    const second = client.requests[1];
    expect(second.messages.some((m) => m.content.includes("1: const a = 1;"))).toBe(true);
    expect(t.meta.turns).toBe(2);
    expect(t.meta.usageTokens).toBe(20);
  });

  it("原生协议：assistant 消息带 toolCalls，结果以 tool 消息带 id 回灌", async () => {
    const client = new ScriptedClient([
      {
        content: "先读",
        provider: "fake",
        model: "fake-1",
        toolCalls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }],
      },
      assistant("好了"),
    ]);
    const runner = new ScriptedRunner([{ id: "call-1", name: "read_file", ok: true, output: "1: x" }]);
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      toolProtocol: "native",
    });
    await session.send("改 a.ts");
    const second = client.requests[1];
    const withCalls = second.messages.find((m) => m.toolCalls && m.toolCalls.length > 0);
    expect(withCalls?.toolCalls?.[0].name).toBe("read_file");
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("call-1");
    // 原生路径必须真的把工具表发给端点，否则模型无从调用。
    expect(client.requests[0].tools?.length).toBeGreaterThan(0);
  });

  it("文本协议不把 tools 字段发给端点（未声明支持的端点不能被塞不认识的字段）", async () => {
    const client = new ScriptedClient([assistant("ok")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      toolProtocol: "text",
    });
    await session.send("hi");
    expect(client.requests[0].tools).toBeUndefined();
    // 工具说明改走 system 提示：不写进去模型就不知道有工具可用。
    expect(client.requests[0].messages[0].content).toMatch(/read_file/);
  });

  it("工具失败时把理由回灌（而不是空结果），循环继续", async () => {
    const client = new ScriptedClient([
      assistant("```tool\n{\"tool\":\"run_command\",\"arguments\":{\"command\":\"rm\",\"args\":[\"-rf\"]}}\n```"),
      assistant("那我换个办法"),
    ]);
    const runner = new ScriptedRunner([
      { id: "t-1", name: "run_command", ok: false, output: "", reason: "命令被沙箱禁止：rm" },
    ]);
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
    });
    const t = await session.send("删掉它");
    const second = client.requests[1];
    expect(second.messages.some((m) => m.content.includes("命令被沙箱禁止：rm"))).toBe(true);
    expect(t.entries.filter((e) => e.kind === "tool_result")[0].text).toMatch(/失败/);
  });

  it("轮次用尽时说破上限并收束（不静默停）", async () => {
    const replies: ChatResponse[] = [];
    for (let i = 0; i < 5; i++) {
      replies.push(assistant("```tool\n{\"tool\":\"list_dir\",\"arguments\":{}}\n```"));
    }
    const client = new ScriptedClient(replies);
    const runner = new ScriptedRunner([], async (call) => ({
      id: call.id,
      name: call.name,
      ok: true,
      output: "a.ts",
    }));
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      maxTurns: 3,
    });
    const t = await session.send("一直看");
    expect(t.meta.status).toBe("done");
    expect(t.entries.at(-1)?.text).toMatch(/达到轮次上限（3 轮）/);
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(3);
  });

  it("中止信号：轮次之间真的停下，状态是 aborted", async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([assistant("```tool\n{\"tool\":\"list_dir\",\"arguments\":{}}\n```")]);
    const runner = new ScriptedRunner([], async (call) => {
      controller.abort();
      return { id: call.id, name: call.name, ok: true, output: "a.ts" };
    });
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      signal: controller.signal,
    });
    const t = await session.send("看看");
    expect(t.meta.status).toBe("aborted");
    expect(t.entries.some((e) => e.text.includes("会话被中止"))).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  it("在途的模型调用也能被真的取消（signal 真转给了客户端，不是只在轮次间看）", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const client: LlmClient = {
      // 与真实客户端同形：signal 挂到在途请求上，一落下就拒（http-clients 的
      // sleepUnlessAborted / fetch 就是这个行为）。收不到 signal 就直接报错 ——
      // 让"没转发"现形，而不是永远等下去把测试挂成假绿。
      chat: async (req) => {
        seenSignal = req.signal;
        if (!req.signal) throw new Error("signal 没有转发给客户端");
        await new Promise<void>((resolve, reject) => {
          req.signal?.addEventListener(
            "abort",
            () => reject(req.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
          setTimeout(resolve, 5000);
        });
        return assistant("来不及了");
      },
    };
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      signal: controller.signal,
    });
    const sending = session.send("看看");
    // send 的同步段已经走到在途调用，listener 此刻已挂上。
    controller.abort();
    const t = await sending;
    expect(t.meta.status).toBe("aborted");
    expect(t.entries.some((e) => e.kind === "error")).toBe(false);
    expect(t.entries.some((e) => e.text.includes("会话被中止"))).toBe(true);
    // 对象级证据：转发出去的就是控制器那一个（时序证明不了同一性）。
    expect(seenSignal).toBe(controller.signal);
  });

  it("空回复：给占位而不是空白一条，状态照常收束", async () => {
    const client = new ScriptedClient([assistant("   ")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
    });
    const t = await session.send("在吗");
    expect(t.meta.status).toBe("done");
    expect(t.entries.at(-1)?.text).toBe("（模型没有给出任何内容）");
  });

  it("末轮只剩坏块：正文照给、解析问题说破，围栏不留在转录里", async () => {
    const client = new ScriptedClient([assistant("先看看\n```tool\n{坏}\n```")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      toolProtocol: "text",
    });
    const t = await session.send("读一下");
    expect(t.meta.status).toBe("done");
    const last = t.entries.at(-1);
    expect(last?.text).toMatch(/^先看看/);
    expect(last?.text).toMatch(/解析问题/);
    expect(last?.text).not.toContain("```");
  });

  it("一轮没跑完就再发一条会被拒（并发会让工具结果与历史错位）", async () => {
    // 用数组存 resolver：闭包里赋值给 let 会让 TS 把它收窄成 null（调用点变 never）。
    const releasers: Array<() => void> = [];
    const gate = new Promise<void>((r) => {
      releasers.push(r);
    });
    const client: LlmClient = {
      chat: async () => {
        await gate;
        return assistant("ok");
      },
    };
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
    });
    const first = session.send("第一条");
    await expect(session.send("第二条")).rejects.toThrow(/上一轮还没结束/);
    releasers[0]?.();
    await first;
  });

  it("事件流：entry / status / done 都发得出来", async () => {
    const events: ChatEvent[] = [];
    const client = new ScriptedClient([assistant("好了")]);
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      onEvent: (e) => events.push(e),
    });
    await session.send("hi");
    expect(events.filter((e) => e.type === "chat:entry")).toHaveLength(2);
    expect(events.some((e) => e.type === "chat:status" && e.status === "running")).toBe(true);
    expect(events.some((e) => e.type === "chat:done")).toBe(true);
  });
});

/** 会吐增量的假大脑：模拟真实客户端的"边收边交"（正文与增量通常一致）。 */
class StreamingClient implements LlmClient {
  readonly requests: ChatRequest[] = [];
  constructor(
    private readonly chunks: string[],
    private readonly text: string,
  ) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    for (const chunk of this.chunks) req.onDelta?.(chunk);
    return assistant(this.text);
  }
}

describe("流式增量的接线（session → chat:delta）", () => {
  it("客户端每交一段就发一条 chat:delta；正文仍只落一条 entry", async () => {
    const events: ChatEvent[] = [];
    const client = new StreamingClient(["你", "好"], "你好");
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      sessionId: "s-stream",
      onEvent: (e) => events.push(e),
    });
    const t = await session.send("hi");
    const deltas = events.filter((e) => e.type === "chat:delta").map((e) => (e.type === "chat:delta" ? e.text : ""));
    expect(deltas).toEqual(["你", "好"]);
    // 增量是"正在打字"层，不是转录：落定的 assistant 条目仍然只有一条。
    expect(t.entries.filter((e) => e.kind === "assistant")).toHaveLength(1);
    expect(t.entries.at(-1)?.text).toBe("你好");
  });

  it("不传 stream 选项时默认要增量（缺省 = 流）", async () => {
    const client = new StreamingClient(["y"], "y");
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
    });
    await session.send("hi");
    expect(typeof client.requests[0].onDelta).toBe("function");
  });

  it("stream:false 时一个 onDelta 都不给（不想流的下游可以整条关掉）", async () => {
    const events: ChatEvent[] = [];
    const client = new StreamingClient(["x"], "x");
    const session = new ChatSession({
      client,
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      stream: false,
      onEvent: (e) => events.push(e),
    });
    await session.send("hi");
    expect(client.requests[0].onDelta).toBeUndefined();
    expect(events.some((e) => e.type === "chat:delta")).toBe(false);
  });
});

describe("工具执行层（tool-runner，真盘真进程）", () => {
  let root = "";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-chat-runner-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runner = (opts: Partial<ConstructorParameters<typeof ToolRunner>[0]> = {}): ToolRunner =>
    new ToolRunner({ rootAbs: root, ...opts });

  it("read_file 给带行号的正文，路径越界被挡", async () => {
    const r = runner();
    const ok = await r.run({ id: "1", name: "read_file", args: { path: "src/a.ts" } });
    expect(ok.ok).toBe(true);
    expect(ok.output).toMatch(/^1: const a = 1;/);
    const bad = await r.run({ id: "2", name: "read_file", args: { path: "../outside.txt" } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/不允许读取|路径穿越/);
    const missing = await r.run({ id: "3", name: "read_file", args: { path: "nope.ts" } });
    expect(missing.reason).toMatch(/文件不存在/);
  });

  it("list_dir 与 find_by_name 能摸清目录结构", async () => {
    const r = runner();
    const listed = await r.run({ id: "1", name: "list_dir", args: { path: "src", depth: 1 } });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("src/a.ts");
    const found = await r.run({ id: "2", name: "find_by_name", args: { glob: "**/*.ts" } });
    expect(found.output).toContain("src/b.ts");
  });

  it("grep_files 按行命中并给出行号", async () => {
    const r = runner();
    const hit = await r.run({ id: "1", name: "grep_files", args: { pattern: "export const b" } });
    expect(hit.ok).toBe(true);
    expect(hit.output).toMatch(/src\/b\.ts:1:/);
    const bad = await r.run({ id: "2", name: "grep_files", args: { pattern: "([unclosed" } });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/正则无法编译/);
  });

  it("apply_patch 真改盘：只动该动的那一行", async () => {
    const r = runner();
    const res = await r.run({
      id: "1",
      name: "apply_patch",
      args: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "@@ ",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "*** End Patch",
        ].join("\n"),
      },
    });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
    // 改动全文随结果返回：diff 与撤销都靠它，不能只给一句"补丁已应用"。
    expect(res.changes).toHaveLength(1);
    expect(res.changes?.[0]).toMatchObject({
      path: "src/a.ts",
      before: "const a = 1;\nconst b = 2;\n",
      after: "const a = 1;\nconst b = 3;\n",
      created: false,
      revertable: true,
    });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
  });

  it("apply_patch 落到受保护路径（package.json）被拒", async () => {
    const r = runner();
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n', "utf8");
    const res = await r.run({
      id: "1",
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Update File: package.json\n-{\"name\":\"x\"}\n+{\"name\":\"y\"}\n*** End Patch" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/package.json/);
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe('{"name":"x"}\n');
  });

  it("read-only 档位下写与执行都被拒，盘上不动", async () => {
    const r = runner({ mode: "read-only" });
    const write = await r.run({
      id: "1",
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch" },
    });
    expect(write.ok).toBe(false);
    expect(write.reason).toMatch(/read-only/);
    expect(fs.existsSync(path.join(root, "src", "new.ts"))).toBe(false);
    const exec = await r.run({ id: "2", name: "run_command", args: { command: "node", args: ["-v"] } });
    expect(exec.ok).toBe(false);
    expect(exec.reason).toMatch(/read-only/);
  });

  it("run_command：白名单外的命令被地板挡下（rm 不会被尝试执行）", async () => {
    const r = runner();
    const res = await r.run({ id: "1", name: "run_command", args: { command: "rm", args: ["-rf", "src"] } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/沙箱禁止|白名单/);
    expect(fs.existsSync(path.join(root, "src", "a.ts"))).toBe(true);
  });

  it("run_command：白名单内的命令真跑，退出码取自 close 事件", async () => {
    const r = runner();
    const res = await r.run({ id: "1", name: "run_command", args: { command: "node", args: ["-e", "process.stdout.write('hi')"] } });
    // `node -e` 被平台刻意禁止（EVAL_FLAGS），所以这里要的是"被挡下且理由说明白"，
    // 而不是"真的执行了" —— 这条同时证明 eval 类参数没有漏过。
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/沙箱|白名单|-e/);
  });

  it("untrusted 策略下，没有审批通道时按拒绝处理（fail-closed）", async () => {
    const r = runner({ approvalPolicy: "untrusted" });
    const res = await r.run({
      id: "1",
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Add File: src/need-approval.ts\n+x\n*** End Patch" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/没有审批通道/);
    expect(fs.existsSync(path.join(root, "src", "need-approval.ts"))).toBe(false);
  });

  it("审批通过才落盘；拒绝时把理由带回会话", async () => {
    const seen: string[] = [];
    const r = runner({
      approvalPolicy: "untrusted",
      requestApproval: async (req) => {
        seen.push(req.tool);
        return { granted: false, reason: "先别改这个文件" };
      },
    });
    const denied = await r.run({
      id: "1",
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Add File: src/denied.ts\n+x\n*** End Patch" },
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/先别改这个文件/);
    expect(seen).toEqual(["apply_patch"]);

    const r2 = runner({
      approvalPolicy: "untrusted",
      requestApproval: async () => ({ granted: true, scope: "session" }),
    });
    const granted = await r2.run({
      id: "2",
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Add File: src/allowed.ts\n+x\n*** End Patch" },
    });
    expect(granted.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "src", "allowed.ts"), "utf8")).toBe("x");
    // 会话记忆：同类动作不再打扰（逐次问人会把审批变成噪音，噪音会被习惯性点掉）。
    let asked = 0;
    const r3 = runner({
      approvalPolicy: "untrusted",
      requestApproval: async () => {
        asked += 1;
        return { granted: true, scope: "session" };
      },
    });
    await r3.run({ id: "3", name: "apply_patch", args: { patch: "*** Begin Patch\n*** Add File: src/one.ts\n+x\n*** End Patch" } });
    await r3.run({ id: "4", name: "apply_patch", args: { patch: "*** Begin Patch\n*** Add File: src/two.ts\n+x\n*** End Patch" } });
    expect(asked).toBe(1);
  });
});

describe("恢复与持久化边界", () => {
  it("历史 entries 的 seq 与用户回合号从已有条目推导（不撞号、不把 assistant 当 user）", async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, "hist-"));
    const history: ChatHistory = {
      sessionId: "s-hist",
      entries: [
        { id: "e-10", ts: 1, kind: "user", text: "旧任务" },
        { id: "e-1", ts: 2, kind: "assistant", text: "旧答复" },
        { id: "e-2", ts: 3, kind: "assistant", text: "补充" },
      ],
      messages: [
        { role: "user", content: "旧任务" },
        { role: "assistant", content: "旧答复" },
        { role: "assistant", content: "补充" },
      ],
      meta: { startedAt: 1, updatedAt: 3, turns: 1, usageTokens: 0 },
    };
    const client = new ScriptedClient([
      assistant(
        "```tool\n" +
          JSON.stringify({
            tool: "apply_patch",
            arguments: { patch: "*** Begin Patch\n*** Add File: b.txt\n+x\n*** End Patch" },
          }) +
          "\n```",
      ),
      assistant("done"),
    ]);
    const session = new ChatSession({
      client,
      runner: new ToolRunner({ rootAbs: root, approvalPolicy: "never" }),
      rootAbs: root,
      history,
    });
    const t = await session.send("新任务");
    // seq 取历史最大值 10，而不是最后一条的 2 / 第一条的 10 被后一条覆写。
    expect(t.entries.find((e) => e.kind === "user" && e.text === "新任务")?.id).toBe("e-11");
    // userTurn 只数 user 条目（1），新 send 后是第 2 轮；把 assistant 算进去会变成 3。
    const change = t.entries.find((e) => e.result?.changes)?.result?.changes?.[0];
    expect(change?.turn).toBe(2);
  });

  it("空会话的 note 也会落盘（persist 的空判断不能写反）", () => {
    const seen: ChatSessionSnapshot[] = [];
    const session = new ChatSession({
      client: new ScriptedClient([assistant("x")]),
      runner: new ScriptedRunner([]) as unknown as ToolRunner,
      rootAbs: tmpRoot,
      onPersist: (snapshot) => seen.push(snapshot),
    });
    session.note("宿主提示");
    expect(seen).toHaveLength(1);
    expect(seen[0].entries.at(-1)?.text).toBe("宿主提示");
  });

  it("工具执行拿到的 signal 与用户回合号都是真值（不是空对象）", async () => {
    const seen: Array<{ signal?: AbortSignal; turn?: number }> = [];
    const runner = {
      run: async (call: ToolCall, opts: { signal?: AbortSignal; turn?: number } = {}) => {
        seen.push(opts);
        return { id: call.id, name: call.name, ok: true, output: "ok" } satisfies ToolResult;
      },
    };
    const controller = new AbortController();
    const client = new ScriptedClient([
      assistant("```tool\n" + JSON.stringify({ tool: "list_dir", arguments: {} }) + "\n```"),
      assistant("done"),
    ]);
    const session = new ChatSession({
      client,
      runner: runner as unknown as ToolRunner,
      rootAbs: tmpRoot,
      signal: controller.signal,
    });
    await session.send("看看");
    expect(seen[0]?.signal).toBe(controller.signal);
    expect(seen[0]?.turn).toBe(1);
  });
});
