import { describe, expect, it } from "vitest";
import { compileGlob, isPathInZone, isUnrestrictedGlob, matchesAnyGlob, zoneWithinGlobs } from "../shared/glob";

describe("compileGlob", () => {
  it("matches everything beneath a directory pattern", () => {
    const re = compileGlob("src/**");
    expect(re.test("src")).toBe(true);
    expect(re.test("src/core/a.js")).toBe(true);
    expect(re.test("tests/a.js")).toBe(false);
  });

  it("treats **/ as zero or more directories", () => {
    const re = compileGlob("**/x.js");
    expect(re.test("x.js")).toBe(true);
    expect(re.test("a/b/x.js")).toBe(true);
    expect(re.test("a/b/y.js")).toBe(false);
  });

  it("keeps * inside one segment only", () => {
    const re = compileGlob("src/*");
    expect(re.test("src/a.js")).toBe(true);
    expect(re.test("src/deep/a.js")).toBe(false);
  });

  it("normalizes backslashes and leading ./", () => {
    expect(compileGlob("./src\\core").test("src/core")).toBe(true);
  });
});

describe("isUnrestrictedGlob", () => {
  it("flags scope-free patterns", () => {
    for (const g of ["**", "**/*", "*", "."]) expect(isUnrestrictedGlob(g)).toBe(true);
    expect(isUnrestrictedGlob("src/**")).toBe(false);
    expect(isUnrestrictedGlob("tests")).toBe(false);
  });
});

describe("matchesAnyGlob", () => {
  it("returns false for an empty glob list", () => {
    expect(matchesAnyGlob("src/a.js", [])).toBe(false);
  });

  it("short-circuits on an unrestricted glob", () => {
    expect(matchesAnyGlob("anything/at/all.js", ["**"])).toBe(true);
  });
});

describe("zoneWithinGlobs", () => {
  it("covers sub-directories of a scoped glob", () => {
    expect(zoneWithinGlobs("src/core", ["src/**"])).toBe(true);
    expect(zoneWithinGlobs("src", ["src/**"])).toBe(true);
  });

  it("rejects a sibling directory", () => {
    expect(zoneWithinGlobs("tests", ["src/**"])).toBe(false);
  });

  it("does not treat a single-level glob as covering sub-directories", () => {
    expect(zoneWithinGlobs("src/core", ["src/core/*"])).toBe(false);
  });

  it("lets the project root be claimed only by an unrestricted glob", () => {
    expect(zoneWithinGlobs(".", ["src/**"])).toBe(false);
    expect(zoneWithinGlobs(".", ["**"])).toBe(true);
    expect(zoneWithinGlobs("", ["**"])).toBe(true);
  });
});

describe("isPathInZone", () => {
  it("owns everything for the root zone", () => {
    expect(isPathInZone("anything/at/all.js", ".")).toBe(true);
    expect(isPathInZone("anything/at/all.js", "")).toBe(true);
  });

  it("owns a directory and everything beneath it", () => {
    expect(isPathInZone("src/store/index.js", "src/store")).toBe(true);
    expect(isPathInZone("src/store", "src/store")).toBe(true);
    expect(isPathInZone("src/other/index.js", "src/store")).toBe(false);
  });

  it("owns the module files of a module-shaped zone", () => {
    // Found by a real run: the planner wrote zone "src/duration" while the model
    // produced "src/duration.js" — a strict directory check called that a
    // violation, rolled the file back, and failed every batch.
    expect(isPathInZone("src/duration.js", "src/duration")).toBe(true);
    expect(isPathInZone("src/duration.test.js", "src/duration")).toBe(true);
    expect(isPathInZone("tests/duration.test.js", "tests/duration")).toBe(true);
  });

  it("stays bounded: a dash-sibling is not owned, but real sub-paths are", () => {
    // `src/duration-extra.js` shares a prefix with the zone but is a different file.
    expect(isPathInZone("src/duration-extra.js", "src/duration")).toBe(false);
    // A directory named like the zone still owns everything beneath it.
    expect(isPathInZone("src/duration/sub/x.js", "src/duration")).toBe(true);
    // Sibling files of the same module are owned.
    expect(isPathInZone("src/duration.js.bak", "src/duration")).toBe(true);
  });

  it("requires the module-file suffix to be a non-empty single segment", () => {
    // Both halves of the `rest !== "" && !rest.includes("/")` guard must be
    // load-bearing. Found by mutation testing: flipping `&&` to `||` kept every
    // test green, because no case exercised either half in isolation — and the
    // flipped version *widens* the zone (a nested path is wrongly owned).
    //
    // Empty remainder: `src/duration.` is not a module file of `src/duration`.
    expect(isPathInZone("src/duration.", "src/duration")).toBe(false);
    // Nested remainder: a directory named like the module is NOT owned via the
    // module-file rule — only via the `zone/` prefix rule, which this is not.
    expect(isPathInZone("src/duration.sub/x.js", "src/duration")).toBe(false);
    expect(isPathInZone("src/duration./x.js", "src/duration")).toBe(false);
  });

  it("normalizes separators and leading ./", () => {
    expect(isPathInZone("./src\\store\\a.js", "src/store/")).toBe(true);
    expect(isPathInZone("src/duration.js", "./src/duration")).toBe(true);
  });

  it("does not let a shorter zone swallow a longer directory name", () => {
    expect(isPathInZone("srcfoo/a.js", "src")).toBe(false);
    expect(isPathInZone("src/a.js", "src")).toBe(true);
  });
});

