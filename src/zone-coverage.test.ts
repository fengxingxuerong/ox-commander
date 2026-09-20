import { describe, expect, it } from "vitest";
import { declaredArtifactPaths, extractDeclaredPaths, findOrphanPaths } from "../shared/zone-coverage";
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
