import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readMcpList } from "../electron/ipc/mcp";

const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-mcp-ipc-"));
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
});

describe("mcp:list · 只读清单", () => {
  it("列出 server 摘要，env 只出名字且排序；坏清单进 issues", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "fs.json"),
      JSON.stringify({ command: "npx", args: ["-y", "pkg"], env: { Z: "1", A: "2" }, timeoutMs: 2_000 }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ args: [] }), "utf8");
    const res = readMcpList(dir);
    expect(res.dir).toBe(dir);
    expect(res.servers).toEqual([
      {
        name: "fs",
        command: "npx",
        args: ["-y", "pkg"],
        envNames: ["A", "Z"],
        timeoutMs: 2_000,
      },
    ]);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]?.file).toBe("bad.json");
    expect(res.problem).toBeUndefined();
  });

  it("空/不存在的目录是正常状态（不是 problem）", () => {
    const missing = path.join(tempDir(), "nope");
    expect(readMcpList(missing)).toEqual({ dir: missing, servers: [], issues: [] });
  });

  it("目录参数异常时把问题带回去，而不是抛给渲染层", () => {
    const res = readMcpList(null as unknown as string);
    expect(res.servers).toEqual([]);
    expect(res.issues).toEqual([]);
    expect(res.problem).toContain("trim");
  });
});
