import type { ToolCall, ToolSpec } from "./tools/spec";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * 原生 function calling 路径下，**assistant** 消息携带的工具调用。
   *
   * 为什么必须能带：OpenAI 兼容端点要求「assistant 发了 tool_calls，下一轮就必须
   * 有对应的 tool 消息」，缺了直接 400。于是不把工具调用回灌进历史的话，
   * 第二轮调用会在端点侧炸掉 —— 失败发生在平台之外，最难查。
   */
  toolCalls?: ToolCall[];
  /** 原生路径下 **tool** 消息对应的调用 id。 */
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  /**
   * 本轮开放给模型的工具表。`undefined` 或空数组 = 不开放（行为与以前一致）。
   *
   * 平台侧是否真的把它发进请求体，由 `ProviderConfig.tools` 决定：未声明原生
   * 支持的端点走文本协议（工具表进 system 提示），声明了的才透传。这是为了让
   * 「工具能力」不依赖"端点恰好支持" —— 否则默认线路不支持时，这条能力对
   * 默认用户就是不可用的。
   */
  tools?: readonly ToolSpec[];
  /**
   * Caller-side cancellation (run aborted / run deadline tripped).
   *
   * It lives on the *request*, not the client: one client instance is shared by
   * every run of a provider pool, while the thing being cancelled is a single
   * run. Aborting it must also stop the failover pool from rotating — see
   * `FailoverLlmClient.chat`.
   */
  signal?: AbortSignal;
  /**
   * 增量正文回调。给了它 = 想要流式：客户端先按 SSE 发一次请求，边收边把正文
   * 增量交出去（**不累积**，调用方自己拼），并仍然返回完整的 `ChatResponse`。
   *
   * 为什么是"给回调才流"而不是"总是流"：
   *   - 大脑层（PRD/任务分解）要的是**整段 JSON**，流式对它没有价值，多一层
   *     解析只增加故障面；
   *   - 端点是否支持 `stream: true` **没有实测结论**（与 `ProviderConfig.tools`
   *     同一条纪律）。所以客户端先试一次流式，**在还没吐出任何增量之前**失败就
   *     整段退回普通请求（见 `OpenAiCompatibleClient.chat`）—— 能力不依赖
   *     "端点恰好支持"，也不会把不认识的字段硬发给端点后变成一连串 400。
   *
   * ⚠️ 已经吐出的字收不回来：failover 在**有过增量**（committed）之后不换线路
   * 重试 —— 否则同一段话会被说两遍（`FailoverLlmClient.chat`）。
   */
  onDelta?: (delta: string) => void;
}

