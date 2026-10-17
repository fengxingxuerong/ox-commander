import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVENTIONS_MARKER,
  MAX_CONVENTIONS_CHARS,
  formatConventionsBlock,
} from "../shared/project-conventions";
import { readProjectConventions } from "../electron/engine/conventions";

const roots: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-conv-${tag}-`));
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

describe("formatConventionsBlock", () => {
  it("没有文件 / 全空白 ⇒ 空串（不产空标题）", () => {
    expect(formatConventionsBlock([])).toBe("");
    expect(formatConventionsBlock([{ name: "OX.md", content: "  \n\n " }])).toBe("");
  });

  it("单文件：带标记、文件名与正文", () => {
    const block = formatConventionsBlock([{ name: "OX.md", content: "用 CommonJS；禁改 lockfile。" }]);
    expect(block).toContain(CONVENTIONS_MARKER);
    expect(block).toContain("### OX.md");
    expect(block).toContain("用 CommonJS；禁改 lockfile。");
    // 块自己声明边界：约定不覆盖契约
    expect(block).toContain("以契约为准");
  });

  it("多文件按传入顺序拼接（OX 在前）", () => {
    const block = formatConventionsBlock([
      { name: "OX.md", content: "A" },
      { name: "AGENTS.md", content: "B" },
    ]);
    expect(block.indexOf("A")).toBeLessThan(block.indexOf("B"));
  });

  it("超过上限：截断并说破原始长度（不静默丢）", () => {
    const big = "x".repeat(MAX_CONVENTIONS_CHARS + 500);
    const block = formatConventionsBlock([{ name: "OX.md", content: big }]);
    expect(block).toContain("已截断");
    expect(block).toMatch(/约定原文共 \d+ 字符/); // 说破原始长度，而不是静默丢
    expect(block).toContain(`上限 ${MAX_CONVENTIONS_CHARS}`);
    // 截断后的块仍然给了标记（调用方能认出它是什么）
    expect(block.startsWith(CONVENTIONS_MARKER)).toBe(true);
  });

  it("恰好在上限内不截断", () => {
    // 头部长度不稳定，构造一个明显小于上限的
    const block = formatConventionsBlock([{ name: "OX.md", content: "y".repeat(100) }]);
    expect(block).not.toContain("已截断");
  });
});

describe("readProjectConventions", () => {
  it("按 OX.md → AGENTS.md 顺序读，只收存在的", () => {
    const root = scratch("read");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "agents", "utf8");
    fs.writeFileSync(path.join(root, "OX.md"), "ox", "utf8");
    const out = readProjectConventions(root);
    expect(out.files.map((f) => f.name)).toEqual(["OX.md", "AGENTS.md"]);
    expect(out.files[0]!.content).toBe("ox");
    expect(out.unreadable).toEqual([]);
  });

  it("前一个文件不存在不拦截后一个（continue 不是 break）", () => {
    // `continue` 换成 `break` 时，第一个缺席的 OX.md 会让整个读取收摊 ——
    // 只写 AGENTS.md 的项目从此一个字的约定都带不进去。
    const root = scratch("skip-missing");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "agents-only", "utf8");
    const out = readProjectConventions(root);
    expect(out.files.map((f) => f.name)).toEqual(["AGENTS.md"]);
  });

  it("没有文件 ⇒ 空结果（缺席是常态，不是错误）", () => {
    const root = scratch("empty");
    const out = readProjectConventions(root);
    expect(out.files).toEqual([]);
    expect(out.unreadable).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it("同名目录（读不动）：进 unreadable，不抛", () => {
    const root = scratch("dir-as-file");
    fs.mkdirSync(path.join(root, "OX.md"), { recursive: true });
    const out = readProjectConventions(root);
    expect(out.files).toEqual([]);
    expect(out.unreadable.map((u) => u.name)).toEqual(["OX.md"]);
    expect(out.unreadable[0]!.reason).toBeTruthy();
  });

  it("超过单文件上限：跳过并报字节数，且不拦截后面的文件（continue 不是 break）", () => {
    const root = scratch("huge");
    // OX.md 超限、AGENTS.md 正常：跳过后必须继续读下一个 —— `continue` 换成
    // `break` 时，一个超大的 OX.md 会让后面的约定全部读不到。
    fs.writeFileSync(path.join(root, "OX.md"), "z".repeat(300 * 1024), "utf8");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "agents-ok", "utf8");
    const out = readProjectConventions(root);
    expect(out.skipped.map((s) => s.name)).toEqual(["OX.md"]);
    expect(out.skipped[0]!.bytes).toBeGreaterThan(256 * 1024);
    expect(out.files.map((f) => f.name)).toEqual(["AGENTS.md"]);
    expect(out.files[0]!.content).toBe("agents-ok");
  });
});
