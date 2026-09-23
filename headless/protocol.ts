/**
 * OxCommander headless protocol (`ox-headless/1`).
 *
 * This module is the contract, not the runner: it turns a raw stdin payload
 * into a fully-defaulted `ParsedSpec`, and types every event the runner may
 * emit. Keeping it pure (no fs, no process) is what makes the protocol
 * testable — the runner can then be exercised with injected fakes.
 *
 * Backwards compatibility is a promise here: unknown top-level fields are
 * reported as warnings, never as errors, and every field except
 * `requirement` / `projectRoot` has a default. A spec written for the first
 * version still runs unchanged.
 */
import * as path from "node:path";
import { getProvider } from "../shared/providers";
import { parseAgentManifestList } from "../electron/agents/manifest-schema";
import type { AgentManifest } from "../shared/agent-contract";
import {
  DEFAULT_SETTINGS,
  type ArbitrationMode,
  type PrdDocument,
  type ProjectSettings,
  type VerificationCommand,
  type VerificationKind,
} from "../shared/types";

export const PROTOCOL_VERSION = "ox-headless/1";

/**
 * What the runner does when repair rounds are exhausted.
 *
 * - `abort` (default): stop the pipeline — exit 1.
 * - `skip`: drop the failing tasks and deliver the rest if verification passes — exit 1 if it still cannot.
 * - `redispatch_once`: grant one extra repair round per task, then stop — exit 1.
 * - `exhaust`: no intervention at all; report "budget spent" — exit 2.
 */
export type EscalationPolicy = "abort" | "skip" | "redispatch_once" | "exhaust";

export interface HeadlessSpec {
  /** Optional in the wire format; echoed back in the `hello` event. */
  protocolVersion?: string;
  /** Natural-language requirement (required unless a `prd` is supplied). */
  requirement: string;
  /** Target project root (absolute, or relative to the runner's cwd). */
  projectRoot: string;
  /** Pre-approved PRD; when present the PRD stage is skipped. */
  prd?: PrdDocument;
  /** Brain-layer provider, default `sensenova` (used when `llmPool` is empty). */
  llmProvider?: string;
  /**
   * Providers sharing one failover table, in preference order. Defaults to the
   * platform default (SenseNova's 12 routes + AMD). `[]` falls back to
   * `llmProvider` alone.
   */
  llmPool?: string[];
  /** Repair-round ceiling, default 3. */
  maxRepairRounds?: number;
  /** Hard verification commands, default npm build/typecheck/test. */
  verificationCommands?: VerificationCommand[];
  escalationPolicy?: EscalationPolicy;
  /** Extra agent declarations (cli / http-bridge). */
  agents?: AgentManifest[];
  /** Directory scanned for `*.json` agent declarations. */
  manifestDir?: string;
  /** `false` disables capability routing (legacy round-robin). */
  agentRouter?: boolean;
  /** Content-backup directory used for rollback; defaults to the temp dir. */
  snapshotRoot?: string;
  /** Zone-violation handling: default `revert-batch`. */
  arbitration?: ArbitrationMode;
  /** Concurrency ceiling; 0 means unlimited. */
  maxParallelRuns?: number;
  /**
   * Token budget for this run (soft ceiling). The next LLM call is rejected
   * *before* it is sent once the total reaches the limit; a single call may
   * overshoot and is still recorded. Must be a positive number — an explicit
   * `0` / negative is treated as a host bug and rejected, not as "unlimited"
   * (omit the field to express unlimited).
   */
  maxTokensPerRun?: number;
}

export interface ParsedSpec {
  protocolVersion: string;
  requirement: string;
  /** Absolute path. */
  projectRoot: string;
  prd?: PrdDocument;
  llmProvider: string;
  /** Provider ids sharing one failover table (empty ⇒ single provider). */
  llmPool: string[];
  escalationPolicy: EscalationPolicy;
  /** Fully-defaulted project settings, ready for the engine. */
  settings: ProjectSettings;
  agents: AgentManifest[];
  manifestDir?: string;
  snapshotRoot: string;
  maxParallelRuns: number;
  /** Non-fatal notes (unknown fields, coerced values) for the host to log. */
  warnings: string[];
}

