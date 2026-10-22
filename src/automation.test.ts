import { describe, expect, it } from "vitest";

import {
  AUTOMATION_ID_MAX,
  AUTOMATION_NAME_MAX,
  dueAutomations,
  describeAutomation,
  nextWakeDelayMs,
  normalizeAutomation,
  normalizeAutomationFields,
  normalizeAutomationInput,
  normalizeName,
  scheduleBaseMs,
  type Automation,
} from "../shared/automation";
import { MIN_EVERY_MS } from "../shared/schedule-core";

/**
 * M5b 的纯逻辑层。断言重点在三件容易漂的事：
 * 1. **同一把尺子** —— `normalizeAutomationInput` 放行的写法，`normalizeAutomation`
 *    （读盘）也必须放行；否则落盘合法的记录会在下次启动时被判坏，自动化凭空消失；
 * 2. **到期判定不另造算术** —— 直接用 `nextDelayMs` 的口径（从未触发 = 一个间隔）；
 * 3. **坏记录跳过而不是抛错** —— 一条手改坏的记录不该让整个列表打不开。
 */

const NOW = 1_700_000_000_000;

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "夜间构建",
    projectId: "p1",
    everyMs: 300_000,
    enabled: true,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...over,
  };
}

describe("normalizeName", () => {
  it("trim、拒空、超长截断", () => {
    expect(normalizeName("  夜间构建  ")).toBe("夜间构建");
    expect(normalizeName("")).toBeUndefined();
    expect(normalizeName("   ")).toBeUndefined();
    expect(normalizeName(42)).toBeUndefined();
    expect(normalizeName(null)).toBeUndefined();
    expect(normalizeName("x".repeat(AUTOMATION_NAME_MAX + 10))).toHaveLength(AUTOMATION_NAME_MAX);
  });
});

describe("normalizeAutomationFields", () => {
  it("只认形状：安全整数、非空字符串；坏形状整个键缺席", () => {
    expect(normalizeAutomationFields({ name: " a ", projectId: " p1 ", everyMs: 5000 })).toEqual({
      name: "a",
      projectId: "p1",
      everyMs: 5000,
    });
    // everyMs 是浮点数上的"整数"（1e21）—— Number.isInteger 拦不住，isSafeInteger 才拦得住
    expect(normalizeAutomationFields({ everyMs: 1e21 })).toEqual({});
    expect(normalizeAutomationFields({ everyMs: 1500.5 })).toEqual({});
    expect(normalizeAutomationFields({ everyMs: "5000" })).toEqual({});
    expect(normalizeAutomationFields({ projectId: "  " })).toEqual({});
    expect(normalizeAutomationFields(null)).toEqual({});
    expect(normalizeAutomationFields("x")).toEqual({});
  });
});

describe("normalizeAutomationInput", () => {
  it("三个字段齐全才放行，逐个说清缺哪个", () => {
    expect(normalizeAutomationInput({ name: "a", projectId: "p1", everyMs: 5000 })).toEqual({
      input: { name: "a", projectId: "p1", everyMs: 5000 },
    });
    expect(normalizeAutomationInput({ projectId: "p1", everyMs: 5000 })).toEqual({ error: "名称不能为空" });
    expect(normalizeAutomationInput({ name: "a", everyMs: 5000 })).toEqual({ error: "必须指定一个项目" });
    expect(normalizeAutomationInput({ name: "a", projectId: "p1" })).toEqual({ error: "间隔必须是毫秒数（安全整数）" });
  });

  it("间隔下限与 parseEvery 同口径：低于 1s 是配置错误", () => {
    expect(normalizeAutomationInput({ name: "a", projectId: "p1", everyMs: MIN_EVERY_MS - 1 })).toEqual({
      error: `间隔不能小于 ${MIN_EVERY_MS}ms（1 秒）`,
    });
    const atLimit = normalizeAutomationInput({ name: "a", projectId: "p1", everyMs: MIN_EVERY_MS });
    expect("input" in atLimit ? atLimit.input.everyMs : undefined).toBe(MIN_EVERY_MS);
  });
});

