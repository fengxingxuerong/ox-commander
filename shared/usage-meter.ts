import type { ChatRequest, ChatResponse } from "./providers";
import type { LlmClient } from "./llm-client";

/**
 * Token 用量的**采集、汇总与预算闸门**（纯逻辑，不碰 node/DOM）。
 *
 * 为什么要有这个文件：`usageTokens` 一直在 `http-clients.ts` 里被采集
 * （OpenAI 兼容层读 `usage.total_tokens`、Anthropic 层把 input+output 相加），
 * 也在 `providers.ts` 里被声明过 —— 但**全仓没有任何读取方**：
 * 既没有汇总，也没有上限，一次长跑烧掉多少配额只能靠翻服务商账单。
 *
 * 上一轮只做**可见性**（谁用了多少、有多少次没上报）。这一轮补上
 * **预算闸门**（`maxTokensPerRun`）：累计用量达到上限后，下一次调用
 * 在发出**之前**被拒绝 —— 闸门包在 `meteredLlm` 最外层，所以大脑层和
 * 内置执行器共用同一道闸。采集链路没动：闸门只是多了一个"开闸前看一眼"。
 */

/** 一次调用的用量明细；`usageTokens` 缺失表示服务商没在响应里给用量。 */
export interface UsageSample {
  provider?: string;
  model?: string;
  usageTokens?: number;
}

export interface UsageSnapshot {
  /** 已上报的 token 之和。 */
  totalTokens: number;
  /** 成功返回的调用次数（失败/抛错的不计）。 */
  calls: number;
  /** 其中**在响应里上报了用量**的次数；`calls - measuredCalls` 就是没上报的次数。 */
  measuredCalls: number;
  /** `provider/model` → token 数；未上报的调用不产生条目。 */
  byModel: Record<string, number>;
  /** 预算上限；未配置时不出现在快照里（字段即承诺，不给宿主歧义）。 */
  limit?: number;
}

/**
 * 预算耗尽时抛出。message 刻意写成可行动的一句话（含两个数字），
 * 让宿主和看板日志不用翻堆栈就知道发生了什么、该调大还是分拆。
 */
export class BudgetExceededError extends Error {
  readonly used: number;
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(`token 预算已耗尽：本次运行已用 ${used} / 上限 ${limit}（maxTokensPerRun）。调大上限或分拆运行后再试`);
    this.name = "BudgetExceededError";
    this.used = used;
    this.limit = limit;
  }
}

/** 仅"有限正数"算作有效预算；其余（undefined/0/负/NaN/Infinity）一律视为未配置。 */
function validLimit(max: number | undefined): number | undefined {
  return typeof max === "number" && Number.isFinite(max) && max > 0 ? max : undefined;
}

/**
 * 预算闸"看不见"某些调用时的那句提示（不带前缀，方便并进另一行）。
 *
 * 为什么需要：闸门只能拿**端点上报的** `usage.total_tokens` 做判断，而有些端点
 * 根本不回报用量 —— 那部分调用的 token 永远进不了 `totalTokens`，于是
 * `maxTokensPerRun` 对它们不起作用。这里刻意**不估算**：没有本机校准过的
 * "字符→token"分布，估出来的数会被当成账单口径读，比不估更坏。说要说什么没被
 * 看见，让人自己决定信不信这个数。
 */
export function budgetBlindNote(info: { limit: number; unmeasuredCalls: number }): string {
  return (
    `已有 ${info.unmeasuredCalls} 次调用端点未上报用量 ⇒ maxTokensPerRun=${info.limit} ` +
    `这道闸看不见它们，实际支出可能已超过上限（未上报的部分刻意不估算）`
  );
}

/**
 * 进程内累加器。刻意**不**做持久化 —— 它的职责只有"数得对"和"拦得住"。
 *
 * 对脏数据的处理是刻意收紧的：`undefined` / `NaN` / `Infinity` / 负数
 * 一律**不计入 total**，只把 `calls` 加上去。理由是把 `NaN` 累进总量会让
 * 之后所有汇总都变成 `NaN`（且不会报错），负数则会静默抵掉真实用量 ——
 * 两者都会让"可见性"变成假的。
 *
 * 预算上限（`maxTokensPerRun`）是**软上限**：闸门只能在下一次调用发出前
 * 判定，已经发生的那一次没法撤回 —— 所以单次调用可以穿透上限，但会如实
 * 记录（总量必须能和服务商账单对上），下一跳才被拦。把坏值（0/负/NaN）
 * 解释成"不限"而不是"全拒"：宁可放行也不能把一次配置失误放大成整轮 run
 * 全部失败 —— 想禁用调用应该走能力路由，而不是把预算设为 0。
 */
