import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseSpec, type HeadlessEvent, type ParsedSpec } from "../headless/protocol";
import { runSpec } from "../headless/run-spec";
import { createAgentLayer } from "../electron/agents";
import type { LlmClient } from "../shared/llm-client";
import type { AgentAdapter, Task, VerificationReport } from "../shared/types";
import type { AgentCapabilities } from "../shared/agent-contract";
import type { PrdDocument } from "../shared/types";

const dirs: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

/** The spec shape the first version of this protocol accepted. */
const LEGACY_SPEC = {
  requirement: "做一个待办清单",
  projectRoot: ".",
  maxRepairRounds: 1,
  verificationCommands: [{ kind: "test", command: "npm", args: ["run", "test"] }],
  escalationPolicy: "skip",
};

function parse(text: string): ParsedSpec {
  const r = parseSpec(text);
  if (!r.ok) throw new Error(`unexpected parse failure: ${r.message}`);
  return r.spec;
}

describe("parseSpec", () => {
  it("accepts the legacy spec unchanged and fills every default", () => {
    const spec = parse(JSON.stringify(LEGACY_SPEC));
    expect(spec.requirement).toBe("做一个待办清单");
    expect(spec.projectRoot).toBe(path.resolve("."));
    expect(spec.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(spec.llmProvider).toBe("sensenova");
    expect(spec.escalationPolicy).toBe("skip");
    expect(spec.settings.maxRepairRounds).toBe(1);
    expect(spec.settings.verificationCommands).toEqual([{ kind: "test", command: "npm", args: ["run", "test"] }]);
    // New fields default without the host having to know about them.
    expect(spec.settings.agentRouter).toBe(true);
    expect(spec.settings.arbitration).toBe("revert-batch");
    expect(spec.agents).toEqual([]);
    expect(spec.maxParallelRuns).toBe(4);
    expect(spec.snapshotRoot).toContain("ox-commander-snapshots");
    expect(spec.warnings).toEqual([]);
  });

  it("echoes a host-supplied protocol version", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, protocolVersion: "ox-headless/9" }));
    expect(spec.protocolVersion).toBe("ox-headless/9");
  });

  it("reports unknown fields as warnings instead of failing", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, futureFlag: true, nested: { a: 1 } }));
    expect(spec.warnings).toHaveLength(2);
    expect(spec.warnings.join()).toContain("futureFlag");
  });

  it("collects every problem at once", () => {
    const r = parseSpec(
      JSON.stringify({
        requirement: "",
        projectRoot: ".",
        maxRepairRounds: -1,
        escalationPolicy: "explode",
        arbitration: "wishful",
        agentRouter: "yes",
        verificationCommands: [{ kind: "lint", command: "" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const fragment of ["requirement", "maxRepairRounds", "escalationPolicy", "arbitration", "agentRouter", "verificationCommands"]) {
      expect(r.message).toContain(fragment);
    }
  });

  it("rejects non-JSON, non-objects and missing required fields", () => {
    expect(parseSpec("{ nope").ok).toBe(false);
    expect(parseSpec("[]").ok).toBe(false);
    expect(parseSpec("null").ok).toBe(false);
    const r = parseSpec(JSON.stringify({ projectRoot: "." }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("requirement");
  });

  it("validates agent declarations with the same schema as agents.d", () => {
    const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, agents: [{ id: "bad id!", adapter: "cli" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("agents 声明校验失败");
  });

  it("accepts a valid agent declaration and a pre-approved PRD", () => {
    const prd = { goal: "g", features: ["f"], techStack: ["Node.js"], acceptanceCriteria: ["npm test"] };
    const spec = parse(
      JSON.stringify({
        ...LEGACY_SPEC,
        prd,
        agents: [
          {
            id: "codex-cli",
            displayName: "Codex",
            adapter: "cli",
            entry: { kind: "cli", command: "codex", argsTemplate: ["exec"] },
            capabilities: {
              roles: ["backend-dev"],
              zoneGlobs: ["src/**"],
              supports: ["read", "edit"],
              maxProfiles: 1,
              maxConcurrency: 2,
              selfIsolated: true,
              artifactKinds: ["files"],
            },
          },
        ],
      }),
    );
    expect(spec.prd).toEqual(prd);
    expect(spec.agents).toHaveLength(1);
    expect(spec.agents[0]!.id).toBe("codex-cli");
  });

  it("resolves relative paths against the runner cwd", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: "./sub", manifestDir: "agents.d", snapshotRoot: "snaps" }));
    expect(path.isAbsolute(spec.projectRoot)).toBe(true);
    expect(spec.manifestDir).toBe(path.resolve("agents.d"));
    expect(spec.snapshotRoot).toBe(path.resolve("snaps"));
  });

  it("honours maxParallelRuns including 0 (unlimited)", () => {
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, maxParallelRuns: 0 })).maxParallelRuns).toBe(0);
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, maxParallelRuns: 8 })).maxParallelRuns).toBe(8);
  });

  it("defaults llmPool to the platform pool (12 SenseNova routes + AMD)", () => {
    expect(parse(JSON.stringify(LEGACY_SPEC)).llmPool).toEqual(["sensenova", "amd-radeon"]);
  });

  it("accepts an explicit llmPool and rejects unknown providers", () => {
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["amd-radeon"] })).llmPool).toEqual(["amd-radeon"]);
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, llmPool: [] })).llmPool).toEqual([]);
    const bad = parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["nope"] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("未知 provider");
    const malformed = parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: "sensenova" }));
    expect(malformed.ok).toBe(false);
  });
});

