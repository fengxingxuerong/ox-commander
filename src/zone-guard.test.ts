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

/**
 * `scanFiles` 的四个 `continue`（跳过 node_modules/.git、递归后继续同级、
 * 非普通文件跳过、读文件失败跳过）此前**全部零覆盖** —— 变异成 `break` 后
 * 测试照样全绿。它们的共同点：现有用例里"被跳过的项"永远排在同级**最后一项**，
 * 于是 continue 与 break 行为相同。下面每条都刻意让「被跳过的项」后面
 * **还有兄弟项**，把两个分支的差异钉出来。
 */
describe("ZoneGuard · scanFiles 跳过分支（变异测试发现的缺口）", () => {
  it("跳过 node_modules 后仍继续遍历同级 —— 排序在被跳过目录之后的兄弟不能被漏掉", () => {
    // "aaa" 排在 "node_modules" 之前，保证目录列举顺序下 node_modules 不是最后一项。
    // 若 48 行 continue 变 break，`zzz` 会被整个漏掉。
    write("aaa/keep.js", "keep");
    write("node_modules/pkg/index.js", "x");
    write("zzz/also-kept.js", "kept");
    const guard = new ZoneGuard();
    const files = [...guard.snapshot(root).files.keys()].sort();
    expect(files).toEqual(["aaa/keep.js", "zzz/also-kept.js"]);
  });

  it("递归进子目录后仍继续同级 —— 同级的后续文件不能被漏掉", () => {
    // 目录项排在前面时，50 行的 continue → break 会终止整个 for 循环，
    // 同级的普通文件就此消失。
    write("adir/inner.js", "inner");
    write("plain.js", "plain");
    const guard = new ZoneGuard();
    const files = [...guard.snapshot(root).files.keys()].sort();
    expect(files).toEqual(["adir/inner.js", "plain.js"]);
  });

  it("非普通文件（无 isFile 且非目录）被跳过但不终止扫描", () => {
    // 用一个既非目录也非文件的 Dirent（如 fifo/socket）验证 52 行分支：
    // 它必须被跳过，且同级的普通文件仍要被收集。
    const calls: string[] = [];
    const fakeFs = {
      existsSync: () => true,
      readdirSync: (dir: string) => {
        calls.push(dir);
        if (dir !== root) return [];
        return [
          { name: "pipe", isDirectory: () => false, isFile: () => false },
          { name: "real.js", isDirectory: () => false, isFile: () => true },
        ];
      },
      readFileSync: () => "content",
    };
    const guard = new ZoneGuard(fakeFs as never);
    expect([...guard.snapshot(root).files.keys()]).toEqual(["real.js"]);
  });

  it("单个文件读取失败被跳过，同级的其他文件仍然进快照", () => {
    const fakeFs = {
      existsSync: () => true,
      readdirSync: () => [
        { name: "bad.js", isDirectory: () => false, isFile: () => true },
        { name: "good.js", isDirectory: () => false, isFile: () => true },
      ],
      readFileSync: (p: string) => {
        if (p.endsWith("bad.js")) throw new Error("EACCES");
        return "ok";
      },
    };
    const guard = new ZoneGuard(fakeFs as never);
    // 57 行 continue → break 时 good.js 会消失（bad.js 排在它前面）
    expect([...guard.snapshot(root).files.keys()]).toEqual(["good.js"]);
  });

  it("读目录失败时该子树整体跳过，不影响同级其余目录", () => {
    const fakeFs = {
      existsSync: () => true,
      readdirSync: (dir: string) => {
        if (dir === path.join(root, "locked")) throw new Error("EPERM");
        if (dir !== root) return [];
        return [
          { name: "locked", isDirectory: () => true, isFile: () => false },
          { name: "open", isDirectory: () => true, isFile: () => false },
        ];
      },
      readFileSync: () => "content",
    };
    const guard = new ZoneGuard(fakeFs as never);
    // 43 行 catch 里的 return 只放弃这一棵子树，不能带走兄弟目录
    expect([...guard.snapshot(root).files.keys()]).toEqual([]);
  });
});
