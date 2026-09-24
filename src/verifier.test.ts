/**
 * runSmokeChecks 直接单测：用注入的 fake spawn 覆盖全部边界分支
 * （沙箱拒 / 缺失期望片段 / stdin 传递 / 非零退出 / 超时 / 空期望只看退出码）。
 * 全部确定性，不真实 spawn 任何进程。
 */
import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { runSmokeChecks } from "../electron/engine/verifier";
import type { SmokeCheck } from "../shared/types";

interface FakeBehavior {
  out?: string;
  code?: number;
  err?: string;
  /** close 延迟（毫秒）；undefined = 立即，null = 永不（配合超时测用 60ms 场景） */
  closeDelay?: number | null;
  onStdin?: (chunk: string) => void;
  /** 拿到真正传给 spawn 的 env —— 断言"子进程看不到凭证"要用它，不能只测 scopedEnv 纯函数。 */
  onSpawn?: (env: NodeJS.ProcessEnv | undefined) => void;
}

interface FakeChild {
  pid: number;
  exitCode: number | null;
  kill: () => boolean;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  on: (ev: string, fn: (...a: unknown[]) => void) => FakeChild;
  emit: (ev: string, ...args: unknown[]) => void;
}

function fakeSpawnImpl(b: FakeBehavior) {
  return (
    _file?: string,
    _args?: readonly string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ): FakeChild => {
    b.onSpawn?.(opts?.env);
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const child: FakeChild = {
      pid: 99999,
      exitCode: null,
      kill: () => true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk, _enc, cb) {
          b.onStdin?.(String(chunk));
          cb();
        },
      }),
      on(ev, fn) {
        (listeners[ev] ??= []).push(fn);
        return child;
      },
      emit(ev, ...args) {
        for (const fn of listeners[ev] ?? []) fn(...args);
      },
    };
    queueMicrotask(() => {
      if (b.err) {
        child.emit("error", new Error(b.err));
        return;
      }
      if (b.out !== undefined) {
        // ⚠️ 必须按真实 pipe 粒度**分块**投递，不能一次 `write(整串)`。
        // `PassThrough.write(huge)` 会把整串塞进 readableLength，`data` 只触发
        // 一次且 chunk 就是全部内容 —— 而生产代码的字节预算是**块粒度**判定
        // （`if (logBytes >= MAX_LOG_BYTES) 丢弃`），单块超大输入必然整套漏掉，
        // 让"超预算丢弃"这条路径在测试里永远不可达（实测：一次 write
        // 2.09MiB → 单次 data、dropped 恒为 0）。
        // 真实子进程经 OS pipe（~64KB）分块到达，分块才是忠实的替身。
        const CHUNK = 256 * 1024;
        const out = b.out;
        for (let i = 0; i < out.length; i += CHUNK) {
          (child.stdout as PassThrough).write(out.slice(i, i + CHUNK));
        }
      }
      const finish = () => {
        child.exitCode = b.code ?? 0;
        child.emit("close", child.exitCode);
        (child.stdout as PassThrough).end();
        (child.stderr as PassThrough).end();
      };
      if (b.closeDelay === null) return;
      if (b.closeDelay) setTimeout(finish, b.closeDelay);
      else finish();
    });
    return child;
  };
}

function check(over: Partial<SmokeCheck>): SmokeCheck {
  return { title: "t", command: "node", args: ["run.js"], ...over };
}

