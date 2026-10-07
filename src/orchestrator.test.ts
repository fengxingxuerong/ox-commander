import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllRoutesCoolingError } from "../shared/http-clients";
import {
  CancelledError,
  isCancelled,
  OrchestratorEngine,
  VerificationExhaustedError,
  type OrchestratorDeps,
  type RunSnapshot,
} from "../electron/engine/orchestrator";
import type { Scheduler } from "../electron/engine/scheduler";
import type { LlmClient } from "../shared/llm-client";
import { DEFAULT_SETTINGS, type EscalationAction, type PrdDocument, type SmokeCheck, type Task, type VerificationReport } from "../shared/types";
import type { DeliveryReceipt, ReceiptConflict } from "../shared/delivery-receipt";

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
  // 第 1 次调用是**基线验证**（引擎动手前跑的），它必须返回绿：基线红会往日志与
  // 重修上下文里注入"本次运行前就已失败"，把这条用例想测的时序整个挪掉。
  let calls = 0;
  let verified = false;
  deps.verify = async () => {
    calls += 1;
    if (calls === 1) return makeReport(true);
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

  it("环境裁决失败（审批/沙箱拒绝）在重修上下文里被说破，不是「项目本来就坏」（P2-3）", async () => {
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    const logs: string[] = [];
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { round: number; errorLogDigest: string }> },
      ) {
        if (opts?.repairOf) repairPayloads.push(opts.repairOf);
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "ok", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => ({
        passed: false,
        results: [
          {
            kind: "build",
            ok: false,
            exitCode: null,
            logDigest: "[审批] 命令需要人工确认，但当前无审批回调可用，按拒绝处理",
            durationMs: 0,
            errorClass: "approval-denied",
          },
        ],
      }),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: (t) => logs.push(t),
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);
    // 环境裁决说明必须进日志与重修上下文：agent 据此知道"改代码没用"
    expect(logs.some((l) => l.includes("[环境裁决]") && l.includes("审批拒绝执行"))).toBe(true);
    const ctx = repairPayloads.at(-1)!.get("t1")!.errorLogDigest;
    expect(ctx).toContain("[环境裁决]");
    expect(ctx).toContain("approvalCommands");
  });

  it("前任履历进重修上下文（P1-3 闭环：这条任务之前被谁试过、错在哪）", async () => {
    // 这是 P1-3 的闭环那一半：履历此前只流到 UI（人看），agent 读不到。
    // 没有这段，重试的agent 只知道"现在哪里错了"，会反复踩同一个坑。
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    const asked: string[] = [];
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { round: number; errorLogDigest: string }> },
      ) {
        if (opts?.repairOf) repairPayloads.push(opts.repairOf);
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "ok", events: [] }));
      },
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => ({
        passed: false,
        results: [
          { kind: "test", ok: false, exitCode: 1, logDigest: "still red", durationMs: 0 },
        ],
      }),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
      priorAttempts: (taskId) => {
        asked.push(taskId);
        return "[前任履历] 这个任务之前被试过：\n- 上一任执行器：a-prev\n- 已失败 2 次，按原因分：timeout × 2";
      },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    // 只在重修轮问一次，且问的是真正失败的那个任务
    expect(asked).toEqual(["t1"]);
    const ctx = repairPayloads.at(-1)!.get("t1")!.errorLogDigest;
    expect(ctx).toContain("[前任履历]");
    expect(ctx).toContain("上一任执行器：a-prev");
    expect(ctx).toContain("timeout × 2");
    // 履历是补充，不能把归属线索挤掉
    expect(ctx).toContain("still red");
  });

  it("首轮不查履历（没有「上一任」可言，查了也是空转）", async () => {
    // 反向用例：priorAttempts 只在重修轮被调用。首轮调用它既浪费 IO，
    // 又会让审计读次数与实际需要不符（契约是"重修时才回溯"）。
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    let calls = 0;
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { round: number; errorLogDigest: string }> },
      ) {
        if (opts?.repairOf) repairPayloads.push(opts.repairOf);
        // 第一轮直接成功 ⇒ 不进重修轮
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "ok", events: [] }));
      },
    } as unknown as Scheduler;
    const eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => ({ passed: true, results: [] }),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
        priorAttempts: () => {
          calls += 1;
          return "[前任履历] 不该被问到";
        },
      },
      {
        onStage: () => undefined,
        onLog: () => undefined,
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
    await eng.execute([TASKS], ".");
    expect(calls).toBe(0);
    expect(repairPayloads).toHaveLength(0);
  });

  it("routes verification errors to the task owning the failing file's zone", async () => {
    const repairPayloads: Array<Map<string, { round: number; errorLogDigest: string }>> = [];
    const greenLogs: string[] = [];
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
      // 第 1 次是**基线验证**（动手之前跑，必须绿，否则这条用例的意图就变了）；
      // 第 2 次是首轮交付闸（红）；第 3 次是重修后的闸（绿）。
      verify: async () => {
        verifyCalls += 1;
        return verifyCalls === 2 ? failingReport : makeReport(true);
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: (t) => greenLogs.push(t),
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    const report = await eng.execute([[tCalc, tApi]], ".");
    // 基线是绿的：日志必须说"全部通过"。把 `bad.length === 0` 翻成 `!==` 时，
    // 零条失败会被当成红，这一句就不出现了 —— 这个位点靠本断言杀掉。
    expect(greenLogs.join("\n")).toContain("基线验证：本次运行开始前，验证命令全部通过。");
    expect(report.passed).toBe(true);
    // 基线 + 首轮闸 + 重修后闸
    expect(verifyCalls).toBe(3);
    // Round 1 repair context: tc gets the routed digest, ta does not.
    const repairRound = repairPayloads.at(-1)!;
    expect(repairRound.get("tc")?.errorLogDigest).toContain("src/calc/math.js");
    expect(repairRound.get("ta")?.errorLogDigest).not.toContain("src/calc/math.js");
    // 基线是绿的，所以不该出现"本次运行前就已失败"的标注。
    expect(repairRound.get("ta")?.errorLogDigest).not.toContain("本次运行前就已失败");
  });

  it("基线红时，每一份重修上下文都带上这份历史失败", async () => {
    // 契约很简单：只要基线是红的，本轮每个任务的上下文都附上这份历史失败。
    // 两个任务的 zone 一个覆盖、一个不覆盖验证报出来的文件，是为了同时钉住
    // "归属路由本身没被基线注掉"（tq 看得到定位到自己 zone 的那份错）。
    const tz: Task = { ...TASKS[0]!, id: "tz", zone: "src/z" };
    const tq: Task = { ...TASKS[0]!, id: "tq", zone: "src/q" };
    const seen: Array<Map<string, { errorLogDigest: string }>> = [];
    const scheduler = {
      async runBatch(
        tasks: Task[],
        _root: string,
        opts?: { repairOf?: Map<string, { errorLogDigest: string }> },
      ) {
        if (opts?.repairOf) seen.push(opts.repairOf);
        return tasks.map((t) => ({ taskId: t.id, ok: true, logDigest: "ok", events: [] }));
      },
    } as unknown as Scheduler;
    const baselineBroken: VerificationReport = {
      passed: false,
      results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "Cannot find module 'left-pad'", durationMs: 5 }],
    };
    const gateRouted: VerificationReport = {
      passed: false,
      results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "TypeError: boom\n    at fn (src/q/a.js:3:1)", durationMs: 5 }],
    };
    let verifyCalls = 0;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      verify: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) return baselineBroken; // 基线（动手之前）
        if (verifyCalls === 2) return gateRouted; // 首轮交付闸
        return makeReport(true); // 重修之后
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const logs: string[] = [];
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: (t) => logs.push(t),
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    const report = await eng.execute([[tz, tq]], ".");
    expect(report.passed).toBe(true);
    expect(logs.join("\n")).toContain("在本次运行开始前就失败");
    const repair = seen.at(-1)!;
    for (const id of ["tz", "tq"]) {
      expect(repair.get(id)?.errorLogDigest).toContain("[本次运行前就已失败] test(exit=1)");
    }
    // 注记不复制失败摘要 —— 否则"这条线索归谁"的归属判据会被冲掉（见 [413]）。
    for (const id of ["tz", "tq"]) {
      expect(repair.get(id)?.errorLogDigest).not.toContain("left-pad");
    }
    expect(logs.join("\n")).toContain("Cannot find module 'left-pad'");
    // 与既有归属路由用例（"routes verification errors…"）不冲突：那份错该归谁仍由
    // routing.ts 决定，这里只保证基线注记一定附上。
  });

  it("断点续跑不重跑基线（工作区已被上一轮改过，基线不成立）", async () => {
    const t = { id: "tr", title: "tr", description: "", zone: "src/r", dependencies: [], suggestedRole: "fullstack-dev" } as Task;
    let verifyCalls = 0;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[]) {
          return tasks.map((x) => ({ taskId: x.id, ok: true, logDigest: "ok", events: [] }));
        },
      } as unknown as Scheduler,
      verify: async () => {
        verifyCalls += 1;
        return makeReport(true);
      },
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 2 },
      journal: { save: () => undefined },
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
    });
    await eng.execute([[t]], ".", {
      resume: { allDone: [], skipped: [], attempts: { tr: 1 }, round: 1, extraRounds: 0, lastDigest: "" },
    });
    expect(verifyCalls).toBe(1); // 只有交付闸那一次
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

  it("跳过任务时点名它的下游，并说明不会为它们花修预算", async () => {
    const events: string[] = [];
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const upstream: Task = { id: "t1", title: "上游模块", description: "d", zone: "src/a", dependencies: [], suggestedRole: "fullstack-dev" };
    const downstream: Task = { id: "t2", title: "下游模块", description: "d", zone: "src/b", dependencies: ["t1"], suggestedRole: "fullstack-dev" };
    const eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(false),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      },
      {
        onStage: () => undefined,
        onLog: (l) => events.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
        requestEscalationDecision: async (taskId: string) => (taskId === "t1" ? "skip" : "abort"),
      },
    );
    // 这条终局从"用户终止（对下游答 abort）"变成"带累 N 个下游"：下游现在根本拿不到
    // 那一问 —— 问它就是诱人多花一轮。见下一个用例。
    await expect(eng.execute([[upstream, downstream]], ".")).rejects.toThrow(/带累 1 个下游任务/);
    const line = events.find((l) => l.includes("用户跳过任务"));
    expect(line).toBeDefined();
    expect(line!).toContain("它的下游");
    expect(line!).toContain("「下游模块」");
  });

  it("上游被跳过后，下游不再拿升级决策（重派也补不上缺的产物）", async () => {
    const events: string[] = [];
    const asked: string[] = [];
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const upstream: Task = { id: "t1", title: "上游模块", description: "d", zone: "src/a", dependencies: [], suggestedRole: "fullstack-dev" };
    const downstream: Task = { id: "t2", title: "下游模块", description: "d", zone: "src/b", dependencies: ["t1"], suggestedRole: "fullstack-dev" };
    const eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(false),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      },
      {
        onStage: () => undefined,
        onLog: (l) => events.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
        requestEscalationDecision: async (taskId: string) => {
          asked.push(taskId);
          return "skip";
        },
      },
    );
    await expect(eng.execute([[upstream, downstream]], ".")).rejects.toThrow(/带累 1 个下游任务/);
    expect(asked).toEqual(["t1"]); // t2 从没被问"要不要重派"——那一问只会诱导再花钱
    expect(events.some((e) => e.includes("不进入升级决策") && e.includes("「下游模块」"))).toBe(true);
  });

  it("被跳过上游传染的任务只给一次机会，后续重修轮不再派发", async () => {
    const events: string[] = [];
    const dispatched: string[][] = [];
    let t3Asks = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        const ids = tasks.map((t) => t.id);
        dispatched.push(ids);
        events.push(`dispatch:${ids.join(",")}`);
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const upstream: Task = { id: "t1", title: "上游模块", description: "d", zone: "src/a", dependencies: [], suggestedRole: "fullstack-dev" };
    const other: Task = { id: "t3", title: "旁支模块", description: "d", zone: "src/c", dependencies: [], suggestedRole: "fullstack-dev" };
    const downstream: Task = { id: "t2", title: "下游模块", description: "d", zone: "src/b", dependencies: ["t1"], suggestedRole: "fullstack-dev" };
    const eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(false),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      },
      {
        onStage: () => undefined,
        onLog: (l) => events.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
        // t1 一开始就被跳过；t3 前两次要求重派（换来两个追加轮：第一轮给 t2 第一次
        // 机会，第二轮才轮到"已试过的 t2 不再派发"这条判定），第三次跳过
        // —— 否则这个循环没有尽头。
        requestEscalationDecision: async (taskId: string) => {
          if (taskId === "t3") {
            t3Asks += 1;
            return t3Asks <= 2 ? "redispatch" : "skip";
          }
          return "skip";
        },
      },
    );
    await eng.execute([[upstream, other], [downstream]], ".").catch(() => undefined);
    expect(dispatched.filter((ids) => ids.includes("t2"))).toHaveLength(1); // 只给一次机会
    const givenUpLines = events.filter((e) => e.includes("已停止为这些任务花修预算"));
    expect(givenUpLines).toHaveLength(1);
    expect(givenUpLines[0]).toContain("「下游模块」");
    // 那句话必须在它**真的被派过之后**才说：提前说等于宣称"已试过"而其实正要派发它。
    expect(events.indexOf(givenUpLines[0])).toBeGreaterThan(
      events.findIndex((e) => e === "dispatch:t2"),
    );
  });

  it("被跳过的上游挡在中间时，它后面的正常任务照样拿到升级决策", async () => {
    // `continue → break` 的位点：传染的任务排在未传染的任务前面时，一旦循环被打断，
    // 后面的任务就永远等不到那句"要不要重派/终止/跳过"——用户失去处置权。
    const asked: string[] = [];
    const events: string[] = [];
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({
          taskId: t.id,
          ok: t.id === "v", // 只有 v 成功：x 的依赖成立，所以 x 不属于被传染的那一类
          logDigest: "boom",
          events: [],
        }));
      },
    } as unknown as Scheduler;
    const u: Task = { id: "u", title: "上游模块", description: "d", zone: "src/a", dependencies: [], suggestedRole: "fullstack-dev" };
    const v: Task = { id: "v", title: "旁支上游", description: "d", zone: "src/b", dependencies: [], suggestedRole: "fullstack-dev" };
    const d: Task = { id: "d", title: "下游模块", description: "d", zone: "src/c", dependencies: ["u"], suggestedRole: "fullstack-dev" };
    const x: Task = { id: "x", title: "独立模块", description: "d", zone: "src/d", dependencies: ["v"], suggestedRole: "fullstack-dev" };
    const eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(false),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      },
      {
        onStage: () => undefined,
        onLog: (l) => events.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
        requestEscalationDecision: async (taskId: string) => {
          asked.push(taskId);
          if (taskId === "u") return "skip";
          return "abort";
        },
      },
    );
    await expect(eng.execute([[u, v], [d, x]], ".")).rejects.toThrow(/用户终止/);
    expect(asked).toEqual(["u", "x"]); // d 被跳过上游传染 ⇒ 不问它；x 必须照问
    expect(events.some((e) => e.includes("不进入升级决策") && e.includes("「下游模块」"))).toBe(true);
  });

  it("没有下游依赖时不多嘴", async () => {
    const events: string[] = [];
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const only: Task = { id: "t1", title: "孤立模块", description: "d", zone: "src/a", dependencies: [], suggestedRole: "fullstack-dev" };
    const eng = new OrchestratorEngine(
      { llm: fakeLlm(), scheduler, verify: async () => makeReport(false), settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 } },
      {
        onStage: () => undefined,
        onLog: (l) => events.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
        requestEscalationDecision: async () => "skip",
      },
    );
    // 唯一任务被跳过后没有可交付产物，验证仍是红的：这里只关心那句提示，不关心终局
    await eng.execute([[only]], ".").catch(() => undefined);
    const line = events.find((l) => l.includes("用户跳过任务"));
    expect(line).toBeDefined();
    expect(line!).not.toContain("它的下游");
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

  /**
   * 反过来也钉一下：**计划快照不该预写 attempts**。
   *
   * `save()` 在循环外先跑一次（:539），那时一个任务都还没派发。若有人为了
   * "保险"把 attempts 提前写进去，恢复后会得到"从没发生过"的轮次 ——
   * 比少记更糟：它会让上限判断偏松，用户以为自己还有预算。
   */
  it("计划快照里 attempts 是空的（不能预写没发生过的派发）", () => {
    // 只验形状，不起引擎：这条关心的是"第一份快照长什么样"。
    // 真正的反面风险是**少记**（见上面取消那条），这条管住"多记"。
    const saved: RunSnapshot[] = [];
    const engine = silentEngine({
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["A", "B"]), []),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
      journal: { save: (s) => saved.push(s) },
    });
    return engine.execute(twoBatchTasks(), ".").then(() => {
      expect(saved.length).toBeGreaterThan(0);
      // 计划快照：一个都还没派发
      expect(saved[0]!.attempts).toEqual({});
      // 收尾快照：两次派发都记着
      expect(saved.at(-1)!.attempts).toEqual({ A: 1, B: 1 });
    });
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

describe("OrchestratorEngine · 分解校验失败带反馈重试", () => {
  const PRD_WITH_FILE: PrdDocument = {
    goal: "g",
    features: ["实现 src/cli.test.js 测试文件"],
    techStack: ["Node.js"],
    acceptanceCriteria: ["npm test 通过"],
  };

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

  it("zone 覆盖缺口触发重试，校验错误回喂大脑后修正规划", async () => {
    const prompts: string[] = [];
    const dispatched: string[] = [];
    const llm: LlmClient = {
      async chat(req) {
        const prompt = req.messages.map((m) => m.content).join("\n");
        prompts.push(prompt);
        // 首次 zone 不覆盖 PRD 声明文件 → 触发校验缺口 → 重试时修正 zone
        const zone = prompts.length === 1 ? "tests" : "src";
        const plan = {
          tasks: [
            {
              id: "t1",
              title: "CLI 测试",
              description: "实现 src/cli.test.js",
              zone,
              dependencies: [],
              suggestedRole: "test-writer",
            },
          ],
          smoke: [],
        };
        return { content: JSON.stringify(plan), provider: "fake", model: "fake" };
      },
    };
    const deps: OrchestratorDeps = {
      llm,
      scheduler: recordingScheduler(new Set(["t1"]), dispatched),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    const { batches, smoke } = await silentEngine(deps).decompose(PRD_WITH_FILE);
    expect(prompts.length).toBe(2); // 恰好一次修正重试
    expect(prompts[1]).toMatch(/不属于任何 zone/); // 校验错误回喂
    expect(prompts[1]).toContain("src/cli.test.js"); // 缺口路径在反馈里
    expect(batches.flat().map((t) => t.zone)).toEqual(["src"]); // 修正后的 zone
    expect(smoke).toEqual([]);
  });

  it("重试预算耗尽仍失败 → 抛出校验错误", async () => {
    let calls = 0;
    const llm: LlmClient = {
      async chat() {
        calls += 1;
        const plan = {
          tasks: [
            { id: "t1", title: "x", description: "x", zone: "tests", dependencies: [], suggestedRole: "test-writer" },
          ],
          smoke: [],
        };
        return { content: JSON.stringify(plan), provider: "fake", model: "fake" };
      },
    };
    const deps: OrchestratorDeps = {
      llm,
      scheduler: recordingScheduler(new Set(["t1"]), []),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    await expect(silentEngine(deps).decompose(PRD_WITH_FILE)).rejects.toThrow(
      /src\/cli\.test\.js/,
    );
    expect(calls).toBe(3); // 首次 + 2 次重试
  });
});

/**
 * 下面这一组来自 site 逐位点审计（orchestrator.ts 9 处存活里的 4 处）。
 *
 * 这个模块是调度主链路（478 行、有状态、有 IO），改坏的共同特征是
 * **不抛错、只是行为悄悄变了** —— 所以断言的落点必须是可观测的外部事实：
 * 回调收到了什么、日志里写了什么、批次派给了谁。
 */
describe("OrchestratorEngine · 取消信号 / 任务时长 / 警告闸门", () => {
  it("[91] isCancelled 认得鸭子类型的取消信号", () => {
    // 第 91 行 `err instanceof CancelledError || (err as {name?})?.name === "CancelledError"`。
    // 两侧各自承载一半语义，改坏方向相反但后果都是"取消信号被当成普通失败"：
    //  - `||` 改 `&&`：鸭子类型那一侧（跨 realm 的实例、经结构化克隆后
    //    失去原型的错误）认不出来 → 批次继续往下跑而不是停下；
    //  - `===` 改 `!==`：`{name:"CancelledError"}` 判 false，而
    //    `{name:"TypeError"}` 反而判 true —— 判断整个反了。
    expect(isCancelled(new CancelledError())).toBe(true);
    expect(isCancelled({ name: "CancelledError" })).toBe(true);
    expect(isCancelled({ name: "TypeError" })).toBe(false);
    expect(isCancelled(null)).toBe(false);
    expect(isCancelled(undefined)).toBe(false);
  });

  it("[186] 首次分解就命中冷却等待时，日志说的是「任务分解」而不是「第 0 次重试」", () => {
    // 第 186 行 `attempt === 0 ? "任务分解" : \`任务分解（第 ${attempt} 次校验修正重试）\``。
    // 这个 label 只作为 `brainCall(what, …)` 的第一参出现，而 `what` 只在
    // **冷却等待**的日志里露面 —— 所以触发条件就写成"第一次调用就撞上全线冷却"。
    // 改成 `!==` 后首次尝试被标成"第 0 次校验修正重试"：日志看像是重试，
    // 而实际上一次都还没重试过，运维会去翻不存在的上一轮。
    const events: string[] = [];
    let calls = 0;
    const plan = {
      tasks: [
        {
          id: "t1",
          title: "x",
          description: "x",
          zone: "src",
          dependencies: [],
          suggestedRole: "backend-dev",
        },
      ],
      smoke: [],
    };
    const llm: LlmClient = {
      async chat() {
        calls += 1;
        if (calls === 1) throw new AllRoutesCoolingError(20);
        return { content: JSON.stringify(plan), provider: "fake", model: "fake" };
      },
    };
    const deps: OrchestratorDeps = {
      llm,
      scheduler: fakeScheduler(false),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    return (async () => {
      const eng = new OrchestratorEngine(deps, {
        onStage: () => {},
        onLog: (l) => events.push(l),
        onTaskStatus: () => {},
        onVerification: () => {},
        onEscalation: () => {},
      });
      await eng.decompose({
        goal: "g",
        features: [],
        techStack: ["Node.js"],
        acceptanceCriteria: ["npm test 通过"],
      });
      const coolLog = events.find((e) => e.includes("冷却中")) ?? "";
      expect(coolLog).toContain("任务分解");
      expect(coolLog).not.toContain("第 0 次");
    })();
  });

  it("[375] 任务结果里的 durationMs 要透传给 onTaskOutcome", () => {
    // 第 375 行 `...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {})`。
    // 改成 `===` 后**给出时反而被丢掉** —— 看板上的"每个任务耗时"整列变空。
    // 这个字段是运营侧唯一的耗时来源（结果对象里的 durationMs 只到批次级）。
    const events: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[]) {
          return tasks.map((t: Task) => ({
            taskId: t.id,
            ok: true,
            logDigest: "log",
            events: [],
            durationMs: 42,
          }));
        },
      } as unknown as Scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    return (async () => {
      const eng = new OrchestratorEngine(deps, {
        onStage: () => {},
        onLog: () => {},
        onTaskStatus: () => {},
        onVerification: () => {},
        onEscalation: () => {},
        onTaskOutcome: (_id, _ok, _digest, extra) => events.push(JSON.stringify(extra)),
      });
      await eng.execute([TASKS], ".");
      expect(events.join("\n")).toContain('"durationMs":42');
    })();
  });

  it("[483/484] outcome 的可选字段：给出时透传，缺失时连键都不出现", () => {
    // 第 483/484 行 `...(o.agentId ? { agentId: o.agentId } : {})` 与 errorClass 同形。
    // 交换分支后：给了 agentId 反而被丢（"哪个智能体做的"整列变空），没给的却
    // 硬塞一个值为 undefined 的键 —— 下游按 `in` / `Object.keys` 读形状的代码
    // 会把它当成"有"。注意用 JSON.stringify 看不出来（undefined 键会被省略），
    // 所以这里断言的是**键的存在性**。
    async function metasFor(outcome: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
      const metas: Array<Record<string, unknown>> = [];
      const deps: OrchestratorDeps = {
        llm: fakeLlm(),
        scheduler: {
          async runBatch(tasks: Task[]) {
            return tasks.map((t: Task) => ({
              taskId: t.id,
              ok: true,
              logDigest: "log",
              events: [],
              ...outcome,
            }));
          },
        } as unknown as Scheduler,
        verify: async () => makeReport(true),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
      };
      const eng = new OrchestratorEngine(deps, {
        onStage: () => {},
        onLog: () => {},
        onTaskStatus: () => {},
        onVerification: () => {},
        onEscalation: () => {},
        onTaskOutcome: (_id, _ok, _digest, extra) => metas.push({ ...(extra ?? {}) }),
      });
      await eng.execute([TASKS], ".");
      return metas;
    }

    return (async () => {
      const full = await metasFor({ agentId: "a1", errorClass: "resource" });
      expect(full[0]!.agentId).toBe("a1");
      expect(full[0]!.errorClass).toBe("resource");

      const bare = await metasFor({});
      expect("agentId" in bare[0]!).toBe(false);
      expect("errorClass" in bare[0]!).toBe(false);
    })();
  });

  it("[408] 验证没过但开发任务也失败时，不许打「即使构建通过」的警告", () => {
    // 第 408 行 `if (anyDevFailure && report.passed)`。改成 `||` 后，
    // **"开发任务失败 + 验证也没过"**这种最需要如实报告的情形反而会打上
    // "即使构建通过也不允许交付" —— 日志把结论说反了（构建明明没过），
    // 运维据此判断会得出错误结论。
    //
    // 触发条件：`anyDevFailure=true` 且 `report.passed=false`。
    // 注意第 402 行的提前 return 是 `!anyDevFailure && report.passed`，
    // 所以这条警告只在"走到修复轮"时可见 —— 而那一轮恰恰是 passed=false。
    const events: string[] = [];
    const eng = engine({ failFirstRound: true, events });
    return (async () => {
      await eng.execute([TASKS], ".");
      expect(events.join("\n")).not.toContain("即使构建通过");
    })();
  });

  /**
   * 升级决策相关的两处存活位点（`@444` 的 `continue` / `@456` 的 `&&`）。
   *
   * 断言用的是**时间线**而不是最终状态：这两个位点都会让流程"多绕一轮"或
   * "少问一个任务"，只看最终有没有交付会被绕行掩盖过去。
   */
  function escalateEngine(o: {
    timeline: string[];
    decisions: Map<string, "skip" | "abort" | "redispatch">;
    verifyPassed: boolean;
    okIds?: Set<string>;
  }): OrchestratorEngine {
    let schedulerCalls = 0;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[]) {
          schedulerCalls += 1;
          o.timeline.push("sched:" + String(schedulerCalls));
          return tasks.map((t: Task) => ({
            taskId: t.id,
            ok: o.okIds?.has(t.id) ?? false,
            logDigest: t.id + " 的失败日志",
            events: [],
          }));
        },
      } as unknown as Scheduler,
      verify: async () => makeReport(o.verifyPassed),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
    };
    return new OrchestratorEngine(deps, {
      onStage: (s) => o.timeline.push("stage:" + s),
      onLog: () => {},
      onTaskStatus: () => {},
      onVerification: () => {},
      onEscalation: (id, summary) => o.timeline.push("esc:" + id + " " + summary),
      requestEscalationDecision: async (id) => {
        o.timeline.push("ask:" + id);
        return o.decisions.get(id) ?? "skip";
      },
    });
  }

  const TWO_TASKS: Task[][] = [
    [
      { id: "t1", title: "core", description: "", zone: "src/core", dependencies: [], suggestedRole: "backend-dev" },
      { id: "t2", title: "cli", description: "", zone: "src/cli", dependencies: [], suggestedRole: "backend-dev" },
    ],
  ];

  it("[444] 同一轮里每个失败任务都要问用户，跳过一个不能中断后面的", () => {
    // 第 444 行是 skip 分支里的 `continue;` —— 语义是"这个任务跳过了，
    // 继续问下一个失败任务"。改成 `break` 后，**第一个被跳过的任务之后
    // 所有失败任务都不再询问用户**，直接被下一轮重新派发出去。
    // 用户点了"跳过"，却看到它又被跑了一遍。
    //
    // 断言用时间线：要求 `ask:t2` 出现在**第二次调度之前**。
    // 只断言"最终两个都被问过"不够 —— 改坏后 t2 会在下一轮被问到，
    // 结果集合相同、只有次序不同（这正是"聚合掩盖"在时间维度上的翻版）。
    const timeline: string[] = [];
    const decisions = new Map<string, "skip" | "abort" | "redispatch">([
      ["t1", "skip"],
      ["t2", "skip"],
    ]);
    return (async () => {
      const eng = escalateEngine({ timeline, decisions, verifyPassed: true });
      await eng.execute(TWO_TASKS, ".");
      // 只看"第二次调度之前"这一段：正常实现里两个任务在同一轮被问完，
      // 跳完即交付（根本不会有 sched:2）；改 `break` 后 t2 被跳过询问，
      // 只能等下一轮重新派发时才被问到 —— 于是 sched:2 会先出现。
      const second = timeline.indexOf("sched:2");
      const firstPass = second === -1 ? timeline : timeline.slice(0, second);
      expect(firstPass).toContain("ask:t1");
      expect(firstPass).toContain("ask:t2");
    })();
  });

  it("[456] t1 已完成、t2 被跳过后要能交付，不能被已完成的任务挡住", () => {
    // 第 456 行 `.some((t) => !allDone.has(t.id) && !skipped.has(t.id))`。
    // 改成 `||` 之后，**任何一个"已完成但没被跳过"的任务都会让
    // stillFailing 为真**（allDone 真 ⟹ `!allDone` 假，但 `!skipped` 真）。
    // 于是"失败任务全被跳过、验证也过了"这种完全可以交付的收尾，
    // 会退回 `round += 1; continue` 绕圈，永远走不到 DELIVERY/DONE。
    //
    // 注意必须有一个**成功**的任务：如果所有任务都是"被跳过"的，
    // `!allDone || !skipped` 两侧同为假，改坏也看不出来。
    const timeline: string[] = [];
    const decisions = new Map<string, "skip" | "abort" | "redispatch">([["t2", "skip"]]);
    return (async () => {
      const eng = escalateEngine({
        timeline,
        decisions,
        verifyPassed: true,
        okIds: new Set(["t1"]),
      });
      await eng.execute(TWO_TASKS, ".");
      expect(timeline).toContain("stage:DONE");
    })();
  });

  it("[419] 升级摘要要带真实失败日志，不能只剩兜底文案", () => {
    // 第 419 行 `[...lastFailedLogs.values()].join("\n\n") || "开发任务执行失败（无验证错误，可能是 API 调用失败）"`。
    // 改成 `&&` 之后**两个方向都错**：
    //  - 有失败日志时 → `"真实日志" && "兜底文案"` 得到**兜底文案**
    //    （把"可能是 API 调用失败"这种猜测盖在确凿的失败原因上）；
    //  - 没有失败日志时 → `"" && ...` 得到**空串**，摘要里那一栏直接是空白。
    // 这里覆盖第一个方向。
    const timeline: string[] = [];
    const decisions = new Map<string, "skip" | "abort" | "redispatch">([["t2", "skip"]]);
    return (async () => {
      const eng = escalateEngine({
        timeline,
        decisions,
        verifyPassed: true,
        okIds: new Set(["t1"]),
      });
      await eng.execute(TWO_TASKS, ".");
      const escalation = timeline.filter((t) => t.startsWith("esc:")).join("\n");
      expect(escalation).toContain("t2 的失败日志");
      expect(escalation).not.toContain("可能是 API 调用失败");
    })();
  });

  it("[413] 待修任务只算「没完成且没跳过」的，已完成的任务不能被算进去", () => {
    // 第 413 行 `batches.flat().filter((t) => !allDone.has(t.id) && !skipped.has(t.id))`。
    // 改成 `||` 之后**已完成的任务也被当成待修**，于是
    // `routeVerificationErrors` 会把「错误文件所属 zone」归属给那些已经交付的任务，
    // 真正的待修任务反而分不到错误、`unattributed` 变空 ——
    // 下一轮修复拿到的不是"哪里错了"，而是回落成"上次失败的日志"。
    //
    // 构造：t1（zone src/core）已完成；t2（zone src/cli）失败；
    // 验证错误提到 `src/core/a.js` —— 它属于 t1 的 zone、不属于 t2 的。
    const seen: Array<Map<string, { errorLogDigest: string }>> = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[], _root: string, opts?: { repairOf?: Map<string, { errorLogDigest: string }> }) {
          if (opts?.repairOf) seen.push(opts.repairOf);
          return tasks.map((t: Task) => ({
            taskId: t.id,
            ok: t.id === "t1",
            logDigest: t.id + " 的失败日志",
            events: [],
          }));
        },
      } as unknown as Scheduler,
      verify: async () => ({
        passed: false,
        results: [
          {
            kind: "build",
            ok: false,
            exitCode: 1,
            // ⚠️ 格式有讲究：`extractErrorFiles` 的两条正则要求
            // `文件:行:列`（**两个**数字）或 node 栈帧；写成 `a.js:12` 提取不出来，
            // 于是两种写法都会走 unattributed，差异观察不到（我第一版就踩了这个）。
            logDigest: "src/core/a.js:12:5 - error TS2322: Type 'string' is not assignable",
            durationMs: 1,
          },
        ],
      }),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
    };
    return (async () => {
      const eng = new OrchestratorEngine(deps, {
        onStage: () => {},
        onLog: () => {},
        onTaskStatus: () => {},
        onVerification: () => {},
        onEscalation: () => {},
      });
      await eng.execute(TWO_TASKS, ".").catch(() => undefined);
      // 修复轮发给 t2 的错误摘要必须带上验证错误里那条真实线索
      const digest = seen[0]?.get("t2")?.errorLogDigest ?? "";
      expect(digest).toContain("src/core/a.js");
    })();
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
    /**
     * 首轮输出不合格、重修轮**改写脚本文件**后才合格 —— 刻意用文件而不是
     * 宿主环境变量：验证/冒烟子进程走 `scopedEnv()` 最小化环境，那里读不到
     * 测试进程自己 set 的变量，而"改文件"才是智能体真实的修法。
     */
    const writeSample = (fixed: boolean): void =>
      fs.writeFileSync(script, fixed ? "console.log('EXPECTED-OUTPUT');" : "console.log('nope');");
    writeSample(false);
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
    const engine = new OrchestratorEngine(deps, {
      onStage: () => {},
      onLog: (l) => {
        events.push(l);
        if (l.includes("重修第 1/1 轮")) writeSample(true);
      },
      onTaskStatus: () => {},
      onVerification: (r) => events.push("verify:" + r.passed),
      onEscalation: () => {},
    });
    const report = await engine.execute(twoBatchTasks(), root, { smoke });
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
    // 预期 ["A","A"]：B 依赖 A，A 永不成功 → 依赖门每轮阻断 B（依赖跳过层的正确行为）
    //
    // ⚠️ 这里断言的是 **class** 而不是 message（2026-10-05）：本用例关心的是
    // "冒烟有没有被运行"，而错误文案后来被拆成两种（验证红着 / 验证全绿但任务
    // 没做出来）—— 这条引擎正是后者。钉死文案会让这条与被测点无关的断言
    // 承担一份它并不理解的语义。
    await expect(
      smokeEngine(new Set(), dispatched, events).execute(twoBatchTasks(), root, { smoke }),
    ).rejects.toBeInstanceOf(VerificationExhaustedError);
    expect(dispatched).toEqual(["A", "A"]);
    expect(events.some((l) => l.includes("独立样本冒烟"))).toBe(false);
  });

  it("resume + 冒烟首败 → 重修轮冒烟转绿 → 交付（两层联动）", async () => {
    const script = path.join(root, "sample-smoke.js");
    fs.writeFileSync(script, "console.log('nope');");
    const smoke: SmokeCheck[] = [
      { title: "冒烟", command: process.execPath, args: ["sample-smoke.js"], expectContains: ["EXPECTED"] },
    ];
    const dispatched: string[] = [];
    let verifyCalls = 0;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: recordingScheduler(new Set(["B"]), dispatched), // A 已完成不重派；B 首败重派成功
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 2 },
      journal: { save: () => undefined },
    };
    // 首次验证后把样例脚本修好（模拟重修轮完成任务修复了冒烟缺口）
    const eng = new OrchestratorEngine(deps, {
      onStage: () => {},
      onLog: () => {},
      onTaskStatus: () => {},
      onVerification: () => {
        verifyCalls += 1;
        if (verifyCalls === 1) fs.writeFileSync(script, "console.log('EXPECTED');");
      },
      onEscalation: () => {},
    });
    const report = await eng.execute(twoBatchTasks(), root, {
      resume: { allDone: ["A"], skipped: [], attempts: { A: 1 }, round: 1, extraRounds: 0, lastDigest: "" },
      smoke,
    });
    expect(report.passed).toBe(true);
    expect(verifyCalls).toBe(2); // 首败 + 重修轮转绿
    expect(dispatched).toEqual(["B", "B"]); // A 不重派；B 两轮各一次
    const sr = report.results.filter((r) => r.kind === "smoke");
    expect(sr.length).toBe(1);
    expect(sr[0]!.ok).toBe(true); // 最终报告的冒烟已转绿
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
      abortInFlight: async () => 0,
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

  /**
   * **取消时在飞任务的派发次数仍要写进 journal**（2026-10-05 断点续跑审计）。
   *
   * 这条钉的是一个**差点被改坏**的行为。静态读代码看：`attempts.set()` 在派发前
   * （`orchestrator.ts:635`），而 `save()` 只在**批次跑完之后**（:691）——
   * 看着像"派发没落盘"，恢复后 `attempts` 从头算，烧掉的预算没人记得。
   * 第一版我正是这么判的，还准备去加 save()。
   *
   * 真跑一次才发现**不是**：`cancel()` 调 `abortInFlight()`，它让在跑的批次
   * **以 cancelled 收场而不是悬着**，于是控制流照常走到 :691，attempts 落盘了。
   * 实测（真 serve run + 读 journal 文件）：派发 1 次 → 取消 → 恢复后凭据
   * `attempts=2`，与真实派发数一致。
   *
   * 所以那条 save 是**承重的**：哪天有人把 `abortInFlight` 换成"直接抛、
   * 不等批次收场"（就像上面那个用 `throw` 的用例），真实运行就会丢掉计数。
   *
   * ⚠️ 本用例必须让 `runBatch` **正常返回**（生产里的形状），而不是像上一条那样
   * 直接抛 —— 抛的那条走不到 :691，而那正是它没断言 journal 的原因。
   */
  it("取消后批次收场时，journal 里的 attempts 记着这次派发", async () => {
    const snapshots: RunSnapshot[] = [];
    let eng!: OrchestratorEngine;
    const scheduler = {
      async runBatch(ts: readonly { id: string }[]) {
        eng.cancel(); // 用户在批次途中点了取消
        // 生产形状：abortInFlight 让批次以"失败/取消"收场并正常返回
        return ts.map((t) => ({ taskId: t.id, ok: false, logDigest: "cancelled" }));
      },
      abortInFlight: async () => 1,
    } as unknown as Scheduler;
    eng = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(true),
        settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
        journal: { save: (s) => snapshots.push(s) },
      },
      {
        onStage: () => undefined,
        onLog: () => undefined,
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
    await eng.execute([TASKS], ".").catch(() => undefined);

    // 派发过就必须在快照里看得见 —— 恢复后才知道"这次已经烧过一轮"
    const last = snapshots[snapshots.length - 1];
    expect(last?.attempts).toEqual({ t1: 1 });
  });

  /**
   * `cancel()` 不只是设一个标志位：标志位只拦得住下一个检查点，已经在跑的 run
   * （外部 CLI 进程、在途 HTTP 请求）必须被真的中止，否则用户点了取消，
   * 智能体还会继续跑满自己的 runDeadline 并改文件。
   */
  it("cancel 会下传中止，并把中止数量播报出来", async () => {
    let abortCalls = 0;
    const scheduler = {
      async runBatch() {
        return [];
      },
      async abortInFlight() {
        abortCalls += 1;
        return 2;
      },
    } as unknown as Scheduler;
    const logs: string[] = [];
    const engine = new OrchestratorEngine(
      {
        llm: fakeLlm(),
        scheduler,
        verify: async () => makeReport(true),
        settings: { ...DEFAULT_SETTINGS },
      },
      {
        onStage: () => undefined,
        onLog: (l) => logs.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
    engine.cancel();
    // cancel 是同步 API，数量是在微任务里回来的
    await new Promise((r) => setTimeout(r, 0));
    expect(abortCalls).toBe(1);
    expect(logs.join(" | ")).toContain("已请求中止 2 个在跑的任务");
  });

  it("一个都没中止时不播报（不假装做了什么）", async () => {
    const logs: string[] = [];
    const scheduler = {
      async runBatch() {
        return [];
      },
      async abortInFlight() {
        return 0;
      },
    } as unknown as Scheduler;
    const engine = new OrchestratorEngine(
      { llm: fakeLlm(), scheduler, verify: async () => makeReport(true), settings: { ...DEFAULT_SETTINGS } },
      {
        onStage: () => undefined,
        onLog: (l) => logs.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
    engine.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.join(" | ")).not.toContain("已请求中止");
  });

  it("does not mark a task cancelled once it already reached a terminal state", async () => {
    const statuses: string[] = [];
    let eng!: OrchestratorEngine;
    let calls = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "log", events: [] }));
      },
      abortInFlight: async () => 0,
    } as unknown as Scheduler;
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler,
      // The cancel lands after the batch succeeded — the task is already `done`
      // and must stay that way. 第 1 次调用是基线验证，那时派单还没开始，
      // 在它上面 cancel 会让整条用例失去意义（没有任何终态可保留）。
      verify: async () => {
        if (++calls === 1) return makeReport(true);
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

/**
 * `onUsage` 是一次 `execute` 结束时回报的用量快照。三条出口（交付 / 取消 /
 * 抛错）都必须到 —— 只在成功路径上报，会让"最贵的那次运行"恰好看不见：
 * 反复重修的失败运行通常比一次顺利交付贵得多。
 */
/**
 * `verificationCommands: []` 是合法配置（headless 协议允许空集），而空集在 `verifyProject`
 * 里恒为 passed。判定不改，改的是说法：零验证必须当场说出来，
 * 否则看板与审计日志会显示"全部验证通过"，而那一次什么都没验过。
 */
describe("OrchestratorEngine · 零验证交付的口径", () => {
/**
 * run 级墙钟上界。三个分支都要能被判红：没配（省略字段）、配 0（=不限）、配 1ms（到点）。
 * 变异口径下这三处（`=== undefined` / `<= 0` / `elapsed <= limit`）各自都有断言对着。
 */
describe("OrchestratorEngine · run 墙钟上界", () => {
  const eagerScheduler = {
    async runBatch(tasks: Task[]) {
      return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "log", events: [] }));
    },
  } as unknown as Scheduler;
  function clockEngine(settings: Record<string, number>, scheduler: Scheduler): OrchestratorEngine {
    return new OrchestratorEngine(
      { llm: fakeLlm(), scheduler, verify: async () => makeReport(true), settings: { ...DEFAULT_SETTINGS, ...settings } },
      { onStage: () => undefined, onLog: () => undefined, onTaskStatus: () => undefined, onVerification: () => undefined, onEscalation: () => undefined },
    );
  }

  it("到点就停在批/轮边界，并说清现场还在", async () => {
    const eng = clockEngine({ runWallClockMs: 1 }, eagerScheduler);
    await new Promise((r) => setTimeout(r, 20));
    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/墙钟上限/);
  });

  it("配 0 是不限，不是「立刻超时」", async () => {
    const rep = await clockEngine({ runWallClockMs: 0 }, eagerScheduler).execute([TASKS], ".");
    expect(rep.passed).toBe(true);
  });

  it("没配这个字段时行为与从前完全一致", async () => {
    const rep = await clockEngine({}, eagerScheduler).execute([TASKS], ".");
    expect(rep.passed).toBe(true);
  });
});


  function verifyEngine(report: VerificationReport, logs: string[]): OrchestratorEngine {
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: true, logDigest: "log", events: [] }));
      },
    } as unknown as Scheduler;
    return new OrchestratorEngine(
      { llm: fakeLlm(), scheduler, verify: async () => report, settings: { ...DEFAULT_SETTINGS } },
      {
        onStage: () => undefined,
        onLog: (l) => logs.push(l),
        onTaskStatus: () => undefined,
        onVerification: () => undefined,
        onEscalation: () => undefined,
      },
    );
  }

  it("空验证集：说「未经构建/测试验证」，而不是「全部验证通过」", async () => {
    const logs: string[] = [];
    const rep = await verifyEngine({ passed: true, results: [] }, logs).execute([TASKS], ".");
    expect(rep.passed).toBe(true); // 判定本身不改
    expect(logs.join(" | ")).toContain("未经构建/测试验证");
    expect(logs.join(" | ")).not.toContain("全部验证通过");
  });

  it("有验证结果时仍然是原来那句", async () => {
    const logs: string[] = [];
    await verifyEngine(makeReport(true), logs).execute([TASKS], ".");
    expect(logs.join(" | ")).toContain("全部验证通过，进入交付。");
    expect(logs.join(" | ")).not.toContain("未经构建/测试验证");
  });
});

