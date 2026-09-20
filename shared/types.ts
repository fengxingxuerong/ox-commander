export type Stage =
  | "PRD"
  | "PLANNING"
  | "DEVELOPMENT"
  | "VERIFICATION"
  | "DELIVERY"
  | "DONE";

export const STAGE_ORDER: Stage[] = [
  "PRD",
  "PLANNING",
  "DEVELOPMENT",
  "VERIFICATION",
  "DELIVERY",
  "DONE",
];

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "verifying"
  | "repairing"
  | "done"
  | "failed"
  /** Terminal, user-initiated stop: distinct from `failed` so the board does
   * not report an operator's cancel as an agent failure. */
  | "cancelled";

export interface PrdDocument {
  goal: string;
  features: string[];
  techStack: string[];
  acceptanceCriteria: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  zone: string;
  dependencies: string[];
  suggestedRole: string;
}

export interface RepairRecord {
  round: number;
  reason: string;
  errorLogDigest: string;
  dispatchedAt: string;
}

export interface TaskState {
  task: Task;
  status: TaskStatus;
  assignedAgentId?: string;
  attempts: number;
  repairHistory: RepairRecord[];
  lastErrorDigest?: string;
}

export type VerificationKind = "build" | "typecheck" | "test" | "smoke";

/**
 * 独立样本冒烟检查（规划期由大脑生成）：针对交付后的主入口，用真实样例数据
 * 实际运行并断言输出片段 —— 防止"实现与自写测试同口径共谋"的自证盲区
 * （实证：转置 bug 骗过 13 项自写测试）。
 */
export interface SmokeCheck {
  /** 一句话说明这条冒烟在验证什么。 */
  title: string;
  /** 在 projectRoot 下执行的程序（会被 CommandPolicy 沙箱门审查）。 */
  command: string;
  args: string[];
  /** 可选：通过 stdin 喂给程序的样例数据。 */
  stdin?: string;
  /** stdout 必须包含的片段（空数组 = 只看退出码）。 */
  expectContains?: string[];
}

export interface VerificationCommand {
  kind: VerificationKind;
  command: string;
  args: string[];
}

export interface VerificationReport {
  passed: boolean;
  results: Array<{
    kind: VerificationKind;
    ok: boolean;
    exitCode: number | null;
    logDigest: string;
    durationMs: number;
  }>;
}

export type AgentEventKind = "log" | "completed" | "failed" | "aborted";

export interface AgentEvent {
  kind: AgentEventKind;
  text: string;
  timestamp: number;
}

export interface RunHandle {
  runId: string;
  agentId: string;
  taskId: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  kind: "api" | "ui";
}

export interface AgentAdapter {
  readonly meta: AgentMeta;
  probe(): Promise<boolean>;
  dispatch(payload: TaskPayload): Promise<RunHandle>;
  collect(handle: RunHandle): AsyncGenerator<AgentEvent>;
  abort(handle: RunHandle): Promise<void>;
}

export interface TaskPayload {
  runId: string;
  taskId: string;
  title: string;
  description: string;
  zone: string;
  projectRoot: string;
  repairContext?: { round: number; errorLogDigest: string };
}

/** User decision for an escalated (repair-exhausted) task. */
export type EscalationAction = "skip" | "redispatch" | "abort";

/**
 * What to do when a batch touches files outside its declared zones.
 * `report-only`/`deny-all` keep the historic behaviour (report and fail);
 * `revert-batch` restores the workspace before failing; `quarantine` moves the
 * offending files aside so the evidence survives.
 */
export type ArbitrationMode = "report-only" | "deny-all" | "revert-batch" | "quarantine";

export interface ProjectSettings {
  maxRepairRounds: number;
  verificationCommands: VerificationCommand[];
  enabledAgents: string[];
  llmProvider: string;
  /**
   * Route tasks to agents by declared capability (role / zone / tags) instead of
   * round-robin. Enabled by default; the pool stays on the legacy round-robin
   * whenever no agent declares capabilities, so this is safe to leave on.
   */
  agentRouter: boolean;
  /** Zone-violation handling; defaults to rolling the offending changes back. */
  arbitration: ArbitrationMode;
  /**
   * Platform-wide ceiling on concurrently running agents. The pool may be wide,
   * but the provider quota is not — a 10-task batch on a 3-key pool would
   * otherwise stampede into 429s. `0` means unlimited.
   */
  maxParallelRuns: number;
  /**
   * Providers whose routes share one failover table, in preference order.
   * SenseNova contributes 3 keys × 4 models = 12 routes; AMD adds one more.
   * Empty ⇒ fall back to the single `llmProvider`.
   */
  llmPool: string[];
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  maxRepairRounds: 3,
  verificationCommands: [
    { kind: "build", command: "npm", args: ["run", "build"] },
    { kind: "typecheck", command: "npm", args: ["run", "typecheck"] },
    { kind: "test", command: "npm", args: ["run", "test"] },
  ],
  enabledAgents: ["sensenova-api"],
  llmProvider: "sensenova",
  agentRouter: true,
  arbitration: "revert-batch",
  maxParallelRuns: 4,
  llmPool: ["sensenova", "amd-radeon"],
};
