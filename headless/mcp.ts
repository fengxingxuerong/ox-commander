/**
 * 反向 MCP server（竞品清单 5.5，学 Vibe Kanban 的双向集成）。
 *
 * serve 形态补上了"离开工位也能看"，但它的消费者是人（浏览器）或 CI（POST /run）。
 * 这一格补的是**agent 生态的接入点**：把 serve 的 HTTP 面包装成 MCP（Model Context
 * Protocol）stdio server，Loomy 这类外部 agent 就能编程驱动本平台 —— 查状态、
 * 取交付凭据、投递 spec、暂停/继续。
 *
 * 协议刻意手写（JSON-RPC 2.0 over stdio，约百余行）而引入官方 SDK：本项目
 * HTTP 桥接"零依赖、易测试"的先例在此同样成立 —— MCP 的 stdio 传输就是一个
 * 按行分割的 JSON-RPC 对话，SDK 背后没有魔法。
 *
 * 纯逻辑（握手 / 工具表 / 分发 / 工具实现）与 IO（stdio 循环、真 HTTP）分开：
 * 本模块的 HTTP 面是**注入的**（`ServeHttp`），测试喂假件，逐位点审得到住。
 * 工具结果是给人（agent）读的文本，如实转述 serve 的响应 —— 409 就说忙，
 * 不可达就说不可达，不把失败包装成成功。
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** serve 实例的 HTTP 面（真入口用 fetch 实现，测试注入假件）。允许 reject ——
 *  调用方（工具实现）负责把网络错误转成工具失败，而不是让异常逃出分发器。 */
export interface ServeHttp {
  get(path: string): Promise<{ status: number; body: string }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: string }>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const STATE_NOTE = "状态详情：GET {serve-url}/state；事件流：GET {serve-url}/events（SSE）。";

/** serve 状态的 JSON 形状只取本模块用得到的字段（宽松解析，字段缺席不算错）。 */
interface ServeStateShape {
  status?: string;
  paused?: boolean;
  exitCode?: number;
  updatedAt?: string;
  receipt?: unknown;
  events?: Array<Record<string, unknown>>;
}

/** 工具描述表：`tools/list` 与测试共用同一份事实。 */
export function mcpToolDefs(): McpToolDef[] {
  return [
    {
      name: "ox_status",
      description:
        "查询 OxCommander serve 实例当前状态：idle/running/delivered/failed、是否暂停、退出码、事件数。投递前先看一眼，别在 busy 时撞 409。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "ox_receipt",
      description:
        "取最近一次运行的交付凭据（delivery receipt）：门禁逐段结果、逐任务账、越权处置、token 用量。还没有凭据时如实说明。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "ox_events",
      description: "取最近 N 条运行事件（默认 30，上限 500）：log/receipt/done/error 等。",
      inputSchema: {
        type: "object",
        properties: { tail: { type: "number", description: "最近多少条（1-500，默认 30）" } },
        additionalProperties: false,
      },
    },
    {
      name: "ox_run",
      description:
        "投递一份 run spec（与 headless JSONL 的 spec 同形状：{requirement, projectRoot, ...}）。一次只跑一个 run，busy 时返回 409 —— 先 ox_status 确认空闲。受理后用 ox_status/ox_events 轮询。",
      inputSchema: {
        type: "object",
        properties: { spec: { type: "object", description: "完整 spec 对象" } },
        required: ["spec"],
        additionalProperties: false,
      },
    },
    {
      name: "ox_control",
      description: "暂停或恢复当前 run（pause：当前任务跑完就停，不再派新的；resume：继续派发）。没有 run 在跑时会 409。",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["pause", "resume"] } },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ];
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textContent(text: string, isError = false): Record<string, unknown> {
  const content = [{ type: "text", text }];
  return isError ? { content, isError: true } : { content };
}

/** 从 JSON-RPC 消息里取出合法请求（对象 + 字符串 method）；通知与坏形状在此分流。 */
function asRequest(msg: unknown): { id: unknown; method: string; params: Record<string, unknown> } | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const m = msg as Record<string, unknown>;
  if (typeof m.method !== "string") return undefined;
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;
  return { id: m.id, method: m.method, params };
}

/** 工具入参安全取字段：工具描述说是什么类型，调用方未必照办 —— 宽进严出。 */
function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseState(raw: string): ServeStateShape | undefined {
  try {
    const s = JSON.parse(raw);
    // 数组也算 object，但 /state 的形状必须是对象 —— 数组响应同样是"无法解析"。
    return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as ServeStateShape) : undefined;
  } catch {
    return undefined;
  }
}

