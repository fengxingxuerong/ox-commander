import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});
import {
  CommandPolicy,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_DENIED_COMMANDS,
  createDefaultCommandPolicy,
} from "../electron/sandbox/command-policy";
import { resolveCommand } from "../electron/sandbox/spawn-plan";
import { TimeoutError, TimeoutGate } from "../electron/sandbox/timeout-gate";
import { CircuitBreaker } from "../electron/sandbox/circuit-breaker";
import { verifyProject } from "../electron/engine/verifier";
import type { VerificationCommand } from "../shared/types";

describe("CommandPolicy", () => {
  it("allows the commands real toolchains need", () => {
    const p = createDefaultCommandPolicy();
    expect(p.check("npm", ["run", "build"]).ok).toBe(true);
    expect(p.check("node", ["ox-scripts/build.js"]).ok).toBe(true);
    expect(p.check("git", ["status", "--porcelain"]).ok).toBe(true);
    expect(p.check("python", ["-m", "pytest", "-q"]).ok).toBe(true);
  });

  it("resolves a command by its base name, whatever the path or extension", () => {
    const p = createDefaultCommandPolicy();
    expect(p.check("/usr/local/bin/node", ["-v"]).ok).toBe(true);
    expect(p.check("C:\\Program Files\\nodejs\\node.exe", ["-v"]).ok).toBe(true);
    expect(p.check("npm.cmd", ["run", "test"]).ok).toBe(true);
  });

  it("refuses destructive programs", () => {
    const p = createDefaultCommandPolicy();
    for (const cmd of ["rm", "del", "format", "shutdown", "powershell", "curl", "sudo"]) {
      const d = p.check(cmd, ["-rf", "/"]);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toContain("禁止");
    }
  });

  it("refuses anything outside the allow list", () => {
    const d = createDefaultCommandPolicy().check("mycustom-tool", ["--go"]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("白名单");
  });

  it("lets the deny list win over the allow list", () => {
    const p = new CommandPolicy({ allow: ["rm", ...DEFAULT_ALLOWED_COMMANDS] });
    expect(p.check("rm", ["-rf", "x"]).ok).toBe(false);
  });

  it("refuses shell metacharacters in the command or any argument", () => {
    const p = createDefaultCommandPolicy();
    const bad = [
      ["npm", ["run", "build; rm -rf /"]],
      ["npm", ["run", "build", "&&", "echo pwned"]],
      ["npm", ["run", "test|cat /etc/passwd"]],
      ["npm", ["run", "build > out.txt"]],
      ["npm", ["run", "build$(whoami)"]],
      ["npm", ["run", "build`id`"]],
      ["npm", ["run", "build\nrm -rf /"]],
    ] as const;
    for (const [cmd, args] of bad) {
      const d = p.check(cmd, [...args]);
      expect(d.ok, `${cmd} ${args.join(" ")} should be rejected`).toBe(false);
      if (!d.ok) expect(d.reason).toContain("元字符");
    }
  });

  it("refuses inline evaluation, which would sidestep the allow list entirely", () => {
    const p = createDefaultCommandPolicy();
    for (const [cmd, args] of [
      ["node", ["-e", "require('node:fs').rmSync('.', { recursive: true })"]],
      ["node", ["--eval", "1"]],
      ["node", ["-p", "process.env"]],
      ["python", ["-c", "import os"]],
    ] as const) {
      const d = p.check(cmd, [...args]);
      expect(d.ok, `${cmd} ${args.join(" ")} should be rejected`).toBe(false);
    }
    // The rejection is attributed to the eval rule when nothing else trips first.
    const d = p.check("node", ["-e", "1"]);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("内联求值");
    // A script file stays allowed — that is the supported way to run code.
    expect(p.check("node", ["scripts/check.js"]).ok).toBe(true);
    // And the rule can be lifted for a reviewed toolchain.
    expect(new CommandPolicy({ denyEvalFlags: false }).check("node", ["-e", "1"]).ok).toBe(true);
  });

  it("can be told to permit metacharacters for an exotic toolchain", () => {
    const p = new CommandPolicy({ denyShellMetacharacters: false });
    expect(p.check("npm", ["run", "build", "&&", "echo ok"]).ok).toBe(true);
  });

  it("refuses history-rewriting git subcommands", () => {
    const p = createDefaultCommandPolicy();
    for (const sub of ["push", "reset", "clean", "filter-branch", "config"]) {
      const d = p.check("git", [sub]);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toContain("git 子命令");
    }
    expect(p.check("git", ["diff"]).ok).toBe(true);
  });

  it("exposes a summary for the settings panel", () => {
    const s = createDefaultCommandPolicy().describe();
    expect(s.allowed).toContain("npm");
    expect(s.denied).toContain("rm");
    expect(s.denied.length).toBe(DEFAULT_DENIED_COMMANDS.length);
  });

  it("assert() throws with the same reason", () => {
    expect(() => createDefaultCommandPolicy().assert("rm", ["-rf", "/"])).toThrow(/禁止/);
  });
});

describe("resolveCommand", () => {
  it("returns the input when nothing matches", () => {
    expect(resolveCommand("ox-missing-binary-xyz", { PATH: "" }, "linux")).toBe("ox-missing-binary-xyz");
  });

  it("resolves a real binary from PATH", () => {
    const dir = path.dirname(process.execPath);
    const resolved = resolveCommand("node", { PATH: dir });
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("passes an absolute path straight through", () => {
    expect(resolveCommand(process.execPath)).toBe(process.execPath);
  });

  it("appends PATHEXT candidates on win32 only", () => {
    const dir = scratch("resolve");
    const shim = path.join(dir, "mytool.cmd");
    fs.writeFileSync(shim, "@echo off\n");
    expect(resolveCommand("mytool", { PATH: dir }, "win32")).toBe(shim);
    // On POSIX the same lookup must not invent a .cmd hit.
    expect(resolveCommand("mytool", { PATH: dir }, "linux")).toBe("mytool");
  });
});

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  dirs.push(dir);
  return dir;
}

// ── TimeoutGate ─────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 1_000;
  let seq = 0;
  const jobs: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const job = { id: ++seq, at: now + ms, fn };
      jobs.push(job);
      return job as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => {
      const i = jobs.findIndex((j) => j === (t as unknown as { id: number }));
      if (i >= 0) jobs.splice(i, 1);
    },
    advance: (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = jobs.filter((j) => j.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        jobs.splice(jobs.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    pending: () => jobs.length,
  };
}

describe("TimeoutGate", () => {
  function gate(clock = fakeClock()) {
    const g = new TimeoutGate({
      deadlineMs: 10_000,
      idleTimeoutMs: 3_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { g, clock };
  }

  it("trips on the deadline when activity keeps arriving", () => {
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r1" }, (reason) => trips.push(reason));
    for (let i = 0; i < 4; i++) {
      clock.advance(2_000);
      g.touch("r1");
    }
    clock.advance(2_100);
    expect(trips).toEqual(["deadline"]);
    expect(g.tripped("r1")).toBe("deadline");
  });

  it("trips on idle before the deadline when nothing arrives", () => {
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r2" }, (reason) => trips.push(reason));
    clock.advance(3_100);
    expect(trips).toEqual(["idle"]);
    expect(g.tripped("r2")).toBe("idle");
  });

  it("re-arms the idle window on every touch", () => {
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r3" }, (reason) => trips.push(reason));
    for (let i = 0; i < 3; i++) {
      clock.advance(2_000);
      g.touch("r3");
    }
    expect(trips).toEqual([]);
    clock.advance(3_100); // idle expires before the deadline would
    expect(trips).toEqual(["idle"]);
  });

  it("fires at most once per run", () => {
    const { g, clock } = gate();
    let count = 0;
    g.attach({ id: "r4" }, () => count++);
    clock.advance(3_100);
    clock.advance(30_000);
    expect(count).toBe(1);
  });

  it("touch 一个未在监控中的 id 静默返回，不会误伤其它 run", () => {
    // `if (!w || w.tripped) return` —— 变异成 `&&` 后，未知 id 会走到
    // `w.tripped` 并在 undefined 上抛 TypeError。这条钉住"未知 id 必须静默"。
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r6" }, (reason) => trips.push(reason));
    expect(() => g.touch("no-such-run")).not.toThrow();
    expect(g.activeCount()).toBe(1); // 没把正在监控的 run 弄丢
    clock.advance(3_100);
    expect(trips).toEqual(["idle"]);
  });

  it("TimeoutError 的消息与 reason 严格对应（不能互换）", () => {
    // `reason === "deadline" ? "超出总时限" : "空闲超时"` —— 变异成 `!==` 会把
    // 两种原因的文案互换，而只断言 `reason` 字段的用例照样全绿。
    const dl = new TimeoutError("r", "deadline").message;
    const idle = new TimeoutError("r", "idle").message;
    expect(dl).toContain("超出总时限");
    expect(dl).not.toContain("空闲超时");
    expect(idle).toContain("空闲超时");
    expect(idle).not.toContain("超出总时限");
  });

  it("stops watching after detach", () => {
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r5" }, (reason) => trips.push(reason));
    g.detach("r5");
    clock.advance(30_000);
    expect(trips).toEqual([]);
    expect(g.activeCount()).toBe(0);
  });

  it("supports per-run overrides", () => {
    const { g, clock } = gate();
    const trips: string[] = [];
    g.attach({ id: "r6", idleTimeoutMs: 500 }, (reason) => trips.push(reason));
    clock.advance(600);
    expect(trips).toEqual(["idle"]);
  });

  it("guard() rejects with a labelled TimeoutError and detaches on success", async () => {
    const { g, clock } = gate();
    g.attach({ id: "r7" }, () => undefined);
    const never = new Promise<string>(() => undefined);
    const guarded = g.guard("r7", never);
    clock.advance(3_100);
    await expect(guarded).rejects.toBeInstanceOf(TimeoutError);

    g.attach({ id: "r8" }, () => undefined);
    await expect(g.guard("r8", Promise.resolve("ok"))).resolves.toBe("ok");
    expect(g.activeCount()).toBe(0);
  });
});

// ── CircuitBreaker ──────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  function breaker(opts: { threshold?: number; openMs?: number } = {}) {
    let now = 0;
    const events: string[] = [];
    const b = new CircuitBreaker({
      failureThreshold: opts.threshold ?? 3,
      openMs: opts.openMs ?? 60_000,
      now: () => now,
      onEvent: (t) => events.push(t),
    });
    return { b, events, advance: (ms: number) => (now += ms) };
  }

  it("查询一个从未记录过的 id：state 为 closed 且 retryInMs 为 0，不抛异常", () => {
    // `state === "open" && e?.openedAt !== null` —— 变异成 `||` 后，
    // 未知 id 的 `e?.openedAt` 是 **undefined**，而 `undefined !== null` 为真，
    // 于是短路失败、继续去读 `e!.openedAt!` 并在 undefined 上抛 TypeError。
    // 这条同时钉住"stats 未知 id 必须健壮"。
    const { b } = breaker();
    expect(() => b.stats("never-seen")).not.toThrow();
    const s = b.stats("never-seen");
    expect(s.state).toBe("closed");
    expect(s.retryInMs).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("starts closed and stays closed below the threshold", () => {
    const { b } = breaker();
    expect(b.state("a")).toBe("closed");
    b.recordFailure("a");
    b.recordFailure("a");
    expect(b.state("a")).toBe("closed");
    expect(b.allow("a")).toBe(true);
  });

  it("opens after the configured number of consecutive failures", () => {
    const { b, events } = breaker();
    b.recordFailure("a");
    b.recordFailure("a");
    b.recordFailure("a");
    expect(b.state("a")).toBe("open");
    expect(b.allow("a")).toBe(false);
    expect(events.some((e) => e.includes("熔断"))).toBe(true);
  });

  it("a success resets the consecutive counter", () => {
    const { b } = breaker();
    b.recordFailure("a");
    b.recordFailure("a");
    b.recordSuccess("a");
    b.recordFailure("a");
    expect(b.state("a")).toBe("closed");
    expect(b.stats("a").successes).toBe(1);
  });

  it("moves to half-open after the open window and admits exactly one probe", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure("a");
    advance(59_999);
    expect(b.state("a")).toBe("open");
    advance(2);
    expect(b.state("a")).toBe("half-open");
    expect(b.allow("a")).toBe(true); // the probe
    expect(b.allow("a")).toBe(false); // nobody else gets in while it runs
  });

  it("closes on a successful probe", () => {
    const { b, advance, events } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure("a");
    advance(60_001);
    expect(b.allow("a")).toBe(true);
    b.recordSuccess("a");
    expect(b.state("a")).toBe("closed");
    expect(events.some((e) => e.includes("关闭"))).toBe(true);
  });

  it("re-opens (with a fresh window) when the probe fails", () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure("a");
    advance(60_001);
    expect(b.allow("a")).toBe(true);
    b.recordFailure("a");
    expect(b.state("a")).toBe("open");
    expect(b.stats("a").retryInMs).toBe(60_000);
  });

  it("reports a sliding success rate for the router", () => {
    const { b } = breaker();
    b.recordSuccess("a");
    b.recordSuccess("a");
    b.recordFailure("a");
    const stats = b.stats("a");
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(1);
    expect(stats.successRate).toBeCloseTo(2 / 3, 5);
    expect(b.statsProvider()("a").circuit).toBe("closed");
  });

  it("keeps agents independent and can be reset", () => {
    const { b } = breaker();
    for (let i = 0; i < 3; i++) b.recordFailure("a");
    expect(b.state("a")).toBe("open");
    expect(b.state("b")).toBe("closed");
    b.reset("a");
    expect(b.state("a")).toBe("closed");
    for (let i = 0; i < 3; i++) b.recordFailure("a");
    b.reset();
    expect(b.snapshot()).toEqual({});
  });
});

// ── verifier integration ────────────────────────────────────────────────────

describe("verifyProject sandbox gate", () => {
  const cmd = (command: string, args: string[]): VerificationCommand => ({ kind: "test", command, args });

  /** Writes a throwaway script; verification runs script files, never inline eval. */
  function script(body: string): string {
    const file = path.join(os.tmpdir(), `ox-verify-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, body, "utf8");
    return file;
  }

  it("refuses a destructive command without spawning it", async () => {
    const events: string[] = [];
    const report = await verifyProject([cmd("rm", ["-rf", "/"])], {
      cwd: () => process.cwd(),
      onEvent: (t) => events.push(t),
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.logDigest).toContain("命令被拒绝");
    expect(events[0]).toContain("禁止");
  });

  it("refuses an argument carrying shell metacharacters", async () => {
    const report = await verifyProject([cmd("npm", ["run", "build; rm -rf /"])], { cwd: () => process.cwd() });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.logDigest).toContain("元字符");
  });

  it("refuses inline evaluation", async () => {
    const report = await verifyProject([cmd(process.execPath, ["-e", "process.exit(0)"])], {
      cwd: () => process.cwd(),
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.logDigest).toContain("内联求值");
  });

  it("actually runs an allowed command and reports its exit code", async () => {
    const file = script("console.log('verified'); process.exit(0)");
    const report = await verifyProject([cmd(process.execPath, [file])], { cwd: () => process.cwd() });
    expect(report.passed).toBe(true);
    expect(report.results[0]!.exitCode).toBe(0);
    expect(report.results[0]!.logDigest).toContain("verified");
  });

  it("fails on a non-zero exit code and stops at the first failure", async () => {
    const failing = script("process.exit(4)");
    const passing = script("process.exit(0)");
    const report = await verifyProject([cmd(process.execPath, [failing]), cmd(process.execPath, [passing])], {
      cwd: () => process.cwd(),
    });
    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.exitCode).toBe(4);
  });

  it("kills a command that exceeds its timeout", async () => {
    const events: string[] = [];
    const file = script("setTimeout(() => {}, 30000)");
    const report = await verifyProject([cmd(process.execPath, [file])], {
      cwd: () => process.cwd(),
      timeoutMs: 300,
      onEvent: (t) => events.push(t),
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.exitCode).toBeNull();
    expect(report.results[0]!.logDigest).toContain("终止进程树");
    expect(events.some((e) => e.includes("超过"))).toBe(true);
  });
});
