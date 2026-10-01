import type { AgentAdapter, Task } from "../../shared/types";
import type { AgentManifest } from "../../shared/agent-contract";
import type { ArbitrationMode } from "../../shared/types";
import { SensenovaApiAdapter } from "./sensenova-api";
import { AgentRegistry, createRegistry } from "./registry";
import { buildAdaptersFromManifests, loadManifestDir, type ManifestLoadError } from "./manifest-loader";
import { createCapabilityRouter, type RouterOptions } from "../engine/router";
import { CircuitBreaker, type CircuitBreakerOptions } from "../sandbox/circuit-breaker";
import { BatchGuard, type BatchVerdict } from "../engine/batch-guard";
import { SnapshotStore } from "../sandbox/snapshot-store";
import { FileJournal } from "../sandbox/file-journal";
import type { SchedulerOptions } from "../engine/scheduler";
import type { UsageMeter } from "../../shared/usage-meter";
import { remoteExecutorNote } from "./remote-endpoint";

/**
 * Agent registry: the SenseNova API executor is the default worker. Failover
 * across every configured API key × model happens inside its LlmClient layer, so the
 * scheduler has exactly one adapter to talk to unless more are registered.
 *
 * `meter` 只影响内置执行器自己构造的那个客户端 —— 外部声明的 CLI / HTTP
 * 桥接智能体跑在别的进程里，它们的用量不由本进程记账（桥接侧自己知道）。
 */
/**
 * 内置执行器（当前只有 SenseNova API 一个）。
 *
 * `executorTimeoutMs` 是它**单次 HTTP 请求**的超时，不是整轮 run 的时限
 * （后者是 `limits.runDeadlineMs`）。不传时适配器用自己的内置默认。
 */
export function createDefaultAdapters(
  meter?: UsageMeter,
  executorTimeoutMs?: number,
  forbiddenWrite?: readonly string[],
): AgentAdapter[] {
  return [
    new SensenovaApiAdapter(undefined, {
      // 2026-09-28：原为 `...(meter ? { meter } : {})`。条件展开是冗余的 ——
      // 接收方读的是**值**（`opts?.meter`），「键存在但值为 undefined」与
      // 「键不存在」对它没有区别；而那个三元一旦被改反，就是「传了 meter
      // 反而不记账」，用量统计会静默消失。本文件里 5 处同类写法一并简化掉。
      meter,
      ...(executorTimeoutMs !== undefined ? { timeoutMs: executorTimeoutMs } : {}),
      // 路径面（P2-2）：**已算好的并集**（调用方用 pathPolicyOverrides 合成）。
      // 条件展开在这里不是冗余：`PathPolicy` 的 forbiddenWrite 是**替换**语义，
      // 传空数组等于清空地板，所以"没配策略"必须表现为"键不存在"。
      ...(forbiddenWrite !== undefined ? { forbiddenWrite } : {}),
    }),
  ];
}

// `findAdapter` 曾在这里导出，但**生产零调用**：调度器用的是自己的私有同名
// 方法（scheduler.ts 的 this.findAdapter），池外查找走 AgentRegistry。
// 2026-09-27 把本文件纳入变异门禁后，它唯一的作用就是贡献一个永远杀不死的
// 位点（没有任何测试经过它）—— 死代码按规矩删除，不进 EQUIVALENT_SITES。
export interface AgentLayerOptions {
  /** Defaults to the built-in SenseNova adapter list. */
  adapters?: AgentAdapter[];
  /** Declared capabilities per agent; entries may also come from `manifestDir`. */
  manifests?: readonly AgentManifest[];
  /** Directory scanned for `*.json` agent declarations (CLI / HTTP bridge). */
  manifestDir?: string;
  /** Where CLI adapters write their prompt files. */
  promptDir?: string;
  /** Set false to force the pre-router round-robin behaviour. */
  enableRouter?: boolean;
  routerOptions?: RouterOptions;
  /** Bring your own breaker (tests / host-level sharing); one is created otherwise. */
  breaker?: CircuitBreaker;
  breakerOptions?: CircuitBreakerOptions;
  /**
   * Where content backups live. When set, a BatchGuard is installed and zone
   * violations can actually be rolled back; when omitted, no guard is installed
   * and an out-of-zone write is not attributed to the batch that caused it (the
   * sandbox still fail-closes the individual write itself).
   */
  snapshotRoot?: string;
  /** Zone-violation policy; defaults to `revert-batch`. */
  arbitration?: ArbitrationMode;
  /** Extra paths that must never be attributed to one task. */
  sharedPaths?: readonly string[];
  /** Sink for breaker + guard diagnostics (board log). */
  onEvent?: (text: string) => void;
  /** Structured batch verdicts (hosts stream these as events). */
  onVerdict?: (verdict: BatchVerdict) => void;
  /** Routing decision sink (board log). */
  onRouting?: SchedulerOptions["onRouting"];
  /**
   * Token 用量汇总器，转给**内置**执行器（见 `createDefaultAdapters`）。
   * 注入 `adapters` / `layer` 时不经此处 —— 那种情况下用量由注入方负责。
   */
  meter?: UsageMeter;
  /**
   * 内置执行器单次调用的超时（毫秒）。只影响 `createDefaultAdapters` 造出来的那个
   * 适配器 —— 外部声明的 CLI / HTTP 桥接智能体跑在别的进程里，超时由它们自己管。
   */
  executorTimeoutMs?: number;
  /**
   * 路径面（P2-2）：追加到内置禁止写入清单的 glob（**已算好并集**）。
   * 省略 = 内置默认（`DEFAULT_FORBIDDEN_WRITE`）。见 `createDefaultAdapters` 的注释。
   */
  forbiddenWrite?: readonly string[];
}

