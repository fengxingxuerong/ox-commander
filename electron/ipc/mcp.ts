/**
 * MCP 清单的桌面只读面（M7）。
 *
 * 只回答"有哪些 server、什么时候会被启动、哪些清单坏了"——**不在这里起进程**。
 * 页面打开就 spawn 一堆外部程序既慢又超出"看一眼配置"的预期；真正的连接由
 * 会话首次发送时懒做（`McpPool.discover`）。
 *
 * env 只出**名字**，不出值：清单里允许写第三方 token，但界面、日志、会话记录
 * 都不是密钥该出现的地方。
 */
import { app, ipcMain } from "electron";
import path from "node:path";

import { loadMcpManifests } from "../mcp/manifest";
import { mcpEnvNames, type McpListResult } from "../../shared/mcp";
import { logLine } from "./context";

/** `<userData>/mcp.d`：与 `agents.d`/`policy.d` 同一个应用数据域。 */
export function mcpDir(): string {
  return path.join(app.getPath("userData"), "mcp.d");
}

export function readMcpList(dir: string = mcpDir()): McpListResult {
  try {
    const load = loadMcpManifests(dir);
    return {
      dir,
      servers: load.servers.map((m) => ({
        name: m.name,
        command: m.command,
        args: [...m.args],
        envNames: mcpEnvNames(m),
        timeoutMs: m.timeoutMs,
      })),
      issues: load.issues,
    };
  } catch (err) {
    const problem = (err as Error).message;
    logLine(`[mcp] 清单读取失败：${problem}`);
    return { dir, servers: [], issues: [], problem };
  }
}

export function registerMcpHandlers(): void {
  ipcMain.handle("mcp:list", () => readMcpList());
}
