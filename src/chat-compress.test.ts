import { describe, expect, it } from "vitest";
import {
  COMPACTED_PREFIX,
  COMPACTION_SOURCE_CHAR_CAP,
  buildCompactedMessages,
  compactionNote,
  estimateMessagesTokens,
  estimateTokens,
  planCompaction,
  renderCompactionSource,
} from "../shared/chat-compress";
import type { ChatMessage } from "../shared/providers";

/**
 * 上下文压缩（P1-2）。
 *
 * 这一层的坏法都很安静：切点劈开工具回合 ⇒ 端点 400（失败发生在平台之外）；
 * 尾部没留够 ⇒ 压完立刻再压一次；压不动却假装压过 ⇒ 模型看不见开头而界面一片绿。
 * 所以用例按**这些坏法**写，不按"压成功了"写。
 */

const ascii = (n: number, ch = "a"): string => ch.repeat(n);
const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role,
  content,
  ...extra,
});

describe("estimateTokens", () => {
  it("ASCII 大约 4 字符一个 token（向上取整）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(ascii(4))).toBe(1);
    expect(estimateTokens(ascii(5))).toBe(2);
  });

  it("CJK 按字算（多语言 tokenizer 对中日韩几乎不压缩）", () => {
    expect(estimateTokens("你好")).toBe(2);
    // 混排：两种口径都在同一条里参与
    expect(estimateTokens("你好" + ascii(8))).toBe(4);
  });
});

describe("estimateMessagesTokens", () => {
  it("每条都带结构开销，空消息也不算 0", () => {
    expect(estimateMessagesTokens([msg("user", "")])).toBeGreaterThan(0);
    expect(estimateMessagesTokens([msg("user", ascii(40))])).toBe(14);
  });

  it("工具调用与 tool_call_id 也计入（它们真的占上下文）", () => {
    const plain = estimateMessagesTokens([msg("assistant", "x")]);
    const withCalls = estimateMessagesTokens([
      msg("assistant", "x", { toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }] }),
      msg("tool", "y", { toolCallId: "t1" }),
    ]);
    expect(withCalls).toBeGreaterThan(plain * 2);
  });
});

/** system + 10 条等长消息：每条 14 tokens，system 5 tokens。 */
function longHistory(): ChatMessage[] {
  const out: ChatMessage[] = [msg("system", "S")];
  for (let i = 0; i < 10; i++) out.push(msg(i % 2 === 0 ? "user" : "assistant", ascii(40)));
  return out;
}

describe("planCompaction", () => {
  it("没超预算就不压（压缩请求本身也花钱）", () => {
    const plan = planCompaction({ messages: longHistory(), maxPromptTokens: 10_000 });
    expect(plan.needed).toBe(false);
    expect(plan.stuck).toBe(false);
  });

  it("超预算时切到尾部装得下为止，system 永远保留", () => {
    const messages = longHistory();
    const plan = planCompaction({ messages, maxPromptTokens: 60, keepTailRatio: 0.5 });
    expect(plan.needed).toBe(true);
    expect(plan.stuck).toBe(false);
    expect(plan.cutIndex).toBe(9);
    // system 不参与压缩：下标 0 那一条永远在
    expect(plan.source).not.toContain("S");
    expect(plan.tail).toHaveLength(2);
    expect(plan.tailTokens).toBeLessThanOrEqual(30);
  });

  it("切点不劈开工具回合（assistant 带 tool_calls ⇒ 它的结果必须跟着留下来）", () => {
    const messages: ChatMessage[] = [
      msg("system", "S"),
      msg("user", ascii(400)),
      msg("assistant", "", { toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }] }),
      msg("tool", ascii(400), { toolCallId: "t1" }),
      msg("user", ascii(400)),
    ];
    // 预算刻意卡在"尾部第 3 条起装得下、第 2 条起装不下"：未对齐的切点是 3，
    // 那样尾部第一条就是一个没有对应调用的孤儿 tool 结果（端点会 400）。
    const plan = planCompaction({ messages, maxPromptTokens: 240, keepTailRatio: 0.9 });
    expect(plan.needed).toBe(true);
    expect(plan.cutIndex).toBe(4);
    // 切点不能落在 tool 结果之后、也不能把 assistant(tool_calls) 与它的结果分开：
    // 切点前一条若是"发出调用的 assistant"，端点就会收到没有对应调用的 tool 消息。
    const before = messages[plan.cutIndex - 1];
    expect(before.role === "assistant" && (before.toolCalls?.length ?? 0) > 0).toBe(false);
    // 整个工具回合（调用 + 结果）一起被压掉是可以的；留下孤儿结果不行。
    expect(plan.tail.some((m) => m.role === "tool")).toBe(false);
    expect(plan.source).toContain("read_file(");
  });

  it("只有 system + 一条：没得压，明说（不假装压过）", () => {
    const plan = planCompaction({ messages: [msg("system", "S"), msg("user", ascii(400))], maxPromptTokens: 10 });
    expect(plan.needed).toBe(true);
    expect(plan.stuck).toBe(true);
    expect(plan.source).toBe("");
  });

  it("尾部本身就装不下：压不动也要报（否则「压过了」是假象）", () => {
    const messages: ChatMessage[] = [msg("system", "S"), msg("user", ascii(400)), msg("user", ascii(4000))];
    const plan = planCompaction({ messages, maxPromptTokens: 20 });
    expect(plan.needed).toBe(true);
    expect(plan.stuck).toBe(true);
  });

  it("keepTailRatio 缺省 0.5（不给也有一致的口径）", () => {
    const messages = longHistory();
    const a = planCompaction({ messages, maxPromptTokens: 60 });
    const b = planCompaction({ messages, maxPromptTokens: 60, keepTailRatio: 0.5 });
    expect(a.cutIndex).toBe(b.cutIndex);
  });
});

