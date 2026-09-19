import type { LlmClient } from "../../shared/llm-client";
import { chatJson, withCooldownRetry } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { parsePrd, parseTaskList } from "../../shared/schema";
import { planBatches } from "../../shared/graph";
import { routeVerificationErrors } from "../../shared/routing";
import type { DispatchOutcome } from "./scheduler";
import type {
  EscalationAction,
  PrdDocument,
  ProjectSettings,
  Stage,
  Task,
  TaskStatus,
  VerificationReport,
} from "../../shared/types";

export interface OrchestratorDeps {
  llm: LlmClient;
  scheduler: import("./scheduler").Scheduler;
  verify: (cwd: string) => Promise<VerificationReport>;
  settings: ProjectSettings;
}

export interface OrchestratorCallbacks {
  onStage(stage: Stage): void;
  onLog(text: string): void;
  onTaskStatus(taskId: string, status: TaskStatus, attempts: number): void;
  onVerification(report: VerificationReport): void;
  /**
   * Fired when a task's run finishes; carries the failure digest plus the run's
   * attribution (which agent, how long, how it failed). The extra argument is
   * optional so existing 3-argument callers keep working.
   */
  onTaskOutcome?(
    taskId: string,
    ok: boolean,
    logDigest: string,
    meta?: { agentId?: string; errorClass?: string; durationMs?: number },
  ): void;
  /**
   * Fired when repair rounds are exhausted. When provided, the engine waits
   * for the returned decision instead of aborting; omit it to keep the old
   * fail-fast behaviour.
   */
  onEscalation(taskId: string, summary: string): void;
  requestEscalationDecision?(taskId: string, summary: string): Promise<EscalationAction>;
}

