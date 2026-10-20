/**
 * `ox chat` —— 交互式编码智能体的 CLI 入口。
 *
 * 三种形态共用同一套 `ChatSession` / `ToolRunner` / 沙箱 / 会话记录：
 *   ox chat                        REPL（末行交互，斜杠命令）
 *   ox chat exec "<prompt>"        单发非交互（JSONL 事件可选）
 *   ox chat resume [sessionId]     继续最近/指定会话
 *
 * 与桌面端的差别只在**审批通道**：CLI 没有 IPC，交互形态用 readline 问人；
 * 非 TTY / `--json` 时没有可问的人，于是按 fail-closed 拒绝需要审批的动作
 * （要跳过审批必须显式 `--approval never`，与 Codex 的安全语义一致）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ChatSession } from "../electron/chat/session";
import { ToolRunner } from "../electron/chat/tool-runner";
import { ChatSessionStore, type ChatSessionEnvelope } from "../electron/chat/session-store";
import { resolveChatRuntime, type ChatRuntime } from "../electron/chat/runtime";
import { buildLlmClient } from "../shared/build-llm";
import { createLlmClient } from "../shared/http-clients";
import { getProvider, type ProviderConfig } from "../shared/providers";
import { redactSecrets } from "../shared/redact";
import { DEFAULT_SETTINGS, type ProjectSettings } from "../shared/types";
import {
  messagesForProtocol,
  type ChatApprovalAnswer,
  type ChatApprovalRequest,
  type ChatEvent,
  type ChatHistory,
} from "../shared/chat-events";
import {
  isApprovalPolicy,
  isSandboxMode,
  type ApprovalPolicy,
  type SandboxMode,
} from "../shared/tools/policy";

interface ChatArgs {
  command: "exec" | "repl" | "resume" | "list";
  prompt: string;
  json: boolean;
  cwd: string;
  provider: string;
  /** 覆盖 provider 的 baseUrl（本地端点/代理/测试）。 */
  baseUrl?: string;
  /** 覆盖 provider 的默认模型。 */
  model?: string;
  sandbox?: SandboxMode;
  approval?: ApprovalPolicy;
  maxTurns?: number;
  sessionId?: string;
  continueLatest: boolean;
}

interface SessionBundle {
  session: ChatSession;
  store: ChatSessionStore;
  projectId: string;
  rootAbs: string;
  runtime: ChatRuntime;
  controller: AbortController;
}

class CliError extends Error {}
class HelpRequested extends Error {}

function usage(): string {
  return [
    "ox chat - interactive coding agent",
    "",
    "  ox chat                         REPL (slash commands: /new /resume /sessions /help /exit)",
    "  ox chat exec \"<prompt>\"           run one prompt and exit",
    "  ox chat resume [sessionId]      continue a session (latest when omitted)",
    "  ox chat list                    list sessions for the current project",
    "",
    "  --json                          emit JSONL ChatEvents (exec/resume)",
    "  --cwd <dir>                     project root (default: current directory)",
    "  --provider <id>                 LLM provider (default: sensenova)",
    "  --base-url <url>                override the provider endpoint (local/proxy/tests)",
    "  --model <name>                  override the provider model",
    "  --sandbox <mode>                read-only | workspace-write | danger-full-access",
    "  --approval <policy>             untrusted | on-request | never",
    "  --max-turns <n>                 tool-loop ceiling for one send",
    "  --session <id>                  resume this session (exec)",
    "  --continue                      resume the latest session",
    "",
    "Non-interactive runs have no approval channel: actions that need approval are denied.",
    "Pass --approval never only when the surrounding environment is already sandboxed.",
  ].join("\n");
}

function takeValue(argv: string[], i: number, name: string): { value: string; next: number } {
  const token = argv[i]!;
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: i + 1 };
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError(`${name} 需要一个值`);
  return { value, next: i + 2 };
}