describe("OrchestratorEngine · 用量回报", () => {
  const SNAPSHOT = {
    totalTokens: 321,
    calls: 2,
    measuredCalls: 2,
    byModel: { "sensenova/deepseek-v4-flash": 321 },
  };

  function build(opts: {
    scheduler: Scheduler;
    usage?: () => typeof SNAPSHOT;
    onUsage?: (s: typeof SNAPSHOT) => void;
    maxRounds?: number;
  }): OrchestratorEngine {
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: opts.scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: opts.maxRounds ?? 0 },
      ...(opts.usage ? { usage: opts.usage } : {}),
    };
    return new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
      ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
    });
  }

  it("交付路径：回报一次，内容是依赖给的快照", async () => {
    const seen: Array<typeof SNAPSHOT> = [];
    const eng = build({
      scheduler: fakeScheduler(false),
      usage: () => SNAPSHOT,
      onUsage: (s) => seen.push(s),
    });

    await eng.execute([TASKS], ".");

    expect(seen).toEqual([SNAPSHOT]);
  });

  it("预算耗尽抛错的路径也要回报（失败的运行一样烧了 token）", async () => {
    const seen: Array<typeof SNAPSHOT> = [];
    const alwaysFail = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
      },
    } as unknown as Scheduler;
    const eng = build({
      scheduler: alwaysFail,
      usage: () => SNAPSHOT,
      onUsage: (s) => seen.push(s),
      maxRounds: 0,
    });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    expect(seen).toEqual([SNAPSHOT]);
  });

  it("取消的路径也要回报", async () => {
    const seen: Array<typeof SNAPSHOT> = [];
    const cancelled = {
      async runBatch() {
        throw new CancelledError();
      },
    } as unknown as Scheduler;
    const eng = build({
      scheduler: cancelled,
      usage: () => SNAPSHOT,
      onUsage: (s) => seen.push(s),
    });

    await expect(eng.execute([TASKS], ".")).rejects.toBeInstanceOf(CancelledError);

    expect(seen).toEqual([SNAPSHOT]);
  });

  it("宿主没提供 usage 依赖时 onUsage 不被调用（可选能力不能变成必需）", async () => {
    // 两者缺一都不该触发：`deps.usage` 缺失（宿主不管计量）时回调必须安静。
    const seen: Array<typeof SNAPSHOT> = [];
    const eng = build({ scheduler: fakeScheduler(false), onUsage: (s) => seen.push(s) });

    await eng.execute([TASKS], ".");

    expect(seen).toEqual([]);
  });
});

