/**
 * 工具调用的**裁决**（纯函数，可被逐点变异审计）。
 *
 * 与既有两层的关系（`electron/sandbox/` 那两层的延伸，不是替代）：
 * - `CommandPolicy` / `PathPolicy` 是**地板**：回答"能不能"，一票否决；
 * - 本模块回答"**要不要先问人**"，以及"在当前沙箱档位下这件事根本没有资格发生"。
 *
 * 把两者分开的理由与 `approval-gate.ts` 头注释同源：地板漏了是越权，审批漏了是
 * **该被看见的动作静默发生了**；混在一起会让沙箱多出一种它不认识的中间态。
 *
 * 三档沙箱（`SandboxMode`）对齐 Codex：
 * - `read-only`：只读探索（`/plan` 那种"先看看"），一切写与执行都拒绝；
 * - `workspace-write`：默认档 —— 能改项目内的文件、能跑命令，但仍受地板约束；
 * - `danger-full-access`：不做分档拦截（CLI 适配器今天实际就处在这一档，
 *   见 `electron/agents/cli-agent.ts` 的注释）。
 *
 * 审批策略（`ApprovalPolicy`）同样对齐 Codex：
 * - `untrusted`：凡是会改变世界（写文件 / 跑命令）的动作都先问人；
 * - `on-request`：只问"策略点名"的命令（`approvalCommands`），其余照跑；
 * - `never`：从不问 —— 只有沙箱档位本身在兜底时才安全，所以界面上必须把
 *   这两件事**放在一起**呈现（README 里那句"沙箱不是防火墙"同理）。
 */
import { TOOL_NAMES, isToolName, type ToolName } from "./spec";

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export type ToolRisk = "read" | "write" | "exec";

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && (APPROVAL_POLICIES as readonly string[]).includes(value);
}

const RISK_BY_TOOL: Record<ToolName, ToolRisk> = {
  read_file: "read",
  list_dir: "read",
  grep_files: "read",
  find_by_name: "read",
  apply_patch: "write",
  run_command: "exec",
};

export function toolRisk(name: ToolName): ToolRisk {
  return RISK_BY_TOOL[name];
}

export function baseNameOf(command: string): string {
  const posix = command.trim().replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
}

export interface ToolDecisionInput {
  tool: ToolName;
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  /** `on-request` 档下点名要问的命令（basename 口径）。 */
  approvalCommands?: readonly string[];
  /** `run_command` 的命令名；其它工具可省略。 */
  command?: string;
  /** 本次会话里人已经答过"这一类动作不用再问"的集合（basename / 工具名）。 */
  sessionApproved?: readonly string[];
}

export type ToolDecision =
  | { verdict: "allow" }
  | { verdict: "ask"; reason: string }
  | { verdict: "deny"; reason: string };

/**
 * 裁决一次工具调用。
 *
 * 顺序是承重的：**先判沙箱档位，再判会话记忆，最后才判审批策略**。档位拒绝
 * 与审批拒绝是两种结局（前者是"这里不允许发生"，后者是"人没同意"），
 * 混在一起会让界面把"read-only 下不能写"报成"你拒绝了这次修改"。
 */
export function decideTool(input: ToolDecisionInput): ToolDecision {
  const risk = toolRisk(input.tool);
  if (input.mode === "read-only" && risk !== "read") {
    return {
      verdict: "deny",
      reason: `沙箱档位为 read-only，不允许${risk === "write" ? "写文件" : "执行命令"}（改档位或换一个只读工具）`,
    };
  }
  if (risk === "read") return { verdict: "allow" };

  const session = input.sessionApproved ?? [];
  const key = risk === "exec" ? `cmd:${baseNameOf(input.command ?? "")}` : `tool:${input.tool}`;
  if (session.includes(key)) return { verdict: "allow" };

  if (input.approvalPolicy === "never") return { verdict: "allow" };
  if (input.approvalPolicy === "untrusted") {
    return {
      verdict: "ask",
      reason: risk === "write" ? "当前审批策略为 untrusted：写文件需要人工确认" : "当前审批策略为 untrusted：执行命令需要人工确认",
    };
  }
  // on-request：只问策略点名的命令，其余交给地板。
  const named = input.approvalCommands ?? [];
  if (risk === "exec" && named.some((c) => baseNameOf(c) === baseNameOf(input.command ?? ""))) {
    return { verdict: "ask", reason: `命令 ${baseNameOf(input.command ?? "")} 在审批名单内，需要人工确认` };
  }
  return { verdict: "allow" };
}

/** 界面/日志用的一句话当前档位描述（两档一起说，避免"档位"被单独读成安全承诺）。 */
export function describeSandbox(mode: SandboxMode, approval: ApprovalPolicy): string {
  const modeText: Record<SandboxMode, string> = {
    "read-only": "只读（不改文件、不跑命令）",
    "workspace-write": "可改项目内文件、可跑命令（仍受路径与命令白名单约束）",
    "danger-full-access": "不做分档拦截",
  };
  const approvalText: Record<ApprovalPolicy, string> = {
    untrusted: "写与执行都先问",
    "on-request": "只问审批名单里的命令",
    never: "从不询问",
  };
  return `${modeText[mode]} · 审批：${approvalText[approval]}`;
}

/**
 * 工具名在进入执行层之前再验一次。
 *
 * 执行层拿到的 `name` 可能来自端点响应（原生 tools 路径），端点可以返回任意
 * 字符串；在 `switch` 里落到 default 等于"未知工具按已知工具处理"。这里把它
 * 变成一条明确的失败。
 */
export function assertKnownTool(name: unknown): ToolName | null {
  return isToolName(name) ? name : null;
}

/** 把未知工具名拦在 switch **之前**（参数就是要被拦的那个名字）。 */
export function unknownToolReason(name: unknown): string {
  return `未登记的工具：${String(name)}（可用：${TOOL_NAMES.join("、")}）`;
}