function parseArgs(argv: string[]): ChatArgs {
  const args: ChatArgs = {
    command: "repl",
    prompt: "",
    json: false,
    cwd: process.cwd(),
    provider: process.env.OX_PROVIDER || "sensenova",
    continueLatest: false,
  };
  const positional: string[] = [];
  let i = 0;
  if (argv[0] === "exec" || argv[0] === "resume" || argv[0] === "list") {
    args.command = argv[0];
    i = 1;
  }
  if (args.command === "resume") args.continueLatest = true;
  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--json") args.json = true;
    else if (token === "--continue") args.continueLatest = true;
    else if (token === "--help" || token === "-h") throw new HelpRequested(usage());
    else if (token === "--cwd" || token.startsWith("--cwd=")) {
      const r = takeValue(argv, i, "--cwd");
      args.cwd = r.value;
      i = r.next - 1;
    } else if (token === "--provider" || token.startsWith("--provider=")) {
      const r = takeValue(argv, i, "--provider");
      args.provider = r.value;
      i = r.next - 1;
    } else if (token === "--base-url" || token.startsWith("--base-url=")) {
      const r = takeValue(argv, i, "--base-url");
      args.baseUrl = r.value;
      i = r.next - 1;
    } else if (token === "--model" || token.startsWith("--model=")) {
      const r = takeValue(argv, i, "--model");
      args.model = r.value;
      i = r.next - 1;
    } else if (token === "--sandbox" || token.startsWith("--sandbox=")) {
      const r = takeValue(argv, i, "--sandbox");
      if (!isSandboxMode(r.value)) throw new CliError(`未知沙箱档位：${r.value}`);
      args.sandbox = r.value;
      i = r.next - 1;
    } else if (token === "--approval" || token.startsWith("--approval=")) {
      const r = takeValue(argv, i, "--approval");
      if (!isApprovalPolicy(r.value)) throw new CliError(`未知审批策略：${r.value}`);
      args.approval = r.value;
      i = r.next - 1;
    } else if (token === "--max-turns" || token.startsWith("--max-turns=")) {
      const r = takeValue(argv, i, "--max-turns");
      const n = Number.parseInt(r.value, 10);
      if (!Number.isInteger(n) || n <= 0) throw new CliError(`--max-turns 必须是正整数：${r.value}`);
      args.maxTurns = n;
      i = r.next - 1;
    } else if (token === "--session" || token.startsWith("--session=")) {
      const r = takeValue(argv, i, "--session");
      args.sessionId = r.value;
      i = r.next - 1;
    } else if (token.startsWith("--")) {
      throw new CliError(`未知参数：${token}`);
    } else {
      positional.push(token);
    }
  }
  if (args.command === "exec") {
    args.prompt = positional.join(" ").trim();
    if (args.prompt === "") throw new CliError("ox chat exec 需要一段 prompt");
  } else if (positional.length > 0 && args.command === "resume") {
    args.sessionId = positional[0];
  } else if (positional.length > 0 && args.command === "repl") {
    throw new CliError(`多余的参数：${positional.join(" ")}`);
  }
  if (args.json && (args.command === "repl" || args.command === "resume")) {
    throw new CliError("REPL / resume 不能与 --json 同用（单发请用 ox chat exec --json）");
  }
  if (args.sessionId && args.continueLatest && args.command === "exec") {
    throw new CliError("--session 与 --continue 只能给一个");
  }
  return args;
}

function projectIdFor(rootAbs: string): string {
  return `cli-${createHash("sha256").update(rootAbs).digest("hex").slice(0, 16)}`;
}

function protocolFor(providerId: string): "native" | "text" {
  try {
    return getProvider(providerId).tools === "native" ? "native" : "text";
  } catch {
    return "text";
  }
}

function settingsFor(args: ChatArgs): ProjectSettings {
  return {
    ...DEFAULT_SETTINGS,
    llmProvider: args.provider,
    llmPool: [],
    approvalCommands: [],
    ...(args.sandbox ? { sandboxMode: args.sandbox } : {}),
    ...(args.approval ? { approvalPolicy: args.approval } : {}),
  };
}

function oxHome(): string {
  return process.env.OX_HOME || path.join(os.homedir(), ".ox");
}

function writeJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function describeApproval(req: ChatApprovalRequest): string {
  if (req.tool === "run_command") return `${req.command ?? ""} ${(req.args ?? []).join(" ")}`.trim();
  return (req.paths ?? []).join("\n");
}

