/**
 * 上下文压缩的**纯**逻辑（P1-2）：估算、切点、拼装。
 *
 * 为什么单独一层：长会话必然撞上下文窗口，而"撞了怎么办"这件事有两个极端都错 ——
 * 不做压缩，模型从第 N 轮开始就看不见开头（表现为"它忘了刚才说过什么"）；
 * 压得太狠，把正在用的工具调用上下文也压掉（表现为"它开始胡编文件里有什么"）。
 * 判断逻辑必须能被测：喂一组合成消息就能验"切在哪"，比起真会话便宜得多。
 *
 * 三条纪律：
 * 1. **估算只用于触发，不用于计费**。实际用量永远以端点返回的 usage 为准 ——
 *    这里算的是"要不要压"，不是"压完省了多少"。
 * 2. **切点不能劈开一个工具回合**：`assistant(tool_calls)` 后面必须紧跟它的
 *    `tool` 结果，切开会让 OpenAI 兼容端点直接 400（失败发生在平台之外，最难查）。
 *    所以切点一律向后挪到安全边界。
 * 3. **尾部必须真的装得下**：切完剩下的一段要能塞进预算，否则压缩等于白做 ——
 *    判不出来就明说"压不动"，由调用方决定是继续（可能超窗）还是停下。
 */

import type { ChatMessage } from "./providers";

/** 一条消息的结构开销（role / 分隔符 / 字段名），按主流 chat 模板的实测均值取。 */
const PER_MESSAGE_OVERHEAD = 4;
/** 单条消息参与压缩时的字符上限（防一条巨型工具输出吃掉整个压缩提示）。 */
export const COMPACTION_SOURCE_CHAR_CAP = 24_000;

/**
 * 估算一条消息的 token 数。
 *
 * 按字符类分开算：ASCII 大约 4 字符/token，CJK 大约 1 字符/token（多语言 tokenizer
 * 对中日韩的压缩率远低于英文）。**刻意不做真正的 tokenizer** —— 那需要把词表带进
 * 纯逻辑层，而这里只要一个**偏保守的触发信号**：估少了顶多多压一次，估多了会漏压。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x2e80) ascii += 1;
    else cjk += 1;
  }
  return Math.ceil(ascii / 4) + cjk;
}

/** 一组消息的总估算（含每条的结构开销与 toolCalls 的 JSON）。 */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTokens(m.content ?? "");
    if (m.toolCalls && m.toolCalls.length > 0) total += estimateTokens(JSON.stringify(m.toolCalls));
    if (m.toolCallId) total += estimateTokens(m.toolCallId);
  }
  return total;
}

/**
 * 切点必须落在"上一条不是带 tool_calls 的 assistant"的边界上。
 *
 * 反例：把 `assistant(tool_calls)` 压掉、留下它的 `tool` 结果 ⇒ 端点 400。
 * 所以切点往后挪，直到它前面的那条消息不是"发出调用的 assistant"。
 */
function isSafeCut(messages: readonly ChatMessage[], index: number): boolean {
  if (index <= 0) return false;
  const prev = messages[index - 1];
  // 切点之后第一条如果还是某个 tool 调用的结果，说明这一组被劈开了。
  return !(prev?.role === "assistant" && (prev.toolCalls?.length ?? 0) > 0);
}

export interface CompactionInput {
  /** 完整消息序列，**首条是 system**（不参与压缩，但参与估算）。 */
  messages: readonly ChatMessage[];
  /** 预算（token）。通常取端点上下文窗口的一个保守比例。 */
  maxPromptTokens: number;
  /**
   * 压缩后尾部至少要留多少预算（`0 < x < 1`）。尾巴是"正在发生的事"——
   * 留太少的压缩会立刻再触发一次，留太多则压不动。
   */
  keepTailRatio?: number;
}

export interface CompactionPlan {
  /** 需要压缩。为 false 时其余字段没有意义。 */
  needed: boolean;
  /** 要压掉的消息区间是 `[1, cutIndex)`（system 永远保留）。 */
  cutIndex: number;
  /** 交给压缩器的原文（含上一份摘要，如果有）。 */
  source: string;
  /** 压缩后保留的尾部消息。 */
  tail: ChatMessage[];
  /** 压完之后的估算大小（用来判断"这一刀值不值"）。 */
  tailTokens: number;
  /**
   * 需要压缩，但**切不动**（尾部本身就超预算，或整段只有 system + 一条）。
   * 调用方应当把这个事实说破，而不是假装压过。
   */
  stuck: boolean;
}

const DEFAULT_KEEP_TAIL_RATIO = 0.5;

/**
 * 规划一次压缩。
 *
 * 从**头部**开始累加，直到"剩下的尾部"装得进 `maxPromptTokens * keepTailRatio`；
 * 切点再按工具回合边界向后对齐。system 与至少一条消息永远保留。
 */
