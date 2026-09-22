import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN_WRITE, PathPolicy } from "../electron/sandbox/path-policy";

// Realpath with `.native` on purpose: mkdtemp may return an 8.3 short-name
// path (e.g. `ADMIN~1` for a non-ASCII user directory), and PathPolicy now
// resolves the root the same way — the test baseline must use the same form.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ox-policy-")));

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // temp cleaner will get it
  }
});

function policy(over: Partial<ConstructorParameters<typeof PathPolicy>[0]> = {}) {
  return new PathPolicy({ projectRoot: root, ...over });
}

describe("PathPolicy.assertWritable", () => {
  it("allows a plain file inside the project", () => {
    const d = policy().assertWritable("src/core/a.js");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.abs).toBe(path.join(root, "src", "core", "a.js"));
      expect(d.via).toBe("unrestricted");
    }
  });

  it("rejects empty and malformed input", () => {
    expect(policy().assertWritable("").ok).toBe(false);
    expect(policy().assertWritable("   ").ok).toBe(false);
  });

  it("rejects absolute paths", () => {
    const d = policy().assertWritable(process.platform === "win32" ? "C:/Windows/system32/x.dll" : "/etc/passwd");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("绝对路径");
  });

  it("两种绝对路径形态都要拒绝，不能只认当前平台那一种", () => {
    // 上一条用例只测了**平台对上号**的那一种，于是守卫
    // `path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath.trim())`
    // 里的 `||` 改成 `&&` 之后照样通过：
    //   win32 测 "C:/Windows/…" → 两个条件都成立 → `true && true` 仍为 true
    //   posix 测 "/etc/passwd"  → 第一个条件成立 → 另一种形态根本没被覆盖
    //
    // 而两种形态**各自**都足以构成绝对路径，任何一个条件单独成立都必须拒绝 ——
    // 漏掉的那一种就是"写穿沙箱根"的入口。
    const p = policy();
    for (const abs of ["C:/Windows/system32/x.dll", "/etc/passwd"]) {
      const d = p.assertWritable(abs, ".");
      expect(d.ok).toBe(false);
    }
  });

  it("rejects traversal, including the encoded-looking variants", () => {
    for (const p of ["../outside.js", "src/../../outside.js", "a/../../b.js"]) {
      const d = policy().assertWritable(p);
      expect(d.ok).toBe(false);
    }
  });

  it("rejects the protected paths by default", () => {
    for (const p of [...DEFAULT_FORBIDDEN_WRITE.slice(0, 4), "node_modules/x/index.js", ".git/config", ".env", ".env.local"]) {
      const d = policy().assertWritable(p.includes("*") ? p.replace(/\*\*.*/, "anything.js") : p);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toContain("受保护路径");
    }
  });

  it("honours a custom forbidden list", () => {
    const p = policy({ forbiddenWrite: ["docs/**"] });
    expect(p.assertWritable("docs/readme.md").ok).toBe(false);
    // The built-in list is replaced, so package.json becomes writable again.
    expect(p.assertWritable("package.json").ok).toBe(true);
  });

  it("confines writes to the declared writable roots", () => {
    const p = policy({ writableRoots: ["src", "tests"] });
    expect(p.assertWritable("src/a.js").ok).toBe(true);
    expect(p.assertWritable("tests/a.js").ok).toBe(true);
    const d = p.assertWritable("scripts/build.js");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("越出可写根");
  });

  it("refuses to escape the project even when the writable root is broader", () => {
    const p = policy({ writableRoots: [path.resolve(root, "..")] });
    const d = p.assertWritable("src/a.js");
    // Still inside the project, so allowed.
    expect(d.ok).toBe(true);
    // A sibling of the project root is outside the project itself.
    expect(p.assertWritable("../sibling.js").ok).toBe(false);
  });

  it("enforces the zone in legacy mode (zone '.' owns everything)", () => {
    const p = policy();
    expect(p.assertWritable("src/a.js", "src").ok).toBe(true);
    expect(p.assertWritable("tests/a.js", "src").ok).toBe(false);
    expect(p.assertWritable("anything/a.js", ".").ok).toBe(true);
    expect(p.assertWritable("anything/a.js", "").ok).toBe(true);
  });

  it("reinterprets zone '.' in strict mode as root-level files only", () => {
    const p = policy({ zoneMode: "strict" });
    expect(p.assertWritable("a.js", ".").ok).toBe(true);
    const nested = p.assertWritable("src/a.js", ".");
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.reason).toContain("zone 越权");
    expect(p.assertWritable("src/a.js", "src").ok).toBe(true);
  });

  it("allows a zone violation only when the path is delegated", () => {
    const p = policy({ delegatedWrite: ["shared/**"] });
    expect(p.assertWritable("tests/x.js", "src").ok).toBe(false);
    const d = p.assertWritable("shared/x.js", "src");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.via).toBe("delegated");
    expect(p.isDelegated("shared/x.js")).toBe(true);
    expect(p.isDelegated("tests/x.js")).toBe(false);
  });

  it("reports the zone in the reason so the log is actionable", () => {
    const d = policy().assertWritable("tests/x.js", "src/core");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("src/core");
  });

  it("keeps forbidden paths forbidden even when delegated", () => {
    const p = policy({ delegatedWrite: ["**"], zoneMode: "legacy" });
    // `**` delegation is broad, but the safety floor still wins.
    const d = p.assertWritable("package.json", "src");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("受保护路径");
  });

  it("refuses protected paths written in the wrong case (P1-5)", () => {
    // On a case-insensitive filesystem `PACKAGE.JSON` IS `package.json`; a
    // case-sensitive glob match lets the agent overwrite the manifest anyway.
    const ci = process.platform === "win32" || process.platform === "darwin";
    for (const p of ["PACKAGE.JSON", "Package.json", "PACKAGE-LOCK.JSON", ".ENV", ".Env.Local", "Node_Modules/x.js"]) {
      const d = policy().assertWritable(p);
      if (ci) {
        expect(d.ok, `${p} should be rejected on a case-insensitive fs`).toBe(false);
        if (!d.ok) expect(d.reason).toContain("受保护路径");
      } else {
        // A case-sensitive fs really does treat these as different files.
        expect(d.ok, `${p} is a distinct name on a case-sensitive fs`).toBe(true);
      }
    }
  });

  it("refuses a junction that points outside the project (P1-5)", () => {
    if (process.platform !== "win32") return; // junctions are a Windows concept
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ox-pathpolicy-out-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.symlinkSync(outside, path.join(root, "src", "out-link"), "junction");
      // A purely lexical check resolves this to root/src/out-link/x.js — inside.
      // The real location is `outside`, and the write must be judged there.
      const d = policy().assertWritable("src/out-link/escape.js");
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toContain("越出项目根目录");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("still allows a junction that resolves back inside the project (golden)", () => {
    if (process.platform !== "win32") return;
    fs.mkdirSync(path.join(root, "real-dir"), { recursive: true });
    fs.symlinkSync(path.join(root, "real-dir"), path.join(root, "in-link"), "junction");
    const d = policy().assertWritable("in-link/ok.js");
    expect(d.ok).toBe(true);
    if (d.ok) {
      // The decision must expose the REAL location, not the link path.
      expect(d.abs.toLowerCase()).toBe(path.join(root, "real-dir", "ok.js").toLowerCase());
    }
  });

  it("resolves 8.3 short names before the protected check (P1-5)", () => {
    if (process.platform !== "win32") return;
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    let short: string;
    try {
      short = fs.realpathSync.native(path.join(root, "NODE_M~1"));
    } catch {
      return; // this volume has 8.3 name generation disabled — nothing to test
    }
    expect(path.basename(short).toLowerCase()).toBe("node_modules");
    const d = policy().assertWritable("NODE_M~1/pwn.js");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("受保护路径");
  });
});

describe("PathPolicy.assertReadable", () => {
  it("allows in-project paths and refuses escapes", () => {
    const p = policy();
    expect(p.assertReadable("src/a.js")).toBe(true);
    expect(p.assertReadable("../a.js")).toBe(false);
    expect(p.assertReadable("")).toBe(false);
  });
});
