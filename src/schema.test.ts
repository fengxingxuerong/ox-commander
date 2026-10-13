import { describe, expect, it } from "vitest";
import {
  parseDecompose,
  parsePrd,
  parseSettings,
  parseTaskList,
  SchemaValidationError,
} from "../shared/schema";

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

  it("tasks 不是数组时给出校验错误，而不是让 TypeError 冒出去", () => {
    // 守卫是 `!Array.isArray(rawTasks) || rawTasks.length === 0`。
    // 改成 `&&` 后：`tasks: "string"` 走 `true && undefined` → **假** → 不抛错，
    // 紧接着 `rawTasks.map(...)` 抛 TypeError —— 调用方拿到运行时崩溃，
    // 而不是可读的 "tasks must be a non-empty array"。
    for (const bad of ["a-string", 42, {}, null]) {
      expect(() => parseTaskList({ ...valid, tasks: bad })).toThrow(SchemaValidationError);
    }
    expect(() => parseTaskList({ ...valid, tasks: "a-string" })).toThrow(/non-empty array/);
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

  it("smoke 条目不是对象时给出校验错误，而不是让 TypeError 冒出去", () => {
    // `isObject` 的守卫是 `typeof v === "object" && v !== null && !Array.isArray(v)`。
    // 任一处 `&&` 改成 `||` 都会让它**恒真**，于是 null/字符串/数组会被当成对象继续往下走：
    // 字符串和数字会静默变成"缺字段"（仍抛 SchemaValidationError，看不出差别），
    // 但 `null` 会在 `s["title"]` 处抛 **TypeError** —— 调用方拿到的是运行时崩溃，
    // 而不是可读的校验信息。
    for (const bad of [null, "just-a-string", 42, ["title", "command"]]) {
      expect(() => parseDecompose({ ...valid, smoke: [bad] })).toThrow(SchemaValidationError);
    }
    expect(() => parseDecompose({ ...valid, smoke: [null] })).toThrow(/must be an object/);
  });
});

