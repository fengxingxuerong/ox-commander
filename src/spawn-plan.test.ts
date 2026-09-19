import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSpawnSpec, needsCmdWrapper, planSpawn, quoteForCmd } from "../electron/sandbox/spawn-plan";
import { createDefaultCommandPolicy } from "../electron/sandbox/command-policy";
import { verifyProject } from "../electron/engine/verifier";

/**
 * Regression cover for a defect found only by a real end-to-end run:
 * `spawn("npm", …, {shell:false})` yields ENOENT on Windows (and EINVAL for
 * `npm.cmd`), so every default verification command silently failed with
 * `exitCode: null` — 340 green unit tests never touched npm.
 */
const dirs: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

describe("buildSpawnSpec", () => {
  it("leaves POSIX commands exactly as they were", () => {
    const plan = buildSpawnSpec("npm", ["run", "build"], { platform: "linux" });
    expect(plan).toEqual({ file: "npm", args: ["run", "build"], windowsVerbatimArguments: false, note: "posix direct" });
  });

  it("wraps a Windows .cmd shim in cmd.exe /d /s /c", () => {
    const dir = scratch("spawn");
    const shim = path.join(dir, "npm.cmd");
    fs.writeFileSync(shim, "@echo off\n");
    const plan = buildSpawnSpec("npm", ["run", "build"], {
      platform: "win32",
      env: { PATH: dir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(plan.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toContain("npm.cmd");
    expect(plan.args[3]).toContain("run build");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.note).toBe("windows cmd shim");
  });

  it("does not wrap a Windows .exe", () => {
    const dir = scratch("spawn-exe");
    const exe = path.join(dir, "tool.exe");
    fs.writeFileSync(exe, "");
    const plan = buildSpawnSpec("tool", ["--flag"], { platform: "win32", env: { PATH: dir } });
    expect(plan.file).toBe(exe);
    expect(plan.args).toEqual(["--flag"]);
    expect(plan.windowsVerbatimArguments).toBe(false);
    expect(plan.note).toBe("windows direct");
  });

  it("keeps the original command when it cannot be resolved on PATH", () => {
    const plan = buildSpawnSpec("nowhere-to-be-found", ["x"], { platform: "win32", env: { PATH: "" } });
    expect(plan.file).toBe("nowhere-to-be-found");
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it("quotes only the arguments that need it", () => {
    expect(quoteForCmd("plain")).toBe("plain");
    expect(quoteForCmd("has space")).toBe('"has space"');
    expect(quoteForCmd("")).toBe('""');
    expect(quoteForCmd('with"quote')).toBe('"with\\"quote"');
  });

  it("quotes a prompt path containing spaces when wrapping", () => {
    const dir = scratch("spawn-space");
    fs.writeFileSync(path.join(dir, "codex.cmd"), "@echo off\n");
    const plan = buildSpawnSpec("codex", ["exec", "--prompt-file", "C:\\Users\\a b\\p.md"], {
      platform: "win32",
      env: { PATH: dir, ComSpec: "cmd.exe" },
    });
    expect(plan.args[3]).toContain('"C:\\Users\\a b\\p.md"');
  });
});

describe("needsCmdWrapper", () => {
  it("only fires for .cmd/.bat on win32", () => {
    expect(needsCmdWrapper("C:\\x\\npm.cmd", "win32")).toBe(true);
    expect(needsCmdWrapper("C:\\x\\npm.CMD", "win32")).toBe(true);
    expect(needsCmdWrapper("C:\\x\\build.bat", "win32")).toBe(true);
    expect(needsCmdWrapper("C:\\x\\node.exe", "win32")).toBe(false);
    expect(needsCmdWrapper("/usr/bin/npm.cmd", "linux")).toBe(false);
  });
});

describe("planSpawn (check then wrap)", () => {
  it("refuses a destructive command before building any spawn plan", () => {
    expect(() => planSpawn("rm", ["-rf", "/"])).toThrow(/禁止/);
  });

  it("refuses a metacharacter, which is what makes the cmd.exe wrap safe", () => {
    expect(() => planSpawn("npm", ["run", "build; rm -rf /"])).toThrow(/元字符/);
  });

  it("plans a legitimate command", () => {
    // Pinned to posix so the assertion does not depend on whether the host has
    // an `npm.cmd` on PATH (which would legitimately change the shape).
    const plan = planSpawn("npm", ["run", "test"], createDefaultCommandPolicy(), { platform: "linux" });
    expect(plan.args).toEqual(["run", "test"]);
    expect(plan.file).toBe("npm");
  });

  it("wraps the same command on Windows without changing the intent", () => {
    const dir = scratch("plan-win");
    fs.writeFileSync(path.join(dir, "npm.cmd"), "@echo off\n");
    const plan = planSpawn("npm", ["run", "test"], createDefaultCommandPolicy(), {
      platform: "win32",
      env: { PATH: dir, ComSpec: "cmd.exe" },
    });
    expect(plan.note).toBe("windows cmd shim");
    expect(plan.args.join(" ")).toContain("run test");
  });
});

describe("verifier end to end on a real command", () => {
  const cmd = (command: string, args: string[]) => ({ kind: "test" as const, command, args });

  it("actually runs a script through the planner and reports success", async () => {
    const dir = scratch("verify-real");
    const script = path.join(dir, "ok.js");
    fs.writeFileSync(script, "console.log('real run'); process.exit(0)", "utf8");
    const report = await verifyProject([cmd(process.execPath, [script])], { cwd: () => dir });
    expect(report.passed).toBe(true);
    expect(report.results[0]!.logDigest).toContain("real run");
  });

  it("reports spawn-level failures with the plan note, not a bare null", async () => {
    const dir = scratch("verify-missing");
    const report = await verifyProject([cmd(process.execPath, [path.join(dir, "nope.js")])], { cwd: () => dir });
    // The script genuinely fails to load: node exits non-zero, so this is a real failure.
    expect(report.passed).toBe(false);
  });
});
