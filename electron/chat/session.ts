import { randomUUID } from "node:crypto";

import type { LlmClient } from "../../shared/llm-client";
import type { ChatMessage } from "../../shared/providers";
import type { ToolName } from "../../shared/tools/spec";
import { TOOL_NAMES, TOOL_SPECS } from "../../shared/tools/spec";
import { parseToolTurn, toolCatalogBlock, toolResultBlock } from "../../shared/tools/protocol";
import type { ApprovalPolicy, SandboxMode } from "../../shared/tools/policy";
import {
  COMPACTION_INSTRUCTION,
  buildCompactedMessages,
  compactionNote,
  estimateMessagesTokens,
  planCompaction,
  type CompactionPlan,
} from "../../shared/chat-compress";
import {
  describeToolCall,
  describeToolResult,
  type ChatEntry,
  type ChatEvent,
  type ChatHistory,
  type ChatSessionMeta,
  type ChatSessionSnapshot,
  type ChatTranscript,
} from "../../shared/chat-events";
import type { ToolRunner } from "./tool-runner";

/**
 * 交互式会话：把"人一句话"变成"模型自己读、改、跑，直到给出答复"。
 *
 * 这是本平台此前**没有**的一种形态：内置执行器是一问一答（平台塞快照 → 模型吐
 * 整文件），而编码智能体的能力面恰恰在"多轮自主取信息"上 —— 模型先 list_dir 摸清
 * 结构、再 read_file 看关键文件、再 apply_patch 改一处、再 run_command 验证，
 * 每一步的结果决定下一步。少了这个循环，"读不到就说没这个文件"是无法被纠正的
 * （`docs/2026-10-06-real-decomposition-e2e.md` 里那次就卡在这里）。
 *
 * 循环里三条硬约束：
 * 1. **轮次上限**：模型反复调工具不会烧穿预算（`maxTurns`）；
 * 2. **可中断**：每个回合之间都检查 signal，取消是真的停下而不是跑完再说；
 * 3. **过程可回放**：每一步都进 transcript（用户/模型/工具调用/工具结果/审批），
 *    界面与事后审计看的是同一份结构。
 */
export interface ChatSessionOptions {
  client: LlmClient;
  runner: ToolRunner;
  rootAbs: string;
  sessionId?: string;
  /**
   * 从磁盘恢复的会话。只用于构造期载入历史，不触发事件；
   * `status` 一律重置为 idle（上次退出时可能停在 running）。
   */
  history?: ChatHistory;
  /** 每次状态边界（用户消息、工具批次、终态）落一次快照；IO 由宿主注入。 */
  onPersist?: (snapshot: ChatSessionSnapshot) => void;
  /** 附加的 system 提示（项目约定 / 宿主说明）。工具说明由本模块按协议追加。 */
  systemPrompt?: string;
  /** 开放给模型的工具（缺省全开）。 */
  tools?: readonly ToolName[];
  /**
   * 工具调用的传输方式。`native` 走端点的 function calling，`text` 走文本协议
   * —— 两者对**本模块**是同一种结构，差别只在消息怎么摆。
   */
  toolProtocol?: "native" | "text";
  maxTurns?: number;
  mode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  /** 线程钉死的线路（M3c-2）；省略 = 跟随全局 provider/pool。 */
  providerId?: string;
  model?: string;
  /**
   * 要不要把正文增量（`chat:delta`）发出去。默认开。
   *
   * 关掉它只在"下游根本没人看增量"时才有意义（比如一次性脚本）—— 客户端的
   * 策略是「给了回调才流」，所以这里关掉等于一次普通请求，不是另一种结果。
   */
  stream?: boolean;
  /**
   * 上下文压缩（P1-2）。给 `false` 关掉；给对象则按给的预算跑。
   *
   * 为什么默认开一个具体的数：长会话撞上下文窗口是**必然**而不是意外，而撞了
   * 之后的症状（"模型忘了开头说过什么"）在界面上完全看不出成因。
   */
  compact?: CompactOptions | false;
  /**
   * 压缩器。注入是为了让这一层可测（也是宿主换模型的口子）；缺省用同一个客户端
   * 发一条不带工具的总结请求。
   */
  summarize?: (source: string, signal?: AbortSignal) => Promise<string>;
  onEvent?: (event: ChatEvent) => void;
  signal?: AbortSignal;
  /** 注入时钟，测试才写得动时间戳。 */
  now?: () => number;
}

