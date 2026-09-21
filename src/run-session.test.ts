import { describe, expect, it } from "vitest";
import { RunSession } from "../electron/agents/run-session";

/**
 * `RunSession` 是三个适配器（sensenova-api / cli-agent / http-bridge）共用的
 * 等待-唤醒协议核心：消费者在队列空时 `await` 一个没有超时的 promise，
 * 完全依赖 `wake()` 把它唤醒。
 *
 * 这些用例钉住 `wake()` 的两个分支及其**优先级**，以及 `push()` 的过滤语义 ——
 * 它们此前由各适配器的集成测试间接覆盖，出问题时表现为"用例挂住直到超时"
 * 而不是明确报错，很难定位。
 */
describe("RunSession · 事件投递", () => {
  it("把入队的事件交给等待者", () => {
    const session = new RunSession();
    const seen: Array<IteratorResult<{ kind: string; text: string }>> = [];
    session.waiting.push((r) => seen.push(r as never));

    session.push("log", "第二条");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.done).toBe(false);
    expect(session.events).toHaveLength(0);
  });

  it("等待者与事件成对消费：事件多出时留在队列里", () => {
    const session = new RunSession();
    let delivered = 0;
    session.waiting.push(() => delivered++);

    session.push("log", "a");
    session.push("log", "b");

    // 一个等待者只领走一个事件，剩下的留在队列等下一个消费者
    expect(delivered).toBe(1);
    expect(session.events).toHaveLength(1);
  });

  it("未结束时队列为空不唤醒任何人", () => {
    const session = new RunSession();
    const seen: unknown[] = [];
    session.waiting.push((r) => seen.push(r));

    session.wake();

    // 没有事件、也没结束 —— 等待者必须继续等（`wake` 的两个条件都不满足）
    expect(seen).toHaveLength(0);
    expect(session.waiting).toHaveLength(1);
  });
});

describe("RunSession · 结束语义", () => {
  it("结束后丢弃 log，但保留终态事件", () => {
    const session = new RunSession();
    session.finished = true;

    session.push("log", "收尾噪音");
    expect(session.events).toHaveLength(0);

    // 终态事件必须照常入队，否则消费者会错过 run 的结局
    session.push("completed", "交付完成");
    expect(session.events).toHaveLength(1);
  });

  it("已结束且队列空时，唤醒全部等待者并标记 done", () => {
    const session = new RunSession();
    const seen: Array<{ done?: boolean }> = [];
    session.waiting.push((r) => seen.push(r as never), (r) => seen.push(r as never));

    session.finished = true;
    session.wake();

    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.done === true)).toBe(true);
    expect(session.waiting).toHaveLength(0);
  });

  it("事件优先于关流：已排队的终态事件先投递，再给下一个等待者 done", () => {
    const session = new RunSession();
    const seen: Array<{ done?: boolean }> = [];
    session.waiting.push((r) => seen.push(r as never), (r) => seen.push(r as never));

    session.push("completed", "最后一个事件");
    session.finished = true;
    session.wake();

    // 两个分支的顺序不能颠倒：先投递事件，再关流
    expect(seen).toHaveLength(2);
    expect(seen[0]!.done).toBe(false);
    expect(seen[1]!.done).toBe(true);
  });

  it("未结束时即使队列空也不发 done", () => {
    const session = new RunSession();
    const seen: unknown[] = [];
    session.waiting.push((r) => seen.push(r));

    session.wake();

    expect(seen).toHaveLength(0);
  });
});

describe("RunSession · 与 collect() 消费循环对接", () => {
  it("按 collect() 的取用方式能拿全事件并正常收流", async () => {
    const session = new RunSession();

    // 复刻适配器 collect() 的骨架：队列优先，空则等，结束且空则收流。
    async function* drain() {
      for (;;) {
        if (session.events.length > 0) {
          yield session.events.shift()!;
          continue;
        }
        if (session.finished && session.events.length === 0) return;
        const next = await new Promise<IteratorResult<{ kind: string }>>((resolve) => {
          session.waiting.push(resolve as never);
        });
        if (next.done) return;
        yield next.value;
      }
    }

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const e of drain()) collected.push(`${e.kind}`);
    })();

    session.push("log", "开始");
    session.push("completed", "完成");
    session.finished = true;
    session.wake();
    await consumer;

    // 关键：顺序是 push/wake 交错进行也不会丢事件、不会挂住
    expect(collected).toEqual(["log", "completed"]);
  });
});
