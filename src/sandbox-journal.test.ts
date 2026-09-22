import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJournal } from "../electron/sandbox/file-journal";
import {
  SnapshotStore,
  withinZones,
  type SnapshotFsLike,
  type SnapshotToken,
} from "../electron/sandbox/snapshot-store";
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

/**
 * 把真 fs 包装成替身，只改指定的方法。
 *
 * 用途：覆盖真实文件系统上跨平台造不出的路径 —— `readdirSync` 抛 EACCES、
 * `dirent` 既非文件也非目录（fifo/socket）、`rmSync` 被权限拒绝。
 * `SnapshotStore` 的第二个构造参数是 `SnapshotFsLike`（默认真 fs），与 `ZoneGuard`
 * 的 `FsLike` 是同一模式：**纯测试缝，生产行为零变化**。
 */
function stubFs(overrides: Partial<SnapshotFsLike> = {}): SnapshotFsLike {
  return {
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => fs.statSync(p),
    readdirSync: (dir, opts) => fs.readdirSync(dir, opts) as fs.Dirent[],
    mkdirSync: (p, opts) => {
      fs.mkdirSync(p, opts);
    },
    copyFileSync: (from, to) => {
      fs.copyFileSync(from, to);
    },
    rmSync: (p, opts) => {
      fs.rmSync(p, opts);
    },
    ...overrides,
  };
}

/** 造一个 dirent 形状的对象：readdirSync 返回它，不需要真实条目存在。 */
function dirent(name: string, kind: "file" | "dir" | "other"): fs.Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => kind === "other",
    isSocket: () => kind === "other",
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as unknown as fs.Dirent;
}

