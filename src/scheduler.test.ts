import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  admitConcurrency,
  compareVariantRank,
  digest,
  Scheduler,
  type DispatchOutcome,
  type VariantRateResult,
} from "../electron/engine/scheduler";
import type { VariantBackend, VariantWindow } from "../electron/engine/variant-store";
import type { BatchGuard } from "../electron/engine/batch-guard";
import { CancelledError } from "../electron/engine/orchestrator";
import { AgentRegistry } from "../electron/agents/registry";
import { createCapabilityRouter } from "../electron/engine/router";
import { CircuitBreaker } from "../electron/sandbox/circuit-breaker";
import { createAgentLayer, createDefaultAdapters } from "../electron/agents";
import { SensenovaApiAdapter } from "../electron/agents/sensenova-api";
import { EXECUTOR_TIMEOUT_MS } from "../shared/http-clients";
import type { AgentCapabilities, AgentManifest } from "../shared/agent-contract";
import type { AgentAdapter, RunHandle, Task, TaskPayload } from "../shared/types";

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

  /**
   * 登记表里留着**已注销适配器**的句柄（run 跑到一半被摘掉）时，必须跳过它、继续中止其余在跑的
   * run。把 `continue` 改成 `break`，取消会在第一处残留句柄上静默收工，后面的 run 照样跑满
   * 自己的时限 —— 而看板上已经写着"已取消"。
   *
   * 两点来之不易（上一版在这两处都是空的，本机 site 审计当时还报 15/15）：
   *   1. ghost 的句柄必须带**真的在池里**的 agentId，否则 `collectToTerminal` 里同一个
   *      findAdapter 找不到它就当场返回失败、释放槽位、把句柄摘掉 ⇒ 那一支根本不可达；
   *      "已从池里注销"改由 registry.activeAdapters() 在 abort 前一刻制造。
   *   2. 前置条件要"没满足就红"：waitLive 是轮询到点就放过的辅助函数，单靠它，
   *      构造没成立的用例照样会通过。
   * 判定方式：差分 —— 把生产那句改成 break，这条用例必须红。
   */
  it("残留句柄的适配器不在池里时，跳过它并继续中止其余在跑的 run", async () => {
    const log: string[] = [];
    let releaseGoodDispatch!: () => void;
    const goodDispatch = new Promise<void>((r) => (releaseGoodDispatch = r));
    let releaseGoodCollect!: () => void;
    const goodCollect = new Promise<void>((r) => (releaseGoodCollect = r));
    let releaseGhostCollect!: () => void;
    const ghostCollect = new Promise<void>((r) => (releaseGhostCollect = r));

    // ghost：dispatch 立刻返回，但句柄挂在一个不在池里的 agentId 上
    const ghost: AgentAdapter = {
      meta: { id: "ghost", name: "ghost", kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        log.push("dispatch:ghost");
        // agentId 必须是真的在池里的那个 id —— 否则 collectToTerminal 里的 findAdapter
        // 也找不到它，会当场返回失败并释放槽位，run 根本不会留在 liveRuns 里。
        // "已从池里注销"改由下面的 registry.activeAdapters() 在 abort 前一刻制造。
        return { runId: payload.runId, agentId: "ghost", taskId: payload.taskId };
      },
      async *collect() {
        await ghostCollect;
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {
        log.push("abort:ghost");
        releaseGhostCollect();
      },
    };
    // good 的 dispatch 等我们放行 —— 这样它必然登记在 ghost **之后**，顺序是断言的一部分
    const good: AgentAdapter = {
      meta: { id: "good", name: "good", kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        await goodDispatch;
        log.push("dispatch:good");
        return { runId: payload.runId, agentId: "good", taskId: payload.taskId };
      },
      async *collect() {
        await goodCollect;
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {
        log.push("abort:good");
        releaseGoodCollect();
      },
    };

    // pool() 在给了 registry 时读 activeAdapters() ⇒ 可以让 ghost 在派发那一刻在场、
    // 到 abort 前一刻才从池里消失，这才是"登记表里留着已注销适配器的句柄"的真实形状。
    let ghostInPool = true;
    const sched = new Scheduler([ghost, good], [], {
      registry: {
        activeAdapters: () => (ghostInPool ? [ghost, good] : [good]),
        // 预算闸（2026-10-11）会查 registry.get 拿 limits.maxTokens；这个最小假
        // registry 只关心 activeAdapters，get 返回 undefined = 无上限、全放行。
        get: () => undefined,
      },
    } as never);
    const batch = sched.runBatch([task("t1", "src/a"), task("t2", "src/b")], ".");
    for (let i = 0; i < 100 && !log.includes("dispatch:ghost"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    releaseGoodDispatch();
    await waitLive(sched, 2);
    // 前置条件必须"没满足就红"：waitLive 是轮询到点就放过的辅助函数，单靠它
    // 会让"构造根本没成立"的用例照样通过（这条用例上一版就是这样空的）。
    expect(log).toContain("dispatch:ghost");
    expect(sched.activeRuns()).toBe(2);
    ghostInPool = false; // ghost 的 run 还在飞，但它已经不在池里了

    expect(await sched.abortInFlight()).toBe(1);
    expect(log).toContain("abort:good");
    expect(log).not.toContain("abort:ghost"); // 它不在池里，abort 无从下达（只能等它自己的时限）

    releaseGhostCollect();
    await batch;
  });
});

describe("Scheduler.runBatch", () => {
  it("runs zone-disjoint tasks concurrently and collects outcomes", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    const outcomes = await sched.runBatch([task("t1", "src/a"), task("t2", "src/b")], ".");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("任务活性心跳：派发起点一次，之后每条事件续约（静默检测的数据源）", async () => {
    const beats: Array<{ taskId: string; at: number }> = [];
    const sched = new Scheduler([adapterWith("a1", true)], [], {
      onTaskActivity: (taskId, at) => beats.push({ taskId, at }),
    });
    await sched.runBatch([task("t1", "z")], ".");
    // 起点 1 + log 1 + completed 1：起点先于事件（UI 的静默时钟从派发起算）
    expect(beats).toHaveLength(3);
    expect(beats.every((b) => b.taskId === "t1")).toBe(true);
    expect(beats[1]!.at >= beats[0]!.at).toBe(true);
  });

  it("心跳回调缺席时零行为变化（不发也照常收集结果）", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0]!.ok).toBe(true);
  });

  it("throws on zone conflict inside one batch", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    await expect(
      sched.runBatch([task("t1", "same"), task("t2", "same")], "."),
    ).rejects.toThrow(/zone conflict/);
  });

  it("throws on overlapping zones, not just identical ones", async () => {
    // runBatch 是最后一道不变量断言：调用方（planBatches）现在按 zonesOverlap 分批，
    // 但如果有人手工塞进 `src` + `src/util`，这里必须拒绝，而不是让两个智能体
    // 同批写同一个目录 —— 越权检测对这种形状是瞎的。
    const sched = new Scheduler([adapterWith("a1", true)]);
    await expect(
      sched.runBatch([task("t1", "src"), task("t2", "src/util/deep")], "."),
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

  it("节流等待期间取消 → 立刻 CancelledError，不等满封顶（2026-10-13 活测修复）", async () => {
    // 活测实录：/cancel 在限流风暴里 7 分钟没落地 —— 规划期（brainCall）已修，
    // 这是执行期的同一处病：节流封顶 5min 的整段睡眠不听取消。
    const state = { failNext: true };
    const throttled: number[] = [];
    const sched = new Scheduler([rateLimitAdapter(state, [])], [], {
      maxParallelRuns: 1,
      rateLimitBackoffMs: 60_000, // 名义 60s
      onThrottle: (ms) => throttled.push(ms),
    });
    await sched.runBatch([task("t1", "z1")], "."); // 429 → 记账 60s 节流
    expect(throttled.length).toBe(0);
    sched.setShouldStop(() => true);
    const t0 = Date.now();
    await expect(sched.runBatch([task("t2", "z2")], ".")).rejects.toThrow(CancelledError);
    expect(Date.now() - t0).toBeLessThan(3_000); // 不是 60s
    expect(throttled.length).toBe(1); // onThrottle 照旧上报（可观测性不丢）
  }, 8_000);

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

describe("Scheduler · 项目约定注入（B3）", () => {
  function capturing(captured: Array<{ taskId: string; description: string }>): AgentAdapter {
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

  /** 造一个带约定文件的项目根；返回根目录与清理函数。 */
  function projectWith(files: Record<string, string>): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-conv-"));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), body, "utf8");
    }
    return {
      root,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    };
  }

  it("项目根的 OX.md 进每个任务的 description，且在契约块之前", async () => {
    const proj = projectWith({ "OX.md": "约定：所有文件用 CommonJS；禁止改 package.json。" });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      const desc = captured[0]!.description;
      expect(desc).toContain("禁止改 package.json");
      expect(desc).toContain("【项目约定（项目根的 OX.md / AGENTS.md）】");
      // 顺序即语义：背景（约定）先于合同（契约块）
      expect(desc.indexOf("【项目约定")).toBeGreaterThan(-1);
      expect(desc.indexOf("【项目约定")).toBeLessThan(desc.indexOf("[平台契约条款]"));
    } finally {
      proj.cleanup();
    }
  });

  it("OX.md 与 AGENTS.md 同时存在：两块都在，OX 在前", async () => {
    const proj = projectWith({
      "OX.md": "OX-约定-A",
      "AGENTS.md": "AGENTS-约定-B",
    });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      const desc = captured[0]!.description;
      expect(desc).toContain("### OX.md");
      expect(desc).toContain("### AGENTS.md");
      expect(desc.indexOf("OX-约定-A")).toBeLessThan(desc.indexOf("AGENTS-约定-B"));
    } finally {
      proj.cleanup();
    }
  });

  it("没有约定文件：description 不产空标题（缺席零副作用）", async () => {
    const proj = projectWith({});
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      const desc = captured[0]!.description;
      expect(desc).not.toContain("【项目约定");
      expect(desc).toContain("[平台契约条款]"); // 契约照旧
    } finally {
      proj.cleanup();
    }
  });

  it("三段顺序：描述 → 约定 → 契约 → 附言（附言永远最后）", async () => {
    const proj = projectWith({ "OX.md": "CONV-MARK" });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      const t = task("t1", "src");
      t.description = "BASE-MARK";
      t.operatorNote = "NOTE-MARK";
      await new Scheduler([capturing(captured)]).runBatch([t], proj.root);
      const desc = captured[0]!.description;
      const base = desc.indexOf("BASE-MARK");
      const conv = desc.indexOf("CONV-MARK");
      const contract = desc.indexOf("[平台契约条款]");
      const note = desc.indexOf("NOTE-MARK");
      expect(base).toBeGreaterThan(-1);
      expect(conv).toBeGreaterThan(base);
      expect(contract).toBeGreaterThan(conv);
      expect(note).toBeGreaterThan(contract);
    } finally {
      proj.cleanup();
    }
  });

  it("空/纯空白的约定文件不产块", async () => {
    const proj = projectWith({ "OX.md": "   \n\n  " });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      expect(captured[0]!.description).not.toContain("【项目约定");
    } finally {
      proj.cleanup();
    }
  });

  it("规划备忘 OX-PLAN.md 也进 description，且排在约定之后、契约之前", async () => {
    // 执行者只拿到任务书、看不到取舍时会按自己的理解重推一遍 —— 备忘进执行侧
    // 就是为了堵这一格；同时它必须是**背景**，不能挤到契约块下面去。
    const proj = projectWith({ "OX.md": "CONV-MARK", "OX-PLAN.md": "MEMO-MARK" });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      const desc = captured[0]!.description;
      expect(desc).toContain("MEMO-MARK");
      expect(desc).toContain("【规划备忘（项目根的 OX-PLAN.md）】");
      expect(desc.indexOf("CONV-MARK")).toBeLessThan(desc.indexOf("MEMO-MARK"));
      expect(desc.indexOf("MEMO-MARK")).toBeLessThan(desc.indexOf("[平台契约条款]"));
    } finally {
      proj.cleanup();
    }
  });

  it("只有备忘、没有约定文件：备忘照样进 description（两块各自独立）", async () => {
    const proj = projectWith({ "OX-PLAN.md": "MEMO-ONLY" });
    try {
      const captured: Array<{ taskId: string; description: string }> = [];
      await new Scheduler([capturing(captured)]).runBatch([task("t1", "src")], proj.root);
      const desc = captured[0]!.description;
      expect(desc).toContain("MEMO-ONLY");
      expect(desc).not.toContain("【项目约定");
    } finally {
      proj.cleanup();
    }
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

describe("Scheduler · 批内并发准入（maxConcurrency 是硬上限）", () => {
  function cap1(id: string, maxConcurrency: number, dispatched: string[]): AgentAdapter {
    const base = adapterWith(id, true, { dispatched });
    return Object.assign(base, {
      capabilities: () => ({
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files"],
        maxConcurrency,
        selfIsolated: false,
      }),
    }) as AgentAdapter;
  }

  function zTask(id: string, role = "backend-dev"): Task {
    return { id, title: id, description: "d", zone: `${id}-zone`, dependencies: [], suggestedRole: role };
  }

  it("同批第二个任务不再派给已满载的 agent，改派空闲者", async () => {
    // 2026-09-26 实弹演习实测的行为：maxConcurrency=1 的 loomy 同批接下
    // t1/t2 两单 —— t2 决策时 inflight 已是 1/1，却只被扣 10 分照样胜出。
    //
    // 构造要点：a1 带 priority=50（weight 1 → +50 分），保证 load 软惩罚（-10）
    // 不足以让 a2 反超 —— 否则用例在旧实现下就绿，钉不住硬拦语义
    //（这正是演习里 loomy 压过内置执行器的形态）。
    const dispatched: string[] = [];
    const a1 = cap1("a1", 1, dispatched);
    const a2 = cap1("a2", 1, dispatched);
    const registry = new AgentRegistry([
      { adapter: a1, manifest: { id: "a1", priority: 50 } },
      { adapter: a2 },
    ]);
    const sched = new Scheduler([a1, a2], [], { registry, router: createCapabilityRouter() });
    const outcomes = await sched.runBatch([zTask("t1"), zTask("t2")], ".");
    // 旧实现 t2 也会派给 a1（load 软惩罚拦不住）：["a1", "a1"]
    expect(dispatched).toEqual(["a1", "a2"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("唯一 agent 满载时第二个任务如实 no-agent，不硬派", async () => {
    // router 报"无人可派"后，planPool 的 round-robin 兜底（?? available[i % n]）
    // 会把任务硬塞回满载者 —— 并发准入闸必须连兜底路径一起把关。
    const dispatched: string[] = [];
    const a1 = cap1("a1", 1, dispatched);
    const registry = new AgentRegistry([{ adapter: a1 }]);
    const sched = new Scheduler([a1], [], { registry, router: createCapabilityRouter() });
    const outcomes = await sched.runBatch([zTask("t1"), zTask("t2")], ".");
    // 旧实现：["a1", "a1"]
    expect(dispatched).toEqual(["a1"]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[1]!.ok).toBe(false);
    expect(outcomes[1]!.errorClass).toBe("no-agent");
  });

  it("preferredAgentId 点名超过并发上限 → 超出部分 no-agent（点名不静默改派）", async () => {
    // 点名是显式意图：满了就是满了，静默改派别人违背点名语义；
    // 超出的任务走 no-agent，由修复轮在 agent 空闲后自然重试。
    const dispatched: string[] = [];
    const a1 = cap1("a1", 1, dispatched);
    const a2 = cap1("a2", 1, dispatched);
    const registry = new AgentRegistry([{ adapter: a1 }, { adapter: a2 }]);
    const sched = new Scheduler([a1, a2], [], { registry, router: createCapabilityRouter() });
    const outcomes = await sched.runBatch([zTask("t1"), zTask("t2")], ".", { preferredAgentId: "a1" });
    // 旧实现：["a1", "a1"]
    expect(dispatched).toEqual(["a1"]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[1]!.errorClass).toBe("no-agent");
  });

  it("legacy 池不受并发准入影响（v1 round-robin 原样）", async () => {
    const dispatched: string[] = [];
    const layer = createAgentLayer({
      adapters: [adapterWith("a1", true, { dispatched }), adapterWith("a2", true, { dispatched })],
    });
    const sched = new Scheduler(layer.adapters, [], layer.schedulerOptions);
    const outcomes = await sched.runBatch([zTask("t1"), zTask("t2"), zTask("t3")], ".");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
    expect(dispatched).toEqual(["a1", "a2", "a1"]);
  });

  it("满载兜底路径能命中 spare —— 改派给还有余量的声明 agent", async () => {
    // 这条钉住 admitConcurrency 的 spare 查找本体（@343 的「跳过 wanted 自己」）。
    // 改派场景平时在 router 评分层就被消化了（满载者不进 decision），spare 查找
    // 唯一的真实入口是 round-robin 兜底：candidates 为空（本用例用无人匹配的
    // role 构造）→ 兜底按 index 选中 a1 → a1 已满 → spare 查找把任务交给
    // 还有余量的 a2。
    const dispatched: string[] = [];
    const mk = (id: string, mc: number) =>
      Object.assign(adapterWith(id, true, { dispatched }), {
        capabilities: () => ({
          roles: ["backend-dev"],
          zoneGlobs: ["**"],
          supports: ["read", "edit", "create", "run-test"],
          artifactKinds: ["files"],
          maxConcurrency: mc,
          selfIsolated: false,
        }),
      }) as AgentAdapter;
    const a1 = mk("a1", 1);
    const a2 = mk("a2", 5);
    const registry = new AgentRegistry([{ adapter: a1 }, { adapter: a2 }]);
    const sched = new Scheduler([a1, a2], [], { registry, router: createCapabilityRouter() });
    // suggestedRole = "nobody"：两个声明 agent 都不匹配 → candidates 恒空 → 走兜底
    const nobody = (id: string): Task => ({
      id, title: id, description: "d", zone: `${id}-zone`, dependencies: [], suggestedRole: "nobody",
    });
    const outcomes = await sched.runBatch([nobody("t1"), nobody("t2"), nobody("t3")], ".");
    // t1 兜底 a1（放行）；t2 兜底 a2（放行）；t3 兜底 a1 已满 → spare 命中 a2
    expect(dispatched).toEqual(["a1", "a2", "a2"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
  });

  it("点名 legacy agent 不受并发闸限制（bypass，v1 语义）", async () => {
    // 直派路径的 registry 检查是 `d && !d.inferredLegacy` —— legacy 点名必须
    // 原样放行（v1 池没有并发概念），连续点名几次都照派。
    const dispatched: string[] = [];
    const v1 = adapterWith("v1", true, { dispatched });
    const registry = new AgentRegistry([{ adapter: v1 }]);
    const sched = new Scheduler([v1], [], { registry, router: createCapabilityRouter() });
    const outcomes = await sched.runBatch([zTask("t1"), zTask("t2")], ".", { preferredAgentId: "v1" });
    expect(dispatched).toEqual(["v1", "v1"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("满载改派时 legacy agent 恒可接（无并发概念的池子是兜底资源）", async () => {
    // admitConcurrency 满载改派循环的 legacy 分支：`!d || d.inferredLegacy →
    // return true`。此前只测过声明 agent 的余量分支 —— 「return true → false」
    // 变异存活（2026-09-29 touched 审计）。legacy 改派目标必须被接住。
    const dispatched: string[] = [];
    const declared = Object.assign(adapterWith("a1", true, { dispatched }), {
      capabilities: () => ({
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: false,
      }),
    }) as AgentAdapter;
    const legacy = adapterWith("v1", true, { dispatched });
    const registry = new AgentRegistry([{ adapter: declared }, { adapter: legacy }]);
    const sched = new Scheduler([declared, legacy], [], { registry, router: createCapabilityRouter() });
    // suggestedRole 无匹配 → candidates 空 → 兜底按 index 轮换：t1→a1、t2→v1
    // （legacy 恒可接）、t3→a1 已满 → **spare 查找**跳过 a1、命中 v1 —— 变异
    // 必须在 spare 分支上被杀（t2 走的是 wanted 直派路径，杀不到它）。
    const nobody = (id: string): Task => ({
      id, title: id, description: "d", zone: `${id}-zone`, dependencies: [], suggestedRole: "nobody",
    });
    const outcomes = await sched.runBatch([nobody("t1"), nobody("t2"), nobody("t3")], ".");
    expect(dispatched).toEqual(["a1", "v1", "v1"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, true]);
  });

  it("满载改派只考虑 registry 注册过的 agent（registry 是准入事实来源）", async () => {
    // admitConcurrency 的 spare 查找遍历的 available 池在更早的环节就来自
    // registry 注册列表 —— 未注册的 adapter 即使塞进构造列表也不会被改派
    // 选中，t2 如实 no-agent。这也说明 `!d` 半边是防御分支：正常路径下
    // available 里不存在 registry 缺席者。
    const dispatched: string[] = [];
    const declared = Object.assign(adapterWith("a1", true, { dispatched }), {
      capabilities: () => ({
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: false,
      }),
    }) as AgentAdapter;
    const ghost = adapterWith("ghost", true, { dispatched });
    const registry = new AgentRegistry([{ adapter: declared }]);
    const sched = new Scheduler([declared, ghost], [], { registry, router: createCapabilityRouter() });
    const nobody = (id: string): Task => ({
      id, title: id, description: "d", zone: `${id}-zone`, dependencies: [], suggestedRole: "nobody",
    });
    const outcomes = await sched.runBatch([nobody("t1"), nobody("t2")], ".");
    expect(dispatched).toEqual(["a1"]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
  });
});

// executorTimeoutMs 的四跳链路：协议 → settings → createAgentLayer → 适配器。
// 前三跳早有断言，**最后一跳没有出口可观测** —— 于是「宿主设了超时、适配器
// 仍在用内置默认 300s」这种断链，改坏了也不会有任何测试变红（2026-09-27
// 变异门禁实测：`!== undefined` 改成 `=== undefined` 全绿）。这两条断言把
// 最后一跳钉住：值要真的落到适配器的单次请求超时上，而不是停在装配层。
describe("Scheduler · 并发准入的改派分支（入参显式化后可直接喂）", () => {
  // 这两条钉住 admitConcurrency 的 spare 查找里 `!d || d.inferredLegacy` 这一支。
  // 端到端路径**构造不出**它的输入：registry.candidates 在评分层就把满载 agent
  // 滤掉了，router 于是永远不会把"满载的声明 agent"递到准入闸（实测：只要池里
  // 有 legacy，router 先选 legacy）。所以判定被提成模块级函数，测试直接喂
  // "上游失效"的组合 —— 这是让二次防线拿到证据的唯一办法。
  const declared = (id: string, mc: number) =>
    Object.assign(adapterWith(id, true), {
      capabilities: () => ({
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files"],
        maxConcurrency: mc,
        selfIsolated: false,
      }),
    }) as AgentAdapter;

  it("满载改派时 legacy agent 恒可接（无并发概念的池子是兜底资源）", () => {
    const a1 = declared("a1", 1);
    const legacy = adapterWith("v1", true);
    const registry = new AgentRegistry([{ adapter: a1 }, { adapter: legacy }]);
    // a1 已在飞 1 单且上限 1 → 满载；spare 查找必须接住 legacy。
    expect(admitConcurrency(a1, new Map([["a1", 1]]), [a1, legacy], registry)?.meta.id).toBe("v1");
  });

  it("满载改派时未注册者也接（`!d` 半边不是死代码）", () => {
    const a1 = declared("a1", 1);
    const ghost = adapterWith("ghost", true);
    const registry = new AgentRegistry([{ adapter: a1 }]);
    // registry 里没有 ghost：这一支是防御分支（正常情况下 available 来自注册
    // 列表），但它决定"未注册者会不会被静默跳过" —— 必须有一条断言守着。
    expect(admitConcurrency(a1, new Map([["a1", 1]]), [a1, ghost], registry)?.meta.id).toBe("ghost");
  });
});

describe("Scheduler · 任务级冗余赛马（raceRedundancy）", () => {
  // 赛马编排层的终局有三类：赢家交付 / 全员失败 / 池子不够退化为单派发。
  // 每一类都要走到，否则判定里的分支拿不到证据（2026-09-30 touched 审计：
  // 434/452/471/482/492/503 六处存活，全部因为没有任何用例开启赛马）。
  function racer(
    id: string,
    opts: {
      ok: boolean;
      dispatched?: string[];
      aborted?: string[];
      /** 终态前的闸门：不释放就一直在飞，只有 abort 能把它放下来。 */
      gate?: Promise<void>;
      /** 日志文本；空串用来验证失败摘要的"无日志"兜底。 */
      logText?: string;
      /** 失败终态的事件文本（与 logText 一起为空时，logDigest 才是空串）。 */
      failText?: string;
      /** abort 之后的收尾 collect 到什么终态（true = 完赛，false = 已中止）。 */
      tailOk?: boolean;
      /** abort 的副作用：真实适配器被中止后 collect 一定会结束，闸门要靠它放行。 */
      onAbort?: () => void;
    },
  ): AgentAdapter {
    let calls = 0;
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        opts.dispatched?.push(id);
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        calls += 1;
        yield { kind: "log", text: opts.logText ?? `working ${id}`, timestamp: Date.now() };
        if (calls === 1 && opts.gate) await opts.gate;
        yield {
          kind: opts.ok ? "completed" : calls === 1 ? "failed" : opts.tailOk ? "completed" : "aborted",
          text: opts.ok ? "done" : opts.failText ?? "exit 1",
          timestamp: Date.now(),
        };
      },
      async abort() {
        opts.aborted?.push(id);
        opts.onAbort?.();
      },
    };
  }

  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    return { promise, release };
  }

  it("两个执行器赛马：先到终态者赢，输家被中止", async () => {
    const dispatched: string[] = [];
    const aborted: string[] = [];
    const slow = deferred();
    const winner = racer("fast", { ok: true, dispatched });
    const loser = racer("slow", {
      ok: false,
      dispatched,
      aborted,
      gate: slow.promise,
      tailOk: false,
      onAbort: slow.release,
    });
    const sched = new Scheduler([winner, loser], [], { raceRedundancy: 2 });
    const outcome = (await sched.runBatch([task("t1", "z1")], "."))[0]!;
    expect(outcome.ok).toBe(true);
    expect(outcome.agentId).toBe("fast");
    expect(dispatched.slice().sort()).toEqual(["fast", "slow"]);
    expect(aborted).toEqual(["slow"]);
    expect(outcome.logDigest).toContain("[赛马] 成员：fast、slow");
    expect(outcome.logDigest).toContain("[赛马] 输家 slow: 已中止");
  });

  it("输家晚于赢家完赛时照实记为完赛（不是已中止）", async () => {
    const dispatched: string[] = [];
    const aborted: string[] = [];
    const slow = deferred();
    const winner = racer("fast", { ok: true, dispatched });
    const loser = racer("slow", {
      ok: false,
      dispatched,
      aborted,
      gate: slow.promise,
      tailOk: true,
      onAbort: slow.release,
    });
    const sched = new Scheduler([winner, loser], [], { raceRedundancy: 2 });
    const outcome = (await sched.runBatch([task("t1", "z1")], "."))[0]!;
    expect(outcome.ok).toBe(true);
    expect(outcome.logDigest).toContain("[赛马] 输家 slow: 完赛（晚于赢家）");
  });

  it("全员失败：汇总一份失败 outcome，无日志者写「无日志」", async () => {
    const dispatched: string[] = [];
    const a1 = racer("a1", { ok: false, dispatched, logText: "", failText: "" });
    const a2 = racer("a2", { ok: false, dispatched, logText: "", failText: "" });
    const sched = new Scheduler([a1, a2], [], { raceRedundancy: 2 });
    const outcome = (await sched.runBatch([task("t1", "z1")], "."))[0]!;
    expect(outcome.ok).toBe(false);
    expect(dispatched).toEqual(["a1", "a2"]);
    expect(outcome.logDigest).toContain("[赛马] 全部 2 个执行器失败：");
    expect(outcome.logDigest).toContain("a1: 无日志");
    expect(outcome.logDigest).toContain("a2: 无日志");
  });

  it("冗余度 > 1 但池里只有一个执行器 → 退化为单派发（不进赛马摘要）", async () => {
    const dispatched: string[] = [];
    const only = racer("solo", { ok: true, dispatched });
    const sched = new Scheduler([only], [], { raceRedundancy: 2 });
    const outcome = (await sched.runBatch([task("t1", "z1")], "."))[0]!;
    expect(outcome.ok).toBe(true);
    expect(dispatched).toEqual(["solo"]);
    // 单派发路径不组赛马组：摘要里不该出现赛马头（否则就是被当成赛马组处理了）
    expect(outcome.logDigest).not.toContain("[赛马]");
  });
});

describe("compareVariantRank（裁决排序的纯函数面）", () => {
  const r = (passed: number, total: number, firstFailIndex: number | null = null): VariantRateResult => ({
    passed,
    total,
    firstFailIndex,
    summary: `${passed}/${total}`,
  });

  it("通过门数多者优 → 首败更晚者优（全过最晚）→ 变体序小者优", () => {
    // 门数优先：3/3 胜过 1/3，哪怕前者变体序更大
    expect(compareVariantRank({ rate: r(3, 3), variantIndex: 1 }, { rate: r(1, 3, 0), variantIndex: 0 })).toBeLessThan(0);
    // 同门数、首败更晚者优
    expect(compareVariantRank({ rate: r(1, 3, 1), variantIndex: 0 }, { rate: r(1, 3, 0), variantIndex: 1 })).toBeLessThan(0);
    // 全过（firstFail = null 按最后一门之后计）比"首败在最后一门"更深
    expect(compareVariantRank({ rate: r(3, 3, null), variantIndex: 1 }, { rate: r(2, 3, 2), variantIndex: 0 })).toBeLessThan(0);
    // 完全平手：变体序小者优（确定性）
    expect(compareVariantRank({ rate: r(2, 3), variantIndex: 0 }, { rate: r(2, 3), variantIndex: 1 })).toBeLessThan(0);
  });
});

describe("Scheduler · 变体竞争（variantCount）", () => {
  const rate = (passed: number, total: number, firstFailIndex: number | null = null): VariantRateResult => ({
    passed,
    total,
    firstFailIndex,
    summary: `门 ${passed}/${total}`,
  });

  /**
   * 内存替身：窗口动作全部只记账。`caps` 按捕获顺序给每个变体配置
   * "现场"（默认 1 个变更文件、可回放）；`fails.revertCalls` 里的第 N 次
   * revert（1-based 调用序，跨变体统一计数）先记账后抛错 —— 用来钉住
   * "收不回的窗口把备份留在盘上"这条退路。
   */
  function fakeBackend(
    caps: Array<{ replayable?: boolean; note?: string; files?: number }> = [],
    log: string[] = [],
    fails: { revertCalls?: readonly number[] } = {},
  ): { backend: VariantBackend; log: string[] } {
    const idxByWin = new Map<string, number>();
    let captured = 0;
    let began = 0;
    let reverts = 0;
    const backend: VariantBackend = {
      async beginWindow(opts) {
        // 窗口序号在开窗时就登记：派发直接抛错的路径不会经过 capture，
        // 但那一个窗口的 revert/finish 一样要能被记名。
        idxByWin.set(opts.runId, began);
        began += 1;
        log.push(`begin:${opts.zone}`);
        return {
          id: opts.runId,
          rootAbs: opts.root,
          zone: opts.zone,
          token: {},
          journal: {},
        } as unknown as VariantWindow;
      },
      capture(win, meta) {
        captured += 1;
        idxByWin.set(win.id, meta.variantIndex);
        const c = caps[captured - 1] ?? {};
        log.push(`capture:${meta.variantIndex}`);
        return {
          variantIndex: meta.variantIndex,
          agentId: meta.agentId,
          changes: Array.from({ length: c.files ?? 1 }, (_, i) => ({
            path: `z/f${i}.js`,
            op: "modify" as const,
          })),
          forward: new Map(),
          replayable: c.replayable ?? true,
          ...(c.note !== undefined ? { note: c.note } : {}),
        };
      },
      async revert(win) {
        reverts += 1;
        log.push(`revert:${idxByWin.get(win.id)}`);
        if (fails.revertCalls?.includes(reverts)) throw new Error(`revert boom #${reverts}`);
      },
      apply(_win, capture) {
        log.push(`apply:${capture.variantIndex}`);
      },
      async finish(win) {
        log.push(`finish:${idxByWin.get(win.id)}`);
      },
    };
    return { backend, log };
  }

  /** 第 `call` 次派发抛 CancelledError 的适配器（其余行为与 adapterWith 一致）。 */
  function adapterCancellingOn(
    id: string,
    call: number,
    opts?: { dispatched?: string[] },
  ): AgentAdapter {
    let n = 0;
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        n += 1;
        opts?.dispatched?.push(id);
        if (n === call) throw new CancelledError();
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
  }

  it("顺序就地双派 + 批末回放裁决：评级高者赢（不看派发序），赢家回放、输家回退", async () => {
    const dispatched: string[] = [];
    const calls: string[] = [];
    const starts: string[] = [];
    const completes: DispatchOutcome[] = [];
    const { backend, log } = fakeBackend();
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    // 池里有第三个候选，但 variantCount=2：成员补齐必须在第二个就停住
    // （`>=` 的边界位点：换成 `>` 会把 a3 也拉进组，变成三变体竞争）。
    const a3 = adapterWith("a3", true, { dispatched });
    const sched = new Scheduler([a1, a2, a3], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex, agentId) => {
        calls.push(`rate:${variantIndex}:${agentId}`);
        // 让后派发的变体赢 —— 排序必须是"评级说话"，不是"派发序说话"
        return variantIndex === 1 ? rate(3, 3) : rate(1, 3, 0);
      },
      onRunStart: (agentId, t) => starts.push(`${agentId}:${t.id}`),
      onRunComplete: (o) => completes.push(o),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");

    expect(dispatched).toEqual(["a1", "a2"]);
    expect(calls).toEqual(["rate:0:a1", "rate:1:a2"]);
    // 组级通知只有一份（start 计划归首选，end 记实际赢家）
    expect(starts).toEqual(["a1:t1"]);
    expect(completes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("a2");
    expect(completes[0]!.agentId).toBe("a2");
    expect(outcomes[0]!.logDigest).toContain("[变体] 共 2 个变体");
    expect(outcomes[0]!.logDigest).toContain("#1 a2 派发成功 · 门 3/3");
    // 行级钉住两个标记的归属：互为镜像的变异会把「赢家 / 已回退」整体对调、
    // 或把「首败」印到全过的行上 —— 全局 contains 断言对这两种都视而不见。
    const lines = outcomes[0]!.logDigest.split("\n");
    const winnerLine = lines.find((l) => l.startsWith("[变体] #1"))!;
    const loserLine = lines.find((l) => l.startsWith("[变体] #0"))!;
    expect(winnerLine).toContain("← 赢家（已回放）");
    expect(loserLine).toContain("（已回退）");
    expect(winnerLine).not.toContain("首败");
    expect(loserLine).toContain("（首败第 1 门）");
    // 评级各回放一次，赢家最后再回放一次；两个窗口都收尾
    expect(log.filter((x) => x.startsWith("apply"))).toEqual(["apply:0", "apply:1", "apply:1"]);
    expect(log.filter((x) => x.startsWith("finish"))).toEqual(["finish:0", "finish:1"]);
  });

  it("全员平手 → 变体序小者赢（确定性裁决）", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend();
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(2, 2),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(outcomes[0]!.agentId).toBe("a1");
    expect(log.filter((x) => x.startsWith("apply"))).toEqual(["apply:0", "apply:1", "apply:0"]);
  });

  it("评级抛错 = 没资格当赢家（排最后），但不改写派发本身的成败", async () => {
    const dispatched: string[] = [];
    const { backend } = fakeBackend();
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex) => {
        if (variantIndex === 0) throw new Error("boom");
        return rate(0, 4, 0);
      },
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(outcomes[0]!.agentId).toBe("a2");
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.logDigest).toContain("门 -1/0");
    expect(outcomes[0]!.logDigest).toContain("评级失败：boom");
  });

  it("前向镜像失败：中止后续变体、保留现场（不评级/不回放/不改片），digest 说破", async () => {
    const dispatched: string[] = [];
    const calls: string[] = [];
    const { backend, log } = fakeBackend([{ replayable: false, note: "z/f.js（EACCES）" }]);
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex) => {
        calls.push(`rate:${variantIndex}`);
        return rate(1, 1);
      },
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");

    expect(dispatched).toEqual(["a1"]); // 第二个变体没有被派
    expect(calls).toEqual([]); // 不评级
    // 现场保留：不复位、不回放、也不丢弃备份目录（人工能救）
    expect(log).toEqual(["begin:z1", "capture:0"]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("a1");
    expect(outcomes[0]!.logDigest).toContain("前向镜像失败");
    expect(outcomes[0]!.logDigest).toContain("保留现场");
    expect(outcomes[0]!.logDigest).toContain("EACCES");
  });

  it("镜像失败发生在第二个变体：前一个窗口照常收尾，失败窗口留备份", async () => {
    const dispatched: string[] = [];
    const completes: DispatchOutcome[] = [];
    const { backend, log } = fakeBackend([{}, { replayable: false, note: "z/f.js（EACCES）" }]);
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
      onRunComplete: (o) => completes.push(o),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");

    expect(dispatched).toEqual(["a1", "a2"]);
    expect(completes).toHaveLength(1);
    expect(outcomes[0]!.agentId).toBe("a2");
    expect(outcomes[0]!.logDigest).toContain("第 2/2 个变体前向镜像失败");
    // v0 已复位 ⇒ 收尾丢备份；v1 是"现场保留"窗口 ⇒ 跳过收尾（备份留盘）
    expect(log).toEqual(["begin:z1", "capture:0", "revert:0", "begin:z1", "capture:1", "finish:0"]);
  });

  it("镜像失败不带 note：digest 说「原因未知」，不把 undefined 带出去", async () => {
    const dispatched: string[] = [];
    const { backend } = fakeBackend([{ replayable: false }]);
    const sched = new Scheduler([adapterWith("a1", true, { dispatched })], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(outcomes[0]!.logDigest).toContain("原因未知");
    expect(outcomes[0]!.logDigest).not.toContain("undefined");
  });

  it("note 为空串时原样留空（`??` 不是 `||`：空串是有效取值，不该被替换）", async () => {
    const dispatched: string[] = [];
    const { backend } = fakeBackend([{ replayable: false, note: "" }]);
    const sched = new Scheduler([adapterWith("a1", true, { dispatched })], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(outcomes[0]!.logDigest).toContain("不裁决）：\n");
    expect(outcomes[0]!.logDigest).not.toContain("原因未知");
  });

  it("派发中叫停（第一个变体）：在途窗口收回派发前后收尾，只此一个窗口", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend();
    const a1 = adapterCancellingOn("a1", 1, { dispatched });
    const sched = new Scheduler([a1], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    await expect(sched.runBatch([task("t1", "z1")], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(dispatched).toEqual(["a1"]);
    // 复位成功 ⇒ 窗口按"已复位"收尾（丢备份）；还没开过第二个窗口
    expect(log).toEqual(["begin:z1", "revert:0", "finish:0"]);
  });

  it("派发中叫停（第二个变体）：在飞窗口复位后收尾，已复位窗口一起收尾", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend();
    const a1 = adapterCancellingOn("a1", 2, { dispatched });
    const sched = new Scheduler([a1], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    await expect(sched.runBatch([task("t1", "z1")], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(dispatched).toEqual(["a1", "a1"]);
    expect(log).toEqual([
      "begin:z1",
      "capture:0",
      "revert:0",
      "begin:z1",
      "revert:1",
      "finish:0",
      "finish:1",
    ]);
  });

  it("派发失败且窗口复位也失败：备份留盘（不 finish），原样上抛", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend([], [], { revertCalls: [1] });
    const a1 = adapterCancellingOn("a1", 1, { dispatched });
    const sched = new Scheduler([a1], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    await expect(sched.runBatch([task("t1", "z1")], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(log).toEqual(["begin:z1", "revert:0"]);
    // 收不回 ⇒ 不丢备份目录：现场比干净重要
    expect(log.filter((x) => x.startsWith("finish"))).toEqual([]);
  });

  it("裁决期首槽位回退失败：失败窗口留备份，其余照常收尾后再上抛", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend([], [], { revertCalls: [3, 4] });
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => rate(1, 1),
    });
    await expect(sched.runBatch([task("t1", "z1")], ".")).rejects.toThrow(/revert boom/);
    // 回放已经发生（apply:0），但两次复位都失败 ⇒ 只有 v1 被收尾丢备份
    expect(log.filter((x) => x.startsWith("apply"))).toEqual(["apply:0"]);
    expect(log.filter((x) => x.startsWith("finish"))).toEqual(["finish:1"]);
  });

  it("池里只有一个执行器：退回同一执行器补齐（同一适配器派两次）", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend();
    const only = adapterWith("solo", true, { dispatched });
    const sched = new Scheduler([only], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex) => (variantIndex === 0 ? rate(0, 2, 1) : rate(2, 2)),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(dispatched).toEqual(["solo", "solo"]);
    expect(outcomes[0]!.agentId).toBe("solo");
    expect(outcomes[0]!.logDigest).toContain("#1 solo 派发成功 · 门 2/2");
    expect(log.filter((x) => x.startsWith("apply"))).toEqual(["apply:0", "apply:1", "apply:1"]);
  });

  it("两变体都派发失败：赢家仍是评级更优者，ok 照实为 false", async () => {
    const dispatched: string[] = [];
    const { backend } = fakeBackend();
    const a1 = adapterWith("a1", false, { dispatched });
    const a2 = adapterWith("a2", false, { dispatched });
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex) => (variantIndex === 0 ? rate(1, 3, 1) : rate(0, 3, 0)),
    });
    const outcomes = await sched.runBatch([task("t1", "z1")], ".");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.agentId).toBe("a1");
    expect(outcomes[0]!.logDigest).toContain("派发失败 · 门 1/3");
    // 两条都带首败读数（都是非 null 的格子）：三元被换向时这里会集体消失
    const lines = outcomes[0]!.logDigest.split("\n");
    expect(lines.find((l) => l.startsWith("[变体] #0"))).toContain("门 1/3（首败第 2 门）");
    expect(lines.find((l) => l.startsWith("[变体] #1"))).toContain("门 0/3（首败第 1 门）");
  });

  it("三件套缺一（开关 / 后端 / 评级）都退回单派发路径", async () => {
    const cases: Array<Record<string, unknown>> = [
      { variantCount: 1, hasStore: true, hasRater: true },
      { variantCount: 2, hasStore: true, hasRater: false },
      { variantCount: 2, hasStore: false, hasRater: true },
    ];
    for (const c of cases) {
      const dispatched: string[] = [];
      const { backend, log } = fakeBackend();
      const a1 = adapterWith("a1", true, { dispatched });
      const sched = new Scheduler([a1], [], {
        variantCount: c.variantCount as number,
        ...(c.hasStore ? { variantStore: backend } : {}),
        ...(c.hasRater ? { rateVariant: async () => rate(1, 1) } : {}),
      });
      const outcomes = await sched.runBatch([task("t1", "z1")], ".");
      expect(dispatched, JSON.stringify(c)).toEqual(["a1"]);
      expect(log, JSON.stringify(c)).toEqual([]);
      expect(outcomes[0]!.logDigest, JSON.stringify(c)).not.toContain("[变体]");
    }
  });

  it("裁决先于 guard.settle：批次仲裁看到的是赢家落盘后的状态", async () => {
    const dispatched: string[] = [];
    const seq: string[] = [];
    const { backend } = fakeBackend([], seq);
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    const guard = {
      async begin() {
        return "scope";
      },
      async settle(_scope: unknown, outcomes: DispatchOutcome[]) {
        seq.push("settle");
        return { outcomes, conflicts: [], remedies: [] };
      },
    };
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async (_task, variantIndex) => (variantIndex === 1 ? rate(2, 2) : rate(0, 2, 0)),
      guard: guard as unknown as BatchGuard,
    });
    await sched.runBatch([task("t1", "z1")], ".");
    expect(seq[seq.length - 1]).toBe("settle");
    expect(seq.filter((x) => x.startsWith("apply"))).toEqual(["apply:0", "apply:1", "apply:1"]);
  });

  it("裁决中叫停：CancelledError 上抛，窗口全部收尾，赢家不回放", async () => {
    const dispatched: string[] = [];
    const { backend, log } = fakeBackend();
    const a1 = adapterWith("a1", true, { dispatched });
    const a2 = adapterWith("a2", true, { dispatched });
    let stop = false;
    const sched = new Scheduler([a1, a2], [], {
      variantCount: 2,
      variantStore: backend,
      rateVariant: async () => {
        stop = true; // 第一个变体评级后叫停：下一轮迭代开头的检查点命中
        return rate(1, 3, 0);
      },
    });
    sched.setShouldStop(() => stop);
    await expect(sched.runBatch([task("t1", "z1")], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(dispatched).toEqual(["a1", "a2"]);
    // 只有 v0 的评级回放发生过，赢家回放一次都没有；两个窗口都已收尾
    expect(log.filter((x) => x.startsWith("apply"))).toEqual(["apply:0"]);
    expect(log.filter((x) => x.startsWith("finish"))).toEqual(["finish:0", "finish:1"]);
  });
});

describe('executorTimeoutMs 的最后一跳', () => {
  it('createAgentLayer 传入时，内置执行器真的用它做单次请求超时', () => {
    const layer = createAgentLayer({ executorTimeoutMs: 4321 });
    const builtin = layer.adapters[0] as SensenovaApiAdapter;
    expect(builtin).toBeInstanceOf(SensenovaApiAdapter);
    expect(builtin.requestTimeoutMs).toBe(4321);
  });

  it('省略时回落到内置默认（不是 0 / undefined）', () => {
    const [a] = createDefaultAdapters();
    expect((a as SensenovaApiAdapter).requestTimeoutMs).toBe(EXECUTOR_TIMEOUT_MS);
    const [b] = createDefaultAdapters(undefined, 1234);
    expect((b as SensenovaApiAdapter).requestTimeoutMs).toBe(1234);
  });

  /**
   * 路径面（P2-2）：第三个参数是 `forbiddenWrite`，它的**存在性**是承重的。
   *
   * `PathPolicy` 的 `forbiddenWrite` 是**替换**语义 —— 传空数组等于"已提供"，
   * 会把内置地板（`package.json` / `.env` / `.git/**` …）整块清空。
   * 所以"没配策略"必须表现为**键不存在**，而不是键存在但值为空。
   *
   * 位点 `!== undefined` 与条件展开的三元同时被这两条断言钉住：
   * 改成 `=== undefined` 会让"没配"变成"传空数组"（地板被拆）；
   * 分支互换则让"配了"变成不传（策略失效）。
   */
  it('路径面：不传 forbiddenWrite 时字段不存在（省略 = 内置默认）', () => {
    const [a] = createDefaultAdapters();
    expect((a as unknown as { forbiddenWrite?: readonly string[] }).forbiddenWrite).toBeUndefined();
    // 显式传 undefined 与不传同义（TS 的可选参数）
    const [b] = createDefaultAdapters(undefined, undefined, undefined);
    expect((b as unknown as { forbiddenWrite?: readonly string[] }).forbiddenWrite).toBeUndefined();
  });

  it('路径面：传了 forbiddenWrite 时原样落到适配器（策略真的生效）', () => {
    const list = ['package.json', 'secrets/**'];
    const [a] = createDefaultAdapters(undefined, undefined, list);
    expect((a as unknown as { forbiddenWrite?: readonly string[] }).forbiddenWrite).toEqual(list);
  });
});

// createAgentLayer 的两个装配分支此前没有任何用例：声明来源标记与 manifestDir 加载。
// 三元算子一开就露出来了 —— 两处都是「改反了照样跑，只是声明悄悄失效」。
describe('createAgentLayer · 声明来源与目录加载', () => {
  function codexManifest(extra: Partial<AgentManifest> = {}): AgentManifest {
    return {
      id: 'codex-cli',
      displayName: 'Codex CLI',
      adapter: 'cli',
      entry: { kind: 'cli', command: 'codex', argsTemplate: ['exec'] },
      capabilities: {
        roles: ['backend-dev'],
        zoneGlobs: ['src/**'],
        supports: ['read', 'edit'],
        artifactKinds: ['files'],
        maxConcurrency: 1,
        selfIsolated: true,
      },
      ...extra,
    };
  }

  it('带 source 的声明原样保留，只有缺 source 的才标成 declared', () => {
    const layer = createAgentLayer({
      manifests: [
        codexManifest({ source: 'agents.d' }),
        codexManifest({ id: 'second-cli', entry: { kind: 'cli', command: 'second', argsTemplate: [] } }),
      ],
    });
    expect(layer.registry.get('codex-cli')?.manifest.source).toBe('agents.d');
    expect(layer.registry.get('second-cli')?.manifest.source).toBe('declared');
  });

  it('manifestDir 指到的目录真的被加载（不是拿到空集）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agentsd-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex-cli.json'), JSON.stringify(codexManifest()), 'utf8');
      const layer = createAgentLayer({ manifestDir: dir });
      expect(layer.registry.get('codex-cli')).toBeDefined();
      expect(layer.manifestErrors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// 赛马补充维度（e52de2a 主测试之外）：onRunStart 组级只发一次、breaker 记账
// （赢家 true / 终态失败者 false / 被中止的输家不记）、redundancy=1 单派发
// 保真、快者失败时继续等下一个成功者。
// ---------------------------------------------------------------------------
describe("Scheduler · 赛马补充维度（组级 onRunStart / breaker 记账）", () => {
  /** 可控行为 adapter：delayMs 后出终态；abort 让 collect 立即出 aborted。 */
  function raceAdapter(
    id: string,
    opts: { ok: boolean; delayMs: number; dispatched?: string[]; aborts?: string[] },
  ): AgentAdapter {
    const runs = new Map<string, { aborted: boolean }>();
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload: TaskPayload) {
        opts.dispatched?.push(id);
        const runId = `${id}-${payload.runId}`;
        runs.set(runId, { aborted: false });
        return { runId, agentId: id, taskId: payload.taskId } as RunHandle;
      },
      async *collect(handle: RunHandle) {
        const run = runs.get(handle.runId);
        const step = 10;
        let waited = 0;
        while (waited < opts.delayMs) {
          if (run?.aborted) {
            yield { kind: "aborted", text: "已中止", timestamp: Date.now() };
            return;
          }
          await new Promise((r) => setTimeout(r, step));
          waited += step;
        }
        if (opts.ok) yield { kind: "completed", text: "done", timestamp: Date.now() };
        else yield { kind: "failed", text: "exit code 1", timestamp: Date.now() };
      },
      async abort(handle: RunHandle) {
        opts.aborts?.push(handle.agentId);
        const run = runs.get(handle.runId);
        if (run) run.aborted = true;
      },
    } as unknown as AgentAdapter;
  }

  it("第一个到终态成功者赢，慢者被 abort，输家的 aborted 不进任务账", async () => {
    const dispatched: string[] = [];
    const aborts: string[] = [];
    const quick = raceAdapter("quick", { ok: true, delayMs: 20, dispatched, aborts });
    const slow = raceAdapter("slow", { ok: true, delayMs: 400, dispatched, aborts });
    const registry = new AgentRegistry([{ adapter: quick }, { adapter: slow }]);
    const completes: Array<{ agent: string | undefined; ok: boolean }> = [];
    const sched = new Scheduler([quick, slow], [], {
      registry,
      raceRedundancy: 2,
      onRunComplete: (o) => completes.push({ agent: o.agentId, ok: o.ok }),
    });
    const outcomes = await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(dispatched.sort()).toEqual(["quick", "slow"]);
    // 赢家是 quick；slow 被 abort。
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("quick");
    expect(aborts).toEqual(["slow"]);
    // 输家静默：onRunComplete 只有赢家一条。
    expect(completes).toEqual([{ agent: "quick", ok: true }]);
    // 全组归因在赢家 digest 里。
    expect(outcomes[0]!.logDigest).toContain("[赛马]");
    expect(outcomes[0]!.logDigest).toContain("slow");
  });

  it("快者失败时继续等下一个成功者；失败成员照记 breaker，赢家记 true", async () => {
    const records: Array<{ id: string; ok: boolean }> = [];
    const failing = raceAdapter("failing", { ok: false, delayMs: 20 });
    const winning = raceAdapter("winning", { ok: true, delayMs: 80 });
    const registry = new AgentRegistry([{ adapter: failing }, { adapter: winning }]);
    const sched = new Scheduler([failing, winning], [], {
      registry,
      raceRedundancy: 2,
      breaker: {
        allow: () => true,
        record: (id: string, ok: boolean) => records.push({ id, ok }),
      } as never,
    });
    const outcomes = await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("winning");
    expect(records).toContainEqual({ id: "failing", ok: false });
    expect(records).toContainEqual({ id: "winning", ok: true });
  });

  it("全员失败 → 汇总失败 outcome 进重修（只发一条 onRunComplete）", async () => {
    const a = raceAdapter("a", { ok: false, delayMs: 10 });
    const b = raceAdapter("b", { ok: false, delayMs: 40 });
    const registry = new AgentRegistry([{ adapter: a }, { adapter: b }]);
    const completes: boolean[] = [];
    const sched = new Scheduler([a, b], [], {
      registry,
      raceRedundancy: 2,
      onRunComplete: (o) => completes.push(o.ok),
    });
    const outcomes = await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.logDigest).toContain("全部 2 个执行器失败");
    expect(outcomes[0]!.logDigest).toContain("a");
    expect(outcomes[0]!.logDigest).toContain("b");
    expect(completes).toEqual([false]);
  });

  it("redundancy = 1（默认）保持单派发：无赛马标记", async () => {
    const solo = raceAdapter("solo", { ok: true, delayMs: 10 });
    const registry = new AgentRegistry([{ adapter: solo }]);
    const sched = new Scheduler([solo], [], { registry });
    const outcomes = await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("solo");
    expect(outcomes[0]!.logDigest).not.toContain("[赛马]");
  });

  it("冗余度超过池子大小时按池子大小截断", async () => {
    const dispatched: string[] = [];
    const a = raceAdapter("a", { ok: true, delayMs: 10, dispatched });
    const b = raceAdapter("b", { ok: true, delayMs: 200, dispatched });
    const registry = new AgentRegistry([{ adapter: a }, { adapter: b }]);
    const sched = new Scheduler([a, b], [], { registry, raceRedundancy: 5 });
    await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(dispatched.sort()).toEqual(["a", "b"]);
  });

  it("onRunStart 组级只发一次（planned 归因）", async () => {
    const starts: string[] = [];
    const a = raceAdapter("a", { ok: true, delayMs: 30 });
    const b = raceAdapter("b", { ok: false, delayMs: 300 });
    const registry = new AgentRegistry([{ adapter: a }, { adapter: b }]);
    const sched = new Scheduler([a, b], [], {
      registry,
      raceRedundancy: 2,
      onRunStart: (agentId) => starts.push(agentId),
    });
    await sched.runBatch([task("t1", "t1-zone")], ".");
    expect(starts.length).toBe(1);
  });
});

/**
 * 循环输出检测 + per-agent 预算闸（2026-10-11 竞品刷新：
 * agentguard-llm 的 loop 检测、paperclip 的 per-agent budget + throttling）。
 */
describe("Scheduler 循环输出检测", () => {
  const LOOP_LINE = "npm ERR! code ERESOLVE unable to resolve dependency tree — retrying install";

  function streamingAdapter(id: string, lines: string[], hooks?: { aborts?: string[] }): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        for (const text of lines) yield { kind: "log", text, timestamp: Date.now() };
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {
        hooks?.aborts?.push(id);
      },
    };
  }

  const repeat = (n: number) => Array.from({ length: n }, () => LOOP_LINE);

  it("连续相同长行到达阈值：中止本 run，digest 带 [loop]，归因为 loop", async () => {
    const aborts: string[] = [];
    const a = streamingAdapter("a", [...repeat(3), "never reached"], { aborts });
    const sched = new Scheduler([a], [], { loopDetection: { threshold: 3, minLineLength: 16 } });
    const outcomes = await sched.runBatch([task("t1", "src/a")], ".");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.logDigest).toContain("[loop]");
    expect(outcomes[0]!.logDigest).toContain(LOOP_LINE.slice(0, 40));
    expect(outcomes[0]!.errorClass).toBe("loop");
    expect(aborts).toEqual(["a"]);
  });

  it("输出在推进（行不相同）不触发；loopDetection: false 显式关闭", async () => {
    const aborts: string[] = [];
    const lines = [1, 2, 3].map((n) => `${LOOP_LINE} (${n})`);
    const a = streamingAdapter("a", lines, { aborts });
    const sched = new Scheduler([a], [], { loopDetection: { threshold: 3, minLineLength: 16 } });
    const outcomes = await sched.runBatch([task("t1", "src/a")], ".");
    expect(outcomes[0]!.ok).toBe(true);
    expect(aborts).toEqual([]);

    const b = streamingAdapter("b", repeat(9), { aborts });
    const off = new Scheduler([b], [], { loopDetection: false });
    const offOutcomes = await off.runBatch([task("t2", "src/a")], ".");
    expect(offOutcomes[0]!.ok).toBe(true);
    expect(aborts).toEqual([]);
  });
});

describe("Scheduler per-agent 预算闸", () => {
  function usageAdapter(id: string, tokens: number, dispatched?: string[]): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        dispatched?.push(id);
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "log", text: `working on ${id}`, timestamp: Date.now() };
        yield {
          kind: "completed",
          text: "done",
          timestamp: Date.now(),
          ...(tokens > 0 ? { usage: { tokens } } : {}),
        };
      },
      async abort() {},
    };
  }

  const capped = (adapter: AgentAdapter, maxTokens: number) => ({
    adapter,
    manifest: { id: adapter.meta.id, limits: { maxTokens } },
  });

  it("上报用量到达 maxTokens 后，同 run 后续批次改派他人", async () => {
    const dispatched: string[] = [];
    const a1 = usageAdapter("a1", 100, dispatched);
    const a2 = usageAdapter("a2", 0, dispatched);
    const registry = new AgentRegistry([capped(a1, 100), { adapter: a2, manifest: { id: "a2" } }]);
    const sched = new Scheduler([a1, a2], [], { registry });
    await sched.runBatch([task("t1", "src/a")], ".");
    await sched.runBatch([task("t2", "src/a")], ".");
    expect(dispatched).toEqual(["a1", "a2"]);
  });

  it("池内候选全部超预算：no-agent 且 digest 写明预算闸归因", async () => {
    const a1 = usageAdapter("a1", 100);
    const registry = new AgentRegistry([capped(a1, 100)]);
    const sched = new Scheduler([a1], [], { registry });
    await sched.runBatch([task("t1", "src/a")], ".");
    const outcomes = await sched.runBatch([task("t2", "src/a")], ".");
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.errorClass).toBe("no-agent");
    expect(outcomes[0]!.logDigest).toContain("预算闸跳过");
    expect(outcomes[0]!.logDigest).toContain("a1");
  });

  it("点名路径不受预算闸约束——与熔断同语义：显式意图优先", async () => {
    const a1 = usageAdapter("a1", 100);
    const registry = new AgentRegistry([capped(a1, 100)]);
    const sched = new Scheduler([a1], [], { registry });
    await sched.runBatch([task("t1", "src/a")], ".");
    const outcomes = await sched.runBatch([task("t2", "src/a")], ".", { preferredAgentId: "a1" });
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.agentId).toBe("a1");
  });

  it("onBudgetGate 在跳过时触发，带 agentId、已用量与上限", async () => {
    const gates: Array<[string, number, number]> = [];
    const a1 = usageAdapter("a1", 100);
    const a2 = usageAdapter("a2", 0);
    const registry = new AgentRegistry([capped(a1, 100), { adapter: a2, manifest: { id: "a2" } }]);
    const sched = new Scheduler([a1, a2], [], {
      registry,
      onBudgetGate: (id, used, cap) => gates.push([id, used, cap]),
    });
    await sched.runBatch([task("t1", "src/a")], ".");
    await sched.runBatch([task("t2", "src/a")], ".");
    expect(gates).toEqual([["a1", 100, 100]]);
  });
});

