/**
 * 一次会话的 MCP 连接池（M7）。
 *
 * 每个 server 一个 `McpClient`（= 一个外部进程），**懒连接**：只有会话真的
 * 开始发现工具时才起进程。发现失败不阻断会话 —— 坏掉的 server 变成一条系统
 * 条目，其余工具照常可用，与"读不动的技能只报不抛"同一纪律。
 *
 * 工具目录有上限（单 server 50 / 单会话 40）：一个 server 可以合法地声明几千
 * 个工具，全部塞进提示会把上下文吃光；超出部分不声明，并且**说破**是哪几个
 * 被丢了。静默截断会让模型"看不见某个工具"而人完全不知道。
 */
import {
  MAX_MCP_TOOLS_PER_SERVER,
  MAX_MCP_TOOLS_PER_SESSION,
  mcpConnectIssue,
  mcpToolName,
  toMcpToolSpec,
  type McpCallText,
  type McpServerManifest,
  type McpToolDef,
} from "../../shared/mcp";
import type { DynamicToolSpec } from "../../shared/tools/spec";
import { McpClient, type McpClientOptions } from "./client";

export interface McpClientLike {
  listTools(signal?: AbortSignal): Promise<readonly McpToolDef[]>;
  callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallText>;
  dispose(): void;
}

export type McpClientFactory = (
  manifest: McpServerManifest,
  cwd: string,
  onEvent: ((text: string) => void) | undefined,
) => McpClientLike;

export interface McpDiscovery {
  specs: DynamicToolSpec[];
  issues: string[];
}

export interface McpPoolCallResult {
  ok: boolean;
  output: string;
  reason?: string;
}

export interface McpPoolOptions {
  rootAbs: string;
  manifests: readonly McpServerManifest[];
  onEvent?: (text: string) => void;
  /** 注入点：测试用假 client 时不必起进程。 */
  clientFactory?: McpClientFactory;
  /** 透传给真实 client 的 spawn 注入点（真实进程测试用）。 */
  clientOptions?: Pick<McpClientOptions, "spawn" | "now">;
}

function defaultFactory(
  manifest: McpServerManifest,
  cwd: string,
  onEvent: ((text: string) => void) | undefined,
  extra: McpPoolOptions["clientOptions"],
): McpClientLike {
  return new McpClient({ manifest, cwd, onEvent, ...extra });
}

export class McpPool {
  private readonly rootAbs: string;
  private readonly manifests: readonly McpServerManifest[];
  private readonly onEvent?: (text: string) => void;
  private readonly factory: McpClientFactory;
  private readonly clients = new Map<string, McpClientLike>();
  private discovery: Promise<McpDiscovery> | null = null;
  private specs: DynamicToolSpec[] = [];
  private disposed = false;

  constructor(opts: McpPoolOptions) {
    this.rootAbs = opts.rootAbs;
    this.manifests = opts.manifests;
    this.onEvent = opts.onEvent;
    this.factory =
      opts.clientFactory ?? ((manifest, cwd, onEvent) => defaultFactory(manifest, cwd, onEvent, opts.clientOptions));
  }

  /** server 的启动命令（审批名单按 basename 匹配它）。 */
  commandOf(server: string): string | undefined {
    return this.manifests.find((m) => m.name === server)?.command;
  }

  /**
   * 连接所有 server 并汇总工具。只跑一次；失败结果同样缓存 —— 会话中途反复
   * 重连一个坏 server 会让每一轮都等一次超时。
   */
  async discover(signal?: AbortSignal): Promise<McpDiscovery> {
    if (this.discovery !== null) return this.discovery;
    this.discovery = this.doDiscover(signal);
    return this.discovery;
  }

  private async doDiscover(signal?: AbortSignal): Promise<McpDiscovery> {
    if (this.disposed) return { specs: [], issues: ["MCP 连接池已关闭"] };
    if (this.manifests.length === 0) return { specs: [], issues: [] };
    const issues: string[] = [];
    const perServer = await Promise.all(
      this.manifests.map(async (manifest) => {
        const client = this.factory(manifest, this.rootAbs, this.onEvent);
        this.clients.set(manifest.name, client);
        try {
          const tools = await client.listTools(signal);
          return { manifest, tools };
        } catch (e) {
          return { manifest, tools: [] as McpToolDef[], issue: mcpConnectIssue(manifest.name, e) };
        }
      }),
    );

    const specs: DynamicToolSpec[] = [];
    const remaining: string[] = [];
    for (const result of perServer) {
      if (result.issue !== undefined) {
        issues.push(result.issue);
        continue;
      }
      const declared = result.tools;
      if (declared.length > MAX_MCP_TOOLS_PER_SERVER) {
        issues.push(
          `MCP server ${result.manifest.name} 声明了 ${declared.length} 个工具，超过单 server ${MAX_MCP_TOOLS_PER_SERVER} 个上限，` +
            `后 ${declared.length - MAX_MCP_TOOLS_PER_SERVER} 个未声明：${declared
              .slice(MAX_MCP_TOOLS_PER_SERVER)
              .map((t) => t.name)
              .join("、")}`,
        );
      }
      for (const def of declared.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
        if (specs.length >= MAX_MCP_TOOLS_PER_SESSION) {
          remaining.push(`${result.manifest.name}/${def.name}`);
          continue;
        }
        specs.push(toMcpToolSpec(result.manifest.name, def));
      }
    }
    if (remaining.length > 0) {
      issues.push(
        `MCP 工具目录达到单会话 ${MAX_MCP_TOOLS_PER_SESSION} 个上限，后 ${remaining.length} 个未声明：${remaining.join("、")}`,
      );
    }
    this.specs = specs;
    return { specs: [...specs], issues: [...issues] };
  }

  /**
   * 调一个已声明的工具。未声明的名字直接拒：模型（尤其原生协议端点）可以
   * 返回任意字符串，而 server 内部可能有未对外的危险工具。
   */
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpPoolCallResult> {
    if (this.disposed) return { ok: false, output: "", reason: "MCP 连接池已关闭，调用未执行" };
    const declared = this.specs.some((s) => s.name === mcpToolName(server, tool));
    if (!declared) {
      return { ok: false, output: "", reason: `MCP server ${server} 未声明工具 ${tool}（或发现阶段失败）` };
    }
    const client = this.clients.get(server);
    if (client === undefined) {
      return { ok: false, output: "", reason: `MCP server ${server} 未连接` };
    }
    try {
      const result = await client.callTool(tool, args, signal);
      if (result.isError) {
        return { ok: false, output: "", reason: result.text };
      }
      return { ok: true, output: result.text };
    } catch (e) {
      return { ok: false, output: "", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.specs = [];
  }
}
