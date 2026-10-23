/**
 * 工具（function calling）层的**契约**：名字、参数模式、调用与结果的形状。
 *
 * 为什么工具表要单独成层而不是散在提示词里：Codex 那一类编码智能体的能力面
 * 就是这张表 —— 模型自己决定"先读哪个文件、再改哪一处、要不要跑一次测试"，
 * 平台只负责执行与拦。在此之前本项目内置执行器是**一问一答**：平台塞一份
 * 32k 静态快照、模型一次性吐出全部文件（`{"files":[...]}`），它既不能二次取
 * 文件，也不能自己跑命令 —— 而"读不到就说没这个文件"正是这类形态的典型缺陷
 * （`docs/2026-10-06-real-decomposition-e2e.md` 抓到的那一类）。
 *
 * 本模块只放**纯契约**（类型 + 参数校验），不碰任何 node/DOM API —— `shared/`
 * 的分层红线由 eslint 的 `no-restricted-imports` 强制。真正的执行在宿主层
 * （`electron/chat/tool-runner.ts`），因为读盘与起进程都不是纯逻辑。
 *
 * 工具名刻意用 Codex/Claude Code 那一套的公共子集（`read_file` / `list_dir` /
 * `grep_files` / `find_by_name` / `apply_patch` / `run_command`）：提示词与模型
 * 的既有先验对得上，比自造一套名字少一次翻译。
 */

export const TOOL_NAMES = [
  "read_file",
  "list_dir",
  "grep_files",
  "find_by_name",
  "apply_patch",
  "run_command",
  "read_skill",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** JSON Schema 的最小可用子集（够端点声明参数，也够平台自己校验）。 */
export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array";
  description: string;
  /** `array` 时给出元素类型。 */
  items?: { type: "string" };
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: JsonSchemaObject;
}

export interface ToolCall {
  /** 端点给的工具调用 id（文本协议下由平台自己生成，形如 `t-1`）。 */
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
}

/**
 * 一次 apply_patch 对单个文件的改动，供 diff 审阅与撤销使用。
 *
 * `before` / `after` 是**文件全文**，不是 diff：撤销需要在用户之后不再手动
 * 改过文件的前提下原样写回。超过上限的文件记 `revertable:false`，界面必须
 * 说"这个文件太大，没记录可撤销内容"，而不是给一个点了会出错的按钮。
 */
export interface ChatFileChange {
  /** 项目内相对路径（posix）。 */
  path: string;
  /** 改前全文；新建文件为 null。 */
  before: string | null;
  /** 改后全文；删除文件为 null。 */
  after: string | null;
  /** 这个文件是本次补丁新建的。撤销时只有带这个证据才允许删除。 */
  created: boolean;
  /** 所属**用户回合**序号（第几条 user 消息；不是 LLM 调用次数）。 */
  turn: number;
  /** 是否记录了可撤销内容；false 时 before/after 为 null。 */
  revertable: boolean;
}

export interface ToolResult {
  id: string;
  name: ToolName;
  ok: boolean;
  /** 成功时是工具输出（可能被截断，见 `truncateToolOutput`）。 */
  output: string;
  /** 失败时的理由：要么是被沙箱挡了，要么是工具自己报错。两者必须可区分。 */
  reason?: string;
  /** apply_patch 才有：逐文件改动（用于 diff 与撤销）。 */
  changes?: ChatFileChange[];
  /**
   * 输出被截断时记下原始长度 —— "只给了一部分"必须说破，否则模型会以为
   * 文件就这么大，然后照着残缺内容改文件（`docs/2026-09-19-real-task-e2e.md`
   * 那一类盲区）。
   */
  truncatedFrom?: number;
}

