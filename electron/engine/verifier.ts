import { spawn } from "node:child_process";
import type { SmokeCheck, VerificationCommand, VerificationReport } from "../../shared/types";
import { digest } from "./scheduler";
import { CommandPolicy, createDefaultCommandPolicy } from "../sandbox/command-policy";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";
import { scopedEnv } from "../agents/scoped-env";

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

/**
 * Byte budget for one command's captured output (aligned with the agent
 * `maxStdoutBytes` default). Without it a pathological build script stuck in a
 * print loop balloons memory per verification round. The stream is ALWAYS
 * drained — only the accumulation stops — so the child never blocks on a full
 * pipe; the budget is enforced at chunk granularity (worst case overshoot is
 * one pipe chunk).
 */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

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
        // 验证命令跑的是智能体刚写下的脚本。默认继承 process.env 会把手上的
        // 每一把 provider key 交给它 —— 桌面端的 keychain 正是播种进 process.env 的。
        env: scopedEnv(),
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
    let logBytes = 0;
    let droppedBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onEvent?.(`[verifier] ${cmd.command} 超过 ${Math.round(timeoutMs / 1000)}s，终止进程树`);
      killTree(child);
    }, timeoutMs);

    const onChunk = (c: Buffer): void => {
      if (logBytes >= MAX_LOG_BYTES) {
        droppedBytes += c.length;
        return;
      }
      logBytes += c.length;
      log += c.toString("utf8");
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
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
      let finalLog = timedOut ? `${log}\n[沙箱] 超过 ${timeoutMs}ms，已终止进程树` : log;
      if (droppedBytes > 0) {
        finalLog += `\n[沙箱] 输出超过 ${Math.round(MAX_LOG_BYTES / 1024)}KB 预算，已丢弃约 ${Math.round(droppedBytes / 1024)}KB`;
      }
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

export interface SmokeRunnerDeps {
  cwd: string;
  spawnImpl?: typeof spawn;
  /** 冒烟命令同样过沙箱门（默认策略）。 */
  policy?: CommandPolicy;
  timeoutMs?: number;
  onEvent?: (text: string) => void;
}

/**
 * 独立样本冒烟：运行规划期生成的真实样例命令（防自证盲区层）。
 *
 * 与 verifyProject 的区别：命令来自大脑的 decompose 产物（针对交付后的主入口），
 * 支持通过 stdin 喂样例数据，且 ok = 退出码 0 且 stdout 包含全部 expectContains
 * 片段。同样过 CommandPolicy 沙箱门 —— 冒烟命令也不得越界。首败即停，
 * 与 verifyProject 保持一致，让失败进入重修循环。
 */
export async function runSmokeChecks(
  checks: SmokeCheck[],
  deps: SmokeRunnerDeps,
): Promise<VerificationReport["results"]> {
  const results: VerificationReport["results"] = [];
  const spawnImpl = deps.spawnImpl ?? spawn;
  const policy = deps.policy ?? createDefaultCommandPolicy();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  for (const check of checks) {
    const verdict = policy.check(check.command, check.args);
    if (!verdict.ok) {
      results.push({
        kind: "smoke",
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 冒烟命令被拒绝：${verdict.reason}\n[${check.title}]`,
        durationMs: 0,
      });
      break;
    }

    const startedAt = Date.now();
    const plan = buildSpawnSpec(check.command, check.args);
    const output = await new Promise<string>((resolve) => {
      let timedOut = false;
      let child: ReturnType<typeof spawnImpl>;
      try {
        child = spawnImpl(plan.file, plan.args, {
          cwd: deps.cwd,
          shell: false,
          // 同 runOnce：冒烟命令也是智能体写的代码，不给它看凭证。
          env: scopedEnv(),
          ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch (err) {
        resolve(`spawn failed (${plan.note}): ${String(err)}`);
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        deps.onEvent?.(`[smoke] ${check.title} 超过 ${Math.round(timeoutMs / 1000)}s，终止进程树`);
        killTree(child);
      }, timeoutMs);
      // Same byte budget as runOnce. Note: expect-fragment matching runs
      // against the capped log — a fragment past the budget reads as missing,
      // which is the honest outcome for output that large anyway.
      let log = "";
      let logBytes = 0;
      let droppedBytes = 0;
      const onChunk = (c: Buffer): void => {
        if (logBytes >= MAX_LOG_BYTES) {
          droppedBytes += c.length;
          return;
        }
        logBytes += c.length;
        log += c.toString("utf8");
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`${log}\nspawn failed: ${String(err)}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const droppedMark =
          droppedBytes > 0
            ? `\n[沙箱] 输出超过 ${Math.round(MAX_LOG_BYTES / 1024)}KB 预算，已丢弃约 ${Math.round(droppedBytes / 1024)}KB`
            : "";
        resolve(`${log}${droppedMark}\n[exit]${timedOut ? "timeout" : String(code)}`);
      });
      if (check.stdin !== undefined) child.stdin?.write(check.stdin);
      child.stdin?.end();
    });

    const timedOut = output.includes("\n[exit]timeout");
    const exitMatch = /\n\[exit\](\d+)/.exec(output);
    const missing = (check.expectContains ?? []).filter((frag) => !output.includes(frag));
    const ok = !timedOut && exitMatch !== null && exitMatch[1] === "0" && missing.length === 0;

    const digestParts = [
      `[smoke] ${check.title}`,
      `命令：${check.command} ${check.args.join(" ")}`,
      output,
    ];
    if (missing.length > 0) digestParts.push(`缺失期望片段：${JSON.stringify(missing)}`);

    results.push({
      kind: "smoke",
      ok,
      exitCode: timedOut ? null : exitMatch ? Number(exitMatch[1]) : null,
      logDigest: digest(digestParts.join("\n")),
      durationMs: Date.now() - startedAt,
    });
    if (!ok) break;
  }
  return results;
}