export type ParseResult = { ok: true; spec: ParsedSpec } | { ok: false; message: string };

/** Emitted by the runner, one JSON object per line on stdout. */
export type HeadlessEvent =
  | { type: "hello"; protocolVersion: string; projectRoot: string; llmProvider: string; arbitration: ArbitrationMode; agentRouter: boolean; warnings: string[] }
  | { type: "stage"; stage: string }
  | { type: "log"; text: string }
  | { type: "agents"; agents: Array<{ id: string; adapter: string; enabled: boolean; declared: boolean; roles: string[]; zoneGlobs: string[] }> }
  | { type: "prd"; prd: PrdDocument }
  | { type: "tasks"; batches: unknown }
  | { type: "task"; taskId: string; status: string; attempts: number }
  | { type: "run"; phase: "start" | "end"; taskId: string; agentId?: string; zone?: string; ok?: boolean; durationMs?: number; errorClass?: string }
  | { type: "conflict"; kind: string; paths: string[]; remedy: string }
  | {
      type: "verification";
      passed: boolean;
      results: Array<{ kind: string; ok: boolean; exitCode: number | null; logDigest?: string }>;
    }
  | { type: "escalation"; taskId: string; summary: string }
  /**
   * 本次运行的 token 用量（进程内：大脑层 + 内置执行器）。在 `done` / `error`
   * **之前**发一次，成功、取消、抛错三条路径都会到。
   * `calls - measuredCalls` 是服务商没在响应里上报用量的次数 ——
   * 宿主据此判断这份数字可信到什么程度。外部 CLI / HTTP 桥接智能体
   * 跑在别的进程里，不计入。
   */
  | {
      type: "usage";
      totalTokens: number;
      calls: number;
      measuredCalls: number;
      byModel: Record<string, number>;
      /** 本轮预算上限；settings 未配置时省略（字段即承诺）。 */
      limit?: number;
    }
  | { type: "done"; passed: boolean; report: unknown }
  /** `exhausted: true` means the repair budget ran out (exit code 2), not a crash (1). */
  | { type: "error"; message: string; exhausted?: boolean };

const KNOWN_FIELDS = new Set<string>([
  "protocolVersion",
  "requirement",
  "projectRoot",
  "prd",
  "llmProvider",
  "llmPool",
  "maxRepairRounds",
  "verificationCommands",
  "escalationPolicy",
  "agents",
  "manifestDir",
  "agentRouter",
  "snapshotRoot",
  "arbitration",
  "maxParallelRuns",
  "maxTokensPerRun",
]);

const ESCALATION_POLICIES: readonly EscalationPolicy[] = ["abort", "skip", "redispatch_once", "exhaust"];
const ARBITRATION_MODES: readonly ArbitrationMode[] = ["report-only", "deny-all", "revert-batch", "quarantine"];
const VERIFICATION_KINDS: readonly VerificationKind[] = ["build", "typecheck", "test"];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function parseCommands(raw: unknown, issues: string[]): VerificationCommand[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push("verificationCommands 必须是数组");
    return undefined;
  }
  const out: VerificationCommand[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isObj(item)) {
      issues.push(`verificationCommands[${i}] 必须是对象`);
      continue;
    }
    const kind = item.kind;
    if (typeof kind !== "string" || !VERIFICATION_KINDS.includes(kind as VerificationKind)) {
      issues.push(`verificationCommands[${i}].kind 必须是 ${VERIFICATION_KINDS.join(" / ")}`);
      continue;
    }
    if (!isNonEmptyString(item.command)) {
      issues.push(`verificationCommands[${i}].command 必须是非空字符串`);
      continue;
    }
    const args = item.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      issues.push(`verificationCommands[${i}].args 必须是字符串数组`);
      continue;
    }
    out.push({ kind: kind as VerificationKind, command: item.command, args: args as string[] });
  }
  return out;
}

