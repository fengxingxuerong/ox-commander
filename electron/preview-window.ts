import { BrowserWindow, session } from "electron";
import { isLoopbackHttpUrl } from "../shared/page-smoke";
import { previewPartitionOf } from "../shared/preview-isolation";

/**
 * 应用内预览窗口（竞品缺口 C3 的剩余半，2026-10-25）。
 *
 * 它替换掉的是 `shell.openExternal` —— 那条路打开的是**使用者的浏览器**：profile 由
 * 浏览器决定，应用既不能按项目隔离 cookie，也擦不掉自己写进去的东西（登录态会跟着
 * 使用者的日常浏览）。这里改为自己开一个窗口，profile 由 `previewPartitionOf` 派生。
 *
 * **权限面（三条一起才是这一段的安全声明，少一条都不算）**：
 *   · 独立 partition —— 被预览页面的 cookie / localStorage / service worker 落在
 *     自己的 profile 里，与主窗口、与别的项目都不互相看得见；
 *   · **不给 preload 桥** —— 主窗口那份 `window.oxCommander` 是完整 IPC 控制面，
 *     而被预览的是模型产出 + 第三方页面，它一个通道都不该拿到；
 *   · `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。
 * 导航面另两条：`setWindowOpenHandler` 一律 deny（子窗口会继承同一份 webPreferences），
 * `will-navigate` / `will-redirect` 只放行本机回环地址（复用 `isLoopbackHttpUrl`，
 * 与 dev-server 冒烟、schema 校验同一份判据，不另写一份白名单）。
 *
 * **刻意不做**：不在窗口里注入任何脚本、不做截图/DOM 断言（验证链仍然只看 HTTP 与正文，
 * 见 `shared/page-smoke.ts` 顶部的边界声明）；关窗**不清** profile —— 那是显式动作，
 * 见 `resetPreviewStorage`。
 */

/** 单实例：一个预览窗口、跟随预览管理器那一个 dev server。 */
let current: { win: BrowserWindow; partition: string } | null = null;

type PreviewWindowResult = { ok: true } | { ok: false; reason: string };

/**
 * 在本项目的隔离 profile 里打开预览窗口。
 *
 * 同一个项目重复打开 = 聚焦已有窗口（不新建、profile 不变，于是登录态接着用）；
 * 换项目 = 关掉旧窗口再开新的（旧的 dev server 由预览管理器负责，这里只管窗口）。
 */
export function openPreviewWindow(projectId: unknown, url: string): PreviewWindowResult {
  const partition = previewPartitionOf(projectId);
  if (partition === undefined) {
    return { ok: false, reason: "预览需要一个合法的项目 id：它决定这个窗口用哪份浏览器 profile" };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ok: false, reason: `预览地址不是本机 HTTP(S)，拒绝打开：${url}` };
  }

  const existing = current;
  if (existing !== null && existing.partition === partition && !existing.win.isDestroyed()) {
    existing.win.focus();
    return { ok: true };
  }

  closePreviewWindow();
  current = { win: createPreviewWindow(partition, url), partition };
  return { ok: true };
}

/** 关掉预览窗口；没有窗口时返回 false。已销毁的窗口不再 close（那会抛错）。 */
export function closePreviewWindow(): boolean {
  const entry = current;
  if (entry === null) return false;
  current = null;
  if (!entry.win.isDestroyed()) entry.win.close();
  return true;
}

/** 清掉某个项目预览 profile 的 cookie / localStorage / service worker。 */
export async function resetPreviewStorage(projectId: unknown): Promise<PreviewWindowResult> {
  const partition = previewPartitionOf(projectId);
  if (partition === undefined) {
    return { ok: false, reason: "清除预览数据需要一个合法的项目 id" };
  }
  await session.fromPartition(partition).clearStorageData();
  return { ok: true };
}

function createPreviewWindow(partition: string, url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "OxCommander 预览",
    autoHideMenuBar: true,
    webPreferences: {
      // 没有 `preload` 这一项是**刻意的**：见文件头的权限面。
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (!isLoopbackHttpUrl(target)) event.preventDefault();
  });
  win.webContents.on("will-redirect", (event, target) => {
    if (!isLoopbackHttpUrl(target)) event.preventDefault();
  });

  // 加载失败（dev server 刚好退出）由窗口自己显示错误页，这里不抛到主进程。
  win.loadURL(url).catch(() => undefined);
  return win;
}
