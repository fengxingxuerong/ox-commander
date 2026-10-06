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

/**
 * `argsTemplate` / `envTemplate` 里允许出现的占位符 —— **白名单**，不是黑名单。
 *
 * 为什么必须是白名单（2026-10-05 实测，勿删本段）：
 * 这套占位符渲染出的 argv 在 Windows 上会经过 `cmd.exe /d /s /c`
 * （`spawn-plan.ts`：`.cmd`/`.bat` shim 必须那样才能被 Node 执行），而 cmd 会
 * **重新解析整行**。实测 `quoteForCmd` 的 `\"` 转义挡不住注入：参数
 * `say"hi&whoami` 里的 `&whoami` 真的执行了。
 *
 * 于是 argv 的安全**不能**来自"把危险字符转义掉"，只能来自
 * "**每个插进去的值都不是自由文本**"。本白名单就是这条保证的执行点。
 *
 * 表里这五个值**全都是生成物**，逐条有据：
 *   · projectRoot — `workspaceRoot(projectId)` = `userData/workspaces/<id>`，
 *     projectId 由 store 铸造，不是用户输入
 *   · promptPath  — `cli-agent.writePrompt()` 生成的临时文件
 *   · taskId / runId / zone — 引擎分配；zone 另经 `shared/schema.ts` 的
 *     `VALID_ZONE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/` 白名单，不含元字符
 *
 * **绝不要**把 LLM 产出的自由文本（`task.title` / `task.description` /
 * PRD 片段 / 模型回显）加进来。加一个 `{{taskTitle}}` 就是静默开一条注入路径：
 * `renderTemplate` 对未知键是 `vars[key] ?? whole`，既不报错也不留痕。
 * 真要传正文，用 `{{promptPath}}` —— 任务书本来就该走文件，不该挤进 argv。
 */
const ALLOWED_PLACEHOLDERS = new Set<string>([
  "projectRoot",
  "promptPath",
  "taskId",
  "runId",
  "zone",
]);

/** 取出模板里出现的所有 `{{name}}`。 */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

/** 模板里是否有不在白名单内的占位符；返回按出现顺序去重后的名字。 */
export function unknownPlaceholders(template: string): string[] {
  return [...new Set(templatePlaceholders(template).filter((n) => !ALLOWED_PLACEHOLDERS.has(n)))];
}

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
    // 2026-09-28：条件展开简化为直接传（同族，理由见 manifest-loader.ts）。
    // 这里输出的是**声明解析结果**：消费方 `normalizeCapabilities` 与各适配器构造
    // 都是读值（`caps.protocolVersion ?? LEGACY`），键存在但值为 undefined 等价于缺键。
    protocolVersion,
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
    // 占位符白名单：渲染后的 argv 会进 cmd.exe，所以"插进去的值不是自由文本"
    // 必须在这里成立。见 ALLOWED_PLACEHOLDERS 的注释（⚠️ 别改成黑名单）。
    for (const [field, template] of [
      ...argsTemplate.map((t) => ["entry.argsTemplate", t] as const),
      ...(probeArgs ?? []).map((t) => ["entry.probeArgs", t] as const),
      ...Object.entries(envTemplate ?? {}).map(([k, v]) => [`entry.envTemplate.${k}`, v] as const),
    ]) {
      const unknown = unknownPlaceholders(template);
      if (unknown.length > 0) {
        issues.push(
          `${field} 含未知占位符：${unknown.map((n) => `{{${n}}}`).join("、")}` +
            `（允许的：${[...ALLOWED_PLACEHOLDERS].map((n) => `{{${n}}}`).join("、")}）`,
        );
      }
    }
    return command
      ? {
          kind: "cli",
          command,
          argsTemplate,
          probeArgs,
          envTemplate,
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
        healthPath,
        runsPath,
        ...(pollMs !== undefined ? { pollMs } : {}),
        headers,
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
    entry,
    capabilities: capabilities!,
    credential,
    limits,
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

/**
 * Convenience for the UI: a JSON snippet that validates against the contract.
 *
 * `argsTemplate` 必须是**目标 CLI 真实存在的参数**。本模板原先写的是
 * `["exec","--cd","{{projectRoot}}","--prompt-file","{{promptPath}}"]`，
 * 但 `codex exec` 根本没有 `--prompt-file`（2026-09-20 用 `codex exec --help`
 * 实测核对：位置参数 PROMPT 或 stdin，二者之外无文件入口）。照着复制的用户
 * 会收到未知参数错误，且因为 probe 只跑 `--version`，健康检查还是绿的 ——
 * 属于「配好了但永远跑不起来」的静默陷阱。
 *
 * 现在用的参数都在 `codex exec --help` 里实测存在：`--cd` / `--skip-git-repo-check`
 * / `--dangerously-bypass-approvals-and-sandbox`；任务正文仍走 prompt 文件，
 * 由位置参数指向它（cli-agent 的 stdin 是 ignore，所以不能走 stdin）。
 */
export function exampleManifest(): AgentManifest {
  return {
    id: "codex-cli",
    displayName: "Codex CLI",
    adapter: "cli",
    entry: {
      kind: "cli",
      command: "codex",
      argsTemplate: [
        "exec",
        "--cd",
        "{{projectRoot}}",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "严格按文件 {{promptPath}} 中的任务书执行（先读该文件）。",
      ],
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
