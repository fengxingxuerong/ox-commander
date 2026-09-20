import { spawn, type ChildProcess } from "node:child_process";

/**
 * Kills a process **tree**.
 *
 * A bare `child.kill()` orphans grandchildren on every platform, and on Windows
 * a `.cmd` shim (npm/yarn/gradle) always has at least one — leaving a build
 * running after the run was aborted. `taskkill /T` is the only reliable way to
 * take the whole tree down there.
 */
export function killTree(child: ChildProcess, opts: { graceMs?: number } = {}): void {
  if (!child || child.pid === undefined) return;
  if (process.platform === "win32") {
    const graceMs = opts.graceMs ?? 2_000;
    let fellBack = false;
    // `spawn` reports failure asynchronously: a missing/blocked taskkill emits
    // 'error' later, so a surrounding try/catch alone would leave the tree
    // alive AND emit an unhandled error event that takes the host down.
    const fallback = (): void => {
      if (fellBack) return;
      fellBack = true;
      portableKill(child, graceMs);
    };
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        shell: false,
        stdio: "ignore",
      });
      killer.on("error", fallback);
      killer.on("exit", (code) => {
        // Non-zero exit means the tree may well still be alive.
        if (code !== 0) fallback();
      });
      // Belt and braces: if the child is still alive after the grace window,
      // kill it directly even when taskkill reported success.
      const verify = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) portableKill(child, 0);
      }, graceMs);
      (verify as unknown as { unref?: () => void }).unref?.();
      return;
    } catch {
      // fall through to the portable path
    }
  }
  portableKill(child, opts.graceMs ?? 2_000);
}

/** SIGTERM → SIGKILL escalation; the only path available off Windows. */
function portableKill(child: ChildProcess, graceMs: number): void {
  try {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, graceMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // already gone
  }
}

/** True when the process (and therefore its tree) has exited. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
