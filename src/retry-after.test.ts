import { describe, expect, it } from "vitest";
import { ERROR_BODY_BYTE_CAP, RETRY_AFTER_SLEEP_CAP, parseRetryAfterMs, readCappedErrorBody } from "../shared/http-clients";

/**
 * A `Retry-After` header is attacker/provider-controlled and unbounded. Without
 * a cap, one hostile value parks a `chat()` call (and the whole pipeline behind
 * it) for hours while the orchestrator still reports the run as healthy.
 */
describe("parseRetryAfterMs", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
  });

  it("caps an absurd delay-seconds value at the sleep cap", () => {
    // 86400s = 24h; the whole point of the cap.
    expect(parseRetryAfterMs("86400")).toBe(RETRY_AFTER_SLEEP_CAP);
    expect(RETRY_AFTER_SLEEP_CAP).toBeLessThanOrEqual(60_000);
  });

  it("caps an HTTP-date far in the future", () => {
    const farFuture = new Date(Date.now() + 86_400_000).toUTCString();
    expect(parseRetryAfterMs(farFuture)).toBe(RETRY_AFTER_SLEEP_CAP);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
  });

  it("clamps negative delays to zero", () => {
    expect(parseRetryAfterMs("-5")).toBe(0);
  });
});

/**
 * The error body is provider-controlled and unbounded. `HttpLlmError` shows
 * only 300 chars, but a multi-megabyte gateway error page would still be
 * decoded in full — per route, per retry.
 */
describe("readCappedErrorBody", () => {
  const respond = (text: string) => ({
    ok: false,
    status: 500,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  });

  it("returns a small body verbatim", async () => {
    await expect(readCappedErrorBody(respond("rate limited"))).resolves.toBe("rate limited");
  });

  it("truncates an oversized body and says so", async () => {
    const huge = "x".repeat(ERROR_BODY_BYTE_CAP * 3);
    const out = await readCappedErrorBody(respond(huge));
    expect(out).toContain("[truncated");
    // Head is kept, total stays bounded by the cap plus the marker.
    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out.length).toBeLessThan(ERROR_BODY_BYTE_CAP + 100);
  });

  it("leaves a body exactly at the cap untouched", async () => {
    const exact = "y".repeat(ERROR_BODY_BYTE_CAP);
    await expect(readCappedErrorBody(respond(exact))).resolves.toBe(exact);
  });
});
