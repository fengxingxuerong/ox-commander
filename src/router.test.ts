import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../electron/agents/registry";
import { createCapabilityRouter, DEFAULT_ROUTER_WEIGHTS, type RouteContext } from "../electron/engine/router";
import { DEFAULT_AGENT_LIMITS, type AgentCapabilities, type AgentDescriptor } from "../shared/agent-contract";
import type { Task } from "../shared/types";
import { fakeAgent } from "./__fakes__/agents";

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

  it("reports no agent for a legacy-only pool when fallback is disabled", () => {
    // `fallback: "none"` must also govern the legacy short-circuit, not just
    // the scored path — otherwise a v1-only registry keeps handing out
    // round-robin assignments after the host asked the router to stop guessing.
    const t = task("src/app", "backend-dev");
    const { candidates } = build([{ id: "a1" }], t);
    const d = createCapabilityRouter({ fallback: "none" }).assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBeUndefined();
    expect(d.score).toBe(0);
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

/**
 * 候选过滤循环里的三处 `continue`（137 / 139 / 141）此前从未被触发。
 *
 * 为什么既有用例覆盖不到：`AgentRegistry.candidates()` **已经**按
 * required tags / role / zone 过滤过一遍，所以走注册表这条路的候选
 * 全部能通过路由器的复查 —— 那三行是注释里写的"defensive re-check
 * （注册表通常会先滤掉）"，也就一直没人验证过它到底做不做功。
 *
 * 改成 `break` 之后：**第一个被滤掉的候选会让整个评分循环提前终止**，
 * 后面的候选一个都不参与评分 → `scored` 为空或残缺 → 静默退化到
 * legacy round-robin。症状是"能力路由时灵时不灵"，而不是报错。
 *
 * 这里直接构造 `candidates` 喂给 `assign` —— `RouteContext.candidates`
 * 本来就是公开入参，路由器也明确承诺会复查，所以这是合法路径。
 */
function descriptor(
  id: string,
  partial: Partial<AgentCapabilities> = {},
  inferredLegacy = false,
): AgentDescriptor {
  const c = caps(partial);
  return {
    manifest: { id, displayName: id, adapter: "local-llm", capabilities: c },
    capabilities: c as Required<AgentCapabilities>,
    limits: DEFAULT_AGENT_LIMITS,
    adapter: fakeAgent(id, c) as unknown as AgentDescriptor["adapter"],
    inferredLegacy,
    enabled: true,
    priority: 0,
  };
}

describe("CapabilityRouter · 候选复查（被滤掉的候选不能中断后面的评分）", () => {
  it("[137] 第一个候选不支持 required tag 时，后面的候选仍被评分并胜出", () => {
    const t = task("src/x", "backend-dev");
    const candidates = [
      // 默认 required 是 ["edit"]：第一个候选不支持 edit，必须被跳过而非终止
      descriptor("no-edit", { supports: ["read"] }),
      descriptor("can-edit", { supports: ["edit"], roles: ["*"], zoneGlobs: ["**"] }),
    ];
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("can-edit");
    expect(d.reason).not.toContain("round-robin");
  });

  it("[139] 第一个候选角色不匹配时，后面的候选仍被评分并胜出", () => {
    const t = task("src/x", "backend-dev");
    const candidates = [
      descriptor("wrong-role", { roles: ["test-writer"] }),
      descriptor("right-role", { roles: ["backend-dev"] }),
    ];
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("right-role");
  });

  it("[141] 第一个候选的 zone 覆盖不到时，后面的候选仍被评分并胜出", () => {
    const t = task("tests/unit", "backend-dev");
    const candidates = [
      descriptor("wrong-zone", { zoneGlobs: ["src/**"] }),
      descriptor("right-zone", { zoneGlobs: ["tests/**"] }),
    ];
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("right-zone");
  });

  it("全部候选都被滤掉时才回落 round-robin（复查不是「有候选就收」）", () => {
    const t = task("tests/unit", "backend-dev");
    const candidates = [
      descriptor("no-edit", { supports: ["read"] }),
      descriptor("wrong-zone", { zoneGlobs: ["src/**"] }),
    ];
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    // 全部不匹配 → 走 legacy 回落，而不是硬选一个不合格的
    expect(d.reason).toContain("round-robin");
  });
});

describe("CapabilityRouter · 等分时的声明优先 tie-break", () => {
  it("[193] 分数相同时，声明了能力的候选必须压过推断（legacy）候选", () => {
    // 第 193 行 `a.descriptor.inferredLegacy !== b.descriptor.inferredLegacy`。
    // 改成 `===` 之后这个分支只在"两边同为声明或同为 legacy"时进入 ——
    // 而那时下面的 `if (a.inferredLegacy) return 1` 两边都不成立，整块白跑。
    // 真正需要它的"一真一假"组合反而被跳过，于是排序退回按分数比较；
    // 分数相等时稳定排序保持输入顺序 → **legacy 候选会赢**。
    //
    // 构造要点：两个候选的分数必须**相等**，否则分数差会盖过 tie-break，
    // 改坏也看不出来（既有用例正是这种情况：专门用一个高分 specialist 对比）。
    const t = task("src/x", "backend-dev");
    const candidates = [
      // legacy 推断候选排在前面 —— 稳定排序下它会赢，除非 tie-break 生效
      descriptor("legacy-generalist", { roles: ["*"], zoneGlobs: ["**"] }, true),
      descriptor("declared", { roles: ["*"], zoneGlobs: ["**"] }, false),
    ];
    const d = createCapabilityRouter().assign({ task: t, index: 0, candidates });
    expect(d.agentId).toBe("declared");
  });
});
