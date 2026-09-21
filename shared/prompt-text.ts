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
 * mangled: callers that need the full text wrap it in `fencedBlock` instead.
 */
export function inlineField(value: string): string {
  const flat = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  const single = flat.replace(/\n+/g, " ⏎ ").trim();
  if (single === "") return "(空)";
  if (single.length > INLINE_SAFE_LIMIT) return `${single.slice(0, INLINE_SAFE_LIMIT)}…（已截断）`;
  return single;
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

// `needsBlock` / `safeField` used to live here as a closed pair: `safeField`
// chose between `inlineField` and `fencedBlock`, and `needsBlock` held the rule.
// Neither had a production caller — both adapters call `inlineField` directly,
// which already neutralises the structural risk on its own (newlines become
// " ⏎ "), so the inline-vs-block decision had nothing to decide. Their unit
// tests were pinning a code path no run could reach.
//
// This is the chained-dead-code shape `check-unwired` cannot see (it exempts
// same-file callers): `needsBlock` looked wired because `safeField` called it,
// while `safeField` itself was already dead. Found by reading, not by the gate.
