import { getProvider, SENSENOVA_KEY_VARS, SENSENOVA_MODELS, type ChatMessage, type ProviderConfig } from "./providers";
import type { ChatRequest, ChatResponse, LlmClient } from "./llm-client";

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Present on real fetch responses; optional so test doubles stay compatible. */
  headers?: { get(name: string): string | null };
}

interface FetchLike {
  (url: string, init: RequestInit): Promise<FetchLikeResponse>;
}

export class HttpLlmError extends Error {
  public readonly retryAfterMs?: number;
  constructor(public status: number, body: string, retryAfterMs?: number) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpLlmError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Transient infra glitch: 200 OK but body is not parseable JSON (e.g. BOM prefix, truncated stream). */
export class MalformedResponseError extends Error {
  constructor(body: string) {
    super(`LLM 返回了无法解析的响应体: ${JSON.stringify(body.slice(0, 80))}`);
    this.name = "MalformedResponseError";
  }
}

/**
 * Cap on the *in-call sleep* derived from `Retry-After`. The cooldown cap
 * (`RETRY_AFTER_COOLDOWN_CAP_MS`) only bounds the bench time; without this
 * second cap a single `retry-after: 86400` would park one `chat()` for a full
 * day while the orchestrator still believes the run is healthy.
 */
const RETRY_AFTER_SLEEP_CAP_MS = 60_000;

/** Parses a `retry-after` header value (delay-seconds or HTTP-date) into milliseconds. */
function parseRawRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Sleep-bounded view of a Retry-After header: the raw value may be arbitrarily large. */
function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  const ms = parseRawRetryAfterMs(raw);
  return ms === undefined ? undefined : Math.min(ms, RETRY_AFTER_SLEEP_CAP_MS);
}

/**
 * Parse a `Retry-After` header into milliseconds, clamped to the in-call sleep
 * cap. Exported so the cap itself is testable without a live HTTP round-trip.
 */
export function parseRetryAfterHeaderMs(raw: string | null | undefined): number | undefined {
  return parseRetryAfterMs(raw);
}

export const RETRY_AFTER_SLEEP_CAP = RETRY_AFTER_SLEEP_CAP_MS;

abstract class BaseHttpLlmClient implements LlmClient {
  constructor(
    protected config: ProviderConfig,
    protected apiKey: string,
    protected fetchImpl: FetchLike = fetch as unknown as FetchLike,
    protected timeoutMs = 300_000,
  ) {}

  abstract chat(req: ChatRequest): Promise<ChatResponse>;

  protected async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpLlmError(res.status, text, parseRetryAfterMs(res.headers?.get("retry-after")));
    }
    const raw = (await res.text()).replace(/^\uFEFF/, "");
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new MalformedResponseError(raw);
    }
  }
}

export class OpenAiCompatibleClient extends BaseHttpLlmClient {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.config.defaultModel,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
    };
    if (req.jsonMode) body.response_format = { type: "json_object" };
    const data = await this.postJson(
      `${this.config.baseUrl}/chat/completions`,
      this.authHeaders(),
      body,
    );
    const choices = data.choices as
      | Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
      | undefined;
    const choice = choices?.[0];
    const raw = choice?.message ?? {};
    if (choice?.finish_reason === "length") {
      throw new MalformedResponseError(`输出因长度限制被截断（finish_reason=length）：${(raw.content ?? "").slice(0, 80)}`);
    }
    // Some reasoning models put the answer in reasoning_content and leave content empty.
    const content = (raw.content ?? "").trim() !== "" ? (raw.content ?? "") : (raw.reasoning_content ?? "");
    const usage = data.usage as { total_tokens?: number } | undefined;
    return {
      content,
      provider: this.config.id,
      model: String(data.model ?? this.config.defaultModel),
      usageTokens: usage?.total_tokens,
    };
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKeyEnvVar ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}

export class AnthropicClient extends BaseHttpLlmClient {
  private toAnthropicMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.find((m) => m.role === "system")?.content;
    const body: Record<string, unknown> = {
      model: this.config.defaultModel,
      max_tokens: 8192,
      temperature: req.temperature ?? 0.2,
      messages: this.toAnthropicMessages(req.messages),
    };
    if (system) body.system = system;
    const data = await this.postJson(`${this.config.baseUrl}/messages`, this.authHeaders(), body);
    const blocks = data.content as Array<{ type: string; text?: string }> | undefined;
    const content = (blocks ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      content,
      provider: this.config.id,
      model: String(data.model ?? this.config.defaultModel),
      usageTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    };
  }

  private authHeaders(): Record<string, string> {
    return { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" };
  }
}

/** Brain layer (PRD / task decomposition) calls: compact JSON, tighter timeout. */
export const BRAIN_TIMEOUT_MS = 120_000;
/** Executor layer calls: full-file code generation, generous timeout. */
export const EXECUTOR_TIMEOUT_MS = 300_000;

