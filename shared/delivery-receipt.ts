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
  /**
   * **实际跑过的命令**（外部可验证的基石）。
   *
   * 没有它时，"这份交付过了门禁"只是一句自述 —— 拿到凭据的人只能选择相信我们。
   * 有了它，任何人在自己的环境里跑同一条命令就能得到自己的观察。
   * 缺席 = 这条检查不经过命令（纯逻辑判定），不是"我们懒得记"。
   */
  command?: string;
  args?: string[];
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
  /**
   * 内容指纹：`canonicalReceiptPayload` 的哈希（外部可复核的第二半）。
   *
   * **它保证什么**：凭据内容与指纹一致 —— 任何对凭据的改动（哪怕是补一个字段）
   * 都会让指纹对不上，复核工具当场说破。它是"这份凭据有没有被改过"的答案。
   *
   * **它不保证什么**（说清热绒在验收时不会被误导）：它不是**签名**。
   * 能改凭据的人同样能重算指纹。要真正防伪造，需要一个复核方信任的密钥 ——
   * 那是密钥分发问题，不是哈希能解决的，本字段刻意不假装解决它。
   * 缺席 = 构建时没给哈希函数（字段即承诺，不给就一条都不编）。
   */
  fingerprint?: string;
}

/**
 * 凭据的**规范序列化**：确定性、与键序无关、排除指纹本身。
 *
 * 为什么必须是纯逻辑且确定的：指纹只有在"同一份内容永远得到同一个字节串"时
 * 才有意义。依赖 JS 对象键序是不够的 —— 一次 JSON 往返、一个不同版本的序列化器
 * 就可能改变键序，于是同一份凭据算出两个指纹，"被改过"变成噪声。
 * 所以这里显式排序键，并递归处理数组与嵌套对象。
 *
 * 排除 `fingerprint` 是定义上的必需：指纹是对**其余内容**的承诺，
 * 把自己算进去就成了自指（先有鸡还是先有蛋）。
 */
export function canonicalReceiptPayload(receipt: DeliveryReceipt): string {
  const { fingerprint: _ignored, ...rest } = receipt;
  return stableStringify(rest);
}

/** 排序键的确定性序列化。数组保持原序：命令顺序与任务顺序本身是语义。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // 缺席的键不进序列化：`{a: undefined}` 与 `{}` 必须得到同一个指纹，
    // 否则"给可选字段显式赋 undefined"会凭空改变指纹。
    .filter(([, v]) => v !== undefined)
    // 比较器刻意只有两支：对象键**天然唯一**，`a === b` 永不发生，
    // 所以 `a > b ? 1 : 0` 是死分支 —— 原来那支还让"三元分支互换"变异
    // 无法构造输入（互换后仍满足"`< 0` 当且仅当 a < b"，实测 400×9 组
    // 随机键、n 从 2 到 1000 顺序全部一致）。删掉后只剩一个可被杀的三元。
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * 给凭据盖章：算出指纹并贴上去。
 *
 * 哈希函数由调用方注入 —— `shared/` 是纯逻辑层，不能 import `node:crypto`，
 * 而"用什么哈希"又恰恰是宿主的决定（桌面用 sha256，测试可注入确定性替身）。
 */
export function sealReceipt(receipt: DeliveryReceipt, hash: (s: string) => string): DeliveryReceipt {
  return { ...receipt, fingerprint: hash(canonicalReceiptPayload(receipt)) };
}

/**
 * 复核一份凭据：内容与指纹是否一致。
 *
 * 返回结构化结论而不是布尔 —— "指纹对不上"与"压根没有指纹"是两件事：
 * 前者是被改过，后者只是这份凭据没盖章。把它们并成 false 会让复核工具
 * 把"没盖章"报成"被篡改"，那是诬告。
 */
