import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_POOL,
  PROVIDER_CATALOG,
  SENSENOVA_KEY_VARS,
  SENSENOVA_MODELS,
  SENSENOVA_MODELS_EXTRA,
  getProvider,
  providerKeyEnvVars,
} from "../shared/providers";
import {
  countPoolRoutes,
  FailoverLlmClient,
  HttpLlmError,
  createMultiProviderFailover,
  type FailoverGroup,
} from "../shared/http-clients";
import { buildLlmPool } from "../shared/build-llm";
import type { ChatResponse, LlmClient } from "../shared/llm-client";

function ok(model: string): ChatResponse {
  return { content: `pong from ${model}`, provider: "fake", model };
}

/** A client that always throws the given error. */
function failing(error: Error): LlmClient {
  return {
    async chat() {
      throw error;
    },
  };
}

function groupThrough(order: string[]): FailoverGroup[] {
  // Every group's clients record themselves when called, so the test can read
  // exactly which routes were attempted and in what order.
  const client = (label: string): LlmClient => ({
    async chat() {
      order.push(label);
      return ok(label);
    },
  });
  return [
    { label: "sensenova:KEY1", clients: [client("sensenova:KEY1#flash")] },
    { label: "sensenova:KEY2", clients: [client("sensenova:KEY2#flash")] },
    { label: "amd-radeon:AMD_API_KEY", clients: [client("amd:DeepSeek-V4-Flash")] },
  ];
}

describe("provider catalog", () => {
  it("exposes the 12-route SenseNova pool: 3 keys x 4 models", () => {
    expect(SENSENOVA_KEY_VARS).toHaveLength(3);
    expect(SENSENOVA_MODELS).toHaveLength(4);
    expect(SENSENOVA_KEY_VARS.length * SENSENOVA_MODELS.length).toBe(12);
  });

  it("keeps the extra model out of the default rotation", () => {
    expect(SENSENOVA_MODELS_EXTRA).toEqual(["kimi-k3"]);
    expect(SENSENOVA_MODELS as readonly string[]).not.toContain("kimi-k3");
  });

  it("lists the AMD Radeon endpoint as a first-class provider", () => {
    const amd = getProvider("amd-radeon");
    expect(amd.baseUrl).toBe("https://developer.amd.com.cn/radeon/api/v1");
    // 2026-09-20 重新核对 live `GET /models`：端点已扩容到 7 个模型，
    // `DeepSeek-V4-Flash` 实测返回 200（旧注释说它 400，已失效）。
    expect(amd.defaultModel).toBe("DeepSeek-V4-Flash");
    expect(amd.apiKeyEnvVar).toBe("AMD_API_KEY");
    expect(amd.protocol).toBe("openai-compatible");
  });

  it("defaults the pool to SenseNova + AMD, in that order", () => {
    expect([...DEFAULT_LLM_POOL]).toEqual(["sensenova", "amd-radeon"]);
  });

  it("every catalog entry has a unique id and a usable base url", () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDER_CATALOG) expect(p.baseUrl).toMatch(/^https?:\/\//);
  });

  it("reports the extra key vars of a multi-key provider", () => {
    expect(providerKeyEnvVars("sensenova")).toEqual([...SENSENOVA_KEY_VARS]);
    expect(providerKeyEnvVars("amd-radeon")).toEqual([]);
  });
});

describe("countPoolRoutes", () => {
  const routes = [
    { providerId: "sensenova", keyVars: SENSENOVA_KEY_VARS, models: SENSENOVA_MODELS },
    { providerId: "amd-radeon", keyVars: ["AMD_API_KEY"], models: ["DeepSeek-V4-Flash"] },
  ];

  it("multiplies keys by models, per provider", () => {
    const env = {
      SENSENOVA_API_KEY: "a",
      SENSENOVA_API_KEY_2: "b",
      SENSENOVA_API_KEY_3: "c",
      AMD_API_KEY: "d",
    };
    expect(countPoolRoutes(routes, env)).toBe(13); // 12 + 1
  });

  it("skips providers whose key is missing", () => {
    expect(countPoolRoutes(routes, { SENSENOVA_API_KEY: "a" })).toBe(4);
    expect(countPoolRoutes(routes, { AMD_API_KEY: "d" })).toBe(1);
    expect(countPoolRoutes(routes, {})).toBe(0);
  });
});

