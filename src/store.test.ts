import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "./store";

/**
 * Renderer event mapping is the one layer no other test can reach: it sits
 * between the main process's event stream and the board. Everything the engine
 * computes (agent attribution, failure class, durations) is worthless if this
 * mapping drops it silently — which is exactly what a narrow type declaration
 * did once before.
 *
 * Driven through the store's public surface: no React rendering required.
 */
function reset(): void {
  useApp.setState({
    page: "projects",
    projects: [],
    stage: "PRD",
    logs: [],
    tasks: {},
    escalations: [],
    verification: undefined,
    planning: false,
    planningError: undefined,
  });
}

const emit = (payload: Record<string, unknown>) => useApp.getState().handleEvent(payload);

beforeEach(reset);

describe("handleEvent · stage", () => {
  it("moves the pipeline stage and journals it", () => {
    emit({ type: "stage", stage: "DEVELOPMENT" });
    const s = useApp.getState();
    expect(s.stage).toBe("DEVELOPMENT");
    expect(s.logs.at(-1)).toContain("DEVELOPMENT");
  });
});

describe("handleEvent · log", () => {
  it("appends lines", () => {
    emit({ type: "log", text: "第一行" });
    emit({ type: "log", text: "第二行" });
    expect(useApp.getState().logs).toEqual(["第一行", "第二行"]);
  });

  it("keeps the buffer bounded", () => {
    for (let i = 0; i < 520; i++) emit({ type: "log", text: `line-${i}` });
    const logs = useApp.getState().logs;
    expect(logs.length).toBeLessThanOrEqual(501);
    expect(logs.at(-1)).toBe("line-519");
  });

  it("coerces a non-string payload instead of throwing", () => {
    emit({ type: "log", text: 42 });
    expect(useApp.getState().logs).toEqual(["42"]);
  });
});

describe("handleEvent · taskStatus", () => {
  it("creates a task view from the first status event", () => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "实现解析器", zone: "src/core" });
    expect(useApp.getState().tasks["t1"]).toMatchObject({
      taskId: "t1",
      title: "实现解析器",
      zone: "src/core",
      status: "running",
      attempts: 1,
    });
  });

  it("falls back to the id when no title has been seen yet", () => {
    emit({ type: "taskStatus", taskId: "t9", status: "queued", attempts: 1 });
    expect(useApp.getState().tasks["t9"]!.title).toBe("t9");
    expect(useApp.getState().tasks["t9"]!.zone).toBe("");
  });

  it("keeps title and zone across later status events", () => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
    emit({ type: "taskStatus", taskId: "t1", status: "done", attempts: 1 });
    expect(useApp.getState().tasks["t1"]).toMatchObject({ title: "T", zone: "src", status: "done" });
  });

  it("keeps attribution across a repair-round re-dispatch", () => {
    // Round 1 fails with full attribution.
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
    emit({
      type: "taskOutcome",
      taskId: "t1",
      ok: false,
      logDigest: "boom",
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 900,
    });
    // Round 2 re-dispatches: `running` arrives again, carrying no attribution.
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 2 });
    const t = useApp.getState().tasks["t1"]!;
    expect(t).toMatchObject({
      status: "running",
      attempts: 2,
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 900,
      failureDigest: "boom",
    });
  });
});

describe("handleEvent · taskOutcome", () => {
  beforeEach(() => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
  });

  it("carries agent attribution, duration and failure class (P5 payload)", () => {
    emit({
      type: "taskOutcome",
      taskId: "t1",
      ok: false,
      logDigest: "看门狗触发（空闲无输出）",
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 1234,
    });
    expect(useApp.getState().tasks["t1"]).toMatchObject({
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 1234,
      failureDigest: "看门狗触发（空闲无输出）",
    });
  });

  it("keeps attribution on success but clears the failure state", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false, logDigest: "boom", errorClass: "protocol" });
    emit({ type: "taskOutcome", taskId: "t1", ok: true, agentId: "trae-cli", durationMs: 20 });
    const t = useApp.getState().tasks["t1"]!;
    expect(t.failureDigest).toBeUndefined();
    expect(t.errorClass).toBeUndefined();
    expect(t.agentId).toBe("trae-cli");
    expect(t.durationMs).toBe(20);
  });

  it("substitutes a placeholder when a failure carries no digest", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false });
    expect(useApp.getState().tasks["t1"]!.failureDigest).toBe("无日志");
  });

  it("defaults an unclassifiable failure to 'unknown'", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false, logDigest: "boom" });
    expect(useApp.getState().tasks["t1"]!.errorClass).toBe("unknown");
  });

  it("ignores an outcome for a task it has never seen", () => {
    const before = useApp.getState().tasks;
    emit({ type: "taskOutcome", taskId: "ghost", ok: false, logDigest: "boom" });
    expect(useApp.getState().tasks).toBe(before);
  });
});

describe("handleEvent · verification and escalation", () => {
  it("stores the latest verification report", () => {
    const report = { passed: false, results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "x", durationMs: 1 }] };
    emit({ type: "verification", report });
    expect(useApp.getState().verification).toEqual(report);
    expect(useApp.getState().logs.at(-1)).toContain("硬性验证");
  });

  it("adds an escalation once per task", () => {
    emit({ type: "escalation", taskId: "t1", summary: "第一次" });
    emit({ type: "escalation", taskId: "t1", summary: "第二次" });
    const escalations = useApp.getState().escalations;
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ taskId: "t1", summary: "第二次", resolved: false });
  });

  it("keeps escalations for different tasks side by side", () => {
    emit({ type: "escalation", taskId: "t1", summary: "a" });
    emit({ type: "escalation", taskId: "t2", summary: "b" });
    expect(useApp.getState().escalations.map((e) => e.taskId)).toEqual(["t1", "t2"]);
  });
});

describe("handleEvent · robustness", () => {
  it("ignores unknown event types without touching state", () => {
    emit({ type: "log", text: "before" });
    const snapshot = useApp.getState();
    emit({ type: "some-future-event", payload: 1 });
    const after = useApp.getState();
    expect(after.logs).toEqual(snapshot.logs);
    expect(after.stage).toBe(snapshot.stage);
    expect(after.tasks).toEqual(snapshot.tasks);
  });

  it("survives a payload with no type at all", () => {
    expect(() => emit({})).not.toThrow();
  });
});
