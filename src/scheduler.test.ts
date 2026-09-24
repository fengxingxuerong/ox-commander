import { describe, expect, it, vi } from "vitest";
import { digest, Scheduler } from "../electron/engine/scheduler";
import { AgentRegistry } from "../electron/agents/registry";
import { createCapabilityRouter } from "../electron/engine/router";
import { createAgentLayer } from "../electron/agents";
import type { AgentCapabilities } from "../shared/agent-contract";
import type { AgentAdapter, RunHandle, Task } from "../shared/types";

function task(id: string, zone: string): Task {
  return {
    id,
    title: id,
    description: "desc",
    zone,
    dependencies: [],
    suggestedRole: "fullstack-dev",
  };
}

function adapterWith(id: string, ok: boolean, opts?: { probe?: boolean; dispatched?: string[]; handles?: RunHandle[] }): AgentAdapter {
  return {
    meta: { id, name: id, kind: "api" },
    async probe() {
      return opts?.probe ?? true;
    },
    async dispatch(payload) {
      opts?.dispatched?.push(id);
      const handle = { runId: payload.runId, agentId: id, taskId: payload.taskId };
      opts?.handles?.push(handle);
      return handle;
    },
    async *collect(handle) {
      yield { kind: "log", text: `working on ${handle.taskId}`, timestamp: Date.now() };
      if (ok) {
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      } else {
        yield { kind: "failed", text: "exit code 1", timestamp: Date.now() };
      }
    },
    async abort() {},
  };
}

describe("Scheduler.abortInFlight", () => {
  /**
   * "卡住不返回"的适配器：collect 等在 gate 上，只有 abort 放行 ——
   * 这样才有真正"在跑"的窗口可以观察登记表。
   */
  function stuckAdapter(id: string, log: string[], failAbort = false): AgentAdapter {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        log.push(`dispatch:${id}`);
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        await gate;
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {
        // 无论这次 abort 算不算失败，run 都得收摊 —— 否则用例自己挂死在 collect 上。
        release();
        if (failAbort) throw new Error(`abort refused by ${id}`);
        log.push(`abort:${id}`);
      },
    };
  }

  async function waitLive(sched: Scheduler, n: number): Promise<void> {
    for (let i = 0; i < 100 && sched.activeRuns() < n; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // activeRuns 数的是槽位；再让出一拍，确保 dispatch 已经返回、句柄已登记
    await new Promise((r) => setTimeout(r, 10));
  }

  it("掐掉在跑的 run；收摊之后登记表是干净的", async () => {
    const log: string[] = [];
    const sched = new Scheduler([stuckAdapter("a1", log)]);
    const batch = sched.runBatch([task("t1", "src/a")], ".");
    await waitLive(sched, 1);

    expect(await sched.abortInFlight()).toBe(1);
    expect(await batch).toHaveLength(1);
    expect(log).toContain("abort:a1");
    // finally 已经把它从 liveRuns 摘掉：再 abort 一次既不能计数也不能重复打扰适配器
    expect(await sched.abortInFlight()).toBe(0);
    expect(log.filter((x) => x === "abort:a1")).toHaveLength(1);
  });

  it("一个适配器的 abort 抛错，其余在跑的 run 仍被中止", async () => {
    const log: string[] = [];
    const sched = new Scheduler([
      stuckAdapter("bad", log, true),
      stuckAdapter("good", log),
    ]);
    const batch = sched.runBatch([task("t1", "src/a"), task("t2", "src/b")], ".");
    await waitLive(sched, 2);

    const n = await sched.abortInFlight();
    // bad 抛错 ⇒ 不计入；good 正常 ⇒ 计入
    expect(n).toBe(1);
    expect(log).toContain("abort:good");
    await batch;
  });
});