export function createLlmClient(config: ProviderConfig, apiKey: string, timeoutMs?: number): LlmClient {
  if (config.protocol === "anthropic") return new AnthropicClient(config, apiKey, undefined, timeoutMs);
  return new OpenAiCompatibleClient(config, apiKey, undefined, timeoutMs);
}

export interface FailoverGroup {
  label: string;
  clients: LlmClient[];
}

export interface FailoverOptions {
  /** Cooldown applied to a combo after a transient failure that carries no Retry-After. */
  cooldownMs?: number;
  /** Cap for the exponential backoff sleep between combos. */
  maxBackoffMs?: number;
  /** First backoff sleep; doubles for each subsequent failure within one chat() call. */
  baseBackoffMs?: number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Observability sink: combo failures, cooldown skips, rotation decisions. */
  onEvent?: (text: string) => void;
  /**
   * Whether 401/403 aborts the whole pool (default) or just benches that route.
   *
   * Within one provider, an auth failure means the credentials are wrong, so
   * retrying other routes only wastes time — hence the default. In a
   * **cross-provider** pool it is the opposite: one provider's missing/expired
   * key must not take down the providers that are perfectly healthy.
   */
  failFastOnAuth?: boolean;
}

/** Retry-After-derived cooldowns are capped so a hostile/crazy header cannot shelve a combo for hours. */
const RETRY_AFTER_COOLDOWN_CAP_MS = 300_000;

/** Thrown when every failover combo is still cooling down; retrying immediately cannot succeed. */
export class AllRoutesCoolingError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`所有 LLM 故障转移组合均在冷却中，约 ${Math.ceil(retryInMs / 1000)}s 后再试`);
    this.name = "AllRoutesCoolingError";
  }
}

function isTransient(e: unknown): boolean {
  if (e instanceof HttpLlmError) return e.status === 429 || e.status >= 500;
  return true; // malformed body, timeout, network-level errors
}

/**
 * Tries clients group by group (one group per API key); any transient failure
 * (429, 5xx, timeouts, malformed bodies) rotates to the next combo; auth
 * failures (401/403) fail fast since retrying another combo cannot help.
 *
 * Cooldowns: a transient failure puts its combo on the bench (30s default, or
 * the 429 Retry-After value capped at 5min) so later chat() calls skip it
 * instead of re-hitting a known-bad route. Backoff between combos grows
 * exponentially (500ms * 2^failIndex, capped) and never goes below a
 * Retry-After hint. When every combo is cooling, chat() throws
 * AllRoutesCoolingError immediately instead of sleeping.
 */
export class FailoverLlmClient implements LlmClient {
  private cooldowns = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly maxBackoffMs: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (text: string) => void;
  private readonly failFastOnAuth: boolean;

  constructor(
    private groups: FailoverGroup[],
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    opts?: FailoverOptions,
  ) {
    this.cooldownMs = opts?.cooldownMs ?? 30_000;
    this.maxBackoffMs = opts?.maxBackoffMs ?? 8_000;
    this.baseBackoffMs = opts?.baseBackoffMs ?? 500;
    this.now = opts?.now ?? Date.now;
    this.onEvent = opts?.onEvent;
    this.failFastOnAuth = opts?.failFastOnAuth ?? true;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.groups.length === 0) throw new Error("failover client has no groups");
    const now = this.now();
    const attempts: Array<{ client: LlmClient; comboKey: string }> = [];
    let skipped = 0;
    for (const group of this.groups) {
      for (let ci = 0; ci < group.clients.length; ci++) {
        const comboKey = `${group.label}#${ci}`;
        const until = this.cooldowns.get(comboKey);
        if (until !== undefined && until > now) {
          skipped++;
          continue; // cooling: skip silently, no sleep
        }
        attempts.push({ client: group.clients[ci]!, comboKey });
      }
    }
    if (attempts.length === 0) {
      const retryInMs = Math.max(0, ...[...this.cooldowns.values()].map((u) => u - now));
      throw new AllRoutesCoolingError(retryInMs);
    }
    if (skipped > 0) this.onEvent?.(`跳过 ${skipped} 个冷却中的组合`);
    let lastErr: unknown = new Error("failover client has no groups");
    for (let k = 0; k < attempts.length; k++) {
      const { client, comboKey } = attempts[k];
      try {
        const res = await client.chat(req);
        this.cooldowns.delete(comboKey);
        return res;
      } catch (e) {
        const status = e instanceof HttpLlmError ? e.status : undefined;
        const nonRetryable = status === 401 || status === 403;
        if (nonRetryable && this.failFastOnAuth) {
          this.onEvent?.(`${comboKey} 认证失败（${status}），终止`);
          throw e;
        }
        lastErr = e;
        if (nonRetryable) {
          // Multi-provider pool: bench this route only, keep the healthy ones.
          const cd = this.setCooldown(comboKey, e);
          this.onEvent?.(`${comboKey} 认证失败（${status}），仅冷却该线路 ${Math.round(cd / 1000)}s`);
          // Waiting cannot fix a bad credential — skip the backoff and move on.
          // Without this, a pool whose first provider is misconfigured spends
          // one backoff window per route (12 routes ≈ 80s) before reaching a
          // provider that works.
          continue;
        }
        if (isTransient(e)) {
          const cd = this.setCooldown(comboKey, e);
          this.onEvent?.(
            `${comboKey} 失败（${errorDigest(e)}），冷却 ${Math.round(cd / 1000)}s`,
          );
        } else {
          this.onEvent?.(`${comboKey} 失败（${errorDigest(e)}），不冷却`);
        }
      }
      if (k < attempts.length - 1) {
        const retryAfterMs = lastErr instanceof HttpLlmError ? lastErr.retryAfterMs : undefined;
        const backoff = Math.min(this.baseBackoffMs * 2 ** k, this.maxBackoffMs);
        await this.sleep(retryAfterMs !== undefined ? Math.max(backoff, retryAfterMs) : backoff);
      }
    }
    throw lastErr;
  }

  private setCooldown(comboKey: string, e: unknown): number {
    const retryAfterMs = e instanceof HttpLlmError ? e.retryAfterMs : undefined;
    const cd =
      retryAfterMs !== undefined
        ? Math.min(retryAfterMs, RETRY_AFTER_COOLDOWN_CAP_MS)
        : this.cooldownMs;
    this.cooldowns.set(comboKey, this.now() + cd);
    return cd;
  }
}

