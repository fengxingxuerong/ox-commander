/**
 * electron/store.ts — JSON persistence layer (ProjectStore / SettingsStore).
 * Runs in plain node against a temp dir; pins the BOM tolerance, the
 * defaults-merge semantics and the CRUD contract the IPC layer relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore, SettingsStore } from "./store";
import { DEFAULT_SETTINGS } from "../shared/types";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-store-"));
});

afterEach(() => {
  // Windows keeps handles briefly; never fail the suite on cleanup races.
  try {
    fs.rmSync(dir, { recursive: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best effort */
  }
});

describe("ProjectStore", () => {
  it("creates, lists (newest first), gets, updates and removes", () => {
    const store = new ProjectStore(dir);
    const a = store.create("项目A", "需求A");
    const b = store.create("项目B", "需求B");
    expect(a.stage).toBe("PRD");
    expect(b.id).not.toBe(a.id);

    const listed = store.list();
    expect(listed.map((r) => r.name)).toEqual(["项目B", "项目A"]);

    expect(store.get(a.id)?.requirement).toBe("需求A");

    const before = store.get(a.id)!.updatedAt;
    store.update(a.id, { stage: "DONE", prdJson: "{}" });
    const after = store.get(a.id)!;
    expect(after.stage).toBe("DONE");
    expect(after.prdJson).toBe("{}");
    expect(after.createdAt).toBe(store.get(a.id)!.createdAt);
    expect(after.updatedAt >= before).toBe(true);

    expect(store.remove(a.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.remove(a.id)).toBe(false);
  });

  it("同一毫秒内连建两个项目：id 不碰撞，newest-first 平局可分", () => {
    // CI ubuntu 首跑 flake（e74af63 前）：id 与 createdAt 都是 Date.now 毫秒
    // 精度，同毫秒连建两个项目时 id 碰撞（p-<ts> 相同）、排序平局随机 ——
    // "newest first" 断言时挂时不挂。用假时钟钉住同毫秒场景，把
    // 「id 唯一性」与「平局决胜」变成确定性断言。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    try {
      const store = new ProjectStore(dir);
      const a = store.create("先建", "r1");
      const b = store.create("后建", "r2");
      expect(b.id).not.toBe(a.id);

      const listed = store.list();
      expect(listed.map((r) => r.id)).toEqual([b.id, a.id]); // 平局：后建者在前
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects updates for unknown ids", () => {
    const store = new ProjectStore(dir);
    expect(() => store.update("nope", { stage: "DONE" })).toThrow(/not found/);
  });

  it("survives a UTF-8 BOM written by external tools", () => {
    const store = new ProjectStore(dir);
    store.create("项目A", "需求A");
    const file = path.join(dir, "projects.json");
    fs.writeFileSync(file, "\uFEFF" + fs.readFileSync(file, "utf8"), "utf8");
    expect(store.list().map((r) => r.name)).toEqual(["项目A"]);
  });
});

describe("SettingsStore", () => {
  it("returns pristine defaults when the file is missing", () => {
    const store = new SettingsStore(path.join(dir, "settings.json"));
    expect(store.load()).toEqual(DEFAULT_SETTINGS);
    // a copy, not a live reference into DEFAULT_SETTINGS
    const loaded = store.load();
    loaded.enabledAgents.push("x");
    expect(DEFAULT_SETTINGS.enabledAgents).toEqual(["sensenova-api"]);
  });

  it("round-trips a full save and merges partial files over defaults", () => {
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file);

    store.save({ ...DEFAULT_SETTINGS, maxRepairRounds: 5, llmPool: ["sensenova"] });
    expect(store.load().maxRepairRounds).toBe(5);
    expect(store.load().llmPool).toEqual(["sensenova"]);

    fs.writeFileSync(file, JSON.stringify({ maxRepairRounds: 9 }), "utf8");
    const merged = store.load();
    expect(merged.maxRepairRounds).toBe(9);
    expect(merged.llmProvider).toBe(DEFAULT_SETTINGS.llmProvider);
    expect(merged.verificationCommands).toEqual(DEFAULT_SETTINGS.verificationCommands);
  });

  it("tolerates a BOM the same way the projects file does", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ maxRepairRounds: 2 }), "utf8");
    expect(new SettingsStore(file).load().maxRepairRounds).toBe(2);
  });
});
