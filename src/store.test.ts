import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/types";
import { useApp } from "./store";
import { buildReceipt } from "../shared/delivery-receipt";

/**
 * Renderer event mapping is the one layer no other test can reach: it sits
 * between the main process's event stream and the board. Everything the engine
 * computes (agent attribution, failure class, durations) is worthless if this
 * mapping drops it silently — which is exactly what a narrow type declaration
 * did once before.
 *
 * Driven through the store's public surface: no React rendering required.
 */
function reset(): void {
  useApp.setState({
    page: "projects",
    projects: [],
    stage: "PRD",
    logs: [],
    tasks: {},
    escalations: [],
    conflicts: [],
    verification: undefined,
    receipt: undefined,
    usage: undefined,
    lineHealth: undefined,
    planning: false,
    planningError: undefined,
    settings: undefined,
    settingsError: undefined,
  });
}

const emit = (payload: Record<string, unknown>) => useApp.getState().handleEvent(payload);

beforeEach(() => {
  reset();
  // This suite runs in the node environment (no `window`), so the preload
  // bridge is installed on a minimal globalThis-backed `window` shim for the
  // settings error-path tests. The store resolves its bridge via `window`.
  const g = globalThis as { window?: unknown; oxCommander?: unknown };
  g.window = g;
  g.oxCommander = {
    getSettings: async () => undefined,
    saveSettings: async () => true,
  };
});

describe("handleEvent · stage", () => {
  it("moves the pipeline stage and journals it", () => {
    emit({ type: "stage", stage: "DEVELOPMENT" });
    const s = useApp.getState();
    expect(s.stage).toBe("DEVELOPMENT");
    expect(s.logs.at(-1)).toContain("DEVELOPMENT");
  });
});

describe("handleEvent · log", () => {
  it("appends lines", () => {
    emit({ type: "log", text: "第一行" });
    emit({ type: "log", text: "第二行" });
    expect(useApp.getState().logs).toEqual(["第一行", "第二行"]);
  });

  it("keeps the buffer bounded", () => {
    for (let i = 0; i < 520; i++) emit({ type: "log", text: `line-${i}` });
    const logs = useApp.getState().logs;
    expect(logs.length).toBeLessThanOrEqual(501);
    expect(logs.at(-1)).toBe("line-519");
  });

  it("coerces a non-string payload instead of throwing", () => {
    emit({ type: "log", text: 42 });
    expect(useApp.getState().logs).toEqual(["42"]);
  });
});

describe("loadRecovery · 审计事实恢复", () => {
  it("merges the derived view into state and flags an interrupted run", async () => {
    const g = globalThis as { oxCommander?: { boardRecovery?: unknown } };
    g.oxCommander = {
      boardRecovery: async () => ({
        tasks: {
          t1: { taskId: "t1", title: "A", zone: "z", status: "done", attempts: 1 },
          t2: { taskId: "t2", title: "B", zone: "z", status: "running", attempts: 1 },
        },
        stage: "VERIFICATION",
        interrupted: true,
        lastActivityTs: "2026-09-29T10:00:00.000Z",
      }),
    };
    await useApp.getState().loadRecovery();
    const s = useApp.getState();
    expect(s.tasks.t1).toMatchObject({ status: "done" });
    expect(s.tasks.t2).toMatchObject({ status: "running" });
    expect(s.stage).toBe("VERIFICATION");
    expect(s.interrupted).toBe(true);
    expect(s.lastActivityTs).toBe("2026-09-29T10:00:00.000Z");
    expect(s.logs.at(-1)).toContain("恢复");
  });

  it("restores the delivery receipt of the last run", async () => {
    const last = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    const g = globalThis as { oxCommander?: { boardRecovery?: unknown } };
    g.oxCommander = {
      boardRecovery: async () => ({
        tasks: { t1: { taskId: "t1", title: "A", zone: "z", status: "done", attempts: 1 } },
        receipt: last,
        interrupted: false,
      }),
    };
    await useApp.getState().loadRecovery();
    const s = useApp.getState();
    // A clean run (not interrupted) still restores the receipt…
    expect(s.receipt).toEqual(last);
    expect(s.interrupted).toBe(false);
    // …and announces the recovery, because facts were merged at all.
    expect(s.logs.at(-1)).toContain("恢复");
  });

  it("keeps live state when the trail has nothing to say, without a recovery log line", async () => {
    emit({ type: "log", text: "运行中日志" });
    const g = globalThis as { oxCommander?: { boardRecovery?: unknown } };
    g.oxCommander = { boardRecovery: async () => ({ tasks: {}, interrupted: false }) };
    await useApp.getState().loadRecovery();
    const s = useApp.getState();
    expect(s.interrupted).toBe(false);
    expect(s.logs.at(-1)).toBe("运行中日志");
  });

  it("survives a broken recovery call: the board still works, reason logged", async () => {
    const g = globalThis as { oxCommander?: { boardRecovery?: unknown } };
    g.oxCommander = { boardRecovery: async () => Promise.reject(new Error("audit unreadable")) };
    await useApp.getState().loadRecovery();
    const s = useApp.getState();
    expect(s.interrupted).toBe(false);
    expect(s.tasks).toEqual({});
    expect(s.logs.at(-1)).toContain("审计恢复不可用");
    expect(s.logs.at(-1)).toContain("audit unreadable");
  });
});

