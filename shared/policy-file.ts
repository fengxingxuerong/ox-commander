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
  /**
   * 需要**人工确认**才能执行的命令（审批门，P2-3）。按 basename 比对，与白名单同口径。
   *
   * 与 `denyCommands` 的区别是"停下来问"而不是"直接拒"：拒是把路封死，
   * 审批是把决定权交回人手上。适合那些**有时必须做、但每次做都该被看见**的动作
   * （生产环境迁移、发布、清库…）—— 封死会让流程走不通，放任则会静默出事。
   *
   * 没有宿主回调时按**拒绝**处理（`verifier` 的默认行为）：无人可问的场景下
   * "停下来"的唯一安全实现就是不执行 —— 与 `EscalationPolicy` 的 `exhaust`
   * 同构，而不是假装问过了。
   */
  approvalCommands?: string[];
  /**
   * 追加到内置**禁止写入**清单（路径面，P2-2）。glob 口径，与内置同一套匹配。
   *
   * ⚠️ 语义是**扩展**不是替换：内置的 `package.json` / `.env` / `.git/**` 等
   * 始终生效，这里只能往上叠。`SandboxConfig.forbiddenWrite` 本身是**替换**语义
   * （"Overrides when provided"）—— 策略层直接透传会**把内置地板拆掉**，
   * 那是放宽，违反本模块"只加严不放宽"的纪律（见 `pathPolicyOverrides`）。
   */
  forbidWrite?: string[];
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
  const approvalCommands = cleanStrings(obj.approvalCommands, "approvalCommands", issues);
  const forbidWrite = cleanStrings(obj.forbidWrite, "forbidWrite", issues);
  if (denyCommands) policy.denyCommands = denyCommands;
  if (denyGitSubcommands) policy.denyGitSubcommands = denyGitSubcommands;
  if (denyNpmSubcommands) policy.denyNpmSubcommands = denyNpmSubcommands;
  if (approvalCommands) policy.approvalCommands = approvalCommands;
  if (forbidWrite) policy.forbidWrite = forbidWrite;

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
  const approval = new Set<string>();
  const forbid = new Set<string>();
  let budget: number | undefined;
  for (const f of files) {
    for (const c of f.denyCommands ?? []) deny.add(c);
    for (const c of f.denyGitSubcommands ?? []) denyGit.add(c);
    for (const c of f.denyNpmSubcommands ?? []) denyNpm.add(c);
    // 审批清单取**并集**：一份策略要求确认，另一份不提，前者不应被后者抵消。
    for (const c of f.approvalCommands ?? []) approval.add(c);
    // 禁止写入同理取并集 —— 保护清单只会越叠越多，不会被另一份"没说"抹掉。
    for (const c of f.forbidWrite ?? []) forbid.add(c);
    if (f.maxTokensPerRun !== undefined) {
      budget = budget === undefined ? f.maxTokensPerRun : Math.min(budget, f.maxTokensPerRun);
    }
  }
  if (deny.size > 0) out.denyCommands = [...deny].sort();
  if (denyGit.size > 0) out.denyGitSubcommands = [...denyGit].sort();
  if (denyNpm.size > 0) out.denyNpmSubcommands = [...denyNpm].sort();
  if (approval.size > 0) out.approvalCommands = [...approval].sort();
  if (forbid.size > 0) out.forbidWrite = [...forbid].sort();
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

/**
 * 策略 → 审批门的入参（P2-3）。
 *
 * 刻意与 `commandPolicyOverrides` 分开：审批**不是**命令沙箱的一档。
 * `CommandPolicy.check` 返回的是终局裁决（allow / deny），而审批是一个
 * "先别动、去问人"的中间态 —— 把它塞进沙箱会让沙箱多出一种它不认识的语义，
 * 而沙箱的价值恰恰在于它的判据简单可审。
 */
export function approvalGateOf(policy: PolicyFile): { commands: string[] } | undefined {
  return policy.approvalCommands?.length ? { commands: policy.approvalCommands } : undefined;
}

/**
 * 策略 → 路径沙箱的 `forbiddenWrite`（P2-2 路径面）。
 *
 * ⚠️ 这里必须**自己算并集**，不能直接把 `policy.forbidWrite` 交给
 * `PathPolicy`：`SandboxConfig.forbiddenWrite` 是**替换**语义
 * （源码注释写着 "Overrides DEFAULT_FORBIDDEN_WRITE when provided"），
 * 直接透传等于把内置地板（`package.json` / `.env` / `.git/**` / `node_modules/**`）
 * 整块换掉 —— 那份 JSON 就能拆掉沙箱的地板，正是本模块反复强调的"只加严不放宽"
 * 要挡住的事。
 *
 * 返回 undefined 表示"策略没碰路径面"——调用方应当**不传** `forbiddenWrite`
 * （保持 PathPolicy 的默认行为），而不是传一个可能为空的数组：
 * 空数组在 `??` 下是"已提供"，会把地板清空。
 */
export function pathPolicyOverrides(
  policy: PolicyFile,
  defaults: readonly string[],
): { forbiddenWrite: string[] } | undefined {
  if (!policy.forbidWrite?.length) return undefined;
  // 并集 + 去重 + 排序：内置在前（可读性），策略项在后，整体去重。
  const merged = [...new Set([...defaults, ...policy.forbidWrite])].sort();
  return { forbiddenWrite: merged };
}

/**
 * 策略 → 预算上限（P2-2 预算面）。
 *
 * 取**更小**的那个：策略与设置都是"上限"，两个上限并存时以严的为准 ——
 * 否则"我在策略里写了 10 万上限"会被一个更大的 settings 值静默架空。
 * 两侧都可能没配（undefined）；都没配时返回 undefined（= 不设闸）。
 */
export function effectiveTokenBudget(
  policyBudget: number | undefined,
  settingsBudget: number | undefined,
): number | undefined {
  const valid = (n: number | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const a = valid(policyBudget) ? policyBudget : undefined;
  const b = valid(settingsBudget) ? settingsBudget : undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** 一行人话，给设置页/日志说"这份策略加了什么"。 */
export function describePolicy(policy: PolicyFile): string {
  const parts: string[] = [];
  if (policy.denyCommands?.length) parts.push(`禁用命令 ${policy.denyCommands.join("、")}`);
  if (policy.denyGitSubcommands?.length) parts.push(`禁用 git 子命令 ${policy.denyGitSubcommands.join("、")}`);
  if (policy.denyNpmSubcommands?.length) parts.push(`禁用 npm 子命令 ${policy.denyNpmSubcommands.join("、")}`);
  if (policy.approvalCommands?.length) parts.push(`需人工确认 ${policy.approvalCommands.join("、")}`);
  if (policy.forbidWrite?.length) parts.push(`禁止写入 ${policy.forbidWrite.join("、")}`);
  if (policy.maxTokensPerRun !== undefined) parts.push(`token 上限 ${policy.maxTokensPerRun}`);
  return parts.length > 0 ? parts.join("；") : "（空策略：规则一条不改）";
}
