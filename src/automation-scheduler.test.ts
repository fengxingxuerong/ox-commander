import { describe, expect, it } from "vitest";

import { AutomationScheduler, type TriggerOutcome } from "../electron/automations/automation-scheduler";
import { BUSY_RETRY_CAP_MS, MIN_EVERY_MS } from "../shared/schedule-core";
import type { Automation } from "../shared/automation";

/**
 * M5b 的调度环。用手动泵驱动注入的时钟与定时器 —— 不靠真实时间、不 sleep，
 * 断言的是时间戳语义：
 * - 接受才记账（`markFired`），忙/失败不记账且短重试；
 * - **短重试独占**：失败的任务 `nextDelayMs` 仍是 0，取 min 会退化成 tight loop；
 * - 停机补跑至多一次，触发点按"上次触发 + 间隔"漂移自校正。
 */

const T0 = 1_000_000;

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto-a",
    name: "夜间构建",
    projectId: "p1",
    everyMs: 60_000,
    enabled: true,
    createdAt: T0,
    // 从未触发时排程从 updatedAt 起算（见 scheduleBaseMs）：这里让"刚建好"= 现在
    updatedAt: T0,
    ...over,
  };
}

interface TimerRec {
  at: number;
  fn: () => void;
  cleared: boolean;
}

function harness(input: {
  automations: Automation[];
  /** 第 n 次触发（从 0 起）的结果。 */
  outcome?: (a: Automation, n: number) => TriggerOutcome;
  nowStart?: number;
  markFiredThrows?: boolean;
}) {
  let clock = input.nowStart ?? T0;
  let automations = input.automations;
  const timers: TimerRec[] = [];
  const fired: Array<{ id: string; at: number }> = [];
  const triggered: string[] = [];
  const logs: string[] = [];
  let calls = 0;

  const scheduler = new AutomationScheduler({
    list: () => automations,
    trigger: async (a) => {
      triggered.push(a.id);
      return (input.outcome ?? (() => "accepted"))(a, calls++);
    },
    markFired: (id, now) => {
      if (input.markFiredThrows) throw new Error("EACCES");
      fired.push({ id, at: now });
      const target = automations.find((x) => x.id === id);
      if (target) target.lastFiredMs = now;
    },
    log: (t) => logs.push(t),
    now: () => clock,
    setTimeoutImpl: (fn, ms) => {
      timers.push({ at: clock + ms, fn, cleared: false });
      return timers[timers.length - 1]!;
    },
    clearTimeoutImpl: (h) => {
      (h as TimerRec).cleared = true;
    },
  });

  /** 把到点的 timer 全部烧掉（每次烧完让 tick 的 await 链跑完）。 */
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

  return {
    scheduler,
    pump,
    timers,
    fired,
    triggered,
    logs,
    at: (ms: number) => (clock = ms),
    setList: (next: Automation[]) => (automations = next),
    /** 下一个尚未触发的 timer 的时刻（没有 = undefined）。 */
    nextAt: () => timers.filter((t) => !t.cleared)[0]?.at,
  };
}

