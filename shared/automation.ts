/**
 * 桌面定时任务（Automations，M5b）的**纯**逻辑：类型、字段校验、到期判定。
 *
 * 与 `schedule-core.ts` 的分工：那份管"间隔怎么解析、什么时候该触发、忙时等多久"
 * （headless serve 与桌面共用）；本文件管"一条自动化长什么样、哪几条现在到期"。
 * 调度环本身在 `electron/automations/`（定时器与 IO 在宿主层），这里只留可逐点
 * 审计的判定。
 *
 * 三条纪律：
 * 1. **坏记录跳过而不是抛错**（与 `session-store` 同款）：一条手改坏的 automation
 *    不该让整个列表打不开；
 * 2. **到期判定用 `nextDelayMs` 的同一口径**（`lastFiredMs + everyMs <= now`），
 *    不另造一套时间算术 —— 两套算术必然漂；
 * 3. **写盘前与读盘后是同一把尺子**（都走 `normalizeAutomationInput`）：否则
 *    落盘时放行的写法会在下次启动时被判坏，界面上的自动化凭空少几条。
 */

import { MIN_EVERY_MS, nextDelayMs } from "./schedule-core";

/** 一条桌面自动化。触发 = 跑指定项目的编排（复用 `orchestration:start` 的同一路径）。 */
export interface Automation {
  id: string;
  /** 人取的名字（界面列表主标识）。 */
  name: string;
  /** 触发哪个项目。项目必须已有分解结果（`batchesJson`），否则触发会失败并记账。 */
  projectId: string;
  /** 触发间隔（毫秒）。语义同 `schedule-core` 的 `--every`：下限 1s。 */
  everyMs: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * 上次**真正启动**的时间戳；缺席 = 从未触发，此时排程从 `updatedAt`（创建/启用/
   * 改间隔的时刻）起算一个间隔，见 `scheduleBaseMs`。
   */
  lastFiredMs?: number;
}

/** 使用者可编辑的三个字段（id 与时间戳由存储生成，不从这里进）。 */
export interface AutomationFields {
  name: string;
  projectId: string;
  everyMs: number;
}

/**
 * 触发历史的一条（`automations:history` 的返回项）。
 *
 * 来源是审计 JSONL 的 `automation` phase，字段在这里重命名成界面口径
 * （`automationOutcome` → `outcome`）：渲染层不该知道审计记录的完整字段表，
 * 那边加字段时也不该逼着界面跟着改。
 */
export interface AutomationHistoryEntry {
  ts: string;
  automationId?: string;
  automationName?: string;
  projectId?: string;
  /** `accepted`（已派发）/ `busy`（撞单飞闸跳过）/ `failed`（派不出去）。 */
  outcome: string;
  detail?: string;
}

export const AUTOMATION_NAME_MAX = 40;
export const AUTOMATION_ID_MAX = 64;

/** 名字上限：列表一行放不下长名，而"截断说破"比换行把表格撑散好。 */
export function normalizeName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return name === "" ? undefined : name.slice(0, AUTOMATION_NAME_MAX);
}

/**
 * 三个可编辑字段的**形状**归一化（不判范围）：名字截断、字符串 trim、
 * everyMs 只认安全整数（`1e21` 这种浮点数上的"整数"必须拒）。
 */
export function normalizeAutomationFields(raw: unknown): Partial<AutomationFields> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const name = normalizeName(r.name);
  const projectId = typeof r.projectId === "string" && r.projectId.trim() !== "" ? r.projectId.trim() : undefined;
  const everyMs = typeof r.everyMs === "number" && Number.isSafeInteger(r.everyMs) ? r.everyMs : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(everyMs !== undefined ? { everyMs } : {}),
  };
}

/**
 * 创建/更新入参的归一化，**同时是读盘的尺子**（`normalizeAutomation` 走它）。
 * 返回 `error` = 不能要；写盘前放行的写法，读盘时必须也放行。
 */
