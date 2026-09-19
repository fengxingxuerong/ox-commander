import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  Task,
  TaskPayload,
} from "../../shared/types";
import type { AgentDescriptor, AgentAction } from "../../shared/agent-contract";
import { ZoneGuard } from "./zone-guard";
import { wrapLegacyDescriptor, type AgentRegistry } from "../agents/registry";
import type { CapabilityRouter, RoutingDecision } from "./router";
import type { CircuitBreaker } from "../sandbox/circuit-breaker";
import type { BatchGuard } from "./batch-guard";
import { classifyFailure } from "../audit-log";

export interface DispatchOutcome {
  taskId: string;
  ok: boolean;
  logDigest: string;
  events: AgentEvent[];
  /** Which agent actually ran it (absent when nothing was available). */
  agentId?: string;
  durationMs?: number;
  /** Coarse failure class, for grouping in the UI and the audit trail. */
  errorClass?: string;
}

export const DEFAULT_MAX_PARALLEL_RUNS = 4;

/**
 * Optional multi-agent extensions. Omitted ⇒ behaviour identical to the
 * pre-router Scheduler (round-robin over probe-passing adapters).
 */
export interface SchedulerOptions {
  router?: CapabilityRouter;
  registry?: AgentRegistry;
  /** Three-state breaker: an agent that keeps failing is skipped, not retried. */
  breaker?: CircuitBreaker;
  /**
   * Post-batch adjudicator (P4): stat-only change detection + rollback +
   * arbitration. When present it replaces the ZoneGuard fail-everything path.
   */
  guard?: BatchGuard;
  /**
   * Ceiling on concurrently running agents across the whole platform. The pool
   * may be wide, but the provider quota is not — a batch of 10 tasks on a
   * 3-key pool would otherwise stampede into 429s. Defaults to 4.
   */
  maxParallelRuns?: number;
  /** Fired right before a run is dispatched (audit / UI). */
  onRunStart?: (agentId: string, task: Task) => void;
  /** Fired for every terminal outcome, including "no agent available". */
  onRunComplete?: (outcome: DispatchOutcome, task: Task) => void;
  /** Sink for routing decisions, e.g. forwarded to the board log. */
  onRouting?: (decision: RoutingDecision, task: Task) => void;
  /**
   * 429 感知派发节流：一次 rate-limit 失败后，下一个排队任务延迟派发
   * （指数退避，封顶 rateLimitMaxBackoffMs），避免在配额墙上继续撞。
   */
  rateLimitBackoffMs?: number;
  /** 节流上限（默认 5 分钟）。 */
  rateLimitMaxBackoffMs?: number;
  /** 节流可观测性：实际等待了多久、连续第几次限流。 */
  onThrottle?: (waitMs: number, streak: number) => void;
}

/**
 * Zone-isolating concurrent dispatcher: runs one batch of zone-disjoint tasks
 * across the available agent pool concurrently, collects each run to its
 * terminal event, and returns structured outcomes. When several agents are
 * available, tasks are distributed round-robin so the batch genuinely runs as
 * multi-agent parallel work; a ZoneGuard (optional) fails any batch whose
 * files changed outside the declared zones.
 *
 * With `opts.router` + `opts.registry` the round-robin assignment is replaced
 * by capability routing (agent capability declaration → task role/zone/tags).
 * The legacy path stays reachable at any time: a pool in which no agent
 * declares capabilities routes exactly like before.
 */
export class Scheduler {
  private probeCache = new Map<string, Promise<boolean>>();
  /** Platform-wide concurrency gate (see `SchedulerOptions.maxParallelRuns`). */
  private running = 0;
  private slotWaiters: Array<() => void> = [];
  /** 429 节流：此前派发必须等到的时间戳（epoch ms）。 */
  private throttleUntil = 0;
  /** 连续 rate-limit 次数（成功一次即清零）。 */
  private rateLimitStreak = 0;

  constructor(
    private adapters: AgentAdapter[],
    private preferredAgents: string[] = [],
    private zoneGuard?: ZoneGuard,
    private opts: SchedulerOptions = {},
  ) {}

