import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_CALLS_PER_TURN,
  TOOL_NAMES,
  TOOL_SPECS,
  TOOL_OUTPUT_MAX_CHARS,
  isToolName,
  toolSpecOf,
  truncateToolOutput,
  validateArgsAgainstSpec,
  validateToolArgs,
  type ToolSpec,
  type ToolResult,
} from "../shared/tools/spec";
import {
  parseToolTurn,
  toolCatalogBlock,
  toolResultBlock,
  extractToolBlocks,
} from "../shared/tools/protocol";
import {
  applyFileOp,
  applyHunks,
  describePatchOps,
  parsePatch,
} from "../shared/tools/patch";
import {
  assertKnownTool,
  baseNameOf,
  decideTool,
  describeSandbox,
  isApprovalPolicy,
  isSandboxMode,
  toolRisk,
} from "../shared/tools/policy";
import {
  describeToolCall,
  describeToolResult,
  messagesForProtocol,
  summarizeTranscript,
  type ChatTranscript,
} from "../shared/chat-events";
import {
  parseAnthropicToolCalls,
  parseOpenAiToolCalls,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAiMessages,
  toOpenAiTools,
} from "../shared/http-clients";
import type { ChatMessage } from "../shared/providers";

describe("通用参数校验（validateArgsAgainstSpec）", () => {
  const spec: ToolSpec = {
    name: "read_file",
    description: "synthetic",
    parameters: {
      type: "object",
      properties: {
        flag: { type: "boolean", description: "开关" },
        items: { type: "array", items: { type: "string" }, description: "列表" },
      },
      required: ["flag"],
      additionalProperties: false,
    },
  };

  it("boolean 分支：缺必填 / 类型不对 / 合法值", () => {
    expect(validateArgsAgainstSpec("synthetic", spec, {})).toContain("缺少必填参数");
    expect(validateArgsAgainstSpec("synthetic", spec, { flag: "yes" })).toContain("必须是布尔值");
    expect(validateArgsAgainstSpec("synthetic", spec, { flag: true })).toBeNull();
  });

  it("array 分支：非数组 / 元素类型不对 / 合法值", () => {
    expect(validateArgsAgainstSpec("synthetic", spec, { flag: true, items: "x" })).toContain("必须是数组");
    expect(validateArgsAgainstSpec("synthetic", spec, { flag: true, items: [1] })).toContain("字符串数组");
    expect(validateArgsAgainstSpec("synthetic", spec, { flag: true, items: ["a"] })).toBeNull();
  });
});

describe("跨协议恢复（messagesForProtocol）", () => {
  it("恢复为 text 协议：原生 toolCalls 不发给不支持 tools 的端点，tool 消息降级为 user", () => {
    const messages = [
      { role: "user" as const, content: "读文件" },
      { role: "assistant" as const, content: "先看", toolCalls: [{ id: "t-1", name: "read_file" as const, args: { path: "a.ts" } }] },
      { role: "tool" as const, content: "文件内容", toolCallId: "t-1" },
    ];
    const out = messagesForProtocol(messages, "text");
    expect(out.some((m) => (m as { toolCalls?: unknown }).toolCalls !== undefined)).toBe(false);
    expect(out.find((m) => m.role === "assistant")?.content).toBe("先看");
    expect(out.find((m) => m.role === "user" && m.content.includes("文件内容"))).toBeTruthy();
    // 原数组不被修改
    expect(messages[1].content).toBe("先看");
  });

  it("恢复为 native 协议：逐条保留 toolCalls 与 tool 消息", () => {
    const messages = [
      { role: "assistant" as const, content: "先看", toolCalls: [{ id: "t-1", name: "read_file" as const, args: { path: "a.ts" } }] },
      { role: "tool" as const, content: "文件内容", toolCallId: "t-1" },
    ];
    const out = messagesForProtocol(messages, "native");
    expect(out).toHaveLength(2);
    expect(out[0]?.toolCalls?.[0]?.id).toBe("t-1");
    expect(out[1]?.role).toBe("tool");
  });

  it("tool 消息不是最后一条时，后续消息必须继续处理（continue 不是 break）", () => {
    const out = messagesForProtocol(
      [
        { role: "tool" as const, content: "工具结果", toolCallId: "t-1" },
        { role: "user" as const, content: "下一句" },
      ],
      "text",
    );
    expect(out).toHaveLength(2);
    expect(out[1]?.content).toBe("下一句");
  });

  it("非 assistant 消息带 toolCalls 时原样保留；空 toolCalls 的 assistant 不被吞掉", () => {
    const userWithCalls = {
      role: "user" as const,
      content: "原样",
      toolCalls: [{ id: "x", name: "read_file" as const, args: {} }],
    };
    const emptyAssistant = { role: "assistant" as const, content: "", toolCalls: [] };
    const out = messagesForProtocol([userWithCalls, emptyAssistant], "text");
    expect(out).toHaveLength(2);
    expect(out[0]?.toolCalls).toHaveLength(1);
    expect(out[1]?.role).toBe("assistant");
  });
});

