import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN_WRITE, PathPolicy } from "../electron/sandbox/path-policy";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-policy-"));

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
});

describe("PathPolicy.assertReadable", () => {
  it("allows in-project paths and refuses escapes", () => {
    const p = policy();
    expect(p.assertReadable("src/a.js")).toBe(true);
    expect(p.assertReadable("../a.js")).toBe(false);
    expect(p.assertReadable("")).toBe(false);
  });
});
