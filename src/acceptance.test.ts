import { describe, expect, it } from "vitest";
import {
  MAX_ACCEPTANCE_CHECKS,
  acceptanceTitle,
  missingAcceptanceFiles,
  missingFilesMessage,
  normalizeAcceptanceChecks,
  toSmokeCheck,
} from "../shared/acceptance";
import { buildReceipt, receiptHeadlineFor, type ReceiptCheck } from "../shared/delivery-receipt";

/** 一条最小合法判据（覆盖"只有命令、只看退出码"这一档）。 */
const OK = { command: "node", args: ["src/cli.js"] };

function check(ok: boolean, extra: Partial<ReceiptCheck> = {}): ReceiptCheck {
  return { kind: "smoke", ok, exitCode: ok ? 0 : 1, preexisting: false, headline: "", ...extra };
}

describe("normalizeAcceptanceChecks · 形状", () => {
  it("缺席 = 一条都没有（不是错误）", () => {
    expect(normalizeAcceptanceChecks(undefined)).toEqual({ checks: [], issues: [] });
  });

  it("不是数组就报错，并给出空列表", () => {
    const r = normalizeAcceptanceChecks({ command: "node" });
    expect(r.checks).toEqual([]);
    expect(r.issues).toEqual(["acceptanceChecks 必须是数组"]);
  });

  it("条目不是对象 → 报错跳过，其余照收", () => {
    const r = normalizeAcceptanceChecks([null, OK]);
    expect(r.issues).toContain("acceptanceChecks[0] 必须是对象");
    expect(r.checks).toHaveLength(1);
  });

  it("command 为空/空白 → 拒收", () => {
    for (const command of ["", "   ", 7]) {
      const r = normalizeAcceptanceChecks([{ command, args: [] }]);
      expect(r.checks).toEqual([]);
      expect(r.issues.join()).toContain(".command 必须是非空字符串");
    }
  });

  it("args 必须是字符串数组（缺席按空数组）", () => {
    expect(normalizeAcceptanceChecks([{ command: "node" }]).checks[0].args).toEqual([]);
    const bad = normalizeAcceptanceChecks([{ command: "node", args: ["a", 1] }]);
    expect(bad.checks).toEqual([]);
    expect(bad.issues.join()).toContain(".args 必须是字符串数组");
  });

  it("stdin / title 类型不对 → 拒收；title 会 trim", () => {
    expect(normalizeAcceptanceChecks([{ command: "node", args: [], stdin: 1 }]).checks).toEqual([]);
    expect(normalizeAcceptanceChecks([{ command: "node", args: [], title: "   " }]).checks).toEqual([]);
    expect(
      normalizeAcceptanceChecks([{ command: "node", args: [], title: "  CLI 报数  " }]).checks[0].title,
    ).toBe("CLI 报数");
  });

  it("不认识的字段**整条拒收**（拼错的期望不能静默降级成只看退出码）", () => {
    const r = normalizeAcceptanceChecks([{ command: "node", args: [], expectContain: ["x"] }]);
    expect(r.checks).toEqual([]);
    expect(r.issues.join()).toContain("expectContain");
    expect(r.issues.join()).toContain("整条已拒收");
  });

  it("expectContains 必须是字符串数组；空/非字符串条目被剔除并说破", () => {
    const bad = normalizeAcceptanceChecks([{ ...OK, expectContains: "rows=3" }]);
    expect(bad.checks).toEqual([]);
    expect(bad.issues.join()).toContain("expectContains 必须是字符串数组");

    const dirty = normalizeAcceptanceChecks([{ ...OK, expectContains: ["  rows=3  ", "", 5, "rows=3"] }]);
    expect(dirty.checks[0].expectContains).toEqual(["rows=3"]);
    expect(dirty.issues.join()).toContain("2 个空/非字符串条目");
  });

  it("expectFiles 只收项目内相对路径（绝对路径 / 盘符 / 穿越都拒）", () => {
    for (const p of ["/etc/passwd", "\\\\server\\share\\x", "C:\\tmp\\x", "src/../x", ".."]) {
      const r = normalizeAcceptanceChecks([{ ...OK, expectFiles: [p] }]);
      expect(r.checks).toEqual([]);
      expect(r.issues.join()).toContain("只收项目内相对路径");
    }
    const ok = normalizeAcceptanceChecks([{ ...OK, expectFiles: ["dist/index.js", "src\\main.js"] }]);
    expect(ok.checks[0].expectFiles).toEqual(["dist/index.js", "src\\main.js"]);
  });

  it("超过上限时保留前 N 条并说破", () => {
    const many = Array.from({ length: MAX_ACCEPTANCE_CHECKS + 2 }, (_, i) => ({
      command: "node",
      args: [String(i)],
    }));
    const r = normalizeAcceptanceChecks(many);
    expect(r.checks).toHaveLength(MAX_ACCEPTANCE_CHECKS);
    expect(r.issues.join()).toContain(`最多 ${MAX_ACCEPTANCE_CHECKS} 条`);
  });

  it("args 原样保留（不做 trim：参数里的空格可能是语义）", () => {
    const r = normalizeAcceptanceChecks([{ command: "node", args: [" a b "] }]);
    expect(r.checks[0].args).toEqual([" a b "]);
  });

  /**
   * 每个拒收分支都必须**只拒这一条**：写成 `break` 会把它后面所有合法判据一起吞掉，
   * 而症状是"我配了 5 条，凭据里只有 1 条"——没有任何报错。变异审计逐条抓这里。
   */
  it("拒收一条之后仍继续处理后面的合法条目（每条分支各一次）", () => {
    const cases: Array<[unknown, string]> = [
      [null, "必须是对象"],
      [{ command: "node", args: [], expectContain: ["x"] }, "不认识的字段"],
      [{ command: "", args: [] }, ".command 必须是非空字符串"],
      [{ command: "node", args: [1] }, ".args 必须是字符串数组"],
      [{ command: "node", args: [], stdin: 1 }, ".stdin 必须是字符串"],
      [{ command: "node", args: [], title: "" }, ".title 必须是非空字符串"],
      [{ command: "node", args: [], expectContains: "x" }, "expectContains 必须是字符串数组"],
      [{ command: "node", args: [], expectFiles: "x" }, "expectFiles 必须是字符串数组"],
      [{ command: "node", args: [], expectFiles: ["../x"] }, "只收项目内相对路径"],
    ];
    for (const [bad, fragment] of cases) {
      const good = { command: "node", args: ["ok.js"] };
      const r = normalizeAcceptanceChecks([bad, good]);
      expect(r.issues.join(), JSON.stringify(bad)).toContain(fragment);
      expect(r.checks, `坏条目之后的好条目被吞了：${JSON.stringify(bad)}`).toHaveLength(1);
      expect(r.checks[0].args).toEqual(["ok.js"]);
    }
  });

  it("清洗数组时坏条目之后的好条目仍被收下", () => {
    expect(normalizeAcceptanceChecks([{ ...OK, expectContains: ["", "rows=3"] }]).checks[0].expectContains).toEqual([
      "rows=3",
    ]);
    expect(normalizeAcceptanceChecks([{ ...OK, expectContains: [7, "rows=3"] }]).checks[0].expectContains).toEqual([
      "rows=3",
    ]);
  });

  it("stdin 是字符串时保留，缺席时不带这个键", () => {
    const withStdin = normalizeAcceptanceChecks([{ command: "node", args: [], stdin: "a,b" }]);
    expect(withStdin.checks[0].stdin).toBe("a,b");
    const without = normalizeAcceptanceChecks([{ command: "node", args: [] }]);
    expect("stdin" in without.checks[0]).toBe(false);
  });
});

