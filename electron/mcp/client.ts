/**
 * stdio MCP client（M7）。
 *
 * 协议是**按行分隔的 JSON-RPC 2.0**：MCP 的 stdio 传输没有 Content-Length 头，
 * 一条消息一行（官方 2024-11-05 规范）。手写而不引 SDK 的理由与
 * `headless/mcp.ts`（我们是 server）相同：这一层没有魔法，引进来反而多一份
 * 需要信任的依赖与一套我们没有审计过的超时语义。
 *
 * 四条边界：
 * 1. **外部进程 = 沙箱外**：server 的行为平台不背书。平台只做三件事 ——
 *    环境收窄（`scopedEnv` + 清单显式 env）、调用前审批、输出脱敏与截断。
 * 2. 超时/中止必须**杀进程树**：只 reject Promise 会让子进程继续写盘/发网络请求，
 *    用户看到的"已停止"就只是界面停了。
 * 3. 熔断只记**传输层失败**（起不来、超时、进程退出）；工具自己返回的
 *    `isError: true` 是业务失败，不是 server 坏了 —— 把它算进熔断会让一个
 *    "查询不到记录"的工具把整个 server 打进冷却。
 * 4. 退出/拆卸时所有挂起请求都要收尾：没有审批通道时 fail-closed 的纪律同样
 *    适用于"等一个永远不会来的响应"。
 */
import { spawn, type ChildProcess } from "node:child_process";

import { scopedEnv } from "../agents/scoped-env";
import { killTree } from "../sandbox/kill-tree";
import {
  MAX_MCP_TOOLS_PER_SERVER,
  MCP_PROTOCOL_VERSION,
  mcpCallText,
  normalizeMcpToolDef,
  type McpCallText,
  type McpServerManifest,
  type McpToolDef,
} from "../../shared/mcp";

/** 连续传输失败多少次后冷却（与熔断器的"连续失败才开闸"同一条）。 */
export const MCP_MAX_CONSECUTIVE_FAILURES = 3;
/** 冷却窗口；窗口过后允许一次重连试探。 */
export const MCP_COOLDOWN_MS = 60_000;
/** stdout 单行上限：防一个不按协议换行的 server 把内存吃光。 */
export const MAX_MCP_MESSAGE_CHARS = 8 * 1024 * 1024;
/** stderr 只留尾巴：报错时够定位，不把整个日志搬进上下文。 */
const STDERR_TAIL_CHARS = 4_000;

export class McpAbortError extends Error {
  constructor(message = "MCP 调用被中止") {
    super(message);
    this.name = "McpAbortError";
  }
}

export class McpTimeoutError extends Error {
  constructor(server: string, ms: number) {
    super(`MCP server ${server} 超时（${ms}ms）`);
    this.name = "McpTimeoutError";
  }
}

export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

type SpawnLike = typeof spawn;

