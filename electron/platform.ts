/**
 * Single assembly point for a running platform: agent pool + scheduler + engine.
 *
 * Before this module existed, `electron/ipc.ts` and `headless/run-spec.ts` each
 * built their own engine from their own copy of the wiring. That is how the two
 * drifted: the desktop entry had no `journal` (no checkpoint/resume), no verdict
 * sink (zone rollback invisible in the UI), no LLM timeout override, and passed
 * a legacy `ZoneGuard` third argument that `BatchGuard` always shadowed (that
 * argument has since been removed from `Scheduler`).
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
import { ActionGate } from "./sandbox/action-gate";
import { buildLlmClient, buildLlmPool } from "../shared/build-llm";
import { EXECUTOR_TIMEOUT_MS, type LineHealth } from "../shared/http-clients";
import type { LlmClient } from "../shared/llm-client";
import { budgetBlindNote, formatUsageLine, meteredLlm, UsageMeter, type UsageSnapshot } from "../shared/usage-meter";
import { formatReceiptLine, pairConflict, type ReceiptConflict } from "../shared/delivery-receipt";
import {
  commandPolicyOverrides,
  describePolicy,
  approvalGateOf,
  effectiveTokenBudget,
  pathPolicyOverrides,
} from "../shared/policy-file";
import { loadPolicyDir } from "./sandbox/policy-dir";
import { CommandPolicy } from "./sandbox/command-policy";
import { ApprovalGate } from "./sandbox/approval-gate";
import { DEFAULT_FORBIDDEN_WRITE } from "./sandbox/path-policy";
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

/**
 * 大脑层单次调用的超时取哪个值。
 *
 * 抽成函数而不是内联，是因为"省略 / 0 / 负数 / 正常值"四种输入的归属容易写错：
 * 0 毫秒的超时没有任何意义，把它当成"不限"或当成 0 都是错的 —— 它只能表示
 * "用内置默认"，与 `runWallClockMs`（0 = 不限）**不是**同一套语义。
 */
export function brainTimeoutMsFor(settings: Pick<ProjectSettings, "brainTimeoutMs">): number {
  const v = settings.brainTimeoutMs;
  return v !== undefined && v > 0 ? v : BRAIN_POOL_TIMEOUT_MS;
}

/**
 * 内置执行器单次调用的超时取哪个值（语义与 `brainTimeoutMsFor` 完全同构：
 * 省略 / 0 / 负数都归"用内置默认"，只有正数算用户设置）。
 *
 * 默认值写成常量引用而不是再抄一个 300_000，避免两处默认值各自漂移。
 */
export function executorTimeoutMsFor(settings: Pick<ProjectSettings, "executorTimeoutMs">): number {
  const v = settings.executorTimeoutMs;
  return v !== undefined && v > 0 ? v : EXECUTOR_TIMEOUT_MS;
}

