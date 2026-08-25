import { describe, expect, it } from "vitest";
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

  it("repair loop retries failed tasks then passes", async () => {
    const events: string[] = [];
    const eng = engine({ failFirstRound: true, maxRounds: 3, events });
    const report = await eng.execute([TASKS], ".");
    expect(report.passed).toBe(true);
    expect(events.some((e) => e.includes("重修第 1"))).toBe(true);
    expect(events.filter((e) => e.startsWith("task:t1:running"))).toHaveLength(2);
  });
});
