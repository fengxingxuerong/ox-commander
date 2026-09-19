import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CliAgentAdapter, killTree } from "../electron/agents/cli-agent";
import type { AgentEvent, TaskPayload } from "../shared/types";

const NODE = process.execPath;
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-cli-prompts-"));

afterAll(() => {
  // Child processes may still hold the directory on Windows; retry briefly and
  // never fail the suite over temp-file cleanup.
  try {
    fs.rmSync(promptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // left to the OS temp cleaner
  }
});

function payload(over: Partial<TaskPayload> = {}): TaskPayload {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`,
    taskId: "t1",
    title: "实现解析器",
    description: "写一个解析器",
    zone: "src/core",
    projectRoot: promptDir,
    ...over,
  };
}

function cli(args: string[], over: Partial<ConstructorParameters<typeof CliAgentAdapter>[0]> = {}) {
  return new CliAgentAdapter({
    id: "cli-under-test",
    command: NODE,
    argsTemplate: args,
    promptDir,
    ...over,
  });
}

async function drainEvents(adapter: CliAgentAdapter, handle: Awaited<ReturnType<CliAgentAdapter["dispatch"]>>) {
  const events: AgentEvent[] = [];
  for await (const e of adapter.collect(handle)) events.push(e);
  return events;
}

describe("CliAgentAdapter", () => {
  it("probes an existing binary and rejects a missing one", async () => {
    expect(await cli(["-e", ""]).probe()).toBe(true);
    const missing = new CliAgentAdapter({
      id: "missing",
      command: "ox-missing-binary-xyz",
      argsTemplate: [],
      promptDir,
    });
    expect(await missing.probe()).toBe(false);
  });

  it("streams stdout as log events and completes on exit code 0", async () => {
    const adapter = cli(["-e", "console.log('line one');console.log('line two')"]);
    const handle = await adapter.dispatch(payload());
    const events = await drainEvents(adapter, handle);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("completed");
    const text = events.map((e) => e.text).join("\n");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  it("fails the run on a non-zero exit code", async () => {
    const adapter = cli(["-e", "console.error('boom');process.exit(3)"]);
    const handle = await adapter.dispatch(payload());
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("failed");
    expect(events.map((e) => e.text).join("\n")).toContain("boom");
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("failed");
  });

  it("writes a prompt file and substitutes it into the argv", async () => {
    const adapter = cli([
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8').split('\\n')[0])",
      "{{promptPath}}",
    ]);
    const handle = await adapter.dispatch(payload());
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain("# 任务：实现解析器");
  });

  it("passes the repair context into the prompt", async () => {
    const adapter = cli([
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
      "{{promptPath}}",
    ]);
    const handle = await adapter.dispatch(
      payload({ repairContext: { round: 2, errorLogDigest: "TypeError: x is not a function" } }),
    );
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain("第 2 轮修复");
    expect(text).toContain("TypeError: x is not a function");
  });

  it("runs with shell:false so metacharacters reach the child verbatim", async () => {
    // With a shell in the loop, `a && echo pwned` would be split into two
    // commands; without one it must arrive as a single argv element.
    const adapter = cli([
      "-e",
      "process.stdout.write('ARGV:' + JSON.stringify(process.argv.slice(1)))",
      "a && echo pwned",
      "b|c",
    ]);
    const handle = await adapter.dispatch(payload());
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain('ARGV:["a && echo pwned","b|c"]');
  });

  it("aborts a long-running child and reports an aborted terminal event", async () => {
    const adapter = cli(["-e", "setTimeout(() => {}, 30000)"]);
    const handle = await adapter.dispatch(payload());
    expect(adapter.activeRunCount()).toBe(1);
    await adapter.abort(handle);
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("aborted");
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("aborted");
  });

  it("drains immediately when nothing is running", async () => {
    expect(await cli(["-e", ""]).drain(100)).toBe("drained");
  });

  it("reports drain timeout and aborts the stragglers", async () => {
    const adapter = cli(["-e", "setTimeout(() => {}, 30000)"]);
    const handle = await adapter.dispatch(payload());
    expect(await adapter.drain(150)).toBe("timeout");
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("aborted");
  });

  it("keeps the result available after the run was collected", async () => {
    const adapter = cli(["-e", "console.log('done')"]);
    const handle = await adapter.dispatch(payload());
    await drainEvents(adapter, handle);
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("completed");
    expect(result?.logDigest).toContain("done");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("exposes declared capabilities and limits", () => {
    const adapter = cli(["-e", ""], {
      capabilities: {
        roles: ["test-writer"],
        zoneGlobs: ["tests/**"],
        supports: ["read", "edit"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: true,
      },
      limits: { runDeadlineMs: 12_345 },
    });
    expect(adapter.capabilities().roles).toEqual(["test-writer"]);
    expect(adapter.limits.runDeadlineMs).toBe(12_345);
    expect(adapter.limits.idleTimeoutMs).toBeGreaterThan(0);
  });
});

describe("killTree", () => {
  it("is a no-op for a process without a pid", () => {
    expect(() => killTree({ pid: undefined } as never)).not.toThrow();
  });
});
