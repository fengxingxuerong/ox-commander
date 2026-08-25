import { describe, expect, it } from "vitest";
import { createLlmClient, AnthropicClient, OpenAiCompatibleClient } from "../shared/http-clients";
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
      return { ok: true, status: 200, text: async () => "", json: async () => ({
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
      return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content: "{}" } }] }) } as never;
    }) as never);
    await client.chat({ ...req, jsonMode: true });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws HttpLlmError on non-2xx", async () => {
    const { HttpLlmError } = await import("../shared/http-clients");
    const client = new OpenAiCompatibleClient(getProvider("glm"), "k", (async () => ({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
      json: async () => ({}),
    })) as never);
    await expect(client.chat(req)).rejects.toBeInstanceOf(HttpLlmError);
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
      return { ok: true, status: 200, text: async () => "", json: async () => ({
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
