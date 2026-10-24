import type { DeliveryReceipt } from "../shared/delivery-receipt";

/**
 * 跨 run / 跨项目的 token 成本聚合（C4 · 2026-10-24）。
 *
 * 为什么要有它：用量此前只有**两个面** —— run 进行中的 `usage` 协议事件，与
 * 凭据里那一行总量。跑完之后，"哪条线路最费、哪个项目最贵"就没人答得上来
 * （竞品 cezar 有 "Usage & cost by project"）。数据源是落盘凭据：桌面项目库
 * 每个项目留**最新一份**，headless/导出的凭据文件可以整目录喂进来。
 *
 * 口径纪律（与 `usage-meter` 同源）：
 * - 只统计**端点上报过**的用量；`unmetered`（calls − measuredCalls）必须与总量
 *   同行出现 —— 它是这份数字的可信边界，不是脚注。
 * - `byModel` 只从**带着明细**的凭据累加（`detailed` 是分母）；旧凭据（本字段
 *   落地之前）与新跑的无明细 run 都不进这张表，也不装作 0。
 * - **按任务的归因今天不存在于任何持久事实里**：凭据的 usage 是 run 级，
 *   把 run 级总量摊到任务头上就是编数字。报告把这句话打出来，而不是沉默。
 *
 * 纯函数、无 IO 无时钟：同一批凭据进去，同一份报告出来。
 */
export interface UsageCostProject {
  /** 凭据的来源标签：项目名（store 模式）或文件名（receipts 模式）。 */
  label: string;
  outcome: string;
  totalTokens: number;
  calls: number;
  /** `calls − measuredCalls` 之和：端点没上报用量的调用次数。 */
  unmetered: number;
  /** 该凭据带 `byModel` 明细时的逐线路账，按 token 降序；缺席时键不出现。 */
  models?: Array<{ key: string; tokens: number }>;
}

export interface UsageCostSummary {
  /** 读到的凭据份数（解析成功并进入了聚合的）。 */
  receipts: number;
  /** 解析失败被拒收的份数 —— 说破而不是吞掉。 */
  broken: number;
  totalTokens: number;
  calls: number;
  unmetered: number;
  /** 其中带 `byModel` 明细的凭据份数：byModel 表的分母边界。 */
  detailed: number;
  /** `provider/model → token` 跨凭据累加，token 降序、同数按 key 升序。 */
  byModel: Array<{ key: string; tokens: number }>;
  /** 每份凭据一行，label 升序 —— 同一批事实在不同机器上打印同一行。 */
  byProject: UsageCostProject[];
}

/** 解析失败也进结果（label + 原因），聚合侧只数个数不打印 —— 措辞单源在 format。 */
export interface UsageCostInput {
  label: string;
  /** 凭据 JSON 文本；解析失败按 broken 计。 */
  receiptJson: string;
}

function isReceiptLike(value: unknown): value is DeliveryReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    "outcome" in value &&
    typeof (value as { outcome: unknown }).outcome === "string"
  );
}

/** 模型表排序：token 降序，同数 key 升序 —— 两个键完全决定顺序，结果确定。 */
function sortModelRows(rows: Array<{ key: string; tokens: number }>): Array<{ key: string; tokens: number }> {
  return rows.sort((a, b) => (b.tokens !== a.tokens ? (b.tokens < a.tokens ? -1 : 1) : a.key < b.key ? -1 : 1));
}

export function summarizeUsageCost(inputs: UsageCostInput[]): UsageCostSummary {
  let receipts = 0;
  let broken = 0;
  let totalTokens = 0;
  let calls = 0;
  let unmetered = 0;
  let detailed = 0;
  const byModelMap = new Map<string, number>();
  const byProject: UsageCostProject[] = [];

  for (const input of inputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.receiptJson);
    } catch {
      broken += 1;
      continue;
    }
    if (!isReceiptLike(parsed)) {
      broken += 1;
      continue;
    }
    receipts += 1;
    const usage = parsed.usage;
    const row: UsageCostProject = {
      label: input.label,
      outcome: parsed.outcome,
      totalTokens: usage?.totalTokens ?? 0,
      calls: usage?.calls ?? 0,
      unmetered: usage ? usage.calls - usage.measuredCalls : 0,
    };
    totalTokens += row.totalTokens;
    calls += row.calls;
    unmetered += row.unmetered;
    // 有 usage 段但没有 byModel（旧凭据 / 全程无上报）⇒ 不进模型表，也不给 models 键：
    // 明细缺席要在报告里可见（detailed 分子），而不是以 0 的姿态混进排名。
    if (usage && usage.byModel && Object.keys(usage.byModel).length > 0) {
      detailed += 1;
      const models: Array<{ key: string; tokens: number }> = [];
      for (const [key, tokens] of Object.entries(usage.byModel)) {
        byModelMap.set(key, (byModelMap.get(key) ?? 0) + tokens);
        models.push({ key, tokens });
      }
      row.models = sortModelRows(models);
    }
    byProject.push(row);
  }

  byProject.sort((a, b) => (a.label < b.label ? -1 : 1));
  return {
    receipts,
    broken,
    totalTokens,
    calls,
    unmetered,
    detailed,
    byModel: sortModelRows([...byModelMap.entries()].map(([key, tokens]) => ({ key, tokens }))),
    byProject,
  };
}

/** 打印成人能读的几行；脚本与看板日志共用，不留第二份措辞。 */
export function formatUsageCostReport(s: UsageCostSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `凭据 ${s.receipts} 份 · token ${s.totalTokens} · 调用 ${s.calls} 次` +
      (s.unmetered > 0 ? ` · ${s.unmetered} 次未上报用量（总数是下界）` : "") +
      (s.broken > 0 ? ` · 解析失败 ${s.broken} 份（未计入）` : ""),
  );
  lines.push(`按模型（来自 ${s.detailed}/${s.receipts} 份带明细的凭据）：`);
  if (s.byModel.length === 0) {
    lines.push("  （没有凭据带 byModel 明细 —— 旧凭据与无上报的 run 都不进这张表，不装作 0）");
  }
  for (const m of s.byModel) {
    lines.push(`  · ${m.key}: ${m.tokens}`);
  }
  lines.push("按凭据（label 升序）：");
  for (const p of s.byProject) {
    const parts = [`  · ${p.label}: ${p.outcome} · ${p.totalTokens} tokens · ${p.calls} 次`];
    if (p.unmetered > 0) parts.push(`${p.unmetered} 次未上报`);
    lines.push(parts.join(" · "));
  }
  lines.push(
    "按任务的归因今天不存在于任何持久事实里（凭据的 usage 是 run 级）—— 这里不摊派、不估算。",
  );
  return lines;
}
