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
import type { OrchestratorCallbacks, RunSnapshot } from "../electron/engine";
import type { AgentLayer } from "../electron/agents";
import { createFileJournal, createPlatform } from "../electron/platform";
import { getProvider, providerKeyEnvVars } from "../shared/providers";
import type { LlmClient } from "../shared/llm-client";
import type { SmokeCheck, Task, EscalationAction, VerificationReport } from "../shared/types";
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
  /** Override root validation (tests). */
  isDirectory?: (absPath: string) => boolean;
}

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
  if (pruned.kept.length > 0) {
    io.emit({
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
  const callbacks: OrchestratorCallbacks = {
    onStage: (stage) => io.emit({ type: "stage", stage }),
    onLog: (text) => io.emit({ type: "log", text }),
    onTaskStatus: (taskId, status, attempts) => io.emit({ type: "task", taskId, status, attempts }),
    onEscalation: (taskId, summary) => io.emit({ type: "escalation", taskId, summary }),
    // 用量走协议事件而不是日志行：宿主可能要对账，而解析自由文本不如读字段。
    // （桌面端的默认实现是落一行 `[usage] …` 到看板日志，见 platform.ts。）
    onUsage: (snapshot) => io.emit({ type: "usage", ...snapshot }),
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
  // 断点续跑：projectRoot 下的运行日志（若与本需求匹配）恢复进度状态，
  // 跳过 PRD/分解，直接从保存的轮次继续 —— 被杀的长运行不再从零开始。
  const journal = createFileJournal(spec.projectRoot, spec.requirement);
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
    ...(spec.manifestDir ? { manifestDir: spec.manifestDir } : {}),
    llmPool: spec.llmPool,
    maxParallelRuns: spec.maxParallelRuns,
    journal,
    // Injected (tests) or self-built — the platform reports verdicts for both.
    ...(io.layer ? { layer: io.layer } : {}),
    ...(io.llm ? { llm: io.llm } : {}),
    ...(io.verify ? { verify: io.verify } : {}),
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
          ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
          ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
          ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        }),
      onVerdict: (verdict) => {
        for (const c of verdict.conflicts) {
          io.emit({
            type: "conflict",
            kind: c.kind,
            paths: c.paths,
            remedy: verdict.remedies.find((r) => r.paths.some((p) => c.paths.includes(p)))?.action ?? "none",
          });
        }
      },
      ...(callbacks.requestEscalationDecision
        ? { requestEscalationDecision: callbacks.requestEscalationDecision }
        : {}),
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

  try {
    let batches: Task[][];
    let smoke: SmokeCheck[] = [];
    if (resume) {
      batches = resume.batches;
      smoke = resume.smoke ?? [];
      io.emit({ type: "tasks", batches });
    } else {
      const prd = spec.prd ?? (await engine.generatePrd(spec.requirement));
      io.emit({ type: "prd", prd });
      // 把宿主的验证命令一并交给 zone 覆盖校验：它引用的文件若不被任何任务
      // 的 zone 覆盖，重修多少轮都造不出来 —— 早失败，别烧掉整个重修预算。
      const plan = await engine.decompose(prd, spec.settings.verificationCommands);
      batches = plan.batches;
      smoke = plan.smoke;
      io.emit({ type: "tasks", batches });
    }
    const report = await engine.execute(batches, spec.projectRoot, {
      ...(resume ? { resume } : {}),
      smoke,
    });
    io.emit({ type: "done", passed: report.passed, report });
    return report.passed ? 0 : 2;
  } catch (err) {
    // "Spent the repair budget" is a different outcome from "something broke":
    // hosts script against the difference, so the exit codes differ too.
    if (err instanceof VerificationExhaustedError) {
      io.emit({ type: "error", message: err.message, exhausted: true });
      return 2;
    }
    io.emit({ type: "error", message: (err as Error).message ?? String(err) });
    return 1;
  }
}
