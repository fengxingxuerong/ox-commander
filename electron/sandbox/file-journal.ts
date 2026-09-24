import fs from "node:fs";
import path from "node:path";
import { isPathInZone } from "../../shared/glob";

/**
 * Directories whose churn is never one task's business.
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
  /** Content reads performed. Always 0 — that is the whole point of this class. */
  contentRead: 0;
}

interface Entry {
  size: number;
  mtimeMs: number;
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
  }

  stats(): JournalStats {
    return { ...this.lastStats };
  }

  begin(root: string, zones: string[], id = `j-${Date.now().toString(36)}`): JournalToken {
    const rootAbs = path.resolve(root);
    return {
      id,
      rootAbs,
      zones: [...zones],
      baseline: this.walkStat(rootAbs),
      startedAt: Date.now(),
    };
  }

  changed(token: JournalToken): FileChange[] {
    const startedAt = Date.now();
    const after = this.walkStat(token.rootAbs);
    const changes: FileChange[] = [];

    for (const [rel, now] of after) {
      const before = token.baseline.get(rel);
      if (!before) {
        changes.push({ path: rel, op: "create", bytes: now.size });
        continue;
      }
      if (before.size === now.size && before.mtimeMs === now.mtimeMs) continue;
      changes.push({ path: rel, op: "modify", bytes: now.size });
    }
    for (const rel of token.baseline.keys()) {
      if (!after.has(rel)) changes.push({ path: rel, op: "delete" });
    }

    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.lastStats = {
      files: after.size,
      create: changes.filter((c) => c.op === "create").length,
      modify: changes.filter((c) => c.op === "modify").length,
      delete: changes.filter((c) => c.op === "delete").length,
      durationMs: Date.now() - startedAt,
      contentRead: 0,
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