describe("Scheduler.runBatch", () => {
  it("runs zone-disjoint tasks concurrently and collects outcomes", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    const outcomes = await sched.runBatch([task("t1", "src/a"), task("t2", "src/b")], ".");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("throws on zone conflict inside one batch", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    await expect(
      sched.runBatch([task("t1", "same"), task("t2", "same")], "."),
    ).rejects.toThrow(/zone conflict/);
  });

  it("marks failed runs with log digest", async () => {
    const sched = new Scheduler([adapterWith("a1", false)]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toContain("exit code 1");
  });

  it("reports dispatch failure when no adapter exists", async () => {
    const sched = new Scheduler([]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toMatch(/no agent|dispatch failed/);
  });

  it("skips adapters whose probe fails and picks the next available CLI", async () => {
    const dispatched: string[] = [];
    const sched = new Scheduler([adapterWith("a1", true, { probe: false }), adapterWith("a2", true, { dispatched })]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(true);
    expect(dispatched).toEqual(["a2"]);
  });

  it("reports no agent available when every probe fails", async () => {
    const sched = new Scheduler([
      adapterWith("a1", true, { probe: false }),
      adapterWith("a2", true, { probe: false }),
    ]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toBe("no agent available");
  });

  it("orders candidates by preferredAgents before availability probing", async () => {
    const dispatched: string[] = [];
    const sched = new Scheduler(
      [adapterWith("a1", true), adapterWith("a2", true, { dispatched })],
      ["a2"],
    );
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(true);
    expect(dispatched).toEqual(["a2"]);
  });

  it("rejects an exact agentId whose probe fails", async () => {
    const sched = new Scheduler(
      [adapterWith("a1", true, { probe: false }), adapterWith("a2", true)],
      [],
    );
    const outcomes = await sched.runBatch([task("t1", "z")], ".", { preferredAgentId: "a1" });
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toBe("no agent available");
  });

  it("distributes zone-disjoint tasks round-robin across multiple available agents", async () => {
    const handles: RunHandle[] = [];
    const dispatched: string[] = [];
    const sched = new Scheduler([
      adapterWith("a1", true, { dispatched, handles }),
      adapterWith("a2", true, { dispatched, handles }),
    ]);
    const outcomes = await sched.runBatch(
      [task("t1", "src/a"), task("t2", "src/b"), task("t3", "src/c")],
      ".",
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
    // Two available agents → first two tasks land on different agents.
    expect(dispatched[0]).toBe("a1");
    expect(dispatched[1]).toBe("a2");
    expect(handles.map((h) => h.agentId)).toEqual(["a1", "a2", "a1"]);
  });

  // The legacy third constructor argument (`ZoneGuard`) was removed: `platform.ts`
  // is the only production wiring point and always passed `undefined`, so the
  // out-of-zone branch it drove could never run — while its tests kept passing.
  // The rogue-write case now lives on the real guard path, end-to-end, in
  // `sandbox-journal.test.ts` ("rolls a rogue write back and fails only the
  // batch that caused it").

  it("passes the batch when changes stay inside declared zones (real guard path)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { BatchGuard } = await import("../electron/engine/batch-guard");
    const { SnapshotStore } = await import("../electron/sandbox/snapshot-store");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sched-"));
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sched-bak-"));
    try {
      const wellBehaved = {
        meta: { id: "a1", name: "a1", kind: "api" as const },
        async probe() {
          return true;
        },
        async dispatch(payload: { runId: string; taskId: string }) {
          fs.mkdirSync(path.join(root, "src/core"), { recursive: true });
          fs.writeFileSync(path.join(root, "src/core/b.js"), "b", "utf8");
          return { runId: payload.runId, agentId: "a1", taskId: payload.taskId };
        },
        async *collect() {
          yield { kind: "completed" as const, text: "done", timestamp: Date.now() };
        },
        async abort() {},
      } as unknown as AgentAdapter;
      const sched = new Scheduler([wellBehaved], [], {
        guard: new BatchGuard({ snapshots: new SnapshotStore({ backupRoot }), mode: "revert-batch" }),
      });
      const outcomes = await sched.runBatch([task("t1", "src/core")], root);
      expect(outcomes[0].ok).toBe(true);
      // Legitimate work must survive the guard: no rollback, no report.
      expect(fs.readFileSync(path.join(root, "src/core/b.js"), "utf8")).toBe("b");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  });

  it("同毫秒内的两个批不会共用批号，runId 也不会碰撞", async () => {
    // 批号被当快照**目录名**用（snapshots/<runId>），撞了就变成两个批抢同一份备份；
    // runId 是适配器里会话表的键，撞了日志与结果就会串到别的任务上。
    // Date.now 只有毫秒粒度，所以这里把时钟冻住 —— 不冻就测不到真正会撞的那一档。
    const batchIds: string[] = [];
    const runIds: string[] = [];
    const guard = {
      begin: async (runId: string) => {
        batchIds.push(runId);
        return { runId };
      },
      settle: async (_scope: unknown, outcomes: unknown[]) => ({ outcomes, conflicts: [], remedies: [] }),
    };
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const capturing = {
        meta: { id: "a1", name: "a1", kind: "api" as const },
        async probe() {
          return true;
        },
        async dispatch(payload: { runId: string; taskId: string }) {
          runIds.push(payload.runId);
          return { runId: payload.runId, agentId: "a1", taskId: payload.taskId };
        },
        async *collect() {
          yield { kind: "completed" as const, text: "done", timestamp: 0 };
        },
        async abort() {},
      } as unknown as AgentAdapter;
      const sched = new Scheduler([capturing], [], { guard: guard as never });
      await sched.runBatch([task("t1", "src/a")], "root-a");
      await sched.runBatch([task("t1", "src/a")], "root-b"); // 同一份计划、同一毫秒
    } finally {
      spy.mockRestore();
    }
    expect(batchIds).toHaveLength(2);
    expect(new Set(batchIds).size).toBe(2);
    // 目录是跨进程共享的，所以批号还必须带上 pid
    expect(batchIds[0]).toContain(`-${process.pid}-`);
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(runIds).toHaveLength(2);
  });

  it("records exactly one circuit-breaker failure per failed dispatch", async () => {
    const { CircuitBreaker } = await import("../electron/sandbox/circuit-breaker");
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    const exploding = {
      meta: { id: "a1", name: "a1", kind: "api" as const },
      async probe() {
        return true;
      },
      async dispatch() {
        throw new Error("boom");
      },
      async *collect() {},
      async abort() {},
    } as unknown as AgentAdapter;
    const sched = new Scheduler([exploding], [], { breaker });
    await sched.runBatch([task("t1", "z")], ".");
    // `recordFailure` bumps `consecutiveFailures`, so a second record on the same
    // dispatch opened a threshold-3 circuit after 2 independent failures.
    expect(breaker.stats("a1").failures).toBe(1);
    expect(breaker.stats("a1").consecutiveFailures).toBe(1);
    await sched.runBatch([task("t2", "z")], ".");
    expect(breaker.stats("a1").state).toBe("closed");
  });

  it("does not fall back to an agent whose circuit is open", async () => {
    const { CircuitBreaker } = await import("../electron/sandbox/circuit-breaker");
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    // Threshold 1: one recorded failure opens each circuit.
    breaker.record("a1", false);
    breaker.record("a2", false);
    const dispatched: string[] = [];
    const sched = new Scheduler(
      [adapterWith("a1", true, { dispatched }), adapterWith("a2", true, { dispatched })],
      [],
      { breaker },
    );
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    // The fallback must skip an open circuit too. `||` instead of `&&` in
    // `admitBreaker` would hand the task to a tripped agent and quietly defeat
    // the breaker — found by mutation testing.
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toBe("no agent available");
    expect(dispatched).toEqual([]);
  });

  it("[267] 首选 agent 熔断时，兜底找到的必须是「别人」而不是它自己", async () => {
    // 第 267 行 `available.find((a) => a.meta.id !== wanted.meta.id && breaker.allow(a.meta.id))`。
    // 把 `!==` 改成 `===` 之后，find 会在**首选 agent 自己**身上找 ——
    // 而它刚刚因为 allow 为假才被兜底，所以永远匹配不上，find 恒返回 undefined。
    // 于是「熔断一个、还有别的可用」的场景下任务直接判成 no agent available，
    // 能力池里的其它 agent 被白白闲置。
    //
    // 既有用例（both open）两种写法结果相同（都是找不到），所以看不出来。
    const { CircuitBreaker } = await import("../electron/sandbox/circuit-breaker");
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.record("a1", false); // 只打开 a1，a2 仍可用
    const dispatched: string[] = [];
    const sched = new Scheduler(
      [adapterWith("a1", true, { dispatched }), adapterWith("a2", true, { dispatched })],
      [],
      { breaker },
    );
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(dispatched).toEqual(["a2"]);
    expect(outcomes[0]!.ok).toBe(true);
  });
});

describe("Scheduler capability routing (P1)", () => {
  function declared(id: string, ok: boolean, c: Partial<AgentCapabilities>, dispatched: string[]): AgentAdapter {
    const base = adapterWith(id, ok, { dispatched });
    return Object.assign(base, {
      capabilities: () => ({
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: false,
        ...c,
      }),
    }) as AgentAdapter;
  }

  function roleTask(id: string, zone: string, role: string): Task {
    return { id, title: id, description: "d", zone, dependencies: [], suggestedRole: role };
  }

  it("dispatches a task to the agent that declares the matching role and zone", async () => {
    const dispatched: string[] = [];
    const generalist = declared("generalist", true, {}, dispatched);
    const tests = declared("tests-specialist", true, { roles: ["test-writer"], zoneGlobs: ["tests/**"] }, dispatched);
    const registry = new AgentRegistry([{ adapter: generalist }, { adapter: tests }]);
    const sched = new Scheduler([generalist, tests], [], {
      registry,
      router: createCapabilityRouter(),
    });
    const outcomes = await sched.runBatch([roleTask("t1", "tests/unit", "test-writer")], ".");
    expect(outcomes[0].ok).toBe(true);
    expect(dispatched).toEqual(["tests-specialist"]);
  });

  it("keeps the legacy round-robin order when no agent declares capabilities", async () => {
    const dispatched: string[] = [];
    const layer = createAgentLayer({
      adapters: [adapterWith("a1", true, { dispatched }), adapterWith("a2", true, { dispatched })],
    });
    const sched = new Scheduler(layer.adapters, [], layer.schedulerOptions);
    const outcomes = await sched.runBatch(
      [roleTask("t1", "src/a", "backend-dev"), roleTask("t2", "src/b", "backend-dev"), roleTask("t3", "src/c", "backend-dev")],
      ".",
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
    expect(dispatched).toEqual(["a1", "a2", "a1"]);
  });

  it("reports routing decisions to the host sink", async () => {
    const dispatched: string[] = [];
    const seen: string[] = [];
    const layer = createAgentLayer({
      adapters: [declared("only", true, { roles: ["docs-writer"], zoneGlobs: ["docs/**"] }, dispatched)],
      onRouting: (decision, task) => seen.push(`${task.id}->${decision.agentId}`),
    });
    const sched = new Scheduler(layer.adapters, [], layer.schedulerOptions);
    await sched.runBatch([roleTask("t1", "docs/api", "docs-writer")], ".");
    expect(seen).toEqual(["t1->only"]);
  });

  it("can be switched off entirely, restoring the round-robin pool", async () => {
    const dispatched: string[] = [];
    const layer = createAgentLayer({
      adapters: [
        declared("tests-specialist", true, { roles: ["test-writer"], zoneGlobs: ["tests/**"] }, dispatched),
        adapterWith("a2", true, { dispatched }),
      ],
      enableRouter: false,
    });
    expect(layer.schedulerOptions.router).toBeUndefined();
    const sched = new Scheduler(layer.adapters, [], layer.schedulerOptions);
    await sched.runBatch([roleTask("t1", "tests/unit", "test-writer")], ".");
    expect(dispatched[0]).toBe("tests-specialist");
  });

  it("sees an agent registered after the Scheduler was built", async () => {
    const dispatched: string[] = [];
    const layer = createAgentLayer({ adapters: [adapterWith("generalist", true, { dispatched })] });
    const sched = new Scheduler(layer.adapters, [], layer.schedulerOptions);

    // Register a specialist into the live registry, then route again.
    class TraeAdapter {
      readonly meta = { id: "trae-cli", name: "Trae", kind: "api" as const };
      async probe() {
        return true;
      }
      async dispatch(p: { runId: string; taskId: string }) {
        dispatched.push("trae-cli");
        return { runId: p.runId, agentId: "trae-cli", taskId: p.taskId };
      }
      async *collect() {
        yield { kind: "completed" as const, text: "ok", timestamp: Date.now() };
      }
      async abort() {}
      capabilities() {
        return {
          roles: ["backend-dev"],
          zoneGlobs: ["src/**"],
          supports: ["read", "edit", "create"],
          artifactKinds: ["files"],
          maxConcurrency: 1,
          selfIsolated: true,
        };
      }
    }
    const reg = layer.registry;
    expect(reg.register({ adapter: new TraeAdapter() as unknown as AgentAdapter }).ok).toBe(true);
    sched.forgetProbe();

    const outcomes = await sched.runBatch([roleTask("t1", "src/app", "backend-dev")], ".");
    expect(outcomes[0].ok).toBe(true);
    expect(dispatched).toEqual(["trae-cli"]);
  });
});

describe("digest", () => {
  it("truncates long logs keeping head and tail", () => {
    const long = `${"x".repeat(5000)}ERROR${"y".repeat(5000)}`;
    const d = digest(long, 1000);
    expect(d.length).toBeLessThan(1200);
    expect(d).toContain("[truncated]");
    expect(d.endsWith("y".repeat(10))).toBe(true);
  });
});

describe("Scheduler · 派单失败的错误分类", () => {
  it("errorClass 取自 classifyFailure，而不是一律兜底 unknown", async () => {
    // `errorClass: classifyFailure(msg) || "unknown"`
    // 改成 `&&` 之后：分类**成功**时（返回真值字符串）反而被替成 "unknown"，
    // 分类失败时（同样返回真值 "unknown"）也是 "unknown" —— 于是所有失败都记成 unknown，
    // 运维侧按 errorClass 做统计 / 告警会全部失真。
    //
    // 所以这里必须用**能命中分类规则**的消息（"超时" → "timeout"）：
    // 若用 "boom"（→ "unknown"），两个版本结果相同，看不出差别。
    const boom = {
      meta: { id: "a1", name: "a1", kind: "api" as const },
      async probe() {
        return true;
      },
      async dispatch() {
        throw new Error("调用超时（timeout）");
      },
      async *collect() {
        yield { kind: "failed" as const, text: "x", timestamp: Date.now() };
      },
      async abort() {},
    } as unknown as AgentAdapter;
    const sched = new Scheduler([boom], []);
    const outcomes = await sched.runBatch([task("t1", "src/core")], ".");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.errorClass).toBe("timeout");
  });
});

describe("Scheduler · 429 感知派发节流", () => {
  function rateLimitAdapter(state: { failNext: boolean }, dispatched: string[]): AgentAdapter {
    return {
      meta: { id: "a1", name: "a1", kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        dispatched.push(payload.taskId);
        return { runId: payload.runId, agentId: "a1", taskId: payload.taskId };
      },
      async *collect() {
        if (state.failNext) {
          yield { kind: "failed", text: "LLM HTTP 429: rate limit exceeded", timestamp: Date.now() };
        } else {
          yield { kind: "completed", text: "ok", timestamp: Date.now() };
        }
      },
      async abort() {},
    };
  }

  it("rate-limit 失败后，下一个派发被节流推迟；干净结果清零状态", async () => {
    const state = { failNext: true };
    const dispatched: string[] = [];
    const throttled: number[] = [];
    const sched = new Scheduler([rateLimitAdapter(state, dispatched)], [], {
      maxParallelRuns: 1,
      rateLimitBackoffMs: 150,
      onThrottle: (ms) => throttled.push(ms),
    });

    await sched.runBatch([task("t1", "src/a")], "."); // 失败 → 记账节流（当下不等待）
    expect(throttled.length).toBe(0);

    state.failNext = false;
    const t0 = Date.now();
    await sched.runBatch([task("t2", "src/b")], "."); // 派发前等待节流窗口
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
    expect(throttled.length).toBe(1);

    await sched.runBatch([task("t3", "src/c")], "."); // t2 成功已清零 → 不再节流
    expect(throttled.length).toBe(1);
  });

  it("连续限流指数退避（第二次等待翻倍）", async () => {
    const state = { failNext: true };
    const throttled: number[] = [];
    const sched = new Scheduler([rateLimitAdapter(state, [])], [], {
      maxParallelRuns: 1,
      rateLimitBackoffMs: 100,
      onThrottle: (ms) => throttled.push(ms),
    });

    await sched.runBatch([task("t1", "z1")], ".");
    await sched.runBatch([task("t2", "z2")], ".");
    await sched.runBatch([task("t3", "z3")], ".");
    // onThrottle 上报的是"实际剩余等待"（含进程间开销），用区间断言验证退避翻倍
    expect(throttled[0]!).toBeGreaterThanOrEqual(80);
    expect(throttled[0]!).toBeLessThanOrEqual(100);
    expect(throttled[1]!).toBeGreaterThanOrEqual(150);
    expect(throttled[1]!).toBeLessThanOrEqual(200);
    expect(throttled[1]!).toBeGreaterThan(throttled[0]!); // 第二次等待确实翻倍
  });
});

describe("Scheduler · 平台契约模板注入", () => {
  function capturingAdapter(captured: Array<{ taskId: string; description: string }>): AgentAdapter {
    return {
      meta: { id: "a1", name: "a1", kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        captured.push({ taskId: payload.taskId, description: payload.description });
        return { runId: payload.runId, agentId: "a1", taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed" as const, text: "ok", timestamp: Date.now() };
      },
      async abort() {},
    };
  }

  it("派发时强制注入契约模板（覆盖历史漂移维度）", async () => {
    const captured: Array<{ taskId: string; description: string }> = [];
    const sched = new Scheduler([capturingAdapter(captured)]);
    await sched.runBatch([task("t1", "src")], ".");
    const desc = captured[0]!.description;
    expect(desc).toContain("[平台契约条款]");
    expect(desc).toMatch(/退出码/);
    expect(desc).toMatch(/stdout 只输出结果/);
    expect(desc).toMatch(/不得照抄实现/);
    expect(desc).toMatch(/表头\/总数口径/);
  });

  it("已带标记的 description 不会被重复拼接（重修轮幂等）", async () => {
    const captured: Array<{ taskId: string; description: string }> = [];
    const t = task("t1", "src");
    t.description = "已有契约\n\n[平台契约条款]\n内容";
    const sched = new Scheduler([capturingAdapter(captured)]);
    await sched.runBatch([t], ".");
    const desc = captured[0]!.description;
    expect((desc.match(/\[平台契约条款\]/g) ?? []).length).toBe(1);
  });
});

describe("Scheduler · 事件流的终止判定", () => {
  /** 按给定事件序列回报的适配器（`adapterWith` 只能给"成功/失败"两段固定流）。 */
  function eventAdapter(id: string, events: Array<{ kind: string; text: string }>): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        for (const e of events) {
          yield { ...e, timestamp: Date.now() } as never;
        }
      },
      async abort() {},
    };
  }

  it("[383] failed 之后又来 completed 时仍算失败 —— 失败不能被后续事件洗白", async () => {
    // 第 383 行 `event.kind === "failed" || event.kind === "aborted"` 里的第一个 `===`。
    // 改成 `!==` 之后，`failed` 事件不再命中这一支：循环不 break，继续读到后面的
    // `completed` 并把 `terminalOk` 置真 —— **失败的任务被报成成功**，
    // 于是 verifier 放行、坏产物进入交付。既有用例的失败流里没有后续事件，
    // 两种写法都是 ok=false，所以看不出来。
    const sched = new Scheduler(
      [eventAdapter("a1", [{ kind: "failed", text: "boom" }, { kind: "completed", text: "done" }])],
      [],
    );
    const outcomes = await sched.runBatch([task("t1", "src/core")], ".");
    expect(outcomes[0]!.ok).toBe(false);
  });

  it("[383] 未知类型的事件不中断收集 —— 后面真正的 completed 不能被丢掉", async () => {
    // 同一行的第二个 `===`（`aborted`）。改成 `!==` 后，任何**不是** aborted 的
    // 事件（比如进度事件）都会命中这一支并 break —— 收集提前结束，
    // 后面那个 completed 读不到，`terminalOk` 停在 false → **成功的任务被报成失败**。
    const sched = new Scheduler(
      [
        eventAdapter("a1", [
          { kind: "progress", text: "50%" },
          { kind: "completed", text: "done" },
        ]),
      ],
      [],
    );
    const outcomes = await sched.runBatch([task("t1", "src/core")], ".");
    expect(outcomes[0]!.ok).toBe(true);
  });
});

describe("Scheduler · 探针缓存失效的粒度", () => {
  /** 记录 probe() 被真实调用了几次。 */
  function countingAdapter(id: string, counts: Record<string, number>): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        counts[id] = (counts[id] ?? 0) + 1;
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
  }

  it("[142] forgetProbe(id) 只失效那一个 agent，不能清掉整张缓存", () => {
    // 第 142 行 `if (agentId === undefined) this.probeCache.clear();`。
    // 把 `===` 改成 `!==` 之后**两个分支对调**：
    //   - 传了 id → 走 `clear()`，**整张缓存被清空**，所有 agent 都要重新探测；
    //   - 不传 id → 走 `delete(undefined)`，真正的"清全部"反而什么都不做。
    // 后者会让注销后的探针结果永远残留（探测到一个已下线的 agent）。
    //
    // 断言落在**可观测事实**上：另一个 agent 的 probe() 被真实调用的次数。
    return (async () => {
      const counts: Record<string, number> = {};
      const sched = new Scheduler([countingAdapter("a1", counts), countingAdapter("a2", counts)], []);
      await sched.runBatch([task("t1", "src/core")], ".");
      expect(counts).toEqual({ a1: 1, a2: 1 });

      sched.forgetProbe("a1");
      await sched.runBatch([task("t2", "src/core")], ".");

      // a1 必须被重新探测，a2 必须仍命中缓存
      expect(counts.a1).toBe(2);
      expect(counts.a2).toBe(1);

      // 不带参数时才是"清全部"
      sched.forgetProbe();
      await sched.runBatch([task("t3", "src/core")], ".");
      expect(counts.a1).toBe(3);
      expect(counts.a2).toBe(2);
    })();
  });
});
