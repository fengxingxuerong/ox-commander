/**
 * 项目级会话配置（`.ox/config.json`）的契约与归一化。
 *
 * 与 `policy.d/` 的分工：
 * - 这里是**项目所有者**的默认值（沙箱档位、审批策略、轮次上限）；
 * - `policy.d/` 是**只能加严**的安全地板（禁命令、禁写路径、需审批命令）。
 *
 * 两者都不接受"放宽代码里的地板"：`sandboxMode` 只能选三档之一，
 * `approvalPolicy` 只能选三档之一；命令白名单本身仍然只能改代码。
 */
import { isApprovalPolicy, isSandboxMode, type ApprovalPolicy, type SandboxMode } from "./tools/policy";

export const PROJECT_CONFIG_VERSION = 1;

export interface ProjectChatConfig {
  version: number;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalCommands?: string[];
  /** 单次会话的工具轮次上限；缺省沿用 ChatSession 的内置值。 */
  maxTurns?: number;
}

export interface NormalizedProjectConfig {
  config: ProjectChatConfig;
  /** 人工可读的问题清单；空数组 = 这份配置没话说。 */
  issues: string[];
}

function cleanStrings(raw: unknown, field: string, issues: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push(`${field} 必须是字符串数组`);
    return undefined;
  }
  const out = new Set<string>();
  let dropped = 0;
  for (const item of raw) {
    if (typeof item !== "string") {
      dropped += 1;
      continue;
    }
    const trimmed = item.trim();
    if (trimmed !== "") out.add(trimmed);
    else dropped += 1;
  }
  if (dropped > 0) issues.push(`${field} 里有 ${dropped} 个非字符串/空条目，已剔除`);
  return out.size > 0 ? [...out].sort() : undefined;
}

export function normalizeProjectConfig(raw: unknown): NormalizedProjectConfig {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: { version: PROJECT_CONFIG_VERSION }, issues: ["项目配置必须是 JSON 对象"] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== PROJECT_CONFIG_VERSION) {
    return {
      config: { version: PROJECT_CONFIG_VERSION },
      issues: [`不认识的项目配置版本 ${String(obj.version)}（当前 ${PROJECT_CONFIG_VERSION}），整份忽略`],
    };
  }
  const config: ProjectChatConfig = { version: PROJECT_CONFIG_VERSION };
  if (obj.sandboxMode !== undefined) {
    if (isSandboxMode(obj.sandboxMode)) config.sandboxMode = obj.sandboxMode;
    else issues.push(`sandboxMode 无效：${String(obj.sandboxMode)}（可选 read-only / workspace-write / danger-full-access）`);
  }
  if (obj.approvalPolicy !== undefined) {
    if (isApprovalPolicy(obj.approvalPolicy)) config.approvalPolicy = obj.approvalPolicy;
    else issues.push(`approvalPolicy 无效：${String(obj.approvalPolicy)}（可选 untrusted / on-request / never）`);
  }
  const approvalCommands = cleanStrings(obj.approvalCommands, "approvalCommands", issues);
  if (approvalCommands) config.approvalCommands = approvalCommands;
  if (obj.maxTurns !== undefined) {
    if (typeof obj.maxTurns === "number" && Number.isInteger(obj.maxTurns) && obj.maxTurns > 0) {
      config.maxTurns = obj.maxTurns;
    } else {
      issues.push(`maxTurns 无效（${String(obj.maxTurns)}）：必须是正整数，已忽略`);
    }
  }
  return { config, issues };
}
