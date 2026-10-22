import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  busyRetryMs,
  decideStartupCatchup,
  MIN_EVERY_MS,
  nextDelayMs,
  parseEvery,
  parseScheduleArgs,
  type ScheduleState,
} from "../shared/schedule-core";
import { scheduleStateIo, startScheduleLoop } from "../headless/serve-main";

describe("parseEvery（--every 的值）", () => {
  it("[1] 毫秒数 / 单位后缀 / 大单位都认", () => {
    expect(parseEvery("1500")).toEqual({ everyMs: 1500 });
    expect(parseEvery("1500ms")).toEqual({ everyMs: 1500 });
    expect(parseEvery("30s")).toEqual({ everyMs: 30_000 });
    expect(parseEvery("5m")).toEqual({ everyMs: 300_000 });
    expect(parseEvery("1h")).toEqual({ everyMs: 3_600_000 });
  });

  it("[2] 解析不了 / 非正数 / 溢出 / 低于下限都报错", () => {
    expect(parseEvery("abc")?.error).toBeTruthy();
    expect(parseEvery("")?.error).toBeTruthy();
    expect(parseEvery("-5s")?.error).toBeTruthy();
    expect(parseEvery("0")?.error).toContain("正整数");
    // 超长数字串溢出：Number.isInteger(1e25) 是 true，必须用 isSafeInteger 拦
    expect(parseEvery("9".repeat(25))?.error).toContain("溢出");
    // 大单位乘出来越过 setTimeout 上限（2^31-1 ms ≈ 24.8 天）也要拦
    expect(parseEvery("999999999h")?.error).toContain("间隔过大");
    // 边界：24 天内合法
    expect(parseEvery("500h")).toEqual({ everyMs: 1_800_000_000 });
    expect(parseEvery(`${MIN_EVERY_MS - 1}`)?.error).toContain("间隔过小");
    // 边界：恰好下限合法
    expect(parseEvery(`${MIN_EVERY_MS}`)).toEqual({ everyMs: MIN_EVERY_MS });
  });
});

describe("parseScheduleArgs（--every/--spec/--schedule-state）", () => {
  it("[3] 成对出现即解析；= 与空格两种写法都认；state 可选", () => {
    expect(parseScheduleArgs(["--every=5m", "--spec=s.json"])).toEqual({
      schedule: { everyMs: 300_000, specFile: "s.json" },
    });
    expect(parseScheduleArgs(["--every", "30s", "--spec", "s.json", "--schedule-state", "st.json"])).toEqual({
      schedule: { everyMs: 30_000, specFile: "s.json", stateFile: "st.json" },
    });
  });

  it("[4] 缺一即报错；两者都没有 = 没配定时（不是错误）", () => {
    expect(parseScheduleArgs(["--every=5m"])?.error).toContain("成对");
    expect(parseScheduleArgs(["--spec=s.json"])?.error).toContain("成对");
    expect(parseScheduleArgs(["--port=8787"])).toEqual({});
  });

  it("[5] 拼写错误必须报错，不静默忽略（--port 的既有纪律）", () => {
    expect(parseScheduleArgs(["--everyy=5m", "--spec=s.json"])?.error).toContain("无法识别");
    expect(parseScheduleArgs(["--every=5m", "--spez=s.json"])?.error).toContain("无法识别");
    expect(parseScheduleArgs(["--every=5m", "--spec=s.json", "--schedule-stateX=st"])?.error).toContain("无法识别");
    // 值缺失也报错，且错误要说对事：空值是"需要一个值"，不是"没成对"
    expect(parseScheduleArgs(["--every=5m", "--spec"])?.error).toContain("需要一个值");
    expect(parseScheduleArgs(["--every=5m", "--spec="])?.error).toContain("需要一个值");
  });
});

