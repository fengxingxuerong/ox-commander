import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPathInZone } from "../../shared/glob";

/** 台账 id 的同毫秒单调序数（见 `begin` 的注释）。 */
let journalSeq = 0;

/**
 * Files whose churn is never one task's business.
 *
 * Two kinds, matched by **directory name at any depth** (which is what a bare
 * `dist/` line in `.gitignore` means as well):
 *
 * - shared infra: `node_modules`, the repository itself, the quarantine area;
 * - machine-generated output: a batch that runs the project's own build or test
 *   writes these **inside its own window**, so without this they would be
 *   reported as `unauthorized-write` — failing the whole batch and (in the
 *   default `revert-batch` mode) rolling the build output back, even though
 *   every task stayed inside its zone.
 *
 * Deliberately narrow: `out` / `bin` / `target` are left out because authored
 * source does live under those names in real projects.
 */
export const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".ox-quarantine",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);

/**
 * How long `begin()` waits after capturing the baseline, in milliseconds.
 *
 * ⚠️ **This is load-bearing for security, not a politeness delay.**
 *
 * `changed()` decides "did this file change?" from `size + mtimeMs`. On this
 * filesystem an mtime tick is ~1ms wide, so a write landing in the *same* tick
 * as the baseline is invisible: `begin()` stats the tree, the agent rewrites a
 * file microseconds later, `settle()` re-stats and sees an identical fingerprint
 * — the edit is reported as **no change at all**. For a zone violation that is
 * the worst possible failure: the file stays corrupted, nothing is rolled back,
 * and the batch is still marked `ok`.
 *
 * Measured on this machine (2026-10-05, win32): an equal-length rewrite
 * immediately after the baseline is missed **~75%** of the time; after a 5ms
 * window, **0/150**.
 *
 * The delay alone is not a guarantee — it only moves the boundary, and a
 * sufficiently fast write could still land inside one tick. That is why
 * `changed()` also breaks such ties by content digest. Both measures are cheap:
 * this costs one wall-clock wait per batch, the digest only ever touches files
 * that are already ambiguous on the cheap signals.
 */
export const SETTLE_WINDOW_MS = 5;

/**
 * Waits until the clock has advanced past `ms`.
 *
 * ⚠️ It spins on `Date.now()` rather than using `setTimeout`, because the point
 * is to age filesystem timestamps and nothing else — a timer would defer the
 * task and let unrelated work interleave.
 *
 * The spin is **bounded by an iteration cap** rather than trusting the clock
 * alone: a test that freezes `Date.now()` (vitest fake timers) would otherwise
 * hang forever, and this class must never be able to wedge a run. A frozen
 * clock simply yields immediately — it cannot produce a real mtime collision,
 * so giving up here costs nothing.
 */
function waitForClock(ms: number): void {
  if (ms <= 0) return;
  const until = Date.now() + ms;
  // ~10M iterations ≈ well over a second of spinning: past any real wait we
  // care about, while still bounded under a frozen clock.
  for (let spin = 0; spin < 10_000_000; spin += 1) {
    if (Date.now() >= until) return;
  }
}

/** Content digest used **only** to break size+mtime ties. */
function digestOf(abs: string): string | undefined {
  try {
    return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return undefined; // unreadable: treated as "cannot decide"
  }
}

export interface FileChange {
  path: string;
  op: "create" | "modify" | "delete";
  bytes?: number;
}

export interface JournalStats {
  /** Files seen in the walk. */
  files: number;
  create: number;
  modify: number;
  delete: number;
  durationMs: number;
  /**
   * Content reads performed. Normally 0 — the whole point of this class. It is
   * non-zero only for the **ambiguous** files (identical size *and* mtime) whose
   * digest was needed to decide the diff; see `changed()`.
   */
  contentRead: number;
}

interface Entry {
  size: number;
  mtimeMs: number;
  /**
   * Content digest — the **tie-breaker** for the one case `size + mtimeMs`
   * cannot decide, see `changed()`.
   */
  digest?: string;
}

export interface JournalToken {
  id: string;
  rootAbs: string;
  zones: string[];
  /** relative posix path → cheap fingerprint captured *before* the batch. */
  baseline: Map<string, Entry>;
  startedAt: number;
}

export interface FileJournalOptions {
  skipDirs?: Set<string>;
  /**
   * Overrides the settle window (milliseconds). See `SETTLE_WINDOW_MS`.
   * Tests set it to 0; production leaves it at the default.
   */
  settleWindowMs?: number;
}

/**
 * Cheap workspace change detection for a batch.
 *
 * Replaces the previous approach (`ZoneGuard` = two full-tree **content** scans
 * per batch: read every file + md5): the baseline only `stat`s the tree, and
 * the diff walk only re-`stat`s it. Nothing is ever read.
 *
 * Deliberate trade-off: `size + mtimeMs` is the whole judgement, so a tool that
 * rewrites a file with identical content counts as a change. That false
 * positive costs one restore of unchanged content during a rollback — harmless,
 * and far cheaper than hashing the tree twice.
 */
