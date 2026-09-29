import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../electron/audit-log";
import { deriveBoardView } from "../electron/board-derive";
import type { DeliveryReceipt } from "../shared/delivery-receipt";

/**
 * Behavioural lock for the board-recovery derive layer (facts/derived split).
 *
 * The audit trail is the durable fact store; these tests pin how the view is
 * reduced from it — including the interrupted semantics that motivated the
 * feature (a killed process tree leaves a run-start with no matching run-end,
 * and the board must say so instead of showing a blank board).
 */

const start = (over: Partial<AuditRecord>): AuditRecord => ({
  ts: "2026-09-29T10:00:00.000Z",
  phase: "run-start",
  taskId: "t1",
  ...over,
});

const end = (over: Partial<AuditRecord>): AuditRecord => ({
  ts: "2026-09-29T10:01:00.000Z",
  phase: "run-end",
  taskId: "t1",
  ok: true,
  ...over,
});

const receipt = (over: Partial<DeliveryReceipt>): DeliveryReceipt =>
  ({
    runId: "r1",
    outcome: "delivered",
    headline: "3/3 完成",
    counts: { total: 3, done: 3, failed: 0, skipped: 0, pending: 0 },
    checks: [],
    conflicts: [],
    tasks: [],
    rounds: 0,
    ...over,
  }) as unknown as DeliveryReceipt;

