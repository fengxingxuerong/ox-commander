import type { LlmClient } from "../../shared/llm-client";
import { chatJson, withCooldownRetry } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { parseDecompose, parsePrd, SchemaValidationError } from "../../shared/schema";
import { findOrphanPaths, describeZoneGaps, verificationCommandPaths } from "../../shared/zone-coverage";
import type { UsageSnapshot } from "../../shared/usage-meter";
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
  /**
   * 用量快照提供者（可选）。engine 自己不管计数 —— 它只负责在 `execute`
   * 结束时**取一次**快照交给宿主，计数逻辑留在拥有 LLM 客户端的那一层
   * （`platform.ts` 的 meter）。成功、取消、抛错三条路径都会触发。
   */
  usage?: () => UsageSnapshot;
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
  /**
   * 一次 `execute` 结束时回报用量（成功 / 取消 / 抛错都会到）。
   * 只在宿主提供了 `deps.usage` 时触发；没有它就什么都不做。
   */
  onUsage?(snapshot: UsageSnapshot): void;
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

/** 失败摘要压成一行放进重修上下文：多行日志会把提示词撑爆，而首行通常就是原因。 */
function firstLine(digest: string): string {
  const line = (digest.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
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
/** run 墙钟到点。抛在批/轮边界，现场（journal 与快照备份）保留，可续跑或调大上限。 */
export class RunWallClockError extends Error {
  constructor(public readonly elapsedMs: number, public readonly limitMs: number) {
    super(
      `本次 run 已达墙钟上限 ${Math.round(limitMs / 1000)}s（实际用时 ${Math.round(elapsedMs / 1000)}s）：` +
        "停在批/轮边界，现场已保留，可断点续跑或调大 runWallClockMs。",
    );
    this.name = "RunWallClockError";
  }
}

export class OrchestratorEngine {
  private cancelled = false;
  /** 计时起点＝引擎构造那一刻（两个宿主都是每次 run 现构造引擎）。 */
  private readonly runStartedAt = Date.now();
  private paused = false;
  /** Tasks currently dispatched (status `running`); drives the cancel sweep. */
  private readonly inFlight = new Set<string>();
  /** Last attempt number emitted per task, reused by the cancel sweep. */
  private readonly attemptsSeen = new Map<string, number>();

  constructor(private deps: OrchestratorDeps, private cb: OrchestratorCallbacks) {}

  cancel(): void {
    this.cancelled = true;
    /*
     * 标志位只拦得住下一个检查点。已经在跑的 run 必须被真的掐掉 —— 否则用户点了
     * 取消之后，外部 CLI 智能体还会跑满自己的 runDeadline（默认 600s）继续改文件。
     * `abortInFlight` 承诺永不 reject，所以这里接得住一个不处理的 Promise。
     */
    void this.deps.scheduler.abortInFlight().then((n) => {
      if (n > 0) this.cb.onLog(`[取消] 已请求中止 ${n} 个在跑的任务`);
    });
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

  /** 见 `runWallClockMs`：只在批/轮边界检查，不掐在途请求。 */
  private assertWallClock(): void {
    const limit = this.deps.settings.runWallClockMs;
    if (limit === undefined) return;
    if (limit <= 0) return;
    const elapsed = Date.now() - this.runStartedAt;
    if (elapsed <= limit) return;
    throw new RunWallClockError(elapsed, limit);
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
    // 规划校验失败（zone 覆盖缺口等）不是终点：把校验错误回喂大脑重新规划，
    // 最多 2 次修正重试 —— 比快速失败省一次人工介入，比硬着头皮派发省整轮配额。
    const MAX_PLAN_RETRIES = 2;
    let feedback = "";
    for (let attempt = 0; ; attempt++) {
      const label = attempt === 0 ? "任务分解" : `任务分解（第 ${attempt} 次校验修正重试）`;
      const plan = await this.brainCall(
        label,
        () =>
          chatJson(
            this.deps.llm,
            {
              messages: [
                {
                  role: "user",
                  content:
                    buildDecomposePrompt(prd) +
                    (feedback ? `\n\n【上一次规划未通过 zone 覆盖校验，必须修正】\n${feedback}` : ""),
                },
              ],
            },
            { schemaName: "decompose plan", validate: parseDecompose },
          ),
      );
      try {
        this.assertZoneCoverage(prd, plan.tasks, verificationCommands);
        return { batches: planBatches(plan.tasks), smoke: plan.smoke };
      } catch (err) {
        feedback = (err as SchemaValidationError).message;
        if (attempt >= MAX_PLAN_RETRIES) throw err;
        this.cb.onLog(`[规划校验] 规划不合格，携带校验错误重试分解（${attempt + 1}/${MAX_PLAN_RETRIES}）`);
      }
    }
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
    } finally {
      // 三条出口（交付 / 取消 / 抛错）都要报用量 —— 失败的运行一样烧了 token，
      // 只在成功路径上报会让"最贵的那次"恰好看不见。
      const snapshot = this.deps.usage?.();
      if (snapshot) this.cb.onUsage?.(snapshot);
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
    // 断点续跑恢复的完成状态：全员重跑分支不得清掉它们（真实工作成果）
    const restoredIds = new Set(resume?.allDone ?? []);
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

    /**
     * 基线验证：动手之前把同样的命令跑一遍。
     *
     * 为什么要它 —— 重修提示里只有"上一轮的失败日志"，于是**目标项目本来就坏着**
     * （缺依赖、套件红、命令被沙箱拒绝）时，智能体看到一份与自己无关的失败，会去
     * 修不属于自己的东西；而引擎的"验证未过但无失败任务 → 全员重跑"分支会把同一份
     * 失败再烧三轮预算。标注出来之后，谁造成的谁负责。
     *
     * 只在全新 run 上跑：断点续跑时工作区已被上一轮改过，"基线"这个概念不成立。
     * 代价是每次运行多一轮验证命令，所以它换的是归因与预算，不是速度。
     */
    let preexistingKinds = "";
    if (!resume) {
      const baseline = await this.deps.verify(projectRoot);
      const bad = baseline.results.filter((r) => !r.ok);
      if (bad.length === 0) {
        this.cb.onLog("基线验证：本次运行开始前，验证命令全部通过。");
      } else {
        // 给操作者的是原因（含日志首行），给智能体的只到"哪条命令、退出码"这一层：
        // 把失败摘要原样抄进每份重修上下文，会把"这条线索归谁"这类归属判据冲掉
        // ——[413] 那条变异测试就是这么被缴械的（实测过），而且智能体本来就会
        // 在本轮的错误摘要里看到同样的文字。
        preexistingKinds = bad.map((r) => `${r.kind}(exit=${r.exitCode ?? "null"})`).join("、");
        this.cb.onLog(
          `基线验证：${bad.length} 条命令在本次运行开始前就失败（不是智能体造成的）：` +
            `${preexistingKinds}\n${bad.map((r) => `[${r.kind}] ${firstLine(r.logDigest)}`).join("\n")}`,
        );
      }
    }
    this.cb.onStage("DEVELOPMENT");
    /** Per-task digests routed by zone from the last verification report. */
    let routedByTask = new Map<string, string>();
    let outcomes: DispatchOutcome[] = [];
    let lastFailedLogs = new Map<string, string>();
    while (round <= maxRounds + extraRounds) {
      this.assertWallClock();
      await this.gate();
      const isRepair = round > 0;
      if (isRepair) {
        this.cb.onLog(`── 重修第 ${round}/${maxRounds + extraRounds} 轮 ──`);
        if (outcomes.length > 0 && outcomes.every((o) => o.ok)) {
          // Verification failed with no failed dev task: workspace was broken
          // externally or integration regressed. Re-run everything.
          // （outcomes 为空的断点续跑轮不算：恢复的 allDone 必须保留）
          // 断点续跑恢复的完成状态是真实工作成果，全员重跑只清本轮派发过的，
          // 不清从 journal 恢复的 —— 否则已交付模块会被无谓重派。
          allDone.clear();
          for (const id of restoredIds) allDone.add(id);
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
                    // 每一份重修上下文都要知道：这些失败早于本次运行。
                    // 只报"哪条命令早于本次运行就是红的"，不复制失败摘要：
                    // 摘要本身已经在本轮的错误归属里，抄两遍只会淹没归属线索。
                    preexistingKinds ? `[本次运行前就已失败] ${preexistingKinds}` : "",
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
        /*
         * `verificationCommands: []` 是合法配置（headless 协议允许空集），而空集在
         * `verifyProject` 里恒为 passed —— 于是"全部验证通过"其实什么都没验。
         * 判定刻意不改（纯文档类任务确实不需要构建），改的是**说法**：零验证当场说出来，
         * 日志与审计里都留得下，看板不会显示成"验证通过"。
         */
        this.cb.onLog(
          report.results.length === 0
            ? "警告：没有配置任何验证命令，也没有冒烟样本运行过 —— 本次交付**未经构建/测试验证**，只按任务成功放行。"
            : `全部验证通过，进入交付。${skippedNote}`,
        );
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
