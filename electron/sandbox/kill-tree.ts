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
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { shell: false, stdio: "ignore" });
      return;
    } catch {
      // fall through to the portable path
    }
  }
  try {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, opts.graceMs ?? 2_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    // already gone
  }
}

/** True when the process (and therefore its tree) has exited. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
