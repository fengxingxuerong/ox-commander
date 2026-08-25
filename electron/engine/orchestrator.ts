import type { LlmClient } from "../../shared/llm-client";
import { chatJson } from "../../shared/llm-client";
import { buildDecomposePrompt, buildEscalationSummary, buildPrdPrompt } from "../../shared/prompts";
import { parsePrd, parseTaskList } from "../../shared/schema";
import { planBatches } from "../../shared/graph";
import type {
  PrdDocument,
  ProjectSettings,
  Stage,
  Task,
  TaskStatus,
  VerificationReport,
} from "../../shared/types";

export interface OrchestratorDeps {
  llm: LlmClient;
  scheduler: import("./scheduler").Scheduler;
  verify: (cwd: string) => Promise<VerificationReport>;
  settings: ProjectSettings;
}

export interface OrchestratorCallbacks {
  onStage(stage: Stage): void;
  onLog(text: string): void;
  onTaskStatus(taskId: string, status: TaskStatus, attempts: number): void;
  onVerification(report: VerificationReport): void;
  /** Fired when repair rounds are exhausted; engine halts awaiting user decision. */
  onEscalation(taskId: string, summary: string): void;
}

export class CancelledError extends Error {
  constructor() {
    super("orchestration cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Fixed six-stage skeleton; inside PLANNING and repair rounds the LLM may
 * freely shape content, but stage transitions are code-controlled.
 */
export class OrchestratorEngine {
  private cancelled = false;
  private paused = false;

  constructor(private deps: OrchestratorDeps, private cb: OrchestratorCallbacks) {}

  cancel(): void {
    this.cancelled = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  private async gate(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.cancelled) throw new CancelledError();
  }

  async generatePrd(userRequirement: string): Promise<PrdDocument> {
    this.cb.onStage("PRD");
    const prd = await chatJson(this.deps.llm, { messages: [{ role: "user", content: buildPrdPrompt(userRequirement) }] }, {
      schemaName: "PRD",
      validate: parsePrd,
    });
    return prd;
  }

  async decompose(prd: PrdDocument): Promise<Task[][]> {
    this.cb.onStage("PLANNING");
    const tasks = await chatJson(this.deps.llm, { messages: [{ role: "user", content: buildDecomposePrompt(prd) }] }, {
      schemaName: "task list",
      validate: parseTaskList,
    });
    return planBatches(tasks);
  }

  /** Runs DEVELOPMENT → VERIFICATION (+ repair loops) → DELIVERY. */
  async execute(batches: Task[][], projectRoot: string): Promise<VerificationReport> {
    const maxRounds = this.deps.settings.maxRepairRounds;
    const attempts = new Map<string, number>();
    const allDone = new Set<string>();

    this.cb.onStage("DEVELOPMENT");
    let lastDigest = "";
    for (let round = 0; round <= maxRounds; round++) {
      await this.gate();
      const isRepair = round > 0;
      if (isRepair) {
        this.cb.onLog(`── 重修第 ${round}/${maxRounds} 轮 ──`);
      }

      for (const [bi, batch] of batches.entries()) {
        await this.gate();
        const pending = batch.filter((t) => !allDone.has(t.id) || isRepair);
        if (pending.length === 0) continue;
        for (const t of pending) {
          attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
          this.cb.onTaskStatus(t.id, "running", attempts.get(t.id)!);
        }
        const repairOf = isRepair
          ? new Map(pending.map((t) => [t.id, { round, errorLogDigest: lastDigest }]))
          : undefined;
        const outcomes = await this.deps.scheduler.runBatch(pending, projectRoot, { repairOf });
        for (const o of outcomes) {
          if (o.ok) {
            allDone.add(o.taskId);
            this.cb.onTaskStatus(o.taskId, "done", attempts.get(o.taskId)!);
          } else {
            this.cb.onTaskStatus(o.taskId, "failed", attempts.get(o.taskId)!);
          }
        }
        this.cb.onLog(`批次 ${bi + 1}/${batches.length} 完成：${outcomes.filter((o) => o.ok).length}/${outcomes.length} 成功`);
      }

      // Stage 4: hard verification gates delivery.
      this.cb.onStage("VERIFICATION");
      await this.gate();
      const report = await this.deps.verify(projectRoot);
      this.cb.onVerification(report);
      if (report.passed) {
        this.cb.onStage("DELIVERY");
        this.cb.onLog("全部验证通过，进入交付。");
        this.cb.onStage("DONE");
        return report;
      }
      lastDigest = report.results
        .filter((r) => !r.ok)
        .map((r) => `[${r.kind}] exit=${r.exitCode}\n${r.logDigest}`)
        .join("\n\n");

      const exhausted = round === maxRounds;
      if (exhausted) {
        for (const t of batches.flat()) {
          this.cb.onEscalation(t.id, buildEscalationSummary({
            taskTitle: t.title,
            attemptsSoFar: attempts.get(t.id) ?? round,
            maxRepairRounds: maxRounds,
            lastErrorDigest: lastDigest,
          }));
        }
        throw new Error(`verification still failing after ${maxRounds} repair rounds`);
      }
    }
    throw new Error("unreachable");
  }
}
