import { describe, expect, it } from "vitest";
import { parseDecompose, parsePrd, parseTaskList, SchemaValidationError } from "../shared/schema";

describe("parsePrd", () => {
  it("accepts a well-formed PRD", () => {
    const prd = parsePrd({
      goal: "todo app",
      features: ["auth"],
      techStack: ["react"],
      acceptanceCriteria: ["build passes"],
    });
    expect(prd.goal).toBe("todo app");
  });

  it("rejects missing fields", () => {
    expect(() => parsePrd({ goal: "" })).toThrow(SchemaValidationError);
  });
});

describe("parseTaskList", () => {
  const valid = {
    tasks: [
      {
        id: "t1",
        title: "setup",
        description: "init",
        zone: "src/core",
        dependencies: [],
        suggestedRole: "backend-dev",
      },
      {
        id: "t2",
        title: "ui",
        description: "pages",
        zone: "src/pages",
        dependencies: ["t1"],
        suggestedRole: "frontend-dev",
      },
    ],
  };

  it("accepts a valid list and dedups dependencies", () => {
    const tasks = parseTaskList(valid);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].dependencies).toEqual(["t1"]);
  });

  it("rejects unknown dependency ids", () => {
    const bad = {
      tasks: [{ ...valid.tasks[0], dependencies: ["ghost"] }],
    };
    expect(() => parseTaskList(bad)).toThrow(/unknown task/);
  });

  it("rejects path traversal zones", () => {
    const bad = {
      tasks: [{ ...valid.tasks[0], zone: "../etc" }],
    };
    expect(() => parseTaskList(bad)).toThrow(/traversal/);
  });

  it("rejects unknown roles", () => {
    const bad = {
      tasks: [{ ...valid.tasks[0], suggestedRole: "ceo" }],
    };
    expect(() => parseTaskList(bad)).toThrow(/known role/);
  });
});

describe("parseDecompose（任务 + 独立冒烟清单）", () => {
  const valid = {
    tasks: [
      {
        id: "t1",
        title: "CLI",
        description: "主入口",
        zone: "src",
        dependencies: [],
        suggestedRole: "fullstack-dev",
      },
    ],
  };

  it("smoke 缺省 → 空数组（向后兼容纯任务分解）", () => {
    const plan = parseDecompose(valid);
    expect(plan.tasks.length).toBe(1);
    expect(plan.smoke).toEqual([]);
  });

  it("接受合法 smoke 清单（含 stdin 与 expectContains）", () => {
    const plan = parseDecompose({
      ...valid,
      smoke: [
        {
          title: "CLI 打印统计",
          command: "node",
          args: ["src/cli.js", "sample.csv"],
          stdin: "样例数据",
          expectContains: ["col0", "type="],
        },
      ],
    });
    expect(plan.smoke[0].command).toBe("node");
    expect(plan.smoke[0].stdin).toBe("样例数据");
    expect(plan.smoke[0].expectContains).toEqual(["col0", "type="]);
  });

  it("拒绝超过 5 条的 smoke（防滥用）", () => {
    const smoke = Array.from({ length: 6 }, (_, i) => ({
      title: `s${i}`,
      command: "node",
      args: ["x.js"],
    }));
    expect(() => parseDecompose({ ...valid, smoke })).toThrow(/at most 5/);
  });

  it("拒绝缺 title/command 的 smoke 条目", () => {
    expect(() => parseDecompose({ ...valid, smoke: [{ command: "node", args: [] }] })).toThrow(
      /title/,
    );
    expect(() => parseDecompose({ ...valid, smoke: [{ title: "x", args: [] }] })).toThrow(
      /command/,
    );
  });

  it("smoke 不是数组 → 校验失败", () => {
    expect(() => parseDecompose({ ...valid, smoke: "node src/cli.js" })).toThrow(/smoke/);
  });
});
