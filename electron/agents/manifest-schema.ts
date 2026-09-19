import {
  type AgentAction,
  type AgentCapabilities,
  type AgentCredential,
  type AgentEntry,
  type AgentLimits,
  type AgentManifest,
  type AgentRole,
  type ArtifactKind,
} from "../../shared/agent-contract";

/** Thrown with the full issue list so the UI can show every problem at once. */
export class ManifestValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`manifest 校验失败：${issues.join("；")}`);
    this.name = "ManifestValidationError";
  }
}

const ROLES = new Set<string>([
  "frontend-dev",
  "backend-dev",
  "fullstack-dev",
  "test-writer",
  "docs-writer",
  "*",
]);
const ACTIONS = new Set<string>(["read", "edit", "create", "delete", "run-command", "run-test", "review"]);
const ARTIFACTS = new Set<string>(["files", "diff", "logs", "report"]);
const ADAPTERS = new Set<string>(["local-llm", "cli", "http-bridge"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, issues: string[], prefix: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    issues.push(`${prefix}${key} 必须是非空字符串`);
    return undefined;
  }
  return v;
}

function num(o: Record<string, unknown>, key: string, issues: string[], prefix: string, min: number): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    issues.push(`${prefix}${key} 必须是不小于 ${min} 的数字`);
    return undefined;
  }
  return v;
}

function bool(o: Record<string, unknown>, key: string, issues: string[], prefix: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    issues.push(`${prefix}${key} 必须是布尔值`);
    return undefined;
  }
  return v;
}

function stringArray(
  o: Record<string, unknown>,
  key: string,
  issues: string[],
  prefix: string,
  allowed?: Set<string>,
  required = false,
): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) issues.push(`${prefix}${key} 不能为空`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    issues.push(`${prefix}${key} 必须是字符串数组`);
    return undefined;
  }
  const list = v as string[];
  if (required && list.length === 0) issues.push(`${prefix}${key} 不能为空`);
  if (allowed) {
    for (const item of list) {
      if (!allowed.has(item)) issues.push(`${prefix}${key} 含有未知值 "${item}"`);
    }
  }
  return list;
}

function parseCapabilities(raw: unknown, issues: string[]): AgentCapabilities | undefined {
  if (!isObj(raw)) {
    issues.push("capabilities 必须是对象");
    return undefined;
  }
  const p = "capabilities.";
  const roles = (stringArray(raw, "roles", issues, p, ROLES, true) ?? []) as AgentRole[];
  const zoneGlobs = stringArray(raw, "zoneGlobs", issues, p, undefined, true) ?? [];
  const supports = (stringArray(raw, "supports", issues, p, ACTIONS, true) ?? []) as AgentAction[];
  const artifactKinds = (stringArray(raw, "artifactKinds", issues, p, ARTIFACTS) ?? []) as ArtifactKind[];
  const maxConcurrency = num(raw, "maxConcurrency", issues, p, 1);
  const selfIsolated = bool(raw, "selfIsolated", issues, p);
  const protocolVersion = str(raw, "protocolVersion", issues, p);
  if (issues.length > 0) return undefined;
  return {
    ...(protocolVersion ? { protocolVersion } : {}),
    roles,
    zoneGlobs,
    supports,
    artifactKinds: artifactKinds.length > 0 ? artifactKinds : ["files", "logs"],
    maxConcurrency: Math.max(1, Math.floor(maxConcurrency ?? 1)),
    selfIsolated: selfIsolated ?? false,
  };
}

function parseCredential(raw: unknown, issues: string[]): AgentCredential | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    issues.push("credential 必须是对象");
    return undefined;
  }
  const kind = raw.kind;
  switch (kind) {
    case "env": {
      const envVar = str(raw, "envVar", issues, "credential.");
      return envVar ? { kind: "env", envVar } : undefined;
    }
    case "bearerFile": {
      const tokenFile = str(raw, "tokenFile", issues, "credential.");
      return tokenFile ? { kind: "bearerFile", tokenFile } : undefined;
    }
    case "execToken": {
      const command = str(raw, "command", issues, "credential.");
      const args = stringArray(raw, "args", issues, "credential.") ?? [];
      const cacheTtlMs = num(raw, "cacheTtlMs", issues, "credential.", 0);
      return command
        ? { kind: "execToken", command, args, ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}) }
        : undefined;
    }
    case "none":
      return { kind: "none" };
    default:
      issues.push(`credential.kind 未知：${String(kind)}`);
      return undefined;
  }
}