/**
 * 预算闸兜底候选的两道闸缺一不可（杀 site 审计存活位点）：
 * 兜底搜索既要「未超预算」也要「熔断可接」—— 少判任何一个，
 * 被跳过的执行器都会换个名字混回来。
 */
describe("Scheduler 预算闸的兜底候选判定", () => {
  function usageAdapter(id: string, tokens: number): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield {
          kind: "completed",
          text: "done",
          timestamp: Date.now(),
          ...(tokens > 0 ? { usage: { tokens } } : {}),
        };
      },
      async abort() {},
    };
  }

  it("另一个候选也超预算时，不能拿它凑数——选真正未超的第三个", async () => {
    const a1 = usageAdapter("a1", 100);
    const a2 = usageAdapter("a2", 100);
    const a3 = usageAdapter("a3", 0);
    const registry = new AgentRegistry([
      { adapter: a1, manifest: { id: "a1", limits: { maxTokens: 100 } } },
      { adapter: a2, manifest: { id: "a2", limits: { maxTokens: 100 } } },
      { adapter: a3, manifest: { id: "a3" } },
    ]);
    const sched = new Scheduler([a1, a2, a3], [], { registry });
    // 第一批两个任务把 a1、a2 都喂到上限（轮询：t1→a1、t1b→a2）
    await sched.runBatch([task("t1", "src/a"), task("t1b", "src/b")], ".");
    const outcomes = await sched.runBatch([task("t2", "src/a")], ".");
    expect(outcomes[0]!.agentId).toBe("a3");
  });

  it("未超预算但熔断打开的候选也不能接——兜底要同时过熔断闸", async () => {
    const a1 = usageAdapter("a1", 100);
    const a2 = usageAdapter("a2", 0);
    const a3 = usageAdapter("a3", 0);
    const registry = new AgentRegistry([
      { adapter: a1, manifest: { id: "a1", limits: { maxTokens: 100 } } },
      { adapter: a2, manifest: { id: "a2" } },
      { adapter: a3, manifest: { id: "a3" } },
    ]);
    const breaker = new CircuitBreaker();
    // open a2 的熔断：连续 3 次失败
    for (let i = 0; i < 3; i += 1) breaker.record("a2", false);
    const sched = new Scheduler([a1, a2, a3], [], { registry, breaker });
    await sched.runBatch([task("t1", "src/a")], ".");
    const outcomes = await sched.runBatch([task("t2", "src/a")], ".");
    expect(outcomes[0]!.agentId).toBe("a3");
  });
});

