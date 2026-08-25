import type { TaskPayload } from "../../shared/types";
import { BaseCliAdapter, type CliAgentDefinition } from "./base";

export class CodexAdapter extends BaseCliAdapter {
  readonly meta = { id: "codex-cli", name: "Codex CLI", kind: "cli" as const };

  constructor() {
    super({
      meta: { id: "codex-cli", name: "Codex CLI", kind: "cli" },
      commandFor(payload: TaskPayload) {
        return { cmd: "codex", args: ["exec", "--json", payload.description] };
      },
    });
  }

  protected baseCommand(): string {
    return "codex";
  }
}
