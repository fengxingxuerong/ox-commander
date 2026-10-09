/**
 * 变异门禁「强杀残留自愈」的门卫用例。
 *
 * 为什么单独测它：`verify` 里唯一能还原活体变异体的代码是 `recoverPendingRecord()`，
 * 而它此前**没有任何测试**——2026-09-28 一次被强杀的 site 审计把
 * `orchestrator.ts:575` 的 `=== "skip"` 留在了源码里，下一轮门禁于是死在第 9 段
 * `npm test`（V8 堆 4.6GB → OOM 且不退出），完全不像"工作区脏"。自愈现在被提到
 * 第 1 段 `check:residue`，所以它的结论必须各自钉住：
 *   - 干净 / 台账冗余但内容一致 → 退出 0
 *   - 真的还原了一个变异体      → 退出 2（逼人重跑，不给脏 PASS）
 *   - 台账不可用                → 退出 2，且**不许**说工作区干净
 *   - 台账丢了而备份还在        → 逐份向备份要证据：与源码一致才算干净（2026-10-09 补）
 *
 * 最后一条是补上的盲区：旧实现只看 `index.json`，台账不在就直接宣布"工作区干净"，
 * 手工清台账、`clearPendingRecord` 的删除被杀软挡住、或并发两轮互相清台账时，
 * 活体变异体就带着一个"干净"的结论进到 `npm test`（V8 堆 4.6GB → OOM 且不退出）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "mutation-check.mjs");
const PENDING_DIR = path.join(ROOT, "scripts", ".mutation-pending");
const PENDING_INDEX = path.join(PENDING_DIR, "index.json");

/** 一次运行的结果，测试只看这三样。 */
interface RecoverRun {
  status: number | null;
  out: string;
  err: string;
}

const scratch: string[] = [];

/** 目标文件放在 pending 目录**之外**：还原后内容必须仍然可观察。 */
function makeTarget(original: string, current: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-residue-"));
  scratch.push(dir);
  const file = path.join(dir, "target.ts");
  fs.writeFileSync(file, current, "utf8");
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const backup = path.join(PENDING_DIR, "target.ts.orig");
  fs.writeFileSync(backup, original, "utf8");
  return file;
}

function writeIndex(record: unknown): void {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  fs.writeFileSync(PENDING_INDEX, typeof record === "string" ? record : JSON.stringify(record), "utf8");
}

/**
 * 备份文件名的编码规则归门禁脚本自己定，测试不复制第二份实现 ——
 * 按锚点把 `pendingBackupName` / `armPendingRecord` 从脚本里抠出来直接调
 * （手法与下面 `restoreSource` 那一节一致，锚点不在了会当场说清）。
 */
function loadPending(
  processImpl: { exit: (code: number) => void },
  fsImpl: {
    mkdirSync: typeof fs.mkdirSync;
    writeFileSync: typeof fs.writeFileSync;
    readFileSync: typeof fs.readFileSync;
  } = fs,
): {
  pendingBackupName: (file: string) => string;
  armPendingRecord: (file: string, original: string) => void;
} {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("/** 备份文件名");
  const end = src.indexOf("/** 同步等待（毫秒）");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("无法在 mutation-check.mjs 里定位备份台账区（锚点被改名或移动了？）");
  }
  const factory = new Function(
    "fs",
    "path",
    "ROOT",
    "PENDING_DIR",
    "PENDING_INDEX",
    "process",
    "relFromRoot",
    `${src.slice(start, end)}\nreturn { pendingBackupName, armPendingRecord };`,
  );
  return factory(
    fsImpl,
    path,
    ROOT,
    PENDING_DIR,
    PENDING_INDEX,
    processImpl,
    (p: string) => path.relative(ROOT, p).split(path.sep).join("/"),
  ) as {
    pendingBackupName: (file: string) => string;
    armPendingRecord: (file: string, original: string) => void;
  };
}