describe("工具契约（spec）", () => {
  it("七个工具名都在册，且 isToolName 拒绝未登记的名字", () => {
    expect(TOOL_NAMES).toEqual([
      "read_file",
      "list_dir",
      "grep_files",
      "find_by_name",
      "apply_patch",
      "run_command",
      "read_skill",
    ]);
    for (const n of TOOL_NAMES) expect(isToolName(n)).toBe(true);
    expect(isToolName("rm_file")).toBe(false);
    expect(isToolName(42)).toBe(false);
  });

  it("每个工具的 spec 都声明了必填参数且能取回", () => {
    for (const n of TOOL_NAMES) {
      const spec = toolSpecOf(n);
      expect(spec.name).toBe(n);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("未登记的工具名取 spec 会抛错（而不是返回一个空声明）", () => {
    expect(() => toolSpecOf("nope" as never)).toThrow(/unknown tool/);
  });

  it("参数校验：缺必填 / 类型不对 / 多余参数，都给出可回灌的理由", () => {
    expect(validateToolArgs("read_file", {})).toMatch(/缺少必填参数/);
    expect(validateToolArgs("read_file", { path: 1 })).toMatch(/必须是字符串/);
    expect(validateToolArgs("read_file", { path: "a.ts", extra: 1 })).toMatch(/不接受参数/);
    expect(validateToolArgs("run_command", { command: "npm", args: [1] })).toMatch(/字符串数组/);
    expect(validateToolArgs("read_file", { path: "a.ts" })).toBeNull();
    expect(validateToolArgs("read_file", "x")).toMatch(/必须是一个对象/);
  });

  it("read_skill 的参数契约：name 必填字符串，多余参数拒绝（工具描述里点名了「停用会被拒绝」）", () => {
    expect(validateToolArgs("read_skill", {})).toMatch(/缺少必填参数.*name/);
    expect(validateToolArgs("read_skill", { name: 42 })).toMatch(/必须是字符串/);
    expect(validateToolArgs("read_skill", { name: "deploy", full: true })).toMatch(/不接受参数/);
    expect(validateToolArgs("read_skill", { name: "deploy" })).toBeNull();
    const spec = toolSpecOf("read_skill");
    expect(spec.description).toContain("停用的技能会被拒绝");
  });

  it("参数校验的几条边界：null 必填、undefined 键后的坏键、number 与字符串数组各走各的", () => {
    // null 也是"没给"：只查 undefined 会让 null 一路漏到执行层。
    expect(validateToolArgs("read_file", { path: null })).toMatch(/缺少必填参数/);
    // 值为 undefined 的键跳过之后，后面的键照查 —— 跳过不等于收工。
    expect(validateToolArgs("read_file", { path: "a.ts", a: undefined, b: 1 })).toMatch(/不接受参数：b/);
    // number 参数：给数字放行、给字符串报错（两个方向都得钉）。
    expect(validateToolArgs("grep_files", { pattern: "x", maxMatches: 10 })).toBeNull();
    expect(validateToolArgs("grep_files", { pattern: "x", maxMatches: "10" })).toMatch(/必须是数字/);
    // 合法的字符串数组要真的放行：items 约束在就不该误报。
    expect(validateToolArgs("run_command", { command: "npm", args: ["test"] })).toBeNull();
  });

  it("截断保留尾部并说破原文长度", () => {
    const longText = "x".repeat(50);
    const short = truncateToolOutput(longText, 100);
    expect(short.truncatedFrom).toBeUndefined();
    expect(short.text).toBe(longText);
    const cut = truncateToolOutput(longText, 10);
    expect(cut.truncatedFrom).toBe(50);
    expect(cut.text).toMatch(/已截断，原文 50 字符/);
    // 保留尾部而不是头部：命令的失败结论总在最后几行。
    expect(cut.text.endsWith("x".repeat(10))).toBe(true);
  });

  it("默认截断上限就是导出常量（改常量时测试会跟着响）", () => {
    expect(truncateToolOutput("y".repeat(TOOL_OUTPUT_MAX_CHARS + 1)).truncatedFrom).toBe(
      TOOL_OUTPUT_MAX_CHARS + 1,
    );
  });
});

describe("文本协议（protocol）", () => {
  it("围栏块与 XML 标签两种写法都能抠出来", () => {
    const text = "先看一眼\n```tool\n{\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```\n收尾";
    expect(extractToolBlocks(text)).toHaveLength(1);
    expect(extractToolBlocks("<tool_call>{}</tool_call>")).toHaveLength(1);
    expect(extractToolBlocks("没有块")).toHaveLength(0);
  });

  it("单个调用块 → 一个 ToolCall，块外正文保留", () => {
    const parsed = parseToolTurn("说明一下\n```tool\n{\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```");
    expect(parsed.calls).toEqual([{ id: "t-1", name: "read_file", args: { path: "a.ts" } }]);
    expect(parsed.text).toBe("说明一下");
    expect(parsed.problems).toEqual([]);
  });

  it("数组块 → 多个调用，id 递增", () => {
    const parsed = parseToolTurn(
      "```tool\n[{\"tool\":\"list_dir\",\"arguments\":{}},{\"tool\":\"read_file\",\"arguments\":{\"path\":\"b.ts\"}}]\n```",
    );
    expect(parsed.calls.map((c) => c.name)).toEqual(["list_dir", "read_file"]);
    expect(parsed.calls.map((c) => c.id)).toEqual(["t-1", "t-2"]);
  });

  it("非法 JSON / 未登记工具名 / 参数不合法 → 进 problems 而不是静默丢掉", () => {
    expect(parseToolTurn("```tool\n{不是json}\n```").problems[0]).toMatch(/不是合法 JSON/);
    expect(parseToolTurn("```tool\n{\"tool\":\"rm_rf\",\"arguments\":{}}\n```").problems[0]).toMatch(/未登记的工具名/);
    expect(parseToolTurn("```tool\n{\"tool\":\"read_file\",\"arguments\":{}}\n```").problems[0]).toMatch(/缺少必填参数/);
  });

  it("坏元素被逐条说破，同一行里后面的好调用照常执行（跳过不等于收工）", () => {
    const notJson = parseToolTurn(
      "```tool\n{不是json}\n```\n```tool\n{\"tool\":\"list_dir\",\"arguments\":{}}\n```",
    );
    expect(notJson.problems[0]).toMatch(/不是合法 JSON/);
    expect(notJson.calls.map((c) => c.name)).toEqual(["list_dir"]);

    const notObj = parseToolTurn("```tool\n[null, {\"tool\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}]\n```");
    expect(notObj.problems[0]).toMatch(/工具调用不是对象/);
    expect(notObj.calls).toEqual([{ id: "t-1", name: "read_file", args: { path: "a.ts" } }]);

    const badName = parseToolTurn("```tool\n[{\"tool\":\"rm_rf\",\"arguments\":{}},{\"tool\":\"list_dir\",\"arguments\":{}}]\n```");
    expect(badName.problems[0]).toMatch(/未登记的工具名/);
    expect(badName.calls.map((c) => c.name)).toEqual(["list_dir"]);

    const badArgs = parseToolTurn("```tool\n[{\"tool\":\"read_file\",\"arguments\":{}},{\"tool\":\"list_dir\",\"arguments\":{}}]\n```");
    expect(badArgs.problems[0]).toMatch(/缺少必填参数/);
    expect(badArgs.calls.map((c) => c.name)).toEqual(["list_dir"]);
  });

  it("一轮超过上限时只执行前 N 个，并把丢弃说破", () => {
    const many = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, () =>
      JSON.stringify({ tool: "list_dir", arguments: {} }),
    ).join(",");
    const parsed = parseToolTurn(`\`\`\`tool\n[${many}]\n\`\`\``);
    expect(parsed.calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(parsed.problems[0]).toMatch(/只执行前/);
  });

  it("工具目录块只列出开放的工具，且写清输出形状", () => {
    const block = toolCatalogBlock(["read_file"]);
    expect(block).toMatch(/read_file/);
    expect(block).not.toMatch(/run_command/);
    expect(block).toMatch(/```tool/);
  });

  it("目录块把必填与可选参数标清楚（不靠模型猜）", () => {
    const block = toolCatalogBlock(["read_file", "grep_files"]);
    expect(block).toMatch(/path（string，必填）/);
    expect(block).toMatch(/path（string，可选）/);
    expect(block).toMatch(/maxMatches（number，可选）/);
  });

  it("结果回灌带上 id、成功标记与失败理由", () => {
    const ok: ToolResult = { id: "t-1", name: "read_file", ok: true, output: "1: hello" };
    const bad: ToolResult = { id: "t-2", name: "run_command", ok: false, output: "", reason: "命令被沙箱禁止：rm" };
    const text = toolResultBlock([ok, bad], ["某块解析失败"]);
    expect(text).toMatch(/\[t-1\] read_file 成功/);
    expect(text).toMatch(/命令被沙箱禁止：rm/);
    expect(text).toMatch(/解析问题：某块解析失败/);
  });

  it("结果回灌：空输出不占位，非空输出原样带上", () => {
    const text = toolResultBlock([
      { id: "t-1", name: "read_file", ok: true, output: "1: hello" },
      { id: "t-2", name: "list_dir", ok: true, output: "   " },
    ]);
    expect(text).toBe("工具结果：\n[t-1] read_file 成功\n1: hello\n[t-2] list_dir 成功");
  });
});

describe("补丁解析与应用（patch）", () => {
  it("缺少 Begin/End 包裹时报解析错", () => {
    expect(parsePatch("*** Update File: a.ts\n-x\n+y")).toEqual({ error: expect.stringMatching(/缺少/) });
  });

  it("三种文件段都能解析", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: new.ts",
        "+export const a = 1;",
        "*** Update File: old.ts",
        "@@ ",
        " const keep = 1;",
        "-const drop = 2;",
        "+const added = 2;",
        "*** Delete File: gone.ts",
        "*** End Patch",
      ].join("\n"),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.ops.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
    expect(describePatchOps(parsed.ops)).toBe("新建 1、修改 1、删除 1");
  });

  it("Move File 明确不支持（而不是被当成 Add 静默处理）", () => {
    const parsed = parsePatch("*** Begin Patch\n*** Move File: a -> b\n*** End Patch");
    expect(parsed).toEqual({ error: expect.stringMatching(/Move File/) });
  });

  it("Update 段没有改动行 → 报错", () => {
    const parsed = parsePatch("*** Begin Patch\n*** Update File: a.ts\n*** End Patch");
    expect(parsed).toEqual({ error: expect.stringMatching(/没有任何文件段|没有任何改动行/) });
  });

  it("按上下文替换：只动该动的行，其余原样保留", () => {
    const outcome = applyHunks("const a = 1;\nconst b = 2;\nconst c = 3;\n", [
      { lines: [
        { kind: "context", text: "const b = 2;" },
        { kind: "del", text: "const c = 3;" },
        { kind: "add", text: "const c = 4;" },
      ] },
    ]);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("const a = 1;\nconst b = 2;\nconst c = 4;\n");
  });

  it("上下文对不上就失败并说破在第几块、首行是什么（绝不模糊匹配）", () => {
    const outcome = applyHunks("const a = 1;\n", [
      { lines: [
        { kind: "context", text: "const zzz = 9;" },
        { kind: "add", text: "const b = 2;" },
      ] },
    ]);
    expect(outcome).toEqual({ error: expect.stringMatching(/第 1 个改动块的上下文在文件里找不到/) });
  });

  it("无上下文的纯新增：追加到末尾并把这件事说破", () => {
    const outcome = applyHunks("line1\n", [{ lines: [{ kind: "add", text: "line2" }] }]);
    if ("error" in outcome) throw new Error(outcome.error);
    // 原文件以换行结尾：新行插在结尾换行之前，得到 "line1\nline2\n"，
    // 而不是多出一个空行（旧实现的 "line1\n\nline2" 是错的）。
    expect(outcome.content).toBe("line1\nline2\n");
    expect(outcome.notes[0]).toMatch(/追加到文件末尾/);
  });

  it("多个 hunk 顺序推进：相同文本不会被回头改到第一处", () => {
    const outcome = applyHunks("dup\ndup\n", [
      { lines: [{ kind: "context", text: "dup" }, { kind: "add", text: "one" }] },
      { lines: [{ kind: "context", text: "dup" }, { kind: "add", text: "two" }] },
    ]);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("dup\none\ndup\ntwo\n");
  });

  it("Add 段的多行按换行拼接：首行不多空行、后续行不丢分隔", () => {
    const parsed = parsePatch(["*** Begin Patch", "*** Add File: new.ts", "+line1", "+line2", "*** End Patch"].join("\n"));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.ops[0]).toMatchObject({ kind: "add", path: "new.ts", content: "line1\nline2" });
  });

  it("Delete 段体里的行被跳过，后面的文件段照样解析（跳过不等于收工）", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Delete File: gone.ts",
        " 这行落在 Delete 段体里，不该影响后续段",
        "*** Add File: new.ts",
        "+x",
        "*** End Patch",
      ].join("\n"),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.ops.map((o) => o.kind)).toEqual(["delete", "add"]);
  });

  it("解析出的 Update 补丁真能落盘：收尾时最后一个 hunk 不会被丢", () => {
    const parsed = parsePatch(
      ["*** Begin Patch", "*** Update File: a.ts", "@@ ", " const a = 1;", "-const b = 2;", "+const b = 3;", "*** End Patch"].join("\n"),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const outcome = applyFileOp(parsed.ops[0], "const a = 1;\nconst b = 2;\n");
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("文件段header 后连空行都没有：报错而不是崩（两个边界一起钉）", () => {
    expect(parsePatch("*** Begin Patch*** Update File: a.ts*** End Patch")).toEqual({
      error: expect.stringMatching(/没有任何改动行/),
    });
    expect(parsePatch("*** Begin Patch*** End Patch")).toEqual({
      error: expect.stringMatching(/没有任何文件段/),
    });
  });

  it("多个无上下文新增依次追加：第二个不会被 break 丢下", () => {
    const outcome = applyHunks("line1\n", [
      { lines: [{ kind: "add", text: "line2" }] },
      { lines: [{ kind: "add", text: "line3" }] },
    ]);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("line1\nline2\nline3\n");
    expect(outcome.notes).toHaveLength(2);
  });

  it("非法补丁行报错；空行作为上下文行仍然合法", () => {
    expect(parsePatch("*** Begin Patch\n*** Update File: a\nnot a patch line\n*** End Patch")).toEqual({
      error: expect.stringMatching(/不是合法的补丁行/),
    });
    const withBlank = parsePatch(
      ["*** Begin Patch", "*** Update File: a", "@@ ", " keep", "", "-old", "+new", "*** End Patch"].join("\n"),
    );
    expect("error" in withBlank).toBe(false);
  });

  it("只有 + 或只有 - 的 Update 段都算真改动（不能要求两者同时出现）", () => {
    const addOnly = parsePatch("*** Begin Patch\n*** Update File: a\n+new\n*** End Patch");
    expect("error" in addOnly).toBe(false);
    const delOnly = parsePatch("*** Begin Patch\n*** Update File: a\n-old\n*** End Patch");
    expect("error" in delOnly).toBe(false);
    if ("error" in delOnly) return;
    const out = applyFileOp(delOnly.ops[0], "old\n");
    if ("error" in out) throw new Error(out.error);
    expect(out.content).toBe("");
  });

  it("原文件不以换行结尾时，无上下文追加不丢最后一行、也不添空行", () => {
    const outcome = applyHunks("line1", [{ lines: [{ kind: "add", text: "line2" }] }]);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("line1\nline2");
  });

  it("文件级前置校验：Add 已存在 / Delete 不存在 / Update 不存在都拒绝", () => {
    expect(applyFileOp({ kind: "add", path: "a", content: "x" }, "old")).toEqual({
      error: expect.stringMatching(/已存在/),
    });
    expect(applyFileOp({ kind: "delete", path: "a" }, null)).toEqual({
      error: expect.stringMatching(/文件不存在/),
    });
    expect(applyFileOp({ kind: "update", path: "a", hunks: [] }, null)).toEqual({
      error: expect.stringMatching(/无法修改/),
    });
  });

  it("CRLF 文件也能被正确匹配（不留 CR 残渣）", () => {
    const outcome = applyHunks("a\r\nb\r\n", [
      { lines: [{ kind: "context", text: "b" }, { kind: "add", text: "c" }] },
    ]);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(outcome.content).toBe("a\nb\nc\n");
  });
});

describe("工具裁决（policy）", () => {
  it("风险分档：读是 read，补丁是 write，命令是 exec", () => {
    expect(toolRisk("read_file")).toBe("read");
    expect(toolRisk("apply_patch")).toBe("write");
    expect(toolRisk("run_command")).toBe("exec");
  });

  it("read_skill 与读文件同一风险档：read-only 也放行、任何审批策略都不问", () => {
    // 目录块把技能名给了模型 —— read-only 会话取不到技能全文，等于只读模式被
    // 降成"看得到拿不着"；而它只出正文、不落盘，没有理由让人看见。
    expect(toolRisk("read_skill")).toBe("read");
    expect(decideTool({ tool: "read_skill", mode: "read-only", approvalPolicy: "untrusted" })).toEqual({
      verdict: "allow",
    });
    expect(decideTool({ tool: "read_skill", mode: "workspace-write", approvalPolicy: "untrusted" })).toEqual({
      verdict: "allow",
    });
  });

  it("read-only 档位下写与执行都被拒，且理由区分于‘人拒绝了’", () => {
    expect(decideTool({ tool: "apply_patch", mode: "read-only", approvalPolicy: "never" })).toEqual({
      verdict: "deny",
      reason: expect.stringMatching(/read-only/),
    });
    expect(decideTool({ tool: "run_command", mode: "read-only", approvalPolicy: "never", command: "npm" })).toEqual({
      verdict: "deny",
      reason: expect.stringMatching(/不允许执行命令/),
    });
  });

  it("read-only 下读工具照常放行", () => {
    expect(decideTool({ tool: "read_file", mode: "read-only", approvalPolicy: "untrusted" })).toEqual({
      verdict: "allow",
    });
  });

  it("untrusted：写与执行都要问，且理由说清问的是哪一类", () => {
    const write = decideTool({ tool: "apply_patch", mode: "workspace-write", approvalPolicy: "untrusted" });
    expect(write.verdict).toBe("ask");
    expect(write).toEqual({ verdict: "ask", reason: expect.stringMatching(/写文件/) });
    const exec = decideTool({ tool: "run_command", mode: "workspace-write", approvalPolicy: "untrusted", command: "node" });
    expect(exec.verdict).toBe("ask");
    expect(exec).toEqual({ verdict: "ask", reason: expect.stringMatching(/执行命令/) });
    expect(exec).toEqual({ verdict: "ask", reason: expect.not.stringMatching(/写文件/) });
  });

  it("on-request：只问名单里的命令", () => {
    const base = { tool: "run_command" as const, mode: "workspace-write" as const, approvalPolicy: "on-request" as const };
    expect(decideTool({ ...base, command: "git", approvalCommands: ["git"] }).verdict).toBe("ask");
    expect(decideTool({ ...base, command: "node", approvalCommands: ["git"] }).verdict).toBe("allow");
    expect(decideTool({ ...base, command: "GIT.EXE", approvalCommands: ["git"] }).verdict).toBe("ask");
  });

  it("never：从不询问（档位自己兜底）", () => {
    expect(decideTool({ tool: "apply_patch", mode: "workspace-write", approvalPolicy: "never" }).verdict).toBe("allow");
  });

  it("会话记忆：答过‘本会话不再问’的同类动作不再打扰", () => {
    const input = {
      tool: "run_command" as const,
      mode: "workspace-write" as const,
      approvalPolicy: "untrusted" as const,
      command: "npm",
    };
    expect(decideTool(input).verdict).toBe("ask");
    expect(decideTool({ ...input, sessionApproved: ["cmd:npm"] }).verdict).toBe("allow");
    expect(
      decideTool({ ...input, tool: "apply_patch", sessionApproved: ["tool:apply_patch"] }).verdict,
    ).toBe("allow");
  });

  it("档位与策略的值域判定", () => {
    expect(isSandboxMode("read-only")).toBe(true);
    expect(isSandboxMode("nope")).toBe(false);
    expect(isApprovalPolicy("never")).toBe(true);
    expect(isApprovalPolicy("always")).toBe(false);
  });

  it("档位描述把‘能做什么’与‘问不问’写在一起", () => {
    const text = describeSandbox("workspace-write", "on-request");
    expect(text).toMatch(/可改项目内文件/);
    expect(text).toMatch(/审批：只问审批名单里的命令/);
  });

  it("basename 归一：大小写、扩展名、路径分隔符都不影响比对", () => {
    expect(baseNameOf("C:\\Program Files\\git.exe")).toBe("git");
    expect(baseNameOf("/usr/bin/GIT")).toBe("git");
  });

  it("未知工具名在执行层入口就被挡下", () => {
    expect(assertKnownTool("read_file")).toBe("read_file");
    expect(assertKnownTool("rm -rf")).toBeNull();
  });
});

describe("会话转录（chat-events）", () => {
  const transcript: ChatTranscript = {
    meta: {
      sessionId: "s-1",
      rootAbs: "/repo",
      startedAt: 1,
      updatedAt: 2,
      turns: 3,
      status: "done",
      mode: "workspace-write",
      approvalPolicy: "on-request",
      usageTokens: 120,
    },
    entries: [
      { id: "e1", ts: 1, kind: "user", text: "把 a 改成 b" },
      { id: "e2", ts: 2, kind: "tool_call", text: "读取 a.ts", tool: { id: "t-1", name: "read_file", args: { path: "a.ts" } } },
      { id: "e3", ts: 3, kind: "tool_call", text: "应用补丁", tool: { id: "t-2", name: "apply_patch", args: { patch: "..." } } },
      { id: "e4", ts: 4, kind: "assistant", text: "改好了" },
    ],
  };

  it("摘要给出轮次、工具调用数与涉及路径", () => {
    const s = summarizeTranscript(transcript);
    expect(s.turns).toBe(3);
    expect(s.toolCalls).toBe(2);
    expect(s.changedPaths).toEqual(["a.ts"]);
    expect(s.lastText).toBe("改好了");
  });

  it("lastText 只跟助手文本走：后面的工具条目不覆盖它，空白助手文本也不覆盖", () => {
    const toolAfter: ChatTranscript = {
      ...transcript,
      entries: [
        ...transcript.entries,
        {
          id: "e5",
          ts: 5,
          kind: "tool_call",
          text: "读取 b.ts",
          tool: { id: "t-3", name: "read_file", args: { path: "b.ts" } },
        },
      ],
    };
    expect(summarizeTranscript(toolAfter).lastText).toBe("改好了");
    const blankAfter: ChatTranscript = {
      ...transcript,
      entries: [...transcript.entries, { id: "e6", ts: 6, kind: "assistant", text: "   " }],
    };
    expect(summarizeTranscript(blankAfter).lastText).toBe("改好了");
  });

  it("工具调用与结果各有一行可读摘要", () => {
    expect(describeToolCall({ id: "t-1", name: "run_command", args: { command: "npm", args: ["test"] } })).toBe(
      "执行 npm test",
    );
    expect(describeToolCall({ id: "t-2", name: "grep_files", args: { pattern: "TODO" } })).toBe("检索 TODO");
    // read_skill 也要有人话摘要（落进 default 就会把工具名原样丢给界面）。
    expect(describeToolCall({ id: "t-4", name: "read_skill", args: { name: "deploy" } })).toBe("取技能 deploy");
    expect(describeToolResult({ id: "t-3", name: "read_file", ok: false, output: "", reason: "路径穿越" })).toBe(
      "失败：路径穿越",
    );
  });

  it("结果摘要的省略号只标多行：单行原样、多行取首行加 …，两者都可区分", () => {
    expect(describeToolResult({ id: "t-4", name: "read_file", ok: true, output: "12 bytes" })).toBe("12 bytes");
    expect(describeToolResult({ id: "t-5", name: "read_file", ok: true, output: "第 1 行\n第 2 行\n第 3 行" })).toBe(
      "第 1 行 …",
    );
  });
});

describe("端点侧工具映射（http-clients）", () => {
  it("OpenAI 工具声明带 type:function 三层", () => {
    const tools = toOpenAiTools([TOOL_SPECS[0]]);
    expect(tools[0].type).toBe("function");
    const fn = tools[0].function as { name: string; parameters: { required: string[] } };
    expect(fn.name).toBe("read_file");
    expect(fn.parameters.required).toEqual(["path"]);
  });

  it("Anthropic 工具声明把 parameters 换成 input_schema", () => {
    const tools = toAnthropicTools([TOOL_SPECS[0]]);
    expect(tools[0].name).toBe("read_file");
    expect(tools[0].input_schema).toBeDefined();
    expect(tools[0].parameters).toBeUndefined();
  });

  it("OpenAI 消息映射：assistant 的 tool_calls 与 tool 消息的 id 都要回灌", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "改一下" },
      {
        role: "assistant",
        content: "先读",
        toolCalls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }],
      },
      { role: "tool", content: "1: hello", toolCallId: "call-1" },
    ];
    const out = toOpenAiMessages(messages) as Array<Record<string, unknown>>;
    expect(out[1].tool_calls).toEqual([
      { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ]);
    expect(out[2].role).toBe("tool");
    expect(out[2].tool_call_id).toBe("call-1");
    // 普通消息不能被多长出工具字段：多出来的字段会让某些端点直接 400。
    expect(out[0]).toEqual({ role: "user", content: "改一下" });
  });

  it("Anthropic 消息映射：工具结果是 user 消息里的 tool_result 块", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: "先读", toolCalls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }] },
      { role: "tool", content: "1: hello", toolCallId: "call-1" },
    ]);
    expect(out[0].role).toBe("assistant");
    const blocks = out[0].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "先读" });
    expect(blocks[1]).toEqual({ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } });
    expect(out[1].role).toBe("user");
    expect((out[1].content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "1: hello",
    });
  });

  it("Anthropic 映射丢掉 system 消息（system 走单独字段）", () => {
    expect(toAnthropicMessages([{ role: "system", content: "s" }, { role: "user", content: "u" }])).toEqual([
      { role: "user", content: "u" },
    ]);
  });

  it("解析 OpenAI 的 tool_calls：arguments 是 JSON 串", () => {
    const calls = parseOpenAiToolCalls({
      tool_calls: [{ id: "call-9", function: { name: "run_command", arguments: '{"command":"npm","args":["test"]}' } }],
    });
    expect(calls).toEqual([{ id: "call-9", name: "run_command", args: { command: "npm", args: ["test"] } }]);
  });

  it("解析 OpenAI 的 tool_calls：arguments 非法 JSON 时抛畸形响应（不是静默当空参数）", () => {
    expect(() =>
      parseOpenAiToolCalls({ tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{oops" } }] }),
    ).toThrow(/arguments 不是合法 JSON/);
  });

  it("没有 tool_calls 时返回空数组（不打扰既有的一问一答路径）", () => {
    expect(parseOpenAiToolCalls({ content: "hi" })).toEqual([]);
    expect(parseOpenAiToolCalls(undefined)).toEqual([]);
  });

  it("解析 Anthropic 的 tool_use 块：input 已是对象，不需要再 parse", () => {
    const calls = parseAnthropicToolCalls([
      { type: "text", text: "先读" },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(calls).toEqual([{ id: "toolu_1", name: "read_file", args: { path: "a.ts" } }]);
    expect(parseAnthropicToolCalls([{ type: "text", text: "x" }])).toEqual([]);
    expect(parseAnthropicToolCalls(undefined)).toEqual([]);
  });

  it("OpenAI 映射：普通 assistant / 无 id 的 tool / 空 toolCalls 都不长多余字段", () => {
    const out = toOpenAiMessages([
      { role: "assistant", content: "普通" },
      { role: "tool", content: "无 id" },
      { role: "assistant", content: "空数组", toolCalls: [] },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ role: "assistant", content: "普通" });
    expect("tool_call_id" in out[1]).toBe(false);
    expect("tool_calls" in out[2]).toBe(false);
  });

  it("OpenAI 解析：非数组/空数组/缺 id/坏名字后继续/arguments 非对象都按约定处理", () => {
    expect(parseOpenAiToolCalls({ tool_calls: "x" })).toEqual([]);
    expect(parseOpenAiToolCalls({ tool_calls: [] })).toEqual([]);
    expect(
      parseOpenAiToolCalls({
        tool_calls: [
          { function: { name: 42, arguments: "{}" } },
          { function: { name: "read_file" } },
        ],
      }),
    ).toEqual([{ id: "t-1", name: "read_file", args: {} }]);
    for (const raw of ["null", "[]", "42", '"x"']) {
      expect(parseOpenAiToolCalls({ tool_calls: [{ function: { name: "read_file", arguments: raw } }] })[0]?.args).toEqual(
        {},
      );
    }
    expect(
      parseOpenAiToolCalls({ tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] })[0]?.args,
    ).toEqual({ path: "a" });
  });

  it("Anthropic 映射：空正文不塞空 text 块，普通/空 toolCalls 消息保持普通形状", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] },
      { role: "assistant", content: "普通" },
      { role: "assistant", content: "空数组", toolCalls: [] },
    ]);
    expect(out[0].content).toEqual([{ type: "tool_use", id: "c1", name: "read_file", input: {} }]);
    expect(out[1]).toEqual({ role: "assistant", content: "普通" });
    expect(out[2]).toEqual({ role: "assistant", content: "空数组" });
  });

  it("Anthropic 解析：非对象 input 归空对象，坏名字后继续", () => {
    const calls = parseAnthropicToolCalls([
      { type: "tool_use", id: "a", name: 42, input: { x: 1 } },
      { type: "tool_use", id: "b", name: "read_file", input: null },
      { type: "tool_use", id: "c", name: "read_file", input: ["x"] },
      { type: "tool_use", id: "d", name: "read_file", input: { path: "a" } },
    ]);
    expect(calls.map((c) => c.id)).toEqual(["b", "c", "d"]);
    expect(calls[0]?.args).toEqual({});
    expect(calls[1]?.args).toEqual({});
    expect(calls[2]?.args).toEqual({ path: "a" });
  });
});
