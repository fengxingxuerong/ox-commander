/**
 * 策略即代码（P2-2）契约层的直接单测。
 *
 * 为什么要单独一个文件：此前的覆盖全部来自 `platform.test.ts` 的**间接**路径
 * （通过 policyDir 装载再观察命令是否被拒），只能碰到主干。2026-10-01 登记进
 * 变异门禁后，site 口径首跑 **11/26（42%）** —— 15 处边界判断没有断言：
 * `cleanStrings` 的空数组/非数组/剔除计数、`normalizePolicyFile` 的三种非法输入
 * 与版本判定、`mergePolicies` 的并集与预算取最小、`describePolicy` 的各分支。
 *
 * 这些不是"覆盖率数字"问题：本模块承载的是**"只加严不放宽"**这条安全语义 ——
 * 归一化少挡一种坏输入，就等于一份坏策略被当好的执行了。
 */
import { describe, expect, it } from "vitest";
import {
  POLICY_VERSION,
  approvalGateOf,
  commandPolicyOverrides,
  describePolicy,
  mergePolicies,
  normalizePolicyFile,
} from "../shared/policy-file";

describe("normalizePolicyFile · 非法输入一律整份丢弃", () => {
  it("非对象（null / 数组 / 原始值）⇒ 空策略 + 说明", () => {
    for (const bad of [null, [], "x", 42, true]) {
      const r = normalizePolicyFile(bad);
      expect(r.policy).toEqual({ version: POLICY_VERSION });
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it("version 缺失 / 非整数 ⇒ 丢弃", () => {
    expect(normalizePolicyFile({}).issues.join()).toContain("version");
    expect(normalizePolicyFile({ version: 1.5 }).issues.join()).toContain("version");
    expect(normalizePolicyFile({ version: "1" }).issues.join()).toContain("version");
  });

  it("未知版本整份丢弃（半懂不懂地执行一份安全策略比不执行更危险）", () => {
    const r = normalizePolicyFile({ version: 99, denyCommands: ["node"] });
    expect(r.policy.denyCommands).toBeUndefined(); // 规则一条都没进来
    expect(r.issues.join()).toContain("99");
  });

  it("当前版本照常解析", () => {
    const r = normalizePolicyFile({ version: POLICY_VERSION, denyCommands: ["node"] });
    expect(r.issues).toEqual([]);
    expect(r.policy.denyCommands).toEqual(["node"]);
  });
});

describe("normalizePolicyFile · cleanStrings 的边界", () => {
  it("非数组 ⇒ 该字段忽略并报问题（不是静默）", () => {
    const r = normalizePolicyFile({ version: 1, denyCommands: "node" });
    expect(r.policy.denyCommands).toBeUndefined();
    expect(r.issues.join()).toContain("必须是字符串数组");
  });

  it("剔除非字符串与空白条目，并**数出来**", () => {
    const r = normalizePolicyFile({ version: 1, denyCommands: ["node", 42, "  ", null, "git"] });
    // 剩两个有效项，且顺序稳定（排序）
    expect(r.policy.denyCommands).toEqual(["git", "node"]);
    // 3 个被剔除（42 / "  " / null）
    expect(r.issues.join()).toContain("3 个");
  });

  it("去重 + 排序：同一份策略在任何机器上得出同一张表", () => {
    const r = normalizePolicyFile({ version: 1, denyCommands: ["b", "a", "b", "a"] });
    expect(r.policy.denyCommands).toEqual(["a", "b"]);
  });

  it("全被剔除 ⇒ 该字段回到 undefined，而不是空数组", () => {
    const r = normalizePolicyFile({ version: 1, denyCommands: [1, 2, "   "] });
    expect(r.policy.denyCommands).toBeUndefined();
  });

  it("trim 前后空白（配置里多打空格不该变成一条不生效的规则）", () => {
    const r = normalizePolicyFile({ version: 1, denyCommands: ["  node  "] });
    expect(r.policy.denyCommands).toEqual(["node"]);
  });

  it("四个清单字段各自独立解析（一个坏不影响其他）", () => {
    const r = normalizePolicyFile({
      version: 1,
      denyCommands: "bad",
      denyGitSubcommands: ["push"],
      denyNpmSubcommands: ["publish"],
      approvalCommands: ["deploy"],
    });
    expect(r.policy.denyCommands).toBeUndefined();
    expect(r.policy.denyGitSubcommands).toEqual(["push"]);
    expect(r.policy.denyNpmSubcommands).toEqual(["publish"]);
    expect(r.policy.approvalCommands).toEqual(["deploy"]);
  });
});

describe("normalizePolicyFile · 预算口径", () => {
  it("只有有限正数算有效", () => {
    expect(normalizePolicyFile({ version: 1, maxTokensPerRun: 100 }).policy.maxTokensPerRun).toBe(100);
    // 小数也是正数，照收（上限不要求是整数）
    expect(normalizePolicyFile({ version: 1, maxTokensPerRun: 0.5 }).policy.maxTokensPerRun).toBe(0.5);
  });

  it("0 / 负数 / NaN / Infinity ⇒ 视为没配并报问题（宁可放行不放大配置失误）", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const r = normalizePolicyFile({ version: 1, maxTokensPerRun: bad });
      expect(r.policy.maxTokensPerRun).toBeUndefined();
      expect(r.issues.join()).toContain("maxTokensPerRun");
    }
  });

  it("完全没写这个字段时不报问题（不是错误）", () => {
    const r = normalizePolicyFile({ version: 1 });
    expect(r.issues).toEqual([]);
    expect(r.policy.maxTokensPerRun).toBeUndefined();
  });
});

describe("mergePolicies · 并集与取最小", () => {
  it("空输入 ⇒ 空策略", () => {
    expect(mergePolicies([])).toEqual({ version: POLICY_VERSION });
  });

  it("同类清单取并集并排序", () => {
    const m = mergePolicies([
      { version: 1, denyCommands: ["b"] },
      { version: 1, denyCommands: ["a", "b"] },
    ]);
    expect(m.denyCommands).toEqual(["a", "b"]);
  });

  it("审批清单同样取并集（一份要求确认，另一份不提，不该被抵消）", () => {
    const m = mergePolicies([
      { version: 1, approvalCommands: ["deploy"] },
      { version: 1, approvalCommands: ["migrate"] },
      { version: 1 },
    ]);
    expect(m.approvalCommands).toEqual(["deploy", "migrate"]);
  });

  it("预算取**最小**（多份策略并存时以更严的那份为准）", () => {
    const m = mergePolicies([
      { version: 1, maxTokensPerRun: 500 },
      { version: 1, maxTokensPerRun: 100 },
      { version: 1, maxTokensPerRun: 900 },
    ]);
    expect(m.maxTokensPerRun).toBe(100);
  });

  it("只有一份带预算时取那一份（不因其他份没写而被抹掉）", () => {
    const m = mergePolicies([{ version: 1 }, { version: 1, maxTokensPerRun: 700 }]);
    expect(m.maxTokensPerRun).toBe(700);
  });

  it("三种子命令清单互不串味", () => {
    const m = mergePolicies([
      { version: 1, denyGitSubcommands: ["push"] },
      { version: 1, denyNpmSubcommands: ["publish"] },
    ]);
    expect(m.denyGitSubcommands).toEqual(["push"]);
    expect(m.denyNpmSubcommands).toEqual(["publish"]);
    expect(m.denyCommands).toBeUndefined();
  });
});

describe("commandPolicyOverrides · 只产加严项（没有 allow 这一格）", () => {
  it("空策略 ⇒ 不产出任何键", () => {
    expect(commandPolicyOverrides({ version: 1 })).toEqual({});
  });

  it("各清单映射到对应入参，且绝不产出 allow 类字段", () => {
    const o = commandPolicyOverrides({
      version: 1,
      denyCommands: ["node"],
      denyGitSubcommands: ["push"],
      denyNpmSubcommands: ["publish"],
    });
    expect(o).toEqual({
      denyMore: ["node"],
      denyGitSubcommands: ["push"],
      denyNpmSubcommands: ["publish"],
    });
    // 契约里没有"允许某条命令"这一格 —— 一份 JSON 不该能把地板拆掉
    expect(Object.keys(o)).not.toContain("allow");
  });
});

describe("approvalGateOf · 空清单不建门", () => {
  it("没配 / 空数组 ⇒ undefined（默认路径零影响）", () => {
    expect(approvalGateOf({ version: 1 })).toBeUndefined();
    expect(approvalGateOf({ version: 1, approvalCommands: [] })).toBeUndefined();
  });

  it("配了 ⇒ 原样给出命令清单", () => {
    expect(approvalGateOf({ version: 1, approvalCommands: ["deploy", "migrate"] })).toEqual({
      commands: ["deploy", "migrate"],
    });
  });
});

describe("describePolicy · 各分支都要念出来", () => {
  it("空策略说明「一条不改」，而不是空串", () => {
    expect(describePolicy({ version: 1 })).toContain("空策略");
  });

  it("四类规则各自成句", () => {
    const s = describePolicy({
      version: 1,
      denyCommands: ["node"],
      denyGitSubcommands: ["push"],
      denyNpmSubcommands: ["publish"],
      approvalCommands: ["deploy"],
      maxTokensPerRun: 100,
    });
    expect(s).toContain("禁用命令 node");
    expect(s).toContain("禁用 git 子命令 push");
    expect(s).toContain("禁用 npm 子命令 publish");
    expect(s).toContain("需人工确认 deploy");
    expect(s).toContain("token 上限 100");
  });

  it("只配一类时只念那一类（不摆空句）", () => {
    expect(describePolicy({ version: 1, approvalCommands: ["deploy"] })).toBe("需人工确认 deploy");
  });
});
