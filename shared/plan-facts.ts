/**
 * 规划备忘的「自动汇总可核事实」（2026-10-25，调研 §五 的待拍板项落地）。
 *
 * **它解决什么**：人写的 `OX-PLAN.md` 回答"我们决定了什么"，但它要人记得写；而
 * **"这个项目上一轮为什么红过"是落盘事实，不需要谁记**。规划时把这类事实摆出来，
 * 就少一次"上一次同一条验证命令已经挂过三次，这次再拆一遍还是同样的坑"。
 *
 * **它绝不是什么（这条比功能本身重要）**：
 * · **不是学习**。不写回 `OX-PLAN.md`，不修改任何文件，不参与任何决策 —— 只读地
 *   渲染成一段提示。人在备忘里写的才是"决定"，这里只有"账"。
 * · **不是模型自述**。每一条都能追到一条审计记录；本模块只做**聚合**，不做推断
 *   （"所以你应该…"一个字都不写，那是规划大脑的活）。
 * · **不是时间序列**。块里不出现任何绝对时间戳 —— 见下面"可复现性"。
 *
 * **可复现性（这是本项最大的设计约束）**：同一条需求 × 同一份审计输入，必须产出
 * **逐字相同**的块。所以：
 *   · 不印时间戳（"3 天前失败过"过一夜就变，而规划没有任何理由依赖这个）;
 *   · 不按出现顺序、按**固定的键序**（错误类字母序、zone 字母序）；
 *   · 不取"最近 N 条"而取"最近一个 run" —— 窗口边界一旦随时间滑动，同一份历史
 *     在不同时刻会给出不同答案。
 * 这三条让"规划提示里有什么"只取决于**事实**，不取决于**读的时机**。
 */
import type { PlanSnapshot } from "./plan-history";

/**
 * 审计记录里本模块会用到的那几个字段。
 *
 * 刻意用结构化子集而不是整个 `AuditRecord`：这层的判据挂在 `shared/`（禁 node 内建、
 * 禁反向依赖宿主层），而 `AuditRecord` 住在 `electron/`。宿主负责把记录喂进来。
 */
export interface FactRecord {
  phase: string;
  ok?: boolean;
  errorClass?: string;
  zone?: string;
  conflictKind?: string;
  remedy?: string;
  changed?: number;
}

/** 事实块的标记（与"人写的备忘"区分开：一个是决定，一个是账）。 */
export const PLAN_FACTS_MARKER = "【规划参考：上一轮的可核事实（来自审计落盘，非决定）】";

/** 事实块的字符上限（与备忘块共用同一套纪律：超限截断并说破）。 */
export const MAX_PLAN_FACTS_CHARS = 2000;

/** 每个维度最多列几项（超出只报"还有 N 项"，不摊开）。 */
const MAX_LISTED = 6;

export interface PlanFacts {
  /** 有失败的派发次数与总派发次数。 */
  dispatched: number;
  failed: number;
  /** 失败按原因聚合（键 = errorClass，已排序）。 */
  failuresByClass: Array<{ errorClass: string; count: number }>;
  /** 越权/漂移冲突按种类聚合（已排序）。 */
  conflictsByKind: Array<{ kind: string; count: number }>;
  /** 被仲裁处置的次数（回滚/隔离等；已排序）。 */
  remedies: Array<{ remedy: string; count: number }>;
  /** 上一版 PRD 拆出的任务数（有规划快照时才有）。 */
  lastTaskCount?: number;
}

/**
 * 从审计记录里数出可核事实。
 *
 * `records` 只应包含**本项目**的记录（宿主按 projectId 过滤后喂进来 —— 跨项目汇总
 * 会把 A 项目的坑算到 B 头上，而那正是"自动汇总"最容易犯的错）。
 */
