import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `electron/main.ts` 是进程入口：到这一轮为止它 0% 覆盖、无任何断言 ——
 * 而它决定的是「开几个进程、往哪个窗口发事件、失败时退不退出」这类
 * 一旦错了整个应用都不可用的事。
 *
 * 这里的做法是把入口**跑起来**（fixture 化的 electron 替身 + 模块重置），
 * 而不是把它重构成"可测函数"——入口的结构本身就是被测对象（谁先谁后、
 * 哪个分支才 whenReady）。
 *
 * 依赖 vitest.config.mts 里 `electron` → `src/__fakes__/electron.ts` 的别名，
 * 所以 `import "electron"`（main.ts 内）与 `import "./__fakes__/electron"`（本文件）
 * 拿到的是**同一个模块实例**，不需要 vi.mock。
 *
 * `../electron/ipc` 必须 mock 掉：真品会在 import 时 `ensureStores()` 落盘，
 * 而这里要断言的是"入口有没有调它"，不是它自己干了什么（那是 ipc.test.ts 的事）。
 */
vi.mock("../electron/ipc", () => ({
  registerIpc: vi.fn(),
  attachWindow: vi.fn(),
}));

type FakeElectron = typeof import("./__fakes__/electron");
type IpcModule = typeof import("../electron/ipc");

const tempDirs: string[] = [];
const touchedEnv: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
  for (const name of touchedEnv.splice(0)) delete process.env[name];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-main-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 以指定的 electron 替身状态加载一次入口。
 *
 * 顺序是刻意的：先 resetModules 再 import 替身与 ipc（否则拿到的是上一轮的
 * 旧实例），改完替身状态**最后**才 import main.ts —— 入口的行为发生在模块
 * 顶层，晚一步就改不动了。
 */
async function loadEntry(
  setup?: (fake: FakeElectron) => void,
): Promise<{ fake: FakeElectron; ipc: IpcModule }> {
  vi.resetModules();
  const fake = await import("./__fakes__/electron");
  const ipc = await import("../electron/ipc");
  fake.resetFakeApp();
  vi.mocked(ipc.registerIpc).mockClear();
  vi.mocked(ipc.attachWindow).mockClear();
  setup?.(fake);
  await import("../electron/main");
  // whenReady().then(...) 的回调在微任务里跑，等一拍再断言。
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { fake, ipc };
}

function setEnv(name: string, value: string): void {
  touchedEnv.push(name);
  process.env[name] = value;
}

describe("electron 入口 · 单实例锁", () => {
  it("[拿到锁] 注册 IPC 并开窗，事件汇点是那个窗口", async () => {
    const { fake, ipc } = await loadEntry();

    expect(ipc.registerIpc).toHaveBeenCalledTimes(1);
    expect(fake.createdWindows).toHaveLength(1);
    expect(ipc.attachWindow).toHaveBeenCalledWith(fake.createdWindows[0]);
    // 入口在**打包产物**里是 dist-electron/electron/main.js，所以它用 `../../dist/index.html`
    // 回到仓库根。vitest 下跑的是源码 electron/main.ts，跳两级会落到仓库上一级 ——
    // 绝对路径因此不可断言。能断言、也最该断言的是「跳几级 + 指向哪个文件」：
    // 少写一级在源码里看不出问题，只有打包后才变成"页面白屏"。
    const expectedBundle = path.join(__dirname, "..", "electron", "..", "..", "dist", "index.html");
    expect(fake.createdWindows[0]!.loaded).toBe(expectedBundle);
    expect(fake.createdWindows[0]!.loaded).not.toBe("http://localhost:5173");
    expect(fake.app.quit).not.toHaveBeenCalled();
  });

  it("[拿不到锁] 直接退出，且连 whenReady 都不该调（不是先开窗再退）", async () => {
    const { fake, ipc } = await loadEntry((f) => f.app.requestSingleInstanceLock.mockReturnValue(false));

    expect(fake.app.quit).toHaveBeenCalledTimes(1);
    expect(ipc.registerIpc).not.toHaveBeenCalled();
    expect(fake.createdWindows).toHaveLength(0);
    // 这一条才是关键：断言"没走到 ready"，而不只是"结果看起来没开窗"。
    expect(fake.app.whenReady).not.toHaveBeenCalled();
  });

  it("[second-instance] 最小化中的窗口被 restore 后 focus", async () => {
    const { fake } = await loadEntry();
    const win = fake.createdWindows[0]!;
    win.minimized = true;

    fake.fireAppEvent("second-instance", {}, []);

    expect(win.restoreCalls).toBe(1);
    expect(win.focusCalls).toBe(1);
  });

  it("[second-instance] 窗口已关闭时不抛错（守卫真的兜住了）", async () => {
    const { fake } = await loadEntry();
    const win = fake.createdWindows[0]!;
    win.close();
    expect(fake.appEventNames()).toContain("second-instance");

    // 去掉 `if (!win) return;` 之后这里会 TypeError（focus of undefined）。
    expect(() => fake.fireAppEvent("second-instance", {}, [])).not.toThrow();
    expect(win.focusCalls).toBe(0);
  });

  it("[window-all-closed] 非 darwin 退出 / darwin 不退（按当前平台断言，两种写法各验一侧）", async () => {
    const { fake } = await loadEntry();
    expect(fake.appEventNames()).toContain("window-all-closed");

    fake.fireAppEvent("window-all-closed");

    // 平台相关分支：`process.platform` 是模块读的全局量，没做成参数，
    // 所以这里只能断言"本机该成立的一侧"。darwin 那一侧要跑到得换 OS
    // （CI 的 ubuntu/windows 都不覆盖它）——这是已记录的局限，不是漏测。
    if (process.platform === "darwin") {
      expect(fake.app.quit).not.toHaveBeenCalled();
    } else {
      expect(fake.app.quit).toHaveBeenCalledTimes(1);
    }
  });

  it("[activate] 已有窗口时不重复开窗，全关掉后才开新窗", async () => {
    const { fake } = await loadEntry();
    expect(fake.createdWindows).toHaveLength(1);

    fake.fireAppEvent("activate");
    expect(fake.createdWindows).toHaveLength(1);

    fake.createdWindows[0]!.close();
    fake.fireAppEvent("activate");
    expect(fake.createdWindows).toHaveLength(2);
  });
});