function errorDigest(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

export interface FailoverClientOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onEvent?: (text: string) => void;
}

/** Generic failover factory: one group per key env var, models rotated within each group. */
export function createFailoverClient(
  provider: string | ProviderConfig,
  keyVars: readonly string[],
  models: readonly string[],
  opts: FailoverClientOptions = {},
): LlmClient {
  const base = typeof provider === "string" ? getProvider(provider) : provider;
  const env = opts.env ?? process.env;
  const groups: FailoverGroup[] = [];
  for (const keyVar of keyVars) {
    const apiKey = env[keyVar] ?? "";
    if (!apiKey) continue;
    groups.push({
      label: keyVar,
      clients: models.map(
        (model) => new OpenAiCompatibleClient({ ...base, defaultModel: model }, apiKey, undefined, opts.timeoutMs),
      ),
    });
  }
  return new FailoverLlmClient(groups, undefined, { onEvent: opts.onEvent });
}

/** SenseNova flavor: 3 key env vars x N models with automatic failover. Thin wrapper, signature preserved. */
export function createSensenovaFailoverClient(
  env: NodeJS.ProcessEnv = process.env,
): LlmClient {
  return createFailoverClient("sensenova", SENSENOVA_KEY_VARS, SENSENOVA_MODELS, { env });
}

/** One provider's participation in a cross-provider pool. */
export interface PoolRoute {
  providerId: string;
  /** Keys for this provider, in preference order; missing ones are skipped. */
  keyVars: readonly string[];
  /** Models rotated within each key's group. */
  models: readonly string[];
}

export interface PoolOptions extends FailoverClientOptions {
  /** Force the auth behaviour instead of deriving it (see `failFastOnAuth`). */
  failFastOnAuth?: boolean;
}

/**
 * Builds **one** failover table across several providers.
 *
 * Route count is multiplied out — 3 keys × 4 models is 12 routes, plus one per
 * model on every other provider — and they all share a single cooldown table.
 * That is what makes "multiple APIs working at the same time" real rather than
 * a chain of nested clients: a 429 on one route benches exactly that route, and
 * the very next attempt (same call) may land on a different key, a different
 * model, or a different provider entirely.
 *
 * Auth failures bench only their own route when the pool spans more than one
 * provider — one provider's missing key must not blind the others.
 */
export function createMultiProviderFailover(
  routes: readonly PoolRoute[],
  opts: PoolOptions = {},
): LlmClient {
  const env = opts.env ?? process.env;
  const groups: FailoverGroup[] = [];
  for (const route of routes) {
    const base = getProvider(route.providerId);
    for (const keyVar of route.keyVars) {
      const apiKey = keyVar === "" ? "" : (env[keyVar] ?? "");
      // Keyless providers (a local Ollama, say) still get their routes.
      if (keyVar !== "" && apiKey === "") continue;
      groups.push({
        label: `${base.id}:${keyVar || "nokey"}`,
        clients: route.models.map(
          (model) =>
            createLlmClient({ ...base, defaultModel: model }, apiKey, opts.timeoutMs),
        ),
      });
    }
  }
  const providerCount = new Set(routes.map((r) => r.providerId)).size;
  return new FailoverLlmClient(groups, undefined, {
    onEvent: opts.onEvent,
    failFastOnAuth: opts.failFastOnAuth ?? providerCount <= 1,
  });
}

/** Number of routes a pool spec would produce — used by the UI/tests. */
export function countPoolRoutes(routes: readonly PoolRoute[], env: NodeJS.ProcessEnv = process.env): number {
  let n = 0;
  for (const route of routes) {
    for (const keyVar of route.keyVars) {
      if (keyVar !== "" && !(env[keyVar] ?? "")) continue;
      n += route.models.length;
    }
  }
  return n;
}