export class FileJournal {
  private readonly skipDirs: Set<string>;
  private readonly settleWindowMs: number;
  private lastStats: JournalStats = {
    files: 0,
    create: 0,
    modify: 0,
    delete: 0,
    durationMs: 0,
    contentRead: 0,
  };

  constructor(opts: FileJournalOptions = {}) {
    this.skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
    this.settleWindowMs = opts.settleWindowMs ?? SETTLE_WINDOW_MS;
  }

  stats(): JournalStats {
    return { ...this.lastStats };
  }

  // `id` 缺省由调用方省略时的防碰撞后缀：同毫秒连开两批，裸 `Date.now()`
  // 会给出同一个台账 id，而回滚与冲突归因都按 id 取台账 —— 撞了就分不清
  // 哪份基线属于哪一批。与 store.ts 的 idSeq 同一套做法。
  begin(root: string, zones: string[], id = `j-${Date.now().toString(36)}-${(journalSeq += 1)}`): JournalToken {
    const rootAbs = path.resolve(root);
    const baseline = this.walkStat(rootAbs);
    // Digest the files that lie **outside every declared zone** — the only ones
    // whose invisibility is a security problem, and the only ones we will ever
    // pay a content read for. In-zone files stay on the cheap stat path.
    for (const [rel, entry] of baseline) {
      if (zones.some((z) => isPathInZone(rel, z))) continue;
      entry.digest = digestOf(path.join(rootAbs, rel));
    }
    // Age the captured timestamps past the FS clock tick *before* handing the
    // token to the caller: without this, a write in the same tick as the
    // baseline is undetectable (see SETTLE_WINDOW_MS).
    waitForClock(this.settleWindowMs);
    return {
      id,
      rootAbs,
      zones: [...zones],
      baseline,
      startedAt: Date.now(),
    };
  }

  changed(token: JournalToken): FileChange[] {
    const startedAt = Date.now();
    const after = this.walkStat(token.rootAbs);
    const changes: FileChange[] = [];
    let contentRead = 0;

    for (const [rel, now] of after) {
      const before = token.baseline.get(rel);
      if (!before) {
        changes.push({ path: rel, op: "create", bytes: now.size });
        continue;
      }
      if (before.size !== now.size || before.mtimeMs !== now.mtimeMs) {
        changes.push({ path: rel, op: "modify", bytes: now.size });
        continue;
      }
      // Cheap signals agree the file is untouched — but "untouched" is exactly
      // what a same-tick rewrite also looks like, and for a file **outside every
      // declared zone** that case is a security case: an out-of-zone edit the
      // journal cannot see is one that never gets arbitrated or rolled back.
      // Those are the only files we pay a content read for, and the digest was
      // captured during `begin()`, while the contents were still the originals.
      const beforeDigest = before.digest;
      if (beforeDigest === undefined) continue;
      contentRead += 1;
      const nowDigest = digestOf(path.join(token.rootAbs, rel));
      if (nowDigest === undefined) continue; // unreadable now: cannot decide
      if (beforeDigest !== nowDigest) {
        changes.push({ path: rel, op: "modify", bytes: now.size });
      }
    }
    for (const rel of token.baseline.keys()) {
      if (!after.has(rel)) changes.push({ path: rel, op: "delete" });
    }

    // 2026-09-28：path 严格互异（after 的 Map 键与 baseline 剩余键都不重复，
    // 同一 rel 不会产生两条 change），相等分支不可达 —— 收敛成两分支后，
    // 三元互换算子只剩「整体反转」一个变异面，由 changed() 的顺序断言看守。
    changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    this.lastStats = {
      files: after.size,
      create: changes.filter((c) => c.op === "create").length,
      modify: changes.filter((c) => c.op === "modify").length,
      delete: changes.filter((c) => c.op === "delete").length,
      durationMs: Date.now() - startedAt,
      contentRead,
    };
    return changes;
  }

  /** Files touched outside every declared zone. */
  unauthorized(changes: FileChange[], zones: readonly string[]): string[] {
    return changes.filter((c) => !zones.some((z) => isInsideZone(c.path, z))).map((c) => c.path);
  }

  private walkStat(rootAbs: string): Map<string, Entry> {
    const out = new Map<string, Entry>();
    if (!fs.existsSync(rootAbs)) return out;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = fs.statSync(abs);
          out.set(path.relative(rootAbs, abs).replace(/\\/g, "/"), { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // unreadable: treated as absent
        }
      }
    };
    walk(rootAbs);
    return out;
  }
}

/**
 * Zone ownership lives in `shared/glob.ts` — one implementation, used by the
 * journal, the ZoneGuard, the error router and the snapshot store, so they can
 * never disagree about what a zone covers. Re-exported here for callers that
 * already import it from this module.
 */
export const isInsideZone = isPathInZone;
