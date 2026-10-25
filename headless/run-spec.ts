/**
 * 把**宿主可选钩子**铺进 callbacks。
 *
 * 抽出来的理由（2026-10-05，site 逐位点审计）：这两行原先内联在
 * `runSpec` 的对象字面量里，两处三元**都零断言** ——
 * 把"有就给、没有就给 `undefined`"这条变异存活了，
 * 说明没有任何测试能区分这两种写法。
 *
 * 而它们**不是随手写的防御**，各自有独立语义：
 *   · `requestApproval` —— CLI 形态缺席 = **fail-closed 拒绝**。
 *     若改成 `{ requestApproval: undefined }`，引擎侧
 *     `"requestApproval" in callbacks` 会是 `true`，fail-closed 就被绕过了。
 *   · `onTaskActivity` —— 宿主缺席时**不发**（无消费者就不产生事件量）。
 *
 * 与本文件 `onRunComplete` 里的 `...(outcome.agentId ? {agentId} : {})`
 * 是同一条契约：**缺失时连键都不出现**，不能简化成直接传。
 */
export function optionalHostHooks(io: {
  requestApproval?: PlatformHost["requestApproval"];
  onTaskActivity?: PlatformHost["onTaskActivity"];
}): Pick<PlatformHost, "requestApproval" | "onTaskActivity"> {
  return {
    ...(io.requestApproval ? { requestApproval: io.requestApproval } : {}),
    ...(io.onTaskActivity ? { onTaskActivity: io.onTaskActivity } : {}),
  };
}

/** package.json 只用于"怎么启动"这一格；读不到就是没有，不影响交付。 */
function readPackageJson(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, "package.json"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Runs one `ParsedSpec` to completion and reports the exit code.
 *
 * Kept free of process/stdin/stdout so it can be driven by a test with injected
 * fakes (fake LLM, fake agent pool, fake verifier) — the protocol is only
 * trustworthy if its happy path is actually exercised.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { VerificationExhaustedError } from "../electron/engine";
import type { OrchestratorCallbacks, OrchestratorEngine, RunSnapshot } from "../electron/engine";
import type { AgentLayer } from "../electron/agents";
import type { PlatformHost } from "../electron/platform";
import { createFileJournal, createPlatform } from "../electron/platform";
import { getProvider, providerKeyEnvVars } from "../shared/providers";
import { renderIssueRequirement, viewGithubIssue } from "../electron/context/github-readonly";
import type { LlmClient } from "../shared/llm-client";
import type { SmokeCheck, Task, EscalationAction, VerificationReport } from "../shared/types";
import { pairConflict, type DeliveryReceipt } from "../shared/delivery-receipt";
import { deriveDeliveryGuide, type DeliveryArtifactFile } from "../shared/delivery-guide";
import type { HeadlessEvent, ParsedSpec } from "./protocol";

/**
 * 大脑层实际会用的那组 provider → 它要求哪些环境变量里有值。
 *
 * provider 侧必须与 `electron/platform.ts` 的 `buildLlm` 同口径：「池非空用池，
 * 池空才退回 `settings.llmProvider`」。跟着默认池走就会出现"池里明明是免密钥的
 * 本地 provider，却按 SenseNova 要 key"的假拦截。`apiKeyEnvVar` 为空的 provider
 * （本地 Ollama 之类）贡献为空 —— 空数组就是"这一步不拦"。
 *
 * 导出只为让这条口径能被单测直接钉住（不必走一遍真实网络路径）。
 */
export function requiredCredentialVars(spec: ParsedSpec): string[] {
  const ids = spec.llmPool.length > 0 ? spec.llmPool : [spec.settings.llmProvider];
  const out = new Set<string>();
  for (const id of ids) {
    const provider = getProvider(id);
    for (const v of providerKeyEnvVars(id)) out.add(v);
    if (provider?.apiKeyEnvVar) out.add(provider.apiKeyEnvVar);
  }
  return [...out];
}

/** 池内 provider 一个凭证都没有时，返回那些缺的变量名；否则 undefined。 */
export function missingCredentials(spec: ParsedSpec): string[] | undefined {
  const wanted = requiredCredentialVars(spec);
  const present = wanted.filter((v) => (process.env[v] ?? "").trim() !== "");
  return wanted.length > 0 && present.length === 0 ? wanted : undefined;
}

/**
 * 回收中断/崩溃留下的快照备份目录。
 *
 * 为什么不能"退出时删"：Ctrl-C 那一刻，备份恰恰是人工恢复现场的唯一材料，
 * 而续跑会另起一个批号（= 目录名），旧备份既接不上也没人再来清 —— 它就是
 * `userData/snapshots` 只会变大的原因。所以回收放在**启动时**，且两条硬约束：
 *   · 只认 `batch-*` 形状（`Scheduler` 发的批号），别的一律不碰 —— 宿主把
 *     `snapshotRoot` 指到共享目录时也不该丢别人的东西；
 *   · 只删超过保留期的（默认 24h），避免 concurrent run 正在用的目录被误删。
 * 返回删掉的目录数；任何 fs 错误都吞掉（回收是卫生工作，不该让一次 run 因它失败）。
 */
export interface PruneResult {
  removed: number;
  /** 想删但删不掉的（权限、被占用）—— 不吞掉，否则"回收过了"是假的。 */
  failed: string[];
  /** 备份根本不存在（首次运行）时为真：不是错误，但调用方措辞不同。 */
  missingRoot: boolean;
  /**
   * 未到期因而「保留」下来的 batch-* 目录名。它们来自没有结算完的批，
   * 里面可能有从未被仲裁过的越权写入 —— 以前这里既不删也不报，保留看起来像没事。
   */
  kept: string[];
}

export function pruneStaleBackups(
  backupRoot: string,
  opts: { now?: number; maxAgeMs?: number } = {},
): PruneResult {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const out: PruneResult = { removed: 0, failed: [], missingRoot: false, kept: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") out.missingRoot = true;
    // 备份根读不动（权限等）也不炸：回收是卫生工作。
    else out.failed.push(`${backupRoot}: ${(e as Error).message}`);
    return out;
  }
  // 显式排序：`readdirSync` 在 Linux 上是 hash 序、Windows 上是字典序，而 `failed`
  // 是要给宿主比对的结果列表，不能随平台变。
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || !entry.name.startsWith("batch-")) continue;
    const abs = path.join(backupRoot, entry.name);
    try {
      const ageMs = now - fs.statSync(abs).mtimeMs;
      if (ageMs <= maxAge) {
        out.kept.push(entry.name);
        continue;
      }
      fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
      out.removed += 1;
    } catch (e) {
      out.failed.push(`${entry.name}: ${(e as Error).message}`);
    }
  }
  return out;
}

