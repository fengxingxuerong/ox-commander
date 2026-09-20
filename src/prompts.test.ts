import { describe, expect, it } from "vitest";
import { buildDecomposePrompt } from "../shared/prompts";
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
