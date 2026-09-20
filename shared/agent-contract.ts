/**
 * Multi-agent access contract (protocol `ox-agent/2`).
 *
 * Additive by design: `AgentAdapter` (shared/types.ts) stays untouched and a
 * v1 adapter is a valid v2 adapter — `capabilities()`/`credential`/`limits` are
 * optional, and anything missing is normalized by the AgentRegistry into an
 * inferred "legacy" capability set that reproduces v1 behaviour exactly.
 *
 * Dependency-free (no node, no DOM): this module is compiled by both the
 * renderer and the electron tsconfig projects.
 */
import type { AgentAdapter, AgentEvent, RunHandle, TaskPayload } from "./types";

export const AGENT_PROTOCOL_VERSION = "ox-agent/2";

export type AgentRole =
  | "frontend-dev"
  | "backend-dev"
  | "fullstack-dev"
  | "test-writer"
  | "docs-writer"
  | "*";

export type AgentAction = "read" | "edit" | "create" | "delete" | "run-command" | "run-test" | "review";

export type ArtifactKind = "files" | "diff" | "logs" | "report";

/** What an agent can do, where it may do it, and how much of it can run at once. */
export interface AgentCapabilities {
  /** Protocol the agent speaks; absent ⇒ v1 legacy. */
  protocolVersion?: string;
  /** `"*"` means any role. */
  roles: AgentRole[];
  /** Posix globs relative to the project root. `["**"]` means unrestricted. */
  zoneGlobs: string[];
  supports: AgentAction[];
  artifactKinds: ArtifactKind[];
  maxConcurrency: number;
  /** True when the agent already isolates its own work (container/subprocess policy). */
  selfIsolated: boolean;
}

/** How an agent authenticates. Resolved in the main process only — never shipped over IPC. */
export type AgentCredential =
  | { kind: "env"; envVar: string }
  | { kind: "bearerFile"; tokenFile: string }
  | { kind: "execToken"; command: string; args: string[]; cacheTtlMs?: number }
  | { kind: "none" };

export interface AgentLimits {
  /** Hard ceiling for one run. */
  runDeadlineMs: number;
  /** No-event ceiling for one run. */
  idleTimeoutMs: number;
  /** Output budget per run. */
  maxStdoutBytes: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  runDeadlineMs: 600_000,
  idleTimeoutMs: 120_000,
  maxStdoutBytes: 2_097_152,
};

/**
 * How to reach the agent. `cli` spawns a subprocess without a shell; `http`
 * talks to a bridge service; `builtin` refers to an adapter compiled in.
 */
export type AgentEntry =
  | {
      kind: "cli";
      command: string;
      /** Placeholders: {{projectRoot}} {{promptPath}} {{taskId}} {{runId}} {{zone}}. */
      argsTemplate: string[];
      /** Args used by `probe()`; defaults to `["--version"]`. */
      probeArgs?: string[];
      /** Extra env vars, values may contain the same placeholders. */
      envTemplate?: Record<string, string>;
    }
  | {
      kind: "http";
      baseUrl: string;
      /** Defaults to `/health`. */
      healthPath?: string;
      /** Defaults to `/v1/runs`. */
      runsPath?: string;
      /** Poll interval used to drain the event stream; defaults to 500ms. */
      pollMs?: number;
      headers?: Record<string, string>;
    }
  | { kind: "builtin"; provider: string };

/** What the host declares about an agent. */
export interface AgentManifest {
  id: string;
  displayName: string;
  adapter: "local-llm" | "cli" | "http-bridge";
  entry?: AgentEntry;
  capabilities: AgentCapabilities;
  credential?: AgentCredential;
  limits?: Partial<AgentLimits>;
  /** Higher wins ties between equally-scored candidates. */
  priority?: number;
  enabled?: boolean;
  /** Where this manifest came from, for the UI. Set by the loader. */
  source?: "builtin" | "declared" | "agents.d";
}

