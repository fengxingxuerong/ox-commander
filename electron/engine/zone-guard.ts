import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPathInZone } from "../../shared/glob";

/** Directories that belong to shared infrastructure; churn there is never attributed to a task. */
const SHARED_SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface WorkspaceSnapshot {
  /** relative posix path -> content hash */
  files: Map<string, string>;
}

export interface WorkspaceDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(dir: string, opts: { withFileTypes: true }): fs.Dirent[];
  readFileSync(p: string, enc: "utf8"): string;
}

/**
 * Zone ownership is defined once, in `shared/glob.ts`. Re-exported here so the
 * legacy ZoneGuard path and the newer journal/snapshot path cannot diverge.
 */
export { isPathInZone as isInsideZone } from "../../shared/glob";

function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function scanFiles(rootAbs: string, fsImpl: FsLike): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SHARED_SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let content: string;
      try {
        content = fsImpl.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(rootAbs, abs).replace(/\\/g, "/");
      files.set(rel, hashContent(content));
    }
  };
  walk(rootAbs);
  return files;
}

/**
 * Zone sandbox enforcement by before/after diffing: takes a snapshot before a
 * batch runs, diffs after, and attributes changed files to the zones of the
 * tasks in that batch. Files changed outside every declared zone are
 * unattributable violations that fail the whole batch.
 */
export class ZoneGuard {
  constructor(private fsImpl: FsLike = fs as unknown as FsLike) {}

  snapshot(root: string): WorkspaceSnapshot {
    const rootAbs = path.resolve(root);
    if (!this.fsImpl.existsSync(rootAbs)) return { files: new Map() };
    return { files: scanFiles(rootAbs, this.fsImpl) };
  }

  diff(root: string, before: WorkspaceSnapshot): WorkspaceDiff {
    const after = this.snapshot(root).files;
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [rel, hash] of after) {
      const prev = before.files.get(rel);
      if (prev === undefined) added.push(rel);
      else if (prev !== hash) modified.push(rel);
    }
    for (const rel of before.files.keys()) {
      if (!after.has(rel)) deleted.push(rel);
    }
    return { added, modified, deleted };
  }

  /** Files in the diff that no task zone owns — zone violations. */
  unownedChanges(diff: WorkspaceDiff, zones: string[]): string[] {
    const changed = [...diff.added, ...diff.modified, ...diff.deleted];
    return changed.filter((rel) => !zones.some((z) => isPathInZone(rel, z)));
  }
}
