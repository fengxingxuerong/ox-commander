import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  deriveDeliveryGuide,
  type DeliveryFileRead,
} from "../../shared/delivery-guide";
import { setDevServerKeeper } from "../engine/verifier";
import { getPreview, keepDevServer, stopPreview } from "../preview-manager";
import { closePreviewWindow, openPreviewWindow, resetPreviewStorage } from "../preview-window";
import { ensureAudit, workspaceRoot } from "./context";

/** 只读预览的上限：超过这个体积只给前 512KiB，并明确标 `truncated`。 */
const MAX_DELIVERY_READ_BYTES = 512 * 1024;

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function reject(reason: string): DeliveryFileRead {
  return { ok: false, reason };
}

/**
 * 工作区内的只读文件读取。
 *
 * 两道路径判定是承重的：先按字面路径确认在 root 内，再对 realpath 确认一次 ——
 * 只查字面路径会让工作区里的符号链接把读取带到树外。拒绝时返回数据而不是抛，
 * 因为"文件已被本批删除"是正常形态，界面要把它和"读取失败"分开显示。
 */
function readWorkspaceFile(root: string, relPath: string): DeliveryFileRead {
  if (path.isAbsolute(relPath) || relPath.includes("\0")) {
    return reject("路径必须是工作区内的相对路径");
  }
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, relPath);
  const lexical = path.relative(rootAbs, targetAbs);
  if (lexical.startsWith("..")) {
    return reject("路径越出工作区（拒绝读取）");
  }
  if (path.isAbsolute(lexical)) {
    return reject("路径越出工作区（拒绝读取）");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetAbs);
  } catch {
    return reject("文件不在工作区（可能已删除或被移动）");
  }
  if (!stat.isFile()) return reject("目标不是普通文件");

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = fs.realpathSync.native(rootAbs);
    realTarget = fs.realpathSync.native(targetAbs);
  } catch {
    return reject("文件不在工作区（可能已删除或被移动）");
  }
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith("..")) {
    return reject("路径经符号链接越出工作区（拒绝读取）");
  }
  if (path.isAbsolute(realRel)) {
    return reject("路径经符号链接越出工作区（拒绝读取）");
  }

  const fd = fs.openSync(realTarget, "r");
  try {
    const size = stat.size;
    const toRead = Math.min(size, MAX_DELIVERY_READ_BYTES);
    const buf = Buffer.alloc(toRead);
    const read = fs.readSync(fd, buf, 0, toRead, 0);
    const head = buf.subarray(0, Math.min(read, 8192));
    if (head.includes(0)) {
      return { ok: true, content: "", bytes: size, truncated: false, binary: true };
    }
    return {
      ok: true,
      content: buf.subarray(0, read).toString("utf8"),
      bytes: size,
      truncated: size > MAX_DELIVERY_READ_BYTES,
      binary: false,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function registerDeliveryHandlers(): void {
  // 桌面端把探活成功的 dev server 接管为预览；headless 不经过这里。
  setDevServerKeeper(keepDevServer);
  app.on("before-quit", () => {
    stopPreview();
    closePreviewWindow();
  });

  /**
   * 本次运行的产物清单 + 验收命令。推导在 shared（双宿主同源），这里只做
   * "审计 + package.json" 的 IO。projectId 可选：缺省时按全部审计事实推导。
   */
  ipcMain.handle("delivery:guide", (_e, projectId?: string) => {
    const wanted = typeof projectId === "string" && projectId !== "" ? projectId : undefined;
    const packageJson =
      wanted === undefined ? undefined : readText(path.join(workspaceRoot(wanted), "package.json"));
    const opts: { projectId?: string; packageJson?: string } = {};
    if (wanted !== undefined) opts.projectId = wanted;
    if (packageJson !== undefined) opts.packageJson = packageJson;
    return deriveDeliveryGuide(ensureAudit().read(), opts);
  });

  ipcMain.handle("delivery:read", (_e, projectId: unknown, relPath: unknown): DeliveryFileRead => {
    if (typeof projectId !== "string" || projectId === "") {
      return reject("projectId 必须是非空字符串");
    }
    if (typeof relPath !== "string" || relPath === "") {
      return reject("path 必须是非空字符串");
    }
    return readWorkspaceFile(workspaceRoot(projectId), relPath);
  });

  /** 当前保活的 dev server；没有时返回 null（字段即承诺，不给空壳对象）。 */
  ipcMain.handle("preview:status", () => getPreview());

  /**
   * 在应用内预览窗口打开当前预览（C3 剩余半：按项目隔离 profile）。
   * **不接收渲染层传的 URL**：只打开管理器里那一条已经过探活的服务；回环判定与
   * 导航守卫都在 `electron/preview-window.ts`（真正加载 URL 的那一层），这里只透传结论。
   * 渲染层必须给 projectId —— 隔离身份缺失时拒绝打开，不退化成共享 profile。
   */
  ipcMain.handle("preview:open", (_e, projectId: unknown) => {
    const preview = getPreview();
    if (!preview) return { ok: false as const, reason: "当前没有可预览的服务" };
    if (!preview.running) return { ok: false as const, reason: "预览服务已退出（可停止后清除）" };
    return openPreviewWindow(projectId, preview.url);
  });

  /** 清掉该项目预览 profile 的 cookie / localStorage（下一次预览需重新登录）。 */
  ipcMain.handle("preview:reset", (_e, projectId: unknown) => resetPreviewStorage(projectId));

  /** 停止预览：dev server 与预览窗口一起收（窗口留着看死页面没有意义）。 */
  ipcMain.handle("preview:stop", () => {
    const stopped = stopPreview();
    closePreviewWindow();
    return stopped;
  });
}
