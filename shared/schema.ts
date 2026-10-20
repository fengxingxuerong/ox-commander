import type {
  ProjectSettings,
  PrdDocument,
  SmokeCheck,
  Task,
  VerificationKind,
} from "./types";
import { ARBITRATION_MODES, ESCALATION_POLICY_SETTINGS, isArbitrationMode, isEscalationPolicySetting } from "./types";
import { isLoopbackHttpUrl } from "./page-smoke";
import { APPROVAL_POLICIES, SANDBOX_MODES, isApprovalPolicy, isSandboxMode } from "./tools/policy";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class SchemaValidationError extends Error {
  constructor(public issues: string[]) {
    super(`schema validation failed: ${issues.join("; ")}`);
    this.name = "SchemaValidationError";
  }
}

function isObject(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, JsonValue>, key: string, issues: string[]): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    issues.push(`${key} must be a non-empty string`);
    return "";
  }
  return v;
}

function requireStringArray(
  obj: Record<string, JsonValue>,
  key: string,
  issues: string[],
): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    issues.push(`${key} must be an array of strings`);
    return [];
  }
  return v as string[];
}

export function parsePrd(raw: unknown): PrdDocument {
  if (!isObject(raw as JsonValue)) throw new SchemaValidationError(["root must be an object"]);
  const obj = raw as Record<string, JsonValue>;
  const issues: string[] = [];
  const goal = requireString(obj, "goal", issues);
  const features = requireStringArray(obj, "features", issues);
  const techStack = requireStringArray(obj, "techStack", issues);
  const acceptanceCriteria = requireStringArray(obj, "acceptanceCriteria", issues);
  if (issues.length) throw new SchemaValidationError(issues);
  return { goal, features, techStack, acceptanceCriteria };
}

const VALID_ROLES = new Set([
  "frontend-dev",
  "backend-dev",
  "fullstack-dev",
  "test-writer",
  "docs-writer",
]);

interface RawTaskLike {
  id: string;
  title: string;
  description: string;
  zone: string;
  dependencies: string[];
  suggestedRole: string;
}

/**
 * Characters a zone may contain. A zone is a project-relative *directory*, so
 * the set is deliberately narrow: letters, digits, and `_ - . /`.
 *
 * Why validate at all, given the sandbox is fail-closed on a malformed zone?
 * Because "fail-closed" here means *every* write is rejected, so the task can
 * never succeed — it burns the whole repair budget and reports "zone 越权"
 * for a plan that was broken from the start. Rejecting the plan at parse time
 * costs one decompose call and names the real problem.
 *
 * The security argument is secondary but real: `zone` is interpolated into the
 * Markdown task prompt, where a newline could inject a fake `## 要求` section.
 * Whitelisting removes that channel rather than escaping it.
 */
const VALID_ZONE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** A zone deeper than this is almost certainly a model mistake, not a plan. */
const MAX_ZONE_LENGTH = 200;

function parseTask(raw: Record<string, JsonValue>, index: number, issues: string[]): RawTaskLike {
  const prefix = `tasks[${index}]`;
  const id = requireString(raw, "id", issues);
  const title = requireString(raw, "title", issues);
  const description = requireString(raw, "description", issues);
  let zone = requireString(raw, "zone", issues);
  if (zone.includes("..")) {
    issues.push(`${prefix}.zone must not contain path traversal`);
    zone = "";
  } else if (zone !== "" && !VALID_ZONE.test(zone)) {
    // Rejects newlines, spaces, quotes, backslashes and absolute paths. Note the
    // sandbox stays restrictive either way — the point is to fail *here*, with
    // the real reason, instead of locking the task out of every write later.
    issues.push(
      `${prefix}.zone "${zone.slice(0, 80)}" must be a project-relative directory of letters, digits, "_", "-", "." and "/"`,
    );
    zone = "";
  } else if (zone.length > MAX_ZONE_LENGTH) {
    issues.push(`${prefix}.zone must be at most ${MAX_ZONE_LENGTH} characters`);
    zone = "";
  }
  const deps = requireStringArray(raw, "dependencies", issues);
  const role = requireString(raw, "suggestedRole", issues);
  if (!VALID_ROLES.has(role)) {
    issues.push(`${prefix}.suggestedRole "${role}" is not a known role`);
  }
  return { id, title, description, zone, dependencies: deps, suggestedRole: role };
}

