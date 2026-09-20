import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, RunHandle, TaskPayload } from "../../shared/types";
import { AGENT_PROTOCOL_VERSION, DEFAULT_AGENT_LIMITS, type AgentAdapterV2, type AgentCapabilities, type AgentLimits, type AgentRunResult } from "../../shared/agent-contract";
import { TimeoutGate } from "../sandbox/timeout-gate";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";
import { scopedEnv } from "./scoped-env";
import { RunSession } from "./run-session";

export interface CliAgentOptions {
  id: string;
  name?: string;
  command: string;
  /** Placeholders: {{projectRoot}} {{promptPath}} {{taskId}} {{runId}} {{zone}}. */
  argsTemplate: string[];
  probeArgs?: string[];
  envTemplate?: Record<string, string>;
  /**
   * Provider ids whose credentials this CLI may see. Normally empty: a CLI
   * authenticates via its own config file, not via our environment.
   */
  allowProviders?: readonly string[];
  capabilities?: AgentCapabilities;
  limits?: Partial<AgentLimits>;
  /** Where prompt files are written. Defaults to a per-process temp dir. */
  promptDir?: string;
  /** Probe timeout; defaults to 10s. */
  probeTimeoutMs?: number;
}

interface CliRun {
  session: RunSession;
  child: ChildProcess;
  taskId: string;
  startedAt: number;
  bytes: number;
  truncated: boolean;
  exitCode: number | null;
  logs: string[];
  done: Promise<void>;
}

const PROMPT_EXCERPT = 2000;

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

function tail(text: string, max = 1500): string {
  return text.length <= max ? text : `…（前段省略）\n${text.slice(-max)}`;
}

