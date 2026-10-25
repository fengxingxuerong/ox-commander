/**
 * Shared mutable state for the main-process IPC layer, plus the factories that
 * build the long-lived singletons (stores, agent pool, audit log, engine).
 *
 * This module exists so the per-domain handler files under `electron/ipc/` can
 * share state without importing each other. Only this file may hold `let`
 * bindings for that state; the handler modules are stateless registrars.
 */
import { app, Notification, safeStorage, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { OrchestratorEngine, type OrchestratorCallbacks, type RunSnapshot } from "../engine";
import { agentRoutingLogLine, createAgentLayer, type AgentLayer } from "../agents";
import { AuditLog } from "../audit-log";
import { taskTrail, trailBriefForRepair } from "../board-derive";
import { brainTimeoutMsFor, createPlatform, executorTimeoutMsFor, type Platform } from "../platform";
import { desktopNotificationOf, type NotifyEventShape } from "../notify-rules";
import { focusedChatSession } from "../chat/focus";
import { writeFileAtomic } from "../atomic-file";
import { ProjectStore, SettingsStore } from "../store";
import { KeysStore, createSafeStorageCrypto } from "../keys-store";
import { getProvider, providerKeyEnvVars } from "../../shared/providers";
import { buildLlmClient } from "../../shared/build-llm";
import { redactSecrets } from "../../shared/redact";
import type { AgentAdapter } from "../../shared/types";
import type { AgentManifest } from "../../shared/agent-contract";
import type { LlmClient } from "../../shared/llm-client";
import { DEFAULT_ESCALATION_POLICY, type EscalationAction, type ProjectSettings } from "../../shared/types";
import { pairConflict } from "../../shared/delivery-receipt";

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
/** Pending approval requests (P2-3): requestId -> granted resolver. */
const pendingApprovals = new Map<string, (granted: boolean) => void>();
let approvalSeq = 0;

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
  // 桌面通知（C1）：渲染层推送回答"看板上有什么"，通知回答"该回工位了" ——
  // 长 run 在后台跑、窗口被切走时，后一条是操作者唯一还能收到的信号。
  // 判据是纯函数（notify-rules.ts），弹不弹只挑三类卡住/错过的事件；
  // 平台不支持（isSupported false）就安静降级，不抛。
  const note = desktopNotificationOf(payload as NotifyEventShape, {
    focusedChatSession: focusedChatSession(),
  });
  if (note && Notification.isSupported()) {
    new Notification({ title: note.title, body: note.body }).show();
  }
}

