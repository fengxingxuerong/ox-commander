import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  formatUsageLine,
  meteredLlm,
  UsageMeter,
  type UsageSnapshot,
} from "../shared/usage-meter";
import type { ChatRequest, ChatResponse } from "../shared/providers";
import type { LlmClient } from "../shared/llm-client";

/**
 * `usageTokens` 采集了很久却零消费方（见 shared/usage-meter.ts 顶部说明）。
 * 这一组用例钉住的是"数得对"这件事 —— 尤其是**脏数据不能污染总量**：
 * 累进一个 NaN 会让之后所有汇总都变成 NaN，且不会报任何错。
 */

function sample(over: Partial<{ provider: string; model: string; usageTokens: number }> = {}) {
  return { provider: "sensenova", model: "deepseek-v4-flash", usageTokens: 100, ...over };
}

describe("UsageMeter · 累加", () => {
  it("跨调用累加，并按 provider/model 分桶", () => {
    const meter = new UsageMeter();
    meter.record(sample({ usageTokens: 100 }));
    meter.record(sample({ usageTokens: 50 }));
    meter.record(sample({ provider: "amd-radeon", model: "DeepSeek-V4-Flash", usageTokens: 7 }));

    const s = meter.snapshot();
    expect(s.totalTokens).toBe(157);
    expect(s.calls).toBe(3);
    expect(s.measuredCalls).toBe(3);
    expect(s.byModel).toEqual({
      "sensenova/deepseek-v4-flash": 150,
      "amd-radeon/DeepSeek-V4-Flash": 7,
    });
  });

  it("未上报用量只计调用次数，不计入总量", () => {
    const meter = new UsageMeter();
    meter.record(sample({ usageTokens: 100 }));
    meter.record(sample({ usageTokens: undefined }));

    const s = meter.snapshot();
    expect(s.totalTokens).toBe(100);
    expect(s.calls).toBe(2);
    // 这个差值就是"这份数字可信到什么程度"的可观测面。
    expect(s.calls - s.measuredCalls).toBe(1);
    expect(s.byModel).toEqual({ "sensenova/deepseek-v4-flash": 100 });
  });

  it("NaN / Infinity / 负数都不进总量（脏数据不能污染后续汇总）", () => {
    const meter = new UsageMeter();
    meter.record(sample({ usageTokens: 100 }));
    meter.record(sample({ usageTokens: Number.NaN }));
    meter.record(sample({ usageTokens: Number.POSITIVE_INFINITY }));
    meter.record(sample({ usageTokens: -500 }));

    const s = meter.snapshot();
    expect(s.totalTokens).toBe(100);
    // 四次调用都记了，但只有第一次被认为"有可信用量"。
    expect(s.calls).toBe(4);
    expect(s.measuredCalls).toBe(1);
  });

  it("缺 provider / model 时落进 unknown 桶，而不是拼出 undefined 字样", () => {
    const meter = new UsageMeter();
    meter.record({ usageTokens: 3 });
    expect(Object.keys(meter.snapshot().byModel)).toEqual(["unknown/unknown"]);
  });

  it("两次 snapshot 互不影响（快照不是内部状态的引用）", () => {
    const meter = new UsageMeter();
    meter.record(sample({ usageTokens: 10 }));
    const first = meter.snapshot();
    meter.record(sample({ usageTokens: 5 }));

    expect(first.totalTokens).toBe(10);
    expect(meter.snapshot().totalTokens).toBe(15);
    // 直接改第一次快照的 byModel 不能影响内部状态。
    first.byModel["sensenova/deepseek-v4-flash"] = 999;
    expect(meter.snapshot().byModel["sensenova/deepseek-v4-flash"]).toBe(15);
  });
});

describe("meteredLlm · 只当观察者", () => {
  function client(res: ChatResponse, onChat?: () => void): LlmClient {
    return {
      async chat(_req: ChatRequest) {
        onChat?.();
        return res;
      },
    };
  }

  it("转发请求、原样返回响应，并把用量记进 meter", async () => {
    const meter = new UsageMeter();
    const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
    let seen: ChatRequest | undefined;
    const inner: LlmClient = {
      async chat(r) {
        seen = r;
        return { content: "{}", provider: "p", model: "m", usageTokens: 42 };
      },
    };

    const res = await meteredLlm(inner, meter).chat(req);

    expect(seen).toBe(req);
    expect(res).toEqual({ content: "{}", provider: "p", model: "m", usageTokens: 42 });
    expect(meter.snapshot().totalTokens).toBe(42);
  });

  it("抛错的调用不记录（calls 的语义是成功拿到响应的次数）", async () => {
    const meter = new UsageMeter();
    const inner: LlmClient = {
      async chat() {
        throw new Error("boom");
      },
    };

    await expect(meteredLlm(inner, meter).chat({ messages: [] })).rejects.toThrow("boom");
    expect(meter.snapshot()).toEqual({ totalTokens: 0, calls: 0, measuredCalls: 0, byModel: {} });
  });

  it("不缓存响应：同一个 wrapper 连调两次，两次都转发", async () => {
    // 若哪天有人给装饰器加上记忆化，它就不再是"观察者"而是"缓存"了。
    const meter = new UsageMeter();
    let calls = 0;
    const wrapped = meteredLlm(client({ content: "x", provider: "p", model: "m", usageTokens: 1 }, () => { calls += 1; }), meter);

    await wrapped.chat({ messages: [] });
    await wrapped.chat({ messages: [] });

    expect(calls).toBe(2);
    expect(meter.snapshot().totalTokens).toBe(2);
  });
});

