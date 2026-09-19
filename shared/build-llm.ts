import { getProvider, providerKeyEnvVars, SENSENOVA_KEY_VARS, SENSENOVA_MODELS, DEFAULT_LLM_POOL } from "./providers";
import { BRAIN_TIMEOUT_MS, createFailoverClient, createLlmClient, createMultiProviderFailover, type PoolRoute } from "./http-clients";
import type { LlmClient } from "./llm-client";

export interface BuildLlmOptions {
  /** Key resolution env; defaults to process.env (callers may pre-seed it from their key store). */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout; defaults to BRAIN_TIMEOUT_MS (brain-layer calls). */
  timeoutMs?: number;
  /** Failover decision sink (rotation failures, cooldown skips); wired to the caller's log stream. */
  onEvent?: (text: string) => void;
}

/**
 * Brain-layer LLM factory shared by the Electron (ipc.ts) and headless
 * (headless-main.ts) entries so the two can never drift apart: sensenova gets
 * the 3-key × 3-model failover client, every other provider a plain client.
 */
export function buildLlmClient(providerId: string, opts: BuildLlmOptions = {}): LlmClient {
  const env = opts.env ?? process.env;
  const provider = getProvider(providerId);
  const timeoutMs = opts.timeoutMs ?? BRAIN_TIMEOUT_MS;
  if (provider.id === "sensenova") {
    return createFailoverClient(provider, SENSENOVA_KEY_VARS, SENSENOVA_MODELS, {
      env,
      timeoutMs,
      onEvent: opts.onEvent,
    });
  }
  const apiKey = provider.apiKeyEnvVar ? (env[provider.apiKeyEnvVar] ?? "") : "";
  return createLlmClient(provider, apiKey, timeoutMs);
}

export interface BuildPoolOptions extends BuildLlmOptions {
  /** Provider ids in preference order; defaults to `DEFAULT_LLM_POOL`. */
  providers?: readonly string[];
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
  const providers = opts.providers && opts.providers.length > 0 ? opts.providers : DEFAULT_LLM_POOL;
  const routes: PoolRoute[] = providers.map((id) => {
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
  return createMultiProviderFailover(routes, {
    env,
    timeoutMs: opts.timeoutMs ?? BRAIN_TIMEOUT_MS,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}
