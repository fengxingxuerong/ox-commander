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

/**
 * Agent registry: the SenseNova API executor is the default worker. Failover
 * across 3 API keys × 3 models happens inside its LlmClient layer, so the
 * scheduler has exactly one adapter to talk to unless more are registered.
 */
export function createDefaultAdapters(): AgentAdapter[] {
  return [new SensenovaApiAdapter()];
}

export function findAdapter(adapters: AgentAdapter[], agentId: string): AgentAdapter | undefined {
  return adapters.find((a) => a.meta.id === agentId);
}

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
  const builtin = opts.adapters ?? createDefaultAdapters();
  const loaded = opts.manifestDir ? loadManifestDir(opts.manifestDir) : { manifests: [], errors: [] };
  const declared: AgentManifest[] = [
    ...(opts.manifests ?? []).map((m) => (m.source ? m : { ...m, source: "declared" as const })),
    ...loaded.manifests,
  ];
  const built = buildAdaptersFromManifests(declared, {
    ...(opts.promptDir ? { promptDir: opts.promptDir } : {}),
  });
  const adapters = [...builtin, ...built.adapters];
  // A builtin adapter wins an id clash: its declaration is compiled in.
  const declaredById = new Map<string, AgentManifest>();
  const builtinIds = new Set(builtin.map((a) => a.meta.id));
  for (const m of declared) if (!builtinIds.has(m.id)) declaredById.set(m.id, m);

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
      ...(opts.sharedPaths ? { sharedPaths: opts.sharedPaths } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.onVerdict ? { onVerdict: opts.onVerdict } : {}),
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