/** 事件的人类可读一行：log 取 text，receipt 取 headline，其余 JSON 截断。 */
function eventLine(e: Record<string, unknown>): string {
  if (e.type === "log" && typeof e.text === "string") return `log ${e.text}`;
  if (e.type === "receipt" && typeof e.receipt === "object" && e.receipt !== null) {
    const headline = (e.receipt as Record<string, unknown>).headline;
    return `receipt ${typeof headline === "string" ? headline : JSON.stringify(e.receipt).slice(0, 200)}`;
  }
  return `${String(e.type ?? "?")} ${JSON.stringify(e).slice(0, 200)}`;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  http: ServeHttp,
): Promise<Record<string, unknown>> {
  if (name === "ox_status") {
    const res = await http.get("/state");
    const s = parseState(res.body);
    if (!s) return textContent(`serve 响应无法解析（HTTP ${res.status}）`, true);
    const parts = [`状态 ${s.status ?? "unknown"}`];
    if (s.paused === true) parts.push("已暂停");
    if (s.exitCode !== undefined) parts.push(`退出码 ${s.exitCode}`);
    parts.push(`事件 ${s.events?.length ?? 0} 条`);
    if (s.updatedAt) parts.push(`更新于 ${s.updatedAt}`);
    return textContent(`${parts.join(" · ")}。${STATE_NOTE}`);
  }
  if (name === "ox_receipt") {
    const res = await http.get("/state");
    const s = parseState(res.body);
    if (!s) return textContent(`serve 响应无法解析（HTTP ${res.status}）`, true);
    if (s.receipt === undefined || s.receipt === null) {
      return textContent("还没有交付凭据（只在交付成功 / 重修耗尽两条出口上产生）。");
    }
    return textContent(JSON.stringify(s.receipt, null, 2));
  }
  if (name === "ox_events") {
    const tail = Math.min(Math.max(Math.floor(argNum(args, "tail") ?? 30), 1), 500);
    const res = await http.get("/state");
    const s = parseState(res.body);
    if (!s) return textContent(`serve 响应无法解析（HTTP ${res.status}）`, true);
    const all = s.events ?? [];
    if (all.length === 0) return textContent("还没有任何事件。");
    const lines = all.slice(-tail).map(eventLine);
    const head = all.length > tail ? `（共 ${all.length} 条，显示最近 ${tail} 条）\n` : "";
    return textContent(head + lines.join("\n"));
  }
  if (name === "ox_run") {
    const spec = args.spec;
    if (typeof spec !== "object" || spec === null) {
      return textContent("spec 必须是对象（{requirement, projectRoot, ...}）", true);
    }
    const res = await http.post("/run", spec);
    if (res.status === 202) return textContent(`已受理，开始运行。${STATE_NOTE}`);
    if (res.status === 409) return textContent(`serve 忙（409）：${res.body}（先 ox_status 确认）`, true);
    return textContent(`serve 拒绝（HTTP ${res.status}）：${res.body.slice(0, 300)}`, true);
  }
  if (name === "ox_control") {
    const action = argStr(args, "action");
    if (action !== "pause" && action !== "resume") {
      return textContent('action 必须是 "pause" 或 "resume"', true);
    }
    const res = await http.post(`/${action}`);
    if (res.status === 200) {
      return textContent(action === "pause" ? "已暂停：当前任务跑完就停，不再派新的（ox_control resume 继续）。" : "已恢复派发。");
    }
    if (res.status === 409) return textContent(`无法${action === "pause" ? "暂停" : "恢复"}：${res.body}`, true);
    return textContent(`serve 拒绝（HTTP ${res.status}）：${res.body.slice(0, 300)}`, true);
  }
  return textContent(`未知工具：${name}`, true);
}

/**
 * 单条 MCP 消息的处理：返回要写回 stdout 的 JSON-RPC 响应；通知与坏形状返回
 * undefined（不回 —— stdio 协议里对通知回话会让客户端错乱）。
 *
 * 工具内部的失败（serve 忙、不可达、参数错）走 `isError: true` 的工具结果 ——
 * 那是"agent 该看到并处理的失败"，不是协议故障；协议级错误（未知方法、坏
 * 请求）才走 JSON-RPC error。
 */
export async function handleMcpMessage(msg: unknown, http: ServeHttp): Promise<Record<string, unknown> | undefined> {
  const req = asRequest(msg);
  if (!req) return undefined;

  if (req.method === "initialize") {
    return rpcResult(req.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "ox-commander", version: "0.1.7" },
    });
  }
  // 客户端的 initialized 通知没有 id，在 asRequest 之后根本到不了这里带 id 的
  // 分支 —— 但有些客户端会把它发成带 id 的请求，也要回 200 空 result 兜住。
  if (req.method === "notifications/initialized") return rpcResult(req.id, {});
  if (req.method === "ping") return rpcResult(req.id, {});
  if (req.method === "tools/list") return rpcResult(req.id, { tools: mcpToolDefs() });
  if (req.method === "tools/call") {
    const name = argStr(req.params, "name") ?? "";
    const args = (typeof req.params.arguments === "object" && req.params.arguments !== null
      ? req.params.arguments
      : {}) as Record<string, unknown>;
    try {
      return rpcResult(req.id, await callTool(name, args, http));
    } catch (e) {
      return rpcResult(req.id, textContent(`serve 不可达：${(e as Error).message}`, true));
    }
  }
  if (req.method.startsWith("notifications/")) return undefined;
  return rpcError(req.id, -32601, `method not found: ${req.method}`);
}
