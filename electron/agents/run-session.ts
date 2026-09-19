import type { AgentEvent } from "../../shared/types";

/**
 * In-memory event queue backing an adapter's collect() stream: producers push
 * events, the async generator drains them, and finish semantics wake pending
 * waiters. Agent-agnostic (API and future UI adapters share it).
 */
export class RunSession {
  events: AgentEvent[] = [];
  waiting: Array<(e: IteratorResult<AgentEvent>) => void> = [];
  finished = false;

  push(kind: AgentEvent["kind"], text: string) {
    if (this.finished && kind === "log") return;
    this.events.push({ kind, text, timestamp: Date.now() });
    this.wake();
  }

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