export function logLine(text: string): void {
  // 实时日志流也要过脱敏（2026-10-13）：logDigest / receipt / audit detail 三处
  // 已过闸，唯独这条直发渲染层的通道漏了 —— agent/沙箱/熔断的报错文本若回显
  // token，会原样出现在看板上且可复制。与其它三处用同一把梳子。
  send({ type: "log", text: redactSecrets(text) });
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

/** 审批答复（P2-3）：requestId -> granted。不存在时返回 false（IPC 层报错）。 */
export function resolveApproval(requestId: string, granted: boolean): boolean {
  const resolve = pendingApprovals.get(requestId);
  if (!resolve) return false;
  pendingApprovals.delete(requestId);
  resolve(granted);
  return true;
}

/**
 * 取消/关窗时把还挂着的审批全部按拒绝收尾（fail-closed 最后一环）：
 * 无人再能回答的审批不能永远挂住 run。
 */
export function abortAllApprovals(): void {
  for (const resolve of pendingApprovals.values()) resolve(false);
  pendingApprovals.clear();
}

export function dynamicAgentMap(): Map<string, { adapter: AgentAdapter; manifest: AgentManifest }> {
  return dynamicAgents;
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
  // ⚠️ 执行器超时必须进 signature：这个 layer 是**缓存的单例**，而适配器在构造时
  // 就把 `timeoutMs` 存成了字段（`client()` 之后不再读 settings）。大脑层不需要进
  // —— 它在 `buildLlm` 里每次都现读。改了设置却不重建 layer，改的就是个摆设。
  // manifestDir / snapshotRoot 同理（P1-5）：SnapshotStore 与清单加载器也在构造时
  // 把根目录存成字段，两个路径因此都进 signature —— 设置页改了必须真的生效。
  const executorTimeoutMs = executorTimeoutMsFor(settingsValue);
  const manifestDir = settingsValue.manifestDir || agentDir();
  const snapshotRootDir = settingsValue.snapshotRoot || snapshotRoot();
  const signature =
    `router=${settingsValue.agentRouter !== false};arbitration=${settingsValue.arbitration}` +
    `;executorTimeoutMs=${executorTimeoutMs};manifestDir=${manifestDir};snapshotRoot=${snapshotRootDir}`;
  if (agentLayer && layerSignature === signature) return agentLayer;
  const layer = createAgentLayer({
    enableRouter: settingsValue.agentRouter !== false,
    manifestDir,
    promptDir: promptDir(),
    snapshotRoot: snapshotRootDir,
    arbitration: settingsValue.arbitration,
    executorTimeoutMs,
    onRouting: (decision, task) => logLine(agentRoutingLogLine(decision, task)),
    onEvent: (text) => logLine(`[sandbox] ${text}`),
    breakerOptions: { onEvent: (text) => logLine(`[breaker] ${text}`) },
    // 成功率总账跨 run 保留（2026-10-11 竞品吸收，ruflo「自适应记忆」对位）：
    // 路由的质量分从此不随进程重启清零。路径在 userData 下，与快照/审计同域。
    breakerStatsFile: path.join(app.getPath("userData"), "agent-stats.json"),
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
    /**
     * Which project this platform runs for. Written into the audit trail so
     * board recovery can attribute run facts per project (older records
     * without it are treated as unattributed history by the derive layer).
     */
    projectId?: string;
  },
): Platform {
  const auditLog = ensureAudit();
  const auditProject = overrides.projectId
    ? { projectId: overrides.projectId }
    : {};
  // P1-5：两个根路径可由设置覆盖（空串/省略 = 内置默认）。引擎/快照仓每次 run
  // 都在这里重建，所以改动对下一次运行即时生效，无需重启。
  const manifestDir = settingsValue.manifestDir || agentDir();
  const snapshotRootDir = settingsValue.snapshotRoot || snapshotRoot();
  // 升级决策策略（P1-5）：`ask`（默认）= 弹窗等人；其余四种与 headless 协议同义。
  // redispatch 的"每任务一次"账本挂在本次 platform 上 —— buildEngine 每次 run
  // 重建 platform，账本天然 per-run，不会跨运行累积。
  const escalation = settingsValue.escalationPolicy ?? DEFAULT_ESCALATION_POLICY;
  const autoRedispatched = new Set<string>();
  return createPlatform({
    settings: settingsValue,
    promptDir: promptDir(),
    snapshotRoot: snapshotRootDir,
    manifestDir,
    enableRouter: settingsValue.agentRouter !== false,
    arbitration: settingsValue.arbitration,
    maxParallelRuns: settingsValue.maxParallelRuns,
    // 策略即代码：全局目录 + 项目 `.ox/policy.d`。两者都只加严；此前桌面
    // 装配根本没传 policyDir，导致文档里的 policy.d 在生产中是一条死线。
    policyDirs: [
      path.join(app.getPath("userData"), "policy.d"),
      ...(overrides.projectId ? [path.join(workspaceRoot(overrides.projectId), ".ox", "policy.d")] : []),
    ],
    // The pool is a singleton so runtime registration survives engine rebuilds.
    layer: ensureAgentLayer(settingsValue),
    // Every brain client this platform builds seeds from the key store, the
    // engine's own included: `createPlatform()` constructs it with a no-argument
    // `buildLlm()`, so a seeder passed only by the one-shot caller below would
    // leave real runs reading an unseeded `process.env`.
    seedKeys: (envVars) => seedKeysFromStore(settingsValue, envVars),
    journal: overrides.journal,
    // 前任履历（P1-3 上下文回溯闭环）：审计日志归这里所有，引擎读不到，
    // 所以由宿主把「履历 → 给下一个执行器看的文本」这一步做掉再喂进去。
    // 摘要规则在纯函数 `trailBriefForRepair` 里，这里只提供事实。
    priorAttempts: (taskId) => trailBriefForRepair(taskTrail(auditLog.read({ limit: 5000 }), taskId)),
    host: {
      log: overrides.log,
      callbacks: overrides.callbacks,
      // 审批（P2-3）：命令命中 approvalCommands 时发事件给渲染进程，park 到
      // 渲染端回答（orchestration:approval-decide）。渲染端不在（窗口关了）
      // 时 promise 挂着 —— cancel 会走 abortAllApprovals 按拒绝收尾。
      requestApproval: (command: string, args: readonly string[]): Promise<boolean> => {
        const requestId = `a-${(approvalSeq += 1)}-${Date.now().toString(36)}`;
        send({ type: "approval-request", requestId, command, args });
        return new Promise<boolean>((resolve) => {
          pendingApprovals.set(requestId, resolve);
        });
      },
      // P5 observability: every run start/end is attributed and persisted, so
      // "which agent did what" survives a reload. The title/projectId extras
      // are board-recovery facts: the derive layer rebuilds the task view from
      // run-start/run-end pairs alone.
      onRunStart: (agentId, task) => {
        auditLog.append({
          phase: "run-start",
          ...auditProject,
          // Planned attribution (who the scheduler picked); the actual runner
          // is recorded on run-end and is what the board displays.
          agentId,
          taskId: task.id,
          title: task.title,
          zone: task.zone,
        });
      },
      onRunComplete: (outcome, task) => {
        auditLog.append({
          phase: "run-end",
          ...auditProject,
          taskId: task.id,
          zone: task.zone,
          ok: outcome.ok,
          // 这两处**不能**简化成直接传：契约是「字段缺失时连键都不出现」
          // （`"agentId" in record === false`），由 src/ipc-handlers.test.ts 的
          // "omits optional fields…" 守着 —— 2026-09-28 简化时当场变红。
          ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
          ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
          // Audit JSONL is durable: redact before it hits disk.
          detail: redactSecrets(outcome.logDigest).slice(0, 300),
        });
      },
      // Zone-conflict verdicts must reach the board even though the guard lives
      // inside the long-lived layer, not inside this engine.
      onVerdict: (verdict, scope) => {
        // 批次改动事实（diff 面板的数据源）：每批一条、clean 批也落 ——
        // `batch-guard` phase 只记越权路径，正常批次的改动此前没有任何持久事实。
        // scope 缺席（测试直接调宿主回调 / 无 guard 的装配）就不落：编一条
        // "0 个文件"比什么都不写更假。上限 100 条 + filesTotal：审计是 2MiB
        // 轮转的 JSONL，一批写几百个路径会把别的记录挤出去；说破"截断了"
        // 比静默丢强。
        const changes = scope?.changes ?? [];
        if (scope) {
          auditLog.append({
            phase: "batch-changes",
            ...auditProject,
            changed: changes.length,
            paths: changes.map((c) => c.path),
            files: changes.slice(0, 100).map((c) => ({ path: c.path, op: c.op, bytes: c.bytes })),
            ...(changes.length > 100 ? { filesTotal: changes.length } : {}),
            // 存档 id（B1 第二半）：有它，看板这一批才能 diff 与单文件回滚。
            // 字段即承诺：没有存档时这个键不出现（契约见 audit-log）。
            ...(scope.archiveId ? { archiveId: scope.archiveId } : {}),
          });
        }
        for (const conflict of verdict.conflicts) {
          // 配对规则只有一份实现（`pairConflict`）：事件流报的处置与交付凭据里
          // 报的处置必须是同一个，而两份实现不一致是没有测试能发现的。
          const paired = pairConflict(conflict, verdict.remedies);
          send({ type: "conflict", kind: paired.kind, paths: paired.paths, remedy: paired.remedy });
          // 同一条事实也落审计：事件流是内存的（重载即消失），而"这轮拦下过什么"
          // 是对外对比 zone 路线与 worktree 路线的唯一凭据。
          auditLog.append({
            phase: "batch-guard",
            ok: false,
            errorClass: "conflict",
            conflictKind: paired.kind,
            remedy: paired.remedy,
            changed: paired.paths.length,
            paths: paired.paths,
            // 字段即承诺：没有 run 归属时 detail 这个键也不出现（契约见 audit-log）。
            ...(conflict.runs.length > 0 ? { detail: `runs=${conflict.runs.join(",")}` } : {}),
          });
        }
      },
      // 线路健康：哪条线路在冷却、被限流了几次。走独立事件而不是日志行 ——
      // 界面要的是字段（不是一行给人看的话），而且要能在重载后重新拉一次。
      onLineHealth: (lines) => send({ type: "line-health", lines }),
      // 任务活性心跳：看板据此显示"静默 Xs"，长任务与挂死从此可区分。
      onTaskActivity: (taskId, at) => send({ type: "task-activity", taskId, at }),
      // exhaust 刻意让决策回调整个缺席（字段即承诺）：引擎随后把"重修预算
      // 耗尽"报成结构化错误（与 CLI 的 exit 2 同义），而不是挂在一个永远
      // 不会有人回答的 Promise 上。escalation 事件照发 —— 升级发生过这件事
      // 本身仍要可见，只是没有决策入口。
      ...(escalation !== "exhaust"
        ? {
            requestEscalationDecision: (taskId: string): Promise<EscalationAction> => {
              if (escalation === "skip") return Promise.resolve("skip");
              if (escalation === "abort") return Promise.resolve("abort");
              if (escalation === "redispatch_once") {
                if (!autoRedispatched.has(taskId)) {
                  autoRedispatched.add(taskId);
                  return Promise.resolve("redispatch");
                }
                // 与 CLI 的 redispatch_once 同义：第二次升级自动终止 ——
                // "重派一次"承诺的就是只重派一次，第二次再问没有意义。
                return Promise.resolve("abort");
              }
              // ask（默认）：The escalation event itself is already sent by
              // onEscalation; here we only park the resolver until the
              // renderer answers.
              return new Promise<EscalationAction>((resolve) => {
                pendingEscalations.set(taskId, resolve);
              });
            },
          }
        : {}),
    },
  });
}

/** Brain client for one-shot calls (the settings "test connection" button). */
export function buildLlm(settingsValue: ProjectSettings): LlmClient {
  const platform = buildPlatformLayer(settingsValue, { log: logLine });
  return platform.buildLlm();
}

/**
 * 线程钉死到一条 provider × model 的线路（M3c-2）。
 *
 * 为什么不复用 `buildLlm(settings)`：那条路会按 `settings.llmPool` 组一个故障转移
 * 池，模型由池里的线路决定；线程选了模型之后必须**只有这一条模型**。这里先按
 * 被选 provider 播种密钥（密钥仓只在 Electron 侧），再直接建单线路客户端，且
 * 沿用同一个超时设置 —— 否则选模型会顺带把超时改回大脑层默认值。
 */
export function buildLlmPinned(settingsValue: ProjectSettings, providerId: string, model: string): LlmClient {
  seedKeysFromStore({ ...settingsValue, llmPool: [providerId] }, new Set<string>());
  return buildLlmClient(providerId, { model, timeoutMs: brainTimeoutMsFor(settingsValue), onEvent: logLine });
}

/**
 * 当前正在跑的项目的需求（写 journal 时带上，供下次启动做"需求匹配"）。
 *
 * 为什么要在这一层记：`RunSnapshot` 是引擎的恢复状态，不该为了"这份快照属于谁的需求"
 * 而长出一个它自己并不使用的字段；需求归宿主（项目记录）所有，写的时候顺手抄一份进
 * journal 外壳就够了 —— 与 headless 的 `createFileJournal` 把 `requirement` 写在
 * 文件外壳上（而不是快照里）是同一个设计。
 */
let journalRequirement: string | undefined;

/** 设置本轮 run 的需求（`startProjectRun` 进入时设，收尾时清）。 */
export function setJournalRequirement(requirement: string | undefined): void {
  journalRequirement = requirement;
}

/** Writes a checkpoint journal for one project. Best-effort: never breaks a run. */
export function writeJournal(projectId: string, snapshot: RunSnapshot): void {
  try {
    fs.mkdirSync(journalDir(), { recursive: true });
    // Atomic: a truncated checkpoint is worse than none — resume would read a
    // half-written snapshot and restart the run from a bogus state.
    writeFileAtomic(
      path.join(journalDir(), `${projectId}.json`),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          // 外壳字段（不进快照）：下次启动靠它判"这份进度属于哪份需求"。
          ...(journalRequirement !== undefined ? { requirement: journalRequirement } : {}),
          snapshot,
        },
        null,
        2,
      ),
    );
  } catch {
    // Checkpointing is a best-effort fuse; never break a run over it.
  }
}

