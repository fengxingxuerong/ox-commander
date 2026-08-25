import type { AgentAdapter, AgentMeta, RunHandle, TaskPayload } from "../../shared/types";

/**
 * Placeholder slot for UI-automation-driven desktop agents (e.g. WorkBuddy).
 * probe() always returns false until a concrete implementation lands.
 */
export class UiSlotAdapter implements AgentAdapter {
  readonly meta: AgentMeta;

  constructor(id: string, name: string) {
    this.meta = { id, name, kind: "ui" };
  }

  async probe(): Promise<boolean> {
    return false;
  }

  async dispatch(payload: TaskPayload): Promise<RunHandle> {
    throw new Error(`agent ${this.meta.id} is not implemented yet`);
  }

  async *collect(): AsyncGenerator<never> {
    return;
  }

  async abort(handle: RunHandle): Promise<void> {
    void handle;
  }
}