describe("UsageMeter · maxTokensPerRun 预算闸门", () => {
  it("达到上限后拒绝下一次调用，错误带已用/上限数字", () => {
    const meter = new UsageMeter({ maxTokensPerRun: 100 });
    meter.record(sample({ usageTokens: 100 }));
    expect(() => meter.assertWithinBudget()).toThrow(BudgetExceededError);
    try {
      meter.assertWithinBudget();
      expect.unreachable("应当抛出 BudgetExceededError");
    } catch (err) {
      const e = err as BudgetExceededError;
      expect(e.used).toBe(100);
      expect(e.limit).toBe(100);
      // message 必须可行动：宿主看到数字就知道该调大上限还是分拆运行。
      expect(e.message).toContain("100");
      expect(e.message).toContain("maxTokensPerRun");
    }
  });

  it("未达上限不拦截；恰好等于上限即拒绝（闸门是 >= 语义）", () => {
    const meter = new UsageMeter({ maxTokensPerRun: 100 });
    meter.record(sample({ usageTokens: 99 }));
    expect(() => meter.assertWithinBudget()).not.toThrow();
    meter.record(sample({ usageTokens: 1 }));
    expect(() => meter.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it("未配置上限时永不拦截", () => {
    const meter = new UsageMeter();
    meter.record(sample({ usageTokens: 10_000_000 }));
    expect(() => meter.assertWithinBudget()).not.toThrow();
  });

  it("0 / 负数 / 非有限数的上限一律不启用（配置笔误不能放大成拒绝服务）", () => {
    // 这条与 headless 协议层"显式传坏值直接拒绝"刻意不同：协议层面向宿主
    // 程序（错误应该立刻暴露），这里面向 settings 透传（UI 里 0 就是"不限"），
    // 闸门 宁可放行也不能把一次配置失误变成整轮 run 全部失败。
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const meter = new UsageMeter({ maxTokensPerRun: bad });
      meter.record(sample({ usageTokens: 100 }));
      expect(() => meter.assertWithinBudget(), `maxTokensPerRun=${String(bad)}`).not.toThrow();
    }
  });

  it("软上限：单次调用可以穿透上限，如实记录，下一跳才被拦", () => {
    // 闸门只能在调用前判定 —— 已经发生的那一次没法撤回；强行不给记录
    // 反而会让 totalTokens 与服务商账单对不上，违背可见性的初衷。
    const meter = new UsageMeter({ maxTokensPerRun: 100 });
    meter.record(sample({ usageTokens: 150 }));
    expect(meter.snapshot().totalTokens).toBe(150);
    expect(() => meter.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it("snapshot 带上限配置；未配置时不出该字段（快照字段即承诺）", () => {
    const limited = new UsageMeter({ maxTokensPerRun: 500 });
    expect(limited.snapshot().limit).toBe(500);
    expect("limit" in new UsageMeter().snapshot()).toBe(false);
  });
});

describe("meteredLlm · 预算闸门", () => {
  it("达到上限后下一次调用直接抛 BudgetExceededError，且不再透传给内层（闸门在最外层）", async () => {
    const meter = new UsageMeter({ maxTokensPerRun: 50 });
    let innerCalls = 0;
    const inner: LlmClient = {
      async chat() {
        innerCalls += 1;
        return { content: "x", provider: "p", model: "m", usageTokens: 50 };
      },
    };
    const wrapped = meteredLlm(inner, meter);

    await wrapped.chat({ messages: [] }); // 第一次：正好用满预算
    await expect(wrapped.chat({ messages: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(innerCalls).toBe(1); // 第二次根本没有烧钱
  });
});

describe("formatUsageLine", () => {
  function line(over: Partial<UsageSnapshot>): string {
    const base: UsageSnapshot = { totalTokens: 0, calls: 0, measuredCalls: 0, byModel: {} };
    return formatUsageLine({ ...base, ...over });
  }

  it("含总量与调用次数", () => {
    const out = line({ totalTokens: 1234, calls: 5, measuredCalls: 5 });
    expect(out).toContain("[usage]");
    expect(out).toContain("1234 tokens");
    expect(out).toContain("5 次调用");
  });

  it("全部上报时不出现「未上报」字样", () => {
    expect(line({ totalTokens: 10, calls: 2, measuredCalls: 2 })).not.toContain("未上报");
  });

  it("有未上报时显式给出次数", () => {
    expect(line({ totalTokens: 10, calls: 3, measuredCalls: 1 })).toContain("2 次未上报用量");
  });

  it("按用量降序列出线路", () => {
    const out = line({
      totalTokens: 30,
      calls: 2,
      measuredCalls: 2,
      byModel: { "b/m": 10, "a/m": 20 },
    });
    expect(out).toContain("a/m=20 / b/m=10");
  });

  it("零调用时不拼出空的分隔符", () => {
    expect(line({})).toBe("[usage] 0 tokens · 0 次调用");
  });
});
