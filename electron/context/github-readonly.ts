/**
 * PRD 前的**只读**外部上下文（2026-10-12，竞品清单 P2-1 的本地半边 + 远端半边）：
 * 从本机 `gh` 拉 GitHub 的 issue / PR 文本，喂给规划大脑当背景；PR 的 diff 行
 * 批注（review comments）也走这里进上下文 —— 竞品口径里"在 diff 行留批注回传给
 * agent"的**读半边**：人在 GitHub 上留批注，agent 在下一轮规划/重修时看得到。
 *
 * ## 为什么值得单开一层
 *
 * 竞品对照表里 P2-1 是"GitHub/Linear 只读集成"：把外部系统的任务上下文带进规划，
 * 免得操作者手抄。真做链路集成需要凭据与 webhook，那是另一轮；这一层取的是
 * **本机已经登录好的 `gh`**，只读、零凭据接触、失败只写日志。
 *
 * ## 硬边界
 *
 * - **只读，且是命令白名单意义上的只读**：只认 `gh issue list`、`gh pr view`，
 *   外加唯一一条 `gh api --method GET repos/{repo}/pulls/{N}/comments`（diff 行
 *   批注；路径由字符集校验过的 repo 与安全整数 PR 号拼成，方法强制 GET）。
 *   其余一律拒绝（不是"尽量只读"，是枚举）。绝不评论、绝不建 PR —— 写操作在
 *   别处也不该有。
 * - **仓库名/PR 号走字符集**：`owner/repo` 与数字编号，不接受任意字符串。
 * - **预算**：条数上限（默认 10）、字符上限（默认 8000/份，总 24000）—— 拉来的
 *   文本要挤进大脑层的提示预算，不设上限等于让远端吃光它。
 * - **不可信输入**：拉来的内容原样带毒（issue 里写"忽略上述规则"是免费的，
 *   PR 批注同理）。本层只负责**如实标注来源与截断**，围栏在 `externalContextBlock`
 *   （提示层）与 schema 校验（结构层）—— 三处都不敢说"拦得住"，只能说"没人以为它是指令"。
 * - **失败 ≠ 空上下文**：`gh` 不在 / 未登录 / 网络失败，如实报"没拿到"，
 *   绝不退化成"当作没有这项需求"。但"PR 没有批注"是合法的空结果（ok=true,
 *   items=0）—— 没反馈和拿不到是两件事，不能说破前者冒充后者。
 */
import { makeGitRunner } from "../engine/git-export";

/** `owner/repo`：GitHub 的现实字符集，收紧到无空格无斜杠嵌套。 */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
/** 单份上下文的字符预算（超出尾部截断并标注）。 */
export const DEFAULT_MAX_CHARS = 8_000;
/** 条数上限（`--limit`），也是总字符的分母。 */
export const DEFAULT_MAX_ITEMS = 10;
export const MAX_ITEMS_CEILING = 50;

export type GithubContextKind = "issues" | "pr" | "pr-comments";

export interface GithubContextInput {
  /** `"issues"` = 拉 issue 列表；`"pr"` = 拉指定 PR 的描述与 diff；`"pr-comments"` = 拉指定 PR 的 diff 行批注。 */
  kind: GithubContextKind;
  /** `owner/repo`。缺省 = 不指定（`gh` 自己认当前仓库的 upstream）。 */
  repo?: string;
  /** issues：搜索条件（原样传给 `--search`，不拼 shell）。缺省 = 全部开放的。 */
  search?: string;
  /** issues：条数（默认 10，上限 50）。 */
  limit?: number;
  /** pr / pr-comments：PR 号（一个）。 */
  pr?: number;
  /** 单份字符上限，默认 8000。 */
  maxChars?: number;
  /** 命令执行器（默认真实 spawn，测试注入）。不抛错，非零退出码用 `code` 表达。 */
  run?: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** 超时（毫秒），默认 60s —— 拉上下文不该比规划还慢。 */
  timeoutMs?: number;
  /** 工作目录（`gh` 要认仓库时用它）。 */
  cwd?: string;
}

export interface GithubContextResult {
  ok: boolean;
  /** 给提示用的成文文本（ok=false 时是 undefined —— 拿不到就不许假装拿到了）。 */
  text?: string;
  /** 拉了几条（ok=false 时缺席）。 */
  items?: number;
  /** 是否发生了截断（提示层要如实说）。 */
  truncated?: boolean;
  /** 失败原因（ok=false）。 */
  reason?: string;
}