describe("acceptanceTitle / toSmokeCheck", () => {
  it("有 title 用 title，没有就由 command + args 派生", () => {
    expect(acceptanceTitle({ command: "node", args: ["a.js"], title: "验主流程" })).toBe("验主流程");
    expect(acceptanceTitle({ command: "node", args: ["a.js", "x"] })).toBe("node a.js x");
  });

  it("映射到冒烟执行器输入：可选字段缺席就不出现", () => {
    const minimal = toSmokeCheck({ command: "node", args: [] });
    expect(minimal).toEqual({ title: "node", command: "node", args: [] });
    expect("stdin" in minimal).toBe(false);

    const full = toSmokeCheck({
      command: "node",
      args: ["cli.js"],
      stdin: "a,b",
      expectContains: ["rows=1"],
      expectFiles: ["x.js"],
    });
    expect(full).toEqual({
      title: "node cli.js",
      command: "node",
      args: ["cli.js"],
      stdin: "a,b",
      expectContains: ["rows=1"],
    });
    // expectFiles 不属于执行器输入：它由引擎在命令之后单独核。
    expect("expectFiles" in full).toBe(false);
  });
});

describe("missingAcceptanceFiles", () => {
  it("只返回真的有缺的判据，缺几条都列出来", () => {
    const checks = [
      { command: "node", args: [], expectFiles: ["a.js", "b.js"] },
      { command: "node", args: ["x"], expectFiles: ["ok.js"] },
      { command: "node", args: ["y"] },
    ];
    const gaps = missingAcceptanceFiles(checks, (rel) => rel === "ok.js");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing).toEqual(["a.js", "b.js"]);
  });

  it("全都在盘上时返回空数组", () => {
    expect(missingAcceptanceFiles([{ command: "node", args: [], expectFiles: ["a.js"] }], () => true)).toEqual([]);
  });

  it("没有 expectFiles 的判据不产生探测（exists 不会被调用）", () => {
    let calls = 0;
    missingAcceptanceFiles([{ command: "node", args: [] }], () => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(0);
  });
});

