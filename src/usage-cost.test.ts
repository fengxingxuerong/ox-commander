import { describe, expect, it } from "vitest";
import {
  formatUsageCostReport,
  summarizeUsageCost,
  type UsageCostInput,
} from "../electron/usage-cost";

/**
 * 凭据 JSON 里 usage 段的实况形状：`byModel` 可省（旧凭据 / 无上报的 run），
 * 所以这里**不用** `UsageSnapshot`（它的 byModel 必填）—— 测的就是缺席这条路。
 */
interface ReceiptUsageJson {
  totalTokens: number;
  calls: number;
  measuredCalls: number;
  byModel?: Record<string, number>;
  limit?: number;
}

/** 最小可判读凭据：只带聚合要读的字段，其余按需展开。 */
function receipt(opts: { outcome?: string; usage?: ReceiptUsageJson }): string {
  return JSON.stringify({
    outcome: opts.outcome ?? "delivered",
    verified: true,
    rounds: 0,
    checks: [],
    tasks: [],
    conflicts: [],
    ...(opts.usage ? { usage: opts.usage } : {}),
  });
}

function input(label: string, json: string): UsageCostInput {
  return { label, receiptJson: json };
}

describe("summarizeUsageCost", () => {
  it("sums tokens/calls/unmetered across receipts", () => {
    const s = summarizeUsageCost([
      input("p1", receipt({ usage: { totalTokens: 100, calls: 4, measuredCalls: 3, byModel: {} } })),
      input("p2", receipt({ usage: { totalTokens: 50, calls: 2, measuredCalls: 2, byModel: {} } })),
    ]);
    expect(s.receipts).toBe(2);
    expect(s.broken).toBe(0);
    expect(s.totalTokens).toBe(150);
    expect(s.calls).toBe(6);
    // 4+2 次调用里 3+2 次上报 ⇒ 1 次未上报：可信边界必须随总量一起可读。
    expect(s.unmetered).toBe(1);
  });

  it("aggregates byModel across receipts and sorts by tokens desc, key asc on ties", () => {
    const s = summarizeUsageCost([
      input("a", receipt({ usage: { totalTokens: 70, calls: 2, measuredCalls: 2, byModel: { "sensenova/glm-5.2": 50, "sensenova/deepseek-v4-flash": 20 } } })),
      input("b", receipt({ usage: { totalTokens: 50, calls: 1, measuredCalls: 1, byModel: { "sensenova/glm-5.2": 30, "coze/worker": 20 } } })),
    ]);
    expect(s.detailed).toBe(2);
    // glm-5.2 = 50+30 = 80 领先；deepseek 与 coze 各 20，键升序决定次序。
    expect(s.byModel).toEqual([
      { key: "sensenova/glm-5.2", tokens: 80 },
      { key: "coze/worker", tokens: 20 },
      { key: "sensenova/deepseek-v4-flash", tokens: 20 },
    ]);
  });

  it("keeps receipts without byModel out of the model table but in the project rows", () => {
    const s = summarizeUsageCost([
      input("old", receipt({ usage: { totalTokens: 40, calls: 2, measuredCalls: 2 } })),
      input("new", receipt({ usage: { totalTokens: 10, calls: 1, measuredCalls: 1, byModel: { "sensenova/glm-5.2": 10 } } })),
    ]);
    // 分母边界：2 份凭据只有 1 份有明细 —— 旧凭据不装作 0 进排名。
    expect(s.detailed).toBe(1);
    expect(s.byModel).toEqual([{ key: "sensenova/glm-5.2", tokens: 10 }]);
    expect(s.byProject).toHaveLength(2);
    expect(s.byProject[0]).toEqual({ label: "new", outcome: "delivered", totalTokens: 10, calls: 1, unmetered: 0, models: [{ key: "sensenova/glm-5.2", tokens: 10 }] });
    expect("models" in s.byProject[1]).toBe(false);
  });

  it("treats a receipt without usage as zero-usage, not as broken", () => {
    const s = summarizeUsageCost([input("bare", receipt({}))]);
    expect(s.receipts).toBe(1);
    expect(s.broken).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.byProject[0]).toEqual({ label: "bare", outcome: "delivered", totalTokens: 0, calls: 0, unmetered: 0 });
  });

  it("counts unparsable or non-receipt JSON as broken instead of dropping it silently", () => {
    const s = summarizeUsageCost([
      input("bad-json", "{not json"),
      input("not-a-receipt", JSON.stringify({ hello: "world" })),
      input("good", receipt({ usage: { totalTokens: 5, calls: 1, measuredCalls: 1, byModel: { "sensenova/glm-5.2": 5 } } })),
    ]);
    expect(s.receipts).toBe(1);
    expect(s.broken).toBe(2);
    expect(s.totalTokens).toBe(5);
  });

  it("rejects a receipt whose outcome key exists but is not a string", () => {
    // 形状守卫必须咬到「值」这一层：只查键存在会把 {outcome: 42} 当凭据收进聚合，
    // "解析失败"从此少计、"凭据份数"多计 —— 两边一起漂。
    const s = summarizeUsageCost([
      input("numeric-outcome", JSON.stringify({ outcome: 42, usage: { totalTokens: 9, calls: 1, measuredCalls: 1, byModel: {} } })),
    ]);
    expect(s.receipts).toBe(0);
    expect(s.broken).toBe(1);
    expect(s.totalTokens).toBe(0);
  });

  it("sorts project rows by label for deterministic output", () => {
    const s = summarizeUsageCost([
      input("zeta", receipt({})),
      input("alpha", receipt({})),
    ]);
    expect(s.byProject.map((p) => p.label)).toEqual(["alpha", "zeta"]);
  });
});

describe("formatUsageCostReport", () => {
  it("keeps the unmetered boundary and the broken count on the headline", () => {
    const lines = formatUsageCostReport(
      summarizeUsageCost([
        input("p1", receipt({ usage: { totalTokens: 100, calls: 4, measuredCalls: 3, byModel: {} } })),
        input("bad", "{oops"),
      ]),
    );
    expect(lines[0]).toContain("凭据 1 份");
    expect(lines[0]).toContain("1 次未上报用量");
    expect(lines[0]).toContain("解析失败 1 份");
  });

  it("states the empty-model-table case instead of printing nothing", () => {
    const lines = formatUsageCostReport(summarizeUsageCost([input("old", receipt({}))]));
    expect(lines.some((l) => l.includes("没有凭据带 byModel 明细"))).toBe(true);
  });

  it("always states that per-task attribution does not exist in persisted facts", () => {
    const lines = formatUsageCostReport(summarizeUsageCost([]));
    expect(lines[lines.length - 1]).toContain("按任务的归因今天不存在");
  });

  it("renders per-model rows and per-receipt rows from the same summary", () => {
    const lines = formatUsageCostReport(
      summarizeUsageCost([
        input("proj", receipt({ usage: { totalTokens: 30, calls: 2, measuredCalls: 2, byModel: { "sensenova/glm-5.2": 20, "coze/worker": 10 } } })),
      ]),
    );
    expect(lines.some((l) => l === "  · sensenova/glm-5.2: 20")).toBe(true);
    expect(lines.some((l) => l === "  · coze/worker: 10")).toBe(true);
    expect(lines.some((l) => l.includes("proj: delivered · 30 tokens · 2 次"))).toBe(true);
  });
});
