import { describe, expect, it } from "vitest";
import { AllRoutesCoolingError } from "../shared/http-clients";
import { OrchestratorEngine, type OrchestratorDeps } from "../electron/engine/orchestrator";
import type { Scheduler } from "../electron/engine/scheduler";
import type { LlmClient } from "../shared/llm-client";
import { DEFAULT_SETTINGS, type Task, type VerificationReport } from "../shared/types";

const TASKS: Task[] = [
  {
    id: "t1",
    title: "core",
    description: "",
    zone: "src/core",
    dependencies: [],
    suggestedRole: "backend-dev",
  },
];

function fakeScheduler(failFirstRound: boolean): Scheduler {
  let round = 0;
  return {
    async runBatch(tasks: Task[]) {
      round += 1;
      return tasks.map((t: Task) => ({
        taskId: t.id,
        ok: !(failFirstRound && round === 1),
        logDigest: "log",
        events: [],
      }));
    },
  } as unknown as Scheduler;
}

function fakeLlm(): LlmClient {
  return { async chat() { throw new Error("not used in execute tests"); } };
}

function makeReport(passed: boolean): VerificationReport {
  return {
    passed,
    results: [{ kind: "build", ok: passed, exitCode: passed ? 0 : 1, logDigest: "err", durationMs: 10 }],
  };
}

function engine(opts: {
  failFirstRound: boolean;
  maxRounds?: number;
  events: string[];
}): OrchestratorEngine {
  const deps: OrchestratorDeps = {
    llm: fakeLlm(),
    scheduler: fakeScheduler(opts.failFirstRound),
    verify: async () => makeReport(!opts.failFirstRound || undefined as never),
    settings: { ...DEFAULT_SETTINGS, maxRepairRounds: opts.maxRounds ?? 3 },
  };
  // verify passes when scheduler's first round succeeded; else fails until repair.
  let verified = false;
  deps.verify = async () => {
    if (!opts.failFirstRound) return makeReport(true);
    if (verified) return makeReport(true);
    verified = true;
    return makeReport(false);
  };
  return new OrchestratorEngine(deps, {
    onStage: (s) => opts.events.push(`stage:${s}`),
    onLog: (l) => opts.events.push(`log:${l}`),
    onTaskStatus: (id, st) => opts.events.push(`task:${id}:${st}`),
    onVerification: () => opts.events.push("verify"),
    onEscalation: (_id, s) => opts.events.push(`escalation:${s.slice(0, 20)}`),
  });
}