/** What the platform needs to know about its host. */
export interface PlatformHost {
  /** Board log / protocol event sink. */
  log(text: string): void;
  /** Audit sink for run attribution. Omit when the host streams instead.
   * `title` is board-recovery context: the engine passes the full Task, but
   * hosts before the facts/derived split only ever needed id/zone. */
  onRunStart?(agentId: string, task: { id: string; zone: string; title?: string }): void;
  onRunComplete?(outcome: DispatchOutcome, task: { id: string; zone: string; title?: string }): void;
  /** Zone-violation verdict sink (rollback / isolation / report-only outcomes). */
  onVerdict?(verdict: BatchVerdict): void;
  /** Escalation decision; omit to keep the engine's fail-fast/typed-error path. */
  requestEscalationDecision?(taskId: string, summary: string): Promise<EscalationAction>;
  /**
   * 线路健康的事实出口（P1-2）：哪条线路在冷却、还剩多久、被限流了几次。
   * 由 `buildLlm()` 建的故障转移客户端在构造时与每次失败/恢复时推送；
   * 桌面推给渲染进程、headless 可发协议事件。**不注入 layer 的那条路径
   * 不会有任何线路** —— 那是事实（池里没有线路），不是缺陷。
   */
  onLineHealth?(lines: LineHealth[]): void;
  /**
   * 审批回调（P2-3）：`policy.d` 的 `approvalCommands` 里的命令执行前问一次。
   *
   * 返回 true 放行、false 拒绝。**缺席时按拒绝处理**（fail-closed）——
   * 无人可问的场景下"停下来"的唯一安全实现是不执行，与 `EscalationPolicy`
   * 的 `exhaust` 同构，而不是假装问过了。
   *
   * 只有策略里真的配了 `approvalCommands` 才会被调用；没配时这个回调整个不被使用。
   */
  requestApproval?(command: string, args: readonly string[]): Promise<boolean>;
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
  /**
   * 策略即代码的目录（`policy.d/`）。省略 = 只用内置规则。
   *
   * 与 `manifestDir` 同构但方向相反：manifest 描述"谁来做"（越具体越好），
   * policy 描述"做到哪为止"（只增不减 —— 契约里没有"允许"这一格）。
   */
  policyDir?: string;
  /** Enable capability routing; defaults to `settings.agentRouter !== false`. */
  enableRouter?: boolean;
  arbitration?: ArbitrationMode;
  /** Concurrency ceiling; overrides `settings.maxParallelRuns` when set. */
  maxParallelRuns?: number;
  /** Explicit provider pool; falls back to `settings.llmPool`. */
  llmPool?: readonly string[];
  /**
   * Host-side key seeding, applied before any brain client is built. The
   * desktop keeps provider keys encrypted in its own store and only that store
   * knows how to read them back, so the seeder has to reach the engine's own
   * client too — not just the ones a caller asks for later.
   */
  seedKeys?: (envVars: Set<string>) => void;
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
  /** 自带用量汇总器（测试观察点，或宿主想复用同一个计数器）。 */
  meter?: UsageMeter;
}

export interface Platform {
  engine: OrchestratorEngine;
  layer: AgentLayer;
  /**
   * Builds the brain client. `seedKeys` lets the Electron host top up provider
   * env vars from its encrypted key store first; omit it and `config.seedKeys`
   * applies (headless has no key store and passes neither).
   */
  buildLlm(seedKeys?: (envVars: Set<string>) => void): LlmClient;
  /** Scheduler options shared by both hosts (exposed for parity assertions). */
  schedulerOptions(): NonNullable<ConstructorParameters<typeof Scheduler>[2]>;
  /**
   * 本次平台生命周期内的 token 用量快照（大脑层 + 内置执行器）。
   *
   * 只在**本进程**有效：外部 CLI / HTTP 桥接智能体跑在别的进程里，
   * 它们的用量不在这里。`calls - measuredCalls` 是服务商没在响应里
   * 上报用量的次数 —— 那个差值就是这份数字的可信边界。
   */
  usage(): UsageSnapshot;
  /** 最近一份线路健康事实（池里每条线路的冷却与限流账）。空数组 = 没有线路。 */
  lineHealth(): LineHealth[];
}

/**
 * Assembles the agent pool and engine from one config object. Hosts differ only
 * in the callbacks they pass and whether they supply a journal — the structural
 * wiring (router, breaker, guard, scheduler limits, LLM grade) is identical.
 */
