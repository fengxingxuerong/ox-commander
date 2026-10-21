import { describe, expect, it, vi } from "vitest";
import { createLlmClient, AnthropicClient, OpenAiCompatibleClient, HttpLlmError, toOpenAiMessages } from "../shared/http-clients";
import { getProvider, PROVIDER_CATALOG } from "../shared/providers";
import type { ChatRequest } from "../shared/llm-client";
import { TOOL_SPECS } from "../shared/tools/spec";

const req: ChatRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
};

describe("OpenAiCompatibleClient", () => {
  it("posts to chat/completions and unwraps choices", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "sk-test", (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({
        model: "deepseek-chat",
        choices: [{ message: { content: "hello" } }],
        usage: { total_tokens: 42 },
      }) } as never;
    }) as never);
    void capturedInit;
    const res = await client.chat(req);
    expect(capturedUrl).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(res.content).toBe("hello");
    expect(res.usageTokens).toBe(42);
    // 没有 tool_calls 时不能长出 `toolCalls: []`：会把"一问一答"伪装成工具回合。
    expect("toolCalls" in res).toBe(false);
  });

  it("只有 tools=native 才发 tools 字段", async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
    }) as never;
    const native = new OpenAiCompatibleClient({ ...getProvider("deepseek"), tools: "native" }, "k", fake);
    await native.chat({ ...req, tools: [TOOL_SPECS[0]] });
    expect(body.tools).toBeDefined();
    const text = new OpenAiCompatibleClient({ ...getProvider("deepseek"), tools: "text" }, "k", fake);
    await text.chat({ ...req, tools: [TOOL_SPECS[0]] });
    expect(body.tools).toBeUndefined();
  });

  it("enables json mode when requested", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) } as never;
    }) as never);
    await client.chat({ ...req, jsonMode: true });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("forces temperature=1 for kimi-k3 even when the caller asks 0.2", async () => {
    // 端点实测：kimi-k3 对 0.2 返回 400（只接受 1）。这条线路现在在轮转表里，
    // 客户端必须替调用方改写，否则每次执行器调用都白烧一个 400。
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), defaultModel: "kimi-k3" },
      "k",
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
      }) as never,
    );
    await client.chat({ ...req, temperature: 0.2 });
    expect(body.temperature).toBe(1);
  });

  it("sends the caller temperature for models without an override", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), defaultModel: "glm-5.2" },
      "k",
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
      }) as never,
    );
    await client.chat({ ...req, temperature: 0.5 });
    expect(body.temperature).toBe(0.5);
  });

  it("线程推理强度只发给已登记线路，并取代默认的关闭思考", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), defaultModel: "deepseek-v4-flash" },
      "k",
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
      }) as never,
    );
    await client.chat({ ...req, reasoningEffort: "medium" });
    expect(body.reasoning_effort).toBe("medium");
    // 不能同时发 `enable_thinking: false`：语义冲突，不能靠端点碰巧忽略。
    expect("enable_thinking" in body).toBe(false);
  });

  it("未登记线路收到推理强度时原地报错，不把字段硬发给端点", async () => {
    let called = false;
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), defaultModel: "kimi-k3" },
      "k",
      (async () => {
        called = true;
        return { ok: true, status: 200, text: async () => "{}" } as never;
      }) as never,
    );
    await expect(client.chat({ ...req, reasoningEffort: "high" })).rejects.toThrow(/未登记推理强度/);
    expect(called).toBe(false);
  });

  it("默认仍显式关闭思考（保持原有延迟/费用）", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), defaultModel: "deepseek-v4-flash" },
      "k",
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
      }) as never,
    );
    await client.chat(req);
    expect(body.enable_thinking).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("把 reasoning_content 交给调用方，供原生工具循环回灌", async () => {
    const client = new OpenAiCompatibleClient(
      getProvider("sensenova"),
      "k",
      (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "答案", reasoning_content: "先想一下" } }],
        }),
      })) as never,
    );
    const res = await client.chat(req);
    expect(res.reasoning).toBe("先想一下");
  });

  it("原生工具消息回灌 reasoning_content（DeepSeek 带 tools 的硬要求）", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenAiCompatibleClient(
      { ...getProvider("sensenova"), tools: "native" },
      "k",
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) } as never;
      }) as never,
    );
    await client.chat({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", reasoning: "想过了", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }] },
        { role: "tool", content: "x", toolCallId: "c1" },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("想过了");
    expect(assistant?.tool_calls).toBeDefined();
  });

  /**
   * 上一条只钉住「带 tool_calls 的助手消息」。工具循环**收尾那一条**（正文已产出、
   * 没有 tool_calls）是另一条分支：它若丢掉 reasoning_content，DeepSeek 系要求
   * 「带 tools 的请求把历史 reasoning 原样带回」的约束就在最后一轮破了 ——
   * 下一轮追问时模型看不到自己上一轮怎么想的，而请求本身完全合法、不报错。
   */
  it("无工具调用的助手消息也回灌 reasoning_content；没有思考就不带这个键", () => {
    const messages = toOpenAiMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "结论", reasoning: "想过了" },
      { role: "assistant", content: "没思考的答复" },
    ]);
    expect(messages[1].reasoning_content).toBe("想过了");
    // 必须是**缺席**而不是 undefined：有的端点会把显式 null/undefined 当字段校验。
    expect("reasoning_content" in messages[2]).toBe(false);
  });

  it("throws HttpLlmError on non-2xx", async () => {
    const { HttpLlmError: E } = await import("../shared/http-clients");
    const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
      json: async () => ({}),
    })) as never);
    await expect(client.chat(req)).rejects.toBeInstanceOf(E);
  });

  it("parses numeric retry-after seconds into retryAfterMs", async () => {
    const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      json: async () => ({}),
      headers: { get: (n: string) => (n === "retry-after" ? "30" : null) },
    })) as never);
    const err = (await client.chat(req).catch((e: unknown) => e as HttpLlmError)) as HttpLlmError;
    expect(err).toBeInstanceOf(HttpLlmError);
    expect((err as HttpLlmError).retryAfterMs).toBe(30_000);
  });

  it("parses HTTP-date retry-after into the remaining milliseconds", async () => {
    vi.useFakeTimers();
    try {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const expected = Date.parse(future) - Date.now();
      const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
        ok: false,
        status: 503,
        text: async () => "unavailable",
        json: async () => ({}),
        headers: { get: (n: string) => (n === "retry-after" ? future : null) },
      })) as never);
      const err = (await client.chat(req).catch((e: unknown) => e as HttpLlmError)) as HttpLlmError;
      expect(err).toBeInstanceOf(HttpLlmError);
      expect((err as HttpLlmError).retryAfterMs).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves retryAfterMs undefined when the header is missing or garbage", async () => {
    for (const value of [null, "not-a-date-or-number"]) {
      const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
        ok: false,
        status: 429,
        text: async () => "rate limited",
        json: async () => ({}),
        headers: { get: (n: string) => (n === "retry-after" ? value : null) },
      })) as never);
      const err = (await client.chat(req).catch((e: unknown) => e as HttpLlmError)) as HttpLlmError;
      expect(err).toBeInstanceOf(HttpLlmError);
      expect((err as HttpLlmError).retryAfterMs).toBeUndefined();
    }
  });

  it("extracts the server request id from any of the three known headers", async () => {
    for (const [header, id] of [
      ["x-request-id", "req-openai-1"],
      ["request-id", "req-anthropic-2"],
      ["x-generation-id", "gen-openrouter-3"],
    ] as const) {
      const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
        ok: false,
        status: 500,
        text: async () => "boom",
        json: async () => ({}),
        headers: { get: (n: string) => (n === header ? id : null) },
      })) as never);
      const err = (await client.chat(req).catch((e: unknown) => e as HttpLlmError)) as HttpLlmError;
      expect(err).toBeInstanceOf(HttpLlmError);
      expect(err.requestId).toBe(id);
    }
  });

  it("requestId stays undefined when the endpoint sends none (absent ≠ lost)", async () => {
    const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
      headers: { get: () => null },
    })) as never);
    const err = (await client.chat(req).catch((e: unknown) => e as HttpLlmError)) as HttpLlmError;
    expect(err).toBeInstanceOf(HttpLlmError);
    expect(err.requestId).toBeUndefined();
  });
});

