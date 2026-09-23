import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_POOL_TIMEOUT_MS, createFileJournal, createPlatform } from "../electron/platform";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";
import { UsageMeter } from "../shared/usage-meter";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-platform-"));
  dirs.push(dir);
  return dir;
}

function settings(patch: Partial<ProjectSettings> = {}): ProjectSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch };
}

/** `SchedulerOptions` fields are all optional; tests read them as concrete. */
interface ConcreteSchedulerOptions {
  maxParallelRuns?: number;
  guard?: { setVerdictSink(sink: (v: { conflicts: Array<{ kind: string }> }) => void): void };
  router?: unknown;
  breaker?: unknown;
  onRunStart?: (agentId: string, task: unknown) => void;
  onRunComplete?: (outcome: unknown, task: unknown) => void;
}

function options(platform: ReturnType<typeof createPlatform>): ConcreteSchedulerOptions {
  return platform.schedulerOptions() as ConcreteSchedulerOptions;
}

/**
 * These tests guard the reason `platform.ts` exists: the desktop and headless
 * entries used to assemble their engines separately, and drifted four ways
 * (missing journal, missing verdict sink, different LLM timeout, dead ZoneGuard
 * argument — the latter has since been deleted from `Scheduler` entirely).
 * Anything asserted here is a structural guarantee both hosts share.
 */
describe("createPlatform · shared structure", () => {
  it("installs a guard when a snapshot root is given (zone rollback wired)", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).guard).toBeDefined();
  });

  it("omits the guard when no snapshot root is given (no rollback, no detection)", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).guard).toBeUndefined();
  });

  it("routes the verdict sink even for an injected layer", () => {
    // The historic headless code attached the sink after construction precisely
    // so an injected (test) layer still reported verdicts. That contract holds.
    const verdicts: string[] = [];
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      host: {
        log: () => undefined,
        onVerdict: (v) => verdicts.push(...v.conflicts.map((c) => c.kind)),
      },
    });
    expect(platform.layer.schedulerOptions.guard).toBeDefined();
    expect(verdicts).toEqual([]);
  });

  it("honours maxParallelRuns over the settings value", () => {
    const platform = createPlatform({
      settings: settings({ maxParallelRuns: 2 }),
      promptDir: tempDir(),
      maxParallelRuns: 7,
      host: { log: () => undefined },
    });
    expect(options(platform).maxParallelRuns).toBe(7);
  });

  it("falls back to the settings concurrency when no override is given", () => {
    const platform = createPlatform({
      settings: settings({ maxParallelRuns: 3 }),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).maxParallelRuns).toBe(3);
  });

  it("forwards host run-attribution callbacks into the scheduler", () => {
    const starts: string[] = [];
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: {
        log: () => undefined,
        onRunStart: (agentId) => starts.push(agentId),
      },
    });
    const onRunStart = options(platform).onRunStart;
    expect(onRunStart).toBeDefined();
    onRunStart!("agent-1", { id: "t1", zone: "src" } as never);
    expect(starts).toEqual(["agent-1"]);
  });

  it("accepts host callback overrides without breaking construction", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: {
        log: () => undefined,
        callbacks: { onStage: () => undefined, onTaskOutcome: () => undefined },
      },
    });
    expect(platform.engine).toBeDefined();
  });

  it("exposes the composed callbacks so hosts can assert what they own", () => {
    // The observable contract is the engine itself: both hosts build one from
    // the same wiring, and the override path must not throw mid-construction.
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(typeof platform.engine.generatePrd).toBe("function");
    expect(typeof platform.engine.execute).toBe("function");
  });
});

