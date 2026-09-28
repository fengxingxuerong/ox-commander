/**
 * 变异门禁「强杀残留自愈」的门卫用例。
 *
 * 为什么单独测它：`verify` 里唯一能还原活体变异体的代码是 `recoverPendingRecord()`，
 * 而它此前**没有任何测试**——2026-09-28 一次被强杀的 site 审计把
 * `orchestrator.ts:575` 的 `=== "skip"` 留在了源码里，下一轮门禁于是死在第 9 段
 * `npm test`（V8 堆 4.6GB → OOM 且不退出），完全不像"工作区脏"。自愈现在被提到
 * 第 1 段 `check:residue`，所以它的三种结论必须各自钉住：
 *   - 干净 / 台账冗余但内容一致 → 退出 0
 *   - 真的还原了一个变异体      → 退出 2（逼人重跑，不给脏 PASS）
 *   - 台账不可用                → 退出 2，且**不许**说工作区干净
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

function recoverOnly(): RecoverRun {
  const r = spawnSync(process.execPath, [SCRIPT, "--recover-only"], { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

afterEach(() => {
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("mutation-check --recover-only（verify 第 1 段）", () => {
  it("starts from a clean pending dir — residue here would mean the previous run was killed", () => {
    // 这条不只是卫生检查：它把「带残留跑测试」变成一次点名失败，而不是 OOM。
    expect(fs.existsSync(PENDING_INDEX), `工作区有未还原的变异残留，跑 npm run check:residue 还原后再跑测试`).toBe(false);
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
    const file = makeTarget("original\n", "original\n");

    const run = recoverOnly();

    expect(run.status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
  });
});