describe("OrchestratorEngine.execute", () => {
  it("happy path passes verification and reaches DONE", async () => {
    const events: string[] = [];
    const eng = engine({ failFirstRound: false, events });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events).toContain("stage:DONE");
  });

  it("escalates instead of delivering when all tasks fail", async () => {
    const events: string[] = [];
    const alwaysFail = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: alwaysFail,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: (_id, s) => events.push(`escalation:${s.slice(0, 20)}`),
    });
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);
    expect(events).not.toContain("stage:DONE");
    expect(events.some((e) => e.startsWith("escalation:"))).toBe(true);
  });

  it("repair loop retries failed tasks then passes", async () => {
    const events: string[] = [];
    const eng = engine({ failFirstRound: true, maxRounds: 3, events });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events.some((e) => e.includes("重修第 1"))).toBe(true);
    expect(events.filter((e) => e.startsWith("task:t1:running"))).toHaveLength(2);
  });

  it("keeps earlier batch failures visible when later batches succeed", async () => {
    const events: string[] = [];
    const t2: Task = { ...TASKS[0]!, id: "t2", zone: "src/other" };
    let call = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        call += 1;
        // Batch 1 (t1) fails; batch 2 (t2) succeeds.
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: call !== 1,
          logDigest: "boom",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: () => events.push("escalation"),
    });
    await expect(eng.execute([TASKS, [t2]], ".")).rejects.toThrow(/repair rounds/);
  });

  it("re-runs all tasks when verification fails with no failed dev task (external breakage)", async () => {
    const events: string[] = [];
    let verifyOk = false;
    let batchCalls = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        batchCalls += 1;
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "ok", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => {
        if (batchCalls >= 2) verifyOk = true;
        return makeReport(verifyOk);
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 2 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: () => events.push("escalation"),
    });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events).toContain("stage:DONE");
    expect(events.some((e) => e.includes("全员重跑"))).toBe(true);
    expect(batchCalls).toBe(2);
  });

  it("emits onTaskOutcome with the failure digest for failed runs", async () => {
    const outcomes: Array<{ taskId: string; ok: boolean; logDigest: string }> = [];
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: t.id !== "t1",
          logDigest: t.id === "t1" ? "TypeError: cannot read property" : "ok",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(false),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onTaskOutcome: (taskId, ok, logDigest) => outcomes.push({ taskId, ok, logDigest }),
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);
    expect(outcomes).toContainEqual({
      taskId: "t1",
      ok: false,
      logDigest: "TypeError: cannot read property",
    });
  });

  it("escalates only the tasks that failed, never the succeeded ones", async () => {
    const escalatedIds: string[] = [];
    const t2: Task = { ...TASKS[0]!, id: "t2", zone: "src/other" };
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: t.id === "t1",
          logDigest: "ok",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(false),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: (id) => escalatedIds.push(id),
    });
    await expect(eng.execute([[TASKS[0]!, t2]], ".")).rejects.toThrow(/repair rounds/);
    expect(escalatedIds).toEqual(["t2"]);
  });

  it("carries earlier batch failure logs into the next round's repair context", async () => {
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    const t2: Task = { ...TASKS[0]!, id: "t2", zone: "src/other" };
    let call = 0;
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { round: number; errorLogDigest: string }> },
      ) {
        call += 1;
        if (opts?.repairOf) repairPayloads.push(opts.repairOf);
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: call === 1 ? false : true,
          logDigest: `boom-${t.id}`,
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(false),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS, [t2]], ".")).rejects.toThrow(/repair rounds/);
    // Round 0: batch 1 (t1) fails with "boom-t1", batch 2 (t2) succeeds.
    // Round 1: only t1 is pending; its repair context must still carry
    // "boom-t1" even though a later batch ran in between (regression: the old
    // per-batch overwrite lost batch-1 failure logs).
    const repairRound = repairPayloads.at(-1)!;
    expect(repairRound.get("t1")?.errorLogDigest).toContain("boom-t1");
    expect(repairRound.has("t2")).toBe(false);
  });

  it("routes verification errors to the task owning the failing file's zone", async () => {
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    const tCalc: Task = { ...TASKS[0]!, id: "tc", zone: "src/calc" };
    const tApi: Task = { ...TASKS[0]!, id: "ta", zone: "src/api" };
    let call = 0;
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { round: number; errorLogDigest: string }> },
      ) {
        call += 1;
        if (opts?.repairOf) repairPayloads.push(opts.repairOf);
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: call === 1 ? false : true,
          logDigest: "dev failed",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const failingReport: VerificationReport = {
      passed: false,
      results: [
        {
          kind: "test",
          ok: false,
          exitCode: 1,
          logDigest: "TypeError: boom\n    at fn (src/calc/math.js:3:1)",
          durationMs: 1,
        },
      ],
    };
    let verifyCalls = 0;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => {
        verifyCalls += 1;
        return verifyCalls === 1 ? failingReport : makeReport(true);
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    const report = await eng.execute([[tCalc, tApi]], ".");
    expect(report.passed).toBe(true);
    // Round 1 repair context: tc gets the routed digest, ta does not.
    const repairRound = repairPayloads.at(-1)!;
    expect(repairRound.get("tc")?.errorLogDigest).toContain("src/calc/math.js");
    expect(repairRound.get("ta")?.errorLogDigest).not.toContain("src/calc/math.js");
  });

  it("lets the user skip an exhausted task and still deliver", async () => {
    const events: string[] = [];
    const decisions = new Map<string, "skip" | "redispatch" | "abort">([["t1", "skip"]]);
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: () => undefined,
      requestEscalationDecision: async (taskId) => decisions.get(taskId) ?? "abort",
    });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events).toContain("stage:DONE");
    expect(events.some((e) => e.includes("跳过任务"))).toBe(true);
  });

  it("throws when the user chooses abort on an escalated task", async () => {
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
      requestEscalationDecision: async () => "abort",
    });
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/用户终止/);
  });

  it("grants an extra repair round when the user chooses redispatch", async () => {
    const events: string[] = [];
    let round = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        round += 1;
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: round >= 2,
          logDigest: round >= 2 ? "ok" : "boom",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(round >= 2),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
      requestEscalationDecision: async () => "redispatch",
    });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events).toContain("stage:DONE");
    expect(events.some((e) => e.includes("追加一轮"))).toBe(true);
  });
});

