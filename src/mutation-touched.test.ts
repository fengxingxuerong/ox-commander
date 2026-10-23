import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `mutation:touched` 的审计范围判定（基线选择 + 未跟踪并入）。
 *
 * 门禁脚本刻意不在变异 TARGETS 里（把变异体写进判据自身再启动判据去测，自指会让
 * 审计失去意义），它的正确性靠本文件按锚点抠出 `resolveAuditScope` 注入假 git
 * 逐条钉住 —— 手法与 src/mutation-residue.test.ts 同族：锚点不在了当场说清，
 * 而不是让用例静默失效。
 *
 * 为什么盯这个函数：2026-10-23 实弹踩过一次 —— 旧判据拿 `git status --porcelain`
 * 非空当「脏」，而未跟踪文件既算进 porcelain、又不进 `git diff HEAD`，于是工作区里
 * 一个杂散文件就把基线顶成 HEAD、待审集合为空，「最后一笔提交」整个没被审还报 PASS。
 * 审计范围被无关文件静默改写，比不审更糟：它带着一个绿章进了 verify。
 */
const SCRIPT = path.join(path.resolve(__dirname, ".."), "scripts", "mutation-touched.mjs");

/** 假 git：只认两条 status 形态，别的调用当场炸 —— 判据协议变了，这里必须跟着醒。 */
function fakeGit(statusNoUntracked: string, statusAll: string) {
  return (args: string[]): string => {
    if (args[0] === "status" && args.includes("--porcelain") && args.includes("--untracked-files=no")) {
      return statusNoUntracked;
    }
    if (args[0] === "status" && args.includes("--porcelain") && args.includes("--untracked-files=all")) {
      return statusAll;
    }
    throw new Error(`resolveAuditScope 不该发起这条调用：git ${args.join(" ")}`);
  };
}

/**
 * 按锚点把判定区从门禁脚本里抠出来求值。
 * 区首/区尾锚点是两段块注释的完整开头（`决定本轮审谁` 与 `基线落定后的主流程`），
 * 两者都在脚本里唯一；挪动或改名会让这里红出来，处置是把锚点跟上（而不是删用例）。
 *
 * ⚠️ 先把行尾归一成 LF 再找锚点：win32 上的 git 检出是 **CRLF**，用 `\n` 组成的
 * 锚点会一个都找不到 —— CI 的 windows job 就是这样红的（ubuntu 是 LF，本机工作区
 * 也是 LF，所以本地永远绿）。切出来的区段同样来自归一后的文本，它是拿去
 * `new Function` 的，行尾形式无所谓。
 */
function loadResolveAuditScope(): (gitFn: (args: string[]) => string, args: string[]) => { base: string; untracked: string[] } {
  const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("/*\n * 决定本轮审谁");
  const end = src.indexOf("/*\n * 基线落定后的主流程");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("无法在 mutation-touched.mjs 里定位审计范围判定区（锚点被改名或移动了？）");
  }
  const factory = new Function(
    `${src.slice(start, end)}\nreturn resolveAuditScope;`,
  ) as () => (gitFn: (args: string[]) => string, args: string[]) => { base: string; untracked: string[] };
  return factory();
}

describe("resolveAuditScope（mutation:touched 的审计范围）", () => {
  it("完全干净 ⇒ 审最后一笔（HEAD~1..HEAD），未跟踪清单为空", () => {
    const scope = loadResolveAuditScope()(fakeGit("", ""), []);
    expect(scope.base).toBe("HEAD~1");
    expect(scope.untracked).toEqual([]);
  });

  it("只有未跟踪的杂散文件 ⇒ 仍审最后一笔（杂散文件不许把基线顶成 HEAD）", () => {
    // 2026-10-23 的现场：工作区干净、只因多了一个未跟踪的 audit.json，
    // 旧判据输出「基线=HEAD 改动文件=0」—— 最后一笔提交整个没被审。
    const scope = loadResolveAuditScope()(fakeGit("", "?? audit.json\n"), []);
    expect(scope.base).toBe("HEAD~1");
    expect(scope.untracked).toEqual(["audit.json"]);
  });

  it("有已跟踪/已暂存的改动 ⇒ 以 HEAD 为基线（审「准备交出去的东西」）", () => {
    const scope = loadResolveAuditScope()(fakeGit(" M src/store.ts\nA  shared/new-file.ts\n", ""), []);
    expect(scope.base).toBe("HEAD");
    expect(scope.untracked).toEqual([]);
  });

  it("未跟踪文件恒并入待审集合 —— 全新的生产文件在 diff 的两种形态里都看不见", () => {
    // 已跟踪改动 + 未跟踪的新文件并存：基线按已跟踪改动取 HEAD，新文件照样要审。
    const scope = loadResolveAuditScope()(
      fakeGit(" M electron/chat/runtime.ts\n", "?? shared/skills.ts\n?? logs/trace.log\n"),
      [],
    );
    expect(scope.base).toBe("HEAD");
    expect(scope.untracked).toEqual(["shared/skills.ts", "logs/trace.log"]);
  });

  it("未跟踪目录项剥掉尾斜杠（目录本身不是变异目标，别拿脏路径去匹配）", () => {
    const scope = loadResolveAuditScope()(fakeGit("", "?? scratch-dir/\n?? real-file.ts\n"), []);
    expect(scope.untracked).toEqual(["scratch-dir", "real-file.ts"]);
  });

  it("--base=<ref> 覆盖基线选择，但不覆盖「未跟踪恒并入」", () => {
    const scope = loadResolveAuditScope()(fakeGit(" M src/store.ts\n", "?? shared/skills.ts\n"), ["--base=main"]);
    expect(scope.base).toBe("main");
    expect(scope.untracked).toEqual(["shared/skills.ts"]);
  });
});