export function normalizeAutomationInput(raw: unknown): { input: AutomationFields } | { error: string } {
  const f = normalizeAutomationFields(raw);
  if (f.name === undefined) return { error: "名称不能为空" };
  if (f.projectId === undefined) return { error: "必须指定一个项目" };
  if (f.everyMs === undefined) return { error: "间隔必须是毫秒数（安全整数）" };
  // 间隔下限与 schedule-core 的 parseEvery 同口径：更小的值会让单 run 语义
  // 变成连续撞忙闸的空转（这是**配置错误**，写不进去也读不出来）。
  if (f.everyMs < MIN_EVERY_MS) return { error: `间隔不能小于 ${MIN_EVERY_MS}ms（1 秒）` };
  return { input: { name: f.name, projectId: f.projectId, everyMs: f.everyMs } };
}

/**
 * 归一化一条磁盘记录。返回 `null` = 这条不能要（调用方跳过它，并把这事实说破）。
 *
 * 字段判定整份委托 `normalizeAutomationInput`（同一把尺子），这里只补
 * id / 启停 / 时间戳这些**存储生成**的字段。
 */
export function normalizeAutomation(raw: unknown, now: number): Automation | null {
  const checked = normalizeAutomationInput(raw);
  if ("error" in checked) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() !== "" ? r.id.trim().slice(0, AUTOMATION_ID_MAX) : undefined;
  if (id === undefined) return null;
  const lastFiredMs = typeof r.lastFiredMs === "number" && Number.isFinite(r.lastFiredMs) ? r.lastFiredMs : undefined;
  return {
    id,
    ...checked.input,
    // 只有显式 true 才算启用："yes" / 1 / "false" 一律当停用 —— 启停是显式状态，
    // 没有"看起来开着"这种中间态。
    enabled: r.enabled === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
    ...(lastFiredMs !== undefined ? { lastFiredMs } : {}),
  };
}

/**
 * 排程基准时刻：触发过的看**上次触发点**，从未触发的看**最后一次修改**
 * （创建/启用/改间隔都会刷新它）。
 *
 * 为什么需要它：`nextDelayMs` 对"没有 lastFiredMs"的输入返回一个整间隔 ——
 * 直接拿去做到期判定会永远不得到点，调度环每轮醒来都发现"没到"，永远不触发。
 * 把"从未触发"折算成"从 updatedAt 起算一个间隔"，到期判定与剩余时间就回到
 * 同一个算术上（serve 的 fresh 分支是同一语义）。
 */
export function scheduleBaseMs(a: Automation): number {
  return a.lastFiredMs ?? a.updatedAt;
}

/**
 * 现在该触发的（启用中且已到点）。顺序稳定：按 `id` 字典序，避免同一时刻的触发
 * 顺序漂。
 *
 * 比较器刻意写成**两分支**（与本仓 zone-coverage / batch-guard 的同一写法）：
 * 三元的第三支（`a.id > b.id ? 1 : 0`）在实际排序里是死分支 —— 插入排序只在
 * 比较结果为负时交换，"把大于判成相等"与"判成大于"的行为完全一样，于是那一格
 * 成了等价变异（site 审计实测存活）。id 由 uuid 生成、天然唯一，两分支已是全序。
 */
export function dueAutomations(list: readonly Automation[], now: number): Automation[] {
  return list
    .filter((a) => a.enabled && nextDelayMs({ now, lastFiredMs: scheduleBaseMs(a), everyMs: a.everyMs }) === 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * 下一次该醒来的时刻（距现在的毫秒数）；没有启用的任务返回 `null`（调度环可以睡死）。
 *
 * 与 serve 的调度环同一个公式：不另造一套，避免两边对"漂移自校正"的解释不同。
 */
export function nextWakeDelayMs(list: readonly Automation[], now: number): number | null {
  let min: number | null = null;
  for (const a of list) {
    if (!a.enabled) continue;
    const d = nextDelayMs({ now, lastFiredMs: scheduleBaseMs(a), everyMs: a.everyMs });
    if (min === null || d < min) min = d;
  }
  return min;
}

/** 间隔的人话文案：整小时/整分才用大单位，其余说秒（"90 秒"不四舍五入成"2 分钟"）。 */
function formatEvery(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

/** 界面列表里的一行说明（"每 5 分钟 · 上次 3 分钟前 · 启用中"）。 */
export function describeAutomation(a: Automation, now: number): string {
  const last = a.lastFiredMs === undefined ? "从未触发" : `上次 ${Math.max(0, Math.round((now - a.lastFiredMs) / 1000))} 秒前`;
  return `每 ${formatEvery(a.everyMs)} · ${last} · ${a.enabled ? "启用中" : "已停用"}`;
}
