/**
 * serve 定时运行的核心判定（2026-10-11 竞品刷新第五轮，学 Orca 的 scheduled
 * automations；刷新文档 §五 排定的下一候选）。
 *
 * 形态：serve 常驻进程带 `--every=<间隔> --spec=<spec.json>` 启动后，按间隔
 * 自投递 `POST /run`（127.0.0.1 自调用）—— 409（上一次还没跑完）即跳过本轮，
 * 全部既有语义（SSE 广播、鉴权、单 run 语义、验证）零改动复用。
 *
 * 调度语义（刻意简单，边界说破）：
 * - **首次触发在一个间隔之后**，不是启动即跑（操作者要立刻跑一次，自己 POST 就行）；
 * - **中断补跑至多一次**：带 `--schedule-state` 时，上次触发时间落盘；重启发现
 *   停机期间错过了触发点，启动时补跑一次 —— 补的是"最近错过的一次"，不是
 *   按间隔把错过的全补齐（编排器一次只跑一个 run，积压补齐没有意义）；
 * - **忙时跳过不积压**：上一 run 未结束时到点的触发直接放弃，本轮不计入
 *   已触发 —— 短重试（min(间隔, 30s)）后若已空闲则正常触发；
 * - 状态落盘是增强不是权威：坏账（缺文件/损坏）一律当"从未触发"。
 *
 * 本文件是纯逻辑（间隔解析、参数解析、补跑判定、忙时重试间隔），不含 IO 与
 * 定时器 —— 那两样在 serve-main 的装配里，注入后可测。
 */

export interface ScheduleArgs {
  everyMs: number;
  specFile: string;
  /** 触发时间戳的落盘文件；缺省 = 不持久化（每次重启当"从未触发"，无补跑）。 */
  stateFile?: string;
}

export interface ScheduleState {
  lastFiredMs?: number;
}

/** 忙时跳过后的重试等待上限：间隔再长，空闲后的补触发也不该等满一个整间隔。 */
export const BUSY_RETRY_CAP_MS = 30_000;

/** 间隔下限：低于 1s 的"定时"只会把单 run 语义打成连续撞 409 的空转。 */
export const MIN_EVERY_MS = 1_000;

/**
 * 解析 `--every` 的值：`750`（毫秒）、`750ms`、`30s`、`5m`、`1h`。
 * 下限 `MIN_EVERY_MS`（1s）——更小的值是配置错误，报错而不是照办。
 */
export function parseEvery(raw: string): { everyMs?: number; error?: string } {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) {
    return { error: `--every 无法解析：${JSON.stringify(raw)}（可用：毫秒数 / 30s / 5m / 1h）` };
  }
  const n = Number(m[1]);
  // 两道分开的闸（合并成 || 会让位点不可杀）：
  // · 安全整数闸拦**超长数字串**——Number.isInteger(1e25) 是 true（浮点上没有
  //   小数部分），拦不住；isSafeInteger 才拦得住；
  // · 正数闸拦 "0"。
  if (!Number.isSafeInteger(n)) {
    return { error: `--every 数值溢出：${JSON.stringify(raw)} 超出安全整数范围` };
  }
  if (n <= 0) {
    return { error: `--every 需要正整数，实际收到：${JSON.stringify(raw)}` };
  }
  const unit = m[2] ?? "ms";
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const everyMs = n * scale;
  // 上限闸：Node 的 setTimeout 上限是 2^31-1 ms（约 24.8 天），更大的 delay 会
  // 被运行时退化成立即触发 —— "1 年后跑一次"这种配置必须当场报错，而不是
  // 变成每次事件循环都撞一次的自残循环。
  if (everyMs > 2_147_000_000) {
    return { error: `--every 间隔过大（${everyMs}ms）：上限 2147000000ms（约 24.8 天，Node setTimeout 的极限）` };
  }
  if (everyMs < MIN_EVERY_MS) {
    return { error: `--every 间隔过小（${everyMs}ms）：下限 ${MIN_EVERY_MS}ms，更小只会连续撞 409` };
  }
  return { everyMs };
}