describe("OrchestratorEngine · 交付凭据", () => {
  function buildReceiptEngine(opts: {
    scheduler: Scheduler;
    onReceipt: (r: DeliveryReceipt) => void;
    verify?: () => Promise<VerificationReport>;
    conflicts?: () => ReceiptConflict[];
    maxRounds?: number;
    requestEscalationDecision?: (taskId: string, summary: string) => Promise<EscalationAction>;
  }): OrchestratorEngine {
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: opts.scheduler,
      verify: opts.verify ?? (async () => makeReport(true)),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: opts.maxRounds ?? 0 },
      ...(opts.conflicts ? { conflicts: opts.conflicts } : {}),
    };
    return new OrchestratorEngine(deps, {
      onStage: () => undefined,
      onLog: () => undefined,
      onTaskStatus: () => undefined,
      onVerification: () => undefined,
      onEscalation: () => undefined,
      onReceipt: opts.onReceipt,
      ...(opts.requestEscalationDecision ? { requestEscalationDecision: opts.requestEscalationDecision } : {}),
    });
  }

  const attributed = {
    async runBatch(tasks: Task[]) {
      return tasks.map((t: Task) => ({
        taskId: t.id,
        ok: true,
        logDigest: "",
        events: [],
        agentId: "sensenova-api",
        durationMs: 1500,
      }));
    },
  } as unknown as Scheduler;

  const alwaysFail = {
    async runBatch(tasks: Task[]) {
      return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "boom", events: [] }));
    },
  } as unknown as Scheduler;

  it("交付成功只发一次，且任务账带上执行器归因", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({ scheduler: attributed, onReceipt: (r) => seen.push(r) });

    await eng.execute([TASKS], ".");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.outcome).toBe("delivered");
    expect(seen[0]!.verified).toBe(true);
    // 验证真实通过时，"未经构建/测试验证"的免责声明整个键不出现（字段即承诺）。
    expect(seen[0]!.unverifiedReason).toBeUndefined();
    expect(seen[0]!.tasks).toMatchObject([
      { id: "t1", status: "done", agentId: "sensenova-api", durationMs: 1500 },
    ]);
  });

  /**
   * `outcomeOk` 必须真的出现在凭据里（2026-10-05 分流审计）。
   *
   * 缺陷：`ReceiptTask` 原本**没有** `outcomeOk` 字段，而 `orchestrator.ts:463`
   * 把它展开进任务对象 —— TypeScript **静默丢弃**，于是真实凭据里
   * 从来没有过这个键。写那行的注释说"没有派发结果时不给 outcomeOk"，
   * 实际是**从没兑现过的承诺**。
   *
   * 为什么单测没抓到：已有的凭据用例都只 `toMatchObject([...])` 断言
   * `status`/`agentId`，**没断言过任何"不该出现/该出现的键"**，
   * 而 `grep outcomeOk` 全仓零消费侧 ⇒ 没有任何一侧会因此变红。
   *
   * 这就是**端到端断言**存在的理由：它不看某几个字段对不对，
   * 而看"这份凭据讲的故事完不完整"。
   */
  it("成功派发的任务带着 outcomeOk=true（缺了这个键，status 就没了来路）", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({ scheduler: attributed, onReceipt: (r) => seen.push(r) });
    await eng.execute([TASKS], ".");

    const t = seen[0]!.tasks[0]!;
    expect(t.status).toBe("done");
    expect(t.outcomeOk).toBe(true); // ← 这一行在修之前是 undefined
    // `attempts` 与 `outcomeOk` 是**同源**的两份事实（都来自这一次派发）。
    // 顺带钉住它：反注入把 attempts 写死 0 时，只有这里能咬住 ——
    // journal 那几条断言管的是 RunSnapshot，管不到凭据。
    expect(t.attempts).toBe(1);
  });

  /**
   * 逐轮重修台账进凭据（2026-10-07「两套账打通」）。
   *
   * 缺口形状：`attempts` 只说"派发过几次"，说不出"每一轮为什么没成"。
   * 而重修上下文（每轮的归因摘要）此前**只在事件流里活一轮** —— 跑完就没了，
   * 事后要复盘只能翻日志。2026-10-06 真实拆解端到端的负结果里，最花时间的
   * 一格正是"这一轮到底归因到了什么"。
   *
   * 三条断言各自的理由：
   *   · `repairs` 有 1 条 —— 只发生了一轮重修；
   *   · `attempts === 2` —— 首轮 + 重修轮，两个数是**同源**的两份事实；
   *   · `dispatchedAt` 是 ISO 串 —— 时间戳缺席会让"第几轮"失去时序。
   *
   * ⚠️ 反向注入（改完必做）：把 orchestrator 里那个 `list.push(...)` 删掉
   * ⇒ 本用例当场红（`repairs` 变 undefined）。**只断言"加字段后绿"证明不了
   * 任何东西。**
   */
  it("重修轮的原因与摘要进任务账（attempts 只说次数，repairs 说每一轮为什么）", async () => {
    const seen: DeliveryReceipt[] = [];
    let round = 0;
    // 首轮派发成功但验证未过 ⇒ 重修的来路是"上一轮验证未通过"。
    const scheduler = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({
          taskId: t.id, ok: true, logDigest: "", events: [], agentId: "sensenova-api", durationMs: 10,
        }));
      },
    } as unknown as Scheduler;
    const eng = buildReceiptEngine({
      scheduler,
      onReceipt: (r) => seen.push(r),
      maxRounds: 1,
      verify: async () => {
        round += 1;
        // 前两次都红：第 1 次是**派发前的基线验证**（动手前先跑基线），
        // 第 2 次才是首轮派发后的验证 —— 两次都红才会真的进入重修轮。
        return round < 3 ? makeReport(false) : makeReport(true);
      },
    });

    await eng.execute([TASKS], ".");

    const t = seen[0]!.tasks[0]!;
    expect(t.attempts).toBe(2);
    expect(t.repairs).toHaveLength(1);
    expect(t.repairs![0]!.round).toBe(1);
    // 首轮是"派发成功、验证没过"，**不是**"没派发成功" —— 这两种来路的
    // 排查路径完全不同（看归因摘要 vs 看执行器/沙箱）。
    expect(t.repairs![0]!.reason).toContain("验证未通过");
    expect(t.repairs![0]!.dispatchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("上一轮没派发成功的任务，reason 说的是派发失败（不是含糊的「重修」）", async () => {
    const seen: DeliveryReceipt[] = [];
    let round = 0;
    let batchNo = 0;
    const scheduler = {
      async runBatch(tasks: Task[]) {
        batchNo += 1;
        // 首轮派发失败（进 lastFailedLogs），重修轮成功 —— 否则"验证过了但
        // 任务没完成"会走到 VerificationExhaustedError，凭据根本不会发出。
        const ok = batchNo > 1;
        return tasks.map((t: Task) => ({
          taskId: t.id, ok, logDigest: ok ? "" : "boom-t1", events: [], durationMs: 10,
        }));
      },
    } as unknown as Scheduler;
    const eng = buildReceiptEngine({
      scheduler,
      onReceipt: (r) => seen.push(r),
      maxRounds: 1,
      verify: async () => {
        round += 1;
        return round === 1 ? makeReport(false) : makeReport(true);
      },
    });

    await eng.execute([TASKS], ".");

    const t = seen[0]!.tasks.find((x) => x.id === "t1")!;
    expect(t.repairs).toHaveLength(1);
    expect(t.repairs![0]!.reason).toContain("未派发成功");
  });

  /** 缺席 ≠ 空数组：一次就过的任务没有"重修"这回事，连键都不该出现。 */
  it("一次就过的任务没有 repairs 键（空数组会分不清「没修过」与「记录丢了」）", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({ scheduler: attributed, onReceipt: (r) => seen.push(r) });
    await eng.execute([TASKS], ".");

    expect(seen[0]!.tasks[0]!.repairs).toBeUndefined();
  });

  it("失败派发的任务带着 outcomeOk=false（不许只靠 status 传达）", async () => {
    const seen: DeliveryReceipt[] = [];
    const failing = {
      async runBatch(tasks: Task[]) {
        return tasks.map((t: Task) => ({
          taskId: t.id, ok: false, logDigest: "boom", events: [], errorClass: "timeout",
        }));
      },
    } as unknown as Scheduler;
    const eng = buildReceiptEngine({
      scheduler: failing, onReceipt: (r) => seen.push(r), verify: async () => makeReport(true),
    });
    await eng.execute([TASKS], ".").catch(() => undefined);

    const t = seen.at(-1)!.tasks[0]!;
    expect(t.status).toBe("failed");
    expect(t.outcomeOk).toBe(false);
    expect(t.errorClass).toBe("timeout");
    // 失败那次也是**真派发过**的 —— 计数与 outcomeOk 必须一起涨，
    // 否则"派发过却像没派发"会让重修预算算错。
    expect(t.attempts).toBeGreaterThanOrEqual(1);
  });

  it("零验证命令的交付要自己说破未经构建/测试验证", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({
      scheduler: attributed,
      // 空 results 在 verifyProject 里恒为 passed —— "全部验证通过"其实什么都没验。
      verify: async () => ({ passed: true, results: [] }),
      onReceipt: (r) => seen.push(r),
    });

    await eng.execute([TASKS], ".");

    expect(seen[0]!.outcome).toBe("delivered");
    expect(seen[0]!.verified).toBe(false);
    expect(seen[0]!.unverifiedReason).toContain("没有配置任何验证命令");
  });

  it("重修预算耗尽发 blocked 凭据，并写明卡在哪", async () => {
    const seen: DeliveryReceipt[] = [];
    // 验证红着（verify 默认 makeReport(true) 是通过的，这里显式改成红）
    const eng = buildReceiptEngine({
      scheduler: alwaysFail,
      maxRounds: 0,
      verify: async () => ({
        passed: false,
        results: [{ kind: "build", ok: false, exitCode: 1, logDigest: "err", durationMs: 10 }],
      }),
      onReceipt: (r) => seen.push(r),
    });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.outcome).toBe("blocked");
    expect(seen[0]!.verified).toBe(false);
    expect(seen[0]!.unverifiedReason).toContain("验证仍未通过");
    expect(seen[0]!.tasks[0]).toMatchObject({ id: "t1", status: "failed" });
  });

  /**
   * **凭据不得自相矛盾**（2026-10-05 运行时观察发现）。
   *
   * 真实 run（`.tmp-runtime.mjs` 观测到的那一次）里同时出现：
   *   checks[0].ok = true      验证命令确实是过的
   *   unverifiedReason = "重修 1 轮后验证仍未通过"
   * 而任务真实死因是 `no-agent` —— 调度器没匹配到执行者，项目文件压根没人动，
   * 基线本来就绿，于是验证**必然**全绿。拿到凭据的人只能二选一地相信。
   *
   * 注意 `alwaysFail` + `makeReport(true)`（验证通过）正是这个形状：
   * 第一版的断言 `toContain("验证仍未通过")` 在这里也是绿的 —— 它**测错了东西**。
   */
  it("验证全绿但任务没做出来：凭据说「任务未完成」，且不得说「验证未通过」", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({ scheduler: alwaysFail, maxRounds: 0, onReceipt: (r) => seen.push(r) });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow();

    const r = seen[0]!;
    expect(r.verified).toBe(false);
    // 不许说"验证仍未通过" —— 那是这份文件里另一段话（checks）直接否掉的
    expect(r.unverifiedReason).not.toContain("验证仍未通过");
    expect(r.unverifiedReason).toContain("任务未能完成");
    // 并且必须点明验证是过的，否则读凭据的人会以为要去查一个根本没红的日志
    expect(r.unverifiedReason).toContain("验证命令全部通过");
  });

  it("凭据的每一句话都要与 checks 一致（不变量：全绿时不得说验证未通过）", async () => {
    // 直接把不变量写成断言，而不是再抄一遍某句文案。
    for (const passed of [true, false]) {
      const seen: DeliveryReceipt[] = [];
      const eng = buildReceiptEngine({
        scheduler: alwaysFail,
        maxRounds: 0,
        verify: async () => ({
          passed,
          results: [{ kind: "build", ok: passed, exitCode: passed ? 0 : 1, logDigest: "err", durationMs: 10 }],
        }),
        onReceipt: (x) => seen.push(x),
      });
      await expect(eng.execute([TASKS], ".")).rejects.toThrow();
      const r = seen[0]!;
      const checksAllGreen = r.checks.every((c) => c.ok);
      const saysVerificationFailed = (r.unverifiedReason ?? "").includes("验证仍未通过");
      // 前提是 checks 非空（否则"全绿"是空集的真，不构成证据）
      expect(r.checks.length, "用例前提：checks 非空").toBeGreaterThan(0);
      expect(checksAllGreen && saysVerificationFailed, `passed=${passed}`).toBe(false);
    }
  });

  it("抛出的错也分得清：验证红着 vs 验证全绿但任务没做出来", async () => {
    // 这条错误会进宿主日志和 SSE 的 error 事件。旧文案只有一种说法，于是
    // "verification still failing" 会与同一份凭据里 ok:true 的 checks 打脸。
    // class 名与 exit code 都不动（它们是协议的一部分），只把话说准。
    const build = (passed: boolean) =>
      buildReceiptEngine({
        scheduler: alwaysFail,
        maxRounds: 0,
        verify: async () => ({
          passed,
          results: [{ kind: "build", ok: passed, exitCode: passed ? 0 : 1, logDigest: "err", durationMs: 10 }],
        }),
        onReceipt: () => undefined,
      });

    // 验证红着：老措辞保留（宿主可能有依赖它的匹配）
    await expect(build(false).execute([TASKS], ".")).rejects.toThrow(/verification still failing/);
    // 验证全绿：不得说 verification failing
    let err: Error | undefined;
    await build(true)
      .execute([TASKS], ".")
      .catch((e: Error) => (err = e));
    expect(err!.message).not.toMatch(/verification still failing/);
    expect(err!.message).toMatch(/verification passed but tasks did not complete/);
    // 两种情形都还是同一个 class —— 退出码语义不变
    expect(err).toBeInstanceOf(VerificationExhaustedError);
    // 且标志位必须如实携带，供宿主分辨
    expect((err as unknown as { verificationFailed: boolean }).verificationFailed).toBe(false);
  });

  /**
   * 引擎**真的**把验证结论递给了 escalation（2026-10-05 反向注入⑤）。
   *
   * `prompts.test.ts` 里那几条是直接调 `buildEscalationSummary` 并自己传
   * `verificationPassed` 的 —— 它们管得住措辞，**管不住连线**：
   * 把 `orchestrator.ts` 里那行 `verificationPassed: report.passed` 改成
   * `false`，上面全部照绿，而真实 run 的弹窗又变回自相矛盾。
   * 这类"参数写了但没人传"的漏洞只有端到端断言抓得到。
   */
  it("escalation 的措辞跟着真实验证结论走（连线，不是参数）", async () => {
    const seen: string[] = [];
    const run = async (passed: boolean) => {
      const eng = buildReceiptEngine({
        scheduler: alwaysFail,
        maxRounds: 0,
        verify: async () => ({
          passed,
          results: [{ kind: "build", ok: passed, exitCode: passed ? 0 : 1, logDigest: "err", durationMs: 10 }],
        }),
        onReceipt: () => undefined,
        requestEscalationDecision: async (_id, summary) => {
          seen.push(summary);
          return "skip";
        },
      });
      await eng.execute([TASKS], ".").catch(() => undefined);
    };

    await run(true);
    await run(false);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const [whenGreen, whenRed] = [seen[0]!, seen[seen.length - 1]!];
    // 验证全绿：不得说"仍未通过验证"
    expect(whenGreen).not.toContain("仍未通过验证");
    expect(whenGreen).toContain("仍未完成");
    // 验证红着：老措辞
    expect(whenRed).toContain("仍未通过验证");
    expect(whenRed).not.toContain("仍未完成");
  });

  it("用户跳过的任务在凭据里记成跳过，而不是完成", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({
      scheduler: alwaysFail,
      maxRounds: 0,
      onReceipt: (r) => seen.push(r),
      requestEscalationDecision: async () => "skip",
    });

    await eng.execute([TASKS], ".");

    // 全部失败任务被跳过、验证通过 ⇒ 仍然交付，但凭据必须说清少做了什么。
    expect(seen[0]!.outcome).toBe("delivered");
    expect(seen[0]!.tasks[0]).toMatchObject({ id: "t1", status: "skipped" });
    expect(seen[0]!.counts.skipped).toBe(1);
    expect(seen[0]!.counts.done).toBe(0);
    // 升级/跳过后的最终交付段（与首轮交付是两个构建点）同样不许冒充"验证通过"。
    expect(seen[0]!.verified).toBe(true);
    expect(seen[0]!.unverifiedReason).toBeUndefined();
  });

  it("验证失败的凭据：checks 的 headline 带失败首行，成功条目刻意留空", async () => {
    // headline 的契约是"为什么失败"：失败条目取 digest 首行，成功条目是空串 ——
    // 两个方向都要钉住，分支互换（失败给空、成功给 digest）才逃不掉。
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({
      scheduler: attributed,
      verify: async () => ({
        passed: false,
        results: [
          { kind: "build", ok: false, exitCode: 1, logDigest: "err", durationMs: 10 },
          { kind: "test", ok: true, exitCode: 0, logDigest: "all green", durationMs: 5 },
        ],
      }),
      maxRounds: 0,
      onReceipt: (r) => seen.push(r),
    });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.outcome).toBe("blocked");
    const build = seen[0]!.checks.find((c) => c.kind === "build")!;
    const test = seen[0]!.checks.find((c) => c.kind === "test")!;
    expect(build.ok).toBe(false);
    expect(build.headline).toBe("err");
    expect(test.ok).toBe(true);
    expect(test.headline).toBe("");
  });

  /**
   * R2「失败必须可归因到责任方」的反例：**不在基线里的失败不得被标成 preexisting**。
   *
   * 归因判据是逐条按 `kind` 匹配基线（`emitReceipt` 的
   * `preexistingKinds.includes(r.kind)`），它回答的是那句关键的话：
   * "这条红是动手前就有的（不是智能体的账），还是这批改动造成的（是它的账）"。
   *
   * 构造：基线只有 `test` 红；交付闸上 `test` 依旧红（**基线噪音**）、
   * `build` 新红（**本次改动造成的真失败**）。两种事实同时在场 —— 任何
   * "整体取反"或"一律标同一值"的写法都会在下面两条断言上露馅。
   *
   * 为什么这是反例而不是重复覆盖：把新失败洗成基线噪音，后果不是日志难看，
   * 而是**修复循环失去目标** —— 引擎会认为"这条红不归任何人"，于是不去修它，
   * 同时凭据对外宣称"其中 N 条本次运行前就是红的"，把智能体写坏的构建说成
   * 目标项目的历史问题。这正是 R2 要挡住的方向。
   */
  it("基线噪音与真失败必须分开：不在基线里的失败不得标成 preexisting（R2）", async () => {
    const seen: DeliveryReceipt[] = [];
    let verifyCalls = 0;
    const eng = buildReceiptEngine({
      scheduler: attributed,
      verify: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          // 基线（动手之前）：只有 test 是红的 —— 这是"不是你的账"那一份
          return {
            passed: false,
            results: [
              { kind: "test", ok: false, exitCode: 1, logDigest: "Cannot find module 'left-pad'", durationMs: 3 },
            ],
          };
        }
        // 交付闸：test 照旧红（基线噪音）+ build 新红（本次改动造成）
        return {
          passed: false,
          results: [
            { kind: "build", ok: false, exitCode: 1, logDigest: "TS2304: Cannot find name 'x'", durationMs: 4 },
            { kind: "test", ok: false, exitCode: 1, logDigest: "Cannot find module 'left-pad'", durationMs: 3 },
          ],
        };
      },
      maxRounds: 0,
      onReceipt: (r) => seen.push(r),
    });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    expect(seen).toHaveLength(1);
    const build = seen[0]!.checks.find((c) => c.kind === "build")!;
    const test = seen[0]!.checks.find((c) => c.kind === "test")!;
    // 决定性断言①：新失败是智能体的账，不许被洗成基线噪音
    expect(build.preexisting).toBe(false);
    // 决定性断言②（反向）：基线里就红的必须照旧标出，否则"不是你的账"这条信息也丢了
    expect(test.preexisting).toBe(true);
    // 汇总只数基线噪音那一条，而不是把所有失败都算上
    expect(seen[0]!.counts.preexisting).toBe(1);
    expect(seen[0]!.counts.checksFailed).toBe(2);
    // ⚠️ 结论行的「本次运行前就是红的」措辞**只在 delivered 分支**（blocked 分支
    // 只讲卡在哪，见 `receiptHeadlineFor`）。所以这里不断 headline —— 归因事实
    // 由上面逐条 checks 的 preexisting 承担，那才是 R2 的承重点。
    expect(seen[0]!.outcome).toBe("blocked");
  });

  it("基线全绿时不谎报任何 preexisting（否则真实归因被噪音淹没）", async () => {
    // 与上一条配对：基线干净时，交付闸上出现的每一条失败都必须是智能体的账。
    const seen: DeliveryReceipt[] = [];
    let verifyCalls = 0;
    const eng = buildReceiptEngine({
      scheduler: attributed,
      verify: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) return makeReport(true); // 基线全绿
        return {
          passed: false,
          results: [
            { kind: "build", ok: false, exitCode: 1, logDigest: "boom", durationMs: 2 },
          ],
        };
      },
      maxRounds: 0,
      onReceipt: (r) => seen.push(r),
    });

    await expect(eng.execute([TASKS], ".")).rejects.toThrow(/repair rounds/);

    expect(seen[0]!.checks.find((c) => c.kind === "build")!.preexisting).toBe(false);
    expect(seen[0]!.counts.preexisting).toBe(0);
    expect(seen[0]!.headline).not.toContain("本次运行前就是红的");
  });

  it("宿主喂进来的越权记录进凭据（引擎自己看不到仲裁层）", async () => {
    const seen: DeliveryReceipt[] = [];
    const eng = buildReceiptEngine({
      scheduler: attributed,
      conflicts: () => [{ kind: "unauthorized-write", paths: ["outside/x.js"], remedy: "revert" }],
      onReceipt: (r) => seen.push(r),
    });

    await eng.execute([TASKS], ".");

    expect(seen[0]!.conflicts).toEqual([
      { kind: "unauthorized-write", paths: ["outside/x.js"], remedy: "revert" },
    ]);
  });

  it("取消的路径不发凭据（现场不完整，发出去会被当成这次的结果）", async () => {
    const seen: DeliveryReceipt[] = [];
    const cancelled = {
      async runBatch() {
        throw new CancelledError();
      },
    } as unknown as Scheduler;
    const eng = buildReceiptEngine({ scheduler: cancelled, onReceipt: (r) => seen.push(r) });

    await expect(eng.execute([TASKS], ".")).rejects.toBeInstanceOf(CancelledError);

    expect(seen).toEqual([]);
  });
});

