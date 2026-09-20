import type { LlmClient } from "../../shared/llm-client";
import { chatJson, withCooldownRetry } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { parseDecompose, parsePrd, SchemaValidationError } from "../../shared/schema";
import { findOrphanPaths, describeZoneGaps, verificationCommandPaths } from "../../shared/zone-coverage";
import { runSmokeChecks } from "./verifier";
import type { SmokeCheck } from "../../shared/types";
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
  VerificationCommand,
  VerificationReport,
} from "../../shared/types";

export interface OrchestratorDeps {
  llm: LlmClient;
  scheduler: import("./scheduler").Scheduler;
  verify: (cwd: string) => Promise<VerificationReport>;
  settings: ProjectSettings;
  /**
   * 断点续跑日志（可选）：宿主持久化快照，engine 在计划完成、每个批次结束、
   * 每轮升级处理完成时调用 save。宿主重启后把快照经 execute 的 resume 参数喂回。
   */
  journal?: { save(snapshot: RunSnapshot): void };
}

/** 断点续跑快照：足以在全新进程里恢复一轮 execute 的全部进度状态。 */
export interface RunSnapshot {
  batches: Task[][];
  smoke?: SmokeCheck[];
  allDone: string[];
  skipped: string[];
  attempts: Record<string, number>;
  round: number;
  extraRounds: number;
  lastDigest: string;
}

/** execute 的恢复入参：RunSnapshot 去掉 batches（batches 由宿主直接传入）。 */
export interface ResumeState {
  smoke?: SmokeCheck[];
  allDone: string[];
  skipped: string[];
  attempts: Record<string, number>;
  round: number;
  extraRounds: number;
  lastDigest: string;
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

/** True when a rejected promise is the orchestrator's own cancel signal. */
export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError || (err as { name?: string } | null)?.name === "CancelledError";
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
  /** Tasks currently dispatched (status `running`); drives the cancel sweep. */
  private readonly inFlight = new Set<string>();
  /** Last attempt number emitted per task, reused by the cancel sweep. */
  private readonly attemptsSeen = new Map<string, number>();

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

  /**
   * `verificationCommands` is optional: passing it extends the zone-coverage
   * guard to paths the host's verify step references. A verify command naming a
   * file that no task's zone owns cannot be satisfied by any repair round —
   * better to fail here than after three identical rounds.
   */
  async decompose(
    prd: PrdDocument,
    verificationCommands?: readonly VerificationCommand[],
  ): Promise<{ batches: Task[][]; smoke: SmokeCheck[] }> {
    this.cb.onStage("PLANNING");
    const plan = await this.brainCall(
      "任务分解",
      () =>
        chatJson(
          this.deps.llm,
          { messages: [{ role: "user", content: buildDecomposePrompt(prd) }] },
          { schemaName: "decompose plan", validate: parseDecompose },
        ),
    );
    // Refuse a plan that cannot satisfy the PRD. A declared artifact owned by no
    // zone is un-writable, so verification would fail forever while the repair
    // loop burned its whole budget on an impossible task. Failing here costs one
    // decompose call; failing later costs a full run and reports the wrong cause.
    this.assertZoneCoverage(prd, plan.tasks, verificationCommands);
    return { batches: planBatches(plan.tasks), smoke: plan.smoke };
  }

  private assertZoneCoverage(
    prd: PrdDocument,
    tasks: readonly Task[],
    verificationCommands?: readonly VerificationCommand[],
  ): void {
    const gaps = findOrphanPaths(
      prd,
      tasks,
      undefined,
      verificationCommandPaths(verificationCommands ?? []),
    );
    if (gaps.length === 0) return;
    const message = `以下路径不属于任何 zone，写入必被沙箱拒绝、重修不可能成功：${describeZoneGaps(gaps)}`;
    this.cb.onLog(`[规划校验] ${message}`);
    throw new SchemaValidationError([
      message,
      "请让相关任务的 zone 覆盖这些路径（例如取它们的父目录），或修正 PRD 中的产物路径。",
    ]);
  }

  /** Runs DEVELOPMENT → VERIFICATION (+ repair loops) → DELIVERY. */
  async execute(
    batches: Task[][],
    projectRoot: string,
    opts?: { resume?: ResumeState; smoke?: SmokeCheck[] },
  ): Promise<VerificationReport> {
    try {
      return await this.runPipeline(batches, projectRoot, opts);
    } catch (err) {
      // A cancel aborts mid-batch: tasks already switched to `running` never
      // receive a terminal status, so the board would show them spinning
      // forever. Emit an explicit terminal state for everything in flight.
      if (isCancelled(err)) {
        for (const task of batches.flat()) {
          if (this.inFlight.has(task.id)) {
            this.inFlight.delete(task.id);
            this.cb.onTaskStatus(task.id, "cancelled", this.attemptsSeen.get(task.id) ?? 1);
          }
        }
      }
      throw err;
    }
  }

