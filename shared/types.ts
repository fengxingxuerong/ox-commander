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
  | "failed";

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

export type VerificationKind = "build" | "typecheck" | "test";

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
  pid?: number;
}

export interface AgentMeta {
  id: string;
  name: string;
  kind: "cli" | "ui";
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

export interface ProjectSettings {
  maxRepairRounds: number;
  verificationCommands: VerificationCommand[];
  enabledAgents: string[];
  llmProvider: string;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  maxRepairRounds: 3,
  verificationCommands: [
    { kind: "build", command: "npm", args: ["run", "build"] },
    { kind: "typecheck", command: "npm", args: ["run", "typecheck"] },
    { kind: "test", command: "npm", args: ["run", "test"] },
  ],
  enabledAgents: ["claude-code"],
  llmProvider: "deepseek",
};
