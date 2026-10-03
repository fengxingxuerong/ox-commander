import { getProvider, type ChatMessage, type ProviderConfig } from "./providers";
import type { ChatRequest, ChatResponse, LlmClient } from "./llm-client";

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Present on real fetch responses; optional so test doubles stay compatible. */
  headers?: { get(name: string): string | null };
  /**
   * Present on real fetch responses; optional so test doubles stay compatible.
   * Exposed so large bodies can be capped *while streaming* instead of after a
   * full `text()` decode.
   */
  body?: { getReader(): ReadableStreamDefaultReader<Uint8Array> };
}

interface FetchLike {
  (url: string, init: RequestInit): Promise<FetchLikeResponse>;
}

export class HttpLlmError extends Error {
  public readonly retryAfterMs?: number;
  /**
   * 服务端的请求追踪 id（`x-request-id` / `request-id` / `x-generation-id`）。
   *
   * 弹性库生态的标准可观测性做法：带上它，向服务商报障时一句话就能定位到
   * 那一次请求 —— 不带的话工单要在时间戳和模型名里猜。字段缺席 = 端点没给
   * （不少 OpenAI 兼容代理不发），不是丢失。
   */
  public readonly requestId?: string;
  constructor(public status: number, body: string, retryAfterMs?: number, requestId?: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpLlmError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (requestId !== undefined) this.requestId = requestId;
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
 *
 * Exported so the cap itself is testable without a live HTTP round-trip.
 */
export const RETRY_AFTER_SLEEP_CAP = 60_000;

/**
 * Cap on the bytes read from a *failed* response body.
 *
 * `HttpLlmError` only ever shows 300 chars, but `await res.text()` first pulls
 * the whole body into memory. A gateway returning a multi-megabyte HTML error
 * page (or a hostile endpoint streaming forever) would otherwise be decoded in
 * full, per route, per retry. Only the head is kept — enough for the message
 * and for provider-specific error parsing.
 *
 * Exported so the cap itself is testable without a live HTTP round-trip.
 */
export const ERROR_BODY_BYTE_CAP = 64 * 1024;

/**
 * Cap on the successful JSON body of a chat call. A legitimate response is
 * kilobytes; a broken or hostile endpoint can stream arbitrarily more — and a
 * body that large would fail JSON parsing anyway, so the cap only keeps the
 * memory honest on the way to the same error.
 */
export const RESPONSE_BODY_BYTE_CAP = 8 * 1024 * 1024;

/**
 * Reads a response body under a hard byte budget. When the runtime exposes a
 * stream (every real `fetch` response does), the reader stops pulling and
 * cancels the stream as soon as the budget is spent — bytes past the cap never
 * cross the wire into memory. Response doubles that only implement `text()`
 * fall back to decode-then-trim. A torn multi-byte sequence at the cap
 * boundary is discarded (never flushed as replacement chars), since everything
 * after it is dropped anyway.
 */
export async function readBodyWithCap(res: FetchLikeResponse, capBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length <= capBytes) return text;
    return `${text.slice(0, capBytes)}…[truncated ${text.length - capBytes} chars]`;
  }
  const decoder = new TextDecoder();
  let out = "";
  let kept = 0;
  let dropped = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value!;
    const remaining = capBytes - kept;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) {
        out += decoder.decode(chunk.slice(0, remaining), { stream: true });
        kept = capBytes;
      }
      dropped += chunk.byteLength - Math.max(0, remaining);
      // Budget spent: stop pulling from the wire. No flush — the held tail of
      // a torn multi-byte sequence is dropped along with the rest.
      void reader.cancel().catch(() => {});
      if (dropped > 0) out += `…[truncated ~${Math.round(dropped / 1024)}KB]`;
      return out;
    }
    kept += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Reads at most `ERROR_BODY_BYTE_CAP` of a response body, marking truncation. */
export async function readCappedErrorBody(res: FetchLikeResponse): Promise<string> {
  return readBodyWithCap(res, ERROR_BODY_BYTE_CAP);
}

/** Parses a `retry-after` header value (delay-seconds or HTTP-date) into milliseconds. */
function parseRawRetryAfterMs(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Sleep-bounded view of a `Retry-After` header: the raw value may be
 * arbitrarily large. Exported so the cap itself is testable without a live
 * HTTP round-trip.
 */
export function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  const ms = parseRawRetryAfterMs(raw);
  return ms === undefined ? undefined : Math.min(ms, RETRY_AFTER_SLEEP_CAP);
}

