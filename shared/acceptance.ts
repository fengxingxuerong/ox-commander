/**
 * 操作者验收判据的**归一化与判定**（B7，2026-10-28）—— 纯逻辑，零 IO。
 *
 * 为什么这一层存在（它不是"再多一种验证命令"）：
 *
 * 硬门禁验的是项目自己的 build/typecheck/test，而测试是**执行器可以写、可以改**
 * 的。于是 `npm test` 绿只证明"它写的测试认可它自己"——判据的输入由被判定方
 * 提供，这正是 product-spec 的 R1（判据必须独立于被判定方）在实现上的缺口。
 * 验收判据补的是另一半：命令与期望由**操作者**给定，从不进任务描述、不进规划
 * 提示，执行器看不见自己要被怎么验；判定跑的是交付物本身（黑盒），不是它的自测。
 *
 * 三件事刻意都在这一层用纯函数做完（可被逐位点审计，不必起进程）：
 *   · `normalizeAcceptanceChecks` —— 把宿主/配置文件里的原始值收窄成合法判据；
 *   · `toSmokeCheck`              —— 映射到已经被验证过的那套执行器输入；
 *   · `missingAcceptanceFiles`    —— "命令说通过了，东西真的在那个路径吗"。
 *
 * 边界（说清楚比做得更多重要）：
 *   · 这里**不判断语义**（"输出内容对不对"没有机械判据，那属于 advisory）；
 *   · 判据的出处只在 `acceptanceChecks` 这一个入口，别处塞进来的冒烟不算；
 *   · 未知字段**整条拒收**（不是忽略）：拼错的 `expectContain` 若被静默丢掉，
 *     这条判据就退化成"只看退出码"，而使用者以为它在验输出 —— 那比没有更坏。
 */
import type { AcceptanceCheck, SmokeCheck } from "./types";

/** 单次 run 最多几条。与 `MAX_SMOKE_CHECKS` 同量级：判据是承诺，不是清单。 */
export const MAX_ACCEPTANCE_CHECKS = 10;

/** 每条判据认识的字段。多一个就拒 —— 见文件头"未知字段整条拒收"。 */
const KNOWN_KEYS = new Set(["title", "command", "args", "stdin", "expectContains", "expectFiles"]);

export interface AcceptanceNormalization {
  checks: AcceptanceCheck[];
  /** 人读的问题清单；空数组 = 这份输入没话说。 */
  issues: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 字符串数组收窄：去空、去重、保序。
 *
 * 去重是承重的：同一条期望写两遍会让"缺 2 条"的结论凭空多一条。
 * 保序而不是排序：判据的书写顺序是操作者的表达（先验主流程、再验边界）。
 *
 * 三种结果必须分开（不能都折成"没写"）：没写 = 这条判据不看该项；写错了 =
 * 配置问题，必须报出来；否则一个写成 `expectContains: "rows=3"`（不是数组）
 * 的判据会退化成"只看退出码"，而操作者以为它在验输出。
 */
function cleanStringArray(raw: unknown): {
  absent: boolean;
  invalid: boolean;
  value?: string[];
  dropped: number;
} {
  if (raw === undefined || raw === null) return { absent: true, invalid: false, dropped: 0 };
  if (!Array.isArray(raw)) return { absent: false, invalid: true, dropped: 0 };
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    if (typeof item !== "string") {
      dropped += 1;
      continue;
    }
    const trimmed = item.trim();
    if (trimmed === "") {
      dropped += 1;
      continue;
    }
    seen.add(trimmed);
  }
  return { absent: false, invalid: false, value: seen.size > 0 ? [...seen] : undefined, dropped };
}

/**
 * `expectFiles` 只收项目内的相对路径。
 *
 * 绝对路径与 `..` 在这里就拒掉，而不是等 `fileExists` 探针去判：探针的口径
 * 可能随宿主变化（realpath / 越根判定），而配置里的路径是**静态可判**的。
 * 用 `/` 与 `\` 两种分隔符都算穿越 —— 配置文件可能来自另一个平台。
 */
function isSafeRelativePath(p: string): boolean {
  // 不判空串：调用方（`cleanStringArray`）已经剔掉空条目，这里再判一次就是
  // 一条**永远走不到**的分支 —— 变异审计里它会以"存活"的形式出现，而补一条
  // 永远不通过的断言只是把它藏起来。宁可删掉。
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[/\\]/).includes("..");
}

/**
 * 把原始值收窄成判据列表。
 *
 * 与 `parseCommands`（protocol）的分工：那边管"验证命令"的传输格式，这边管
 * "验收判据"的语义边界；两侧都对坏形状**报错而不是丢弃**，因为它们都会被
 * 当成"验过了"的证据。
 */