describe("AnthropicClient", () => {
  it("maps system prompt and headers correctly", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const client = new AnthropicClient(getProvider("anthropic"), "ak-test", (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "hi there" }],
        usage: { input_tokens: 5, output_tokens: 7 },
      }) } as never;
    }) as never);
    const res = await client.chat(req);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("hi there");
    expect(res.usageTokens).toBe(12);
    expect("toolCalls" in res).toBe(false);
  });

  it("只有 tools=native 才发 tools 字段（Anthropic 侧）", async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "ok" }] }) } as never;
    }) as never;
    const native = new AnthropicClient({ ...getProvider("anthropic"), tools: "native" }, "k", fake);
    await native.chat({ ...req, tools: [TOOL_SPECS[0]] });
    expect(body.tools).toBeDefined();
    const text = new AnthropicClient({ ...getProvider("anthropic"), tools: "text" }, "k", fake);
    await text.chat({ ...req, tools: [TOOL_SPECS[0]] });
    expect(body.tools).toBeUndefined();
  });
});

describe("catalog coverage", () => {
  it("creates clients for every provider", () => {
    for (const p of PROVIDER_CATALOG) {
      expect(createLlmClient(p, "key")).toBeTruthy();
    }
  });
});

describe("createLlmClient 的协议分发", () => {
  it("[260] anthropic 协议建 AnthropicClient，其余建 OpenAI 兼容客户端", () => {
    // 第 260 行 `config.protocol === "anthropic"`。改成 `!==` 之后两个分支**对调**：
    // anthropic 的 provider 会拿 OpenAI 的报文格式去请求 —— 字段名不同、
    // system 不是独立参数，表现为对方返回 400 或响应解析失败，
    // 而不是明确的"协议不支持"。反过来 OpenAI 兼容的 provider 会走 Anthropic 报文。
    // 既有用例都是直接 new 具体类，没走这个工厂，所以一直没有断言。
    const anthropic = createLlmClient({ ...getProvider("sensenova"), protocol: "anthropic" }, "sk-x");
    expect(anthropic).toBeInstanceOf(AnthropicClient);

    const openai = createLlmClient(
      { ...getProvider("sensenova"), protocol: "openai-compatible" },
      "sk-x",
    );
    expect(openai).toBeInstanceOf(OpenAiCompatibleClient);
  });
});

