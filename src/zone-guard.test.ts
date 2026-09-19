import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZoneGuard, isInsideZone } from "../electron/engine/zone-guard";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-zone-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

describe("isInsideZone", () => {
  it("root zone owns everything", () => {
    expect(isInsideZone("anything/file.js", ".")).toBe(true);
    expect(isInsideZone("anything/file.js", "")).toBe(true);
  });

  it("matches the zone dir itself and nested paths, not siblings", () => {
    expect(isInsideZone("src/core", "src/core")).toBe(true);
    expect(isInsideZone("src/core/foo.js", "src/core")).toBe(true);
    expect(isInsideZone("src/corex/foo.js", "src/core")).toBe(false);
    expect(isInsideZone("src/other/foo.js", "src/core")).toBe(false);
  });

  it("normalizes windows separators in the zone", () => {
    expect(isInsideZone("src/core/foo.js", "src\\core")).toBe(true);
  });
});

describe("ZoneGuard", () => {
  it("detects added, modified and deleted files", () => {
    write("src/a.js", "a");
    write("src/b.js", "b");
    const guard = new ZoneGuard();
    const before = guard.snapshot(root);

    write("src/a.js", "changed");
    fs.rmSync(path.join(root, "src/b.js"));
    write("src/c.js", "c");

    const diff = guard.diff(root, before);
    expect(diff.added).toEqual(["src/c.js"]);
    expect(diff.modified).toEqual(["src/a.js"]);
    expect(diff.deleted).toEqual(["src/b.js"]);
  });

  it("skips node_modules and .git churn", () => {
    const guard = new ZoneGuard();
    const before = guard.snapshot(root);
    write("node_modules/pkg/index.js", "x");
    write(".git/HEAD", "x");
    const diff = guard.diff(root, before);
    expect(diff.added).toEqual([]);
  });

  it("flags files changed outside every declared zone", () => {
    write("src/core/a.js", "a");
    const guard = new ZoneGuard();
    const before = guard.snapshot(root);

    write("src/core/a.js", "changed"); // inside zone
    write("rogue/file.js", "boom"); // outside every zone

    const diff = guard.diff(root, before);
    const violations = guard.unownedChanges(diff, ["src/core"]);
    expect(violations).toEqual(["rogue/file.js"]);
  });

  it("empty root snapshot yields no violations on empty diff", () => {
    const guard = new ZoneGuard();
    const before = guard.snapshot(root);
    expect(guard.unownedChanges(guard.diff(root, before), ["src/core"])).toEqual([]);
  });
});
