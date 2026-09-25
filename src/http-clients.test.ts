import { describe, expect, it, vi } from "vitest";
import { createLlmClient, AnthropicClient, OpenAiCompatibleClient, HttpLlmError } from "../shared/http-clients";
import { getProvider, PROVIDER_CATALOG } from "../shared/providers";
import type { ChatRequest } from "../shared/llm-client";

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
    const err = await client.chat(req).catch((e: unknown) => e as HttpLlmError);
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
      const err = await client.chat(req).catch((e: unknown) => e as HttpLlmError);
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
      const err = await client.chat(req).catch((e: unknown) => e as HttpLlmError);
      expect(err).toBeInstanceOf(HttpLlmError);
      expect((err as HttpLlmError).retryAfterMs).toBeUndefined();
    }
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