describe("handleEvent · taskStatus", () => {
  it("creates a task view from the first status event", () => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "实现解析器", zone: "src/core" });
    expect(useApp.getState().tasks["t1"]).toMatchObject({
      taskId: "t1",
      title: "实现解析器",
      zone: "src/core",
      status: "running",
      attempts: 1,
    });
  });

  it("falls back to the id when no title has been seen yet", () => {
    emit({ type: "taskStatus", taskId: "t9", status: "queued", attempts: 1 });
    expect(useApp.getState().tasks["t9"]!.title).toBe("t9");
    expect(useApp.getState().tasks["t9"]!.zone).toBe("");
  });

  it("keeps title and zone across later status events", () => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
    emit({ type: "taskStatus", taskId: "t1", status: "done", attempts: 1 });
    expect(useApp.getState().tasks["t1"]).toMatchObject({ title: "T", zone: "src", status: "done" });
  });

  it("keeps attribution across a repair-round re-dispatch", () => {
    // Round 1 fails with full attribution.
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
    emit({
      type: "taskOutcome",
      taskId: "t1",
      ok: false,
      logDigest: "boom",
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 900,
    });
    // Round 2 re-dispatches: `running` arrives again, carrying no attribution.
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 2 });
    const t = useApp.getState().tasks["t1"]!;
    expect(t).toMatchObject({
      status: "running",
      attempts: 2,
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 900,
      failureDigest: "boom",
    });
  });
});

describe("handleEvent · taskOutcome", () => {
  beforeEach(() => {
    emit({ type: "taskStatus", taskId: "t1", status: "running", attempts: 1, title: "T", zone: "src" });
  });

  it("carries agent attribution, duration and failure class (P5 payload)", () => {
    emit({
      type: "taskOutcome",
      taskId: "t1",
      ok: false,
      logDigest: "看门狗触发（空闲无输出）",
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 1234,
    });
    expect(useApp.getState().tasks["t1"]).toMatchObject({
      agentId: "codex-cli",
      errorClass: "timeout",
      durationMs: 1234,
      failureDigest: "看门狗触发（空闲无输出）",
    });
  });

  it("keeps attribution on success but clears the failure state", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false, logDigest: "boom", errorClass: "protocol" });
    emit({ type: "taskOutcome", taskId: "t1", ok: true, agentId: "trae-cli", durationMs: 20 });
    const t = useApp.getState().tasks["t1"]!;
    expect(t.failureDigest).toBeUndefined();
    expect(t.errorClass).toBeUndefined();
    expect(t.agentId).toBe("trae-cli");
    expect(t.durationMs).toBe(20);
  });

  it("substitutes a placeholder when a failure carries no digest", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false });
    expect(useApp.getState().tasks["t1"]!.failureDigest).toBe("无日志");
  });

  it("defaults an unclassifiable failure to 'unknown'", () => {
    emit({ type: "taskOutcome", taskId: "t1", ok: false, logDigest: "boom" });
    expect(useApp.getState().tasks["t1"]!.errorClass).toBe("unknown");
  });

  it("ignores an outcome for a task it has never seen", () => {
    const before = useApp.getState().tasks;
    emit({ type: "taskOutcome", taskId: "ghost", ok: false, logDigest: "boom" });
    expect(useApp.getState().tasks).toBe(before);
  });
});

describe("handleEvent · verification and escalation", () => {
  it("stores the latest verification report", () => {
    const report = { passed: false, results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "x", durationMs: 1 }] };
    emit({ type: "verification", report });
    expect(useApp.getState().verification).toEqual(report);
    expect(useApp.getState().logs.at(-1)).toContain("硬性验证");
  });

  it("adds an escalation once per task", () => {
    emit({ type: "escalation", taskId: "t1", summary: "第一次" });
    emit({ type: "escalation", taskId: "t1", summary: "第二次" });
    const escalations = useApp.getState().escalations;
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ taskId: "t1", summary: "第二次", resolved: false });
  });

  it("keeps escalations for different tasks side by side", () => {
    emit({ type: "escalation", taskId: "t1", summary: "a" });
    emit({ type: "escalation", taskId: "t2", summary: "b" });
    expect(useApp.getState().escalations.map((e) => e.taskId)).toEqual(["t1", "t2"]);
  });
});

