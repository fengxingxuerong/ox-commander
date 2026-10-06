/**
 * `policy.d/` 的目录加载（IO 层）此前**一条断言都没有** —— 生产由
 * `electron/platform.ts` 调用，全仓没有测试 import 过它。
 *
 * 它是安全边界的入口：策略坏到什么程度算"没生效"、坏文件会不会拖垮 run，
 * 全在这 30 行里决定。这里逐支钉住，重点不是"能读出来"，而是
 * **读不出来的时候行为是什么**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolicyDir } from "./policy-dir";

const created: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ox-policy-"));
  created.push(d);
  return d;
}

/** `body` 传字符串 = 原样写盘（用来造坏 JSON）；否则 JSON.stringify。 */
function put(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
}

afterEach(() => {
  while (created.length > 0) {
    const d = created.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

const GOOD = { version: 1, denyCommands: ["rm -rf /"], maxTokensPerRun: 1200 };

describe("loadPolicyDir · 空与不存在的目录", () => {
  it("未配置策略目录时返回空集 —— 没写策略 = 用内置规则，不是错误", () => {
    expect(loadPolicyDir(undefined)).toEqual({ policy: { version: 1 }, errors: [], files: 0 });
  });

  it("目录不存在不抛异常（不该因此让 run 起不来）", () => {
    const r = loadPolicyDir(path.join(os.tmpdir(), "ox-policy-does-not-exist-xyz"));
    expect(r).toEqual({ policy: { version: 1 }, errors: [], files: 0 });
  });

  it("空目录：files 为 0 且没有错误", () => {
    const r = loadPolicyDir(tmpDir());
    expect(r.files).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe("loadPolicyDir · 文件筛选", () => {
  it("只吃 *.json，跳过 *.example.json（样例不是策略）", () => {
    const d = tmpDir();
    put(d, "a.json", GOOD);
    put(d, "sample.example.json", { version: 1, denyCommands: ["git push --force"] });

    const r = loadPolicyDir(d);
    expect(r.files).toBe(1);
    expect(r.policy.denyCommands).toEqual(["rm -rf /"]);
    expect(r.errors).toEqual([]);
  });

  it("非 .json 后缀一律不读（README / .jsonc 都不是策略）", () => {
    const d = tmpDir();
    put(d, "notes.md", "不是策略");
    put(d, "b.jsonc", GOOD);
    expect(loadPolicyDir(d).files).toBe(0);
  });
});

describe("loadPolicyDir · 坏文件只影响它自己", () => {
  it("JSON 解析失败：记一条错误，该文件不算生效，其余照常加载", () => {
    const d = tmpDir();
    put(d, "bad.json", "{ 这不是 json ");
    put(d, "good.json", GOOD);

    const r = loadPolicyDir(d);
    expect(r.files).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].issues.join("")).toContain("JSON 解析失败");
    expect(r.errors[0].file).toContain("bad.json");
    // 好文件的规则仍然生效 —— 不能因为一个坏文件把整份策略掀了
    expect(r.policy.denyCommands).toEqual(["rm -rf /"]);
  });

  it("逐文件按名字排序遍历 —— 多个坏文件时错误顺序稳定（errors[0] 是 a 不是 z）", () => {
    const d = tmpDir();
    put(d, "z-bad.json", "{ x");
    put(d, "a-bad.json", "{ y");

    const r = loadPolicyDir(d);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0].file).toContain("a-bad.json");
    expect(r.errors[1].file).toContain("z-bad.json");
  });
});

describe("loadPolicyDir · 半坏文件不生效", () => {
  it("有问题的策略整份不计入 files，也不产出任何规则", () => {
    const d = tmpDir();
    // version 不认识 → normalizePolicyFile 返回 issues → 该文件不 push
    put(d, "v99.json", { version: 99, denyCommands: ["curl"] });

    const r = loadPolicyDir(d);
    expect(r.files).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].issues.join("")).toContain("不认识的策略版本");
    // 关键：坏版本里的 denyCommands 不许漏进生效策略（半懂不懂地执行安全策略比不执行更危险）
    expect(r.policy.denyCommands).toBeUndefined();
  });

  it("同一份里既有有效规则又有无效字段：只丢无效那个，但整份仍算不生效", () => {
    const d = tmpDir();
    put(d, "half.json", { version: 1, denyCommands: ["rm -rf /"], maxTokensPerRun: -5 });

    const r = loadPolicyDir(d);
    expect(r.files).toBe(0);
    expect(r.errors[0].issues.join("")).toContain("maxTokensPerRun 无效");
    expect(r.policy.maxTokensPerRun).toBeUndefined();
  });
});

describe("loadPolicyDir · 合成语义", () => {
  it("一个文件可以声明多份（数组形式）", () => {
    const d = tmpDir();
    put(d, "multi.json", [
      { version: 1, denyCommands: ["a"] },
      { version: 1, denyCommands: ["b"], maxTokensPerRun: 800 },
    ]);

    const r = loadPolicyDir(d);
    expect(r.files).toBe(2);
    expect(r.policy.denyCommands).toEqual(["a", "b"]);
    expect(r.policy.maxTokensPerRun).toBe(800);
  });

  it("多份合成：清单取并集、预算取最小（保护只会叠加，不会被另一份抵消）", () => {
    const d = tmpDir();
    put(d, "01.json", { version: 1, denyCommands: ["a"], maxTokensPerRun: 500 });
    put(d, "02.json", { version: 1, denyCommands: ["b"], maxTokensPerRun: 1500 });

    const r = loadPolicyDir(d);
    expect(r.files).toBe(2);
    expect(r.policy.denyCommands).toEqual(["a", "b"]);
    expect(r.policy.maxTokensPerRun).toBe(500);
  });

  it("数组里第 i 份坏掉时，错误里带下标（便于定位是哪一份）", () => {
    const d = tmpDir();
    put(d, "multi.json", [{ version: 1, denyCommands: ["a"] }, { version: 7 }]);

    const r = loadPolicyDir(d);
    expect(r.files).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].file).toMatch(/multi\.json\[1\]$/);
    expect(r.policy.denyCommands).toEqual(["a"]);
  });
});
