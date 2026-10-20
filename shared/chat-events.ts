/**
 * 交互式会话（对标 Codex 的 TUI 那一层）的**事件与转录契约**。
 *
 * 为什么要把"转录条目"做成一等结构而不是"把日志流贴上墙"：看板现有的
 * `log` 事件是一条条纯文本（`AgentEventKind` 只有 log/completed/failed/aborted），
 * 它能回答"跑到哪一步"，回答不了"它读了什么、改了哪一处、这条命令是谁批准的"。
 * 而后者正是编码智能体的全部交互面 —— 用户要能逐条展开看，也要能在事后重放。
 *
 * 本模块只放类型与**纯**派生函数（摘要、状态合并），读写磁盘与起进程都在宿主层。
 */
import type { ToolCall, ToolResult } from "./tools/spec";
import type { SandboxMode, ApprovalPolicy } from "./tools/policy";
import type { ChatMessage } from "./providers";

export type ChatEntryKind = "user" | "assistant" | "tool_call" | "tool_result" | "approval" | "error" | "system";

export interface ChatEntry {
  id: string;
  ts: number;
  kind: ChatEntryKind;
  /** 人读的那一行（工具调用与结果也各有一行摘要，详情在下面两个字段里）。 */
  text: string;
  tool?: ToolCall;
  result?: ToolResult;
  /** 审批条目：问了什么、人怎么答的。 */
  approval?: {
    requestId: string;
    granted: boolean | null;
    scope?: "once" | "session";
    reason?: string;
  };
}

export type ChatStatus = "idle" | "running" | "awaiting-approval" | "done" | "aborted" | "error";

export interface ChatSessionMeta {
  sessionId: string;
  /** 会话绑定的项目根（工具的路径判定以它为界）。 */
  rootAbs: string;
  startedAt: number;
  updatedAt: number;
  turns: number;
  status: ChatStatus;
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  usageTokens: number;
}

export interface ChatTranscript {
  meta: ChatSessionMeta;
  entries: ChatEntry[];
}

/**
 * 恢复一段会话所需的最小状态。
 *
 * `entries` 是给人看的转录，`messages` 是给模型看的原始消息序列。两者不能
 * 互相推导：文本协议把多个工具结果合成一条 user 消息，原生协议则要求
 * assistant 的 `toolCalls` 与 `tool` 消息按 id 对齐 —— 只存 entries 再“重建”
 * 会在恢复后改变协议形状（表现是端点 400 或模型以为工具没执行过）。
 */
export interface ChatHistory {
  sessionId?: string;
  entries: ChatEntry[];
  messages: ChatMessage[];
  meta?: Partial<Pick<ChatSessionMeta, "startedAt" | "updatedAt" | "turns" | "usageTokens">>;
}

/** 落盘用的完整快照（meta 里的 status 在恢复时会被重置为 idle）。 */
export interface ChatSessionSnapshot extends ChatTranscript {
  messages: ChatMessage[];
  toolProtocol: "native" | "text";
}

/** 撤销一轮/一个文件后的结果（部分撤销必须逐条说清为什么没撤）。 */
export interface ChatRevertResult {
  reverted: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/** 会话列表项（桌面侧栏与 IPC 共用；不含消息正文）。 */
export interface ChatSessionSummary {
  sessionId: string;
  projectId: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  status: string;
  turns: number;
  usageTokens: number;
}

/**
 * 当会话从一种工具协议恢复到另一种时，旧消息里的原生 `toolCalls` / `tool`
 * 消息对文本协议端点没有意义；把它们降级成普通正文，避免恢复后的第一个
 * 请求就因为“assistant 发了未声明的 tool_calls”被 400 掉。
 */
export function messagesForProtocol(
  messages: readonly ChatMessage[],
  protocol: "native" | "text",
): ChatMessage[] {
  if (protocol === "native") return messages.map((m) => ({ ...m }));
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "user", content: `工具结果：\n${m.content}` });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (m.content.trim() !== "") out.push({ role: "assistant", content: m.content });
      continue;
    }
    out.push({ ...m });
  }
  return out;
}

export interface ChatApprovalRequest {
  requestId: string;
  tool: "apply_patch" | "run_command";
  reason: string;
  /** `run_command` 才有。 */
  command?: string;
  args?: readonly string[];
  /** `apply_patch` 才有：补丁里要动的文件路径，用来让人看清动了谁。 */
  paths?: readonly string[];
}

/** 人的答复。`scope: "session"` = 这类动作本次会话不再问（对齐 Codex 的三选一）。 */
export interface ChatApprovalAnswer {
  granted: boolean;
  scope?: "once" | "session";
  /** 拒绝时说明理由 —— 理由会回灌给模型，否则它只会原样重试同一个动作。 */
  reason?: string;
}

export type ChatEvent =
  | { type: "chat:entry"; sessionId: string; entry: ChatEntry }
  /**
   * 正在流入的正文增量（P1-1）。
   *
   * 它是「正在打字」层，**不是转录**：消费方拼出预览，收到下一条 entry / done /
   * error 就清空。落盘与恢复都不带它 —— 所以崩溃后重开会话看不到半句话，那是
   * 对的：半句话不是事实。
   */
  | { type: "chat:delta"; sessionId: string; text: string }
  | { type: "chat:status"; sessionId: string; status: ChatStatus; turns: number }
  | { type: "chat:approval-request"; sessionId: string; request: ChatApprovalRequest }
  | { type: "chat:done"; sessionId: string; turns: number; usageTokens: number }
  | { type: "chat:error"; sessionId: string; message: string };

/** 一次会话里展示用的一行摘要（状态栏 / 历史列表）。 */
export function summarizeTranscript(t: ChatTranscript): {
  turns: number;
  toolCalls: number;
  changedPaths: string[];
  lastText: string;
} {
  let toolCalls = 0;
  const paths = new Set<string>();
  let lastText = "";
  for (const e of t.entries) {
    if (e.kind === "tool_call") {
      toolCalls += 1;
      const p = e.tool?.args?.path;
      if (typeof p === "string") paths.add(p);
    }
    if (e.kind === "assistant" && e.text.trim() !== "") lastText = e.text.trim();
  }
  return { turns: t.meta.turns, toolCalls, changedPaths: [...paths].sort(), lastText: lastText.slice(0, 200) };
}

/** 工具调用的一行摘要：名字 + 最关键的那个参数（人扫一眼就知道它在干嘛）。 */
export function describeToolCall(call: ToolCall): string {
  const args = call.args;
  switch (call.name) {
    case "read_file":
      return `读取 ${String(args.path ?? "")}`;
    case "list_dir":
      return `列目录 ${String(args.path ?? ".")}`;
    case "grep_files":
      return `检索 ${String(args.pattern ?? "")}`;
    case "find_by_name":
      return `按名查找 ${String(args.glob ?? "")}`;
    case "apply_patch":
      return `应用补丁`;
    case "run_command":
      return `执行 ${String(args.command ?? "")} ${Array.isArray(args.args) ? args.args.join(" ") : ""}`.trim();
    default:
      return call.name;
  }
}

/** 工具结果的一行摘要：成功给字节数/行数，失败给理由。 */
export function describeToolResult(result: ToolResult): string {
  if (!result.ok) return `失败：${result.reason ?? "未知原因"}`;
  const first = result.output.split("\n")[0] ?? "";
  const more = result.output.includes("\n") ? " …" : "";
  return `${first.slice(0, 120)}${more}`;
}
