/**
 * Runs one `ParsedSpec` to completion and reports the exit code.
 *
 * Kept free of process/stdin/stdout so it can be driven by a test with injected
 * fakes (fake LLM, fake agent pool, fake verifier) — the protocol is only
 * trustworthy if its happy path is actually exercised.
 */
import * as fs from "node:fs";
import path from "node:path";
import { OrchestratorEngine, Scheduler, VerificationExhaustedError, verifyProject } from "../electron/engine";
import type { RunSnapshot } from "../electron/engine";
import { agentRoutingLogLine, createAgentLayer, type AgentLayer } from "../electron/agents";
import { buildLlmClient, buildLlmPool } from "../shared/build-llm";
import type { LlmClient } from "../shared/llm-client";
import type { SmokeCheck, Task, EscalationAction, VerificationReport } from "../shared/types";
import type { OrchestratorCallbacks } from "../electron/engine";
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

  const layer =
    io.layer ??
    createAgentLayer({
      enableRouter: spec.settings.agentRouter !== false,
      manifests: spec.agents,
      ...(spec.manifestDir ? { manifestDir: spec.manifestDir } : {}),
      snapshotRoot: spec.snapshotRoot,
      arbitration: spec.settings.arbitration,
      onRouting: (decision, task) => io.emit({ type: "log", text: agentRoutingLogLine(decision, task) }),
      onEvent: (text) => io.emit({ type: "log", text: `[sandbox] ${text}` }),
      breakerOptions: { onEvent: (text) => io.emit({ type: "log", text: `[breaker] ${text}` }) },
    });

  // Attached after the fact so an injected layer reports verdicts the same way a
  // self-built one does.
  layer.schedulerOptions.guard?.setVerdictSink((verdict) => {
    for (const c of verdict.conflicts) {
      io.emit({
        type: "conflict",
        kind: c.kind,
        paths: c.paths,
        remedy: verdict.remedies.find((r) => r.paths.some((p) => c.paths.includes(p)))?.action ?? "none",
      });
    }
  });

  for (const err of layer.manifestErrors) {
    io.emit({ type: "log", text: `[agents.d] ${err.file} 未通过校验：${err.message}` });
  }
  io.emit({
    type: "agents",
    agents: layer.registry.list().map((d) => ({
      id: d.manifest.id,
      adapter: d.manifest.adapter,
      enabled: d.enabled,
      declared: !d.inferredLegacy,
      roles: d.capabilities.roles as string[],
      zoneGlobs: d.capabilities.zoneGlobs,
    })),
  });

  const policy = spec.escalationPolicy;
  const redispatched = new Set<string>();
  const callbacks: OrchestratorCallbacks = {
    onStage: (stage) => io.emit({ type: "stage", stage }),
    onLog: (text) => io.emit({ type: "log", text }),
    onTaskStatus: (taskId, status, attempts) => io.emit({ type: "task", taskId, status, attempts }),
    onEscalation: (taskId, summary) => io.emit({ type: "escalation", taskId, summary }),
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
  const journalPath = path.join(spec.projectRoot, "ox-run-journal.json");
  const journal = {
    save: (snapshot: RunSnapshot): void => {
      try {
        fs.writeFileSync(
          journalPath,
          JSON.stringify({ requirement: spec.requirement, savedAt: new Date().toISOString(), snapshot }, null, 2),
          "utf8",
        );
      } catch {
        // 快照写失败不中断运行（断点续跑是尽力而为的保险丝）
      }
    },
  };
  let resume: RunSnapshot | undefined;
  if (fs.existsSync(journalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        requirement?: string;
        snapshot?: RunSnapshot;
      };
      if (parsed.requirement === spec.requirement && Array.isArray(parsed.snapshot?.batches)) {
        resume = parsed.snapshot;
        io.emit({
          type: "log",
          text: `[journal] 断点续跑：恢复快照（round ${resume.round}，已完成 ${resume.allDone.length} 个任务），跳过规划`,
        });
      } else {
        io.emit({ type: "log", text: "[journal] 发现旧运行日志但需求不匹配，按全新运行处理" });
      }
    } catch {
      io.emit({ type: "log", text: "[journal] 快照解析失败，按全新运行处理" });
    }
  }

  const engine = new OrchestratorEngine(
    {
      llm: io.llm ?? (spec.llmPool.length > 0 ? buildLlmPool({ providers: spec.llmPool }) : buildLlmClient(spec.llmProvider)),
      scheduler: new Scheduler(layer.adapters, spec.settings.enabledAgents, undefined, {
        ...layer.schedulerOptions,
        maxParallelRuns: spec.maxParallelRuns,
        // Headless has no userData directory to audit into, so run attribution
        // is streamed and the host decides where to persist it.
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
      }),
      verify:
        io.verify ??
        ((cwd: string) =>
          verifyProject(spec.settings.verificationCommands, {
            cwd: () => cwd,
            onEvent: (text) => io.emit({ type: "log", text }),
          })),
      settings: spec.settings,
      journal,
    },
    callbacks,
  );

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
      const plan = await engine.decompose(prd);
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
