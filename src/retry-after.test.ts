import { describe, expect, it } from "vitest";
import { RETRY_AFTER_SLEEP_CAP, parseRetryAfterHeaderMs } from "../shared/http-clients";

/**
 * A `Retry-After` header is attacker/provider-controlled and unbounded. Without
 * a cap, one hostile value parks a `chat()` call (and the whole pipeline behind
 * it) for hours while the orchestrator still reports the run as healthy.
 */
describe("parseRetryAfterHeaderMs", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfterHeaderMs("7")).toBe(7_000);
  });

  it("caps an absurd delay-seconds value at the sleep cap", () => {
    // 86400s = 24h; the whole point of the cap.
    expect(parseRetryAfterHeaderMs("86400")).toBe(RETRY_AFTER_SLEEP_CAP);
    expect(RETRY_AFTER_SLEEP_CAP).toBeLessThanOrEqual(60_000);
  });

  it("caps an HTTP-date far in the future", () => {
    const farFuture = new Date(Date.now() + 86_400_000).toUTCString();
    expect(parseRetryAfterHeaderMs(farFuture)).toBe(RETRY_AFTER_SLEEP_CAP);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfterHeaderMs(null)).toBeUndefined();
    expect(parseRetryAfterHeaderMs(undefined)).toBeUndefined();
    expect(parseRetryAfterHeaderMs("")).toBeUndefined();
    expect(parseRetryAfterHeaderMs("not-a-date")).toBeUndefined();
  });

  it("clamps negative delays to zero", () => {
    expect(parseRetryAfterHeaderMs("-5")).toBe(0);
  });
});
