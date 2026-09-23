import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerIpc, attachWindow } from "./ipc";

// Software rendering is plenty for this board-style UI and keeps the app
// alive on VMs / remote desktops where the GPU process dies on startup.
app.disableHardwareAcceleration();

function loadEnvFile(): void {
  const envPath = path.join(app.getAppPath(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
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
  });

  attachWindow(win);

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