export function collectPlanFacts(records: readonly FactRecord[], lastPlan?: PlanSnapshot): PlanFacts {
  let dispatched = 0;
  let failed = 0;
  const byClass = new Map<string, number>();
  const byKind = new Map<string, number>();
  const byRemedy = new Map<string, number>();

  for (const r of records) {
    if (r.phase === "run-start") {
      dispatched += 1;
      continue;
    }
    if (r.phase === "run-end") {
      // `ok === false` 才算失败：`undefined` 是"没报结论"（腰斩），不能算成失败，
      // 也不能算成成功 —— 那是两件事，见 `trailBriefForRepair` 的同一条纪律。
      if (r.ok === false) {
        failed += 1;
        const cls = r.errorClass ?? "unknown";
        byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
      }
      continue;
    }
    if (r.phase === "batch-guard") {
      const kind = r.conflictKind;
      if (kind !== undefined) byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      const remedy = r.remedy;
      if (remedy !== undefined) byRemedy.set(remedy, (byRemedy.get(remedy) ?? 0) + 1);
    }
  }

  // 键序**必须固定**：JS 的 Map 迭代顺序是插入序，而插入序取决于审计记录的写入顺序
  // —— 同一批事实换个顺序写就换个输出，"可复现"就没了。显式排序是这里唯一正确的做法。
  const failuresByClass = [...byClass.entries()]
    .map(([errorClass, count]) => ({ errorClass, count }))
    .sort((a, b) => a.errorClass.localeCompare(b.errorClass));
  const conflictsByKind = [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const remedies = [...byRemedy.entries()]
    .map(([remedy, count]) => ({ remedy, count }))
    .sort((a, b) => a.remedy.localeCompare(b.remedy));

  return {
    dispatched,
    failed,
    failuresByClass,
    conflictsByKind,
    remedies,
    ...(lastPlan ? { lastTaskCount: lastPlan.taskCount } : {}),
  };
}

/**
 * 有没有值得说的事实（全零时调用方不该产块）。
 *
 * ⚠️ 刻意**不写** `failuresByClass.length > 0` 这一项：只要 `failed > 0`，那条链上
 * 每一次失败都必然被计进某个 errorClass（缺类的落 `unknown`），所以它是恒被蕴含的
 * 冗余合取项。写上去等于给变异测试造一个**改不改都观察不到**的位点 —— 2026-10-25
 * 首次 site 审计当场抓到两处 `|| → &&` 存活，正是这个形态。按「能简化就简化」删掉。
 */
function hasFacts(facts: PlanFacts): boolean {
  return facts.failed > 0 || facts.conflictsByKind.length > 0 || facts.remedies.length > 0;
}

/**
 * 把事实渲染成一个提示块；没有值得说的事实 → 空串（不产空标题）。
 *
 * 措辞纪律：**只陈述账，不给建议**。"所以这次要避开 X"那种句子属于规划大脑，
 * 平台写进去就等于把它自己的推断伪装成事实。
 */
export function formatPlanFactsBlock(facts: PlanFacts): string {
  if (!hasFacts(facts)) return "";
  const lines: string[] = [
    PLAN_FACTS_MARKER,
    "以下事实来自这个项目的审计落盘（只读、可核）。它们是**账**，不是决定 ——",
    "这次的拆法仍然由你按需求决定；这些数字只说明上一轮踩过什么。",
  ];

  if (facts.dispatched > 0) {
    lines.push(`- 历史派发 ${facts.dispatched} 次，其中判失败 ${facts.failed} 次`);
  }
  if (facts.failuresByClass.length > 0) {
    lines.push(`- 失败按原因：${renderCounts(facts.failuresByClass, "errorClass")}`);
  }
  if (facts.conflictsByKind.length > 0) {
    lines.push(`- zone 越权/共享漂移拦下：${renderCounts(facts.conflictsByKind, "kind")}`);
  }
  if (facts.remedies.length > 0) {
    lines.push(`- 仲裁处置：${renderCounts(facts.remedies, "remedy")}`);
  }
  if (facts.lastTaskCount !== undefined) {
    lines.push(`- 上一版 PRD 拆出 ${facts.lastTaskCount} 个任务`);
  }

  const full = lines.join("\n");
  if (full.length <= MAX_PLAN_FACTS_CHARS) return full;
  const kept = full.slice(0, MAX_PLAN_FACTS_CHARS);
  return (
    `${kept}\n` +
    `（已截断：事实块原文共 ${full.length} 字符，上限 ${MAX_PLAN_FACTS_CHARS}。）`
  );
}

/** 渲染 "键 × 次数" 串；超过上限只列前面几项并说破"还有 N 项"。 */
function renderCounts(
  rows: ReadonlyArray<Record<string, string | number>>,
  keyName: string,
): string {
  const view = rows.map((row) => `${String(row[keyName])} × ${row.count}`);
  if (view.length <= MAX_LISTED) return view.join("、");
  const rest = view.length - MAX_LISTED;
  return `${view.slice(0, MAX_LISTED).join("、")}（另有 ${rest} 项未列出）`;
}