describe("parseSettings（settings:save 的入参校验，2026-10-13）", () => {
  const valid = {
    maxRepairRounds: 3,
    verificationCommands: [{ kind: "build", command: "npm", args: ["run", "build"] }],
    enabledAgents: ["sensenova-api"],
    llmProvider: "sensenova",
    agentRouter: true,
    arbitration: "revert-batch",
    maxParallelRuns: 4,
    raceRedundancy: 1,
    llmPool: ["sensenova"],
  };

  it("合法全量对象原样通过", () => {
    expect(parseSettings(valid)).toEqual(valid);
  });

  it("部分保存是合法的（缺席 ≠ 非法，绝不补默认值）", () => {
    // 渲染层只会发全量；这里钉住"部分对象也能过"，防止有人把它收紧成
    // "缺字段就报错"—— 那会把"部分保存"变成"用默认值覆盖"。
    const partial = parseSettings({ llmProvider: "sensenova" });
    expect(partial).toEqual({ llmProvider: "sensenova" });
  });

  it("非对象（null / 数组 / 标量）拒绝", () => {
    for (const bad of [null, [], "x", 42, true]) {
      expect(() => parseSettings(bad), JSON.stringify(bad)).toThrow(SchemaValidationError);
    }
  });

  it("已知字段类型错了就拒：数字 / 布尔 / 字符串 / 数组各有断言", () => {
    const cases: Array<[string, unknown]> = [
      ["maxRepairRounds", -1],
      ["maxRepairRounds", "3"],
      ["maxParallelRuns", 1.5],
      ["raceRedundancy", null],
      ["agentRouter", "yes"],
      ["llmProvider", 123],
      ["enabledAgents", "sensenova-api"],
      ["maxTokensPerRun", Number.POSITIVE_INFINITY],
      ["snapshotRoot", 7],
      ["manifestDir", {}],
    ];
    for (const [key, value] of cases) {
      expect(() => parseSettings({ ...valid, [key]: value }), `${key}=${JSON.stringify(value)}`).toThrow(
        SchemaValidationError,
      );
    }
  });

  it("枚举字段用运行时值域收窄（arbitration / escalationPolicy）", () => {
    expect(() => parseSettings({ ...valid, arbitration: "nuke-everything" })).toThrow(/arbitration/);
    // "ask" 是桌面 5 档里的合法值（headless 协议才有 4 档子集），别当非法用例。
    expect(() => parseSettings({ ...valid, escalationPolicy: "ask" })).not.toThrow();
    expect(() => parseSettings({ ...valid, escalationPolicy: "nuke" })).toThrow(/escalationPolicy/);
    expect(parseSettings({ ...valid, arbitration: "quarantine" }).arbitration).toBe("quarantine");
  });

  it("verificationCommands 逐项校验（kind 枚举 / command 非空 / args 字符串数组）", () => {
    expect(() =>
      parseSettings({ ...valid, verificationCommands: [{ kind: "lint", command: "npm", args: [] }] }),
    ).toThrow(/verificationCommands\[\]\.kind/);
    expect(() =>
      parseSettings({ ...valid, verificationCommands: [{ kind: "build", command: "  ", args: [] }] }),
    ).toThrow(/command/);
    expect(() =>
      parseSettings({ ...valid, verificationCommands: [{ kind: "build", command: "npm", args: ["run", 1] }] }),
    ).toThrow(/args/);
    expect(() => parseSettings({ ...valid, verificationCommands: "npm test" })).toThrow(
      /verificationCommands must be an array/,
    );
  });

  it("verificationCommands / contextSources 的 null 项：SchemaValidationError 而不是 TypeError", () => {
    // 杀 `!e || …` → `!e && …`：变异后 null 项会漏进 `e["kind"]` 引用，
    // 抛的是运行时 TypeError —— 边界必须仍抛可读的 SchemaValidationError。
    expect(() => parseSettings({ ...valid, verificationCommands: [null] })).toThrow(SchemaValidationError);
    expect(() => parseSettings({ ...valid, contextSources: [null] })).toThrow(SchemaValidationError);
  });

  it("null 项之后的合法但不合格条目仍被检查（continue 不是 break）", () => {
    // 杀 continue → break：断言消息里带**后面那条**的 issue —— break 会在
    // 第一条就停，消息里不会有它。
    expect(() =>
      parseSettings({ ...valid, verificationCommands: [null, { kind: "wiki", command: "x", args: [] }] }),
    ).toThrow(/kind must be one of/);
    expect(() => parseSettings({ ...valid, contextSources: [null, { kind: "wiki" }] })).toThrow(
      /kind must be one of/,
    );
  });

  it("contextSources / deliveryRemote 的嵌套形状也过闸", () => {
    expect(() =>
      parseSettings({ ...valid, contextSources: [{ kind: "issues", repo: "o/r", limit: 5 }] }),
    ).not.toThrow();
    expect(() => parseSettings({ ...valid, contextSources: [{ kind: "wiki" }] })).toThrow(
      /contextSources\[\]\.kind/,
    );
    expect(() => parseSettings({ ...valid, deliveryRemote: { mode: "force-push" } })).toThrow(
      /deliveryRemote\.mode/,
    );
    expect(() =>
      parseSettings({ ...valid, deliveryRemote: { mode: "pr", awaitChecks: { intervalMs: "soon" } } }),
    ).toThrow(/intervalMs/);
    expect(() => parseSettings({ ...valid, deliveryRemote: 7 })).toThrow(/deliveryRemote must be an object/);
    // 正例：合法 mode 不许被误拒（杀 `!==` → `===`，变异后合法 mode 也会报错）
    expect(parseSettings({ ...valid, deliveryRemote: { mode: "pr" } }).deliveryRemote).toEqual({
      mode: "pr",
    });
    // awaitChecks 是真值非对象（数字）→ 必须报"must be an object"，
    // 杀 `!a || …` → `!a && …`（变异后静默跳过整个 awaitChecks 校验）
    expect(() =>
      parseSettings({ ...valid, deliveryRemote: { mode: "pr", awaitChecks: 7 } }),
    ).toThrow(/awaitChecks must be an object/);
    expect(() =>
      parseSettings({ ...valid, deliveryRemote: { mode: "pr", awaitChecks: null } }),
    ).toThrow(/awaitChecks must be an object/);
  });

  it("未知键原样放行（刻意不建白名单：漏登记 = 保存时静默丢字段）", () => {
    const withExtra = { ...valid, someFutureField: { nested: true } };
    expect(parseSettings(withExtra)).toEqual(withExtra);
  });
});