export function createPlatform(config: PlatformConfig): Platform {
  const { settings, host } = config;
  const log = host.log;

  /**
   * 策略即代码（`policy.d/`）。
   *
   * 加载一次、合成一份、只往严的方向叠（契约里没有"允许某条命令"这一格 ——
   * 见 `commandPolicyOverrides`）。坏文件不拦 run，但**每条问题都说出来**：
   * 静默跳过会让"我以为禁掉了"变成假的，而那正是安全策略最坏的失败方式。
   *
   * ⚠️ 位置在 `meter` / `layer` **之前**是承重的：预算面（`maxTokensPerRun`）
   * 要参与 `UsageMeter` 的构造，而 meter 是所有 LLM 客户端的共用上游。
   * 策略加载本身不依赖它们（只读磁盘上的 JSON），所以可以安全前置。
   */
  const loaded = loadPolicyDir(config.policyDir);
  const policy = loaded.files > 0 ? loaded.policy : undefined;
  for (const err of loaded.errors) log(`[policy] ${err.file}：${err.issues.join("；")}`);
  if (policy) log(`[policy] 已加载 ${loaded.files} 份策略：${describePolicy(policy)}`);

  /**
   * 预算面：策略与设置取**更小**者。
   *
   * 此前 `policy.d` 的 `maxTokensPerRun` 只被解析、合并、并被 `describePolicy`
   * 念出来，**没有任何消费者** —— 日志说"token 上限 N"，实际闸门读的是
   * `settings.maxTokensPerRun`，写进策略的预算不生效。这里接上。
   *
   * 取更小值的理由：两者都是"上限"，并存时以严的为准；否则一份更宽的设置值
   * 会静默架空策略里那条更严的规则。
   */
  const tokenBudget = effectiveTokenBudget(policy?.maxTokensPerRun, settings.maxTokensPerRun);
  if (policy?.maxTokensPerRun !== undefined) {
    log(
      `[policy] token 上限：策略 ${policy.maxTokensPerRun}` +
        (settings.maxTokensPerRun !== undefined ? ` / 设置 ${settings.maxTokensPerRun}` : "") +
        ` ⇒ 生效 ${tokenBudget}`,
    );
  }

  /**
   * 路径面（P2-2）：策略的 `forbidWrite` 与内置地板取**并集**。
   *
   * 必须在这里算好再传，不能把 `policy.forbidWrite` 直接交给 `PathPolicy` ——
   * 后者的 `forbiddenWrite` 是**替换**语义（源码注释 "Overrides ... when provided"），
   * 直接透传等于让一份 JSON 拆掉沙箱地板（`package.json` / `.env` / `.git/**` …）。
   * 见 `pathPolicyOverrides` 的注释。
   */
  const pathOverrides = policy ? pathPolicyOverrides(policy, DEFAULT_FORBIDDEN_WRITE) : undefined;
  if (pathOverrides) {
    log(`[policy] 禁止写入清单已扩展：${policy!.forbidWrite!.join("、")}（与内置地板取并集，共 ${pathOverrides.forbiddenWrite.length} 条）`);
  }

  // 用量汇总：大脑层在 `buildLlm` 里包一层、执行器在 `createAgentLayer` 里包一层
  // （它是 token 大头，且不走大脑层工厂）。两处都指向同一个 meter，所以
  // `usage()` 拿到的是这次平台生命周期的总和。
  // 预算上限从 settings 与 policy.d 的**更小者**流入；
  // `config.meter` 显式传入时（测试 / 宿主自建）尊重传入值，不再二次包配置。
  const meter =
    config.meter ??
    new UsageMeter(
      tokenBudget !== undefined
        ? {
            maxTokensPerRun: tokenBudget,
            // 第一跳没上报用量就说，而不是等 run 结束才对着一行"总量 0"困惑。
            onBudgetBlind: (info) => log(`[budget] ${budgetBlindNote(info)}`),
          }
        : undefined,
    );

  const layer =
    config.layer ??
    createAgentLayer({
      enableRouter: config.enableRouter ?? settings.agentRouter !== false,
      manifests: config.manifests,
      manifestDir: config.manifestDir,
      promptDir: config.promptDir,
      snapshotRoot: config.snapshotRoot,
      arbitration: config.arbitration ?? settings.arbitration,
      // 内置执行器那一路的超时；注入 `layer` 的调用方不受影响（那种情况由注入方负责）。
      executorTimeoutMs: executorTimeoutMsFor(settings),
      // 路径面（P2-2）：策略的 forbidWrite 与内置地板取**并集**后交给 PathPolicy。
      // 省略 = 内置默认（调用方不该传空数组 —— 那是"已提供"，会清空地板）。
      ...(pathOverrides ? { forbiddenWrite: pathOverrides.forbiddenWrite } : {}),
      meter,
      onRouting: (decision, task) => log(agentRoutingLogLine(decision, task)),
      onEvent: (text) => log(`[sandbox] ${text}`),
      breakerOptions: { onEvent: (text) => log(`[breaker] ${text}`) },
    });

  /**
   * 本次平台生命周期里累积的越权条目。
   *
   * 引擎看不到仲裁（guard 挂在长期存活的 layer 上，比一次 `execute` 活得久），
   * 所以在这里顺手攒一份，交付凭据取它回答"这轮到底有没有越权、怎么处置的"。
   * 累积**不去重**：两次越权同一路径是两次事件，凭据要能看出它反复发生。
   */
  const verdictConflicts: ReceiptConflict[] = [];
  // Attached after construction so an injected layer reports verdicts exactly
  // like a self-built one (tests inject a layer; the sink must still fire).
  // 挂载条件从"宿主接了 onVerdict"放宽成"有 guard"：凭据需要这份记录，
  // 而宿主是否关心事件流是另一回事（转发处按可选调用处理）。
  if (layer.schedulerOptions.guard) {
    const sink = host.onVerdict;
    layer.schedulerOptions.guard.setVerdictSink((verdict) => {
      for (const conflict of verdict.conflicts) {
        verdictConflicts.push(pairConflict(conflict, verdict.remedies));
      }
      sink?.(verdict);
    });
  }

  const schedulerOptions = (): NonNullable<ConstructorParameters<typeof Scheduler>[2]> => ({
    ...layer.schedulerOptions,
    maxParallelRuns: config.maxParallelRuns ?? settings.maxParallelRuns,
    onRunStart: host.onRunStart,
    onRunComplete: host.onRunComplete,
    // 任务级冗余赛马（§5.3）：默认 1 = 关闭；>1 时同任务并行派 N 个执行器。
    raceRedundancy: settings.raceRedundancy,
    // One gate per platform (= per project): the scheduler feeds it every
    // agent log line, the engine resets it at batch boundaries, the verifier
    // queries it before spawning. All three hold the same instance.
    actionGate: gate,
  });

  /**
   * Brain client builder. Seeding first matters: the pool reads provider keys
   * from `process.env`, and the Electron host keeps them encrypted on disk.
   * A per-call seeder overrides `config.seedKeys`; when the caller passes
   * nothing (the engine below does exactly that) the config seeder still runs,
   * otherwise the key store would only be reachable from one-shot clients.
   */
  // 线路健康：故障转移客户端建好就推一份（池里有什么），之后每次失败/恢复再推。
  // 存一份最新的，`lineHealth()` 让宿主也能主动拉（headless 与测试用）。
  let latestLines: LineHealth[] = [];
  const onHealth = (lines: LineHealth[]): void => {
    latestLines = lines;
    host.onLineHealth?.(lines);
  };
  const buildLlm = (seedKeys?: (envVars: Set<string>) => void): LlmClient => {
    if (config.llm) return meteredLlm(config.llm, meter);
    // The host's seeder mutates `process.env` (it owns the key store); the set
    // it receives is just the list of vars worth resolving.
    const seed = seedKeys ?? config.seedKeys;
    if (seed) seed(new Set<string>());
    const pool = config.llmPool ?? settings.llmPool ?? [];
    return pool.length > 0
      ? buildLlmPool({
          providers: pool,
          // 账号热切换（P1-2）：停用的密钥不进池 —— 密钥仍在盘上，随时能开回来。
          disabledKeyVars: settings.disabledKeyVars,
          timeoutMs: brainTimeoutMsFor(settings),
          onEvent: log,
          meter,
          onHealth,
        })
      : buildLlmClient(settings.llmProvider, {
          timeoutMs: brainTimeoutMsFor(settings),
          onEvent: log,
          meter,
          onHealth,
        });
  };

  const callbacks: OrchestratorCallbacks = {
    onStage: (stage) => log(`── 阶段：${stage} ──`),
    onLog: (text) => log(text),
    onTaskStatus: (taskId, status, attempts) => log(`[task] ${taskId} → ${status}（第 ${attempts} 次）`),
    onVerification: () => undefined,
    onEscalation: () => undefined,
    // 默认落一行日志；宿主（headless）覆盖它改成发协议事件。
    onUsage: (snapshot) => log(formatUsageLine(snapshot)),
    // 同 onUsage：默认只落一行，headless 覆盖成 `receipt` 协议事件。
    // 桌面端走 IPC 的 send（见 electron/ipc/context.ts）。
    onReceipt: (receipt) => log(formatReceiptLine(receipt)),
    requestEscalationDecision: host.requestEscalationDecision,
    ...(host.callbacks ?? {}),
  };

  // Cross-action state machine (§5.1): scoped to this platform instance, so
  // concurrent projects never share observations.
  const gate = new ActionGate();

  const buildPolicy = (): CommandPolicy =>
    new CommandPolicy({ ...commandPolicyOverrides(policy!) });

  /**
   * 审批门（P2-3）：只有策略里真的写了 `approvalCommands` 才建实例 ——
   * 没配时传 undefined，验证链上零影响（默认路径不该多出人工环节）。
   *
   * 宿主回调缺席时，门本身按拒绝处理（fail-closed，见 approval-gate.ts 头注释）。
   */
  const approvalSpec = policy ? approvalGateOf(policy) : undefined;
  const buildApprovalGate = (): ApprovalGate | undefined =>
    approvalSpec
      ? new ApprovalGate({
          commands: approvalSpec.commands,
          ...(host.requestApproval ? { request: host.requestApproval } : {}),
          onEvent: (text) => log(text),
        })
      : undefined;
  if (approvalSpec) {
    log(
      `[policy] 审批门已启用：${approvalSpec.commands.join("、")}` +
        (host.requestApproval ? "" : "（⚠️ 宿主未接审批回调 ⇒ 这些命令会被拒绝执行）"),
    );
  }
  // 一个平台一个实例：批次边界由引擎 reset（与 ActionGate 同一个生命单位）。
  const approvalGate = buildApprovalGate();

  const engine = new OrchestratorEngine(
    {
      llm: buildLlm(),
      scheduler: new Scheduler(layer.adapters, settings.enabledAgents, schedulerOptions()),
      verify:
        config.verify ??
        ((cwd: string) =>
          verifyProject(settings.verificationCommands, {
            cwd: () => cwd,
            onEvent: log,
            actionGate: gate,
            // 策略即代码（`policy.d/`）：内置地板之上再叠加一层本地规则。
            // 验证跑的是**智能体刚写下的脚本**，这里是最该被策略管住的地方。
            ...(policy ? { policy: buildPolicy() } : {}),
            ...(approvalGate ? { approvalGate } : {}),
          })),
      settings,
      usage: () => meter.snapshot(),
      conflicts: () => verdictConflicts,
      journal: config.journal,
      actionGate: gate,
      // 审批门与 actionGate 同一生命单位：批次边界一起 reset（"本批次已批准"不该跨批）。
      ...(approvalGate ? { approvalGate } : {}),
    },
    callbacks,
  );

  return {
    engine,
    layer,
    schedulerOptions,
    buildLlm,
    usage: () => meter.snapshot(),
    lineHealth: () => latestLines,
  };
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