export interface RunSpecIo {
  emit: (evt: HeadlessEvent) => void;
  /** Override the brain-layer client (tests, custom routers). */
  llm?: LlmClient;
  /** Override the agent pool wiring (tests). */
  layer?: AgentLayer;
  /** Override verification (tests). */
  verify?: (cwd: string) => Promise<VerificationReport>;
  /**
   * Override the contract-path probe (tests). Default really hits the filesystem —
   * headless must not silently skip the check that the desktop host wires up.
   */
  fileExists?: (root: string, rel: string) => boolean;
  /** Override root validation (tests). */
  isDirectory?: (absPath: string) => boolean;
  /**
   * 拿到引擎实例的出口（P1-5）：桌面有 `pause` / `resume`，CLI/常驻服务此前没有
   * 对等能力 —— 宿主（HTTP 服务）要靠它才能把"先停一下"这件事递到引擎里。
   * 在规划**之前**就给出，否则 PRD/任务分解那两段（最烧 token 的部分）无法暂停。
   */
  onEngine?: (engine: OrchestratorEngine) => void;
  /**
   * 审批询问器（P2-3）：serve 形态由服务注入（广播 approval-request 事件 +
   * 等 POST /approve）；缺省 = 无宿主回调，`ApprovalGate` 按 fail-closed 拒绝。
   */
  requestApproval?: (command: string, args: readonly string[]) => Promise<boolean>;
  /** 任务活性心跳（2026-10-03 竞品吸收）：宿主转发给事件流，缺省不发。 */
  onTaskActivity?: (taskId: string, at: number) => void;
  /**
   * 摄入半边（2026-10-14）：`spec.issue` 的需求解析器。缺省走真实的
   * `gh issue view`（只读白名单）；测试注入替身 —— 与 llm/layer/verify
   * 同一套"注入了就用注入的"规矩，headless 的真进程测试不该依赖 gh 登录态。
   */
  resolveIssue?: IssueResolver;
}

/**
 * `spec.issue` → 需求文本。失败折进结果（不抛）："issue 不存在"与"gh 没登录"
 * 都要能上事件流说给人听，而不是一个栈。
 */