type Runner = (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function tail(text: string, max = 200): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}

/** 条数收敛：非法/超限 → 默认或上限（不静默放大）。 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(limit, MAX_ITEMS_CEILING);
}

/** 字符预算收敛：非法 → 默认；上限 50000（再大提示也放不下）。 */
export function clampChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isSafeInteger(maxChars) || maxChars <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(maxChars, 50_000);
}

/**
 * 命令构造（纯函数，便于逐点审计）：只产出白名单里的三种形态。
 * 返回 `null` = 这个 kind/参数组合不被接受（调用方报"不支持"，不猜）。
 */
export function githubArgs(input: GithubContextInput): readonly string[] | null {
  // 这里是**守住**（不是提示）：哪怕调用方忘了校验，非法 repo 也出不去命令。
  // 上面那一步负责把话说清楚（"仓库名不合法"），这一步负责不出事。
  if (input.repo !== undefined && !REPO_RE.test(input.repo)) return null;
  const limit = clampLimit(input.limit);
  const repo = input.repo ? ["--repo", input.repo] : [];
  if (input.kind === "issues") {
    const search = input.search ? ["--search", input.search] : [];
    return ["issue", "list", ...repo, ...search, "--limit", String(limit), "--json", "number,title,body,state"];
  }
  if (input.kind === "pr") {
    if (input.pr === undefined || !Number.isSafeInteger(input.pr) || input.pr <= 0) return null;
    return ["pr", "view", String(input.pr), ...repo, "--json", "number,title,body"];
  }
  if (input.kind === "pr-comments") {
    if (input.pr === undefined || !Number.isSafeInteger(input.pr) || input.pr <= 0) return null;
    // 白名单里唯一一条 `gh api`：路径每一段都由我们拼 —— repo 要么过了 REPO_RE，
    // 要么缺席时用 gh 自己的 {owner}/{repo} 占位符（它按 cwd 的仓库填）；
    // PR 号是安全整数。`--method GET` 显式钉死方法，不靠 gh 的默认值。
    const slug = input.repo ?? "{owner}/{repo}";
    return ["api", "--method", "GET", `repos/${slug}/pulls/${input.pr}/comments`];
  }
  return null;
}

/** 解析 `gh issue list --json …` 的输出（数组，缺字段按空处理；坏 JSON → null）。 */
export function parseIssues(raw: string): Array<{ number: number; title: string; body: string; state: string }> | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Array<{ number: number; title: string; body: string; state: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue; // null / 非对象跳过，不抛错
    const o = item as Record<string, unknown>;
    out.push({
      number: typeof o["number"] === "number" ? o["number"] : 0,
      title: String(o["title"] ?? ""),
      body: String(o["body"] ?? ""),
      state: String(o["state"] ?? ""),
    });
  }
  return out;
}

/** 把 issue 列表渲染成给大脑看的文本（含来源标注与截断标记）。 */
export function renderIssues(
  issues: Array<{ number: number; title: string; body: string; state: string }>,
  maxChars: number,
): { text: string; truncated: boolean } {
  const lines = issues.map(
    (i) => `- #${i.number} [${i.state}] ${i.title}\n${i.body.replace(/\r\n/g, "\n").trim()}`,
  );
  return clipText(lines.join("\n\n"), maxChars);
}

/** 把单个 PR 渲染成文本（标题 + 正文）。 */
export function renderPr(pr: { number: number; title: string; body: string }, maxChars: number) {
  return clipText(`PR #${pr.number}: ${pr.title}\n${String(pr.body ?? "").replace(/\r\n/g, "\n").trim()}`, maxChars);
}

/** `gh api …/pulls/N/comments` 的一条 diff 行批注（字段名贴近 gh 的输出，login 提成 author）。 */
export interface PrComment {
  path: string;
  /** diff 行号；`line` 缺席（行已不在 diff 里）时回落到 `original_line`，再缺席为 0。 */
  line: number;
  /** `"LEFT"` / `"RIGHT"` —— 批注钉在旧侧还是新侧。 */
  side: string;
  author: string;
  body: string;
}

/**
 * 解析 `gh api …/pulls/N/comments` 的输出（diff 行批注数组）。
 * 坏 JSON / 非数组 → null（拿不到就说拿不到）；**空数组 → []**（合法空结果：
 * "这个 PR 没有批注"和"拉取失败"是两件事，后者才折进 reason）。
 */
