/**
 * 交付后的可选**远端分发**（2026-10-12，竞品刷新清单 5.7 的**远端半边**）：
 * 本地半边（`./git-export`）只产出分支 + commit，且**永不 push**；这一层在
 * 操作者**显式开开关**时把那个分支推到指定 remote、可选开 PR、可选把 CI 的
 * 结论回流进日志。
 *
 * ## 信任面（为什么这里可以 push）
 *
 * `CommandPolicy` 的拒绝地板把 `git push` 判为拒绝，那是给**智能体生成/执行的
 * 验证命令**用的；本模块不是那条路径：它是操作者在 settings 里显式打开的交付
 * 分发动作（`deliveryRemote.mode`），remote 名与分支名都是我们自己的字符集校验
 * 过的字面量，全程 `shell: false`。地板的语义不变（验证命令里的 push 照样被拒），
 * 这里走的是"操作者授权"这条单独的信任面 —— 两件事不能混着说。
 *
 * ## 刻意不做 / 诚实边界
 *
 * - **不碰凭据**：push 走本机 git 凭据链（credential helper / SSH agent），PR 走
 *   `gh` 自己的登录态。我们不读、不存、不回显任何 token；`gh` 不在 PATH 或未登录
 *   时如实报"gh 不可用"，绝不退化成"把 token 交给某个参数"。
 * - **永不 `--force`**：强推覆盖远端历史是不可逆的外部动作，本模块没有这条路径。
 * - **只推指定 remote 的指定分支**：remote 名走 `[A-Za-z0-9._-]+`，分支名复用
 *   `BRANCH_RE`，基分支走 ref 字符集；三者都在跑命令之前自证。
 * - **CI 结论只回流到日志与返回值**：`failed` 名单是给人看的，也是给下一轮决策
 *   用的事实；**不自动触发重修**——"CI 红了要不要再派一轮"是策略问题，需要
 *   幂等与次数上限的设计，v1 不做，说破留着。
 * - **失败只写日志，不影响交付结论**：与本地半边同一口径 —— 硬门禁在交付前
 *   已经过了，分发层坏掉不追认门禁为假。
 */
import { BRANCH_RE, makeGitRunner } from "./git-export";

/** remote 名字符集（git remote 名的现实范围，收紧到无空格无斜杠）。 */
export const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
/** 基分支 / ref 字符集（允许一层以上的 `/`，不允许空格与控制字符）。 */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

export type DeliveryRemoteMode = "off" | "push" | "pr";

export interface GitRemoteInput {
  projectRoot: string;
  /** 本地已产出的交付分支（字符集由调用方保证，这里再校验一次）。 */
  branch: string;
  /** `"push"` = 只推分支；`"pr"` = 推送后开 PR（PR 失败不影响 push 已成立的事实）。 */
  mode: "push" | "pr";
  /** 远端名，默认 `"origin"`。 */
  remote?: string;
  /** PR 的基分支，默认 `"main"`。 */
  base?: string;
  /** PR 标题（mode="pr" 时用）。 */
  title?: string;
  /** PR 正文（mode="pr" 时用）。 */
  body?: string;
  /** 草稿 PR。 */
  draft?: boolean;
  /** 是否轮询 CI 结论（默认不轮询）。 */
  poll?: { intervalMs: number; maxPolls: number };
  /** 单条命令超时（毫秒），默认 120s。 */
  timeoutMs?: number;
  /** 命令执行器（默认真实 spawn，测试注入）。不抛错，非零退出码用 `code` 表达。 */
  run?: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 轮询间隔的等待（默认真实 setTimeout，测试注入）。 */
  sleep?: (ms: number) => Promise<void>;
}

export type ChecksState = "pass" | "fail" | "pending" | "unknown";

