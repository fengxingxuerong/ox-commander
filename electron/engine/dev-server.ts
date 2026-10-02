import { killTree } from "../sandbox/kill-tree";
import type { ChildProcess } from "node:child_process";

/**
 * dev server 托管的探活核心（竞品清单 5.4，学 Vibe Kanban 的 dev server
 * 托管 + browser preview 的"能打开"这一半）。
 *
 * 职责只有一件事：**"这个 dev server 起来了吗"** —— 轮询一个 HTTP URL，
 * 2xx/3xx 即存活。刻意不做的：
 *   · 不做页面截图 / DOM 断言 —— 那是无头浏览器的事，依赖与体积都不该进
 *     验证链；"HTTP 200"已经把"端口活着、路由可达"钉住了；
 *   · 不猜端口 —— URL 由声明给出（大脑产物或 spec），探活器只管按它轮询；
 *   · 不保留进程 —— 无论探活成败，进程树都被杀掉。dev server 是验证道具，
 *     不是长驻服务（要长驻的预览走 serve 形态）。
 *
 * fetch 与 sleep 都可注入：测试用假 fetch（不联网、不真等），逐位点审才
 * 审得到轮询节奏与判定边界（4xx 算死、5xx 算死、异常算死）。
 */

export type ProbeVerdict = "alive" | "dead";

/** 2xx/3xx 算活 —— 301/302 是 dev server 的正常重定向（尾斜杠、https 升级）。 */
export function probeVerdictOf(status: number): ProbeVerdict {
  return status >= 200 && status < 400 ? "alive" : "dead";
}

export interface PollResult {
  ok: boolean;
  /** 实际探活次数（含导致判定定格的那一次）。 */
  attempts: number;
  elapsedMs: number;
  /** 判定说明：成功带状态码，失败带最后一次死因。 */
  detail: string;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * 轮询直到存活或超时。超时是**硬预算**（从第一次探活前起算，与进程 spawn
 * 同步开始），不是"再试最后一次"的软提示。
 */
export async function pollDevServer(url: string, opts: PollOptions = {}): Promise<PollResult> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 30_000);
  const intervalMs = Math.max(1, opts.intervalMs ?? 500);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let attempts = 0;
  let lastDetail = "未发起探活";
  for (;;) {
    attempts += 1;
    try {
      const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(Math.max(intervalMs, 2_000)) });
      if (probeVerdictOf(res.status) === "alive") {
        return { ok: true, attempts, elapsedMs: now() - startedAt, detail: `HTTP ${res.status}` };
      }
      lastDetail = `HTTP ${res.status}`;
    } catch (e) {
      lastDetail = (e as Error).message.slice(0, 120);
    }
    const elapsed = now() - startedAt;
    if (elapsed + intervalMs > timeoutMs) {
      return { ok: false, attempts, elapsedMs: elapsed, detail: `超时（${Math.round(timeoutMs / 1000)}s）：最后一次 ${lastDetail}` };
    }
    await sleep(intervalMs);
  }
}

/**
 * 杀掉 dev server 的进程树（best-effort）。fire-and-forget：调用方（验证器）
 * 的判定与它无关，杀失败也不该让验证报告变红 —— 真泄漏了进程，下一轮的
 * 端口占用探活会把它暴露出来。
 */
export function killDevServer(child: ChildProcess | undefined): void {
  if (!child) return;
  try {
    killTree(child);
  } catch {
    // 尽力而为：进程已退出时 kill 会抛（ESRCH 等），忽略。
  }
}

/**
 * 带进程退出守卫的轮询：dev server 在探活期间崩掉（端口被占、编译错误 panic）
 * 时，继续傻等 HTTP 只会烧满整个超时预算 —— 进程 `close` 一到就立刻判死，
 * 轮询输给退出事件时直接返回失败结果。
 *
 * 赢家（探活成功/超时）返回后，退出监听器被摘除；进程还活着由**调用方**杀
 * （`killDevServer`），本函数不越权。
 */
export async function pollDevServerProcess(
  url: string,
  child: ChildProcess,
  opts: PollOptions = {},
): Promise<PollResult> {
  const onExit = new Promise<PollResult>((resolve) => {
    child.once("close", (code) => {
      resolve({
        ok: false,
        attempts: 0,
        elapsedMs: 0,
        detail: `dev server 进程在探活期间退出（code=${code === null ? "signal" : code}）`,
      });
    });
  });
  const poll = pollDevServer(url, opts);
  let winner: PollResult;
  try {
    winner = await Promise.race([poll, onExit]);
  } finally {
    // 摘掉还没触发的退出监听（poll 赢时进程可能还活着）；已触发过的摘除是无害空操作。
    child.removeAllListeners("close");
  }
  return winner;
}
