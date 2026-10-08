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

/**
 * 某个 provider 端点的**覆盖变量名**：`OX_LLM_BASE_URL_<ID>`（大写、连字符换下划线）。
 *
 * 为什么端点必须可覆盖：目录里 ollama 的 baseUrl 是写死的
 * `http://localhost:11434/v1`，于是"本地模型"只剩这一个端口能当大脑 ——
 * 跑在别的端口上的 LM Studio / vLLM、公司内网的网关，或者一个用来做离线演示
 * 与回归的假端点，都接不进来。这不是"灵活性"问题，是**本地部署接不进来**。
 */
export function baseUrlEnvVar(providerId: string): string {
  return `OX_LLM_BASE_URL_${providerId.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * 解析 provider 配置。
 *
 * `env` 是**参数**而不是直接读 `process.env` —— 与 `build-llm` / `http-clients`
 * 同一条既有约定：环境由调用方注入，测试才构造得出"端点被改过"的情形。
 *
 * 覆盖放在**唯一**的解析点生效，所以单客户端、跨 provider 池、桌面与 headless
 * 四条构造路径一并受益；散在各处判断必然漏掉其中一条，而漏掉的那条会表现成
 * "覆盖在某些形态下不生效"——最难查的一类。
 *
 * 空串不算覆盖：`baseUrl: ""` 不是端点，是配置错误，让它静默生效只会得到一个
 * 更难定位的连接失败。
 */
export function getProvider(id: string, env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const p = PROVIDER_CATALOG.find((x) => x.id === id);
  if (!p) throw new Error(`unknown llm provider: ${id}`);
  const override = env[baseUrlEnvVar(id)];
  if (override) return { ...p, baseUrl: override };
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
 * costs more latency than it buys in availability. It is registered in
 * `SENSENOVA_MODELS_EXTRA` below.)
 */
export const SENSENOVA_MODELS = [
  "deepseek-v4-flash",
  "sensenova-6.8-flash-lite",
  "deepseek-v4-pro",
  "glm-5.2",
] as const;
export const SENSENOVA_KEY_VARS = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3"] as const;

/**
 * Registered but **not rotated** by default (see above).
 *
 * ⚠️ 它是**登记表，不是开关**：全仓生产代码零消费者 —— 没有任何一处把它并进
 * 轮转表（`build-llm.ts` 的 models 装配只认 `SENSENOVA_MODELS`）。所以它不构成
 * "两份值域同时参与计算"，而是"一份参与、一份只登记"。
 * `check-unwired` 对它有显式豁免（理由同上），测试钉住两件事：它等于 `["kimi-k3"]`、
 * 且不在 `SENSENOVA_MODELS` 里。
 *
 * 要真的启用属于**功能变更**（得给 models 装配开一个入口并配用例），不是改个
 * 常量就能生效 —— 别以为填进这里就等于入了池。
 */
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
