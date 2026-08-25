import { describe, expect, it } from "vitest";
import { chatJson, JsonParseError, type LlmClient } from "../shared/llm-client";
import type { ChatRequest } from "../shared/llm-client";

function clientWith(outputs: string[]): { client: LlmClient; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    client: {
      async chat(req) {
        calls.push(req);
        return { content: outputs[Math.min(calls.length - 1, outputs.length - 1)], provider: "mock", model: "mock" };
      },
    },
  };
}

describe("chatJson", () => {
  it("returns validated output on first try", async () => {
    const { client, calls } = clientWith(['{"ok": true}']);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: boolean },
      maxRetries: 1,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("strips markdown fences before parsing", async () => {
    const { client } = clientWith(['```json\n{"ok": 1}\n```']);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: number },
    });
    expect(result.ok).toBe(1);
  });

  it("retries with error feedback and recovers", async () => {
    const { client, calls } = clientWith(["not json at all", '{"ok": 2}']);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: number },
      maxRetries: 2,
    });
    expect(result.ok).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.at(-1)?.content).toMatch(/validation/);
  });

  it("throws JsonParseError after exhausting retries", async () => {
    const { client } = clientWith(["garbage"]);
    await expect(
      chatJson(client, { messages: [] }, {
        schemaName: "t",
        validate: (raw) => raw as unknown,
        maxRetries: 1,
      }),
    ).rejects.toBeInstanceOf(JsonParseError);
  });
});
