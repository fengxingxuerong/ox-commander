export type CircuitState = "closed" | "open" | "half-open";

/** Persisted per-agent totals: the routing quality signal that survives restarts. */
export interface AgentTotals {
  successes: number;
  failures: number;
}

/**
 * 成功率的跨 run 记忆（2026-10-11 竞品刷新，ruflo「自适应记忆」在本架构里的
 * 对位物）：路由给历史成功率打分（quality × successRate），而这份账此前只活在
 * 进程内存里——桌面端进程活着才累积，headless 每个 run 归零。持久化把
 * successes/failures 两本总账存进宿主给的文件（桌面端 `userData/agent-stats.json`）。
 *
 * 边界（说破）：只恢复**总账**，不恢复 `consecutiveFailures`/`openedAt`——
 * 新进程一律从 closed 起步，短期的熔断行为仍由本 run 的事实决定；恢复的是
 * "这个 agent 历史上靠不靠谱"的先验，不是"它上一 run 挂没挂"的结论。
 * `save` 的实现必须自吞 IO 错误（账本是增强，不是权威）——熔断判定不因
 * 落盘失败而中断。
 */
export interface CircuitPersistence {
  /** 缺文件/损坏/读失败时返回 undefined（从零开始），实现自行兜底。 */
  load(): Record<string, AgentTotals> | undefined;
  save(totals: Record<string, AgentTotals>): void;
}

export interface CircuitBreakerOptions {
  /** Consecutive terminal failures that open the circuit; default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before probing again; default 60s. */
  openMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Observability sink. */
  onEvent?: (text: string) => void;
  /** 成功率总账的持久化（见 `CircuitPersistence`）；缺省 = 纯内存，行为同从前。 */
  persistence?: CircuitPersistence;
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
  private readonly persistence?: CircuitPersistence;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? 3);
    this.openMs = Math.max(0, opts.openMs ?? 60_000);
    this.now = opts.now ?? Date.now;
    if (opts.onEvent) this.onEvent = opts.onEvent;
    if (opts.persistence) {
      this.persistence = opts.persistence;
      // 只恢复总账：consecutiveFailures 归零、一律 closed 起步（见接口注释）。
      const saved = opts.persistence.load();
      if (saved) {
        for (const [id, totals] of Object.entries(saved)) {
          if (typeof totals?.successes !== "number" || typeof totals?.failures !== "number") continue;
          if (totals.successes <= 0 && totals.failures <= 0) continue;
          this.entries.set(id, {
            consecutiveFailures: 0,
            successes: totals.successes,
            failures: totals.failures,
            openedAt: null,
            probing: false,
          });
        }
      }
    }
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
    this.persist();
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
      this.persist();
      return;
    }
    if (e.consecutiveFailures >= this.threshold) {
      e.openedAt = this.now();
      this.onEvent?.(`${id} 连续失败 ${e.consecutiveFailures} 次，熔断 ${Math.round(this.openMs / 1000)}s`);
    }
    this.persist();
  }

  /**
   * 总账落盘。比例淡出：总次数超过 500 时按比例折半，让"很久以前的账"
   * 逐渐失去对 successRate 的主导权（先验要能被新事实改写，而不是永远
   * 背着历史包袱）。写盘失败由 persistence 实现自吞（见接口注释）。
   */
  private persist(): void {
    if (!this.persistence) return;
    const CAP = 500;
    const totals: Record<string, AgentTotals> = {};
    for (const [id, e] of this.entries) {
      const total = e.successes + e.failures;
      if (total > CAP) {
        const scale = CAP / total;
        e.successes = Math.max(e.successes > 0 ? 1 : 0, Math.floor(e.successes * scale));
        e.failures = Math.max(e.failures > 0 ? 1 : 0, Math.floor(e.failures * scale));
      }
      totals[id] = { successes: e.successes, failures: e.failures };
    }
    this.persistence.save(totals);
  }

  /**
   * Feeds a terminal outcome. Only the boolean is read: a failure counts toward
   * opening the circuit whether or not it was retryable, so an agent that is
   * broken on credentials gets benched like any other failing one instead of
   * being retried once per task.
   */
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
