import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, tempNameFor, writeFileAtomic } from "../electron/atomic-file";
import { ProjectStore, SettingsStore } from "../electron/store";
import { DEFAULT_SETTINGS } from "../shared/types";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-atomic-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces an existing file and leaves no temp files behind", () => {
    const file = path.join(dir, "data.json");
    fs.writeFileSync(file, "old", "utf8");
    writeFileAtomic(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    // A leaked `.data.json.<pid>.<ts>.tmp` would accumulate one file per write.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the parent directory when it does not exist", () => {
    const file = path.join(dir, "nested", "deeper", "data.json");
    writeFileAtomic(file, "{}");
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });

  it("leaves the previous content readable when the write itself fails", () => {
    const file = path.join(dir, "data.json");
    writeFileAtomic(file, "good");
    // A directory can be written but not renamed onto, which is the closest
    // reproducible stand-in for "the write died half-way".
    const blocker = path.join(dir, "blocked");
    fs.mkdirSync(blocker);
    expect(() => writeFileAtomic(blocker, "x")).toThrow();
    // The real file was never touched, so a reader still sees a complete value.
    expect(fs.readFileSync(file, "utf8")).toBe("good");
  });
});

describe("tempNameFor · 同毫秒也要唯一", () => {
  it("同一 pid 同一毫秒的两次调用给出不同名字（并发写不再互相覆盖）", () => {
    // 只有 pid + Date.now() 时这两次会得到同一个 tmp：后写的覆盖先写的，
    // 那次内容凭空消失且不报错。这正是 CI 上"偶发丢一次写入"的形状。
    const a = tempNameFor("data.json", 4242, 1_700_000_000_000);
    const b = tempNameFor("data.json", 4242, 1_700_000_000_000);
    expect(a).not.toBe(b);
  });

  it("名字里带 pid、basename 与 .tmp 后缀（落点仍是同目录）", () => {
    const name = tempNameFor("data.json", 4242, 1_700_000_000_000);
    expect(name.startsWith(".data.json.4242.")).toBe(true);
    expect(name.endsWith(".tmp")).toBe(true);
  });

  it("不同 basename 互不相同（同目录多文件并发写不串台）", () => {
    expect(tempNameFor("a.json", 7, 1)).not.toBe(tempNameFor("b.json", 7, 1));
  });
});

describe("readJsonFile", () => {
  it("returns the fallback only when the file is absent", () => {
    expect(readJsonFile(path.join(dir, "nope.json"), [])).toEqual([]);
  });

  it("throws on a corrupt file instead of silently defaulting", () => {
    // Silently returning the fallback here is what turns a truncated write into
    // "all my projects vanished" with no error surfaced anywhere.
    const file = path.join(dir, "corrupt.json");
    fs.writeFileSync(file, '{"half": ', "utf8");
    expect(() => readJsonFile(file, {})).toThrow();
  });

  it("tolerates a UTF-8 BOM", () => {
    const file = path.join(dir, "bom.json");
    fs.writeFileSync(file, '\uFEFF{"a":1}', "utf8");
    expect(readJsonFile(file, {})).toEqual({ a: 1 });
  });
});

describe("ProjectStore · durability", () => {
  it("keeps every project across writes, and leaves no temp residue", () => {
    const store = new ProjectStore(dir);
    const a = store.create("alpha", "req-a");
    store.create("beta", "req-b");
    store.update(a.id, { stage: "DEVELOPMENT" });
    expect(store.list().map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("survives a serialise round-trip through the atomic path", () => {
    const store = new ProjectStore(dir);
    const rec = store.create("gamma", "with \"quotes\" and \\ backslash");
    // Re-read from a fresh instance: proves it is really on disk, not cached.
    const reopened = new ProjectStore(dir);
    expect(reopened.get(rec.id)?.requirement).toBe('with "quotes" and \\ backslash');
  });
});

describe("SettingsStore · durability", () => {
  it("round-trips settings through a fresh instance", () => {
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file);
    store.save({ ...DEFAULT_SETTINGS, llmProvider: "deepseek", maxParallelRuns: 7 });
    const reopened = new SettingsStore(file);
    expect(reopened.load().llmProvider).toBe("deepseek");
    expect(reopened.load().maxParallelRuns).toBe(7);
  });

  it("returns defaults when the file is absent", () => {
    const store = new SettingsStore(path.join(dir, "missing.json"));
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("does not let a caller mutate process-wide defaults via loaded settings", () => {
    const file = path.join(dir, "settings.json");
    new SettingsStore(file).save({ ...DEFAULT_SETTINGS });
    const baseline = structuredClone(DEFAULT_SETTINGS.llmPool);
    const loaded = new SettingsStore(file).load();
    loaded.llmPool.push({ provider: "poison" } as never);
    // The nested array must be a clone: poisoning it must not reach the
    // process-wide DEFAULT_SETTINGS that every later load() spreads from.
    expect(DEFAULT_SETTINGS.llmPool).toEqual(baseline);
    expect(DEFAULT_SETTINGS.llmPool).not.toContainEqual({ provider: "poison" });
  });
});
