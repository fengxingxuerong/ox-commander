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
 * The fs surface this module needs. Injected so tests can exercise the paths a
 * real filesystem cannot produce on every platform — a `readdirSync` that throws
 * EACCES, a dirent that is neither file nor directory, a delete that is refused.
 * Defaults to the real `node:fs`, so production behaviour is unchanged.
 */
export interface SnapshotFsLike {
  existsSync(p: string): boolean;
  statSync(p: string): { isFile(): boolean; isDirectory(): boolean };
  readdirSync(dir: string, opts: { withFileTypes: true }): fs.Dirent[];
  mkdirSync(p: string, opts: { recursive: true }): void;
  copyFileSync(from: string, to: string): void;
  rmSync(p: string, opts: { force?: boolean; recursive?: boolean; maxRetries?: number }): void;
}

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
  private readonly fsImpl: SnapshotFsLike;

  constructor(opts: SnapshotStoreOptions, fsImpl: SnapshotFsLike = fs as unknown as SnapshotFsLike) {
    this.backupRoot = path.resolve(opts.backupRoot);
    this.maxFiles = opts.maxFiles ?? 5_000;
    this.skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
    this.fsImpl = fsImpl;
  }

  async begin(scope: SnapshotScope): Promise<SnapshotToken> {
    const rootAbs = path.resolve(scope.root);
    const dirAbs = path.join(this.backupRoot, scope.runId.replace(/[^\w.-]/g, "_"));
    this.fsImpl.mkdirSync(dirAbs, { recursive: true });
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
        this.fsImpl.mkdirSync(path.dirname(to), { recursive: true });
        // A real copy: hard links would share the inode, and in-place writes
        // (fs.writeFileSync on the original path) would corrupt the backup.
        this.fsImpl.copyFileSync(from, to);
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
        this.fsImpl.rmSync(abs, { force: true });
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
      this.fsImpl.rmSync(token.dirAbs, { recursive: true, force: true, maxRetries: 3 });
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
        this.fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
        this.fsImpl.copyFileSync(backup, abs);
        result.restored.push(rel);
      } catch (err) {
        result.skipped.push({ path: rel, reason: (err as Error).message });
      }
      return;
    }
    // No backup: the file did not exist when the batch started.
    if (this.fsImpl.existsSync(abs)) {
      try {
        this.fsImpl.rmSync(abs, { force: true });
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
        entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
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
      // 这里原先有个三目：zone 为 "." 或空串时取空串，否则取 zone 本身。其实
      // path.join 自己就会把 "." 与空串归一化到根，两个分支结果完全相同 ——
      // 删掉它而不是留着：它看着承重，实际没有任何可观测效果。
      // （注释里刻意不写会命中变异算子的运算符字面量：那些算子是 replaceAll，
      // 会连注释一起改写，制造"只改注释不改行为"的假存活。）
      const dirAbs = path.join(token.rootAbs, zone);
      if (this.fsImpl.existsSync(dirAbs)) walk(dirAbs);
    }
    return out;
  }

  private collect(rootAbs: string, zones: readonly string[], include: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
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
      // Same as above: `path.join` normalises "." and "" to the root by itself.
      const dirAbs = path.join(rootAbs, zone);
      if (!this.fsImpl.existsSync(dirAbs)) continue;
      const stat = this.fsImpl.statSync(dirAbs);
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
      if (!this.fsImpl.existsSync(path.join(rootAbs, rel))) continue;
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
