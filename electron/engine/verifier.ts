import { spawn } from "node:child_process";
import type { VerificationCommand, VerificationReport } from "../../shared/types";
import { digest } from "./scheduler";

export interface VerifierDeps {
  cwd: () => string;
  spawnImpl?: typeof spawn;
}

function runOnce(
  cmd: VerificationCommand,
  cwd: string,
  spawnImpl: typeof spawn,
): Promise<{ kind: typeof cmd.kind; ok: boolean; exitCode: number | null; log: string; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawnImpl(cmd.command, cmd.args, { cwd, shell: process.platform === "win32" });
    let log = "";
    child.stdout?.on("data", (c: Buffer) => (log += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (log += c.toString("utf8")));
    child.on("error", (err) => {
      resolve({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        log: `spawn failed: ${String(err)}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      resolve({
        kind: cmd.kind,
        ok: code === 0,
        exitCode: code,
        log,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Runs build → typecheck → test in order and stops at the first failure. */
export async function verifyProject(
  commands: VerificationCommand[],
  deps: VerifierDeps,
): Promise<VerificationReport> {
  const results: VerificationReport["results"] = [];
  const spawnImpl = deps.spawnImpl ?? spawn;
  for (const cmd of commands) {
    const r = await runOnce(cmd, deps.cwd(), spawnImpl);
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
