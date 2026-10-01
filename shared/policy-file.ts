/**
 * 策略即代码（`policy.d/`）的**契约与归一化**（纯逻辑，无 IO、无 node）。
 *
 * 为什么要有它：沙箱规则目前全写在代码常量里（`command-policy.ts` 的
 * DEFAULT_*、`path-policy.ts` 的 forbidden、`usage-meter` 的预算）。改一条规则
 * 要改代码重新打包 —— 而"这条命令能不能跑、这个预算是多少"恰恰是**该被评审、
 * 该进版本库**的东西。声明式智能体（`agents.d/`）已经证明了这条路可行，
 * 这里把同一套思路扩到策略上。
 *
 * 与 `agents.d/` 的不同：manifest 描述"谁来做"，policy 描述"做到哪为止"。
 * 后者是安全边界，所以归一化**刻意收紧**：
 *   · 未知版本整份丢弃（半懂不懂地执行一份安全策略，比不执行更危险）；
 *   · 坏元素剔除并**说出来**（静默丢会让"我以为禁掉了"变成假的）；
 *   · 只能加严不能放宽 —— 见 `policyCommandOptions` 的注释。
 */

/** 当前认识的策略版本。 */
export const POLICY_VERSION = 1;

export interface PolicyFile {
  version: number;
  /** 追加到内置拒绝清单；**优先于**白名单（deny 先于 allow 查）。 */
  denyCommands?: string[];
  /** 追加到 git 子命令拒绝清单。 */
  denyGitSubcommands?: string[];
  /** 追加到 npm 子命令拒绝清单。 */
  denyNpmSubcommands?: string[];
  /** token 软上限；与 `ProjectSettings.maxTokensPerRun` 冲突时取**更小**的那个。 */
  maxTokensPerRun?: number;
}

export interface NormalizedPolicy {
  /** 归一化后的策略；解析失败时为空策略（规则一条不加，而不是半份）。 */
  policy: PolicyFile;
  /** 人工可读的问题清单。空数组 = 这份文件没话说。 */
  issues: string[];
}

/** 去重 + 排序：同一份策略在不同机器上必须得出同一张规则表。 */
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

/**
 * 归一化一份策略文件。
 *
 * 刻意**不抛异常**：策略加载失败不该让一次 run 起不来（与 `agents.d` 同风格：
 * 单文件失败只记录并跳过）。但"跳过"必须留下话，否则"我以为禁掉了"是假的。
 */
export function normalizePolicyFile(raw: unknown): NormalizedPolicy {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { policy: { version: POLICY_VERSION }, issues: ["策略文件必须是一个 JSON 对象"] };
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { policy: { version: POLICY_VERSION }, issues: [`version 缺失或不是整数：${String(version)}`] };
  }
  if (version !== POLICY_VERSION) {
    // 未知版本整份丢弃：半懂不懂地执行一份安全策略比不执行更危险。
    return { policy: { version: POLICY_VERSION }, issues: [`不认识的策略版本 ${version}（当前 ${POLICY_VERSION}），整份忽略`] };
  }

  const policy: PolicyFile = { version: POLICY_VERSION };
  const denyCommands = cleanStrings(obj.denyCommands, "denyCommands", issues);
  const denyGitSubcommands = cleanStrings(obj.denyGitSubcommands, "denyGitSubcommands", issues);
  const denyNpmSubcommands = cleanStrings(obj.denyNpmSubcommands, "denyNpmSubcommands", issues);
  if (denyCommands) policy.denyCommands = denyCommands;
  if (denyGitSubcommands) policy.denyGitSubcommands = denyGitSubcommands;
  if (denyNpmSubcommands) policy.denyNpmSubcommands = denyNpmSubcommands;

  const budget = obj.maxTokensPerRun;
  if (budget !== undefined) {
    // 与 usage-meter 同口径：只有"有限正数"算有效预算，0/负/NaN 一律视为没配
    // （把它们解释成"不限"而不是"全拒"，宁可放行也不放大一次配置失误）。
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      policy.maxTokensPerRun = budget;
    } else {
      issues.push(`maxTokensPerRun 无效（${String(budget)}）：必须是正数，已忽略`);
    }
  }
  return { policy, issues };
}

/** 多份策略合成一份：同类清单并集，预算取最小。 */
export function mergePolicies(files: readonly PolicyFile[]): PolicyFile {
  const out: PolicyFile = { version: POLICY_VERSION };
  const deny = new Set<string>();
  const denyGit = new Set<string>();
  const denyNpm = new Set<string>();
  let budget: number | undefined;
  for (const f of files) {
    for (const c of f.denyCommands ?? []) deny.add(c);
    for (const c of f.denyGitSubcommands ?? []) denyGit.add(c);
    for (const c of f.denyNpmSubcommands ?? []) denyNpm.add(c);
    if (f.maxTokensPerRun !== undefined) {
      budget = budget === undefined ? f.maxTokensPerRun : Math.min(budget, f.maxTokensPerRun);
    }
  }
  if (deny.size > 0) out.denyCommands = [...deny].sort();
  if (denyGit.size > 0) out.denyGitSubcommands = [...denyGit].sort();
  if (denyNpm.size > 0) out.denyNpmSubcommands = [...denyNpm].sort();
  if (budget !== undefined) out.maxTokensPerRun = budget;
  return out;
}

/**
 * 策略 → 命令沙箱的入参。
 *
 * **只加严，不放宽**：契约里**没有**"允许某条命令"这一格。白名单只能由代码改
 * （那是要评审的事），一份 JSON 不该能把地板拆掉 —— 否则"沙箱"这本书里
 * 有一页是可以随手撕的。
 *
 * 因此这里只产出 `denyMore` / 子命令拒绝：**扩展**内置清单，不替换。
 */
export function commandPolicyOverrides(policy: PolicyFile): {
  denyMore?: string[];
  denyGitSubcommands?: string[];
  denyNpmSubcommands?: string[];
} {
  return {
    ...(policy.denyCommands ? { denyMore: policy.denyCommands } : {}),
    ...(policy.denyGitSubcommands ? { denyGitSubcommands: policy.denyGitSubcommands } : {}),
    ...(policy.denyNpmSubcommands ? { denyNpmSubcommands: policy.denyNpmSubcommands } : {}),
  };
}

/** 一行人话，给设置页/日志说"这份策略加了什么"。 */
export function describePolicy(policy: PolicyFile): string {
  const parts: string[] = [];
  if (policy.denyCommands?.length) parts.push(`禁用命令 ${policy.denyCommands.join("、")}`);
  if (policy.denyGitSubcommands?.length) parts.push(`禁用 git 子命令 ${policy.denyGitSubcommands.join("、")}`);
  if (policy.denyNpmSubcommands?.length) parts.push(`禁用 npm 子命令 ${policy.denyNpmSubcommands.join("、")}`);
  if (policy.maxTokensPerRun !== undefined) parts.push(`token 上限 ${policy.maxTokensPerRun}`);
  return parts.length > 0 ? parts.join("；") : "（空策略：规则一条不改）";
}
