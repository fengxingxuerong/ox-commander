import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  Task,
  TaskPayload,
} from "../../shared/types";
import type { AgentDescriptor, AgentAction } from "../../shared/agent-contract";
import { CONTRACT_MARKER, STANDARD_CONTRACT_RULES } from "../../shared/prompts";
import { zonesOverlap } from "../../shared/glob";
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
 * 并发准入：满载的声明 agent 在本批不再接单，改派给第一个还能接的
 * （legacy 恒可接；声明的看余量）。全满 → 无人。
 *
 * 它是**模块级导出函数而不是私有方法**，原因是这个判定的输入在端到端路径上
 * 构造不出来：registry.candidates 已经在评分层把满载 agent 过滤掉了，于是
 * router 永远不会把一个满载的声明 agent 递到这里（实测：池里只要有 legacy，
 * router 就先选 legacy）。也就是说"满载改派"这条二次防线在真实链路上不可达，
 * 拿不到"它守住了"的证据。把入参显式化之后，测试才能直接喂"上游失效"的组合
 * （wanted 已满 + available 里有 legacy / 未注册者）。
 *
 * 2026-09-26 实弹演习实测：maxConcurrency=1 的 loomy 同批接下 t1/t2 两单 ——
 * load 评分是软惩罚（-10/单位），压不过优先级/专属区的分差。
 */