describe("补跑与排程判定", () => {
  it("[6] fresh = 等一个间隔；越过触发点 = 补一次；未到 = 正常等待", () => {
    expect(decideStartupCatchup({ now: 1_000_000, everyMs: 60_000 })).toEqual({ fire: false, reason: "fresh" });
    expect(decideStartupCatchup({ now: 1_000_000, lastFiredMs: 1_000_000 - 60_000, everyMs: 60_000 })).toEqual({
      fire: true,
      reason: "catchup",
    });
    expect(decideStartupCatchup({ now: 1_000_000, lastFiredMs: 1_000_000 - 59_999, everyMs: 60_000 })).toEqual({
      fire: false,
      reason: "wait",
    });
  });

  it("[7] busyRetryMs：短间隔原样、长间隔封顶 30s", () => {
    expect(busyRetryMs(10_000)).toBe(10_000);
    expect(busyRetryMs(3_600_000)).toBe(30_000);
  });

  it("[8] nextDelayMs：fresh = 整间隔；逾期 = 0（立即）；未到 = 差值（漂移自校正）", () => {
    expect(nextDelayMs({ now: 1_000, everyMs: 60_000 })).toBe(60_000);
    expect(nextDelayMs({ now: 1_000_000, lastFiredMs: 900_000, everyMs: 60_000 })).toBe(0);
    expect(nextDelayMs({ now: 1_000_000, lastFiredMs: 970_000, everyMs: 60_000 })).toBe(30_000);
  });
});

describe("scheduleStateIo（触发时间戳落盘）", () => {
  it("[9] 缺文件 = 从未触发；写后可读回；损坏/形状不对按未触发处理；无 stateFile = 双 no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sched-"));
    const file = path.join(dir, "state.json");
    const io = scheduleStateIo(file);
    expect(io.loadState()).toBeUndefined();
    io.saveState({ lastFiredMs: 123_456 });
    expect(io.loadState()).toEqual({ lastFiredMs: 123_456 });

    fs.writeFileSync(file, "{ not json");
    expect(io.loadState()).toBeUndefined();

    fs.writeFileSync(file, JSON.stringify({ lastFiredMs: "yesterday" }));
    expect(io.loadState()).toBeUndefined();

    // 数字字符串也必须拒收：isFinite("123456") 是 true，&& 放宽成 || 就从这里漏
    fs.writeFileSync(file, JSON.stringify({ lastFiredMs: "123456" }));
    expect(io.loadState()).toBeUndefined();

    const noop = scheduleStateIo(undefined);
    expect(noop.loadState()).toBeUndefined();
    expect(() => noop.saveState({ lastFiredMs: 1 })).not.toThrow();
  });
});

/**
 * 调度环（注入式时钟/fetch/timer，手动泵驱动——不靠真实时间，不 sleep）。
 * 断言的是时间戳语义：接受才落盘、409/失败不落盘且短重试、补跑至多一次。
 */
