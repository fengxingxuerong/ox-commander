/**
 * Single assembly point for a running platform: agent pool + scheduler + engine.
 *
 * Before this module existed, `electron/ipc.ts` and `headless/run-spec.ts` each
 * built their own engine from their own copy of the wiring. That is how the two
 * drifted: the desktop entry had no `journal` (no checkpoint/resume), no verdict
 * sink (zone rollback invisible in the UI), no LLM timeout override, and passed
 * a dead `ZoneGuard` third argument that the BatchGuard always shadowed.
 *
 * Everything shared lives here; what genuinely differs per host is passed in as
 * callbacks (where logs go, where audit records go, what the escalation policy
 * is). Both entries now describe *policy*, not *structure*.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { OrchestratorEngine, Scheduler, verifyProject } from "./engine";
import type { OrchestratorCallbacks, RunSnapshot } from "./engine";
import type { DispatchOutcome } from "./engine/scheduler";
import type { BatchVerdict } from "./engine/batch-guard";
import { createAgentLayer, agentRoutingLogLine, type AgentLayer } from "./agents";
import { buildLlmClient, buildLlmPool } from "../shared/build-llm";
import type { LlmClient } from "../shared/llm-client";
import type { AgentManifest } from "../shared/agent-contract";
import type {
  ArbitrationMode,
  EscalationAction,
  ProjectSettings,
  VerificationReport,
} from "../shared/types";

/**
 * Brain-layer budget. Congested windows make the 120s default cut routes off
 * mid-generation, so the pool runs at executor grade (300s) — the same lesson
 * that was applied to the executor timeout, now applied to both hosts at once.
 */
export const BRAIN_POOL_TIMEOUT_MS = 300_000;

/** What the platform needs to know about its host. */
export interface PlatformHost {
  /** Board log / protocol event sink. */
  log(text: string): void;
  /** Audit sink for run attribution. Omit when the host streams instead. */
  onRunStart?(agentId: string, task: { id: string; zone: string }): void;
  onRunComplete?(outcome: DispatchOutcome, task: { id: string; zone: string }): void;
  /** Zone-violation verdict sink (rollback / isolation / report-only outcomes). */
  onVerdict?(verdict: BatchVerdict): void;
  /** Escalation decision; omit to keep the engine's fail-fast/typed-error path. */
  requestEscalationDecision?(taskId: string, summary: string): Promise<EscalationAction>;
  /**
   * Extra engine callbacks the host owns (stage persistence, richer task
   * payloads, verification rendering). Merged last, so a host-supplied callback
   * overrides the platform default for the same hook.
   */
  callbacks?: Partial<OrchestratorCallbacks>;
}

export interface PlatformConfig {
  settings: ProjectSettings;
  /** Where CLI adapters write prompt files. */
  promptDir: string;
  /** Content-backup root; enables zone-violation rollback. */
  snapshotRoot?: string;
  /**
   * Declarative agent manifests (headless passes `spec.agents`). The desktop
   * entry only reads `agents.d` from disk, so it omits this.
   */
  manifests?: readonly AgentManifest[];
  manifestDir?: string;
  /** Enable capability routing; defaults to `settings.agentRouter !== false`. */
  enableRouter?: boolean;
  arbitration?: ArbitrationMode;
  /** Concurrency ceiling; overrides `settings.maxParallelRuns` when set. */
  maxParallelRuns?: number;
  /** Explicit provider pool; falls back to `settings.llmPool`. */
  llmPool?: readonly string[];
  /**
   * Durable checkpoint sink. When present the engine saves a snapshot at every
   * checkpoint and the host can resume a killed run instead of starting over.
   */
  journal?: { save(snapshot: RunSnapshot): void };
  host: PlatformHost;
  /** Test seams. */
  llm?: LlmClient;
  layer?: AgentLayer;
  verify?: (cwd: string) => Promise<VerificationReport>;
}

export interface Platform {
  engine: OrchestratorEngine;
  layer: AgentLayer;
  /**
   * Builds the brain client. `seedKeys` lets the Electron host top up provider
   * env vars from its encrypted key store first; headless omits it.
   */
  buildLlm(seedKeys?: (envVars: Set<string>) => void): LlmClient;
  /** Scheduler options shared by both hosts (exposed for parity assertions). */
  schedulerOptions(): ConstructorParameters<typeof Scheduler>[3];
}

/**
 * Assembles the agent pool and engine from one config object. Hosts differ only
 * in the callbacks they pass and whether they supply a journal — the structural
 * wiring (router, breaker, guard, scheduler limits, LLM grade) is identical.
 */
