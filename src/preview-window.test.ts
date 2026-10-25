import { describe, expect, it, vi } from "vitest";

/**
 * 应用内预览窗口（C3 剩余半，2026-10-25）。
 *
 * 这里的做法与 `main-wiring.test.ts` 同源：**把真实模块跑在虚构的 electron 上**
 * （`vitest.config.mts` 把 `electron` 指到 `src/__fakes__/electron.ts`），而不是把
 * 逻辑重构成"可测函数" —— 被测的正是"窗口怎么开、开了之后守住什么"。
 *
 * 每例都 `resetModules` 重新加载：模块里那个单例窗口引用是承重状态（同一项目复用、
 * 换项目替换），跨例共用会让断言互相污染。
 */
async function loadModule(): Promise<{
  fake: typeof import("./__fakes__/electron");
  mod: typeof import("../electron/preview-window");
}> {
  vi.resetModules();
  const fake = await import("./__fakes__/electron");
  fake.resetFakeApp();
  const mod = await import("../electron/preview-window");
  return { fake, mod };
}

const URL = "http://127.0.0.1:5173/";

describe("预览窗口 · 隔离 profile", () => {
  it("打开：窗口用该项目的 persist partition、只加载回环地址、不带 preload 桥", async () => {
    const { fake, mod } = await loadModule();

    expect(mod.openPreviewWindow("p-1-1", URL)).toEqual({ ok: true });
    expect(fake.createdWindows).toHaveLength(1);

    const win = fake.createdWindows[0]!;
    expect(win.loaded).toBe(URL);
    const prefs = (win.options.webPreferences ?? {}) as Record<string, unknown>;
    expect(prefs.partition).toBe("persist:ox-preview-p-1-1");
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    // 被预览的是模型产出 + 第三方页面：它绝不能拿到主窗口那份 IPC 控制面。
    expect("preload" in prefs).toBe(false);
  });

  it("同一项目再打开：聚焦同一窗口，不新建（profile 不变 = 登录态接着用）", async () => {
    const { fake, mod } = await loadModule();

    mod.openPreviewWindow("p-1-1", URL);
    const first = fake.createdWindows[0]!;

    expect(mod.openPreviewWindow("p-1-1", URL)).toEqual({ ok: true });
    expect(fake.createdWindows).toHaveLength(1);
    expect(first.focusCalls).toBe(1);
    expect(first.closed).toBe(false);
  });

  it("换项目：旧窗口关掉、新窗口换到那个项目的 partition", async () => {
    const { fake, mod } = await loadModule();

    mod.openPreviewWindow("p-1-1", URL);
    const first = fake.createdWindows[0]!;
    expect(mod.openPreviewWindow("p-1-2", URL)).toEqual({ ok: true });

    expect(first.closed).toBe(true);
    expect(fake.createdWindows).toHaveLength(2);
    const prefs = fake.createdWindows[1]!.options.webPreferences as Record<string, unknown>;
    expect(prefs.partition).toBe("persist:ox-preview-p-1-2");
  });

  it("窗口已被关掉之后再打开：新建窗口，不去 focus 一个已销毁的窗口", async () => {
    const { fake, mod } = await loadModule();

    mod.openPreviewWindow("p-1-1", URL);
    fake.createdWindows[0]!.close();
    expect(mod.openPreviewWindow("p-1-1", URL)).toEqual({ ok: true });

    expect(fake.createdWindows).toHaveLength(2);
    expect(fake.createdWindows[1]!.closed).toBe(false);
    expect(fake.createdWindows[1]!.focusCalls).toBe(0);
  });

  it("项目 id 非法或缺失：拒绝打开，且一个窗口都不建", async () => {
    const { fake, mod } = await loadModule();

    for (const bad of ["", "p 1", "项目", 42, undefined]) {
      const res = mod.openPreviewWindow(bad, URL);
      expect(res.ok, String(bad)).toBe(false);
      if (!res.ok) expect(res.reason).toContain("项目 id");
    }
    expect(fake.createdWindows).toHaveLength(0);
  });

  it("非本机回环地址：拒绝打开（判据与 dev-server 冒烟、schema 同一份）", async () => {
    const { fake, mod } = await loadModule();

    for (const bad of ["https://example.com/", "file:///etc/passwd", "not-a-url"]) {
      const res = mod.openPreviewWindow("p-1-1", bad);
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.reason).toContain("本机 HTTP");
    }
    expect(fake.createdWindows).toHaveLength(0);
  });

  it("导航守卫：不开新窗口、导航与重定向都出不去，回环地址照常放行", async () => {
    const { fake, mod } = await loadModule();
    mod.openPreviewWindow("p-1-1", URL);
    const win = fake.createdWindows[0]!;

    // 子窗口会继承同一份 webPreferences（含那份隔离 profile），一律不开。
    expect(win.openWindow()).toEqual({ action: "deny" });
    expect(win.fireNavigation("https://evil.example.com/")).toBe(true);
    expect(win.fireNavigation("http://localhost:5173/app")).toBe(false);
    // 服务端重定向也要拦：dev server 302 到外部站点时不能把窗口带走。
    expect(win.fireRedirect("https://evil.example.com/")).toBe(true);
    expect(win.fireRedirect("http://127.0.0.1:5173/login")).toBe(false);
  });
});

describe("预览窗口 · 关闭与清除", () => {
  it("没有窗口时返回 false；有窗口时关掉；已销毁的窗口不再 close", async () => {
    const { fake, mod } = await loadModule();

    expect(mod.closePreviewWindow()).toBe(false);

    mod.openPreviewWindow("p-1-1", URL);
    expect(mod.closePreviewWindow()).toBe(true);
    expect(fake.createdWindows[0]!.closed).toBe(true);
    expect(mod.closePreviewWindow()).toBe(false);

    // 窗口自己先没了（使用者点了标题栏的关闭）时，收尾不能抛错。
    mod.openPreviewWindow("p-1-1", URL);
    fake.createdWindows[1]!.close();
    expect(mod.closePreviewWindow()).toBe(true);
    expect(mod.closePreviewWindow()).toBe(false);
  });

  it("清除预览数据：落在该项目自己的 partition 上", async () => {
    const { fake, mod } = await loadModule();

    expect(await mod.resetPreviewStorage("p-1-2")).toEqual({ ok: true });
    expect(fake.requestedPartitions).toEqual(["persist:ox-preview-p-1-2"]);
    expect(fake.clearedPartitions).toEqual(["persist:ox-preview-p-1-2"]);
  });

  it("清除预览数据：身份非法时不清任何东西，并给出原因", async () => {
    const { fake, mod } = await loadModule();

    const res = await mod.resetPreviewStorage("项目");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("项目 id");
    expect(fake.requestedPartitions).toEqual([]);
    expect(fake.clearedPartitions).toEqual([]);
  });
});
