/**
 * 流式（SSE）读取层的**纯**逻辑：切分事件、聚合增量、拼回工具调用。
 *
 * 为什么单独一层：
 *   1. 端点形状是两个流派（OpenAI 的 `choices[].delta` 与 Anthropic 的
 *      `content_block_delta`），而**下游只认一种结果**（正文 + ToolCall）——
 *      与文本协议那层同一个理由：能力不绑在"端点恰好怎么流"上。
 *   2. 切分必须能跨 chunk 边界：一个 `data:` 行会被网络任意切开（字段名一半在
 *      这个 chunk、JSON 一半在下一个），按 chunk 直接 JSON.parse 的写法在真实
 *      网络上必然偶发失败，而这种失败看起来像"模型偶尔不回话"。
 *   3. 纯函数才测得动：喂合成 SSE 文本比起一个会分片的假端点便宜得多。
 *
 * 本模块不抛异常：坏帧进 `problems`，由调用方决定是"整段退回"还是"报错"。
 * 流里已经吐出去的正文收不回来 —— 所以"已经看到字之后"的处置与"一个字都没看到"
 * 必须分开，那属于调用方的判断，不属于解析器。
 */

/** 一条工具调用的原始碎片（参数是**增量字符串**，拼完才 JSON.parse）。 */
export interface RawToolCallFragment {
  id?: string;
  name?: string;
  argumentsJson: string;
}

/** SSE 事件切分器：喂任意切分的文本，吐出完整事件（每条是合并后的 `data`）。 */
export interface SseDecoder {
  push(chunk: string): string[];
  /** 连接结束时调用：把没有以空行收尾的最后一条事件也交出来。 */
  flush(): string[];
}

/**
 * SSE 切分。
 *
 * 只认 `data:` 字段（`event:` / `id:` / `retry:` 对聚合没有意义），注释行
 * （`:` 开头，常用作心跳）直接忽略；一个事件的多行 `data:` 按 SSE 规范用
 * `\n` 连接。`\r\n` 与 `\n` 都算行尾 —— 有的代理会改写行尾。
 */
export function createSseDecoder(): SseDecoder {
  let buffer = "";
  let data: string[] = [];

  const dispatch = (out: string[]): void => {
    if (data.length > 0) out.push(data.join("\n"));
    data = [];
  };

  const feedLine = (line: string, out: string[]): void => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text === "") {
      dispatch(out);
      return;
    }
    if (text.startsWith(":")) return;
    if (!text.startsWith("data:")) return;
    const value = text.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        feedLine(line, out);
      }
      return out;
    },
    flush(): string[] {
      const out: string[] = [];
      if (buffer !== "") {
        feedLine(buffer, out);
        buffer = "";
      }
      dispatch(out);
      return out;
    },
  };
}

export interface OpenAiStreamResult {
  /** 正文增量拼起来的全文。 */
  text: string;
  /** `reasoning_content` 拼起来的全文（推理模型把答案放这里时用它兜底）。 */
  reasoning: string;
  /** 按 `index` 聚合后的工具调用碎片，顺序即首次出现的顺序。 */
  toolCalls: RawToolCallFragment[];
  /** 终点块里带的 usage（不少兼容端点不发，缺席 = 端点没给）。 */
  usageTokens?: number;
  finishReason?: string;
  /** 解析不了的帧（空正文时调用方据此判"这条流根本没通"）。 */
  problems: string[];
}

/** OpenAI 兼容流的聚合器。`pushData` 返回本条增量的正文（没有正文返回 null）。 */
export interface OpenAiStreamReader {
  pushData(data: string): string | null;
  finish(): OpenAiStreamResult;
}

/**
 * OpenAI 兼容的流式块：
 *   `{"choices":[{"delta":{"content":"…"}}]}`  —— 正文增量
 *   `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"…","function":{"name":"…","arguments":"{\"pa"}}]}}]}`
 *   `{"choices":[{"finish_reason":"stop"}]}` / `data: [DONE]`
 *
 * 工具调用按 `index` 聚合：名字可能只在第一块出现，参数是**逐段拼接的字符串**
 * （`{"pa` + `th":"a.ts"}`），不拼就 JSON.parse 必然失败。
 */