export function parseTaskList(raw: unknown): Task[] {
  // Models sometimes emit a bare task array instead of {"tasks": [...]}.
  const obj: Record<string, JsonValue> = Array.isArray(raw) ? { tasks: raw } : (raw as Record<string, JsonValue>);
  if (!isObject(obj as JsonValue)) throw new SchemaValidationError(["root must be an object or array"]);
  const issues: string[] = [];
  const rawTasks = obj.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new SchemaValidationError(["tasks must be a non-empty array"]);
  }
  const tasks = rawTasks.map((t, i) => {
    if (!isObject(t)) {
      issues.push(`tasks[${i}] must be an object`);
      return {
        id: "",
        title: "",
        description: "",
        zone: "",
        dependencies: [] as string[],
        suggestedRole: "",
      };
    }
    return parseTask(t, i, issues);
  });
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!ids.has(dep)) {
        issues.push(`task "${t.id}" depends on unknown task "${dep}"`);
      }
    }
  }
  if (issues.length) throw new SchemaValidationError(issues);
  return tasks.map((t) => ({ ...t, dependencies: [...new Set(t.dependencies)] }));
}

/**
 * 分解产物 = 任务清单 + 可选的独立样本冒烟清单（防自证盲区层）。
 * smoke 缺省或为空数组都合法（无可运行入口的交付物）。
 */
export interface DecomposePlan {
  tasks: Task[];
  smoke: SmokeCheck[];
}

const MAX_SMOKE_CHECKS = 5;

