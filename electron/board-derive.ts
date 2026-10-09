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
import type { FailureClass, Stage, TaskStatus } from "../shared/types";
import { isFailureClass } from "../shared/types";

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
  errorClass?: FailureClass;
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

/** 一次派发的事实（P1-3 上下文回溯的最小单位）。 */
export interface TrailRun {
  startedAt?: string;
  /** 缺席 = 这次派发**没有收尾**（进程被腰斩 / 重派时前一次还没回来）。 */
  endedAt?: string;
  /** 真正跑完的执行器：来自 run-end，而不是 run-start 的计划值。 */
  agentId?: string;
  ok?: boolean;
  durationMs?: number;
  /**
   * 这次派发为什么失败。
   *
   * ⚠️ 这里已经是**收窄后**的值（2026-10-07）：它是 `FailureClass` 而不是
   * `AuditRecord.errorClass` 那个 `string`。理由与 `DerivedTask` 那一条同源 ——
   * `TrailRun` 不是审计原件的投影，它是**给下一个执行器读的履历**
   * （`trailBriefForRepair` 会把 `${cls} × ${n}` 直接印进 prompt），
   * 未登记的值到了那里就是一个没人认识、也没人登记过的裸 token，
   * 而 LLM 拿它做不出任何判断。收窄就发生在构造这一处（下）。
   */
  errorClass?: FailureClass;
  digest?: string;
}

export interface TaskTrail {
  taskId: string;
  title?: string;
  zone?: string;
  /** 按时间顺序（旧 → 新）的每一次派发。 */
  runs: TrailRun[];
}

/**
 * 一个任务的**运行履历**（P1-3：上下文回溯）。
 *
 * `deriveBoardView` 只给"现在是什么状态"，而这个回答"它经历过什么" —— 重修轮里
 * 同一个任务会被派给不同的执行器，前一次为什么失败（`errorClass` / `digest`）、
 * 换谁重派的，正是"查前任 agent 的决策与改动"要的东西。
 *
 * 配对规则与 `deriveBoardView` 同源（run-start 开、run-end 关）：
 *   · 前一次还没闭合又来了新的 start ⇒ 先把未闭合那条收进履历（事实不能丢），
 *     它**没有 `endedAt`** —— 那是"被腰斩"的唯一诚实表达；
 *   · run-end 早于任何 start（start 被轮转掉了）⇒ 照样算一次派发，只是没有开始时间。
 */
export function taskTrail(records: readonly AuditRecord[], taskId: string): TaskTrail {
  const runs: TrailRun[] = [];
  let title: string | undefined;
  let zone: string | undefined;
  let open: TrailRun | undefined;

  for (const record of records) {
    if (record.taskId !== taskId || !TASK_PHASES.has(record.phase)) continue;
    if (record.title) title = record.title;
    if (record.zone) zone = record.zone;

    if (record.phase === "run-start") {
      if (open) runs.push(open);
      open = {
        startedAt: record.ts,
        ...(record.agentId ? { agentId: record.agentId } : {}),
      };
      continue;
    }

    const base: TrailRun = open ?? {};
    runs.push({
      ...base,
      endedAt: record.ts,
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.ok !== undefined ? { ok: record.ok } : {}),
      ...(record.ok
        ? {}
        : {
            // 与 `DerivedTask.errorClass` 同一处收窄、同一处理由（2026-10-07）：
            // 这段履历是要念给下一个执行器听的，登记外的值念出来就是裸 token。
            errorClass: isFailureClass(record.errorClass) ? record.errorClass : "unknown",
            digest: record.detail ?? "无日志",
          }),
    });
    open = undefined;
  }
  // 尾部仍未闭合 ⇒ 最后一次派发没有收尾（腰斩），照样进履历。
  if (open) runs.push(open);

  return {
    taskId,
    runs,
    ...(title ? { title } : {}),
    ...(zone ? { zone } : {}),
  };
}

