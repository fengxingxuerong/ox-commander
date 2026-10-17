import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOnPath, splitPathEnv } from "../shared/cli-detect";
import { CANDIDATES, detectInstalledClis } from "../electron/agents/cli-detect";
import { parseAgentManifest } from "../electron/agents/manifest-schema";

const roots: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-detect-${tag}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
}, 30_000);

describe("splitPathEnv", () => {
  it("空串 ⇒ 空列表（不是 [\"\"]）", () => {
    expect(splitPathEnv("", false)).toEqual([]);
  });

  it("POSIX 冒号切分，去掉空段", () => {
    expect(splitPathEnv("/usr/bin:/bin", false)).toEqual(["/usr/bin", "/bin"]);
    expect(splitPathEnv("/usr/bin::/bin", false)).toEqual(["/usr/bin", "/bin"]);
  });

  it("Windows 分号切分：驱动号里的冒号不是分隔符", () => {
    // 这条同时是一条回归测试：靠"字符串里有没有分号"去猜平台，会把
    // `C:\bin` 切成 `C` + `\bin` —— 于是 Windows 上什么都扫不到。
    expect(splitPathEnv("C:\\bin;D:\\tools", true)).toEqual(["C:\\bin", "D:\\tools"]);
  });

  it("同一个串在不同平台下切法不同（平台必须来自调用方，不猜）", () => {
    expect(splitPathEnv("C:\\bin", true)).toEqual(["C:\\bin"]);
    // POSIX 切法会把驱动号后的冒号当分隔符 ⇒ 一段变两段（这正是"扫不到"的来源）
    expect(splitPathEnv("C:\\bin", false)).toEqual(["C", "\\bin"]);
  });
});

describe("resolveOnPath", () => {
  const dirs = ["/usr/bin", "/opt/bin"];
  const exists = (abs: string) => abs === "/opt/bin/claude";

  it("按目录顺序找到就返回，且是拼接出来的绝对路径", () => {
    expect(resolveOnPath("claude", dirs, exists, false)).toBe("/opt/bin/claude");
  });

  it("找不到 ⇒ null（不是空串）", () => {
    expect(resolveOnPath("codex", dirs, exists, false)).toBeNull();
  });

  it("Windows 形态：无扩展名优先，其次 .cmd/.bat/.exe", () => {
    const present = new Set(["/b/claude.cmd"]);
    const e = (abs: string) => present.has(abs);
    expect(resolveOnPath("claude", ["/b"], e, true)).toBe("/b/claude.cmd");
    present.clear();
    present.add("/b/claude.exe");
    expect(resolveOnPath("claude", ["/b"], e, true)).toBe("/b/claude.exe");
  });

  it("命令名里带分隔符时不查 PATH（那是路径，不是命令）", () => {
    const e = () => true;
    expect(resolveOnPath("C:/evil/claude", ["/b"], e, true)).toBeNull();
    expect(resolveOnPath("sub/claude", ["/b"], e, false)).toBeNull();
  });

  it("空命令 ⇒ null", () => {
    expect(resolveOnPath("", ["/b"], () => true, false)).toBeNull();
  });
});

describe("候选表（与 agents.d/*.example.json 逐条比对）", () => {
  /** 仓内模板目录（真文件）：候选表必须与它一致，否则界面接入的是另一份参数。 */
  function templates(): Record<string, Record<string, unknown>> {
    const dir = path.join(process.cwd(), "agents.d");
    const out: Record<string, Record<string, unknown>> = {};
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".example.json")) continue;
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
      out[String(raw.id)] = raw;
    }
    return out;
  }

  it("每个候选在仓内都有一份同名模板，且 command 一致", () => {
    const t = templates();
    for (const c of CANDIDATES) {
      const tpl = t[c.id];
      expect(tpl, `agents.d 里没有 ${c.id} 的模板`).toBeTruthy();
      const entry = tpl!.entry as { command?: string };
      expect(entry.command, `${c.id} 的 command 与模板不一致`).toBe(c.command);
    }
  });

  it("每个候选的 manifest 都过契约校验（接入时不会当场报错）", () => {
    for (const c of CANDIDATES) {
      expect(() => parseAgentManifest(c.manifest), `${c.id} 的 manifest 不合法`).not.toThrow();
    }
  });

  it("从模板复制的那几份：argsTemplate 与模板逐字一致", () => {
    // codex 那份的单一事实源是 `exampleManifest()`（界面"填入示例"也用它），
    // 所以只比 command，不比 args 文本。
    const t = templates();
    for (const c of CANDIDATES) {
      if (c.id === "codex-cli") continue;
      const entry = t[c.id]!.entry as { argsTemplate?: string[] };
      const mine = (c.manifest.entry as { argsTemplate?: string[] }).argsTemplate;
      expect(mine, `${c.id} 的 argsTemplate 与模板不一致`).toEqual(entry.argsTemplate);
    }
  });

  it("每个候选都有非空安装提示（没核实的那条也说明理由）", () => {
    for (const c of CANDIDATES) {
      expect(c.installHint.trim(), `${c.id} 没有安装提示`).not.toBe("");
    }
  });
});