describe("startScheduleLoop", () => {
  interface TimerRec {
    at: number;
    fn: () => void;
    cleared: boolean;
  }

  function harness(input: {
    everyMs?: number;
    initialState?: ScheduleState;
    status: () => number;
    token?: string;
    nowStart?: number;
    host?: string;
  }) {
    let clock = input.nowStart ?? 1_000_000;
    const timers: TimerRec[] = [];
    const saved: ScheduleState[] = [];
    const fires: Array<{ url: string; auth?: string; body: string }> = [];
    const logs: string[] = [];
    let state: ScheduleState | undefined = input.initialState;
    let timerSeq = 0;
    const loop = startScheduleLoop({
      args: { everyMs: input.everyMs ?? 60_000, specFile: "spec.json" },
      specPayload: JSON.stringify({ requirement: "x" }),
      port: 8787,
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.token ? { token: input.token } : {}),
      log: (t) => logs.push(t),
      loadState: () => state,
      saveState: (s) => {
        saved.push(s);
        state = s;
      },
      fetchImpl: async (url, init) => {
        fires.push({ url, auth: init.headers.Authorization, body: init.body });
        const status = input.status();
        return { ok: status >= 200 && status < 300, status };
      },
      setTimeoutImpl: (fn, ms) => {
        timers.push({ at: clock + ms, fn, cleared: false });
        return timers[timerSeq++];
      },
      clearTimeoutImpl: (h) => {
        (h as TimerRec).cleared = true;
      },
      now: () => clock,
    });
    const pump = async (): Promise<void> => {
      for (let i = 0; i < 50; i++) {
        const due = timers.filter((t) => !t.cleared && t.at <= clock);
        if (due.length === 0) break;
        for (const t of due) {
          t.cleared = true;
          t.fn();
          await new Promise<void>((r) => setImmediate(r));
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    };
    return { loop, pump, timers, saved, fires, logs, at: (ms: number) => (clock = ms) };
  }

  it("[10] fresh 启动：不立即触发，一个间隔后首次触发并落盘，下一点 = 触发点 + 间隔", async () => {
    const h = harness({ status: () => 200 });
    expect(h.fires).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.at).toBe(1_060_000);

    h.at(1_060_000);
    await h.pump();
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]!.url).toBe("http://127.0.0.1:8787/run");
    expect(JSON.parse(h.fires[0]!.body)).toEqual({ requirement: "x" });
    expect(h.saved).toEqual([{ lastFiredMs: 1_060_000 }]);
    // 下一个触发点从**触发时刻**起算（漂移自校正），不是固定节拍
    expect(h.timers.some((t) => t.at === 1_120_000)).toBe(true);
  });

  it("[10b] 自调用地址跟着绑定地址走：绑到具体网卡时连它，而不是写死的回环", async () => {
    // 绑 192.168.1.5 时回环上没有监听 —— 写死 127.0.0.1 的定时环会每次触发都静默失败。
    const h = harness({ status: () => 200, host: "192.168.1.5" });
    h.at(1_060_000);
    await h.pump();
    expect(h.fires[0]!.url).toBe("http://192.168.1.5:8787/run");
  });

  it("[11] 补跑：重启时已越过触发点 → 启动立即触发一次，然后恢复正常节拍", async () => {
    const h = harness({ status: () => 200, initialState: { lastFiredMs: 1_000_000 - 120_000 } });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(h.fires).toHaveLength(1);
    expect(h.saved).toEqual([{ lastFiredMs: 1_000_000 }]);
    expect(h.timers.some((t) => t.at === 1_060_000)).toBe(true);
  });

  it("[12] 409 = 忙：不落盘、不计已触发，短重试（封顶 30s）", async () => {
    const h = harness({ status: () => 409, everyMs: 3_600_000 });
    expect(h.timers[0]!.at).toBe(1_000_000 + 3_600_000);
    h.at(1_000_000 + 3_600_000);
    await h.pump();
    expect(h.fires).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(h.timers.some((t) => t.at === 1_000_000 + 3_600_000 + 30_000)).toBe(true);
  });

  it("[13] 服务 5xx：同样不落盘、短重试（服务自愈后自动恢复节拍）", async () => {
    const h = harness({ status: () => 500 });
    h.at(1_060_000);
    await h.pump();
    expect(h.saved).toHaveLength(0);
    expect(h.timers.some((t) => t.at === 1_060_000 + 30_000)).toBe(true);
  });

  it("[13b] 网络异常（fetch 抛错）＝ 触发失败：不落盘、短重试、日志说破", async () => {
    let clock = 1_000_000;
    const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
    const saved: ScheduleState[] = [];
    const logs: string[] = [];
    const loop = startScheduleLoop({
      args: { everyMs: 60_000, specFile: "spec.json" },
      specPayload: JSON.stringify({ requirement: "x" }),
      port: 8787,
      log: (t) => logs.push(t),
      loadState: () => undefined,
      saveState: (s) => saved.push(s),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      setTimeoutImpl: (fn, ms) => {
        timers.push({ at: clock + ms, fn, cleared: false });
        return timers.at(-1)!;
      },
      clearTimeoutImpl: (h2) => {
        (h2 as { cleared: boolean }).cleared = true;
      },
      now: () => clock,
    });
    void loop;
    clock = 1_060_000;
    for (const t of timers.filter((x) => !x.cleared && x.at <= clock)) {
      t.fn();
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(saved).toHaveLength(0);
    expect(logs.some((l) => l.includes("触发失败") && l.includes("ECONNREFUSED"))).toBe(true);
    // 失败 = 不计已触发：重试走 busyRetryMs（30s），而不是被当成"已接受"排到下个整间隔
    expect(timers.some((t) => t.at === 1_060_000 + 30_000)).toBe(true);
  });

  it("[14] 鉴权：配置了 token 时自调用也带 Bearer 头", async () => {
    const h = harness({ status: () => 200, token: "sekrit" });
    h.at(1_060_000);
    await h.pump();
    expect(h.fires[0]!.auth).toBe("Bearer sekrit");
  });

  it("[15] stop() 之后到点的 timer 不再触发，且 timer 真被清掉", async () => {
    const h = harness({ status: () => 200 });
    h.loop.stop();
    expect(h.timers[0]!.cleared).toBe(true);
    h.at(1_060_000);
    await h.pump();
    expect(h.fires).toHaveLength(0);
  });
});
