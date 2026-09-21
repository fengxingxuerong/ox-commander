import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJournal } from "../electron/sandbox/file-journal";
import { SnapshotStore } from "../electron/sandbox/snapshot-store";
import { BatchGuard, DEFAULT_SHARED_PATHS } from "../electron/engine/batch-guard";
import { ZoneGuard } from "../electron/engine/zone-guard";
import { Scheduler } from "../electron/engine/scheduler";
import { AgentRegistry } from "../electron/agents/registry";
import { createCapabilityRouter } from "../electron/engine/router";
import type { AgentAdapter } from "../shared/types";
import type { AgentCapabilities } from "../shared/agent-contract";

const roots: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  roots.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

function read(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

describe("FileJournal", () => {
  /**
   * 下面三条同一个根因：**所有既有用例的输入都是"全有效"的**，遍历里每个
   * `continue` 被改成 `break` 都照样全绿 —— 因为从来没有任何东西需要被跳过。
   * 一旦真实输入里出现「先有被跳过的项、后有要收集的项」，那些改动就会让
   * 遍历在第一个跳过项处提前终止，后面的文件全部丢失。
   */
  it("尺寸未变只改 mtime 也算修改（不能被 size 相同就跳过）", () => {
    // `size === now.size && mtimeMs === now.mtimeMs` —— 变异成 `||` 后，
    // 只要 size 相同就 continue，同尺寸改写会被静默漏报。
    const root = scratch("journal-same-size");
    write(root, "src/a.js", "aaa");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);

    const abs = path.join(root, "src/a.js");
    fs.writeFileSync(abs, "bbb", "utf8"); // 同样 3 字节
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(abs, later, later);

    const changes = journal.changed(token);
    expect(changes).toEqual([{ path: "src/a.js", op: "modify", bytes: 3 }]);
  });

  it("node_modules 排在前面时，后面的 src 仍会被纳入基线", () => {
    // `if (this.skipDirs.has(entry.name)) continue` —— 变 break 后，walk 在
    // node_modules 处终止（字母序 n < s），src 下的文件完全不进基线。
    const root = scratch("journal-skip-first");
    write(root, "node_modules/pkg/index.js", "dep");
    write(root, "src/app.js", "app");

    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);
    expect([...token.baseline.keys()]).toContain("src/app.js");
    expect([...token.baseline.keys()]).not.toContain("node_modules/pkg/index.js");
  });

  it("新增项排在前面时，后面的修改项不会被漏掉", () => {
    // `if (!before) { push create; continue }` —— 变 break 后，遍历在第一个
    // 新增文件处终止，排在字母序后面的 modify 全部丢失。
    const root = scratch("journal-create-first");
    write(root, "src/z.js", "old");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);

    write(root, "src/a.js", "new"); // 新增，字母序在最前
    write(root, "src/z.js", "changed"); // 修改，排在后面

    const ops = journal.changed(token).map((c) => `${c.op}:${c.path}`).sort();
    expect(ops).toEqual(["create:src/a.js", "modify:src/z.js"]);
  });

  it("detects create / modify / delete without reading file contents", () => {
    const root = scratch("journal");
    write(root, "src/a.js", "one");
    write(root, "src/b.js", "two");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);

    write(root, "src/a.js", "one-changed");
    write(root, "src/c.js", "three");
    fs.rmSync(path.join(root, "src/b.js"));

    const changes = journal.changed(token);
    expect(changes).toEqual([
      { path: "src/a.js", op: "modify", bytes: "one-changed".length },
      { path: "src/b.js", op: "delete" },
      { path: "src/c.js", op: "create", bytes: "three".length },
    ]);
    const stats = journal.stats();
    expect(stats.contentRead).toBe(0); // the whole point of this class
    expect(stats.files).toBe(2);
  });

  it("reports nothing when the tree is untouched", () => {
    const root = scratch("journal-clean");
    write(root, "src/a.js", "x");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);
    expect(journal.changed(token)).toEqual([]);
  });

  it("flags files changed outside the declared zones", () => {
    const root = scratch("journal-zone");
    write(root, "src/a.js", "x");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);
    write(root, "rogue/x.js", "y");
    const changes = journal.changed(token);
    expect(journal.unauthorized(changes, ["src"])).toEqual(["rogue/x.js"]);
    expect(journal.unauthorized(changes, ["src", "rogue"])).toEqual([]);
  });

  it("skips shared infra directories", () => {
    const root = scratch("journal-skip");
    write(root, "node_modules/pkg/i.js", "x");
    write(root, ".git/config", "x");
    const journal = new FileJournal();
    const token = journal.begin(root, ["."]);
    write(root, "node_modules/pkg/i.js", "y");
    write(root, ".git/config", "y");
    expect(journal.changed(token)).toEqual([]);
  });

  it("is measurably cheaper than a full content scan (ZoneGuard)", () => {
    const root = scratch("journal-perf");
    // 300 files × 4KB — small enough to stay fast in CI, big enough to separate
    // "stat the tree" from "read the tree twice".
    const body = "x".repeat(4096);
    for (let i = 0; i < 300; i++) write(root, `src/mod${i % 12}/file${i}.js`, body);

    const journal = new FileJournal();
    const journalStart = Date.now();
    const token = journal.begin(root, ["src"]);
    journal.changed(token);
    const journalMs = Math.max(1, Date.now() - journalStart);

    const zoneGuard = new ZoneGuard();
    const zgStart = Date.now();
    const snapshot = zoneGuard.snapshot(root);
    zoneGuard.diff(root, snapshot);
    const zgMs = Math.max(1, Date.now() - zgStart);

    // Journal does 2 stat-walks, ZoneGuard does 2 read+hash-walks. Require a
    // real gap but not a flaky one: 1.5× is the floor, typically much more.
    expect(journalMs).toBeLessThan(zgMs * 1.5);
    expect(snapshot.files.size).toBe(300);
  });
});

