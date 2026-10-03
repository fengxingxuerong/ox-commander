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
    // 锁 win32 + 断言 taskkill 确实被 spawn：@32 行 `process.platform === "win32"`
    // 的 `!== → ===` 变异会让 win32 宿主在 Linux CI 上走 POSIX 直调（无
    // taskkill 记录），这条断言立刻暴露路径走错。
    withPlatform("win32", () => {
      const killer = fakeKiller();
      h.spawnImpl = () => killer as never;
      const child = fakeChild();
      expect(() => killTree(child, { graceMs: 5 })).not.toThrow();
      killer.emit("error", new Error("taskkill blocked by policy"));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(h.spawnCalls.some((c) => c.cmd === "taskkill")).toBe(true);
    });
  });

  it("falls back when taskkill exits non-zero (tree may still be alive)", () => {
    const killer = fakeKiller();
    h.spawnImpl = () => killer as never;
    const child = fakeChild();
    killTree(child, { graceMs: 5 });
    killer.emit("exit", 1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("taskkill 报成功（exit 0）时不触发 fallback —— 补刀只由 double-check 决定", async () => {
    // 钉 @32 行 `if (code !== 0) fallback()`：`!== → ===` 变异会让 taskkill
    // **报成功**时反而立即 fallback 杀。最终 kill 次数被 post-grace
    // double-check 兜底到相同，唯一可观察差异是**时机** —— exit 0 的同步
    // 窗口内原版绝不杀（等宽限期），变异版立即杀。同步断言无竞态地把两者分开。
    await withPlatform("win32", async () => {
      const killer = fakeKiller();
      h.spawnImpl = () => killer as never;
      const child = fakeChild();
      killTree(child, { graceMs: 50 });
      killer.emit("exit", 0);
      expect(child.kill).not.toHaveBeenCalled(); // 变异版这里就挂
      await sleep(100);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM"); // double-check 补刀
    });
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
    // withPlatform("win32") 是这条用例的灵魂：post-grace double-check（37 行
    // 的 verify timer）只存在于 win32 分支里。不锁平台的话，Linux CI 上这条
    // 用例走 POSIX 直调（同样会 SIGKILL），对 double-check 的三个 `===`
    // 完全不可观察 —— 2026-09-23 CI 首跑抓到的三处存活正是这么来的。
    await withPlatform("win32", async () => {
      h.spawnImpl = () => fakeKiller() as never;
      const child = fakeChild();
      killTree(child, { graceMs: 10 });
      await sleep(60);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  it("does not re-kill a child that already exited within the grace window", async () => {
    await withPlatform("win32", async () => {
      h.spawnImpl = () => fakeKiller() as never;
      const child = fakeChild({ exitCode: 0 });
      killTree(child, { graceMs: 10 });
      await sleep(60);
      expect(child.kill).not.toHaveBeenCalled();
    });
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

  /**
   * 生产上**没有一处**传 `graceMs`：`verifier.ts:96/406`、`dev-server.ts:84`、
   * `cli-agent.ts:313` 三个调用点全是 `killTree(child)`。
   *
   * 也就是说 `?? 2_000`（`kill-tree.ts:14` 与 `:45`）才是真正在跑的那个值 ——
   * 而既有 18 条用例里每一条都显式传了自己的 graceMs（1/5/10/30/50/500），
   * 那条不传的（`guards` 里两条）又都在 `pid === undefined` 守卫处提前 return，
   * **永远走不到默认值**。于是"默认值被改成 20ms"这种改动可以全绿通过。
   *
   * 判据用"默认窗口内不升级、窗口后才升级"夹逼，而不是硬等 2 秒 ——
   * 既钉住了量级（不是 20ms 也不是 20s），又不用让门禁多跑 2 秒。
   */
  describe("默认 graceMs（生产真正在用的那个值）", () => {
    it("POSIX 路径：默认 2000ms 宽限期内只发 SIGTERM，之后才升级 SIGKILL", async () => {
      await withPlatform("linux", async () => {
        const child = fakeChild();
        killTree(child); // 不传 graceMs —— 与生产三个调用点同形
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");

        // 默认值若被改成 50ms，这里就已经升级过了 → 变异版会红。
        await sleep(300);
        expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
        expect(child.kill).toHaveBeenCalledTimes(1); // 窗口内绝不重复杀

        // 过了 2s 窗口必须升级，否则"杀干净"这条承诺是空的。
        await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGKILL"), { timeout: 4000 });
      });
    });

    it("win32 路径：post-grace double-check 同样吃这个默认值", async () => {
      await withPlatform("win32", async () => {
        const killer = fakeKiller();
        h.spawnImpl = () => killer as never;
        const child = fakeChild();
        killTree(child); // 不传 graceMs
        killer.emit("exit", 0); // taskkill 报成功 → 不走 fallback

        // 宽限期内不得补刀：这条断言把"默认 2000ms"和"默认 0ms"分开。
        await sleep(300);
        expect(child.kill).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"), { timeout: 4000 });
      });
    });
  });

  it("reports exit state from either exit code or signal", () => {
    expect(hasExited({ exitCode: 0, signalCode: null } as never)).toBe(true);
    expect(hasExited({ exitCode: 1, signalCode: null } as never)).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: "SIGTERM" } as never)).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: null } as never)).toBe(false);
  });
});