type Ask = (question: string) => Promise<string>;

function approvalChannel(ask: Ask | null): (req: ChatApprovalRequest) => Promise<ChatApprovalAnswer> {
  return async (req: ChatApprovalRequest): Promise<ChatApprovalAnswer> => {
    const detail = describeApproval(req);
    if (!ask) {
      return {
        granted: false,
        reason:
          "非交互运行没有审批通道，按拒绝处理（如确需执行，请显式加 --approval never）" +
          (detail ? `：${detail}` : ""),
      };
    }
    const answer = await ask(
      `\n[审批] ${req.reason}\n${detail}\n允许？[y] 一次 / [a] 本会话都不再问 / [n] 拒绝（可附理由）> `,
    );
    const text = answer.trim();
    const lower = text.toLowerCase();
    if (lower === "a" || lower.startsWith("a ")) return { granted: true, scope: "session" };
    if (lower === "y" || lower.startsWith("y ")) return { granted: true, scope: "once" };
    const reason = lower === "" ? "人工拒绝" : text.replace(/^n\s*/i, "") || "人工拒绝";
    return { granted: false, reason };
  };
}

function makePrinter(json: boolean): (event: ChatEvent) => void {
  const marks: Record<string, string> = {
    user: "▸",
    assistant: "◂",
    tool_call: "⚙",
    tool_result: "↳",
    system: "·",
    error: "✖",
    approval: "🛂",
  };
  // 非 json 模式的"正在打字"状态：已经直接写到 stdout 的增量。正文落定时用它
  // 去重 —— 同一段字不打印两遍（桌面端是清空预览行，终端里就只能是"别再打一次"）。
  let streamed = "";
  const endStream = (): void => {
    if (streamed === "") return;
    process.stdout.write("\n");
    streamed = "";
  };
  return (event) => {
    if (json) {
      writeJson(event as unknown as Record<string, unknown>);
      return;
    }
    if (event.type === "chat:delta") {
      if (event.text === "") return;
      // 第一条增量前补上行首标记，让流式行与落定行长得一样。
      if (streamed === "") process.stdout.write(`${marks.assistant} `);
      streamed += event.text;
      process.stdout.write(event.text);
      return;
    }
    if (event.type === "chat:entry") {
      const mark = marks[event.entry.kind] ?? "·";
      // 增量已经原样显示过且与落定正文一致：只换行（文本协议下正文会被剥掉围栏，
      // 两者不同，那就照常打印干净版本 —— 宁可多一行，不给半个坏块）。
      const shown =
        event.entry.kind === "assistant" && streamed !== "" && streamed.trim() === event.entry.text.trim();
      endStream();
      if (shown) return;
      process.stdout.write(`${mark} ${event.entry.text}\n`);
      if (event.entry.kind === "tool_result" && event.entry.result?.output) {
        const body = redactSecrets(event.entry.result.output);
        process.stdout.write(`${body.replace(/^/gm, "  ")}\n`);
      }
      if (event.entry.kind === "tool_result" && (event.entry.result?.changes?.length ?? 0) > 0) {
        const files = event.entry.result!.changes!.map((c) => c.path).join("、");
        process.stdout.write(`  [改动] ${files}（在桌面端可看 diff / 撤销）\n`);
      }
      return;
    }
    if (event.type === "chat:done") {
      endStream();
      process.stdout.write(`— 会话收束（${event.turns} 次模型回合，${event.usageTokens} tokens）—\n`);
      return;
    }
    if (event.type === "chat:error") {
      // 出错时增量可能停在半句上：先收行，错误信息才不会粘在句尾。
      endStream();
      process.stderr.write(`✖ ${event.message}\n`);
    }
  };
}

