import { describe, expect, it } from "vitest";
import { createAnthropicStreamReader, createOpenAiStreamReader, createSseDecoder } from "../shared/sse";

/**
 * 流式读取层。
 *
 * 这一层的失败方式很隐蔽：切分错一个 chunk 边界，表现是"模型偶尔不回话"；
 * 工具碎片少拼一段参数，表现是"模型调用失败"而不是"解析器坏了"。所以用例按
 * **网络真实的坏形状**写（半行、跨块、心跳注释、坏帧），不按"理想 SSE"写。
 */

describe("createSseDecoder", () => {
  it("切出完整事件，一条 data 一次", () => {
    const d = createSseDecoder();
    expect(d.push('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("跨 chunk 边界也能拼回一条事件（字段名被切开）", () => {
    const d = createSseDecoder();
    // 前半个 chunk 停在 `dat`，甚至连换行都没有：真实网络就是这样切的。
    expect(d.push("da")).toEqual([]);
    expect(d.push('ta: {"a"')).toEqual([]);
    expect(d.push(":1}\n")).toEqual([]);
    // 只有空行才算事件结束：没有收尾空行时一个字都不能交出去。
    expect(d.push("\n")).toEqual(['{"a":1}']);
  });

  it("\\r\\n 行尾与 \\n 等价（有的代理会改写）", () => {
    const d = createSseDecoder();
    expect(d.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it("多行 data 按 SSE 规范用 \\n 连接", () => {
    const d = createSseDecoder();
    expect(d.push("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("注释行（心跳）与 event/id 字段不进数据", () => {
    const d = createSseDecoder();
    expect(d.push(': keep-alive\n\nid: 7\nevent: ping\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("`data:` 后最多只剥一个空格（其余是内容）", () => {
    const d = createSseDecoder();
    expect(d.push("data:  two\n\n")).toEqual([" two"]);
    expect(d.push("data:x\n\n")).toEqual(["x"]);
  });

  it("flush 交出没有空行收尾的最后一条", () => {
    const d = createSseDecoder();
    expect(d.push('data: {"a":1}\n')).toEqual([]);
    expect(d.flush()).toEqual(['{"a":1}']);
  });

  it("flush 之后不重复交出（buffer 已清空）", () => {
    const d = createSseDecoder();
    d.push('data: {"a":1}');
    expect(d.flush()).toEqual(['{"a":1}']);
    expect(d.flush()).toEqual([]);
  });

  it("空输入 flush 不产生空事件", () => {
    const d = createSseDecoder();
    expect(d.flush()).toEqual([]);
    // 只有空行、没有任何 data：也不能冒出一条 "" 事件。
    expect(d.push("\n\n")).toEqual([]);
    expect(d.flush()).toEqual([]);
  });
});

describe("createOpenAiStreamReader", () => {
  it("正文增量逐条返回，全文在 finish 里拼好", () => {
    const r = createOpenAiStreamReader();
    const chunk = (content: string): string =>
      JSON.stringify({ choices: [{ delta: { content } }] });
    expect(r.pushData(chunk("你"))).toBe("你");
    expect(r.pushData(chunk("好"))).toBe("好");
    const out = r.finish();
    expect(out.text).toBe("你好");
    expect(out.reasoning).toBe("");
    expect(out.toolCalls).toEqual([]);
    expect(out.problems).toEqual([]);
  });

  it("首块只有 role 时不当作增量（返回 null）", () => {
    const r = createOpenAiStreamReader();
    expect(r.pushData(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }))).toBe(null);
    expect(r.pushData(JSON.stringify({ choices: [{ delta: { content: "" } }] }))).toBe(null);
    expect(r.finish().text).toBe("");
  });

  it("`[DONE]` 是终止标记，不是内容", () => {
    const r = createOpenAiStreamReader();
    expect(r.pushData("[DONE]")).toBe(null);
    expect(r.finish().text).toBe("");
    expect(r.finish().problems).toEqual([]);
  });

  it("坏帧进 problems 而不是抛异常", () => {
    const r = createOpenAiStreamReader();
    expect(r.pushData("{not json")).toBe(null);
    const out = r.finish();
    expect(out.text).toBe("");
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain("不是合法 JSON");
  });

  it("usage / finish_reason 只在端点给了才出现", () => {
    const r = createOpenAiStreamReader();
    r.pushData(JSON.stringify({ choices: [{ delta: { content: "x" } }], usage: { total_tokens: 12 } }));
    r.pushData(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    const out = r.finish();
    expect(out.usageTokens).toBe(12);
    expect(out.finishReason).toBe("stop");
  });

  it("reasoning_content 单独攒起来（推理模型把答案放这里）", () => {
    const r = createOpenAiStreamReader();
    expect(r.pushData(JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] }))).toBe(null);
    r.pushData(JSON.stringify({ choices: [{ delta: { reasoning_content: "好了" } }] }));
    const out = r.finish();
    expect(out.reasoning).toBe("想好了");
    expect(out.text).toBe("");
  });

  it("工具调用按 index 聚合：名字一块、参数分两块", () => {
    const r = createOpenAiStreamReader();
    r.pushData(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }] } }],
      }),
    );
    r.pushData(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] }));
    const out = r.finish();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toEqual({ id: "call_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' });
  });

  it("多个工具调用按首次出现顺序排列（不是 index 数值序）", () => {
    const r = createOpenAiStreamReader();
    r.pushData(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 2, function: { name: "b" } }] } }] }));
    r.pushData(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "a" } }] } }] }));
    const out = r.finish();
    expect(out.toolCalls.map((c) => c.name)).toEqual(["b", "a"]);
  });

  it("缺 index 的碎片归到 0", () => {
    const r = createOpenAiStreamReader();
    r.pushData(JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "x" } }] } }] }));
    const out = r.finish();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe("x");
    expect(out.toolCalls[0].argumentsJson).toBe("");
  });

  it("choices 为空 / 缺 delta 时不炸也不产生增量", () => {
    const r = createOpenAiStreamReader();
    expect(r.pushData(JSON.stringify({ choices: [] }))).toBe(null);
    expect(r.pushData(JSON.stringify({ choices: [{ finish_reason: "stop" }] }))).toBe(null);
    expect(r.pushData(JSON.stringify({}))).toBe(null);
    expect(r.finish().text).toBe("");
  });
});

