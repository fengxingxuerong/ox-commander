import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewManager } from "../electron/preview-manager";
import type { DevServerKeepInfo } from "../electron/engine/dev-server";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  exitCode: number | null;
  killed: boolean;
}

function fakeChild(pid = 123): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  return child;
}

function info(child: FakeChild, over: Partial<DevServerKeepInfo> = {}): DevServerKeepInfo {
  return {
    title: "dev server 起得来",
    url: "http://127.0.0.1:5173/",
    command: "node",
    args: ["server.js"],
    cwd: "/ws",
    child: child as unknown as ChildProcess,
    log: "boot\n",
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PreviewManager", () => {
  it("接管后给出完整事实；stdout/stderr 继续追加；close 后保留现场", () => {
    let now = 1_000;
    const kill = vi.fn();
    const manager = new PreviewManager(kill, 60_000, () => now);
    const child = fakeChild();
    expect(manager.keep(info(child))).toBe(true);

    const state = manager.state()!;
    expect(state).toMatchObject({
      title: "dev server 起得来",
      url: "http://127.0.0.1:5173/",
      command: "node",
      args: ["server.js"],
      cwd: "/ws",
      pid: 123,
      running: true,
      log: "boot\n",
    });
    expect(state.startedAt).toBe(new Date(1_000).toISOString());
    expect(state.expiresAt).toBe(new Date(61_000).toISOString());
    expect("exitCode" in state).toBe(false);

    child.stdout.emit("data", Buffer.from("line2\n"));
    child.stderr.emit("data", "oops\n");
    expect(manager.state()!.log).toBe("boot\nline2\noops\n");

    now = 2_000;
    child.exitCode = 0;
    child.emit("close", 0);
    const ended = manager.state()!;
    expect(ended.running).toBe(false);
    expect(ended.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it("stop 杀掉进程并清除状态；重复 stop 返回 false", () => {
    const kill = vi.fn();
    const manager = new PreviewManager(kill);
    const child = fakeChild();
    manager.keep(info(child));
    expect(manager.stop()).toBe(true);
    expect(kill).toHaveBeenCalledWith(child);
    expect(manager.state()).toBeNull();
    expect(manager.stop()).toBe(false);
  });

  it("新预览接管时先停掉旧的（同一个处理器只持有一个进程）", () => {
    const kill = vi.fn();
    const manager = new PreviewManager(kill);
    const first = fakeChild(1);
    const second = fakeChild(2);
    manager.keep(info(first, { url: "http://127.0.0.1:5173/" }));
    manager.keep(info(second, { url: "http://127.0.0.1:5174/" }));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(first);
    expect(manager.state()!.pid).toBe(2);
    expect(manager.state()!.url).toBe("http://127.0.0.1:5174/");
  });

  it("已经退出/被杀的 child 不接管（返回 false，不误杀旧预览）", () => {
    const kill = vi.fn();
    const manager = new PreviewManager(kill);
    const dead = fakeChild();
    dead.exitCode = 3;
    expect(manager.keep(info(dead))).toBe(false);
    expect(manager.state()).toBeNull();

    const killed = fakeChild();
    killed.killed = true;
    expect(manager.keep(info(killed))).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("超过 TTL 自动停止", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const manager = new PreviewManager(kill, 1_000);
    manager.keep(info(fakeChild()));
    expect(manager.state()).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(manager.state()).toBeNull();
  });

  it("旧预览的 TTL 不会误停后来的新预览", () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const manager = new PreviewManager(kill, 1_000);
    const first = fakeChild(1);
    const second = fakeChild(2);
    manager.keep(info(first));
    vi.advanceTimersByTime(500);
    manager.keep(info(second));
    // 旧 entry 的定时器到点：current 已不是它，不许停新预览。
    vi.advanceTimersByTime(500);
    expect(manager.state()!.pid).toBe(2);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(first);
    // 新预览自己的 TTL 到点才停。
    vi.advanceTimersByTime(500);
    expect(kill).toHaveBeenLastCalledWith(second);
    expect(manager.state()).toBeNull();
  });

  it("进程 exitCode/killed 已变化但 close 还没到时，state 也如实报已退出", () => {
    const manager = new PreviewManager(vi.fn());
    const byExit = fakeChild();
    manager.keep(info(byExit));
    byExit.exitCode = 7; // 不 emit close：事件可能晚到
    const exited = manager.state()!;
    expect(exited.running).toBe(false);
    expect(exited.exitCode).toBe(7);

    const byKill = fakeChild();
    manager.keep(info(byKill));
    byKill.killed = true; // exitCode 仍为 null（被信号杀）
    const killed = manager.state()!;
    expect(killed.running).toBe(false);
    expect("exitCode" in killed).toBe(true);
    expect(killed.exitCode).toBeNull();
  });

  it("进程 error 事件：标记已退出并把原因写进日志", () => {
    const manager = new PreviewManager(vi.fn());
    const child = fakeChild();
    manager.keep(info(child));
    child.emit("error", new Error("boom"));
    const state = manager.state()!;
    expect(state.running).toBe(false);
    expect(state.log).toContain("进程错误：boom");
  });

  it("日志只保留尾部 16KiB", () => {
    const manager = new PreviewManager(vi.fn());
    const child = fakeChild();
    manager.keep(info(child, { log: "" }));
    child.stdout.emit("data", "x".repeat(20 * 1024));
    expect(manager.state()!.log).toHaveLength(16 * 1024);
  });
});