/**
 * 从 argv 解析定时参数。与 `portFromArgv` 同一纪律：`--every` / `--spec` /
 * `--schedule-state` 的**拼写错误必须报错**，静默忽略会让操作者以为定时已生效。
 * `--every` 与 `--spec` 成对出现（缺一即报错）——"定了间隔没给内容"与
 * "给了内容没定间隔"都不是可用的配置。
 */
export function parseScheduleArgs(argv: string[]): { schedule?: ScheduleArgs; error?: string } {
  // 拼写错误侦察**先行**：词干匹配（--ev/--sp/--sc）但不完全匹配的参数一律报错
  // —— 词干要短到能逮住 "--spez" 这类中间字母打错的旗标；"--spez" 并不以
  // "--spec" 开头，用全名前缀侦察会漏掉它。本解析器只认四个旗标（--port 由
  // portFromArgv 管辖区分），所以词干放宽不会误伤别的参数。
  const typoFamilies: ReadonlyArray<{ stem: RegExp; exact: RegExp; hint: string }> = [
    { stem: /^--ev/i, exact: /^--every(?:=.*)?$/i, hint: "--every=<30s|5m|1h|毫秒>" },
    { stem: /^--sp/i, exact: /^--spec(?:=.*)?$/i, hint: "--spec=<spec.json 路径>" },
    { stem: /^--sc/i, exact: /^--schedule-state(?:=.*)?$/i, hint: "--schedule-state=<状态文件>" },
  ];
  for (const a of argv) {
    const s = String(a);
    for (const fam of typoFamilies) {
      if (fam.stem.test(s) && !fam.exact.test(s)) {
        return { error: `无法识别的参数：${JSON.stringify(s)}（正确写法：${fam.hint}）` };
      }
    }
  }
  const read = (name: string): { raw?: string; error?: string } => {
    const re = new RegExp(`^--${name}(?:=(.*))?$`);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i] ?? "";
      const m = re.exec(a);
      if (!m) continue;
      const raw = m[1] ?? argv[i + 1];
      if (raw === undefined || raw === "") {
        return { error: `--${name} 需要一个值，实际收到：空` };
      }
      return { raw };
    }
    return {};
  };
  const every = read("every");
  const spec = read("spec");
  const state = read("schedule-state");
  const firstError = every.error ?? spec.error ?? state.error;
  if (firstError) return { error: firstError };

  if (every.raw === undefined && spec.raw === undefined) return {};
  if (every.raw === undefined) return { error: "--spec 需要与 --every 成对出现（只给了内容没定间隔）" };
  if (spec.raw === undefined) return { error: "--every 需要与 --spec 成对出现（定了间隔没给内容）" };
  const parsed = parseEvery(every.raw!);
  if (parsed.error) return { error: parsed.error };
  return {
    schedule: {
      everyMs: parsed.everyMs!,
      specFile: spec.raw!,
      ...(state.raw !== undefined ? { stateFile: state.raw } : {}),
    },
  };
}

/**
 * 启动时的补跑判定：`fresh`（从未触发）等一个间隔；停机期间错过的（now 已
 * 越过上一次触发点 + 间隔）补一次；否则按 `nextDelayMs` 正常排程。
 */
export function decideStartupCatchup(input: {
  now: number;
  lastFiredMs?: number;
  everyMs: number;
}): { fire: boolean; reason: "fresh" | "catchup" | "wait" } {
  if (input.lastFiredMs === undefined) return { fire: false, reason: "fresh" };
  return input.now - input.lastFiredMs >= input.everyMs
    ? { fire: true, reason: "catchup" }
    : { fire: false, reason: "wait" };
}

/** 忙时跳过后的重试等待：短间隔原样重试，长间隔封顶 `BUSY_RETRY_CAP_MS`。 */
export function busyRetryMs(everyMs: number): number {
  return Math.min(everyMs, BUSY_RETRY_CAP_MS);
}

/** 距下一次该触发的毫秒数（按上次触发点 + 间隔推算，漂移自校正；从未触发 = 一个间隔）。 */
export function nextDelayMs(input: { now: number; lastFiredMs?: number; everyMs: number }): number {
  if (input.lastFiredMs === undefined) return input.everyMs;
  return Math.max(0, input.lastFiredMs + input.everyMs - input.now);
}
