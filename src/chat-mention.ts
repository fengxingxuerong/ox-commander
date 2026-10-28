export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export interface MentionInsertion {
  text: string;
  caret: number;
}

export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  if (!Number.isInteger(caret)) return null;
  if (caret < 0 || caret > text.length) return null;
  let start = -1;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "@") {
      start = i;
      break;
    }
    if (/\s/.test(ch)) return null;
  }
  if (start < 0) return null;
  const before = start === 0 ? "" : text[start - 1];
  if (before !== "" && !/[\s([{"'`]/.test(before)) return null;
  return { start, end: caret, query: text.slice(start + 1, caret) };
}

export function mentionCandidates(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let score = -1;
    if (q === "") score = 0;
    else if (base.startsWith(q)) score = 0;
    else if (lower.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    if (score >= 0) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((item) => item.file);
}

export function insertMention(text: string, token: MentionToken, file: string): MentionInsertion {
  const path = file.replace(/\\/g, "/");
  const gap = text[token.end] === " " || text[token.end] === "\n" ? "" : " ";
  const inserted = `@${path}${gap}`;
  return {
    text: `${text.slice(0, token.start)}${inserted}${text.slice(token.end)}`,
    caret: token.start + inserted.length,
  };
}