export function createPlatform(config: PlatformConfig): Platform {
  const { settings, host } = config;
  const log = host.log;

  const layer =
    config.layer ??
    createAgentLayer({
      enableRouter: config.enableRouter ?? settings.agentRouter !== false,
      ...(config.manifests ? { manifests: config.manifests } : {}),
      ...(config.manifestDir ? { manifestDir: config.manifestDir } : {}),
      promptDir: config.promptDir,
      ...(config.snapshotRoot ? { snapshotRoot: config.snapshotRoot } : {}),
      arbitration: config.arbitration ?? settings.arbitration,
      onRouting: (decision, task) => log(agentRoutingLogLine(decision, task)),
      onEvent: (text) => log(`[sandbox] ${text}`),
      breakerOptions: { onEvent: (text) => log(`[breaker] ${text}`) },
    });

  // Attached after construction so an injected layer reports verdicts exactly
  // like a self-built one (tests inject a layer; the sink must still fire).
  if (host.onVerdict && layer.schedulerOptions.guard) {
    const sink = host.onVerdict;
    layer.schedulerOptions.guard.setVerdictSink((verdict) => sink(verdict));
  }

  const schedulerOptions = (): ConstructorParameters<typeof Scheduler>[3] => ({
    ...layer.schedulerOptions,
    maxParallelRuns: config.maxParallelRuns ?? settings.maxParallelRuns,
    ...(host.onRunStart ? { onRunStart: host.onRunStart } : {}),
    ...(host.onRunComplete ? { onRunComplete: host.onRunComplete } : {}),
  });

  /**
   * Brain client builder. Seeding first matters: the pool reads provider keys
   * from `process.env`, and the Electron host keeps them encrypted on disk.
   */
  const buildLlm = (seedKeys?: (envVars: Set<string>) => void): LlmClient => {
    if (config.llm) return config.llm;
    // The host's seeder mutates `process.env` (it owns the key store); the set
    // it receives is just the list of vars worth resolving.
    if (seedKeys) seedKeys(new Set<string>());
    const pool = config.llmPool ?? settings.llmPool ?? [];
    return pool.length > 0
      ? buildLlmPool({ providers: pool, timeoutMs: BRAIN_POOL_TIMEOUT_MS, onEvent: log })
      : buildLlmClient(settings.llmProvider, { timeoutMs: BRAIN_POOL_TIMEOUT_MS, onEvent: log });
  };

  const callbacks: OrchestratorCallbacks = {
    onStage: (stage) => log(`── 阶段：${stage} ──`),
    onLog: (text) => log(text),
    onTaskStatus: (taskId, status, attempts) => log(`[task] ${taskId} → ${status}（第 ${attempts} 次）`),
    onVerification: () => undefined,
    onEscalation: () => undefined,
    ...(host.requestEscalationDecision
      ? { requestEscalationDecision: host.requestEscalationDecision }
      : {}),
    ...(host.callbacks ?? {}),
  };

  const engine = new OrchestratorEngine(
    {
      llm: buildLlm(),
      scheduler: new Scheduler(layer.adapters, settings.enabledAgents, undefined, schedulerOptions()),
      verify:
        config.verify ??
        ((cwd: string) => verifyProject(settings.verificationCommands, { cwd: () => cwd, onEvent: log })),
      settings,
      ...(config.journal ? { journal: config.journal } : {}),
    },
    callbacks,
  );

  return { engine, layer, schedulerOptions, buildLlm };
}

export interface FileJournalHandle {
  path: string;
  save(snapshot: RunSnapshot): void;
  /** The stored snapshot, or undefined when absent / mismatched / corrupt. */
  load(): RunSnapshot | undefined;
  /** True when a journal existed but belonged to a different requirement. */
  mismatched(): boolean;
  /** True when a journal existed but could not be parsed. */
  corrupted(): boolean;
}

/**
 * File-backed checkpoint journal: one file at the project root, keyed by the
 * requirement so a different requirement never resumes the wrong run.
 */
export function createFileJournal(projectRoot: string, requirement: string): FileJournalHandle {
  const file = path.join(projectRoot, "ox-run-journal.json");
  let mismatch = false;
  let corrupt = false;
  return {
    path: file,
    save: (snapshot: RunSnapshot): void => {
      try {
        // Atomic: a half-written checkpoint would make the next `load()` report
        // `corrupted`, silently discarding a perfectly good resume point.
        writeFileAtomic(
          file,
          JSON.stringify({ requirement, savedAt: new Date().toISOString(), snapshot }, null, 2),
        );
      } catch {
        // Checkpointing is a best-effort fuse; a failed write must not abort a run.
      }
    },
    load: (): RunSnapshot | undefined => {
      if (!fs.existsSync(file)) return undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
          requirement?: string;
          snapshot?: RunSnapshot;
        };
        if (parsed.requirement === requirement && Array.isArray(parsed.snapshot?.batches)) {
          return parsed.snapshot;
        }
        mismatch = true;
        return undefined;
      } catch {
        corrupt = true;
        return undefined;
      }
    },
    mismatched: () => mismatch,
    corrupted: () => corrupt,
  };
}
