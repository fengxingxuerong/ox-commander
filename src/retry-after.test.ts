import { describe, expect, it } from "vitest";
import {
  ERROR_BODY_BYTE_CAP,
  RESPONSE_BODY_BYTE_CAP,
  RETRY_AFTER_SLEEP_CAP,
  OpenAiCompatibleClient,
  parseRetryAfterMs,
  readCappedErrorBody,
} from "../shared/http-clients";
import type { ProviderConfig } from "../shared/providers";

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

/**
 * A response body that exposes a stream (every real `fetch` response) can be
 * capped *while reading*: the reader stops pulling from the wire once the byte
 * budget is spent and cancels the stream. Response doubles with only `text()`
 * keep the decode-then-trim fallback — the cap still bounds what's kept, just
 * not what crosses the wire.
 */
describe("streamed body cap", () => {
  function streamedResponse(parts: string[], status = 500) {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const text = async () => parts.join("");
    const res =
      status === 200
        ? { ok: true, status, body, text, json: async () => JSON.parse(parts.join("")) }
        : { ok: false, status, body, text, json: async () => JSON.parse(parts.join("")) };
    return { res, cancelled: () => cancelled };
  }

  it("stops pulling and cancels the stream once the byte budget is spent", async () => {
    const half = "x".repeat(ERROR_BODY_BYTE_CAP);
    const { res, cancelled } = streamedResponse([half, half, half]);
    const out = await readCappedErrorBody(res);
    expect(out.startsWith("x".repeat(100))).toBe(true);
    expect(out).toContain("[truncated");
    expect(out.length).toBeLessThan(ERROR_BODY_BYTE_CAP + 100);
    // The whole point: the third chunk never needs to be pulled — the stream
    // is cancelled as soon as the budget is exhausted.
    expect(cancelled()).toBe(true);
  });

  it("returns a streamed body under the cap verbatim without cancelling", async () => {
    const { res, cancelled } = streamedResponse(["rate limited"]);
    await expect(readCappedErrorBody(res)).resolves.toBe("rate limited");
    expect(cancelled()).toBe(false);
  });

  it("keeps multi-byte characters intact around the cap boundary", async () => {
    const cjk = "火".repeat(400); // 3 bytes each in UTF-8
    const { res } = streamedResponse([cjk, cjk, cjk, cjk, cjk, cjk]);
    const out = await readCappedErrorBody(res);
    expect(out.length).toBeLessThan(ERROR_BODY_BYTE_CAP + 100);
    // No replacement garbage from a torn multi-byte sequence at the boundary.
    expect(out.includes("\uFFFD")).toBe(false);
  });

  it("caps the successful JSON body of a chat call and reports malformed input", async () => {
    const cfg: ProviderConfig = {
      id: "test",
      displayName: "test",
      protocol: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      defaultModel: "m",
      apiKeyEnvVar: "TEST_KEY",
    };
    // One giant chunk >> RESPONSE_BODY_BYTE_CAP: a real fetch would expose this
    // as a stream, so the client must stop reading instead of decoding it all.
    const huge = `{"choices":[{"message":{"content":"${"x".repeat(RESPONSE_BODY_BYTE_CAP)}"}}]}`;
    const { res } = streamedResponse([huge], 200);
    const client = new OpenAiCompatibleClient(cfg, "sk-test", (async () => res) as never, 1000);
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /无法解析的响应体/,
    );
  });
});
