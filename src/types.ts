import type { EscalationAction, FailureClass, PrdDocument, ProjectSettings, Stage, Task, TaskStatus, VerificationReport } from "../shared/types";
import type { ReceiptVerifyResult } from "../shared/delivery-receipt";
import type { AgentCapabilities, AgentLimits, AgentManifest } from "../shared/agent-contract";
import { type DeliveryReceipt } from "../shared/delivery-receipt";
import type { DeliveryFileRead, DeliveryGuide, PreviewState } from "../shared/delivery-guide";
import type { UsageSnapshot } from "../shared/usage-meter";
import type { LineHealth } from "../shared/http-clients";
import type { BoardRecoveryView, TaskTrail } from "../electron/board-derive";
import type {
  ChatApprovalRequest,
  ChatEntry,
  ChatRevertResult,
  ChatSessionSummary,
  ChatStatus,
  ChatTranscript,
} from "../shared/chat-events";
import type { ApprovalPolicy, SandboxMode } from "../shared/tools/policy";
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

/**
 * 一个被扫到的执行器候选（C6 执行器自动探测）。
 *
 * `manifest` 是来源模板里那份**可直接注册**的声明 —— 界面不自己拼参数：
 * 拼错了就是"配好了但永远跑不起来"（2026-09-20 的 codex `--prompt-file`
 * 教训：模板里不存在于真 CLI 的参数，健康检查照样绿）。
 */
