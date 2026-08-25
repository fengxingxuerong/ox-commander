import { describe, expect, it } from "vitest";
import { parsePrd, parseTaskList, SchemaValidationError } from "../shared/schema";

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