/**
 * 台账已丢（没有 `index.json`）而备份仍在的现场。
 * 源文件放在 pending 目录**里面**：那里 git 已忽略，又能被备份名映射回来。
 */
function makeOrphan(original: string, current: string): { file: string; backup: string } {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const name = `orphan-${process.pid}-${Date.now().toString(36)}.ts`;
  const file = path.join(PENDING_DIR, name);
  fs.writeFileSync(file, current, "utf8");
  const backup = path.join(PENDING_DIR, loadPending({ exit: () => undefined }).pendingBackupName(file));
  fs.writeFileSync(backup, original, "utf8");
  return { file, backup };
}

function recoverOnly(): RecoverRun {
  const r = spawnSync(process.execPath, [SCRIPT, "--recover-only"], { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

afterEach(() => {
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 前置卫生检查：源码里现在有没有**活体变异体**。
 *
 * 判据的权威实现是 `check:residue`（verify 第 1 段），这里不复用它 —— 它会**写盘**：
 * 并发跑第二轮变异时，本用例若去调它，会把那一轮还活着的台账连根清掉，
 * 反而把别人的残留变成无主的（正是下面「孤儿备份」要处置的形态）。
 *
 * 也不用"台账文件在不在"当代理指标：2026-10-09 实测到一次假红 —— 另一轮变异跑到
 * 两次改写的间隙（源码已还原、台账还在），旧断言必红，而那时并不会 OOM。
 * OOM 的直接原因是活体变异体，所以就看它。
 */
function liveMutant(): string | null {
  if (!fs.existsSync(PENDING_INDEX)) return null;
  let rec: { file?: string; backup?: string };
  try {
    rec = JSON.parse(fs.readFileSync(PENDING_INDEX, "utf8")) as { file?: string; backup?: string };
  } catch {
    return "台账不可读";
  }
  if (!rec.file || !rec.backup || !fs.existsSync(rec.backup)) return "台账指向的文件或备份缺失";
  return fs.readFileSync(rec.file, "utf8") === fs.readFileSync(rec.backup, "utf8") ? null : rec.file;
}

describe("mutation-check --recover-only（verify 第 1 段）", () => {
  it("starts with no live mutant on disk — that is what balloons vitest to 4.6GB", () => {
    // 这条不只是卫生检查：它把「带残留跑测试」变成一次点名失败，而不是 OOM。
    expect(liveMutant(), "工作区有未还原的变异体，跑 npm run check:residue 还原后再跑测试").toBeNull();
  });

  it("exits 0 and says clean when there is no pending record at all", () => {
    const run = recoverOnly();
    expect(run.status).toBe(0);
    expect(run.out).toContain("无变异残留");
  });

  it("restores the mutated file, clears the record, and exits 2 so nobody reads a dirty PASS", () => {
    const file = makeTarget('if (decision === "skip") {\n', 'if (decision !== "skip") {\n');
    writeIndex({ file, backup: path.join(PENDING_DIR, "target.ts.orig") });

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(fs.readFileSync(file, "utf8")).toBe('if (decision === "skip") {\n');
    expect(run.err).toContain("已自动还原");
    expect(fs.existsSync(PENDING_INDEX)).toBe(false);
  });

  it("treats a stale record whose content already matches the backup as clean", () => {
    const file = makeTarget("same content\n", "same content\n");
    writeIndex({ file, backup: path.join(PENDING_DIR, "target.ts.orig") });

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(run.out).toContain("台账已清理");
    expect(fs.existsSync(PENDING_INDEX)).toBe(false);
  });

  it("refuses to call the workspace clean when the record is unreadable", () => {
    const file = makeTarget("original\n", "MUTANT");
    writeIndex("{ this is not json");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("不可用");
    expect(run.out).not.toContain("无变异残留");
    // 没有还原手段时它必须只说"去自查"，而不是悄悄把目标文件当好的。
    expect(fs.readFileSync(file, "utf8")).toBe("MUTANT");
  });

  it("refuses to call the workspace clean when the backup file is gone", () => {
    const file = makeTarget("original\n", "MUTANT");
    writeIndex({ file, backup: path.join(PENDING_DIR, "target.ts.orig") });
    fs.rmSync(path.join(PENDING_DIR, "target.ts.orig"));

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.out).not.toContain("无变异残留");
    expect(fs.existsSync(PENDING_INDEX)).toBe(false);
  });

  it("leaves the target file untouched on the clean path", () => {
    // 备份与源文件一致 ⇒ 上一轮其实还原成功了，只是台账没来得及清 —— 这仍然算干净。
    const { file, backup } = makeOrphan("original\n", "original\n");

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
    expect(fs.existsSync(backup)).toBe(false);
  });

  it("refuses to call the workspace clean when a ledger-less backup disagrees with its source", () => {
    // 这条钉住的是台账制的盲区：`index.json` 没了而活体变异体还在源码里时，
    // 旧实现只会说"工作区干净"（2026-10-09 实弹：塞一份孤儿备份，退出码 0）。
    const { file } = makeOrphan("if (a === b) {\n", "if (a !== b) {\n");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("无法证明干净");
    expect(run.out).not.toContain("无变异残留");
    // 只许点名、不许动手：孤儿备份可能是写盘写坏的一半，拿它覆盖源码会把好文件截断。
    expect(fs.readFileSync(file, "utf8")).toBe("if (a !== b) {\n");
  });

  it("refuses to call the workspace clean when a stray backup maps to no file", () => {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, "gone-dir__vanished.ts.orig"), "whatever\n", "utf8");

    const run = recoverOnly();

    expect(run.status).toBe(2);
    expect(run.err).toContain("映射不回源文件");
  });
});

describe("armPendingRecord · 没有落盘台账就不改写源码", () => {
  it("备份名映射得回源文件，台账指向那份备份", () => {
    const { pendingBackupName, armPendingRecord } = loadPending({ exit: () => undefined });
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const file = path.join(PENDING_DIR, "armed.ts");
    fs.writeFileSync(file, "MUTANT\n", "utf8");

    armPendingRecord(file, "ORIGINAL\n");

    const rec = JSON.parse(fs.readFileSync(PENDING_INDEX, "utf8")) as { file: string; backup: string };
    expect(fs.readFileSync(rec.backup, "utf8")).toBe("ORIGINAL\n");
    // 名字里带路径：不同目录的同名文件不会顶掉同一份备份，台账丢了也还能反查源文件。
    expect(path.basename(rec.backup)).toBe("scripts__.mutation-pending__armed.ts.orig");
    expect(pendingBackupName(file)).toBe(path.basename(rec.backup));
  });

  it("备份写不下去时退出 2，而不是警告一声继续跑", () => {
    // 旧实现是"警告后继续"，而那正是盲区的来源 —— 没有台账的残留，`check:residue` 看不见。
    fs.rmSync(PENDING_DIR, { recursive: true, force: true });
    // 父目录位上放一个普通文件：`mkdirSync` 在各平台都确定性抛。
    fs.writeFileSync(PENDING_DIR, "not a directory\n", "utf8");

    const codes: number[] = [];
    const messages: string[] = [];
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    try {
      loadPending({ exit: (code: number) => void codes.push(code) }).armPendingRecord(
        path.join(PENDING_DIR, "armed.ts"),
        "ORIGINAL\n",
      );
    } finally {
      console.error = realError;
    }

    expect(codes).toEqual([2]);
    expect(messages.some((m) => m.includes("无法建立变异备份"))).toBe(true);
  });

  it("备份落地后被写坏（读回来不是原文）时同样拒跑", () => {
    // 只挡"写不下去"还不够：Windows 上杀软会把刚写下的文件掏空 —— 拿一份坏备份去
    // 自愈，等于把源码写成截断的原文，比没有台账更糟。所以 arm 有写后校验。
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const codes: number[] = [];
    const messages: string[] = [];
    const badFs = {
      mkdirSync: fs.mkdirSync.bind(fs),
      writeFileSync: fs.writeFileSync.bind(fs),
      readFileSync: ((p: fs.PathLike, enc?: unknown) =>
        String(p).endsWith(".orig") ? "TRUNC" : fs.readFileSync(p, enc as never)) as typeof fs.readFileSync,
    };
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    try {
      loadPending({ exit: (code: number) => void codes.push(code) }, badFs).armPendingRecord(
        path.join(PENDING_DIR, "armed.ts"),
        "ORIGINAL\n",
      );
    } finally {
      console.error = realError;
    }

    expect(codes).toEqual([2]);
    expect(messages.some((m) => m.includes("备份写后校验不一致"))).toBe(true);
  });
});

/**
 * 还原写盘的重试路径。
 *
 * 2026-09-28 连续两次实测：`finally` 里的 `fs.writeFileSync` 抛
 * `UNKNOWN (errno -4094)`（Windows 上杀软/索引器短暂占住刚被改写的文件），
 * 进程就带着**活体变异体**死了 —— 下一轮门禁于是红在无关目标上。
 * 现在还原走 `restoreSource`：重试、不抛、尽力后返回 false 并点名。
 *
 * 手法与 `scripts/masker-selftest.mjs` 一致：按锚点从门禁脚本里抠出函数体，
 * 注进新作用域直接调用（不留第二份实现）。故障用"父目录不存在"制造 ——
 * 各平台都确定性抛 ENOENT；没用 chmod 只读，因为 root 身份下它拦不住写。
 */
describe("restoreSource · 还原写盘不能抛在 finally 里", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");
  const START_ANCHOR = "/** 同步等待（毫秒）";
  const END_ANCHOR = "/** 一个目标跑完";
  const start = SRC.indexOf(START_ANCHOR);
  const end = SRC.indexOf(END_ANCHOR);

  /** 抠出 sleepSync + restoreSource，注入 fs/path/ROOT/relFromRoot。 */
  function loadRestore(): (file: string, original: string) => boolean {
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(
        `无法在 mutation-check.mjs 里定位 restoreSource（锚点 ${START_ANCHOR} / ${END_ANCHOR} 被改名或移动了？）`,
      );
    }
    const helpers = SRC.slice(start, end);
    const factory = new Function("fs", "path", "relFromRoot", `${helpers}\nreturn { restoreSource };`);
    const { restoreSource } = factory(fs, path, (p: string) => path.relative(ROOT, p));
    return restoreSource as (file: string, original: string) => boolean;
  }

  it("returns true and really puts the original back when the file is writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-restore-"));
    scratch.push(dir);
    const file = path.join(dir, "target.ts");
    fs.writeFileSync(file, "MUTANT\n", "utf8");

    expect(loadRestore()(file, "ORIGINAL\n")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("ORIGINAL\n");
  });

  it("gives up out-loud instead of throwing when the write keeps failing", () => {
    // 父目录不存在 → writeFileSync 每次必抛（ENOENT），等价于"句柄一直不放"。
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ox-restore-gone-"));
    scratch.push(base);
    const missing = path.join(base, "nope", "target.ts");

    const messages: string[] = [];
    const realError = console.error;
    console.error = (m?: unknown) => void messages.push(String(m));
    let threw: unknown = null;
    let returned: boolean | undefined;
    try {
      returned = loadRestore()(missing, "ORIGINAL\n");
    } catch (e) {
      threw = e;
    } finally {
      console.error = realError;
    }

    // 抛异常就是原缺陷本身：它一抛，进程带着变异体死掉，台账也来不及说清。
    expect(threw).toBeNull();
    expect(returned).toBe(false);
    expect(messages.some((m) => m.includes("反复无法还原") && m.includes("自愈"))).toBe(true);
  });
});
