import { spawn } from "node:child_process";
import type { VerificationCommand, VerificationReport } from "../../shared/types";
import { digest } from "./scheduler";
import { CommandPolicy, createDefaultCommandPolicy } from "../sandbox/command-policy";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";

export interface VerifierDeps {
  cwd: () => string;
  spawnImpl?: typeof spawn;
  /**
   * Structural gate for the configured commands. Defaults to the built-in
   * policy (allow common build/test toolchains, refuse destructive programs and
   * shell metacharacters).
   */
  policy?: CommandPolicy;
  /** Per-command ceiling; the process tree is killed when it expires. 300s default. */
  timeoutMs?: number;
  /** Observability sink (rejections, timeouts). */
  onEvent?: (text: string) => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

function runOnce(
  cmd: VerificationCommand,
  cwd: string,
  spawnImpl: typeof spawn,
  timeoutMs: number,
  onEvent?: (text: string) => void,
): Promise<{ kind: typeof cmd.kind; ok: boolean; exitCode: number | null; log: string; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // `shell: false` on every platform: the argv reaches the program verbatim.
    // Windows `.cmd` shims (npm, yarn, gradle) cannot be spawned that way, so
    // `buildSpawnSpec` wraps them in `cmd.exe /d /s /c` — safe only because the
    // CommandPolicy gate above already rejected shell metacharacters.
    const plan = buildSpawnSpec(cmd.command, cmd.args);
    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(plan.file, plan.args, {
        cwd,
        shell: false,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      resolve({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        log: `spawn failed (${plan.note}): ${String(err)}`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let log = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onEvent?.(`[verifier] ${cmd.command} 超过 ${Math.round(timeoutMs / 1000)}s，终止进程树`);
      killTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => (log += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (log += c.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        log: `spawn failed (${plan.note}): ${String(err)}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const finalLog = timedOut ? `${log}\n[沙箱] 超过 ${timeoutMs}ms，已终止进程树` : log;
      resolve({
        kind: cmd.kind,
        ok: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        log: finalLog,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Runs build → typecheck → test in order and stops at the first failure.
 *
 * Sandbox gate (P3): every configured command is checked against the
 * CommandPolicy first. A rejected command is reported as a failed step carrying
 * the reason instead of being spawned, so a bad setting cannot silently execute
 * something destructive — the pipeline treats it like any other failed
 * verification and goes into repair.
 */
export async function verifyProject(
  commands: VerificationCommand[],
  deps: VerifierDeps,
): Promise<VerificationReport> {
  const results: VerificationReport["results"] = [];
  const spawnImpl = deps.spawnImpl ?? spawn;
  const policy = deps.policy ?? createDefaultCommandPolicy();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  for (const cmd of commands) {
    const verdict = policy.check(cmd.command, cmd.args);
    if (!verdict.ok) {
      deps.onEvent?.(`[verifier] 拒绝执行：${verdict.reason}`);
      results.push({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 命令被拒绝：${verdict.reason}`,
        durationMs: 0,
      });
      break;
    }
    const r = await runOnce(cmd, deps.cwd(), spawnImpl, timeoutMs, deps.onEvent);
    results.push({
      kind: r.kind,
      ok: r.ok,
      exitCode: r.exitCode,
      logDigest: digest(r.log),
      durationMs: r.durationMs,
    });
    if (!r.ok) break;
  }
  return { passed: results.every((r) => r.ok), results };
}
