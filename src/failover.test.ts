import { describe, expect, it } from "vitest";
import { buildLlmClient } from "../shared/build-llm";
import {
  AllRoutesCoolingError,
  createFailoverClient,
  FailoverLlmClient,
  HttpLlmError,
  type FailoverGroup,
} from "../shared/http-clients";
import type { ChatRequest, ChatResponse, LlmClient } from "../shared/llm-client";
import { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../shared/providers";

const REQ: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

function stub(results: Array<() => Promise<ChatResponse>>): LlmClient {
  let i = 0;
  return {
    async chat(): Promise<ChatResponse> {
      const fn = results[Math.min(i, results.length - 1)];
      i++;
      return fn!();
    },
  };
}

const OK = (m: string): () => Promise<ChatResponse> => async () => ({
  content: "ok",
  provider: "t",
  model: m,
});
const RATE = (): Promise<ChatResponse> => Promise.reject(new HttpLlmError(429, "rate limited"));
const AUTH = (): Promise<ChatResponse> => Promise.reject(new HttpLlmError(401, "unauthorized"));

function group(label: string, clients: LlmClient[]): FailoverGroup {
  return { label, clients };
}

describe("FailoverLlmClient", () => {
  it("returns first success without touching others", async () => {
    const calls: string[] = [];
    const a = stub([async () => { calls.push("a"); return OK("m-a")(); }]);
    const b = stub([async () => { calls.push("b"); throw new Error("should not be called"); }]);
    const client = new FailoverLlmClient([group("g1", [a, b])]);
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-a");
    expect(calls).toEqual(["a"]);
  });

  it("rotates within group on 429 then succeeds", async () => {
    const calls: string[] = [];
    const a = stub([
      async () => { calls.push("a"); return RATE(); },
      async () => { calls.push("a2"); throw new Error("no second call to same client"); },
    ]);
    const b = stub([async () => { calls.push("b"); return OK("m-b")(); }]);
    const client = new FailoverLlmClient([group("g1", [a, b])], async () => {});
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("moves to next group after exhausting a group on 429", async () => {
    const calls: string[] = [];
    const mk = (name: string): LlmClient =>
      stub([async () => { calls.push(name); return RATE(); }]);
    const c = stub([async () => { calls.push("c"); return OK("m-c")(); }]);
    const client = new FailoverLlmClient([
      group("g1", [mk("a"), mk("b")]),
      group("g2", [c]),
    ], async () => {});
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-c");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("fails fast on auth errors without rotating", async () => {
    const calls: string[] = [];
    const a = stub([async () => { calls.push("a"); return AUTH(); }]);
    const b = stub([async () => { calls.push("b"); throw new Error("must not run"); }]);
    const client = new FailoverLlmClient([group("g1", [a, b]), group("g2", [b])]);
    await expect(client.chat(REQ)).rejects.toBeInstanceOf(HttpLlmError);
    expect(calls).toEqual(["a"]);
  });

  it("rotates to next combo on transient 5xx errors", async () => {
    const calls: string[] = [];
    const boom = (name: string): LlmClient =>
      stub([async () => { calls.push(name); throw new HttpLlmError(500, "server error"); }]);
    const c = stub([async () => { calls.push("c"); return OK("m-c")(); }]);
    const client = new FailoverLlmClient([group("g1", [boom("a"), boom("b")]), group("g2", [c])], async () => {});
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-c");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("rotates on unexpected non-HTTP errors (timeout, network)", async () => {
    const calls: string[] = [];
    const timeoutClient = stub([async () => { calls.push("a"); throw new Error("The operation was aborted due to timeout"); }]);
    const okClient = stub([async () => { calls.push("b"); return OK("m-b")(); }]);
    const client = new FailoverLlmClient([group("g1", [timeoutClient, okClient])], async () => {});
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("sleeps between combos but not after the final one", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
    const rate = stub([async () => RATE()]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient([group("g1", [rate, ok])], sleep);
    await client.chat(REQ);
    expect(sleeps).toEqual([500]);
  });

  it("throws the last error when every group is exhausted", async () => {
    const mk = (name: string): LlmClient =>
      stub([async () => { throw new HttpLlmError(429, `${name} limited`); }]);
    const client = new FailoverLlmClient([
      group("g1", [mk("a"), mk("b")]),
      group("g2", [mk("c")]),
    ], async () => {});
    await expect(client.chat(REQ)).rejects.toThrow("c limited");
  });
});

describe("FailoverLlmClient cooldown & backoff", () => {
  it("exponential backoff 500, 1000, 2000, then capped at 8000", async () => {
    const sleeps: number[] = [];
    const fail = (): LlmClient => stub([async () => RATE()]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [fail(), fail(), fail(), fail(), fail(), fail(), fail(), ok])],
      async (ms) => { sleeps.push(ms); },
    );
    await client.chat(REQ);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("skips cooling combos on later calls without sleeping or calling them", async () => {
    let clock = 1_000;
    const calls: string[] = [];
    const a = stub([async () => { calls.push("a"); return RATE(); }]);
    const b = stub([async () => { calls.push("b"); return OK("m-b")(); }]);
    const sleeps: number[] = [];
    const client = new FailoverLlmClient([group("g1", [a, b])], async (ms) => { sleeps.push(ms); }, { now: () => clock });
    await client.chat(REQ);
    expect(calls).toEqual(["a", "b"]);
    expect(sleeps).toEqual([500]);
    // a is cooling for 30s; second call must skip it silently (no call, no sleep).
    clock = 1_100;
    const res = await client.chat(REQ);
    expect(res.model).toBe("m-b");
    expect(calls).toEqual(["a", "b", "b"]);
    expect(sleeps).toEqual([500]);
  });

  it("honors Retry-After for the backoff sleep and the combo cooldown", async () => {
    let clock = 0;
    const calls: string[] = [];
    const limited = stub([async () => { calls.push("ra"); return Promise.reject(new HttpLlmError(429, "limited", 7_000)); }]);
    const ok = stub([async () => { calls.push("ok"); return OK("m")(); }]);
    const sleeps: number[] = [];
    const client = new FailoverLlmClient([group("g1", [limited, ok])], async (ms) => { sleeps.push(ms); }, { now: () => clock });
    const res = await client.chat(REQ);
    expect(res.model).toBe("m");
    expect(sleeps).toEqual([7_000]); // max(500 backoff, 7000 retry-after)
    // cooldown should be 7s (retry-after), not the 30s default:
    clock = 6_999; // still cooling
    await client.chat(REQ);
    expect(calls).toEqual(["ra", "ok", "ok"]);
    clock = 7_000; // cooldown expired → combo 0 gets attempted again (and fails again)
    await client.chat(REQ);
    expect(calls).toEqual(["ra", "ok", "ok", "ra", "ok"]);
    expect(sleeps).toEqual([7_000, 7_000]);
  });

  it("caps Retry-After cooldown at 5 minutes", async () => {
    let clock = 0;
    const crazy = stub([async () => Promise.reject(new HttpLlmError(429, "limited", 3_600_000))]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [crazy, ok])],
      async () => {},
      { now: () => clock },
    );
    await client.chat(REQ);
    clock = 300_000; // 5 min: cap reached, combo usable again
    await expect(client.chat(REQ)).resolves.toBeTruthy();
  });

  it("throws AllRoutesCoolingError immediately when every combo is cooling", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const mk = (): LlmClient => stub([async () => RATE()]);
    const client = new FailoverLlmClient(
      [group("g1", [mk(), mk()])],
      async (ms) => { sleeps.push(ms); },
      { now: () => clock },
    );
    await expect(client.chat(REQ)).rejects.toThrow("rate limited"); // all fail → last error
    expect(sleeps).toEqual([500]);
    // both combos now cooling until 30s; second call must reject without sleeping.
    let caught: unknown;
    try {
      await client.chat(REQ);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllRoutesCoolingError);
    expect((caught as AllRoutesCoolingError).retryInMs).toBe(30_000);
    expect(sleeps).toEqual([500]); // no sleep added
    // after the cooldown expires the combos are attempted again
    clock = 30_001;
    await expect(client.chat(REQ)).rejects.toThrow("rate limited");
    expect(sleeps).toEqual([500, 500]);
  });

  it("cooldown applies to 5xx and transport errors, but not to 4xx", async () => {
    let clock = 0;
    const calls: string[] = [];
    const boom = stub([async () => { calls.push("boom"); throw new HttpLlmError(503, "unavailable"); }]);
    const timeout = stub([async () => { calls.push("timeout"); throw new Error("aborted due to timeout"); }]);
    const bad = stub([async () => { calls.push("bad"); throw new HttpLlmError(400, "bad request"); }]);
    const ok = stub([async () => { calls.push("ok"); return OK("m")(); }]);
    const sleeps: number[] = [];
    const client = new FailoverLlmClient(
      [group("g1", [boom, timeout, bad, ok])],
      async (ms) => { sleeps.push(ms); },
      { now: () => clock },
    );
    await client.chat(REQ);
    expect(calls).toEqual(["boom", "timeout", "bad", "ok"]);
    expect(sleeps).toEqual([500, 1000, 2000]);
    // 503/timeout combos are cooling; the 400 combo is not, so it is retried.
    clock = 1;
    const res = await client.chat(REQ);
    expect(res.model).toBe("m");
    expect(calls).toEqual(["boom", "timeout", "bad", "ok", "bad", "ok"]);
    expect(sleeps).toEqual([500, 1000, 2000, 500]);
  });
});

describe("createFailoverClient", () => {
  it("builds groups per present key for any provider/model set", () => {
    const client = createFailoverClient("glm", ["GLM_API_KEY"], ["glm-4-plus"], {
      env: { GLM_API_KEY: "k1" },
      timeoutMs: 60_000,
    });
    expect(client).toBeInstanceOf(FailoverLlmClient);
  });

  it("accepts a ProviderConfig object directly", () => {
    const client = createFailoverClient(
      { id: "x", displayName: "X", protocol: "openai-compatible", baseUrl: "https://x.example/v1", defaultModel: "m1", apiKeyEnvVar: "X_KEY" },
      ["X_KEY"],
      ["m1", "m2"],
      { env: { X_KEY: "k" } },
    );
    expect(client).toBeInstanceOf(FailoverLlmClient);
  });

  it("returns inert client when no keys are configured", async () => {
    const client = createFailoverClient("deepseek", ["DEEPSEEK_API_KEY"], ["deepseek-chat"], { env: {} });
    await expect(client.chat(REQ)).rejects.toThrow("no groups");
  });
});

describe("FailoverLlmClient observability", () => {
  it("emits rotation decisions through onEvent (failure, cooldown skip)", async () => {
    let clock = 0;
    const events: string[] = [];
    const limited = stub([async () => RATE()]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [limited, ok])],
      async () => {},
      { now: () => clock, onEvent: (t) => events.push(t) },
    );
    await client.chat(REQ);
    expect(events.some((t) => t.includes("g1#0") && t.includes("失败") && t.includes("冷却 30s"))).toBe(true);
    // a-cooling combo is skipped on the next call with a summary line
    clock = 1;
    await client.chat(REQ);
    expect(events.some((t) => t.includes("跳过 1 个冷却中的组合"))).toBe(true);
  });

  it("emits a fail-fast line on auth errors", async () => {
    const events: string[] = [];
    const a = stub([async () => AUTH()]);
    const client = new FailoverLlmClient([group("g1", [a])], async () => {}, {
      onEvent: (t) => events.push(t),
    });
    await expect(client.chat(REQ)).rejects.toBeInstanceOf(HttpLlmError);
    expect(events.some((t) => t.includes("g1#0") && t.includes("认证失败"))).toBe(true);
  });
});