describe("electron 入口 · .env 装载", () => {
  it("只补缺失的变量，已被宿主设好的值不被文件覆盖", async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, ".env"),
      ["# 注释行", "OX_MAIN_TEST_FILLED=from-file", "OX_MAIN_TEST_KEPT=from-file", ""].join("\n"),
      "utf8",
    );
    setEnv("OX_MAIN_TEST_KEPT", "from-host");

    await loadEntry((f) => f.app.getAppPath.mockReturnValue(dir));

    expect(process.env.OX_MAIN_TEST_FILLED).toBe("from-file");
    // 宿主传入的环境优先：`.env` 是"补充默认值"，不是"覆盖"。
    expect(process.env.OX_MAIN_TEST_KEPT).toBe("from-host");
  });

  it("没有 .env 文件时静默跳过，不抛错", async () => {
    const dir = tempDir();
    await expect(loadEntry((f) => f.app.getAppPath.mockReturnValue(dir))).resolves.toBeDefined();
  });

  it("[打包态] appPath 在 asar 内拿不到 .env 时，改从 userData 读取", async () => {
    // 打包后 `app.getAppPath()` 指向 `resources/app.asar` —— 归档内部，
    // 用户放不进文件。原来只查这一个位置，**安装版用户根本无法配置密钥**，
    // 而开发态（源码树里 .env 就在项目根）一切正常。
    const appPath = tempDir(); // 故意不放 .env
    const userData = tempDir();
    fs.writeFileSync(path.join(userData, ".env"), "OX_MAIN_TEST_USERDATA=from-userdata\n", "utf8");

    await loadEntry((f) => {
      f.app.getAppPath.mockReturnValue(appPath);
      f.app.getPath.mockImplementation((name: string) => (name === "userData" ? userData : appPath));
    });

    expect(process.env.OX_MAIN_TEST_USERDATA).toBe("from-userdata");
  });

  it("[portable 态] userData 也没有时，从 exe 所在目录读取", async () => {
    const appPath = tempDir();
    const userData = tempDir();
    const portable = tempDir(); // 解压即用的目录，.env 跟包走
    fs.writeFileSync(path.join(portable, ".env"), "OX_MAIN_TEST_PORTABLE=from-exe-dir\n", "utf8");
    const exe = path.join(portable, "OxCommander.exe");

    await loadEntry((f) => {
      f.app.getAppPath.mockReturnValue(appPath);
      f.app.getPath.mockImplementation((name: string) => {
        if (name === "userData") return userData;
        if (name === "exe") return exe;
        return appPath;
      });
    });

    expect(process.env.OX_MAIN_TEST_PORTABLE).toBe("from-exe-dir");
  });

  it("只采用第一个存在的 .env，后面的不再读（结果不依赖合并顺序）", async () => {
    const first = tempDir();
    const second = tempDir();
    fs.writeFileSync(path.join(first, ".env"), "OX_MAIN_TEST_FIRST=yes\n", "utf8");
    fs.writeFileSync(path.join(second, ".env"), "OX_MAIN_TEST_SECOND=yes\n", "utf8");

    await loadEntry((f) => {
      f.app.getAppPath.mockReturnValue(first);
      f.app.getPath.mockImplementation((name: string) => (name === "userData" ? second : first));
    });

    expect(process.env.OX_MAIN_TEST_FIRST).toBe("yes");
    expect(process.env.OX_MAIN_TEST_SECOND).toBeUndefined();
  });

  it("OX_DEV_SERVER 时加载 dev server，而不是打包产物", async () => {
    setEnv("OX_DEV_SERVER", "1");
    const { fake } = await loadEntry();

    expect(fake.createdWindows[0]!.loaded).toBe("http://localhost:5173");
    expect(fake.createdWindows[0]!.loaded).not.toBe(
      path.join(__dirname, "..", "electron", "..", "..", "dist", "index.html"),
    );
  });
});
