import { describe, expect, it } from "vitest";
import {
  declaredArtifactPaths,
  describeZoneGaps,
  extractDeclaredPaths,
  findOrphanPaths,
  verificationCommandPaths,
} from "../shared/zone-coverage";
import type { PrdDocument, Task } from "../shared/types";

function prd(over: Partial<PrdDocument> = {}): PrdDocument {
  return {
    goal: "Build a tool",
    features: [],
    techStack: ["Node"],
    acceptanceCriteria: [],
    ...over,
  };
}

function task(id: string, zone: string): Task {
  return { id, title: id, description: "", zone, dependencies: [], suggestedRole: "backend-dev" };
}

describe("extractDeclaredPaths", () => {
  it("pulls concrete relative file paths out of prose", () => {
    const paths = extractDeclaredPaths(
      "Create tests/greet.test.js using node:test, and src/app/greet.js exporting greet(name).",
    );
    expect(paths).toContain("tests/greet.test.js");
    expect(paths).toContain("src/app/greet.js");
  });

  it("strips trailing sentence punctuation", () => {
    // The path is at the end of a sentence: the period is not part of it.
    expect(extractDeclaredPaths("See src/config/defaults.js.")).toContain("src/config/defaults.js");
  });

  it("ignores bare prose extensions with no directory", () => {
    // ".env" and "package.json" are constraints, not artifacts under a dir.
    // A bare filename is never treated as an artifact: prose names protected
    // paths constantly ("do not modify package.json") and a false positive
    // here would reject a perfectly good plan.
    expect(extractDeclaredPaths("Do not modify package.json or .env files")).toEqual([]);
    expect(extractDeclaredPaths("the CLI entry cli.js must print stats")).toEqual([]);
  });

  it("skips traversal and unparseable tokens", () => {
    expect(extractDeclaredPaths("escape ../outside/secret.txt and **/*.js")).toEqual([]);
  });

  it("deduplicates across the same sentence", () => {
    const paths = extractDeclaredPaths("src/a.js then src/a.js again");
    expect(paths.filter((p) => p === "src/a.js")).toHaveLength(1);
  });

  it("keeps scanning past a skipped token — each guard is `continue`, not `break`", () => {
    // Three guards skip a token and move on. Flipping ANY of them to `break`
    // stops the whole scan instead, so every path mentioned *after* a skipped
    // token is silently lost. The coverage check then sees "no declared paths"
    // and waves through a plan that will produce zone violations forever —
    // exactly the regression this module was written to catch.
    //
    // Found by mutation testing: all three survived, because every earlier case
    // had either all-valid or all-skipped tokens — none mixed the two.
    //
    // Guard 1 — a `../` continuation (`prev` is `.` / `/` / `\`).
    expect(extractDeclaredPaths("escape ../outside/secret.txt then src/app/main.js")).toEqual([
      "src/app/main.js",
    ]);
    // Guard 2 — a token whose cleaned form still contains `..`.
    expect(extractDeclaredPaths("skip a..b/c.js then src/real.js")).toEqual(["src/real.js"]);
    // Guard 3 — a bare filename. The most likely one to bite: PRDs constantly
    // name `package.json` as a constraint *before* naming real artifacts.
    expect(extractDeclaredPaths("do not modify package.json; write src/cli.js")).toEqual([
      "src/cli.js",
    ]);
  });

  /**
   * 2026-09-27 第三轮 --real 演习实测：PRD 大脑描述 CommonJS 接口时写出
   * "require/module.exports"（斜杠连接的代码概念），两段形态恰好骗过
   * "至少两段目录"启发式，被当成真实嵌套路径提取 → zone 覆盖校验永远失败
   * → 规划带错重试 2/2 也纠不回来（分解层无法覆盖一个不存在的文件），
   * 演习在 PLANNING 就 exit 1。代码概念关键词进黑名单：任何一段命中即
   * 判为代码引用而非路径。取舍：真实业务目录叫 exports/ 的场景在本项目
   * 几乎不存在，且这类误杀远比"规划必败"便宜。
   */
  describe("code-concept blacklist (2026-09-27 --real 演习实测)", () => {
    it("require/module.exports（演习实测形态）不提取", () => {
      expect(extractDeclaredPaths("模块通过 require/module.exports 提供 CommonJS 接口")).toEqual([]);
    });

    it("其他模块系统概念的斜杠连接形态不提取", () => {
      expect(extractDeclaredPaths("use module/exports and import/default semantics")).toEqual([]);
      expect(extractDeclaredPaths("the require path exports/init.js is not a file")).toEqual([]);
    });

    it("真实路径不受黑名单影响（回归）", () => {
      expect(extractDeclaredPaths("write src/core/csv.js and tests/csv.test.js")).toEqual([
        "src/core/csv.js",
        "tests/csv.test.js",
      ]);
    });

    it("黑名单只杀命中段——后续真实路径照常提取（continue 语义）", () => {
      expect(extractDeclaredPaths("require/module.exports first, then src/cli.js")).toEqual(["src/cli.js"]);
    });
  });
});

