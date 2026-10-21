import { beforeEach, describe, expect, it } from "vitest";

import {
  clearThreadWrites,
  recordThreadWrites,
  resetThreadWrites,
  threadWrites,
} from "../electron/chat/write-ledger";
import {
  compareConflictPaths,
  DEFAULT_CONFLICT_WINDOW_MS,
  conflictFacts,
  describeAgo,
  describeConflictFacts,
  shortId,
  type ThreadWrite,
} from "../shared/chat-conflict";

/**
 * 并行写冲突（M4c · P1）。
 *
 * 它决定"要不要拦一下人"。两种错法**都不抛异常**：该拦不拦 → 一次莫名其妙的
 * 覆盖；不该拦乱拦 → 一次烦人的弹窗，而人一旦养成"知道了就点"的习惯，这个
 * 闸门就废了。所以四条边界各钉一条：别人的/自己的、窗内/窗外、最近那一条。
 */

const w = (sessionId: string, path: string, ts: number): ThreadWrite => ({ sessionId, path, ts });
const NOW = 1_000_000;

describe("conflictFacts", () => {
  it("只认别人的写：自己刚改过的文件再改一次不算冲突", () => {
    expect(conflictFacts(["src/a.ts"], [w("chat-self", "src/a.ts", NOW - 1_000)], { sessionId: "chat-self", now: NOW })).toEqual(
      [],
    );
    expect(
      conflictFacts(["src/a.ts"], [w("chat-other", "src/a.ts", NOW - 1_000)], { sessionId: "chat-self", now: NOW }),
    ).toHaveLength(1);
  });

  it("窗外的写不算冲突（陈旧线索没有价值）", () => {
    const old = w("chat-other", "src/a.ts", NOW - DEFAULT_CONFLICT_WINDOW_MS - 1);
    expect(conflictFacts(["src/a.ts"], [old], { sessionId: "chat-self", now: NOW })).toEqual([]);
    // 恰好在窗口边界（差一毫秒也不算）：<= 才算并发。
    const edge = w("chat-other", "src/a.ts", NOW - DEFAULT_CONFLICT_WINDOW_MS + 1);
    expect(conflictFacts(["src/a.ts"], [edge], { sessionId: "chat-self", now: NOW })).toHaveLength(1);
  });

  it("同一路径多条写：只报最近那一条（人看的是「谁刚动过」）", () => {
    const facts = conflictFacts(
      ["src/a.ts"],
      [
        w("chat-old", "src/a.ts", NOW - 300_000),
        w("chat-new", "src/a.ts", NOW - 2_000),
        w("chat-mid", "src/a.ts", NOW - 60_000),
      ],
      { sessionId: "chat-self", now: NOW },
    );
    expect(facts).toEqual([{ path: "src/a.ts", otherSessionId: "chat-new", agoMs: 2_000 }]);
  });

  it("自己的写在前面也不该挡住后面别人的写（continue 不是 break）", () => {
    const facts = conflictFacts(
      ["src/a.ts"],
      [
        w("chat-self", "src/a.ts", NOW - 1_000),
        w("chat-other", "src/a.ts", NOW - 2_000),
      ],
      { sessionId: "chat-self", now: NOW },
    );
    expect(facts).toEqual([{ path: "src/a.ts", otherSessionId: "chat-other", agoMs: 2_000 }]);
  });

  it("过期的写在前面也不该收摊：后面还有新的并发写", () => {
    const facts = conflictFacts(
      ["src/a.ts"],
      [
        w("chat-old", "src/a.ts", NOW - DEFAULT_CONFLICT_WINDOW_MS - 1_000),
        w("chat-new", "src/a.ts", NOW - 3_000),
      ],
      { sessionId: "chat-self", now: NOW },
    );
    expect(facts).toEqual([{ path: "src/a.ts", otherSessionId: "chat-new", agoMs: 3_000 }]);
  });

  it("比较器的三档都成立（相等那档单独测，否则永远不可达）", () => {
    expect(compareConflictPaths("a", "b")).toBe(-1);
    expect(compareConflictPaths("b", "a")).toBe(1);
    expect(compareConflictPaths("a", "a")).toBe(0);
  });

  it("多条路径按字典序返回；没冲突的路径不出现", () => {
    const facts = conflictFacts(
      ["src/z.ts", "src/a.ts", "src/clean.ts"],
      [w("chat-other", "src/z.ts", NOW - 1_000), w("chat-other", "src/a.ts", NOW - 1_000)],
      { sessionId: "chat-self", now: NOW },
    );
    expect(facts.map((f) => f.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("时钟倒挂按“刚刚”处理：宁可多问一次，也不放过一个真并发", () => {
    const facts = conflictFacts(["src/a.ts"], [w("chat-other", "src/a.ts", NOW + 5_000)], {
      sessionId: "chat-self",
      now: NOW,
    });
    expect(facts).toEqual([{ path: "src/a.ts", otherSessionId: "chat-other", agoMs: 0 }]);
  });

  it("windowMs <= 0 = 关掉冲突检测（headless/单线程形态）", () => {
    expect(
      conflictFacts(["src/a.ts"], [w("chat-other", "src/a.ts", NOW)], { sessionId: "chat-self", now: NOW, windowMs: 0 }),
    ).toEqual([]);
  });
});

describe("describeAgo / describeConflictFacts / shortId", () => {
  it("多久之前：秒 → 分钟 → 小时，5 秒内说“刚刚”", () => {
    expect(describeAgo(0)).toBe("刚刚");
    expect(describeAgo(4_000)).toBe("刚刚");
    expect(describeAgo(12_000)).toBe("12 秒前");
    expect(describeAgo(90_000)).toBe("1 分钟前");
    expect(describeAgo(3_600_000 * 2)).toBe("2 小时前");
    // 负数（时钟倒挂）不该说出"-3 秒前"这种话。
    expect(describeAgo(-3_000)).toBe("刚刚");
  });

  it("冲突文案带路径、线程短尾与多久之前；空事实给空串", () => {
    expect(describeConflictFacts([])).toBe("");
    const text = describeConflictFacts([
      { path: "src/a.ts", otherSessionId: "chat-1a2b3c4d", agoMs: 30_000 },
    ]);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("线程 1a2b3c4d");
    expect(text).toContain("30 秒前");
    expect(text.endsWith("要继续写吗？")).toBe(true);
  });

  it("短尾取最后 8 位；短 id 原样", () => {
    expect(shortId("chat-abcdefghijkl")).toBe("线程 efghijkl");
    expect(shortId("abc")).toBe("线程 abc");
  });
});

/**
 * 写台账（M4c）。
 *
 * 它是判据的**输入端**：台账漏一条，冲突就少拦一次；台账留着已退场线程的记录，
 * 后来的写会被一个不存在的线程拦住。上限那条也钉住：丢最新等于把最该拦的先扔掉。
 */
describe("write-ledger", () => {
  beforeEach(() => {
    resetThreadWrites();
  });

  it("记下谁改了哪个文件；空路径不记", () => {
    recordThreadWrites("chat-a", ["src/a.ts", "", "src/b.ts"], 1_000);
    expect(threadWrites()).toEqual([
      { sessionId: "chat-a", path: "src/a.ts", ts: 1_000 },
      { sessionId: "chat-a", path: "src/b.ts", ts: 1_000 },
    ]);
  });

  it("线程退场时连记录一起清（已不存在的线程不该继续拦人）", () => {
    recordThreadWrites("chat-a", ["src/a.ts"], 1_000);
    recordThreadWrites("chat-b", ["src/a.ts"], 2_000);
    clearThreadWrites("chat-a");
    expect(threadWrites().map((w) => w.sessionId)).toEqual(["chat-b"]);
    // 清一个不存在的线程是 no-op，不是抛错。
    clearThreadWrites("chat-ghost");
    expect(threadWrites()).toHaveLength(1);
  });

  it("超过上限丢**最旧的**（最新的才是要拦的）", () => {
    for (let i = 0; i < 600; i += 1) recordThreadWrites("chat-a", [`f-${i}.ts`], i);
    const all = threadWrites();
    expect(all.length).toBe(500);
    expect(all[0]?.path).toBe("f-100.ts");
    expect(all[all.length - 1]?.path).toBe("f-599.ts");
  });

  it("重置清空（重装配 IPC / 应用退出）", () => {
    recordThreadWrites("chat-a", ["src/a.ts"], 1_000);
    resetThreadWrites();
    expect(threadWrites()).toEqual([]);
  });
});
