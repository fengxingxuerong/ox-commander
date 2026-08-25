import type { ProviderConfig } from "./providers";
import type { ChatMessage } from "./providers";
import type { ChatRequest, ChatResponse, LlmClient } from "./llm-client";

interface FetchLike {
  (url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
}

export class HttpLlmError extends Error {
  constructor(public status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpLlmError";
  }
}

abstract class BaseHttpLlmClient implements LlmClient {
  constructor(
    protected config: ProviderConfig,
    protected apiKey: string,
    protected fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  abstract chat(req: ChatRequest): Promise<ChatResponse>;

  protected async postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HttpLlmError(res.status, await res.text());
    return (await res.json()) as Record<string, unknown>;
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
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? "";
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
      max_tokens: 4096,
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

export function createLlmClient(config: ProviderConfig, apiKey: string): LlmClient {
  if (config.protocol === "anthropic") return new AnthropicClient(config, apiKey);
  return new OpenAiCompatibleClient(config, apiKey);
}