export function planCompaction(input: CompactionInput): CompactionPlan {
  const { messages, maxPromptTokens } = input;
  const keepTailRatio = input.keepTailRatio ?? DEFAULT_KEEP_TAIL_RATIO;
  const budget = Math.max(0, Math.floor(maxPromptTokens));
  const notNeeded: CompactionPlan = {
    needed: false,
    cutIndex: 1,
    source: "",
    tail: messages.slice(1),
    tailTokens: estimateMessagesTokens(messages.slice(1)),
    stuck: false,
  };
  if (estimateMessagesTokens(messages) <= budget) return notNeeded;
  if (messages.length <= 2) {
    // 只有 system + 一条：没得压。说破，别假装压过。
    return { ...notNeeded, needed: true, stuck: true };
  }

  const tailBudget = Math.max(1, Math.floor(budget * keepTailRatio));
  // 从**尾部往前**找切点：能留多少近期内容就留多少，但一定至少留最后一条。
  //
  // 反过来的写法（从头部累加到"剩下的装得下"为止）有一个安静的坏法：当最新
  // 一条本身就已经超出预算时，循环会一直推到表尾，把尾部压成**空** —— 压得最
  // 狠的一次反而既不报 stuck 也不报错，模型下一轮只剩 system 与摘要。
  let cut = messages.length - 1;
  for (let i = messages.length - 1; i > 0; i--) {
    if (estimateMessagesTokens(messages.slice(i)) > tailBudget) break;
    cut = i;
  }
  // 向后对齐到安全边界（不能劈开工具回合），但不允许越过最后一条。
  while (cut < messages.length - 1 && !isSafeCut(messages, cut)) cut += 1;
  if (cut >= messages.length) {
    return { ...notNeeded, needed: true, stuck: true };
  }
  const tail = messages.slice(cut);
  const tailTokens = estimateMessagesTokens(tail);
  return {
    needed: true,
    cutIndex: cut,
    source: renderCompactionSource(messages.slice(1, cut)),
    tail,
    tailTokens,
    // 尾部本身就装不下：这一刀救不了，明说。
    stuck: tailTokens > budget,
  };
}

/**
 * 把要压掉的那一段渲染成给压缩器的文本。
 *
 * 带角色标记是因为"谁说的"在压缩里是要点：把工具结果说成模型的结论，
 * 是最难被发现的一类失真。超长单条截断并标注 —— 静默丢一半比截断更坏。
 */
export function renderCompactionSource(messages: readonly ChatMessage[], previousSummary?: string): string {
  const lines: string[] = [];
  if (previousSummary && previousSummary.trim() !== "") {
    lines.push("【上一份压缩摘要】", previousSummary.trim(), "");
  }
  for (const m of messages) {
    if (m.role === "system") continue;
    let body = (m.content ?? "").trim();
    if (body.length > COMPACTION_SOURCE_CHAR_CAP) {
      body = `${body.slice(0, COMPACTION_SOURCE_CHAR_CAP)}\n…（本条已截断，原文更长）`;
    }
    if (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0) {
      const calls = (m.toolCalls ?? []).map((c) => `${c.name}(${JSON.stringify(c.args ?? {})})`).join("、");
      lines.push(`assistant（调用了 ${calls}）：${body}`);
      continue;
    }
    if (m.role === "tool") {
      lines.push(`tool 结果（${m.toolCallId ?? "-"}）：${body}`);
      continue;
    }
    lines.push(`${m.role}：${body}`);
  }
  return lines.join("\n").trim();
}

/** 让压缩器做的事。单独导出是为了让"压缩提示词"只有一个地方改。 */
export const COMPACTION_INSTRUCTION =
  "把下面这段被截断的对话压缩成**可续用的上下文**。硬性要求：\n" +
  "1. 保留已经确认的事实（读到的文件内容、跑过的命令与它们的输出结论、被拒的动作与理由）；\n" +
  "2. 保留还没做完的事与当前的进展；\n" +
  "3. 丢掉寒暄、重复尝试与被放弃的路线；\n" +
  "4. **不要**编造没出现过的内容，也不要给新的建议 —— 只总结已经发生的事；\n" +
  "5. 用中文，控制在 800 字以内，直接给正文，不要任何前后缀。";

export const COMPACTED_PREFIX = "【历史压缩摘要】";

/** 压完之后的消息序列：system + 一条摘要 + 尾部。 */
export function buildCompactedMessages(
  system: ChatMessage | undefined,
  summary: string,
  tail: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push(system);
  const text = summary.trim();
  out.push({ role: "assistant", content: `${COMPACTED_PREFIX}\n${text}` });
  out.push(...tail.map((m) => ({ ...m })));
  return out;
}

/** 压缩后转录里那一条系统说明（"为什么正文忽然少了"必须能在界面上被看见）。 */
export function compactionNote(dropped: number, before: number, after: number): string {
  return `已压缩 ${dropped} 条历史消息（上下文约 ${before} → ${after} tokens）；被压掉的部分以摘要续用，原文仍在本会话的转录里。`;
}
