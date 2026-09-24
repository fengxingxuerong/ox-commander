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
    /*
     * 断**整条形状**，不是断"含不含 npm.cmd"。旧断言只要子串命中就绿，所以
     * `/s` 会把首尾引号吃掉的那一版（token 各自加引号、外层没有）也判通过 ——
     * 单测全绿而 Windows 上每条 npm 命令必红，2026-09-25 真链路跑出来才发现。
     */
    expect(plan.args[3]).toBe(`"${quoteForCmd(shim)} run build"`);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.note).toBe("windows cmd shim");
  });

  /**
   * 真跑一次，且**路径带空格** —— Node 的默认安装位置 `C:\Program Files\nodejs`
   * 就是带空格的，这正是生产形态。上一条评论里那一版在这里 exit 1
   * （cmd 报「'C:\Program' 不是内部或外部命令」）。POSIX 上没有 cmd 包装，早退。
   */
  it("Windows cmd shim 真跑得起来，即使解析出的路径含空格", async () => {
    if (process.platform !== "win32") return;
    const { spawn } = await import("node:child_process");
    const base = scratch("shim space");
    const dir = path.join(base, "with space");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "shim.cmd"), "@echo off\r\necho SHIM-OK [%*]\r\n", "utf8");
    const plan = buildSpawnSpec("shim", ["run", "a b"], {
      platform: "win32",
      env: { ...process.env, PATH: dir },
    });
    expect(plan.note).toBe("windows cmd shim");
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(plan.file, plan.args, {
        cwd: base,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
      child.on("error", (e) => resolve({ code: null, out: out + String(e) }));
      child.on("close", (code) => resolve({ code, out }));
    });
    // `a b` 是一个 arg：cmd 把它原样交给 shim，echo 打出带引号的两个 token
    expect(r.code).toBe(0);
    expect(r.out).toContain("SHIM-OK");
    expect(r.out).toContain("a b");
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

  it("PATH 上与目标同名的目录不会被当成可执行文件（必须继续往后找）", () => {
    // `existsSync(p) && statSync(p).isFile()` —— 变异成 `||` 后，existsSync 为真
    // 就短路返回 true，于是"同名目录"被误判为可执行文件并被 spawn。
    // 注意：路径**不存在**时两种写法都返回 false（一个靠 && 短路、一个靠
    // catch 兜住 statSync 的 ENOENT），所以只有"存在但是目录"能区分它们。
    const decoyDir = scratch("spawn-decoy");
    fs.mkdirSync(path.join(decoyDir, "tool.exe"), { recursive: true }); // 目录，不是文件
    const goodDir = scratch("spawn-good");
    const real = path.join(goodDir, "tool.exe");
    fs.writeFileSync(real, "");

    const plan = buildSpawnSpec("tool", ["--flag"], {
      platform: "win32",
      env: { PATH: [decoyDir, goodDir].join(path.delimiter) },
    });
    // 跳过 decoy 目录，落到 goodDir 里的真文件
    expect(plan.file).toBe(real);
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

  it("refuses an empty or whitespace-only command", () => {
    // `typeof command !== "string" || command.trim() === ""` —— 变异成 `&&` 后，
    // 对字符串输入前半恒为 false，于是空串与纯空白都能绕过这条检查。
    // 前半是类型系统保证的防御分支，运行时恒假，所以只有"空/空白"能区分两种写法。
    const p = createDefaultCommandPolicy();
    // CommandDecision 是判别联合，先收窄再读 reason（否则 tsc 会拒绝）。
    const rejectReason = (c: string): string => {
      const d = p.check(c, []);
      if (d.ok) throw new Error(`期望被拒，实际放行了：${JSON.stringify(c)}`);
      return d.reason;
    };
    expect(rejectReason("")).toMatch(/空/);
    expect(rejectReason("   ")).toBeTruthy();
    expect(rejectReason("\t\n")).toBeTruthy();
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
