import fs from "node:fs";
import path from "node:path";

export type AuditPhase = "run-start" | "run-end" | "batch-guard" | "agent-change" | "settings";

export interface AuditRecord {
  /** ISO timestamp, stamped by the writer. */
  ts: string;
  phase: AuditPhase;
  runId?: string;
  taskId?: string;
  agentId?: string;
  zone?: string;
  ok?: boolean;
  durationMs?: number;
  /** Coarse classification, so the UI can group failures without reading logs. */
  errorClass?: string;
  /** How many files changed (batch-guard phases). */
  changed?: number;
  /** Kept short on purpose: the first N paths plus the real total. */
  paths?: string[];
  pathsTotal?: number;
  detail?: string;
}

export interface AuditLogOptions {
  dir: string;
  /** Roll to a new file once the current one exceeds this; default 2 MiB. */
  maxFileBytes?: number;
  /** Paths recorded per record; default 20. */
  maxPaths?: number;
  /**
   * How many rolled files to keep (oldest are deleted once exceeded); default 20.
   *
   * The log used to roll by size but never drop anything, so a long-running
   * project accumulated JSONL forever — a slow disk leak with no upper bound.
   * Retention is deliberately generous: roughly 40 MiB of history at the
   * defaults, enough for "which agent changed what" over many runs.
   */
  maxFiles?: number;
  now?: () => Date;
}

/**
 * Append-only JSONL audit trail.
 *
 * Why a separate file rather than the board log: the board keeps only the last
 * few hundred lines in memory and is wiped on reload, while "which agent
 * changed which files in run X" has to survive restarts. One JSON object per
 * line keeps it greppable and cheap to append — no read-modify-write.
 */
export class AuditLog {
  private readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly maxPaths: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  /** Cached size of the current file, so append() does not stat every time. */
  private size = 0;
  private current: string;

  constructor(opts: AuditLogOptions) {
    this.dir = path.resolve(opts.dir);
    this.maxFileBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxPaths = opts.maxPaths ?? 20;
    this.maxFiles = opts.maxFiles ?? 20;
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(this.dir, { recursive: true });
    this.current = this.pickFile();
    this.enforceRetention();
  }

  /** The file currently being appended to. */
  currentFile(): string {
    return this.current;
  }

  /** All audit files, oldest first. */
  files(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith("audit-") && f.endsWith(".jsonl"))
        .sort()
        .map((f) => path.join(this.dir, f));
    } catch {
      return [];
    }
  }

  append(record: Omit<AuditRecord, "ts"> & { ts?: string }): AuditRecord {
    const stamped: AuditRecord = {
      ts: record.ts ?? this.now().toISOString(),
      ...record,
      ...(record.paths
        ? {
            paths: record.paths.slice(0, this.maxPaths),
            pathsTotal: record.pathsTotal ?? record.paths.length,
          }
        : {}),
    };
    const line = `${JSON.stringify(stamped)}\n`;
    try {
      if (this.size + line.length > this.maxFileBytes) this.rotate();
      fs.appendFileSync(this.current, line, "utf8");
      this.size += Buffer.byteLength(line, "utf8");
    } catch {
      // Auditing must never take the pipeline down.
    }
    return stamped;
  }

  /** Reads records back, newest last. `limit` caps how many are returned. */
  read(opts: { limit?: number; phase?: AuditPhase } = {}): AuditRecord[] {
    const out: AuditRecord[] = [];
    for (const file of this.files()) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line) as AuditRecord;
          if (opts.phase && parsed.phase !== opts.phase) continue;
          out.push(parsed);
        } catch {
          // a truncated tail line is skipped, not fatal
        }
      }
    }
    return opts.limit !== undefined ? out.slice(-opts.limit) : out;
  }

  private pickFile(): string {
    const existing = this.files();
    if (existing.length === 0) return this.newFile(0);
    const last = existing[existing.length - 1]!;
    try {
      const size = fs.statSync(last).size;
      if (size < this.maxFileBytes) {
        this.size = size;
        return last;
      }
      return this.newFile(this.index(last) + 1);
    } catch {
      return this.newFile(0);
    }
  }

  private rotate(): void {
    this.current = this.newFile(this.index(this.current) + 1);
    this.enforceRetention();
  }

  /**
   * Deletes the oldest files so the directory never holds more than `maxFiles`
   * JSONL files *in total, including the active one*.
   *
   * Counting the active file matters: with `maxFiles: 1` the log must still
   * hold exactly one file, and a naive "keep the newest N, plus current" would
   * settle at N+1 forever.
   *
   * `this.current` is never deleted, so the active file survives even when the
   * swept-away order would otherwise include it. Best-effort: a failure to
   * delete must not break appending.
   */
  private enforceRetention(): void {
    try {
      const surplus = this.files().filter((f) => f !== this.current);
      const removable = surplus.length - Math.max(1, this.maxFiles - 1);
      for (const file of surplus.slice(0, Math.max(0, removable))) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // keep going: one stubborn file must not stop the sweep
        }
      }
    } catch {
      // auditing must never take the pipeline down
    }
  }

  private index(file: string): number {
    const m = /-(\d+)\.jsonl$/.exec(path.basename(file));
    return m ? Number(m[1]) : 0;
  }

  private newFile(index: number): string {
    const day = this.now().toISOString().slice(0, 10);
    this.size = 0;
    return path.join(this.dir, `audit-${day}-${String(index).padStart(3, "0")}.jsonl`);
  }
}

/**
 * Coarse failure classification derived from the run's log digest.
 *
 * Heuristic on purpose — the adapters produce prose, not error codes — and the
 * class is used for grouping in the UI, never for a decision.
 */
export function classifyFailure(logDigest: string): string {
  const t = logDigest.toLowerCase();
  if (/401|403|unauthorized|invalid api key|认证失败/.test(t)) return "auth";
  if (/429|rate limit|限流|冷却|cooling|too many requests/.test(t)) return "rate-limit";
  if (/timeout|timed out|deadline|超时|看门狗|空闲/.test(t)) return "timeout";
  if (/files-protocol|schema validation|协议自纠偏|找不到 json/.test(t)) return "protocol";
  if (/zone 越权|越权/.test(t)) return "conflict";
  if (/enospc|eacces|eperm|emfile|内存不足|磁盘/.test(t)) return "resource";
  if (/no agent available|未注册|不在池中/.test(t)) return "no-agent";
  return "unknown";
}
