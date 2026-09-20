/**
 * Zone coverage check for a decompose plan.
 *
 * Why this exists: the planner is free to invent its own zone directory names
 * ("tests/unit", "tests/runner"), but the PRD names the concrete files the
 * deliverable must contain ("tests/greet.test.js"). When those two disagree,
 * every write to the declared file is a zone violation: the sandbox reverts it,
 * verification keeps failing on the missing file, and the run burns its whole
 * repair budget in a loop that cannot terminate.
 *
 * Observed in a real multi-agent run: zones `tests/unit` + `tests/runner`, PRD
 * requiring `tests/greet.test.js` (directly under `tests/`) → 3 revert
 * verdicts, `no test files found in tests/` forever.
 *
 * The guard is deliberately one-directional: it only fails a plan when a file
 * the PRD *explicitly names* is owned by no zone. It never rewrites zones —
 * widening a zone automatically would silently grant write access the planner
 * did not intend, which is exactly what the zone model exists to prevent.
 *
 * Pure TS (no node, no DOM): both the renderer and the electron project compile
 * `shared/`, and the headless entry point must be able to run this too.
 */
import { isPathInZone } from "./glob";
import type { PrdDocument, Task } from "./types";

/**
 * File paths that a PRD line explicitly names, as project-relative posix paths.
 *
 * Extraction is conservative — a false negative (missing a path) merely skips
 * the check, while a false positive would reject a perfectly good plan. So a
 * token only counts when it looks like a real *nested* relative file path.
 */
export function extractDeclaredPaths(text: string): string[] {
  const found = new Set<string>();
  // Tokens like `src/app/greet.js`, `tests/greet.test.js`, `docs/README.md`.
  const token = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+/g;
  for (const match of text.matchAll(token)) {
    // A match that continues a path fragment is not a path start: `../x/y.js`
    // must not degrade into the plausible-looking `x/y.js`. Guarding on the
    // preceding character is the only reliable way — a leading lookahead lets
    // the engine simply start matching one character later.
    const start = match.index ?? 0;
    const prev = start > 0 ? text[start - 1] ?? "" : "";
    if (prev === "." || prev === "/" || prev === "\\") continue;
    // Strip trailing punctuation that a sentence may glue on.
    const cleaned = match[0].replace(/[.,;:)\]}>"'`]+$/, "");
    if (cleaned === "" || cleaned.includes("..")) continue;
    const segments = cleaned.split("/").filter((s) => s !== "");
    // Require a directory part. A bare filename is almost always a reference to
    // a protected path in prose ("do not modify package.json"), and treating it
    // as an artifact would reject plans that are perfectly fine.
    if (segments.length < 2) continue;
    found.add(cleaned);
  }
  return [...found].sort();
}

/** Every path the PRD names anywhere a file could be introduced. */
export function declaredArtifactPaths(prd: PrdDocument): string[] {
  const parts: string[] = [
    prd.goal,
    ...prd.features,
    ...prd.acceptanceCriteria,
  ];
  const found = new Set<string>();
  for (const part of parts) {
    for (const p of extractDeclaredPaths(part)) found.add(p);
  }
  return [...found].sort();
}

export interface ZoneCoverageGap {
  /** The declared file no zone owns. */
  path: string;
  /** Zones that exist but do not cover it. */
  zones: string[];
}

/**
 * Declared artifact paths that no task's zone owns.
 *
 * Paths inside protected prefixes (`.git/`, `node_modules/`, `ox-scripts/`)
 * are skipped: those are intentionally unwritable, and a PRD mentioning them is
 * usually describing a constraint ("do not touch package.json") rather than
 * asking for a file to be produced.
 */
export function findOrphanPaths(
  prd: PrdDocument,
  tasks: readonly Task[],
  protectedPrefixes: readonly string[] = ["node_modules/", ".git/", "ox-scripts/"],
): ZoneCoverageGap[] {
  const declared = declaredArtifactPaths(prd);
  if (declared.length === 0 || tasks.length === 0) return [];
  const zones = [...new Set(tasks.map((t) => t.zone))];
  const gaps: ZoneCoverageGap[] = [];
  for (const path of declared) {
    if (protectedPrefixes.some((p) => path.startsWith(p))) continue;
    if (zones.some((z) => isPathInZone(path, z))) continue;
    gaps.push({ path, zones });
  }
  return gaps;
}

/**
 * Human-readable summary of the gaps, for logs and error messages.
 * Callers decide whether a gap is fatal (the orchestrator fails the plan).
 */
export function describeZoneGaps(gaps: readonly ZoneCoverageGap[]): string {
  return gaps.map((g) => `${g.path}（现有 zone：${g.zones.join("、") || "无"}）`).join("；");
}