/**
 * breakerStatsFile 装配（2026-10-11，成功率跨 run 持久化）：给了路径就接
 * CircuitPersistence——record 落盘、重建即恢复先验。三元反转的 mutant 表现为
 * 「给了路径不落盘」，这里用真文件钉住。
 */
describe('createAgentLayer · breakerStatsFile', () => {
  it('record 即写回总账文件；同一文件重建 layer 即恢复先验', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agent-stats-'));
    const file = path.join(dir, 'agent-stats.json');
    const layer = createAgentLayer({ breakerStatsFile: file });
    layer.breaker.record('a1', false);
    layer.breaker.record('a1', true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      a1: { successes: 1, failures: 1 },
    });

    const rebuilt = createAgentLayer({ breakerStatsFile: file });
    expect(rebuilt.breaker.stats('a1').failures).toBe(1);
    expect(rebuilt.breaker.stats('a1').successRate).toBeCloseTo(0.5);
    // 新进程一律 closed 起步：恢复的是先验，不是上一 run 的熔断状态
    expect(rebuilt.breaker.state('a1')).toBe('closed');
  });

  it('不给路径 = 纯内存（不落盘）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agent-stats-'));
    const layer = createAgentLayer();
    layer.breaker.record('a1', true);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

/**
 * 执行期 liveness（2026-10-13）：引擎的中止闸经 `setAbortSignal` 进调度器，
 * 随**每一条** TaskPayload 下发给适配器。
 *
 * 它与既有的 `setShouldStop` 是两条互补的路，缺一不可：
 * - `shouldStop` 是**轮询**，只在检查点被问到，已派发的 run 不会回头再问；
 * - `abortSignal` 是**中断**，run 从诞生那刻起就挂在闸上。
 *
 * 少掉下发这一步，`cancel()` 里那一次性的 `abortInFlight()` 就是唯一收口手段 ——
 * 实测一次 /cancel 要等满 run 时限（默认 600s）才落地。
 */
