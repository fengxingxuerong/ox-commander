/**
 * `apply_patch` 的**解析与应用**（纯逻辑，不碰磁盘）。
 *
 * 为什么不用"模型直接吐整个文件"：整文件覆盖写会丢掉模型没复述的部分 ——
 * 一个 600 行的文件里改 3 行，模型就得把 600 行原样写回，任何一次复述漂移
 * 都是一次静默的回退。补丁只说"改了什么"，未提及的行由平台保留，于是
 * **改动量与风险正相关**而不是与文件大小相关。这是 Codex/Claude Code 那一类
 * 形态共有的两个前提之一（另一个是工具循环）。
 *
 * 格式取 Codex `apply_patch` 的公共子集：
 *
 *     *** Begin Patch
 *     *** Add File: src/new.ts
 *     +export const a = 1;
 *     *** Update File: src/old.ts
 *     @@ 上下文标注（可选，平台忽略其内容）
 *       const keep = 1;
 *     -const drop = 2;
 *     +const added = 2;
 *     *** Delete File: src/gone.ts
 *     *** End Patch
 *
 * 两条纪律：
 * 1. **上下文不匹配就失败并说破，绝不模糊匹配**。模糊匹配会把"改错地方"变成
 *    "改了别的地方"，而后者在验收里表现为一片绿。失败理由带上第几个 hunk 与
 *    首行内容，模型下一轮能据此重新读文件。
 * 2. **无上下文的纯新增**不猜位置：追加到文件末尾，并在结果里明说它是追加的
 *    —— 静默插到末尾与静默插到开头一样坏，区别只在于哪个更不容易被发现。
 */
export type PatchFileOp =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; hunks: PatchHunk[] }
  | { kind: "delete"; path: string };

export type PatchLineKind = "context" | "del" | "add";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  lines: PatchLine[];
}

export interface ParsedPatch {
  ops: PatchFileOp[];
}