export function admitConcurrency(
  wanted: AgentAdapter | undefined,
  inflight: ReadonlyMap<string, number>,
  available: AgentAdapter[],
  registry?: AgentRegistry,
): AgentAdapter | undefined {
  if (!wanted) return undefined;
  const wantedDesc = registry?.get(wanted.meta.id);
  if (!wantedDesc || wantedDesc.inferredLegacy) return wanted;
  if ((inflight.get(wanted.meta.id) ?? 0) < wantedDesc.capabilities.maxConcurrency) return wanted;
  return available.find((a) => {
    if (a.meta.id === wanted.meta.id) return false;
    const d = registry?.get(a.meta.id);
    if (!d || d.inferredLegacy) return true;
    return (inflight.get(a.meta.id) ?? 0) < d.capabilities.maxConcurrency;
  });
}

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
   * 跨动作状态机的观察面（竞品调研 §5.1）：每条 agent 日志喂给它，批次内
   * 出现过依赖安装/发布/推送痕迹后，验证命令面据此升级审查。可选 —— 不传
   * 则调度器行为与从前完全一致。
   */
  actionGate?: { observe(text: string): void };
  /**
   * 任务级冗余赛马（竞品调研 §5.3，学 Vibe Kanban，默认 1 = 关闭）。
   *
   * >1 时每个任务并行派给 min(raceRedundancy, 可用执行器数) 个**不同**执行器，
   * 第一个到达终态成功者赢得该任务，其余立即 abort。产物正确性不靠赛马本身
   * —— 批次后的统一硬门禁照旧把关；赛马是拿 token 换时间（等慢执行器的
   * 批次里，快者先交付）。输家静默：不进审计、不记 breaker、不进任务账，
   * 全组归因由赢家的 logDigest 承载（成员、各自结局与时长）。
   */
  raceRedundancy?: number;
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
      this.opts.registry.candidates({ task, requiredTags }).map((d) => d.manifest.id),
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
      if (!ok) return tasks.map(() => undefined);
      // 点名路径也要过并发闸：点名是显式意图，但 maxConcurrency 是能力声明，
      // 连续点名的第 N 个任务不能把它打穿。满载时不静默改派别人（那违背点名
      // 语义），如实报 no-agent，交给修复轮在 agent 空闲后重试。
      const planned = new Map<string, number>();
      return tasks.map(() => {
        const d = this.opts.registry?.get(exact.meta.id);
        if (d && !d.inferredLegacy) {
          if ((planned.get(exact.meta.id) ?? 0) >= d.capabilities.maxConcurrency) return undefined;
        }
        planned.set(exact.meta.id, (planned.get(exact.meta.id) ?? 0) + 1);
        return exact;
      });
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
      const picked = this.admitConcurrency(this.admitBreaker(wanted, available), inflight, available);
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

  /**
   * Concurrency admission: a declared agent at capacity takes no more tasks in
   * this batch. The router already filters saturated candidates, but this gate
   * carries real weight on two paths that bypass scoring entirely — the
   * round-robin fallback (`?? available[i % n]`, which would otherwise hand a
   * "no one available" decision straight back to the saturated agent) and any
   * future caller that picks without routing. It is the scheduler-side twin of
   * the registry's hard filter, not a redundant re-check.
   *
   * 2026-09-26 实弹演习实测：maxConcurrency=1 的 loomy 同批接下 t1/t2 两单 ——
   * load 评分是软惩罚（-10/单位），压不过优先级/专属区的分差。
   */
  private admitConcurrency(
    wanted: AgentAdapter | undefined,
    inflight: ReadonlyMap<string, number>,
    available: AgentAdapter[],
  ): AgentAdapter | undefined {
    return admitConcurrency(wanted, inflight, available, this.opts.registry);
  }

  async runBatch(
    tasks: Task[],
    projectRoot: string,
    opts?: { preferredAgentId?: string; repairOf?: Map<string, { round: number; errorLogDigest: string }> },
  ): Promise<DispatchOutcome[]> {
    const zones = tasks.map((t) => t.zone);
    // 互斥的是**重叠**，不是同名。原判定只做字符串全等，于是 `src` 与 `src/util`
    // 可以同批并发写同一个目录 —— 而越权检测看不见它：每一条写入都落在本批某个
    // zone 之内，`BatchGuard` 会放过去。全等只是重叠的一个特例。
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        if (zonesOverlap(zones[i], zones[j])) {
          throw new Error(`zone conflict inside batch: 「${zones[i]}」与「${zones[j]}」重叠`);
        }
      }
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
      const preferred = agentPool[i];
      if (!preferred) {
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

      // 任务级冗余赛马（§5.3）：redundancy > 1 时同任务派 N 个不同执行器并行，
      // 第一个到终态成功者赢，其余 abort。redundancy = 1 保持单派发路径不变。
      // 成员从**整个可用池**取（agentPool 是 per-task 首选分配，单任务批拿不到
      // 第二个执行器）；probe 已在 planPool 里做过，这里直接用同池候选。
      const redundancy = Math.max(1, Math.floor(this.opts.raceRedundancy ?? 1));
      const extras: AgentAdapter[] = [];
      if (redundancy > 1) {
        for (const a of await this.availableAgents()) {
          if (extras.length >= redundancy - 1) break;
          if (a.meta.id !== preferred.meta.id) extras.push(a);
        }
      }
      const members: AgentAdapter[] = [preferred, ...extras].slice(0, redundancy);
      const startedAt = Date.now();
      // onRunStart 是组级事实（审计 run-start 一条）：planned 归因记首选执行者，
      // 实际赢家由 run-end 承载 —— 与"start 计划 / end 实际"的既有语义一致。
      this.opts.onRunStart?.(members[0]!.meta.id, task);
      const buildPayload = (): TaskPayload => ({
        runId: `${task.id}-${Date.now()}-${i}-${(dispatchSeq += 1)}`,
        taskId: task.id,
        title: task.title,
        description,
        zone: task.zone,
        projectRoot,
        repairContext: repair,
      });

      if (members.length === 1) {
        return await this.dispatchOne(members[0]!, task, buildPayload(), { startedAt });
      }

      // 赛马组：全部成员并发派发，逐个等到终态；首个 ok 者赢。
      // 全员 silent：通知（onRunComplete / breaker / 限流记账）由编排层统一发，
      // 输家被中止不是执行器的错，也不能让 aborted 事实污染看板恢复语义。
      const entries = members.map((agent) => {
        const handleRef: { current?: RunHandle } = {};
        const p = this.dispatchOne(agent, task, buildPayload(), {
          handleRef,
          silent: true,
        }).then((outcome) => ({ agent, handleRef, outcome }));
        return { agent, handleRef, p };
      });

      const pending = new Set(entries.map((e) => e.p));
      const failures: string[] = [];
      let winner: { agent: AgentAdapter; outcome: DispatchOutcome } | undefined;
      while (pending.size > 0 && !winner) {
        const settled = await Promise.race([...pending].map(async (p) => ({ p, r: await p })));
        pending.delete(settled.p);
        if (settled.r.outcome.ok) {
          winner = { agent: settled.r.agent, outcome: settled.r.outcome };
          break;
        }
        // 到终态的失败者：真实失败，照记 breaker 与限流账。
        this.opts.breaker?.record(settled.r.agent.meta.id, false);
        this.noteRateLimit(settled.r.outcome.errorClass);
        failures.push(
          `${settled.r.agent.meta.id}: ${(settled.r.outcome.logDigest || "无日志").slice(0, 200)}`,
        );
      }

      if (winner) {
        // 赢家确定：其余成员立即 abort（killTree），并排空它们的 collect 让
        // 适配器内部状态归位。
        const losers: string[] = [];
        await Promise.all(
          entries
            .filter((e) => e.agent.meta.id !== winner!.agent.meta.id)
            .map(async (e) => {
              const handle = e.handleRef.current;
              if (handle) {
                const adapter = this.findAdapter(handle.agentId);
                try {
                  await adapter?.abort(handle);
                } catch {
                  // abort 是尽力而为；失败不影响赢家交付
                }
                const tail = await this.collectToTerminal(handle, task.id).catch(() => undefined);
                losers.push(`${e.agent.meta.id}: ${tail && tail.ok ? "完赛（晚于赢家）" : "已中止"}`);
              } else {
                // 还卡在 throttle/dispatch 阶段，没有 handle 可中止：排空即弃。
                losers.push(`${e.agent.meta.id}: 未完赛（派发阶段）`);
                await e.p.catch(() => undefined);
              }
            }),
        );
        this.opts.breaker?.record(winner.agent.meta.id, true);
        this.noteRateLimit(winner.outcome.errorClass);
        const digest = [
          `[赛马] 成员：${members.map((m) => m.meta.id).join("、")}`,
          ...losers.map((l) => `[赛马] 输家 ${l}`),
          winner.outcome.logDigest,
        ]
          .filter(Boolean)
          .join("\n");
        const withMeta: DispatchOutcome = { ...winner.outcome, logDigest: digest };
        this.opts.onRunComplete?.(withMeta, task);
        return withMeta;
      }

      // 全员失败：汇总一份失败 outcome（进重修），errorClass 取最后一个。
      const last = entries[entries.length - 1]!;
      const lastOutcome = (await last.p.catch(() => undefined))?.outcome;
      const summary: DispatchOutcome = {
        taskId: task.id,
        ok: false,
        logDigest: [`[赛马] 全部 ${members.length} 个执行器失败：`, ...failures].join("\n"),
        events: [],
        agentId: last.agent.meta.id,
        durationMs: Date.now() - startedAt,
        errorClass: lastOutcome?.errorClass ?? "unknown",
      };
      this.opts.onRunComplete?.(summary, task);
      return summary;
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

  /**
   * 单次派发的执行本体：并发闸 → 派发 → 收集到终态。`silent` 模式（赛马成员）
   * 不发 onRunComplete、不记 breaker、不记限流 —— 通知职责上移到赛马编排层，
   * 输家的 aborted 终态不能污染任务账与看板恢复语义。`handleRef`（可选）让
   * 赛马编排层在派发返回后立刻拿到句柄，赢家确定时才能中止还在飞的输家。
   */
  private async dispatchOne(
    agent: AgentAdapter,
    task: Task,
    payload: TaskPayload,
    opts?: {
      silent?: boolean;
      handleRef?: { current?: RunHandle };
      startedAt?: number;
    },
  ): Promise<DispatchOutcome> {
    const silent = opts?.silent ?? false;
    const startedAt = opts?.startedAt ?? Date.now();
    // Platform-wide concurrency cap: the pool may be wide, but the provider
    // quota is not. Held for the whole run, released in `finally`.
    await this.acquireSlot();
    let handle: RunHandle | undefined;
    try {
      await this.awaitThrottle();
      handle = await agent.dispatch(payload);
      if (opts?.handleRef) opts.handleRef.current = handle;
      this.liveRuns.set(handle.runId, handle);
      const outcome = await this.collectToTerminal(handle, task.id);
      const withMeta: DispatchOutcome = {
        ...outcome,
        agentId: agent.meta.id,
        durationMs: Date.now() - startedAt,
        ...(outcome.ok ? {} : { errorClass: classifyFailure(outcome.logDigest) }),
      };
      if (!silent) {
        this.opts.breaker?.record(agent.meta.id, withMeta.ok);
        this.noteRateLimit(withMeta.errorClass);
        this.opts.onRunComplete?.(withMeta, task);
      }
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
      if (!silent) {
        this.opts.breaker?.record(agent.meta.id, false);
        this.noteRateLimit(failed.errorClass);
        this.opts.onRunComplete?.(failed, task);
      }
      return failed;
    } finally {
      if (handle) this.liveRuns.delete(handle.runId);
      this.releaseSlot();
    }
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
        // Observation surface of the cross-action state machine: what the
        // agent did (installs, publishes, pushes) betrays itself in its log.
        this.opts.actionGate?.observe(event.text);
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
