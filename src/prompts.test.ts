import { describe, expect, it } from "vitest";
import {
  buildPrdPrompt,
  buildDecomposePrompt,
  buildTaskDispatchPrompt,
  buildEscalationSummary,
} from "../shared/prompts";

describe("buildPrdPrompt", () => {
  it("constrains techStack to the Node.js execution sandbox", () => {
    const prompt = buildPrdPrompt("做一个计算器");
    expect(prompt).toContain("CommonJS");
    expect(prompt).toContain("node:test");
    expect(prompt).toContain("NEVER propose Python");
  });

  it("requires npm-test-runnable acceptance criteria", () => {
    const prompt = buildPrdPrompt("做一个待办应用");
    expect(prompt).toContain('npm test');
    expect(prompt).toContain("tests/*.test.js");
  });

  it("embeds the user requirement verbatim", () => {
    const req = "支持表达式求值 3+4*2";
    expect(buildPrdPrompt(req)).toContain(req);
  });
});

describe("buildDecomposePrompt", () => {
  const prd = {
    goal: "g",
    features: ["f1"],
    techStack: ["Node.js"],
    acceptanceCriteria: ["npm test passes"],
  };

  it("demands six-field task objects and forbids string entries", () => {
    const prompt = buildDecomposePrompt(prd);
    expect(prompt).toContain("dependencies");
    expect(prompt).toContain("Never use plain strings");
  });

  it("forbids non-Node runtime requirements in task descriptions", () => {
    const prompt = buildDecomposePrompt(prd);
    expect(prompt).toContain("CommonJS Node.js with no external npm packages");
  });

  it("includes the PRD as JSON", () => {
    const prompt = buildDecomposePrompt(prd);
    expect(prompt).toContain('"techStack"');
    expect(prompt).toContain("Node.js");
  });

  it("steers zones towards concrete directories and off the repository root", () => {
    const prompt = buildDecomposePrompt(prd);
    expect(prompt).toContain("concrete directory");
    expect(prompt).toContain('NEVER use "." or "" as a zone');
    expect(prompt).toContain('"zone": "src/config"');
    // The example must not teach the model to claim the whole tree.
    expect(prompt).not.toContain('"zone": "."');
  });

  it("tells the planner that protected paths cannot be written", () => {
    const prompt = buildDecomposePrompt(prd);
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("rejected");
  });
});

describe("dispatch and escalation prompts", () => {
  it("repair dispatch carries the error digest", () => {
    const prompt = buildTaskDispatchPrompt({
      runId: "r1",
      taskId: "t1",
      title: "修复",
      description: "d",
      zone: "z",
      projectRoot: "/tmp/x",
      repairContext: { round: 2, errorLogDigest: "TypeError: boom" },
    });
    expect(prompt).toContain("TypeError: boom");
    expect(prompt).toContain("Repair round: 2");
  });

  it("escalation summary lists options when digest is empty", () => {
    const summary = buildEscalationSummary({
      taskTitle: "文档任务",
      attemptsSoFar: 3,
      maxRepairRounds: 2,
      lastErrorDigest: "",
    });
    expect(summary).toContain("(空)");
    expect(summary).toContain("跳过该任务");
  });
});
