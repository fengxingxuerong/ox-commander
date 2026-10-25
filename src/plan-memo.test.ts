import { describe, expect, it } from "vitest";
import {
  MAX_BACKGROUND_CHARS,
  MAX_PLAN_MEMO_CHARS,
  PLAN_MEMO_FILE_NAME,
  PLAN_MEMO_MARKER,
  composeBackground,
  formatPlanMemoBlock,
} from "../shared/plan-memo";
import { clipBackgroundBlock } from "../shared/project-conventions";

/**
 * 规划备忘（2026-10-25）。这一层只有三个判据，但每一条错了都不会抛异常：
 * 备忘块混进"证据"的口气 → 人会以为它代表门禁结论；超限静默截断 → 模型以为自己
 * 看全了；背景总预算算错 → 提示悄悄变长或悄悄变短，两端都看不出来。
 */
describe("formatPlanMemoBlock · 备忘块", () => {
  it("空内容 / 全空白 ⇒ 空串（缺席是常态，不产空标题）", () => {
    expect(formatPlanMemoBlock("")).toBe("");
    expect(formatPlanMemoBlock("   \n\t\n ")).toBe("");
  });

  it("有内容：带标记与正文，并声明它是背景、不代表交付已过门禁", () => {
    const block = formatPlanMemoBlock("这一版决定：zone 按模块切，否掉按文件切。");
    expect(block.startsWith(PLAN_MEMO_MARKER)).toBe(true);
    expect(block).toContain("这一版决定：zone 按模块切，否掉按文件切。");
    // 信任面写死在这一层：备忘是提示，不是证据。
    expect(block).toContain("以契约为准");
    expect(block).toContain("不代表任何交付已经过门禁");
  });

  it("正文两侧空白被裁掉（文件尾的换行不该进提示）", () => {
    const block = formatPlanMemoBlock("\n\n  正文  \n\n");
    expect(block).toContain("正文");
    // 备忘是单文件，没有"多文件小节"这层结构 —— 不该长出 `### 文件名` 那样的二级头。
    expect(block).not.toContain("### ");
    expect(block.endsWith("正文")).toBe(true);
  });

  it("超过上限：截断并说破原文长度与上限（不静默丢）", () => {
    const block = formatPlanMemoBlock("x".repeat(MAX_PLAN_MEMO_CHARS + 500));
    expect(block).toContain("已截断");
    expect(block).toMatch(/规划备忘原文共 \d+ 字符/);
    expect(block).toContain(`上限 ${MAX_PLAN_MEMO_CHARS}`);
    // 截断后标记仍在：调用方与人都能认出这段是什么
    expect(block.startsWith(PLAN_MEMO_MARKER)).toBe(true);
  });

  it("文件名常量与标记里的文件名一致（文案不许两处各写一遍）", () => {
    expect(PLAN_MEMO_FILE_NAME).toBe("OX-PLAN.md");
    expect(PLAN_MEMO_MARKER).toContain(PLAN_MEMO_FILE_NAME);
  });
});

describe("clipBackgroundBlock · 约定与备忘共用的截断判据", () => {
  it("未超限：原样返回，一个字都不动", () => {
    expect(clipBackgroundBlock("短内容", 100, "约定")).toBe("短内容");
    expect(clipBackgroundBlock("x".repeat(100), 100, "约定")).toBe("x".repeat(100));
  });

  it("超限：说破的主语由调用方给（约定 / 规划备忘各说各的，措辞不漂）", () => {
    const conv = clipBackgroundBlock("x".repeat(200), 100, "约定");
    const memo = clipBackgroundBlock("x".repeat(200), 100, "规划备忘");
    expect(conv).toContain("约定原文共 200");
    expect(memo).toContain("规划备忘原文共 200");
    expect(conv.slice(0, 100)).toBe("x".repeat(100));
  });
});

