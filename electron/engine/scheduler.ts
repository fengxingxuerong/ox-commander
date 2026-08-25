import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  Task,
  TaskPayload,
} from "../../shared/types";
export interface DispatchOutcome {
  taskId: string;
  ok: boolean;
  logDigest: string;
  events: AgentEvent[];
}

/**
 * Zone-isolating concurrent dispatcher: runs one batch of zone-disjoint tasks
 * across the available agent pool concurrently, collects each run to its
 * terminal event, and returns structured outcomes.
 */
export class Scheduler {
  constructor(private adapters: AgentAdapter[]) {}

  private pickAgent(agentId?: string): AgentAdapter | undefined {
    if (agentId) return this.adapters.find((a) => a.meta.id === agentId);
    return this.adapters.find((a) => a.meta.kind === "cli");
  }

  async runBatch(
    tasks: Task[],
    projectRoot: string,
    opts?: { preferredAgentId?: string; repairOf?: Map<string, { round: number; errorLogDigest: string }> },
  ): Promise<DispatchOutcome[]> {
    const zones = tasks.map((t) => t.zone);
    const duplicated = zones.filter((z, i) => zones.indexOf(z) !== i);
    if (duplicated.length > 0) {
      throw new Error(`zone conflict inside batch: ${[...new Set(duplicated)].join(", ")}`);
    }

    const jobs = tasks.map(async (task) => {
      const agent = this.pickAgent(opts?.preferredAgentId);
      if (!agent) {
        return { taskId: task.id, ok: false, logDigest: "no agent available", events: [] };
      }
      const repair = opts?.repairOf?.get(task.id);
      const payload: TaskPayload = {
        runId: `${task.id}-${Date.now()}`,
        taskId: task.id,
        title: task.title,
        description: task.description,
        zone: task.zone,
        projectRoot,
        ...(repair ? { repairContext: repair } : {}),
      };
      try {
        const handle = await agent.dispatch(payload);
        return await this.collectToTerminal(handle, task.id);
      } catch (err) {
        return {
          taskId: task.id,
          ok: false,
          logDigest: `dispatch failed: ${(err as Error).message}`,
          events: [],
        };
      }
    });
    return Promise.all(jobs);
  }

  private async collectToTerminal(handle: RunHandle, taskId: string): Promise<DispatchOutcome> {
    const adapter = this.adapters.find((a) => a.meta.id === handle.agentId)!;
    const logs: string[] = [];
    let terminalOk = false;
    for await (const event of adapter.collect(handle)) {
      if (event.kind === "log") {
        logs.push(event.text);
      } else if (event.kind === "completed") {
        terminalOk = true;
        break;
      } else if (event.kind === "failed" || event.kind === "aborted") {
        logs.push(event.text);
        break;
      }
    }
    return { taskId, ok: terminalOk, logDigest: digest(logs.join("\n")), events: [] };
  }
}

/** Keep the head and tail of long logs; error summaries usually live in the tail. */
export function digest(log: string, maxLen = 4000): string {
  const clean = log.trim();
  if (clean.length <= maxLen) return clean;
  const half = Math.floor(maxLen / 2);
  return `${clean.slice(0, half)}\n...[truncated]...\n${clean.slice(-half)}`;
}
