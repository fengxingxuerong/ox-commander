/**
 * Board-recovery derive layer (facts/derived split, learnings from AO).
 *
 * The audit JSONL is the durable fact store; this module is the pure
 * "events → state" reduction that rebuilds the board view from those facts.
 * It has no IO and no clock: same records in, same view out — which makes it
 * exactly the shape the mutation gate likes to attack, and makes the recovered
 * view reproducible.
 *
 * Why this exists: the board used to be fed only by in-memory engine pushes,
 * so a reload (or a killed process tree — the --real drills lost two rounds
 * to exactly that) left the operator staring at a blank board with no memory
 * of what the last run had achieved. Facts survive in the audit trail; the
 * view is derived, never stored.
 *
 * Contract: records are consumed in the order given (AuditLog.read() returns
 * oldest first, i.e. append order). The layer never sorts — reordering is the
 * caller's concern, and a stable view must follow the trail's own order.
 */
import type { AuditRecord } from "./audit-log";
import type { DeliveryReceipt } from "../shared/delivery-receipt";
import type { Stage, TaskStatus } from "../shared/types";

/**
 * One task's view as derived from run facts. Structurally identical to the
 * renderer's `TaskView`; kept as a separate type so the derive layer does not
 * depend on renderer typings.
 */
export interface DerivedTask {
  taskId: string;
  title: string;
  zone: string;
  status: TaskStatus;
  /** Number of observed run-starts — "attempts" in the trail's own terms. */
  attempts: number;
  /** Failure digest from the most recent failed run (redacted at write time). */
  failureDigest?: string;
  /** Which agent actually finished the last run (from run-end, not run-start). */
  agentId?: string;
  /** Coarse failure class from the last run, for grouping. */
  errorClass?: string;
  /** Duration of the last run. */
  durationMs?: number;
}

export interface BoardRecoveryView {
  tasks: Record<string, DerivedTask>;
  /** Last observed pipeline stage, if any stage fact exists. */
  stage?: Stage;
  /** The most recent delivery receipt, if a receipt fact exists. */
  receipt?: DeliveryReceipt;
  /**
   * True when some task's last fact is a run-start with no matching run-end:
   * the process died mid-run (crash, killed tree, power loss). A clean
   * cancel/failure always writes run-end, so this flag means "the trail ends
   * mid-sentence".
   */
  interrupted: boolean;
  /** ts of the last recovery-relevant fact, for a "last seen" line. */
  lastActivityTs?: string;
}

/** Phases that carry board state; everything else (settings, guards) is noise here. */
const TASK_PHASES = new Set(["run-start", "run-end"]);

/**
 * Reduces the audit trail into a board view.
 *
 * Missing-field tolerance is deliberate: older records predate projectId,
 * titles may be absent from rotated-away starts, and a run-end can outlive
 * its run-start. Each rule states what it does in that case — the layer never
 * invents attribution it did not observe.
 */
export function deriveBoardView(records: AuditRecord[]): BoardRecoveryView {
  const tasks: Record<string, DerivedTask> = {};
  let stage: Stage | undefined;
  let receipt: DeliveryReceipt | undefined;
  let lastActivityTs: string | undefined;
  /** taskId -> whether the last seen fact for it is an unmatched run-start. */
  const open = new Set<string>();

  for (const record of records) {
    if (record.phase === "stage" && record.stage) {
      stage = record.stage;
      lastActivityTs = record.ts;
      continue;
    }
    if (record.phase === "receipt" && record.receipt) {
      receipt = record.receipt;
      lastActivityTs = record.ts;
      continue;
    }
    if (!TASK_PHASES.has(record.phase) || !record.taskId) continue;
    lastActivityTs = record.ts;

    const prev = tasks[record.taskId];
    if (record.phase === "run-start") {
      open.add(record.taskId);
      tasks[record.taskId] = {
        // Spread prev first: a repair round re-dispatches the task — wiping
        // attribution here would erase "who ran it, how long, why it failed".
        ...prev,
        taskId: record.taskId,
        title: record.title ?? prev?.title ?? record.taskId,
        zone: record.zone ?? prev?.zone ?? "",
        status: "running",
        attempts: (prev?.attempts ?? 0) + 1,
      };
      continue;
    }

    // run-end: closes the start, whatever the outcome.
    open.delete(record.taskId);
    // A run-end without a seen run-start still proves one attempt happened
    // (the start was simply rotated away or written by an older version);
    // title/zone fall back to what the end itself carries.
    const base: DerivedTask = prev ?? {
      taskId: record.taskId,
      title: record.taskId,
      zone: record.zone ?? "",
      status: "pending",
      attempts: 1,
    };
    // Optional fields follow the audit's own contract: a field that is absent
    // must not appear as a key at all (`"agentId" in obj === false`).
    const next: DerivedTask = {
      ...base,
      status: record.ok ? "done" : "failed",
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.ok
        ? {}
        : {
            errorClass: record.errorClass ?? "unknown",
            failureDigest: record.detail ?? "无日志",
          }),
    };
    if (record.ok) {
      // A task can fail and later succeed in a repair round: the board must
      // not keep showing a stale error next to a green task.
      delete next.errorClass;
      delete next.failureDigest;
    }
    tasks[record.taskId] = next;
  }

  return {
    tasks,
    ...(stage ? { stage } : {}),
    ...(receipt ? { receipt } : {}),
    interrupted: open.size > 0,
    ...(lastActivityTs ? { lastActivityTs } : {}),
  };
}
