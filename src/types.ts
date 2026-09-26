import type { EscalationAction, PrdDocument, ProjectSettings, Stage, Task, TaskStatus, VerificationReport } from "../shared/types";
import type { AgentCapabilities, AgentLimits, AgentManifest } from "../shared/agent-contract";

/** Serializable agent summary shown in the settings panel (no credentials). */
export interface AgentSummary {
  id: string;
  displayName: string;
  adapter: AgentManifest["adapter"];
  source: "builtin" | "declared" | "agents.d";
  enabled: boolean;
  /** True when capabilities were inferred from a v1 adapter. */
  inferredLegacy: boolean;
  priority: number;
  capabilities: Required<AgentCapabilities>;
  limits: AgentLimits;
  credentialKind: string;
}

export interface AgentListResult {
  agents: AgentSummary[];
  manifestDir: string;
  manifestErrors: Array<{ file: string; message: string }>;
  skippedManifests: Array<{ id: string; reason: string }>;
}

/**
 * 运行时注册的 manifest 是否成功写回 `agents.d`。
 *
 * 注册成功但 `ok:false` 是有意义的中间态：这一轮 agent 能用，重启就没了 ——
 * UI 必须把它说出来，不能只报"注册成功"。
 * `removed` 只在注销分支出现（false = 文件被改过、没删）。
 */
export interface ManifestPersistResult {
  ok: boolean;
  path?: string;
  removed?: boolean;
  reason?: string;
}

export type AgentMutationResult =
  | { ok: true; id: string; replaced?: boolean; persisted?: ManifestPersistResult }
  | { ok: true; drained: "drained" | "timeout" | "unsupported"; persisted?: ManifestPersistResult }
  | { ok: false; error: string };

export interface TaskView {
  taskId: string;
  title: string;
  zone: string;
  status: TaskStatus;
  attempts: number;
  /** Failure digest from the most recent run; present when the last run failed. */
  failureDigest?: string;
  /** Which agent ran it last (P5 attribution). */
  agentId?: string;
  /** Coarse failure class from the last run, for grouping. */
  errorClass?: string;
  /** Duration of the last run. */
  durationMs?: number;
}

/** Per-agent circuit state, as reported by the breaker. */
export interface AgentCircuitStats {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  successes: number;
  failures: number;
  successRate?: number;
  retryInMs: number;
}

export interface AuditRecordView {
  ts: string;
  phase: "run-start" | "run-end" | "batch-guard" | "agent-change" | "settings";
  runId?: string;
  taskId?: string;
  agentId?: string;
  zone?: string;
  ok?: boolean;
  durationMs?: number;
  errorClass?: string;
  changed?: number;
  paths?: string[];
  pathsTotal?: number;
  detail?: string;
}

/**
 * Outcome of the audit export dialog, reported as data instead of throwing:
 * "canceled" is a normal outcome and must be distinguishable from "empty"
 * (nothing to export) and from a real write failure.
 */
export type AuditExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export interface EscalationView {
  taskId: string;
  summary: string;
  resolved: boolean;
}

/**
 * A zone-conflict verdict surfaced to the board. The engine's BatchGuard knows
 * which files two concurrent tasks fought over and what it did about it; without
 * this the arbitration outcome is only visible in the durable audit file.
 */
export interface ConflictView {
  kind: string;
  paths: string[];
  remedy: string;
  ts: string;
}

export type Page = "projects" | "board" | "prd-review" | "settings";

export interface AppState {
  page: Page;
  projects: Array<{ id: string; name: string; stage: string; requirement: string }>;
  activeProjectId?: string;
  stage: Stage;
  logs: string[];
  tasks: Record<string, TaskView>;
  verification?: VerificationReport;
  escalations: EscalationView[];
  conflicts: ConflictView[];
  prd?: PrdDocument;
  batches?: Task[][];
  planning: boolean;
  planningError?: string;
  settings?: ProjectSettings;
  /** Last settings load/save failure; cleared when the next call succeeds. */
  settingsError?: string;
  /**
   * Last project-list failure (refresh / create / delete). These all happen on
   * the projects page, which has no log view, so the error has to live in
   * state to be reachable at all.
   */
  projectsError?: string;
  newProjectName: string;
  newRequirement: string;

  setPage(page: Page): void;
  setNewProjectName(name: string): void;
  setNewRequirement(text: string): void;
  refreshProjects(): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  createAndOpen(): Promise<void>;
  runPlanning(): Promise<void>;
  retryPlanning(): Promise<void>;
  updatePrd(prd: PrdDocument): Promise<void>;
  confirmAndExecute(): Promise<void>;
  backToProjects(): void;
  loadSettings(): Promise<void>;
  saveSettings(settings: ProjectSettings): Promise<void>;
  resolveEscalation(taskId: string, action: EscalationAction): Promise<void>;
  handleEvent(payload: Record<string, unknown>): void;
}

declare global {
  interface Window {
    oxCommander: {
      createProject(name: string, requirement: string): Promise<{ id: string }>;
      listProjects(): Promise<Array<{ id: string; name: string; stage: string; requirement: string }>>;
      openWorkspace(projectId: string): Promise<void>;
      deleteProject(projectId: string): Promise<boolean>;
      getSettings(): Promise<ProjectSettings>;
      saveSettings(settings: ProjectSettings): Promise<boolean>;
      getKeysStatus(envVars: string[]): Promise<Array<{ envVar: string; configured: boolean; source: "env" | "store" }>>;
      getKeySecurity(): Promise<{ encryptedAtRest: boolean; plaintextCount: number }>;
      saveKeys(entries: Array<{ envVar: string; value: string }>): Promise<number>;
      testLlm(): Promise<{ ok: true; model: string } | { ok: false; error: string; status?: number }>;
      runPlanning(projectId: string): Promise<{ prd: PrdDocument; batches: Task[][] }>;
      updatePrd(projectId: string, prd: PrdDocument): Promise<{ prd: PrdDocument; batches: Task[][] }>;
      startOrchestration(projectId: string): Promise<void>;
      cancel(): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      resolveEscalation(taskId: string, action: EscalationAction): Promise<boolean>;
      listAgents(): Promise<AgentListResult>;
      exampleManifest(): Promise<AgentManifest>;
      registerAgent(manifest: unknown): Promise<AgentMutationResult>;
      unregisterAgent(id: string, graceMs?: number): Promise<AgentMutationResult>;
      toggleAgent(id: string, enabled: boolean): Promise<boolean>;
      probeAgents(id?: string): Promise<Record<string, boolean>>;
      getAgentStats(): Promise<{ circuits: Record<string, AgentCircuitStats> }>;
      recentAudit(limit?: number): Promise<AuditRecordView[]>;
      auditFiles(): Promise<string[]>;
      exportAudit(): Promise<AuditExportResult>;
      onEvent(handler: (payload: unknown) => void): () => void;
    };
  }
}