export interface ChatResponse {
  content: string;
  provider: string;
  model: string;
  usageTokens?: number;
  /**
   * 模型要求调用的工具（原生路径下由端点结构化返回；文本路径下平台从正文里
   * 解析后再填进这里）。两种来源对下游是**同一个结构** —— 这是工具循环只写
   * 一份的理由。
   */
  toolCalls?: ToolCall[];
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  protocol: "openai-compatible" | "anthropic";
  baseUrl: string;
  defaultModel: string;
  apiKeyEnvVar: string;
  /**
   * 端点对**原生** function calling 的支持情况。
   *
   * 缺省即 `text`：未实测过的端点一律不发 `tools` 字段 —— 发一个端点不认识的
   * 字段会把整条线路打成 400，而 400 在本项目的 failover 口径里是**请求级**的
   * （不冷却、只重试），于是故障会表现成"每次调用都慢一点"而不是"工具坏了"。
   *
   * ⚠️ 当前 `native` 名单的依据是**厂商公开协议**（OpenAI / Anthropic /
   * DeepSeek / GLM / Qwen / Kimi / Ollama 均公开支持 function calling），
   * **不是本项目实测**；商汤与 AMD 未见声明，故保持 `text`。要改这一项，
   * 请先用 `scripts/probe-endpoints.cjs` 实测并把结论写进注释 —— 这里是
   * "谁支持什么"的唯一登记点，散在各处判断必然漏掉其中一条。
   */
  tools?: "native" | "text";
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
    tools: "native",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  {
    id: "glm",
    displayName: "智谱 GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    tools: "native",
    apiKeyEnvVar: "GLM_API_KEY",
  },
  {
    id: "qwen",
    displayName: "通义千问",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-max",
    tools: "native",
    apiKeyEnvVar: "DASHSCOPE_API_KEY",
  },
  {
    id: "kimi",
    displayName: "Kimi (Moonshot)",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    tools: "native",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
  },
  {
    id: "openai",
    displayName: "OpenAI GPT",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    tools: "native",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  {
    id: "ollama",
    displayName: "Ollama (本地)",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:14b",
    tools: "native",
    apiKeyEnvVar: "",
  },
  {
    id: "anthropic",
    displayName: "Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    tools: "native",
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
/**
 * 模型名可否作为线程钉死目标（M3c-2）。
 *
 * 这里不是"猜端点支持什么"，而是挡住**不可能**成立的输入：空白、换行、超长串。
 * 真正的可用性仍由端点决定（选了一个 404 的模型，第一轮就会收到错误）。
 * 允许字母数字开头，后续允许 `._:/-` —— 够覆盖 `qwen2.5:14b`、`z-ai/glm-5.3-flash`、
 * `claude-sonnet-4-20250514` 这些已登记形态。
 */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value);
}

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
 * 2026-10-18：`deepseek-v4-pro` 实测已从端点下架（`GET /models` 不再返回、
 * 直连稳定 404 `model is not found`），留一条死线路等于每次轮转白烧一个冷却位；
 * 由跨家族的 `kimi-k3` 顶上（同批 1-token 探针实测 200）。12 条线路数不变。
 */
export const SENSENOVA_MODELS = [
  "deepseek-v4-flash",
  "sensenova-6.8-flash-lite",
  "kimi-k3",
  "glm-5.2",
] as const;
export const SENSENOVA_KEY_VARS = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3"] as const;

/**
 * Registered but **not rotated** by default (see above).
 *
 * ⚠️ 它是**登记表，不是开关**：全仓生产代码零消费者 —— 没有任何一处把它并进
 * 轮转表（`build-llm.ts` 的 models 装配只认 `SENSENOVA_MODELS`）。所以它不构成
 * "两份值域同时参与计算"，而是"一份参与、一份只登记"。
 * `check-unwired` 对它有显式豁免（理由同上），测试钉住两件事：它等于
 * `["deepseek-v4.1-flash"]`、且不在 `SENSENOVA_MODELS` 里。
 *
 * 2026-10-18：`kimi-k3` 已换入轮转表（顶替下架的 `deepseek-v4-pro`），本表转记
 * 下一代候补 `deepseek-v4.1-flash`——端点已在册，但本账号 token plan 暂 403
 * （"model is not available in the current token plan"，探针实测），plan 放开后
 * 即可考虑顶上。注意它顶进轮转的另一半是 `MODEL_TEMPERATURE_OVERRIDES`：
 * `kimi-k3` 只接受 `temperature=1`，其余值直接 400（见下表）。
 *
 * 要真的启用属于**功能变更**（得给 models 装配开一个入口并配用例），不是改个
 * 常量就能生效 —— 别以为填进这里就等于入了池。
 */
export const SENSENOVA_MODELS_EXTRA = ["deepseek-v4.1-flash"] as const;

/**
 * 模型对 `temperature` 的硬性要求（端点实测，非偏好）。
 *
 * `kimi-k3` 只接受 `1`：传 `0.2`（本项目的默认）返回 400
 * `field Temperature invalid, only 1 is allowed for this model`。这个 400 在
 * failover 口径里是**请求级**错误（不冷却、不换线路移除），于是不做覆盖的话，
 * 每次执行器/大脑调用都会在 kimi 的三条键上白烧一个 400 再轮到下一个模型
 * （2026-10-18 B2 对照实验的 stderr 实测；精确探针复现：0.2 → 400，1 → 200）。
 *
 * 覆盖优先于调用方传值：`sensenova-api.ts` 明确传 `temperature: 0.2`，
 * 覆盖表仍须把它改写成 1，否则表形同虚设。知识放在这里而不是客户端内联，
 * 是因为这是**模型目录的属性**：哪些模型带特殊约定，应当和模型名在同一处可读。
 */
export const MODEL_TEMPERATURE_OVERRIDES: Readonly<Record<string, number>> = {
  "kimi-k3": 1,
};

/** 请求温度的唯一解析点：覆盖表命中即用表值，否则用请求值，缺省 0.2。 */
export function resolveTemperature(model: string, requested?: number): number {
  return MODEL_TEMPERATURE_OVERRIDES[model] ?? requested ?? 0.2;
}

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
