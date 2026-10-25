import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_FACTS_CHARS,
  PLAN_FACTS_MARKER,
  collectPlanFacts,
  formatPlanFactsBlock,
  type FactRecord,
} from "../shared/plan-facts";
import type { PlanSnapshot } from "../shared/plan-history";

/**
 * 可核事实汇总（2026-10-25）。这一层的判据几乎全是"错了也不会报错"的类型：
 * 计数错 → 规划看到的账是假的；**键序不稳定 → 同一份审计在不同进程里给出不同文字**，
 * 而"可复现"正是这个特性敢被加进提示的前提（否则同一条需求每次规划都会看到不同的
 * 提示，无法归因）。所以可复现性单独成一组钉住。
 */

function rec(over: Partial<FactRecord> & { phase: string }): FactRecord {
  return { ...over };
}

const snap: PlanSnapshot = {
  ts: "2026-10-25T00:00:00.000Z",
  requirement: "r",
  goal: "g",
  taskTitles: ["t1"],
  taskCount: 3,
  requirementHash: "aaaaaaaa",
  featureCount: 1,
};

describe("collectPlanFacts · 只数可核事实", () => {
  it("没有记录 ⇒ 全零（不凭空造账）", () => {
    expect(collectPlanFacts([])).toEqual({
      dispatched: 0,
      failed: 0,
      failuresByClass: [],
      conflictsByKind: [],
      remedies: [],
    });
  });

  it("run-start 计派发；run-end ok=false 才算失败", () => {
    const facts = collectPlanFacts([
      rec({ phase: "run-start" }),
      rec({ phase: "run-start" }),
      rec({ phase: "run-end", ok: true }),
      rec({ phase: "run-end", ok: false, errorClass: "test-red" }),
    ]);
    expect(facts.dispatched).toBe(2);
    expect(facts.failed).toBe(1);
    expect(facts.failuresByClass).toEqual([{ errorClass: "test-red", count: 1 }]);
  });

  it("run-end 的 ok 缺席（腰斩）既不算成功也不算失败 —— 不编造因果", () => {
    // 这与 `trailBriefForRepair` 是同一条纪律：没有结论的派发不是"错了"。
    const facts = collectPlanFacts([
      rec({ phase: "run-start" }),
      rec({ phase: "run-end" }),
      rec({ phase: "run-end", ok: false }),
    ]);
    expect(facts.failed).toBe(1); // 只有显式 ok=false 的那条
    expect(facts.failuresByClass).toEqual([{ errorClass: "unknown", count: 1 }]);
  });

  it("缺 errorClass 的失败归到 unknown（不让它消失，也不编一个原因）", () => {
    const facts = collectPlanFacts([rec({ phase: "run-end", ok: false })]);
    expect(facts.failuresByClass).toEqual([{ errorClass: "unknown", count: 1 }]);
  });

  it("zone 冲突按 kind 聚合、处置按 remedy 聚合", () => {
    const facts = collectPlanFacts([
      rec({ phase: "batch-guard", conflictKind: "unauthorized-write", remedy: "revert" }),
      rec({ phase: "batch-guard", conflictKind: "unauthorized-write", remedy: "revert" }),
      rec({ phase: "batch-guard", conflictKind: "shared-drift", remedy: "quarantine" }),
    ]);
    expect(facts.conflictsByKind).toEqual([
      { kind: "shared-drift", count: 1 },
      { kind: "unauthorized-write", count: 2 },
    ]);
    expect(facts.remedies).toEqual([
      { remedy: "quarantine", count: 1 },
      { remedy: "revert", count: 2 },
    ]);
  });

  it("batch-guard 缺 conflictKind / remedy 时跳过，不数成空键", () => {
    const facts = collectPlanFacts([rec({ phase: "batch-guard" })]);
    expect(facts.conflictsByKind).toEqual([]);
    expect(facts.remedies).toEqual([]);
  });

  it("给了上次规划 ⇒ 带上任务数；没给则键不出现", () => {
    expect(collectPlanFacts([], snap).lastTaskCount).toBe(3);
    expect("lastTaskCount" in collectPlanFacts([])).toBe(false);
  });

  it("别的阶段（stage / receipt / batch-changes）不参与计数", () => {
    const facts = collectPlanFacts([
      rec({ phase: "stage" }),
      rec({ phase: "receipt" }),
      rec({ phase: "batch-changes", changed: 5 }),
    ]);
    expect(facts.dispatched).toBe(0);
    expect(facts.failed).toBe(0);
  });
});

