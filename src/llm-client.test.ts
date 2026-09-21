import { describe, expect, it } from "vitest";
import { AllRoutesCoolingError } from "../shared/http-clients";
import { chatJson, JsonParseError, withCooldownRetry, type LlmClient } from "../shared/llm-client";
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

  it("does not mutate the caller's system message", async () => {
    const { client } = clientWith(['{"ok": true}']);
    const system = { role: "system" as const, content: "original" };
    const messages = [system, { role: "user" as const, content: "hi" }];
    await chatJson(client, { messages }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: boolean },
    });
    expect(system.content).toBe("original");
    expect(messages[0]!.content).toBe("original");
  });

  it("sends exactly one system message plus every non-system message", async () => {
    // The split is `messages.filter((m) => m.role !== "system")`. Flipping it to
    // `===` drops every user turn and duplicates the system prompt instead — the
    // model receives no question at all.
    //
    // The "does not mutate" test above cannot see this: it only checks that the
    // caller's own object was left alone, which stays true either way.
    const { client, calls } = clientWith(['{"ok": true}']);
    await chatJson(
      client,
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
      { schemaName: "t", validate: (raw) => raw as { ok: boolean } },
    );

    const sent = calls[0]!.messages;
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["first", "second"]);
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

  it("extracts balanced JSON object embedded in prose", async () => {
    const { client } = clientWith([
      '分析如下：{"ok": 3} 以上就是结果，说明 {完成} 了。',
    ]);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: number },
    });
    expect(result.ok).toBe(3);
  });

  it("extracts JSON with braces inside string values", async () => {
    const { client } = clientWith([
      'prefix {"cmd": "echo \\"{hi}\\"", "n": 7} trailing text',
    ]);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { cmd: string; n: number },
    });
    expect(result.n).toBe(7);
    expect(result.cmd).toContain("{hi}");
  });

  it("retries on transport errors and recovers", async () => {
    const calls: ChatRequest[] = [];
    let n = 0;
    const client: LlmClient = {
      async chat(req) {
        calls.push(req);
        n++;
        if (n === 1) throw new Error("The operation was aborted due to timeout");
        return { content: '{"ok": 9}', provider: "mock", model: "mock" };
      },
    };
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "t",
      validate: (raw) => raw as { ok: number },
      maxRetries: 2,
    });
    expect(result.ok).toBe(9);
    expect(calls).toHaveLength(2);
  });

  it("rethrows after transport errors exhaust retries", async () => {
    const client: LlmClient = {
      async chat() {
        throw new Error("network down");
      },
    };
    await expect(
      chatJson(client, { messages: [] }, {
        schemaName: "t",
        validate: (raw) => raw as unknown,
        maxRetries: 1,
      }),
    ).rejects.toThrow("network down");
  });

  it("propagates AllRoutesCoolingError immediately without retrying", async () => {
    const calls: ChatRequest[] = [];
    const err = new AllRoutesCoolingError(25_000);
    const client: LlmClient = {
      async chat(req) {
        calls.push(req);
        throw err;
      },
    };
    await expect(
      chatJson(client, { messages: [] }, {
        schemaName: "t",
        validate: (raw) => raw as unknown,
        maxRetries: 2,
      }),
    ).rejects.toBe(err);
    expect(calls).toHaveLength(1); // no outer retries on top of failover cooldown
  });

  it("picks the candidate that passes schema validation", async () => {
    const echoedPrd = '{"goal": "x", "features": [], "techStack": [], "acceptanceCriteria": []}';
    const realTasks =
      '{"tasks": [{"id": "t1", "title": "A", "description": "do", "zone": "src", "dependencies": [], "suggestedRole": "frontend-dev"}]}';
    const { client, calls } = clientWith([`${echoedPrd}\n\n${realTasks}`]);
    const result = await chatJson(client, { messages: [] }, {
      schemaName: "task list",
      validate: (raw) => {
        const r = raw as { tasks?: unknown[] };
        if (!Array.isArray(r.tasks) || r.tasks.length === 0) {
          throw new Error("tasks must be a non-empty array");
        }
        return r;
      },
    });
    expect(result.tasks).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("withCooldownRetry", () => {
  it("waits the cooldown window then retries successfully", async () => {
    const sleeps: number[] = [];
    const waits: Array<{ ms: number; n: number }> = [];
    let calls = 0;
    const result = await withCooldownRetry(
      async () => {
        calls++;
        if (calls === 1) throw new AllRoutesCoolingError(1_000);
        return 7;
      },
      {
        sleep: async (ms) => { sleeps.push(ms); },
        onWait: (ms, n) => waits.push({ ms, n }),
      },
    );
    expect(result).toBe(7);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
    expect(waits).toEqual([{ ms: 1_000, n: 1 }]);
  });

  it("caps a single wait at maxWaitMs", async () => {
    const sleeps: number[] = [];
    await withCooldownRetry(
      async () => { throw new AllRoutesCoolingError(300_000); },
      { maxWaitMs: 5_000, maxWaits: 1, sleep: async (ms) => { sleeps.push(ms); } },
    ).catch(() => undefined); // exhausts the single wait then rethrows; we assert the cap
    expect(sleeps).toEqual([5_000]);
  });

  it("rethrows non-cooling errors immediately without sleeping", async () => {
    const sleeps: number[] = [];
    await expect(
      withCooldownRetry(async () => { throw new Error("boom"); }, {
        sleep: async (ms) => { sleeps.push(ms); },
      }),
    ).rejects.toThrow("boom");
    expect(sleeps).toEqual([]);
  });

  it("rethrows the cooling error after exhausting maxWaits", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const err = new AllRoutesCoolingError(500);
    await expect(
      withCooldownRetry(
        async () => {
          calls++;
          throw err;
        },
        { maxWaits: 2, sleep: async (ms) => { sleeps.push(ms); } },
      ),
    ).rejects.toBe(err);
    expect(calls).toBe(3); // initial call + 2 retries after waits
    expect(sleeps).toEqual([500, 500]);
  });

  it("skips waiting when shouldStop reports the run is over", async () => {
    const sleeps: number[] = [];
    const err = new AllRoutesCoolingError(60_000);
    await expect(
      withCooldownRetry(async () => { throw err; }, {
        sleep: async (ms) => { sleeps.push(ms); },
        shouldStop: () => true,
      }),
    ).rejects.toBe(err);
    expect(sleeps).toEqual([]);
  });
});