describe("caller signal · 取消要真的下传到 fetch", () => {
  it("调用方 signal 与内部超时合并：abort 后请求立刻失败，不占满 timeoutMs", async () => {
    const ctrl = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const client = new OpenAiCompatibleClient(
      getProvider("deepseek"),
      "k",
      ((
        _url: string,
        init: RequestInit,
      ) =>
        new Promise((_res, rej) => {
          // 服务端永不返回：只有 signal 能结束这次调用
          sawSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () => rej(init.signal!.reason), { once: true });
        })) as never,
    );
    const p = client.chat({ ...req, signal: ctrl.signal });
    ctrl.abort();
    const err = await p.then(() => null, (e) => e as Error);
    expect(err?.name).toBe("AbortError");
    expect(sawSignal?.aborted).toBe(true);
    // 传进来的是"超时 ∪ 调用方"的合并信号，不是调用方那个原件
    expect(sawSignal).not.toBe(ctrl.signal);
  });

  it("不传 signal 时内部超时仍然生效（合并分支没把原行为弄丢）", async () => {
    const client = new OpenAiCompatibleClient(
      getProvider("deepseek"),
      "k",
      ((
        _url: string,
        init: RequestInit,
      ) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(init.signal!.reason), { once: true });
        })) as never,
      5,
    );
    const err = await client.chat(req).then(() => null, (e) => e as Error);
    expect(err?.name).toBe("TimeoutError");
  });
});

/* ------------------------------------------------------------------ *
 * 流式（P1-1）：先试后退
 *
 * 三条纪律各有用例：① 真流能把增量交出去；② **零增量**整段退回（能力不绑在
 * "端点声明支持"上）；③ 已经吐过字之后的失败**不重来**（否则同一段话说两遍）。
 * ------------------------------------------------------------------ */

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** 假 SSE 响应：按 chunk 顺序吐，读完 done。`failAt` = 第几次 read 抛错（模拟断线）。 */
function sseResponse(chunks: string[], failAt?: number): never {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (failAt !== undefined && i === failAt) throw new Error("connection reset");
          return i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true };
        },
      }),
    },
  } as never;
}

function jsonResponse(payload: unknown): never {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) } as never;
}

function httpError(status: number): never {
  return { ok: false, status, headers: { get: () => null }, text: async () => `http ${status}` } as never;
}

/** 按顺序回放响应，并把每次请求的 url/body/headers 记下来。 */
function recorder(responses: Array<() => never>): { fetchImpl: never; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit): Promise<never> => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error("请求次数超出预期");
    return next();
  }) as never;
  return { fetchImpl, calls };
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textChunk = (text: string): string => sse({ choices: [{ delta: { content: text } }] });
const DONE = "data: [DONE]\n\n";

