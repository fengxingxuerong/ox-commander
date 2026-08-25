import type { ChatRequest, ChatResponse } from "./providers";

export type { ChatRequest, ChatResponse };

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface JsonCallOptions<T> {
  schemaName: string;
  validate: (raw: unknown) => T;
  maxRetries?: number;
}

export class JsonParseError extends Error {
  constructor(public readonly attempt: number, public readonly lastRaw: string, message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  try {
    return JSON.parse(withoutFences);
  } catch {
    const candidates = [withoutFences.indexOf("{"), withoutFences.indexOf("[")].filter(
      (i) => i >= 0,
    );
    if (candidates.length === 0) throw new Error("no JSON found in model output");
    const first = Math.min(...candidates);
    return JSON.parse(withoutFences.slice(first));
  }
}

/** Calls the LLM and validates its output against a schema; retries with the validation error fed back into the conversation. */
export async function chatJson<T>(
  client: LlmClient,
  request: ChatRequest,
  options: JsonCallOptions<T>,
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  let lastRaw = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const messages = [...request.messages];
    if (attempt > 0) {
      messages.push({
        role: "user",
        content: `Your previous output failed ${options.schemaName} validation: ${lastRaw.slice(0, 500)}. Respond again with ONLY valid JSON.`,
      });
    }
    const res = await client.chat({ ...request, messages, jsonMode: true });
    lastRaw = res.content;
    let parsed: unknown;
    try {
      parsed = extractJson(res.content);
    } catch (e) {
      if (attempt === maxRetries) {
        throw new JsonParseError(attempt, lastRaw, `invalid JSON: ${(e as Error).message}`);
      }
      continue;
    }
    try {
      return options.validate(parsed);
    } catch (e) {
      if (attempt === maxRetries) {
        throw new JsonParseError(attempt, lastRaw, (e as Error).message);
      }
    }
  }
  throw new JsonParseError(maxRetries, lastRaw, "unreachable");
}