describe("buildLlmClient", () => {
  it("routes sensenova to the failover client, other providers to plain clients", () => {
    const sensenova = buildLlmClient("sensenova", { env: { SENSENOVA_API_KEY: "k" } });
    expect(sensenova).toBeInstanceOf(FailoverLlmClient);
    const deepseek = buildLlmClient("deepseek", { env: { DEEPSEEK_API_KEY: "k" } });
    expect(deepseek).not.toBeInstanceOf(FailoverLlmClient);
  });

  it("returns an inert failover client when sensenova keys are missing", async () => {
    const client = buildLlmClient("sensenova", { env: {} });
    await expect(client.chat(REQ)).rejects.toThrow("no groups");
  });
});

describe("createFailoverClient · sensenova flavor", () => {
  // Driven through the same call the two production sites make — build-llm.ts
  // and sensenova-api.ts — rather than through a convenience wrapper that only
  // the tests used.
  const sensenovaClient = (env?: NodeJS.ProcessEnv) =>
    createFailoverClient("sensenova", SENSENOVA_KEY_VARS, SENSENOVA_MODELS, env ? { env } : {});

  it("builds one group per present key with all models in order", () => {
    process.env.SENSENOVA_API_KEY = "k1";
    delete process.env.SENSENOVA_API_KEY_2;
    const client = sensenovaClient();
    expect(client).toBeInstanceOf(FailoverLlmClient);
    // Pool geometry is intentional: 3 keys × 4 models = the 12-route rotation.
    expect(SENSENOVA_KEY_VARS).toHaveLength(3);
    expect(SENSENOVA_MODELS).toHaveLength(4);
    expect(SENSENOVA_KEY_VARS.length * SENSENOVA_MODELS.length).toBe(12);
    delete process.env.SENSENOVA_API_KEY;
  });

  it("returns inert client when no keys are configured", async () => {
    for (const v of SENSENOVA_KEY_VARS) delete process.env[v];
    const client = sensenovaClient({});
    await expect(client.chat(REQ)).rejects.toThrow("no groups");
  });
});

