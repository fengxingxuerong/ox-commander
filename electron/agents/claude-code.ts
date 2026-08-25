import type { TaskPayload } from "../../shared/types";
import { BaseCliAdapter, type CliAgentDefinition } from "./base";

function claudeDefinition(): CliAgentDefinition {
  return {
    meta: { id: "claude-code", name: "Claude Code", kind: "cli" },
    commandFor(payload: TaskPayload) {
      const prompt = [
        payload.description,
        `You may only create or modify files inside the zone: ${payload.zone}.`,
      ].join("\n");
      return {
        cmd: "claude",
        args: ["-p", prompt, "--output-format", "json"],
      };
    },
  };
}

export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly meta = { id: "claude-code", name: "Claude Code", kind: "cli" as const };

  constructor() {
    super(claudeDefinition());
  }

  protected baseCommand(): string {
    return "claude";
  }
}