export function parsePrComments(raw: string): PrComment[] | null {
  const text = raw.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: PrComment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue; // null / 非对象跳过，不抛错
    const o = item as Record<string, unknown>;
    const user = o["user"];
    const login = user && typeof user === "object" ? (user as Record<string, unknown>)["login"] : undefined;
    const line = typeof o["line"] === "number" ? o["line"] : typeof o["original_line"] === "number" ? o["original_line"] : 0;
    out.push({
      path: String(o["path"] ?? ""),
      line,
      side: String(o["side"] ?? ""),
      author: String(login ?? ""),
      body: String(o["body"] ?? ""),
    });
  }
  return out;
}

/**
 * 把批注渲染成给大脑看的文本：`- path:line（side）@author: body`。
 * 空列表给一句"没有批注"的实话 —— 不返回空字符串（那会被引擎当成"没拿到"）。
 */
export function renderPrComments(comments: readonly PrComment[], maxChars: number): { text: string; truncated: boolean } {
  if (comments.length === 0) return { text: "（该 PR 没有 diff 行批注）", truncated: false };
  const lines = comments.map(
    (c) => `- ${c.path}:${c.line}（${c.side}）@${c.author}: ${c.body.replace(/\r\n/g, "\n").trim()}`,
  );
  return clipText(lines.join("\n\n"), maxChars);
}

/** 裁剪到预算：超了就在尾部说"被截断多少"，**不静默丢内容**。 */
export function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const keep = Math.max(0, maxChars - 40);
  return {
    text: `${text.slice(0, keep)}\n…（已截断，省略 ${text.length - keep} 字符）`,
    truncated: true,
  };
}

/**
 * 主入口。永不 throw：失败折进结果对象。**拿不到就是拿不到**，不返回空文本。
 */
export async function fetchGithubContext(input: GithubContextInput): Promise<GithubContextResult> {
  if (input.repo !== undefined && !REPO_RE.test(input.repo)) {
    return { ok: false, reason: `仓库名不合法：${JSON.stringify(input.repo)}` };
  }
  const args = githubArgs(input);
  if (!args) {
    return { ok: false, reason: `不支持的拉取方式：kind=${input.kind} pr=${String(input.pr)}` };
  }
  const maxChars = clampChars(input.maxChars);
  const run: Runner =
    input.run ??
    ((command, argv) => makeGitRunner(input.timeoutMs ?? 60_000, input.cwd ?? process.cwd())(command, argv));

  const r = await run("gh", args);
  if (r.code !== 0) {
    // 失败原因里带上人话命令名（不是 argv[0..1] —— api 形态下那是 "--method"）
    const label = input.kind === "issues" ? "issue list" : input.kind === "pr" ? "pr view" : "api pulls comments";
    return {
      ok: false,
      reason: `gh ${label} 失败（gh 未安装 / 未登录 / 仓库不存在？）:${tail(r.stderr)}`,
    };
  }

  if (input.kind === "pr") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout.trim());
    } catch {
      return { ok: false, reason: `gh pr view 的输出不是 JSON：${tail(r.stdout)}` };
    }
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "gh pr view 的输出不是对象" };
    const o = parsed as Record<string, unknown>;
    const pr = {
      number: typeof o["number"] === "number" ? o["number"] : input.pr ?? 0,
      title: String(o["title"] ?? ""),
      body: String(o["body"] ?? ""),
    };
    const rendered = renderPr(pr, maxChars);
    return { ok: true, text: rendered.text, items: 1, ...(rendered.truncated ? { truncated: true } : {}) };
  }

  if (input.kind === "pr-comments") {
    const comments = parsePrComments(r.stdout);
    if (!comments) return { ok: false, reason: `gh api pulls comments 的输出解析不了：${tail(r.stdout)}` };
    const rendered = renderPrComments(comments, maxChars);
    return {
      ok: true,
      text: rendered.text,
      items: comments.length,
      ...(rendered.truncated ? { truncated: true } : {}),
    };
  }

  const issues = parseIssues(r.stdout);
  if (!issues) return { ok: false, reason: `gh issue list 的输出解析不了：${tail(r.stdout)}` };
  const rendered = renderIssues(issues, maxChars);
  return {
    ok: true,
    text: rendered.text,
    items: issues.length,
    ...(rendered.truncated ? { truncated: true } : {}),
  };
}