/** Keeps the head and the tail of an oversized stream; errors usually live in the tail. */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…（输出超出 ${max} 字符，已截断）…\n${text.slice(-half)}`;
}

/**
 * Adapter for external coding agents driven as a subprocess (Codex CLI, Trae
 * CLI, Claude Code …).
 *
 * Design rules:
 * - the child receives a **prompt file** (never a giant argv), so long task
 *   descriptions cannot blow the OS argument limit;
 * - spawn always runs with `shell: false` — no shell metacharacter can escape;
 * - stdout/stderr are streamed into the run's event queue line by line and are
 *   budgeted, so a runaway agent cannot exhaust memory;
 * - `abort()` kills the whole process tree (Windows: `taskkill /F /T`).
 */
export class CliAgentAdapter implements AgentAdapterV2 {
  readonly meta: { id: string; name: string; kind: "api" | "ui" };
  readonly limits: AgentLimits;
  private readonly runs = new Map<string, CliRun>();
  /** Terminal results, kept after collect() drops the run so `lastResult` still answers. */
  private readonly results = new Map<string, AgentRunResult>();
  /** Per-run watchdog: hard deadline + idle (no-output) detection. */
  private readonly gate: TimeoutGate;
  private readonly promptDir: string;

  constructor(private opts: CliAgentOptions) {
    this.meta = { id: opts.id, name: opts.name ?? opts.id, kind: "api" };
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...(opts.limits ?? {}) };
    this.gate = new TimeoutGate({
      deadlineMs: this.limits.runDeadlineMs,
      idleTimeoutMs: this.limits.idleTimeoutMs,
    });
    this.promptDir = opts.promptDir ?? path.join(os.tmpdir(), "ox-commander-prompts", opts.id);
  }

  capabilities(): AgentCapabilities {
    return (
      this.opts.capabilities ?? {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "run-test"],
        artifactKinds: ["files", "logs"],
        maxConcurrency: 1,
        selfIsolated: true,
      }
    );
  }

  /** Spawns the binary once to check it exists and exits 0. */
  async probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // A CLI installed on Windows is usually a `.cmd` shim (`codex.cmd`),
      // which Node refuses to spawn without a shell — see `spawn-plan.ts`.
      const plan = buildSpawnSpec(this.opts.command, this.opts.probeArgs ?? ["--version"]);
      let child: ChildProcess;
      try {
        child = spawn(plan.file, plan.args, {
          shell: false,
          stdio: "ignore",
          ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, this.opts.probeTimeoutMs ?? 10_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  async dispatch(payload: TaskPayload): Promise<RunHandle> {
    const vars = {
      projectRoot: path.resolve(payload.projectRoot),
      taskId: payload.taskId,
      runId: payload.runId,
      zone: payload.zone,
      promptPath: "",
    };
    const promptPath = this.writePrompt(payload);
    vars.promptPath = promptPath;
    const args = this.opts.argsTemplate.map((a) => renderTemplate(a, vars));
    // Minimised on purpose. `{ ...process.env }` used to hand this child the API
    // keys of every configured provider, including ones it has no business
    // seeing. The agent's own envTemplate values are passed as an explicit
    // operator grant; nothing else beyond process basics and those keys.
    const envTemplateKeys = Object.keys(this.opts.envTemplate ?? {});
    const env = scopedEnv({
      ...(this.opts.allowProviders ? { allowProviders: this.opts.allowProviders } : {}),
      extraKeys: envTemplateKeys,
    });
    for (const [k, v] of Object.entries(this.opts.envTemplate ?? {})) env[k] = renderTemplate(v, vars);

    const session = new RunSession();
    const handle: RunHandle = { runId: payload.runId, agentId: this.meta.id, taskId: payload.taskId };
    const plan = buildSpawnSpec(this.opts.command, args);
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: vars.projectRoot,
        shell: false,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      session.push("failed", `[${this.meta.id}] 启动失败：${(err as Error).message}`);
      session.finished = true;
      session.wake();
      this.runs.set(payload.runId, {
        session,
        child: { pid: undefined } as ChildProcess,
        taskId: payload.taskId,
        startedAt: Date.now(),
        bytes: 0,
        truncated: false,
        exitCode: null,
        logs: [],
        done: Promise.resolve(),
      });
      return handle;
    }
    const run: CliRun = {
      session,
      child,
      taskId: payload.taskId,
      startedAt: Date.now(),
      bytes: 0,
      truncated: false,
      exitCode: null,
      logs: [],
      done: Promise.resolve(),
    };
    this.runs.set(payload.runId, run);

    session.push("log", `[${this.meta.id}] spawn ${this.opts.command} ${args.join(" ")}`);
    // Watchdog: the child may hang without producing a single byte, so the idle
    // window matters as much as the hard deadline.
    this.gate.attach(
      {
        id: payload.runId,
        deadlineMs: this.limits.runDeadlineMs,
        idleTimeoutMs: this.limits.idleTimeoutMs,
      },
      (reason) => {
        if (run.session.finished) return;
        session.push(
          "log",
          `[${this.meta.id}] 看门狗触发（${reason === "deadline" ? "超出总时限" : "空闲无输出"}），终止 run`,
        );
        void this.abort(handle);
      },
    );
    const onData = (chunk: Buffer): void => {
      this.gate.touch(payload.runId);
      run.bytes += chunk.length;
      if (run.bytes > this.limits.maxStdoutBytes) {
        if (!run.truncated) {
          run.truncated = true;
          session.push("log", `[${this.meta.id}] 输出超过 ${this.limits.maxStdoutBytes} 字节，后续内容不再记录`);
        }
        return;
      }
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim() === "") continue;
        run.logs.push(line);
        session.push("log", line);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    run.done = new Promise<void>((resolve) => {
      const finish = (kind: AgentEvent["kind"], text: string): void => {
        if (run.session.finished) return;
        this.gate.detach(payload.runId);
        run.session.push(kind, text);
        run.session.finished = true;
        run.session.wake();
        this.rememberResult(run, payload.runId, kind);
        resolve();
      };
      child.on("error", (err) =>
        finish("failed", `[${this.meta.id}] 启动失败：${(err as Error).message}`),
      );
      child.on("close", (code) => {
        run.exitCode = code;
        if (code === 0) {
          finish("completed", `[${this.meta.id}] 退出码 0（${Math.round((Date.now() - run.startedAt) / 1000)}s）`);
        } else {
          finish("failed", `[${this.meta.id}] 退出码 ${code}（${Math.round((Date.now() - run.startedAt) / 1000)}s）`);
        }
      });
    });
    return handle;
  }

  async *collect(handle: RunHandle): AsyncGenerator<AgentEvent> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`unknown run ${handle.runId}`);
    try {
      while (true) {
        if (run.session.events.length > 0) {
          yield run.session.events.shift()!;
          continue;
        }
        if (run.session.finished) return;
        const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
          run.session.waiting.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.runs.delete(handle.runId);
    }
  }

  async abort(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run || run.session.finished) return;
    this.gate.detach(handle.runId);
    killTree(run.child);
    if (!run.session.finished) {
      run.session.push("aborted", `[${this.meta.id}] run 已被中止`);
      run.session.finished = true;
      run.session.wake();
      this.rememberResult(run, handle.runId, "aborted");
    }
  }

  /** Waits for every in-flight run to finish; used by unregister/deregistration. */
  async drain(graceMs: number): Promise<"drained" | "timeout"> {
    const pending = [...this.runs.values()].map((r) => r.done);
    if (pending.length === 0) return "drained";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    const settled = await Promise.race([Promise.all(pending).then(() => "drained" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (settled === "timeout") {
      for (const handle of [...this.runs.keys()]) await this.abort({ runId: handle, agentId: this.meta.id, taskId: "" });
    }
    return settled;
  }

  async lastResult(handle: RunHandle): Promise<AgentRunResult | undefined> {
    const run = this.runs.get(handle.runId);
    if (run) return this.buildResult(run, handle.runId, run.session.finished ? "failed" : "log");
    return this.results.get(handle.runId);
  }

  private buildResult(run: CliRun, runId: string, lastKind: AgentEvent["kind"]): AgentRunResult {
    const status =
      lastKind === "completed" ? "completed" : lastKind === "aborted" ? "aborted" : "failed";
    return {
      runId,
      agentId: this.meta.id,
      taskId: run.taskId,
      status,
      changes: [],
      ...(lastKind === "failed" && run.exitCode === null
        ? { errorClass: "timeout" as const, retryable: true }
        : {}),
      logDigest: truncateMiddle(run.logs.join("\n"), 4000),
      durationMs: Date.now() - run.startedAt,
    };
  }

  private rememberResult(run: CliRun, runId: string, lastKind: AgentEvent["kind"]): void {
    this.results.set(runId, this.buildResult(run, runId, lastKind));
    if (this.results.size > 50) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
  }

  /** Diagnostic helper used by tests and the settings panel. */
  activeRunCount(): number {
    return this.runs.size;
  }

  /** Runs currently under watchdog protection. */
  watchedCount(): number {
    return this.gate.activeCount();
  }

  private writePrompt(payload: TaskPayload): string {
    fs.mkdirSync(this.promptDir, { recursive: true });
    const lines = [
      `# 任务：${payload.title}`,
      "",
      `- 任务 id：${payload.taskId}`,
      `- 所属区域（zone）：${payload.zone}`,
      `- 项目根目录：${path.resolve(payload.projectRoot)}`,
      "",
      "## 要求",
      "",
      payload.description,
      "",
      `## 约束`,
      "",
      `- 只能创建或修改 zone「${payload.zone}」内的文件；其它路径一律不要动。`,
      `- 完成后请确保项目能通过构建与测试。`,
    ];
    if (payload.repairContext) {
      lines.push(
        "",
        `## 这是第 ${payload.repairContext.round} 轮修复`,
        "",
        "上一轮失败日志摘要：",
        "",
        "```",
        tail(payload.repairContext.errorLogDigest, PROMPT_EXCERPT),
        "```",
        "",
        "只修导致失败的代码，已通过的部分保持原样。",
      );
    }
    const file = path.join(this.promptDir, `${payload.runId}.md`);
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }
}

/** Re-exported for callers that used to import it from this module. */
export { killTree };
