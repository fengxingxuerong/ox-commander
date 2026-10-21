import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BRANCH_RE,
  deliveryStamp,
  exportDeliveryBranch,
  parseStatusZ,
  type GitExportInput,
} from "../electron/engine/git-export";

/** 注入式 runner：按脚本回放，记录每次调用（不真 spawn——真 git 的用例在最后）。 */
function fakeRunner(script: Array<{ code: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let i = 0;
  const run = async (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return { code: step.code, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { run, calls };
}

function base(input: Partial<GitExportInput> = {}): GitExportInput {
  return {
    projectRoot: "D:/proj",
    zones: ["src"],
    branch: "oxcommander/delivery-20261011-120000",
    message: "OxCommander delivery",
    ...input,
  };
}

describe("git-export · 参数与解析（注入 runner）", () => {
  it("[1] 分支名不合法直接拒绝，一条命令都不跑", async () => {
    const { run, calls } = fakeRunner([]);
    const result = await exportDeliveryBranch(base({ branch: "bad branch;rm", run }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("分支名不合法");
    expect(calls).toHaveLength(0);
    expect(BRANCH_RE.test("oxcommander/delivery-20261011-120000")).toBe(true);
    expect(BRANCH_RE.test("-leading-dash")).toBe(false);
  });

  it("[2] 不在 git 仓库内（含 git 缺失的 -1）＝ 跳过不是失败", async () => {
    const noRepo = fakeRunner([{ code: 0, stdout: "false\n" }]);
    expect((await exportDeliveryBranch(base({ run: noRepo.run }))).skipped).toBe("no-repo");
    const missing = fakeRunner([{ code: -1, stderr: "spawn git ENOENT" }]);
    expect((await exportDeliveryBranch(base({ run: missing.run }))).skipped).toBe("no-repo");
  });

  it("[3] 工作树干净 ＝ 跳过；zone 外的改动不归属 ＝ 跳过", async () => {
    const clean = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "" },
    ]);
    expect((await exportDeliveryBranch(base({ run: clean.run }))).skipped).toBe("no-changes");

    const outside = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "?? other.txt\0" },
    ]);
    const r = await exportDeliveryBranch(base({ run: outside.run, zones: ["src"] }));
    expect(r.skipped).toBe("no-zone-files");
    expect(outside.calls.filter((c) => c.command === "git" && c.args[0] === "checkout")).toHaveLength(0);
  });

  it("[4] porcelain -z 解析：重命名消费原路径段、引号路径剥壳、未跟踪目录去尾斜杠、残段跳过", () => {
    expect(parseStatusZ("M  src/a.ts\0?? src/new/\0R  src/b.ts\0src/old.ts\0X")).toEqual([
      "src/a.ts",
      "src/new",
      "src/b.ts",
    ]);
    expect(parseStatusZ(`?? "src/w file.txt"\0M  "src/q\\"t.ts"\0`)).toEqual(["src/w file.txt", 'src/q"t.ts']);
    // 短残段在前也不能截断后面的解析（continue→break 的 mutant 会在这里丢文件）
    expect(parseStatusZ("X\0M  src/after.ts\0")).toEqual(["src/after.ts"]);
    // 只有一头有引号的路径不剥壳（&&→|| 的 mutant 会把单边引号当配对削掉）
    expect(parseStatusZ(`M  src/foo"\0`)).toEqual([`src/foo"`]);
    expect(parseStatusZ(`M  "src/foo\0`)).toEqual([`"src/foo`]);
  });

  it("[5] 元字符文件名单条跳过，不拖垮其余导出", async () => {
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "?? src/a&b.txt\0M  src/good.ts\0" },
      { code: 0 }, // checkout
      { code: 0 }, // add
      { code: 0 }, // commit
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(base({ run }));
    expect(r.ok).toBe(true);
    expect(r.filesCommitted).toBe(1);
    expect(r.skippedPaths?.[0]).toContain("src/a&b.txt");
    const add = calls.find((c) => c.args[0] === "add");
    expect(add!.args).toEqual(["add", "--", "src/good.ts"]);
  });

  it("[6] 快乐路径的完整命令序列：checkout -B → add -- → commit → rev-parse", async () => {
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0M  src/lib/b.ts\0" },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(base({ run, zones: ["src"] }));
    expect(r).toMatchObject({ ok: true, branch: "oxcommander/delivery-20261011-120000", commit: "abc1234", filesCommitted: 2 });
    expect(calls.map((c) => c.args[0])).toEqual(["rev-parse", "status", "checkout", "add", "commit", "rev-parse"]);
    expect(calls[2]!.args).toEqual(["checkout", "-B", "oxcommander/delivery-20261011-120000"]);
    expect(calls[4]!.args).toEqual(["commit", "-m", "OxCommander delivery"]);
  });

  it("[7] 多路径分块 add：单块不超字节预算，块数随路径数增长", async () => {
    const paths = Array.from({ length: 600 }, (_, i) => `src/file-${String(i).padStart(3, "0")}.ts`);
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: paths.map((p) => `M  ${p}`).join("\0") + "\0" },
      { code: 0 },
      ...paths.map(() => ({ code: 0 })),
      { code: 0 },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(base({ run }));
    expect(r.ok).toBe(true);
    const adds = calls.filter((c) => c.args[0] === "add");
    expect(adds.length).toBeGreaterThan(1);
    for (const a of adds) {
      expect(a.args.join(" ").length).toBeLessThan(7000);
      expect(a.args[1]).toBe("--");
    }
  });

  it("[8] 仓库没配身份：commit 失败且报身份 → 带 -c 重试一次（不写仓库配置）", async () => {
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 0 },
      { code: 0 },
      { code: 1, stderr: "fatal: Please tell me who you are.\n" },
      { code: 0 },
      { code: 0, stdout: "def5678\n" },
    ]);
    const r = await exportDeliveryBranch(base({ run }));
    expect(r.ok).toBe(true);
    const commits = calls.filter((c) => c.args.includes("commit"));
    expect(commits).toHaveLength(2);
    expect(commits[1]!.args).toContain("user.name=OxCommander");
    // 重试不写仓库配置：config 子命令一次都不出现（它在拒绝地板里）
    expect(calls.some((c) => c.args[0] === "config")).toBe(false);
  });

  it("[8b] commit 成功但 stderr 提到身份字样：不重试（&&→|| 的 mutant 会重放一次）", async () => {
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 0 },
      { code: 0 },
      { code: 0, stderr: "hint: your user.name is unset, using fallback" },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(base({ run }));
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.args.includes("commit"))).toHaveLength(1);
  });

  it("[3c] 显式 paths：不扫 git status，只 add 给定路径；非法路径跳过", async () => {
    const ok = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(
      base({ run: ok.run, paths: ["src/new/a.ts", "src/new/a.ts", "../escape.txt", "D:/abs.txt"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.filesCommitted).toBe(1);
    expect(ok.calls.some((c) => c.args[0] === "status")).toBe(false);
    expect(ok.calls.find((c) => c.args[0] === "add")?.args).toEqual(["add", "--", "src/new/a.ts"]);
    expect(r.skippedPaths?.join()).toContain("非法路径");

    const none = fakeRunner([{ code: 0, stdout: "true\n" }]);
    const skipped = await exportDeliveryBranch(base({ run: none.run, paths: ["../escape.txt"] }));
    expect(skipped.skipped).toBe("no-zone-files");
    // 全被跳过时也必须把原因带回来；三元写反会把 skippedPaths 整块吞掉。
    expect(skipped.skippedPaths?.join()).toContain("非法路径");
    expect(none.calls.some((c) => c.args[0] === "checkout")).toBe(false);
  });

  it("[3d] 显式 paths 的非法/被策略拒的条目在**前面**时，后面的合法路径仍要导出", async () => {
    const { run, calls } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const r = await exportDeliveryBranch(
      base({
        run,
        paths: ["", "/abs.txt", "D:/abs.txt", "../escape.txt", "src/a;b.ts", "src/ok.ts"],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.filesCommitted).toBe(1);
    expect(r.skippedPaths).toHaveLength(5);
    expect(r.skippedPaths?.join()).toContain("非法路径");
    expect(calls.find((c) => c.args[0] === "add")?.args).toEqual(["add", "--", "src/ok.ts"]);
  });

  it("[3e] zones 缺席时是 no-zone-files，不能去读 undefined.length", async () => {
    const none = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  a.ts\0" },
    ]);
    const r = await exportDeliveryBranch(base({ run: none.run, zones: undefined }));
    expect(r).toMatchObject({ ok: true, skipped: "no-zone-files" });
    expect(none.calls.some((c) => c.args[0] === "checkout")).toBe(false);
  });

  it("[3f] paths 是空数组 ⇒ no-changes（不是失败）", async () => {
    const empty = fakeRunner([{ code: 0, stdout: "true\n" }]);
    const r = await exportDeliveryBranch(base({ run: empty.run, paths: [] }));
    expect(r).toMatchObject({ ok: true, skipped: "no-changes" });
  });

  it("[9] checkout / add / commit 失败都折进结果对象（ok:false + 原因），永不 throw", async () => {
    const checkoutFail = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 1, stderr: "error: pathspec 'x'" },
    ]);
    const a = await exportDeliveryBranch(base({ run: checkoutFail.run }));
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("git checkout 失败");
    expect(a.skippedPaths).toBeUndefined();

    const commitFail = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 0 },
      { code: 0 },
      { code: 1, stderr: "fatal: nothing to commit" },
      { code: 1, stderr: "fatal: nothing to commit" },
    ]);
    const b = await exportDeliveryBranch(base({ run: commitFail.run }));
    expect(b.ok).toBe(false);
    expect(b.reason).toContain("git commit 失败");
    expect(b.skippedPaths).toBeUndefined();
  });

  it("[10] deliveryStamp：本地时间 yyyyMMdd-HHmmss，落在分支名字符集内", () => {
    const stamp = deliveryStamp(new Date(2026, 9, 11, 9, 5, 3));
    expect(stamp).toBe("20261011-090503");
    expect(BRANCH_RE.test(`oxcommander/delivery-${stamp}`)).toBe(true);
  });
});