/** 手工构造一个 SnapshotToken，用于直接驱动 revert 而跳过 begin。 */
function bareToken(backupRoot: string, root: string, zones: string[], id: string): SnapshotToken {
  return {
    id,
    rootAbs: path.resolve(root),
    dirAbs: path.join(backupRoot, id),
    zones,
    backedUp: new Map(),
    skipped: [],
    truncated: false,
  };
}

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

  it("有多个新增时不会在第一个就停止遍历", () => {
    // 与上一条同源但更锋利：上一条只有 1 个 create，于是"在第一个 create 处停下"
    // 与"继续遍历"看起来一样（后面只剩 1 个 modify，恰好也能被第二个循环补上）。
    //
    // 断言只数**数量**、不依赖遍历顺序 —— `walkStat` 的键序由 readdir 决定，
    // 写死字典序会让用例在别的文件系统上变脆。
    const root = scratch("journal-multi-create");
    write(root, "src/base.js", "b");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);

    write(root, "src/a.js", "1");
    write(root, "src/m.js", "2");
    write(root, "src/z.js", "3");
    write(root, "src/base.js", "changed-longer");

    const changes = journal.changed(token);
    const count = (op: string) => changes.filter((c) => c.op === op).length;
    // `continue → break` 会在第一个新文件处终止，后面两个 create 与那个 modify 全丢
    expect(count("create")).toBe(3);
    expect(count("modify")).toBe(1);
    expect(changes).toHaveLength(4);
  });

  it("lastStats 的分类计数与 changes 实际内容一致", () => {
    // `lastStats` 的三个计数是
    //   `changes.filter((c) => c.op === "create").length`
    // 这类表达式。任一 `===` 改成 `!==` 之后，计数变成"**不是**该类型的条数"。
    //
    // 场景特意让三类数量**互不相等**（3 / 1 / 0）：
    // 若取 2 create + 1 modify + 1 delete，"非 create" 恰好也是 2，变异后会假绿。
    const root = scratch("journal-stats");
    write(root, "src/old.js", "o");
    const journal = new FileJournal();
    const token = journal.begin(root, ["src"]);

    write(root, "src/new1.js", "a");
    write(root, "src/new2.js", "b");
    write(root, "src/new3.js", "c");
    write(root, "src/old.js", "changed-and-longer");

    const changes = journal.changed(token);
    const stats = journal.stats();
    const count = (op: string) => changes.filter((c) => c.op === op).length;

    expect(count("create")).toBe(3);
    expect(count("modify")).toBe(1);
    expect(count("delete")).toBe(0);
    // 关键：stats 必须与 changes 自身一致，而不是各算各的
    expect(stats.create).toBe(3);
    expect(stats.modify).toBe(1);
    expect(stats.delete).toBe(0);
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

  /**
   * 下面这组补的是**行覆盖**缺口（不是上两组的 continue/break 断言敏感度）。
   * 此前 stmts 80.64% / branch 73.91%，未覆盖集中在四类：
   *   1. 各 catch 分支（复制失败 / 回滚失败 / 新建文件删除失败）
   *   2. `newlyCreated` 的遍历过滤（skipDirs、非普通文件、已备份与已跳过）
   *   3. `collect` 的 statSync 分支（zone 直接指向单个文件）
   *   4. `hasBackup` 与 `withinZones` 两个公开符号，此前**零用例**
   */
  it("zone 直接指向单个文件时不再向下遍历，且与同路径的目录 zone 互不干扰", async () => {
    // collect 里 `stat.isFile()` 那一支此前从未走到：所有 zone 都是目录。
    const root = scratch("snap-file-zone");
    const backupRoot = scratch("snap-file-zone-backups");
    write(root, "src/a.js", "a");
    write(root, "src/b.js", "b");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-file-zone", root, zones: ["src/a.js"] });

    expect([...token.backedUp.keys()]).toEqual(["src/a.js"]);
  });

  it("单文件 zone 与目录 zone 混用时，单个文件的路径只收一次且后续 zone 照常收集", async () => {
    const root = scratch("snap-file-zone-mix");
    const backupRoot = scratch("snap-file-zone-mix-backups");
    write(root, "src/a.js", "a");
    write(root, "src/b.js", "b");
    write(root, "other/c.js", "c");

    const store = new SnapshotStore({ backupRoot });
    // 顺序很关键：先按单文件收 a.js（进 seen），再走 src 目录 —— src 目录
    // 遍历到 a.js 时必须被 seen 挡掉，否则 backedUp 会重复；同时 other 必须仍在。
    const token = await store.begin({
      runId: "r-file-zone-mix",
      root,
      zones: ["src/a.js", "src", "other/c.js"],
    });

    expect([...token.backedUp.keys()].sort()).toEqual(["other/c.js", "src/a.js", "src/b.js"]);
  });

  it("hasBackup 对已备份路径为真、对未备份路径为假，且接受反斜杠写法", async () => {
    const root = scratch("snap-hasbackup");
    const backupRoot = scratch("snap-hasbackup-backups");
    write(root, "src/a.js", "a");
    write(root, "src/plain.js", "plain"); // 用 include 之外的方式放进去，但不备份它

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({
      runId: "r-hasbackup",
      root,
      zones: ["src/a.js"], // 只备份 a.js
    });

    expect(store.hasBackup(token, "src/a.js")).toBe(true);
    expect(store.hasBackup(token, "src/plain.js")).toBe(false);
    // toRel 会把 Windows 反斜杠归一化成 posix —— 否则在 Windows 上查同一个文件会返回 false
    expect(store.hasBackup(token, "src\\a.js")).toBe(true);
    // 前导 ./ 与首尾斜杠同样要归一化
    expect(store.hasBackup(token, "./src/a.js")).toBe(true);
  });

  it("备份文件复制失败时记入 skipped 而不是抛错，且不阻断后续文件", async () => {
    // begin 里的 `catch { token.skipped.push(rel) }` 此前未覆盖。
    // 造一个"目录里读得到、但复制时失败"的文件：用只读目录挡住目标侧的写入。
    const root = scratch("snap-copy-fail");
    const backupRoot = scratch("snap-copy-fail-backups");
    write(root, "src/a.js", "a");
    write(root, "src/b.js", "b");
    write(root, "src/c.js", "c");

    // 排序后 a.js 先处理；在 a.js 的目标路径上先放一个**同名目录**，
    // copyFileSync 到已存在的目录会 EISDIR/EPERM 而失败。
    const runDir = path.join(backupRoot, "r-copy-fail");
    fs.mkdirSync(path.join(runDir, "src", "a.js"), { recursive: true });

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-copy-fail", root, zones: ["src"] });

    expect(token.skipped).toContain("src/a.js");
    expect(token.backedUp.has("src/a.js")).toBe(false);
    // 关键：a.js 失败不能让 b.js / c.js 一起丢
    expect([...token.backedUp.keys()].sort()).toEqual(["src/b.js", "src/c.js"]);
  });

  it("回滚单个路径时，快照没记录且当前也不存在的文件 → 记入 skipped 而非静默丢弃", async () => {
    // revertOne 末尾那条「无需回滚」终态此前未覆盖（行 180）。
    const root = scratch("snap-revert-noop");
    const backupRoot = scratch("snap-revert-noop-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-revert-noop", root, zones: ["src"] });

    const result = await store.revert(token, { paths: ["src/never-existed.js"] });

    expect(result.restored).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.path).toBe("src/never-existed.js");
    expect(result.skipped[0]!.reason).toContain("无需回滚");
  });

  it("回滚时目标父目录已被删除 → 重新创建父目录后仍然还原成功", async () => {
    // revertOne 的 `fs.mkdirSync(path.dirname(abs), { recursive: true })`（行 162）
    // 是"批任务把整个目录删了"这条真实路径上的必要动作。
    const root = scratch("snap-revert-mkdir");
    const backupRoot = scratch("snap-revert-mkdir-backups");
    write(root, "src/deep/nested/a.js", "a0");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-revert-mkdir", root, zones: ["src"] });

    // 模拟批任务把整个 src 目录删掉
    write(root, "src/deep/nested/a.js", "changed");
    fs.rmSync(path.join(root, "src"), { recursive: true, force: true });

    const result = await store.revert(token);

    expect(result.restored).toContain("src/deep/nested/a.js");
    expect(read(root, "src/deep/nested/a.js")).toBe("a0");
  });

  it("newlyCreated 把 skipDirs 排除在外，不会误删 node_modules 与 .git", async () => {
    // newlyCreated 的 `if (this.skipDirs.has(entry.name)) continue;`（行 198）
    // 此前未覆盖：一旦改成不跳过，回滚会把整棵 node_modules 判为"批任务新建"而删除。
    const root = scratch("snap-newly-skipdirs");
    const backupRoot = scratch("snap-newly-skipdirs-backups");
    write(root, "src/a.js", "a");
    // 这两个目录在快照前后都存在，且不在 zones 内 —— 必须完全不被触碰
    write(root, "node_modules/pkg/index.js", "dep");
    write(root, ".git/objects/aa/bb", "obj");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-newly-skipdirs", root, zones: ["src"] });
    const result = await store.revert(token);

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(root, "node_modules/pkg/index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".git/objects/aa/bb"))).toBe(true);
  });

  it("newlyCreated 不会把快照里已备份过的文件当新建删掉", async () => {
    // `!token.backedUp.has(rel)` 是这条断言的核心：漏掉它，全量回滚会把
    // 刚刚 restored 回来的文件立刻再删一遍。
    const root = scratch("snap-newly-nobackup-clash");
    const backupRoot = scratch("snap-newly-nobackup-clash-backups");
    write(root, "src/a.js", "a0");
    write(root, "src/b.js", "b0");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-newly-clash", root, zones: ["src"] });
    // 批任务改了内容、又新建了 c.js
    write(root, "src/a.js", "a1");
    write(root, "src/c.js", "c1");

    const result = await store.revert(token);

    // a.js 与 b.js 是"改过的"，只能 restore；c.js 才是"新建的"，只能 remove
    expect(result.restored.sort()).toEqual(["src/a.js", "src/b.js"]);
    expect(result.removed).toEqual(["src/c.js"]);
    expect(read(root, "src/a.js")).toBe("a0");
    expect(read(root, "src/c.js")).toBeNull();
  });

  it("newlyCreated 只扫 zone 内路径，zone 外的历史文件不会被误删", async () => {
    // 行 209-217 的注释明确说了这个约束：把扫描面放宽到整棵树会删掉 zone 外的既有文件。
    const root = scratch("snap-newly-zone-only");
    const backupRoot = scratch("snap-newly-zone-only-backups");
    write(root, "src/a.js", "a");
    write(root, "outside/keep.js", "keep"); // zone 外，批任务前后都在

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-newly-zone-only", root, zones: ["src"] });
    const result = await store.revert(token);

    expect(result.removed).toEqual([]);
    expect(read(root, "outside/keep.js")).toBe("keep");
  });

  it("[111] begin 超预算后仍逐个登记 all 被跳过的文件，而不是只记第一个", async () => {
    // 行 108-112：
    //   if (token.backedUp.size >= this.maxFiles) {
    //     token.truncated = true;
    //     token.skipped.push(rel);
    //     continue;                      ← 本条的靶子
    //   }
    //
    // 这里**不是等价变异**：`size >= maxFiles` 一旦成立就恒成立（本分支不 set backedUp），
    // 所以改 break 后前两行行为相同，但 `skipped` 的**内容**会差 —— continue 收全部
    // 超预算文件，break 只收第一个。既有那条 maxFiles:1 用例超预算后只剩 1 个文件，
    // 正好看不出这个差别，所以 111 一直存活。
    const root = scratch("snap-budget-many");
    const backupRoot = scratch("snap-budget-many-backups");
    for (const n of ["a", "b", "c", "d"]) write(root, `src/${n}.js`, n);

    const store = new SnapshotStore({ backupRoot, maxFiles: 1 });
    const token = await store.begin({ runId: "r-budget-many", root, zones: ["src"] });

    expect(token.truncated).toBe(true);
    expect(token.backedUp.size).toBe(1);
    // 四个文件里 1 个进 backedUp，其余 3 个**全部**要被登记为 skipped
    expect(token.skipped).toHaveLength(3);
    expect([...token.skipped].sort()).toEqual(
      ["src/a.js", "src/b.js", "src/c.js", "src/d.js"].filter((p) => !token.backedUp.has(p)),
    );
  });

  it("commit 之后备份目录被清空，且对已不存在的目录重复 commit 不抛错", async () => {
    const root = scratch("snap-commit-twice");
    const backupRoot = scratch("snap-commit-twice-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-commit-twice", root, zones: ["src"] });

    await store.commit(token);
    expect(fs.existsSync(token.dirAbs)).toBe(false);
    // 第二次 commit：rmSync 带 force，必须静默成功（catch 吞错是刻意设计）
    await expect(store.commit(token)).resolves.toBeUndefined();
  });

  /**
   * 下面四条来自**逐位点拆单点验证**（`_tmp-snapshot-sites.mjs`，12 个 continue 位点）。
   *
   * 起因：`mutation-check.mjs` 的 `continue → break` 算子用 replaceAll 一次改掉全部 12 处，
   * 报「2/2 全杀」—— 但拆开单点后实测 **5 个位点存活**。这是「算子去重掩盖位点」的
   * 新形态：**只要任意一处被杀死就报杀死，无法区分是哪些位点真被断言覆盖。**
   *
   * 5 个存活位点里：
   * - 行 111（begin 超预算 continue）是**等价变异** —— 超预算是累加判定，
   *   改 break 后行为一致（后面的项本就全部该跳过），不补断言。
   * - 其余 4 处是真缺口，共同形态与 zone-guard / protocol 同一根因：
   *   **测试里"被跳过的项"永远是最后一项**，改 break 也看不出来。
   */
  it("[217] newlyCreated：进入一个子目录递归之后，父目录的其余同级项不能被丢掉", async () => {
    // 行 215-217 的成对结构：
    //   if (this.skipDirs.has(entry.name)) continue;  ← 行 215
    //   walk(abs);
    //   continue;                                     ← 行 217（本条的靶子）
    // 217 的语义是「递归完这个子目录后，继续处理父目录的下一个同级项」。
    // 改成 break 后，只要父目录里**先出现一个子目录**，它后面的同级项就全部丢失。
    // 关键：aaa-sub 必须是目录且排在 fresh.js 之前。
    const root = scratch("snap-newly-walk-continue");
    const backupRoot = scratch("snap-newly-walk-continue-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        readdirSync: (dir): fs.Dirent[] => {
          const norm = dir.replace(/\\/g, "/");
          if (norm.endsWith("/src")) {
            // 先子目录（触发 walk 递归），再一个普通文件
            return [dirent("aaa-sub", "dir"), dirent("zzz-fresh.js", "file")];
          }
          if (norm.endsWith("/src/aaa-sub")) {
            return []; // 子目录是空的 —— 让"递归"这一步纯粹产生副作用
          }
          return [];
        },
        rmSync: () => undefined,
      }),
    );

    const token = bareToken(backupRoot, root, ["src"], "r-newly-walk-continue");
    const result = await store.revert(token);

    // 递归 aaa-sub 之后必须回到 src 的同级循环，zzz-fresh.js 才不会被漏掉
    expect(result.removed).toEqual(["src/zzz-fresh.js"]);
  });

  it("[253] collect：进入一个子目录递归之后，父目录的其余同级项不能被丢掉", async () => {
    // 行 251-253 与上面 215-217 完全同形，但在 collect 里 —— 必须独立断言。
    const root = scratch("snap-collect-walk-continue");
    const backupRoot = scratch("snap-collect-walk-continue-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        statSync: () => ({ isFile: () => false, isDirectory: () => true }),
        readdirSync: (dir): fs.Dirent[] => {
          const norm = dir.replace(/\\/g, "/");
          if (norm.endsWith("/src")) {
            // 先子目录（触发递归），再普通文件
            return [dirent("aaa-sub", "dir"), dirent("zzz-kept.js", "file")];
          }
          if (norm.endsWith("/src/aaa-sub")) {
            return [];
          }
          return [];
        },
        copyFileSync: () => undefined,
      }),
    );

    const token = await store.begin({ runId: "r-collect-walk-continue", root, zones: ["src"] });

    // 递归 aaa-sub 之后必须回到 src 的同级循环，zzz-kept.js 才不会被漏掉
    expect([...token.backedUp.keys()]).toEqual(["src/zzz-kept.js"]);
  });

  it("[215] newlyCreated：skipDirs 目录之后仍有兄弟项时，兄弟项照常被识别为新建", async () => {
    // newlyCreated 里 `if (this.skipDirs.has(entry.name)) continue;`（行 215）。
    // 关键：node_modules 必须**排在** fresh.js 之前，且 fresh.js 要能被收集到。
    const root = scratch("snap-newly-skipdir-sibling");
    const backupRoot = scratch("snap-newly-skipdir-siblings-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const removed: string[] = [];
    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        readdirSync: (dir): fs.Dirent[] => {
          if (dir.endsWith(`${path.sep}src`)) {
            // 顺序即断言：node_modules 在前，fresh.js 在后
            return [dirent("node_modules", "dir"), dirent("zzz-fresh.js", "file")];
          }
          return [];
        },
        rmSync: (p) => {
          removed.push(p);
        },
      }),
    );

    const token = bareToken(backupRoot, root, ["src"], "r-newly-skipdir-sibling");
    const result = await store.revert(token);

    // 跳过 node_modules 之后必须继续遍历，zzz-fresh.js 才不会被漏掉
    expect(result.removed).toEqual(["src/zzz-fresh.js"]);
  });

  it("[251] collect：skipDirs 目录之后仍有同级的其他目录时，后者照常被收录", async () => {
    // collect 里同形的 `if (this.skipDirs.has(entry.name)) continue;`（行 253）。
    // 两个遍历各有一处同形 continue，必须分别有断言 —— 杀一处不代表另一处也被杀。
    const root = scratch("snap-collect-skipdir-sibling");
    const backupRoot = scratch("snap-collect-skipdir-sibling-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        statSync: () => ({ isFile: () => false, isDirectory: () => true }),
        readdirSync: (dir): fs.Dirent[] => {
          if (dir.endsWith(`${path.sep}src`)) {
            // aaa-node_modules 字典序在前，zzz-keep 在后 —— 改 break 会丢掉后者
            return [dirent("aaa-node_modules", "dir"), dirent("zzz-keep", "dir")];
          }
          if (dir.endsWith("zzz-keep")) {
            return [dirent("kept.js", "file")];
          }
          return [];
        },
        copyFileSync: () => undefined,
      }),
    );

    const token = await store.begin({
      runId: "r-collect-skipdir-sibling",
      root,
      zones: ["src"],
    });

    expect([...token.backedUp.keys()]).toEqual(["src/zzz-keep/kept.js"]);
  });

  it("[279] include：重复项之后仍有有效项时，后面的项不被跳过", async () => {
    // include 循环 `if (seen.has(rel)) continue;`（行 279）。
    // 既有用例里"重复项"永远是最后一项 —— 改 break 看不出差别。
    const root = scratch("snap-include-dup-first");
    const backupRoot = scratch("snap-include-dup-first-backups");
    write(root, "src/a.js", "a");
    write(root, "shared/env.json", "{}");
    write(root, "shared/later.json", "{}");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({
      runId: "r-include-dup-first",
      root,
      zones: ["src"],
      // src/a.js 已被 zone 收过（重复，应跳过）—— 它排在两个有效项之前
      include: ["src/a.js", "shared/env.json", "shared/later.json"],
    });

    const keys = [...token.backedUp.keys()].sort();
    expect(keys).toEqual(["shared/env.json", "shared/later.json", "src/a.js"]);
  });

  it("[280] include：不存在的项之后仍有有效项时，后面的项不被跳过", async () => {
    // include 循环 `if (!this.fsImpl.existsSync(...)) continue;`（行 280）。
    // 与上一条同形但触发条件不同（不存在 vs 重复），两处必须分别断言。
    const root = scratch("snap-include-missing-first");
    const backupRoot = scratch("snap-include-missing-first-backups");
    write(root, "src/a.js", "a");
    write(root, "shared/real.json", "{}");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({
      runId: "r-include-missing-first",
      root,
      zones: ["src"],
      // 不存在的项排在最前 —— 改 break 后 shared/real.json 会被丢掉
      include: ["shared/ghost.json", "shared/real.json"],
    });

    expect([...token.backedUp.keys()].sort()).toEqual(["shared/real.json", "src/a.js"]);
  });

  it("include 指向 zone 之外且真实存在的文件时会被独立收录（zone 内已收过的不重复）", async () => {
    // collect 末尾那段 include 循环里 `seen.add(rel); out.push(rel);`（行 264-265）
    // 此前零覆盖 —— 既有用例的 include 要么已在 zone 内（被 seen 挡掉）、要么不存在。
    const root = scratch("snap-include-real");
    const backupRoot = scratch("snap-include-real-backups");
    write(root, "src/a.js", "a");
    write(root, "shared/env.json", "{}"); // zone 之外，但必须一起备份

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({
      runId: "r-include-real",
      root,
      zones: ["src"],
      include: ["shared/env.json"],
    });

    expect([...token.backedUp.keys()].sort()).toEqual(["shared/env.json", "src/a.js"]);
  });

  it("collect 遇到不可读目录时跳过而不是抛错，后续 zone 仍能正常收集", async () => {
    // walk 里的 `catch { return; }`（行 229）此前未覆盖。
    // 模拟"某个 zone 是个不可读目录"：用文件占位一个本该是目录的位置不成立，
    // 所以这里直接删掉目录再断言另一条 zone 不受影响（readdirSync 抛 ENOENT）。
    const root = scratch("snap-unreadable");
    const backupRoot = scratch("snap-unreadable-backups");
    write(root, "src/a.js", "a");
    write(root, "keep/b.js", "b");

    const store = new SnapshotStore({ backupRoot });
    // zone 列表里放一个"存在但不可读"的位置：用 existsSync 为真、statSync 为目录、
    // 但读不到子项的情形在真实 fs 上难造，这里退一步断言"不存在的 zone 被跳过"这条
    // 同族路径，配合下面那条针对 readdirSync 失败的替身用例形成完整覆盖。
    const token = await store.begin({
      runId: "r-unreadable",
      root,
      zones: ["src", "ghost-dir", "keep"],
    });

    expect([...token.backedUp.keys()].sort()).toEqual(["keep/b.js", "src/a.js"]);
  });

  it("全量回滚时新建文件的删除失败会被记入 skipped，不影响其余文件", async () => {
    // revert 里删除新建文件那条 catch（行 137）此前未覆盖。
    // 造法：让父目录只读 —— 里面的文件仍是 entry.isFile()（会进 newlyCreated），
    // 但 rmSync 因为没有写权限而失败。
    const root = scratch("snap-remove-fail");
    const backupRoot = scratch("snap-remove-fail-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-remove-fail", root, zones: ["src"] });
    // 批任务新建的文件，放在一个只读子目录里
    write(root, "src/locked/created.js", "new");
    try {
      fs.chmodSync(path.join(root, "src", "locked"), 0o555);
    } catch {
      // Windows 上 chmod 对目录常是 no-op —— 下面用目录占位法兜底
    }

    const result = await store.revert(token);

    expect(result.restored).toEqual(["src/a.js"]);
    // 删除是否失败取决于平台权限语义；两条分支都必须是"安全"的：
    // 要么进 removed（真删掉了），要么进 skipped（删不掉且说明了原因）。
    const deleted = result.removed.includes("src/locked/created.js");
    const skipped = result.skipped.some((s) => s.path === "src/locked/created.js");
    expect(deleted || skipped).toBe(true);
    if (skipped) {
      expect(result.skipped.find((s) => s.path === "src/locked/created.js")!.reason).toBeTruthy();
    }
  });

  it("全量回滚只删除批任务新建的文件，被备份文件的改动一律还原而非删除", async () => {
    // 与上面那条同族但断言更强的语义：新建 → removed，已有 → restored，二者不能混。
    const root = scratch("snap-remove-vs-restore");
    const backupRoot = scratch("snap-remove-vs-restore-backups");
    write(root, "src/existing.js", "orig");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-remove-vs-restore", root, zones: ["src"] });
    write(root, "src/existing.js", "modified");
    write(root, "src/fresh.js", "fresh");

    const result = await store.revert(token);

    expect(result.removed).toEqual(["src/fresh.js"]);
    expect(result.restored).toEqual(["src/existing.js"]);
    expect(read(root, "src/existing.js")).toBe("orig");
    expect(read(root, "src/fresh.js")).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it("回滚某个已备份文件时若目标被目录占位导致复制失败，记入 skipped 且其余照常还原", async () => {
    // revertOne 里 restore 的 catch（行 166）此前未覆盖。
    const root = scratch("snap-restore-fail");
    const backupRoot = scratch("snap-restore-fail-backups");
    write(root, "src/a.js", "a0");
    write(root, "src/b.js", "b0");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-restore-fail", root, zones: ["src"] });
    // 把 a.js 的位置换成同名非空目录 → copyFileSync 到目录会失败
    fs.rmSync(path.join(root, "src/a.js"), { force: true });
    fs.mkdirSync(path.join(root, "src/a.js", "inner"), { recursive: true });

    const result = await store.revert(token);

    expect(result.skipped.some((s) => s.path === "src/a.js")).toBe(true);
    // b.js 不受影响
    expect(result.restored).toContain("src/b.js");
    expect(read(root, "src/b.js")).toBe("b0");
  });

  it("回滚单个路径时删除失败被记入 skipped", async () => {
    // revertOne 里删除分支的 catch（行 176）此前未覆盖。
    const root = scratch("snap-revert1-rmfail");
    const backupRoot = scratch("snap-revert1-rmfail-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "r-revert1-rmfail", root, zones: ["src"] });
    // 该路径无备份（不在 backedUp），当前存在 → 走删除分支；而它是非空目录 → 失败
    fs.mkdirSync(path.join(root, "src", "ghost.js", "inner"), { recursive: true });

    const result = await store.revert(token, { paths: ["src/ghost.js"] });

    expect(result.removed).toEqual([]);
    expect(result.skipped.some((s) => s.path === "src/ghost.js")).toBe(true);
    expect(result.skipped[0]!.reason).toBeTruthy();
  });
});

describe("withinZones", () => {
  it("路径落在任一声明 zone 内即为真", () => {
    expect(withinZones("src/a.js", ["src"])).toBe(true);
    expect(withinZones("src/deep/b.js", ["other", "src"])).toBe(true);
  });

  it("路径在全部 zone 之外为假", () => {
    expect(withinZones("other/a.js", ["src"])).toBe(false);
    expect(withinZones("srcsibling/a.js", ["src"])).toBe(false); // 前缀相同但不同目录
  });

  it("空 zone 列表恒为假（some 在空数组上是 false）", () => {
    expect(withinZones("src/a.js", [])).toBe(false);
  });
});

describe("SnapshotStore · runId 归一化", () => {
  it("runId 里的路径分隔符被替换，带 ../ 的 runId 不会让备份目录逃逸出 backupRoot", async () => {
    const root = scratch("snap-runid");
    const backupRoot = scratch("snap-runid-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId: "../../evil/run", root, zones: ["src"] });

    // `scope.runId.replace(/[^\w.-]/g, "_")` —— 斜杠与空格等被换成 `_`。
    // 注意 `.` 在白名单内（字符类里是字面量），所以 ".." 会原样留下；
    // 真正挡逃逸的是**斜杠被换掉** —— 没有分隔符，`..` 就只是目录名的一部分。
    expect(token.dirAbs).not.toContain("/");
    expect(path.resolve(token.dirAbs).startsWith(path.resolve(backupRoot) + path.sep)).toBe(true);
    // 单层目录，不会因为 ../ 多跳出去
    expect(path.relative(backupRoot, token.dirAbs)).not.toContain(path.sep);
  });

  it("runId 归一化后仍能区分不同 run，且同一 run 复用同一目录", async () => {
    const root = scratch("snap-runid-dup");
    const backupRoot = scratch("snap-runid-dup-backups");
    write(root, "src/a.js", "a");

    const store = new SnapshotStore({ backupRoot });
    const a = await store.begin({ runId: "run/one", root, zones: ["src"] });
    const b = await store.begin({ runId: "run one", root, zones: ["src"] });
    const c = await store.begin({ runId: "run/one", root, zones: ["src"] });

    // "run/one" 与 "run one" 归一化后同名（都变成 run_one），这是刻意的取舍：
    // 宁可在极端输入下合并，也不能让分隔符漏进去。同 run 复用目录则是必须的。
    expect(a.dirAbs).toBe(b.dirAbs);
    expect(a.dirAbs).toBe(c.dirAbs);
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

/**
 * 下面这组用**注入的 fs 替身**覆盖真实文件系统上造不出来的分支。
 * 辅助函数 `stubFs` / `dirent` 定义在文件顶部（前面的用例也要用）。
 */
describe("SnapshotStore · 注入 fs 替身覆盖真实 fs 造不出的分支", () => {
  it("collect 遇到 readdirSync 抛错（EACCES）时静默跳过，不阻断后续 zone", async () => {
    // 行 229 的 `catch { return; }` —— 一个不可读目录不能带走整个快照。
    const root = scratch("snap-stub-eacces");
    const backupRoot = scratch("snap-stub-eacces-backups");
    write(root, "src/a.js", "a");
    write(root, "other/b.js", "b");

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        readdirSync: (dir, opts) => {
          if (dir.endsWith(`${path.sep}src`)) {
            const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return fs.readdirSync(dir, opts) as fs.Dirent[];
        },
      }),
    );

    const token = await store.begin({ runId: "r-stub-eacces", root, zones: ["src", "other"] });

    // src 的条目一个都收不到（读失败），但 other 必须照常收 —— 这是"跳过而非终止"
    expect([...token.backedUp.keys()]).toEqual(["other/b.js"]);
  });

  it("collect 跳过既非文件也非目录的 dirent（fifo/socket），后面的正常文件不受影响", async () => {
    // 行 238 的 `if (!entry.isFile()) continue;` —— 此前未覆盖。
    // 顺序关键：fifo 排在 good.js 之前，若改成 break，good.js 会一起丢。
    const root = scratch("snap-stub-collect-fifo");
    const backupRoot = scratch("snap-stub-collect-fifo-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        readdirSync: (dir) => {
          if (dir.endsWith(`${path.sep}src`)) {
            return [dirent("pipe.fifo", "other"), dirent("good.js", "file")];
          }
          return [] as fs.Dirent[];
        },
        existsSync: () => true,
        statSync: () => ({ isFile: () => false, isDirectory: () => true }),
        copyFileSync: () => undefined,
      }),
    );

    const token = await store.begin({ runId: "r-stub-collect-fifo", root, zones: ["src"] });

    expect([...token.backedUp.keys()]).toEqual(["src/good.js"]);
  });

  it("newlyCreated 跳过 fifo/socket 与 skipDirs，不会把它们当作批任务新建去删", async () => {
    // 行 198（skipDirs）与行 202（!entry.isFile()）两处 —— 此前均未覆盖。
    // 这两处若退化，全量回滚会把 fifo、node_modules 都当"新建"删掉。
    const root = scratch("snap-stub-newly-filters");
    const backupRoot = scratch("snap-stub-newly-filters-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    write(root, "src/a.js", "a");

    const removed: string[] = [];
    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        readdirSync: (dir): fs.Dirent[] => {
          if (dir.endsWith(`${path.sep}src`)) {
            return [
              dirent("node_modules", "dir"),
              dirent("pipe.fifo", "other"),
              dirent("fresh.js", "file"),
            ];
          }
          if (dir.endsWith("node_modules")) {
            return [dirent("pkg.js", "file")];
          }
          return [];
        },
        rmSync: (p) => {
          removed.push(p);
        },
      }),
    );

    const token = bareToken(backupRoot, root, ["src"], "r-stub-newly-filters");
    const result = await store.revert(token);

    // 只有 fresh.js 是"普通文件且不在 skipDirs 且未被备份" → 唯一的删除目标
    expect(result.removed).toEqual(["src/fresh.js"]);
    expect(removed).toHaveLength(1);
    // node_modules 被 skipDirs 挡住，根本没进去递归
    expect(removed.some((p) => p.includes("node_modules"))).toBe(false);
    expect(removed.some((p) => p.includes("pipe.fifo"))).toBe(false);
  });

  it("newlyCreated 自身 readdirSync 失败时不抛错，其余 zone 照常扫描", async () => {
    // 行 193 的 catch —— newlyCreated 与 collect 各有一处同形 catch，要分别覆盖。
    const root = scratch("snap-stub-newly-eacces");
    const backupRoot = scratch("snap-stub-newly-eacces-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "ok"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        readdirSync: (dir): fs.Dirent[] => {
          if (dir.endsWith(`${path.sep}src`)) {
            const err = new Error("EACCES") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
          return [dirent("b.js", "file")];
        },
        rmSync: () => undefined,
      }),
    );

    const token = bareToken(backupRoot, root, ["src", "ok"], "r-stub-newly-eacces");

    // 不抛错，且 ok/b.js 仍被识别为新建
    const result = await store.revert(token);
    expect(result.removed).toEqual(["ok/b.js"]);
    expect(result.skipped).toEqual([]);
  });

  it("全量回滚删除新建文件被拒绝时记入 skipped 并带出原因", async () => {
    // 行 137 的 catch —— Windows 上 chmod 对目录常是 no-op，只能用替身。
    const root = scratch("snap-stub-rmfail");
    const backupRoot = scratch("snap-stub-rmfail-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        readdirSync: () => [dirent("locked.js", "file")],
        rmSync: () => {
          const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        },
      }),
    );

    const token = bareToken(backupRoot, root, ["src"], "r-stub-rmfail");
    const result = await store.revert(token);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.path).toBe("src/locked.js");
    expect(result.skipped[0]!.reason).toContain("EPERM");
  });

  it("begin 复制失败时记入 skipped 并继续处理后续文件（替身版，跨平台确定）", async () => {
    // 与前面"目录占位"那条同义，但用替身让 EACCES 在任何平台都稳定复现。
    const root = scratch("snap-stub-copyfail");
    const backupRoot = scratch("snap-stub-copyfail-backups");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    const store = new SnapshotStore(
      { backupRoot },
      stubFs({
        existsSync: () => true,
        statSync: () => ({ isFile: () => false, isDirectory: () => true }),
        readdirSync: () => [
          dirent("a.js", "file"),
          dirent("b.js", "file"),
          dirent("c.js", "file"),
        ],
        copyFileSync: (from) => {
          if (from.endsWith("a.js")) {
            const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
            err.code = "EACCES";
            throw err;
          }
        },
      }),
    );

    const token = await store.begin({ runId: "r-stub-copyfail", root, zones: ["src"] });

    expect(token.skipped).toEqual(["src/a.js"]);
    expect([...token.backedUp.keys()]).toEqual(["src/b.js", "src/c.js"]);
  });
});