function makeBundle(
  store: ChatSessionStore,
  rootAbs: string,
  args: ChatArgs,
  onEvent: (event: ChatEvent) => void,
  ask: Ask | null,
  existing?: ChatSessionEnvelope,
): SessionBundle {
  const projectId = existing?.projectId ?? projectIdFor(rootAbs);
  const settings = settingsFor(args);
  const runtime = resolveChatRuntime({
    rootAbs,
    settings,
    globalPolicyDir: path.join(oxHome(), "policy.d"),
    homeDir: os.homedir(),
  });
  for (const issue of runtime.issues) process.stderr.write(`[chat] ${issue}\n`);
  const providerId = args.provider;
  const controller = new AbortController();
  const requestApproval = approvalChannel(ask);
  const runner = new ToolRunner({
    rootAbs,
    pathPolicy: runtime.pathPolicy,
    commandPolicy: runtime.commandPolicy,
    mode: runtime.mode,
    approvalPolicy: runtime.approvalPolicy,
    approvalCommands: runtime.approvalCommands,
    requestApproval,
    onEvent: (text) => {
      const safe = redactSecrets(text);
      if (args.json) writeJson({ type: "log", text: safe });
      else process.stdout.write(`[log] ${safe}\n`);
    },
  });
  const providerConfig: ProviderConfig = {
    ...getProvider(providerId, process.env),
    ...(args.baseUrl ? { baseUrl: args.baseUrl.replace(/\/+$/, "") } : {}),
    ...(args.model ? { defaultModel: args.model } : {}),
  };
  const client = args.baseUrl || args.model
    ? createLlmClient(providerConfig, process.env[providerConfig.apiKeyEnvVar] ?? "")
    : buildLlmClient(providerId, { env: process.env });
  const history: ChatHistory | undefined = existing
    ? {
        sessionId: existing.snapshot.meta.sessionId,
        entries: existing.snapshot.entries,
        messages: messagesForProtocol(
          existing.snapshot.messages,
          protocolFor(providerId),
        ),
        meta: existing.snapshot.meta,
      }
    : undefined;
  const session = new ChatSession({
    client,
    runner,
    rootAbs,
    sessionId: existing?.snapshot.meta.sessionId,
    ...(history ? { history } : {}),
    systemPrompt: runtime.systemPrompt,
    toolProtocol: protocolFor(providerId),
    mode: runtime.mode,
    approvalPolicy: runtime.approvalPolicy,
    ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
    signal: controller.signal,
    onEvent,
    onPersist: (snapshot) => {
      try {
        store.save(projectId, rootAbs, providerId, snapshot);
      } catch (e) {
        process.stderr.write(`[chat] 会话记录保存失败：${(e as Error).message}\n`);
      }
    },
  });
  return { session, store, projectId, rootAbs, runtime, controller };
}

function loadForResume(
  store: ChatSessionStore,
  args: ChatArgs,
  rootAbs: string,
  onEvent: (event: ChatEvent) => void,
  ask: Ask | null,
  requireExisting: boolean,
): SessionBundle {
  const projectId = projectIdFor(rootAbs);
  const id = args.sessionId;
  let env: ChatSessionEnvelope | null = id ? store.load(id) : null;
  if (!id) {
    const latest = store.latest(projectId);
    if (latest) env = store.load(latest.sessionId);
  }
  if (id && !env) throw new CliError(`会话不存在或已损坏：${id}`);
  if (!env) {
    if (requireExisting) throw new CliError("没有可恢复的历史会话");
    return makeBundle(store, rootAbs, args, onEvent, ask);
  }
  return makeBundle(store, env.rootAbs, args, onEvent, ask, env);
}

async function runExec(args: ChatArgs): Promise<number> {
  const rootAbs = path.resolve(args.cwd);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new CliError(`工作区不存在或不是目录：${rootAbs}`);
  }
  const store = new ChatSessionStore(path.join(oxHome(), "chat"));
  const printer = makePrinter(args.json);
  let ask: Ask | null = null;
  let rl: ReadlineInterface | null = null;
  if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
    rl = createInterface({ input, output });
    ask = (q) => rl!.question(q);
  }
  const bundle = args.continueLatest || args.sessionId
    ? loadForResume(store, { ...args, continueLatest: true }, rootAbs, printer, ask, true)
    : makeBundle(store, rootAbs, args, printer, ask);
  const onSigint = (): void => bundle.controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const t = await bundle.session.send(args.prompt);
    const last = t.entries.at(-1);
    if (bundle.session.status === "error") return 1;
    if (bundle.session.status === "aborted") return 2;
    if (last?.kind === "system" && last.text.startsWith("达到轮次上限")) return 2;
    return 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
    rl?.close();
  }
}

