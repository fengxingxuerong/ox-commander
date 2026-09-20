/**
 * Rendering helpers for LLM-facing text.
 *
 * Why this exists: task `title`, `zone` and `description` all originate from
 * model output and were interpolated into a Markdown prompt verbatim. A value
 * containing a newline could therefore inject a new `##` section — e.g. a fake
 * `## 要求` block that contradicts the real constraints sitting below it.
 *
 * The schema now whitelists `zone` (see `shared/schema.ts`), so the primary
 * channel is closed. These helpers are the second layer: they make the *prompt
 * document structure* hold regardless of what any field contains, which matters
 * for `description` — free-form by design, and impossible to whitelist.
 *
 * Deliberately additive: content is preserved, never silently dropped. A field
 * that cannot be rendered inline is moved to its own fenced block, so the
 * operator can still see exactly what the model asked for.
 */

/** Longest single-line value to render inline before switching to a block. */
const INLINE_SAFE_LIMIT = 120;

/**
 * Renders a value so it cannot break out of the line it is placed on.
 *
 * Newlines and carriage returns are the structural risk (they end the line and
 * can open a new Markdown section); tabs collapse to a space because they are
 * only cosmetic here.
 *
 * A value that is too long or contains a newline is *annotated* rather than
 * mangled: the caller is expected to use `fencedBlock` for those.
 */
export function inlineField(value: string): string {
  const flat = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  const single = flat.replace(/\n+/g, " ⏎ ").trim();
  if (single === "") return "(空)";
  if (single.length > INLINE_SAFE_LIMIT) return `${single.slice(0, INLINE_SAFE_LIMIT)}…（已截断，完整内容见下方区块）`;
  return single;
}

/**
 * True when a value must be rendered as its own block rather than inline.
 *
 * Callers use this to decide between `inlineField` and `fencedBlock`; keeping
 * the rule in one place means the two stay consistent.
 */
export function needsBlock(value: string): boolean {
  return /[\r\n]/.test(value) || value.replace(/\t/g, " ").length > INLINE_SAFE_LIMIT;
}

/**
 * Wraps arbitrary text in a fenced block that cannot be terminated early.
 *
 * A fence is closed by a line that starts with the fence marker, so the marker
 * is lengthened until it is longer than any run of backticks inside the content.
 * That is the standard Markdown defence and it needs no escaping of the content
 * itself, which keeps the original text readable.
 */
export function fencedBlock(text: string, lang = ""): string {
  let ticks = "```";
  const existing = text.match(/^`{3,}/gm);
  if (existing) {
    const longest = Math.max(...existing.map((m) => m.length));
    if (longest >= ticks.length) ticks = "`".repeat(longest + 1);
  }
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/**
 * Renders a field inline when it is safe to do so, otherwise as a fenced block
 * on its own lines. Always returns something that ends without trailing space.
 */
export function safeField(label: string, value: string): string {
  if (!needsBlock(value)) return `${label}${inlineField(value)}`;
  return `${label}\n\n${fencedBlock(value)}`;
}
