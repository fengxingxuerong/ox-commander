import type { EscalationAction, FailureClass, PrdDocument, ProjectSettings, Stage, Task, TaskStatus, VerificationReport } from "../shared/types";
import type { AgentCapabilities, AgentLimits, AgentManifest } from "../shared/agent-contract";
import type { DeliveryReceipt } from "../shared/delivery-receipt";
import type { UsageSnapshot } from "../shared/usage-meter";
import type { LineHealth } from "../shared/http-clients";
import type { BoardRecoveryView } from "../electron/board-derive";

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
  errorClass?: FailureClass;
  /**
   * 最后一次任务活性心跳（2026-10-03 竞品吸收，学 Orca 的 agent heartbeats）：
   * 派发与每条 agent 事件都会刷新它。running 任务超过 ~30s 无心跳 → 看板显示
   * "静默 Xs"，长任务与挂死从此可区分。字段缺席 = 没有可信的心跳源。
   */
  lastActivityTs?: number;
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

/** 一条等待人工审批的命令（P2-3）：command 命中 approvalCommands 时上板。 */
export interface ApprovalView {
  requestId: string;
  command: string;
  args: string[];
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
  /**
   * 上一次运行的交付凭据（只在交付成功 / 重修耗尽两条出口上到）。
   * 与 `verification` 的关系：那是**逐条命令**的结果，这是**一次运行的结论** ——
   * 看板上两者并存，因为"哪些命令红了"和"这次到底交付了什么"是两个问题。
   */
  receipt?: DeliveryReceipt;
  /**
   * 本次运行的 token 用量（进程内：大脑层 + 内置执行器）。
   *
   * `calls - measuredCalls` 是**端点没上报用量**的次数 —— 那个差值就是这份数字的
   * 可信边界，UI 必须把它和总数一起显示，否则"3k tokens"会被读成全部支出。
   */
  usage?: UsageSnapshot;
  /**
   * 每条 LLM 线路的健康事实（冷却剩余、失败次数、其中明确 429 的次数）。
   *
   * 有故障转移池才有这份表（单 provider 直连时没有线路可报）。它回答的是
   * "现在还有几条线能用、是哪几条在被限流" —— 用量回答的是"一共烧了多少"，
   * 两者是不同维度，别混成一张表。
   */
  lineHealth?: LineHealth[];
  /**
   * True when the audit trail ends mid-run (run-start without a matching
   * run-end): the last run was killed before it could finish. Set by
   * loadRecovery; cleared once a new run starts writing facts.
   */
  interrupted?: boolean;
  /** ts of the last audit fact, shown next to the recovery banner. */
  lastActivityTs?: string;
  escalations: EscalationView[];
  approvals: ApprovalView[];
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
  resolveApproval(requestId: string, granted: boolean): Promise<void>;
  /** Rebuilds the board from audit facts on mount (facts/derived split). */
  loadRecovery(): Promise<void>;
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
      resolveApproval(requestId: string, granted: boolean): Promise<boolean>;
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
      /** Board view derived from the audit trail (durable facts). */
      boardRecovery(): Promise<BoardRecoveryView>;
      onEvent(handler: (payload: unknown) => void): () => void;
    };
  }
}
