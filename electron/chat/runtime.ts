import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadPolicyDirs } from "../sandbox/policy-dir";
import { CommandPolicy, createDefaultCommandPolicy } from "../sandbox/command-policy";
import { DEFAULT_FORBIDDEN_READ, DEFAULT_FORBIDDEN_WRITE, PathPolicy } from "../sandbox/path-policy";
import { readProjectConventions } from "../engine/conventions";
import { formatConventionsBlock } from "../../shared/project-conventions";
import {
  commandPolicyOverrides,
  describePolicy,
  forbiddenReadOverrides,
  pathPolicyOverrides,
  type PolicyFile,
} from "../../shared/policy-file";
import { PROJECT_CONFIG_VERSION, normalizeProjectConfig, type ProjectChatConfig } from "../../shared/project-config";
import type { ProjectSettings } from "../../shared/types";
import type { ApprovalPolicy, SandboxMode } from "../../shared/tools/policy";

/**
 * 一次会话的**运行时边界**：沙箱档位、审批策略、路径/命令地板、项目约定
 * 与项目级配置。
 *
 * 为什么单独成层而不是塞在 IPC 里：
 * - 这些值全部在构造 `ToolRunner` / `ChatSession` 时定死。把它们算一遍、
 *   同时产出一个签名，宿主就能在"设置/策略/约定变了"时重建会话，而不是
 *   继续拿旧边界执行；
 * - 纯计算 + 读盘，能脱离 Electron 单测（`src/chat-runtime.test.ts`）。
 *
 * 安全纪律：项目级配置只能选档位与审批策略，**不能放宽**代码里的命令/路径
 * 地板；`policy.d` 只能往上叠规则。两者合并后再构造沙箱。
 */
export interface ChatRuntimeOptions {
  rootAbs: string;
  settings: ProjectSettings;
  /** 全局策略目录（桌面 `<userData>/policy.d`；headless 通常没有）。 */
  globalPolicyDir?: string;
  /** 家目录，用于读 `~/.ox/AGENTS.md`；省略 = 不读全局约定。 */
  homeDir?: string;
  /**
   * 线程级覆盖（M3c）：显式选择的档位/审批策略要压过项目配置与全局设置。
   * 省略 = 逐字沿用原来的合并顺序。
   */
  profile?: { mode: SandboxMode; approvalPolicy: ApprovalPolicy };
}

export interface ChatRuntime {
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  approvalCommands: string[];
  maxTurns?: number;
  pathPolicy: PathPolicy;
  commandPolicy: CommandPolicy;
  systemPrompt: string;
  signature: string;
  /** 策略/配置/约定加载时的问题（给日志，不阻断会话）。 */
  issues: string[];
}

const BASE_PROMPT = "你是一个在本项目里干活的编码智能体。用工具看清现状再动手，改完自己跑一遍验证。";

function readProjectConfig(rootAbs: string): { config: ProjectChatConfig; issues: string[] } {
  const file = path.join(rootAbs, ".ox", "config.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { config: { version: PROJECT_CONFIG_VERSION }, issues: [] };
  }
  try {
    const normalized = normalizeProjectConfig(JSON.parse(raw));
    return { config: normalized.config, issues: normalized.issues.map((i) => `.ox/config.json：${i}`) };
  } catch (e) {
    return {
      config: { version: PROJECT_CONFIG_VERSION },
      issues: [`.ox/config.json：JSON 解析失败（${(e as Error).message}），整份忽略`],
    };
  }
}

function policyFingerprint(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      try {
        const st = fs.statSync(abs);
        out.push(`${abs}:${st.size}:${st.mtimeMs}`);
      } catch {
        out.push(`${abs}:unreadable`);
      }
    }
  }
  return out;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function resolveChatRuntime(opts: ChatRuntimeOptions): ChatRuntime {
  const { rootAbs, settings } = opts;
  const project = readProjectConfig(rootAbs);
  const projectPolicyDir = path.join(rootAbs, ".ox", "policy.d");
  // 空串由 `loadPolicyDirs` / `loadPolicyDir` 当"没配"处理，这里只收窄类型。
  const policyDirs = [opts.globalPolicyDir, projectPolicyDir].filter(
    (d): d is string => typeof d === "string",
  );
  const loaded = loadPolicyDirs(policyDirs);
  const policy: PolicyFile | undefined = loaded.files > 0 ? loaded.policy : undefined;

  const mode: SandboxMode =
    opts.profile?.mode ?? project.config.sandboxMode ?? settings.sandboxMode ?? "workspace-write";
  const approvalPolicy: ApprovalPolicy =
    opts.profile?.approvalPolicy ?? project.config.approvalPolicy ?? settings.approvalPolicy ?? "on-request";
  const approvalCommands = uniqueSorted([
    ...(settings.approvalCommands ?? []),
    ...(project.config.approvalCommands ?? []),
    ...(policy?.approvalCommands ?? []),
  ]);

  const writeOverrides = policy ? pathPolicyOverrides(policy, DEFAULT_FORBIDDEN_WRITE) : undefined;
  const readOverrides = policy ? forbiddenReadOverrides(policy, DEFAULT_FORBIDDEN_READ) : undefined;
  const pathPolicy = new PathPolicy({
    projectRoot: rootAbs,
    ...(writeOverrides ?? {}),
    ...(readOverrides ?? {}),
  });
  const commandPolicy = policy
    ? new CommandPolicy(commandPolicyOverrides(policy))
    : createDefaultCommandPolicy();

  const conventions = readProjectConventions(
    rootAbs,
    opts.homeDir ? [{ name: "~/.ox/AGENTS.md", abs: path.join(opts.homeDir, ".ox", "AGENTS.md") }] : [],
  );
  const conventionsBlock = formatConventionsBlock(conventions.files);
  const systemPrompt = conventionsBlock === "" ? BASE_PROMPT : `${BASE_PROMPT}\n\n${conventionsBlock}`;

  const issues = [
    ...project.issues,
    ...loaded.errors.map((e) => `${e.file}：${e.issues.join("；")}`),
    ...conventions.unreadable.map((u) => `${u.name} 读取失败：${u.reason}`),
    ...conventions.skipped.map((s) => `${s.name} 超过单文件上限（${s.bytes} 字节），已跳过`),
  ];

  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        rootAbs,
        mode,
        approvalPolicy,
        approvalCommands,
        maxTurns: project.config.maxTurns ?? null,
        provider: settings.llmProvider ?? "sensenova",
        pool: settings.llmPool ?? [],
        disabledKeys: settings.disabledKeyVars ?? [],
        policy: policy ? describePolicy(policy) : "",
        policyFiles: policyFingerprint(policyDirs),
        systemPrompt,
      }),
    )
    .digest("hex");

  return {
    mode,
    approvalPolicy,
    approvalCommands,
    ...(project.config.maxTurns !== undefined ? { maxTurns: project.config.maxTurns } : {}),
    pathPolicy,
    commandPolicy,
    systemPrompt,
    signature,
    issues,
  };
}
