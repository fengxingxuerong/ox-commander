import { describe, expect, it } from "vitest";
import { AgentRegistry, createRegistry, wrapLegacyDescriptor } from "../electron/agents/registry";
import { AGENT_PROTOCOL_VERSION, type AgentCapabilities } from "../shared/agent-contract";
import type { AgentAdapter, Task } from "../shared/types";

function caps(partial: Partial<AgentCapabilities>): AgentCapabilities {
  return {
    roles: ["*"],
    zoneGlobs: ["**"],
    supports: ["read", "edit", "create"],
    artifactKinds: ["files"],
    maxConcurrency: 1,
    selfIsolated: false,
    ...partial,
  };
}

/** Minimal adapter; when `declared` is given it also speaks the v2 capability contract. */
export function fakeAgent(id: string, declared?: AgentCapabilities): AgentAdapter {
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
  return declared ? (Object.assign(base, { capabilities: () => declared }) as AgentAdapter) : base;
}

function task(zone: string, role: string): Task {
  return { id: "t1", title: "t1", description: "", zone, dependencies: [], suggestedRole: role };
}

describe("AgentRegistry normalization", () => {
  it("marks an undeclared adapter as legacy and gives it unrestricted defaults", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }]);
    const d = reg.get("a1")!;
    expect(d.inferredLegacy).toBe(true);
    expect(d.capabilities.roles).toEqual(["*"]);
    expect(d.capabilities.zoneGlobs).toEqual(["**"]);
    expect(d.capabilities.protocolVersion).toBe(AGENT_PROTOCOL_VERSION);
  });

  it("fills the gaps of a partial capability declaration", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("a1", caps({ roles: ["test-writer"], supports: [] })) },
    ]);
    const d = reg.get("a1")!;
    expect(d.inferredLegacy).toBe(false);
    expect(d.capabilities.roles).toEqual(["test-writer"]);
    // Empty list ⇒ normalized back to the permissive default.
    expect(d.capabilities.supports).toContain("edit");
    expect(d.capabilities.maxConcurrency).toBe(1);
  });

  it("clamps a nonsensical concurrency to at least 1", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", caps({ maxConcurrency: 0 })) }]);
    expect(reg.get("a1")!.capabilities.maxConcurrency).toBe(1);
  });

  it("wraps a bare adapter as a legacy descriptor", () => {
    const d = wrapLegacyDescriptor(fakeAgent("raw"));
    expect(d.inferredLegacy).toBe(true);
    expect(d.manifest.id).toBe("raw");
    expect(d.enabled).toBe(true);
  });
});

describe("AgentRegistry.candidates", () => {
  it("keeps a legacy agent for any task", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }]);
    expect(reg.candidates({ task: task("src/x", "docs-writer") })).toHaveLength(1);
  });

  it("filters a scoped agent out when the role does not match", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("specialist", caps({ roles: ["docs-writer"] })) },
    ]);
    expect(reg.candidates({ task: task("src/x", "backend-dev") })).toHaveLength(0);
    expect(reg.candidates({ task: task("src/x", "docs-writer") })).toHaveLength(1);
  });

  it("filters by zone globs", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("tests-only", caps({ zoneGlobs: ["tests/**"] })) },
    ]);
    expect(reg.candidates({ task: task("src/app", "backend-dev") })).toHaveLength(0);
    expect(reg.candidates({ task: task("tests/unit", "backend-dev") })).toHaveLength(1);
  });

  it("filters by required actions", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("writer", caps({ supports: ["read", "edit"] })) },
    ]);
    expect(reg.candidates({ task: task("src", "backend-dev"), requiredTags: ["run-test"] })).toHaveLength(0);
    expect(reg.candidates({ task: task("src", "backend-dev"), requiredTags: ["edit"] })).toHaveLength(1);
  });

  it("honours manifest.enabled and setEnabled", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("on") },
      { adapter: fakeAgent("off"), manifest: { id: "off", displayName: "off", adapter: "local-llm", capabilities: caps({}), enabled: false } },
    ]);
    expect(reg.candidates({ task: task("src", "backend-dev") }).map((d) => d.manifest.id)).toEqual(["on"]);
    expect(reg.setEnabled("off", true)).toBe(true);
    expect(reg.candidates({ task: task("src", "backend-dev") }).map((d) => d.manifest.id)).toEqual(["on", "off"]);
    expect(reg.setEnabled("missing", true)).toBe(false);
  });

  it("does not disable an agent that is missing from enabledAgents", () => {
    // enabledAgents is a *preference* ordering, never a kill switch.
    const reg = createRegistry([fakeAgent("a1"), fakeAgent("a2")]);
    expect(reg.list().every((d) => d.enabled)).toBe(true);
    expect(reg.candidates({ task: task("src", "backend-dev") })).toHaveLength(2);
  });

  it("reports path coverage, always true for legacy agents", () => {
    const reg = new AgentRegistry([
      { adapter: fakeAgent("legacy") },
      { adapter: fakeAgent("scoped", caps({ zoneGlobs: ["src/**"] })) },
    ]);
    expect(reg.coversPath("legacy", "anywhere/x.js")).toBe(true);
    expect(reg.coversPath("scoped", "src/x.js")).toBe(true);
    expect(reg.coversPath("scoped", "tests/x.js")).toBe(false);
    expect(reg.coversPath("nope", "src/x.js")).toBe(true);
  });
});

