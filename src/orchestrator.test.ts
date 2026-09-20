import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllRoutesCoolingError } from "../shared/http-clients";
import {
  CancelledError,
  OrchestratorEngine,
  type OrchestratorDeps,
  type RunSnapshot,
} from "../electron/engine/orchestrator";
import type { Scheduler } from "../electron/engine/scheduler";
import type { LlmClient } from "../shared/llm-client";
import { DEFAULT_SETTINGS, type SmokeCheck, type Task, type VerificationReport } from "../shared/types";

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

describe("OrchestratorEngine · 断点续跑 journal", () => {
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

  it("关键点保存快照（计划 + 每批次），最终快照含全部完成状态", async () => {
    const snapshots: RunSnapshot[] = [];
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["A", "B"]), dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
      journal: { save: (s) => snapshots.push(s) },
    };
    const report = await silentEngine(deps).execute(twoBatchTasks(), ".");
    expect(report.passed).toBe(true);
    // 计划快照 + 批次1 + 批次2 = 至少 3 个快照
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(snapshots[0]!.batches.length).toBe(2); // 计划快照携带完整计划（免重规划）
    const last = snapshots[snapshots.length - 1]!;
    expect(last.allDone).toEqual(["A", "B"]);
    expect(last.attempts).toEqual({ A: 1, B: 1 });
  });

  it("resume 恢复快照：已完成任务不再派发，直接续接后续批次", async () => {
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["B"]), dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const report = await silentEngine(deps).execute(twoBatchTasks(), ".", {
      resume: { allDone: ["A"], skipped: [], attempts: { A: 1 }, round: 1, extraRounds: 0, lastDigest: "" },
    });
    expect(report.passed).toBe(true);
    expect(dispatched).toEqual(["B"]); // A 已完成 → 不重派，直接续接 B
  });

  it("resume 轮 outcomes 为空时不误触全员重跑（保护恢复的 allDone）", async () => {
    const dispatched: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["A"]), dispatched), // A ok=true（若被误重派也能跑通）
      verify: async () => makeReport(false), // 永远失败
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 2 },
      journal: { save: () => undefined },
    };
    // resume：round=1、allDone 含 A → 每个批次都无待派任务 → outcomes 恒为空
    // 修复前：空 outcomes 触发"全员重跑"清掉恢复的 allDone → A 被误重派
    // 修复后：guard 保护恢复的 allDone → A 从不重派，直至预算耗尽抛出
    await expect(
      silentEngine(deps).execute([[{ ...TASKS[0], id: "A", dependencies: [] }]], ".", {
        resume: { allDone: ["A"], skipped: [], attempts: { A: 1 }, round: 1, extraRounds: 0, lastDigest: "" },
      }),
    ).rejects.toThrow(/verification still failing/);
    expect(dispatched).toEqual([]); // A 从未被重派
  });
});

describe("OrchestratorEngine · 独立样本冒烟（防自证盲区）", () => {
  let root = "";

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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-smoke-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows 文件句柄竞态，尽力清理
    }
  });

  function smokeEngine(
    okIds: Set<string>,
    dispatched: string[],
    events: string[],
  ): OrchestratorEngine {
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(okIds, dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    return new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => {},
      onVerification: (r) => events.push(`verify:${r.passed}`),
      onEscalation: () => {},
    });
  }

  it("冒烟通过 → 报告含 smoke 结果，正常交付", async () => {
    fs.writeFileSync(path.join(root, "sample-smoke.js"), "console.log('col0: type=string');");
    const smoke: SmokeCheck[] = [
      { title: "CLI 冒烟", command: process.execPath, args: ["sample-smoke.js"], expectContains: ["col0: type=string"] },
    ];
    const dispatched: string[] = [];
    const events: string[] = [];
    const report = await smokeEngine(new Set(["A", "B"]), dispatched, events).execute(
      twoBatchTasks(),
      root,
      { smoke },
    );
    expect(report.passed).toBe(true);
    expect(report.results.some((r) => r.kind === "smoke" && r.ok)).toBe(true);
    expect(events.some((l) => l.includes("独立样本冒烟"))).toBe(true);
  });

  it("冒烟失败 → 拦截交付进重修 → 修复后交付", async () => {
    const script = path.join(root, "sample-smoke.js");
    fs.writeFileSync(script, "console.log(process.env.SMOKE_FIX === '1' ? 'EXPECTED-OUTPUT' : 'nope');");
    const smoke: SmokeCheck[] = [
      { title: "CLI 冒烟", command: process.execPath, args: ["sample-smoke.js"], expectContains: ["EXPECTED-OUTPUT"] },
    ];
    const dispatched: string[] = [];
    const events: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["A", "B"]), dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    // 重修轮把样例脚本修好（模拟任务修复），冒烟二轮通过 → 才允许交付
    process.env.SMOKE_FIX = "";
    const engine = new OrchestratorEngine(deps, {
      onStage: () => {},
      onLog: (l) => {
        events.push(l);
        if (l.includes("重修第 1/1 轮")) process.env.SMOKE_FIX = "1";
      },
      onTaskStatus: () => {},
      onVerification: (r) => events.push("verify:" + r.passed),
      onEscalation: () => {},
    });
    const report = await engine.execute(twoBatchTasks(), root, { smoke });
    delete process.env.SMOKE_FIX;
    expect(events.filter((l) => l === "verify:false").length).toBe(1); // 首轮被冒烟拦截
    expect(report.passed).toBe(true);                                  // 修复后交付
    // 最终报告只携带末轮验证结果：冒烟修复后 ok=true（首轮的失败在 events 里）
    const sr = report.results.filter((r) => r.kind === "smoke");
    expect(sr.length).toBe(1);
    expect(sr[0]!.ok).toBe(true);
  });

  it("开发任务失败时不运行冒烟（先修任务，省配额）", async () => {
    const smoke: SmokeCheck[] = [
      { title: "CLI 冒烟", command: process.execPath, args: ["sample-smoke.js"], expectContains: ["x"] },
    ];
    const dispatched: string[] = [];
    const events: string[] = [];
    // A/B 永远失败（okIds 空）→ 重修预算耗尽抛出，冒烟全程未运行
    await expect(
      smokeEngine(new Set(), dispatched, events).execute(twoBatchTasks(), root, {
        smoke,
        resume: { allDone: ["A"], skipped: [], attempts: { A: 1 }, round: 1, extraRounds: 0, lastDigest: "" },
      }),
    ).rejects.toThrow(/verification still failing/);
    // resume 恢复 allDone=["A"] → 批次 1 的 A 被跳过；maxRounds=1 → 一轮后预算耗尽
    expect(dispatched).toEqual(["B"]);
    expect(events.some((l) => l.includes("独立样本冒烟"))).toBe(false);
  });
});

