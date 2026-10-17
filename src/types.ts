import type { EscalationAction, FailureClass, PrdDocument, ProjectSettings, Stage, Task, TaskStatus, VerificationReport } from "../shared/types";
import type { ReceiptVerifyResult } from "../shared/delivery-receipt";
import type { AgentCapabilities, AgentLimits, AgentManifest } from "../shared/agent-contract";
import type { DeliveryReceipt } from "../shared/delivery-receipt";
import type { UsageSnapshot } from "../shared/usage-meter";
import type { LineHealth } from "../shared/http-clients";
import type { BoardRecoveryView, TaskTrail } from "../electron/board-derive";
import type { GithubIssue, GithubIssueListResult } from "../electron/context/github-readonly";

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
  /**
   * 操作者附言（C2，2026-10-17）：人给这个任务挂的、下一次派发生效的指示。
   * 空串/缺席 = 没有。**不是实时送达**：执行器是一问一答形态，附言进的是
   * 下一次派发的 prompt；任务成功后引擎自动清除并广播空串。
   */
  operatorNote?: string;
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
  /** 本次 run 的开始时刻（confirmAndExecute 落的；看板据此显示已耗时）。 */
  runStartedAt?: number;
  /** 凭据复核的五档裁决（凭据卡的"复核"按钮发起；新 run 开始时清掉）。 */
  receiptVerdict?: ReceiptVerifyResult;
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
  /**
   * 摄入半边（2026-10-14）：从 GitHub issue 建项目。名字取标题、需求取
   * 标题+正文（成文模板与 headless 的 spec.issue 共用），之后与手填创建
   * 走同一条 beginProject → runPlanning 链路。
   */
  createFromIssue(issue: GithubIssue): Promise<void>;
  /** 创建成功后的共同搬家：进 PRD 复核页并立即开始规划。 */
  beginProject(projectId: string): void;
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
  /** 凭据卡"复核"按钮：默认 replay:false（fail-safe，不执行凭据里的命令）。 */
  verifyReceipt(): Promise<void>;
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
      /**
       * 操作者附言（C2）：给一个任务挂一句"下一次派发时带上"的指示；
       * 空串 = 清除。只对**在跑的 run** 有效（引擎内存，不落盘）——
       * 没有 run 时主进程抛错，不静默成功。
       */
      setTaskNote(taskId: string, note: string): Promise<boolean>;
      resolveApproval(requestId: string, granted: boolean): Promise<boolean>;
      verifyReceipt(projectId: string, replay?: boolean): Promise<ReceiptVerifyResult>;
      listAgents(): Promise<AgentListResult>;
      exampleManifest(): Promise<AgentManifest>;
      registerAgent(manifest: unknown): Promise<AgentMutationResult>;
      unregisterAgent(id: string, graceMs?: number): Promise<AgentMutationResult>;
      toggleAgent(id: string, enabled: boolean): Promise<boolean>;
      probeAgents(id?: string): Promise<Record<string, boolean>>;
      getAgentStats(): Promise<{ circuits: Record<string, AgentCircuitStats> }>;
      recentAudit(limit?: number): Promise<AuditRecordView[]>;
      /**
       * 批次改动事实（diff 面板供数，竞品缺口 B1）：`batch-changes` 审计的界面出口。
       * 每批一条（clean 批也落），files 截断上限 100、超限有 filesTotal。
       *
       * `archiveId`（B1 第二半）：本批备份的存档 id。有它才有逐行 diff 与
       * 单文件回滚（`fileDiff` / `revertFile`）—— 缺席的三种情况是未配置
       * 快照存储、存档失败已回收、纯新建批（没有 before 内容）。
       */
      listChanges(projectId?: string): Promise<
        Array<{
          ts: string;
          projectId?: string;
          changed?: number;
          paths?: string[];
          files?: Array<{ path: string; op: string; bytes?: number }>;
          filesTotal?: number;
          archiveId?: string;
        }>
      >;
      /**
       * 逐行 diff（B1 第二半）：存档里的 before × 盘上的 after。
       * 返回 `diffText` 的 `FileDiff`（status/lines/added/deleted/截断标记）。
       */
      fileDiff(
        batchId: string,
        path: string,
      ): Promise<
        | { ok: true; diff: import("../shared/text-diff").FileDiff }
        | { ok: false; reason: string }
      >;
      /**
       * 单文件回滚（B1 第二半）：从存档恢复 before；本批新建的文件撤销新建
       * （需审计里的 create 证据，否则拒绝删除）。界面必须二次确认后调用。
       */
      revertFile(
        batchId: string,
        path: string,
      ): Promise<
        | { ok: true; action: "restored" | "removed" | "already-gone" }
        | { ok: false; reason: string }
      >;
      /**
       * 一个任务的**运行履历**（P1-3 上下文回溯的界面出口）：
       * `deriveBoardView` 回答"现在是什么状态"，它回答"经历过什么" ——
       * 重修轮里同一个任务会被派给不同执行器，前一次为什么失败、换谁重派的。
       *
       * 2026-10-14 补：主进程的 `audit:trail` handler 与 preload 的转发**早就有了**，
       * 但渲染层的桥接类型里一直没声明这个方法 ⇒ 界面拿不到有类型的句柄、从没调用过
       * ⇒ 功能静默不可用（不报错、不留日志，只是"这个能力没人用得上"）。
       */
      taskTrail(taskId: string): Promise<TaskTrail>;
      auditFiles(): Promise<string[]>;
      exportAudit(): Promise<AuditExportResult>;
      /**
       * 摄入半边（2026-10-14）：列 GitHub issue 给"从 issue 建任务"的选择器。
       * 只读（`gh issue list`，白名单在 electron/context/github-readonly.ts）；
       * gh 没装/没登录折进结果的 reason —— "没拿到"与"没有 issue"是两件事。
       */
      listGithubIssues(input: { repo?: string; search?: string; limit?: number }): Promise<GithubIssueListResult>;
      /** Board view derived from the audit trail (durable facts). */
      boardRecovery(): Promise<BoardRecoveryView>;
      onEvent(handler: (payload: unknown) => void): () => void;
    };
  }
}