  private async runPipeline(
    batches: Task[][],
    projectRoot: string,
    opts?: { resume?: ResumeState; smoke?: SmokeCheck[] },
  ): Promise<VerificationReport> {
    const maxRounds = this.deps.settings.maxRepairRounds;
    const resume = opts?.resume;
    const smoke = opts?.smoke ?? resume?.smoke ?? [];
    const attempts = new Map<string, number>(
      Object.entries(resume?.attempts ?? {}).map(([k, v]) => [k, v]),
    );
    const allDone = new Set<string>(resume?.allDone ?? []);
    const skipped = new Set<string>(resume?.skipped ?? []);
    let extraRounds = resume?.extraRounds ?? 0;
    let round = resume?.round ?? 0;
    let lastDigest = "";
    // 断点续跑：关键点保存快照（计划完成 / 每批次 / 每轮收尾）。
    const save = () =>
      this.deps.journal?.save({
        batches,
        smoke,
        allDone: [...allDone],
        skipped: [...skipped],
        attempts: Object.fromEntries(attempts),
        round,
        extraRounds,
        lastDigest,
      });
    save();
    this.cb.onStage("DEVELOPMENT");
    /** Per-task digests routed by zone from the last verification report. */
    let routedByTask = new Map<string, string>();
    let outcomes: DispatchOutcome[] = [];
    let lastFailedLogs = new Map<string, string>();
    while (round <= maxRounds + extraRounds) {
      await this.gate();
      const isRepair = round > 0;
      if (isRepair) {
        this.cb.onLog(`── 重修第 ${round}/${maxRounds + extraRounds} 轮 ──`);
        if (outcomes.length > 0 && outcomes.every((o) => o.ok)) {
          // Verification failed with no failed dev task: workspace was broken
          // externally or integration regressed. Re-run everything.
          // （outcomes 为空的断点续跑轮不算：恢复的 allDone 必须保留）
          allDone.clear();
          outcomes = [];
          this.cb.onLog("验证未过但无失败任务，判定工作区受损/集成回归，全员重跑。");
        }
      }

      for (const [bi, batch] of batches.entries()) {
        await this.gate();
        const notDone = batch.filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
        // 配额守卫：上游依赖未成功的任务本轮不派发（依赖会在重修轮重试，
        // 成功后下游自动解锁）——避免在注定失败的下游上白烧 API 配额。
        // 用户跳过的依赖视为已满足（下游可继续）。
        const depsReady = (t: Task) => t.dependencies.every((d) => allDone.has(d) || skipped.has(d));
        const pending = notDone.filter(depsReady);
        const blocked = notDone.filter((t) => !depsReady(t));
        if (blocked.length > 0) {
          this.cb.onLog(
            `依赖未就绪，本轮跳过（等待上游修复后自动解锁，不烧配额）：${blocked.map((t) => t.id).join("、")}`,
          );
        }
        if (pending.length === 0) continue;
        for (const t of pending) {
          attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
          this.attemptsSeen.set(t.id, attempts.get(t.id)!);
          this.inFlight.add(t.id);
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
          this.inFlight.delete(o.taskId);
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
        save();
      }

      // Stage 4: hard verification gates delivery.
      this.cb.onStage("VERIFICATION");
      await this.gate();
      const anyDevFailure = outcomes.some((o) => !o.ok);
      let report = await this.deps.verify(projectRoot);
      // 独立样本冒烟（防自证盲区层）：仅在开发任务全部成功且常规验证通过后
      // 运行规划期生成的真实样例 —— 失败同样进重修循环，不许带病交付。
      if (!anyDevFailure && report.passed && smoke.length > 0) {
        this.cb.onLog(`── 独立样本冒烟（${smoke.length} 项）：用真实样例运行交付物，防自测同盲 ──`);
        const smokeResults = await runSmokeChecks(smoke, {
          cwd: projectRoot,
          onEvent: (text) => this.cb.onLog(text),
        });
        report = {
          passed: smokeResults.every((r) => r.ok),
          results: [...report.results, ...smokeResults],
        };
      }
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
            save();
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
          save();
          continue;
        }

        throw new VerificationExhaustedError(maxRounds);
      }
      round += 1;
      save();
    }
    throw new Error("unreachable");
  }
}