export interface AgentLayer {
  adapters: AgentAdapter[];
  registry: AgentRegistry;
  /** Three-state breaker shared by the router (scoring) and the scheduler (admission). */
  breaker: CircuitBreaker;
  /** Spread into `new Scheduler(adapters, preferredAgents, schedulerOptions)`. */
  schedulerOptions: SchedulerOptions;
  /** `agents.d` files that failed validation (reported, never fatal). */
  manifestErrors: ManifestLoadError[];
  /** Manifests that produced no adapter, with the reason. */
  skippedManifests: Array<{ id: string; reason: string }>;
}

/**
 * Single assembly point for the agent pool, shared by the Electron (ipc.ts) and
 * headless entries so nothing can drift. Omitting every option reproduces the
 * original single-adapter, round-robin setup.
 */
export function createAgentLayer(opts: AgentLayerOptions = {}): AgentLayer {
  const builtin = opts.adapters ?? createDefaultAdapters(opts.meter, opts.executorTimeoutMs, opts.forbiddenWrite);
  const loaded = opts.manifestDir ? loadManifestDir(opts.manifestDir) : { manifests: [], errors: [] };
  const declared: AgentManifest[] = [
    ...(opts.manifests ?? []).map((m) => (m.source ? m : { ...m, source: "declared" as const })),
    ...loaded.manifests,
  ];
  const built = buildAdaptersFromManifests(declared, {
    promptDir: opts.promptDir,
  });
  const adapters = [...builtin, ...built.adapters];
  // A builtin adapter wins an id clash: its declaration is compiled in.
  const declaredById = new Map<string, AgentManifest>();
  const builtinIds = new Set(builtin.map((a) => a.meta.id));
  for (const m of declared) if (!builtinIds.has(m.id)) declaredById.set(m.id, m);

  // 远程执行器的边界要说破：远端 http-bridge 改的是远端文件，本地的越权检测、
  // 仲裁与回滚对它全部静默失效（不是报错，是看不见）。加载时就说一次，别等
  // 操作者看着"零越权"的看板以为万事大吉。
  for (const m of declared) {
    if (m.entry?.kind !== "http") continue;
    const note = remoteExecutorNote(m.id, m.entry.baseUrl);
    if (note) opts.onEvent?.(note);
  }
  const registry = createRegistry(adapters, { manifests: [...declaredById.values()] });
  const breaker = opts.breaker ?? new CircuitBreaker(opts.breakerOptions ?? {});
  const schedulerOptions: SchedulerOptions = { registry, breaker };
  if (opts.enableRouter !== false) {
    // The router scores with the same breaker the scheduler admits with, so a
    // cooling agent is both deprioritised and (in open state) skipped.
    schedulerOptions.router = createCapabilityRouter({
      stats: breaker.statsProvider(),
      ...(opts.routerOptions ?? {}),
    });
  }
  if (opts.onRouting) schedulerOptions.onRouting = opts.onRouting;
  if (opts.snapshotRoot) {
    const mode = opts.arbitration ?? "revert-batch";
    schedulerOptions.guard = new BatchGuard({
      journal: new FileJournal(),
      snapshots: new SnapshotStore({ backupRoot: opts.snapshotRoot }),
      mode,
      // 2026-09-28：三处条件展开（sharedPaths / onEvent / onVerdict）同理简化 ——
      // BatchGuard 的消费方式是 `opts.sharedPaths ?? DEFAULT_SHARED_PATHS` 与
      // `if (opts.onEvent) this.onEvent = ...`，都只看值。改反的后果是
      // 「配了事件回调却收不到」，排查时只能看到"日志莫名其妙少了"。
      sharedPaths: opts.sharedPaths,
      onEvent: opts.onEvent,
      onVerdict: opts.onVerdict,
    });
  }
  return {
    adapters,
    registry,
    breaker,
    schedulerOptions,
    manifestErrors: loaded.errors,
    skippedManifests: built.skipped,
  };
}

/** Convenience for callers that only need the scheduler wiring. */
export function agentRoutingLogLine(decision: { agentId?: string; score: number; reason: string }, task: Task): string {
  return `[router] ${task.id}（zone=${task.zone}, role=${task.suggestedRole}）→ ${decision.agentId ?? "无可用智能体"} · score=${decision.score} · ${decision.reason}`;
}
