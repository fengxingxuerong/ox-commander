import { describe, expect, it } from "vitest";
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