export function createOpenAiStreamReader(): OpenAiStreamReader {
  const state = { text: "", reasoning: "", usageTokens: undefined as number | undefined, finishReason: undefined as string | undefined, problems: [] as string[] };
  const calls = new Map<number, RawToolCallFragment>();
  const order: number[] = [];

  return {
    pushData(data: string): string | null {
      if (data.trim() === "[DONE]") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        state.problems.push(`流式块不是合法 JSON（已跳过）：${data.slice(0, 120)}`);
        return null;
      }
      const payload = parsed as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { total_tokens?: number };
      };
      if (payload.usage?.total_tokens !== undefined) state.usageTokens = payload.usage.total_tokens;
      const choice = payload.choices?.[0];
      if (!choice) return null;
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
        state.reasoning += delta.reasoning_content;
      }
      for (const raw of delta.tool_calls ?? []) {
        const index = typeof raw.index === "number" ? raw.index : 0;
        let frag = calls.get(index);
        if (!frag) {
          frag = { argumentsJson: "" };
          calls.set(index, frag);
          order.push(index);
        }
        if (raw.id !== undefined) frag.id = raw.id;
        if (raw.function?.name !== undefined) frag.name = raw.function.name;
        if (raw.function?.arguments !== undefined) frag.argumentsJson += raw.function.arguments;
      }
      const text = typeof delta.content === "string" ? delta.content : "";
      if (text === "") return null;
      state.text += text;
      return text;
    },
    finish(): OpenAiStreamResult {
      const toolCalls: RawToolCallFragment[] = [];
      for (const index of order) {
        const frag = calls.get(index);
        if (frag) toolCalls.push(frag);
      }
      return {
        text: state.text,
        reasoning: state.reasoning,
        toolCalls,
        ...(state.usageTokens !== undefined ? { usageTokens: state.usageTokens } : {}),
        ...(state.finishReason !== undefined ? { finishReason: state.finishReason } : {}),
        problems: state.problems,
      };
    },
  };
}

export interface AnthropicStreamResult {
  text: string;
  toolCalls: RawToolCallFragment[];
  usageTokens?: number;
  problems: string[];
}

/** Anthropic 流的聚合器。`pushData` 返回本条增量的正文（没有正文返回 null）。 */
export interface AnthropicStreamReader {
  pushData(data: string): string | null;
  finish(): AnthropicStreamResult;
}

/**
 * Anthropic 的事件流（每条 `data:` 都是一个带 `type` 的事件）：
 *   `message_start` → `message.usage.input_tokens`
 *   `content_block_start`（`tool_use`）→ id/name
 *   `content_block_delta` → `text_delta.text` 或 `input_json_delta.partial_json`
 *   `message_delta` → `usage.output_tokens` / `delta.stop_reason`
 *   `message_stop`
 *
 * 工具入参在流里同样是**增量 JSON 字符串**，按 `index` 拼到对应调用上。
 */
export function createAnthropicStreamReader(): AnthropicStreamReader {
  const state = { text: "", inputTokens: 0, outputTokens: 0, problems: [] as string[] };
  const calls = new Map<number, RawToolCallFragment>();
  const order: number[] = [];

  return {
    pushData(data: string): string | null {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        state.problems.push(`流式块不是合法 JSON（已跳过）：${data.slice(0, 120)}`);
        return null;
      }
      const e = event as {
        type?: string;
        index?: number;
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        delta?: { type?: string; text?: string; partial_json?: string };
      };
      if (e.type === "message_start") {
        const n = e.message?.usage?.input_tokens;
        if (typeof n === "number") state.inputTokens = n;
        return null;
      }
      if (e.type === "message_delta") {
        const n = e.usage?.output_tokens;
        if (typeof n === "number") state.outputTokens = n;
        return null;
      }
      if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
        const index = typeof e.index === "number" ? e.index : 0;
        if (!calls.has(index)) order.push(index);
        // 少数实现会在 start 里直接给完整 input（不发 input_json_delta）：
        // 非空对象就当已拼好的参数收下，后续增量继续往后接。
        const input = e.content_block.input;
        const prefill =
          input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0
            ? JSON.stringify(input)
            : "";
        calls.set(index, {
          ...(e.content_block.id !== undefined ? { id: e.content_block.id } : {}),
          ...(e.content_block.name !== undefined ? { name: e.content_block.name } : {}),
          argumentsJson: prefill,
        });
        return null;
      }
      if (e.type === "content_block_delta") {
        const delta = e.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          state.text += delta.text;
          return delta.text;
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const index = typeof e.index === "number" ? e.index : 0;
          const frag = calls.get(index);
          if (frag) frag.argumentsJson += delta.partial_json;
        }
      }
      return null;
    },
    finish(): AnthropicStreamResult {
      const total = state.inputTokens + state.outputTokens;
      const toolCalls: RawToolCallFragment[] = [];
      for (const index of order) {
        const frag = calls.get(index);
        if (frag) toolCalls.push(frag);
      }
      return {
        text: state.text,
        toolCalls,
        ...(total > 0 ? { usageTokens: total } : {}),
        problems: state.problems,
      };
    },
  };
}