describe("detectInstalledClis", () => {
  it("PATH 里有命令 ⇒ found 且给绝对路径；没有 ⇒ found=false 且不带 absPath", () => {
    const dir = scratch("found");
    fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off", "utf8");
    const out = detectInstalledClis({ pathEnv: dir, isWindows: true, registeredIds: new Set() });
    const claude = out.find((c) => c.id === "claude-code")!;
    const gemini = out.find((c) => c.id === "gemini-cli")!;
    expect(claude.found).toBe(true);
    // shared 层不 import node:path（分层红线），拼接用的是正斜杠 —— 断言
    // "指向那个目录下的那个文件"，而不是钉死分隔符形态。
    expect(claude.absPath!.replace(/\\/g, "/")).toBe(`${dir.replace(/\\/g, "/")}/claude.cmd`);
    expect(gemini.found).toBe(false);
    expect("absPath" in gemini).toBe(false); // 缺席就不给这个键
    expect(gemini.installHint).toContain("gemini-cli");
  });

  it("平台串了就扫不到（Windows 串用 POSIX 分隔符 ⇒ 全未找到）", () => {
    // 反面钉住"分隔符必须与平台一致"：把 Windows 的 PATH 串按 POSIX 来切，
    // 每段都被切碎，于是明明装了也扫不到 —— 这种失败在真机上表现为
    // "我的 claude 明明在 PATH 里，它却说没装"。
    const dir = scratch("posix-sep");
    fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh", "utf8");
    const winStyle = `C:\\bin;${dir}`;
    expect(detectInstalledClis({ pathEnv: winStyle, isWindows: true }).find((c) => c.id === "codex-cli")!.found).toBe(
      true,
    );
    expect(detectInstalledClis({ pathEnv: winStyle, isWindows: false }).find((c) => c.id === "codex-cli")!.found).toBe(
      false,
    );
  });

  it("已注册的候选标记 registered（接入按钮据此消失）", () => {
    const dir = scratch("registered");
    fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh", "utf8");
    const out = detectInstalledClis({
      pathEnv: dir,
      isWindows: false,
      registeredIds: new Set(["claude-code"]),
    });
    expect(out.find((c) => c.id === "claude-code")!.registered).toBe(true);
    expect(out.find((c) => c.id === "codex-cli")!.registered).toBe(false);
  });

  it("PATH 为空（环境里没有）⇒ 全部未找到，不抛", () => {
    const out = detectInstalledClis({ pathEnv: "" });
    expect(out.length).toBe(CANDIDATES.length);
    expect(out.every((c) => c.found === false)).toBe(true);
  });

  it("不注入平台时按真 platform 走（默认分支不能没人守）", () => {
    // 本机（Windows）上 PATH 是 `C:\…` 形态：按 ";" 切才能扫到；默认分支
    // 若取反（`process.platform !== "win32"`）就会按 ":" 切，于是"明明装了
    // 却说没装"。这条在 Linux CI 上同样成立（那边反过来按 ":" 切）。
    // ⚠️ pathEnv 必须是**两段**（第一段不存在）：单段串在两种切法下都还原成
    // 同一个目录 —— 2026-10-18 实测，单段版本在 Linux 上放过 @300 的
    // `===`→`!==` 变异体（那是"平台默认值取反"的真缺口，不是等价变异）。
    const dir = scratch("default-platform");
    fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off", "utf8");
    fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh", "utf8");
    const win = process.platform === "win32";
    const missing = path.join(os.tmpdir(), "ox-detect-missing-definitely-not-here");
    const pathEnv = [missing, dir].join(path.delimiter);
    const out = detectInstalledClis({ pathEnv }); // 不传 isWindows
    expect(out.find((c) => c.id === "claude-code")!.found).toBe(true);
    expect(win).toBe(process.platform === "win32"); // 断言形状，避免平台逻辑写反
  });

  it("每个候选都带可直接注册的 manifest", () => {
    const out = detectInstalledClis({ pathEnv: "" });
    for (const c of out) {
      expect(() => parseAgentManifest(c.manifest), `${c.id} 的 manifest 不合法`).not.toThrow();
    }
  });
});
