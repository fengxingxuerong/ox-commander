import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  Task,
  TaskPayload,
} from "../../shared/types";
import type { AgentDescriptor, AgentAction } from "../../shared/agent-contract";
import { CONTRACT_MARKER, STANDARD_CONTRACT_RULES } from "../../shared/prompts";
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
 * 批号与 runId 的防碰撞后缀。`Date.now()` 只有毫秒粒度，裸时间戳派生的 id 会同毫秒相撞。
 *
 * 两者的作用域不一样，所以补的东西也不一样：
 *   · 批号会被当快照**目录名**用（`BatchGuard.begin` → `snapshots/<runId>`），目录是
 *     跨进程共享的，因此必须带 pid —— 只加进程内序数不够，两个进程都从 1 开始；
 *   · runId 只活在**本进程**的适配器里（每个进程一套适配器实例），序数就够。
 * 序数这一修法与 `electron/store.ts` 的项目 id 同源。
 */
let dispatchSeq = 0;

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
   * Post-batch adjudicator: stat-only change detection + rollback +
   * arbitration. When present, a write outside the declared zones is detected,
   * rolled back (per `mode`) and attributed instead of going unnoticed.
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
 * multi-agent parallel work.
 *
 * Unauthorized writes are handled once, after the batch settles, by `opts.guard`
 * (see `SchedulerOptions.guard`). An earlier third constructor argument took a
 * `ZoneGuard` and failed the whole batch on any out-of-zone change; it was
 * removed because no production assembly ever passed one — `platform.ts` is the
 * only wiring point and always passed `undefined`, so that branch could not run
 * while its tests kept passing (dead path kept alive by coverage).
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
  /**
   * 正在跑的 run → 它的句柄。`cancel()` 要能把它们真的掐掉，只设标志位的话
   * 外部 CLI 智能体会继续跑满自己的 runDeadline（默认 600s）并改文件。
   */
  private readonly liveRuns = new Map<string, RunHandle>();
  private slotWaiters: Array<() => void> = [];
  /** 429 节流：此前派发必须等到的时间戳（epoch ms）。 */
  private throttleUntil = 0;
  /** 连续 rate-limit 次数（成功一次即清零）。 */
  private rateLimitStreak = 0;

  constructor(
    private adapters: AgentAdapter[],
    private preferredAgents: string[] = [],
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

  /**
   * 请求中止所有在跑的 run（`OrchestratorEngine.cancel()` 的下游）。
   *
   * 逐个适配器单独处理：一个 abort 抛错不该让其余的继续跑。返回值是**成功请求
   * 中止的数量**，且本方法永不 reject —— 调用方是同步的 cancel，接不住异常。
   */
  async abortInFlight(): Promise<number> {
    let aborted = 0;
    for (const handle of [...this.liveRuns.values()]) {
      const adapter = this.findAdapter(handle.agentId);
      if (!adapter) continue;
      try {
        await adapter.abort(handle);
        aborted += 1;
      } catch {
        // abort 失败没有能收着它的地方：适配器自己不收口的话，run 会按自己的
        // 时限跑完。这里不报错是为了让其余在跑的 run 仍被中止。
      }
    }
    return aborted;
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
    // `guard` 与它开出的 `scope` 是同生共死的：要么都有，要么都没有。
    // 打成一对之后，收尾处只需要判一次真值。
    //
    // 原先写成 `if (scope && guard)`，两个条件互为蕴含（guard 存在则 scope
    // 必是 `begin` 返回的对象），属于冗余合取项 —— 改成 `||` 与原文完全等价，
    // 于是变异测试永远杀不掉它。按「能简化就简化」处理。
    const settlement = guard
      ? {
          guard,
          scope: await guard.begin(
            `batch-${Date.now().toString(36)}-${process.pid}-${(dispatchSeq += 1)}-${tasks.map((t) => t.id).join("_")}`,
            projectRoot,
            zones,
          ),
        }
      : null;

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
      // 平台契约模板强制注入：每个执行者（无论哪家智能体）都必须收到统一的
      // 语义条款，堵住"description 没写清 → 各自发明口径"的漂移来源。
      // 带标记检查，避免重修轮重复拼接。
      const baseDesc = task.description ?? "";
      const description = baseDesc.includes(CONTRACT_MARKER)
        ? baseDesc
        : `${baseDesc}\n\n${CONTRACT_MARKER}\n${STANDARD_CONTRACT_RULES}`;
      const payload: TaskPayload = {
        runId: `${task.id}-${Date.now()}-${i}-${(dispatchSeq += 1)}`,
        taskId: task.id,
        title: task.title,
        description,
        zone: task.zone,
        projectRoot,
        ...(repair ? { repairContext: repair } : {}),
      };
      const startedAt = Date.now();
      this.opts.onRunStart?.(agent.meta.id, task);
      // Platform-wide concurrency cap: the pool may be wide, but the provider
      // quota is not. Held for the whole run, released in `finally`.
      await this.acquireSlot();
      let handle: RunHandle | undefined;
      try {
        await this.awaitThrottle();
        handle = await agent.dispatch(payload);
        this.liveRuns.set(handle.runId, handle);
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
        const failed: DispatchOutcome = {
          taskId: task.id,
          ok: false,
          logDigest: `dispatch failed: ${(err as Error).message}`,
          events: [],
          agentId: agent.meta.id,
          durationMs: Date.now() - startedAt,
          errorClass: classifyFailure((err as Error).message) || "unknown",
        };
        // Exactly one record per failed dispatch. `recordFailure` increments
        // `consecutiveFailures`, so a second call here would open a
        // threshold-3 circuit after 2 independent failures instead of 3.
        this.opts.breaker?.record(agent.meta.id, false);
        this.noteRateLimit(failed.errorClass);
        this.opts.onRunComplete?.(failed, task);
        return failed;
      } finally {
        if (handle) this.liveRuns.delete(handle.runId);
        this.releaseSlot();
      }
    });
    const outcomes = await Promise.all(jobs);

    // Zone violations are detected, rolled back and adjudicated by the guard.
    // Without one there is no post-batch check at all: the sandbox still
    // fail-closes every individual write, but nothing can attribute an
    // unauthorized write to the batch that caused it.
    if (settlement) {
      const verdict = await settlement.guard.settle(settlement.scope, outcomes);
      return verdict.outcomes;
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