export function normalizeAcceptanceChecks(raw: unknown): AcceptanceNormalization {
  const issues: string[] = [];
  if (raw === undefined) return { checks: [], issues };
  if (!Array.isArray(raw)) {
    return { checks: [], issues: ["acceptanceChecks 必须是数组"] };
  }
  const checks: AcceptanceCheck[] = [];
  for (const [i, item] of raw.entries()) {
    if (checks.length >= MAX_ACCEPTANCE_CHECKS) {
      issues.push(`acceptanceChecks 最多 ${MAX_ACCEPTANCE_CHECKS} 条，第 ${i + 1} 条起已忽略`);
      break;
    }
    if (!isPlainObject(item)) {
      issues.push(`acceptanceChecks[${i}] 必须是对象`);
      continue;
    }
    const unknown = Object.keys(item).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length > 0) {
      // 整条拒收：见文件头 —— 静默忽略一个拼错的期望字段，等于把这条判据
      // 降级成"只看退出码"，而操作者以为它在验输出。
      issues.push(`acceptanceChecks[${i}] 有不认识的字段：${unknown.join("、")}（整条已拒收）`);
      continue;
    }
    const command = typeof item.command === "string" ? item.command.trim() : "";
    if (command === "") {
      issues.push(`acceptanceChecks[${i}].command 必须是非空字符串`);
      continue;
    }
    const args = item.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      issues.push(`acceptanceChecks[${i}].args 必须是字符串数组`);
      continue;
    }
    if (item.stdin !== undefined && typeof item.stdin !== "string") {
      issues.push(`acceptanceChecks[${i}].stdin 必须是字符串`);
      continue;
    }
    if (item.title !== undefined && (typeof item.title !== "string" || item.title.trim() === "")) {
      issues.push(`acceptanceChecks[${i}].title 必须是非空字符串（不写就由 command + args 派生）`);
      continue;
    }
    const expectContains = cleanStringArray(item.expectContains);
    if (expectContains.invalid) {
      issues.push(`acceptanceChecks[${i}].expectContains 必须是字符串数组`);
      continue;
    }
    if (expectContains.dropped > 0) {
      issues.push(`acceptanceChecks[${i}].expectContains 里有 ${expectContains.dropped} 个空/非字符串条目，已剔除`);
    }
    const expectFilesRaw = cleanStringArray(item.expectFiles);
    if (expectFilesRaw.invalid) {
      issues.push(`acceptanceChecks[${i}].expectFiles 必须是字符串数组`);
      continue;
    }
    if (expectFilesRaw.dropped > 0) {
      issues.push(`acceptanceChecks[${i}].expectFiles 里有 ${expectFilesRaw.dropped} 个空/非字符串条目，已剔除`);
    }
    const unsafe = (expectFilesRaw.value ?? []).filter((p) => !isSafeRelativePath(p));
    if (unsafe.length > 0) {
      issues.push(
        `acceptanceChecks[${i}].expectFiles 只收项目内相对路径（拒掉：${unsafe.join("、")}）`,
      );
      continue;
    }
    checks.push({
      // 标题是可选字段；不写就由 command + args 派生，日志与凭据里总有一个名字。
      ...(typeof item.title === "string" ? { title: item.title.trim() } : {}),
      command,
      // args 原样保留：不 trim —— 参数里的空格可能是语义的一部分。
      args: args as string[],
      ...(typeof item.stdin === "string" ? { stdin: item.stdin } : {}),
      ...(expectContains.value ? { expectContains: expectContains.value } : {}),
      ...(expectFilesRaw.value ? { expectFiles: expectFilesRaw.value } : {}),
    });
  }
  return { checks, issues };
}

/** 一条判据的人类可读名字：优先用 title，否则由命令派生（与日志/凭据同一口径）。 */
export function acceptanceTitle(check: AcceptanceCheck): string {
  const title = check.title?.trim();
  if (title !== undefined && title !== "") return title;
  return `${check.command} ${check.args.join(" ")}`.trim();
}

/**
 * 映射到独立样本冒烟的执行器输入。
 *
 * 为什么复用冒烟执行器而不是另写一套 spawn：那一套已经过沙箱门（策略 + 跨动作
 * 升级）、双超时、输出字节预算与 R1（判定只认 `close` 的退出码与正向片段），
 * 再写一遍等于把已经付过代价的判据复制一份去腐化。
 */
export function toSmokeCheck(check: AcceptanceCheck): SmokeCheck {
  return {
    title: acceptanceTitle(check),
    command: check.command,
    args: check.args,
    ...(check.stdin !== undefined ? { stdin: check.stdin } : {}),
    ...(check.expectContains ? { expectContains: check.expectContains } : {}),
  };
}

export interface AcceptanceFileGap {
  check: AcceptanceCheck;
  missing: string[];
}

/**
 * 命令跑完之后，"期望存在的产物"里哪些不在。
 *
 * `exists` 由宿主注入（引擎的 fileExists 探针 / 测试的假件）—— 本层不碰 fs。
 * 只返回**有缺**的条目：通过的那些不需要在结果里再占一行。
 */
export function missingAcceptanceFiles(
  checks: readonly AcceptanceCheck[],
  exists: (rel: string) => boolean,
): AcceptanceFileGap[] {
  const gaps: AcceptanceFileGap[] = [];
  for (const check of checks) {
    const missing = (check.expectFiles ?? []).filter((rel) => !exists(rel));
    if (missing.length > 0) gaps.push({ check, missing });
  }
  return gaps;
}

/** 缺产物那一条的人类可读结论（进日志与凭据的 headline）。 */
export function missingFilesMessage(check: AcceptanceCheck, missing: readonly string[]): string {
  return `[验收] ${acceptanceTitle(check)}：期望的产物不在盘上 —— ${missing.join("、")}`;
}
