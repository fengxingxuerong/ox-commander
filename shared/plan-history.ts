/**
 * 规划历史（形态 B，2026-10-25）：每次规划落一条**可核快照**，下一次规划注入
 * "上一版摘要与本次差异"。
 *
 * **为什么先有备忘（形态 A）还要这一层**：备忘是**人写的**——它回答"我们决定了什么"，
 * 但人不一定每次都写，也未必记得住"上次需求是什么、改到哪一步了"。这一层回答的是
 * **可核事实**：这一版需求是这句、拆出来的是这几个任务、上一次拆的是什么、差在哪。
 *
 * **为什么落在审计事实而不是新文件**：审计 JSONL 已经是本仓库"跨 run 唯一可信的账本"
 * （`AuditPhase` 的 `stage` / `receipt` / `automation` 都在用它）。再开一份新存储
 * 等于再造一个真源，而两份真源必然漂。数据源是落盘事实，不是模型自述 —— 这是与
 * "让模型记住上次"最根本的区别：**模型的自述不可核，落盘快照可核**。
 *
 * **这一层只放纯判定**（双端可测、零 IO）：把审计记录收敛成历史、把两次快照算出
 * 差异、把差异渲染成一个提示块。读盘与写法在宿主侧（`electron/ipc/orchestration.ts`）。
 */

/**
 * 一条规划快照里**值得跨 run 记住**的东西。
 *
 * 刻意不含完整 PRD 正文：PRD 已经落在项目记录的 `prdJson` 里，审计再存一份会把
 * JSONL 撑大（每行 2 MiB 轮转预算），而"上次拆成哪些任务"用标题就够了 —— 需要细节
 * 时人去看 `prdJson` 与工程日志。摘要的意义是**指路**，不是备份。
 */
export interface PlanSnapshot {
  /** ISO 时刻（审计记录自带）。 */
  ts: string;
  /** 这一版的原始需求（截断后的摘要，见 `planSnapshotOf`）。 */
  requirement: string;
  /** PRD 的目标句。 */
  goal: string;
  /** 任务标题清单（顺序即 planner 给的顺序）。 */
  taskTitles: string[];
  /** 任务数：清单被截断时，这个数仍是完整的。 */
  taskCount: number;
  /** 需求指纹（同一句需求重规划时，差异为"没改"）。 */
  requirementHash: string;
  /** 模型产出的 feature 条数（判据里"拆得够不够细"的粗指标）。 */
  featureCount: number;
}

/** 保留几条历史：再多也不会让"上次 vs 这次"更有用，只会挤占提示预算。 */
export const MAX_PLAN_HISTORY = 5;

/** 快照里需求文本的截断上限（审计行要省着用）。 */
export const PLAN_SNAPSHOT_REQUIREMENT_CHARS = 400;

/** 任务标题最多记几条（规划上限 3–10 个任务，这里给足）。 */
export const PLAN_SNAPSHOT_MAX_TITLES = 12;

/** 提示里"上次规划"这一块的标记。 */
export const PLAN_HISTORY_MARKER = "【上次规划（可核事实，来自审计落盘）】";

/** 这一块注入的字符上限（与背景总预算分开算，由 `composeBackground` 统一收口）。 */
export const MAX_PLAN_HISTORY_CHARS = 2000;

/**
 * 需求指纹：32 位 FNV-1a。
 *
 * 为什么不用 crypto：这一层是 `shared/`（禁 node 内建），而指纹的唯一用途是
 * **判断"需求有没有改"** —— 不是安全用途，碰撞概率够低即可（同一份需求必然同指纹，
 * 不同需求碰撞的后果只是把"改过"说成"没改"，而注入块里同时给了需求原文摘要，
 * 人能自己看出来）。字符串指纹也就不会随审计行增长。
 */
export function requirementFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // FNV-1a 的 32 位乘法：先乘再取低 32 位（`Math.imul` 保证不丢精度）。
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 从一次规划的三个事实（需求 / PRD / 任务清单）造一条快照。
 *
 * 纯函数且**不 trim 需求**：指纹必须对同一份原文稳定，两处各 trim 一次就会漂
 * （一边去掉尾换行、一边没去，同一个需求算出两个指纹 = "改过"的假象）。
 */
export function planSnapshotOf(input: {
  ts: string;
  requirement: string;
  prd: { goal?: string; features?: readonly string[] };
  tasks: ReadonlyArray<{ title?: string }>;
}): PlanSnapshot {
  const requirement = input.requirement.slice(0, PLAN_SNAPSHOT_REQUIREMENT_CHARS);
  // 三个取值都按"缺席即空"收口：调用方可能拿着**未过 `parsePrd` 的**对象
  // （宿主在 PRD 校验之前就想留一份现场、或渲染层传来的形状还没被收窄）。
  // 快照是背景，让一条残缺的 PRD 把一次规划搞崩，比"历史少一版"严重得多。
  return {
    ts: input.ts,
    requirement,
    goal: input.prd.goal ?? "",
    taskTitles: input.tasks.slice(0, PLAN_SNAPSHOT_MAX_TITLES).map((t) => t.title ?? ""),
    taskCount: input.tasks.length,
    requirementHash: requirementFingerprint(input.requirement),
    featureCount: (input.prd.features ?? []).length,
  };
}

