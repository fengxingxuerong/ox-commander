import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ChildProcess } from "node:child_process";
import { hasExited, killTree } from "../electron/sandbox/kill-tree";

/**
 * `killTree` is the sandbox's last line of defence: a build that survives a
 * timeout keeps burning CPU (or holds file locks) forever. The A3 hardening
 * added an async `error` listener + non-zero-exit fallback + a post-grace
 * double-check — exactly the branches a synchronous try/catch never reaches,
 * and exactly the branches this file pins.
 *
 * Strategy: the `node:child_process` module is mocked with a pass-through that
 * tests can swap for a controllable fake "killer". The success path uses the
 * REAL taskkill against a REAL spawned node process, so the gate proves the
 * happy path on the actual platform, not just against doubles.
 */

const h = vi.hoisted(() => ({
  spawnImpl: null as null | ((cmd: string, args: readonly string[], opts: unknown) => unknown),
  spawnCalls: [] as Array<{ cmd: string; args: readonly string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    spawn: vi.fn((cmd: string, args: readonly string[], opts: unknown) => {
      h.spawnCalls.push({ cmd, args });
      if (h.spawnImpl) return h.spawnImpl(cmd, args, opts) as never;
      return mod.spawn(cmd, args, opts as never) as never;
    }),
  };
});

function fakeChild(over: Partial<{ pid: number | undefined; exitCode: number | null; signalCode: string | null }> = {}) {
  return {
    pid: 4321 as number | undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    ...over,
  } as unknown as ChildProcess & { kill: Mock };
}

/** A controllable stand-in for the taskkill ChildProcess (on/exit events). */
function fakeKiller() {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      const list = handlers.get(ev) ?? [];
      list.push(cb);
      handlers.set(ev, list);
    }),
    emit: (ev: string, ...args: unknown[]) => {
      for (const cb of handlers.get(ev) ?? []) cb(...args);
    },
  };
}

function withPlatform(value: NodeJS.Platform, fn: () => void | Promise<void>): Promise<void> | void {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  const done = fn();
  if (done instanceof Promise) {
    return done.finally(() => {
      if (desc) Object.defineProperty(process, "platform", desc);
    });
  }
  if (desc) Object.defineProperty(process, "platform", desc);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  h.spawnImpl = null;
  h.spawnCalls.length = 0;
});

describe("killTree · success path (real taskkill)", () => {
  it("kills a real long-running process and never needs the fallback", async () => {
    if (process.platform !== "win32") return;
    const { spawn } = (await import("node:child_process")) as typeof import("node:child_process");
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1<<30)"], { stdio: "ignore" });
    await sleep(150); // let the child actually boot
    killTree(victim, { graceMs: 500 });
    await vi.waitFor(
      () => expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true),
      { timeout: 4000 },
    );
    // taskkill ran through the mocked seam and reported success, so the
    // post-grace double-check must not have escalated on its own.
    expect(h.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(true);
    expect(victim.signalCode).not.toBe("SIGKILL");
  });
});

describe("killTree · fallback paths", () => {
  it("falls back to a portable kill when taskkill cannot even spawn", () => {
    const killer = fakeKiller();
    h.spawnImpl = () => killer as never;
    const child = fakeChild();
    expect(() => killTree(child, { graceMs: 5 })).not.toThrow();
    killer.emit("error", new Error("taskkill blocked by policy"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back when taskkill exits non-zero (tree may still be alive)", () => {
    const killer = fakeKiller();
    h.spawnImpl = () => killer as never;
    const child = fakeChild();
    killTree(child, { graceMs: 5 });
    killer.emit("exit", 1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never registers a second fallback after the first one fired", () => {
    const killer = fakeKiller();
    h.spawnImpl = () => killer as never;
    const child = fakeChild();
    killTree(child, { graceMs: 30 });
    killer.emit("error", new Error("first"));
    killer.emit("exit", 1);
    killer.emit("error", new Error("second"));
    expect(child.kill).toHaveBeenCalledTimes(1); // fellBack guard holds
  });

  it("swallows errors thrown by kill on an already-dead child", () => {
    const killer = fakeKiller();
    h.spawnImpl = () => killer as never;
    const child = fakeChild();
    (child.kill as Mock).mockImplementation(() => {
      throw new Error("process already gone");
    });
    expect(() => killTree(child, { graceMs: 5 })).not.toThrow();
    expect(() => killer.emit("error", new Error("taskkill blocked"))).not.toThrow();
  });
});

describe("killTree · post-grace double-check", () => {
  it("escalates to SIGKILL when the child is still alive after the grace window", async () => {
    h.spawnImpl = () => fakeKiller() as never;
    const child = fakeChild();
    killTree(child, { graceMs: 10 });
    await sleep(60);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not re-kill a child that already exited within the grace window", async () => {
    h.spawnImpl = () => fakeKiller() as never;
    const child = fakeChild({ exitCode: 0 });
    killTree(child, { graceMs: 10 });
    await sleep(60);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("killTree · guards", () => {
  it("does nothing for a child without a pid", () => {
    h.spawnImpl = () => {
      throw new Error("must not spawn");
    };
    const child = fakeChild({ pid: undefined });
    expect(() => killTree(child)).not.toThrow();
  });

  it("does not even attempt to spawn a killer when the pid is missing", async () => {
    // 上一条用例看不到这个：它让 `spawnImpl` 抛错，而 `killTree` 的 win32 分支
    // 把 spawn 包在 try/catch 里（故意如此，"spawn 失败要落回可移植路径"），
    // 于是"本不该 spawn 却 spawn 了"这件事被吞掉、测试照样绿。
    //
    // 守卫是 `if (!child || child.pid === undefined) return`。
    // 改成 `&&` 后，`{pid: undefined}` 会一路走到 `spawn("taskkill", …)`，
    // 带着字面量 "undefined" 去杀一个不存在的 PID。
    //
    // 固定为 win32：只有那条分支才会 spawn（非 Windows 直接走 portableKill）。
    await withPlatform("win32", async () => {
      h.spawnCalls.length = 0;
      const child = fakeChild({ pid: undefined });
      killTree(child);
      expect(h.spawnCalls).toHaveLength(0);
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("uses plain SIGTERM→SIGKILL escalation off Windows", async () => {
    await withPlatform("linux", async () => {
      const child = fakeChild();
      killTree(child, { graceMs: 5 });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await sleep(40);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  it("reports exit state from either exit code or signal", () => {
    expect(hasExited({ exitCode: 0, signalCode: null } as never)).toBe(true);
    expect(hasExited({ exitCode: 1, signalCode: null } as never)).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: "SIGTERM" } as never)).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: null } as never)).toBe(false);
  });
});