export function parseDecompose(raw: unknown): DecomposePlan {
  const tasks = parseTaskList(raw);
  const obj: Record<string, JsonValue> = Array.isArray(raw) ? { tasks: raw } : (raw as Record<string, JsonValue>);
  const issues: string[] = [];
  const smoke: SmokeCheck[] = [];
  const rawSmoke = obj.smoke;
  if (rawSmoke !== undefined) {
    if (!Array.isArray(rawSmoke)) {
      issues.push("smoke must be an array");
    } else if (rawSmoke.length > MAX_SMOKE_CHECKS) {
      issues.push(`smoke must have at most ${MAX_SMOKE_CHECKS} entries`);
    } else {
      rawSmoke.forEach((s, i) => {
        if (!isObject(s)) {
          issues.push(`smoke[${i}] must be an object`);
          return;
        }
        const title = requireString(s, "title", issues);
        const command = requireString(s, "command", issues);
        const args = requireStringArray(s, "args", issues);
        const stdin = typeof s.stdin === "string" ? s.stdin : undefined;
        const expectContains =
          s.expectContains === undefined ? [] : requireStringArray(s, "expectContains", issues);
        let devServer: SmokeCheck["devServer"];
        if (s.devServer !== undefined) {
          if (!isObject(s.devServer)) {
            issues.push(`smoke[${i}].devServer must be an object`);
          } else {
            const url = requireString(s.devServer, "url", issues);
            if (url !== "" && !isLoopbackHttpUrl(url)) {
              issues.push(
                `smoke[${i}].devServer.url must be a loopback http(s) URL (127.0.0.1 / localhost / ::1)`,
              );
            }
            const timeoutMs = s.devServer.timeoutMs;
            if (
              timeoutMs !== undefined &&
              (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
            ) {
              issues.push(`smoke[${i}].devServer.timeoutMs must be a positive number`);
            }
            if (url !== "") {
              devServer = typeof timeoutMs === "number" ? { url, timeoutMs } : { url };
            }
          }
          if (stdin !== undefined || expectContains.length > 0) {
            issues.push(`smoke[${i}]: devServer is mutually exclusive with stdin/expectContains`);
          }
        }
        // （2026-10-13）此处原本有 `if (!title || !command) return;` —— 冗余分支：
        // requireString 在缺字段时**已经**把 issue 推进同一个数组，函数末尾必然
        // 抛错，"跳过 push 与否"不可观察。冗余分支在逐位点审计里长出等价变异
        // （`||`→`&&` 存活），按"首次遇到优先重构消除"的纪律删掉。
        smoke.push({
          title,
          command,
          args,
          ...(stdin !== undefined ? { stdin } : {}),
          expectContains,
          ...(devServer !== undefined ? { devServer } : {}),
        });
      });
    }
  }
  if (issues.length) throw new SchemaValidationError(issues);
  return { tasks, smoke };
}

// ---- ProjectSettings 的入参校验（IPC settings:save，2026-10-13）-----------------
//
// 背景：渲染层来的 settings 此前 `as ProjectSettings` 后直接落盘 —— 控制面零校验，
// 畸形类型会一路带进引擎（switch + default 静默吞掉）。本函数只做**形状校验**：
//
// · **认识的字段必须是合法形状**（类型 + 轻量值域 + 枚举）；
// · **缺席 ≠ 非法**：可选字段缺席就是缺席，绝不补默认值 —— 补默认值会把"部分保存"
//   变成"用默认值覆盖"（`SettingsStore.load` 本来就会把缺席字段并上默认值）；
// · **未知键原样放行**（刻意不建白名单）：手写白名单与 `ProjectSettings` 之间没有
//   自动同步，漏登记一个字段的后果是**保存时静默丢字段** —— 比"多了个引擎不认识
//   的键"严重得多（后者只是没人读它）。这条取舍与 headless 协议的"未知顶层字段
//   仅警告不报错"同向：宁可放过一个无害键，不冒丢数据的风险。

const VERIFICATION_KINDS: Record<VerificationKind, true> = {
  build: true,
  typecheck: true,
  test: true,
  smoke: true,
};

const CONTEXT_SOURCE_KINDS: Record<"issues" | "pr" | "pr-comments", true> = {
  issues: true,
  pr: true,
  "pr-comments": true,
};

const DELIVERY_REMOTE_MODES: Record<"off" | "push" | "pr", true> = {
  off: true,
  push: true,
  pr: true,
};

function finiteNumber(o: Record<string, unknown>, key: string, issues: string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isFinite(v)) issues.push(`${key} must be a finite number`);
}

/** 非负整数（maxRepairRounds / maxParallelRuns 这类"次数"语义的字段）。 */
function nonNegativeInt(o: Record<string, unknown>, key: string, issues: string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    issues.push(`${key} must be an integer >= 0`);
  }
}

function stringOpt(o: Record<string, unknown>, key: string, issues: string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== "string") issues.push(`${key} must be a string`);
}

function boolOpt(o: Record<string, unknown>, key: string, issues: string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (typeof v !== "boolean") issues.push(`${key} must be a boolean`);
}

function stringArrayOpt(o: Record<string, unknown>, key: string, issues: string[]): void {
  const v = o[key];
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    issues.push(`${key} must be an array of strings`);
  }
}

function enumOpt<V>(
  o: Record<string, unknown>,
  key: string,
  is: (v: unknown) => v is V,
  label: string,
  issues: string[],
): void {
  const v = o[key];
  if (v === undefined) return;
  if (!is(v)) issues.push(`${key} must be one of: ${label}`);
}