export interface McpClientOptions {
  manifest: McpServerManifest;
  /** 子进程工作目录（项目根：文件系统类 server 的相对路径因此可预期）。 */
  cwd: string;
  /** 注入点：测试用真实 fixture 进程时也可以不换。 */
  spawn?: SpawnLike;
  now?: () => number;
  onEvent?: (text: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * 中止订阅。signal 与它的 handler 同生同灭 —— 收成一个字段，而不是两个各自
   * 可缺省的可选字段：那种写法里"两个都非空"的守卫后半段永远走不到，site 审计
   * 只会把它记成一处等价变异（本仓的处置是简化源码，不是加白名单）。
   */
  abort?: { signal: AbortSignal; handler: () => void };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class McpClient {
  private readonly manifest: McpServerManifest;
  private readonly cwd: string;
  private readonly spawnFn: SpawnLike;
  private readonly now: () => number;
  private readonly onEvent?: (text: string) => void;
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private buffer = "";
  private stderrTail = "";
  private tools: McpToolDef[] | null = null;
  private connecting: Promise<void> | null = null;
  private disposed = false;
  private failures = 0;
  private cooldownUntil = 0;
  private badLines = 0;

  constructor(opts: McpClientOptions) {
    this.manifest = opts.manifest;
    this.cwd = opts.cwd;
    this.spawnFn = opts.spawn ?? spawn;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  get name(): string {
    return this.manifest.name;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.tools !== null) return;
    if (this.disposed) throw new Error(`MCP server ${this.manifest.name} 客户端已关闭`);
    const remaining = this.cooldownUntil - this.now();
    if (remaining > 0) {
      throw new Error(
        `MCP server ${this.manifest.name} 熔断冷却中（剩余 ${Math.ceil(remaining / 1000)}s；连续失败 ${this.failures} 次）`,
      );
    }
    if (this.connecting !== null) {
      await this.connecting;
      return;
    }
    this.connecting = this.doConnect(signal);
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpToolDef[]> {
    await this.connect(signal);
    return this.tools ?? [];
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallText> {
    await this.connect(signal);
    if (this.tools === null || !this.tools.some((t) => t.name === tool)) {
      throw new Error(`MCP server ${this.manifest.name} 没有声明工具：${tool}`);
    }
    try {
      const result = await this.request(
        "tools/call",
        { name: tool, arguments: args },
        this.manifest.timeoutMs,
        signal,
      );
      this.failures = 0;
      return mcpCallText(result);
    } catch (e) {
      // 业务错误（JSON-RPC error 与工具 isError）不触发熔断；传输失败才记。
      if (!(e instanceof McpAbortError) && !(e instanceof McpRpcError)) {
        this.recordFailure(errorText(e));
      }
      throw e;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new McpAbortError(`MCP server ${this.manifest.name} 已关闭`));
    this.killChild();
    this.tools = null;
  }

  private async doConnect(signal?: AbortSignal): Promise<void> {
    this.stderrTail = "";
    this.buffer = "";
    this.badLines = 0;
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.manifest.command, this.manifest.args, {
        cwd: this.cwd,
        // 与 run_command 同一条纪律：不把宿主的 provider key 交给外部进程。
        // 清单里显式写的 env 是操作者自己的决定（信任模型见 manifest.ts）。
        env: { ...scopedEnv(), ...this.manifest.env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.recordFailure(errorText(e));
      throw new Error(`无法启动 MCP server ${this.manifest.name}：${errorText(e)}`);
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (e) => {
      this.rejectAll(new Error(`MCP server ${this.manifest.name} 进程错误：${e.message}`));
    });
    child.on("close", (code, signal) => {
      const reason = `MCP server ${this.manifest.name} 进程已退出（code=${String(code)}${signal ? `, signal=${signal}` : ""}）${this.stderrNote()}`;
      this.child = null;
      this.tools = null;
      this.rejectAll(new Error(reason));
    });

    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ox-commander", version: "0.1.9" },
        },
        this.manifest.timeoutMs,
        signal,
      );
      this.notify("notifications/initialized", {});
      const tools = await this.fetchTools(signal);
      this.tools = tools;
      this.failures = 0;
      this.cooldownUntil = 0;
      this.onEvent?.(`[mcp] server ${this.manifest.name} 已连接（${tools.length} 个工具）`);
    } catch (e) {
      if (!(e instanceof McpAbortError)) this.recordFailure(errorText(e));
      this.killChild();
      this.tools = null;
      throw e;
    }
  }

  private async fetchTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = asObject(
        await this.request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          this.manifest.timeoutMs,
          signal,
        ),
      );
      if (result === undefined) {
        throw new Error("MCP tools/list 返回的不是对象");
      }
      const list = Array.isArray(result.tools) ? result.tools : [];
      for (const raw of list) {
        if (out.length >= MAX_MCP_TOOLS_PER_SERVER) break;
        const normalized = normalizeMcpToolDef(raw);
        if (normalized.def !== undefined) out.push(normalized.def);
        else this.onEvent?.(`[mcp] ${this.manifest.name} 的工具被跳过：${normalized.issue ?? "形状不对"}`);
      }
      const next = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      // 服务端游标不前进/重复时停：无界翻页会把一次发现变成死循环。
      if (next === undefined || next === cursor || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return out;
  }

  /**
   * 当前可写的 stdin；进程没起来或管道已断时返回 null。
   *
   * **唯一一处**"管道可用吗"的判据：request() 据此在分配 pending 之前拒绝，
   * notify() 与反向应答据此当 best-effort 跳过。此前这判据在 request/write
   * 各写了一遍三连合取，而那些分支在真实路径上不可观察（close 处理器已经把
   * child 置空），site 审计只会把多出来的四处记成等价。写成 `!x` 形式连布尔
   * 算子位点都不产生 —— 语义靠结构，不靠"没人能测到但看起来更谨慎"。
   */
  private stdinStream(): NodeJS.WritableStream | null {
    const stdin = this.child?.stdin;
    if (!stdin) return null;
    if (stdin.destroyed) return null;
    return stdin;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new McpAbortError());
    const stdin = this.stdinStream();
    if (!stdin) {
      return Promise.reject(new Error(`MCP server ${this.manifest.name} 的 stdin 不可用`));
    }
    const id = (this.seq += 1);
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        if (pending === undefined) return;
        this.pending.delete(key);
        this.removeAbort(pending);
        reject(new McpTimeoutError(this.manifest.name, timeoutMs));
        // 超时后不能留下一个还在跑的 server：下一次调用会与它抢同一个管道。
        this.failAllAndKill(`MCP server ${this.manifest.name} 超时（${timeoutMs}ms）`);
      }, timeoutMs);
      const pending: Pending = { resolve, reject, timer };
      if (signal !== undefined) {
        const handler = () => {
          const current = this.pending.get(key);
          // 已结算/已摘除就什么都不做：`!current` 而不是 `current === undefined` ——
          // 后者会多出一个只能靠竞态触发的等价变异位点（site 审计实测）。
          if (!current) return;
          this.pending.delete(key);
          clearTimeout(current.timer);
          // 能通知就通知；通知发不出去也不影响"杀进程"这个事实。
          this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" });
          reject(new McpAbortError());
          this.failAllAndKill(`MCP server ${this.manifest.name} 被中止`);
        };
        pending.abort = { signal, handler };
        signal.addEventListener("abort", handler, { once: true });
        if (signal.aborted) {
          handler();
          return;
        }
      }
      this.pending.set(key, pending);
      try {
        this.write(stdin, { jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(key);
        clearTimeout(timer);
        this.removeAbort(pending);
        reject(new Error(`写入 MCP server 失败：${errorText(e)}`));
        this.failAllAndKill(`MCP server ${this.manifest.name} 管道已关闭`);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const stdin = this.stdinStream();
    if (!stdin) return;
    try {
      this.write(stdin, { jsonrpc: "2.0", method, params });
    } catch {
      // 通知是 best-effort：进程已经死了就让它死，调用方会从 close/超时收到结果。
    }
  }

  private write(stdin: NodeJS.WritableStream, message: Record<string, unknown>): void {
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_MCP_MESSAGE_CHARS) {
      this.failAllAndKill(`MCP server ${this.manifest.name} 的 stdout 超过 ${MAX_MCP_MESSAGE_CHARS} 字符仍无换行`);
      return;
    }
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) return;
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.badLines += 1;
        // 只报第一条：一个把日志写到 stdout 的 server 会每行都坏。
        if (this.badLines === 1) {
          this.onEvent?.(`[mcp] ${this.manifest.name} 输出了非 JSON 行（已忽略，后续同类不再重复）`);
        }
        continue;
      }
      this.onMessage(parsed);
    }
  }

  private onMessage(message: unknown): void {
    const msg = asObject(message);
    if (msg === undefined) return;
    if (typeof msg.method === "string") {
      // 反向请求（sampling / roots 等）本轮不支持：不回话会让 server 永远等，
      // 回一个明确的 method not found 至少让它自己降级。
      if (msg.id !== undefined && msg.id !== null) {
        const stdin = this.stdinStream();
        if (!stdin) return;
        try {
          this.write(stdin, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `client does not support ${msg.method}` },
          });
        } catch {
          // 管道已断：close 处理器会收尾。
        }
      }
      return;
    }
    // 没有 id 的消息（响应形状但缺 id）在这里不单独挡：紧接着的 pending 查表
    // 对 `"undefined"` / `"null"` 必然落空并返回。多写一道等价的早退只会多出
    // 一个永远等价的变异位点（site 审计实测）。
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    this.removeAbort(pending);
    if (msg.error !== undefined) {
      const err = asObject(msg.error);
      const code = typeof err?.code === "number" ? err.code : -32603;
      const text = typeof err?.message === "string" ? err.message : JSON.stringify(msg.error);
      pending.reject(new McpRpcError(code, `MCP server ${this.manifest.name} 返回错误：${text}`));
      return;
    }
    pending.resolve(msg.result);
  }

  private removeAbort(pending: Pending): void {
    if (pending.abort !== undefined) {
      pending.abort.signal.removeEventListener("abort", pending.abort.handler);
    }
  }

  private rejectAll(error: Error): void {
    for (const [key, pending] of [...this.pending]) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      this.removeAbort(pending);
      pending.reject(error);
    }
  }

  private failAllAndKill(reason: string): void {
    this.rejectAll(new Error(reason));
    this.killChild();
    this.tools = null;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    // 真值判断而不是 `!== null`：后者翻转成 `=== null` 之后会拿 null 去杀，
    // 而那条分支在正常路径上永远走不到（site 审计实测）。
    if (child) killTree(child);
  }

  private recordFailure(reason: string): void {
    this.failures += 1;
    if (this.failures >= MCP_MAX_CONSECUTIVE_FAILURES) {
      this.cooldownUntil = this.now() + MCP_COOLDOWN_MS;
      this.onEvent?.(
        `[mcp] server ${this.manifest.name} 连续失败 ${this.failures} 次（${reason}），冷却 ${Math.ceil(MCP_COOLDOWN_MS / 1000)}s`,
      );
    }
  }

  private stderrNote(): string {
    const tail = this.stderrTail.trim();
    return tail === "" ? "" : `；stderr 尾部：${tail.slice(-500)}`;
  }
}

function errorText(error: unknown): string {
  // 写成 if/return 而不是三元：三元会被"分支互换"变异成一个仍然通顺的坏实现，
  // 而这条函数只被 recordFailure 的日志消费，断言很难摸到它（site 审计实测）。
  if (error instanceof Error) return error.message;
  return String(error);
}
