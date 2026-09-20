import type { PrdDocument, SmokeCheck, Task } from "./types";

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
        if (!title || !command) return;
        smoke.push({
          title,
          command,
          args,
          ...(stdin !== undefined ? { stdin } : {}),
          expectContains,
        });
      });
    }
  }
  if (issues.length) throw new SchemaValidationError(issues);
  return { tasks, smoke };
}
