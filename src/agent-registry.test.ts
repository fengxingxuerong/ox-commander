import { describe, expect, it } from "vitest";
import { AgentRegistry, createRegistry, wrapLegacyDescriptor } from "../electron/agents/registry";
import { AGENT_PROTOCOL_VERSION, LEGACY_CAPABILITIES, type AgentCapabilities } from "../shared/agent-contract";
import type { AgentAdapter, Task } from "../shared/types";
/*
 * `fakeAgent` 此前定义在本文件里并被 `router.test.ts` 跨测试文件 import —— 那会让
 * vitest 连带执行本文件的 describe/it，把同一批用例注册两次（给 router 报的用例数
 * 因此在 40/45 之间漂）。夹具挪进 `src/__fakes__/agents.ts`（`check:unwired` 跳过该目录）。
 */
import { fakeAgent } from "./__fakes__/agents";

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

/** 把 fakeAgent 的 meta.kind 改成 ui —— `fakeAgent` 硬编码 "api"，撑不到 ui 分支。 */
function uiAgent(id: string, declared?: AgentCapabilities): AgentAdapter {
  return Object.assign(fakeAgent(id, declared), {
    meta: { id, name: id, kind: "ui" as const },
  });
}

describe("AgentRegistry · adapter 字段的推断与校验", () => {
  it("[109] 有 id 但 adapter 缺失时返回明确错误，而不是抛 TypeError", () => {
    // 第 109 行 `if (!spec.adapter || typeof spec.adapter.dispatch !== "function")`。
    // 改成 `&&` 之后，`!spec.adapter` 为真会继续求值右侧的
    // `spec.adapter.dispatch` —— 在 undefined 上取属性直接 **TypeError**，
    // 而不是返回那句"adapter 必须实现 dispatch()"。
    //
    // 既有用例为什么盖不到：`register({ adapter: undefined })` 会因为
    // **第 108 行的 id 校验先返回**（id 也取不到），根本走不到这里。
    // 必须带上 id 才到得了 109 行。
    const reg = new AgentRegistry([]);
    const res = reg.register({ manifest: { id: "has-id" } as never, adapter: undefined as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("dispatch");
  });

  it("[69] meta.kind 为 ui 的适配器推断成 http-bridge（声明路径）", () => {
    // 第 69 行 `adapter.meta.kind === "ui" ? "http-bridge" : "local-llm"`。
    // 改成 `!==` 后 ui 适配器被标成 local-llm、api 适配器被标成 http-bridge ——
    // 适配器类型错配，调度时会按错误的协议去调用。
    const reg = new AgentRegistry([{ adapter: uiAgent("ui-declared", caps({})) }]);
    expect(reg.get("ui-declared")!.manifest.adapter).toBe("http-bridge");
  });

  it("[199] wrapLegacyDescriptor 把 ui 适配器标成 http-bridge（legacy 推断路径）", () => {
    // 第 199 行与第 69 行是同一表达式的两处，但**在不同的函数里**：
    // 69 在注册表的 normalize 路径，199 在导出的 `wrapLegacyDescriptor()` 里。
    // 走 `new AgentRegistry([...])` 根本到不了 199 —— 必须直接调它。
    const ui = wrapLegacyDescriptor(uiAgent("ui-legacy"));
    expect(ui.inferredLegacy).toBe(true);
    expect(ui.manifest.adapter).toBe("http-bridge");

    // 反方向也要断言：只测 ui → http-bridge 会让 `===` 与 `!==` 中有一侧无人验证
    expect(wrapLegacyDescriptor(fakeAgent("api-legacy")).manifest.adapter).toBe("local-llm");
  });

  it("kind 不是 ui 时保持 local-llm（两个分支都要断言）", () => {
    // 只断言"ui → http-bridge"的话，`===` 与 `!==` 里总有一侧无人验证。
    const reg = new AgentRegistry([{ adapter: fakeAgent("api-agent", caps({})) }]);
    expect(reg.get("api-agent")!.manifest.adapter).toBe("local-llm");
  });
});

/**
 * `normalizeCapabilities` 的**回退方向**此前没有任何用例：
 * 空数组会被填成"宽松默认"（`roles → ["*"]`、`zoneGlobs → ["**"]`、`supports → 全能力`）。
 * 方向是刻意的（与 v1 适配器无限制的老语义一致），但没人钉的话，一次"顺手收紧"
 * 就会让一个声明不全的智能体变成**永远选不中 / 永远写不进**，而且不报错。
 *
 * 顺带钉两件事：返回值必须是**拷贝**（改它不能污染模块级 LEGACY_CAPABILITIES），
 * 以及输入数组不被就地改。
 */
describe("AgentRegistry normalization · 空声明的回退方向", () => {
  it("roles 为空 ⇒ 回退成 *，并且真的还能被选中（不是只改了字段）", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", caps({ roles: [] })) }]);
    expect(reg.get("a1")!.capabilities.roles).toEqual(["*"]);
    expect(reg.candidates({ task: task("src/x", "docs-writer") })).toHaveLength(1);
    expect(reg.candidates({ task: task("src/x", "backend-dev") })).toHaveLength(1);
  });

  it("zoneGlobs 为空 ⇒ 回退成 **，任务区域照过", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", caps({ zoneGlobs: [] })) }]);
    expect(reg.get("a1")!.capabilities.zoneGlobs).toEqual(["**"]);
    expect(reg.candidates({ task: task("whatever/deep/path", "backend-dev") })).toHaveLength(1);
  });

  it("artifactKinds 为空 ⇒ 回退成 legacy 的 files+logs", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", caps({ artifactKinds: [] })) }]);
    expect(reg.get("a1")!.capabilities.artifactKinds).toEqual(["files", "logs"]);
  });

  it("maxConcurrency 取下界与取整，且不就地改调用方声明的数组", () => {
    const declared = caps({ maxConcurrency: 0.7, roles: ["backend-dev"] });
    const frozen = [...declared.roles];
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", declared) }]);
    const got = reg.get("a1")!.capabilities;
    expect(got.maxConcurrency).toBe(1); // floor(0.7)=0 ⇒ 再夹到 1
    expect(got.roles).toEqual(["backend-dev"]);
    got.roles.push("test-writer"); // 改返回的数组
    expect(declared.roles).toEqual(frozen); // ⇒ 不能污染调用方的声明

    const frac = new AgentRegistry([{ adapter: fakeAgent("a2", caps({ maxConcurrency: 2.7 })) }]);
    expect(frac.get("a2")!.capabilities.maxConcurrency).toBe(2);
    /*
     * `selfIsolated ?? false` 这一兜底**不在这里断**：`AgentCapabilities.selfIsolated` 是必填，
     * 而 manifest 解析器（`manifest-schema.ts:105,116`）也总会写出一个布尔 —— 两条入口都
     * 到不了"字段缺失"的形状。我先前试图省略它来"测默认值"，tsc 直接把两条错误顶回来（2345），
     * 那才是事实；为一个不可能的形状写断言只会把契约写反。
     */
  });

  it("回退到 LEGACY 时给的是拷贝：改它不污染模块级默认", () => {
    const reg = new AgentRegistry([{ adapter: fakeAgent("a1", caps({ roles: [] })) }]);
    reg.get("a1")!.capabilities.roles.push("test-writer");
    expect(LEGACY_CAPABILITIES.roles).toEqual(["*"]);
    // 再建一个走空声明回退的，确认它拿到的不是被上面 push 脏过的那一份
    const again = new AgentRegistry([{ adapter: fakeAgent("a2", caps({ roles: [] })) }]);
    expect(again.get("a2")!.capabilities.roles).toEqual(["*"]);
  });
});
