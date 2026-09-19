import path from "node:path";
import { FileJournal, isInsideZone, type FileChange } from "../sandbox/file-journal";
import { SnapshotStore, type RevertResult, type SnapshotToken } from "../sandbox/snapshot-store";
import type { DispatchOutcome } from "./scheduler";
import type { ArbitrationMode } from "../../shared/types";

export type ConflictKind = "unauthorized-write" | "shared-drift";
export type { ArbitrationMode };

export interface Conflict {
  kind: ConflictKind;
  paths: string[];
  runs: string[];
}

export interface Remedy {
  action: "pass" | "fail-batch" | "revert" | "quarantine";
  paths: string[];
  detail: string;
}

/** Files whose change must never be attributed to one task (config, manifests). */
export const DEFAULT_SHARED_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  ".git/**",
];

export interface BatchScope {
  runId: string;
  rootAbs: string;
  zones: string[];
  changes: FileChange[];
}

export interface BatchGuardOptions {
  journal?: FileJournal;
  snapshots?: SnapshotStore;
  /**
   * `report-only` keeps the historic behaviour (mark the batch failed, leave the
   * files on disk); `revert-batch` restores the workspace first; `quarantine`
   * moves the offending files aside so the evidence survives.
   */
  mode?: ArbitrationMode;
  sharedPaths?: readonly string[];
  quarantineDirName?: string;
  onEvent?: (text: string) => void;
  /** Structured verdict sink (hosts stream it as an event instead of parsing text). */
  onVerdict?: (verdict: BatchVerdict, scope: BatchScope) => void;
}

export interface BatchVerdict {
  outcomes: DispatchOutcome[];
  conflicts: Conflict[];
  remedies: Remedy[];
}

/**
 * Adjudicates a finished batch: which files changed, whether any of them were
 * outside the declared zones, and what to do about it.
 *
 * Replaces the previous "detect and mark the whole batch failed" logic
 * (`ZoneGuard` + a notice appended to every outcome). Detection is now a
 * stat-only diff (`FileJournal`), and the offending changes can actually be
 * rolled back (`SnapshotStore`) instead of merely being reported.
 */
export class BatchGuard {
  private readonly journal: FileJournal;
  private readonly snapshots: SnapshotStore | null;
  private readonly mode: ArbitrationMode;
  private readonly sharedPaths: readonly string[];
  private readonly quarantineDirName: string;
  private readonly onEvent?: (text: string) => void;
  /** Mutable: a host that is handed an already-built guard can still attach. */
  private onVerdict?: (verdict: BatchVerdict, scope: BatchScope) => void;

  constructor(opts: BatchGuardOptions = {}) {
    this.journal = opts.journal ?? new FileJournal();
    this.snapshots = opts.snapshots ?? null;
    this.mode = opts.mode ?? "revert-batch";
    this.sharedPaths = opts.sharedPaths ?? DEFAULT_SHARED_PATHS;
    this.quarantineDirName = opts.quarantineDirName ?? ".ox-quarantine";
    if (opts.onEvent) this.onEvent = opts.onEvent;
    if (opts.onVerdict) this.onVerdict = opts.onVerdict;
  }

  /**
   * Attaches (or replaces) the verdict sink. Needed when the guard was built by
   * someone else — e.g. the headless runner receiving a pre-wired agent layer.
   */
  setVerdictSink(sink: (verdict: BatchVerdict, scope: BatchScope) => void): void {
    this.onVerdict = sink;
  }

  /** Records the baseline (fingerprints + backups) before the batch runs. */
  async begin(runId: string, root: string, zones: readonly string[]): Promise<BatchScope> {
    const rootAbs = path.resolve(root);
    const scope: BatchScope = { runId, rootAbs, zones: [...zones], changes: [] };
    this.journalTokens.set(scope, this.journal.begin(rootAbs, scope.zones, runId));
    if (this.snapshots) {
      this.snapshotTokens.set(scope, await this.snapshots.begin({ runId, root: rootAbs, zones: scope.zones }));
    }
    return scope;
  }

  /**
   * Compares the workspace with the baseline, arbitrates, and returns the
   * (possibly rewritten) outcomes. Clean batches pass through untouched and the
   * backups are dropped.
   */
  async settle(scope: BatchScope, outcomes: DispatchOutcome[]): Promise<BatchVerdict> {
    const token = this.journalTokenOf(scope);
    const changes = this.journal.changed(token);
    scope.changes = changes;
    const conflicts = this.detect(changes, scope.zones);

    if (conflicts.length === 0) {
      if (this.snapshots) await this.snapshots.commit(this.snapshotTokenOf(scope));
      const clean: BatchVerdict = { outcomes, conflicts: [], remedies: [] };
      this.onVerdict?.(clean, scope);
      return clean;
    }

    const remedies: Remedy[] = conflicts.map((c) => ({
      action: remedyFor(this.mode),
      paths: c.paths,
      detail: describe(c),
    }));

    if (this.mode === "report-only" || this.mode === "deny-all") {
      this.onEvent?.(
        `检测到 ${conflicts.length} 类越权变更（${this.mode}${this.mode === "report-only" ? "，未回滚" : "，保留现场"}）`,
      );
      return this.hand(scope, { outcomes: this.markBatchFailed(outcomes, conflicts), conflicts, remedies });
    }

    const allPaths = [...new Set(conflicts.flatMap((c) => c.paths))];
    if (this.mode === "revert-batch") {
      const revertResult = this.snapshots
        ? await this.snapshots.revert(this.snapshotTokenOf(scope), { paths: allPaths })
        : null;
      if (revertResult) {
        this.onEvent?.(
          `已回滚 ${revertResult.restored.length} 个文件、删除 ${revertResult.removed.length} 个新增文件` +
            (revertResult.skipped.length > 0 ? `，${revertResult.skipped.length} 个未能回滚` : ""),
        );
      } else {
        this.onEvent?.("未配置快照存储，仅报告越权（无法回滚）");
      }
      if (this.snapshots) await this.snapshots.commit(this.snapshotTokenOf(scope));
      return this.hand(scope, {
        outcomes: this.markBatchFailed(outcomes, conflicts, {
          ...(revertResult ? { reverted: revertResult } : {}),
        }),
        conflicts,
        remedies,
      });
    }

    // quarantine: move the offending files aside instead of destroying them.
    let moved = 0;
    let failed = 0;
    for (const rel of allPaths) {
      const dest = await this.quarantine(scope, rel);
      if (dest) moved += 1;
      else failed += 1;
    }
    this.onEvent?.(`已将 ${moved} 个越权文件移入隔离区${failed > 0 ? `（${failed} 个失败）` : ""}`);
    if (this.snapshots) await this.snapshots.commit(this.snapshotTokenOf(scope));
    return this.hand(scope, { outcomes: this.markBatchFailed(outcomes, conflicts), conflicts, remedies });
  }

