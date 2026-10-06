import { describe, expect, it } from "vitest";
import {
  checkContractPaths,
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

/**
 * 契约路径合规（2026-10-06 --real 真跑的负结果逼出来的一层）。
 * 这里只测**纯判据**；引擎侧的翻转与日志由 src/orchestrator.test.ts 钉。
 */
describe("checkContractPaths —— 点名的文件必须真的在盘上", () => {
  const task = (id: string, zone: string, description: string): Task => ({
    id,
    title: id,
    description,
    zone,
    dependencies: [],
    suggestedRole: "backend-dev",
  });

  const T1 = task("t1", "src/core/csv", "Create src/core/csv.js — CommonJS exporting parseCsv(text).");

  it("点名的文件缺失 ⇒ 报 gap，并点名等价布局", () => {
    const r = checkContractPaths([T1], (p) => p === "src/core/csv/index.js");
    expect(r.checked).toBe(1);
    expect(r.gaps).toEqual([{ taskId: "t1", path: "src/core/csv.js", indexLayout: "src/core/csv/index.js" }]);
  });

  it("文件在 ⇒ 不报（正向对照：判据不是「永远红」）", () => {
    const r = checkContractPaths([T1], () => true);
    expect(r.gaps).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it("缺失且没有 index 布局可指 ⇒ indexLayout 为 null，不编造", () => {
    const r = checkContractPaths([T1], () => false);
    expect(r.gaps[0]?.indexLayout).toBeNull();
  });

  it("义务只认任务自己的 description：PRD 或别人的描述里点名，不算它的活儿", () => {
    const other = task("t2", "src/report", "renderReport(rows)；它 require src/core/csv.js 里的 parseCsv");
    // t2 的 zone 不含 src/core/csv.js ⇒ isPathInZone 挡掉，不判 t2；t1 仍然只被自己的描述牵上
    const r = checkContractPaths([other], () => false);
    expect(r.checked).toBe(0);
    expect(r.gaps).toEqual([]);
  });

  it("归属不唯一 ⇒ 不判（误判的代价是一整轮修预算白烧）", () => {
    const broad = task("t9", "src", "也涉及 src/core/csv.js 的解析");
    const r = checkContractPaths([T1, broad], () => false);
    expect(r.checked).toBe(0);
    expect(r.gaps).toEqual([]);
    expect(r.ambiguous.join(" ")).toContain("src/core/csv.js");
    expect(r.ambiguous.join(" ")).toContain("被 t1、t9 认领");
  });

  it("裸文件名不是义务（沿用提取器的假阳防护）", () => {
    const t = task("t3", "src", "禁止修改 package.json，产物见 README.md 之外无");
    const r = checkContractPaths([t], () => false);
    expect(r.checked).toBe(0);
  });

  it("穿越形状**连探针都到不了**（提取器挡在前面，守卫是第二道）", () => {
    const calls: string[] = [];
    const t = task("t4", "src", "读取 ../outside/leak.js 与 src/a/b.js");
    const r = checkContractPaths([t], (p) => {
      calls.push(p);
      return true;
    });
    // `../outside/leak.js` 被提取器的起始字符守卫丢掉（前一个字符是 `/`），
    // 所以探针一次都没收到它 —— 这条断言钉的是"IO 只打在干净相对路径上"这件事，
    // 而不是 isProbeableRel 本身（它单独测）。
    expect(calls).toEqual(["src/a/b.js"]);
    expect(r.ambiguous).toEqual([]);
  });

  it("同一任务描述里点名多个文件 ⇒ 逐条核，缺哪条报哪条", () => {
    const t = task("t5", "tests", "Write tests/csv.test.js and tests/stats.test.js using node:test.");
    const r = checkContractPaths([t], (p) => p === "tests/csv.test.js");
    expect(r.checked).toBe(2);
    expect(r.gaps).toEqual([{ taskId: "t5", path: "tests/stats.test.js", indexLayout: null }]);
  });
});

describe("提取器的形状保证 —— 契约探针只可能收到干净相对路径", () => {
  // 这条性质用例替掉了一个 isProbeableRel 守卫分支：那条分支按构造不可达 ——
  // 提取器的首字符正则要求词字符、含两个点的整条丢弃、前一个字符是点或斜杠时不认路径起点。
  // 于是变异门禁判它存活（continue → break 无法被任何输入区分）。处置按本仓自己的口诀走：
  // 答不上"这支什么时候会走到"就**简化源码**，而不是加白名单。
  // 但那条保证本身仍要有判据 —— 判据钉在提取器上：它一旦放宽，这条用例先红。
  const prose = [
    "Create src/core/csv.js — CommonJS exporting parseCsv(text).",
    "禁止修改 package.json 与 ox-scripts 目录，产物见 README.md 之外无",
    "读取 ../outside/leak.js 与 反斜杠形状 C:absy.js 以及 /etc/passwd.js",
    "Write tests/csv.test.js with require of node:test, then src/report/report.js",
    "C:/x/y.js 这类绝对形状不该被认成路径",
  ].join("\n");
  const paths = extractDeclaredPaths(prose);

  it("正向对照：确实提取到了路径（否则下面全是空转）", () => {
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain("src/core/csv.js");
    expect(paths).toContain("tests/csv.test.js");
  });

  it("每一条都是可安全 join 的相对路径", () => {
    for (const p of paths) {
      expect(p.includes("..")).toBe(false);
      expect(p.startsWith("/")).toBe(false);
      expect(p.startsWith(String.fromCharCode(92))).toBe(false);
      expect(/^[A-Za-z]:/.test(p)).toBe(false);
      expect(/^[A-Za-z0-9_]/.test(p)).toBe(true);
    }
  });

  it("穿越、绝对、裸文件名三种形状都没进来", () => {
    expect(paths.filter((p) => p.includes("outside") || p.includes("passwd"))).toEqual([]);
    expect(paths.filter((p) => p === "package.json" || p === "README.md")).toEqual([]);
    expect(paths.filter((p) => /[A-Za-z]:/.test(p))).toEqual([]);
  });
});

/**
 * 三条"多元素"用例：变异门禁当场指出原来的用例集每轮只喂得进**一条**路径，
 * 于是 `continue` 被换成 `break` 也没人发现 —— 那正是"第一个之后全丢"的形状。
 */
describe("checkContractPaths —— 多元素时的 continue 语义", () => {
  const task = (id: string, zone: string, description: string): Task => ({
    id,
    title: id,
    description,
    zone,
    dependencies: [],
    suggestedRole: "backend-dev",
  });

  it("同一任务里先出现不归本 zone 的路径，再出现归本 zone 的 ⇒ 后者仍被核", () => {
    // 摘掉 `if (!isPathInZone(...)) continue` 的 continue 语义（改成 break）
    // 会让第一个不匹配的路径把整条描述的后半截丢掉。
    const t = task("t1", "src/report", "它先读 src/other/nope.js，然后写 src/report/report.js");
    const r = checkContractPaths([t], () => false);
    expect(r.checked).toBe(1);
    expect(r.gaps.map((g) => g.path)).toEqual(["src/report/report.js"]);
  });

  it("先有一条归属不唯一、后有一条归属唯一 ⇒ 后者仍被判定", () => {
    const a = task("ta", "src", "src/core/csv.js 由 src 下的任务也认领");
    const b = task("tb", "src/core/csv", "Create src/core/csv.js");
    const c = task("tc", "src/report", "Create src/report/report.js");
    const r = checkContractPaths([a, b, c], () => false);
    // src/core/csv.js 被两个 zone 认领 ⇒ ambiguous；src/report/report.js 唯一 ⇒ 必须进 gaps。
    expect(r.ambiguous.join(" ")).toContain("src/core/csv.js");
    expect(r.gaps.map((g) => g.path)).toEqual(["src/report/report.js"]);
    expect(r.checked).toBe(1);
  });

  it("输出按路径排序（两条 gap 谁先谁后是稳定的，日志与测试都靠它）", () => {
    const t = task("t9", "tests", "Write tests/stats.test.js first and tests/csv.test.js second");
    const r = checkContractPaths([t], () => false);
    expect(r.gaps.map((g) => g.path)).toEqual(["tests/csv.test.js", "tests/stats.test.js"]);
    expect(r.checked).toBe(2);
  });
});