describe("可复现性（本特性的前提）", () => {
  it("同一批事实、**任何写入顺序** ⇒ 逐字相同的块", () => {
    // 键序取决于 Map 的插入序 = 审计记录的写入顺序。不显式排序的话，
    // 同一批事实换个顺序写，规划看到的提示就变了 —— 而需求一个字都没改。
    const a: FactRecord[] = [
      rec({ phase: "run-end", ok: false, errorClass: "test-red" }),
      rec({ phase: "run-end", ok: false, errorClass: "build-red" }),
      rec({ phase: "batch-guard", conflictKind: "shared-drift", remedy: "quarantine" }),
    ];
    const b: FactRecord[] = [
      rec({ phase: "batch-guard", conflictKind: "shared-drift", remedy: "quarantine" }),
      rec({ phase: "run-end", ok: false, errorClass: "build-red" }),
      rec({ phase: "run-end", ok: false, errorClass: "test-red" }),
    ];
    expect(formatPlanFactsBlock(collectPlanFacts(a, snap))).toBe(
      formatPlanFactsBlock(collectPlanFacts(b, snap)),
    );
  });

  it("块里不出现任何绝对时间/日期（「3 天前」过一夜就变，规划没有理由依赖它）", () => {
    const block = formatPlanFactsBlock(
      collectPlanFacts([rec({ phase: "run-end", ok: false, errorClass: "test-red" })], snap),
    );
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(block).not.toMatch(/\d{1,2}:\d{2}/);
    expect(block).not.toContain("天前");
    expect(block).not.toContain("小时前");
  });
});

describe("formatPlanFactsBlock · 注入块", () => {
  it("没有值得说的事实 ⇒ 空串（不产空标题）", () => {
    expect(formatPlanFactsBlock(collectPlanFacts([]))).toBe("");
    // 有派发但零失败、零冲突 ⇒ 也没什么可说的（"你从没红过"不构成参考）。
    expect(formatPlanFactsBlock(collectPlanFacts([rec({ phase: "run-start" })]))).toBe("");
  });

  it("只有冲突、没有处置（remedies 为空）⇒ 仍然产块", () => {
    // 三个条件必须**各自独立**成立：`failed=0 + conflicts>0 + remedies=0` 这一格
    // 是 site 审计抓出来的（`||` 改 `&&` 存活）。它对应真实场景：账上记了越权，
    // 但那条记录没带 remedy（老记录、或只记了 kind）。
    const facts = collectPlanFacts([rec({ phase: "batch-guard", conflictKind: "unauthorized-write" })]);
    expect(facts.remedies).toEqual([]);
    const block = formatPlanFactsBlock(facts);
    expect(block).not.toBe("");
    expect(block).toContain("unauthorized-write × 1");
  });

  it("只有处置、没有冲突 ⇒ 也产块（对称的一格）", () => {
    const facts = collectPlanFacts([rec({ phase: "batch-guard", remedy: "revert" })]);
    expect(facts.conflictsByKind).toEqual([]);
    expect(formatPlanFactsBlock(facts)).not.toBe("");
  });

  it("有失败：带标记、派发/失败数、按原因聚合，并声明它是账不是决定", () => {
    const block = formatPlanFactsBlock(
      collectPlanFacts(
        [
          rec({ phase: "run-start" }),
          rec({ phase: "run-start" }),
          rec({ phase: "run-end", ok: false, errorClass: "test-red" }),
          rec({ phase: "run-end", ok: true }),
        ],
        snap,
      ),
    );
    expect(block.startsWith(PLAN_FACTS_MARKER)).toBe(true);
    expect(block).toContain("历史派发 2 次，其中判失败 1 次");
    expect(block).toContain("test-red × 1");
    expect(block).toContain("上一版 PRD 拆出 3 个任务");
    // 信任面：只陈述账，不给建议 —— "所以你应该…"属于规划大脑，平台写进来
    // 就等于把自己的推断伪装成事实。
    expect(block).toContain("它们是**账**，不是决定");
    expect(block).not.toContain("所以你应该");
  });

  it("冲突与处置都印出来", () => {
    const block = formatPlanFactsBlock(
      collectPlanFacts([
        rec({ phase: "batch-guard", conflictKind: "unauthorized-write", remedy: "revert" }),
      ]),
    );
    expect(block).toContain("zone 越权/共享漂移拦下");
    expect(block).toContain("unauthorized-write × 1");
    expect(block).toContain("仲裁处置");
    expect(block).toContain("revert × 1");
  });

  it("单项超过上限只列前几项，并说破「另有 N 项未列出」", () => {
    const many: FactRecord[] = Array.from({ length: 9 }, (_, i) =>
      rec({ phase: "run-end", ok: false, errorClass: `cls-${String(i).padStart(2, "0")}` }),
    );
    const block = formatPlanFactsBlock(collectPlanFacts(many));
    expect(block).toContain("cls-00 × 1");
    expect(block).toContain("另有 3 项未列出");
    expect(block).not.toContain("cls-08");
  });

  it("超过字符上限：截断并说破原文长度（与约定/备忘同一套纪律）", () => {
    // ⚠️ 造输入时踩过一次：光靠"很多错误类"撑不爆上限 —— `MAX_LISTED` 会先把它
    // 压成 6 项 + "另有 N 项"，反而更短。要真正触发截断，得让**单项本身**很长：
    // 一个超长的 errorClass 名字（模型/外部命令都可能造出这种）就够。
    const longClass = "x".repeat(MAX_PLAN_FACTS_CHARS + 500);
    const block = formatPlanFactsBlock(
      collectPlanFacts([rec({ phase: "run-end", ok: false, errorClass: longClass })]),
    );
    expect(block).toContain("已截断");
    expect(block).toMatch(/事实块原文共 \d+ 字符/);
    expect(block).toContain(`上限 ${MAX_PLAN_FACTS_CHARS}`);
  });
});