/**
 * Validates and defaults a raw stdin payload. Collects *all* issues so the host
 * can report them at once, and never throws.
 */
export function parseSpec(rawText: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (err) {
    return { ok: false, message: `stdin 不是合法 JSON：${(err as Error).message}` };
  }
  if (!isObj(raw)) return { ok: false, message: "spec 必须是 JSON 对象" };

  const issues: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`未知字段 "${key}" 已忽略`);
  }

  if (!isNonEmptyString(raw.requirement)) issues.push("requirement 必须是非空字符串");
  if (!isNonEmptyString(raw.projectRoot)) issues.push("projectRoot 必须是非空字符串");

  let maxRepairRounds: number | undefined;
  if (raw.maxRepairRounds !== undefined) {
    if (typeof raw.maxRepairRounds !== "number" || !Number.isFinite(raw.maxRepairRounds) || raw.maxRepairRounds < 0) {
      issues.push("maxRepairRounds 必须是不小于 0 的数字");
    } else {
      maxRepairRounds = Math.floor(raw.maxRepairRounds);
    }
  }

  let maxParallelRuns: number | undefined;
  if (raw.maxParallelRuns !== undefined) {
    if (typeof raw.maxParallelRuns !== "number" || !Number.isFinite(raw.maxParallelRuns) || raw.maxParallelRuns < 0) {
      issues.push("maxParallelRuns 必须是不小于 0 的数字（0 表示不限）");
    } else {
      maxParallelRuns = Math.floor(raw.maxParallelRuns);
    }
  }

  let maxTokensPerRun: number | undefined;
  if (raw.maxTokensPerRun !== undefined) {
    // 与 UsageMeter 内核口径刻意不同：协议层显式传 0/负数更像宿主的预算
    // 计算出了 bug，静默解释成"不限"会让宿主以为闸在守而实际没有 ——
    // 直接拒绝并报 issue，让宿主当场修。想表达"不限"就省略该字段。
    if (typeof raw.maxTokensPerRun !== "number" || !Number.isFinite(raw.maxTokensPerRun) || raw.maxTokensPerRun <= 0) {
      issues.push("maxTokensPerRun 必须是正数（token 数；不传表示不限）");
    } else {
      maxTokensPerRun = Math.floor(raw.maxTokensPerRun);
    }
  }

  let escalationPolicy: EscalationPolicy | undefined;
  if (raw.escalationPolicy !== undefined) {
    if (typeof raw.escalationPolicy !== "string" || !ESCALATION_POLICIES.includes(raw.escalationPolicy as EscalationPolicy)) {
      issues.push(`escalationPolicy 必须是 ${ESCALATION_POLICIES.join(" / ")}`);
    } else {
      escalationPolicy = raw.escalationPolicy as EscalationPolicy;
    }
  }

  let arbitration: ArbitrationMode | undefined;
  if (raw.arbitration !== undefined) {
    if (typeof raw.arbitration !== "string" || !ARBITRATION_MODES.includes(raw.arbitration as ArbitrationMode)) {
      issues.push(`arbitration 必须是 ${ARBITRATION_MODES.join(" / ")}`);
    } else {
      arbitration = raw.arbitration as ArbitrationMode;
    }
  }

  let agentRouter: boolean | undefined;
  if (raw.agentRouter !== undefined) {
    if (typeof raw.agentRouter !== "boolean") issues.push("agentRouter 必须是布尔值");
    else agentRouter = raw.agentRouter;
  }
  if (raw.llmProvider !== undefined && !isNonEmptyString(raw.llmProvider)) {
    issues.push("llmProvider 必须是非空字符串");
  }
  if (raw.manifestDir !== undefined && !isNonEmptyString(raw.manifestDir)) {
    issues.push("manifestDir 必须是非空字符串");
  }
  if (raw.snapshotRoot !== undefined && !isNonEmptyString(raw.snapshotRoot)) {
    issues.push("snapshotRoot 必须是非空字符串");
  }

  let llmPool: string[] | undefined;
  if (raw.llmPool !== undefined) {
    if (!Array.isArray(raw.llmPool) || raw.llmPool.some((p) => typeof p !== "string" || p.trim() === "")) {
      issues.push("llmPool 必须是字符串数组（provider id）");
    } else {
      llmPool = (raw.llmPool as string[]).map((p) => p.trim());
      for (const id of llmPool) {
        try {
          getProvider(id);
        } catch {
          issues.push(`llmPool 含有未知 provider：${id}`);
        }
      }
    }
  }

  const verificationCommands = parseCommands(raw.verificationCommands, issues);

  let agents: AgentManifest[] = [];
  if (raw.agents !== undefined) {
    try {
      agents = parseAgentManifestList(raw.agents, "declared");
    } catch (err) {
      issues.push(`agents 声明校验失败：${(err as Error).message}`);
    }
  }

  let prd: PrdDocument | undefined;
  if (raw.prd !== undefined) {
    if (!isObj(raw.prd)) {
      issues.push("prd 必须是对象");
    } else {
      const p = raw.prd;
      const bad =
        !isNonEmptyString(p.goal) ||
        !Array.isArray(p.features) ||
        !Array.isArray(p.techStack) ||
        !Array.isArray(p.acceptanceCriteria);
      if (bad) issues.push("prd 必须包含 goal / features / techStack / acceptanceCriteria");
      else prd = p as unknown as PrdDocument;
    }
  }

  if (issues.length > 0) return { ok: false, message: issues.join("；") };

  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    ...(maxRepairRounds !== undefined ? { maxRepairRounds } : {}),
    ...(verificationCommands ? { verificationCommands } : {}),
    // 只需一个条件：`agentRouter` 只在上面 `if (raw.agentRouter !== undefined)`
    // 的 else 分支里被赋值，所以 `agentRouter !== undefined ⟺ raw.agentRouter !== undefined`。
    // 原先写成 `raw.agentRouter !== undefined && agentRouter !== undefined`，
    // 两个条件互为蕴含 —— 逻辑上冗余，且让变异测试永远杀不掉那个 `&&`
    // （改 `||` 后条件仍与原文等价）。按"能简化就简化"处理，不留冗余守卫。
    ...(agentRouter !== undefined ? { agentRouter } : {}),
    ...(arbitration ? { arbitration } : {}),
    ...(maxTokensPerRun !== undefined ? { maxTokensPerRun } : {}),
  };

  return {
    ok: true,
    spec: {
      protocolVersion: isNonEmptyString(raw.protocolVersion) ? raw.protocolVersion : PROTOCOL_VERSION,
      requirement: (raw.requirement as string).trim(),
      projectRoot: path.resolve(raw.projectRoot as string),
      ...(prd ? { prd } : {}),
      llmProvider: isNonEmptyString(raw.llmProvider) ? raw.llmProvider : "sensenova",
      llmPool: llmPool ?? [...DEFAULT_SETTINGS.llmPool],
      escalationPolicy: escalationPolicy ?? "abort",
      settings,
      agents,
      ...(isNonEmptyString(raw.manifestDir) ? { manifestDir: path.resolve(raw.manifestDir) } : {}),
      snapshotRoot: isNonEmptyString(raw.snapshotRoot)
        ? path.resolve(raw.snapshotRoot)
        : path.join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "ox-commander-snapshots"),
      maxParallelRuns: maxParallelRuns ?? DEFAULT_SETTINGS.maxParallelRuns,
      warnings,
    },
  };
}
