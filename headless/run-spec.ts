/**
 * Runs one `ParsedSpec` to completion and reports the exit code.
 *
 * Kept free of process/stdin/stdout so it can be driven by a test with injected
 * fakes (fake LLM, fake agent pool, fake verifier) — the protocol is only
 * trustworthy if its happy path is actually exercised.
 */
import * as fs from "node:fs";
import { VerificationExhaustedError } from "../electron/engine";
import type { OrchestratorCallbacks, RunSnapshot } from "../electron/engine";
import type { AgentLayer } from "../electron/agents";
import { createFileJournal, createPlatform } from "../electron/platform";
import type { LlmClient } from "../shared/llm-client";
import type { SmokeCheck, Task, EscalationAction, VerificationReport } from "../shared/types";
import type { HeadlessEvent, ParsedSpec } from "./protocol";

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

  const policy = spec.escalationPolicy;
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