/** A normalized registry entry: manifest + live adapter + resolved capability defaults. */
export interface AgentDescriptor {
  manifest: AgentManifest;
  capabilities: Required<AgentCapabilities>;
  limits: AgentLimits;
  adapter: AgentAdapterV2;
  /** True when capabilities were inferred (v1 adapter) — routing must keep legacy semantics. */
  inferredLegacy: boolean;
  enabled: boolean;
  priority: number;
}

export interface FileChange {
  path: string;
  op: "create" | "modify" | "delete";
  bytes?: number;
  producer?: string;
}

export interface AgentRunResult {
  runId: string;
  agentId: string;
  taskId: string;
  status: "completed" | "failed" | "aborted";
  changes: FileChange[];
  errorClass?: "auth" | "timeout" | "protocol" | "resource" | "conflict" | "unknown";
  retryable?: boolean;
  logDigest: string;
  durationMs: number;
}

/** Downstream contract: a strict superset of TaskPayload so v1 adapters keep working. */
export interface TaskRequest extends TaskPayload {
  protocolVersion?: string;
  /** Actions the task needs; defaults to `["edit"]`. Filters candidates. */
  requiredTags?: AgentAction[];
  /** Roots this run may write (relative to projectRoot); defaults to `[task.zone]`. */
  writableRoots?: string[];
  /** Zone-external paths explicitly delegated by the owner. */
  delegatedWrite?: string[];
  forbiddenWrite?: string[];
  allowedCommands?: string[];
  deadlineMs?: number;
  attempt?: number;
  previousAttempt?: { agentId: string; filesChanged: string[]; errorDigest: string };
}

export type AgentEventKindV2 = AgentEvent["kind"] | "artifact" | "heartbeat";

/**
 * v2 event: widens `kind` with `"artifact"` / `"heartbeat"`. Widening means it
 * cannot `extend` AgentEvent directly, hence the `Omit` on `kind` only.
 */
export interface AgentEventV2 extends Omit<AgentEvent, "kind"> {
  kind: AgentEventKindV2;
  changes?: FileChange[];
  usage?: { tokens?: number; costMs?: number };
}

/** v2 adapter = v1 interface + optional extensions. */
export interface AgentAdapterV2 extends AgentAdapter {
  readonly credential?: AgentCredential;
  readonly limits?: Partial<AgentLimits>;
  capabilities?(): AgentCapabilities;
  /** Graceful shutdown: wait for in-flight runs, then force. */
  drain?(graceMs: number): Promise<"drained" | "timeout">;
  /** Structured result when available; otherwise the host derives it from its file journal. */
  lastResult?(handle: RunHandle): Promise<AgentRunResult | undefined>;
}

export const LEGACY_CAPABILITIES: Required<AgentCapabilities> = {
  protocolVersion: AGENT_PROTOCOL_VERSION,
  roles: ["*"],
  zoneGlobs: ["**"],
  supports: ["read", "edit", "create", "delete", "run-command", "run-test", "review"],
  artifactKinds: ["files", "logs"],
  maxConcurrency: 1,
  selfIsolated: true,
};

/** Fills every gap in a declared capability set; safe to call with `undefined`. */
export function normalizeCapabilities(
  caps: AgentCapabilities | undefined,
): Required<AgentCapabilities> {
  if (!caps) return { ...LEGACY_CAPABILITIES };
  return {
    protocolVersion: caps.protocolVersion ?? LEGACY_CAPABILITIES.protocolVersion,
    roles: caps.roles.length > 0 ? [...caps.roles] : [...LEGACY_CAPABILITIES.roles],
    zoneGlobs: caps.zoneGlobs.length > 0 ? [...caps.zoneGlobs] : [...LEGACY_CAPABILITIES.zoneGlobs],
    supports: caps.supports.length > 0 ? [...caps.supports] : [...LEGACY_CAPABILITIES.supports],
    artifactKinds:
      caps.artifactKinds.length > 0 ? [...caps.artifactKinds] : [...LEGACY_CAPABILITIES.artifactKinds],
    maxConcurrency: Math.max(1, Math.floor(caps.maxConcurrency || 1)),
    selfIsolated: caps.selfIsolated ?? false,
  };
}