describe("renderCompactionSource", () => {
  it("带角色标记（谁说的不能丢）+ 跳掉 system", () => {
    const text = renderCompactionSource([
      msg("system", "别压我"),
      msg("user", "读一下 a.ts"),
      msg("assistant", "", { toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }] }),
      msg("tool", "const a = 1;", { toolCallId: "t1" }),
    ]);
    expect(text).toContain("user：读一下 a.ts");
    expect(text).toContain("read_file(");
    expect(text).toContain("tool 结果（t1）：const a = 1;");
    expect(text).not.toContain("别压我");
  });

  it("超长单条截断并标注（静默丢一半比截断更坏）", () => {
    const text = renderCompactionSource([msg("user", ascii(COMPACTION_SOURCE_CHAR_CAP + 500))]);
    expect(text.length).toBeLessThan(COMPACTION_SOURCE_CHAR_CAP + 100);
    expect(text).toContain("本条已截断");
  });

  it("不带调用的 assistant 不能渲染成「调用了」（叙述与调动工具是两回事）", () => {
    const text = renderCompactionSource([msg("assistant", "我先读一下再答"), msg("user", "好")]);
    expect(text).toContain("assistant：我先读一下再答");
    expect(text).not.toContain("调用了");
  });

  it("工具结果后面还有内容也要继续渲染（压缩不许悄悄吃掉后半段）", () => {
    const text = renderCompactionSource([
      msg("assistant", "", { toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }] }),
      msg("tool", "const a = 1;", { toolCallId: "t1" }),
      msg("user", "就按这个改"),
    ]);
    expect(text).toContain("tool 结果（t1）：const a = 1;");
    expect(text).toContain("user：就按这个改");
    // 顺序也不能反：先有结果，才有基于这个结果提出的新要求
    expect(text.indexOf("tool 结果")).toBeLessThan(text.indexOf("就按这个改"));
  });

  it("上一份摘要排在最前（压了又压时不丢前情）", () => {
    const text = renderCompactionSource([msg("user", "现在")], "之前做过 X");
    expect(text.indexOf("之前做过 X")).toBeLessThan(text.indexOf("现在"));
    expect(text).toContain("【上一份压缩摘要】");
  });
});

describe("buildCompactedMessages / compactionNote", () => {
  it("压完的序列 = system + 摘要 + 尾部，且尾部原样在后", () => {
    const out = buildCompactedMessages(
      msg("system", "SYS"),
      "摘要正文",
      [msg("user", "最近一句"), msg("assistant", "收到")],
    );
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe("system");
    expect(out[1].content.startsWith(COMPACTED_PREFIX)).toBe(true);
    expect(out[1].content).toContain("摘要正文");
    expect(out[2].content).toBe("最近一句");
    expect(out[3].content).toBe("收到");
  });

  it("没有 system 时不凭空造一条", () => {
    const out = buildCompactedMessages(undefined, "x", []);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
  });

  it("说明里带条数与估算变化（「正文为什么少了」要能在界面上被看见）", () => {
    const note = compactionNote(7, 900, 300);
    expect(note).toContain("7 条");
    expect(note).toContain("900");
    expect(note).toContain("300");
  });
});
