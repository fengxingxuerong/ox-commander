import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { AutomationStore } from "../electron/automations/automation-store";
import { MIN_EVERY_MS } from "../shared/schedule-core";

/**
 * M5b 的记录仓。断言重点是三条失败语义（与 session-store / ProjectStore 对齐）：
 * 坏记录逐条跳过、文件损坏**抛出来**（不静默当空表）、写坏值当场拒收。
 * 落盘用真实临时目录 —— 原子性/重启可读这些性质 mock 掉 fs 就等于没测。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-automation-store-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const NOW = 1_700_000_000_000;

function good(over: Record<string, unknown> = {}) {
  return { name: "夜间构建", projectId: "p1", everyMs: 300_000, ...over };
}

describe("AutomationStore", () => {
  it("create → list 原样读回；换个实例（模拟重启）仍读得到", () => {
    const dir = path.join(root, "a");
    const store = new AutomationStore(dir);
    const created = store.create(good({ enabled: true }), NOW);
    expect(created.id.startsWith("auto-")).toBe(true);
    expect(created.enabled).toBe(true);
    expect(created.lastFiredMs).toBeUndefined();

    const reopened = new AutomationStore(dir);
    expect(reopened.list()).toEqual([created]);
    expect(reopened.get(created.id)).toEqual(created);
    expect(reopened.get("auto-nope")).toBeNull();
  });

  it("缺文件 = 空表（首次启动不炸）", () => {
    expect(new AutomationStore(path.join(root, "empty")).list()).toEqual([]);
  });

  it("create 的入参与读盘同一把尺子：坏入参当场报错，且不落盘", () => {
    const dir = path.join(root, "b");
    const store = new AutomationStore(dir);
    expect(() => store.create(good({ name: "  " }), NOW)).toThrow(/名称不能为空/);
    expect(() => store.create(good({ projectId: "" }), NOW)).toThrow(/必须指定一个项目/);
    expect(() => store.create(good({ everyMs: MIN_EVERY_MS - 1 }), NOW)).toThrow(/间隔不能小于/);
    expect(() => store.create(good({ everyMs: "5000" }), NOW)).toThrow(/间隔必须是毫秒数/);
    expect(store.list()).toEqual([]);
  });

  it("坏记录只跳过自己：手改坏的 automation 不影响其它条目", () => {
    const dir = path.join(root, "c");
    const store = new AutomationStore(dir);
    const kept = store.create(good({ name: "好的" }), NOW);
    // 直接往文件里塞一条坏记录（模拟手改）：缺 everyMs 的那条
    const file = path.join(dir, "automations.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { automations: unknown[] };
    parsed.automations.push({ id: "auto-bad", name: "坏的", projectId: "p1", enabled: true });
    fs.writeFileSync(file, JSON.stringify(parsed), "utf8");
    expect(store.list().map((a) => a.id)).toEqual([kept.id]);
  });

  it("文件损坏时抛出来，不静默当空表（静默=自动化凭空消失且无痕迹）", () => {
    const dir = path.join(root, "d");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "automations.json"), "{ not json", "utf8");
    expect(() => new AutomationStore(dir).list()).toThrow();
  });

  it("update：改间隔/改名/启停都走合并后重新过尺子", () => {
    const dir = path.join(root, "e");
    const store = new AutomationStore(dir);
    const a = store.create(good(), NOW);

    const renamed = store.update(a.id, { name: "  每周构建  " }, NOW + 1000);
    expect(renamed?.name).toBe("每周构建");
    expect(renamed?.createdAt).toBe(a.createdAt); // 创建时间不属于可编辑范围
    expect(renamed?.updatedAt).toBe(NOW + 1000);

    expect(store.update(a.id, { everyMs: 60_000 }, NOW + 2000)?.everyMs).toBe(60_000);
    expect(store.update(a.id, { enabled: false }, NOW + 3000)?.enabled).toBe(false);
    // enabled 只认显式布尔：字符串 "false" 不是停用
    expect(store.update(a.id, { enabled: "false" as unknown as boolean }, NOW + 4000)?.enabled).toBe(false);
    expect(store.update("auto-nope", { name: "x" }, NOW)).toBeNull();
  });

  it("update 拒收坏值，且盘上的记录不被改坏", () => {
    const dir = path.join(root, "f");
    const store = new AutomationStore(dir);
    const a = store.create(good({ name: "夜间构建" }), NOW);
    expect(() => store.update(a.id, { name: "" }, NOW + 1)).toThrow(/名称不能为空/);
    expect(() => store.update(a.id, { everyMs: 999 }, NOW + 2)).toThrow(/间隔不能小于/);
    const after = store.get(a.id);
    expect(after?.name).toBe("夜间构建");
    expect(after?.everyMs).toBe(300_000);
  });

  it("remove：真删了返 true，不存在返 false", () => {
    const dir = path.join(root, "g");
    const store = new AutomationStore(dir);
    const a = store.create(good(), NOW);
    const b = store.create(good({ name: "另一个" }), NOW);
    expect(store.remove(b.id)).toBe(true);
    expect(store.list().map((x) => x.id)).toEqual([a.id]);
    expect(store.remove(b.id)).toBe(false);
  });

  it("markFired 落 lastFiredMs；未知 id 返 null", () => {
    const dir = path.join(root, "h");
    const store = new AutomationStore(dir);
    const a = store.create(good(), NOW);
    const fired = store.markFired(a.id, NOW + 5000);
    expect(fired?.lastFiredMs).toBe(NOW + 5000);
    expect(fired?.updatedAt).toBe(NOW + 5000);
    expect(store.get(a.id)?.lastFiredMs).toBe(NOW + 5000);
    expect(store.markFired("auto-nope", NOW)).toBeNull();
  });
});