function parseEntry(raw: unknown, adapter: string, issues: string[]): AgentEntry | undefined {
  if (adapter === "local-llm") {
    if (raw !== undefined && isObj(raw) && raw.kind !== "builtin") {
      issues.push('adapter 为 local-llm 时 entry.kind 必须是 "builtin"');
      return undefined;
    }
    const provider = isObj(raw) ? str(raw, "provider", issues, "entry.") : undefined;
    return { kind: "builtin", provider: provider ?? "sensenova" };
  }
  if (!isObj(raw)) {
    issues.push(`adapter 为 ${adapter} 时必须提供 entry`);
    return undefined;
  }
  if (adapter === "cli") {
    if (raw.kind !== "cli") {
      issues.push('entry.kind 必须是 "cli"');
      return undefined;
    }
    const command = str(raw, "command", issues, "entry.");
    const argsTemplate = stringArray(raw, "argsTemplate", issues, "entry.", undefined, true) ?? [];
    const probeArgs = stringArray(raw, "probeArgs", issues, "entry.");
    const envTemplateRaw = raw.envTemplate;
    let envTemplate: Record<string, string> | undefined;
    if (envTemplateRaw !== undefined) {
      if (!isObj(envTemplateRaw) || Object.values(envTemplateRaw).some((v) => typeof v !== "string")) {
        issues.push("entry.envTemplate 必须是 string→string 对象");
      } else {
        envTemplate = envTemplateRaw as Record<string, string>;
      }
    }
    return command
      ? {
          kind: "cli",
          command,
          argsTemplate,
          ...(probeArgs ? { probeArgs } : {}),
          ...(envTemplate ? { envTemplate } : {}),
        }
      : undefined;
  }
  // http-bridge
  if (raw.kind !== "http") {
    issues.push('entry.kind 必须是 "http"');
    return undefined;
  }
  const baseUrl = str(raw, "baseUrl", issues, "entry.");
  const healthPath = str(raw, "healthPath", issues, "entry.");
  const runsPath = str(raw, "runsPath", issues, "entry.");
  const pollMs = num(raw, "pollMs", issues, "entry.", 50);
  const headers = isObj(raw.headers) ? (raw.headers as Record<string, string>) : undefined;
  return baseUrl
    ? {
        kind: "http",
        baseUrl,
        ...(healthPath ? { healthPath } : {}),
        ...(runsPath ? { runsPath } : {}),
        ...(pollMs !== undefined ? { pollMs } : {}),
        ...(headers ? { headers } : {}),
      }
    : undefined;
}

function parseLimits(raw: unknown, issues: string[]): Partial<AgentLimits> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) {
    issues.push("limits 必须是对象");
    return undefined;
  }
  const runDeadlineMs = num(raw, "runDeadlineMs", issues, "limits.", 1000);
  const idleTimeoutMs = num(raw, "idleTimeoutMs", issues, "limits.", 1000);
  const maxStdoutBytes = num(raw, "maxStdoutBytes", issues, "limits.", 1024);
  return {
    ...(runDeadlineMs !== undefined ? { runDeadlineMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxStdoutBytes !== undefined ? { maxStdoutBytes } : {}),
  };
}

/** Validates one raw JSON value into an AgentManifest; throws with every issue found. */
export function parseAgentManifest(raw: unknown, source: AgentManifest["source"] = "declared"): AgentManifest {
  const issues: string[] = [];
  if (!isObj(raw)) throw new ManifestValidationError(["manifest 必须是对象"]);
  const id = str(raw, "id", issues, "");
  if (id && !ID_RE.test(id)) issues.push(`id "${id}" 只能包含字母数字与 . _ -`);
  const displayName = str(raw, "displayName", issues, "") ?? id ?? "";
  const adapter = str(raw, "adapter", issues, "");
  if (adapter && !ADAPTERS.has(adapter)) {
    issues.push(`adapter "${adapter}" 未知（可用：${[...ADAPTERS].join(" / ")}）`);
  }
  const capabilities = parseCapabilities(raw.capabilities, issues);
  const credential = parseCredential(raw.credential, issues);
  const limits = parseLimits(raw.limits, issues);
  const entry = adapter && ADAPTERS.has(adapter) ? parseEntry(raw.entry, adapter, issues) : undefined;
  const priority = num(raw, "priority", issues, "", Number.NEGATIVE_INFINITY);
  const enabled = bool(raw, "enabled", issues, "");

  if (issues.length > 0) throw new ManifestValidationError(issues);
  return {
    id: id!,
    displayName,
    adapter: adapter as AgentManifest["adapter"],
    ...(entry ? { entry } : {}),
    capabilities: capabilities!,
    ...(credential ? { credential } : {}),
    ...(limits ? { limits } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    source,
  };
}

/**
 * Accepts a single manifest object or an array (a `agents.d/*.json` file may
 * declare several agents). Throws on the first invalid entry, with its index.
 */
export function parseAgentManifestList(raw: unknown, source: AgentManifest["source"] = "agents.d"): AgentManifest[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new ManifestValidationError(["manifest 列表为空"]);
  return list.map((entry, i) => {
    try {
      return parseAgentManifest(entry, source);
    } catch (e) {
      if (e instanceof ManifestValidationError) {
        throw new ManifestValidationError(e.issues.map((m) => `[${i}] ${m}`));
      }
      throw e;
    }
  });
}

/** Convenience for the UI: a JSON snippet that validates against the contract. */
export function exampleManifest(): AgentManifest {
  return {
    id: "codex-cli",
    displayName: "Codex CLI",
    adapter: "cli",
    entry: {
      kind: "cli",
      command: "codex",
      argsTemplate: ["exec", "--cd", "{{projectRoot}}", "--prompt-file", "{{promptPath}}"],
    },
    capabilities: {
      roles: ["backend-dev", "fullstack-dev", "test-writer"],
      zoneGlobs: ["src/**", "tests/**"],
      supports: ["read", "edit", "create", "run-test"],
      artifactKinds: ["files", "logs"],
      maxConcurrency: 2,
      selfIsolated: true,
    },
    credential: { kind: "none" },
    limits: { runDeadlineMs: 900_000, idleTimeoutMs: 120_000 },
    priority: 10,
    enabled: true,
    source: "declared",
  };
}