export interface GitRemoteResult {
  ok: boolean;
  /** 跳过原因（ok=true 且什么都没做时出现）。 */
  skipped?: "no-remote" | "no-changes";
  remote?: string;
  branch?: string;
  /** 分支已推到远端。 */
  pushed?: boolean;
  /** PR 已创建（仅 mode="pr"）。 */
  prUrl?: string;
  /** CI 结论（仅打开轮询时出现）。 */
  checks?: { state: ChecksState; failed: string[]; polls: number };
  /** 失败/未完成的原因（ok=false，或 PR/CI 没拿到结论时出现）。 */
  reason?: string;
}

/**
 * 从 settings 的 `deliveryRemote` 造出分发参数（**纯函数**，便于逐点审计）。
 * 返回 `null` = 不该分发（缺省或 `mode:"off"`）。
 *
 * 为什么把默认值（remote=origin / base=main / 轮询 30s×10）放在这里而不是
 * `publishDeliveryRemote` 里：后者是"给我参数我就执行"的执行器，两者的默认值
 * 不该重复定义。字段缺席与显式给值是同一语义（`exactOptionalPropertyTypes`），
 * 所以逐个判 `undefined` 再放进去。
 */
export function deliveryRemoteArgs(
  branch: string,
  cfg: {
    mode: "off" | "push" | "pr";
    remote?: string;
    base?: string;
    draft?: boolean;
    awaitChecks?: { intervalMs?: number; maxPolls?: number };
    timeoutMs?: number;
  },
): Omit<GitRemoteInput, "projectRoot" | "run" | "sleep"> | null {
  if (cfg.mode === "off") return null;
  const args: Omit<GitRemoteInput, "projectRoot" | "run" | "sleep"> = { branch, mode: cfg.mode };
  if (cfg.remote !== undefined) args.remote = cfg.remote;
  if (cfg.base !== undefined) args.base = cfg.base;
  if (cfg.draft) args.draft = true;
  if (cfg.awaitChecks) {
    args.poll = {
      intervalMs: cfg.awaitChecks.intervalMs ?? 30_000,
      maxPolls: cfg.awaitChecks.maxPolls ?? 10,
    };
  }
  if (cfg.timeoutMs !== undefined) args.timeoutMs = cfg.timeoutMs;
  return args;
}

type Runner = (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function tail(text: string, max = 200): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

/**
 * 解析 `gh pr checks --json name,state` 的输出。
 *
 * gh 的 `state` 是 GitHub CheckState 的大写枚举（SUCCESS / FAILURE / PENDING /
 * ERROR / EXPECTED / NEUTRAL / SKIPPED / TIMED_OUT / CANCELLED / ACTION_REQUIRED …）。
 * **解析不出来一律 unknown，绝不猜成绿**——这道闸的意义是"CI 说了什么"，
 * 不是"我们觉得它应该绿"。
 */
export function parseChecks(raw: string): { state: ChecksState; failed: string[] } {
  const text = raw.trim();
  if (text === "") return { state: "unknown", failed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "unknown", failed: [] };
  }
  if (!Array.isArray(parsed)) return { state: "unknown", failed: [] };
  const states: string[] = [];
  const failed: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const state = String((item as { state?: unknown }).state ?? "").toUpperCase();
    const name = String((item as { name?: unknown }).name ?? "unknown");
    states.push(state);
    if (state === "FAILURE" || state === "ERROR" || state === "CANCELLED" || state === "TIMED_OUT" || state === "ACTION_REQUIRED") {
      failed.push(name);
    }
  }
  if (states.length === 0) return { state: "unknown", failed: [] };
  if (failed.length > 0) return { state: "fail", failed };
  const pending = states.some((s) => s === "PENDING" || s === "EXPECTED" || s === "QUEUED" || s === "IN_PROGRESS" || s === "WAITING" || s === "REQUESTED");
  if (pending) return { state: "pending", failed: [] };
  return { state: "pass", failed: [] };
}