describe("runSpec", () => {
  function fakeTask(id: string, zone: string, role = "backend-dev"): Task {
    return { id, title: `任务 ${id}`, description: "做点事", zone, dependencies: [], suggestedRole: role };
  }

  function tasksResponse(tasks: Task[]): LlmClient {
    return {
      async chat(req) {
        const prompt = req.messages.map((m) => m.content).join("\n");
        if (prompt.includes("structured PRD")) {
          const prd: PrdDocument = {
            goal: "g",
            features: ["f"],
            techStack: ["Node.js"],
            acceptanceCriteria: ["npm test"],
          };
          return { content: JSON.stringify(prd), provider: "fake", model: "fake-1" };
        }
        return { content: JSON.stringify({ tasks }), provider: "fake", model: "fake-1" };
      },
    };
  }

  function fakeAdapter(id: string): AgentAdapter {
    const caps: AgentCapabilities = {
      roles: ["backend-dev"],
      zoneGlobs: ["**"],
      supports: ["read", "edit"],
      artifactKinds: ["files"],
      maxConcurrency: 2,
      selfIsolated: true,
    };
    const base: AgentAdapter = {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed" as const, text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
    return Object.assign(base, { capabilities: () => caps });
  }

  function collect(): { events: HeadlessEvent[]; emit: (e: HeadlessEvent) => void } {
    const events: HeadlessEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  const pass: VerificationReport = {
    passed: true,
    results: [{ kind: "test", ok: true, exitCode: 0, logDigest: "ok", durationMs: 5 }],
  };

  it("runs the whole pipeline and exits 0 with a stable event order", async () => {
    const root = scratch("headless-ok");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    const { events, emit } = collect();
    const adapter = fakeAdapter("worker");
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [adapter] }),
      verify: async () => pass,
    });

    expect(code, JSON.stringify(events.filter((e) => e.type === "error"))).toBe(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("hello");
    expect(types).toContain("agents");
    expect(types).toContain("prd");
    expect(types).toContain("tasks");
    expect(types).toContain("verification");
    expect(types.at(-1)).toBe("done");

    const stages = events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(["PRD", "PLANNING", "DEVELOPMENT", "VERIFICATION", "DELIVERY", "DONE"]);

    const runs = events.filter((e) => e.type === "run") as Array<{ phase: string; agentId?: string; ok?: boolean }>;
    expect(runs.map((r) => r.phase)).toEqual(["start", "end"]);
    expect(runs[1]!.agentId).toBe("worker");
    expect(runs[1]!.ok).toBe(true);

    const hello = events[0] as Extract<HeadlessEvent, { type: "hello" }>;
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.projectRoot).toBe(root);
    expect(hello.agentRouter).toBe(true);
  });

  it("断点续跑：journal 匹配需求时跳过规划（LLM 零调用），恢复执行", async () => {
    const root = scratch("headless-resume");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    // 预写运行日志：t1 已完成（快照携带恢复后的计划）
    const snapshot = {
      batches: [[fakeTask("t1", "src")]],
      allDone: ["t1"],
      skipped: [],
      attempts: { t1: 1 },
      round: 1,
      extraRounds: 0,
      lastDigest: "",
    };
    fs.writeFileSync(
      path.join(root, "ox-run-journal.json"),
      JSON.stringify({ requirement: spec.requirement, snapshot }),
      "utf8",
    );
    const { events, emit } = collect();
    let llmCalled = 0;
    const llm: LlmClient = {
      async chat() {
        llmCalled += 1;
        throw new Error("resume 模式不应调用 LLM");
      },
    };
    const adapter = fakeAdapter("worker");
    const code = await runSpec(spec, {
      emit,
      llm,
      layer: createAgentLayer({ adapters: [adapter] }),
      verify: async () => pass,
    });

    expect(code).toBe(0);
    expect(llmCalled).toBe(0); // 跳过 PRD/分解 → 大脑零调用
    expect(events.some((e) => e.type === "log" && e.text.includes("断点续跑"))).toBe(true);
    const runs = events.filter((e) => e.type === "run") as Array<{ phase: string }>;
    expect(runs.length).toBe(0); // t1 已完成 → 无任何派发
    expect(events.at(-1)?.type).toBe("done");
    // 快照在运行中被更新（journal.save 钩子生效）
    const saved = JSON.parse(fs.readFileSync(path.join(root, "ox-run-journal.json"), "utf8"));
    expect(saved.requirement).toBe(spec.requirement);
    expect(saved.snapshot.batches.length).toBe(1);
  });

  it("skips PRD generation when the host supplies one", async () => {
    const root = scratch("headless-prd");
    const prd: PrdDocument = { goal: "g", features: [], techStack: [], acceptanceCriteria: [] };
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, prd }));
    const { events, emit } = collect();
    let chatCalls = 0;
    const llm: LlmClient = {
      async chat(req) {
        chatCalls += 1;
        const t = req.messages.map((m) => m.content).join("\n");
        expect(t).not.toContain("structured PRD");
        return { content: JSON.stringify({ tasks: [fakeTask("t1", "src")] }), provider: "fake", model: "fake-1" };
      },
    };
    const code = await runSpec(spec, {
      emit,
      llm,
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    expect(code).toBe(0);
    expect(chatCalls).toBe(1); // decomposition only
    expect(events.find((e) => e.type === "prd")).toBeTruthy();
  });

  it("exits 2 when the repair budget is spent with escalationPolicy=exhaust", async () => {
    const root = scratch("headless-fail");
    const spec = parse(
      JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, maxRepairRounds: 0, escalationPolicy: "exhaust" }),
    );
    const { events, emit } = collect();
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => ({
        passed: false,
        results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 5 }],
      }),
    });
    expect(code).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "error", exhausted: true });
  });

  it("exits 1 when the host aborts instead of exhausting the budget", async () => {
    const root = scratch("headless-abort");
    const spec = parse(
      JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, maxRepairRounds: 0, escalationPolicy: "abort" }),
    );
    const { events, emit } = collect();
    // A failing agent (not just failing verification) is what triggers escalation.
    const failing: AgentAdapter = Object.assign(fakeAdapter("worker"), {
      async *collect() {
        yield { kind: "failed" as const, text: "exit 1", timestamp: Date.now() };
      },
    });
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [failing] }),
      verify: async () => ({
        passed: false,
        results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 5 }],
      }),
    });
    expect(code).toBe(1);
    const escalation = events.find((e) => e.type === "escalation") as Extract<HeadlessEvent, { type: "escalation" }>;
    expect(escalation).toBeTruthy();
    expect(escalation.taskId).toBe("t1");
    expect(events.at(-1)!.type).toBe("error");
  });

  it("exits 1 before emitting hello when the project root is missing", async () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: path.join(os.tmpdir(), "ox-does-not-exist-xyz") }));
    const { events, emit } = collect();
    const code = await runSpec(spec, { emit, isDirectory: () => false });
    expect(code).toBe(1);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("projectRoot") }]);
  });

  it("surfaces protocol warnings as log lines", async () => {
    const root = scratch("headless-warn");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, futureFlag: 1 }));
    const { events, emit } = collect();
    await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    const hello = events[0] as Extract<HeadlessEvent, { type: "hello" }>;
    expect(hello.warnings.join()).toContain("futureFlag");
    expect(events.some((e) => e.type === "log" && e.text.includes("futureFlag"))).toBe(true);
  });

  it("reports a zone violation as a structured conflict event", async () => {
    const root = scratch("headless-conflict");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.js"), "a", "utf8");
    const rogue: AgentAdapter = Object.assign(fakeAdapter("rogue"), {
      async dispatch(payload: { runId: string; taskId: string; projectRoot: string }) {
        fs.mkdirSync(path.join(root, "outside"), { recursive: true });
        fs.writeFileSync(path.join(root, "outside/x.js"), "rogue", "utf8");
        return { runId: payload.runId, agentId: "rogue", taskId: payload.taskId };
      },
    });
    // Snapshots live outside the project (as they do in production, under
    // userData) — otherwise the backup directory itself counts as a zone change.
    const snapRoot = scratch("headless-conflict-snap");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, snapshotRoot: snapRoot }));
    const { events, emit } = collect();
    await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [rogue], snapshotRoot: snapRoot }),
      verify: async () => pass,
    });
    const conflict = events.find((e) => e.type === "conflict") as Extract<HeadlessEvent, { type: "conflict" }>;
    expect(conflict).toBeTruthy();
    expect(conflict.kind).toBe("unauthorized-write");
    expect(conflict.paths).toEqual(["outside/x.js"]);
    expect(conflict.remedy).toBe("revert");
    // The rogue file is gone: revert is the default arbitration mode.
    expect(fs.existsSync(path.join(root, "outside/x.js"))).toBe(false);
  });
});

describe("headless entry point", () => {
  it("keeps a legacy spec working through the whole binary contract", async () => {
    // The shell itself is trivial by design; this pins that the pieces it wires
    // together still accept the original spec shape.
    const root = scratch("headless-entry");
    const parsed = parseSpec(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, snapshotRoot: path.join(root, ".snap") }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const events: HeadlessEvent[] = [];
    const code = await runSpec(parsed.spec, {
      emit: (e) => events.push(e),
      llm: { async chat() { return { content: JSON.stringify({ tasks: [] }), provider: "fake", model: "fake" }; } },
      layer: createAgentLayer({ adapters: [] }),
    });
    // No tasks ⇒ nothing to develop; the engine still reports a terminal state.
    expect([0, 1, 2]).toContain(code);
    expect(events[0]!.type).toBe("hello");
  });
});
