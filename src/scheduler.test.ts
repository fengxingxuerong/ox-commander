import { describe, expect, it } from "vitest";
import { digest, Scheduler } from "../electron/engine/scheduler";
import type { AgentAdapter, Task } from "../shared/types";

function task(id: string, zone: string): Task {
  return {
    id,
    title: id,
    description: "desc",
    zone,
    dependencies: [],
    suggestedRole: "fullstack-dev",
  };
}

function adapterWith(id: string, ok: boolean): AgentAdapter {
  return {
    meta: { id, name: id, kind: "cli" },
    async probe() {
      return true;
    },
    async dispatch(payload) {
      return { runId: payload.runId, agentId: id, taskId: payload.taskId };
    },
    // eslint-disable-next-line require-yield
    async *collect(handle) {
      yield { kind: "log", text: `working on ${handle.taskId}`, timestamp: Date.now() };
      if (ok) {
        yield { kind: "completed", text: "done", timestamp: Date.now() };
      } else {
        yield { kind: "failed", text: "exit code 1", timestamp: Date.now() };
      }
    },
    async abort() {},
  };
}

describe("Scheduler.runBatch", () => {
  it("runs zone-disjoint tasks concurrently and collects outcomes", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    const outcomes = await sched.runBatch([task("t1", "src/a"), task("t2", "src/b")], ".");
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
  });

  it("throws on zone conflict inside one batch", async () => {
    const sched = new Scheduler([adapterWith("a1", true)]);
    await expect(
      sched.runBatch([task("t1", "same"), task("t2", "same")], "."),
    ).rejects.toThrow(/zone conflict/);
  });

  it("marks failed runs with log digest", async () => {
    const sched = new Scheduler([adapterWith("a1", false)]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toContain("exit code 1");
  });

  it("reports dispatch failure when no adapter exists", async () => {
    const sched = new Scheduler([]);
    const outcomes = await sched.runBatch([task("t1", "z")], ".");
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].logDigest).toMatch(/no agent|dispatch failed/);
  });
});

describe("digest", () => {
  it("truncates long logs keeping head and tail", () => {
    const long = `${"x".repeat(5000)}ERROR${"y".repeat(5000)}`;
    const d = digest(long, 1000);
    expect(d.length).toBeLessThan(1200);
    expect(d).toContain("[truncated]");
    expect(d.endsWith("y".repeat(10))).toBe(true);
  });
});