/**
 * 把运行履历压成一段给**下一个执行器**读的文本（P1-3 上下文回溯闭环）。
 *
 * 为什么必须有它：重修轮的 `errorLogDigest` 只说"现在哪里错了"，不说"这条路已经走过"。
 * 多agent 系统真正难的不是派发或验证，而是**接力** —— 前任换过谁、哪条路已经证伪。
 * 没有这段，agent 每次重试都从零开始，会反复踩同一个坑（同一个错误类已经失败 3 次，
 * 它却不知道，只看到第 4 次的报错）。
 *
 * 三条纪律：
 *   1. **只讲失败的事**。成功过的尝试没有接力价值 —— 那是已经完成的过去。
 *   2. **按错误类聚合计数**，不逐次罗列。同类失败 3 次说"3 次"，比贴三遍日志有用得多，
 *      也把 prompt 体积与失败次数解耦（连挂 10 次不会撑爆上下文）。
 *   3. **腰斩的派发要单列**。`endedAt` 缺席 = 这次没跑完，原因未知（进程被杀/被重派），
 *      把它混进"失败 N 次"是编造因果，所以只如实说"有 N 次没有收尾"。
 *
 * 返回空串 = 还没有任何失败履历（首轮，或上一轮成功）—— 调用方直接不拼这段。
 */
export function trailBriefForRepair(trail: TaskTrail): string {
  const failed = trail.runs.filter((r) => r.ok !== true);
  if (failed.length === 0) return "";

  const byClass = new Map<string, number>();
  let lastAgent: string | undefined;
  let unfinished = 0;
  for (const r of failed) {
    // 没有 endedAt ⇒ 没跑完，原因不可知，不参与归类。
    if (r.endedAt === undefined) {
      unfinished += 1;
      continue;
    }
    const cls = r.errorClass ?? "unknown";
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    // 最后一个真正跑完的执行器 = "上一任是谁"，比"第一个是谁"有用。
    if (r.agentId !== undefined) lastAgent = r.agentId;
  }

  const lines: string[] = ["[前任履历] 这个任务之前被试过："];
  if (lastAgent !== undefined) lines.push(`- 上一任执行器：${lastAgent}`);
  // 这里不再问"byClass 有没有东西"：能走到这行说明 failed 非空，而腰斩的那些
  // 在上面就 continue 掉了 —— 所以只要有失败收尾，byClass 必然非空。写这个条件
  // 只会造出一个恒真的死分支（反向注入 `> 0` 改 `!== 0` 测不出差别）。
  const total = [...byClass.values()].reduce((a, b) => a + b, 0);
  lines.push(
    `- 已失败 ${total} 次，按原因分：${[...byClass.entries()].map(([cls, n]) => `${cls} × ${n}`).join("、")}`,
  );
  lines.push(`- **不要再重复同一条路**：换思路或换执行器，别把同一类错误再犯一遍。`);
  // 腰斩单列：没有 endedAt ⇒ 没跑完，原因不可知，混进"失败 N 次"是编造因果。
  if (unfinished > 0) {
    lines.push(`- 另有 ${unfinished} 次派发没有收尾（原因未知，可能被中断）—— 不代表它错了。`);
  }
  return lines.join("\n");
}

/**
 * Reduces the audit trail into a board view.
 *
 * Missing-field tolerance is deliberate: older records predate projectId,
 * titles may be absent from rotated-away starts, and a run-end can outlive
 * its run-start. Each rule states what it does in that case — the layer never
 * invents attribution it did not observe.
 */
export function deriveBoardView(records: readonly AuditRecord[]): BoardRecoveryView {
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
    //
    // ⚠️ `errorClass` 在这里**必须收窄**（2026-10-07）。`AuditRecord.errorClass`
    // 是 `string`（审计 JSONL 来自 `JSON.parse(line) as AuditRecord`，
    // 里面可能是旧版本写的、也可能被人手改过），而 `DerivedTask.errorClass`
    // 是 `FailureClass`。旧写法 `record.errorClass ?? "unknown"` 把两者直接接上 ——
    // 未登记的值会一路进到看板的 `Record<FailureClass, string>`，
    // 落到 `ERROR_LABELS[c] ?? c` 那句兜底，界面吐出裸 token。
    // 与 `src/store.ts` 的事件路径是同一个收窄、同一处理由。
    const next: DerivedTask = {
      ...base,
      status: record.ok ? "done" : "failed",
      ...(record.agentId ? { agentId: record.agentId } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.ok
        ? {}
        : {
            errorClass: isFailureClass(record.errorClass) ? record.errorClass : "unknown",
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
