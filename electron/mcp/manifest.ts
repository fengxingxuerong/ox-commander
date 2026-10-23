/**
 * `mcp.d/*.json` 的容错加载（M7）。
 *
 * 与 `agents.d` 同一套心智，差别只在语义：agents.d 声明"谁来做任务"，
 * mcp.d 声明"会话可以用哪些外部工具 server"。两条共同的纪律：
 * 1. 单个文件坏了只跳过它并**说出来**（缺一个 server 不该让整页/整场会话消失）；
 * 2. `*.example.json` 是文档，永远不加载。
 *
 * **信任模型（红线）**：这里加载的是**操作者自己写在 `mcp.d` 里的清单**。
 * manifest 的 `command` 会以宿主身份被 `spawn`（`shell:false`），env 也会原样
 * 交给子进程 —— 它有资格启动任意本地程序。因此目录里**不许放外来的、别人给的
 * 清单**；这与 `execToken` 的红线是同一条。平台能做的是把 env 收窄到
 * `scopedEnv()` 的白名单 + 清单显式给的值，而不是假装能鉴别清单作者。
 */
import fs from "node:fs";
import path from "node:path";

import {
  MAX_MCP_SERVERS,
  parseMcpManifest,
  type McpManifestIssue,
  type McpServerManifest,
} from "../../shared/mcp";

export interface McpManifestLoad {
  servers: McpServerManifest[];
  issues: McpManifestIssue[];
}

/** `*.example.json` 只作模板展示，与 agents.d 同一条。 */
export function isMcpManifestFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".example.json");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 文件名承担 server 名：`mcp.d/filesystem.json` → `filesystem`。 */
export function mcpNameFromFile(name: string): string {
  return name.slice(0, -".json".length);
}

/**
 * 读一个目录。目录不存在不是错误（还没配过 MCP 是常态）；读不动才算错误。
 */
export function loadMcpManifests(dir: string): McpManifestLoad {
  const servers: McpServerManifest[] = [];
  const issues: McpManifestIssue[] = [];
  if (dir.trim() === "" || !fs.existsSync(dir)) return { servers, issues };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    issues.push({ file: dir, message: `目录读取失败：${(err as Error).message}` });
    return { servers, issues };
  }
  const seen = new Set<string>();
  for (const file of entries.filter(isMcpManifestFile).sort()) {
    const abs = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(stripBom(fs.readFileSync(abs, "utf8")));
    } catch (err) {
      issues.push({ file, message: (err as Error).message });
      continue;
    }
    const parsed = parseMcpManifest(raw, mcpNameFromFile(file));
    if (parsed.manifest === undefined) {
      issues.push({ file, message: parsed.issues.join("；") });
      continue;
    }
    if (seen.has(parsed.manifest.name)) {
      issues.push({ file, message: `server 名重复（保留先读到的那份）：${parsed.manifest.name}` });
      continue;
    }
    if (servers.length >= MAX_MCP_SERVERS) {
      issues.push({
        file,
        message: `超过单会话 ${MAX_MCP_SERVERS} 个 server 的上限，已跳过：${parsed.manifest.name}`,
      });
      continue;
    }
    seen.add(parsed.manifest.name);
    servers.push(parsed.manifest);
  }
  return { servers, issues };
}

/**
 * 运行时签名用的目录指纹。改一份清单（命令/参数/超时）必须重建会话 ——
 * 否则界面显示的是新配置、实际跑的仍是旧进程。
 */
export function mcpDirFingerprint(dir: string | undefined): string[] {
  if (dir === undefined || dir.trim() === "") return [];
  // 目录不存在 = 没配 MCP，是稳定状态；不能把"不存在"变成每次都不同的签名，
  // 否则每条消息都会重建会话。
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isMcpManifestFile).sort();
  } catch {
    return [`${dir}:unreadable`];
  }
  const out: string[] = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      out.push(`${abs}:${st.size}:${st.mtimeMs}`);
    } catch {
      out.push(`${abs}:unreadable`);
    }
  }
  return out;
}
