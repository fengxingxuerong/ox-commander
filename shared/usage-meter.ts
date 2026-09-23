import type { ChatRequest, ChatResponse } from "./providers";
import type { LlmClient } from "./llm-client";

/**
 * Token 用量的**采集与汇总**（纯逻辑，不碰 node/DOM）。
 *
 * 为什么要有这个文件：`usageTokens` 一直在 `http-clients.ts` 里被采集
 * （OpenAI 兼容层读 `usage.total_tokens`、Anthropic 层把 input+output 相加），
 * 也在 `providers.ts` 里被声明过 —— 但**全仓没有任何读取方**：
 * 既没有汇总，也没有上限，一次长跑烧掉多少配额只能靠翻服务商账单。
 *
 * 这一轮只做**可见性**（谁用了多少、有多少次没上报），不做中断。
 * 上限（`maxTokensPerRun`）留到下一轮，届时只需在这里加一个阈值判定，
 * 无需再动采集链路。
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
}

/**
 * 进程内累加器。刻意**不**做单次上限、不做持久化 —— 它的职责只有"数得对"。
 *
 * 对脏数据的处理是刻意收紧的：`undefined` / `NaN` / `Infinity` / 负数
 * 一律**不计入 total**，只把 `calls` 加上去。理由是把 `NaN` 累进总量会让
 * 之后所有汇总都变成 `NaN`（且不会报错），负数则会静默抵掉真实用量 ——
 * 两者都会让"可见性"变成假的。
 */
export class UsageMeter {
  private total = 0;
  private calls = 0;
  private measured = 0;
  private readonly byModel = new Map<string, number>();

  record(sample: UsageSample): void {
    this.calls += 1;
    const tokens = sample.usageTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return;
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
    };
  }
}

/**
 * 把任意 `LlmClient` 包一层计量。
 *
 * 只包**最外层**客户端：`FailoverLlmClient` 内部那些 route 客户端不该再各包一层，
 * 否则一次调用会被记 N 次（重试/线路轮换时尤其明显）。所以调用方约定：
 * 包在"调用者真正持有的那个 client"上，不要包在 http-clients 的工厂里。
 *
 * 抛错的调用**不记录** —— `calls` 的语义是"成功拿到响应的次数"，
 * 把失败也算进去会让"平均每次消耗"这类推导失真。
 */
export function meteredLlm(inner: LlmClient, meter: UsageMeter): LlmClient {
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
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
  return `[usage] ${parts.join(" · ")}`;
}