export function parseSettings(raw: unknown): ProjectSettings {
  if (!isObject(raw as JsonValue)) throw new SchemaValidationError(["root must be an object"]);
  const o = raw as unknown as Record<string, unknown>;
  const issues: string[] = [];

  nonNegativeInt(o, "maxRepairRounds", issues);
  nonNegativeInt(o, "maxParallelRuns", issues);
  nonNegativeInt(o, "raceRedundancy", issues);
  nonNegativeInt(o, "variantCount", issues);
  finiteNumber(o, "maxTokensPerRun", issues);
  finiteNumber(o, "runWallClockMs", issues);
  finiteNumber(o, "brainTimeoutMs", issues);
  finiteNumber(o, "executorTimeoutMs", issues);

  stringOpt(o, "llmProvider", issues);
  stringOpt(o, "snapshotRoot", issues);
  stringOpt(o, "manifestDir", issues);
  boolOpt(o, "agentRouter", issues);
  boolOpt(o, "exportDeliveryBranch", issues);
  stringArrayOpt(o, "enabledAgents", issues);
  stringArrayOpt(o, "llmPool", issues);
  stringArrayOpt(o, "disabledKeyVars", issues);
  enumOpt(o, "arbitration", isArbitrationMode, Object.keys(ARBITRATION_MODES).join("/"), issues);
  enumOpt(o, "sandboxMode", isSandboxMode, Object.keys(SANDBOX_MODES).join("/"), issues);
  enumOpt(o, "approvalPolicy", isApprovalPolicy, Object.keys(APPROVAL_POLICIES).join("/"), issues);
  stringArrayOpt(o, "approvalCommands", issues);
  enumOpt(
    o,
    "escalationPolicy",
    isEscalationPolicySetting,
    Object.keys(ESCALATION_POLICY_SETTINGS).join("/"),
    issues,
  );

  const cmds = o["verificationCommands"];
  if (cmds !== undefined) {
    if (!Array.isArray(cmds)) {
      issues.push("verificationCommands must be an array");
    } else {
      for (const c of cmds) {
        const e = c as Record<string, unknown> | null;
        if (!e || typeof e !== "object") {
          issues.push("verificationCommands entries must be objects");
          continue;
        }
        if (typeof e["kind"] !== "string" || !(e["kind"] in VERIFICATION_KINDS)) {
          issues.push(`verificationCommands[].kind must be one of: ${Object.keys(VERIFICATION_KINDS).join("/")}`);
        }
        if (typeof e["command"] !== "string" || (e["command"] as string).trim() === "") {
          issues.push("verificationCommands[].command must be a non-empty string");
        }
        if (!Array.isArray(e["args"]) || (e["args"] as unknown[]).some((x) => typeof x !== "string")) {
          issues.push("verificationCommands[].args must be an array of strings");
        }
      }
    }
  }

  const sources = o["contextSources"];
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      issues.push("contextSources must be an array");
    } else {
      for (const s of sources) {
        const e = s as Record<string, unknown> | null;
        if (!e || typeof e !== "object") {
          issues.push("contextSources entries must be objects");
          continue;
        }
        if (typeof e["kind"] !== "string" || !(e["kind"] in CONTEXT_SOURCE_KINDS)) {
          issues.push(`contextSources[].kind must be one of: ${Object.keys(CONTEXT_SOURCE_KINDS).join("/")}`);
        }
        stringOpt(e, "name", issues);
        stringOpt(e, "repo", issues);
        stringOpt(e, "search", issues);
        finiteNumber(e, "limit", issues);
        finiteNumber(e, "pr", issues);
        finiteNumber(e, "maxChars", issues);
      }
    }
  }

  const remote = o["deliveryRemote"];
  if (remote !== undefined) {
    const r = remote as Record<string, unknown> | null;
    if (!r || typeof r !== "object") {
      issues.push("deliveryRemote must be an object");
    } else {
      if (typeof r["mode"] !== "string" || !(r["mode"] in DELIVERY_REMOTE_MODES)) {
        issues.push(`deliveryRemote.mode must be one of: ${Object.keys(DELIVERY_REMOTE_MODES).join("/")}`);
      }
      stringOpt(r, "remote", issues);
      stringOpt(r, "base", issues);
      boolOpt(r, "draft", issues);
      finiteNumber(r, "timeoutMs", issues);
      const ac = r["awaitChecks"];
      if (ac !== undefined) {
        const a = ac as Record<string, unknown> | null;
        if (!a || typeof a !== "object") {
          issues.push("deliveryRemote.awaitChecks must be an object");
        } else {
          finiteNumber(a, "intervalMs", issues);
          finiteNumber(a, "maxPolls", issues);
        }
      }
    }
  }

  if (issues.length) throw new SchemaValidationError(issues);
  return raw as ProjectSettings;
}
