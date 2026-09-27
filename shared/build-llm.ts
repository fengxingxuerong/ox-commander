import { getProvider, providerKeyEnvVars, SENSENOVA_KEY_VARS, SENSENOVA_MODELS, DEFAULT_LLM_POOL } from "./providers";
import { BRAIN_TIMEOUT_MS, createFailoverClient, createLlmClient, createMultiProviderFailover, type PoolRoute } from "./http-clients";
import type { LlmClient } from "./llm-client";
import { meteredLlm, type UsageMeter } from "./usage-meter";

export interface BuildLlmOptions {
  /** Key resolution env; defaults to process.env (callers may pre-seed it from their key store). */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout; defaults to BRAIN_TIMEOUT_MS (brain-layer calls). */
  timeoutMs?: number;
  /** Failover decision sink (rotation failures, cooldown skips); wired to the caller's log stream. */
  onEvent?: (text: string) => void;
  /**
   * Token 用量汇总器。工厂是**唯一**的构造点（Electron 与 headless 共用），
   * 所以在这里包一层就能覆盖两个宿主的大脑层调用 —— 而不是在调用点各记一次。
   */
  meter?: UsageMeter;
}

/** `meter` 是可选的，包一层只是"多一个观察者"，不改变任何行为。 */
function withMeter(client: LlmClient, meter: UsageMeter | undefined): LlmClient {
  return meter ? meteredLlm(client, meter) : client;
}

/**
 * Brain-layer LLM factory shared by the Electron (ipc.ts) and headless
 * (headless-main.ts) entries so the two can never drift apart: sensenova gets
 * the multi-key × multi-model failover client, every other provider a plain client.
 */
export function buildLlmClient(providerId: string, opts: BuildLlmOptions = {}): LlmClient {
  const env = opts.env ?? process.env;
  const provider = getProvider(providerId);
  const timeoutMs = opts.timeoutMs ?? BRAIN_TIMEOUT_MS;
  if (provider.id === "sensenova") {
    return withMeter(
      createFailoverClient(provider, SENSENOVA_KEY_VARS, SENSENOVA_MODELS, {
        env,
        timeoutMs,
        onEvent: opts.onEvent,
      }),
      opts.meter,
    );
  }
  // 2026-09-28：这里原本是 `provider.apiKeyEnvVar ? (env[...] ?? "") : ""`。
  // 三元是**冗余**的 —— `apiKeyEnvVar` 为空串时（ollama 这类无需密钥的端点），
  // `env[""]` 取不到任何东西，`?? ""` 同样落到空串。留着它只会多一个变异位点，
  // 而那个位点交换分支后是「有 envVar 却用空串」，语义变化真实但**无从构造输入
  // 去区分**（空串 envVar 在两条分支上结果一致）。判定简化掉，行为不变。
  const apiKey = env[provider.apiKeyEnvVar] ?? "";
  return withMeter(createLlmClient(provider, apiKey, timeoutMs), opts.meter);
}

export interface BuildPoolOptions extends BuildLlmOptions {
  /** Provider ids in preference order; defaults to `DEFAULT_LLM_POOL`. */
  providers?: readonly string[];
}

/**
 * 线路组装（纯）：provider 列表 → 池里的每一条 (provider × key × model) 线路。
 *
 * **为什么从 `buildLlmPool` 里提出来**：这一段决定「哪个 provider 带几个 key、
 * 几个模型进池」，而它此前只活在 client 构造内部 —— 判错方向**不抛异常**，只表现为
 * 线路池悄悄少几条线 / 带错模型（sensenova 3×4=12 条退化成 3×1=3 条，或者反过来把
 * SenseNova 的模型名发给 AMD 的端点）。真出 429 之前没人看得见，到时候只会以为
 * 「今天线路不稳」。提出来之后，「池里到底有什么」第一次可以被断言。
 */
export function buildPoolRoutes(opts: BuildPoolOptions = {}): PoolRoute[] {
  const providers = opts.providers && opts.providers.length > 0 ? opts.providers : DEFAULT_LLM_POOL;
  return providers.map((id) => {
    const provider = getProvider(id);
    const extraKeys = providerKeyEnvVars(id);
    const keyVars =
      extraKeys.length > 0 ? extraKeys : provider.apiKeyEnvVar ? [provider.apiKeyEnvVar] : [""];
    return {
      providerId: id,
      keyVars,
      models: id === "sensenova" ? SENSENOVA_MODELS : [provider.defaultModel],
    };
  });
}

/**
 * Cross-provider pool: every (provider × key × model) becomes one route in a
 * single failover table. SenseNova contributes 3 keys × 4 models = 12 routes,
 * AMD one more, and a 429 anywhere benches only that route.
 *
 * Providers without a key are dropped at construction; if that leaves nothing,
 * the caller gets a client whose every call fails loudly with a clear reason
 * ("failover client has no groups") rather than a silent no-op.
 */
export function buildLlmPool(opts: BuildPoolOptions = {}): LlmClient {
  const env = opts.env ?? process.env;
  const routes = buildPoolRoutes(opts);
  return withMeter(
    createMultiProviderFailover(routes, {
      env,
      timeoutMs: opts.timeoutMs ?? BRAIN_TIMEOUT_MS,
      // 2026-09-28：原本是 `...(opts.onEvent ? { onEvent: opts.onEvent } : {})`。
      // 条件展开同样是冗余的 —— `onEvent` 本身可选，直接传 undefined 与"不传这
      // 个键"在接收侧完全等价。而那个三元一旦被交换，就是「传了 onEvent 反而
      // 不往下透传」，池的轮换日志会静默消失（没有断言会红）。判定简化掉。
      onEvent: opts.onEvent,
    }),
    opts.meter,
  );
}