/**
 * 读回来的结果：三选一（缺席 / 可续跑 / 坏）。
 *
 * ⚠️ **刻意没有 `mismatched` 这一档**（2026-10-25 自查出来的一处死分支）：headless 的
 * `FileJournalHandle` 有它，是因为那边"读"这个动作自己就拿需求做比对
 * （`createFileJournal` 把 requirement 闭包进去）。桌面的 `readJournal` **不认识需求**
 * —— 需求归项目记录（`stores().get(projectId).requirement`），比对在调用方做。
 * 照抄一个自己永远产生不了的枚举值，等于在调用方留一条**跑不到的分支**：
 * 成对报告的那条"不匹配"日志永远不会出现，读代码的人却以为它在生效。
 */
export type JournalRead =
  | { kind: "resumable"; snapshot: RunSnapshot; requirement?: string }
  | { kind: "absent" }
  | { kind: "corrupted" };

/**
 * 读一次桌面项目的 checkpoint journal（2026-10-25）。
 *
 * **这是本仓库一个存在了很久的缺口**：`writeJournal` 从 2026-09-19 起每批都落盘，
 * 但**从来没被读回过** —— `startProjectRun` 调 `execute` 时只传 `{ smoke }`，
 * `ResumeState` 那个入参在桌面侧永远是 `undefined`。于是长 run 被强杀（或用户关窗）
 * 之后，桌面端**从零开始**：规划重做、已完成的批次重做。headless 有这条通路
 * （`createFileJournal(...).load()`），桌面一直是半截 —— `docs/2026-09-20-fullstack-review.md`
 * 把它记成 B2 待办，此后没人落。
 *
 * 判定口径照抄 headless 那一份（`electron/platform.ts` 的 `createFileJournal`）：
 * 需求必须**逐字相同**才续跑（不同需求续上别人的进度是最坏的一种错），
 * 解析失败按损坏处理。差别只在存储形态：桌面按项目分文件、由宿主写，
 * 所以需求匹配在调用方做（项目记录里就有 requirement），这里只报"有没有快照"。
 */
export function readJournal(projectId: string): JournalRead {
  const file = path.join(journalDir(), `${projectId}.json`);
  if (!fs.existsSync(file)) return { kind: "absent" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      snapshot?: RunSnapshot;
      requirement?: string;
    };
    // `batches` 必须有 —— 没有它的快照恢复不了批次（headless 也是这个判据）。
    if (!Array.isArray(parsed.snapshot?.batches)) return { kind: "corrupted" };
    return {
      kind: "resumable",
      snapshot: parsed.snapshot,
      ...(typeof parsed.requirement === "string" ? { requirement: parsed.requirement } : {}),
    };
  } catch {
    return { kind: "corrupted" };
  }
}

/** 清掉项目的 journal（续跑成功后调用；失败不影响已完成的交付）。 */
export function clearJournal(projectId: string): void {
  try {
    fs.rmSync(path.join(journalDir(), `${projectId}.json`), { force: true });
  } catch {
    // 卫生动作：删不掉只是留个陈旧快照，下一次启动会再判一次。
  }
}