async function runRepl(args: ChatArgs): Promise<number> {
  const rootAbs = path.resolve(args.cwd);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new CliError(`工作区不存在或不是目录：${rootAbs}`);
  }
  const store = new ChatSessionStore(path.join(oxHome(), "chat"));
  const rl = createInterface({ input, output });
  const printer = makePrinter(false);
  const ask: Ask = (q) => rl.question(q);
  let bundle = args.continueLatest || args.sessionId
    ? loadForResume(store, { ...args, continueLatest: true }, rootAbs, printer, ask, true)
    : makeBundle(store, rootAbs, args, printer, ask);
  let current: AbortController | null = bundle.controller;
  rl.on("SIGINT", () => {
    current?.abort();
    process.stdout.write("\n（已请求停止；再按 Ctrl-C 退出）/exit 退出\n");
  });
  process.stdout.write(`项目：${rootAbs}\n沙箱：${bundle.runtime.mode} · 审批：${bundle.runtime.approvalPolicy}\n`);
  process.stdout.write("输入 /help 看命令；空行忽略。\n");
  try {
    for (;;) {
      const raw = await rl.question("you> ").catch(() => null);
      if (raw === null) return 0;
      const line = raw.trim();
      if (line === "") continue;
      if (line === "/exit" || line === "/quit") return 0;
      if (line === "/help") {
        process.stdout.write(`${usage()}\n`);
        continue;
      }
      const resumeMatch = /^\/resume(?:\s+(\S+))?\s*$/.exec(line);
      if (resumeMatch) {
        try {
          const next = loadForResume(
            store,
            { ...args, sessionId: resumeMatch[1], continueLatest: !resumeMatch[1] },
            bundle.rootAbs,
            printer,
            ask,
            true,
          );
          bundle.controller.abort();
          bundle = next;
          current = next.controller;
          process.stdout.write(`已恢复会话 ${next.session.sessionId}\n`);
        } catch (e) {
          process.stderr.write(`恢复失败：${(e as Error).message}\n`);
        }
        continue;
      }
      if (line === "/sessions") {
        const list = store.list(bundle.projectId);
        if (list.length === 0) process.stdout.write("（没有历史会话）\n");
        for (const s of list.slice(0, 20)) {
          process.stdout.write(`${s.sessionId}  ${s.turns} 轮  ${s.title}\n`);
        }
        continue;
      }
      if (line === "/new") {
        bundle.controller.abort();
        bundle = makeBundle(store, bundle.rootAbs, args, printer, ask);
        current = bundle.controller;
        process.stdout.write(`新会话 ${bundle.session.sessionId}\n`);
        continue;
      }
      await bundle.session.send(line);
    }
  } finally {
    rl.close();
  }
}

async function runList(args: ChatArgs): Promise<number> {
  const rootAbs = path.resolve(args.cwd);
  const store = new ChatSessionStore(path.join(oxHome(), "chat"));
  const list = store.list(projectIdFor(rootAbs));
  if (list.length === 0) {
    process.stdout.write("（没有历史会话）\n");
    return 0;
  }
  for (const s of list) {
    process.stdout.write(
      `${s.sessionId}  ${new Date(s.updatedAt).toISOString()}  ${s.turns} 轮  ${s.usageTokens} tokens  ${s.title}\n`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let args: ChatArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpRequested) {
      process.stdout.write(`${e.message}\n`);
      return 0;
    }
    process.stderr.write(`ox chat: ${(e as Error).message}\n`);
    return 2;
  }
  try {
    if (args.command === "list") return await runList(args);
    if (args.command === "exec") return await runExec(args);
    return await runRepl(args);
  } catch (e) {
    if (args.json) writeJson({ type: "error", message: (e as Error).message });
    else process.stderr.write(`ox chat: ${(e as Error).message}\n`);
    return e instanceof CliError ? 2 : 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