describe("AgentRegistry dynamic registration", () => {
  it("exposes only enabled adapters as the live pool", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }, { adapter: fakeAgent("a2") }]);
    expect(reg.activeAdapters().map((a) => a.meta.id)).toEqual(["a1", "a2"]);
    reg.setEnabled("a1", false);
    expect(reg.activeAdapters().map((a) => a.meta.id)).toEqual(["a2"]);
    expect(reg.list()).toHaveLength(2);
  });

  it("registers a new agent so it joins the pool immediately", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }]);
    const res = reg.register({ adapter: fakeAgent("newbie", caps({ roles: ["test-writer"] })) });
    expect(res).toEqual({ ok: true, id: "newbie", replaced: false });
    expect(reg.activeAdapters().map((a) => a.meta.id)).toEqual(["a1", "newbie"]);
    expect(reg.get("newbie")!.capabilities.roles).toEqual(["test-writer"]);
  });

  it("replaces an existing agent id in place, keeping its position", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }, { adapter: fakeAgent("a2") }]);
    const res = reg.register({ adapter: fakeAgent("a2", caps({ roles: ["docs-writer"] })) });
    expect(res).toEqual({ ok: true, id: "a2", replaced: true });
    expect(reg.list().map((d) => d.manifest.id)).toEqual(["a1", "a2"]);
    expect(reg.get("a2")!.capabilities.roles).toEqual(["docs-writer"]);
  });

  it("lets a manifest declaration override the adapter's own capabilities", () => {
    const reg = new AgentRegistry([
      {
        adapter: fakeAgent("a1", caps({ roles: ["*"], zoneGlobs: ["**"] })),
        manifest: { capabilities: caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] }) },
      },
    ]);
    expect(reg.get("a1")!.capabilities.roles).toEqual(["backend-dev"]);
    expect(reg.get("a1")!.inferredLegacy).toBe(false);
  });

  it("rejects a registration without a usable id or adapter", () => {
    const reg = new AgentRegistry([]);
    expect(reg.register({ adapter: { meta: { id: "  ", name: "x", kind: "api" } } as never }).ok).toBe(false);
    expect(reg.register({ adapter: undefined as never }).ok).toBe(false);
  });

  it("drains before unregistering, then removes the agent", async () => {
    const drained: number[] = [];
    const adapter = Object.assign(fakeAgent("slow", caps({})), {
      drain: async (graceMs: number) => {
        drained.push(graceMs);
        return "drained" as const;
      },
    });
    const reg = new AgentRegistry([{ adapter }]);
    const res = await reg.unregister("slow", { graceMs: 1234 });
    expect(res).toEqual({ ok: true, drained: "drained" });
    expect(drained).toEqual([1234]);
    expect(reg.has("slow")).toBe(false);
    expect(reg.activeAdapters()).toEqual([]);
  });

  it("reports unsupported drain for a v1 adapter instead of failing", async () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("plain") }]);
    expect(await reg.unregister("plain")).toEqual({ ok: true, drained: "unsupported" });
  });

  it("ignores an unknown id on unregister", async () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1") }]);
    const res = await reg.unregister("ghost");
    expect(res.ok).toBe(false);
    expect(reg.activeAdapters()).toHaveLength(1);
  });
});