export interface DetectedCliView {
  id: string;
  displayName: string;
  /** 在 PATH 里找的命令名（claude / codex / aider …）。 */
  command: string;
  found: boolean;
  /** 找到的绝对路径；未找到时缺席（不是空串）。 */
  absPath?: string;
  /** 没装时给人看的安装提示（核实过的命令；没核实的一律不给命令）。 */
  installHint: string;
  /** 已在池里 ⇒ 不显示"接入"。 */
  registered: boolean;
  manifest: Record<string, unknown>;
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

/**
 * 五格导航。第 5 格 `chat` 是**交互式会话**（对标 Codex 的 TUI 那一层）：
 * 与看板那条"需求 → PRD → 批次 → 门禁"流水线并行，不共用审批队列。
 */
export type Page = "projects" | "board" | "prd-review" | "chat" | "settings";

/**
 * 会话页在渲染层持有的全部状态。
 *
 * `pendingApproval` 用**单条**而不是数组：会话是严格串行的（一次 send 就是一次
 * "说到做完"），同一时刻最多有一个动作在等人；用数组会让界面出现"两个都答"
 * 这种实际不会发生的状态。
 */
export interface ChatView {
  sessionId?: string;
  entries: ChatEntry[];
  /** 当前项目的历史会话（最近在前）；只含元数据，正文按需 resume/load。 */
  sessions: ChatSessionSummary[];
  status: ChatStatus;
  turns: number;
  usageTokens: number;
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  pendingApproval?: ChatApprovalRequest;
  /** 需要人看着时给的一句话（如"没有选项目"）——空串表示没有。 */
  notice: string;
  /**
   * 正在流入的正文片段（`chat:delta` 拼起来）。**不是转录**：收到下一条
   * entry / done / error 就清空，落盘与恢复都不带它。
   */
  streaming: string;
}

export interface AppState {
  page: Page;
  chat: ChatView;
  chatInput: string;
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
  setChatInput(text: string): void;
  /**
   * 发一句话给会话。立刻返回（会话在后台跑，过程由 `ox:event` 逐条推），
   * 所以这里必须把"已发出"与"已完成"分开：界面上的"停止"按钮依据的是 status。
   */
  sendChat(): Promise<void>;
  /** 中止当前这一轮（轮次之间生效，不是杀进程）。 */
  abortChat(): Promise<void>;
  /** 开一个新会话（清掉旧转录）。 */
  newChat(): Promise<void>;
  /** 加载当前会话（无活会话时自动恢复最近一条）；随后刷新会话列表。 */
  loadChatTranscript(): Promise<void>;
  loadChatSessions(): Promise<void>;
  resumeChat(sessionId: string): Promise<void>;
  forkChat(sessionId: string): Promise<void>;
  deleteChat(sessionId: string): Promise<void>;
  /** 撤销某轮（可只撤一个文件）的 apply_patch 改动。 */
  revertChat(turn: number, path?: string): Promise<void>;
  /**
   * 答复一次审批。三选一对齐 Codex：允许一次 / 本次会话不再问 / 拒绝并说明理由。
   * 拒绝理由会回灌给模型 —— 不给理由，它只会原样重试同一个动作。
   */
  resolveChatApproval(granted: boolean, scope?: "once" | "session", reason?: string): Promise<void>;
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
  /**
   * 从项目库点开一个已有项目：只切当前项目 + 进看板，**不**重新规划。
   * （2026-10-19：此前点行只切页面、不动 activeProjectId，于是看板显示的
   *   还是上一个项目 —— 点了没反应，这是"看不出点在起作用"的典型。）
   */
  openProject(projectId: string): void;
  /**
   * 左栏点项目（M1）：切当前项目并进会话页。
   *
   * 与 `openProject` 的分工是刻意的：那个去**看板**（编排流水线的进度），
   * 这个去**会话页**（线程与执行流）。同一次点击里做两件会互相打断的事
   * 是 Codex 式工作台要避免的 —— 切项目不是"开始跑"，只是换一块工作区。
   * 失败不跳页：先在原地说，不带着空白页走。
   */
  focusProject(projectId: string): Promise<void>;
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
      /**
       * 扫 PATH 出执行器候选（C6）。每个候选带来源模板里那份可直接注册的
       * manifest —— "接入"就是把 manifest 交给 `registerAgent`，不用手写 JSON。
       */
      detectClis(): Promise<DetectedCliView[]>;
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
      /**
       * 本次运行的成果面：按任务分组的产物路径 + 可复制验收命令。
       * 推导在 `shared/delivery-guide`（serve 状态页用同一份），主进程只补
       * 审计事实与 workspace/package.json。
       */
      deliveryGuide(projectId?: string): Promise<DeliveryGuide>;
      /** 只读预览一个产物文件；越出工作区/已删除/二进制都以数据形式说明。 */
      readDeliveryFile(projectId: string, path: string): Promise<DeliveryFileRead>;
      /**
       * 当前保活的 dev server（探活 + 页面冒烟通过后由主进程持有）。
       * 没有预览时返回 null；进程退出后仍保留现场直到用户停止/下次接管。
       */
      previewStatus(): Promise<PreviewState | null>;
      /** 在系统浏览器打开当前预览；只允许管理器里的本机 HTTP(S) 地址。 */
      previewOpen(): Promise<{ ok: true } | { ok: false; reason: string }>;
      /** 停止并清除当前预览；没有预览时返回 false。 */
      previewStop(): Promise<boolean>;
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
      /**
       * 发一句话进交互式会话；立刻返回 sessionId（过程走 onEvent 推）。
       * 需要 projectId：会话的工具边界就是那个项目的工作区。
       */
      sendChat(input: { text: string; projectId: string }): Promise<{ sessionId: string; accepted: true }>;
      abortChat(): Promise<boolean>;
      newChat(input: { projectId: string }): Promise<{ sessionId: string }>;
      chatTranscript(): Promise<ChatTranscript | null>;
      /** 有活会话返回它，否则恢复当前项目最近一条；没有记录返回 null。 */
      chatLatest(input: { projectId: string }): Promise<ChatTranscript | null>;
      listChatSessions(input: { projectId: string }): Promise<ChatSessionSummary[]>;
      loadChatSession(input: { sessionId: string }): Promise<ChatTranscript | null>;
      resumeChat(input: { projectId: string; sessionId: string }): Promise<ChatTranscript>;
      forkChat(input: { projectId: string; sessionId: string }): Promise<ChatTranscript>;
      deleteChat(input: { sessionId: string }): Promise<boolean>;
      revertChat(input: { projectId: string; sessionId: string; turn: number; path?: string }): Promise<ChatRevertResult>;
      resolveChatApproval(
        requestId: string,
        answer: { granted: boolean; scope?: "once" | "session"; reason?: string },
      ): Promise<boolean>;
      onEvent(handler: (payload: unknown) => void): () => void;
    };
  }
}