export const DEFAULT_MAX_TURNS = 24;

/**
 * 压缩触发的提示预算。
 *
 * 端点窗口在平台这一侧是**未知的**（provider 目录里没有窗口字段），所以取一个
 * 保守值：多数兼容端点在 32k–128k 之间，压在 48k 触发意味着"还远没到窗口就先
 * 整理一次"，代价是多一次总结请求，收益是不会突然看不见开头。
 */
export const DEFAULT_MAX_PROMPT_TOKENS = 48_000;

export interface CompactOptions {
  /** 触发预算（token）。超过就压。 */
  maxPromptTokens?: number;
  /** 压完后尾部要占预算的比例（0–1），默认 0.5。 */
  keepTailRatio?: number;
}

export class AbortedError extends Error {
  constructor() {
    super("会话被中止");
    this.name = "AbortedError";
  }
}

export class ChatSession {
  readonly sessionId: string;
  private readonly client: LlmClient;
  private readonly runner: ToolRunner;
  private readonly rootAbs: string;
  private readonly systemPrompt: string;
  private readonly tools: readonly ToolName[];
  private readonly toolProtocol: "native" | "text";
  private readonly maxTurns: number;
  private readonly onEvent?: (event: ChatEvent) => void;
  private readonly onPersist?: (snapshot: ChatSessionSnapshot) => void;
  private readonly signal?: AbortSignal;
  private readonly now: () => number;
  private readonly stream: boolean;
  private readonly compact: CompactOptions | false;
  private readonly summarize?: (source: string, signal?: AbortSignal) => Promise<string>;
  private readonly messages: ChatMessage[] = [];
  private readonly entries: ChatEntry[] = [];
  private readonly meta: ChatSessionMeta;
  private seq = 0;
  /**
   * 用户回合序号（第几条 user 消息）。补丁的 undo 分组用它，而不是
   * `meta.turns`（LLM 调用次数）—— 一次用户输入可能包含工具调用 + 最终答复
   * 两三个 LLM 回合，按后者分组会把"撤这一问"拆错。
   */
  private userTurn = 0;
  private busy = false;
  /** 中止的系统条目只落一次：在途取消与轮次间取消共用收尾路径。 */
  private abortAnnounced = false;

