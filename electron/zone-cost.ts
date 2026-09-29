import type { AuditRecord } from "./audit-log";
import type { Task } from "../shared/types";

/**
 * 共享工作区这套「zone 互斥」到底付出了什么代价 —— 从审计事实算出来。
 *
 * 为什么要有它：竞品（Orca / vibe-kanban / claude-squad …… 实测 15 个里 12 个）
 * 走的是 git worktree 物理隔离，本项目走共享工作区 + zone 互斥。那是一条少数派
 * 路线，**主张必须拿数字说话**，否则会被读成"没做隔离"。
 *
 * 这里只算**我们这边真实发生的量**（越权多少次、处置了什么、串行了多少批）。
 * 刻意不算 worktree 那边的数字：那需要真的跑一遍另一种架构，而一次对照实验的
 * 结论高度依赖任务集与机器 —— 编一个"节省 X%"比不报更坏。报告里给出的是
 * **口径**（两边各自的代价项分别是什么），数字只报自己这一侧实测的部分。
 *
 * 纯函数、无 IO 无时钟：同一批记录进去，同一份数字出来。
 */
export interface ZoneConflictSummary {
  /** 越权事件数（一次判定一条，同一路径被两个 run 命中算两次）。 */
  total: number;
  byKind: Record<string, number>;
  byRemedy: Record<string, number>;
  /** 去重后的涉及路径数。 */
  paths: number;
  /** 其中被真正处置掉的（回滚 / 隔离）路径数。 */
  handledPaths: number;
}

export interface ZoneCostSummary {
  /** 观察到的 run 次数（run-start 条数）。 */
  runs: number;
  /** 涉及的任务数。 */
  tasks: number;
  conflicts: ZoneConflictSummary;
  /** 每个 run 平均多少次越权；没有 run 事实时不给这个键。 */
  conflictsPerRun?: number;
}

/** 会把文件真的挪走/还原的处置；其余（pass / fail-batch）文件留在原地。 */
const HANDLING_REMEDIES = new Set(["revert", "quarantine"]);

/**
 * 排序后的条目：同一份事实在不同机器上必须打印出同一行。
 *
 * 比较器刻意**只有两个分支**（没有"相等返回 0"那一格）：键来自 Map，必然互异，
 * 那一格不可达；留着它会让变异面多出一个"内层三元互换"位点，而那个变异在
 * V8 小数组的二分插入排序下是**行为等价**的（它只看 `< 0`）—— 一个杀不死的
 * 位点比没有位点更糟：它让人以为那里有守卫。
 */
function sortedEntries(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function toRecord(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries(sortedEntries(m));
}

export function summarizeZoneCost(records: AuditRecord[]): ZoneCostSummary {
  let runs = 0;
  const tasks = new Set<string>();
  let total = 0;
  const byKind = new Map<string, number>();
  const byRemedy = new Map<string, number>();
  const paths = new Set<string>();
  const handled = new Set<string>();

  for (const record of records) {
    if (record.phase === "run-start") {
      runs += 1;
      if (record.taskId) tasks.add(record.taskId);
      continue;
    }
    if (record.phase !== "batch-guard") continue;
    total += 1;
    // 老记录没有这两个字段（本模块落地之前的越权只走事件流）—— 归到 unknown /
    // none 而不是丢掉：丢掉会让"曾经发生过"这件事从历史里消失。
    const kind = record.conflictKind ?? "unknown";
    const remedy = record.remedy ?? "none";
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    byRemedy.set(remedy, (byRemedy.get(remedy) ?? 0) + 1);
    for (const p of record.paths ?? []) {
      paths.add(p);
      if (HANDLING_REMEDIES.has(remedy)) handled.add(p);
    }
  }

  return {
    runs,
    tasks: tasks.size,
    conflicts: {
      total,
      byKind: toRecord(byKind),
      byRemedy: toRecord(byRemedy),
      paths: paths.size,
      handledPaths: handled.size,
    },
    // 分母为零时不给这个键：0/0 不是"零越权率"，是"没有可算的分母"。
    ...(runs > 0 ? { conflictsPerRun: total / runs } : {}),
  };
}

export interface PlanCost {
  /** 批次数量（串行段数）。 */
  batches: number;
  tasks: number;
  /**
   * 相对"全部并行"多出来的串行段数。
   *
   * zone 互斥的代价就长在这里：没有冲突时所有任务一批跑完，每多一批就是一段
   * 只能干等的墙钟。它不是"损失的时间"，是**并行度被切了几刀**。
   */
  extraBatches: number;
  /** 最大的一批有多少任务（实际并行宽度）。 */
  largestBatch: number;
}

/**
 * 规划期的并行度代价。
 *
 * 输入是 `planBatches` 的产物（批 → 任务），所以它量的是**互斥规则切了几刀**，
 * 与运行时是否真的越权无关 —— 两件事要分开看：批次是预防，越权是漏网。
 */
export function planCost(batches: Task[][]): PlanCost {
  return {
    batches: batches.length,
    tasks: batches.reduce((n, b) => n + b.length, 0),
    extraBatches: batches.length > 0 ? batches.length - 1 : 0,
    largestBatch: batches.reduce((n, b) => (b.length > n ? b.length : n), 0),
  };
}

/** 打印成人能读的几行；脚本与看板日志共用，不留第二份措辞。 */
export function formatZoneCostReport(
  cost: ZoneCostSummary,
  plan?: PlanCost,
): string[] {
  const lines: string[] = [];
  lines.push(`run ${cost.runs} 次 · 任务 ${cost.tasks} 个`);
  if (plan) {
    lines.push(
      `批次 ${plan.batches} 段（最多并行 ${plan.largestBatch} 个任务）· ` +
        `相对全并行多出 ${plan.extraBatches} 段串行 —— 这就是 zone 互斥切下去的刀数`,
    );
  }
  lines.push(
    `越权 ${cost.conflicts.total} 次` +
      (cost.conflictsPerRun !== undefined
        ? `（每 run ${cost.conflictsPerRun.toFixed(2)} 次）`
        : "") +
      ` · 涉及路径 ${cost.conflicts.paths} 个 · 其中 ${cost.conflicts.handledPaths} 个已处置`,
  );
  for (const [kind, n] of sortedEntries(new Map(Object.entries(cost.conflicts.byKind)))) {
    lines.push(`  · ${kind}: ${n}`);
  }
  for (const [remedy, n] of sortedEntries(new Map(Object.entries(cost.conflicts.byRemedy)))) {
    lines.push(`  · 处置 ${remedy}: ${n}`);
  }
  return lines;
}