  /** Single exit point: every verdict goes to the host before it is returned. */
  private hand(scope: BatchScope, verdict: BatchVerdict): BatchVerdict {
    this.onVerdict?.(verdict, scope);
    return verdict;
  }

  /**
   * Two conflict kinds, both derived from the same diff:
   *
   * - `unauthorized-write`: changed outside every declared zone;
   * - `shared-drift`: changed a path that must never be one task's business
   *   (`package.json`, lockfiles, `.git/**` …), even if the zone nominally owns it.
   *
   * Concurrent writes to the same file cannot happen inside a batch — batches
   * are planned with mutually exclusive zones (`planBatches`) and run
   * concurrently only across disjoint zones. That is why there is no
   * merge/owner-wins policy here: the case it would handle is unreachable, and
   * pretending to handle it would be worse than saying so.
   */
  private detect(changes: FileChange[], zones: readonly string[]): Conflict[] {
    const unauthorized = changes.filter((c) => !zones.some((z) => isInsideZone(c.path, z)));
    const shared = changes.filter((c) => this.sharedPaths.some((p) => matchesShared(c.path, p)));
    const out: Conflict[] = [];
    if (unauthorized.length > 0) {
      out.push({ kind: "unauthorized-write", paths: unauthorized.map((c) => c.path), runs: [] });
    }
    if (shared.length > 0) {
      const sharedPaths = shared.map((c) => c.path).filter((p) => !out[0]?.paths.includes(p));
      if (sharedPaths.length > 0) out.push({ kind: "shared-drift", paths: sharedPaths, runs: [] });
    }
    return out;
  }

  private markBatchFailed(
    outcomes: DispatchOutcome[],
    conflicts: Conflict[],
    extra: { reverted?: RevertResult } = {},
  ): DispatchOutcome[] {
    const lines = [
      `zone 越权：本批任务修改了声明 zone 之外的文件 → ${conflicts.flatMap((c) => c.paths).join("、")}`,
      `处理方式：${this.mode}`,
    ];
    if (extra.reverted) {
      lines.push(
        `已回滚 ${extra.reverted.restored.length} 个文件、删除 ${extra.reverted.removed.length} 个新增文件` +
          (extra.reverted.skipped.length > 0 ? `；${extra.reverted.skipped.length} 个未能回滚，需要人工检查` : ""),
      );
    }
    const notice = lines.join("\n");
    return outcomes.map((o) => ({ ...o, ok: false, logDigest: `${o.logDigest}\n${notice}`.trim() }));
  }

  private async quarantine(scope: BatchScope, rel: string): Promise<string | null> {
    const fs = await import("node:fs");
    const from = path.join(scope.rootAbs, rel);
    const to = path.join(scope.rootAbs, this.quarantineDirName, scope.runId, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return to;
    } catch {
      try {
        fs.copyFileSync(from, to);
        fs.rmSync(from, { force: true });
        return to;
      } catch {
        return null;
      }
    }
  }

  // The journal/snapshot tokens are created in `begin`; they are kept here so
  // callers never have to thread them around.
  private journalTokens = new WeakMap<BatchScope, ReturnType<FileJournal["begin"]>>();
  private snapshotTokens = new WeakMap<BatchScope, SnapshotToken>();

  private journalTokenOf(scope: BatchScope): ReturnType<FileJournal["begin"]> {
    const t = this.journalTokens.get(scope);
    if (!t) throw new Error(`batch scope ${scope.runId} 未经 begin() 登记`);
    return t;
  }

  private snapshotTokenOf(scope: BatchScope): SnapshotToken {
    const t = this.snapshotTokens.get(scope);
    if (!t) throw new Error(`batch scope ${scope.runId} 没有快照`);
    return t;
  }

  /** Test/diagnostic helper: the journal backing this guard. */
  journalRef(): FileJournal {
    return this.journal;
  }
}

function remedyFor(mode: ArbitrationMode): Remedy["action"] {
  switch (mode) {
    case "revert-batch":
      return "revert";
    case "quarantine":
      return "quarantine";
    default:
      return "fail-batch";
  }
}

function describe(c: Conflict): string {
  return c.kind === "unauthorized-write"
    ? `越权写入 ${c.paths.length} 个 zone 外文件`
    : `共享文件被改动：${c.paths.join("、")}`;
}

function matchesShared(rel: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.endsWith("/**")) {
    const base = p.slice(0, -3);
    return rel === base || rel.startsWith(`${base}/`);
  }
  return rel === p;
}