const PROP = {
  path: (description: string): JsonSchemaProperty => ({ type: "string", description }),
} as const;

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "read_file",
    description: "读取项目内的一个文件（相对路径）。返回带行号的正文，超长会截断并说明。",
    parameters: {
      type: "object",
      properties: {
        path: PROP.path("相对于项目根的文件路径"),
        maxLines: { type: "number", description: "最多返回多少行（默认 400）" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "列出项目内某个目录的条目（一层）。用来看清目录结构再决定读谁。",
    parameters: {
      type: "object",
      properties: {
        path: PROP.path("相对于项目根的目录路径，省略为项目根"),
        depth: { type: "number", description: "递归层数（默认 1，最大 3）" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "grep_files",
    description: "在项目内按正则检索文件内容，返回命中行（带文件路径与行号）。",
    parameters: {
      type: "object",
      properties: {
        pattern: PROP.path("正则（不要带分隔符与 flag，平台按大小写敏感逐行匹配）"),
        path: PROP.path("限定在某个目录下检索，省略为整个项目"),
        maxMatches: { type: "number", description: "最多返回多少条命中（默认 40）" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "find_by_name",
    description: "按文件名 glob 找文件（如 `src/**/*.ts`），返回命中的相对路径。",
    parameters: {
      type: "object",
      properties: {
        glob: PROP.path("文件名 glob，如 `**/*.test.ts`"),
        path: PROP.path("限定在某个目录下查找，省略为整个项目"),
      },
      required: ["glob"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "用补丁修改/新建/删除文件。格式：`*** Begin Patch` 开头、`*** End Patch` 结尾；" +
      "每个文件一段，以 `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File: <path>` 起头；" +
      "Update 段的正文行以空格（上下文）、`-`（删除）、`+`（新增）开头，必须带上足够的上下文行。",
    parameters: {
      type: "object",
      properties: {
        patch: PROP.path("完整补丁文本"),
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "在项目根执行一条命令（不经过 shell，命令与参数分开给）。危险命令会被沙箱挡下或要求人工确认。",
    parameters: {
      type: "object",
      properties: {
        command: PROP.path("命令名，如 `npm` / `node` / `git`"),
        args: { type: "array", items: { type: "string" }, description: "参数数组" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_skill",
    description:
      "按名字取一个技能的完整说明（SKILL.md 全文）。名字就是技能目录块里列出的那些；" +
      "停用的技能会被拒绝。技能是背景而不是合同。",
    parameters: {
      type: "object",
      properties: {
        name: PROP.path("技能名（目录块里 `名字：用途` 那一行的名字）"),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

export function toolSpecOf(name: ToolName): ToolSpec {
  const spec = TOOL_SPECS.find((s) => s.name === name);
  // 工具表是闭合的：走到这里说明调用方传了未登记的名字，越往下只会写出一个
  // 端点看不懂的工具声明。早失败好过静默丢工具。
  if (!spec) throw new Error(`unknown tool: ${name}`);
  return spec;
}

/** 工具输出的字符上限（截断时由调用方标注原长度）。 */
export const TOOL_OUTPUT_MAX_CHARS = 8_000;

/** 模型一次能调多少个工具（防跑飞：一轮里塞 50 个工具调用没人审得过来）。 */
export const MAX_TOOL_CALLS_PER_TURN = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 参数校验：返回 `null` 表示通过，否则返回**给模型看**的理由。
 *
 * 理由要能被直接回灌进对话（模型下一轮据此改调用），所以写的是"缺了什么/
 * 类型不对/超出范围"，而不是内部错误码。
 */
export function validateToolArgs(name: ToolName, args: unknown): string | null {
  return validateArgsAgainstSpec(name, toolSpecOf(name), args);
}

/**
 * 通用的参数校验（与工具名解耦，便于对每种 JSON Schema 分支做真实断言）。
 *
 * `validateToolArgs` 只是"查表 + 委托"；当前工具表里没有 boolean 参数，
 * 但契约层必须覆盖它 —— 否则以后加一个布尔开关时，校验分支从来没被执行过。
 */
export function validateArgsAgainstSpec(name: string, spec: ToolSpec, args: unknown): string | null {
  if (!isPlainObject(args)) return `工具 ${name} 的参数必须是一个对象`;
  for (const key of spec.parameters.required) {
    const value = args[key];
    if (value === undefined || value === null || value === "") return `工具 ${name} 缺少必填参数：${key}`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const prop = spec.parameters.properties[key];
    if (!prop) return `工具 ${name} 不接受参数：${key}`;
    if (prop.type === "string" && typeof value !== "string") return `工具 ${name} 的 ${key} 必须是字符串`;
    if (prop.type === "number" && typeof value !== "number") return `工具 ${name} 的 ${key} 必须是数字`;
    if (prop.type === "boolean" && typeof value !== "boolean") return `工具 ${name} 的 ${key} 必须是布尔值`;
    if (prop.type === "array") {
      if (!Array.isArray(value)) return `工具 ${name} 的 ${key} 必须是数组`;
      if (prop.items?.type === "string" && value.some((v) => typeof v !== "string")) {
        return `工具 ${name} 的 ${key} 必须是字符串数组`;
      }
    }
  }
  return null;
}

/**
 * 截断工具输出。
 *
 * 尾部保留而不是头部：命令输出与堆栈的关键结论都在末尾（退出码、失败断言）。
 * 返回值自带"（已截断，原文 N 字符）"——模型据此知道该换更窄的检索，而不是
 * 以为世界就这么大。
 */
export function truncateToolOutput(text: string, maxChars: number = TOOL_OUTPUT_MAX_CHARS): {
  text: string;
  truncatedFrom?: number;
} {
  if (text.length <= maxChars) return { text };
  // 保留尾部：命令输出的结论（退出码、失败断言）与堆栈末尾都在后面；
  // 截头部会让模型看到一堆成功的构建日志却看不到最后那行失败。
  return {
    text: `…（已截断，原文 ${text.length} 字符，上限 ${maxChars}，只给末尾）\n${text.slice(-maxChars)}`,
    truncatedFrom: text.length,
  };
}