/**
 * 下面这几条来自 site 逐位点审计（glob.ts 5 处存活）。
 *
 * 共同点：存活的都是"两个分支几乎互斥 / 或恒被短路"的写法 ——
 * 必须挑出**只有一个分支成立**的输入才能区分，而既有用例都落在
 * "两个都成立"或"两个都不成立"的区域里。
 */
describe("compileGlob · ? 后面还有内容", () => {
  it("? 不在模式末尾时，其后的字符不能被丢掉", () => {
    // 编译循环里 `?` 分支后的 `continue`（第 46 行）。改成 break 之后，
    // 遇到第一个 `?` 就退出循环 —— `a?b` 只编译成 `a[^/]`，尾部的 b 被丢掉，
    // 于是 `/^a[^/]$/` 既匹配不了 "axb"（漏报），又会误匹配 "ab"（误报）。
    const re = compileGlob("a?b");
    expect(re.test("axb")).toBe(true);
    expect(re.test("ab")).toBe(false);
  });
});

describe("matchesAnyGlob · 受限 glob 仍然生效", () => {
  it("受限 glob 按模式匹配，而不是被「不受限」条件吞掉", () => {
    // 第 73 行 `isUnrestrictedGlob(g) || compiled(g).test(p)`。
    // 改成 `&&` 之后，任何**受限** glob 都不再匹配任何东西 ——
    // 受保护路径清单（DEFAULT_FORBIDDEN_WRITE）会整体失效，这是放行而非拦截。
    expect(matchesAnyGlob("src/core/a.js", ["src/**"])).toBe(true);
    expect(matchesAnyGlob("tests/a.js", ["src/**"])).toBe(false);
  });
});

describe("zoneWithinGlobs · 边界", () => {
  it("不受限的 '.' glob 覆盖任意 zone（不能掉到 compiled('.') 去兜）", () => {
    // 第 111 行 `if (isUnrestrictedGlob(pattern)) return true;`。
    // 改成 `return false` 后会掉进下面的分支，而 `compiled('.')` 是 /^\.$/ ——
    // 它只匹配字面的 "."，于是 zone "src" 不再被 "." 覆盖。
    expect(zoneWithinGlobs("src", ["."])).toBe(true);
    expect(zoneWithinGlobs("src/core/deep", ["."])).toBe(true);
  });

  it("glob 直接写出 zone 本身、或写出其父级时都算覆盖", () => {
    // 第 120 行 `re.test(z) || z.startsWith(`${pattern}/`)`。
    // 这两个分支几乎互斥：z 等于 pattern 时后者必假，z 在 pattern 之下时前者必假。
    // 改成 `&&` 之后整行恒假 —— 只有"恰好等于"与"在其之下"各一条用例才能区分。
    expect(zoneWithinGlobs("src/core", ["src/core"])).toBe(true);
    expect(zoneWithinGlobs("src/core/deep", ["src/core"])).toBe(true);
    expect(zoneWithinGlobs("tests", ["src/core"])).toBe(false);
  });

  it("空 glob 不代表覆盖项目根", () => {
    // 第 108 行 `if (z === "" || z === ".") return globs.some(isUnrestrictedGlob);`
    // 改成 `&&` 后该条件恒假，会掉进下面的循环，而 `compiled("")` 是 /^$/ ——
    // 空 zone 会被空 glob"匹配"上，等于把项目根判成被覆盖。
    // 这是 project-root 只认不受限 glob 这条策略的兜底。
    expect(zoneWithinGlobs("", [""])).toBe(false);
  });
});