export interface ApplyOutcome {
  /** `null` 表示删除。 */
  content: string | null;
  /** 执行过程中必须被看见的附加事实（如"无上下文，已追加到末尾"）。 */
  notes: string[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

function stripCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 把 `*** Begin Patch` 与 `*** End Patch` 之间的正文抠出来（允许前后有散文）。 */
function patchBody(text: string): string | null {
  const src = stripCrlf(text);
  const start = src.indexOf(BEGIN);
  if (start < 0) return null;
  const end = src.indexOf(END, start + BEGIN.length);
  if (end < 0) return null;
  return src.slice(start + BEGIN.length, end);
}

function parseLine(raw: string): PatchLine | null {
  // 空行在补丁里是"一个空格前缀的上下文行"被 trim 掉的形态：按上下文处理，
  // 否则模型手写的空行会把 hunk 截断。
  const marker = raw[0];
  if (marker === " ") return { kind: "context", text: raw.slice(1) };
  if (marker === "-") return { kind: "del", text: raw.slice(1) };
  if (marker === "+") return { kind: "add", text: raw.slice(1) };
  if (raw === "") return { kind: "context", text: "" };
  return null;
}

/**
 * 解析补丁。返回 `{ ops }` 或 `{ error }` —— 解析错误同样要说清在哪一行，
 * 理由同模块头纪律 1。
 */
export function parsePatch(text: string): { ops: PatchFileOp[] } | { error: string } {
  const body = patchBody(text);
  if (body === null) return { error: `补丁缺少 ${BEGIN} / ${END} 包裹` };
  const ops: PatchFileOp[] = [];
  let current: PatchFileOp | null = null;
  let hunk: PatchLine[] | null = null;
  const lines = body.split("\n");
  // `*** End Patch` 前面那个换行会 split 出一个空元素；它是分隔符，不是补丁里
  // 的"空上下文行"。不丢掉它会让无上下文的纯新增被误判成"在文件末尾空行处
  // 匹配到上下文"，于是既不追加到末尾，也不产生"已追加"的说明。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const headerMatch = /^\*\*\* (Add|Update|Delete|Move) File:\s*(.+?)\s*$/.exec(raw);
    if (headerMatch) {
      if (current && hunk && current.kind === "update" && hunk.length > 0) current.hunks.push({ lines: hunk });
      hunk = null;
      const kind = headerMatch[1];
      const target = headerMatch[2];
      if (kind === "Move") return { error: `暂不支持 *** Move File（第 ${i + 1} 行）` };
      if (kind === "Add") current = { kind: "add", path: target, content: "" };
      else if (kind === "Delete") current = { kind: "delete", path: target };
      else current = { kind: "update", path: target, hunks: [] };
      ops.push(current);
      continue;
    }
    if (!current) {
      // 头部之前的孤立行：补丁开头常有一句说明，跳过空行，其它当错误。
      if (raw.trim() === "") continue;
      return { error: `第 ${i + 1} 行出现在任何文件段之前：${raw.slice(0, 80)}` };
    }
    if (current.kind === "add") {
      if (raw.startsWith("+")) current.content += `${current.content === "" ? "" : "\n"}${raw.slice(1)}`;
      continue;
    }
    if (current.kind === "delete") continue;
    // update
    if (raw.startsWith("@@")) {
      if (hunk && hunk.length > 0) current.hunks.push({ lines: hunk });
      hunk = [];
      continue;
    }
    const line = parseLine(raw);
    if (!line) return { error: `第 ${i + 1} 行不是合法的补丁行（须以空格 / - / + 开头）：${raw.slice(0, 80)}` };
    if (!hunk) hunk = [];
    hunk.push(line);
  }
  if (current && hunk && current.kind === "update" && hunk.length > 0) current.hunks.push({ lines: hunk });
  if (ops.length === 0) return { error: "补丁里没有任何文件段" };
  /*
   * 只有上下文行的 Update 段同样算"没有改动"。
   *
   * 补丁里空行会被读成上下文行（手写补丁常把空行写成空而不是一个空格），
   * 所以"段内一行都没有"与"段内全是上下文"必须判成同一件事 —— 否则
   * `*** Update File: a.ts` 后面什么都没有也会解析成功，落盘时表现为
   * "补丁应用成功，文件没变"，而那正是最难发现的一类假成功。
   */
  const bad = ops.find(
    (op) =>
      op.kind === "update" &&
      !op.hunks.some((h) => h.lines.some((l) => l.kind === "add" || l.kind === "del")),
  );
  if (bad) return { error: `文件 ${bad.path} 的 Update 段没有任何改动行（只有上下文行等于没改）` };
  return { ops };
}

function linesOf(text: string): string[] {
  return stripCrlf(text).split("\n");
}

/** 一个 hunk 里"旧内容"的行（上下文 + 删除）。 */
function oldLines(lines: readonly PatchLine[]): string[] {
  return lines.filter((l) => l.kind !== "add").map((l) => l.text);
}

/** 一个 hunk 里"新内容"的行（上下文 + 新增）。 */
function newLines(lines: readonly PatchLine[]): string[] {
  return lines.filter((l) => l.kind !== "del").map((l) => l.text);
}

/**
 * 把一组 hunk 应用到原文。
 *
 * 逐个 hunk 顺序查找（从上一处匹配之后开始），保证"改第 3 处"不会因为
 * 前两处文本相同而回头改到第 1 处 —— 顺序推进是补丁语义的一部分。
 */
export function applyHunks(original: string, hunks: readonly PatchHunk[]): ApplyOutcome | { error: string } {
  let lines = linesOf(original);
  const notes: string[] = [];
  let searchFrom = 0;
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const old = oldLines(hunk.lines);
    const next = newLines(hunk.lines);
    if (old.length === 0) {
      // 纯新增且没有任何上下文：不猜位置，追加到末尾并说破。
      // 文件以换行结尾时，`lines` 末尾的 "" 是那个换行的占位符；直接 concat
      // 会插出一个空行。把新行插在它之前，并保留原来的结尾换行。
      const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
      const base = trailingNewline ? lines.slice(0, -1) : lines;
      const where = base.length;
      lines = trailingNewline ? [...base, ...next, ""] : [...base, ...next];
      notes.push(`第 ${i + 1} 个改动块没有上下文行，已追加到文件末尾（原第 ${where} 行之后）`);
      searchFrom = lines.length;
      continue;
    }
    let hit = -1;
    for (let start = searchFrom; start + old.length <= lines.length; start++) {
      let same = true;
      for (let k = 0; k < old.length; k++) {
        if (lines[start + k] !== old[k]) {
          same = false;
          break;
        }
      }
      if (same) {
        hit = start;
        break;
      }
    }
    if (hit < 0) {
      return {
        error:
          `第 ${i + 1} 个改动块的上下文在文件里找不到（首行：「${old[0] ?? ""}」，共 ${old.length} 行）。` +
          `请先 read_file 重新读一遍再改 —— 平台不会模糊匹配。`,
      };
    }
    lines = [...lines.slice(0, hit), ...next, ...lines.slice(hit + old.length)];
    searchFrom = hit + next.length;
  }
  return { content: lines.join("\n"), notes };
}

/**
 * 执行整个补丁里的**一个**文件段。
 *
 * 逐个文件单独调用（而不是一次收一串 content）的理由：落盘要过 `PathPolicy`
 * 与审批，逐文件才能做到"某个文件被拒时不牵连其它文件"，并且审计能记清楚
 * 哪个文件动了。
 */
export function applyFileOp(op: PatchFileOp, original: string | null): ApplyOutcome | { error: string } {
  if (op.kind === "add") {
    if (original !== null) return { error: `文件已存在，不能用 Add File：${op.path}` };
    return { content: op.content, notes: [] };
  }
  if (op.kind === "delete") {
    if (original === null) return { error: `文件不存在，无法删除：${op.path}` };
    return { content: null, notes: [] };
  }
  if (original === null) return { error: `文件不存在，无法修改：${op.path}` };
  return applyHunks(original, op.hunks);
}

/** 给审计/UI 的一行摘要：改了几个文件、各自什么动作。 */
export function describePatchOps(ops: readonly PatchFileOp[]): string {
  const counts = { add: 0, update: 0, delete: 0 };
  for (const op of ops) counts[op.kind] += 1;
  const parts: string[] = [];
  if (counts.add > 0) parts.push(`新建 ${counts.add}`);
  if (counts.update > 0) parts.push(`修改 ${counts.update}`);
  if (counts.delete > 0) parts.push(`删除 ${counts.delete}`);
  return parts.join("、");
}