  private maxParallel(): number {
    const n = this.opts.maxParallelRuns ?? DEFAULT_MAX_PARALLEL_RUNS;
    return n <= 0 ? Number.POSITIVE_INFINITY : n;
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < this.maxParallel()) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  /** FIFO hand-off: the slot transfers to the next waiter, so `running` cannot drift. */
  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.running -= 1;
  }

  /** Runs currently holding a slot; surfaced by the agents panel. */
  activeRuns(): number {
    return this.running;
  }

  private probeCached(adapter: AgentAdapter): Promise<boolean> {
    let cached = this.probeCache.get(adapter.meta.id);
    if (!cached) {
      cached = adapter.probe().catch(() => false);
      this.probeCache.set(adapter.meta.id, cached);
    }
    return cached;
  }

  /** Drops cached probe results (all agents, or one) — call after register/unregister. */
  forgetProbe(agentId?: string): void {
    if (agentId === undefined) this.probeCache.clear();
    else this.probeCache.delete(agentId);
  }

  /** Live pool: the registry when present (so dynamic registration works), else the constructor list. */
  private pool(): AgentAdapter[] {
    return this.opts.registry ? this.opts.registry.activeAdapters() : this.adapters;
  }

  /**
   * 429 节流闸：拿到并发槽位后、真正派发前等待。持槽等待是有意的——
   * 节流的目的就是让后续排队任务一起延后，别在配额墙上继续撞。
   */
  private async awaitThrottle(): Promise<void> {
    const wait = this.throttleUntil - Date.now();
    if (wait > 0) {
      this.opts.onThrottle?.(wait, this.rateLimitStreak);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** 根据刚结束的一次运行更新节流状态：rate-limit 指数退避，干净结果清零。 */
  private noteRateLimit(errorClass?: string): void {
    if (errorClass === "rate-limit") {
      this.rateLimitStreak += 1;
      const base = this.opts.rateLimitBackoffMs ?? 30_000;
      const cap = this.opts.rateLimitMaxBackoffMs ?? 300_000;
      this.throttleUntil = Date.now() + Math.min(base * 2 ** (this.rateLimitStreak - 1), cap);
    } else {
      this.rateLimitStreak = 0;
      this.throttleUntil = 0;
    }
  }

  private findAdapter(agentId: string): AgentAdapter | undefined {
    return this.pool().find((a) => a.meta.id === agentId);
  }

  /** Registered adapters ordered by settings preference; stable sort keeps registry order for the rest. */
  private candidates(): AgentAdapter[] {
    const rank = new Map(this.preferredAgents.map((id, i) => [id, i]));
    return [...this.pool()].sort(
      (x, y) =>
        (rank.get(x.meta.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(y.meta.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  /** All probing-true candidates, preference order first. */
  private async availableAgents(): Promise<AgentAdapter[]> {
    const candidates = this.candidates();
    const probes = await Promise.all(candidates.map((a) => this.probeCached(a)));
    return candidates.filter((_, i) => probes[i]);
  }

  /**
   * Probe-passing descriptors whose declared capabilities can serve the task.
   * Availability order (preference first) is preserved; the registry only
   * removes candidates it can prove unsuitable.
   */
  private descriptorsFor(task: Task, available: AgentAdapter[], requiredTags?: AgentAction[]): AgentDescriptor[] {
    const pool = available.map((a) => this.opts.registry?.get(a.meta.id) ?? wrapLegacyDescriptor(a));
    if (!this.opts.registry) return pool;
    const allowed = new Set(
      this.opts.registry.candidates({ task, ...(requiredTags ? { requiredTags } : {}) }).map((d) => d.manifest.id),
    );
    return pool.filter((d) => allowed.has(d.manifest.id));
  }

  /**
   * Assigns one adapter per task, in batch order. Legacy behaviour (no router,
   * or an all-v1 pool) is unchanged: `available[index % n]`.
   */
  private async planPool(
    tasks: Task[],
    preferredAgentId?: string,
  ): Promise<Array<AgentAdapter | undefined>> {
    if (preferredAgentId) {
      const exact = this.findAdapter(preferredAgentId);
      if (!exact) return tasks.map(() => undefined);
      const ok = await this.probeCached(exact);
      return tasks.map(() => (ok ? exact : undefined));
    }
    const available = await this.availableAgents();
    if (available.length === 0) return tasks.map(() => undefined);
    const router = this.opts.router;
    if (!router) {
      return tasks.map((_, i) => this.admitBreaker(available[i % available.length]!, available));
    }

    const inflight = new Map<string, number>();
    return tasks.map((task, i) => {
      const candidates = this.descriptorsFor(task, available);
      const decision = router.assign({
        task,
        index: i,
        candidates,
        inflight,
        preferredAgents: this.preferredAgents,
      });
      this.opts.onRouting?.(decision, task);
      // Never route worse than the legacy pool: an unassignable task falls back
      // to round-robin rather than failing with "no agent available".
      const wanted =
        (decision.agentId ? available.find((a) => a.meta.id === decision.agentId) : undefined) ??
        available[i % available.length];
      const picked = this.admitBreaker(wanted, available);
      if (picked) inflight.set(picked.meta.id, (inflight.get(picked.meta.id) ?? 0) + 1);
      return picked;
    });
  }

  /**
   * Circuit-breaker admission: an agent whose circuit is open is skipped, and a
   * half-open circuit admits exactly one probe. When the chosen agent is
   * blocked, the first admissible alternative in the pool takes the task.
   */
  private admitBreaker(
    wanted: AgentAdapter | undefined,
    available: AgentAdapter[],
  ): AgentAdapter | undefined {
    const breaker = this.opts.breaker;
    if (!wanted) return undefined;
    if (!breaker) return wanted;
    if (breaker.allow(wanted.meta.id)) return wanted;
    return available.find((a) => a.meta.id !== wanted.meta.id && breaker.allow(a.meta.id));
  }

  async runBatch(
    tasks: Task[],
    projectRoot: string,
    opts?: { preferredAgentId?: string; repairOf?: Map<string, { round: number; errorLogDigest: string }> },
  ): Promise<DispatchOutcome[]> {
    const zones = tasks.map((t) => t.zone);
    const duplicated = zones.filter((z, i) => zones.indexOf(z) !== i);
    if (duplicated.length > 0) {
      throw new Error(`zone conflict inside batch: ${[...new Set(duplicated)].join(", ")}`);
    }

    const agentPool = await this.planPool(tasks, opts?.preferredAgentId);
    const guard = this.opts.guard;
    const scope = guard
      ? await guard.begin(`batch-${Date.now().toString(36)}-${tasks.map((t) => t.id).join("_")}`, projectRoot, zones)
      : null;
    const before = !guard && this.zoneGuard ? this.zoneGuard.snapshot(projectRoot) : null;

    const jobs = tasks.map(async (task, i) => {
      const agent = agentPool[i];
      if (!agent) {
        const miss: DispatchOutcome = {
          taskId: task.id,
          ok: false,
          logDigest: "no agent available",
          events: [],
          errorClass: "no-agent",
        };
        this.opts.onRunComplete?.(miss, task);
        return miss;
      }
      const repair = opts?.repairOf?.get(task.id);
      const payload: TaskPayload = {
        runId: `${task.id}-${Date.now()}-${i}`,
        taskId: task.id,
        title: task.title,
        description: task.description,
        zone: task.zone,
        projectRoot,
        ...(repair ? { repairContext: repair } : {}),
      };
      const startedAt = Date.now();
      this.opts.onRunStart?.(agent.meta.id, task);
      // Platform-wide concurrency cap: the pool may be wide, but the provider
      // quota is not. Held for the whole run, released in `finally`.
      await this.acquireSlot();
      try {
        await this.awaitThrottle();
        const handle = await agent.dispatch(payload);
        const outcome = await this.collectToTerminal(handle, task.id);
        const withMeta: DispatchOutcome = {
          ...outcome,
          agentId: agent.meta.id,
          durationMs: Date.now() - startedAt,
          ...(outcome.ok ? {} : { errorClass: classifyFailure(outcome.logDigest) }),
        };
        this.opts.breaker?.record(agent.meta.id, withMeta.ok);
        this.noteRateLimit(withMeta.errorClass);
        this.opts.onRunComplete?.(withMeta, task);
        return withMeta;
      } catch (err) {
        this.opts.breaker?.record(agent.meta.id, false);
        const failed: DispatchOutcome = {
          taskId: task.id,
          ok: false,
          logDigest: `dispatch failed: ${(err as Error).message}`,
          events: [],
          agentId: agent.meta.id,
          durationMs: Date.now() - startedAt,
          errorClass: classifyFailure((err as Error).message) || "unknown",
        };
        this.opts.breaker?.record(agent.meta.id, false);
        this.noteRateLimit(failed.errorClass);
        this.opts.onRunComplete?.(failed, task);
        return failed;
      } finally {
        this.releaseSlot();
      }
    });
    const outcomes = await Promise.all(jobs);

    // P4 path: journal + snapshot + arbitration (detect, roll back, arbitrate).
    if (scope && guard) {
      const verdict = await guard.settle(scope, outcomes);
      return verdict.outcomes;
    }

    if (before && this.zoneGuard) {
      const diff = this.zoneGuard.diff(projectRoot, before);
      const violations = this.zoneGuard.unownedChanges(diff, zones);
      if (violations.length > 0) {
        const notice =
          `zone 越权：本批任务修改了声明 zone 之外的文件 → ${violations.join("、")}` +
          `\n声明 zone：${zones.join("、")}。整批任务判定失败。`;
        return outcomes.map((o) =>
          o.ok
            ? { ...o, ok: false, logDigest: `${o.logDigest}\n${notice}`.trim() }
            : { ...o, logDigest: `${o.logDigest}\n${notice}`.trim() },
        );
      }
    }
    return outcomes;
  }

  private async collectToTerminal(handle: RunHandle, taskId: string): Promise<DispatchOutcome> {
    const adapter = this.findAdapter(handle.agentId);
    if (!adapter) {
      return { taskId, ok: false, logDigest: `agent ${handle.agentId} 已不在池中（可能已注销）`, events: [] };
    }
    const logs: string[] = [];
    let terminalOk = false;
    for await (const event of adapter.collect(handle)) {
      if (event.kind === "log") {
        logs.push(event.text);
      } else if (event.kind === "completed") {
        terminalOk = true;
        break;
      } else if (event.kind === "failed" || event.kind === "aborted") {
        logs.push(event.text);
        break;
      }
    }
    return { taskId, ok: terminalOk, logDigest: digest(logs.join("\n")), events: [] };
  }
}

/** Keep the head and tail of long logs; error summaries usually live in the tail. */
export function digest(log: string, maxLen = 4000): string {
  const clean = log.trim();
  if (clean.length <= maxLen) return clean;
  const half = Math.floor(maxLen / 2);
  return `${clean.slice(0, half)}\n...[truncated]...\n${clean.slice(-half)}`;
}
