import { describe, expect, it } from "vitest";
import { attentionHeadline, attentionOf, type AttentionBoardShape } from "./attention";
import type { EscalationView, ApprovalView } from "./types";

function esc(taskId: string, resolved = false): EscalationView {
  return { taskId, summary: `${taskId} 摘要`, resolved };
}
function appr(requestId: string, resolved = false): ApprovalView {
  return { requestId, command: "npm", args: ["test"], resolved };
}

function board(partial: Partial<AttentionBoardShape>): AttentionBoardShape {
  return { tasks: [], escalations: [], approvals: [], ...partial };
}

describe("attentionOf", () => {
  it("returns nothing when the board needs no one", () => {
    expect(
      attentionOf(
        board({
          tasks: [{ taskId: "t1", title: "做某事", status: "running" }],
          escalations: [esc("t9", true)],
          approvals: [appr("r9", true)],
        }),
      ),
    ).toEqual([]);
    expect(attentionHeadline([])).toBeUndefined();
  });

  it("escalations come first: an unanswered verdict blocks the whole run", () => {
    const items = attentionOf(
      board({
        escalations: [esc("t2")],
        approvals: [appr("r1")],
        tasks: [{ taskId: "t1", title: "失败任务", status: "failed" }],
      }),
    );
    expect(items[0]).toMatchObject({ kind: "escalation", taskId: "t2" });
    expect(items[1]).toMatchObject({ kind: "approval" });
    expect(items[2]).toMatchObject({ kind: "failed-task", taskId: "t1" });
    expect(attentionHeadline(items)).toBe("该你了：3 件事");
  });

  it("does not double-report a failed task that already has an escalation card", () => {
    const items = attentionOf(
      board({
        escalations: [esc("t1")],
        tasks: [{ taskId: "t1", title: "同一任务", status: "failed", errorClass: "timeout" }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "escalation" });
  });

  it("reports a failed task at rest with its error class when present", () => {
    const items = attentionOf(
      board({
        tasks: [
          { taskId: "a", title: "A", status: "failed", errorClass: "timeout" },
          { taskId: "b", title: "B", status: "failed" },
          { taskId: "c", title: "C", status: "done" },
          { taskId: "d", title: "D", status: "pending" },
        ],
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(["failed-task", "failed-task"]);
    expect(items[0]!.label).toContain("（timeout）");
    expect(items[0]!.label).not.toContain("undefined");
    expect(items[1]!.label).toContain("B");
  });

  it("sorts same-kind items by taskId for deterministic order", () => {
    const items = attentionOf(
      board({
        escalations: [esc("t5"), esc("t2")],
      }),
    );
    expect(items.map((i) => i.taskId)).toEqual(["t2", "t5"]);
  });

  it("carries the interrupted marker as the lowest-priority item", () => {
    const items = attentionOf(board({ escalations: [esc("t1")], interrupted: true }));
    expect(items.map((i) => i.kind)).toEqual(["escalation", "interrupted"]);
    expect(items[1]!.taskId).toBeUndefined();
  });

  it("renders an approval label with the full command line", () => {
    const items = attentionOf(board({ approvals: [appr("r1")] }));
    expect(items[0]!.label).toContain("npm test");
  });

  it("a resolved item earlier in the list does not hide later unresolved ones", () => {
    // 三条 continue 的区分用例：已处理项只跳过自己，不许截断整张清单 ——
    // 否则"先处理了 r1，r2 就永远不被看见"（continue → break 变异的杀手）。
    const items = attentionOf(
      board({
        escalations: [esc("t-done", true), esc("t-open")],
        approvals: [appr("r-done", true), appr("r-open")],
        tasks: [
          { taskId: "first-done", title: "先完成的", status: "done" },
          { taskId: "late-failed", title: "后失败的", status: "failed" },
        ],
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(["escalation", "approval", "failed-task"]);
    expect(items[0]!.taskId).toBe("t-open");
    expect(items[1]!.label).toContain("npm test");
    expect(items[2]!.taskId).toBe("late-failed");
  });
});

describe("attentionHeadline", () => {
  it("counts items and only exists when there is something to see", () => {
    expect(attentionHeadline(attentionOf(board({})))).toBeUndefined();
    expect(attentionHeadline(attentionOf(board({ approvals: [appr("r1")] })))).toBe("该你了：1 件事");
  });
});
