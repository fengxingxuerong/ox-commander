import { describe, expect, it } from "vitest";
import { buildDecomposePrompt, buildEscalationSummary, CONTRACT_MARKER, STANDARD_CONTRACT_RULES } from "../shared/prompts";
import type { PrdDocument } from "../shared/types";

const PRD: PrdDocument = {
  goal: "CSV 统计工具",
  features: ["解析 CSV", "按列统计"],
  techStack: ["Node.js"],
  acceptanceCriteria: ["node --test 全绿"],
};

describe("buildDecomposePrompt", () => {
  it("要求生成独立样本冒烟清单（防自证盲区层）", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toContain('"smoke"');
    expect(p).toContain("expectContains");
    expect(p).toMatch(/sample data|样例数据/);
  });

  it("冒烟期望片段必须来自样例数据手算，不得抄实现", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/not copied from the implementation/);
  });

  it("冒烟命令同样受沙箱约束（无 shell 元字符/危险程序）", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/shell metacharacters|strict sandbox policy/);
  });

  it("无可运行入口时允许返回空冒烟数组", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/empty "smoke" array/);
  });
});

describe("平台契约模板（STANDARD_CONTRACT_RULES）", () => {
  it("覆盖历史漂移的全部语义维度（表头/空值/精度/错误/输出格式）", () => {
    const rules = STANDARD_CONTRACT_RULES;
    expect(rules).toMatch(/表头\/总数口径/);
    expect(rules).toMatch(/缺失值/);
    expect(rules).toMatch(/四舍五入/);
    expect(rules).toMatch(/退出码/);
    expect(rules).toMatch(/stdout 只输出结果/);
    expect(rules).toMatch(/禁止自由发挥|不得照抄实现/);
  });

  it("含防重复拼接的标记", () => {
    expect(STANDARD_CONTRACT_RULES).toContain("【平台契约条款");
    expect(CONTRACT_MARKER).toBe("[平台契约条款]");
  });

  it("decompose 提示词要求任务描述携带契约条款", () => {
    const p = buildDecomposePrompt(PRD);
    expect(p).toMatch(/contract clause list/);
    expect(p).toMatch(/never invent conventions silently/);
  });
});

/**
 * 这段摘要是**人做处置决定时唯一的输入**（跳过 / 重派 / 终止），而它此前一行都没被断过：
 * orchestrator 的用例只数回调次数，不读文案。文案与实际可接受的判定值一旦漂移，
 * 用户会照着提示选一个并不存在的动作。
 */
describe("buildEscalationSummary", () => {
  const base = {
    taskTitle: "CSV 解析模块",
    attemptsSoFar: 3,
    maxRepairRounds: 2,
    lastErrorDigest: "AssertionError: expected 1 to be 2",
  };

  it("点名三个真实可选的处置，并给出两个数字（已试轮数与上限）", () => {
    const s = buildEscalationSummary(base);
    for (const verb of ["跳过", "重派", "终止"]) expect(s).toContain(verb);
    expect(s).toContain("CSV 解析模块");
    expect(s).toContain("3");
    expect(s).toContain("2");
  });

  it("把最近一次错误原文带上 —— 那是归属线索，不能被摘要吃掉", () => {
    expect(buildEscalationSummary(base)).toContain("AssertionError: expected 1 to be 2");
  });

  it("错误摘要为空时写「(空)」，而不是留一行悬空的标题", () => {
    const s = buildEscalationSummary({ ...base, lastErrorDigest: "" });
    expect(s).toContain("最近一次错误摘要：");
    expect(s).toContain("(空)");
    expect(s.endsWith("(空)")).toBe(false); // 后面还有那句处置提示
  });
});
