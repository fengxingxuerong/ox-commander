/**
 * 行级文本 diff（竞品缺口 B1 第二半：看板逐行 diff 的数据源）。
 *
 * 为什么归 `shared/`：它是纯字符串逻辑，双端（桌面端 IPC、测试）都要用，
 * 且不碰任何宿主能力 —— 分层红线（`eslint.config.mjs` 给 `shared/**` 立的
 * `no-restricted-imports`）保证它永远保持这个样子。
 *
 * 两条设计纪律：
 *
 * 1. **大文件与二进制不装能看**。超过行数上限返回 `too-large`（只给统计），
 *    含 NUL 字节返回 `binary`。渲染一个 10 万行的 diff 会把渲染进程拖死，
 *    而"看得慢"比"看不了"更糟 —— 界面必须能说"这个文件太大了"。
 * 2. **截断必须自带标记**。`truncated` 为真时 `lines` 只是前 `maxLines` 行的
 *    结果，不是全貌；调用方（IPC）会把这个标志原样透给界面，界面要念出来。
 *    静默截断是这类面板最常见的撒谎方式。
 */

/** 单行 diff 结果。`text` 不含行尾符（统一按 LF 切分后剥离 CR）。 */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based 行号，`add` 行没有 beforeNo，`del` 行没有 afterNo。 */
  beforeNo?: number;
  afterNo?: number;
}

export type DiffStatus =
  /** 两侧都有内容且不完全相同。 */
  | "modified"
  /** before 缺席（文件是本批新建的）。 */
  | "created"
  /** after 缺席（文件被本批删除）。 */
  | "deleted"
  | "unchanged"
  | "binary"
  /** 行数超过上限，不返回行内容（统计仍准确）。 */
  | "too-large";

export interface FileDiff {
  status: DiffStatus;
  lines: DiffLine[];
  /** 行内容是否被 `maxLines` 截断（`too-large` 时为真，且 lines 为空）。 */
  truncated: boolean;
  /**
   * 增 / 删行数。**未知时为 `null`，不是 0** —— `too-large` 与 `binary`
   * 拿不出这个数，报 0 会让界面显示"无变化"这种反话。界面把 null 显示成
   * "—"，调用方不得把它当 0 用。
   */
  added: number | null;
  deleted: number | null;
  /** 截断前的真实行数（未截断时等于参与 diff 的行数）。 */
  beforeLines: number;
  afterLines: number;
}

/** 默认行数上限。UI 上一次渲染两千行 diff 已是上限，再大就该只给统计。 */
export const DEFAULT_MAX_DIFF_LINES = 2000;

export interface DiffOptions {
  maxLines?: number;
}

/** 二进制判定：含 NUL 字节。与 git 的启发式一致，不猜编码。 */
export function looksBinary(text: string): boolean {
  return text.includes("\0");
}

/** 按行切分（LF 或 CRLF 均可；行尾符不进 `text`）。 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // 尾部换行会产生一个空串元素 —— 它对 diff 没有信息量，去掉它，
  // 否则"只加了结尾换行"会呈现为多出一个空行。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * 两段文本的行级 diff。
 *
 * 算法：先剥公共前缀与后缀（真实改动几乎总是局部的，剪枝后 DP 规模骤减），
 * 对中间段做 LCS 动态规划。复杂度 O(n·m)，由 `maxLines` 兜住。
 *
 * `before` / `after` 为 `undefined` 表示该侧缺席（新建 / 删除的文件）。
 */
