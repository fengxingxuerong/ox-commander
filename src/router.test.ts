import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../electron/agents/registry";
import { createCapabilityRouter, DEFAULT_ROUTER_WEIGHTS, type RouteContext } from "../electron/engine/router";
import type { AgentCapabilities, AgentDescriptor } from "../shared/agent-contract";
import type { Task } from "../shared/types";
import { fakeAgent } from "./agent-registry.test";

function caps(partial: Partial<AgentCapabilities>): AgentCapabilities {
  return {
    roles: ["*"],
    zoneGlobs: ["**"],
    supports: ["read", "edit", "create", "run-test"],
    artifactKinds: ["files"],
    maxConcurrency: 1,
    selfIsolated: false,
    ...partial,
  };
}

function task(zone: string, role: string): Task {
  return { id: "t1", title: "t1", description: "", zone, dependencies: [], suggestedRole: role };
}

function build(entries: Array<{ id: string; caps?: AgentCapabilities; priority?: number }>, t: Task) {
  const reg = new AgentRegistry(
    entries.map((e) => ({
      adapter: fakeAgent(e.id, e.caps),
      ...(e.priority !== undefined
        ? { manifest: { id: e.id, displayName: e.id, adapter: "local-llm" as const, capabilities: caps({}), priority: e.priority } }
        : {}),
    })),
  );
  return { reg, candidates: reg.candidates({ task: t }) };
}

describe("CapabilityRouter.assign", () => {
  it("prefers a scoped specialist over an undeclared generalist", () => {
    const t = task("tests/unit", "test-writer");
    const { candidates } = build(
      [
        { id: "generalist" },
        { id: "test-specialist", caps: caps({ roles: ["test-writer"], zoneGlobs: ["tests/**"] }) },
      ],
      t,
    );
    const router = createCapabilityRouter();
    const d = router.assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("test-specialist");
    expect(d.score).toBeGreaterThan(DEFAULT_ROUTER_WEIGHTS.roleWildcard + DEFAULT_ROUTER_WEIGHTS.zoneBroad);
    expect(d.reason).toContain("role=test-writer");
    expect(d.reason).toContain("zone=tests/**");
  });

  it("reproduces legacy round-robin when no candidate declares capabilities", () => {
    const t = task("src/x", "backend-dev");
    const { candidates } = build([{ id: "a1" }, { id: "a2" }], t);
    const router = createCapabilityRouter();
    const picks = [0, 1, 2, 3].map(
      (index) => router.assign({ task: t, index, candidates }).agentId,
    );
    expect(picks).toEqual(["a1", "a2", "a1", "a2"]);
    expect(router.assign({ task: t, index: 0, candidates }).reason).toContain("legacy round-robin");
  });

  it("falls back to a declared candidate when the specialist cannot serve the zone", () => {
    const t = task("src/app", "backend-dev");
    const { candidates } = build(
      [{ id: "generalist" }, { id: "tests-only", caps: caps({ zoneGlobs: ["tests/**"] }) }],
      t,
    );
    expect(candidates.map((c) => c.manifest.id)).toEqual(["generalist"]);
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("generalist");
  });

  it("breaks a tie in favour of the observed success rate", () => {
    const t = task("src/app", "backend-dev");
    const declared = caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] });
    const { candidates } = build([{ id: "a1", caps: declared }, { id: "a2", caps: declared }], t);
    const stats = new Map([
      ["a1", { successRate: 0.2 }],
      ["a2", { successRate: 0.9 }],
    ]);
    const router = createCapabilityRouter({ stats: (id) => stats.get(id) });
    expect(router.assign({ task: t, index: 0, candidates }).agentId).toBe("a2");
    // Without evidence the first candidate wins (stable, deterministic).
    expect(createCapabilityRouter().assign({ task: t, index: 0, candidates }).agentId).toBe("a1");
  });

  it("penalizes a half-open circuit and skips an open one", () => {
    const t = task("src/app", "backend-dev");
    const declared = caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] });
    const { candidates } = build([{ id: "a1", caps: declared }, { id: "a2", caps: declared }], t);
    const halfOpen = createCapabilityRouter({
      stats: (id) => (id === "a1" ? { circuit: "half-open" as const } : undefined),
    });
    expect(halfOpen.assign({ task: t, index: 0, candidates }).agentId).toBe("a2");
    const open = createCapabilityRouter({
      stats: (id) => (id === "a1" ? { circuit: "open" as const } : undefined),
    });
    const decision = open.assign({ task: t, index: 0, candidates });
    expect(decision.agentId).toBe("a2");
    expect(decision.reason).not.toContain("role=*(+");
  });

  it("spreads load away from an agent that is already saturated", () => {
    const t = task("src/app", "backend-dev");
    const declared = caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"], maxConcurrency: 2 });
    const { candidates } = build([{ id: "a1", caps: declared }, { id: "a2", caps: declared }], t);
    const router = createCapabilityRouter();
    // Evenly scored: without evidence the first candidate wins…
    expect(router.assign({ task: t, index: 0, candidates }).agentId).toBe("a1");
    // …but a saturated first candidate hands the task to the idle one.
    const d = router.assign({ task: t, index: 0, candidates, inflight: new Map([["a1", 2]]) });
    expect(d.agentId).toBe("a2");
    expect(d.reason).toContain("load=0/2");
  });

  it("adds the manifest priority as a tie-breaker", () => {
    const t = task("src/app", "backend-dev");
    const { candidates } = build(
      [
        { id: "low", caps: caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] }), priority: 0 },
        { id: "high", caps: caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] }), priority: 5 },
      ],
      t,
    );
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("high");
    expect(d.reason).toContain("priority=+5");
  });

  it("honours the preferredAgents order as a tie-breaker", () => {
    const t = task("src/app", "backend-dev");
    const declared = caps({ roles: ["backend-dev"], zoneGlobs: ["src/**"] });
    const { candidates } = build([{ id: "a1", caps: declared }, { id: "a2", caps: declared }], t);
    const d = createCapabilityRouter().assign({
      task: t,
      index: 0,
      candidates,
      preferredAgents: ["a2"],
    });
    expect(d.agentId).toBe("a2");
  });

  it("reports no candidate instead of guessing when fallback is disabled", () => {
    const t = task("src/app", "backend-dev");
    const ctx: RouteContext = { task: t, index: 0, candidates: [] as AgentDescriptor[] };
    expect(createCapabilityRouter({ fallback: "none" }).assign(ctx).agentId).toBeUndefined();
    // Default fallback still reports "nothing to route" for an empty pool.
    expect(createCapabilityRouter().assign(ctx).agentId).toBeUndefined();
  });

  it("falls back to round-robin when every candidate is filtered out by scoring", () => {
    const t = task("src/app", "backend-dev");
    // Bypass the registry's hard filter on purpose: `list()` keeps the
    // mismatching specialist so only the scoring layer can reject it.
    const { reg } = build([{ id: "a1", caps: caps({ roles: ["docs-writer"], zoneGlobs: ["docs/**"] }) }], t);
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates: reg.list() });
    expect(d.agentId).toBe("a1");
    expect(d.reason).toContain("回落 round-robin");
  });

  it("emits a decision through onDecision for observability", () => {
    const t = task("src/app", "backend-dev");
    const { candidates } = build([{ id: "a1" }], t);
    const seen: string[] = [];
    createCapabilityRouter({ onDecision: (d) => seen.push(`${d.agentId}:${d.score}`) }).assign({
      task: t,
      index: 0,
      candidates,
    });
    expect(seen).toEqual(["a1:0"]);
  });
});
