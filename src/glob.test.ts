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
