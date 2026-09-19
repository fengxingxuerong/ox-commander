/**
 * Per-run watchdog with two independent trip conditions:
 *
 * - **deadline**: the run has been alive longer than `deadlineMs` (hard ceiling);
 * - **idle**: no event arrived for `idleTimeoutMs` (a hung agent produces no
 *   output — the deadline alone would waste the whole window on it).
 *
 * The gate never kills anything itself; it reports *why* it tripped and lets
 * the owner abort the run through its own adapter (`abort()`), which knows how
 * to tear down its own subprocess / remote run.
 */
export interface TimeoutGateOptions {
  deadlineMs: number;
  idleTimeoutMs: number;
  /** Injectable clock + timers keep the tests deterministic. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export type TripReason = "deadline" | "idle";

export interface WatchTarget {
  id: string;
  deadlineMs?: number;
  idleTimeoutMs?: number;
}

interface Watched {
  id: string;
  onTrip: (reason: TripReason) => void;
  startedAt: number;
  lastActivityAt: number;
  deadlineMs: number;
  idleTimeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  tripped: TripReason | null;
}

export class TimeoutGate {
  private readonly watched = new Map<string, Watched>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly opts: TimeoutGateOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** Starts watching a run; `onTrip` is invoked at most once per run. */
  attach(target: WatchTarget, onTrip: (reason: TripReason) => void): void {
    this.detach(target.id);
    const watched: Watched = {
      id: target.id,
      onTrip,
      startedAt: this.now(),
      lastActivityAt: this.now(),
      deadlineMs: target.deadlineMs ?? this.opts.deadlineMs,
      idleTimeoutMs: target.idleTimeoutMs ?? this.opts.idleTimeoutMs,
      timer: null,
      tripped: null,
    };
    this.watched.set(target.id, watched);
    this.arm(watched);
  }

  /** Signals progress; re-arms the idle watchdog. */
  touch(id: string): void {
    const w = this.watched.get(id);
    if (!w || w.tripped) return;
    w.lastActivityAt = this.now();
    this.arm(w);
  }

  /** Stops watching (normal completion or explicit abort). */
  detach(id: string): void {
    const w = this.watched.get(id);
    if (!w) return;
    if (w.timer) this.clearTimer(w.timer);
    this.watched.delete(id);
  }

  /** Reason the run was tripped, if it was. */
  tripped(id: string): TripReason | null {
    return this.watched.get(id)?.tripped ?? null;
  }

  activeCount(): number {
    return this.watched.size;
  }

  /** Longest a single run may stay alive, across all conditions. */
  get deadlineMs(): number {
    return this.opts.deadlineMs;
  }

  /**
   * Wraps a promise with the gate: whichever comes first wins, and a trip
   * rejects with a labelled error so callers can classify it as `timeout`.
   */
  async guard<T>(id: string, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.detach(id);
        fn();
      };
      const w = this.watched.get(id);
      if (w) {
        const original = w.onTrip;
        w.onTrip = (reason) => {
          original(reason);
          finish(() => reject(new TimeoutError(id, reason)));
        };
      }
      work.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  /** Arms the soonest of (remaining deadline, idle window). */
  private arm(w: Watched): void {
    if (w.timer) this.clearTimer(w.timer);
    const now = this.now();
    const remainingDeadline = w.deadlineMs - (now - w.startedAt);
    const remainingIdle = w.idleTimeoutMs - (now - w.lastActivityAt);
    const wait = Math.max(1, Math.min(remainingDeadline, remainingIdle));
    w.timer = this.setTimer(() => this.fire(w), wait);
  }

  private fire(w: Watched): void {
    const now = this.now();
    if (w.deadlineMs - (now - w.startedAt) <= 0) return this.trip(w, "deadline");
    if (w.idleTimeoutMs - (now - w.lastActivityAt) <= 0) return this.trip(w, "idle");
    this.arm(w); // re-arm: neither condition is actually met yet
  }

  private trip(w: Watched, reason: TripReason): void {
    if (w.tripped) return;
    w.tripped = reason;
    if (w.timer) {
      this.clearTimer(w.timer);
      w.timer = null;
    }
    w.onTrip(reason);
  }
}

export class TimeoutError extends Error {
  constructor(
    public readonly runId: string,
    public readonly reason: TripReason,
  ) {
    super(`run ${runId} ${reason === "deadline" ? "超出总时限" : "空闲超时（无输出）"}`);
    this.name = "TimeoutError";
  }
}
