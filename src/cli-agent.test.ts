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

  it("aborts an unknown run id without crashing", async () => {
    // The guard is `!run || run.session.finished`. With `&&` instead, a missing
    // run falls through to `run.session.finished` and throws a TypeError —
    // aborting something already reaped would take down the caller.
    const adapter = cli(["-e", ""]);
    await expect(
      adapter.abort({ runId: "ghost-run", agentId: "cli-under-test", taskId: "" }),
    ).resolves.toBeUndefined();
  });

  it("does not label an in-flight run as a timeout", async () => {
    // `lastKind === "failed" && run.exitCode === null` — both halves matter.
    // Flipping to `||` marks ANY run that has not exited yet (including one
    // still streaming output) as a retryable timeout.
    const adapter = cli(["-e", "setTimeout(() => {}, 5000)"]);
    const handle = await adapter.dispatch(payload());
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("failed");
    expect(result?.errorClass).toBeUndefined();
    await adapter.abort(handle);
  });

  it("caps the finished-result cache instead of growing forever", async () => {
    // The eviction guard is `oldest !== undefined`. With `===` it never fires,
    // because the key of a non-empty Map is never undefined — `results` then
    // grows without bound for the lifetime of the adapter.
    const adapter = cli(["-e", ""]);
    const internals = adapter as unknown as {
      results: Map<string, unknown>;
      rememberResult(run: unknown, runId: string, kind: string): void;
    };
    for (let i = 0; i < 60; i++) {
      internals.rememberResult(
        { taskId: "t1", logs: [], startedAt: Date.now(), exitCode: 0 },
        `r-${i}`,
        "completed",
      );
    }
    expect(internals.results.size).toBeLessThanOrEqual(50);
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

  it("survives a child that throws on kill", () => {
    // The portable path must swallow a kill() that throws rather than
    // propagating into the caller's finally block.
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error("ESRCH");
      },
    };
    expect(() => killTree(child as never, { graceMs: 1 })).not.toThrow();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const signals: string[] = [];
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: (sig: string) => {
        signals.push(sig);
        return true;
      },
    };
    killTree(child as never, { graceMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});
