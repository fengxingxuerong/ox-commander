import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerIpc, attachWindow } from "./ipc";
import { closePreviewWindow } from "./preview-window";

// Software rendering is plenty for this board-style UI and keeps the app
// alive on VMs / remote desktops where the GPU process dies on startup.
app.disableHardwareAcceleration();

/**
 * `.env` 的候选位置，按优先级排列。
 *
 * ⚠️ 为什么不能只查 `app.getAppPath()`：它在**打包后**指向 `resources/app.asar`
 * —— 归档内部，用户放不进任何文件。于是安装版用户**根本无法配置密钥**，
 * 而开发态一切正常（源码树里 `.env` 就在项目根），是典型的
 * "源码全绿、打包后坏"。
 *
 * 所以打包场景必须查 asar **之外**的位置：
 *   1. `app.getAppPath()`  开发态（项目根），也是既有用例的路径
 *   2. `userData`          安装版：per-user、可写，桌面端的 settings/keys 也在这
 *   3. exe 所在目录        portable 版：解压即用，配置跟着包走
 */
function envFileCandidates(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(app.getAppPath());
  } catch {
    // 未就绪时取不到就跳过这个候选位置；不是错误
  }
  try {
    dirs.push(app.getPath("userData"));
    const exe = app.getPath("exe");
    if (exe) dirs.push(path.dirname(exe));
  } catch {
    // 同上
  }
  return dirs.map((d) => path.join(d, ".env"));
}

function loadEnvFile(): void {
  for (const envPath of envFileCandidates()) {
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    // 只采用**第一个存在**的文件：多处各放一份时，结果不该取决于合并顺序。
    return;
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "OxCommander",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Hold the reference for `second-instance`; drop it on close, otherwise a
  // later second launch would focus a destroyed window and throw.
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // 预览窗口也一起收：它是主窗口的附属窗口，留下的结果有两个 ——
    // 只看板关了而应用不退（`window-all-closed` 不再触发），以及 macOS 上
    // `activate` 看到还有一个窗口，于是主窗口再也回不来。
    closePreviewWindow();
  });

  attachWindow(win);

  // 两条导航守卫（2026-10-23 加固）。
  //
  // 为什么需要：这个窗口渲染的是**模型输出与第三方内容**（会话正文、预览、审计
  // 文本），webPreferences 只关了 nodeIntegration —— 但 `window.open` 出来的子窗口
  // 会继承同一份 preload 桥，一样能调 `window.ox`；而页面里任何一次跳转都会让应用
  // 离开本地站点。两者都不是这个应用需要的能力。
  //
  // 为什么安全：全仓没有 `window.open` / `<a>` / `location.href=`（2026-10-23 grep
  // 核过），对外打开走的是 `preview:open` IPC → `shell.openExternal`（带白名单、
  // 有用例）。dev 模式下 Vite 的整页重载会触发 will-navigate，所以放行应用自身地址。
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, targetUrl) => {
    const allowed = process.env.OX_DEV_SERVER
      ? targetUrl.startsWith("http://localhost:5173")
      : targetUrl.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (process.env.OX_DEV_SERVER) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return win;
}

/**
 * Single-instance lock.
 *
 * Why: two instances driving the same project root each build their own
 * snapshots and each roll back on a zone violation, so the audit ends up with
 * two contradictory run records for one workspace. The stores make it worse —
 * `store.ts` / `keys-store.ts` rewrite the whole file per save, and
 * `atomic-file` only guarantees a single write is not torn, not that concurrent
 * writers cannot lose each other's update. The second launch therefore hands
 * focus to the existing window instead of opening a second commander.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    loadEnvFile();
    registerIpc();
    createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
