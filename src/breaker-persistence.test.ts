import { describe, expect, it } from "vitest";
import { CircuitBreaker, type AgentTotals, type CircuitPersistence } from "../electron/sandbox/circuit-breaker";

/**
 * 成功率总账的跨 run 持久化（2026-10-11 竞品刷新，ruflo「自适应记忆」对位）。
 * 断言的是四件事：恢复的是总账不是熔断状态、record 会写回、坏账从零开始、
 * 淡出封顶保比例。
 */
describe("CircuitBreaker persistence", () => {
  function memoryPersistence(initial?: Record<string, AgentTotals>) {
    let store: Record<string, AgentTotals> | undefined = initial;
    const writes: Record<string, AgentTotals>[] = [];
    const p: CircuitPersistence = {
      load: () => store,
      save: (totals) => {
        writes.push(totals);
        store = totals;
      },
    };
    return { p, writes, read: () => store };
  }

  it("[1] load 恢复总账：successRate 先验立即可用，但一律 closed 起步", () => {
    const { p } = memoryPersistence({ a1: { successes: 7, failures: 3 } });
    const b = new CircuitBreaker({ persistence: p });
    expect(b.state("a1")).toBe("closed");
    const s = b.stats("a1");
    expect(s.successes).toBe(7);
    expect(s.failures).toBe(3);
    expect(s.successRate).toBeCloseTo(0.7);
    expect(s.consecutiveFailures).toBe(0);
    expect(b.allow("a1")).toBe(true);
  });

  it("[2] 不恢复 consecutiveFailures/openedAt：上一 run 连败 3 次的 agent 不该在新进程里直接开闸", () => {
    // 构造一份"持久化时刻已开闸"的现场是不可能的（只存总账），这里验证的是
    // 等价命题：恢复后连败计数从 0 起步，threshold 次新失败才会开闸。
    const { p } = memoryPersistence({ a1: { successes: 0, failures: 9 } });
    const b = new CircuitBreaker({ persistence: p, failureThreshold: 3 });
    expect(b.state("a1")).toBe("closed");
    b.record("a1", false);
    b.record("a1", false);
    expect(b.state("a1")).toBe("closed");
    b.record("a1", false);
    expect(b.state("a1")).toBe("open");
  });

  it("[3] 每次 record 都写回总账", () => {
    const { p, writes } = memoryPersistence();
    const b = new CircuitBreaker({ persistence: p });
    b.record("a1", true);
    b.record("a1", false);
    expect(writes.at(-1)).toEqual({ a1: { successes: 1, failures: 1 } });
  });

  it("[4] 损坏的持久化数据被跳过（形状不对的条目不恢复），其余照常", () => {
    const bad = { a1: { successes: "many" }, a2: { successes: 2, failures: 1 } } as unknown as Record<
      string,
      AgentTotals
    >;
    const b = new CircuitBreaker({ persistence: { load: () => bad, save: () => {} } });
    expect(b.stats("a1").successes).toBe(0);
    expect(b.stats("a2").successes).toBe(2);
  });

  it("[5] load 返回 undefined（缺文件）= 从零开始", () => {
    const { p } = memoryPersistence(undefined);
    const b = new CircuitBreaker({ persistence: p });
    expect(b.stats("a1").successRate).toBeUndefined();
  });

  it("[6] 总账超过 500 按比例淡出：比例保持，量级封顶，小额一侧不丢光", () => {
    const { p } = memoryPersistence({
      old: { successes: 1, failures: 999 },
      mirror: { successes: 999, failures: 1 },
    });
    const b = new CircuitBreaker({ persistence: p });
    b.record("old", false); // 触发淡出（old 总账 1000 > 500，mirror 同批重算）
    const s = b.stats("old");
    expect(s.successes + s.failures).toBeLessThanOrEqual(501);
    // 比例近似保留：成功率仍在 0 附近，而不是被清零或反转
    expect(s.successRate!).toBeLessThan(0.01);
    // 小额一侧不丢光：real 用 Math.max(1, floor) 保底——mutant 清零即红
    expect(s.successes).toBeGreaterThanOrEqual(1);
    expect(b.stats("mirror").failures).toBeGreaterThanOrEqual(1);
    expect(b.stats("mirror").successRate!).toBeGreaterThan(0.99);
  });

  it("[7] 无 persistence 的构造完全等价旧行为：不写盘也不恢复", () => {
    const b = new CircuitBreaker();
    b.record("a1", true);
    expect(b.stats("a1").successes).toBe(1);
  });

  it("[8] 半坏条目（一好一坏）整体跳过——两个字段都要是数字才恢复", () => {
    const bad = { a1: { successes: 3, failures: "n" } } as unknown as Record<string, AgentTotals>;
    const b = new CircuitBreaker({ persistence: { load: () => bad, save: () => {} } });
    expect(b.stats("a1").successes).toBe(0);
  });

  it("[9] 零账条目跳过且不截断后续条目；纯 successes / 纯 failures 的账都恢复", () => {
    const saved = {
      zero: { successes: 0, failures: 0 },
      onlyS: { successes: 5, failures: 0 },
      onlyF: { successes: 0, failures: 4 },
      good: { successes: 1, failures: 1 },
    };
    const b = new CircuitBreaker({ persistence: { load: () => saved, save: () => {} } });
    expect(b.stats("zero").successes).toBe(0);
    expect(b.stats("zero").failures).toBe(0);
    expect(b.stats("onlyS").successes).toBe(5);
    expect(b.stats("onlyF").failures).toBe(4);
    expect(b.stats("good").successes).toBe(1);
  });
});