describe("Scheduler · 中止闸下发（执行期 liveness）", () => {
  /** 记录自己收到的载荷，跑完一条任务即可。 */
  function capturingAdapter(seen: TaskPayload[], id = "a1"): AgentAdapter {
    return {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        seen.push(payload);
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect(handle) {
        yield { kind: "log", text: `working on ${handle.taskId}`, timestamp: Date.now() };
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
  }

  it("挂了闸 ⇒ 每条派发的载荷都带着它", async () => {
    const seen: TaskPayload[] = [];
    const sched = new Scheduler([capturingAdapter(seen)]);
    const ctl = new AbortController();
    sched.setAbortSignal(ctl.signal);

    await sched.runBatch([task("t1", "src/a")], ".");

    expect(seen).toHaveLength(1);
    // 必须是同一个对象：适配器把它并进 fetch 的 signal，换了引用就掐不断在途请求
    expect(seen[0]!.signal).toBe(ctl.signal);
  });

  it("没挂闸 ⇒ 载荷不带 signal（直接 new Scheduler 的旧调用方不受影响）", async () => {
    const seen: TaskPayload[] = [];
    const sched = new Scheduler([capturingAdapter(seen)]);

    await sched.runBatch([task("t1", "src/a")], ".");

    expect(seen).toHaveLength(1);
    // 载荷里留着 signal 这个键没关系，值必须是 undefined —— 适配器据此决定是否并入
    expect(seen[0]!.signal).toBeUndefined();
  });

  it("赛马组：每个成员各自拿到同一个闸（赢家确定时才能掐掉还在飞的输家）", async () => {
    const seen: TaskPayload[] = [];
    const sched = new Scheduler([capturingAdapter(seen, "a1"), capturingAdapter(seen, "a2")], [], {
      raceRedundancy: 2,
    });
    const ctl = new AbortController();
    sched.setAbortSignal(ctl.signal);

    await sched.runBatch([task("t1", "src/a")], ".");

    expect(seen).toHaveLength(2);
    expect(seen.every((p) => p.signal === ctl.signal)).toBe(true);
  });
});

describe("Scheduler · 操作者附言注入（C2）", () => {
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

  it("附言拼进 description，且恒在契约条款块下方（不得覆盖硬规则）", async () => {
    const captured: Array<{ taskId: string; description: string }> = [];
    const t = task("t1", "src");
    t.operatorNote = "口径：CSV 无表头";
    await new Scheduler([capturingAdapter(captured)]).runBatch([t], ".");
    const desc = captured[0]!.description;
    expect(desc).toContain("[操作者附言]");
    expect(desc).toContain("口径：CSV 无表头");
    // 顺序即语义：契约块在上、附言在下，附言块自己也声明不覆盖契约
    expect(desc.indexOf("[平台契约条款]")).toBeLessThan(desc.indexOf("[操作者附言]"));
    expect(desc).toContain("不得覆盖上方平台契约条款");
  });

  it("没有附言不产块（一个字的改动不该出现）", async () => {
    const captured: Array<{ taskId: string; description: string }> = [];
    await new Scheduler([capturingAdapter(captured)]).runBatch([task("t1", "src")], ".");
    expect(captured[0]!.description).not.toContain("[操作者附言]");
  });
});
