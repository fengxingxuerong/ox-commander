import { describe, expect, it } from "vitest";

import { ThreadRegistry, type LiveThread } from "../electron/chat/thread-registry";

/**
 * 活线程登记表（M4a）。
 *
 * 它替掉的是宿主里那句 `let live`。这一层的错法全是**静默**的：登记的 id 与
 * 返回的对象不是同一条线程、删掉活跃项后指针指向已删除的对象、重建会话后
 * "最近活跃"仍停在旧位置 —— 三种都不会抛异常，只会让 `chat:abort` 中止别人、
 * `chat:transcript` 读回上一条。所以每条纪律都单独钉。
 */

function thread(sessionId: string, projectId = "p-1"): LiveThread {
  return { sessionId, projectId, rootAbs: `/w/${projectId}`, signature: `sig-${sessionId}` };
}

describe("ThreadRegistry", () => {
  it("add 即活跃；同 id 覆盖而不是并存（重建会话复用同一个 id）", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("s-1"));
    expect(reg.size).toBe(1);
    expect(reg.active()?.sessionId).toBe("s-1");

    const rebuilt = { ...thread("s-1"), signature: "sig-new" };
    reg.add(rebuilt);
    expect(reg.size).toBe(1);
    // 取到的必须是新对象：界面按 id 寻址，返回旧对象等于永远看不到重建结果。
    expect(reg.get("s-1")).toBe(rebuilt);
    expect(reg.active()?.signature).toBe("sig-new");
  });

  it("add 把该项挪到活跃序末尾（Map.set 对已存在的键不改位置）", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("s-1"));
    reg.add(thread("s-2"));
    // 重登 s-1：它应变成"最近活跃"的那条。
    reg.add(thread("s-1"));
    expect(reg.latestOf("p-1")?.sessionId).toBe("s-1");
    expect(reg.all().map((t) => t.sessionId)).toEqual(["s-2", "s-1"]);
  });

  it("setActive 不存在的 id 返回 false 且不改指针（不静默把活跃项弄丢）", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("s-1"));
    reg.add(thread("s-2"));
    expect(reg.active()?.sessionId).toBe("s-2");

    expect(reg.setActive("s-missing")).toBe(false);
    expect(reg.active()?.sessionId).toBe("s-2");

    expect(reg.setActive("s-1")).toBe(true);
    expect(reg.active()?.sessionId).toBe("s-1");
    // 切活跃同样改变"最近"的顺序（操作者最后看的是 s-1）。
    expect(reg.latestOf("p-1")?.sessionId).toBe("s-1");
  });

  it("删活跃项后退回最后一个还活着的；删空才是空", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("s-1"));
    reg.add(thread("s-2"));

    const removed = reg.remove("s-2");
    expect(removed?.sessionId).toBe("s-2");
    expect(reg.active()?.sessionId).toBe("s-1");

    expect(reg.remove("s-1")?.sessionId).toBe("s-1");
    expect(reg.active()).toBeUndefined();
    expect(reg.size).toBe(0);
    // 重复删是 undefined，不是抛错：删除接口要幂等，界面连点两下不该炸。
    expect(reg.remove("s-1")).toBeUndefined();
  });

  it("latestOf 只在本项目里找，且支持排除自己（不跨项目回退）", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("a-1", "p-a"));
    reg.add(thread("b-1", "p-b"));
    expect(reg.active()?.sessionId).toBe("b-1");

    // p-a 里只有 a-1：全局活跃项是 b-1，但绝不能拿它冒充 p-a 的线程。
    expect(reg.latestOf("p-a", "a-1")).toBeUndefined();
    expect(reg.latestOf("p-a")?.sessionId).toBe("a-1");
    expect(reg.latestOf("p-empty")).toBeUndefined();
  });

  /**
   * `latestOf` 的实现是「遍历整个表、最后一个匹配的赢」。两条 `continue` 都有
   * **只在特定顺序下**才暴露的错法：
   * - `continue → break` 于"项目不匹配"那一行：一旦表里先出现别的项目，遍历就
   *   停在第一个异项目项上 —— 单项目测试永远绿（表里没有异项目项可停）。
   * - `continue → break` 于"排除自己"那一行：要排除的项若不是最后一个，遍历
   *   就提前收摊，返回 undefined（界面以为"这个项目没有其它线程"）。
   * - `&& → ||` 于"排除自己"那一行：排除条件恒真 → 什么都匹配不上。
   */
  it("latestOf 遍历整表：异项目项在前面也不提前收摊", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("b-1", "p-b"));
    reg.add(thread("a-1", "p-a"));
    reg.add(thread("b-2", "p-b"));
    // 表的顺序是 b-1, a-1, b-2：遇到 b-1 就 break 会返回 undefined。
    expect(reg.latestOf("p-a")?.sessionId).toBe("a-1");
  });

  it("latestOf 的 except 不是收摊条件：被排除的项前面还有别人要返回", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("a-1"));
    reg.add(thread("a-2"));
    // a-1 被排除，但 a-2 仍在 —— 排到 a-1 就 break 会返回 undefined。
    expect(reg.latestOf("p-1", "a-1")?.sessionId).toBe("a-2");
    // 反过来：排的是最后一条，返回前面的那条。
    expect(reg.latestOf("p-1", "a-2")?.sessionId).toBe("a-1");
  });

  it("clear 清空指针，不是只清表（否则 active() 读到一个已不存在的 id）", () => {
    const reg = new ThreadRegistry<LiveThread>();
    reg.add(thread("s-1"));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.active()).toBeUndefined();
    expect(reg.all()).toEqual([]);
  });
});
