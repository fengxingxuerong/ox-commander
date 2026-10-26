/**
 * 交付凭据 → **GitHub commit status**（2026-10-26，第七轮竞品吸收 3）。
 *
 * ## 为什么要有这一层
 *
 * 我们的卖点是"交付一份过了门禁的凭据"，但这份结论过去只有**看得见我们界面的人**才认
 * （桌面凭据卡、`receipt:verify` 的退出码）。竞品这周给的信号很直接：paperclip 把评审结论
 * 发成 commit 检查并明说"分支保护可以要求它"。凭据要能被**别人的流水线要求**，就得挂到
 * commit 上 —— 这是"证据挡下一步"的最后一步。
 *
 * ## 判据（这里的 every 一条都对应一条用例）
 *
 * - `success` **只在两个条件同时成立时**给：`outcome === "delivered"` **且**指纹复算一致。
 * - 没有指纹 → `error`（不认作通过）：没盖章的凭据无从判断完整性，**不能**算绿。
 * - 指纹不符 → `error`：结论一律不采信（与 `receipt:verify` 的 `tampered` 同一条纪律）。
 * - `blocked` 且指纹一致 → `failure`：结论是真的，只是没交付。
 *
 * ## 诚实边界
 *
 * - **不碰凭据**：走本机 `gh` 的登录态（与 `git-remote` 同一口径），不读不存不回显 token。
 * - **永不重试成绿**：网络失败只报失败，不重试、不降级成 success（那是"给自述背书的橡皮图章"
 *   的另一种写法）。
 * - **失败不影响交付结论**：与分发层同一口径 —— 硬门禁在交付前已经过了。
 * - **status 是外部状态**：它挂在 GitHub 的 commit 上，撤销只能由人在那边做；我们只在
 *   交付那一次写一条，不持续同步。
 */
import { makeGitRunner } from "./git-export";
import type { DeliveryReceipt } from "../../shared/delivery-receipt";

/** 分支保护里要 requirement 的那个检查名（写成常量：两边拼错一个字母就永远对不上）。 */
export const DELIVERY_STATUS_CONTEXT = "oxcommander/delivery";

/** commit sha 字符集：短 sha（7 位起）到完整 40 位，只认十六进制。 */
export const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/** GitHub 对 status description 的上限。 */
export const STATUS_DESCRIPTION_MAX = 140;

/**
 * 三档而不是四档：`error` 专门表示"**我判不了**"（没指纹 / 指纹不符），
 * 与"判了，没过"（`failure`）分开 —— 分支保护上两者都不绿，但读日志的人
 * 需要知道该去修交付，还是该去查凭据有没有被改过。
 */
export type DeliveryStatusState = "success" | "failure" | "error";

export interface DeliveryStatusDecision {
  state: DeliveryStatusState;
  context: string;
  description: string;
}

type Runner = (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function clip(text: string, max = STATUS_DESCRIPTION_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * 凭据（+ 指纹复算结论）→ 一条 status 的内容（**纯函数**，逐位点可审）。
 *
 * 指纹前 12 位写进 description：读状态的人能拿它去 `receipt:verify` 找对应的那份凭据，
 * 而不用在几十份凭据里按时间戳猜。
 */
export function deliveryStatusFor(
  receipt: Pick<DeliveryReceipt, "outcome" | "fingerprint" | "headline">,
  fingerprintOk: boolean,
): DeliveryStatusDecision {
  const context = DELIVERY_STATUS_CONTEXT;
  const short = receipt.fingerprint === undefined ? "" : ` ${receipt.fingerprint.slice(0, 12)}`;
  if (receipt.fingerprint === undefined) {
    return {
      state: "error",
      context,
      description: clip("凭据没有指纹（unsigned）：无从判断完整性，不认作通过"),
    };
  }
  if (!fingerprintOk) {
    return {
      state: "error",
      context,
      description: clip(`凭据指纹不符（${short.trim()}）：被改过，结论一律不采信`),
    };
  }
  if (receipt.outcome === "delivered") {
    return { state: "success", context, description: clip(`已交付 · 凭据${short}`) };
  }
  const why = receipt.headline ? `：${receipt.headline}` : "";
  return { state: "failure", context, description: clip(`未交付 · 凭据${short}${why}`) };
}

export interface DeliveryStatusInput {
  projectRoot: string;
  /** 导出产出的 commit（短 sha 即可）。 */
  commit: string;
  /** 决议（由 `deliveryStatusFor` 算出并传进来：判定与发送不混在一起）。 */
  decision: DeliveryStatusDecision;
  /** 可选的详情链接（例如凭据页面）。 */
  targetUrl?: string;
  timeoutMs?: number;
  run?: Runner;
}

export interface DeliveryStatusResult {
  ok: boolean;
  state?: DeliveryStatusState;
  context: string;
  /** 跳过原因（ok=true 且什么都没发时出现）。 */
  skipped?: "bad-commit";
  /** 失败原因（ok=false）。**永不**折成 success。 */
  reason?: string;
}

function tail(text: string, max = 200): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

/**
 * 发一条 status。永不 throw：失败折进结果对象，且**只报失败**。
 *
 * 为什么用 `gh api` 而不是自己拼 HTTP：与 `gh pr create` / `gh pr checks` 同一条信任面
 * （本机 gh 登录态），也省掉 owner/repo 解析（gh 自己知道当前仓库）。
 */
export async function publishDeliveryStatus(input: DeliveryStatusInput): Promise<DeliveryStatusResult> {
  const context = input.decision.context;
  if (!COMMIT_RE.test(input.commit)) {
    return { ok: true, context, skipped: "bad-commit" };
  }
  const run: Runner =
    input.run ?? ((command, args) => makeGitRunner(input.timeoutMs ?? 60_000, input.projectRoot)(command, args));

  const args = [
    "api",
    "--method",
    "POST",
    `repos/{owner}/{repo}/statuses/${input.commit}`,
    "-f",
    `state=${input.decision.state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${input.decision.description}`,
  ];
  if (input.targetUrl !== undefined) args.push("-f", `target_url=${input.targetUrl}`);

  const res = await run("gh", args);
  if (res.code !== 0) {
    return {
      ok: false,
      context,
      reason: `gh api statuses 失败（gh 未安装 / 未登录 / 该远端不是 GitHub？）：${tail(res.stderr)}`,
    };
  }
  return { ok: true, context, state: input.decision.state };
}