/**
 * 契约路径合规（2026-10-06 真跑的负结果逼出来的那一层）。
 *
 * 现场形状：规划官把 zone 划成目录 `src/core/csv`，契约点名的却是文件
 * `src/core/csv.js`，于是执行者交 `src/core/csv/index.js` —— zone 合法、等价布局、
 * 契约非法，而 build/typecheck（只做语法检查）与 `node --test`（那时 tests/ 为空）
 * 都看不见它。这组用例钉的是：**点名的文件不在盘上就必须以任务失败的形式回到重修队列，
 * 而这一层没检查的时候要说出来**。
 */
describe("契约路径合规（Stage 3.5）", () => {
  const DRIFT_TASK: Task = {
    id: "t1",
    title: "CSV parser module (src/core/csv.js)",
    description: "Create src/core/csv.js — CommonJS exporting parseCsv(text).",
    zone: "src/core/csv",
    dependencies: [],
    suggestedRole: "backend-dev",
  };

  function driftEngine(opts: {
    exists: (root: string, rel: string) => boolean;
    events: string[];
    status: string[];
  }): OrchestratorEngine {
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: fakeScheduler(false),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 1 },
      fileExists: opts.exists,
    };
    return new OrchestratorEngine(deps, {
      onStage: (s) => opts.events.push(`stage:${s}`),
      onLog: (l) => opts.events.push(`log:${l}`),
      onTaskStatus: (id, st) => opts.status.push(`${id}:${st}`),
      onVerification: () => opts.events.push("verify"),
      onEscalation: () => opts.events.push("escalation"),
    });
  }

  it("点名的文件缺失 ⇒ 任务从 done 翻成 failed，且不带病交付", async () => {
    const events: string[] = [];
    const status: string[] = [];
    // 交付的是目录 + index（漂移），点名的 src/core/csv.js 不存在。
    const eng = driftEngine({
      exists: (_root, rel) => rel === "src/core/csv/index.js",
      events,
      status,
    });
    await expect(eng.execute([[DRIFT_TASK]], ".")).rejects.toThrow(/repair rounds/);
    // 翻转发生在状态回调上：先 done（派发回来了）再 failed（合规判的）。
    expect(status).toContain("t1:done");
    expect(status).toContain("t1:failed");
    // 缺文件 ⇒ 不许进 DELIVERY（这条判据的意义就在"不带病交付"）。
    expect(events).not.toContain("stage:DELIVERY");
    expect(events).not.toContain("stage:DONE");
    const gap = events.find((e) => e.startsWith("log:契约路径合规：1 个任务点名的文件不在盘上"));
    expect(gap).toBeTruthy();
    // 等价布局必须被点名 —— 只说"文件不存在"会把执行者带去改内容。
    expect(String(gap)).toContain("交成了 src/core/csv/index.js");
  });

  it("正向对照：点名的文件真在盘上 ⇒ 正常交付，不翻案", async () => {
    const events: string[] = [];
    const status: string[] = [];
    const eng = driftEngine({
      exists: (_root, rel) => rel === "src/core/csv.js",
      events,
      status,
    });
    const report = await eng.execute([[DRIFT_TASK]], ".");
    expect(report.passed).toBe(true);
    expect(events).toContain("stage:DONE");
    expect(status).not.toContain("t1:failed");
    expect(events.some((e) => e.startsWith("log:契约路径合规：核了 1 条点名路径，缺 0 条"))).toBe(true);
  });

  it("宿主没接探针 ⇒ 当场说出来，而不是安静地给个绿", async () => {
    const events: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: fakeScheduler(false),
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      // 刻意不接 fileExists
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: () => events.push("escalation"),
    });
    await eng.execute([[DRIFT_TASK]], ".");
    expect(events.some((e) => e.includes("fileExists 探针 ⇒ 契约路径合规这一轮**没有执行**"))).toBe(true);
  });

  it("没有可核路径 ⇒ 明说这一层什么都没检查（空转不许当通过）", async () => {
    const events: string[] = [];
    const status: string[] = [];
    const bare: Task = { ...DRIFT_TASK, description: "实现解析器，导出 parseCsv。", zone: "src/core" };
    const eng = driftEngine({ exists: () => false, events, status });
    await eng.execute([[bare]], ".");
    expect(events.some((e) => e.includes("本轮**什么都没检查**"))).toBe(true);
    // 而"什么都没检查"绝不能伪装成"检查过了"：不许出现"核了 N 条"那行。
    expect(events.some((e) => e.startsWith("log:契约路径合规：核了"))).toBe(false);
    expect(status).not.toContain("t1:failed");
  });

  it("本来就失败的任务不被重复判 —— 它自己的根因不能被合规文案顶掉", async () => {
    const events: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[]) {
          return tasks.map((t: Task) => ({ taskId: t.id, ok: false, logDigest: "真根因：429 限流", events: [] }));
        },
      } as unknown as Scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      fileExists: () => false,
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: () => undefined,
      onVerification: () => events.push("verify"),
      onEscalation: (_id, s) => events.push(`escalation:${s}`),
    });
    await expect(eng.execute([[DRIFT_TASK]], ".")).rejects.toThrow(/repair rounds/);
    // 合规层不该再打一条"点名的文件不在盘上"的翻转日志（任务本来就没成功）。
    expect(events.some((e) => e.startsWith("log:契约路径合规：1 个任务点名的文件不在盘上"))).toBe(false);
    // 升级摘要里给用户的必须是真根因，不是合规文案。
    expect(events.some((e) => e.includes("真根因：429 限流"))).toBe(true);
    expect(events.some((e) => e.includes("契约点名的文件不存在"))).toBe(false);
  });
});

