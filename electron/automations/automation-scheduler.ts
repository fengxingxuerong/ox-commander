import { busyRetryMs } from "../../shared/schedule-core";
import { dueAutomations, nextWakeDelayMs, type Automation } from "../../shared/automation";

/**
 * 桌面自动化的调度环（M5b）：到点触发指定项目的编排，忙时跳过不积压。
 *
 * 语义与 headless serve 的定时环**逐条对齐**（`startScheduleLoop`）—— 两处都是
 * "单飞闸 + 忙跳过 + 短重试 + 漂移自校正"，不另造一套：
 * - **首次触发在一个间隔之后**，不是启动即跑（要立刻跑一次，界面上有"立即运行"）；
 * - **停机补跑至多一次**：重启时已到点的（`dueAutomations` 与
 *   `decideStartupCatchup` 对单条任务判定等价）启动即触发一次；
 * - **忙时跳过不积压**：撞上单飞闸（另一项目在跑）就放弃本轮、不计已触发，
 *   短重试（min(间隔, 30s)）后若已空闲则正常触发；
 * - **失败不计数**：派不出去（项目没计划等）同样不计已触发，短重试后再试；
 * - **触发点按"上次触发 + 间隔"推算**（漂移自校正），不是固定节拍。
 *
 * 定时器与 IO 全在宿主层（本文件只做判定 + 组装）：`list` / `trigger` /
 * `markFired` 由 IPC 层注入（store 与编排单飞闸的接线在 `ipc/automations.ts`），
 * 时钟与定时器可注入，于是整个环能在测试里用手动泵驱动，不 sleep。
 */

/** 触发结果三态：`accepted`=已派发（落时间戳）/ `busy`=撞单飞闸（跳过）/ `failed`=派不出去。 */
export type TriggerOutcome = "accepted" | "busy" | "failed";

export interface AutomationSchedulerOptions {
  /** 当前全部自动化。每次判定都重读（store 是同步读盘，代价可忽略）。 */
  list: () => Automation[];
  /** 触发一条自动化。返回三态；抛错按 failed 处理（环不能死）。 */
  trigger: (a: Automation) => Promise<TriggerOutcome>;
  /** 记一次真正启动的时间戳（写失败由调用方接住记账，这里照抛）。 */
  markFired: (id: string, now: number) => void;
  /** 人类可读的调度日志（生产传 logLine：实时日志流统一过脱敏）。 */
  log: (text: string) => void;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export class AutomationScheduler {
  private readonly opts: AutomationSchedulerOptions;
  private readonly now: () => number;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;

  private timer: unknown;
  private stopped = false;
  private started = false;
  /**
   * 跳过（忙/失败）后欠下的短重试间隔；无欠账 = null。
   * 欠账期间**只认它**（serve 同口径）：失败的任务 `nextDelayMs` 仍是 0（未计数），
   * 若取 min 会立刻重试，把"稍后重试"变成tight loop。
   */
  private retryDelay: number | null = null;

  constructor(opts: AutomationSchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** 启动：已到点的（停机期间错过的）先补跑一次，然后进入常规排程。幂等。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const missed = dueAutomations(this.opts.list(), this.now());
    if (missed.length > 0) {
      this.opts.log(
        `[automation] 停机期间错过触发点（${missed.map((a) => a.name).join("、")}），启动补跑一次`,
      );
    }
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** 列表变了（增删改/启停）：按新表重排。欠着的短重试不清 —— 它与列表变化无关，下次 tick 自会结算。 */
  reschedule(): void {
    if (this.stopped) return;
    this.plan();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimeoutImpl(this.timer);
      this.timer = undefined;
    }
  }

  private plan(): void {
    if (this.stopped) return;
    this.clearTimer();
    const delay = this.retryDelay ?? nextWakeDelayMs(this.opts.list(), this.now());
    // 没有启用的任务：调度环睡死，等 reschedule() 叫醒（新建/启停都会叫）。
    if (delay === null) return;
    this.timer = this.setTimeoutImpl(() => void this.tick(), Math.max(0, delay));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const due = dueAutomations(this.opts.list(), this.now());
    let skipped = false;
    for (const a of due) {
      let outcome: TriggerOutcome;
      try {
        outcome = await this.opts.trigger(a);
      } catch (err) {
        // 触发器自己抛错（不是返回 failed）：当失败处理并说破，环不能死。
        outcome = "failed";
        this.opts.log(`[automation] ${a.name} 触发异常：${(err as Error).message}`);
      }
      if (outcome === "accepted") {
        const firedAt = this.now();
        this.opts.log(`[automation] 触发 ${a.name}：项目 ${a.projectId} 的编排已启动`);
        try {
          this.opts.markFired(a.id, firedAt);
        } catch (err) {
          // 账本写不下去不能改判"没触发"——运行已经起来了。只说破，并欠一次
          // 短重试：否则 store 里的 lastFiredMs 仍是旧值，plan 会算出 0 延迟，
          // 把"记账失败"变成每轮事件循环都真触发一次的自旋。
          skipped = true;
          this.opts.log(`[automation] ${a.name} 的触发时间记账失败：${(err as Error).message}`);
        }
        continue;
      }
      skipped = true;
      if (outcome === "busy") {
        this.opts.log(`[automation] 上一次运行还没结束，${a.name} 本轮跳过`);
        // 单飞闸是全局的：后面的到点任务现在触发也只会撞同一道闸，不逐个撞。
        break;
      }
      this.opts.log(`[automation] ${a.name} 触发失败（不计已触发，稍后重试）`);
    }
    this.retryDelay = skipped ? busyRetryMs(Math.min(...due.map((a) => a.everyMs))) : null;
    this.plan();
  }
}
