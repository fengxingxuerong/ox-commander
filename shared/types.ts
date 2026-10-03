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
  /**
   * dev server 托管检查（竞品清单 5.4，学 Vibe Kanban）：存在时本检查是
   * **驻留进程** —— spawn 后不等退出，轮询 HTTP 探活，2xx 即通过；无论探活
   * 结果如何，进程树都会在检查结束时被杀掉（不留给后续批次）。
   *
   * 与普通 smoke 互斥：`stdin` / `expectContains` 在本模式下被忽略（判定只看
   * HTTP 状态码 —— R1：探活判据独立于被判定方，dev server 无法通过往 stdout
   * 写字让自己的判定变绿；它只能真的把端口服务起来）。
   */
  devServer?: {
    /** 探活完整 URL（如 `http://127.0.0.1:5173/`）。 */
    url: string;
    /** 探活超时（默认 30s），从进程 spawn 起算。 */
    timeoutMs?: number;
  };
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
    /**
     * 环境裁决类别（P2-3 失败类别细分）：失败不是代码造成的，而是沙箱/审批
     * **拒绝执行**造成的。重修循环读它来区分"验证失败（改代码有用）"与
     * "环境裁决（改代码无用，要动的是 policy.d 或人的决定）"。
     * 字段即承诺：没有这个键 = 一次真实的命令失败。
     */
    errorClass?: "sandbox-denied" | "escalation-denied" | "approval-denied";
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
   * 任务级冗余赛马（默认 1 = 关闭）。>1 时每个任务并行派给 N 个不同执行器，
   * 第一个到终态成功者赢、其余中止 —— 拿 token 换时间，产物正确性仍由批次后
   * 的统一硬门禁把关。
   */
  raceRedundancy: number;
  /**
   * Providers whose routes share one failover table, in preference order.
   * SenseNova contributes 3 keys × 4 models = 12 routes; AMD adds one more.
   * Empty ⇒ fall back to the single `llmProvider`.
   */
  llmPool: string[];
  /**
   * 停用的密钥变量名（账号级开关，P1-2 的"热切换"）。
   *
   * 一条线路 = provider × key × model，所以**摘掉一个 key 就是摘掉它名下的整组
   * 线路** —— 这就是"不用删密钥也能让某个账号下线"的那一层。留在这里而不是
   * 删掉密钥值，是因为密钥还在盘上（随时能开回来），而池子的形状会立刻变小。
   * 空数组 / 缺省 = 全部启用。
   */
  disabledKeyVars?: string[];
  /**
   * 本次运行的 token 预算软上限（大脑层 + 内置执行器共用一道闸）。
   * 达到上限后下一次 LLM 调用在发出前被拒（`BudgetExceededError`）；
   * 单次调用本身可以穿透上限，但会如实记录。`undefined` / `0` 表示不限 ——
   * 想禁用调用应走能力路由，而不是把预算设为 0。
   */
  maxTokensPerRun?: number;
  /**
   * 本次 run 的墙钟上限（毫秒）。只在批/轮边界生效，不掐断在途请求 ——
   * 那两件事分别归 agent 的 runDeadline 与单次 HTTP 超时管。
   * `undefined` 或 `<= 0` 都是不限（要"不限"就省略这个字段，与 maxTokensPerRun 同风格）。
   */
  runWallClockMs?: number;
  /**
   * 大脑层（PRD / 任务分解）单次 LLM 调用的超时（毫秒）。
   *
   * 省略则用内置默认（`BRAIN_POOL_TIMEOUT_MS`，300s）。那个默认值是从"拥塞窗口下
   * 够用"总结出来的经验值，而不同供应商/模型的首字延迟差得远 —— 真被掐断时，
   * 此前只能改代码重新打包，所以这里开出口子。
   *
   * `undefined` 或 `<= 0` 都表示**用内置默认**（与 `runWallClockMs` 同风格：
   * 要默认值就省略字段，不要填 0 之类的哨兵值 —— 0 毫秒的超时没有任何意义）。
   *
   * 注意它管的是**单次 HTTP 调用**，与 `runWallClockMs`（整轮墙钟）、
   * `maxTokensPerRun`（预算）是三件不同的事。
   */
  brainTimeoutMs?: number;

  /**
   * 内置执行器（SenseNova API）**单次 HTTP 调用**的超时（毫秒）。
   *
   * 省略则用内置默认（`EXECUTOR_TIMEOUT_MS`，300s）。与 `brainTimeoutMs` 是同一类
   * 出口子，针对的是同一段代码里的另一个常量：大脑层管 PRD/分解，这里管**执行器生成代码**
   * 那一路 —— 两边供应商相同、拥塞表现相同，所以痛点也相同（被掐断只能改代码重打包）。
   *
   * `undefined` 或 `<= 0` 都表示**用内置默认**（同 `brainTimeoutMs` 的语义）。
   *
   * ⚠️ 不要和 `limits.runDeadlineMs`（整轮 run 的上界）混淆：这个字段掐的是
   * **一次请求**，超时后线路轮换接着试下一条；run 时限到点则是收口并保留现场。
   */
  executorTimeoutMs?: number;

  /**
   * 快照备份根（桌面端；headless 走 spec 同名字段）。中断批次的越权写入备份
   * 与回滚材料落在这里。省略或空串 = 内置默认（userData/snapshots）。
   *
   * 改这里**不会迁移**已有备份 —— 旧根目录里的东西留在原地；空串与省略同义
   * （`||` 回退），想回到默认就清空输入框。
   */
  snapshotRoot?: string;

  /**
   * agents.d 声明式清单目录（桌面端；headless 走 spec 同名字段）。运行时注册
   * 的智能体 manifest 写在这里，重启后从这里恢复。省略或空串 = 内置默认
   * （userData/agents.d）。
   */
  manifestDir?: string;

  /**
   * 重修轮耗尽时的升级处置。`"ask"`（默认）= 弹窗等人决定，是桌面端独有的
   * 第五种语义；其余四个值与 headless 协议的 escalationPolicy **完全同义**
   * （`headless/protocol.ts` 的 `EscalationPolicy`），给无人值守场景用：
   *
   * - `abort`：自动终止运行（等价于人在弹窗里点了"终止"）；
   * - `skip`：跳过失败任务继续（下游可能连带失败，引擎会说明）；
   * - `redispatch_once`：每任务自动重派一次，再次升级自动终止 —— 与 CLI 的
   *   账本语义一致，账本挂在单次 platform 上（每次 run 重建，天然 per-run）；
   * - `exhaust`：决策回调整个缺席，引擎把"重修预算耗尽"报成结构化错误
   *   （与 CLI 的 exit 2 同义），而不是永远等一个不会来的人。
   */
  escalationPolicy?: "ask" | "abort" | "skip" | "redispatch_once" | "exhaust";
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
  raceRedundancy: 1,
  llmPool: ["sensenova", "amd-radeon"],
  disabledKeyVars: [],
};