export function verifyReceiptFingerprint(
  receipt: DeliveryReceipt,
  hash: (s: string) => string,
): { ok: boolean; reason: "match" | "mismatch" | "unsigned"; expected?: string; actual?: string } {
  if (receipt.fingerprint === undefined) return { ok: false, reason: "unsigned" };
  const expected = hash(canonicalReceiptPayload(receipt));
  if (expected === receipt.fingerprint) return { ok: true, reason: "match" };
  return { ok: false, reason: "mismatch", expected, actual: receipt.fingerprint };
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

/**
 * 复跑一条检查得到的观察（由复核工具采集，与凭据比对）。
 *
 * `exitCode` 用 `null` 表示"没拿到退出码"（进程起不来 / 超时被杀），
 * 与"退出码是 0"是两种事实 —— 混起来会让"命令根本没跑成"被读成"跑通了"。
 */
export interface CheckObservation {
  kind: VerificationKind;
  ok: boolean;
  exitCode: number | null;
}

export type CheckVerdict = "reproduced" | "contradicted" | "unrunnable";

export interface CheckComparison {
  kind: VerificationKind;
  /** 凭据声称的结论。 */
  claimed: boolean;
  /** 复跑的实际观察；`unrunnable` 时缺席（没跑成，就没有观察可言）。 */
  observed?: boolean;
  verdict: CheckVerdict;
  /**
   * 两边都失败但退出码不同 —— 记为 `reproduced` 但值得写出来。
   * （同一条命令在不同机器上退出码可能不同，而"都失败"这个结论是一致的。）
   */
  note?: string;
}

/**
 * 比对"凭据声称的检查结论"与"复跑得到的观察"（外部可验证的核心判定）。
 *
 * 三类结论，刻意分开：
 *   · `reproduced`  —— 复跑得到了同样的 ok（**这才是"验证通过"被复核的证据**）；
 *   · `contradicted` —— 凭据说 ok、复跑说 not ok（或反之）。**凭据不可信**；
 *   · `unrunnable` —— 这条检查没有命令可跑（纯逻辑判定 / 工具跑不动），
 *     **不构成对凭据的否定**，只是"这条复核不了"。
 *
 * 为什么 `unrunnable` 必须与 `contradicted` 分开：把"我跑不动"报成"你骗人"
 * 是诬告 —— 复核工具的假阳性比假阴性更伤信任（一次误报之后，真报也没人信了）。
 *
 * 配对规则：按 `kind` 在观察集里找同名的。同 kind 多条时取**第一条尚未被认领的**
 * （顺序消费，与凭据里的检查顺序一致）—— 同名检查（例如两条 test）不该都对着
 * 第一条观察比。
 */
export function compareChecks(
  claimed: ReceiptCheck[],
  observed: CheckObservation[],
): CheckComparison[] {
  const pool = observed.map((o) => ({ ...o, taken: false }));
  return claimed.map((c) => {
    const hit = pool.find((o) => !o.taken && o.kind === c.kind);
    if (!hit) {
      return { kind: c.kind, claimed: c.ok, verdict: "unrunnable" as const };
    }
    hit.taken = true;
    if (hit.ok === c.ok) {
      // 都失败时把退出码差异写出来（结论一致，但现场不同，值得知道）
      if (!c.ok && c.exitCode !== null && hit.exitCode !== null && c.exitCode !== hit.exitCode) {
        return {
          kind: c.kind,
          claimed: c.ok,
          observed: hit.ok,
          verdict: "reproduced" as const,
          note: `两边都失败，但退出码不同（凭据 ${c.exitCode} / 复跑 ${hit.exitCode}）`,
        };
      }
      return { kind: c.kind, claimed: c.ok, observed: hit.ok, verdict: "reproduced" as const };
    }
    return { kind: c.kind, claimed: c.ok, observed: hit.ok, verdict: "contradicted" as const };
  });
}

/**
 * 从凭据取出**可复跑的命令清单**（复核工具据此在对方环境里重放）。
 *
 * 只挑带 `command` 的检查：没有命令的（纯逻辑判定）复跑不了，
 * 硬编一条命令去跑等于伪造观察 —— 那正是这个工具存在的反面。
 */
export function replayableCommands(r: DeliveryReceipt): Array<{ kind: VerificationKind; command: string; args: string[] }> {
  return r.checks
    .filter((c): c is ReceiptCheck & { command: string } => typeof c.command === "string" && c.command !== "")
    .map((c) => ({ kind: c.kind, command: c.command, args: c.args ?? [] }));
}

/** 一份凭据的复核总裁决。五档，刻意不并档 —— 每档该做什么完全不同。 */
export type ReceiptVerdict =
  /** 指纹一致 + 复跑全部复现。**这是唯一能说"凭据可信"的档**。 */
  | "verified"
  /** 指纹一致，但没有复跑（只查了完整性，没查结论真伪）。 */
  | "not-replayed"
  /** 指纹对不上 —— 内容被改过。此时**任何**复跑比对都无意义（比的是假凭据）。 */
  | "tampered"
  /** 这份凭据压根没盖章，无从判断完整性。 */
  | "unsigned"
  /** 指纹一致但复跑对不上 —— 凭据自己声称的结论与环境观察矛盾。 */
  | "contradicted";

export interface ReceiptAudit {
  verdict: ReceiptVerdict;
  fingerprint: { ok: boolean; reason: "match" | "mismatch" | "unsigned"; expected?: string; actual?: string };
  /** 凭据里带命令、因此**可以被独立复跑**的检查条数。 */
  replayable: number;
  /** 逐条比对（按 kind 同名配对）。没复跑时为空数组。 */
  comparisons: CheckComparison[];
  /** 一行人类可读结论，复核工具直接打印。 */
  summary: string;
}

/**
 * 把"指纹结果 + 复跑比对"合成一份复核裁决（外部可验证的落点）。
 *
 * 判定顺序是承重的：
 *   1. **指纹不符直接判 `tampered`，不看复跑结果** —— 内容都被改过了，拿一个假凭据
 *      去和环境比对，比出来的"矛盾"是伪证的产物，不是环境的错。早退避免诬告。
 *   2. 没盖章判 `unsigned`：不是"被篡改"，只是"没提供完整性凭据"。
 *   3. 有比对且全部复现才叫 `verified`；只要有一条被推翻就是 `contradicted`。
 *   4. 一条都没复跑（`comparisons` 为空）时只能到 `not-replayed` ——
 *      **指纹一致不等于结论为真**，它只说明"没被改过"。把这两件事混为一谈，
 *      复核工具就成了给自述背书的橡皮图章。
 */
export function auditReceipt(
  receipt: DeliveryReceipt,
  fingerprint: { ok: boolean; reason: "match" | "mismatch" | "unsigned"; expected?: string; actual?: string },
  comparisons: CheckComparison[] = [],
): ReceiptAudit {
  const replayable = replayableCommands(receipt).length;

  if (fingerprint.reason === "mismatch") {
    return {
      verdict: "tampered",
      fingerprint,
      replayable,
      comparisons: [],
      summary: "凭据内容与指纹不符 —— 这份凭据被改过，其中的结论不予采信。",
    };
  }
  if (fingerprint.reason === "unsigned") {
    return {
      verdict: "unsigned",
      fingerprint,
      replayable,
      comparisons: [],
      summary: "凭据没有指纹，无法判断内容是否被改过。",
    };
  }

  const contradicted = comparisons.filter((c) => c.verdict === "contradicted");
  if (contradicted.length > 0) {
    return {
      verdict: "contradicted",
      fingerprint,
      replayable,
      comparisons,
      summary:
        `复跑与凭据矛盾 ${contradicted.length} 条（${contradicted
          .map((c) => `${c.kind}: 凭据说${c.claimed ? "通过" : "失败"}、复跑说${c.observed ? "通过" : "失败"}`)
          .join("；")}）—— 凭据的结论与本地观察不一致，需查明差异来源。`,
    };
  }
  if (comparisons.length === 0) {
    return {
      verdict: "not-replayed",
      fingerprint,
      replayable,
      comparisons: [],
      summary: `指纹一致（内容未被改动），但未复跑 —— ${replayable} 条命令可用 --replay 独立验证。`,
    };
  }
  const unrunnable = comparisons.filter((c) => c.verdict === "unrunnable").length;
  const tail = unrunnable > 0 ? `；另有 ${unrunnable} 条无命令可比（不构成对凭据的否定）` : "";
  return {
    verdict: "verified",
    fingerprint,
    replayable,
    comparisons,
    summary: `复跑复现全部 ${comparisons.length} 条结论${tail}。指纹一致。`,
  };
}
