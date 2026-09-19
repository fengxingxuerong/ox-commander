export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
}

export interface ChatResponse {
  content: string;
  provider: string;
  model: string;
  usageTokens?: number;
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  protocol: "openai-compatible" | "anthropic";
  baseUrl: string;
  defaultModel: string;
  apiKeyEnvVar: string;
}

/** All providers below speak OpenAI-compatible /chat/completions except Anthropic. API keys come from env vars (never hardcoded). */
export const PROVIDER_CATALOG: ProviderConfig[] = [
  {
    id: "sensenova",
    displayName: "商汤 SenseNova",
    protocol: "openai-compatible",
    baseUrl: "https://token.sensenova.cn/v1",
    defaultModel: "deepseek-v4-flash",
    apiKeyEnvVar: "SENSENOVA_API_KEY",
  },
  {
    id: "amd-radeon",
    displayName: "AMD Radeon (developer.amd.com.cn)",
    protocol: "openai-compatible",
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
    /*
     * Model name verified against `GET /models` on the live endpoint: it serves
     * exactly two models — `MinerU2.5-Pro` (output modality `ocr`) and
     * `MiniCPM5-2B` (text, 128k context). `DeepSeek-V4-Flash` is *not* served
     * here (400 "not supported") even though it is a valid SenseNova model.
     *
     * MiniCPM5-2B is small, so this provider is a **fallback**, not a
     * first-choice brain: it sits second in DEFAULT_LLM_POOL and only answers
     * when every SenseNova route is cooling.
     */
    defaultModel: "MiniCPM5-2B",
    apiKeyEnvVar: "AMD_API_KEY",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  {
    id: "glm",
    displayName: "智谱 GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    apiKeyEnvVar: "GLM_API_KEY",
  },
  {
    id: "qwen",
    displayName: "通义千问",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-max",
    apiKeyEnvVar: "DASHSCOPE_API_KEY",
  },
  {
    id: "kimi",
    displayName: "Kimi (Moonshot)",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
  },
  {
    id: "openai",
    displayName: "OpenAI GPT",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "ollama",
    displayName: "Ollama (本地)",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:14b",
    apiKeyEnvVar: "",
  },
  {
    id: "anthropic",
    displayName: "Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
];

export function getProvider(id: string): ProviderConfig {
  const p = PROVIDER_CATALOG.find((x) => x.id === id);
  if (!p) throw new Error(`unknown llm provider: ${id}`);
  return p;
}

/**
 * SenseNova failover pool: one API key per group, models rotated within the
 * group on 429. 3 keys × 4 models = **12 routes**, all sharing one cooldown
 * table, so a rate-limited key rotates to another model before another key is
 * tried and vice versa.
 *
 * (`kimi-k3` is also offered by this endpoint; it is deliberately not in the
 * default rotation — 12 routes is the sweet spot before a single cooldown pass
 * costs more latency than it buys in availability. Add it to `LLM_POOL_EXTRA`
 * when a larger sweep is wanted.)
 */
export const SENSENOVA_MODELS = [
  "deepseek-v4-flash",
  "sensenova-6.8-flash-lite",
  "deepseek-v4-pro",
  "glm-5.2",
] as const;
export const SENSENOVA_KEY_VARS = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3"] as const;

/** Requested but not rotated by default (see above). */
export const SENSENOVA_MODELS_EXTRA = ["kimi-k3"] as const;

/**
 * Default cross-provider pool, in preference order.
 *
 * Every route of every listed provider ends up in one failover table, which is
 * what makes "multiple APIs working at once" true: a SenseNova 429 rotates
 * among its 12 routes, and if the whole account is throttled the AMD endpoint
 * answers instead — without any change to the caller.
 *
 * Order matters: AMD's `MiniCPM5-2B` is a 2B model, fine as a safety net and a
 * poor first choice. SenseNova leads; AMD catches.
 *
 * A provider whose key is absent is simply skipped at construction time.
 */
export const DEFAULT_LLM_POOL = ["sensenova", "amd-radeon"] as const;

/** Env vars a provider may use for a request, beyond its primary `apiKeyEnvVar`. */
export function providerKeyEnvVars(providerId: string): string[] {
  return providerId === "sensenova" ? [...SENSENOVA_KEY_VARS] : [];
}