describe("handleEvent · receipt", () => {
  it("keeps the conclusion and journals its headline", () => {
    const receipt = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [{ id: "t1", title: "core", zone: "src", status: "done", attempts: 1 }],
      conflicts: [],
    });
    emit({ type: "receipt", receipt });
    expect(useApp.getState().receipt).toEqual(receipt);
    expect(useApp.getState().logs.at(-1)).toBe(receipt.headline);
  });

  it("replaces a previous receipt when the operator runs again", () => {
    const first = buildReceipt({
      outcome: "blocked",
      verified: false,
      rounds: 1,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    const second = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    emit({ type: "receipt", receipt: first });
    emit({ type: "receipt", receipt: second });
    expect(useApp.getState().receipt!.outcome).toBe("delivered");
  });
});

describe("handleEvent · usage", () => {
  // 用量事件接的是「本次运行烧了多少 token」，而 `calls - measuredCalls` 是这份
  // 数字的**可信边界** —— 端点不上报用量的那部分调用永远进不了 totalTokens，
  // 界面必须把它和总数一起给，否则"42 tokens"会被读成全部支出。
  it("keeps the snapshot and journals a usage line", () => {
    const snapshot = {
      totalTokens: 42,
      calls: 3,
      measuredCalls: 1,
      byModel: { "ollama/qwen2.5:14b": 42 },
    };
    emit({ type: "usage", ...snapshot });
    expect(useApp.getState().usage).toMatchObject(snapshot);
    expect(useApp.getState().logs.at(-1)).toBe("[usage] 42 tokens · 3 次调用 · 2 次未上报用量 · ollama/qwen2.5:14b=42");
  });

  it("全部调用都上报时日志里不出现未上报那一格", () => {
    emit({ type: "usage", totalTokens: 7, calls: 1, measuredCalls: 1, byModel: {} });
    expect(useApp.getState().logs.at(-1)).toBe("[usage] 7 tokens · 1 次调用");
  });
});

describe("handleEvent · line-health", () => {
  it("keeps the per-line health table（冷却与限流账是界面事实）", () => {
    const lines = [
      { key: "sensenova:SENSENOVA_API_KEY#0", cooling: true, remainingMs: 5_000, failures: 2, rateLimitHits: 1 },
    ];
    emit({ type: "line-health", lines });
    expect(useApp.getState().lineHealth).toEqual(lines);
  });
});

describe("handleEvent · conflict", () => {
  it("records a zone-conflict verdict with its paths", () => {
    emit({ type: "conflict", kind: "overlap", paths: ["src/a.ts", "src/b.ts"], remedy: "revert" });
    const { conflicts, logs } = useApp.getState();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: "overlap", paths: ["src/a.ts", "src/b.ts"], remedy: "revert" });
    expect(conflicts[0].ts).toBeTruthy();
    expect(logs.at(-1)).toContain("已回滚");
  });

  it("renders the remedy in plain language", () => {
    // 词表与生产端同源：这四个值就是 `BatchGuard.remedyFor` 的全部输出，
    // 加上宿主在找不到裁决时发的 none。旧用例里的 isolate / keep 是凭空造的，
    // 生产端从没发过 —— 它把错的映射"测绿"了。四档↔词表的对账放在
    // src/sandbox-journal.test.ts（真跑四档再比对）。
    const cases: Array<[string, string]> = [
      ["revert", "已回滚"],
      ["quarantine", "已隔离"],
      ["fail-batch", "保留文件、判批次失败"],
      ["pass", "仅记录"],
      ["none", "仅记录"],
    ];
    for (const [remedy, verb] of cases) {
      reset();
      emit({ type: "conflict", kind: "overlap", paths: ["x.ts"], remedy });
      expect(useApp.getState().logs.at(-1)).toContain(verb);
    }
  });

  it("keeps the conflict buffer bounded", () => {
    for (let i = 0; i < 60; i++) emit({ type: "conflict", kind: `k${i}`, paths: ["x.ts"], remedy: "none" });
    expect(useApp.getState().conflicts).toHaveLength(50);
  });

  it("survives a payload with missing fields", () => {
    emit({ type: "conflict" });
    const c = useApp.getState().conflicts[0];
    expect(c).toMatchObject({ kind: "unknown", paths: [], remedy: "none" });
  });
});

describe("handleEvent · robustness", () => {
  it("ignores unknown event types without touching state", () => {
    emit({ type: "log", text: "before" });
    const snapshot = useApp.getState();
    emit({ type: "some-future-event", payload: 1 });
    const after = useApp.getState();
    expect(after.logs).toEqual(snapshot.logs);
    expect(after.stage).toBe(snapshot.stage);
    expect(after.tasks).toEqual(snapshot.tasks);
  });

  it("survives a payload with no type at all", () => {
    expect(() => emit({})).not.toThrow();
  });
});

