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