export class CancelledError extends Error {
  constructor() {
    super("orchestration cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Repair rounds ran out while verification still failed.
 *
 * A dedicated class (rather than a bare `Error`) so hosts can tell
 * "spent the budget" apart from "something broke" — the headless protocol maps
 * this to exit code 2 instead of 1. The message keeps the historic wording.
 */
export class VerificationExhaustedError extends Error {
  constructor(public readonly maxRounds: number) {
    super(`verification still failing after ${maxRounds} repair rounds`);
    this.name = "VerificationExhaustedError";
  }
}

/**
 * Fixed six-stage skeleton; inside PLANNING and repair rounds the LLM may
 * freely shape content, but stage transitions are code-controlled.
 */
export class OrchestratorEngine {
  private cancelled = false;
  private paused = false;

  constructor(private deps: OrchestratorDeps, private cb: OrchestratorCallbacks) {}

  cancel(): void {
    this.cancelled = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  private async gate(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.cancelled) throw new CancelledError();
  }

  /**
   * Brain-layer call with cooldown-aware retry: "all failover combos cooling"
   * is a transient provider-wide condition, not a permanent failure, so we park
   * the call for the cooldown window and retry instead of killing the pipeline.
   */
  private async brainCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return withCooldownRetry(fn, {
      shouldStop: () => this.cancelled,
      onWait: (ms, n) =>
        this.cb.onLog(
          `${what}：全部 LLM 路由冷却中，第 ${n} 次等待约 ${Math.ceil(ms / 1000)}s 后重试`,
        ),
    });
  }

  async generatePrd(userRequirement: string): Promise<PrdDocument> {
    this.cb.onStage("PRD");
    const prd = await this.brainCall(
      "PRD 生成",
      () =>
        chatJson(
          this.deps.llm,
          { messages: [{ role: "user", content: buildPrdPrompt(userRequirement) }] },
          { schemaName: "PRD", validate: parsePrd },
        ),
    );
    return prd;
  }

  async decompose(prd: PrdDocument): Promise<Task[][]> {
    this.cb.onStage("PLANNING");
    const tasks = await this.brainCall(
      "任务分解",
      () =>
        chatJson(
          this.deps.llm,
          { messages: [{ role: "user", content: buildDecomposePrompt(prd) }] },
          { schemaName: "task list", validate: parseTaskList },
        ),
    );
    return planBatches(tasks);
  }

  /** Runs DEVELOPMENT → VERIFICATION (+ repair loops) → DELIVERY. */
  async execute(batches: Task[][], projectRoot: string): Promise<VerificationReport> {
    const maxRounds = this.deps.settings.maxRepairRounds;
    const attempts = new Map<string, number>();
    const allDone = new Set<string>();
    // Skipped-by-user tasks count as done so their dependents can proceed.
    const skipped = new Set<string>();
    // Extra rounds granted by the user via "redispatch" escalation decisions.
    let extraRounds = 0;

    this.cb.onStage("DEVELOPMENT");
    let lastDigest = "";
    /** Per-task digests routed by zone from the last verification report. */
    let routedByTask = new Map<string, string>();
    let outcomes: DispatchOutcome[] = [];
    let lastFailedLogs = new Map<string, string>();
    let round = 0;
    while (round <= maxRounds + extraRounds) {
      await this.gate();
      const isRepair = round > 0;
      if (isRepair) {
        this.cb.onLog(`── 重修第 ${round}/${maxRounds + extraRounds} 轮 ──`);
        if (outcomes.every((o) => o.ok)) {
          // Verification failed with no failed dev task: workspace was broken
          // externally or integration regressed. Re-run everything.
          allDone.clear();
          outcomes = [];
          this.cb.onLog("验证未过但无失败任务，判定工作区受损/集成回归，全员重跑。");
        }
      }

      for (const [bi, batch] of batches.entries()) {
        await this.gate();
        const pending = batch.filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
        if (pending.length === 0) continue;
        for (const t of pending) {
          attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
          this.cb.onTaskStatus(t.id, "running", attempts.get(t.id)!);
        }
        // Route verification errors to the zone that owns the failing files:
        // each task only sees the errors it is responsible for (plus any
        // unattributable ones), instead of the whole digest.
        const repairOf = isRepair
          ? new Map(
              pending.map((t) => [
                t.id,
                {
                  round,
                  errorLogDigest: [
                    routedByTask.get(t.id) ?? lastDigest,
                    lastFailedLogs.get(t.id) ? `[该任务上次失败日志] ${lastFailedLogs.get(t.id)}` : "",
                  ]
                    .filter((s) => s !== "")
                    .join("\n\n"),
                },
              ]),
            )
          : undefined;
        const batchOutcomes = await this.deps.scheduler.runBatch(pending, projectRoot, { repairOf });
        const byId = new Map(outcomes.map((o) => [o.taskId, o]));
        for (const o of batchOutcomes) byId.set(o.taskId, o);
        outcomes = [...byId.values()];
        // Merge (not overwrite): batches run in sequence and an earlier batch's
        // failure log must survive into the next round's repair context.
        for (const o of batchOutcomes) {
          if (!o.ok) lastFailedLogs.set(o.taskId, o.logDigest);
          else lastFailedLogs.delete(o.taskId);
        }
        for (const o of batchOutcomes) {
          if (o.ok) {
            allDone.add(o.taskId);
            this.cb.onTaskStatus(o.taskId, "done", attempts.get(o.taskId)!);
          } else {
            this.cb.onTaskStatus(o.taskId, "failed", attempts.get(o.taskId)!);
          }
          this.cb.onTaskOutcome?.(o.taskId, o.ok, o.logDigest, {
            ...(o.agentId ? { agentId: o.agentId } : {}),
            ...(o.errorClass ? { errorClass: o.errorClass } : {}),
            ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
          });
        }
        this.cb.onLog(`批次 ${bi + 1}/${batches.length} 完成：${batchOutcomes.filter((o) => o.ok).length}/${batchOutcomes.length} 成功`);
      }

      // Stage 4: hard verification gates delivery.
      this.cb.onStage("VERIFICATION");
      await this.gate();
      const anyDevFailure = outcomes.some((o) => !o.ok);
      const report = await this.deps.verify(projectRoot);
      this.cb.onVerification(report);
      if (!anyDevFailure && report.passed) {
        this.cb.onStage("DELIVERY");
        const skippedNote = skipped.size > 0 ? `（用户跳过 ${skipped.size} 个任务）` : "";
        this.cb.onLog(`全部验证通过，进入交付。${skippedNote}`);
        this.cb.onStage("DONE");
        return report;
      }
      if (anyDevFailure && report.passed) {
        this.cb.onLog("警告：存在失败的开发任务，即使构建通过也不允许交付。");
      }

      // Route errors per zone for the next repair round.
      const pendingNow = batches.flat().filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
      const routed = routeVerificationErrors(report, pendingNow, projectRoot);
      routedByTask = routed.byTask;
      lastDigest = routed.unattributed;
      if (!lastDigest) {
        lastDigest =
          [...lastFailedLogs.values()].join("\n\n") ||
          "开发任务执行失败（无验证错误，可能是 API 调用失败）";
      }

      const exhausted = round === maxRounds + extraRounds;
      if (exhausted) {
        const failedTasks = batches.flat().filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
        for (const t of failedTasks) {
          const summary = buildEscalationSummary({
            taskTitle: t.title,
            attemptsSoFar: attempts.get(t.id) ?? round + 1,
            maxRepairRounds: maxRounds,
            lastErrorDigest: routed.byTask.get(t.id) ?? lastDigest,
          });
          this.cb.onEscalation(t.id, summary);

          if (this.cb.requestEscalationDecision) {
            const decision = await this.cb.requestEscalationDecision(t.id, summary);
            if (decision === "abort") {
              throw new Error(`用户终止：任务「${t.title}」重修 ${attempts.get(t.id) ?? round + 1} 轮后仍未通过`);
            }
            if (decision === "skip") {
              skipped.add(t.id);
              allDone.add(t.id);
              this.cb.onLog(`用户跳过任务「${t.title}」，不再重试。`);
              continue;
            }
            // redispatch: grant one more round and reset this task's failure log.
            extraRounds += 1;
            this.cb.onLog(`用户要求重派任务「${t.title}」，追加一轮修复。`);
          }
        }

        if (this.cb.requestEscalationDecision) {
          const stillFailing = batches
            .flat()
            .some((t) => !allDone.has(t.id) && !skipped.has(t.id));
          if (!stillFailing) {
            // Everything was skipped; deliver only if verification now passes.
            const finalReport = await this.deps.verify(projectRoot);
            this.cb.onVerification(finalReport);
            if (finalReport.passed) {
              this.cb.onStage("DELIVERY");
              this.cb.onStage("DONE");
              return finalReport;
            }
            throw new Error("所有失败任务已被跳过，但验证仍未通过");
          }
          round += 1;
          continue;
        }

        throw new VerificationExhaustedError(maxRounds);
      }
      round += 1;
    }
    throw new Error("unreachable");
  }
}
