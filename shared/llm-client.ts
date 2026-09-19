import type { ChatRequest, ChatResponse } from "./providers";
import type { ChatMessage } from "./providers";
import { AllRoutesCoolingError } from "./http-clients";

export type { ChatRequest, ChatResponse };

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface JsonCallOptions<T> {
  schemaName: string;
  validate: (raw: unknown) => T;
  maxRetries?: number;
}

export class JsonParseError extends Error {
  constructor(public readonly attempt: number, public readonly lastRaw: string, message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

export const DEFAULT_COOLDOWN_MAX_WAITS = 2;
export const DEFAULT_COOLDOWN_MAX_WAIT_MS = 120_000;

export interface CooldownRetryOptions {
  /** Max number of cooldown waits before giving up and rethrowing (default 2). */
  maxWaits?: number;
  /** Cap for a single wait so a huge Retry-After cannot stall the pipeline (default 120s). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook, fired right before each wait. */
  onWait?: (waitMs: number, waitIndex: number) => void;
  /** When it returns true the original error is rethrown instead of waiting (e.g. run aborted). */
  shouldStop?: () => boolean;
}

/**
 * Cooldown-aware wrapper for LLM calls: chatJson propagates AllRoutesCoolingError
 * immediately (retrying a cooling failover pool cannot help), but "temporarily
 * rate-limited everywhere" is not a permanent failure — so this wrapper parks the
 * call for the cooldown window (bounded) and retries instead of failing the task.
 */
export async function withCooldownRetry<T>(fn: () => Promise<T>, opts: CooldownRetryOptions = {}): Promise<T> {
  const maxWaits = opts.maxWaits ?? DEFAULT_COOLDOWN_MAX_WAITS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_COOLDOWN_MAX_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waits = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof AllRoutesCoolingError) || waits >= maxWaits) throw e;
      if (opts.shouldStop?.()) throw e;
      const waitMs = Math.min(Math.max(e.retryInMs, 0), maxWaitMs);
      waits += 1;
      opts.onWait?.(waitMs, waits);
      await sleep(waitMs);
    }
  }
}

/** Returns every balanced {...} / [...] block in the text, in order of appearance. */
function extractJsonCandidates(text: string): unknown[] {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  const out: unknown[] = [];
  try {
    out.push(JSON.parse(withoutFences));
    return out;
  } catch {
    // Fall back: scan all balanced blocks; pseudo-JSON and echoed prompts may
    // precede the real payload, so callers try each candidate against schema.
  }
  for (const [openCh, closeCh] of [["{", "}"], ["[", "]"]] as const) {
    let searchFrom = 0;
    for (;;) {
      const start = withoutFences.indexOf(openCh, searchFrom);
      if (start < 0) break;
      searchFrom = start + 1;
      const slice = balancedSlice(withoutFences, start, openCh, closeCh);
      if (slice === null) continue;
      try {
        out.push(JSON.parse(slice));
      } catch {
        // not valid JSON; keep scanning later blocks
      }
    }
  }
  return out;
}

function balancedSlice(s: string, start: number, openCh: string, closeCh: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Calls the LLM and validates its output against a schema; retries with the validation error fed back into the conversation. */
export async function chatJson<T>(
  client: LlmClient,
  request: ChatRequest,
  options: JsonCallOptions<T>,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const jsonDirective =
    "CRITICAL: Respond with exactly ONE valid JSON value (object or array) using strict JSON syntax: double-quoted keys and strings, no trailing commas, no comments, no markdown fences, no extra text before or after the JSON.";
  // Copy (never mutate) the caller's system message before appending the directive.
  const originalSystem = request.messages.find((m) => m.role === "system");
  const systemMsg: ChatMessage = {
    role: "system",
    content: originalSystem ? `${originalSystem.content}\n\n${jsonDirective}` : jsonDirective,
  };
  const restMessages = request.messages.filter((m) => m.role !== "system");
  let lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const messages: ChatMessage[] = [systemMsg, ...restMessages];
    if (attempt > 0) {
      messages.push({
        role: "user",
        content: `Your previous output failed ${options.schemaName} validation: ${lastRaw.slice(0, 500)}. Respond again with ONLY valid JSON.`,
      });
    }
    let res;
    try {
      res = await client.chat({ ...request, messages, jsonMode: true });
    } catch (e) {
      // Every failover combo is already cooling down: this outer retry loop
      // would only re-hit the same cooldown, so propagate immediately.
      if (e instanceof AllRoutesCoolingError) throw e;
      // Transport-level failures (network errors, timeouts) are retryable too.
      if (attempt === maxRetries) throw e;
      lastRaw = `(transport error: ${(e as Error).message})`;
      continue;
    }
    lastRaw = res.content;
    // Try every extracted candidate against the schema; the first one that
    // validates wins (reasoning models often echo prompt JSON before the answer).
    let validationError: Error | null = null;
    for (const candidate of extractJsonCandidates(res.content)) {
      try {
        return options.validate(candidate);
      } catch (e) {
        validationError = e as Error;
      }
    }
    if (attempt === maxRetries) {
      throw new JsonParseError(
        attempt,
        lastRaw,
        validationError
          ? `schema validation failed: ${validationError.message}`
          : "no JSON found in model output",
      );
    }
  }
  throw new JsonParseError(maxRetries, lastRaw, "unreachable");
}