/**
 * 从审计记录里挑出规划快照，最新的在前。
 *
 * 只认 `phase === "plan"` 且字段齐全的记录：**字段缺失的老记录一律跳过**，
 * 不猜、不补默认值 —— 残缺的"上次规划"比没有更糟（人会以为那就是全部事实）。
 */
export function planHistoryOf(
  records: ReadonlyArray<{
    phase: string;
    ts: string;
    plan?: PlanSnapshot;
  }>,
  limit: number = MAX_PLAN_HISTORY,
): PlanSnapshot[] {
  const out: PlanSnapshot[] = [];
  for (const record of records) {
    if (record.phase !== "plan") continue;
    const snapshot = record.plan;
    if (!snapshot) continue;
    // 反向遍历太脆（记录顺序由写入方决定），这里按 ts 降序自己排 —— 同一 ts 时
    // 稳定保持原顺序（后写的不该顶掉先写的，除非它真的更新）。
    out.push(snapshot);
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out.slice(0, Math.max(0, limit));
}

/** 两次规划之间**可核**的差异。 */
export interface PlanDiff {
  /** 需求文本变了（指纹不同）。 */
  requirementChanged: boolean;
  /** 任务数：上次 → 这次。 */
  taskCountBefore: number;
  taskCountAfter: number;
  /** 这次新增的任务标题（按本次顺序）。 */
  added: string[];
  /** 这次不再出现的任务标题。 */
  removed: string[];
}

/** 算出"上次 → 这次"的差异；没有上次时返回 `undefined`。 */
export function planDiffOf(previous: PlanSnapshot | undefined, current: PlanSnapshot): PlanDiff | undefined {
  if (!previous) return undefined;
  const before = new Set(previous.taskTitles);
  const after = new Set(current.taskTitles);
  return {
    requirementChanged: previous.requirementHash !== current.requirementHash,
    taskCountBefore: previous.taskCount,
    taskCountAfter: current.taskCount,
    added: current.taskTitles.filter((t) => !before.has(t)),
    removed: previous.taskTitles.filter((t) => !after.has(t)),
  };
}

/**
 * 把上次规划 + 差异渲染成一个提示块；没有上次时返回空串（不产空标题）。
 *
 * 口径写在块内：**这是落盘事实，不是模型的记忆**，也不是"这次该怎么做"的建议 ——
 * 它只回答"上次是什么、变在哪"，避免下一次规划在不知情的情况下把已经商量好的
 * 取舍推翻重来。
 */
export function formatPlanHistoryBlock(
  previous: PlanSnapshot | undefined,
  diff: PlanDiff | undefined,
): string {
  if (!previous) return "";
  const lines: string[] = [
    PLAN_HISTORY_MARKER,
    "以下是这个项目**上一次规划**的落盘事实（不是建议，也不代表那次已交付）：",
    `- 上次需求摘要：${previous.requirement.trim() === "" ? "（空）" : previous.requirement.trim()}`,
    `- 上次目标：${previous.goal.trim() === "" ? "（空）" : previous.goal.trim()}`,
    `- 上次拆出 ${previous.taskCount} 个任务：${previous.taskTitles.join("、") || "（无）"}`,
    `- 上次 PRD 有 ${previous.featureCount} 条 feature`,
  ];
  if (diff) {
    lines.push(
      `- 与这次相比：需求${diff.requirementChanged ? "**已改动**" : "未变"}；` +
        `任务数 ${diff.taskCountBefore} → ${diff.taskCountAfter}`,
    );
    if (diff.added.length > 0) lines.push(`- 这次新增的任务：${diff.added.join("、")}`);
    if (diff.removed.length > 0) lines.push(`- 这次不再出现的任务：${diff.removed.join("、")}`);
  }
  lines.push(
    "如果上次的取舍仍然成立，请保持一致的拆法；如果这次要推翻它，请在 PRD 里让目标或验收标准显出差别。",
  );
  const full = lines.join("\n");
  if (full.length <= MAX_PLAN_HISTORY_CHARS) return full;
  // 超限截断并说破（与约定 / 备忘同一套纪律：静默截断会让人以为自己看全了）。
  const kept = full.slice(0, MAX_PLAN_HISTORY_CHARS);
  return (
    `${kept}\n` +
    `（已截断：上次规划块原文共 ${full.length} 字符，上限 ${MAX_PLAN_HISTORY_CHARS}。）`
  );
}
