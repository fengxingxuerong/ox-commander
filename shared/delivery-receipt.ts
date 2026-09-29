import type { VerificationKind } from "./types";
import type { UsageSnapshot } from "./usage-meter";

/**
 * 交付凭据（delivery receipt）：一次 run 结束时**对外可验**的那份结论。
 *
 * 为什么要有它：到今天为止，一次运行留下的对外证据是散的 —— 验证结果是一条
 * `verification` 事件、任务是若干 `task` 事件、越权是一条 `conflict` 事件、
 * 用量是一条 `usage` 事件。要看"这次到底交付了什么、凭什么说它是对的"，
 * 得自己把四种事件在时间轴上重新拼起来。而竞品（Orca / paperclip 那一类）
 * 的终点是"把 N 份 diff 摆给人挑"，我们的终点应该是一份能自己说话的结论。
 *
 * 这份文件的职责只有一件：**把引擎已经掌握的事实归一化成一份结构化凭据**。
 * 它不采集任何东西（采集在 `usage-meter` 与 `batch-guard`），也不做 IO
 * —— 纯函数，所以可以进变异门禁被逐位点审。
 *
 * 字段即承诺：**拿不到就整个键不出现**（与 headless 协议同风格），
 * 不给宿主"0 是不是真的 0"这种歧义。
 */

/** 本次运行的结局。只有两档，因为"成功/失败"之外的状态不具备对外结论价值。 */
export type ReceiptOutcome = "delivered" | "blocked";

/** 一条验证命令的结论。 */
export interface ReceiptCheck {
  kind: VerificationKind;
  ok: boolean;
  exitCode: number | null;
  /**
   * 这条命令在**本次运行开始前**就是红的（基线验证发现的）。
   *
   * 标出来的意义是归因：它不属于任何智能体的账。没有这个标记时，
   * "交付了但 typecheck 是红的"会读成"这批改动把 typecheck 写坏了"，
   * 而真相可能是目标项目本来就缺依赖。
   */
  preexisting: boolean;
  /** 失败原因首行（已截断），给 UI 直接展示；通过的检查为空串。 */
  headline: string;
}

/** 一次越权判定及其处置。 */
export interface ReceiptConflict {
  kind: string;
  paths: string[];
  /** 仲裁动作；未能与任何 remedy 配对时为 `"none"`（沿用协议既有语义）。 */
  remedy: string;
}

export type ReceiptTaskStatus = "done" | "failed" | "skipped" | "pending";

export interface ReceiptTask {
  id: string;
  title: string;
  zone: string;
  status: ReceiptTaskStatus;
  attempts: number;
  agentId?: string;
  durationMs?: number;
  errorClass?: string;
}

/** 用量投影：只留"对账用得上"的字段，`byModel` 明细留给 `usage` 协议事件。 */
export interface ReceiptUsage {
  totalTokens: number;
  calls: number;
  measuredCalls: number;
  /** 预算上限；settings 未配置时不出现（同 `UsageSnapshot`）。 */
  limit?: number;
}

export interface ReceiptInput {
  outcome: ReceiptOutcome;
  /**
   * 这次交付**有没有被构建/测试真正验过**。
   *
   * 与 `outcome` 是两件独立的事：`verificationCommands: []` 是合法配置，
   * 空集在 `verifyProject` 里恒为通过 —— 于是"全部验证通过"其实什么都没验。
   * 所以交付成功也可能是 `verified: false`，那时 `unverifiedReason` 必须说清。
   */
  verified: boolean;
  /** `verified` 为 false 时的原因（一句话）。 */
  unverifiedReason?: string;
  /** 实际跑过的重修轮数（0 表示一轮通过）。 */
  rounds: number;
  checks: ReceiptCheck[];
  tasks: ReceiptTask[];
  conflicts: ReceiptConflict[];
  usage?: UsageSnapshot;
}

export interface ReceiptCounts {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  conflicts: number;
  checksFailed: number;
  /** 其中"本次运行前就已失败"的检查条数。 */
  preexisting: number;
}

export interface DeliveryReceipt {
  outcome: ReceiptOutcome;
  verified: boolean;
  unverifiedReason?: string;
  rounds: number;
  checks: ReceiptCheck[];
  tasks: ReceiptTask[];
  conflicts: ReceiptConflict[];
  usage?: ReceiptUsage;
  counts: ReceiptCounts;
  /** 一行人类可读结论，供看板日志与审计直接落。 */
  headline: string;
}

/**
 * 把冲突与处置配对成凭据条目。
 *
 * 这份配对此前在 `electron/ipc/context.ts` 与 `headless/run-spec.ts` 各写了一遍
 * —— 两处都靠"remedy 的 paths 与 conflict 的 paths 有交集"来配。重复实现意味着
 * 凭据里的处置与事件流里的处置可能不一致，而那种不一致没人会测到。现在两侧共用它。
 */
export function pairConflict(
  conflict: { kind: string; paths: string[] },
  remedies: Array<{ action: string; paths: string[] }>,
): ReceiptConflict {
  const matched = remedies.find((r) => r.paths.some((p) => conflict.paths.includes(p)));
  return {
    kind: conflict.kind,
    // 去重 + 字典序：同一条冲突被两个 run 命中时路径会重复，而顺序不稳定会让
    // 同一份凭据在两次运行里"看起来不一样"（审计对不上）。
    paths: [...new Set(conflict.paths)].sort(),
    remedy: matched ? matched.action : "none",
  };
}

