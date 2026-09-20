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
  return (): FakeChild => {
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
      if (b.out !== undefined) (child.stdout as PassThrough).write(b.out);
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