describe("runSmokeChecks", () => {
  it("沙箱门拒绝内联求值命令（node -e 视为后门）", async () => {
    const results = await runSmokeChecks([check({ command: "node", args: ["-e", "x"] })], {
      cwd: ".",
      spawnImpl: fakeSpawnImpl({ out: "x" }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.logDigest).toMatch(/沙箱/);
  });

  it("冒烟子进程拿到的是最小化环境，不含任何凭证形状变量", async () => {
    process.env.OX_SMOKE_CANARY_SECRET = "canary";
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      const results = await runSmokeChecks([check({ expectContains: [] })], {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: "", onSpawn: (env) => (seen = env) }) as never,
      });
      expect(results[0]!.ok).toBe(true);
      expect(seen, "未显式传 env ⇒ 子进程继承宿主全部凭证").toBeDefined();
      expect(Object.keys(seen!).filter((k) => /SECRET|TOKEN|API_KEY|PASSWORD/i.test(k))).toEqual([]);
      expect(seen!.PATH).toBeTruthy();
    } finally {
      delete process.env.OX_SMOKE_CANARY_SECRET;
    }
  });

  it("stdout 缺失期望片段 → 判定失败并注明缺失项", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["EXPECTED"] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "hello world" }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    // 进程本身退出码 0（运行成功），契约判定失败来自期望片段缺失
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.logDigest).toMatch(/缺失期望片段/);
    expect(results[0]!.logDigest).toContain("EXPECTED");
  });

  it("输出包含全部期望片段 → 通过", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["col0", "type="] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "col0: type=string total=5" }) as never },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBe(0);
  });

  it("空期望列表 → 只看退出码", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "anything", code: 0 }) as never },
    );
    expect(results[0]!.ok).toBe(true);
  });

  it("非零退出码 → 失败", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "", code: 2 }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBe(2);
  });

  it("stdin 样例数据被完整传入子进程", async () => {
    let received = "";
    const results = await runSmokeChecks(
      [check({ stdin: "name,age\n张三,28\n", expectContains: [] })],
      {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: "", onStdin: (c) => (received += c) }) as never,
      },
    );
    expect(results[0]!.ok).toBe(true);
    expect(received).toBe("name,age\n张三,28\n");
  });

  it("spawn 报错 → 失败并携带错误信息", async () => {
    const results = await runSmokeChecks(
      [check({})],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ err: "boom" }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.logDigest).toMatch(/boom/);
  });

  it("超时 → 终止进程树并判失败（close 晚于超时窗口）", async () => {
    const events: string[] = [];
    const results = await runSmokeChecks([check({})], {
      cwd: ".",
      timeoutMs: 40,
      onEvent: (t) => events.push(t),
      spawnImpl: fakeSpawnImpl({ out: "", closeDelay: 60 }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(40);
    expect(events.some((t) => t.includes("超过") && t.includes("终止进程树"))).toBe(true);
  });

  it("首败即停：多条冒烟中第一条失败后不再执行后续", async () => {
    let calls = 0;
    const spawnImpl = (() => {
      calls += 1;
      return fakeSpawnImpl({ out: "x" })();
    }) as never;
    const results = await runSmokeChecks(
      [check({ expectContains: ["NO"] }), check({ expectContains: ["y"] })],
      { cwd: ".", spawnImpl },
    );
    expect(calls).toBe(1); // 第二条冒烟未执行
    expect(results.length).toBe(1);
  });
});

describe("输出字节预算（P2-4）", () => {
  it("超预算的输出被丢弃并注明，而不是无限累积", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "x".repeat(6 * 1024 * 1024), code: 0 }) as never },
    );
    // 截断只影响日志，不改变退出码判定
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBe(0);
    // ⚠️ 不要断言 logDigest 含「输出超过」：digest() 只保留首尾各 2000 字符，
    // 中间被 `...[truncated]...` 顶掉。截断标注恰好落在中段 —— 6MiB 输出时
    // 它前面有 2MiB 的 `x`，后面只剩 `[exit]0`，首尾各取 2000 都取不到它，
    // 正则一律匹配不上，测试必然假红。要验这条备注必须走**未截断的原始 output**：
    // 让超额量小于 digest 的 maxLen（4000），首尾窗口即可覆盖全串。
    const small = await runSmokeChecks(
      [check({ expectContains: [] })],
      {
        cwd: ".",
        // 超出 2MiB 帽 100KB → 丢 98KB（余量不足 1KB 时 Math.round 会给 0）
        spawnImpl: fakeSpawnImpl({ out: "x".repeat(2 * 1024 * 1024 + 100_000), code: 0 }) as never,
      },
    );
    const note = small[0]!.logDigest.match(/输出超过 (\d+)KB 预算，已丢弃约 (\d+)KB/);
    expect(note).not.toBeNull();
    // 帽值如实引用 MAX_LOG_BYTES，不是硬编码在提示语里的另一个数
    expect(Number(note![1])).toBe(2048);
    // 丢弃量如实上报（累计被截掉的字节），不是占位 0
    expect(Number(note![2])).toBe(98);
  });

  it("帽内头部保留：期望片段在头部仍能命中", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["HEAD-MARK"] })],
      {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: `HEAD-MARK\n${"x".repeat(6 * 1024 * 1024)}`, code: 0 }) as never,
      },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.logDigest).toContain("HEAD-MARK");
  });
});
