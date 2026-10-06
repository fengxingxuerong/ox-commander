import { createHash } from "node:crypto";
import type { LlmClient } from "../../shared/llm-client";
import { chatJson, withCooldownRetry } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { parseDecompose, parsePrd, SchemaValidationError } from "../../shared/schema";
import { findOrphanPaths, describeZoneGaps, verificationCommandPaths } from "../../shared/zone-coverage";
import type { UsageSnapshot } from "../../shared/usage-meter";
import { buildReceipt, receiptTaskStatus, sealReceipt } from "../../shared/delivery-receipt";
import type {
  DeliveryReceipt,
  ReceiptCheck,
  ReceiptConflict,
  ReceiptOutcome,
  ReceiptTask,
} from "../../shared/delivery-receipt";
import { runSmokeChecks } from "./verifier";
import type { ActionGateLike } from "../sandbox/action-gate";
import type { SmokeCheck } from "../../shared/types";
import { planBatches, skippedDescendants } from "../../shared/graph";
import { routeVerificationErrors, environmentalRulingNote } from "../../shared/routing";
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
  /**
   * 本次 run 累计的越权判定（可选）。
   *
   * 引擎自己看不到它们 —— 仲裁发生在 `BatchGuard` 里，而 guard 挂在长期存活的
   * agent layer 上，生命周期比一次 `execute` 长。所以由宿主（`platform.ts`）在
   * verdict sink 上顺手收集，引擎只在收尾时取一次快照写进凭据。
   * 没有它时凭据里的 `conflicts` 是空数组（不代表"没有越权"，只代表没人喂）。
   */
  conflicts?: () => ReceiptConflict[];
  /**
   * 跨动作状态机（竞品调研 §5.1，可选）：批次边界上由引擎 reset —— 批次是
   * "已发生过什么"的生命周期单位。观察面（agent 日志）与执行面（验证命令
   * 升级审查）分别由 scheduler 和 verifier 持有同一个实例。
   */
  actionGate?: ActionGateLike;
  /**
   * 审批门（P2-3，可选）：与 `actionGate` 同一生命单位 —— 批次边界一起 reset。
   * "本批次已批准过某命令"不该跨批生效：下一批是新的上下文，该问还得问。
   *
   * 这里只用到它的 `reset()`；判定与问人发生在 verifier 里（执行面）。
   */
  approvalGate?: { reset(): void };
  /**
   * 运行履历提供者（P1-3 上下文回溯闭环，可选）：给一个 taskId，返回给下一个
   * 执行器看的"前任履历"文本。
   *
   * 引擎自己读不到审计日志 —— 它活在一轮 `execute` 里，而日志归长期存活的
   * audit-log 所有（同 `usage` / `conflicts` 的理由）。所以宿主注入一个查询函数，
   * 引擎只在**重修轮**取一次。宿主没提供时重修上下文里就没有履历段，
   * 其余行为一字不变。
   */
  priorAttempts?: (taskId: string) => string;
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
  /**
   * 一次 run 的**交付凭据**：验证结论、任务账、越权处置与用量合成一份结构化结论。
   *
   * 可选是为了向后兼容（既有宿主不接也照常跑），并且在没有宿主接时不生成
   * —— 组装它要遍历任务与检查结果，而没人读的时候那份遍历是纯浪费。
   *
   * 触发点有两处且**只有**两处：交付成功（outcome `delivered`）与重修预算耗尽
   * （`blocked`）。取消与异常路径刻意不发：那种现场不完整，发出去会被当成
   * "这次运行就这些结果"，而事实是它没跑完。
   */
  onReceipt?(receipt: DeliveryReceipt): void;
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
 * Repair rounds ran out while the run still could not be delivered.
 *
 * A dedicated class (rather than a bare `Error`) so hosts can tell
 * "spent the budget" apart from "something broke" — the headless protocol maps
 * this to exit code 2 instead of 1.
 *
 * ⚠️ `message` 必须区分**验证红着**与**验证全绿但任务没做出来**（2026-10-05）。
 * 旧文案只有一种说法，而 `no-agent` 那种死因下验证必然全绿 —— 于是这条错误
 * 会与同一份凭据里 `ok: true` 的 `checks` 互相打脸，宿主日志里读起来像是
 * 验证命令挂了。**这个 class 的名字与 exit code 都不改**（它们是协议的一部分），
 * 只把话说准。
 */
