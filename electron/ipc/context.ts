/**
 * Shared mutable state for the main-process IPC layer, plus the factories that
 * build the long-lived singletons (stores, agent pool, audit log, engine).
 *
 * This module exists so the per-domain handler files under `electron/ipc/` can
 * share state without importing each other. Only this file may hold `let`
 * bindings for that state; the handler modules are stateless registrars.
 */
import { app, safeStorage, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { OrchestratorEngine, type OrchestratorCallbacks, type RunSnapshot } from "../engine";
import { agentRoutingLogLine, createAgentLayer, type AgentLayer } from "../agents";
import { AuditLog } from "../audit-log";
import { createPlatform, type Platform } from "../platform";
import { writeFileAtomic } from "../atomic-file";
import { ProjectStore, SettingsStore } from "../store";
import { KeysStore, createSafeStorageCrypto } from "../keys-store";
import { getProvider, providerKeyEnvVars } from "../../shared/providers";
import { redactSecrets } from "../../shared/redact";
import type { AgentAdapter } from "../../shared/types";
import type { AgentManifest } from "../../shared/agent-contract";
import type { LlmClient } from "../../shared/llm-client";
import type { EscalationAction, ProjectSettings } from "../../shared/types";

let store: ProjectStore | null = null;
let settingsHolder: SettingsStore | null = null;
let keysHolder: KeysStore | null = null;
/** One engine per project, so switching projects never crosses wires. */
const engines = new Map<string, OrchestratorEngine>();
let currentWindow: BrowserWindow | null = null;
/** ProjectId of the engine currently inside execute(); guards re-entry. */
let runningProjectId: string | null = null;
/** Pending user decisions for escalated tasks: taskId -> resolver. */
const pendingEscalations = new Map<string, (action: EscalationAction) => void>();

/**
 * The agent pool is a long-lived singleton: agents registered at runtime must
 * survive engine rebuilds, and the Scheduler reads the pool on every batch.
 */
let agentLayer: AgentLayer | null = null;
/** Runtime-registered agents, re-applied whenever the layer is rebuilt. */
const dynamicAgents = new Map<string, { adapter: AgentAdapter; manifest: AgentManifest }>();
/** Signature of the settings the live layer was built with. */
let layerSignature: string | null = null;

let audit: AuditLog | null = null;

export function agentDir(): string {
  return path.join(app.getPath("userData"), "agents.d");
}

export function promptDir(): string {
  return path.join(app.getPath("userData"), "runs");
}

export function snapshotRoot(): string {
  return path.join(app.getPath("userData"), "snapshots");
}

/** Where per-project checkpoint journals live (desktop parity with headless). */
export function journalDir(): string {
  return path.join(app.getPath("userData"), "runs");
}

export function workspaceRoot(projectId: string): string {
  return path.join(app.getPath("userData"), "workspaces", projectId);
}

export function attachWindow(win: BrowserWindow): void {
  currentWindow = win;
}

/** Push one event payload to the renderer, if a window is attached. */
export function send(payload: Record<string, unknown>): void {
  currentWindow?.webContents.send("ox:event", payload);
}

export function logLine(text: string): void {
  send({ type: "log", text });
}

export function getRunningProjectId(): string | null {
  return runningProjectId;
}

export function setRunningProjectId(projectId: string | null): void {
  runningProjectId = projectId;
}

export function enginesOf(): Map<string, OrchestratorEngine> {
  return engines;
}

export function pendingEscalationMap(): ReadonlyMap<string, (action: EscalationAction) => void> {
  return pendingEscalations;
}

export function resolveEscalation(taskId: string, action: EscalationAction): boolean {
  const resolve = pendingEscalations.get(taskId);
  if (!resolve) return false;
  pendingEscalations.delete(taskId);
  resolve(action);
  return true;
}

/** Aborts every parked escalation so a cancelled run can observe the cancel. */
export function abortAllEscalations(): void {
  for (const resolve of pendingEscalations.values()) resolve("abort");
  pendingEscalations.clear();
}

export function dynamicAgentMap(): Map<string, { adapter: AgentAdapter; manifest: AgentManifest }> {
  return dynamicAgents;
}

export function getAgentLayer(): AgentLayer | null {
  return agentLayer;
}

/** Append-only run audit under userData/audit (survives reloads and restarts). */
export function ensureAudit(): AuditLog {
  if (!audit) audit = new AuditLog({ dir: path.join(app.getPath("userData"), "audit") });
  return audit;
}

export function ensureStores(): void {
  if (!store) {
    store = new ProjectStore(path.join(app.getPath("userData"), "data"));
  }
  if (!settingsHolder) {
    settingsHolder = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  }
  if (!keysHolder) {
    keysHolder = new KeysStore(
      path.join(app.getPath("userData"), "keys.json"),
      // OS keychain (DPAPI / Keychain / libsecret) when the platform has one;
      // the store falls back to plaintext and reports that state to the UI.
      createSafeStorageCrypto(safeStorage),
    );
  }
}

/**
 * Non-null accessors. `registerIpc()` calls `ensureStores()` first, so inside a
 * registered handler these are always populated — the getters keep the non-null
 * assertion out of every handler body.
 */
export function stores(): ProjectStore {
  if (!store) throw new Error("stores not initialised: call registerIpc() first");
  return store;
}

export function settingsStore(): SettingsStore {
  if (!settingsHolder) throw new Error("stores not initialised: call registerIpc() first");
  return settingsHolder;
}

export function keysStore(): KeysStore {
  if (!keysHolder) throw new Error("stores not initialised: call registerIpc() first");
  return keysHolder;
}

/**
 * Seeds every pooled provider's env vars from the key store, so a provider with
 * no key in the process environment still participates when the operator saved
 * one on the settings screen. Passed into the platform so key-store knowledge
 * stays on the Electron side (headless has no key store).
 */
export function seedKeysFromStore(settingsValue: ProjectSettings, envVars: Set<string>): void {
  const keys = keysHolder;
  if (!keys) return;
  const pool = settingsValue.llmPool ?? [];
  for (const id of pool.length > 0 ? pool : [settingsValue.llmProvider]) {
    const provider = getProvider(id);
    for (const v of providerKeyEnvVars(id)) envVars.add(v);
    if (provider.apiKeyEnvVar) envVars.add(provider.apiKeyEnvVar);
  }
  for (const v of envVars) {
    if (!process.env[v]) process.env[v] = keys.get(v);
  }
}

export function ensureAgentLayer(settingsValue: ProjectSettings): AgentLayer {
  const signature = `router=${settingsValue.agentRouter !== false};arbitration=${settingsValue.arbitration}`;
  if (agentLayer && layerSignature === signature) return agentLayer;
  const layer = createAgentLayer({
    enableRouter: settingsValue.agentRouter !== false,
    manifestDir: agentDir(),
    promptDir: promptDir(),
    snapshotRoot: snapshotRoot(),
    arbitration: settingsValue.arbitration,
    onRouting: (decision, task) => logLine(agentRoutingLogLine(decision, task)),
    onEvent: (text) => logLine(`[sandbox] ${text}`),
    breakerOptions: { onEvent: (text) => logLine(`[breaker] ${text}`) },
  });
  for (const { adapter, manifest } of dynamicAgents.values()) {
    layer.registry.register({ adapter, manifest });
  }
  agentLayer = layer;
  layerSignature = signature;
  return layer;
}

/**
 * Desktop assembly of the shared platform. Every host-specific side effect
 * (audit, renderer push, escalation parking) is supplied here, so the engine
 * wiring itself stays identical to the headless entry point.
 */
export function buildPlatformLayer(
  settingsValue: ProjectSettings,
  overrides: {
    log: (text: string) => void;
    journal?: { save(snapshot: RunSnapshot): void };
    callbacks?: Partial<OrchestratorCallbacks>;
  },
): Platform {
  const auditLog = ensureAudit();
  return createPlatform({
    settings: settingsValue,
    promptDir: promptDir(),
    snapshotRoot: snapshotRoot(),
    manifestDir: agentDir(),
    enableRouter: settingsValue.agentRouter !== false,
    arbitration: settingsValue.arbitration,
    maxParallelRuns: settingsValue.maxParallelRuns,
    // The pool is a singleton so runtime registration survives engine rebuilds.
    layer: ensureAgentLayer(settingsValue),
    ...(overrides.journal ? { journal: overrides.journal } : {}),
    host: {
      log: overrides.log,
      ...(overrides.callbacks ? { callbacks: overrides.callbacks } : {}),
      // P5 observability: every run start/end is attributed and persisted, so
      // "which agent did what" survives a reload.
      onRunStart: (agentId, task) => {
        auditLog.append({ phase: "run-start", agentId, taskId: task.id, zone: task.zone });
      },
      onRunComplete: (outcome, task) => {
        auditLog.append({
          phase: "run-end",
          taskId: task.id,
          zone: task.zone,
          ok: outcome.ok,
          ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
          ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
          // Audit JSONL is durable: redact before it hits disk.
          detail: redactSecrets(outcome.logDigest).slice(0, 300),
        });
      },
      // Zone-conflict verdicts must reach the board even though the guard lives
      // inside the long-lived layer, not inside this engine.
      onVerdict: (verdict) => {
        for (const conflict of verdict.conflicts) {
          send({
            type: "conflict",
            kind: conflict.kind,
            paths: conflict.paths,
            remedy:
              verdict.remedies.find((r) => r.paths.some((p) => conflict.paths.includes(p)))?.action ??
              "none",
          });
        }
      },
      requestEscalationDecision: (taskId) =>
        new Promise<EscalationAction>((resolve) => {
          // The escalation event itself is already sent by onEscalation; here
          // we only park the resolver until the renderer answers.
          pendingEscalations.set(taskId, resolve);
        }),
    },
  });
}

/** Brain client for one-shot calls (the settings "test connection" button). */
export function buildLlm(settingsValue: ProjectSettings): LlmClient {
  const platform = buildPlatformLayer(settingsValue, { log: logLine });
  return platform.buildLlm((envVars) => seedKeysFromStore(settingsValue, envVars));
}

/** Writes a checkpoint journal for one project. Best-effort: never breaks a run. */
export function writeJournal(projectId: string, snapshot: RunSnapshot): void {
  try {
    fs.mkdirSync(journalDir(), { recursive: true });
    // Atomic: a truncated checkpoint is worse than none — resume would read a
    // half-written snapshot and restart the run from a bogus state.
    writeFileAtomic(
      path.join(journalDir(), `${projectId}.json`),
      JSON.stringify({ savedAt: new Date().toISOString(), snapshot }, null, 2),
    );
  } catch {
    // Checkpointing is a best-effort fuse; never break a run over it.
  }
}
