import { describe, expect, it } from "vitest";
import {
  formatZoneCostReport,
  planCost,
  summarizeZoneCost,
  type ZoneCostSummary,
} from "../electron/zone-cost";
import type { AuditRecord } from "../electron/audit-log";

function run(taskId: string): AuditRecord {
  return { ts: "2026-09-29T10:00:00.000Z", phase: "run-start", taskId };
}

function conflict(
  paths: string[],
  conflictKind?: string,
  remedy?: string,
): AuditRecord {
  return {
    ts: "2026-09-29T10:00:01.000Z",
    phase: "batch-guard",
    ok: false,
    errorClass: "conflict",
    changed: paths.length,
    paths,
    ...(conflictKind ? { conflictKind } : {}),
    ...(remedy ? { remedy } : {}),
  };
}

describe("summarizeZoneCost", () => {
  it("counts runs and distinct tasks from run facts", () => {
    const s = summarizeZoneCost([run("a"), run("b"), run("a")]);
    expect(s.runs).toBe(3);
    expect(s.tasks).toBe(2);
    expect(s.conflicts.total).toBe(0);
  });

  it("breaks conflicts down by kind and remedy", () => {
    const s = summarizeZoneCost([
      conflict(["outside/x.js"], "unauthorized-write", "revert"),
      conflict(["package.json"], "shared-drift", "pass"),
      conflict(["outside/y.js"], "unauthorized-write", "quarantine"),
    ]);
    expect(s.conflicts.total).toBe(3);
    expect(s.conflicts.byKind).toEqual({ "shared-drift": 1, "unauthorized-write": 2 });
    expect(s.conflicts.byRemedy).toEqual({ pass: 1, quarantine: 1, revert: 1 });
  });

  it("deduplicates paths but keeps every event", () => {
    // 同一路径被两个 run 命中是两次事件、一个路径 —— 前者是"拦了几次"，
    // 后者是"涉及多少文件"，两个数含义不同，不能互相替代。
    const s = summarizeZoneCost([
      conflict(["outside/x.js"], "unauthorized-write", "revert"),
      conflict(["outside/x.js"], "unauthorized-write", "revert"),
    ]);
    expect(s.conflicts.total).toBe(2);
    expect(s.conflicts.paths).toBe(1);
  });

  it("counts only reverting remedies as handled", () => {
    // pass / fail-batch 把文件留在原地：算进"已处置"会让回滚覆盖率看起来比事实高。
    const s = summarizeZoneCost([
      conflict(["a.js"], "unauthorized-write", "revert"),
      conflict(["b.js"], "unauthorized-write", "pass"),
      conflict(["c.js"], "unauthorized-write", "fail-batch"),
      conflict(["d.js"], "unauthorized-write", "quarantine"),
    ]);
    expect(s.conflicts.handledPaths).toBe(2);
    expect(s.conflicts.paths).toBe(4);
  });

  it("keeps pre-structural records visible as unknown/none instead of dropping them", () => {
    const s = summarizeZoneCost([conflict(["old.js"])]);
    expect(s.conflicts.byKind).toEqual({ unknown: 1 });
    expect(s.conflicts.byRemedy).toEqual({ none: 1 });
  });

  it("keeps counting after unrelated phases (skipping is not stopping)", () => {
    // 非 zone 事实（settings / stage / receipt）必须被**跳过**而不是中断扫描：
    // 审计是按时间顺序混写各种 phase 的，一条无关记录就把后半段历史丢掉，
    // 报告会变成"只统计到第一个 settings"。
    const s = summarizeZoneCost([
      { ts: "t", phase: "settings" },
      { ts: "t", phase: "stage", stage: "DEVELOPMENT" },
      run("a"),
      conflict(["x.js"], "unauthorized-write", "revert"),
    ]);
    expect(s.runs).toBe(1);
    expect(s.conflicts.total).toBe(1);
  });

  it("orders breakdown keys deterministically", () => {
    // 顺序是契约：同一份事实在两次运行里必须打印出同一行，否则审计对不上。
    // 断言**键序**而不是对象相等 —— toEqual 不看键顺序，排序判据写反了它也绿。
    const s = summarizeZoneCost([
      conflict(["a"], "unauthorized-write", "revert"),
      conflict(["b"], "shared-drift", "pass"),
    ]);
    expect(Object.keys(s.conflicts.byKind)).toEqual(["shared-drift", "unauthorized-write"]);
    expect(Object.keys(s.conflicts.byRemedy)).toEqual(["pass", "revert"]);
    const text = formatZoneCostReport(s).join("\n");
    expect(text.indexOf("shared-drift")).toBeLessThan(text.indexOf("unauthorized-write"));
  });

  it("gives a per-run rate only when there is a run denominator", () => {
    const withRuns = summarizeZoneCost([run("a"), run("b"), conflict(["x.js"], "shared-drift", "revert")]);
    expect(withRuns.conflictsPerRun).toBe(0.5);

    const noRuns = summarizeZoneCost([conflict(["x.js"], "shared-drift", "revert")]);
    // 0/0 不是"零越权率"，是"没有分母" —— 那种情况这个键必须不出现。
    expect("conflictsPerRun" in noRuns).toBe(false);
  });

  it("ignores phases that carry no zone facts", () => {
    const s = summarizeZoneCost([
      { ts: "t", phase: "settings" },
      { ts: "t", phase: "stage", stage: "DEVELOPMENT" },
      { ts: "t", phase: "receipt" },
    ]);
    expect(s).toMatchObject({ runs: 0, tasks: 0 });
    expect(s.conflicts.total).toBe(0);
  });
});

describe("planCost", () => {
  it("reports how many serial segments the mutex cost", () => {
    // 三个任务分三批 = 完全串行：extraBatches 就是被切的那两刀。
    const p = planCost([[{ id: "a" }], [{ id: "b" }], [{ id: "c" }]] as never);
    expect(p).toEqual({ batches: 3, tasks: 3, extraBatches: 2, largestBatch: 1 });
  });

  it("sees zero extra batches when everything runs in one wave", () => {
    const p = planCost([[{ id: "a" }, { id: "b" }]] as never);
    expect(p).toEqual({ batches: 1, tasks: 2, extraBatches: 0, largestBatch: 2 });
  });

  it("stays at zero for an empty plan instead of reporting a negative", () => {
    const p = planCost([]);
    expect(p.extraBatches).toBe(0);
    expect(p.largestBatch).toBe(0);
  });
});

describe("formatZoneCostReport", () => {
  it("prints the cost lines a reader can act on", () => {
    const cost: ZoneCostSummary = {
      runs: 4,
      tasks: 3,
      conflicts: {
        total: 2,
        byKind: { "unauthorized-write": 2 },
        byRemedy: { revert: 2 },
        paths: 2,
        handledPaths: 2,
      },
      conflictsPerRun: 0.5,
    };
    const lines = formatZoneCostReport(cost, planCost([[{ id: "a" }], [{ id: "b" }]] as never));
    const text = lines.join("\n");
    expect(text).toContain("run 4 次");
    expect(text).toContain("越权 2 次");
    expect(text).toContain("已处置");
    // 并行度那一行只在给了 plan 时出现：批次是预防，越权是漏网，两行不能混。
    expect(text).toContain("多出 1 段串行");
  });

  it("omits the plan line when no plan was supplied", () => {
    const cost: ZoneCostSummary = {
      runs: 1,
      tasks: 1,
      conflicts: { total: 0, byKind: {}, byRemedy: {}, paths: 0, handledPaths: 0 },
    };
    expect(formatZoneCostReport(cost).join("\n")).not.toContain("串行");
  });
});
