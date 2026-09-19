import { describe, expect, it } from "vitest";
import { extractErrorFiles, routeVerificationErrors } from "../shared/routing";
import type { Task, VerificationReport } from "../shared/types";

function task(id: string, zone: string): Task {
  return {
    id,
    title: id,
    description: "d",
    zone,
    dependencies: [],
    suggestedRole: "fullstack-dev",
  };
}

function report(entries: Array<{ kind: "build" | "test"; digest: string }>): VerificationReport {
  return {
    passed: entries.length === 0,
    results: entries.map((e) => ({
      kind: e.kind,
      ok: false,
      exitCode: 1,
      logDigest: e.digest,
      durationMs: 5,
    })),
  };
}

describe("extractErrorFiles", () => {
  it("extracts tsc-style paths", () => {
    const log = [
      "src/calc.ts(12,3): error TS2339: Property 'x' does not exist",
      "src/util/math.ts:4:1 - error TS7006: Parameter implicitly has an 'any' type",
    ].join("\n");
    expect(extractErrorFiles(log).sort()).toEqual(["src/calc.ts", "src/util/math.ts"]);
  });

  it("extracts node stack frames and relativizes them against the workspace root", () => {
    const log = [
      "TypeError: cannot read property 'n' of undefined",
      "    at add (D:\\proj\\src\\add.js:5:17)",
      "    at Object.<anonymous> (tests/add.test.js:9:3)",
    ].join("\n");
    expect(extractErrorFiles(log, "D:/proj").sort()).toEqual(["src/add.js", "tests/add.test.js"]);
  });

  it("drops absolute stack paths that live outside the workspace root", () => {
    const log = "    at fn (C:\\other\\place\\x.js:1:1)";
    expect(extractErrorFiles(log, "D:/proj")).toEqual([]);
  });

  it("extracts node:test / mocha FAIL lines", () => {
    const log = ["✖ tests/store.test.js", "FAIL tests/api.test.js"].join("\n");
    expect(extractErrorFiles(log).sort()).toEqual(["tests/api.test.js", "tests/store.test.js"]);
  });

  it("ignores node_modules internals", () => {
    const log = "    at Module._compile (node:internal/modules/cjs/loader:1105:14)\n    at f (node_modules/pkg/index.js:1:1)";
    expect(extractErrorFiles(log)).toEqual([]);
  });
});

describe("routeVerificationErrors", () => {
  it("routes errors only to the task owning the failing file's zone", () => {
    const t1 = task("t1", "src/calc");
    const t2 = task("t2", "src/api");
    const rpt = report([{ kind: "test", digest: "    at fn (src/calc/math.js:3:1)\nboom" }]);
    const routed = routeVerificationErrors(rpt, [t1, t2]);
    expect(routed.byTask.get("t1")).toContain("src/calc/math.js");
    expect(routed.byTask.has("t2")).toBe(false);
    expect(routed.unattributed).toBe("");
  });

  it("collects unattributable errors separately", () => {
    const t1 = task("t1", "src/calc");
    const rpt = report([{ kind: "build", digest: "some linker error with no file path" }]);
    const routed = routeVerificationErrors(rpt, [t1]);
    expect(routed.byTask.size).toBe(0);
    expect(routed.unattributed).toContain("linker error");
  });

  it("root-zone task absorbs every error", () => {
    const t1 = task("t1", ".");
    const rpt = report([{ kind: "test", digest: "    at fn (src/anywhere.js:3:1)" }]);
    const routed = routeVerificationErrors(rpt, [t1]);
    expect(routed.byTask.get("t1")).toContain("src/anywhere.js");
  });

  it("empty failing digest yields nothing", () => {
    const routed = routeVerificationErrors(
      { passed: true, results: [] },
      [task("t1", "src")],
    );
    expect(routed.byTask.size).toBe(0);
    expect(routed.unattributed).toBe("");
  });
});