/**
 * 变异门禁当场指出的盲区：原用例每轮只喂得进**一条** gap，于是合规循环里
 * `if (!o || !o.ok) continue` 被换成 break 也没人发现 —— 表现是"第一个本来就失败的任务
 * 把后面该翻的任务一起跳过了"，而那恰好是最需要翻转的场景。
 */
describe("契约路径合规 —— 多 gap 时不跳过后续任务", () => {
  const t1: Task = {
    id: "t1",
    title: "core",
    description: "Create src/core/csv.js exporting parseCsv.",
    zone: "src/core/csv",
    dependencies: [],
    suggestedRole: "backend-dev",
  };
  const t2: Task = {
    id: "t2",
    title: "report",
    description: "Create src/report/report.js exporting renderReport.",
    zone: "src/report",
    dependencies: [],
    suggestedRole: "fullstack-dev",
  };

  it("第一个任务本就失败 ⇒ 第二个成功但缺文件的任务仍然被翻", async () => {
    const events: string[] = [];
    const status: string[] = [];
    const deps: OrchestratorDeps = {
      llm: fakeLlm(),
      scheduler: {
        async runBatch(tasks: Task[]) {
          return tasks.map((t: Task) => ({
            taskId: t.id,
            // t1 自己失败了（真根因），t2 报告成功但文件不在盘上。
            ok: t.id !== "t1",
            logDigest: t.id === "t1" ? "真根因：线路超时" : "done",
            events: [],
          }));
        },
      } as unknown as Scheduler,
      verify: async () => makeReport(true),
      settings: { ...DEFAULT_SETTINGS, maxRepairRounds: 0 },
      fileExists: () => false,
    };
    const eng = new OrchestratorEngine(deps, {
      onStage: (s) => events.push(`stage:${s}`),
      onLog: (l) => events.push(`log:${l}`),
      onTaskStatus: (id, st) => status.push(`${id}:${st}`),
      onVerification: () => events.push("verify"),
      onEscalation: (id, s) => events.push(`escalation:${id}:${s}`),
    });
    await expect(eng.execute([[t1, t2]], ".")).rejects.toThrow(/repair rounds/);
    const flip = events.find((e) => e.startsWith("log:契约路径合规：1 个任务点名的文件不在盘上"));
    expect(flip).toBeTruthy();
    // 被翻的是 t2，不是 t1 —— t1 的根因是自己的失败，不该被合规文案顶掉。
    expect(String(flip)).toContain("t2 缺 src/report/report.js");
    expect(String(flip)).not.toContain("t1 缺");
    expect(status).toContain("t2:failed");
  });
});
