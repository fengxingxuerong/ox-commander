/**
 * 循环输出检测（2026-10-11 竞品刷新，吸收 agentguard-llm 的 loop 检测思路，
 * 闭环 2026-10-02 刷新遗留的「loop detection 专项」软挂起项）。
 *
 * 它补的是心跳补不上的那半边观测盲区：idle 超时只能抓「不出声的挂死」，而
 * **在出声但原地打转**的 run（同一行日志反复刷）每条事件都在续约心跳、idle
 * 永远不到、deadline 要烧满才收场——agent 活着，token 与墙钟在空转。
 *
 * 判据（刻意保守）：
 * - 只数**连续**且 trim 后**逐字相同**的行。行内数字不抹平：带时间戳/序号的
 *   心跳是「活着」的证据，逐字不变才是卡死的形状；
 * - 短于 minLineLength 的行跳过且**不清零**（进度条碎屑夹在重复行之间不算打断）；
 * - 一条不同的长行出现即重数。
 *
 * 已知边界（v1 刻意不做）：交替两行的循环（A B A B…）不判——那需要滑窗指纹，
 * 误伤面（表格、清单类规整输出）大得多。误判的代价可控：中止的 digest 写明
 * 原因与那行内容，任务进修复轮，路由可换执行器重试。
 */
export interface LoopDetectionOptions {
  /** 连续相同行数达到该值判为循环；默认 8（下限 2）。 */
  threshold?: number;
  /** 短于该长度（trim 后）的行不参与计数；默认 16（下限 1）。 */
  minLineLength?: number;
}

export interface LoopFinding {
  /** 触发重复的那一行（trim 后）。 */
  repeatedLine: string;
  /** 触发时的连续次数。 */
  count: number;
}

const DEFAULT_THRESHOLD = 8;
const DEFAULT_MIN_LINE_LENGTH = 16;

export class LoopDetector {
  private readonly threshold: number;
  private readonly minLineLength: number;
  private lastLine: string | undefined;
  private runCount = 0;
  private tripped = false;

  constructor(opts: LoopDetectionOptions = {}) {
    this.threshold = Math.max(2, opts.threshold ?? DEFAULT_THRESHOLD);
    this.minLineLength = Math.max(1, opts.minLineLength ?? DEFAULT_MIN_LINE_LENGTH);
  }

  /**
   * 喂一条事件文本（可含多行）。触发时返回发现；之后保持触发——同一发现
   * 重复返回，让调用方不必自己记「已经中止过」。
   */
  observe(text: string): LoopFinding | undefined {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length < this.minLineLength) continue;
      if (line === this.lastLine) {
        this.runCount += 1;
      } else {
        this.lastLine = line;
        this.runCount = 1;
      }
      if (!this.tripped && this.runCount >= this.threshold) {
        this.tripped = true;
        return { repeatedLine: line, count: this.runCount };
      }
    }
    return this.tripped ? { repeatedLine: this.lastLine!, count: this.runCount } : undefined;
  }
}

/** 调度器装配助手：`false` = 关闭；缺省 = 默认参数开启。 */
export function createLoopDetector(opts?: LoopDetectionOptions | false): LoopDetector | undefined {
  if (opts === false) return undefined;
  return new LoopDetector(opts);
}