export function diffText(
  before: string | undefined,
  after: string | undefined,
  opts: DiffOptions = {},
): FileDiff {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const beforeExists = before !== undefined;
  const afterExists = after !== undefined;
  const beforeText = before ?? "";
  const afterText = after ?? "";

  const status: DiffStatus = !beforeExists
    ? "created"
    : !afterExists
      ? "deleted"
      : beforeText === afterText
        ? "unchanged"
        : looksBinary(beforeText) || looksBinary(afterText)
          ? "binary"
          : "modified";

  if (status === "unchanged") {
    const n = splitLines(beforeText).length;
    return { status, lines: [], truncated: false, added: 0, deleted: 0, beforeLines: n, afterLines: n };
  }
  if (status === "binary") {
    const bn = splitLines(beforeText).length;
    const an = splitLines(afterText).length;
    return {
      status,
      lines: [],
      truncated: false,
      added: null,
      deleted: null,
      beforeLines: bn,
      afterLines: an,
    };
  }

  const a = splitLines(beforeText);
  const b = splitLines(afterText);

  // created / deleted：全量增删，不跑 DP。
  if (status === "created" || status === "deleted") {
    const adding = status === "created";
    if (Math.max(a.length, b.length) > maxLines) {
      return {
        status: "too-large",
        lines: [],
        truncated: true,
        added: null,
        deleted: null,
        beforeLines: a.length,
        afterLines: b.length,
      };
    }
    const source = adding ? b : a;
    const lines: DiffLine[] = source.map((text, i) => ({
      kind: adding ? "add" : "del",
      text,
      ...(adding ? { afterNo: i + 1 } : { beforeNo: i + 1 }),
    }));
    return {
      status,
      lines,
      truncated: false,
      added: adding ? b.length : 0,
      deleted: adding ? 0 : a.length,
      beforeLines: a.length,
      afterLines: b.length,
    };
  }

  if (a.length > maxLines || b.length > maxLines) {
    return {
      status: "too-large",
      lines: [],
      truncated: true,
      added: null,
      deleted: null,
      beforeLines: a.length,
      afterLines: b.length,
    };
  }

  // 剥公共前缀 / 后缀：中间段才是 DP 的输入。
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops = lcsOps(midA, midB);
  const lines: DiffLine[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === "same") {
      lines.push({ kind: "same", text: midA[ai]!, beforeNo: head + ai + 1, afterNo: head + bi + 1 });
      ai += 1;
      bi += 1;
    } else if (op === "del") {
      lines.push({ kind: "del", text: midA[ai]!, beforeNo: head + ai + 1 });
      ai += 1;
    } else {
      lines.push({ kind: "add", text: midB[bi]!, afterNo: head + bi + 1 });
      bi += 1;
    }
  }
  // 剪掉的前后缀按 same 补回（行号连续，UI 折叠它们以外的部分）。
  const prefix = a.slice(0, head).map((text, i) => ({
    kind: "same" as const,
    text,
    beforeNo: i + 1,
    afterNo: i + 1,
  }));
  const suffix = a.slice(a.length - tail).map((text, i) => ({
    kind: "same" as const,
    text,
    beforeNo: a.length - tail + i + 1,
    afterNo: b.length - tail + i + 1,
  }));
  const all = [...prefix, ...lines, ...suffix];

  return {
    status: "modified",
    lines: all,
    truncated: false,
    added: all.filter((l) => l.kind === "add").length,
    deleted: all.filter((l) => l.kind === "del").length,
    beforeLines: a.length,
    afterLines: b.length,
  };
}

/**
 * LCS 编辑脚本（逐元素）。返回的序列长度 = n + m - 2·LCS，
 * 元素取 `same`（两侧对齐）/ `del`（只在前侧）/ `add`（只在后侧）。
 *
 * 完整 DP 表（回溯需要全表，滚动表只够算长度）。调用方已用
 * 前缀/后缀剪枝把规模压到真实改动段，且 `maxLines` 兜住上限，
 * 所以这里用 `Uint32Array` 而不是 `number[]`：同样 2000×2000 的
 * 中间段，内存从 ~32MB 降到 ~16MB，且没有 boxed number。
 */
function lcsOps(a: readonly string[], b: readonly string[]): Array<"same" | "del" | "add"> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i * width + j] =
        a[i - 1] === b[j - 1]
          ? table[(i - 1) * width + (j - 1)]! + 1
          : Math.max(table[(i - 1) * width + j]!, table[i * width + (j - 1)]!);
    }
  }
  // 相等时（两个方向的 LCS 一样长）优先 add：回溯是逆序的，最后走 add 意味着
  // 正序脚本里 del 在前 —— 与 git / GitHub diff 的呈现顺序一致（先减后加）。
  const ops: Array<"same" | "del" | "add"> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push("same");
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * width + j]! > table[i * width + (j - 1)]!) {
      ops.push("del");
      i -= 1;
    } else {
      ops.push("add");
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push("del");
    i -= 1;
  }
  while (j > 0) {
    ops.push("add");
    j -= 1;
  }
  ops.reverse();
  return ops;
}