describe("normalizeAutomation（读盘的同一把尺子）", () => {
  it("落盘前放行的写法，读盘必须原样放行", () => {
    const written = normalizeAutomationInput({ name: "夜间构建", projectId: "p1", everyMs: 300_000 });
    if (!("input" in written)) throw new Error(`尺子拒了合法入参：${written.error}`);
    const read = normalizeAutomation(
      { id: "auto-1", ...written.input, enabled: true, createdAt: 1, updatedAt: 2 },
      NOW,
    );
    expect(read).toEqual({
      id: "auto-1",
      name: "夜间构建",
      projectId: "p1",
      everyMs: 300_000,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("坏记录返回 null（调用方跳过），不是抛错", () => {
    expect(normalizeAutomation(null, NOW)).toBeNull();
    expect(normalizeAutomation("x", NOW)).toBeNull();
    expect(normalizeAutomation({ name: "a", projectId: "p1", everyMs: 500 }, NOW)).toBeNull();
    expect(normalizeAutomation({ name: "a", projectId: "p1", everyMs: 5000 }, NOW)).toBeNull(); // 缺 id
    expect(normalizeAutomation({ id: "  ", name: "a", projectId: "p1", everyMs: 5000 }, NOW)).toBeNull();
  });

  it("enabled 只有显式 true 才算启用；时间戳缺席时落 now", () => {
    const base = { id: "auto-1", name: "a", projectId: "p1", everyMs: 5000 };
    expect(normalizeAutomation({ ...base, enabled: true }, NOW)?.enabled).toBe(true);
    expect(normalizeAutomation({ ...base, enabled: "true" }, NOW)?.enabled).toBe(false);
    expect(normalizeAutomation({ ...base, enabled: 1 }, NOW)?.enabled).toBe(false);
    expect(normalizeAutomation({ ...base }, NOW)?.enabled).toBe(false);
    const read = normalizeAutomation(base, NOW);
    expect(read?.createdAt).toBe(NOW);
    expect(read?.updatedAt).toBe(NOW);
    expect(read?.lastFiredMs).toBeUndefined();
  });

  it("lastFiredMs 只认有限数字（Infinity 直接构造也能进到这里，必须拒）", () => {
    const base = { id: "auto-1", name: "a", projectId: "p1", everyMs: 5000, enabled: true };
    expect(normalizeAutomation({ ...base, lastFiredMs: 123 }, NOW)?.lastFiredMs).toBe(123);
    expect(normalizeAutomation({ ...base, lastFiredMs: Infinity }, NOW)?.lastFiredMs).toBeUndefined();
    expect(normalizeAutomation({ ...base, lastFiredMs: "123" }, NOW)?.lastFiredMs).toBeUndefined();
  });

  it("超长 id 截到上限", () => {
    const read = normalizeAutomation(
      { id: `auto-${"z".repeat(AUTOMATION_ID_MAX)}`, name: "a", projectId: "p1", everyMs: 5000 },
      NOW,
    );
    expect(read?.id).toHaveLength(AUTOMATION_ID_MAX);
  });
});

describe("scheduleBaseMs", () => {
  it("触发过的看上次触发点，从未触发的看最后一次修改", () => {
    expect(scheduleBaseMs(auto({ lastFiredMs: 500, updatedAt: 900 }))).toBe(500);
    expect(scheduleBaseMs(auto({ lastFiredMs: undefined, updatedAt: 900 }))).toBe(900);
  });
});

describe("dueAutomations", () => {
  it("只取启用中且已到点的；停用与未到点都不取", () => {
    const list = [
      auto({ id: "auto-b", lastFiredMs: NOW - 300_000 }), // 正好到点
      auto({ id: "auto-a", lastFiredMs: NOW - 299_999 }), // 差 1ms
      auto({ id: "auto-c", enabled: false, lastFiredMs: NOW - 999_999 }), // 停用
      auto({ id: "auto-d" }), // 从未触发：从 updatedAt 起算，还差 10s
    ];
    expect(dueAutomations(list, NOW).map((a) => a.id)).toEqual(["auto-b"]);
  });

  it("从未触发但早已过点的（创建后一直没跑过）照样到点 —— 否则永远不会触发", () => {
    const list = [auto({ id: "auto-a", updatedAt: NOW - 300_000 })];
    expect(dueAutomations(list, NOW).map((a) => a.id)).toEqual(["auto-a"]);
  });

  it("同一时刻多个到点：按 id 字典序稳定输出（触发顺序不漂）", () => {
    const list = [
      auto({ id: "auto-z", lastFiredMs: NOW - 400_000 }),
      auto({ id: "auto-m", lastFiredMs: NOW - 500_000 }),
      auto({ id: "auto-a", lastFiredMs: NOW - 600_000 }),
    ];
    expect(dueAutomations(list, NOW).map((a) => a.id)).toEqual(["auto-a", "auto-m", "auto-z"]);
  });

  it("不改入参（filter 出新数组后才 sort）", () => {
    const list = [auto({ id: "auto-b", lastFiredMs: NOW - 400_000 }), auto({ id: "auto-a", lastFiredMs: NOW - 400_000 })];
    dueAutomations(list, NOW);
    expect(list.map((a) => a.id)).toEqual(["auto-b", "auto-a"]);
  });
});

describe("nextWakeDelayMs", () => {
  it("取启用任务里的最小剩余；停用不参与（且停用项排在最前也不能让循环提前收工）", () => {
    const list = [
      auto({ id: "auto-c", everyMs: 1000, enabled: false }),
      auto({ id: "auto-a", everyMs: 600_000, lastFiredMs: NOW - 100_000 }), // 剩 500s
      auto({ id: "auto-b", everyMs: 300_000, lastFiredMs: NOW - 200_000 }), // 剩 100s
    ];
    expect(nextWakeDelayMs(list, NOW)).toBe(100_000);
  });

  it("已到点返回 0；没有启用任务返回 null（调度环睡死）", () => {
    expect(nextWakeDelayMs([auto({ lastFiredMs: NOW - 300_000 })], NOW)).toBe(0);
    expect(nextWakeDelayMs([], NOW)).toBeNull();
    expect(nextWakeDelayMs([auto({ enabled: false })], NOW)).toBeNull();
  });

  it("从未触发的任务按「最后一次修改 + 一个间隔」算", () => {
    expect(nextWakeDelayMs([auto({ everyMs: 5000, updatedAt: NOW - 2000 })], NOW)).toBe(3000);
    // 早已过点的从未触发任务：剩余 0（启动/启用时立即补跑一次）
    expect(nextWakeDelayMs([auto({ everyMs: 5000, updatedAt: NOW - 60_000 })], NOW)).toBe(0);
  });
});

describe("describeAutomation", () => {
  it("整分/整秒/整时各按大单位，90 秒不说成 2 分钟", () => {
    expect(describeAutomation(auto({ everyMs: 300_000, lastFiredMs: NOW - 180_000 }), NOW)).toBe(
      "每 5 分钟 · 上次 180 秒前 · 启用中",
    );
    expect(describeAutomation(auto({ everyMs: 90_000 }), NOW)).toContain("每 90 秒");
    expect(describeAutomation(auto({ everyMs: 7_200_000 }), NOW)).toContain("每 2 小时");
    expect(describeAutomation(auto({ enabled: false }), NOW)).toContain("已停用");
    expect(describeAutomation(auto({}), NOW)).toContain("从未触发");
  });

  it("时钟跳到上次触发之前时不输出负数秒", () => {
    expect(describeAutomation(auto({ lastFiredMs: NOW + 5000 }), NOW)).toContain("上次 0 秒前");
  });
});
