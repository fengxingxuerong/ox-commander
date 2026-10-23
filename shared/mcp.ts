/**
 * MCP（Model Context Protocol）客户端侧的**纯契约**（M7）。
 *
 * 三个方向必须分清，否则这一层会写成四不像：
 * 1. `headless/mcp.ts` 是**我们是 server**（对外暴露看板能力）；
 * 2. 本模块是**我们是 client**（把第三方 server 的工具并进会话循环）；
 * 3. `agents.d` 是执行器清单（谁来做任务），`mcp.d` 是工具清单（会话能用什么）。
 *
 * 本文件只做纯逻辑：清单归一化、工具名空间、JSON Schema 子集校验、工具结果
 * 展平。起进程与 JSON-RPC 都宿主层的事（`electron/mcp/`）—— 与 `tools/spec.ts`
 * 只放契约、执行在 `tool-runner.ts` 是同一条分层纪律。
 *
 * 工具名空间 `mcp__<server>__<tool>` 是**唯一**的寻址方式：模型只看得见这一个
 * 名字，平台据此拆出 server 与 tool，永远不接受模型直接指定命令行。server 名
 * 禁止包含 `__`，所以"第一个 `__` 之后全是 tool 名"是无歧义的。
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const MCP_TOOL_PREFIX = "mcp__";

/** 单会话最多接多少个 server（每个 server 都是一个外部进程）。 */
export const MAX_MCP_SERVERS = 8;
/** 单 server 最多收多少个工具（防一个 server 用几千个工具撑爆提示）。 */
export const MAX_MCP_TOOLS_PER_SERVER = 50;
/** 单会话工具目录上限：超出的工具不声明，并在系统条目里说破。 */
export const MAX_MCP_TOOLS_PER_SESSION = 40;

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
export const MAX_MCP_CALL_TIMEOUT_MS = 300_000;
export const MIN_MCP_CALL_TIMEOUT_MS = 1_000;

/** server 名同时用作文件名与工具名前缀；`__` 是保留分隔符。 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** MCP 工具名由 server 决定；这里只挡住空名与明显不能进提示的字符。 */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/**
 * 一份 `mcp.d/<server>.json` 的归一化结果。
 *
 * `env` 的值**不写入任何日志或界面**：它可能含第三方服务的 token。界面只看
 * 名字（见 `mcpEnvNames`），这是"清单可以含密钥，但密钥不出本机"的分界。
 */
export interface McpServerManifest {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export interface McpManifestIssue {
  file: string;
  message: string;
}

/** 给界面看的 server 摘要：env 只有名字（值可能含 token，永不出主机）。 */
export interface McpServerSummary {
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  timeoutMs: number;
}

export interface McpListResult {
  dir: string;
  servers: McpServerSummary[];
  issues: McpManifestIssue[];
  /** 目录本身读不动时才有（"扫不到"不是致命错误，但必须说破）。 */
  problem?: string;
}

export interface McpManifestParse {
  manifest?: McpServerManifest;
  issues: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 归一化一份清单。
 *
 * `fallbackName` 来自文件名：允许清单只写 `{"command": ...}`，名字取
 * `mcp.d/filesystem.json` 的 `filesystem` —— 与 `agents.d` 要求显式 id 不同，
 * 这里文件名本身就是寻址的一部分，两处都要求会多一步无意义的重复。
 */
export function parseMcpManifest(raw: unknown, fallbackName?: string): McpManifestParse {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return { issues: ["清单必须是一个 JSON 对象"] };
  }
  // 先判"字段在不在"再取值：写成 `a === undefined || a === null` 后，后半段
  // 永远被 `nonEmptyString` 覆盖，等价的变异位点会永远存活（site 审计实测）。
  const hasName = raw.name !== undefined && raw.name !== null;
  const explicit = hasName ? nonEmptyString(raw.name) : undefined;
  if (hasName && explicit === undefined) {
    issues.push("name 必须是非空字符串");
  }
  const name = explicit ?? fallbackName?.trim() ?? "";
  if (name === "") issues.push("缺少 name（也可以让文件名承担它：mcp.d/<server>.json）");
  else if (!SERVER_NAME_RE.test(name) || name.includes("__")) {
    issues.push(`name 只能由字母、数字、点、下划线、连字符组成（64 字符以内，且不能含 \`__\`）：${name}`);
  }

  const command = nonEmptyString(raw.command);
  if (command === undefined) issues.push("command 必须是非空字符串");

  let args: string[] = [];
  if (raw.args !== undefined && raw.args !== null) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
      issues.push("args 必须是字符串数组");
    } else {
      args = [...(raw.args as string[])];
    }
  }

  const env: Record<string, string> = {};
  if (raw.env !== undefined && raw.env !== null) {
    if (!isPlainObject(raw.env)) {
      issues.push("env 必须是对象（变量名 → 字符串）");
    } else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (key.trim() === "" || key.includes("=") || key.includes("\0")) {
          issues.push(`env 变量名不合法：${key}`);
          continue;
        }
        if (typeof value !== "string") {
          issues.push(`env.${key} 必须是字符串`);
          continue;
        }
        if (value.length > 8_192) {
          issues.push(`env.${key} 超过 8192 字符上限`);
          continue;
        }
        env[key] = value;
      }
    }
  }

  let timeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    const n = raw.timeoutMs;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < MIN_MCP_CALL_TIMEOUT_MS ||
      n > MAX_MCP_CALL_TIMEOUT_MS
    ) {
      issues.push(`timeoutMs 必须是 ${MIN_MCP_CALL_TIMEOUT_MS}–${MAX_MCP_CALL_TIMEOUT_MS} 之间的整数`);
    } else {
      timeoutMs = n;
    }
  }

  if (issues.length > 0) return { issues };
  return {
    manifest: { name, command: command!, args, env, timeoutMs },
    issues,
  };
}

