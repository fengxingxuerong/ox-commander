import fs from "node:fs";
import path from "node:path";
import { isInsideZone } from "./file-journal";

export interface SnapshotScope {
  runId: string;
  root: string;
  zones: string[];
  /** Extra paths (outside the zones) that must be restorable too. */
  include?: string[];
}

export interface SnapshotToken {
  id: string;
  rootAbs: string;
  dirAbs: string;
  zones: string[];
  /** relative posix path → backup was taken (always a real copy). */
  backedUp: Map<string, "copy">;
  /** Files that could not be backed up (over budget / unreadable). */
  skipped: string[];
  truncated: boolean;
}

export interface RevertResult {
  /** Files restored from the backup (they existed before the batch). */
  restored: string[];
  /** Files deleted (they were created by the batch). */
  removed: string[];
  /** Files that could not be restored, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

export interface SnapshotStoreOptions {
  /** Where backups live; one directory per run. */
  backupRoot: string;
  /** Give up backing up beyond this many files (the run is then marked truncated). */
  maxFiles?: number;
  skipDirs?: Set<string>;
}

const DEFAULT_SKIP_DIRS = new Set(["node_modules", ".git", ".ox-quarantine"]);

/**
 * Content backups so a batch can be rolled back.
 *
 * Three rules learned the hard way:
 *
 * 1. **Never `git stash`, never `git checkout -- .`.** Both silently discard the
 *    operator's uncommitted work when `.git` is in a bad state (a documented
 *    failure mode on this machine: `.git/refs` disappeared twice). Backups are
 *    plain files copied out of the tree — this module does not run any process
 *    at all, so git cannot be involved even by accident.
 * 2. **Never hard-link the backups.** A hard link shares the inode, and the
 *    obvious way to modify a file (`fs.writeFileSync(path, …)`) truncates that
 *    inode in place — which silently rewrites the "backup" too. Measured while
 *    writing this: the rollback restored the *new* content. Backups are real
 *    copies.
 * 3. **Only back up what the batch could touch** (its zones), so the cost stays
 *    proportional to the task rather than the repository.
 *
 * Restore semantics: backed-up paths are copied back; paths that did *not* exist
 * in the baseline are deleted (they can only have been created by the batch).
 */
export class SnapshotStore {
  private readonly backupRoot: string;
  private readonly maxFiles: number;
  private readonly skipDirs: Set<string>;

  constructor(opts: SnapshotStoreOptions) {
    this.backupRoot = path.resolve(opts.backupRoot);
    this.maxFiles = opts.maxFiles ?? 5_000;
    this.skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  }

  async begin(scope: SnapshotScope): Promise<SnapshotToken> {
    const rootAbs = path.resolve(scope.root);
    const dirAbs = path.join(this.backupRoot, scope.runId.replace(/[^\w.-]/g, "_"));
    fs.mkdirSync(dirAbs, { recursive: true });
    const token: SnapshotToken = {
      id: scope.runId,
      rootAbs,
      dirAbs,
      zones: [...scope.zones],
      backedUp: new Map(),
      skipped: [],
      truncated: false,
    };
    const candidates = this.collect(rootAbs, scope.zones, scope.include ?? []);
    for (const rel of candidates) {
      if (token.backedUp.size >= this.maxFiles) {
        token.truncated = true;
        token.skipped.push(rel);
        continue;
      }
      const from = path.join(rootAbs, rel);
      const to = path.join(dirAbs, rel);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        // A real copy: hard links would share the inode, and in-place writes
        // (fs.writeFileSync on the original path) would corrupt the backup.
        fs.copyFileSync(from, to);
        token.backedUp.set(rel, "copy");
      } catch {
        token.skipped.push(rel);
      }
    }
    return token;
  }

  /**
   * Rolls the workspace back to the state captured by `begin`.
   * `sel.paths` limits the rollback to specific files (used for zone violations);
   * omitting it rolls back everything the batch touched.
   */
  async revert(token: SnapshotToken, sel?: { paths?: readonly string[] }): Promise<RevertResult> {
    const result: RevertResult = { restored: [], removed: [], skipped: [] };
    const targets = sel?.paths ?? null;

    if (targets) {
      for (const raw of targets) {
        const rel = toRel(raw);
        this.revertOne(token, rel, result);
      }
      return result;
    }

    // No selection: restore every backed-up file, and delete anything the batch
    // created that the snapshot does not know about.
    for (const rel of token.backedUp.keys()) this.revertOne(token, rel, result);
    for (const rel of this.newlyCreated(token)) {
      const abs = path.join(token.rootAbs, rel);
      try {
        fs.rmSync(abs, { force: true });
        result.removed.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
    }
    return result;
  }

  /** Drops the backup directory; call after a successful batch. */
  async commit(token: SnapshotToken): Promise<void> {
    try {
      fs.rmSync(token.dirAbs, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a stuck backup dir is not worth failing a successful batch over
    }
  }

  /** True when the path has a restorable backup. */
  hasBackup(token: SnapshotToken, relPath: string): boolean {
    return token.backedUp.has(toRel(relPath));
  }

  private revertOne(token: SnapshotToken, rel: string, result: RevertResult): void {
    const abs = path.join(token.rootAbs, rel);
    const backup = path.join(token.dirAbs, rel);
    if (token.backedUp.has(rel)) {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(backup, abs);
        result.restored.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
      return;
    }
    // No backup: the file did not exist when the batch started.
    if (fs.existsSync(abs)) {
      try {
        fs.rmSync(abs, { force: true });
        result.removed.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
      return;
    }
    result.skipped.push({ path: rel, reason: "快照中没有该文件，且当前不存在（无需回滚）" });
  }

  private newlyCreated(token: SnapshotToken): string[] {
    const out: string[] = [];
    // A file the snapshot skipped (over budget) may well have existed before the
    // batch — deleting it would be destructive, so it is never treated as new.
    const skipped = new Set(token.skipped.map(toRel));
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
        const rel = toRel(path.relative(token.rootAbs, abs));
        if (!token.backedUp.has(rel) && !skipped.has(rel)) out.push(rel);
      }
    };
    // Only paths the batch could have touched: inside the zones. Widening this
    // to the whole tree would delete pre-existing files outside the scope.
    for (const zone of token.zones) {
      const dirAbs = path.join(token.rootAbs, zone === "." || zone === "" ? "" : zone);
      if (fs.existsSync(dirAbs)) walk(dirAbs);
    }
    return out;
  }

  private collect(rootAbs: string, zones: readonly string[], include: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
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
        const rel = toRel(path.relative(rootAbs, abs));
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
      }
    };
    for (const zone of zones) {
      const dirAbs = path.join(rootAbs, zone === "." || zone === "" ? "" : zone);
      if (!fs.existsSync(dirAbs)) continue;
      const stat = fs.statSync(dirAbs);
      if (stat.isFile()) {
        const rel = toRel(path.relative(rootAbs, dirAbs));
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push(rel);
        }
        continue;
      }
      walk(dirAbs);
    }
    for (const extra of include) {
      const rel = toRel(extra);
      if (seen.has(rel)) continue;
      if (!fs.existsSync(path.join(rootAbs, rel))) continue;
      seen.add(rel);
      out.push(rel);
    }
    return out;
  }
}

function toRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** True when the zone predicates say the file belongs to the batch. */
export function withinZones(rel: string, zones: readonly string[]): boolean {
  return zones.some((z) => isInsideZone(rel, z));
}
