import { describe, expect, it } from "vitest";
import {
  buildReceipt,
  formatReceiptLine,
  pairConflict,
  receiptTaskStatus,
  type ReceiptConflict,
  type ReceiptTask,
} from "../shared/delivery-receipt";

function task(id: string, status: ReceiptTask["status"], extra: Partial<ReceiptTask> = {}): ReceiptTask {
  return { id, title: id, zone: "src", status, attempts: 1, ...extra };
}

describe("pairConflict", () => {
  it("pairs a conflict with the remedy that touches one of its paths", () => {
    const paired = pairConflict(
      { kind: "unauthorized-write", paths: ["outside/x.js"] },
      [{ action: "revert", paths: ["outside/x.js"] }],
    );
    expect(paired.remedy).toBe("revert");
  });

  it("falls back to 'none' when no remedy covers the conflict", () => {
    const paired = pairConflict(
      { kind: "unauthorized-write", paths: ["outside/x.js"] },
      [{ action: "revert", paths: ["other/y.js"] }],
    );
    expect(paired.remedy).toBe("none");
  });

  it("deduplicates and sorts paths so one conflict reads the same in every run", () => {
    const paired = pairConflict({ kind: "overlap", paths: ["b.ts", "a.ts", "b.ts"] }, []);
    expect(paired.paths).toEqual(["a.ts", "b.ts"]);
  });
});

describe("receiptTaskStatus", () => {
  it("reports a user-skipped task as skipped even though it is also marked done", () => {
    // 用户跳过这条路径同样会把任务加进"已完成"集合（它已不需要再做）——
    // 先判完成会把"人放弃的"报成"做出来的"。
    expect(receiptTaskStatus({ skipped: true, done: true })).toBe("skipped");
  });

  it("reports a task with a successful outcome that is not landed yet as pending", () => {
    // 全员重跑会清掉完成记录；那种任务的旧成功结果还在，但它这轮还没重派完。
    expect(receiptTaskStatus({ skipped: false, done: false, outcomeOk: true })).toBe("pending");
  });

  it("reports a dispatched-but-failed task as failed", () => {
    expect(receiptTaskStatus({ skipped: false, done: false, outcomeOk: false })).toBe("failed");
  });

  it("reports a task that never ran as pending, not failed", () => {
    expect(receiptTaskStatus({ skipped: false, done: false })).toBe("pending");
  });
});

describe("buildReceipt", () => {
  it("reports a verified delivery with the check and task counts", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [task("t1", "done"), task("t2", "skipped")],
      conflicts: [],
    });
    expect(r.counts).toMatchObject({ total: 2, done: 1, skipped: 1, failed: 0, pending: 0 });
    expect(r.headline).toContain("已交付");
    expect(r.headline).toContain("1/2 个任务完成");
    // 跳过数必须出现在结论里：少一个任务却说"全完成"是误导。
    expect(r.headline).toContain("跳过 1 个");
  });

  it("keeps 'delivered' and 'verified' independent when nothing was actually checked", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: false,
      unverifiedReason: "没有配置任何验证命令，也没有冒烟样本运行过",
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(r.verified).toBe(false);
    // 字段本身也要断言：只断言 headline 时，"凭据里少了这个字段"是看不出来的
    // （headline 走的是另一处取值），而宿主正是靠这个字段解释"为什么没验过"。
    expect(r.unverifiedReason).toBe("没有配置任何验证命令，也没有冒烟样本运行过");
    expect(r.headline).toContain("未经构建/测试验证");
    expect(r.headline).toContain("没有配置任何验证命令");
  });

  it("omits the reason key entirely when there is nothing to explain", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    // 字段即承诺：给一个 `undefined` 的键会让宿主分不清"没配理由"与"配了空理由"。
    expect("unverifiedReason" in r).toBe(false);
  });

  it("names the blocking reason on a blocked run", () => {
    const r = buildReceipt({
      outcome: "blocked",
      verified: false,
      unverifiedReason: "重修 3 轮后验证仍未通过",
      rounds: 3,
      checks: [{ kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "2 failed" }],
      tasks: [task("t1", "failed"), task("t2", "pending")],
      conflicts: [],
    });
    expect(r.headline).toContain("未交付");
    expect(r.headline).toContain("1 个失败");
    expect(r.headline).toContain("1 个未启动");
    expect(r.counts.checksFailed).toBe(1);
  });

  it("counts checks that were already failing before this run", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 1,
      checks: [
        { kind: "typecheck", ok: true, exitCode: 0, preexisting: true, headline: "" },
        { kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "" },
      ],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(r.counts.preexisting).toBe(1);
    expect(r.headline).toContain("1 条本次运行前就是红的");
  });

  it("carries conflicts through with sorted paths", () => {
    const conflicts: ReceiptConflict[] = [{ kind: "overlap", paths: ["b.ts", "a.ts"], remedy: "quarantine" }];
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [{ ...conflicts[0]!, paths: ["z.ts", "a.ts"] }],
    });
    expect(r.conflicts[0]!.paths).toEqual(["a.ts", "z.ts"]);
    expect(r.counts.conflicts).toBe(1);
    expect(r.headline).toContain("1 次越权");
  });

  it("projects usage without inventing a limit", () => {
    const withLimit = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
      usage: { totalTokens: 120, calls: 4, measuredCalls: 3, byModel: {}, limit: 1000 },
    });
    expect(withLimit.usage).toEqual({ totalTokens: 120, calls: 4, measuredCalls: 3, limit: 1000 });

    const without = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
      usage: { totalTokens: 120, calls: 4, measuredCalls: 4, byModel: {} },
    });
    expect(without.usage && "limit" in without.usage).toBe(false);

    const none = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    expect("usage" in none).toBe(false);
  });
});

describe("formatReceiptLine", () => {
  it("leads with the conclusion", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [task("t1", "done")],
      conflicts: [],
    });
    expect(formatReceiptLine(r)).toContain("[receipt]");
    expect(formatReceiptLine(r)).toContain("已交付");
  });

  it("says how many calls went unmeasured when the number is used as a bill", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [task("t1", "done")],
      conflicts: [],
      usage: { totalTokens: 50, calls: 3, measuredCalls: 1, byModel: {} },
    });
    // 2 次没上报用量 ⇒ 这行必须自己说破，否则"50 tokens"读起来像全部支出。
    expect(formatReceiptLine(r)).toContain("2 次调用未上报用量");
  });
});