describe("missingFilesMessage", () => {
  it("带上判据名字与缺失清单", () => {
    const msg = missingFilesMessage(
      { command: "node", args: ["cli.js"], title: "CLI 产物", expectFiles: ["dist/a.js", "dist/b.js"] },
      ["dist/a.js", "dist/b.js"],
    );
    expect(msg).toBe("[验收] CLI 产物：期望的产物不在盘上 —— dist/a.js、dist/b.js");
  });
});

describe("凭据里的判据账（B7）", () => {
  const counts = { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 };

  it("四格措辞矩阵：通过说通过数、blocked 且判据红才说「其中」、交付但判据红不说", () => {
    const deliveredPass = receiptHeadlineFor({
      outcome: "delivered", verified: true, rounds: 0, counts, checks: 2,
      acceptance: { total: 2, passed: 2, failed: 0 },
    });
    expect(deliveredPass).toContain("2/2 条操作者验收判据通过");
    expect(deliveredPass).not.toContain("其中");

    // 人为组合（真实链路不会出现"交付了但验收红"，但函数是纯的，矩阵必须钉住）：
    // 它钉的是"「其中」只在 blocked 且 failed>0 时出现"，不让 && / === 被换掉。
    const deliveredFail = receiptHeadlineFor({
      outcome: "delivered", verified: true, rounds: 0, counts, checks: 2,
      acceptance: { total: 1, passed: 0, failed: 1 },
    });
    expect(deliveredFail).not.toContain("其中");

    const blockedFail = receiptHeadlineFor({
      outcome: "blocked", verified: true, rounds: 1, counts, checks: 2,
      acceptance: { total: 1, passed: 0, failed: 1 },
    });
    expect(blockedFail).toContain("其中 1 条是操作者验收判据");

    // blocked 但判据全过：结论里说的是"通过了几条"，不是"其中 0 条是判据"。
    const blockedPass = receiptHeadlineFor({
      outcome: "blocked", verified: true, rounds: 1, counts, checks: 2,
      acceptance: { total: 1, passed: 1, failed: 0 },
    });
    expect(blockedPass).toContain("1/1 条操作者验收判据通过");
    expect(blockedPass).not.toContain("其中");
  });

  it("有验收判据时给出 total/passed/failed，并在结论里说通过了几条", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [
        check(true),
        check(true, { origin: "operator", title: "CLI 报数" }),
        check(true, { origin: "operator", title: "产物存在", command: "node", args: ["x"] }),
      ],
      tasks: [],
      conflicts: [],
    });
    expect(r.acceptance).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(r.headline).toContain("2/2 条操作者验收判据通过");
  });

  it("验收判据失败时结论里点明「其中几条是操作者判据」（不与自测成绩混读）", () => {
    const r = buildReceipt({
      outcome: "blocked",
      verified: true,
      rounds: 1,
      checks: [
        check(false),
        check(false, { origin: "operator", title: "CLI 报数" }),
      ],
      tasks: [],
      conflicts: [],
    });
    expect(r.acceptance).toEqual({ total: 1, passed: 0, failed: 1 });
    expect(r.headline).toContain("其中 1 条是操作者验收判据");
    // 判据账不并进任务账：0 个失败任务就是 0。
    expect(r.counts.failed).toBe(0);
  });

  it("没有验收判据时凭据里没有 acceptance 键（缺席 ≠ 0 条）", () => {
    const r = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [check(true)],
      tasks: [],
      conflicts: [],
    });
    expect("acceptance" in r).toBe(false);
    expect(r.headline).not.toContain("操作者验收判据");
  });
});
