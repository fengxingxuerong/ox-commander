import { describe, expect, it } from "vitest";
import { buildLlmClient } from "../shared/build-llm";
import {
  AllRoutesCoolingError,
  createFailoverClient,
  FailoverLlmClient,
  HttpLlmError,
  lineHealthOf,
  type FailoverGroup,
  type LineHealth,
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
    // 非 HTTP 错误（超时/网络）同样视为 transient（isTransient 兜底 true）→
    // 该线路被冷却 → 第二轮直接跳过 a 试 b（变异 true→false 会让 a 不冷却、
    // 第二轮又先试 a，本断言将其杀死）。
    await client.chat(REQ);
    expect(calls).toEqual(["a", "b", "b"]);
  });

  it("benches timeout-only route after first failure (AllRoutesCoolingError)", async () => {
    // 单线路场景：速度画像会让"有历史的线路排前"从而掩盖冷却差异，只有
    // 独苗超时线路才能直接观察 isTransient 兜底 true 的冷却语义（变异
    // true→false 会让第二轮再次尝试超时线路而不是抛 AllRoutesCoolingError）。
    let clock = 0;
    const calls: string[] = [];
    const timeoutOnly: LlmClient = {
      async chat() {
        calls.push("t");
        throw new Error("The operation was aborted due to timeout");
      },
    };
    const client = new FailoverLlmClient([group("g1", [timeoutOnly])], async () => {}, { now: () => clock });
    await expect(client.chat(REQ)).rejects.toThrow("aborted due to timeout");
    clock += 1_000; // 未到 30s 冷却
    await expect(client.chat(REQ)).rejects.toBeInstanceOf(AllRoutesCoolingError);
    expect(calls).toEqual(["t"]); // 第二轮没有再次调用该线路（在冷却中）
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
    clock = 7_000; // cooldown expired. 速度画像（2026-09-27 加）：ok 有成功历史
    // （快线路优先），ra 的失败从不记速度 → ok 先被试且成功，ra 不再被探测。
    await client.chat(REQ);
    expect(calls).toEqual(["ra", "ok", "ok", "ok"]);
    expect(sleeps).toEqual([7_000]); // 第三轮 ok 直接成功，无 backoff sleep
  });

  // 第 455 行 `e instanceof HttpLlmError ? e.retryAfterMs : undefined`。
  // 交换分支后：429 带的 Retry-After 被丢掉，冷却退回默认 30s —— 线路被多罚
  // 23s，而服务端明明说了 7s 后可重试。onEvent 里的秒数是这件事唯一的外显处。
  it("[455] 冷却秒数取自 Retry-After，不是默认值", async () => {
    const events: string[] = [];
    const limited = stub([async () => Promise.reject(new HttpLlmError(429, "limited", 7_000))]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [limited, ok])],
      async () => {},
      { onEvent: (t) => events.push(t) },
    );
    await client.chat(REQ);
    expect(events.join("\n")).toContain("冷却 7s");
  });

  // 第 466 行 `e instanceof Error ? e.message : String(e)`。
  // 交换分支后：真正的 Error 被 `String(e)` 加成 `Error: xxx` 前缀，
  // 非 Error 的抛出物则取 `e.message`（多半是 undefined）—— 日志里要么多一层噪音，
  // 要么整段变成 "undefined"，排障时看不出到底挂在哪。
  it("[466] 错误摘要取裸 message，不带 Error: 前缀", async () => {
    const events: string[] = [];
    const boom = stub([async () => Promise.reject(new Error("socket hang up"))]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [boom, ok])],
      async () => {},
      { onEvent: (t) => events.push(t) },
    );
    await client.chat(REQ);
    const line = events.join("\n");
    expect(line).toContain("socket hang up");
    expect(line).not.toContain("Error: socket hang up");
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
    // 速度画像（2026-09-27 加）：ok 有成功历史（快线路优先）→ 先试 ok 且成功，
    // bad（400 不记速度、无历史）排后不再被探测。
    clock = 1;
    const res = await client.chat(REQ);
    expect(res.model).toBe("m");
    expect(calls).toEqual(["boom", "timeout", "bad", "ok", "ok"]);
    expect(sleeps).toEqual([500, 1000, 2000]); // 第二轮 ok 直接成功，无 backoff sleep
  });

  /**
   * 速度画像（2026-09-27 --real 演习实测驱动）：慢线路排前时每次先被试、
   * 一次吃满 attempt 预算（glm-5.2 529s vs 快线路 74.6s），快线路轮不到。
   * 现在每次调用按「成功耗时画像」动态排序：已知快的先试、无历史保持原序、
   * 失败从不记速度（失败走冷却惩罚）。本组用例用注入的 clock 模拟耗时。
   */
  describe("speed profile (fast-route-first ordering)", () => {
    it("known-fast route is tried first on the next call", async () => {
      const ref = { clock: 0 };
      const calls: string[] = [];
      // slow 首次 503（冷却 30s）——给 fast 一个入画像的机会
      const slow = stub([async () => { calls.push("slow"); throw new HttpLlmError(503, "down"); }]);
      const fast = stub([async () => { calls.push("fast"); ref.clock += 10; return OK("m-fast")(); }]);
      const client = new FailoverLlmClient([group("g1", [slow, fast])], async () => {}, { now: () => ref.clock });
      // 第一轮：slow 503 → fast 成功（10ms 入画像）
      await client.chat(REQ);
      expect(calls).toEqual(["slow", "fast"]);
      // slow 冷却过期后：fast(10ms) 有历史 < slow(无历史=排后) → fast 先试
      ref.clock += 31_000;
      const res = await client.chat(REQ);
      expect(res.model).toBe("m-fast");
      expect(calls).toEqual(["slow", "fast", "fast"]);
    });

    it("among routes with history, the faster EWMA goes first", async () => {
      let calls: string[] = [];
      let clock = 0;
      // slowA: 第一次成功 500ms；第二次抛 503（进冷却），给 fastB 一个成功机会
      const slowA: LlmClient = {
        async chat() {
          calls.push("slowA");
          if (calls.filter((c) => c === "slowA").length === 1) {
            clock += 500;
            return OK("m-slowA")();
          }
          throw new HttpLlmError(503, "down");
        },
      };
      const fastB: LlmClient = {
        async chat() {
          calls.push("fastB");
          clock += 10;
          return OK("m-fastB")();
        },
      };
      const client = new FailoverLlmClient([group("g1", [slowA, fastB])], async () => {}, { now: () => clock });
      // 第一轮：slowA 成功（500ms 入画像）
      await client.chat(REQ);
      // 第二轮：slowA 503（冷却 30s）→ fastB 成功（10ms 入画像）
      clock += 30_000;
      await client.chat(REQ);
      expect(calls).toEqual(["slowA", "slowA", "fastB"]);
      // 第三轮（都无冷却）：fastB(10) < slowA(500) → fastB 先试且成功，slowA 不再被探测
      const res = await client.chat(REQ);
      expect(res.model).toBe("m-fastB");
      expect(calls).toEqual(["slowA", "slowA", "fastB", "fastB"]);
    });

    it("profile updates: a later fast success keeps the route ahead of a middling one", async () => {
      let clock = 0;
      const calls: string[] = [];
      // a：第一次 500ms，第二次起 10ms（快速稳定）；b：固定 300ms
      const a: LlmClient = {
        async chat() {
          calls.push("a");
          const n = calls.filter((c) => c === "a").length;
          clock += n === 1 ? 500 : 10;
          return OK("m-a")();
        },
      };
      const b: LlmClient = {
        async chat() {
          calls.push("b");
          clock += 300;
          return OK("m-b")();
        },
      };
      const client = new FailoverLlmClient([group("g1", [a, b])], async () => {}, { now: () => clock });
      // 第一轮：a(500) 成功入画像
      await client.chat(REQ);
      // 第二轮：a 有历史、b 无历史 → a 先试成功（画像更新：500 → 平滑后更快）
      await client.chat(REQ);
      expect(calls).toEqual(["a", "a"]);
      // 让 b 也入画像：给 a 一次 400（不冷却），b 成功（300ms）
      const a400: LlmClient = {
        async chat() {
          calls.push("a");
          throw new HttpLlmError(400, "bad");
        },
      };
      const client2 = new FailoverLlmClient([group("g1", [a400, b])], async () => {}, { now: () => clock });
      await client2.chat(REQ);
      // a(400) 不冷却不记速度 → 第二轮排序：b 有历史(300) → b 先试成功
      const res = await client2.chat(REQ);
      expect(res.model).toBe("m-b");
      expect(calls).toEqual(["a", "a", "a", "b", "b"]);
    });

    it("failures never enter the speed profile (cooldown is their only penalty)", async () => {
      let clock = 0;
      const calls: string[] = [];
      const flaky: LlmClient = {
        async chat() {
          calls.push("flaky");
          throw new HttpLlmError(429, "limited", 0);
        },
      };
      const ok: LlmClient = {
        async chat() {
          calls.push("ok");
          clock += 20;
          return OK("m-ok")();
        },
      };
      const client = new FailoverLlmClient([group("g1", [flaky, ok])], async () => {}, { now: () => clock });
      await client.chat(REQ);
      clock += 31_000; // flaky 冷却过期
      const res = await client.chat(REQ);
      // flaky 从未成功（无速度记录）→ ok（有历史）排前先试
      expect(res.model).toBe("m-ok");
      expect(calls).toEqual(["flaky", "ok", "ok"]);
    });
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

describe("线路健康（P1-2）：冷却与限流账要能被界面读到", () => {
  // 此前冷却表只活在 client 内部（`onEvent` 只落一行给人看的话），界面拿不到
  // 字段 —— "还有几条线能用、哪条在被限流"这件事没有出口。下面几条把这份事实
  // 钉住：判定在纯函数 `lineHealthOf` 里，UI 与协议事件共用同一份口径。
  it("lineHealthOf：冷却中给剩余毫秒，到期即回到可用（过期不是永久判死）", () => {
    const cooldowns = new Map([["g1#0", 10_000]]);
    const stats = new Map([["g1#0", { failures: 2, rateLimitHits: 1 }]]);
    expect(lineHealthOf(["g1#0"], cooldowns, stats, 4_000)).toEqual([
      { key: "g1#0", cooling: true, remainingMs: 6_000, failures: 2, rateLimitHits: 1 },
    ]);
    // 到期那一刻：cooling 必须为 false、remainingMs 为 0（不是负数也不是哨兵）
    expect(lineHealthOf(["g1#0"], cooldowns, stats, 10_000)).toEqual([
      { key: "g1#0", cooling: false, remainingMs: 0, failures: 2, rateLimitHits: 1 },
    ]);
  });

  it("lineHealthOf：没失败过的线路也要在表里（零值，不是缺行）", () => {
    const lines = lineHealthOf(["g1#0", "g1#1"], new Map(), new Map(), 0);
    expect(lines.map((l) => l.key)).toEqual(["g1#0", "g1#1"]);
    expect(lines.every((l) => l.cooling === false && l.failures === 0 && l.rateLimitHits === 0)).toBe(true);
  });

  it("429 才算限流，5xx 只算失败（两个计数不是一个东西）", async () => {
    let clock = 0;
    const limited = stub([async () => Promise.reject(new HttpLlmError(429, "limited"))]);
    const broken = stub([async () => Promise.reject(new HttpLlmError(500, "boom"))]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient(
      [group("g1", [limited, broken, ok])],
      async () => {},
      { now: () => clock },
    );
    await client.chat(REQ);
    clock = 1_000;
    const health = client.health();
    expect(health).toHaveLength(3);
    expect(health[0]).toMatchObject({ key: "g1#0", cooling: true, failures: 1, rateLimitHits: 1 });
    expect(health[1]).toMatchObject({ key: "g1#1", cooling: true, failures: 1, rateLimitHits: 0 });
    expect(health[2]).toMatchObject({ key: "g1#2", cooling: false, failures: 0, rateLimitHits: 0 });
  });

  it("onHealth：建好就推一份全表，失败/恢复各再推一次", async () => {
    const seen: LineHealth[][] = [];
    const rate = stub([async () => Promise.reject(new HttpLlmError(429, "limited"))]);
    const ok = stub([async () => OK("m")()]);
    const client = new FailoverLlmClient([group("g1", [rate, ok])], async () => {}, {
      onHealth: (lines) => seen.push(lines),
    });
    // 构造即推：宿主不必等第一次失败才知道池里有什么
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((l) => l.key)).toEqual(["g1#0", "g1#1"]);
    await client.chat(REQ);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)![0]!.rateLimitHits).toBe(1);
  });
});
