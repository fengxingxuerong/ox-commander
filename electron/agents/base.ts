import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  TaskPayload,
} from "../../shared/types";

export type { AgentAdapter };

export interface CliInvocation {
  cmd: string;
  args: string[];
}

/** Each brand-specific adapter declares how to turn a task payload into argv. */
export interface CliAgentDefinition {
  meta: AgentAdapter["meta"];
  commandFor(payload: TaskPayload): CliInvocation;
}

async function hasCommand(cmd: string): Promise<boolean> {
  const locator = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(locator, [cmd], { shell: false, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

class RunSession {
  events: AgentEvent[] = [];
  waiting: Array<(e: IteratorResult<AgentEvent>) => void> = [];
  finished = false;

  push(kind: AgentEvent["kind"], text: string) {
    if (this.finished && kind === "log") return;
    this.events.push({ kind, text, timestamp: Date.now() });
    this.wake();
  }

  wake() {
    while (this.waiting.length > 0 && this.events.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve({ value: this.events.shift()!, done: false });
    }
    if (this.finished && this.events.length === 0) {
      while (this.waiting.length > 0) {
        this.waiting.shift()!({ value: undefined, done: true });
      }
    }
  }
}

/**
 * Shared machinery for CLI-driven agents: spawn, stream stdout/stderr as log
 * events, decide success by exit code, support abort. Windows quirk: npm-style
 * CLIs install as .cmd shims which cannot spawn without a shell, so an ENOENT
 * is retried through cmd.exe /c.
 */
export abstract class BaseCliAdapter implements AgentAdapter {
  abstract readonly meta: AgentAdapter["meta"];
  protected sessions = new Map<string, RunSession>();
  protected processes = new Map<string, ChildProcess>();

  constructor(protected definition: CliAgentDefinition) {}

  async probe(): Promise<boolean> {
    return hasCommand(this.baseCommand());
  }

  protected abstract baseCommand(): string;

  async dispatch(payload: TaskPayload): Promise<RunHandle> {
    const invocation = this.definition.commandFor(payload);
    const session = new RunSession();
    const child = this.spawn(invocation.cmd, invocation.args, payload.projectRoot);

    child.stdout?.on("data", (chunk: Buffer) =>
      session.push("log", chunk.toString("utf8").trimEnd()),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      session.push("log", chunk.toString("utf8").trimEnd()),
    );
    child.on("error", (err) => {
      session.push("failed", String(err));
      session.finished = true;
      session.wake();
    });
    child.on("close", (code, signal) => {
      if (signal) {
        session.push("aborted", `terminated by signal ${signal}`);
      } else if (code === 0) {
        session.push("completed", `run ${payload.runId} completed`);
      } else {
        session.push("failed", `exit code ${code}`);
      }
      session.finished = true;
      session.wake();
    });

    this.sessions.set(payload.runId, session);
    this.processes.set(payload.runId, child);
    return { runId: payload.runId, agentId: this.meta.id, taskId: payload.taskId, pid: child.pid };
  }

  private spawn(cmd: string, args: string[], cwd: string): ChildProcess {
    try {
      return spawn(cmd, args, { cwd, shell: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && process.platform === "win32") {
        return spawn("cmd.exe", ["/c", cmd, ...args], { cwd, shell: false });
      }
      throw err;
    }
  }

  async *collect(handle: RunHandle): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(handle.runId);
    if (!session) throw new Error(`unknown run ${handle.runId}`);
    while (true) {
      if (session.events.length > 0) {
        yield session.events.shift()!;
        continue;
      }
      if (session.finished) return;
      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        session.waiting.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  async abort(handle: RunHandle): Promise<void> {
    this.processes.get(handle.runId)?.kill();
  }
}