export class VerificationExhaustedError extends Error {
  constructor(
    public readonly maxRounds: number,
    /** 验证命令是否真的红着；false 表示"全绿但任务没做出来"。 */
    public readonly verificationFailed: boolean = true,
  ) {
    super(
      verificationFailed
        ? `verification still failing after ${maxRounds} repair rounds`
        : `${maxRounds} repair rounds spent; verification passed but tasks did not complete`,
    );
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

  /**
   * 组装并交出一份交付凭据。
   *
   * 只有宿主接了 `onReceipt` 才组装（理由见该回调的注释）——没有接收方时，
   * 遍历全部任务与检查结果纯属浪费。
   *
   * 任务状态交给 `receiptTaskStatus`（纯逻辑层）判定，理由与判定顺序见它的注释。
   */
  /**
   * delivered 凭据的 verified/unverifiedReason 对。零验证命令是合法配置（headless
   * 协议允许空集），空集在 verifyProject 里恒为 passed —— "全部验证通过"其实什么
   * 都没验，判定不改（纯文档类任务确实不需要构建），但**说法必须当场给出**。
   * 三个构建点曾各自复制这段（2026-09-29 变异审计抓到其中一处无断言存活），
   * 收敛成一处 —— 断言只需盯住这一个实现。
   */
  private verifiedFieldsFor(report: { results: unknown[] }): {
    verified: boolean;
    unverifiedReason?: string;
  } {
    return {
      verified: report.results.length > 0,
      ...(report.results.length === 0
        ? { unverifiedReason: "没有配置任何验证命令，也没有冒烟样本运行过" }
        : {}),
    };
  }

  /**
   * 修完轮次耗尽后，凭据里那句"为什么没交付"。
   *
   * ⚠️ 提取成纯函数是因为**它必须能被单独测**：原文案把"开发任务挂了但验证全绿"
   * 说成"验证仍未通过"，而同一份凭据的 `checks` 里躺着 `ok: true`。
   * 这类矛盾写在 `emitReceipt` 的参数里没法测 —— 只能对着一份跑出来的凭据看，
   * 而那需要一整条链路。
   *
   * @param report    最终一次验证的报告（`passed` 才是"验证这一步"的结论）
   * @param maxRounds 重修轮次上限
   * @param outcomes  每个任务的执行结果（`!ok` = 没做出来，与验证无关）
   */
  private stallReasonFor(
    report: { passed: boolean },
    maxRounds: number,
    outcomes: Array<{ ok: boolean }>,
  ): string {
    const failed = outcomes.filter((o) => !o.ok).length;
    if (report.passed) {
      // 验证全绿却没交付 —— 必须**明说**是开发任务没做出来，否则读凭据的人
      // 会以为验证命令红着，回头去查一个根本没红的日志。
      return (
        `重修 ${maxRounds} 轮后仍有 ${failed} 个任务未能完成（验证命令全部通过，` +
        "但产物并未做出来）"
      );
    }
    return `重修 ${maxRounds} 轮后验证仍未通过`;
  }

  private emitReceipt(args: {
    outcome: ReceiptOutcome;
    batches: Task[][];
    report: VerificationReport;
    outcomes: DispatchOutcome[];
    allDone: Set<string>;
    skipped: Set<string>;
    attempts: Map<string, number>;
    preexistingKinds: string[];
    round: number;
    verified: boolean;
    unverifiedReason?: string;
  }): void {
    const sink = this.cb.onReceipt;
    if (!sink) return;
    const byId = new Map(args.outcomes.map((o) => [o.taskId, o]));
    const tasks: ReceiptTask[] = args.batches.flat().map((t) => {
      const outcome = byId.get(t.id);
      return {
        id: t.id,
        title: t.title,
        zone: t.zone,
        status: receiptTaskStatus({
          skipped: args.skipped.has(t.id),
          done: args.allDone.has(t.id),
          // 没有派发结果时不给 `outcomeOk`：那与"派发过且成功"是两种事实。
          outcomeOk: outcome?.ok,
        }),
        attempts: args.attempts.get(t.id) ?? 0,
        // ⚠️ **必须写在返回对象上，不能只喂给 `receiptTaskStatus`**
        // （2026-10-05 分流审计）。旧写法把这个展开放在了上面的**入参**里：
        //
        //   status: receiptTaskStatus({ …, ...(outcome ? { outcomeOk: outcome.ok } : {}) }),
        //
        // 它只参与了 status 的计算，**从没进过 tasks[]**。于是
        // `status: "failed"` 与 `tasks[].outcomeOk` 缺席同时出现 ——
        // 而 `ReceiptTask` 里连字段都没有，所以 TS 也不报错，
        // `grep outcomeOk` 全仓零消费侧 ⇒ 这个错配从没有任何一侧能被发现。
        //
        // `status` 是四态归并的结果，**丢掉了来路**：只有 `outcomeOk` 能区分
        // "这次跑成了"与"上一轮跑成的、这次只是恢复"—— 而两者排查路径完全不同。
        ...(outcome ? { outcomeOk: outcome.ok } : {}),
        ...(outcome?.agentId ? { agentId: outcome.agentId } : {}),
        ...(outcome?.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        // 2026-09-29：原为 `...(outcome?.errorClass ? { … } : {})`。消费侧是可选
        // 字段（ReceiptTask.errorClass?），直接传值与条件展开等价（三元算子转正后
        // 该形状首次全量审计存活，据此简化消灭位点）。
        errorClass: outcome?.errorClass,
      };
    });
    const checks: ReceiptCheck[] = args.report.results.map((r) => ({
      kind: r.kind,
      ok: r.ok,
      exitCode: r.exitCode,
      preexisting: args.preexistingKinds.includes(r.kind),
      headline: r.ok ? "" : firstLine(r.logDigest),
      // 命令透传到凭据（外部可验证的基石）：拿到凭据的人能自己复跑同一条命令，
      // 而不是只能相信我们。缺席照传缺席 —— 条件展开与直传在可选字段上等价。
      command: r.command,
      args: r.args,
    }));
    sink(
      sealReceipt(
        buildReceipt({
          outcome: args.outcome,
          // 交付但没验过是合法状态（纯文档任务不需要构建），所以这两档独立：
          // `verified` 说"有没有真验过"，`unverifiedReason` 说"为什么没有"。
          verified: args.verified,
          ...(args.unverifiedReason !== undefined ? { unverifiedReason: args.unverifiedReason } : {}),
          rounds: args.round,
          checks,
          tasks,
          conflicts: this.deps.conflicts?.() ?? [],
          ...(this.deps.usage ? { usage: this.deps.usage() } : {}),
        }),
        // 盖章用的哈希：宿主层的决定。引擎只负责在凭据产出时贴一次指纹。
        (s) => createHash("sha256").update(s).digest("hex"),
      ),
    );
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
    /** 「上游被跳过 ⇒ 不再花修预算」已经说过的任务，避免每轮重复播报。 */
    const givenUpAnnounced = new Set<string>();
    /** 同一批任务的两条话各记一次：共用一个集合会让先说的那条把后一条吞掉。 */
    const noEscalationAnnounced = new Set<string>();
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
    /** 基线里就红着的命令种类：凭据里要靠它把"不是智能体造成的失败"标出来。 */
    let preexistingKindList: string[] = [];
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
        preexistingKindList = bad.map((r) => r.kind);
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
        // Batch boundary = the cross-action state machine's lifetime unit:
        // facts observed in batch N must not escalate batch N+1's verdicts.
        this.deps.actionGate?.reset();
        // 审批门同一生命单位：「本批已批准过」不该跨批（下一批是新上下文）。
        this.deps.approvalGate?.reset();
        const notDone = batch.filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
        // 配额守卫：上游依赖未成功的任务本轮不派发（依赖会在重修轮重试，
        // 成功后下游自动解锁）——避免在注定失败的下游上白烧 API 配额。
        // 用户跳过的依赖视为已满足（下游可继续）。
        const depsReady = (t: Task) => t.dependencies.every((d) => allDone.has(d) || skipped.has(d));
        const ready = notDone.filter(depsReady);
        /*
         * 上游被用户跳过的任务只给**第一次**机会：它缺的那份产物永远不会出现，
         * 每追加重修轮都是纯烧钱。试过一次的从这里开始不再派发（"人自担"不等于
         * "任人烧预算"），并且只说一次。
         */
        const infected = skippedDescendants(batches.flat(), skipped);
        const pending = ready.filter((t) => !infected.has(t.id) || !attempts.has(t.id));
        const givenUp = ready.filter((t) => infected.has(t.id) && attempts.has(t.id));
        const newlyGivenUp = givenUp.filter((t) => !givenUpAnnounced.has(t.id));
        for (const t of newlyGivenUp) givenUpAnnounced.add(t.id);
        if (newlyGivenUp.length > 0) {
          this.cb.onLog(
            `上游被用户跳过 ⇒ 缺的产物不会再出现，已停止为这些任务花修预算` +
              `（各自已试过一轮，后续重修轮不再派发）：${newlyGivenUp.map((t) => `「${t.title}」`).join("、")}。` +
              `要它们就把上游补上重跑。`,
          );
        }
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
                    // 前任履历（P1-3）：说清"这条路已经走过" —— 只说"现在哪里错了"
                    // 的话，agent 每次重试都从零开始，会反复踩同一个坑。
                    this.deps.priorAttempts?.(t.id) ?? "",
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
          // 冒烟命令来自大脑生成 —— 跨动作升级审查对它最有价值。
          actionGate: this.deps.actionGate,
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
        this.emitReceipt({
          outcome: "delivered",
          batches,
          report,
          outcomes,
          allDone,
          skipped,
          attempts,
          preexistingKinds: preexistingKindList,
          round,
          ...this.verifiedFieldsFor(report),
        });
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
      // 环境裁决（P2-3 失败类别细分）：沙箱/审批拒绝不是代码问题，重修提示里
      // 必须先说破 —— 否则 agent 会把"审批拒绝"当成"项目本来就坏"白修一轮。
      const ruling = environmentalRulingNote(report);
      if (ruling !== "") {
        this.cb.onLog(ruling);
        lastDigest = `${lastDigest}\n\n${ruling}`;
      }

      const exhausted = round === maxRounds + extraRounds;
      if (exhausted) {
        const failedTasks = batches.flat().filter((t) => !allDone.has(t.id) && !skipped.has(t.id));
        // 每处理一个任务都重算：用户在循环里"跳过"的上游，必须立刻让它下游
        // 不再拿到"要不要重派"这个问题（重派补不上缺的产物）。
        const infectedNow = (): Set<string> => skippedDescendants(batches.flat(), skipped);
        for (const t of failedTasks) {
          if (infectedNow().has(t.id)) {
            // 不弹升级决策：那里只有"终止/跳过/重派"三个答案，而**重派不会补上被跳过的
            // 上游产物**，问一次就是诱用户再花一整轮。改成直接说明并放弃（每任务只说一次）。
            if (!noEscalationAnnounced.has(t.id)) {
              noEscalationAnnounced.add(t.id);
              this.cb.onLog(
                `「${t.title}」仍未通过，但它缺的上游被用户跳过 ⇒ 不进入升级决策（重派也补不上）。` +
                  `要它就把上游补上重跑。`,
              );
            }
            continue;
          }
          const summary = buildEscalationSummary({
            taskTitle: t.title,
            // ⚠️ 兜底值必须是**派发次数**口径（2026-10-05）：`round + 1` 里那个
            // `+1` 正是"首次派发"，与 `attempts` 同一量纲。而旧注释说这是
            // "重修轮次"，若哪天有人照那个注释改成 `round`，弹窗就会印出
            // "已尝试 N 次（重修 N-1 轮）" 这种自相矛盾的话。
            // 走到这里的任务都在 `failedTasks` 里，正常都有 attempts；兜底只为类型。
            attemptsSoFar: attempts.get(t.id) ?? round + 1,
            maxRepairRounds: maxRounds,
            lastErrorDigest: routed.byTask.get(t.id) ?? lastDigest,
            // 措辞必须跟着验证结论走：死因是 no-agent 时验证必然全绿，
            // 弹窗却说"仍未通过验证"，用户会照着错误诊断去选"重派"，再烧一轮。
            verificationPassed: report.passed,
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
              const downstream = pendingNow.filter((d) => d.dependencies.includes(t.id));
              this.cb.onLog(
                `用户跳过任务「${t.title}」，不再重试。` +
                  (downstream.length > 0
                    ? ` 它的下游 ${downstream.map((d) => `「${d.title}」`).join("、")} 至多还会被派出一次，` +
                      `缺它的产物很可能失败 —— 那种失败不是下游自己的问题，` +
                      `也不会为它们追加重修轮。`
                    : ""),
              );
              continue;
            }
            // redispatch: grant one more round and reset this task's failure log.
            extraRounds += 1;
            this.cb.onLog(`用户要求重派任务「${t.title}」，追加一轮修复。`);
            save();
          }
        }

        if (this.cb.requestEscalationDecision) {
          // 被跳过上游传染的任务不算"还在失败"：为它们继续追加轮次只是重复烧钱。
          const givenUp = skippedDescendants(batches.flat(), skipped);
          const stillFailing = batches
            .flat()
            .some((t) => !allDone.has(t.id) && !skipped.has(t.id) && !givenUp.has(t.id));
          if (!stillFailing) {
            // Everything was skipped; deliver only if verification now passes.
            const finalReport = await this.deps.verify(projectRoot);
            this.cb.onVerification(finalReport);
            if (finalReport.passed) {
              this.cb.onStage("DELIVERY");
              this.emitReceipt({
                outcome: "delivered",
                batches,
                report: finalReport,
                outcomes,
                allDone,
                skipped,
                attempts,
                preexistingKinds: preexistingKindList,
                round,
                ...this.verifiedFieldsFor(finalReport),
              });
              this.cb.onStage("DONE");
              return finalReport;
            }
            throw new Error(
              givenUp.size > 0
                ? `上游被跳过带累 ${givenUp.size} 个下游任务（已停止为它们花修预算），且验证仍未通过`
                : "所有失败任务已被跳过，但验证仍未通过",
            );
          }
          round += 1;
          save();
          continue;
        }

        this.emitReceipt({
          outcome: "blocked",
          batches,
          report,
          outcomes,
          allDone,
          skipped,
          attempts,
          preexistingKinds: preexistingKindList,
          round,
          // 卡住的一律记成"没验过"：验证命令跑了但红着，与"根本没跑"在凭据里
          // 是同一种结论（这次运行没有可对外担保的东西），差别写在 reason 里。
          verified: false,
          // ⚠️ **reason 必须说清到底卡在哪一步**（2026-10-05 运行时观察发现的
          // 自相矛盾之一）。这一段的真实处境有两种，之前的措辞只覆盖了其中一种：
          //
          //   · 验证命令真的红着            → report.passed === false；
          //   · 验证命令全绿、但开发任务失败 → report.passed === true（!!）
          //
          // 第二种极其常见：任务死因是 no-agent（调度器没匹配到执行者）时，
          // 项目文件压根没人动，基线又本来就是绿的，于是验证**必然**全绿。
          // 而 `checks[0].ok === true` 与 `unverifiedReason` 里那句"验证仍未通过"
          // 摆在同一份凭据里 —— 拿到凭据的人只能二选一地相信。这不是措辞瑕疵，
          // 是同一份文件里的两句话互相打脸。
          //
          // 引擎在 :701 自己就清楚这件事（"存在失败的开发任务，即使构建通过也不允许交付"），
          // 说明它**知道**两者不同，却没把这份知识带进凭据。
          unverifiedReason: this.stallReasonFor(report, maxRounds, outcomes),
        });
        throw new VerificationExhaustedError(maxRounds, !report.passed);
      }
      round += 1;
      save();
    }
    throw new Error("unreachable");
  }
}