export type IssueResolver = (
  issue: { repo?: string; number: number },
) => Promise<{ ok: true; requirement: string } | { ok: false; reason: string }>;

/** 缺省解析器：只读通路取单条 issue，成文模板与桌面端共用一份。 */
const defaultResolveIssue: IssueResolver = async (issue) => {
  const r = await viewGithubIssue({ ...(issue.repo !== undefined ? { repo: issue.repo } : {}), number: issue.number });
  return r.ok ? { ok: true, requirement: renderIssueRequirement(r.issue) } : { ok: false, reason: r.reason };
};

/**
 * Exit codes: 0 = delivered, 2 = repair rounds exhausted, 1 = fatal
 * (bad input / unusable LLM).
 */
export async function runSpec(spec: ParsedSpec, io: RunSpecIo): Promise<number> {
  const isDir = io.isDirectory ?? ((p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (!isDir(spec.projectRoot)) {
    io.emit({ type: "error", message: `projectRoot 不存在或不是目录：${spec.projectRoot}` });
    return 1;
  }

  io.emit({
    type: "hello",
    protocolVersion: spec.protocolVersion,
    projectRoot: spec.projectRoot,
    llmProvider: spec.llmProvider,
    arbitration: spec.settings.arbitration,
    agentRouter: spec.settings.agentRouter !== false,
    warnings: spec.warnings,
  });
  for (const w of spec.warnings) io.emit({ type: "log", text: `[protocol] ${w}` });
  // 没有凭证时，第一声大脑层调用只会吐 "failover client has no groups" —— 那是内部话，
  // 宿主拿到以后不知道该做什么。这里提前一步说清楚要什么。放在 hello 之后，
  // 因为宿主的协议用法是先读 hello；注入了 llm 替身的调用方不受此限。
  if (!io.llm) {
    const missing = missingCredentials(spec);
    if (missing) {
      io.emit({
        type: "error",
        message:
          `没有可用凭证：大脑层 provider 需要 ${missing.join(" / ")} 中的至少一个。` +
          "headless 只读进程环境变量（.env 由桌面端主进程加载，这里不读），请由宿主注入。",
      });
      return 1;
    }
  }

  const policy = spec.escalationPolicy;
  // 上一次被中断的运行留下的备份目录在这里回收（放在 hello 之后：宿主的读法是先拿 hello）。
  const pruned = pruneStaleBackups(spec.snapshotRoot);
  // 措辞刻意不含"回收"二字：离线 IT 有一条断言就是"没谎报回收"，
  // 保留下来的东西不能被写成回收过。
  if (pruned.kept.length > 0) {    io.emit({
      type: "log",
      text:
        `[snapshots] 保留 ${pruned.kept.length} 个未到期批备份：${pruned.kept.join("、")} —— ` +
        "它们来自没有结算完的批，其中可能有未被仲裁的越权写入；本次运行不会自动回滚，请人工核对。",
    });
  }
  if (pruned.removed > 0 || pruned.failed.length > 0) {
    io.emit({
      type: "log",
      text:
        `[snapshots] 回收 ${pruned.removed} 个中断遗留的备份目录（${spec.snapshotRoot}）` +
        (pruned.failed.length > 0 ? `，另有 ${pruned.failed.length} 个删不掉：${pruned.failed.join("；")}` : ""),
    });
  }
  const redispatched = new Set<string>();
  /** 交付成果面的事实：批次改动累积 + 最近一份凭据（只在凭据存在时发 acceptance）。 */
  let receiptForAcceptance: DeliveryReceipt | undefined;
  const runFiles: DeliveryArtifactFile[] = [];
  const callbacks: OrchestratorCallbacks = {
    onStage: (stage) => io.emit({ type: "stage", stage }),
    onLog: (text) => io.emit({ type: "log", text }),
    onTaskStatus: (taskId, status, attempts) => io.emit({ type: "task", taskId, status, attempts }),
    onEscalation: (taskId, summary) => io.emit({ type: "escalation", taskId, summary }),
    // 用量走协议事件而不是日志行：宿主可能要对账，而解析自由文本不如读字段。
    // （桌面端的默认实现是落一行 `[usage] …` 到看板日志，见 platform.ts。）
    onUsage: (snapshot) => io.emit({ type: "usage", ...snapshot }),
    // 凭据走独立事件而不是塞进 `done`：宿主可能要把它原样落进自己的工单系统，
    // 而 `done` 的 `report` 字段是 unknown 形状（历史契约），塞进去就得再解析一次。
    onReceipt: (receipt) => {
      receiptForAcceptance = receipt;
      io.emit({ type: "receipt", receipt });
    },
    onVerification: (report) =>
        io.emit({
          type: "verification",
          passed: report.passed,
          results: report.results.map((r) => ({
            kind: r.kind,
            ok: r.ok,
            exitCode: r.exitCode,
            // Hosts need the reason a step failed: an exit code alone cannot
            // distinguish "tests failed" from "the command never spawned".
            ...(r.ok ? {} : { logDigest: r.logDigest.slice(0, 400) }),
          })),
        }),
  };
  // `exhaust` deliberately leaves the decision callback absent: the engine then
  // reports "budget spent" as a typed error, which the runner maps to exit 2.
  if (policy !== "exhaust") {
    callbacks.requestEscalationDecision = async (taskId: string): Promise<EscalationAction> => {
      if (policy === "skip") return "skip";
      if (policy === "redispatch_once" && !redispatched.has(taskId)) {
        redispatched.add(taskId);
        return "redispatch";
      }
      return "abort";
    };
  }
  // 摄入半边（2026-10-14）：spec.issue 把"需求从哪来"指向 GitHub 的一条 issue。
  // 解析放在 hello 之后、journal 之前：journal 拿**解析后的文本**做"需求匹配"，
  // 断点续跑才对得上一次；而 hello 必须先发（宿主的协议用法是先读 hello）。
  // 拿不到就整轮不启动 —— 不知道要造什么的时候跑起来只是烧 token。
  let requirement = spec.requirement;
  if (spec.issue) {
    const resolved = await (io.resolveIssue ?? defaultResolveIssue)(spec.issue);
    if (!resolved.ok) {
      io.emit({ type: "error", message: `从 GitHub issue 取需求失败：${resolved.reason}` });
      return 1;
    }
    requirement = resolved.requirement;
    io.emit({
      type: "log",
      text: `[issue] 需求取自 GitHub issue #${spec.issue.number}${spec.issue.repo ? `（${spec.issue.repo}）` : ""}`,
    });
  }
  // 断点续跑：projectRoot 下的运行日志（若与本需求匹配）恢复进度状态，
  // 跳过 PRD/分解，直接从保存的轮次继续 —— 被杀的长运行不再从零开始。
  const journal = createFileJournal(spec.projectRoot, requirement);
  let resume: RunSnapshot | undefined;
  const loaded = journal.load();
  if (loaded) {
    resume = loaded;
    io.emit({
      type: "log",
      text: `[journal] 断点续跑：恢复快照（round ${resume.round}，已完成 ${resume.allDone.length} 个任务），跳过规划`,
    });
  } else if (journal.mismatched()) {
    io.emit({ type: "log", text: "[journal] 发现旧运行日志但需求不匹配，按全新运行处理" });
  } else if (journal.corrupted()) {
    io.emit({ type: "log", text: "[journal] 快照解析失败，按全新运行处理" });
  }

  const platform = createPlatform({
    settings: spec.settings,
    promptDir: spec.projectRoot,
    snapshotRoot: spec.snapshotRoot,
    manifests: spec.agents,
    manifestDir: spec.manifestDir,
    // headless 没有 userData：项目级 `.ox/policy.d` 是它的策略入口。
    policyDirs: [path.join(spec.projectRoot, ".ox", "policy.d")],
    llmPool: spec.llmPool,
    maxParallelRuns: spec.maxParallelRuns,
    journal,
    // Injected (tests) or self-built — the platform reports verdicts for both.
    layer: io.layer,
    llm: io.llm,
    verify: io.verify,
    fileExists: io.fileExists ?? ((root, rel) => fs.existsSync(path.join(root, rel))),
    host: {
      log: (text) => io.emit({ type: "log", text }),
      callbacks,
      // Headless has no userData directory to audit into, so run attribution is
      // streamed and the host decides where to persist it.
      onRunStart: (agentId, task) =>
        io.emit({ type: "run", phase: "start", agentId, taskId: task.id, zone: task.zone }),
      onRunComplete: (outcome, task) =>
        io.emit({
          type: "run",
          phase: "end",
          taskId: task.id,
          zone: task.zone,
          ok: outcome.ok,
          // 同 context.ts 的 run-end 记录：事件形状的契约是「缺失时连键都不出现」，
          // 不能简化成直接传（2026-09-28 简化时 ipc-handlers 侧当场变红）。
          ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
          ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        }),
      onVerdict: (verdict, scope) => {
        // 交付成果面的事实来源与桌面审计同源：每批 settle 后的完整改动清单。
        runFiles.push(...(scope?.changes ?? []));
        for (const c of verdict.conflicts) {
          // 同 context.ts：配对规则只有 `pairConflict` 一份实现。
          const paired = pairConflict(c, verdict.remedies);
          io.emit({ type: "conflict", kind: paired.kind, paths: paired.paths, remedy: paired.remedy });
        }
      },
      requestEscalationDecision: callbacks.requestEscalationDecision,
      // 审批（P2-3）：serve 宿主注入的询问器；CLI 形态缺席 = fail-closed 拒绝。
      // 活性心跳（2026-10-03 竞品吸收）：宿主缺席时不发（无消费者就不产生事件量）。
      // 两者的"缺席时连键都不给"契约收在 optionalHostHooks 里（见该函数注释）。
      ...optionalHostHooks(io),
    },
  });

  const effectiveLayer: AgentLayer = platform.layer;

  for (const err of effectiveLayer.manifestErrors) {
    io.emit({ type: "log", text: `[agents.d] ${err.file} 未通过校验：${err.message}` });
  }
  io.emit({
    type: "agents",
    agents: effectiveLayer.registry.list().map((d) => ({
      id: d.manifest.id,
      adapter: d.manifest.adapter,
      enabled: d.enabled,
      declared: !d.inferredLegacy,
      roles: d.capabilities.roles as string[],
      zoneGlobs: d.capabilities.zoneGlobs,
    })),
  });

  const engine = platform.engine;
  io.onEngine?.(engine);

  /**
   * 发交付成果面。只在凭据存在时发：取消/崩溃的现场不完整，不能让半截
   * 改动看起来像"本次成果"。放在终态之前，顺序与 receipt 一致。
   */
  const emitAcceptance = (): void => {
    if (receiptForAcceptance === undefined) return;
    const packageJson = readPackageJson(spec.projectRoot);
    io.emit({
      type: "acceptance",
      guide: deriveDeliveryGuide(
        [
          { phase: "batch-changes", files: runFiles },
          { phase: "receipt", receipt: receiptForAcceptance },
        ],
        { ...(packageJson !== undefined ? { packageJson } : {}) },
      ),
    });
  };

  try {
    let batches: Task[][];
    let smoke: SmokeCheck[] = [];
    if (resume) {
      batches = resume.batches;
      smoke = resume.smoke ?? [];
      io.emit({ type: "tasks", batches });
    } else {
      // 需求文本用解析后的（issue 形态下 spec.requirement 是空串占位）。
      // 项目约定（B3）与桌面端同一口径：项目根的 OX.md / AGENTS.md 进规划提示。
      //
      // 规划历史（形态 B，2026-10-25）**刻意不接在这一层**：它读的是审计 JSONL 里
      // 本项目的历史快照，而 headless 的一次 run 是**无状态**的（没有审计句柄、也不写
      // 审计），把"上次规划"注进来就等于凭空造一个 headless 并不持有的真源。
      // 桌面端与 serve 各有自己的历史，这一格留给它们。
      const prd = spec.prd ?? (await engine.generatePrd(requirement, spec.projectRoot));
      io.emit({ type: "prd", prd });
      // 把宿主的验证命令一并交给 zone 覆盖校验：它引用的文件若不被任何任务
      // 的 zone 覆盖，重修多少轮都造不出来 —— 早失败，别烧掉整个重修预算。
      const plan = await engine.decompose(prd, spec.settings.verificationCommands);
      batches = plan.batches;
      smoke = plan.smoke;
      io.emit({ type: "tasks", batches });
    }
    const report = await engine.execute(batches, spec.projectRoot, {
      resume,
      smoke,
    });
    emitAcceptance();
    io.emit({ type: "done", passed: report.passed, report });
    return report.passed ? 0 : 2;
  } catch (err) {
    // "Spent the repair budget" is a different outcome from "something broke":
    // hosts script against the difference, so the exit codes differ too.
    const exhausted = err instanceof VerificationExhaustedError;
    emitAcceptance();
    if (exhausted) {
      io.emit({ type: "error", message: err.message, exhausted: true });
      return 2;
    }
    io.emit({ type: "error", message: (err as Error).message ?? String(err) });
    return 1;
  }
}
