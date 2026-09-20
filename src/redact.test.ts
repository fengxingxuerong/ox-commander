import { describe, expect, it } from "vitest";
import { containsLikelySecret, redactSecrets } from "../shared/redact";

/**
 * The digests these functions guard flow to two durable sinks — the renderer's
 * board and the audit JSONL. A missed pattern here is a credential on disk.
 */
describe("redactSecrets", () => {
  it("redacts SenseNova/OpenAI-shaped keys but keeps the prefix", () => {
    const out = redactSecrets("调用失败 sk-abc123def456ghi789 请重试");
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).toContain("sk-[REDACTED]");
  });

  it("redacts provider-prefixed keys", () => {
    const nv = redactSecrets("nvapi-AbCdEf1234567890xyz");
    expect(nv).toBe("nvapi-[REDACTED]");
    const amd = redactSecrets("rc-9e1f2a3b4c5d6e7f8a9b");
    expect(amd).toBe("rc-[REDACTED]");
  });

  it("redacts bearer tokens, keeping the scheme", () => {
    const out = redactSecrets("authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghij");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9abcdefghij");
    expect(out).toMatch(/Bearer \[REDACTED\]/);
  });

  it("redacts named secrets in both header and JSON shapes", () => {
    expect(redactSecrets('x-api-key: 0123456789abcdef')).toBe("x-api-key: [REDACTED]");
    expect(redactSecrets('{"apiKey":"0123456789abcdef"}')).toContain("[REDACTED]");
    expect(redactSecrets('{"apiKey":"0123456789abcdef"}')).not.toContain("0123456789abcdef");
  });

  it("redacts bare JWTs and AWS access key ids", () => {
    expect(redactSecrets("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl")).toContain("[REDACTED_JWT]");
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA[REDACTED]");
  });

  it("leaves ordinary log text untouched", () => {
    const text = "批次 2/3 完成：3/4 成功\nzone 越权：src/core 修改了 README.md";
    expect(redactSecrets(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactSecrets("sk-abc123def456ghi789");
    expect(redactSecrets(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("containsLikelySecret reports only when a redaction actually happened", () => {
    expect(containsLikelySecret("sk-abc123def456ghi789")).toBe(true);
    expect(containsLikelySecret("plain build output")).toBe(false);
  });
});
