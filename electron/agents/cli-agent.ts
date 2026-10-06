import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, RunHandle, TaskPayload } from "../../shared/types";
import { AGENT_PROTOCOL_VERSION, DEFAULT_AGENT_LIMITS, type AgentAdapterV2, type AgentCapabilities, type AgentLimits, type AgentRunResult } from "../../shared/agent-contract";
import { TimeoutGate } from "../sandbox/timeout-gate";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";
import { droppedSecretNames, scopedEnv } from "./scoped-env";
import { fencedBlock, inlineField } from "../../shared/prompt-text";
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
 *
 * ⚠️ **不要在这里套 `CommandPolicy`**（2026-10-05 实测差点做，见体检报告 §P2）。
 * `buildSpawnSpec` 把 Windows `.cmd` shim 交给 `cmd.exe /d /s /c`，那确实是
 * shell，而真机实测 `quoteForCmd` 的 `\"` 转义挡不住注入 —— 这个观察是对的。
 * 但结论**不是**"给本文件加 policy.check"：
 *
 * `CommandPolicy` 的白名单是**构建/测试工具链**（node/npm/tsc/vitest/git…），
 * 它服务的是"验证阶段允许跑哪些命令"。CLI 智能体的 command 是
 * codex / claude / aider / goose / qwen —— 实测 `agents.d/` 下 **11/11** 个
 * 清单都会被默认策略拒绝，加上检查等于**让所有 CLI 智能体全部不可用**。
 *
 * 那 argv 靠什么安全？答：靠**渲染模板的取值**都是生成物，不是自由文本 ——
 * `{{promptPath}}` 由 `writePrompt` 生成；`{{zone}}` 经 `shared/schema.ts:81`
 * 的白名单 `^[A-Za-z0-9_][A-Za-z0-9_./-]*$`（不含任何 shell 元字符）；
 * `{{projectRoot}}` 是 `workspaceRoot(projectId)` 拼出的服务端路径，
 * `projectId` 由 store 铸造，不是用户输入。`argsTemplate` 本身来自清单，
 * 而清单是操作员在本机显式注册/审核的，不是 LLM 产物。
 *
 * 所以真正的风险是**将来**给模板加一个绑到 LLM 自由文本的占位符
 * （`{{taskTitle}}` 是最明显的候选）。防它的正确位置是
 * `manifest-loader.ts`（占位符白名单），不是把验证阶段的策略套到这里。
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
          // 探测即真跑一次二进制：它同样拿不到凭证（dispatch 已如此，probe 曾漏）。
          env: scopedEnv(),
          stdio: "ignore",
          // 2026-09-28：原为 `...(plan.windowsVerbatimArguments ? { … : true } : {})`。
          // spawn 只看真假，`undefined` 与"不传"同义（与 verifier.ts 同构）。
          // 该选项 Windows 专属：Linux 上 Node 直接忽略，变异只有 Windows 真_spawn
          // 行为能杀 —— 条件展开曾因此漏过 Windows 评估、在 CI ubuntu 存活。
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
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
      // 2026-09-28：`...(x ? { x } : {})` → 直接传。scopedEnv 里是 `?? []`，
      // undefined 与"不传"等价（三元算子评估后简化）。
      allowProviders: this.opts.allowProviders,
      extraKeys: envTemplateKeys,
    });
    for (const [k, v] of Object.entries(this.opts.envTemplate ?? {})) env[k] = renderTemplate(v, vars);
    // 诊断（只记名字、永不记值）：如实报告最小化环境裁掉了哪些密钥变量，
    // 让操作员能核对"没有误裁、也没有漏裁"。droppedSecretNames 与上面
    // scopedEnv 的过滤参数完全一致，两处必须同步改。日志在 session 创建后
    // 补推（见下方 spawn 日志前），进该 run 的事件流留证据。
    const dropped = droppedSecretNames({
      allowProviders: this.opts.allowProviders,
      extraKeys: envTemplateKeys,
    });

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
        // 2026-09-28：同 probe() —— 直接传值，位点消灭（Linux 上该选项不可观测）。
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
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

    if (dropped.length > 0) {
      session.push("log", `[${this.meta.id}] 已从子进程环境裁掉 ${dropped.length} 个密钥变量（只记名字）：${dropped.join(", ")}`);
    }
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
    // `title` / `zone` come from model output. Rendering them through
    // `inlineField` keeps a newline in either one from injecting a fake `##`
    // section that contradicts the real constraints below it. `zone` is also
    // whitelisted at the schema, so this is the second layer.
    const lines = [
      `# 任务：${inlineField(payload.title)}`,
      "",
      `- 任务 id：${inlineField(payload.taskId)}`,
      `- 所属区域（zone）：${inlineField(payload.zone)}`,
      `- 项目根目录：${path.resolve(payload.projectRoot)}`,
      "",
      "## 要求",
      "",
      payload.description,
      "",
      `## 约束`,
      "",
      `- 只能创建或修改 zone「${inlineField(payload.zone)}」内的文件；其它路径一律不要动。`,
      `- 完成后请确保项目能通过构建与测试。`,
    ];
    if (payload.repairContext) {
      lines.push(
        "",
        `## 这是第 ${payload.repairContext.round} 轮修复`,
        "",
        "上一轮失败日志摘要：",
        "",
        // `errorLogDigest` is raw child output: it can contain a fence of its
        // own, which would close the block early and spill the rest into the
        // prompt as ordinary text. `fencedBlock` lengthens the fence past any
        // run of backticks in the content, so the block always holds.
        fencedBlock(tail(payload.repairContext.errorLogDigest, PROMPT_EXCERPT)),
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