describe("OrchestratorEngine brain cooldown handling", () => {
  const PRD_JSON = JSON.stringify({ goal: "g", features: [], techStack: [], acceptanceCriteria: [] });

  function brainEngine(llm: LlmClient, events: string[]): OrchestratorEngine {
    const deps: OrchestratorDeps = {
      llm,
      scheduler: fakeScheduler(false),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    return new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
  }

  it("generatePrd waits out an all-cooling spell and retries instead of failing", async () => {
    const events: string[] = [];
    let calls = 0;
    const llm: LlmClient = {
      async chat() {
        calls++;
        if (calls === 1) throw new AllRoutesCoolingError(20);
        return { content: PRD_JSON, provider: "t", model: "m" };
      },
    };
    const prd = await brainEngine(llm, events).generatePrd("demo");
    expect(prd.goal).toBe("g");
    expect(calls).toBe(2);
    expect(events.some((e) => e.includes("冷却中") && e.includes("PRD 生成"))).toBe(true);
  });

  it("generatePrd gives up after exhausting cooldown waits", async () => {
    const events: string[] = [];
    const llm: LlmClient = {
      async chat() {
        throw new AllRoutesCoolingError(10);
      },
    };
    await expect(brainEngine(llm, events).generatePrd("demo")).rejects.toBeInstanceOf(
      AllRoutesCoolingError,
    );
    // 2 waits granted by default → 3 calls in total
    expect(events.filter((e) => e.includes("冷却中")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("OrchestratorEngine.execute · 依赖失败跳过下游（配额守卫）", () => {
  function twoBatchTasks(): Task[][] {
    const A: Task = { ...TASKS[0], id: "A", dependencies: [] };
    const B: Task = { ...TASKS[0], id: "B", dependencies: ["A"] };
    return [[A], [B]];
  }

  function recordingScheduler(okIds: Set<string>, dispatched: string[]): Scheduler {
    return {
      async runBatch(tasks: Task[]) {
        for (const t of tasks) dispatched.push(t.id);
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: okIds.has(t.id),
          logDigest: "log",
          events: [],
        }));
      },
    } as unknown as Scheduler;
  }

  function silentEngine(deps: OrchestratorDeps): OrchestratorEngine {
    return new OrchestratorEngine(deps, {
      onStage: () => {},
      onLog: () => {},
      onTaskStatus: () => {},
      onVerification: () => {},
      onEscalation: () => {},
    });
  }

  it("上游失败时下游被跳过，不烧配额", async () => {
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(), dispatched), // A 永远失败
      verify: async () => makeReport(false),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    await expect(silentEngine(deps).execute(twoBatchTasks(), ".")).rejects.toThrow(
      /verification still failing/,
    );
    // A 被派发（并重试预算耗尽），B 从未被派发 —— 省下注定失败的调用
    expect(dispatched).toEqual(["A"]);
  });

  it("上游重修成功后，下游在后续轮次自动解锁", async () => {
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      // A 第 2 次派发起成功（模拟重修轮修复），B 一旦派发即成功
      scheduler: {
        async runBatch(tasks: Task[]) {
          for (const t of tasks) dispatched.push(t.id);
          return tasks.map((t: Task) => ({
            taskId: t.id,
            ok: t.id === "A" ? dispatched.filter((d) => d === "A").length >= 2 : true,
            logDigest: "log",
            events: [],
          }));
        },
      } as unknown as Scheduler,
      verify: async () => makeReport(dispatched.includes("B")),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 2 },
    };
    const report = await silentEngine(deps).execute(twoBatchTasks(), ".");
    expect(report.passed).toBe(true);
    // 第 0 轮 A 失败且 B 被跳过；第 1 轮 A 重派成功后 B 才解锁派发（且仅派发一次）
    expect(dispatched).toEqual(["A", "A", "B"]);
    expect(dispatched.filter((d) => d === "B").length).toBe(1);
    expect(dispatched.indexOf("B")).toBeGreaterThan(dispatched.lastIndexOf("A"));
  });

  it("对照组：上游成功时下游当轮正常派发", async () => {
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["A", "B"]), dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const report = await silentEngine(deps).execute(twoBatchTasks(), ".");
    expect(report.passed).toBe(true);
    expect(dispatched).toEqual(["A", "B"]);
  });
});
