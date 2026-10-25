import type { EscalationView, ApprovalView } from "./types";
import type { FailureClass, TaskStatus } from "../shared/types";

/**
 * 看板「该你了」注意力分组（竞品刷新第六轮排期第 1 项，2026-10-25）。
 *
 * 解决的问题：看板把所有事实都摆出来了（任务状态、升级卡、审批队列），但操作者
 * 回到工位时要自己扫一遍"哪件在等我"。Orchestrator.inc 的启示是把这一步做成
 * **派生泳道**（Working / Needs you / …）；本项目的最小形态是一条**注意力条**：
 * 纯函数从看板已有事实里把"不来就卡住"的事按优先级摆出来。
 *
 * 判据与 `electron/notify-rules.ts` 同一哲学（"不来就卡住"才配打扰人）但**数据源
 * 不同**：通知吃的是瞬时事件（弹过就过），这里吃的是**看板当前状态**（人在看板前
 * 时随取随算）—— 所以是两份判据而不是一份复用：把事件判据套在状态上会把"已经
 * 处理过的"也报出来。
 *
 * 纯函数、无 IO 无时钟：同一份看板状态进去，同一条注意力条出来。
 */

/** 分组条目。kind 决定排序优先级（数组序即优先级：裁决 > 审批 > 失败 > 中断）。 */
export type AttentionKind = "escalation" | "approval" | "failed-task" | "interrupted";

export interface AttentionItem {
  kind: AttentionKind;
  /** 一行人类可读的"什么事在等你"；只陈述事实，不带操作指令（操作在卡上）。 */
  label: string;
  /** 关联任务（interrupted 是全局标记，没有 taskId）。 */
  taskId?: string;
}

/** 看板侧的输入形状：只取判据要看的字段（宽进，不绑死在完整 AppState 上）。 */
export interface AttentionBoardShape {
  tasks: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    errorClass?: FailureClass;
  }>;
  escalations: EscalationView[];
  approvals: ApprovalView[];
  /** 来自 recovery 视图的中断标记：有任务没有收尾（进程被腰斩过）。 */
  interrupted?: boolean;
}

/** 排序键：kind 优先级（数组序）+ taskId 升序兜底 —— 同一份状态在任何机器上同一行序。 */
const KIND_ORDER: Record<AttentionKind, number> = {
  escalation: 0,
  approval: 1,
  "failed-task": 2,
  interrupted: 3,
};

export function attentionOf(board: AttentionBoardShape): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 升级卡没回 = run 挂在原地（三选一裁决不答，后面全是等待）—— 最优先。
  for (const e of board.escalations) {
    if (e.resolved) continue;
    items.push({
      kind: "escalation",
      label: `「${e.taskId}」在等三选一裁决：${e.summary}`,
      taskId: e.taskId,
    });
  }
  // 命令审批 fail-closed：问不到人就不执行 —— 与升级卡同级的"不来就卡住"。
  for (const a of board.approvals) {
    if (a.resolved) continue;
    items.push({
      kind: "approval",
      label: `命令在等审批：${[a.command, ...a.args].join(" ").trim()}`,
    });
  }
  // 失败且静止的任务：终态 failed 且没有挂在升级卡上（有卡的上面已报，不重复喊）。
  const escalated = new Set(board.escalations.filter((e) => !e.resolved).map((e) => e.taskId));
  for (const t of board.tasks) {
    if (t.status !== "failed" || escalated.has(t.taskId)) continue;
    items.push({
      kind: "failed-task",
      label: `「${t.title}」失败${t.errorClass !== undefined ? `（${t.errorClass}）` : ""}，在等处置`,
      taskId: t.taskId,
    });
  }
  // 中断标记：进程被腰斩过 —— 历史事实，但它解释了"为什么有任务一直不动"。
  if (board.interrupted) {
    items.push({ kind: "interrupted", label: "上一轮进程被中断过：有任务没有收尾" });
  }

  return items.sort((a, b) =>
    KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]
      ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      : (a.taskId ?? "") < (b.taskId ?? "")
        ? -1
        : 1,
  );
}

/** 注意力条的第一行：N 件事；0 件返回 undefined（调用方据此整条不渲染）。 */
export function attentionHeadline(items: AttentionItem[]): string | undefined {
  if (items.length === 0) return undefined;
  return `该你了：${items.length} 件事`;
}