describe("OpenAiCompatibleClient · 流式", () => {
  it("给了 onDelta 就发 stream:true，边收边交增量，全文仍返回", async () => {
    const { fetchImpl, calls } = recorder([() => sseResponse([textChunk("你"), textChunk("好"), DONE])]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const deltas: string[] = [];
    const res = await client.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["你", "好"]);
    expect(res.content).toBe("你好");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].headers.accept).toBe("text/event-stream");
  });

  it("没给 onDelta 就不发 stream 字段（普通请求一条不少）", async () => {
    const { fetchImpl, calls } = recorder([
      () => jsonResponse({ model: "m", choices: [{ message: { content: "whole" } }] }),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat(req);
    expect(res.content).toBe("whole");
    expect("stream" in calls[0].body).toBe(false);
    expect(calls[0].headers.accept).toBeUndefined();
  });

  it("端点把 stream 当未知字段、直接回整段 JSON：自动退回，且此后不再试流式", async () => {
    const whole = { model: "m", choices: [{ message: { content: "whole" } }] };
    const { fetchImpl, calls } = recorder([
      // 没有 `data:` 前缀 ⇒ 解出零个事件 ⇒ 判定"这条线不流"，退回整段
      () => sseResponse([JSON.stringify(whole)]),
      () => jsonResponse(whole),
      () => jsonResponse(whole),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const first = await client.chat({ ...req, onDelta: () => undefined });
    expect(first.content).toBe("whole");
    expect(calls[0].body.stream).toBe(true);
    // 退回的那一次必须是**非流式**请求：否则等于把同一个坏形状再发一遍
    expect("stream" in calls[1].body).toBe(false);
    // 记忆生效：第二次连流式都不试，直接一条普通请求
    await client.chat({ ...req, onDelta: () => undefined });
    expect(calls).toHaveLength(3);
    expect("stream" in calls[2].body).toBe(false);
  });

  it("流通了但一个字都没有：同样退回整段（不把空回复当结果）", async () => {
    const { fetchImpl, calls } = recorder([
      () => sseResponse([sse({ choices: [{ delta: { role: "assistant" } }] }), DONE]),
      () => jsonResponse({ choices: [{ message: { content: "real" } }] }),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.content).toBe("real");
    expect(calls).toHaveLength(2);
  });

  it("已吐字后断线：原样抛出，不换整段重来（同一段话不能出现两遍）", async () => {
    const { fetchImpl, calls } = recorder([() => sseResponse([textChunk("半句")], 1)]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const deltas: string[] = [];
    const err = await client
      .chat({ ...req, onDelta: (d) => deltas.push(d) })
      .then(() => null, (e) => e as Error);
    expect(deltas).toEqual(["半句"]);
    expect(err?.message).toBe("connection reset");
    expect(calls).toHaveLength(1);
  });

  it("流式被 400 拒：退回整段（能力不依赖端点在文档里承认 stream）", async () => {
    const { fetchImpl, calls } = recorder([
      () => httpError(400),
      () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.content).toBe("ok");
    expect(calls).toHaveLength(2);
    expect("stream" in calls[1].body).toBe(false);
  });

  it("流式被 500 拒：直接抛，不退回（服务端坏了就别再打一遍）", async () => {
    const { fetchImpl, calls } = recorder([() => httpError(500)]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const err = await client
      .chat({ ...req, onDelta: () => undefined })
      .then(() => null, (e) => e as HttpLlmError);
    expect(err).toBeInstanceOf(HttpLlmError);
    expect(err?.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("流里 finish_reason=length 判截断（与整段路径同一口径）", async () => {
    const { fetchImpl } = recorder([
      () => sseResponse([textChunk("abcdefgh"), sse({ choices: [{ delta: {}, finish_reason: "length" }] })]),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const err = await client
      .chat({ ...req, onDelta: () => undefined })
      .then(() => null, (e) => e as Error);
    expect(err?.message).toContain("finish_reason=length");
  });

  it("工具调用碎片在流里拼回 ToolCall（名字一块、参数两块）", async () => {
    const { fetchImpl } = recorder([
      () =>
        sseResponse([
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] }),
          DONE,
        ]),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.toolCalls).toEqual([{ id: "c1", name: "read_file", args: { path: "a.ts" } }]);
    expect(res.content).toBe("");
  });

  it("正文为空而 reasoning 有内容时用 reasoning 兜底（与整段路径一致）", async () => {
    const { fetchImpl } = recorder([
      () => sseResponse([sse({ choices: [{ delta: { reasoning_content: "答案" } }] }), DONE]),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.content).toBe("答案");
    // reasoning 是**思考**，不是正文增量：不能替模型"边想边说"。
    expect(res.content).not.toBe("");
  });

  it("流里的 reasoning_content 也聚合，并随整段结果返回", async () => {
    const reasoningChunk = (text: string): string => sse({ choices: [{ delta: { reasoning_content: text } }] });
    const { fetchImpl } = recorder([() => sseResponse([reasoningChunk("先想"), reasoningChunk("一下"), textChunk("答"), DONE])]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.reasoning).toBe("先想一下");
    expect(res.content).toBe("答");
  });

  it("流里的 usage 只在端点给了才带（缺席 ≠ 0，不给假数字）", async () => {
    const { fetchImpl } = recorder([
      () => sseResponse([textChunk("x"), sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } }), DONE]),
    ]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.usageTokens).toBe(42);
  });

  it("流里没有 usage 时连键都不留（'不知道'不能被写成 0）", async () => {
    const { fetchImpl } = recorder([() => sseResponse([textChunk("x"), DONE])]);
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect("usageTokens" in res).toBe(false);
  });

  it("响应没有流句柄时，整段文本仍按 SSE 口径切开（退化路径不是黑盒）", async () => {
    const body = `${textChunk("降")}${textChunk("级")}${DONE}`;
    const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body })) as never;
    const client = new OpenAiCompatibleClient(getProvider("deepseek"), "k", fetchImpl);
    const deltas: string[] = [];
    const res = await client.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["降", "级"]);
    expect(res.content).toBe("降级");
  });
});

describe("AnthropicClient · 流式", () => {
  const aEvent = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

  it("走 /messages 且带 x-api-key；正文与 usage 都按事件口径聚合", async () => {
    const { fetchImpl, calls } = recorder([
      () =>
        sseResponse([
          aEvent({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
          aEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
          aEvent({ type: "message_delta", usage: { output_tokens: 5 } }),
          aEvent({ type: "message_stop" }),
        ]),
    ]);
    const client = new AnthropicClient(getProvider("anthropic"), "ak", fetchImpl);
    const deltas: string[] = [];
    const res = await client.chat({ ...req, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["hi"]);
    expect(res.content).toBe("hi");
    expect(res.usageTokens).toBe(15);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("ak");
    expect(calls[0].headers.accept).toBe("text/event-stream");
    expect(calls[0].body.stream).toBe(true);
  });

  it("tool_use 事件流拼回 ToolCall", async () => {
    const { fetchImpl } = recorder([
      () =>
        sseResponse([
          aEvent({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
          aEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "run_command" } }),
          aEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"cmd":' } }),
          aEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls"}' } }),
          aEvent({ type: "message_stop" }),
        ]),
    ]);
    const client = new AnthropicClient(getProvider("anthropic"), "ak", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "run_command", args: { cmd: "ls" } }]);
  });

  it("没给 onDelta 就不试流式（不给回调 = 不流，这条线连 SSE 请求都不发）", async () => {
    const { fetchImpl, calls } = recorder([
      () => jsonResponse({ model: "claude", content: [{ type: "text", text: "whole" }] }),
    ]);
    const client = new AnthropicClient(getProvider("anthropic"), "ak", fetchImpl);
    const res = await client.chat(req);
    expect(res.content).toBe("whole");
    expect(calls).toHaveLength(1);
    expect("stream" in calls[0].body).toBe(false);
    expect(calls[0].headers.accept).toBeUndefined();
  });

  it("零增量时退回整段（Anthropic 侧同一套先试后退）", async () => {
    const { fetchImpl, calls } = recorder([
      () => sseResponse([aEvent({ type: "message_start", message: {} }), aEvent({ type: "message_stop" })]),
      () => jsonResponse({ model: "claude", content: [{ type: "text", text: "whole" }] }),
    ]);
    const client = new AnthropicClient(getProvider("anthropic"), "ak", fetchImpl);
    const res = await client.chat({ ...req, onDelta: () => undefined });
    expect(res.content).toBe("whole");
    expect(calls).toHaveLength(2);
    expect("stream" in calls[1].body).toBe(false);
  });
});
