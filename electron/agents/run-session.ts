import type { AgentEvent } from "../../shared/types";

/**
 * In-memory event queue backing an adapter's collect() stream: producers push
 * events, the async generator drains them, and finish semantics wake pending
 * waiters. Agent-agnostic (API and future UI adapters share it).
 *
 * ## 等待-唤醒协议（三个适配器共用，改动前先读完这段）
 *
 * 消费者（各适配器的 `collect()`）在队列空时挂在这里：
 *
 * ```ts
 * const next = await new Promise((resolve) => session.waiting.push(resolve));
 * ```
 *
 * **这个 await 没有超时** —— 它完全信任生产者会来 `wake()`。所以有两条硬约束：
 *
 * 1. **设置 `finished = true` 之后必须调用 `wake()`**。漏掉的话，`wake()` 的第二段
 *    永远不会把 `{ done: true }` 发给等待者，`collect()` 就**永久挂起**。
 *    本仓库所有赋值点都成对（`sensenova-api.ts` 两处、`cli-agent.ts` 与
 *    `http-bridge.ts` 各自的收尾路径），新增赋值点时请一并检查。
 * 2. **`wake()` 是唯一的唤醒入口** —— 不要绕开它直接 `waiting.shift()`。
 *
 * 这两条是隐式契约，没有类型能守住它们；违反时的症状是"测试挂住直到超时"，
 * 不是报错。各适配器的变异门禁会以"用例挂满 timeout"的形式暴露这类改动。
 */
export class RunSession {
  events: AgentEvent[] = [];
  waiting: Array<(e: IteratorResult<AgentEvent>) => void> = [];
  finished = false;

  /**
   * 入队一个事件并唤醒等待者。
   *
   * 结束后只丢弃 `log`：`completed` / `aborted` 这类终态事件**仍要入队**，
   * 否则消费者会错过 run 的结局。
   */
  push(kind: AgentEvent["kind"], text: string) {
    if (this.finished && kind === "log") return;
    this.events.push({ kind, text, timestamp: Date.now() });
    this.wake();
  }

  /**
   * 唯一的唤醒入口，两个分支按优先级执行：
   *
   * 1. 有事件 **且** 有等待者 → 投递事件（`done: false`）
   * 2. 已结束 **且** 队列已空 → 给所有等待者发 `done: true`
   *
   * 顺序不能颠倒：先投递事件再关流，否则已排队的终态事件会被 `done` 抢在前面。
   */
  wake() {
    while (this.waiting.length > 0 && this.events.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve({ value: this.events.shift()!, done: false });
    }
    if (this.finished && this.events.length === 0) {
      while (this.waiting.length > 0) {
        this.waiting.shift()!({ value: undefined, done: true });
      }
    }
  }
}