describe("createAnthropicStreamReader", () => {
  it("正文来自 content_block_delta.text_delta", () => {
    const r = createAnthropicStreamReader();
    expect(r.pushData(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }))).toBe("hi");
    expect(r.pushData(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "" } }))).toBe(null);
    expect(r.finish().text).toBe("hi");
  });

  it("usage 是 input + output 两段相加", () => {
    const r = createAnthropicStreamReader();
    expect(r.pushData(JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 30 } } }))).toBe(null);
    expect(r.pushData(JSON.stringify({ type: "message_delta", usage: { output_tokens: 12 } }))).toBe(null);
    expect(r.finish().usageTokens).toBe(42);
  });

  it("没有任何 usage 时不给 usageTokens 字段（缺席 ≠ 0）", () => {
    const r = createAnthropicStreamReader();
    r.pushData(JSON.stringify({ type: "message_start", message: {} }));
    expect("usageTokens" in r.finish()).toBe(false);
  });

  it("tool_use：start 给 id/name，input_json_delta 分片拼参数", () => {
    const r = createAnthropicStreamReader();
    r.pushData(
      JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "run_command" },
      }),
    );
    r.pushData(JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd":' } }));
    r.pushData(JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } }));
    const out = r.finish();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toEqual({ id: "toolu_1", name: "run_command", argumentsJson: '{"cmd":"ls"}' });
  });

  it("start 里直接给完整 input 时当预填参数（少数实现不发 delta）", () => {
    const r = createAnthropicStreamReader();
    r.pushData(
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "x", input: { path: "a.ts" } },
      }),
    );
    expect(r.finish().toolCalls[0].argumentsJson).toBe('{"path":"a.ts"}');
  });

  it("空的 / 非对象的 input 不预填（{} 会被当成已拼好的参数）", () => {
    const r = createAnthropicStreamReader();
    r.pushData(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "a", input: {} } }));
    r.pushData(JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "b", input: [1] } }));
    const out = r.finish();
    expect(out.toolCalls.map((c) => c.argumentsJson)).toEqual(["", ""]);
  });

  it("input_json_delta 找不到对应 tool_use 时既不炸也不凭空造调用", () => {
    const r = createAnthropicStreamReader();
    r.pushData(JSON.stringify({ type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }));
    expect(r.finish().toolCalls).toEqual([]);
  });

  it("非 tool_use 块的 start（text/thinking）不产生工具调用", () => {
    const r = createAnthropicStreamReader();
    r.pushData(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    // 少写这一条，`content_block_start && tool_use` 里的 && 改成 || 也测不出来：
    // 下游会丢掉没名字的块，但聚合层已经凭空长出一条"空调用"。
    expect(r.finish().toolCalls).toEqual([]);
  });

  it("缺 partial_json 的增量不把字面量 undefined 拼进参数", () => {
    const r = createAnthropicStreamReader();
    r.pushData(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "x" } }));
    // 只有 type、没有 partial_json 的畸形增量：按"空"处理，否则拼出来的是
    // `...undefined` —— 到 JSON.parse 才炸，报错点离病因很远。
    r.pushData(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } }));
    const out = r.finish();
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].argumentsJson).toBe("");
  });

  it("坏帧进 problems", () => {
    const r = createAnthropicStreamReader();
    expect(r.pushData("oops")).toBe(null);
    const out = r.finish();
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain("不是合法 JSON");
  });
});