describe("FailoverLlmClient · 调用方取消", () => {
  it("取消后不轮询下一条线路，也不把该线路拉进冷却", async () => {
    const seen: string[] = [];
    const events: string[] = [];
    const ctrl = new AbortController();
    const first: LlmClient = {
      async chat(): Promise<ChatResponse> {
        seen.push("first");
        ctrl.abort(); // 模拟"请求在途时用户叫停 / 撞到 run 时限"
        throw new Error("aborted by caller");
      },
    };
    const second: LlmClient = {
      async chat(): Promise<ChatResponse> {
        seen.push("second");
        return OK("m2")();
      },
    };
    const pool = new FailoverLlmClient([group("g1", [first]), group("g2", [second])], async () => {}, {
      onEvent: (t) => events.push(t),
    });
    await expect(pool.chat({ ...REQ, signal: ctrl.signal })).rejects.toThrow("aborted by caller");
    expect(seen).toEqual(["first"]);
    expect(events.some((e) => e.includes("已被调用方取消"))).toBe(true);
    // 取消不是线路的错：一条"冷却 N 秒"的处置都不该产生
    expect(events.filter((e) => /冷却 \d+s/.test(e))).toEqual([]);

    // 冷却池没被动过 ⇒ 下一次调用仍然先试 first（若被拉进冷却会被直接跳过）
    const next = await pool.chat(REQ);
    expect(seen).toEqual(["first", "first", "second"]);
    expect(next.model).toBe("m2");
  });

  it("真故障仍然照旧轮询并冷却（取消分支没顺手改掉默认语义）", async () => {
    const seen: string[] = [];
    const a: LlmClient = {
      async chat(): Promise<ChatResponse> {
        seen.push("a");
        throw new HttpLlmError(429, "rate limited");
      },
    };
    const b: LlmClient = {
      async chat(): Promise<ChatResponse> {
        seen.push("b");
        return OK("m-b")();
      },
    };
    const pool = new FailoverLlmClient([group("g1", [a]), group("g2", [b])], async () => {});
    const res = await pool.chat(REQ);
    expect(res.model).toBe("m-b");
    expect(seen).toEqual(["a", "b"]);
  });
});