/**
 * 从响应头提取服务端的请求追踪 id。各家名字不一：OpenAI 系 `x-request-id`、
 * Anthropic 系 `request-id`、OpenRouter `x-generation-id` —— 逐个试，都没有
 * 就返回 undefined（不少 OpenAI 兼容代理不发）。
 */
function requestIdOf(res: FetchLikeResponse): string | undefined {
  for (const h of ["x-request-id", "request-id", "x-generation-id"]) {
    const v = res.headers?.get(h);
    if (v) return v;
  }
  return undefined;
}

abstract class BaseHttpLlmClient implements LlmClient {  constructor(
    protected config: ProviderConfig,
    protected apiKey: string,
    protected fetchImpl: FetchLike = fetch as unknown as FetchLike,
    protected timeoutMs = 300_000,
  ) {}

  abstract chat(req: ChatRequest): Promise<ChatResponse>;

  protected async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // The per-request timeout and the caller's cancellation are independent:
    // whichever fires first wins. `AbortSignal.any` needs Node >= 20.3 (CI pins
    // 22, Electron 33 ships 20.18 — the headless CLI runs on the user's node,
    // so an older runtime fails loudly here rather than silently ignoring aborts).
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (signal) signals.push(signal);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      const text = await readCappedErrorBody(res);
      throw new HttpLlmError(res.status, text, parseRetryAfterMs(res.headers?.get("retry-after")), requestIdOf(res));
    }
    const raw = (await readBodyWithCap(res, RESPONSE_BODY_BYTE_CAP)).replace(/^\uFEFF/, "");
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
      /*
       * 必须显式带上 max_tokens，而且要给到端点允许的最大值。不带时商汤用默认
       * 输出上限；给 16384 仍会在 PLANNING 上截断 —— 因为 sensenova 的模型是
       * 推理型的，reasoning token 计入输出预算（实测 finish_reason=length 出现
       * 在两个不同模型上，2026-09-20 真实案例）。用端点声明的
       * max_output_length（65536）作为上限，reasoning 再长也不会吃掉正文。
       *
       * 同时关闭思考模式：sensenova 的推理模型思考一次要拖慢生成 15–20 倍
       * （实测同一请求 42–60s → 3.1s），是 PLANNING 超时的另一半根因。
       * OpenAI 兼容层对未知 body 字段普遍忽略；若未来某家报 400，
       * 再做成 per-provider 开关。
       */
      max_tokens: 65536,
      enable_thinking: false,
    };
    if (req.jsonMode) body.response_format = { type: "json_object" };
    const data = await this.postJson(
      `${this.config.baseUrl}/chat/completions`,
      this.authHeaders(),
      body,
      req.signal,
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
    const data = await this.postJson(
      `${this.config.baseUrl}/messages`,
      this.authHeaders(),
      body,
      req.signal,
    );
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
   * 线路健康的结构化出口（P1-2）：每次有线路进冷却/失败账变化后推一份全表。
   * 文本 sink（`onEvent`）只适合给人看，UI 要的是**字段**（哪条线路在冷却、
   * 还剩多久、被限流了几次）。
   */
  onHealth?: (lines: LineHealth[]) => void;
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

/**
 * 无 Retry-After 时的连续失败冷却升级上限。一条线路反复失败说明它大概率还在坏着，
 * 每次 30s 冷却到期就再撞一次慢请求是纯浪费 —— 冷却时长按 2^(streak-1) 指数升级，
 * 最多 bench 十分钟；成功一次即清零回档。
 */
export const COOLDOWN_ESCALATION_CAP_MS = 600_000;

/**
 * 线路级永久错误的 HTTP 状态：这条线路对**任何**请求都会失败，不是某次请求的问题。
 *
 * - 402 余额不足（token plan 耗尽，按量额度恢复前整条 key 都打不通）
 * - 404 / 410 模型或路径不存在 / 已退役（z-ai/glm-5.2 → 410 是 2026-09 实测案例）
 * - 405 方法不允许（代理路径配错）
 * - 413 payload 超限（该端点的上下文窗口装不下这个请求）
 *
 * 与 400 的区别：400 是**请求级**的 —— 不同模型对 temperature / json_mode 的容忍
 * 不同，换一条线路可能就对了；上述这些换谁都不行，所以 bench 本线路、继续轮换。
 * 与 401/403 的区别：认证错误另有 fail-fast 语义（见 `failFastOnAuth`）。
 */
export const ROUTE_LEVEL_4XX: ReadonlySet<number> = new Set([402, 404, 405, 410, 413]);

/** 一条线路的累计失败账：`rateLimitHits` 是其中**明确收到 429** 的那部分。 */
export interface LineStats {
  failures: number;
  rateLimitHits: number;
  /**
   * 连续失败轮次（成功一次清零）。冷却到期后再次失败会**继续累积** ——
   * 这正是升级语义：到期又撞说明线路还坏着，下次 bench 更久。
   */
  streak: number;
}

export interface LineHealth {
  /** `provider#index`，与冷却表/速度画像同一个键。 */
  key: string;
  cooling: boolean;
  /** 冷却剩余毫秒；不在冷却时为 0（不是"剩余多少"的哨兵值）。 */
  remainingMs: number;
  failures: number;
  rateLimitHits: number;
  /** 连续失败轮次（成功清零）；冷却升级依据，UI 可据此展示"连续坏 N 轮"。 */
  consecutiveFailures: number;
}

/**
 * 冷却表 + 失败账 → 每条线路的健康事实。
 *
 * 判定（在不在冷却里、还剩多久）收在这里而不是散在各处：UI 与协议事件共用同一份
 * 口径，"冷却中"这件事只在 `until > now` 时成立 —— 到期的条目**必须**回到
 * 可服务状态，否则一条线路会被永久判死。
 */
export function lineHealthOf(
  keys: readonly string[],
  cooldowns: ReadonlyMap<string, number>,
  stats: ReadonlyMap<string, LineStats>,
  now: number,
): LineHealth[] {
  return [...new Set(keys)].map((key) => {
    const until = cooldowns.get(key);
    const cooling = until !== undefined && until > now;
    const s = stats.get(key);
    return {
      key,
      cooling,
      remainingMs: cooling ? until - now : 0,
      failures: s?.failures ?? 0,
      rateLimitHits: s?.rateLimitHits ?? 0,
      consecutiveFailures: s?.streak ?? 0,
    };
  });
}

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

/** 线路级永久错误（402/404/405/410/413）：见 `ROUTE_LEVEL_4XX`。 */
function isRouteLevel(e: unknown): boolean {
  // 所有调用点都在 isTransient(e) 为 false 之后，而非 HttpLlmError 一律
  // transient（兜底 true），因此这里短路掉的 instanceof 分支不可达 ——
  // 独立 `return false` 会成为变异审计的假存活位点，并入布尔式消灭。
  return e instanceof HttpLlmError && ROUTE_LEVEL_4XX.has(e.status);
}

/**
 * 冷却消息：首轮失败报普通冷却，连续失败（streak ≥ 2）时如实说出升级事实 ——
 * 否则用户只看到"冷却 30s"反复出现，看不出这条线路已经被判成持续坏。
 */
function escalatedDigest(
  stats: ReadonlyMap<string, LineStats>,
  comboKey: string,
  cd: number,
): string {
  const streak = stats.get(comboKey)?.streak ?? 0;
  const secs = Math.round(cd / 1000);
  if (streak >= 2) return `连续失败 ${streak} 轮，冷却升级至 ${secs}s`;
  return `冷却 ${secs}s`;
}

/**
 * Tries clients group by group (one group per API key); any transient failure
 * (429, 5xx, timeouts, malformed bodies) rotates to the next combo; auth
 * failures (401/403) fail fast since retrying another combo cannot help.
 *
 * Cooldowns: a transient failure puts its combo on the bench (30s default, or
 * the 429 Retry-After value capped at 5min) so later chat() calls skip it
 * instead of re-hitting a known-bad route. A combo that keeps failing after its
 * cooldown expires escalates: each consecutive failure round doubles the bench
 * time (capped at 10min) — a route that is still broken keeps getting hit every
 * 30s otherwise. One success resets the streak. Route-level permanent errors
 * (402/404/405/410/413 — out of balance, retired model, misconfigured path)
 * bench their route too, without waiting; genuine request-level errors (400)
 * do not bench anything since another model may accept the request.
 * Backoff between combos grows exponentially (500ms * 2^failIndex, capped) and
 * never goes below a Retry-After hint. When every combo is cooling, chat()
 * throws AllRoutesCoolingError immediately instead of sleeping.
 */
export class FailoverLlmClient implements LlmClient {
  private cooldowns = new Map<string, number>();
  /** 线路失败账：只有**真的收到 429** 才计 `rateLimitHits`（5xx/超时只算 failures）。 */
  private stats = new Map<string, LineStats>();
  /**
   * 线路速度画像（2026-09-27 --real 演习实测驱动）：旧实现按构造顺序静态
   * 轮换，慢线路排前时每次先被试、一次吃满 attempt 预算（glm-5.2 529s vs
   * 快线路 74.6s），快线路轮不到。现在每次调用把不在冷却的线路按
   * 「成功耗时画像」动态排序：已知快的先试、无历史保持原顺序（排后，利用
   * 优先）、失败从不记速度（失败走冷却惩罚）。EWMA α=0.5 平滑单次抖动。
   */
  private speeds = new Map<string, number>();
  private readonly speedEwmaAlpha = 0.5;
  private readonly cooldownMs: number;
  private readonly maxBackoffMs: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (text: string) => void;
  private readonly onHealth?: (lines: LineHealth[]) => void;
  private readonly failFastOnAuth: boolean;
  /** 池里每条线路的键（`label#index`），构造时一次算好 —— 健康表要覆盖全部线路。 */
  private readonly keys: string[];

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
    this.onHealth = opts?.onHealth;
    this.failFastOnAuth = opts?.failFastOnAuth ?? true;
    this.keys = groups.flatMap((g) => g.clients.map((_, ci) => `${g.label}#${ci}`));
    // 推一份初始表：宿主不必等到第一次失败才知道池里有什么。
    this.onHealth?.(this.health());
  }

  /** 当前每条线路的健康事实（冷却剩余 + 失败账）。池里**全部**线路都在表里 ——
   *  没失败过的线路也要出现，否则界面上看不出"池子一共几条、现在还剩几条能用"。 */
  health(): LineHealth[] {
    return lineHealthOf(this.keys, this.cooldowns, this.stats, this.now());
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
    // 速度画像排序：已知快的先试，无历史排后（全无历史时稳定排序＝原顺序）。
    attempts.sort(
      (x, y) =>
        (this.speeds.get(x.comboKey) ?? Number.POSITIVE_INFINITY) -
        (this.speeds.get(y.comboKey) ?? Number.POSITIVE_INFINITY),
    );
    let lastErr: unknown = new Error("failover client has no groups");
    for (let k = 0; k < attempts.length; k++) {
      const { client, comboKey } = attempts[k];
      const t0 = this.now();
      try {
        const res = await client.chat(req);
        // 成功且此前在冷却 ⇒ 健康状态变了（那条线路回到可服务），推一份。
        if (this.cooldowns.delete(comboKey)) this.onHealth?.(this.health());
        // 成功一次即清零连续失败账（冷却升级回档）；账目变了同样推一份。
        const s = this.stats.get(comboKey);
        if (s !== undefined && s.streak > 0) {
          s.streak = 0;
          this.stats.set(comboKey, s);
          this.onHealth?.(this.health());
        }
        // 成功才记速度（失败走冷却惩罚，不污染画像）；EWMA 平滑单次抖动。
        const dur = this.now() - t0;
        const prev = this.speeds.get(comboKey);
        this.speeds.set(
          comboKey,
          prev === undefined ? dur : this.speedEwmaAlpha * dur + (1 - this.speedEwmaAlpha) * prev,
        );
        return res;
      } catch (e) {
        if (req.signal?.aborted) {
          /*
           * 调用方取消（run 被中止 / 撞到时限）**不是线路的错**：轮询到下一条
           * 等于"用户已叫停，我们换个 Key 把同一份 prompt 再发一次"，而把该线路
           * 拉进冷却池会因为一次取消惩罚后面所有 run。所以原样抛出、不冷却。
           */
          this.onEvent?.(`${comboKey} 已被调用方取消，停止轮询（不计入冷却）`);
          throw e;
        }
        const status = e instanceof HttpLlmError ? e.status : undefined;
        const nonRetryable = status === 401 || status === 403;
        if (nonRetryable && this.failFastOnAuth) {
          this.onEvent?.(`${comboKey} 认证失败（${status}），终止`);
          throw e;
        }
        lastErr = e;
        if (nonRetryable) {
          // Multi-provider pool: bench this route only, keep the healthy ones.
          this.recordFailure(comboKey, status);
          const cd = this.setCooldown(comboKey, e);
          this.onEvent?.(`${comboKey} 认证失败（${status}），仅冷却该线路 ${Math.round(cd / 1000)}s`);
          // Waiting cannot fix a bad credential — skip the backoff and move on.
          // Without this, a pool whose first provider is misconfigured spends
          // one backoff window per route (12 routes ≈ 80s) before reaching a
          // provider that works.
          continue;
        }
        if (isTransient(e)) {
          this.recordFailure(comboKey, status);
          const cd = this.setCooldown(comboKey, e);
          this.onEvent?.(
            `${comboKey} 失败（${errorDigest(e)}），${escalatedDigest(this.stats, comboKey, cd)}`,
          );
        } else if (isRouteLevel(e)) {
          // 402/404/410 等：这条线路对任何请求都会失败（余额耗尽、模型退役、
          // 路径配错）。不 bench 的话每次调用都会重新撞一遍慢请求才轮到健康
          // 线路 —— bench 掉它，本轮继续换下一条。
          this.recordFailure(comboKey, status);
          const cd = this.setCooldown(comboKey, e);
          this.onEvent?.(
            `${comboKey} 线路级失败（${status}），${escalatedDigest(this.stats, comboKey, cd)}`,
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

  /** 记一次失败并推健康快照；只有真的收到 429 才计入限流那一格。 */
  private recordFailure(comboKey: string, status?: number): void {
    const s = this.stats.get(comboKey) ?? { failures: 0, rateLimitHits: 0, streak: 0 };
    s.failures += 1;
    s.streak += 1;
    if (status === 429) s.rateLimitHits += 1;
    this.stats.set(comboKey, s);
    this.onHealth?.(this.health());
  }

  private setCooldown(comboKey: string, e: unknown): number {
    const retryAfterMs = e instanceof HttpLlmError ? e.retryAfterMs : undefined;
    let cd: number;
    if (retryAfterMs !== undefined) {
      // 服务端说了等多久就等多久（封顶），升级公式不覆盖它 —— 429 的
      // Retry-After 是权威的，但连续 429 时它通常恒定，升级无意义。
      cd = Math.min(retryAfterMs, RETRY_AFTER_COOLDOWN_CAP_MS);
    } else {
      // 无 Retry-After：按连续失败轮次指数升级（streak 已在 recordFailure 里 +1）。
      const streak = this.stats.get(comboKey)?.streak ?? 1;
      cd = Math.min(this.cooldownMs * 2 ** (streak - 1), COOLDOWN_ESCALATION_CAP_MS);
    }
    this.cooldowns.set(comboKey, this.now() + cd);
    return cd;
  }
}

function errorDigest(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const base = msg.replace(/\s+/g, " ").slice(0, 120);
  // 服务端请求 id 进摘要：报障时一句话定位，不用在时间戳里猜。
  const rid = e instanceof HttpLlmError ? e.requestId : undefined;
  return rid ? `${base} [req=${rid}]` : base;
}

export interface FailoverClientOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onEvent?: (text: string) => void;
  /** 线路健康的结构化出口（P1-2）；见 `FailoverOptions.onHealth`。 */
  onHealth?: (lines: LineHealth[]) => void;
}

/** Generic failover factory: one group per key env var, models rotated within each group. */
export function createFailoverClient(
  provider: string | ProviderConfig,
  keyVars: readonly string[],
  models: readonly string[],
  opts: FailoverClientOptions = {},
): LlmClient {
  // `opts.env` 显式转给解析点：省略时 `getProvider` 的默认参数才回落到 process.env。
  // 不传就是"调用方注入的 env 在这一跳被丢掉"—— 覆盖变量在池外路径上静默失灵。
  const base = typeof provider === "string" ? getProvider(provider, opts.env) : provider;
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
  return new FailoverLlmClient(groups, undefined, { onEvent: opts.onEvent, onHealth: opts.onHealth });
}

// `createSensenovaFailoverClient(env)` was removed here. It differed from
// `createFailoverClient("sensenova", SENSENOVA_KEY_VARS, SENSENOVA_MODELS, ...)`
// only by defaulting the env, so it could not serve either production caller —
// `shared/build-llm.ts` passes `{ env, timeoutMs, onEvent }` and
// `electron/agents/sensenova-api.ts` passes `{ timeoutMs, onEvent }`. It was a
// second way to say the same thing, with a narrower signature than both.

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
    // 同 `createFailoverClient`：池路径也必须吃调用方的 env，否则
    // `buildLlmPool({ env })` 会声明一套 env、却在端点这一跳偷偷读 process.env。
    const base = getProvider(route.providerId, env);
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
    onHealth: opts.onHealth,
    failFastOnAuth: opts.failFastOnAuth ?? providerCount <= 1,
  });
}

/**
 * Number of routes a pool spec would produce, given which key env vars are set.
 *
 * Used by the pool-expansion tests to assert the pool geometry without
 * constructing real clients. (The comment here used to claim the UI needed it;
 * no renderer code has ever called it — corrected rather than left to mislead.)
 */
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
