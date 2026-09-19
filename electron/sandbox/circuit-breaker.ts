export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive terminal failures that open the circuit; default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before probing again; default 60s. */
  openMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Observability sink. */
  onEvent?: (text: string) => void;
}

export interface CircuitStats {
  state: CircuitState;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  /** Sliding-window success rate, `undefined` until the first outcome. */
  successRate?: number;
  /** How long until a half-open probe is allowed (0 when not open). */
  retryInMs: number;
}

interface Entry {
  consecutiveFailures: number;
  successes: number;
  failures: number;
  openedAt: number | null;
  /** Set while a half-open probe is in flight, so only one run is admitted. */
  probing: boolean;
}

/**
 * Classic three-state breaker over agent ids.
 *
 * - **closed**: everything allowed.
 * - **open**: `allow()` returns false for `openMs`; the agent is skipped by the
 *   router instead of being asked again immediately.
 * - **half-open**: exactly one probe run is admitted. Success closes the
 *   circuit; failure re-opens it. This is what prevents a broken agent from
 *   consuming the whole batch while still allowing self-healing.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (text: string) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? 3);
    this.openMs = Math.max(0, opts.openMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { consecutiveFailures: 0, successes: 0, failures: 0, openedAt: null, probing: false };
      this.entries.set(id, e);
    }
    return e;
  }

  state(id: string): CircuitState {
    const e = this.entries.get(id);
    if (!e || e.openedAt === null) return "closed";
    if (this.now() - e.openedAt >= this.openMs) return "half-open";
    return "open";
  }

  /** True when the agent may take a run now. Admits a single half-open probe. */
  allow(id: string): boolean {
    const state = this.state(id);
    if (state === "closed") return true;
    if (state === "open") return false;
    const e = this.entry(id);
    if (e.probing) return false;
    e.probing = true;
    this.onEvent?.(`${id} 熔断半开：放行一次探测`);
    return true;
  }

  recordSuccess(id: string): void {
    const e = this.entry(id);
    e.successes += 1;
    e.consecutiveFailures = 0;
    const wasOpen = e.openedAt !== null;
    e.openedAt = null;
    e.probing = false;
    if (wasOpen) this.onEvent?.(`${id} 熔断关闭：探测成功`);
  }

  recordFailure(id: string): void {
    const e = this.entry(id);
    e.failures += 1;
    e.consecutiveFailures += 1;
    e.probing = false;
    if (e.openedAt !== null) {
      // A failed half-open probe restarts the open window.
      e.openedAt = this.now();
      this.onEvent?.(`${id} 熔断重新打开：探测失败`);
      return;
    }
    if (e.consecutiveFailures >= this.threshold) {
      e.openedAt = this.now();
      this.onEvent?.(`${id} 连续失败 ${e.consecutiveFailures} 次，熔断 ${Math.round(this.openMs / 1000)}s`);
    }
  }

  /** Feeds a terminal outcome; `retryable: false` outcomes (e.g. auth errors) close nothing. */
  record(id: string, ok: boolean): void {
    if (ok) this.recordSuccess(id);
    else this.recordFailure(id);
  }

  stats(id: string): CircuitStats {
    const e = this.entries.get(id);
    const state = this.state(id);
    const total = (e?.successes ?? 0) + (e?.failures ?? 0);
    return {
      state,
      consecutiveFailures: e?.consecutiveFailures ?? 0,
      successes: e?.successes ?? 0,
      failures: e?.failures ?? 0,
      ...(total > 0 ? { successRate: (e!.successes ?? 0) / total } : {}),
      retryInMs: state === "open" && e?.openedAt !== null ? Math.max(0, this.openMs - (this.now() - e!.openedAt!)) : 0,
    };
  }

  /** Sink suitable for `createCapabilityRouter({ stats })`. */
  statsProvider(): (id: string) => { successRate?: number; circuit: CircuitState } {
    return (id: string) => {
      const s = this.stats(id);
      return { ...(s.successRate !== undefined ? { successRate: s.successRate } : {}), circuit: s.state };
    };
  }

  /** Clears one agent (on register/replacement) or everything (on reset). */
  reset(id?: string): void {
    if (id === undefined) this.entries.clear();
    else this.entries.delete(id);
  }

  snapshot(): Record<string, CircuitStats> {
    const out: Record<string, CircuitStats> = {};
    for (const id of this.entries.keys()) out[id] = this.stats(id);
    return out;
  }
}
