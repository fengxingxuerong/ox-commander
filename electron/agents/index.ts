import type { AgentAdapter } from "../../shared/types";
import { ClaudeCodeAdapter } from "./claude-code";
import { CodexAdapter } from "./codex";
import { GeminiCliAdapter } from "./gemini-cli";
import { TraeCliAdapter } from "./trae-cli";
import { UiSlotAdapter } from "./ui-slot";

export function createDefaultAdapters(): AgentAdapter[] {
  return [
    new TraeCliAdapter(),
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new GeminiCliAdapter(),
    new UiSlotAdapter("workbuddy", "WorkBuddy"),
  ];
}

export function findAdapter(adapters: AgentAdapter[], agentId: string): AgentAdapter | undefined {
  return adapters.find((a) => a.meta.id === agentId);
}