export class UsageMeter {
  private total = 0;
  private calls = 0;
  private measured = 0;
  private readonly byModel = new Map<string, number>();
  private readonly limit: number | undefined;
  private readonly onBudgetBlind: ((info: { limit: number; unmeasuredCalls: number }) => void) | undefined;
  /** 半盲提示只说一次：每跳都喊一遍会淹掉日志，而事实不会变。 */
  private blindAnnounced = false;

  constructor(opts?: {
    maxTokensPerRun?: number;
    onBudgetBlind?: (info: { limit: number; unmeasuredCalls: number }) => void;
  }) {
    this.limit = validLimit(opts?.maxTokensPerRun);
    this.onBudgetBlind = opts?.onBudgetBlind;
  }

  /** 已用 token 是否达到预算上限；达到则抛 `BudgetExceededError`。 */
  assertWithinBudget(): void {
    if (this.limit !== undefined && this.total >= this.limit) {
      throw new BudgetExceededError(this.total, this.limit);
    }
  }

  record(sample: UsageSample): void {
    this.calls += 1;
    const tokens = sample.usageTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
      // 这一跳没上报用量 ⇒ 配了预算也拦不到它：第一次遇到就说，而不是等 run 结束
      // 才对着一行"总量 = 0"困惑。
      if (this.limit !== undefined && !this.blindAnnounced) {
        this.blindAnnounced = true;
        this.onBudgetBlind?.({ limit: this.limit, unmeasuredCalls: this.calls - this.measured });
      }
      return;
    }
    this.measured += 1;
    this.total += tokens;
    const key = `${sample.provider ?? "unknown"}/${sample.model ?? "unknown"}`;
    this.byModel.set(key, (this.byModel.get(key) ?? 0) + tokens);
  }

  snapshot(): UsageSnapshot {
    return {
      totalTokens: this.total,
      calls: this.calls,
      measuredCalls: this.measured,
      byModel: Object.fromEntries(this.byModel),
      ...(this.limit !== undefined ? { limit: this.limit } : {}),
    };
  }
}

/**
 * 把任意 `LlmClient` 包一层计量与预算闸门。
 *
 * 只包**最外层**客户端：`FailoverLlmClient` 内部那些 route 客户端不该再各包一层，
 * 否则一次调用会被记 N 次（重试/线路轮换时尤其明显）。所以调用方约定：
 * 包在"调用者真正持有的那个 client"上，不要包在 http-clients 的工厂里。
 *
 * 预算检查放在**转发之前**：超限的调用根本不会到达内层 client，
 * 这就是"不再烧钱"的保证。抛错的调用**不记录** —— `calls` 的语义是
 * "成功拿到响应的次数"，把失败也算进去会让"平均每次消耗"这类推导失真。
 */
export function meteredLlm(inner: LlmClient, meter: UsageMeter): LlmClient {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      meter.assertWithinBudget();
      const res = await inner.chat(req);
      meter.record({ provider: res.provider, model: res.model, usageTokens: res.usageTokens });
      return res;
    },
  };
}

/** 一行人类可读的汇总，供看板/协议日志直接落。 */
export function formatUsageLine(s: UsageSnapshot): string {
  const parts = [`${s.totalTokens} tokens`, `${s.calls} 次调用`];
  const unmetered = s.calls - s.measuredCalls;
  if (unmetered > 0) parts.push(`${unmetered} 次未上报用量`);
  const models = Object.entries(s.byModel)
    .sort((a, b) => b[1] - a[1])
    .map(([key, tokens]) => `${key}=${tokens}`);
  if (models.length > 0) parts.push(models.join(" / "));
  const line = `[usage] ${parts.join(" · ")}`;
  // 配了预算、又有一半调用看不见 ⇒ 这行必须自己说破：否则"3k / 上限 100k"
  // 读起来像"还很安全"，而真实支出可能早就过了上限。
  return s.limit !== undefined && unmetered > 0
    ? `${line}；注意：${budgetBlindNote({ limit: s.limit, unmeasuredCalls: unmetered })}`
    : line;
}