/**
 * 一个任务在凭据里的状态。
 *
 * 判定顺序是承重的，且刻意放在纯逻辑层 —— 引擎里那几种组合（跳过 / 完成 /
 * 有成功结果却被全员重跑清掉完成记录 / 从未派发）很难端到端构造，放在这里
 * 才能被逐位点审到。
 *
 * - `skipped` 优先于完成：用户跳过的任务也会被加进"已完成"集合（它已不需要
 *   再做），先判完成会把"人放弃的"报成"做出来的"；
 * - 有成功结果却不在完成集合里 ⇒ **尚未落地**（全员重跑把完成记录清了、这轮
 *   还没重派完），不是失败 —— 报成失败会让凭据凭空多一笔失败账。
 */
export function receiptTaskStatus(input: {
  skipped: boolean;
  done: boolean;
  outcomeOk?: boolean;
}): ReceiptTaskStatus {
  if (input.skipped) return "skipped";
  if (input.done) return "done";
  if (input.outcomeOk === false) return "failed";
  return "pending";
}

function countTasks(tasks: ReceiptTask[]): Omit<ReceiptCounts, "conflicts" | "checksFailed" | "preexisting"> {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  for (const t of tasks) {
    if (t.status === "done") done += 1;
    else if (t.status === "failed") failed += 1;
    else if (t.status === "skipped") skipped += 1;
    else pending += 1;
  }
  return { total: tasks.length, done, failed, skipped, pending };
}

/** 凭据的那句结论。措辞刻意带上"凭什么"，而不只是"成了没成"。 */
export function receiptHeadlineFor(input: {
  outcome: ReceiptOutcome;
  verified: boolean;
  unverifiedReason?: string;
  rounds: number;
  counts: ReceiptCounts;
  checks: number;
}): string {
  const c = input.counts;
  const taskPart = `${c.done}/${c.total} 个任务完成`;
  const skipPart = c.skipped > 0 ? `（跳过 ${c.skipped} 个）` : "";
  const roundPart = input.rounds > 0 ? `，重修 ${input.rounds} 轮` : "";
  if (input.outcome === "blocked") {
    const why = [c.failed > 0 ? `${c.failed} 个失败` : "", c.pending > 0 ? `${c.pending} 个未启动` : ""]
      .filter((s) => s !== "")
      .join("、");
    return `未交付：${taskPart}${skipPart}，${why || "仍有任务未完成"}${roundPart}。改动已留在工作区，未通过门禁`;
  }
  if (!input.verified) {
    return `已交付但**未经构建/测试验证**：${input.unverifiedReason ?? "没有验证命令实际运行过"}（${taskPart}${skipPart}）`;
  }
  const checkPart = `${input.checks} 条验证命令通过`;
  const conflictPart = c.conflicts > 0 ? `；发生 ${c.conflicts} 次越权并已处置` : "";
  const prePart = c.preexisting > 0 ? `（其中 ${c.preexisting} 条本次运行前就是红的）` : "";
  return `已交付：${taskPart}${skipPart}${roundPart}；${checkPart}${prePart}${conflictPart}`;
}

/**
 * 归一化成一份凭据。
 *
 * 刻意不做的事：不校验"verified 与 outcome 是否自相矛盾"。交付成功但未验证是
 * 合法状态（纯文档任务确实不需要构建），矛盾要如实呈现，而不是被纠正掉 ——
 * 纠正会让"零验证交付"这个事实消失。
 */
export function buildReceipt(input: ReceiptInput): DeliveryReceipt {
  const conflicts = input.conflicts.map((c) => ({ ...c, paths: [...new Set(c.paths)].sort() }));
  const checksFailed = input.checks.filter((c) => !c.ok).length;
  const preexisting = input.checks.filter((c) => c.preexisting).length;
  const counts: ReceiptCounts = {
    ...countTasks(input.tasks),
    conflicts: conflicts.length,
    checksFailed,
    preexisting,
  };
  const usage: ReceiptUsage | undefined = input.usage
    ? {
        totalTokens: input.usage.totalTokens,
        calls: input.usage.calls,
        measuredCalls: input.usage.measuredCalls,
        ...(input.usage.limit !== undefined ? { limit: input.usage.limit } : {}),
      }
    : undefined;
  const headline = receiptHeadlineFor({
    outcome: input.outcome,
    verified: input.verified,
    ...(input.unverifiedReason !== undefined ? { unverifiedReason: input.unverifiedReason } : {}),
    rounds: input.rounds,
    counts,
    checks: input.checks.length,
  });
  return {
    outcome: input.outcome,
    verified: input.verified,
    ...(input.unverifiedReason !== undefined ? { unverifiedReason: input.unverifiedReason } : {}),
    rounds: input.rounds,
    checks: input.checks,
    tasks: input.tasks,
    conflicts,
    ...(usage ? { usage } : {}),
    counts,
    headline,
  };
}

/** 一行摘要（与 `formatUsageLine` 同风格），供看板日志与审计落盘。 */
export function formatReceiptLine(r: DeliveryReceipt): string {
  const parts = [r.headline];
  if (r.usage) {
    const blind = r.usage.calls - r.usage.measuredCalls;
    parts.push(`${r.usage.totalTokens} tokens`);
    if (blind > 0) parts.push(`${blind} 次调用未上报用量`);
  }
  return `[receipt] ${parts.join(" · ")}`;
}