/** 只把 env 的**名字**给界面；值可能含 token，一律不外泄。 */
export function mcpEnvNames(manifest: McpServerManifest): string[] {
  return Object.keys(manifest.env).sort();
}

export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

/**
 * 拆工具名。形状不对返回 null —— 调用方据此把它当"未登记工具"处理，而不是
 * 猜一个 server 去调。server 名不允许 `__`，所以按第一个分隔符切是安全的。
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0) return null;
  const server = rest.slice(0, at);
  const tool = rest.slice(at + 2);
  if (!SERVER_NAME_RE.test(server) || !TOOL_NAME_RE.test(tool)) return null;
  return { server, tool };
}

/** `tools/list` 里一个工具声明的最小形状（宽松解析：第三方 server 可能带扩展字段）。 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function normalizeMcpToolDef(raw: unknown): { def?: McpToolDef; issue?: string } {
  if (!isPlainObject(raw)) return { issue: "工具声明不是对象" };
  const name = nonEmptyString(raw.name);
  if (name === undefined) return { issue: "工具声明缺少 name" };
  if (!TOOL_NAME_RE.test(name)) return { issue: `工具名不合法（只收字母数字点下划线连字符，96 字符内）：${name}` };
  const description = typeof raw.description === "string" && raw.description.trim() !== ""
    ? raw.description.trim()
    : `MCP 工具 ${name}（server 未提供说明）`;
  const inputSchema = isPlainObject(raw.inputSchema) ? { ...raw.inputSchema } : { type: "object", properties: {} };
  return { def: { name, description, inputSchema } };
}

export interface McpDynamicSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toMcpToolSpec(server: string, def: McpToolDef): McpDynamicSpec {
  return {
    name: mcpToolName(server, def.name),
    description: `[MCP ${server}] ${def.description}`,
    parameters: def.inputSchema,
  };
}

/**
 * MCP 工具参数的**宽松**校验。
 *
 * 与内置工具的 `validateArgsAgainstSpec` 刻意不同：内置工具表是闭合的，未知
 * 参数直接拒；MCP 的 schema 由第三方提供，可能是 draft-07 的任意子集。这里只
 * 校验三件平台必须弄对的事 —— 参数是对象、必填项在、已声明类型的原始类型对 ——
 * 其余交给 server 自己判。把未知参数一律拒掉会在合法 schema 上造成假失败。
 */
export function validateMcpArgs(toolName: string, schema: unknown, args: unknown): string | null {
  if (!isPlainObject(args)) return `工具 ${toolName} 的参数必须是一个对象`;
  if (!isPlainObject(schema)) return null;
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return `工具 ${toolName} 缺少必填参数：${key}`;
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const additional = schema.additionalProperties;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const prop = properties[key];
    if (prop === undefined) {
      if (additional === false) return `工具 ${toolName} 不接受参数：${key}`;
      continue;
    }
    if (!isPlainObject(prop)) continue;
    const declared = prop.type;
    const types = Array.isArray(declared)
      ? declared.filter((t): t is string => typeof t === "string")
      : typeof declared === "string"
        ? [declared]
        : [];
    if (types.length === 0) continue;
    if (!types.some((t) => matchesJsonType(t, value))) {
      return `工具 ${toolName} 的 ${key} 类型不对（声明为 ${types.join(" | ")}）`;
    }
  }
  return null;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    // 未知类型词不制造假失败：schema 里可能有平台不认识的扩展。
    default:
      return true;
  }
}

export interface McpCallText {
  text: string;
  isError: boolean;
}

/**
 * 把 `tools/call` 的 `result` 展平成一段文本。
 *
 * 只保留人/模型读得懂的部分：text 原样拼；resource 取 text（没有就给 uri）；
 * image/audio 不给 base64（几百 KB 的 payload 塞进上下文只会把窗口吃光），
 * 只报类型与长度。`structuredContent` 只在没有 content 时兜底。
 */
export function mcpCallText(result: unknown): McpCallText {
  if (!isPlainObject(result)) {
    return { text: "MCP server 返回的 result 不是对象", isError: true };
  }
  const isError = result.isError === true;
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!isPlainObject(item)) {
      parts.push("[无法识别的 content 项]");
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "text") {
      parts.push(typeof item.text === "string" ? item.text : "");
      continue;
    }
    if (type === "resource") {
      const resource = isPlainObject(item.resource) ? item.resource : {};
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.uri === "string") parts.push(`[resource ${resource.uri}]`);
      else parts.push("[resource 没有 text/uri]");
      continue;
    }
    if (type === "image" || type === "audio") {
      const mime = typeof item.mimeType === "string" ? item.mimeType : "unknown";
      const data = typeof item.data === "string" ? item.data.length : 0;
      parts.push(`[${type} ${mime}，base64 ${data} 字符，未注入上下文]`);
      continue;
    }
    parts.push(`[content ${type}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      parts.push(String(result.structuredContent));
    }
  }
  const text = parts.filter((p) => p !== "").join("\n").trim();
  return { text: text === "" ? "（MCP 工具没有返回内容）" : text, isError };
}

/**
 * 发现阶段的问题统一成一句给人看的话。
 *
 * 三种情况必须分开：进程起不来、握手超时、工具表形状不对 —— 合成一句
 * "连接失败"会让操作者不知道该改命令还是改超时。
 */
export function mcpConnectIssue(server: string, error: unknown): string {
  return `MCP server ${server} 不可用：${error instanceof Error ? error.message : String(error)}`;
}
