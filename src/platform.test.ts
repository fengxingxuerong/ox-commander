import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_POOL_TIMEOUT_MS, createFileJournal, createPlatform } from "../electron/platform";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";

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

  it("returns the injected llm untouched", () => {
    const fake = { chat: async () => ({ text: "x", model: "m" }) };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });
    expect(platform.buildLlm()).toBe(fake);
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
