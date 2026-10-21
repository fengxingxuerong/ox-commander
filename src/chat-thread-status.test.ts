import { describe, expect, it } from "vitest";

import {
  applyThreadStatus,
  markThreadRead,
  threadStatusOfSummary,
  type ThreadStatusView,
} from "../shared/chat-thread-status";

/**
 * 线程状态位（M4b）。
 *
 * 它决定左栏那一个小圆点和一个数字。判错的方向全是**静默**的：后台线程跑完了
 * 没有标记、等审批的线程没变红、你正盯着的线程每次落定一条就给自己加一个未读
 * 红点。所以每条纪律单独钉，并且用引用相等钉住"没变就返回原对象"。
 */

const ev = (type: string, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  sessionId,
  ...extra,
});

describe("applyThreadStatus", () => {
  it("status 事件带状态与轮次；done 会清 awaiting", () => {
    const running = applyThreadStatus(undefined, ev("chat:status", "s-1", { status: "running", turns: 0 }), "s-1");
    expect(running).toMatchObject({ status: "running", turns: 0, unread: 0, awaiting: false });

    const asking = applyThreadStatus(running, ev("chat:approval-request", "s-1"), "s-2");
    expect(asking).toMatchObject({ status: "awaiting-approval", awaiting: true });

    const done = applyThreadStatus(asking, ev("chat:done", "s-1", { turns: 2 }), "s-2");
    expect(done).toMatchObject({ status: "done", turns: 2, awaiting: false });
  });

  it("后台线程的每条 entry 都涨未读；正在看的那条不涨（也不新建条目）", () => {
    const base: ThreadStatusView = { status: "running", turns: 1, unread: 0, awaiting: false };
    expect(applyThreadStatus(base, ev("chat:entry", "s-1", { entry: { kind: "assistant" } }), "s-2")).toMatchObject({
      unread: 1,
    });
    expect(applyThreadStatus(base, ev("chat:entry", "s-1", { entry: { kind: "assistant" } }), "s-1")).toBe(base);
    // 还没有任何状态时，光一条 entry（且正在看）不该凭空造一条线程状态。
    expect(applyThreadStatus(undefined, ev("chat:entry", "s-1"), "s-1")).toBeUndefined();
  });

  it("正在看的那条：收到任何事件都把旧未读清零（红点不该留在眼前的线程上）", () => {
    const dirty: ThreadStatusView = { status: "running", turns: 2, unread: 4, awaiting: false };
    expect(applyThreadStatus(dirty, ev("chat:status", "s-1", { status: "running", turns: 2 }), "s-1")).toMatchObject({
      unread: 0,
    });
    expect(applyThreadStatus(dirty, ev("chat:delta", "s-1", { text: "x" }), "s-1")).toMatchObject({ unread: 0 });
    // 看的是别人：未读数原封不动（状态本身照常更新）。
    expect(applyThreadStatus(dirty, ev("chat:status", "s-1", { status: "running", turns: 2 }), "s-2")).toMatchObject({
      unread: 4,
    });
  });

  it("delta 与未知事件不改状态（返回原对象，调用方可据引用相等跳过渲染）", () => {
    const base: ThreadStatusView = { status: "running", turns: 1, unread: 0, awaiting: false };
    expect(applyThreadStatus(base, ev("chat:delta", "s-1", { text: "x" }), "s-2")).toBe(base);
    expect(applyThreadStatus(base, ev("chat:future-thing", "s-1"), "s-2")).toBe(base);
    // 不是 chat 事件 / 没有归属：一律不动。
    expect(applyThreadStatus(base, { type: "log" }, "s-2")).toBe(base);
    expect(applyThreadStatus(base, { type: "chat:status", status: "done", turns: 9 }, "s-2")).toBe(base);
    expect(applyThreadStatus(base, { type: "chat:status", sessionId: "", status: "done", turns: 9 }, "s-2")).toBe(base);
  });

  it("error 也清 awaiting（审批被中止收尾后线程是错，不是还在等）", () => {
    const asking = applyThreadStatus(undefined, ev("chat:approval-request", "s-1"), "s-1");
    expect(applyThreadStatus(asking, ev("chat:error", "s-1"), "s-1")).toMatchObject({
      status: "error",
      awaiting: false,
    });
  });
});

describe("markThreadRead / threadStatusOfSummary", () => {
  it("读过只清未读，不动状态与轮次；已清零时返回原对象", () => {
    const dirty: ThreadStatusView = { status: "running", turns: 3, unread: 5, awaiting: true };
    expect(markThreadRead(dirty)).toEqual({ status: "running", turns: 3, unread: 0, awaiting: true });
    const clean: ThreadStatusView = { status: "running", turns: 3, unread: 0, awaiting: true };
    expect(markThreadRead(clean)).toBe(clean);
    expect(markThreadRead(undefined)).toBeUndefined();
  });

  it("历史摘要当初始状态：未读 0、没有挂起审批", () => {
    expect(threadStatusOfSummary({ status: "done", turns: 4 })).toEqual({
      status: "done",
      turns: 4,
      unread: 0,
      awaiting: false,
    });
  });
});
