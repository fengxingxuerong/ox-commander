import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_HISTORY,
  MAX_PLAN_HISTORY_CHARS,
  PLAN_HISTORY_MARKER,
  PLAN_SNAPSHOT_MAX_TITLES,
  PLAN_SNAPSHOT_REQUIREMENT_CHARS,
  formatPlanHistoryBlock,
  formatPlanHistoryForDecompose,
  planDiffOf,
  planHistoryOf,
  planSnapshotOf,
  requirementFingerprint,
  type PlanSnapshot,
} from "../shared/plan-history";

/**
 * 规划历史（形态 B，2026-10-25）。这一层只做纯判定，但每条判据错了都**不抛错**：
 * 指纹算错 → "需求改过"被说成"没改"；历史取错条 → 注入的是上一版的上一版；
 * 差异算错 → 人会以为拆法一致而其实已经变了。所以逐条钉边界。
 */

function snap(over: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    ts: "2026-10-25T10:00:00.000Z",
    requirement: "做一个 CSV 工具",
    goal: "交付 CSV 统计工具",
    taskTitles: ["t1", "t2"],
    taskCount: 2,
    requirementHash: requirementFingerprint("做一个 CSV 工具"),
    featureCount: 3,
    ...over,
  };
}

describe("requirementFingerprint · 需求指纹", () => {
  it("同一份原文永远同一指纹（跨进程也要一致：FNV 是确定算法，不是随机盐）", () => {
    expect(requirementFingerprint("做一个 CSV 工具")).toBe(requirementFingerprint("做一个 CSV 工具"));
    // 已知值锚：把算法钉死，改实现（比如换成 md5 截断）会当场红。
    expect(requirementFingerprint("")).toBe("811c9dc5");
    expect(requirementFingerprint("a")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("改一个字就是另一个指纹", () => {
    expect(requirementFingerprint("做一个 CSV 工具")).not.toBe(
      requirementFingerprint("做一个 CSV 统计工具"),
    );
    // 尾换行也算改：指纹不对文本做归一化（两处各 trim 一次就必然漂）。
    expect(requirementFingerprint("需求")).not.toBe(requirementFingerprint("需求\n"));
  });

  it("输出恒为 8 位十六进制（长度固定，审计行不会因长短需求膨胀）", () => {
    for (const text of ["", "x", "一".repeat(300), "a".repeat(4096)]) {
      expect(requirementFingerprint(text), text.slice(0, 8)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("planSnapshotOf · 造快照", () => {
  it("需求截断到上限，但指纹用**完整原文**算（截断不该改变身份）", () => {
    const long = "需".repeat(PLAN_SNAPSHOT_REQUIREMENT_CHARS + 500);
    const s = planSnapshotOf({
      ts: "T",
      requirement: long,
      prd: { goal: "g", features: ["f"] },
      tasks: [{ title: "t1" }],
    });
    expect(s.requirement).toHaveLength(PLAN_SNAPSHOT_REQUIREMENT_CHARS);
    expect(s.requirementHash).toBe(requirementFingerprint(long));
  });

  it("任务标题截断到上限，但 taskCount 保持完整（说破截断靠这两个数配合）", () => {
    const tasks = Array.from({ length: PLAN_SNAPSHOT_MAX_TITLES + 5 }, (_, i) => ({ title: `t${i}` }));
    const s = planSnapshotOf({ ts: "T", requirement: "r", prd: { goal: "g", features: [] }, tasks });
    expect(s.taskTitles).toHaveLength(PLAN_SNAPSHOT_MAX_TITLES);
    expect(s.taskCount).toBe(tasks.length);
  });

  it("featureCount 与 goal 原样带上（判据靠它们读「上次拆得够不够细」）", () => {
    const s = planSnapshotOf({
      ts: "T",
      requirement: "r",
      prd: { goal: "目标句", features: ["a", "b", "c"] },
      tasks: [],
    });
    expect(s.goal).toBe("目标句");
    expect(s.featureCount).toBe(3);
  });

  it("残缺的 PRD / 任务（未过 parsePrd 的对象）按空收口，不抛", () => {
    // 2026-10-25 实测：宿主可能在 PRD 校验之前就留现场，或渲染层传来的形状还没收窄。
    // 让一条残缺 PRD 把一次规划搞崩，比"历史少一版"严重得多 —— 快照是背景。
    const s = planSnapshotOf({
      ts: "T",
      requirement: "r",
      prd: {},
      tasks: [{}, { title: "有标题" }],
    });
    expect(s.goal).toBe("");
    expect(s.featureCount).toBe(0);
    expect(s.taskTitles).toEqual(["", "有标题"]);
    expect(s.taskCount).toBe(2);
  });
});

describe("planHistoryOf · 从审计记录取历史", () => {
  it("只认 phase === plan，别的阶段一律跳过", () => {
    const out = planHistoryOf([
      { phase: "stage", ts: "2026-10-25T12:00:00.000Z" },
      { phase: "plan", ts: "2026-10-25T10:00:00.000Z", plan: snap({ ts: "2026-10-25T10:00:00.000Z" }) },
    ]);
    expect(out).toHaveLength(1);
  });

  it("缺 plan 字段的残记录跳过（不猜、不补默认值）", () => {
    // 残缺的"上次规划"比没有更糟：人会以为那就是全部事实。
    const out = planHistoryOf([{ phase: "plan", ts: "2026-10-25T10:00:00.000Z" }]);
    expect(out).toEqual([]);
  });

  it("按 ts 降序（最新在前），与记录写入顺序无关", () => {
    // 乱序输入 → 输出必须仍是最新在前；`continue` 写成 `break` 时，
    // 一条残缺记录会把后面的历史全部截掉。
    const out = planHistoryOf([
      { phase: "plan", ts: "T-old", plan: snap({ ts: "2026-10-25T08:00:00.000Z" }) },
      { phase: "plan", ts: "T-broken" },
      { phase: "plan", ts: "T-new", plan: snap({ ts: "2026-10-25T12:00:00.000Z" }) },
    ]);
    expect(out.map((s) => s.ts)).toEqual(["2026-10-25T12:00:00.000Z", "2026-10-25T08:00:00.000Z"]);
  });

  it("limit 生效；limit=0 返回空（不是全量）", () => {
    const records = Array.from({ length: 8 }, (_, i) => ({
      phase: "plan",
      ts: `T${i}`,
      plan: snap({ ts: `2026-10-25T0${i}:00:00.000Z` }),
    }));
    expect(planHistoryOf(records)).toHaveLength(MAX_PLAN_HISTORY);
    expect(planHistoryOf(records, 2)).toHaveLength(2);
    expect(planHistoryOf(records, 0)).toEqual([]);
  });
});

describe("planDiffOf · 上次 vs 这次", () => {
  it("没有上次时返回 undefined（不编一份空差异）", () => {
    expect(planDiffOf(undefined, snap())).toBeUndefined();
  });

  it("任务增删都算出来；任务数前后各取各自的数", () => {
    const previous = snap({ taskTitles: ["t1", "t2"], taskCount: 2 });
    const current = snap({ taskTitles: ["t2", "t3"], taskCount: 2 });
    const diff = planDiffOf(previous, current)!;
    expect(diff.added).toEqual(["t3"]);
    expect(diff.removed).toEqual(["t1"]);
    expect(diff.taskCountBefore).toBe(2);
    expect(diff.taskCountAfter).toBe(2);
  });

  it("需求变没变看指纹，不看文本长度或标题", () => {
    const previous = snap({ requirementHash: "aaaaaaaa" });
    expect(planDiffOf(previous, snap({ requirementHash: "aaaaaaaa" }))!.requirementChanged).toBe(false);
    expect(planDiffOf(previous, snap({ requirementHash: "bbbbbbbb" }))!.requirementChanged).toBe(true);
  });
});

describe("formatPlanHistoryBlock · 注入块", () => {  it("没有上次 ⇒ 空串（不产空标题）", () => {
    expect(formatPlanHistoryBlock(undefined, undefined)).toBe("");
  });

  it("有上次：带标记、需求摘要、目标、任务清单，并声明它是事实不是建议", () => {
    const block = formatPlanHistoryBlock(snap({ goal: "上次的目标句" }), undefined);
    expect(block.startsWith(PLAN_HISTORY_MARKER)).toBe(true);
    expect(block).toContain("上次的目标句");
    expect(block).toContain("上次拆出 2 个任务");
    expect(block).toContain("t1、t2");
    // 信任面写死在这一层：它是落盘事实，不是建议、也不代表已交付。
    expect(block).toContain("不是建议");
    expect(block).toContain("不代表那次已交付");
  });

  it("空需求 / 空目标 / 空清单各有说破的占位，不印出空白行", () => {
    const block = formatPlanHistoryBlock(
      snap({ requirement: "   ", goal: "  ", taskTitles: [], taskCount: 0 }),
      undefined,
    );
    expect(block).toContain("上次需求摘要：（空）");
    expect(block).toContain("上次目标：（空）");
    expect(block).toContain("上次拆出 0 个任务：（无）");
  });

  it("给了差异就把「改没改 + 任务数前后 + 增删」都印出来", () => {
    const block = formatPlanHistoryBlock(snap(), {
      requirementChanged: true,
      taskCountBefore: 2,
      taskCountAfter: 3,
      added: ["t3"],
      removed: ["t1"],
    });
    expect(block).toContain("已改动");
    expect(block).toContain("任务数 2 → 3");
    expect(block).toContain("这次新增的任务：t3");
    expect(block).toContain("这次不再出现的任务：t1");
  });

  it("需求没改时印「未变」，且不印增删行（空清单不产空行）", () => {
    const block = formatPlanHistoryBlock(snap(), {
      requirementChanged: false,
      taskCountBefore: 2,
      taskCountAfter: 2,
      added: [],
      removed: [],
    });
    expect(block).toContain("未变");
    expect(block).not.toContain("这次新增的任务");
    expect(block).not.toContain("这次不再出现的任务");
  });

  it("超上限：截断并说破原文长度（不静默丢）", () => {
    const block = formatPlanHistoryBlock(
      snap({
        requirement: "x".repeat(PLAN_SNAPSHOT_REQUIREMENT_CHARS),
        goal: "g".repeat(500),
        taskTitles: Array.from({ length: PLAN_SNAPSHOT_MAX_TITLES }, (_, i) => `很长的任务标题${i}`.repeat(20)),
        taskCount: 99,
      }),
      {
        requirementChanged: true,
        taskCountBefore: 99,
        taskCountAfter: 99,
        added: ["a".repeat(400)],
        removed: ["b".repeat(400)],
      },
    );
    expect(block.length).toBeLessThanOrEqual(MAX_PLAN_HISTORY_CHARS + 200);
    expect(block).toContain("已截断");
    expect(block).toMatch(/上次规划块原文共 \d+ 字符/);
    expect(block).toContain(`上限 ${MAX_PLAN_HISTORY_CHARS}`);
  });
});

/**
 * 分解提示里的"上次拆法"块（2026-10-25）。
 *
 * 这是任务级差异真正能被模型看见的那一处 —— PRD 提示那一刻这次的任务清单还不存在，
 * 所以"上次切成了什么"只能在这里给，且必须给成**可执行指令**（保持 / 显式说明为什么变），
 * 而不是一段只供阅读的历史。
 */
describe("formatPlanHistoryForDecompose · 分解提示里的上次拆法", () => {
  it("没有上次 ⇒ 空串（不产空标题）", () => {
    expect(formatPlanHistoryForDecompose(undefined)).toBe("");
  });

  it("有上次：带标记、上次任务清单，并给出可执行指令（保持 or 写清为什么改）", () => {
    const block = formatPlanHistoryForDecompose(snap({ taskTitles: ["配置模块", "统计模块"], taskCount: 2 }));
    expect(block.startsWith(PLAN_HISTORY_MARKER)).toBe(true);
    expect(block).toContain("配置模块、统计模块");
    // 指令必须两条都在：沿用同一套切法、或写清改的理由 —— 缺任意一条，
    // 「比 diff」这件事就变成无谓重排。
    expect(block).toContain("沿用同一套切法");
    expect(block).toContain("写清为什么改");
    // 它仍然声明自己是事实而非建议（与 PRD 侧那个块同一口径）。
    expect(block).toContain("落盘事实");
  });

  it("空标题被滤掉且不印出多余的分隔符", () => {
    const block = formatPlanHistoryForDecompose(snap({ taskTitles: ["A", "", "B"], taskCount: 3 }));
    expect(block).toContain("A、B");
    expect(block).not.toContain("、、");
    // taskCount 仍说 3（清单被过滤是展示层的事，事实不因展示而改）。
    expect(block).toContain("上次 3 个任务");
  });

  it("全部标题为空 ⇒ 印「（无）」而不是一行空白", () => {
    const block = formatPlanHistoryForDecompose(snap({ taskTitles: ["", " "], taskCount: 2 }));
    expect(block).toContain("（无）");
  });

  it("超上限：截断并说破原文长度（与 PRD 侧那个块同一套纪律）", () => {
    const block = formatPlanHistoryForDecompose(
      snap({
        taskTitles: Array.from({ length: PLAN_SNAPSHOT_MAX_TITLES }, (_, i) => `很长的任务标题${i}`.repeat(30)),
        taskCount: 12,
      }),
    );
    expect(block).toContain("已截断");
    expect(block).toMatch(/上次分解块原文共 \d+ 字符/);
    expect(block).toContain(`上限 ${MAX_PLAN_HISTORY_CHARS}`);
  });
});