describe("composeBackground · 背景总预算", () => {
  it("全空 ⇒ 空串；全放得下 ⇒ 按顺序用空行拼起来", () => {
    expect(composeBackground([], 100)).toBe("");
    expect(composeBackground([{ label: "A", text: "" }], 100)).toBe("");
    expect(
      composeBackground(
        [
          { label: "约定", text: "c" },
          { label: "备忘", text: "m" },
        ],
        100,
      ),
    ).toBe("c\n\nm");
  });

  it("超预算：按拼装顺序**从后往前**退让，并说破谁没进上下文", () => {
    const out = composeBackground(
      [
        { label: "约定", text: "c".repeat(30) },
        { label: "备忘", text: "m".repeat(30) },
        { label: "外部上下文", text: "x".repeat(30) },
      ],
      70,
    );
    // 30 + 2 + 30 = 62 放得下；再加 2 + 30 = 94 超 70 ⇒ 只有最后一个出局。
    expect(out.startsWith("c".repeat(30))).toBe(true);
    expect(out).toContain("m".repeat(30));
    expect(out).not.toContain("x".repeat(30));
    expect(out).toContain("未注入上下文");
    expect(out).toContain("外部上下文");
  });

  it("越靠后的块越先出局（长期规矩比这一版的取舍更该留下）", () => {
    const out = composeBackground(
      [
        { label: "约定", text: "c".repeat(20) },
        { label: "备忘", text: "m".repeat(20) },
        { label: "外部上下文", text: "x".repeat(20) },
      ],
      45,
    );
    // 20 + 2 + 20 = 42 ≤ 45；第三个出局，前两个留着。
    expect(out).toContain("c".repeat(20));
    expect(out).toContain("m".repeat(20));
    expect(out).not.toContain("x".repeat(20));
  });

  it("第一个块就放不下：按额度截它并说破，而不是整段丢掉", () => {
    // 静默丢掉是最坏的失败——注释里说"注入了"，实际一个字没进。
    const out = composeBackground([{ label: "约定", text: "y".repeat(200) }], 50);
    expect(out).toContain("y".repeat(50));
    expect(out).toContain("已截断");
    expect(out).toContain("约定原文共 200");
  });

  it("总预算常量是个正数且明显大于单块上限（否则备忘永远进不去）", () => {
    expect(MAX_BACKGROUND_CHARS).toBeGreaterThan(MAX_PLAN_MEMO_CHARS);
  });

  it("块间空行算进预算：把分隔符的 2 个字符算错，最后一块就会挤进去", () => {
    // 边界用例（钉住 `kept.length > 0 ? 2 : 0`）。要三个块才看得见差别 ——
    // 只有两块时"第一个多算 2、第二个少算 2"正好抵消，变异体会活下来。
    // 三块各 10 字符、预算 33：原式 10 + (10+2) + (10+2) = 34 > 33 ⇒ 第三块出局；
    // 三元写反后变成 (10+2) + 10 + 10 = 32 ≤ 33 ⇒ 第三块进去了。
    const blocks = [
      { label: "约定", text: "a".repeat(10) },
      { label: "备忘", text: "b".repeat(10) },
      { label: "外部上下文", text: "c".repeat(10) },
    ];
    const tight = composeBackground(blocks, 33);
    expect(tight).not.toContain("c".repeat(10));
    expect(tight).toContain("未注入上下文");
    // 松一档就刚好放下：说明卡住的确实是那 2 个字符，而不是别的原因。
    expect(composeBackground(blocks, 34)).toContain("c".repeat(10));
  });

  it("被退让的块后面若还有放得下的块，仍然要进去（退让不是截断整个尾巴）", () => {
    // `continue` 写成 `break` 时，第一个放不下的块会把后面全部丢掉 ——
    // 于是"预算不够"变成了"后面的都别想进"，而它们在预算上本来是够的。
    const out = composeBackground(
      [
        { label: "约定", text: "c".repeat(200) },
        { label: "备忘", text: "m".repeat(10) },
      ],
      40,
    );
    expect(out).toContain("m".repeat(10));
    expect(out).not.toContain("c".repeat(200));
    expect(out).toContain("约定");
    expect(out).toContain("未注入上下文");
  });
});