/**
 * Settings load/save used to be the only unguarded IPC calls in the store: a
 * rejection escaped as an unhandled promise rejection, and `saveSettings`
 * committed the new value locally even when the write never landed — the UI
 * then showed configuration that did not exist on disk.
 */
describe("store · settings 错误路径", () => {
  const bridge = () => (globalThis as { oxCommander?: unknown }).oxCommander as {
    getSettings: () => Promise<unknown>;
    saveSettings: () => Promise<unknown>;
  };

  it("surfaces a load failure in the log instead of rejecting", async () => {
    bridge().getSettings = async () => {
      throw new Error("settings.json 损坏");
    };
    await expect(useApp.getState().loadSettings()).resolves.toBeUndefined();
    expect(useApp.getState().settings).toBeUndefined();
    expect(useApp.getState().logs.at(-1)).toContain("settings.json 损坏");
  });

  it("does not apply settings that failed to persist", async () => {
    bridge().saveSettings = async () => {
      throw new Error("磁盘只读");
    };
    const before = useApp.getState().settings;
    await useApp.getState().saveSettings({ ...DEFAULT_SETTINGS, maxParallelRuns: 7 });
    expect(useApp.getState().settings).toBe(before);
    expect(useApp.getState().settingsError).toContain("磁盘只读");
    expect(useApp.getState().logs.at(-1)).toContain("保存设置失败");
  });

  it("clears a previous failure once a save succeeds", async () => {
    bridge().saveSettings = async () => {
      throw new Error("临时故障");
    };
    await useApp.getState().saveSettings({ ...DEFAULT_SETTINGS });
    expect(useApp.getState().settingsError).toBeTruthy();

    bridge().saveSettings = async () => true;
    await useApp.getState().saveSettings({ ...DEFAULT_SETTINGS, maxParallelRuns: 2 });
    expect(useApp.getState().settingsError).toBeUndefined();
    expect(useApp.getState().settings?.maxParallelRuns).toBe(2);
  });
});

describe("项目删除与规划失败的状态收尾", () => {
  function bridge(): Record<string, unknown> {
    const g = globalThis as { oxCommander?: Record<string, unknown> };
    return (g.oxCommander ??= {});
  }

  it("[55] 删除的是当前项目时 activeProjectId 必须清空，删别的项目时不受影响", async () => {
    // 第 55 行 `activeProjectId: s.activeProjectId === projectId ? undefined : s.activeProjectId`。
    // 改成 `!==` 之后这个三元**整体取反**：
    //   - 删掉当前项目 → activeProjectId 仍指向一个已经不存在的 id，
    //     后续 runPlanning / 看板刷新都会拿着悬空 id 去打 IPC；
    //   - 删掉别的项目 → 反而把当前项目清空（界面莫名回到"未选中"）。
    bridge().deleteProject = async () => undefined;

    useApp.setState({ projects: [{ id: "p1" }, { id: "p2" }] as never, activeProjectId: "p1" });
    await useApp.getState().deleteProject("p1");
    expect(useApp.getState().projects.map((p) => p.id)).toEqual(["p2"]);
    expect(useApp.getState().activeProjectId).toBeUndefined();

    // 反向：删一个不是当前的项目，activeProjectId 必须保留
    useApp.setState({ projects: [{ id: "p3" }, { id: "p4" }] as never, activeProjectId: "p3" });
    await useApp.getState().deleteProject("p4");
    expect(useApp.getState().projects.map((p) => p.id)).toEqual(["p3"]);
    expect(useApp.getState().activeProjectId).toBe("p3");
  });

  it("[116] 规划失败时必须结束 planning 并记下 planningError", async () => {
    // 第 116 行是 catch 里的 `if (seq !== planningSeq) return;` —— 用来丢弃
    // **过期**请求的结果。改成 `===` 后判断反了：这次失败的序列号正是当前序列号，
    // 于是**当场 return**，`planning` 永远是 true、`planningError` 永远不写。
    // 症状是界面卡在"正在规划…"，没有任何报错可看。
    //
    // 注意第 113 行（成功分支）有同形的一句，两处必须各自有断言。
    bridge().runPlanning = async () => {
      throw new Error("PRD 生成失败：无可用线路");
    };

    useApp.setState({ activeProjectId: "p1" });
    await useApp.getState().runPlanning();

    const s = useApp.getState();
    expect(s.planning).toBe(false);
    expect(s.planningError).toContain("无可用线路");
    expect(s.logs.join("\n")).toContain("规划失败");
  });
});