describe("declaredArtifactPaths", () => {
  it("scans goal, features and acceptance criteria together", () => {
    const paths = declaredArtifactPaths(
      prd({
        goal: "Ship src/cli.js",
        features: ["Write tests/unit/a.test.js"],
        acceptanceCriteria: ["docs/README.md explains usage"],
      }),
    );
    expect(paths).toEqual(["docs/README.md", "src/cli.js", "tests/unit/a.test.js"]);
  });
});

/**
 * The regression that motivated this module: a real run planned zones
 * `tests/unit` + `tests/runner` while the PRD demanded `tests/greet.test.js`.
 * Every write was a zone violation → reverted → verification failed on a
 * missing file → repair loop could never terminate.
 */
describe("findOrphanPaths", () => {
  const regressionPrd = prd({
    features: ["Implement src/app/greet.js exporting greet(name)"],
    acceptanceCriteria: [
      "src/app/greet.js exists",
      "tests/greet.test.js contains at least 2 cases",
      "tests/math.test.js contains at least 4 cases",
    ],
  });

  it("reports the real regression: narrow zones orphan the PRD's test files", () => {
    const gaps = findOrphanPaths(regressionPrd, [
      task("t1", "src/app"),
      task("t4", "tests/unit"),
      task("t5", "tests/runner"),
    ]);
    expect(gaps.map((g) => g.path)).toEqual(["tests/greet.test.js", "tests/math.test.js"]);
    expect(gaps[0]!.zones).toEqual(["src/app", "tests/unit", "tests/runner"]);
  });

  it("passes once the zone is the parent directory", () => {
    const gaps = findOrphanPaths(regressionPrd, [task("t1", "src/app"), task("t5", "tests")]);
    expect(gaps).toEqual([]);
  });

  it("passes when an unrestricted zone is present", () => {
    expect(findOrphanPaths(regressionPrd, [task("t1", ".")])).toEqual([]);
  });

  it("ignores protected paths the PRD only mentions as constraints", () => {
    const constraintPrd = prd({
      acceptanceCriteria: [
        "ox-scripts/build.js remains unmodified",
        "node_modules/react/index.js is not committed",
      ],
    });
    // Nothing writable is declared, so no gap is reported for the protected ones.
    expect(findOrphanPaths(constraintPrd, [task("t1", "src")])).toEqual([]);
  });

  it("returns nothing for an empty plan or a PRD with no paths", () => {
    expect(findOrphanPaths(regressionPrd, [])).toEqual([]);
    expect(findOrphanPaths(prd({ goal: "just describe a feature" }), [task("t1", "src")])).toEqual([]);
  });
});

/**
 * 下面几条来自 site 逐位点审计（zone-coverage.ts 3 处存活）。
 *
 * 前两条的根因是 `describeZoneGaps` **此前没有任何断言** ——
 * 它产出的诊断串是给人和模型看的（决定修复轮次往哪儿改），
 * 却没有一条用例检查过它写了什么。
 */
describe("describeZoneGaps", () => {
  it("区分两种来源：验证命令引用 vs PRD 声明", () => {
    // 第 129 行 `g.source === "verification" ? "验证命令引用" : "PRD 声明"`。
    // 改成 `!==` 后两个标签**对调** —— 修复提示会指向错误的来源。
    //
    // ⚠️ 断言写法要点：只断言"两个标签都出现"**拦不住对调**（集合相同）。
    // 必须**逐条**断言哪个 path 配哪个标签，即断言对应关系而不是并集。
    const fromVerify = describeZoneGaps([{ path: "src/a.js", zones: [], source: "verification" }]);
    expect(fromVerify).toContain("验证命令引用");
    expect(fromVerify).not.toContain("PRD 声明");

    const fromPrd = describeZoneGaps([{ path: "docs/b.md", zones: [], source: "prd" }]);
    expect(fromPrd).toContain("PRD 声明");
    expect(fromPrd).not.toContain("验证命令引用");
  });

  it("有 zone 时列出 zone 名，一个都没有时写「无」", () => {
    // 第 129 行 `g.zones.join("、") || "无"`。改成 `&&` 之后：
    // 有 zone 时反而显示"无"，没有 zone 时显示空串 —— 两个方向都错。
    expect(describeZoneGaps([{ path: "src/a.js", zones: ["src"], source: "prd" }])).toContain(
      "现有 zone：src",
    );
    expect(describeZoneGaps([{ path: "src/a.js", zones: [], source: "prd" }])).toContain(
      "现有 zone：无",
    );
  });
});

