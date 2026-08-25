import type { TaskPayload } from "../../shared/types";
import { BaseCliAdapter, type CliAgentDefinition } from "./base";

/**
 * TraeCode CLI adapter. The exact argv contract may differ across versions;
 * adjust here only — the engine is agnostic.
 */
export class TraeCliAdapter extends BaseCliAdapter {
  readonly meta = { id: "trae-cli", name: "TraeCode CLI", kind: "cli" as const };

  constructor() {
    super({
      meta: { id: "trae-cli", name: "TraeCode CLI", kind: "cli" },
      commandFor(payload: TaskPayload) {
        return { cmd: "trae", args: ["run", "--prompt", payload.description, "--auto"] };
      },
    });
  }

  protected baseCommand(): string {
    return "trae";
  }
}
