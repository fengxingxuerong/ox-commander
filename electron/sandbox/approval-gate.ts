/**
 * 审批门（P2-3，竞品调研：paperclip 的 approvals / bernstein 的 approval）。
 *
 * 与它旁边两层的关系：
 * - `CommandPolicy`（静态地板）回答"这条命令**能不能**跑" —— 一票否决；
 * - `ActionGate`（跨动作状态机）回答"批次内已经发生过什么，这条命令的含义变了吗"；
 * - 本模块回答第三种问题："这条命令**跑之前要不要先问人**"。
 *
 * 三者刻意分开，因为它们的失败模式不同：地板漏了是越权，状态机漏了是上下文错判，
 * 而审批门漏了是**该被看见的动作静默发生了**。把审批塞进 `CommandPolicy` 会让
 * 沙箱多出一种它不认识的中间态（"先别动"既不是 allow 也不是 deny），而沙箱的
 * 价值恰恰在于判据简单可审。
 *
 * 两条纪律：
 * 1. **问不到人就不执行**（fail-closed）。没有宿主回调时按拒绝处理 —— 无人可问
 *    的场景下，"停下来"的唯一安全实现就是不执行。与 `EscalationPolicy` 的
 *    `exhaust` 同构：不假装问过了。
 *    反过来说，这**不是**要让人去点一堆弹窗：没配 `approvalCommands` 时本模块
 *    零影响，配了才生效 —— 默认路径上不该多出任何人工环节。
 * 2. **纯函数在前、壳在后**：`needsApproval` / `approvalDeniedReason` 是纯的，
 *    可被逐位点审；`ApprovalGate` 只是持有"本批次已批准过哪些命令"的薄壳。
 *
 * 为什么"批准"要按批次记而不是按次记：一次 run 里同一命令会被反复执行
 * （每轮验证都跑一遍），逐次问人会把审批变成噪音，而噪音会被习惯性点掉 ——
 * 那比没有审批更坏。批次的粒度与 `ActionGate` 的 reset 边界一致。
 */
import type { CommandDecision } from "./command-policy";

function baseName(command: string): string {
  const posix = command.trim().replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
}

/** 需要审批吗？纯函数，按 basename 比对（与命令白名单同一口径）。 */
export function needsApproval(approvalCommands: readonly string[], command: string): boolean {
  if (approvalCommands.length === 0) return false;
  const base = baseName(command);
  return approvalCommands.some((c) => baseName(c) === base);
}

/**
 * 问不到人时给出的裁决。
 *
 * 刻意说明"要么配回调、要么把命令移出 approvalCommands 或加进 denyCommands"——
 * 只说"被拒绝"会让人以为这是沙箱地板，从而去查白名单（查不到东西）。
 */
export function approvalDeniedReason(command: string): string {
  return (
    `命令需要人工确认，但当前无审批回调可用，按拒绝处理：${command}` +
    `（无人值守场景下"停下来"的唯一安全实现是不执行。` +
    `要么给宿主接上审批回调，要么把该命令从 policy.d 的 approvalCommands 移出、` +
    `或改用 denyCommands 明确封死）`
  );
}

/** 壳需要的最小宿主接口：问一次"这条命令准不准跑"。 */
export interface ApprovalGateLike {
  /** 返回 true 表示放行；false / 抛出表示拒绝。 */
  requestApproval(command: string, args: readonly string[]): Promise<boolean>;
}

export interface ApprovalGateOptions {
  /** 需要审批的命令（basename 口径）。空数组 = 整个门不生效。 */
  commands: readonly string[];
  /**
   * 宿主回调。**缺席时按拒绝处理**（fail-closed）—— 见模块头注释的纪律 1。
   */
  request?: ApprovalGateLike["requestApproval"];
  /** 观察点（日志/事件流）：谁在什么时候问了、答复是什么。 */
  onEvent?: (text: string) => void;
}

/**
 * 批次生命周期的审批壳。
 *
 * `check` 是 async 的（要等人），这是它与 `CommandPolicy.check` / `ActionGate.check`
 * 的同步签名**刻意不同**的地方：那些是纯判定，这个会阻塞在人的响应上。
 * 调用方（verifier）必须 await —— 所以它不会被顺手塞进同步链里。
 */
export class ApprovalGate {
  private readonly commands: readonly string[];
  private readonly request?: ApprovalGateLike["requestApproval"];
  private readonly onEvent?: (text: string) => void;
  /** 本批次已批准过的命令（basename）。 */
  private approved = new Set<string>();

  constructor(opts: ApprovalGateOptions) {
    this.commands = opts.commands;
    this.request = opts.request;
    if (opts.onEvent) this.onEvent = opts.onEvent;
  }

  /** 本门是否真的会拦东西（`false` = 没配 approvalCommands，调用方可跳过等待）。 */
  get active(): boolean {
    return this.commands.length > 0;
  }

  /**
   * 判定 + （必要时）问人。
   *
   * 返回 `undefined` 表示"本门无意见，按静态策略的裁决走"；返回裁决表示本门
   * 已经替调用方定了（放行或拒绝）。三态而不是两态，是为了让"没配审批"与
   * "配了且通过"在上层可区分 —— 前者不该在事件流里留痕。
   */
  async check(command: string, args: readonly string[]): Promise<CommandDecision | undefined> {
    if (!this.active) return undefined;
    const base = baseName(command);
    if (!needsApproval(this.commands, command)) return undefined;

    // 本批次已经批准过：不再重复打扰。理由见模块头（逐次问人会把审批变噪音）。
    if (this.approved.has(base)) return undefined;

    if (!this.request) {
      const reason = approvalDeniedReason(command);
      this.onEvent?.(`[approval] ${reason}`);
      return { ok: false, reason };
    }

    let granted = false;
    try {
      granted = await this.request(command, args);
    } catch (err) {
      // 回调抛错视为"没问到人"，同样拒绝 —— 不把异常当成默许。
      const reason = `审批回调失败，按拒绝处理：${command}（${String(err)}）`;
      this.onEvent?.(`[approval] ${reason}`);
      return { ok: false, reason };
    }

    if (!granted) {
      const reason = `人工拒绝了该命令：${command}`;
      this.onEvent?.(`[approval] ${reason}`);
      return { ok: false, reason };
    }

    this.approved.add(base);
    this.onEvent?.(`[approval] 已批准 ${command}（本批次内不再重复询问）`);
    return undefined; // 批准 = 本门无意见，交回静态策略继续
  }

  /** 批次边界由编排器调用，与 `ActionGate.reset` 同一个生命单位。 */
  reset(): void {
    this.approved = new Set<string>();
  }

  /** 诊断快照（测试 / 设置页）。 */
  snapshot(): { commands: readonly string[]; approved: string[] } {
    return { commands: this.commands, approved: [...this.approved].sort() };
  }
}