/**
 * Cancel is an operator action, not an agent failure. A task interrupted
 * mid-batch would otherwise keep the `running` status forever, so the board
 * shows a spinner that never resolves and the operator cannot tell whether the
 * stop actually took effect.
 */
describe("OrchestratorEngine · 取消时给在飞任务补终态", () => {
  it("emits cancelled for tasks left running, and propagates the cancel", async () => {
    const statuses: string[] = [];
    let eng!: OrchestratorEngine;
    const scheduler = {
      async runBatch() {
        // Cancel while the batch is in flight, then fail the way a real
        // scheduler does once the underlying dispatch is aborted.
        eng.cancel();
        throw new CancelledError();
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: (id, st) => statuses.push(`${id}:${st}`),
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(statuses).toContain("t1:running");
    expect(statuses.at(-1)).toBe("t1:cancelled");
  });

  it("does not mark a task cancelled once it already reached a terminal state", async () => {
    const statuses: string[] = [];
    let eng!: OrchestratorEngine;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "log", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      // The cancel lands after the batch succeeded — the task is already `done`
      // and must stay that way.
      verify: async () => {
        eng.cancel();
        throw new CancelledError();
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: (id, st) => statuses.push(`${id}:${st}`),
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS], ".")).rejects.toBeInstanceOf(CancelledError);
    expect(statuses).toContain("t1:done");
    expect(statuses).not.toContain("t1:cancelled");
  });
});

/**
 * decompose() is the last point where the PRD's declared files and the plan's
 * zones are both in hand. A plan whose zones cannot reach a declared file is
 * unexecutable — verified by a real run where zones `tests/unit` +
 * `tests/runner` could never produce `tests/greet.test.js`, so every write was
 * reverted and the repair loop spun until its budget ran out reporting the
 * wrong cause.
 */
describe("OrchestratorEngine.decompose · 【规划校验】zone 覆盖", () => {
  function planEngine(plan: unknown, logs: string[]): OrchestratorEngine {
    const llm = {
      async chat() {
        return { content: JSON.stringify(plan), provider: "fake", model: "fake" };
      },
    } as unknown as LlmClient;
    return new OrchestratorEngine(
      { llm, scheduler: fakeScheduler(false), verify: async () => makeReport(true), settings: DEFAULT_SETTINGS },
      {
        onStage: () => undefined,
        onLog: (l) => logs.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
  }

  const prd = {
    goal: "Build a tool",
    features: ["Implement src/app/greet.js exporting greet(name)"],
    techStack: ["Node"],
    acceptanceCriteria: [
      "src/app/greet.js exists",
      "tests/greet.test.js contains at least 2 cases",
    ],
  } as const;

  const taskOf = (id: string, zone: string) => ({
    id,
    title: id,
    description: "do it",
    zone,
    dependencies: [],
    suggestedRole: "backend-dev",
  });

  it("rejects a plan whose zones orphan a PRD-declared file", async () => {
    const logs: string[] = [];
    const eng = planEngine(
      { tasks: [taskOf("t1", "src/app"), taskOf("t5", "tests/unit")], smoke: [] },
      logs,
    );
    await expect(eng.decompose(prd as never)).rejects.toThrow(/不属于任何 zone/);
    // The operator must see why, in the run log, not just as a thrown error.
    expect(logs.some((l) => l.includes("[规划校验]"))).toBe(true);
    expect(logs.some((l) => l.includes("tests/greet.test.js"))).toBe(true);
  });

  it("accepts the same plan once the zone is the parent directory", async () => {
    const logs: string[] = [];
    const eng = planEngine({ tasks: [taskOf("t1", "src/app"), taskOf("t5", "tests")], smoke: [] }, logs);
    const out = await eng.decompose(prd as never);
    expect(out.batches.flat().map((t: Task) => t.id).sort()).toEqual(["t1", "t5"]);
    expect(logs.some((l) => l.includes("[规划校验]"))).toBe(false);
  });
});