describe("deriveBoardView", () => {
  it("returns an empty view for an empty trail", () => {
    expect(deriveBoardView([])).toEqual({ tasks: {}, interrupted: false });
  });

  it("derives a done task with full attribution from a start/end pair", () => {
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", title: "登录页", zone: "src/auth", agentId: "planned" }),
      end({ taskId: "t1", ok: true, agentId: "actual", durationMs: 4200 }),
    ]);
    expect(view.tasks.t1).toEqual({
      taskId: "t1",
      title: "登录页",
      zone: "src/auth",
      status: "done",
      attempts: 1,
      agentId: "actual",
      durationMs: 4200,
    });
    // Actual attribution wins over the planned one recorded at run-start.
    expect(view.tasks.t1?.agentId).toBe("actual");
    expect(view.interrupted).toBe(false);
    expect(view.lastActivityTs).toBe("2026-09-29T10:01:00.000Z");
  });

  it("derives a failed task with error class and digest", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", title: "登录页", zone: "src/auth" }),
      end({ taskId: "t1", ok: false, errorClass: "rate-limit", detail: "429 rate limited" }),
    ]);
    expect(view.tasks.t1).toMatchObject({
      status: "failed",
      errorClass: "rate-limit",
      failureDigest: "429 rate limited",
      attempts: 1,
    });
  });

  it("keeps attempts across repair rounds and clears stale failure marks on success", () => {
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", title: "登录页", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: false, errorClass: "timeout", detail: "boom" }),
      start({ ts: "2026-09-29T10:02:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:03:00.000Z", taskId: "t1", ok: true, agentId: "a2", durationMs: 100 }),
    ]);
    const task = view.tasks.t1!;
    expect(task.status).toBe("done");
    expect(task.attempts).toBe(2);
    expect("errorClass" in task).toBe(false);
    expect("failureDigest" in task).toBe(false);
    expect(task.agentId).toBe("a2");
    // Title survives from the first start even if the retry start omits it.
    expect(task.title).toBe("登录页");
  });

  it("marks the trail interrupted when a run-start has no matching run-end", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", title: "A", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      start({ ts: "2026-09-29T10:02:00.000Z", taskId: "t2", title: "B", zone: "z" }),
    ]);
    expect(view.interrupted).toBe(true);
    // The killed run is shown as still-running: that is the last fact known.
    expect(view.tasks.t2).toMatchObject({ status: "running", attempts: 1 });
    expect(view.tasks.t1).toMatchObject({ status: "done" });
  });

  it("un-marks interrupted once a later run-end closes the start", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", zone: "z" }),
      end({ taskId: "t1", ok: false, errorClass: "timeout" }),
    ]);
    expect(view.interrupted).toBe(false);
  });

  it("derives stage and receipt from their facts, last one wins", () => {
    const r = receipt({ outcome: "blocked", headline: "1/3 完成" });
    const view = deriveBoardView([
      { ts: "2026-09-29T10:00:00.000Z", phase: "stage", stage: "DEVELOPMENT" },
      { ts: "2026-09-29T10:01:00.000Z", phase: "stage", stage: "VERIFICATION" },
      { ts: "2026-09-29T10:02:00.000Z", phase: "receipt", receipt: r },
      // A run fact after the receipt: the stage/receipt branches must hand
      // control back (continue), not stop the trail (break) — a receipt that
      // ends the reduction would silently drop everything after it.
      start({ ts: "2026-09-29T10:03:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:04:00.000Z", taskId: "t1", ok: true }),
    ]);
    expect(view.stage).toBe("VERIFICATION");
    expect(view.receipt?.headline).toBe("1/3 完成");
    expect(view.tasks.t1).toMatchObject({ status: "done" });
    expect(view.lastActivityTs).toBe("2026-09-29T10:04:00.000Z");
  });

  it("ignores noise phases and records without a taskId", () => {
    const view = deriveBoardView([
      { ts: "2026-09-29T10:00:00.000Z", phase: "settings", detail: " saved" },
      { ts: "2026-09-29T10:00:01.000Z", phase: "batch-guard", changed: 3, paths: ["a"] },
      { ts: "2026-09-29T10:00:02.000Z", phase: "agent-change", agentId: "x", detail: "enabled" },
    ]);
    expect(view.tasks).toEqual({});
    expect(view.stage).toBeUndefined();
    expect(view.interrupted).toBe(false);
    // Nothing recovery-relevant happened, so no activity stamp either.
    expect(view.lastActivityTs).toBeUndefined();
  });

  it("malformed stage/receipt facts change neither the view nor the activity stamp", () => {
    // The writers always attach the payload, but a truncated or future-happy
    // record must degrade to "not a fact" — not to "a fact of nothing" that
    // still moves lastActivityTs forward.
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      { ts: "2026-09-29T10:02:00.000Z", phase: "stage" },
      { ts: "2026-09-29T10:03:00.000Z", phase: "receipt" },
    ]) as unknown as Record<string, unknown>;
    expect("stage" in view).toBe(false);
    expect("receipt" in view).toBe(false);
    // The malformed tail must not pretend the trail was active up to 10:03.
    expect(view.lastActivityTs).toBe("2026-09-29T10:01:00.000Z");
  });

  it("a noise phase carrying a taskId stays noise, and later facts still count", () => {
    // settings records can carry a taskId (the writer attaches context); the
    // noise filter must ignore them regardless, and must keep consuming the
    // trail afterwards — both a swapped filter and an early stop would here
    // either corrupt t1 or silently drop t2.
    const view = deriveBoardView([
      start({ ts: "2026-09-29T10:00:00.000Z", taskId: "t1", zone: "z" }),
      end({ ts: "2026-09-29T10:01:00.000Z", taskId: "t1", ok: true }),
      { ts: "2026-09-29T10:02:00.000Z", phase: "settings", taskId: "t1", detail: " saved" },
      start({ ts: "2026-09-29T10:03:00.000Z", taskId: "t2", zone: "z" }),
      end({ ts: "2026-09-29T10:04:00.000Z", taskId: "t2", ok: true }),
    ]);
    expect(view.tasks.t1).toMatchObject({ status: "done" });
    expect(view.tasks.t2).toMatchObject({ status: "done" });
    expect(view.lastActivityTs).toBe("2026-09-29T10:04:00.000Z");
  });

  it("derives a task from a run-end alone when the start was rotated away", () => {
    const view = deriveBoardView([end({ taskId: "t9", ok: true })]);
    expect(view.tasks.t9).toEqual({
      taskId: "t9",
      title: "t9",
      zone: "",
      status: "done",
      attempts: 1,
    });
  });

  it("omits optional keys entirely when the facts lack them", () => {
    const view = deriveBoardView([
      start({ taskId: "t1", zone: "z", title: "T" }),
      end({ taskId: "t1", ok: true }),
    ]);
    const task = view.tasks.t1 as unknown as Record<string, unknown>;
    // Same contract as the audit writer: absent fact → absent key.
    expect("agentId" in task).toBe(false);
    expect("durationMs" in task).toBe(false);
    expect("failureDigest" in task).toBe(false);
    expect("errorClass" in task).toBe(false);
    // And the view-level optionals stay absent when no such facts exist —
    // but a run-start IS an activity fact, so lastActivityTs must be present.
    const bare = deriveBoardView([start({ taskId: "t1", zone: "z" })]) as unknown as Record<string, unknown>;
    expect("stage" in bare).toBe(false);
    expect("receipt" in bare).toBe(false);
    expect(bare.lastActivityTs).toBe("2026-09-29T10:00:00.000Z");
    const noise = deriveBoardView([
      { ts: "2026-09-29T11:00:00.000Z", phase: "settings", detail: "x" },
    ]) as unknown as Record<string, unknown>;
    expect("lastActivityTs" in noise).toBe(false);
  });
});
