import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VariantStore } from "../electron/engine/variant-store";
import { SnapshotStore } from "../electron/sandbox/snapshot-store";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清理尽力而为
    }
  }
});

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-variant-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/** 真快照 + 真台账（settle 窗口保持生产默认：同 tick 写入不漏检）。 */
function makeStore(): { store: VariantStore; backups: string } {
  const backups = scratch("backups");
  return { store: new VariantStore(new SnapshotStore({ backupRoot: backups })), backups };
}

describe("VariantStore · 窗口生命周期", () => {
  it("捕获 zone 内净变更（改/删/建），复位回开窗时，回放等于变体后", async () => {
    const root = scratch("repo");
    const { store, backups } = makeStore();
    fs.mkdirSync(path.join(root, "src/a"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a/keep.js"), "keep");
    fs.writeFileSync(path.join(root, "src/a/gone.js"), "gone");
    fs.writeFileSync(path.join(root, "outside.txt"), "before");

    const win = await store.beginWindow({ runId: "v1", root, zone: "src/a" });
    // 变体现场：改 keep、删 gone、建 fresh；顺手越权动了 zone 外的文件。
    fs.writeFileSync(path.join(root, "src/a/keep.js"), "keep v2");
    fs.rmSync(path.join(root, "src/a/gone.js"));
    fs.writeFileSync(path.join(root, "src/a/fresh.js"), "fresh");
    fs.writeFileSync(path.join(root, "outside.txt"), "after");

    const capture = store.capture(win, { variantIndex: 0, agentId: "a1" });
    expect(capture.replayable).toBe(true);
    expect(capture.changes.map((c) => `${c.path}:${c.op}`).sort()).toEqual([
      "src/a/fresh.js:create",
      "src/a/gone.js:delete",
      "src/a/keep.js:modify",
    ]);
    // zone 外改动不进镜像 —— 那是 BatchGuard 的账，不是变体窗口的。
    expect([...capture.forward.keys()]).not.toContain("outside.txt");

    await store.revert(win);
    expect(fs.readFileSync(path.join(root, "src/a/keep.js"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(root, "src/a/gone.js"), "utf8")).toBe("gone");
    expect(fs.existsSync(path.join(root, "src/a/fresh.js"))).toBe(false);
    // 窗口刻意不动 zone 外的任何东西（越权由批次仲裁层收口）。
    expect(fs.readFileSync(path.join(root, "outside.txt"), "utf8")).toBe("after");

    store.apply(win, capture);
    expect(fs.readFileSync(path.join(root, "src/a/keep.js"), "utf8")).toBe("keep v2");
    expect(fs.existsSync(path.join(root, "src/a/gone.js"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "src/a/fresh.js"), "utf8")).toBe("fresh");

    await store.finish(win);
    expect(fs.existsSync(path.join(backups, "v1"))).toBe(false);
  });

  it("顺序窗口互不污染：第二个窗口只看见自己的变更", async () => {
    const root = scratch("repo");
    const { store } = makeStore();
    fs.mkdirSync(path.join(root, "z"), { recursive: true });
    fs.writeFileSync(path.join(root, "z/f.js"), "v0");

    const w1 = await store.beginWindow({ runId: "w1", root, zone: "z" });
    fs.writeFileSync(path.join(root, "z/f.js"), "v1-longer");
    fs.writeFileSync(path.join(root, "z/n1.js"), "n1");
    const c1 = store.capture(w1, { variantIndex: 0 });
    await store.revert(w1);

    const w2 = await store.beginWindow({ runId: "w2", root, zone: "z" });
    fs.writeFileSync(path.join(root, "z/f.js"), "v2-longer");
    const c2 = store.capture(w2, { variantIndex: 1 });
    await store.revert(w2);

    expect(c1.changes.map((c) => c.path).sort()).toEqual(["z/f.js", "z/n1.js"]);
    expect(c2.changes.map((c) => c.path)).toEqual(["z/f.js"]);
    expect(fs.readFileSync(path.join(root, "z/f.js"), "utf8")).toBe("v0");
    expect(fs.existsSync(path.join(root, "z/n1.js"))).toBe(false);
    await store.finish(w1);
    await store.finish(w2);
  });

  it("finish 丢弃备份目录（窗口是瞬态的）", async () => {
    const root = scratch("repo");
    const { store, backups } = makeStore();
    fs.mkdirSync(path.join(root, "z"), { recursive: true });
    fs.writeFileSync(path.join(root, "z/f.js"), "x");
    const win = await store.beginWindow({ runId: "w-fin", root, zone: "z" });
    expect(fs.existsSync(path.join(backups, "w-fin"))).toBe(true);
    await store.finish(win);
    expect(fs.existsSync(path.join(backups, "w-fin"))).toBe(false);
  });

  it("先建后删的净变化为空（stat-only 台账的诚实边界）", async () => {
    const root = scratch("repo");
    const { store } = makeStore();
    fs.mkdirSync(path.join(root, "z"), { recursive: true });
    const win = await store.beginWindow({ runId: "w-del", root, zone: "z" });
    fs.writeFileSync(path.join(root, "z/tmp.js"), "tmp");
    fs.rmSync(path.join(root, "z/tmp.js"));
    const capture = store.capture(win, { variantIndex: 0 });
    // begin 后先建后删：baseline 没有它、after 也没有 ⇒ 视图里"从没出现过"，
    // 这是 stat-only 台账的诚实边界（净变化为空），不是错误。
    expect(capture.changes.map((c) => `${c.path}:${c.op}`)).toEqual([]);
    await store.revert(win);
    expect(fs.existsSync(path.join(root, "z/tmp.js"))).toBe(false);
    await store.finish(win);
  });
});
