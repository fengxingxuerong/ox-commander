import type { ChildProcess } from "node:child_process";
import { killDevServer, type DevServerKeepInfo } from "./engine/dev-server";
import type { PreviewState } from "../shared/delivery-guide";

/**
 * 桌面端 dev server 保活（item 2）。
 *
 * 验证器只在"探活 + 页面冒烟都通过"后把进程所有权交出来；本管理器是唯一
 * 持有者，负责：
 *   · 单实例：新预览接管时先停掉旧的（避免两个 dev server 抢同一端口）；
 *   · 日志：继续消费 stdout/stderr，保留尾部 16KiB 给看板；
 *   · 退出：进程自己退出时保留状态与退出码，等用户清除；
 *   · 超时：默认 30 分钟后自动停止，避免应用长期挂着孤儿进程；
 *   · 停止：用户点「停止」或应用退出时杀掉进程树。
 *
 * 刻意不做的：不做页面截图/DOM 断言（验证链仍只看 HTTP 与正文错误页）；
 * 不把 ChildProcess 暴露给渲染层（`PreviewState` 只有可展示事实）。
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_LOG_CHARS = 16 * 1024;

interface Entry {
  child: ChildProcess;
  state: PreviewState;
  timer: ReturnType<typeof setTimeout>;
}

export class PreviewManager {
  private current: Entry | null = null;

  constructor(
    private readonly kill: (child: ChildProcess) => void = killDevServer,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 接管一个探活成功的 dev server。返回 false = 没有接管（调用方负责杀掉）。 */
  keep(info: DevServerKeepInfo): boolean {
    if (info.child.exitCode !== null || info.child.killed) return false;
    this.stop();
    const started = this.now();
    const state: PreviewState = {
      title: info.title,
      url: info.url,
      command: info.command,
      args: [...info.args],
      cwd: info.cwd,
      ...(info.child.pid !== undefined ? { pid: info.child.pid } : {}),
      startedAt: new Date(started).toISOString(),
      expiresAt: new Date(started + this.ttlMs).toISOString(),
      running: true,
      log: info.log.slice(-MAX_LOG_CHARS),
    };
    const entry: Entry = {
      child: info.child,
      state,
      timer: setTimeout(() => {
        if (this.current === entry) this.stop();
      }, this.ttlMs),
    };
    entry.timer.unref?.();
    this.current = entry;

    const append = (chunk: Buffer | string): void => {
      entry.state.log = `${entry.state.log}${String(chunk)}`.slice(-MAX_LOG_CHARS);
    };
    info.child.stdout?.on("data", append);
    info.child.stderr?.on("data", append);
    info.child.once("close", (code) => {
      entry.state.running = false;
      entry.state.exitCode = code;
      clearTimeout(entry.timer);
    });
    info.child.once("error", (err) => {
      entry.state.running = false;
      append(`\n[preview] 进程错误：${(err as Error).message}`);
      clearTimeout(entry.timer);
    });
    return true;
  }

  state(): PreviewState | null {
    const entry = this.current;
    if (!entry) return null;
    if (entry.child.exitCode !== null || entry.child.killed) {
      entry.state.running = false;
      if (entry.state.exitCode === undefined) entry.state.exitCode = entry.child.exitCode;
    }
    return { ...entry.state, args: [...entry.state.args] };
  }

  /** 停止并清除当前预览；没有预览时返回 false。 */
  stop(): boolean {
    const entry = this.current;
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.current = null;
    this.kill(entry.child);
    return true;
  }
}

export const previewManager = new PreviewManager();

export function keepDevServer(info: DevServerKeepInfo): boolean {
  return previewManager.keep(info);
}

export function getPreview(): PreviewState | null {
  return previewManager.state();
}

export function stopPreview(): boolean {
  return previewManager.stop();
}