describe("createPlatform · brain client grade", () => {
  it("uses the same 300s budget on both hosts (drift regression)", () => {
    // Headless used to hard-code 300_000 while Electron passed nothing, so the
    // two hosts cut long generations off at different points.
    expect(BRAIN_POOL_TIMEOUT_MS).toBe(300_000);
  });

  it("注入的 brain 客户端仍被使用，且它的用量被计入 platform.usage()", async () => {
    // 这条以前断言 `platform.buildLlm() === fake`（身份相等）。身份相等其实
    // 证明不了"它被用了" —— 换成**行为断言**：调用确实转到了注入的客户端，
    // 响应原样返回，用量进了 meter。加计量装饰器后 `buildLlm()` 返回的是包装层，
    // 而"没有被换成别的 provider 的客户端"这件事由前两条断言保证。
    const seen: number[] = [];
    const fake = {
      async chat() {
        seen.push(1);
        return { content: "{}", provider: "injected", model: "m", usageTokens: 120 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    const res = await platform.buildLlm().chat({ messages: [] });

    expect(seen).toHaveLength(1);
    expect(res).toEqual({ content: "{}", provider: "injected", model: "m", usageTokens: 120 });
    expect(platform.usage()).toEqual({
      totalTokens: 120,
      calls: 1,
      measuredCalls: 1,
      byModel: { "injected/m": 120 },
    });
  });

  it("用量在同一个平台内跨多次 buildLlm() 累加（每次包一层，不重复计数）", async () => {
    // `buildLlm` 是**工厂**：ipc/context 每次调用都会得到新的包装层。
    // 只要每次都指向同一个 meter，总量就不会漏；而"没有重复计数"由 totalTokens
    // 精确等于两次响应的和来保证（各 60 → 120，不是 240）。
    const fake = {
      async chat() {
        return { content: "{}", provider: "p", model: "m", usageTokens: 60 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });
    await platform.buildLlm().chat({ messages: [] });

    expect(platform.usage().totalTokens).toBe(120);
    expect(platform.usage().calls).toBe(2);
  });

  it("可以自带 meter：宿主想复用同一个计数器时，platform.usage() 就是它的快照", async () => {
    // `config.meter` 这个缝的用途：宿主（或测试）自建计数器并观察同一份数据，
    // 而不是让 platform 自己藏一个。断言两者指向同一份计数，而不是各自一份。
    const meter = new UsageMeter();
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      meter,
      llm: { chat: async () => ({ content: "{}", provider: "p", model: "m", usageTokens: 9 }) } as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });

    expect(meter.snapshot().totalTokens).toBe(9);
    expect(platform.usage()).toEqual(meter.snapshot());
  });

  it("未上报用量的调用不污染总量（provider 沉默时的可见边界）", async () => {
    let call = 0;
    const fake = {
      async chat() {
        call += 1;
        // 第一条不给 usageTokens（有的兼容层就是不返回 usage）。
        return call === 1
          ? { content: "{}", provider: "p", model: "m" }
          : { content: "{}", provider: "p", model: "m", usageTokens: 30 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });
    await platform.buildLlm().chat({ messages: [] });

    const s = platform.usage();
    expect(s.totalTokens).toBe(30);
    expect(s.calls).toBe(2);
    expect(s.measuredCalls).toBe(1);
  });
});

/**
 * `enableRouter: config.enableRouter ?? settings.agentRouter !== false` ——
 * 这一行的 `!==` 变 `===` 后测试全绿（变异测试发现）。语义差异在于
 * **只有显式 `agentRouter: false` 才关路由**：缺省 true 与显式 true 都必须开。
 * 现有用例全用默认 settings（`agentRouter` 为 true），于是两个分支等价。
 */
describe("createPlatform · router 开关的三态（变异测试发现的缺口）", () => {
  function routerEnabled(patch: Partial<ProjectSettings>): boolean {
    const platform = createPlatform({
      settings: settings(patch),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    return Boolean(options(platform).router);
  }

  it("缺省即开启：未显式设置时路由必须是开的", () => {
    // `agentRouter !== false` 的默认态。变异成 `===` 时此项仍为真 → 无法区分，
    // 所以下面两项才是关键。
    expect(routerEnabled({})).toBe(true);
  });

  it("显式 true 开启路由", () => {
    expect(routerEnabled({ agentRouter: true })).toBe(true);
  });

  it("只有显式 false 才关闭路由", () => {
    // 这是 `!== false` 与 `=== false` 唯一分开的一格：变异版会把
    // 「缺省 true」也判成关闭 —— 即默认配置下静默失去能力路由。
    expect(routerEnabled({ agentRouter: false })).toBe(false);
  });

  it("config.enableRouter 覆盖 settings（两者冲突时以 config 为准）", () => {
    const platform = createPlatform({
      settings: settings({ agentRouter: false }),
      promptDir: tempDir(),
      enableRouter: true,
      host: { log: () => undefined },
    });
    // `??` 的左侧优先：显式传了 enableRouter 就不再看 settings
    expect(Boolean(options(platform).router)).toBe(true);
  });

  it("enableRouter: false 也覆盖 settings 的 true", () => {
    const platform = createPlatform({
      settings: settings({ agentRouter: true }),
      promptDir: tempDir(),
      enableRouter: false,
      host: { log: () => undefined },
    });
    expect(Boolean(options(platform).router)).toBe(false);
  });
});

/**
 * The drift guard proper: build a platform the way each host builds one and
 * compare the structural fields. If a future change wires the desktop host
 * differently from headless, this fails instead of silently diverging.
 */
describe("createPlatform · desktop/headless parity", () => {
  function buildAsDesktop() {
    return createPlatform({
      settings: settings({ maxParallelRuns: 4, arbitration: "revert-batch" }),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      manifestDir: tempDir(),
      enableRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 4,
      journal: { save: () => undefined },
      host: { log: () => undefined, onRunStart: () => undefined },
    });
  }

  function buildAsHeadless() {
    return createPlatform({
      settings: settings({ maxParallelRuns: 4, arbitration: "revert-batch" }),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      enableRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 4,
      llmPool: [],
      journal: { save: () => undefined },
      host: { log: () => undefined, onRunStart: () => undefined },
    });
  }

  it("produces the same scheduler shape on both hosts", () => {
    const desktop = options(buildAsDesktop());
    const headless = options(buildAsHeadless());
    expect(desktop.maxParallelRuns).toBe(headless.maxParallelRuns);
    expect(Boolean(desktop.guard)).toBe(Boolean(headless.guard));
    expect(Boolean(desktop.router)).toBe(Boolean(headless.router));
    expect(Boolean(desktop.breaker)).toBe(Boolean(headless.breaker));
    expect(Boolean(desktop.onRunStart)).toBe(Boolean(headless.onRunStart));
    expect(Boolean(desktop.onRunComplete)).toBe(Boolean(headless.onRunComplete));
  });

  it("installs the guard on both hosts when a snapshot root is present", () => {
    // The desktop entry previously passed a legacy ZoneGuard third argument while
    // headless passed undefined — same behaviour, different expression. That
    // argument is gone; both hosts now express the same thing: guard present.
    expect(options(buildAsDesktop()).guard).toBeDefined();
    expect(options(buildAsHeadless()).guard).toBeDefined();
  });
});

describe("createFileJournal", () => {
  const snapshot = {
    batches: [[{ id: "t1", title: "T", zone: "src", description: "d", dependencies: [] }]],
    allDone: ["t1"],
    skipped: [],
    attempts: { t1: 1 },
    round: 1,
    extraRounds: 0,
    lastDigest: "",
  };

  it("round-trips a snapshot for the same requirement", () => {
    const root = tempDir();
    const j = createFileJournal(root, "req-A");
    j.save(snapshot as never);
    const loaded = j.load();
    expect(loaded?.allDone).toEqual(["t1"]);
    expect(loaded?.round).toBe(1);
  });

  it("refuses to resume a different requirement", () => {
    const root = tempDir();
    createFileJournal(root, "req-A").save(snapshot as never);
    const other = createFileJournal(root, "req-B");
    expect(other.load()).toBeUndefined();
    expect(other.mismatched()).toBe(true);
  });

  it("reports a corrupt journal instead of throwing", () => {
    const root = tempDir();
    const j = createFileJournal(root, "req-A");
    fs.writeFileSync(j.path, "{ not json", "utf8");
    expect(j.load()).toBeUndefined();
    expect(j.corrupted()).toBe(true);
  });

  it("returns undefined when there is simply no journal", () => {
    const j = createFileJournal(tempDir(), "req-A");
    expect(j.load()).toBeUndefined();
    expect(j.mismatched()).toBe(false);
    expect(j.corrupted()).toBe(false);
  });

  it("does not abort the caller when the write fails", () => {
    // A nonexistent directory makes writeFileSync throw; checkpointing is a
    // best-effort fuse and must never take a run down with it.
    const j = createFileJournal(path.join(tempDir(), "no", "such", "dir"), "req-A");
    expect(() => j.save(snapshot as never)).not.toThrow();
  });
});