describe("SnapshotStore", () => {
  it("backs up, then restores modified files and removes created ones", async () => {
    const root = scratch("snap");
    const backupRoot = scratch("snap-backups");
    write(root, "src/keep.js", "original");
    write(root, "src/edit.js", "before");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r1", root, zones: ["src"] });

    write(root, "src/edit.js", "after");
    write(root, "src/brand-new.js", "new");
    fs.rmSync(path.join(root, "src/keep.js"));

    const result = await store.revert(token);
    expect(result.restored.sort()).toEqual(["src/edit.js", "src/keep.js"]);
    expect(result.removed).toEqual(["src/brand-new.js"]);
    expect(read(root, "src/edit.js")).toBe("before");
    expect(read(root, "src/keep.js")).toBe("original");
    expect(read(root, "src/brand-new.js")).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it("restores only the selected paths", async () => {
    const root = scratch("snap-sel");
    const backupRoot = scratch("snap-sel-backups");
    write(root, "src/a.js", "a0");
    write(root, "src/b.js", "b0");
    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r2", root, zones: ["src"] });
    write(root, "src/a.js", "a1");
    write(root, "src/b.js", "b1");

    await store.revert(token, { paths: ["src/a.js"] });
    expect(read(root, "src/a.js")).toBe("a0");
    expect(read(root, "src/b.js")).toBe("b1"); // untouched on purpose
  });

  it("does not delete a pre-existing file it failed to back up", async () => {
    const root = scratch("snap-budget");
    const backupRoot = scratch("snap-budget-backups");
    write(root, "src/a.js", "a");
    write(root, "src/b.js", "b");
    const store = new SnapshotStore({ backupRoot, maxFiles: 1 });
    const token = await store.begin({ runId: "r3", root, zones: ["src"] });
    expect(token.truncated).toBe(true);
    expect(token.skipped).toHaveLength(1);

    // Nothing changed, yet a full revert must not remove the un-backed-up file.
    const result = await store.revert(token);
    expect(read(root, "src/a.js")).not.toBeNull();
    expect(read(root, "src/b.js")).not.toBeNull();
    expect(result.removed).toEqual([]);
  });

  it("never shells out to git (no stash, no checkout, no process spawn at all)", () => {
    // A structural guarantee rather than a string check: the module cannot run
    // any command, so it cannot stash or checkout. The operator's uncommitted
    // work is therefore never at risk from a rollback.
    const source = fs.readFileSync(path.join(process.cwd(), "electron/sandbox/snapshot-store.ts"), "utf8");
    expect(source).not.toMatch(/node:child_process/);
    expect(source).not.toMatch(/execSync|spawnSync|execFileSync/);
  });

  /**
   * 下面几条是同一个根因，在本仓库已第三次出现（此前在 zone-coverage 与 glob）：
   * **所有用例的输入都是「全有效」的**，于是遍历里每一个 `continue` 被改成
   * `break` 都照样全绿 —— 因为从来没有任何东西需要被跳过。
   * 一旦真实输入里出现「先有被跳过的项、后有要收集的项」，那些改动就会让
   * 遍历在第一个跳过项处**提前终止**，后面的文件全部丢失。
   */
  it("被跳过的目录排在前面时，后面的文件仍然会被备份", async () => {
    const root = scratch("snap-skip-first");
    const backupRoot = scratch("snap-skip-first-backups");
    // node_modules 排在 src 之前（字母序），且属于默认 skipDirs
    write(root, "node_modules/pkg/index.js", "dep");
    write(root, "src/app.js", "app");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-skip-first", root, zones: ["."] });

    const backedUp = [...token.backedUp.keys()].sort();
    expect(backedUp).toContain("src/app.js");
    expect(backedUp.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("zone 不存在时不终止后续 zone 的扫描", async () => {
    const root = scratch("snap-missing-zone");
    const backupRoot = scratch("snap-missing-zone-backups");
    write(root, "src/app.js", "app");

    const store = new SnapshotStore({ backupRoot });
    // 第一个 zone 不存在 —— 跳过它之后必须继续处理 src
    const token = await store.begin({ runId: "r-missing-zone", root, zones: ["no-such-zone", "src"] });

    expect([...token.backedUp.keys()]).toContain("src/app.js");
  });

  it("include 里已备份过的路径不重复收集，且不影响后面的条目", async () => {
    const root = scratch("snap-include-dup");
    const backupRoot = scratch("snap-include-dup-backups");
    write(root, "src/a.js", "a");
    write(root, "src/c.js", "c");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({
      runId: "r-include-dup",
      root,
      zones: ["src"],
      // a.js 已在 zone 里收集过（重复 → 跳过），b.js 不存在（跳过），
      // 两种情况都不能让遍历提前结束 —— 否则 c.js 会丢
      include: ["src/a.js", "src/missing.js", "src/c.js"],
    });

    const backedUp = [...token.backedUp.keys()].sort();
    expect(backedUp).toEqual(["src/a.js", "src/c.js"]);
  });

  it("zone 为 '.' 与 '' 时都从项目根开始收集", async () => {
    const root = scratch("snap-dot-zone");
    const backupRoot = scratch("snap-dot-zone-backups");
    write(root, "src/app.js", "app");

    const store = new SnapshotStore({ backupRoot });
    const dot = await store.begin({ runId: "r-dot", root, zones: ["."] });
    const empty = await store.begin({ runId: "r-empty", root, zones: [""] });

    // `zone === "." || zone === ""` —— 两个分支必须落到同一个起点
    expect([...empty.backedUp.keys()].sort()).toEqual([...dot.backedUp.keys()].sort());
    expect([...dot.backedUp.keys()]).toContain("src/app.js");
  });
});

describe("BatchGuard arbitration", () => {
  it("passes a clean batch through and drops the backups", async () => {
    const root = scratch("guard-clean");
    const backupRoot = scratch("guard-clean-backups");
    write(root, "src/a.js", "a");
    const guard = new BatchGuard({ snapshots: new SnapshotStore({ backupRoot }) });
    const scope = await guard.begin("r-clean", root, ["src"]);
    write(root, "src/a.js", "a-updated");

    const verdict = await guard.settle(scope, [{ taskId: "t1", ok: true, logDigest: "ok", events: [] }]);
    expect(verdict.conflicts).toEqual([]);
    expect(verdict.outcomes[0]!.ok).toBe(true);
    expect(fs.readdirSync(backupRoot)).toEqual([]); // committed
  });

  it("revert-batch rolls the violating files back and fails the batch", async () => {
    const root = scratch("guard-revert");
    const backupRoot = scratch("guard-revert-backups");
    write(root, "src/a.js", "a");
    const events: string[] = [];
    const guard = new BatchGuard({
      snapshots: new SnapshotStore({ backupRoot }),
      mode: "revert-batch",
      onEvent: (t) => events.push(t),
    });
    const scope = await guard.begin("r-revert", root, ["src"]);
    // A rogue agent writes outside its zone and rewrites an in-zone file.
    write(root, "rogue/x.js", "rogue");
    write(root, "src/a.js", "changed");

    const verdict = await guard.settle(scope, [{ taskId: "t1", ok: true, logDigest: "ok", events: [] }]);
    expect(verdict.conflicts[0]!.kind).toBe("unauthorized-write");
    expect(verdict.conflicts[0]!.paths).toEqual(["rogue/x.js"]);
    expect(verdict.outcomes[0]!.ok).toBe(false);
    expect(verdict.outcomes[0]!.logDigest).toContain("回滚");
    expect(read(root, "rogue/x.js")).toBeNull(); // rolled back
    // Only the violating paths were selected, so the in-zone edit survives.
    expect(read(root, "src/a.js")).toBe("changed");
    expect(events.join("|")).toContain("已回滚");
  });

  it("report-only leaves the files on disk (historic behaviour)", async () => {
    const root = scratch("guard-report");
    const guard = new BatchGuard({ mode: "report-only" });
    const scope = await guard.begin("r-report", root, ["src"]);
    write(root, "rogue/x.js", "rogue");
    const verdict = await guard.settle(scope, [{ taskId: "t1", ok: true, logDigest: "", events: [] }]);
    expect(verdict.outcomes[0]!.ok).toBe(false);
    expect(read(root, "rogue/x.js")).toBe("rogue");
    expect(verdict.remedies[0]!.action).toBe("fail-batch");
  });

  it("quarantine moves the evidence aside instead of deleting it", async () => {
    const root = scratch("guard-quarantine");
    const guard = new BatchGuard({ mode: "quarantine", quarantineDirName: ".ox-quarantine" });
    const scope = await guard.begin("r-q", root, ["src"]);
    write(root, "rogue/x.js", "rogue");
    const verdict = await guard.settle(scope, [{ taskId: "t1", ok: true, logDigest: "", events: [] }]);
    expect(verdict.remedies[0]!.action).toBe("quarantine");
    expect(read(root, "rogue/x.js")).toBeNull();
    expect(read(root, ".ox-quarantine/r-q/rogue/x.js")).toBe("rogue");
  });

  it("flags a shared file change even when the zone nominally owns it", async () => {
    const root = scratch("guard-shared");
    const guard = new BatchGuard({ mode: "report-only" });
    const scope = await guard.begin("r-shared", root, ["."]);
    write(root, "package.json", "{}");
    const verdict = await guard.settle(scope, [{ taskId: "t1", ok: true, logDigest: "", events: [] }]);
    expect(verdict.conflicts.map((c) => c.kind)).toContain("shared-drift");
    expect(DEFAULT_SHARED_PATHS).toContain("package.json");
  });

  it("keeps concurrent same-file writes out of scope by design", () => {
    // Batches are planned with mutually exclusive zones, so a same-file
    // collision inside a batch cannot happen. Pinned here so the omission of a
    // merge policy stays a deliberate decision.
    const source = fs.readFileSync(path.join(process.cwd(), "electron/engine/batch-guard.ts"), "utf8");
    expect(source).toContain("Concurrent writes to the same file cannot happen inside a batch");
  });
});

describe("Scheduler + guard integration", () => {
  function declared(id: string, dispatch: (payload: { projectRoot: string }) => void): AgentAdapter {
    const caps: AgentCapabilities = {
      roles: ["backend-dev"],
      zoneGlobs: ["src/**"],
      supports: ["read", "edit"],
      artifactKinds: ["files"],
      maxConcurrency: 1,
      selfIsolated: true,
    };
    const base: AgentAdapter = {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        dispatch(payload);
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed" as const, text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
    return Object.assign(base, { capabilities: () => caps });
  }

  it("rolls a rogue write back and fails only the batch that caused it", async () => {
    const root = scratch("sched-guard");
    const backupRoot = scratch("sched-guard-backups");
    write(root, "src/a.js", "a");
    const adapter = declared("rogue", (payload) => {
      write(payload.projectRoot, "outside/x.js", "rogue");
      write(payload.projectRoot, "src/a.js", "changed-by-agent");
    });
    const registry = new AgentRegistry([{ adapter }]);
    const sched = new Scheduler([adapter], [], {
      registry,
      router: createCapabilityRouter(),
      guard: new BatchGuard({ snapshots: new SnapshotStore({ backupRoot }), mode: "revert-batch" }),
    });

    const outcomes = await sched.runBatch(
      [{ id: "t1", title: "t1", description: "", zone: "src", dependencies: [], suggestedRole: "backend-dev" }],
      root,
    );
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.logDigest).toContain("zone 越权");
    expect(fs.existsSync(path.join(root, "outside/x.js"))).toBe(false);
  });

  it("records no batch-level violation when no guard is configured", async () => {
    const root = scratch("sched-no-guard");
    write(root, "src/a.js", "a");
    const adapter = declared("rogue", (payload) => write(payload.projectRoot, "outside/x.js", "rogue"));
    // No guard ⇒ no post-batch detection. The sandbox still fail-closes each
    // individual write it brokers, but nothing attributes an out-of-zone write
    // to this batch. Pinned so the boundary stays explicit rather than drifting.
    const sched = new Scheduler([adapter], []);
    const outcomes = await sched.runBatch(
      [{ id: "t1", title: "t1", description: "", zone: "src", dependencies: [], suggestedRole: "backend-dev" }],
      root,
    );
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.logDigest).not.toContain("zone 越权");
    expect(fs.existsSync(path.join(root, "outside/x.js"))).toBe(true);
  });
});