/** 从 `gh pr create` 的 stdout 里取 PR URL（末行 URL；取不到返回 undefined）。 */
export function firstUrl(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /https:\/\/\S+/.exec(lines[i]!);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * 主入口。永不 throw：所有失败都折进结果对象，分发永远不影响交付结论。
 */
export async function publishDeliveryRemote(input: GitRemoteInput): Promise<GitRemoteResult> {
  const run: Runner =
    input.run ?? ((command, args) => makeGitRunner(input.timeoutMs ?? 120_000, input.projectRoot)(command, args));
  const remote = input.remote ?? "origin";
  const base = input.base ?? "main";

  // 0. 三者先自证：branch 是本地半边生成的，remote/base 来自 settings —— 都要过字符集。
  if (!BRANCH_RE.test(input.branch)) {
    return { ok: false, reason: `分支名不合法：${JSON.stringify(input.branch)}` };
  }
  if (!REMOTE_RE.test(remote)) {
    return { ok: false, reason: `远端名不合法：${JSON.stringify(remote)}` };
  }
  if (!REF_RE.test(base)) {
    return { ok: false, reason: `基分支不合法：${JSON.stringify(base)}` };
  }

  // 1. 远端存在吗（不在 = 配置问题，跳过不是失败）。
  const remotes = await run("git", ["remote"]);
  if (remotes.code !== 0) {
    return { ok: false, reason: `git remote 失败：${tail(remotes.stderr)}` };
  }
  if (!remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean).includes(remote)) {
    return { ok: true, skipped: "no-remote" };
  }

  // 2. 推分支（-u 建上游；**永不 --force**）。凭据由本机 git 凭据链提供。
  const push = await run("git", ["push", "-u", remote, input.branch]);
  if (push.code !== 0) {
    return {
      ok: false,
      remote,
      reason: `git push 失败（凭据/权限/网络？本模块不碰凭据）：${tail(push.stderr)}`,
    };
  }
  const result: GitRemoteResult = { ok: true, remote, branch: input.branch, pushed: true };

  // 3. 只推分支的档位到此为止（不碰 gh）。
  if (input.mode === "push") return result;

  // 4. 开 PR。gh 不在 / 未登录 → 如实说破，不退化成别的路径。
  const prArgs = [
    "pr",
    "create",
    "--head",
    input.branch,
    "--base",
    base,
    "--title",
    input.title ?? `OxCommander delivery ${input.branch}`,
    "--body",
    input.body ?? "由 OxCommander 交付流水线自动导出（zone 内改动，已过硬门禁）。",
  ];
  if (input.draft) prArgs.push("--draft");
  const pr = await run("gh", prArgs);
  if (pr.code !== 0) {
    return {
      ...result,
      ok: false,
      reason: `gh pr create 失败（gh 未安装 / 未登录 / 该远端不是 GitHub？）：${tail(pr.stderr)}`,
    };
  }
  const url = firstUrl(pr.stdout);
  if (!url) {
    return { ...result, ok: false, reason: `gh pr create 成功但没解析出 PR 地址：${tail(pr.stdout)}` };
  }
  result.prUrl = url;

  // 5. 可选：轮询 CI 结论（默认不轮询 —— 分发不该默认阻塞到 CI 跑完）。
  if (!input.poll) return result;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = Math.max(1, input.poll.maxPolls);
  let polls = 0;
  let last: { state: ChecksState; failed: string[] } = { state: "unknown", failed: [] };
  for (let i = 0; i < maxPolls; i++) {
    polls += 1;
    const checks = await run("gh", ["pr", "checks", input.branch, "--json", "name,state"]);
    last = checks.code === 0 ? parseChecks(checks.stdout) : { state: "unknown", failed: [] };
    if (last.state !== "pending" && last.state !== "unknown") break;
    if (i < maxPolls - 1) await sleep(input.poll.intervalMs);
  }
  result.checks = { state: last.state, failed: last.failed, polls };
  return result;
}