describe("findOrphanPaths · extraDeclared", () => {
  it("PRD 未声明任何路径时，额外声明的产物路径仍要检查 zone 覆盖", () => {
    // 第 105 行 `(declared.length === 0 && extra.length === 0) || tasks.length === 0`。
    // 既有用例从不传 `extraDeclared`，于是 `extra.length === 0` 恒真，
    // 把它改成 `!==` 也看不出来。
    // 真后果：declared 为空 + extra 非空时，改坏后会**直接 return []**，
    // 所有额外声明的产物都不再检查覆盖 —— 越权写入不会被发现。
    const empty = prd({ goal: "no file paths here", features: [], acceptanceCriteria: [] });
    const gaps = findOrphanPaths(empty, [task("t1", "src")], undefined, ["docs/guide.md"]);
    expect(gaps.map((g) => g.path)).toContain("docs/guide.md");
  });
});

/**
 * 验证命令里引用的产物路径，是 zone 覆盖的第二来源（`source: "verification"`）。
 *
 * 为什么单独钉：生产上 `orchestrator.ts:327` 真的调它，但**全仓没有一处测试
 * import 过它** —— 也就是说这个函数改坏了，门禁一声不响。它又是纯函数，
 * 钉它的成本几乎为零，没理由留着。
 *
 * 它与 `findOrphanPaths` 的接线（declared 为空时 extra 仍生效）已由上面那条
 * 用例守住；这里守的是**这个函数本身**的行为。
 */
describe("verificationCommandPaths", () => {
  it("从验证命令的 args 里取出嵌套相对路径", () => {
    // 真实形状：`npm run build --workspace packages/app` 里那个嵌套路径。
    // 裸文件名（`vitest.config.mts`）按设计被忽略 —— 见下面那条用例。
    expect(
      verificationCommandPaths([
        { args: ["run", "build", "--workspace", "packages/app/tsconfig.json"] },
        { args: ["--config", "config/vitest.config.mts"] },
      ]),
    ).toEqual(["config/vitest.config.mts", "packages/app/tsconfig.json"]);
  });

  it("忽略裸文件名，判据与 extractDeclaredPaths 同源（共用一个启发式）", () => {
    // 第 160 行 `for (const arg of c.args ?? [])` 之后复用 `extractDeclaredPaths`，
    // 于是裸文件名的假阳性守卫是**免费继承**的。
    // 但"免费"不等于"被验证过"：若将来改成自己实现启发式，这条会红。
    expect(verificationCommandPaths([{ args: ["run", "build", "package.json"] }])).toEqual([]);
  });

  it("没有 args 的命令不炸，缺失即无路径", () => {
    // 第 160 行的 `c.args ?? []`：ProjectSettings 允许一条只有 `command` 的命令
    // （第 160 行就是这个守卫的全部作用）。去掉 `??` 会 TypeError。
    expect(verificationCommandPaths([{ args: [] }, {}])).toEqual([]);
  });

  it("跨命令去重，且输出稳定排序", () => {
    // Set 去重 + sort：同一路径被两条命令各写一次时只能报一个 gap，
    // 否则 orchestrator 的错误信息会重复同一个路径。
    expect(
      verificationCommandPaths([
        { args: ["--config", "docs/b.md"] },
        { args: ["--config", "docs/a.md"] },
        { args: ["--config", "docs/b.md"] },
      ]),
    ).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("命令引用了本 zone 已覆盖的路径时，仍然如实上报（过滤交给 findOrphanPaths）", () => {
    // 这个函数是**事实提取**，不做 zone 匹配 —— 职责单一。
    // 它的输出会流向 `findOrphanPaths` 的 `extraDeclared`，由后者判 gap。
    // 这里刻意钉住"不自己过滤"：若有人在这里塞 isPathInZone 判断，
    // 返回空数组后 orchestrator 就再也不会报越权写入了。
    expect(verificationCommandPaths([{ args: ["src", "--config", "src/existing.ts"] }])).toEqual([
      "src/existing.ts",
    ]);
  });
});
