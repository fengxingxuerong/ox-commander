export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  /**
   * Caller-side cancellation (run aborted / run deadline tripped).
   *
   * It lives on the *request*, not the client: one client instance is shared by
   * every run of a provider pool, while the thing being cancelled is a single
   * run. Aborting it must also stop the failover pool from rotating — see
   * `FailoverLlmClient.chat`.
   */
  signal?: AbortSignal;
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
     * 2026-09-20 重新核对 `GET /models`：端点已扩容到 **7 个**模型 ——
     * `DeepSeek-V4.1-Flash` · `DeepSeek-V4-Flash` · `GLM-5.3-Flash` ·
     * `MinerU2.5-Pro`（输出模态 ocr，不能用于 chat）· `MiniCPM5-2B` ·
     * `Qwen3.8-27B` · `Qwen3.8-Flash-Next`。
     *
     * 旧注释断言这里"exactly two models"且 `DeepSeek-V4-Flash` 会被拒（400）——
     * 该结论已失效：实测 `DeepSeek-V4-Flash` 与 `MiniCPM5-2B` 都返回 200。
     * 改取 `DeepSeek-V4-Flash` 作兜底：同样是兜底，2B 小模型在商汤全池冷却时
     * 会把大脑质量拉出断崖。
     *
     * 端点由 `self-dploy` 动态调度，worker 有波动（同日实测 `DeepSeek-V4.1-Flash`
     * 返 503 `no_available_workers`）。兜底线路本就只在商汤全部冷却时才轮到，
     * 单次失败会落进同一张冷却表继续轮换，不会卡住整条链路。
     */
    defaultModel: "DeepSeek-V4-Flash",
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
  {
    id: "nvidia",
    displayName: "NVIDIA (integrate.api.nvidia.com)",
    protocol: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "z-ai/glm-5.3-flash",
    apiKeyEnvVar: "NVIDIA_API_KEY",
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
 * NVIDIA（z-ai/glm-5.3-flash）deliberately NOT in DEFAULT_LLM_POOL（2026-09-22 实测）：
 * 单次调用 280s 完全无响应（HTTP 000 连接挂死），入池会让故障转移在它身上
 * 空烧整段超时预算。端点恢复可靠后（连续探针 <240s 有完整正文）再移入
 * DEFAULT_LLM_POOL 末位 —— 届时它是全网关最深的兜底线路。
 *
 * OpenRouter 同样排除：账号被平台锁推理（403），非密钥问题。
 */

/**
 * Default cross-provider pool, in preference order.
 *
 * Every route of every listed provider ends up in one failover table, which is
 * what makes "multiple APIs working at once" true: a SenseNova 429 rotates
 * among its 12 routes, and if the whole account is throttled the AMD endpoint
 * answers instead — without any change to the caller.
 *
 * Order matters: SenseNova leads with 12 routes; AMD catches. AMD's default is
 * `DeepSeek-V4-Flash` (since 2026-09-20, was the 2B `MiniCPM5-2B`), so the
 * safety net no longer drops brain quality off a cliff when it takes over.
 *
 * A provider whose key is absent is simply skipped at construction time.
 */
export const DEFAULT_LLM_POOL = ["sensenova", "amd-radeon"] as const;

/** Env vars a provider may use for a request, beyond its primary `apiKeyEnvVar`. */
export function providerKeyEnvVars(providerId: string): string[] {
  return providerId === "sensenova" ? [...SENSENOVA_KEY_VARS] : [];
}
