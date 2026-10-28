import { createHash } from "node:crypto";
import type { LlmClient } from "../../shared/llm-client";
import { chatJson, withCooldownRetry } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { formatConventionsBlock } from "../../shared/project-conventions";
import { formatPlanMemoBlock } from "../../shared/plan-memo";
import { readPlanMemo, readProjectConventions } from "./conventions";
import { parseDecompose, parsePrd, SchemaValidationError } from "../../shared/schema";
import { findOrphanPaths, describeZoneGaps, verificationCommandPaths, checkContractPaths, findGhostObligations, describeGhostObligations } from "../../shared/zone-coverage";
import type { UsageSnapshot } from "../../shared/usage-meter";
import { buildReceipt, receiptTaskStatus, sealReceipt, verifyReceiptFingerprint } from "../../shared/delivery-receipt";
import type {
  DeliveryReceipt,
  ReceiptCheck,
  ReceiptConflict,
  ReceiptOutcome,
  ReceiptTask,
} from "../../shared/delivery-receipt";
import { deliveryStatusFor } from "./git-status";
import { runSmokeChecks } from "./verifier";
import {
  acceptanceTitle,
  missingAcceptanceFiles,
  missingFilesMessage,
  normalizeAcceptanceChecks,
  toSmokeCheck,
} from "../../shared/acceptance";
import type { ActionGateLike } from "../sandbox/action-gate";
import type { RepairRecord, SmokeCheck } from "../../shared/types";
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
   * 契约路径合规的存在性探针（可选）。宿主按 `root` 判 `rel` 在不在盘上。
   *
   * 为什么做成注入而不是引擎自己 `existsSync`：引擎层至今零文件系统依赖
   * （`verify`/`journal`/`conflicts`/`usage` 全是宿主喂的），断言才能被单测
   * 用一个 Set 直接驱动。
   *
   * ⚠️ `rel` 由引擎先过 `isProbeableRel`（不含 `..`、不是绝对路径、不带盘符）
   * 才交给宿主 —— 路径来自模型写的散文，宿主可以假定拿到的就是相对干净路径。
   *
   * ⚠️ **没喂就是没检查，不是检查通过** —— 那种情况下日志会明说这一轮没核，
   * 与 `conflicts` 空数组"不代表没有越权"同一口径。
   */
  fileExists?: (root: string, rel: string) => boolean;
  /**
   * 交付后的可选 git 导出（5.7 本地半边，2026-10-11）：把本次 run 的 zone 内
   * 改动导出成 `git 分支 + commit`。**为什么注入**：引擎层至今零进程/文件系统
   * 依赖（verify/journal/conflicts/usage 同一口径），spawn 属于宿主实现。
   * 什么时候被调：`settings.exportDeliveryBranch` 为真且本回调在场 —— 两个条件
   * 缺一不可（回调缺席 = 宿主没接，开关开着也不动）。永不 throw（实现自己的
   * 契约是把失败折进结果对象），引擎侧再兜一层 try/catch：导出失败只写日志，
   * **绝不影响交付结论** —— 本地硬门禁已在交付前过了，导出只是分发层。
   */
  exportDelivery?: (input: {
    projectRoot: string;
    zones: string[];
    /**
     * 本次交付凭据的指纹（`DeliveryReceipt.fingerprint`），没有凭据时为 `undefined`。
     *
     * 给导出层把它写进 commit 的 `Ox-Receipt` trailer —— 于是"这个 commit 是哪份凭据
     * 保下来的"不用靠时间戳去猜。引擎只负责**传**，拼不拼进 commit 是宿主的事
     * （与分支名/commit 信息同一条分工）。
     */
    receiptFingerprint?: string;
  }) => Promise<import("./git-export").GitExportResult>;
  /**
   * 交付后的可选远端分发（5.7 远端半边，2026-10-12）：把本地导出的分支推到
   * remote / 开 PR / 等 CI 结论。**为什么注入**：与 `exportDelivery` 同一理由
   * （引擎零 spawn 依赖），且这一层要碰外部系统，宿主必须显式接。
   * 什么时候被调：`settings.deliveryRemote?.mode` 不是 `"off"`、本回调在场、
   * 且本地导出真的产出了分支 —— 三个条件缺一不可（导出跳过时不推）。
   * 永不 throw；失败只写日志，**绝不影响交付结论**。
   */
  /**
   * 规划前的只读外部上下文源（P2-1 本地半边，2026-10-12）：每个来源给一份
   * 成文文本，引擎把它们**标注为不可信数据**后拼进 PRD 提示。
   * **为什么注入**：拉取要 spawn（`gh`），引擎层至今零进程依赖；而且"拉什么"
   * 是宿主的决定（桌面用 settings、headless 用 spec）。
   * 缺省 = 没有来源 = 提示与历史逐字一致（缺席必须零副作用）。
   */
  contextSources?: readonly {
    name: string;
    fetch: () => Promise<string>;
  }[];
  publishRemote?: (input: {
    projectRoot: string;
    branch: string;
  }) => Promise<import("./git-remote").GitRemoteResult>;
  /**
   * 交付凭据 → commit status（2026-10-26，第七轮竞品吸收 3）。
   *
   * 什么时候被调：`settings.deliveryStatus` 为真、本回调在场、**推送真的成功**
   * （status 挂在远端 commit 上，没推上去就无处可挂）、且本轮产出过凭据。
   * 判绿的全部逻辑在 `git-status.deliveryStatusFor`（纯函数，逐位点可审）：
   * 本层只负责"递给谁"。
   * 永不 throw；失败只写日志，**绝不影响交付结论**，也**绝不被重试成 success**。
   */
  publishStatus?: (input: {
    projectRoot: string;
    commit: string;
    decision: import("./git-status").DeliveryStatusDecision;
  }) => Promise<import("./git-status").DeliveryStatusResult>;
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
   * 操作者附言的状态变化（C2）：设置 / 清除 / 任务成功后自动清除都走这里。
   * 宿主转成 `task-note` 事件给看板 —— 附言是**人刚写的东西**，没有实时回显
   * 就没有人知道它有没有生效。note 为空串 = 已清除。
   */
  onTaskNote?(taskId: string, note: string): void;
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
  /**
   * 本次 run 的中止闸（2026-10-13）：cancel() 时 abort，让 brain 层的在途 HTTP
   * 与 combo 间退避睡眠立刻结束（fetch 侧 req.signal 早已并进 AbortSignal.any，
   * 缺的只是"有人去 abort"和退避睡眠听不听）。
   *
   * 同闸也下发给执行期：调度器把它写进每条 TaskPayload，适配器据此掐断在途请求
   * 或杀掉子进程。`abortInFlight()` 是一次性枚举，补不上"取消之后才派发"的那些 run。
   */
  private readonly abort = new AbortController();
  /** 计时起点＝引擎构造那一刻（两个宿主都是每次 run 现构造引擎）。 */
  private readonly runStartedAt = Date.now();
  private paused = false;
  /** Tasks currently dispatched (status `running`); drives the cancel sweep. */
  private readonly inFlight = new Set<string>();
  /** Last attempt number emitted per task, reused by the cancel sweep. */
  private readonly attemptsSeen = new Map<string, number>();
  /**
   * 逐轮重修台账（2026-10-07）：`attempts` 只记"派发过几次"，而排查时真正
   * 要的是"每一轮为什么没成、当时看到的摘要是什么" —— 那份数据只在事件流里
   * 活过一轮，跑完就没了。这里攒下来，最后由 `emitReceipt` 写进凭据的逐任务账。
   */
  private readonly repairsSeen = new Map<string, RepairRecord[]>();
  /**
   * 操作者附言（C2，2026-10-17）：taskId → 人写的一次性指示。
   *
   * 存活范围是**引擎实例**（= 一次 run）：不落盘、不过重启。派发前由
   * `pendingWithNotes()` 拷进 Task 副本，任务成功后 `deleteNote` 收回
   * （附言的用途已兑现，留着会让下一轮重修重复带旧指示）。
   */
  private readonly operatorNotes = new Map<string, string>();
  /**
   * 最近一次交付凭据的指纹（2026-10-26，第七轮竞品刷新「归因随凭据走进 commit」）。
   *
   * 为什么在引擎里留一手：凭据是**交给宿主**的（`onReceipt` sink），而导出分支的
   * commit 信息由宿主拼（引擎只给 root/zones）。没有这一格，宿主拿不到"这一份"凭据
   * 的指纹，只能写个时间戳 —— 而时间戳不指向任何东西。
   *
   * 只活一轮：`emitReceipt` 每次覆盖；没有凭据（宿主没接 sink）时保持 `undefined`，
   * 导出层据此不写 `Ox-Receipt` trailer（不编造）。
   */
  private receiptFingerprint: string | undefined;
  /**
   * 最近一次交付凭据本体（2026-10-26，第七轮竞品吸收 3）。
   *
   * 与 `receiptFingerprint` 分开存而不是只留指纹：commit status 要按凭据的 `outcome`
   * 判绿，光有指纹判不出"交没交"。同一生命周期（每轮覆盖、没有 sink 时保持 undefined）。
   */
  private lastReceipt: DeliveryReceipt | undefined;

  constructor(private deps: OrchestratorDeps, private cb: OrchestratorCallbacks) {
    // 取消探针接进调度器的节流等待（2026-10-13）：节流指数退避封顶 5min 的整段
    // 睡眠曾让 /cancel 在执行期也等满封顶（实测 cancel 7 分钟没生效）。
    // fake scheduler 没有这个方法，可选调用；字段初始化先于构造函数体，闭包安全。
    deps.scheduler.setShouldStop?.(() => this.cancelled);
    // 同一个闸也下发给执行期（2026-10-13）：调度器随载荷转交适配器，让取消能掐断
    // 在途的 agent 请求。fake scheduler 没有这些方法，一律可选调用。
    deps.scheduler.setAbortSignal?.(this.abort.signal);
  }

  cancel(): void {
    this.cancelled = true;
    // 在途的 brain 调用（PRD/规划）随闸一起断 —— 标志位只拦下一个检查点，
    // abort 拦的是"正在飞的那一个"。
    this.abort.abort();
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

  /**
   * 设置/清除一个任务的操作者附言（C2）。
   *
   * 空串（或全空白）= 清除。unknown taskId 也收下 —— 附言可能在规划前就写
   * （那时任务表还没建），execute() 建任务时按 id 对得上；对不上的附言
   * 永远到不了任何派发，UI 侧的任务清单就是过滤器，引擎不重复建一套白名单。
   *
   * 立即回声 `onTaskNote`：人写的东西要有"已生效"的实时确认，否则分不清
   * 是没保存还是没派发。
   */
  setOperatorNote(taskId: string, note: string): void {
    const trimmed = note.trim();
    if (trimmed === "") this.operatorNotes.delete(taskId);
    else this.operatorNotes.set(taskId, trimmed);
    this.cb.onTaskNote?.(taskId, trimmed);
  }

  /** 附言抄进 Task 副本（不改计划原件 —— PRD 是计划级输入，附言是 run 级）。 */
  private pendingWithNotes(tasks: readonly Task[]): Task[] {
    if (this.operatorNotes.size === 0) return [...tasks];
    return tasks.map((t) => {
      const note = this.operatorNotes.get(t.id);
      return note === undefined ? t : { ...t, operatorNote: note };
    });
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
    try {
      return await withCooldownRetry(fn, {
      shouldStop: () => this.cancelled,
      // 等待被 cancel 时以 CancelledError 收尾（2026-10-13）：冷却错是 provider
      // 的结局，取消是用户的结局 —— 等待不再睡满封顶，cancel 最迟 1s 内落地。
      stopError: () => new CancelledError(),
        onWait: (ms, n) =>
          this.cb.onLog(
            `${what}：全部 LLM 路由冷却中，第 ${n} 次等待约 ${Math.ceil(ms / 1000)}s 后重试`,
          ),
      });
    } catch (e) {
      // 已取消的 run：在途 abort / 冷却错一律以 CancelledError 收尾 —— 否则
      // "用户叫停"会被报成 AbortError/限流失败（两种结局分开，2026-10-13）。
      if (this.cancelled) throw new CancelledError();
      throw e;
    }
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

  async generatePrd(
    userRequirement: string,
    projectRoot?: string,
    historyBlock?: string,
    factsBlock?: string,
  ): Promise<PrdDocument> {
    this.cb.onStage("PRD");
    const context = await this.collectExternalContext();
    // 项目约定（B3）：给了项目根才读（规划可能在任何根之前被调用，例如
    // 纯 PRD 预演）；读到就说一声 —— "这次注入了哪些约定"是可核的事实。
    const conventions = this.conventionsFor(projectRoot);
    // 规划备忘（2026-10-25）：与约定同一条读取纪律，但内容层次不同 ——
    // 约定是"这个项目的规矩"，备忘是"这一版决定了什么、为什么、否掉了什么"。
    const memo = this.planMemoFor(projectRoot);
    // 规划历史（形态 B，2026-10-25）：由宿主从**审计落盘事实**里取出并渲染好再传进来
    // （纯逻辑在 `shared/plan-history.ts`）。引擎不自己读历史：它没有审计句柄，
    // 也就不会长出第二条读盘通路。
    const history = historyBlock ?? "";
    if (history !== "") {
      this.cb.onLog(`[plan-history] 已注入上次规划（${history.length} 字符）`);
    }
    // 可核事实（2026-10-25）：由宿主从审计里聚合好传进来 —— 引擎没有审计句柄，
    // 也就不可能自己长出一条读盘通路（与历史块同一个理由）。
    const facts = factsBlock ?? "";
    if (facts !== "") {
      this.cb.onLog(`[plan-facts] 已注入上一轮的可核事实（${facts.length} 字符）`);
    }
    const prd = await this.brainCall(
      "PRD 生成",
      () =>
        chatJson(
          this.deps.llm,
          {
            messages: [
              {
                role: "user",
                content: buildPrdPrompt(userRequirement, context, conventions, memo, history, facts),
              },
            ],
            signal: this.abort.signal,
          },
          { schemaName: "PRD", validate: parsePrd },
        ),
    );
    return prd;
  }

  /**
   * 读项目约定并成块（B3）；缺席/空 → 空串（提示里不产段）。
   *
   * 读不动的文件要**说破**：约定注入最坏的失败形态是"以为带进去了、其实没有"，
   * 而那在提示里看不见（缺了就是缺了，模型不会报警）。
   */
  private conventionsFor(projectRoot?: string): string {
    if (!projectRoot) return "";
    const read = readProjectConventions(projectRoot);
    for (const u of read.unreadable) {
      this.cb.onLog(`[conventions] ${u.name} 读不动（不影响规划）：${u.reason}`);
    }
    for (const s of read.skipped) {
      this.cb.onLog(`[conventions] ${s.name} 超过单文件上限（${s.bytes} B），已跳过`);
    }
    const block = formatConventionsBlock(read.files);
    if (block !== "") {
      const names = read.files.map((f) => f.name).join(" + ");
      this.cb.onLog(`[conventions] 已注入项目约定：${names}（${block.length} 字符）`);
    }
    return block;
  }

  /**
   * 读规划备忘并成块（2026-10-25）；缺席/空 → 空串。
   *
   * 三种"没读到"的形态分开说破（读不动 / 超上限 / 没有这个文件）：前两种是
   * 需要人处理的状态，第三种是常态，不该让人以为故障。这是约定那一层已经踩过的坑
   * （"以为带进去了、其实没有"）。
   */
  private planMemoFor(projectRoot?: string): string {
    if (!projectRoot) return "";
    const read = readPlanMemo(projectRoot);
    if (read.unreadable !== undefined) {
      this.cb.onLog(`[plan-memo] OX-PLAN.md 读不动（不影响规划）：${read.unreadable}`);
    }
    if (read.skippedBytes !== undefined) {
      this.cb.onLog(`[plan-memo] OX-PLAN.md 超过单文件上限（${read.skippedBytes} B），已跳过`);
    }
    const block = formatPlanMemoBlock(read.content ?? "");
    if (block !== "") {
      this.cb.onLog(`[plan-memo] 已注入规划备忘：OX-PLAN.md（${block.length} 字符）`);
    }
    return block;
  }

  /**
   * 规划前的外部上下文（P2-1 本地半边，2026-10-12）。**缺席是常态**（默认不配），
   * 配了才拉；拉失败只写日志 —— 上下文是背景，不是需求本身。
   *
   * ⚠️ 两个"不许"：拉不到不许退化成空字符串（那等于"当作没有这项需求"，
   * 操作者会以为拉到了只是没内容）；拉到的内容**不许当指令**
   * （`externalContextBlock` 负责声明它是数据 —— issue 正文是任何人都能写的）。
   */
  private async collectExternalContext(): Promise<Array<{ name: string; text: string }>> {
    const sources = this.deps.contextSources ?? [];
    if (sources.length === 0) return [];
    this.cb.onLog(`── 外部上下文（${sources.length} 个来源，只读拉取）──`);
    const out: Array<{ name: string; text: string }> = [];
    for (const s of sources) {
      try {
        const text = await s.fetch();
        if (!text) {
          this.cb.onLog(`[context] ${s.name}：没拿到内容 —— 按缺席处理，不当作"没有这项需求"`);
          continue;
        }
        out.push({ name: s.name, text });
      } catch (err) {
        this.cb.onLog(`[context] ${s.name} 失败（不影响规划）：${(err as Error).message}`);
      }
    }
    return out;
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
    previousPlanBlock?: string,
  ): Promise<{ batches: Task[][]; smoke: SmokeCheck[] }> {
    this.cb.onStage("PLANNING");
    // 上次拆法（2026-10-25）：任务级差异只有在**分解**这一步才可能被用上 ——
    // PRD 提示那一刻这次的任务清单还不存在。块由宿主渲染好传进来（引擎不读审计）。
    if (previousPlanBlock !== undefined && previousPlanBlock !== "") {
      this.cb.onLog(`[plan-history] 已注入上次分解清单（${previousPlanBlock.length} 字符）`);
    }
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
                    buildDecomposePrompt(prd, previousPlanBlock) +
                    (feedback ? `\n\n【上一次规划未通过 zone 覆盖校验，必须修正】\n${feedback}` : ""),
                },
              ],
              signal: this.abort.signal,
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
    // 幽灵义务与 PRD 孤儿是两条互补的缝：上面那条管"PRD 点名没人认领"，
    // 这条管"分解时才发明的产物没人认领"（PRD 里没有，PRD 级检查天生看不见）。
    // 都在派发**之前**拦下 —— 真跑实测（2026-10-14）：samples 义务 zone 盖不住，
    // 执行者写了必被仲裁回滚，独立冒烟必红，最后一轮重修预算烧在全员重跑上。
    const ghosts = findGhostObligations(tasks);
    if (gaps.length === 0 && ghosts.length === 0) return;
    const messages: string[] = [];
    if (gaps.length > 0) {
      messages.push(
        `以下路径不属于任何 zone，写入必被沙箱拒绝、重修不可能成功：${describeZoneGaps(gaps)}`,
      );
      messages.push("请让相关任务的 zone 覆盖这些路径（例如取它们的父目录），或修正 PRD 中的产物路径。");
    }
    if (ghosts.length > 0) {
      messages.push(
        `以下路径被任务描述点名，但不属于任何 zone，写入必被仲裁回滚、重修不可能成功：${describeGhostObligations(ghosts)}`,
      );
      messages.push(
        "请让相应任务的 zone 覆盖这些路径（例如取它们的父目录），或拆出 zone 能覆盖该产物目录的任务，或从任务描述里去掉这个要求。",
      );
    }
    const message = messages.join("\n");
    this.cb.onLog(`[规划校验] ${message}`);
    throw new SchemaValidationError([message]);
  }  /** Runs DEVELOPMENT → VERIFICATION (+ repair loops) → DELIVERY. */
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
    repairs: Map<string, RepairRecord[]>;
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
        // 逐轮重修记录：缺席 = 没进过重修轮（不是空数组 —— 空数组分不清
        // "没修过"与"修过但记录丢了"，与 outcomeOk 同一条纪律）。
        ...(args.repairs.get(t.id)?.length
          ? { repairs: args.repairs.get(t.id) }
          : {}),
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
      // 出处与标题照传：凭据据此把"操作者定的判据"与"项目自己的验证"分开读。
      // 缺席 = 项目验证/规划冒烟（历史凭据也长这样，语义不变）。
      origin: r.origin,
      title: r.title,
    }));
    const sealed = sealReceipt(
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
    );
    // 留一份指纹给导出层（`maybeExportDelivery` 紧跟在本方法之后调）：
    // commit 的 `Ox-Receipt` trailer 要指向**这一份**凭据，而不是"最近一次"。
    this.receiptFingerprint = sealed.fingerprint;
    // 也留一份整凭据：commit status（吸收 3）要按**这一份**的 outcome 与指纹判绿。
    this.lastReceipt = sealed;
    sink(sealed);
  }

  /**
   * 交付后的可选 git 导出（5.7 本地半边）。两个开关都必须开：
   * `settings.exportDeliveryBranch`（操作者意图）与 `deps.exportDelivery`
   * （宿主实现）。**失败只写日志，绝不影响交付结论**——本地硬门禁在交付前
   * 已经过了，导出只是分发层；这一层坏掉不追认门禁为假。
   */
  private async maybeExportDelivery(projectRoot: string, batches: Task[][]): Promise<void> {
    if (!this.deps.settings.exportDeliveryBranch || !this.deps.exportDelivery) return;
    const zones = [...new Set(batches.flat().map((t) => t.zone))];
    try {
      const result = await this.deps.exportDelivery({
        projectRoot,
        zones,
        // 直传（可能 undefined）：这一层不做条件展开 —— "没有凭据"与"有凭据但没指纹"
        // 都由宿主按缺席处理，引擎再造一层三元只会多一个位点。
        receiptFingerprint: this.receiptFingerprint,
      });
      if (result.ok && !result.skipped) {
        // 日志只记分支/commit/文件数：凭据与 commit 的绑定写在 commit 的
        // `Ox-Receipt` trailer 里（`git log --format=%(trailers)` 一跳可读），
        // 不在这儿再抄一遍指纹 —— 抄两处就有两处会漂。
        this.cb.onLog(
          `[git-export] 已导出分支 ${result.branch}（commit ${result.commit ?? "无"}，${result.filesCommitted ?? 0} 个文件）`,
        );
        await this.maybePublishRemote(projectRoot, result.branch, result.commit);
      } else if (result.skipped === "no-repo") {
        this.cb.onLog("[git-export] 跳过：项目不在 git 仓库内（要导出请先 git init）");
      } else if (result.skipped === "no-changes") {
        this.cb.onLog("[git-export] 跳过：工作树没有可提交的改动");
      } else if (result.skipped === "no-zone-files") {
        this.cb.onLog("[git-export] 跳过：改动都落在任务 zone 之外，没有可归属的文件");
      } else {
        this.cb.onLog(`[git-export] 失败（不影响交付）：${result.reason}`);
      }
    } catch (err) {
      this.cb.onLog(`[git-export] 失败（不影响交付）：${(err as Error).message}`);
    }
  }

  /**
   * 远端分发（5.7 远端半边）。三个条件缺一不动：`settings.deliveryRemote?.mode`
   * 不是 `"off"`、`deps.publishRemote` 在场、本地导出真的产出了分支。
   *
   * **CI 结论只回流进日志**：`failed` 名单是给人看的事实，也是下一轮决策的
   * 输入；这里**不自动触发重修** —— "CI 红了要不要再派一轮"需要幂等与次数上限
   * 的设计，v1 刻意不做，日志里说破。
   */
  private async maybePublishRemote(projectRoot: string, branch?: string, commit?: string): Promise<void> {
    const mode = this.deps.settings.deliveryRemote?.mode;
    if (!mode || mode === "off" || !branch || !this.deps.publishRemote) return;
    try {
      const r = await this.deps.publishRemote({ projectRoot, branch });
      if (r.skipped === "no-remote") {
        this.cb.onLog(`[git-remote] 跳过：仓库没有名为 ${r.remote ?? "origin"} 的远端（要分发请先 git remote add）`);
        return;
      }
      if (r.pushed) this.cb.onLog(`[git-remote] 已推送 ${r.branch ?? branch} 到 ${r.remote ?? "origin"}`);
      if (r.prUrl) this.cb.onLog(`[git-remote] 已开 PR：${r.prUrl}`);
      if (r.checks) {
        if (r.checks.state === "fail") {
          this.cb.onLog(
            `[git-remote] CI 结论：失败（${r.checks.failed.join("、") || "未点名"}）—— 只回流，不自动重修`,
          );
        } else if (r.checks.state === "pass") {
          this.cb.onLog(`[git-remote] CI 结论：通过（轮询 ${r.checks.polls} 次）`);
        } else {
          this.cb.onLog(`[git-remote] CI 结论：${r.checks.state}（轮询 ${r.checks.polls} 次，未拿到确定结论）`);
        }
      }
      if (!r.ok) this.cb.onLog(`[git-remote] 失败（不影响交付）：${r.reason}`);
      // 6. 推成功了才发 status —— 挂不上远端的 commit 就没有意义（顺序是承重的）。
      if (r.pushed) await this.maybePublishStatus(projectRoot, commit);
    } catch (err) {
      this.cb.onLog(`[git-remote] 失败（不影响交付）：${(err as Error).message}`);
    }
  }

  /**
   * 凭据 → commit status（吸收 3）。三个条件缺一不动：开关开、回调和 commit 都在、
   * 本轮真的有凭据。**判绿不在这里**：`deliveryStatusFor` 决定状态与文案，
   * 本层只负责把"这一份"递过去 —— 判据住在一个能被逐位点审计的纯函数里。
   */
  private async maybePublishStatus(projectRoot: string, commit?: string): Promise<void> {
    if (!this.deps.settings.deliveryStatus || !this.deps.publishStatus || !commit) return;
    const receipt = this.lastReceipt;
    if (!receipt) return;
    try {
      const fingerprintOk =
        verifyReceiptFingerprint(receipt, (s) => createHash("sha256").update(s).digest("hex")).reason === "match";
      const decision = deliveryStatusFor(receipt, fingerprintOk);
      const r = await this.deps.publishStatus({ projectRoot, commit, decision });
      if (r.skipped === "bad-commit") {
        this.cb.onLog(`[git-status] 跳过：commit 号不像 sha（${commit}）`);
      } else if (r.ok) {
        this.cb.onLog(`[git-status] 已发 ${r.context} = ${r.state}（commit ${commit}）`);
      } else {
        this.cb.onLog(`[git-status] 失败（不影响交付）：${r.reason}`);
      }
    } catch (err) {
      this.cb.onLog(`[git-status] 失败（不影响交付）：${(err as Error).message}`);
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
    /**
     * 操作者验收判据（B7）：入口只有 `settings.acceptanceChecks` 一个 —— 它不进
     * 任务描述、不进规划提示，所以执行器从头到尾看不见自己要被怎么验。
     *
     * 在引擎边界**再归一化一次**：桌面端的 settings 来自项目存储（可能由旧版本
     * 写入），而"半条判据被当成验过"是最坏的失败形态。坏条目当场说破，合法条目照跑。
     */
    const acceptanceNorm = normalizeAcceptanceChecks(this.deps.settings.acceptanceChecks);
    const acceptanceChecks = acceptanceNorm.checks;
    for (const issue of acceptanceNorm.issues) this.cb.onLog(`[验收判据] ${issue}`);
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
          //
          // 2026-10-14 注：这里**刻意**没有再做"契约缺口定向翻红"。Stage 3.5
          // 在验证**之前**就把缺口（含幽灵义务）翻成 failed(contract)，走到本
          // 分支时缺口早已翻过、任务早已 failed —— "outcomes 全 ok 且仍有缺口"
          // 按构造不可达。曾在这里写过定向分支，位点审计 + 死代码推演一起判它
          // 不可达（tests 先红），按本仓口诀删掉而不是留着装有用。真跑里那单
          // "冒烟失败烧光预算"的病灶，修的是 Stage 3.5 的幽灵盲区（F1b），不是这里。
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
          if (isRepair) {
            // 只在**重修轮**记：首轮不属于重修（与 `ReceiptTask.repairs` 的
            // 注释同一口径）。reason 区分两种来路，因为排查路径不同：
            //   · 上次这个任务自己没派成 ⇒ 看执行器/沙箱；
            //   · 上次派成了但验证没过 ⇒ 看归因摘要（走 zone 归属那条线）。
            const list = this.repairsSeen.get(t.id) ?? [];
            list.push({
              round,
              reason: lastFailedLogs.has(t.id) ? "上一轮该任务未派发成功" : "上一轮验证未通过",
              errorLogDigest: routedByTask.get(t.id) ?? lastDigest,
              dispatchedAt: new Date().toISOString(),
            });
            this.repairsSeen.set(t.id, list);
          }
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
        // 同任务换线（2026-10-14 --real 实测逼出）：t1 在 loomy 上两次 600s 超时，
        // 第三轮路由仍选它 —— role(100)+zone(40)+priority(50) 的结构分压过质量分
        // （上限 ±20）。把本 run 内"这个任务在哪个 agent 上失败过几次"喂给路由，
        // 让重派换线：失败一次 -100，两连败 -200，唯一候选除外（惩罚只排序不硬拦）。
        // 只认本 run 的 outcomes：断点续跑恢复的失败没有结构化 agentId 可查，
        // 那种轮次行为与从前一致（不装作有账）。
        const failuresByTask = new Map<string, Map<string, number>>();
        for (const o of outcomes) {
          if (o.ok || !o.agentId) continue;
          const m = failuresByTask.get(o.taskId) ?? new Map<string, number>();
          m.set(o.agentId, (m.get(o.agentId) ?? 0) + 1);
          failuresByTask.set(o.taskId, m);
        }
        const batchOutcomes = await this.deps.scheduler.runBatch(
          this.pendingWithNotes(pending),
          projectRoot,
          {
            repairOf,
            taskFailures: (taskId) => failuresByTask.get(taskId),
          },
        );
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
            // 附言随成功一起退休（C2）：它的用途已兑现；不清的话下一轮若因
            // 别处失败触发整体重修，旧指示会重复带进 prompt。回声给看板。
            if (this.operatorNotes.delete(o.taskId)) this.cb.onTaskNote?.(o.taskId, "");
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

      /*
       * Stage 3.5：契约路径合规 —— 在 VERIFICATION **之前**。
       *
       * 顺序就是这条判据的全部内容：缺文件是"**这个任务没做完**"，不是"验证命令红"。
       * 放在验证之后，它会表现成一条谁都不归属的测试红，重修轮拿到的上下文里
       * 只有一句 exit=1；放在这里，它变成那个任务自己的失败原因，下一轮派发时
       * 执行者看到的是"你交成了 src/core/csv/index.js，契约点的是 src/core/csv.js"。
       */
      if (this.deps.fileExists) {
        const probe = this.deps.fileExists;
        const contract = checkContractPaths(batches.flat(), (p) => probe(projectRoot, p));
        const flipped: string[] = [];
        for (const g of contract.gaps) {
          const o = outcomes.find((x) => x.taskId === g.taskId);
          // 本来就失败的任务已经在重修队列里，别重复判、也别覆盖它自己的根因。
          if (!o || !o.ok) continue;
          o.ok = false;
          o.errorClass = "contract";
          o.logDigest = [
            g.ghost
              ? `契约点名的文件不存在：${g.path} —— 而且**没有任何 zone 认领它**（规划缺陷，不是你没交）。` +
                `重派也修不好它：写了必被仲裁回滚。修复轮耗尽后会带着这条根因升级请人裁决 —— ` +
                `要救它就把该路径划进某个任务的 zone，或去掉这个要求。`
              : `契约点名的文件不存在：${g.path}`,
            g.ghost
              ? ""
              : g.indexLayout
                ? `交付里是等价布局 ${g.indexLayout} —— 目录 + index **不等于**契约点名的文件。` +
                  `zone 判定两种形状都放行（` +
                  "`isPathInZone` 把 `x/y.js` 算进 zone `x/y`），所以这不是权限问题，是路径问题：" +
                  `内容要落在 ${g.path}。`
                : "请把该文件按契约路径创建出来（zone 允许写它）。",
          ]
            .filter(Boolean)
            .join("\n");
          lastFailedLogs.set(g.taskId, o.logDigest);
          allDone.delete(g.taskId); // 否则下一轮的 depsReady/allDone 会把它当已完成跳过
          this.cb.onTaskStatus(g.taskId, "failed", attempts.get(g.taskId) ?? 1);
          flipped.push(
            `${g.taskId} 缺 ${g.path}${g.indexLayout ? `（交成了 ${g.indexLayout}）` : ""}${g.ghost ? "（幽灵义务：无 zone 认领）" : ""}`,
          );
        }
        if (flipped.length > 0) {
          this.cb.onLog(
            `契约路径合规：${flipped.length} 个任务点名的文件不在盘上 ⇒ 判为未完成，进重修：${flipped.join("；")}`,
          );
        }
        if (contract.checked === 0) {
          // 空转检测：这一层什么都没核时必须说出来，而不是安静地"通过"。
          this.cb.onLog(
            "⚠️ 契约路径合规：任务描述里没有可核的点名路径，这一层本轮**什么都没检查**" +
              "（提取器刻意忽略裸文件名与归属不唯一的路径，宁漏不误判）。",
          );
        } else {
          this.cb.onLog(
            `契约路径合规：核了 ${contract.checked} 条点名路径，缺 ${contract.gaps.length} 条` +
              (contract.ambiguous.length > 0 ? `；${contract.ambiguous.length} 条因归属不唯一未判` : ""),
          );
        }
        save();
      } else {
        this.cb.onLog(
          "⚠️ 宿主没有接 fileExists 探针 ⇒ 契约路径合规这一轮**没有执行**。",
        );
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
      /*
       * 操作者验收判据（B7）：机械可判的那一半。
       *
       * 与上面那段的差别只有**出处**：判据不进任务描述/规划提示，执行器看不到；
       * 跑的是交付物本身（黑盒），不是执行器自己写的测试。执行机制刻意复用冒烟
       * 那一套（同一沙箱门、同一超时、同一 R1 判定），不另造一套。
       *
       * 失败同样是硬伤：不许带病交付，进重修；重修上下文里会点明"判据不是可改的测试"。
       */
      if (!anyDevFailure && report.passed && acceptanceChecks.length > 0) {
        this.cb.onLog(
          `── 操作者验收判据（${acceptanceChecks.length} 项）：跑交付物本身，判据从未进入执行器上下文 ──`,
        );
        const accResults = await runSmokeChecks(acceptanceChecks.map(toSmokeCheck), {
          cwd: projectRoot,
          onEvent: (text) => this.cb.onLog(text),
          actionGate: this.deps.actionGate,
        });
        // 结果按**执行顺序**与判据一一对应（执行器首败即停，所以只会是前缀）。
        const tagged = accResults.map((r, i) => ({
          ...r,
          origin: "operator" as const,
          title: acceptanceTitle(acceptanceChecks[i]),
        }));
        // 产物存在性：命令退了 0 不代表东西交到了那个路径（2026-10-06 负结果的形态）。
        // 已因命令失败被判过的判据不再重复报 —— 同一件事两个来源就是两条账。
        const commandFailed = new Set(tagged.filter((r) => !r.ok).map((r) => r.title));
        const fileGaps = acceptanceChecks.some((c) => (c.expectFiles ?? []).length > 0)
          ? missingAcceptanceFiles(
              acceptanceChecks.filter((c) => !commandFailed.has(acceptanceTitle(c))),
              (rel) => (this.deps.fileExists ? this.deps.fileExists(projectRoot, rel) : false),
            )
          : [];
        if (fileGaps.length > 0 && !this.deps.fileExists) {
          // 没有探针 = 没核过。宁可判红，也不把"没核"报成"核过了"。
          this.cb.onLog("⚠️ 宿主没有接 fileExists 探针 ⇒ expectFiles 无法核对，按未通过处理。");
        }
        const fileResults = fileGaps.map((gap) => ({
          kind: "smoke" as const,
          ok: false,
          exitCode: null,
          logDigest: missingFilesMessage(gap.check, gap.missing),
          durationMs: 0,
          origin: "operator" as const,
          title: acceptanceTitle(gap.check),
        }));
        // 缺产物也要进日志：这是操作者最需要当场看到的那一行（凭据里是摘要，
        // 日志是"现在就知道"）。不加它的话，用户只看到"未交付"，得去翻凭据。
        for (const gap of fileGaps) this.cb.onLog(missingFilesMessage(gap.check, gap.missing));
        report = {
          passed: report.passed && tagged.every((r) => r.ok) && fileResults.length === 0,
          results: [...report.results, ...tagged, ...fileResults],
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

          repairs: this.repairsSeen,
          preexistingKinds: preexistingKindList,
          round,
          ...this.verifiedFieldsFor(report),
        });
        await this.maybeExportDelivery(projectRoot, batches);
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
      // 验收判据未过（B7）：重修提示必须先说清"判据不是你能改的测试" —— 否则
      // 最自然的修复动作会滑向"改一个能通过的断言"，而那正是这条判据要防的事。
      // 只加在未归属的那份 digest 上：有自己归属错误的执行器仍然先看自己那份，
      // 但它们同样会在下一轮看到整体摘要以外的这条提示（通过 lastFailedLogs 之上）。
      if (report.results.some((r) => r.origin === "operator" && !r.ok)) {
        lastDigest =
          "[操作者验收判据未通过]\n这些判据由操作者给定、从未出现在任务描述里：请改代码让它们成立，" +
          "**不要修改或绕过判据**（改测试不算修好）。\n\n" +
          lastDigest;
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
              // ⚠️ **量纲**：这里手里的数是**派发次数**（含首轮），不是重修轮数。
              // 第十二轮修的是升级弹窗（`shared/prompts.ts`），**这一处漏网了** ——
              // 旧文案把它直接念成"重修 N 轮"，于是 `maxRepairRounds: 0` 的 run
              // （**一次重修都不许有**）终止时报的是"重修 1 轮后仍未通过"；
              // 而同一条的 `stallReasonFor` 用的是 `maxRounds`，说的是"重修 0 轮"。
              // 两句话挂在同一个失败上，差 1 —— 正是第十二轮付过学费的那一类。
              //
              // 改法不是换个变量，是**把两个量纲都写出来**：读者要知道烧了几次，
              // 也要知道那几次里有多少属于重修才能判断"还剩没有机会再试一次"。
              throw new Error(
                `用户终止：任务「${t.title}」已尝试 ${attempts.get(t.id) ?? round + 1} 次` +
                  `（重修上限 ${maxRounds} 轮）后仍未通过`,
              );
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

                repairs: this.repairsSeen,
                preexistingKinds: preexistingKindList,
                round,
                ...this.verifiedFieldsFor(finalReport),
              });
              await this.maybeExportDelivery(projectRoot, batches);
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

          repairs: this.repairsSeen,
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