describe("AutomationScheduler", () => {
  it("fresh：不立即触发，一个间隔后触发并记账，下一点 = 触发点 + 间隔", async () => {
    const h = harness({ automations: [auto()] });
    h.scheduler.start();
    await h.pump();
    expect(h.triggered).toEqual([]);
    expect(h.nextAt()).toBe(T0 + 60_000);

    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a"]);
    expect(h.fired).toEqual([{ id: "auto-a", at: T0 + 60_000 }]);
    // 漂移自校正：下一点从**触发时刻**起算，不是固定节拍
    expect(h.nextAt()).toBe(T0 + 120_000);
    expect(h.logs.some((l) => l.includes("触发") && l.includes("p1"))).toBe(true);
  });

  it("停机补跑：重启时已越过触发点 → 启动立即触发一次并说破", async () => {
    const h = harness({ automations: [auto({ lastFiredMs: T0 - 120_000 })] });
    h.scheduler.start();
    await h.pump();
    expect(h.fired).toEqual([{ id: "auto-a", at: T0 }]);
    expect(h.logs.some((l) => l.includes("停机期间错过触发点") && l.includes("夜间构建"))).toBe(true);
    expect(h.nextAt()).toBe(T0 + 60_000);
  });

  it("忙 = 不记账 + 短重试（间隔再长也封顶 30s）", async () => {
    const h = harness({ automations: [auto({ everyMs: 3_600_000 })], outcome: () => "busy" });
    h.scheduler.start();
    h.at(T0 + 3_600_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a"]);
    expect(h.fired).toEqual([]);
    expect(h.nextAt()).toBe(T0 + 3_600_000 + BUSY_RETRY_CAP_MS);
    expect(h.logs.some((l) => l.includes("跳过"))).toBe(true);
  });

  it("失败 = 不记账 + 短重试，且**不会立刻重试**（回归：短重试独占，不取 min）", async () => {
    const h = harness({ automations: [auto()], outcome: () => "failed" });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.fired).toEqual([]);
    // 已到点的任务 nextDelayMs 仍是 0；若 plan 对 0 与 30s 取 min，这里会立刻再触发
    // —— 每轮事件循环真起一个 run，就是自旋。
    expect(h.timers.filter((t) => t.at === T0 + 60_000)).toHaveLength(1);
    expect(h.nextAt()).toBe(T0 + 60_000 + 30_000);
    expect(h.logs.some((l) => l.includes("触发失败"))).toBe(true);
  });

  it("忙时后面的到点任务不再逐个撞闸（单飞闸是全局的）", async () => {
    const h = harness({
      automations: [auto({ id: "auto-a" }), auto({ id: "auto-b" }), auto({ id: "auto-c" })],
      outcome: () => "busy",
    });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a"]);
  });

  it("失败不阻断同轮的其它任务：接着跑下一个到点项", async () => {
    const h = harness({
      automations: [auto({ id: "auto-a" }), auto({ id: "auto-b" })],
      outcome: (a) => (a.id === "auto-a" ? "failed" : "accepted"),
    });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a", "auto-b"]);
    expect(h.fired).toEqual([{ id: "auto-b", at: T0 + 60_000 }]);
  });

  it("同一时刻多个到点：按 id 字典序触发", async () => {
    const h = harness({
      automations: [auto({ id: "auto-z" }), auto({ id: "auto-m" }), auto({ id: "auto-a" })],
      outcome: (_a, n) => (n === 0 ? "busy" : "accepted"),
    });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a"]); // 第一个就忙 → 后面的同轮不撞
    h.setList([auto({ id: "auto-z" }), auto({ id: "auto-m" }), auto({ id: "auto-a" })]);
    h.at(T0 + 60_000 + 30_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a", "auto-a", "auto-m", "auto-z"]);
  });

  it("触发器抛错 = 失败，环不死（下一轮照常排程）", async () => {
    const h = harness({
      automations: [auto()],
      outcome: () => {
        throw new Error("boom");
      },
    });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.fired).toEqual([]);
    expect(h.logs.some((l) => l.includes("触发异常") && l.includes("boom"))).toBe(true);
    expect(h.nextAt()).toBe(T0 + 90_000);
  });

  it("记账失败：说破 + 欠短重试（不改判已触发，也不 0 延迟自旋）", async () => {
    const h = harness({ automations: [auto()], markFiredThrows: true });
    h.scheduler.start();
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual(["auto-a"]);
    expect(h.logs.some((l) => l.includes("记账失败") && l.includes("EACCES"))).toBe(true);
    expect(h.nextAt()).toBe(T0 + 90_000);
  });

  it("同一轮多个到点且都成功：逐个记账，不是一个成功就收工", async () => {
    const h = harness({ automations: [auto({ id: "auto-a" }), auto({ id: "auto-b" })] });
    h.scheduler.start();
    h.at(T0 + 60_000);
    // 只烧**这一批**到点的 timer，不 pump 后续：否则"第一个成功就收工"会被下一轮
    // tick 补上（第二个仍然会触发，只是晚一轮），两种实现的最终状态一样 —— 等价假象。
    const batch = h.timers.filter((t) => !t.cleared && t.at <= T0 + 60_000);
    expect(batch).toHaveLength(1);
    for (const t of batch) {
      t.cleared = true;
      t.fn();
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(h.triggered).toEqual(["auto-a", "auto-b"]);
    expect(h.fired).toEqual([
      { id: "auto-a", at: T0 + 60_000 },
      { id: "auto-b", at: T0 + 60_000 },
    ]);
  });

  it("停用的不触发；全停用 = 睡死，reschedule 叫醒", async () => {
    const h = harness({ automations: [auto({ enabled: false })] });
    h.scheduler.start();
    await h.pump();
    expect(h.triggered).toEqual([]);
    expect(h.nextAt()).toBeUndefined();

    // 界面上重新打开 → 调度器被叫醒，按"从未触发"等一个间隔
    h.setList([auto({ enabled: true })]);
    h.scheduler.reschedule();
    expect(h.nextAt()).toBe(T0 + 60_000);
  });

  it("stop() 之后到点的 timer 不再触发，且 timer 真被清掉", async () => {
    const h = harness({ automations: [auto()] });
    h.scheduler.start();
    await h.pump();
    h.scheduler.stop();
    expect(h.timers[0]!.cleared).toBe(true);
    h.at(T0 + 60_000);
    await h.pump();
    expect(h.triggered).toEqual([]);
  });

  it("start() 幂等：重复调用不会多排一个 timer", async () => {
    const h = harness({ automations: [auto()] });
    h.scheduler.start();
    h.scheduler.start();
    await h.pump();
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);
  });

  it("间隔下限由归一化层把关：调度环只按 everyMs 排程（MIN_EVERY_MS 秒级也能跑）", async () => {
    const h = harness({ automations: [auto({ everyMs: MIN_EVERY_MS })] });
    h.scheduler.start();
    await h.pump();
    expect(h.nextAt()).toBe(T0 + MIN_EVERY_MS);
  });
});