/**
 * 真 git 集成（临时仓库，双平台跑——git 在 CI 两端都在）：默认 runner
 * （buildSpawnSpec + scopedEnv + 真实 cwd）也在这个用例里被端到端钉住。
 */
describe("git-export · 真 git 仓库", () => {
  function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-gitexp-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    g(["init", "-q"]);
    fs.writeFileSync(path.join(root, "README.md"), "init\n");
    g(["add", "."]);
    g(["-c", "user.name=init", "-c", "user.email=init@localhost", "commit", "-q", "-m", "init"]);
    return root;
  }

  it("[11] zone 内改动导出成分支与 commit；zone 外的留在工作树", async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "other.txt"), "operator's own dirt\n");

    const r = await exportDeliveryBranch(
      base({ projectRoot: root, zones: ["src"], branch: "oxcommander/delivery-test", run: undefined }),
    );
    expect(r.ok).toBe(true);
    expect(r.filesCommitted).toBe(1);
    expect(r.commit).toMatch(/^[0-9a-f]+$/);
    void r;

    const g = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
    // 分支已存在且正是当前分支
    expect(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("oxcommander/delivery-test");
    // commit 里只有 zone 内的那一个文件
    const committed = g(["show", "--name-only", "--format="]).trim().split("\n");
    expect(committed).toEqual(["src/a.ts"]);
    // zone 外的改动原样留在工作树，绝没有被卷进 commit
    expect(g(["status", "--porcelain"]).trim()).toBe("?? other.txt");
  });

  it("[11b] 显式 paths 能导出新建目录里的新文件（zone 过滤会漏掉的那类）", async () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "src", "newdir"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "newdir", "a.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "other.txt"), "operator's own dirt\n");

    const r = await exportDeliveryBranch(
      base({
        projectRoot: root,
        paths: ["src/newdir/a.ts"],
        branch: "oxcommander/thread-test",
        run: undefined,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.filesCommitted).toBe(1);
    const g = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
    const committed = g(["show", "--name-only", "--format="]).trim().split("\n");
    expect(committed).toEqual(["src/newdir/a.ts"]);
    expect(g(["status", "--porcelain"]).trim()).toBe("?? other.txt");
  });

  it("[12] 仓库没配身份时走 -c 兜底，commit 照样成立", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-gitexp-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "src-x.ts"), "x\n");
    const r = await exportDeliveryBranch(
      base({ projectRoot: root, zones: ["."], branch: "oxcommander/delivery-id", run: undefined }),
    );
    expect(r.ok).toBe(true);
    const log = execFileSync("git", ["log", "--oneline"], { cwd: root, stdio: "pipe" }).toString();
    expect(log).toContain("OxCommander delivery");
  });

  it("[13] 不是仓库（父目录也不是）＝ 跳过", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-gitexp-norepo-"));
    const r = await exportDeliveryBranch(base({ projectRoot: root, run: undefined }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe("no-repo");
  });
});

describe("git-export · skippedPaths 的缺席语义（三元互换的 mutant 用）", () => {
  it("[14] no-zone-files 时 skippedPaths 必须缺席（不是空数组）", async () => {
    const { run } = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "?? other.txt\0" },
    ]);
    const r = await exportDeliveryBranch(base({ run, zones: ["src"] }));
    expect(r.skipped).toBe("no-zone-files");
    expect(r.skippedPaths).toBeUndefined();
  });

  it("[15] 快乐路径（无跳过）skippedPaths 缺席；add 失败时同样缺席", async () => {
    const happy = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0, stdout: "abc1234\n" },
    ]);
    const a = await exportDeliveryBranch(base({ run: happy.run }));
    expect(a.ok).toBe(true);
    expect(a.skippedPaths).toBeUndefined();

    const addFail = fakeRunner([
      { code: 0, stdout: "true\n" },
      { code: 0, stdout: "M  src/a.ts\0" },
      { code: 0 },
      { code: 1, stderr: "error: unable to index file" },
    ]);
    const b = await exportDeliveryBranch(base({ run: addFail.run }));
    expect(b.ok).toBe(false);
    expect(b.reason).toContain("git add 失败");
    expect(b.skippedPaths).toBeUndefined();
  });
});