  constructor(opts: ChatSessionOptions) {
    this.client = opts.client;
    this.runner = opts.runner;
    this.rootAbs = opts.rootAbs;
    this.tools = opts.tools ?? [...TOOL_NAMES];
    this.toolProtocol = opts.toolProtocol ?? "text";
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.onEvent = opts.onEvent;
    this.onPersist = opts.onPersist;
    this.signal = opts.signal;
    this.now = opts.now ?? Date.now;
    this.stream = opts.stream ?? true;
    this.compact = opts.compact === undefined ? {} : opts.compact;
    this.summarize = opts.summarize;
    // 会话 id 会进文件名与恢复索引：`Math.random` 既不满足仓库"零随机"
    // 的约定，也没有跨进程唯一性保证。UUID 是宿主层能力，放这里不污染 shared。
    this.sessionId = opts.sessionId ?? opts.history?.sessionId ?? `chat-${randomUUID()}`;
    const catalog = this.toolProtocol === "text" ? `\n\n${toolCatalogBlock(this.tools)}` : "";
    this.systemPrompt = `${(opts.systemPrompt ?? "你是一个在本项目里干活的编码智能体。用工具看清现状再动手，改完自己跑一遍验证。").trim()}${catalog}`;
    const history = opts.history;
    this.meta = {
      sessionId: this.sessionId,
      rootAbs: this.rootAbs,
      startedAt: history?.meta?.startedAt ?? this.now(),
      updatedAt: history?.meta?.updatedAt ?? this.now(),
      turns: history?.meta?.turns ?? 0,
      // 恢复时不能沿用磁盘上的 running / awaiting-approval：那个进程已经不在了，
      // 继续显示"运行中"会让界面永远等一个不会来的事件。
      status: "idle",
      mode: opts.mode ?? "workspace-write",
      approvalPolicy: opts.approvalPolicy ?? "on-request",
      ...(opts.providerId && opts.model ? { providerId: opts.providerId, model: opts.model } : {}),
      usageTokens: history?.meta?.usageTokens ?? 0,
    };
    if (history) {
      for (const entry of history.entries) this.entries.push(entry);
      for (const message of history.messages) this.messages.push({ ...message });
      this.seq = history.entries.reduce((max, entry) => {
        const n = Number.parseInt(entry.id.replace(/^e-/, ""), 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
      this.userTurn = history.entries.filter((e) => e.kind === "user").length;
    }
  }

  transcript(): ChatTranscript {
    return { meta: { ...this.meta }, entries: [...this.entries] };
  }

  /** 给宿主落盘用的完整快照（含模型消息，不能只存给人看的 entries）。 */
  snapshot(): ChatSessionSnapshot {
    return {
      meta: { ...this.meta },
      entries: [...this.entries],
      messages: this.messages.map((m) => ({ ...m })),
      toolProtocol: this.toolProtocol,
    };
  }

  /** 只读的模型消息视图（测试/诊断用；恢复走 history）。 */
  modelMessages(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** 宿主侧动作（撤销/策略提示）落一条可见的系统条目，并立即持久化。 */
  note(text: string): void {
    this.push({ kind: "system", text });
    this.persist();
  }

  get status(): ChatSessionMeta["status"] {
    return this.meta.status;
  }

  private emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  private push(entry: Omit<ChatEntry, "id" | "ts">): ChatEntry {
    this.seq += 1;
    const full: ChatEntry = { id: `e-${this.seq}`, ts: this.now(), ...entry };
    this.entries.push(full);
    this.meta.updatedAt = full.ts;
    this.emit({ type: "chat:entry", sessionId: this.sessionId, entry: full });
    return full;
  }

  private setStatus(status: ChatSessionMeta["status"]): void {
    this.meta.status = status;
    this.emit({ type: "chat:status", sessionId: this.sessionId, status, turns: this.meta.turns });
  }

  /**
   * 落一次快照。只在不变量成立时调用（用户消息已进 messages、工具批次的结果
   * 已回灌、或已到终态）—— 在半更新状态落盘，恢复出来的消息序列会缺一条。
   */
  private persist(): void {
    if (this.entries.length === 0) return;
    this.onPersist?.(this.snapshot());
  }

  /**
   * 中止收尾：状态置 aborted、系统条目只落一次。
   *
   * 两个场景共用它：轮次之间落下的 signal（loop 顶部）与在途模型调用被取消
   * （send 的 catch）。分开写就会漂 —— 文案只说一个场景，另一个场景的信
   * 息就丢了。
   */
  private announceAbort(): void {
    this.setStatus("aborted");
    if (this.abortAnnounced) return;
    this.abortAnnounced = true;
    this.push({ kind: "system", text: "会话被中止" });
    this.persist();
  }

  /**
   * 跑一轮用户输入（含工具循环），直到模型不再要工具或轮次用尽。
   *
   * 同一时刻只跑一轮：`busy` 不是乐观锁而是**语义** —— 一次 send 就是一次完整
   * 的"说到做完"，并发插入第二条会让工具结果与会话历史错位。
   */
  async send(text: string): Promise<ChatTranscript> {
    if (this.busy) throw new Error("上一轮还没结束");
    this.busy = true;
    const trimmed = text.trim();
    if (trimmed === "") {
      this.busy = false;
      return this.transcript();
    }
    this.push({ kind: "user", text: trimmed });
    this.messages.push({ role: "user", content: trimmed });
    this.userTurn += 1;
    this.persist();
    try {
      await this.loop();
    } catch (e) {
      // 叫停不是故障：把它报成 error 会让界面把"用户按了停止"显示成"跑挂了"，
      // 而两者的处置完全不同（一个可以直接续说，一个要看错误）。
      //
      // 判定**不看异常类**：在途调用被 signal 取消时，客户端抛的是
      // DOMException（与 fetch 的 abort 同形，见 http-clients 的
      // sleepUnlessAborted），不是本模块的 AbortedError；而两个场景共同
      // 的事实只有一件 —— signal 已经落下。所以按 signal 判，不按类判。
      if (this.signal?.aborted) {
        this.announceAbort();
      } else {
        const message = (e as Error).message;
        this.setStatus("error");
        this.push({ kind: "error", text: message });
        this.emit({ type: "chat:error", sessionId: this.sessionId, message });
        this.persist();
      }
    } finally {
      this.busy = false;
    }
    return this.transcript();
  }

  /**
   * 上下文压缩（P1-2）：把"已经发生过、但不会再被逐字用到"的旧消息换成一段摘要。
   *
   * 三条处置都是**说破**而不是静默：
   *   1. 压不动（尾部本身就装不下）⇒ 落一条 system 条目，让人知道"后面可能看不到开头"；
   *   2. 压缩器失败 ⇒ 落一条 system 条目并**继续用原文**（不压缩好过把上下文弄丢）；
   *   3. 压完 ⇒ 落一条 system 条目说明压掉了几条、估算从多少到多少。
   * 转录本身**从不删条目** —— 界面上仍能看到全部原文，被换掉的只是给模型的那段。
   */
  private async maybeCompact(): Promise<void> {
    if (this.compact === false) return;
    const maxPromptTokens = this.compact.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
    // 与真正发请求同一口径：**连 system 一起估**。不这么做会踩两种错 ——
    // ① 传 `this.messages`（它从来不含 system）时，planCompaction 会把第一条普通
    //    消息当成"要保留的头"跳过，最老的一条用户消息永远进不了压缩原文；
    // ② 不把 systemPrompt 计入预算，工具目录很长时会系统性低估。
    const full: ChatMessage[] = [{ role: "system", content: this.systemPrompt }, ...this.messages];
    const plan: CompactionPlan = planCompaction({
      messages: full,
      maxPromptTokens,
      ...(this.compact.keepTailRatio !== undefined ? { keepTailRatio: this.compact.keepTailRatio } : {}),
    });
    if (!plan.needed) return;
    const before = estimateMessagesTokens(full);
    if (plan.stuck) {
      this.push({
        kind: "system",
        text: `上下文已超预算（约 ${before} tokens）但压不动：剩下的尾部本身就装不下。后面的回答可能看不到开头的内容。`,
      });
      return;
    }
    let summary = "";
    try {
      summary = (await this.runSummarizer(plan.source)).trim();
    } catch (e) {
      // fail-open：压缩失败不该让这一轮跑不下去，但不许静默 —— 静默的后果是
      // "模型忽然答非所问"而没有任何线索。
      this.push({
        kind: "system",
        text: `上下文压缩失败（继续用原文，可能撞上下文窗口）：${(e as Error).message}`,
      });
      return;
    }
    if (summary === "") {
      this.push({ kind: "system", text: "上下文压缩返回空摘要（继续用原文）" });
      return;
    }
    const system = full[0];
    const next = buildCompactedMessages(system, summary, plan.tail);
    // 写回时**去掉 system**：`this.messages` 从来不含它（每次请求由 loop 现拼），
    // 留着会让下一轮消息里出现两条系统提示。
    // `messages` 是 readonly 字段：就地换内容而不是重新赋值。
    this.messages.splice(0, this.messages.length, ...next.slice(1));
    this.push({ kind: "system", text: compactionNote(plan.cutIndex - 1, before, estimateMessagesTokens(next)) });
    this.persist();
  }

  private async runSummarizer(source: string): Promise<string> {
    if (this.summarize) return this.summarize(source, this.signal);
    // 缺省实现：**不带工具**地问一次 —— 压缩请求绝不能再触发工具循环，
    // 否则"整理上下文"会变成"又去读了一遍文件"。
    const res = await this.client.chat({
      messages: [
        { role: "system", content: COMPACTION_INSTRUCTION },
        { role: "user", content: source },
      ],
      temperature: 0,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    return res.content;
  }

  private async loop(): Promise<void> {
    this.setStatus("running");
    // 轮次是**会话累计值**，不是每次 send 从 1 重数：撤销按 turn 分组，
    // 重置会让第二个用户回合的改动与第一轮撞在同一个 turn 上，撤一轮撤两轮。
    const baseTurns = this.meta.turns;
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      if (this.signal?.aborted) {
        this.announceAbort();
        throw new AbortedError();
      }
      this.meta.turns = baseTurns + turn;
      // 每轮模型调用前先看一眼预算：工具结果回灌最容易把上下文撑爆，
      // 等端点报"超窗"再处理已经晚了（那一轮的活白干）。
      await this.maybeCompact();
      const res = await this.client.chat({
        messages: [{ role: "system", content: this.systemPrompt }, ...this.messages],
        ...(this.toolProtocol === "native"
          ? { tools: TOOL_SPECS.filter((s) => this.tools.includes(s.name)) }
          : {}),
        ...(this.signal ? { signal: this.signal } : {}),
        // 给了回调 = 想要增量：客户端先试 SSE，**零增量**就整段退回普通请求，
        // 所以这里不需要判断"端点支不支持流"。
        ...(this.stream
          ? {
              onDelta: (delta: string) => {
                this.emit({ type: "chat:delta", sessionId: this.sessionId, text: delta });
              },
            }
          : {}),
      });
      this.meta.usageTokens += res.usageTokens ?? 0;

      const native = res.toolCalls ?? [];
      const parsed = this.toolProtocol === "native" ? { text: res.content, calls: native, problems: [] as string[] } : parseToolTurn(res.content);

      if (parsed.calls.length === 0) {
        const finalText = parsed.text.trim() !== "" ? parsed.text.trim() : res.content.trim();
        if (finalText === "" && parsed.problems.length === 0) {
          this.push({ kind: "assistant", text: "（模型没有给出任何内容）" });
          this.messages.push({ role: "assistant", content: "" });
        } else {
          // 解析问题一并说破：坏块被跳过必须可见，否则"少执行一个工具"在会话里
          // 表现为"模型假装读过"（protocol.ts 里同一条理由）。
          const parts = [finalText, ...parsed.problems.map((p) => `（解析问题）${p}`)];
          this.push({ kind: "assistant", text: parts.join("\n").trim() });
          this.messages.push({ role: "assistant", content: finalText });
        }
        this.setStatus("done");
        this.persist();
        this.emit({
          type: "chat:done",
          sessionId: this.sessionId,
          turns: this.meta.turns,
          usageTokens: this.meta.usageTokens,
        });
        return;
      }

      if (parsed.text.trim() !== "") {
        this.push({ kind: "assistant", text: parsed.text.trim() });
      }
      // 原生协议要求 assistant 消息带上 tool_calls 再接 tool 消息，缺了端点会 400。
      this.messages.push({
        role: "assistant",
        content: parsed.text.trim(),
        ...(this.toolProtocol === "native" ? { toolCalls: parsed.calls } : {}),
      });

      const results = [];
      for (const call of parsed.calls) {
        // 轮次之间看 signal 还不够：一条长命令在途时用户按停止，必须让
        // 工具层看见同一个 signal 并把子进程真的杀掉。
        if (this.signal?.aborted) {
          this.announceAbort();
          throw new AbortedError();
        }
        this.push({ kind: "tool_call", text: describeToolCall(call), tool: call });
        const result = await this.runner.run(call, {
          ...(this.signal ? { signal: this.signal } : {}),
          turn: this.userTurn,
        });
        results.push(result);
        this.push({ kind: "tool_result", text: describeToolResult(result), result });
      }
      if (this.signal?.aborted) {
        // 最后一批工具执行期间被叫停时，不能因为 turn 刚好用尽就报 done。
        this.announceAbort();
        throw new AbortedError();
      }

      if (this.toolProtocol === "native") {
        for (const r of results) {
          this.messages.push({ role: "tool", content: r.ok ? r.output : `失败：${r.reason ?? "未知原因"}`, toolCallId: r.id });
        }
      } else {
        this.messages.push({ role: "user", content: toolResultBlock(results, parsed.problems) });
      }
      if (parsed.problems.length > 0) {
        this.push({ kind: "system", text: `工具调用解析问题：${parsed.problems.join("；")}` });
      }
      this.persist();
    }
    this.setStatus("done");
    this.push({
      kind: "system",
      text: `达到轮次上限（${this.maxTurns} 轮）后收束 —— 如果任务没做完，请把它拆小或提高上限再说一遍`,
    });
    this.persist();
    this.emit({ type: "chat:done", sessionId: this.sessionId, turns: this.meta.turns, usageTokens: this.meta.usageTokens });
  }
}
