import type { TaskPayload } from "../../shared/types";
import { BaseCliAdapter, type CliAgentDefinition } from "./base";

export class GeminiCliAdapter extends BaseCliAdapter {
  readonly meta = { id: "gemini-cli", name: "Gemini CLI", kind: "cli" as const };

  constructor() {
    super({
      meta: { id: "gemini-cli", name: "Gemini CLI", kind: "cli" },
      commandFor(payload: TaskPayload) {
        return { cmd: "gemini", args: ["-p", payload.description] };
      },
    });
  }

  protected baseCommand(): string {
    return "gemini";
  }
}