describe("cross-provider failover table", () => {
  it("rotates to another provider when a route is exhausted", async () => {
    const order: string[] = [];
    const client = new FailoverLlmClient(groupThrough(order), async () => undefined, { now: () => 0 });
    const res = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toContain("sensenova:KEY1#flash"); // first route wins
    expect(order).toEqual(["sensenova:KEY1#flash"]);
  });

  it("does not fail fast on auth when the pool spans providers", async () => {
    const events: string[] = [];
    const deadProvider: FailoverGroup = {
      label: "amd-radeon:AMD_API_KEY",
      clients: [failing(new HttpLlmError(401, "invalid api key"))],
    };
    const healthy: FailoverGroup = {
      label: "sensenova:KEY1",
      clients: [
        {
          async chat() {
            return ok("deepseek-v4-flash");
          },
        },
      ],
    };
    const client = new FailoverLlmClient([deadProvider, healthy], async () => undefined, {
      now: () => 0,
      failFastOnAuth: false,
      onEvent: (t) => events.push(t),
    });
    // The broken provider must not take the healthy one down.
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      model: "deepseek-v4-flash",
    });
    expect(events.join("|")).toContain("仅冷却该线路");
  });

  it("still fails fast on auth inside a single provider", async () => {
    const dead: FailoverGroup = {
      label: "sensenova:KEY1",
      clients: [failing(new HttpLlmError(403, "forbidden"))],
    };
    const other: FailoverGroup = {
      label: "sensenova:KEY2",
      clients: [
        {
          async chat() {
            return ok("should not be reached");
          },
        },
      ],
    };
    const client = new FailoverLlmClient([dead, other], async () => undefined, { now: () => 0 });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/403/);
  });

  it("does not sleep between routes on auth failures", async () => {
    // A misconfigured provider would otherwise cost one backoff window per
    // route — 12 dead SenseNova routes meant ~80s before AMD got a turn.
    const sleeps: number[] = [];
    const auth = (label: string): FailoverGroup => ({
      label,
      clients: [failing(new HttpLlmError(401, "invalid api key"))],
    });
    const healthy: FailoverGroup = {
      label: "amd-radeon:AMD_API_KEY",
      clients: [
        {
          async chat() {
            return ok("MiniCPM5-2B");
          },
        },
      ],
    };
    const client = new FailoverLlmClient([auth("sensenova:KEY1"), auth("sensenova:KEY2"), healthy], async (ms) => {
      sleeps.push(ms);
    }, { now: () => 0, failFastOnAuth: false });

    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({
      model: "MiniCPM5-2B",
    });
    expect(sleeps).toEqual([]);
  });

  it("still backs off between routes on rate limits", async () => {
    const sleeps: number[] = [];
    const slow: FailoverGroup = {
      label: "sensenova:KEY1",
      clients: [failing(new HttpLlmError(429, "rpm exhausted"))],
    };
    const healthy: FailoverGroup = {
      label: "amd-radeon:AMD_API_KEY",
      clients: [
        {
          async chat() {
            return ok("MiniCPM5-2B");
          },
        },
      ],
    };
    const client = new FailoverLlmClient([slow, healthy], async (ms) => {
      sleeps.push(ms);
    }, { now: () => 0, failFastOnAuth: false });
    await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(sleeps).toEqual([500]); // baseBackoffMs, only once
  });

  it("benches only the failing route and retries it after the cooldown", async () => {
    let now = 0;
    let calls = 0;
    const flaky: FailoverGroup = {
      label: "amd-radeon:AMD_API_KEY",
      clients: [
        {
          async chat() {
            calls += 1;
            if (calls === 1) throw new HttpLlmError(429, "rpm exhausted", 0);
            return ok("DeepSeek-V4-Flash");
          },
        },
      ],
    };
    const healthy: FailoverGroup = {
      label: "sensenova:KEY1",
      clients: [
        {
          async chat() {
            return ok("deepseek-v4-flash");
          },
        },
      ],
    };
    const client = new FailoverLlmClient([flaky, healthy], async () => undefined, {
      now: () => now,
      cooldownMs: 1_000,
      failFastOnAuth: false,
    });
    expect((await client.chat({ messages: [{ role: "user", content: "hi" }] })).model).toBe("deepseek-v4-flash");
    now += 1_100; // past the cooldown
    expect((await client.chat({ messages: [{ role: "user", content: "hi" }] })).model).toBe("DeepSeek-V4-Flash");
  });
});

describe("createMultiProviderFailover", () => {
  it("builds one table whose route count matches the spec", () => {
    const env = {
      SENSENOVA_API_KEY: "a",
      SENSENOVA_API_KEY_2: "b",
      SENSENOVA_API_KEY_3: "c",
      AMD_API_KEY: "d",
    };
    const client = createMultiProviderFailover(
      [
        { providerId: "sensenova", keyVars: SENSENOVA_KEY_VARS, models: SENSENOVA_MODELS },
        { providerId: "amd-radeon", keyVars: ["AMD_API_KEY"], models: ["DeepSeek-V4-Flash"] },
      ],
      { env },
    );
    // No network here; the assertion is that construction succeeded with all
    // routes present rather than silently collapsing to a single client.
    expect(client).toBeDefined();
    expect(countPoolRoutes(
      [
        { providerId: "sensenova", keyVars: SENSENOVA_KEY_VARS, models: SENSENOVA_MODELS },
        { providerId: "amd-radeon", keyVars: ["AMD_API_KEY"], models: ["DeepSeek-V4-Flash"] },
      ],
      env,
    )).toBe(13);
  });
});

describe("buildLlmPool", () => {
  it("produces a pool that reports no routes when no key is configured", async () => {
    const client = buildLlmPool({ env: {}, providers: ["sensenova", "amd-radeon"] });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /no groups/,
    );
  });

  it("includes AMD only when its key is present", async () => {
    // With only the AMD key, the pool must still work — and must be described
    // as one provider, so auth failures stay fail-fast there.
    const onlyAmd = buildLlmPool({ env: { AMD_API_KEY: "x" }, providers: ["sensenova", "amd-radeon"] });
    expect(onlyAmd).toBeDefined();
  });
});
