import { useCallback, useEffect, useState } from "react";
import type { AuditExportResult, AuditRecordView } from "../types";

const PHASE_LABELS: Record<AuditRecordView["phase"], string> = {
  "run-start": "run 开始",
  "run-end": "run 结束",
  "batch-guard": "批次守卫",
  "agent-change": "智能体变更",
  settings: "设置",
};

/** 读多少条。上限在主进程侧被夹到 1000，这里取一个够看又不拖慢渲染的数。 */
const LIMIT = 200;

/** 一条记录里最多念几个路径；总数用 pathsTotal 兜住，避免"看着只有 3 个"。 */
const PATH_PREVIEW = 3;

/**
 * 审计日志面板。
 *
 * 为什么要有它：审计记录一直都写（`electron/audit-log.ts`），`audit:recent` 与
 * `audit:files` 两个通道也早就注册并暴露到了 preload —— 但**没有任何页面调用它们**，
 * 于是"哪个智能体改了哪些文件"这份只有审计日志里有的事实，用户根本拿不到，
 * 只能自己翻 JSONL。这是典型的"引擎有、UI 没有"。
 *
 * 导出通道的授权模型：渲染层从不指名路径，另存对话框本身就是授权，
 * 主进程因此不需要路径白名单。导出的是原始 JSONL（逐行不改写）——
 * 它是要拿去做证据的，重新序列化会抹掉那些让人 grep 原始文件的细节。
 *
 * 不做分页 —— 记录上限本来就在主进程被夹住，翻页的价值低于它带来的状态复杂度。
 */
export function AuditPanel() {
  const [records, setRecords] = useState<AuditRecordView[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [phase, setPhase] = useState<AuditRecordView["phase"] | "all">("all");
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<AuditExportResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [recent, names] = await Promise.all([
        window.oxCommander.recentAudit(LIMIT),
        window.oxCommander.auditFiles(),
      ]);
      setRecords(recent);
      setFiles(names);
      setError(null);
    } catch (err) {
      // 读不出来要说出来：静默失败与"确实没有记录"长得一模一样。
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runExport = async () => {
    setExporting(true);
    try {
      // 上一次的结果先收起来：连点两次时，旧文案不能假装是这一次的结果。
      setExportResult(null);
      setExportResult(await window.oxCommander.exportAudit());
    } finally {
      setExporting(false);
    }
  };

  // `read()` 返回的是 newest last，而面板要最新在上。
  const visible = records
    .filter((r) => (phase === "all" || r.phase === phase) && (!onlyFailures || r.ok === false))
    .slice()
    .reverse();

  // 按 agentId 折叠成一行成功/失败：操作者先想知道"哪只手最不稳"，
  // 而不是在几十条记录里逐条数。聚合跟随当前筛选（所见即所统）——
  // 若统计范围与列表不一致，任何一行数字都需要额外解释才能相信。
  // run 起止没有 agentId：它们是 run 级事实，不是某只手的，不进聚合。
  const perAgent = new Map<string, { ok: number; fail: number }>();
  for (const r of visible) {
    if (!r.agentId) continue;
    const s = perAgent.get(r.agentId) ?? { ok: 0, fail: 0 };
    if (r.ok === true) s.ok += 1;
    else if (r.ok === false) s.fail += 1;
    perAgent.set(r.agentId, s);
  }
  const agentStats = [...perAgent.entries()]
    .map(([id, s]) => ({ id, ...s }))
    // 失败多的排前面，其次成功多的；同分按 id 稳定排序，避免每次刷新顺序抖动。
    .sort((a, b) => b.fail - a.fail || b.ok - a.ok || a.id.localeCompare(b.id));

  return (
    <section className="card">
      <h3>审计日志</h3>
      <p className="muted">
        run 的开始与结束、批次守卫的越权裁决、智能体的注册与注销都记在这条 JSONL 里，重启不丢 ——
        看板上的日志只活在内存里，重载即消失。当前共 {files.length} 个文件
        {files.length > 0 ? `：${files.join("、")}` : ""}
      </p>

      <div className="btn-row">
        <label>
          阶段{" "}
          <select
            value={phase}
            onChange={(e) => setPhase(e.target.value as AuditRecordView["phase"] | "all")}
          >
            <option value="all">全部</option>
            {(Object.keys(PHASE_LABELS) as AuditRecordView["phase"][]).map((p) => (
              <option key={p} value={p}>
                {PHASE_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyFailures}
            onChange={(e) => setOnlyFailures(e.target.checked)}
          />{" "}
          只看失败
        </label>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
        <button onClick={() => void runExport()} disabled={exporting}>
          {exporting ? "导出中…" : "导出 JSONL"}
        </button>
      </div>

      {exportResult?.ok && <p className="ok-text">已导出到 {exportResult.path}</p>}
      {exportResult && !exportResult.ok && exportResult.reason === "canceled" && (
        <p className="muted">已取消导出。</p>
      )}
      {exportResult && !exportResult.ok && exportResult.reason !== "canceled" && (
        <p className="bad-text" role="alert">
          导出失败：{exportResult.reason}
        </p>
      )}

      {error && (
        <p className="bad-text" role="alert">
          读取审计日志失败：{error}
        </p>
      )}

      {agentStats.length > 0 && (
        <ul className="plain-list muted">
          {agentStats.map((s) => (
            <li key={s.id}>
              {s.id}：成功 {s.ok} · 失败 {s.fail}
            </li>
          ))}
        </ul>
      )}

      {!error && visible.length === 0 && (
        <p className="muted">{records.length === 0 ? "还没有审计记录。" : "没有符合筛选条件的记录。"}</p>
      )}

      <ul className="plain-list">
        {visible.map((r, i) => (
          <li key={`${r.ts}-${r.phase}-${i}`}>
            <code>{formatTs(r.ts)}</code> · {PHASE_LABELS[r.phase]}
            {r.runId ? ` · run ${shortId(r.runId)}` : ""}
            {r.taskId ? ` · 任务 ${shortId(r.taskId)}` : ""}
            {r.agentId ? ` · ${r.agentId}` : ""}
            {r.zone ? ` · ${r.zone}` : ""}
            {r.ok !== undefined ? ` · ${r.ok ? "成功" : "失败"}` : ""}
            {r.errorClass ? ` · ${r.errorClass}` : ""}
            {r.durationMs !== undefined ? ` · ${r.durationMs}ms` : ""}
            {r.changed !== undefined ? ` · 变更 ${r.changed} 个文件` : ""}
            {r.paths && r.paths.length > 0 ? (
              <>
                {" · "}
                {r.paths.slice(0, PATH_PREVIEW).join("、")}
                {(r.pathsTotal ?? r.paths.length) > PATH_PREVIEW
                  ? ` 等 ${r.pathsTotal ?? r.paths.length} 个`
                  : ""}
              </>
            ) : (
              ""
            )}
            {r.detail ? ` · ${r.detail}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `2026-09-26T03:12:04.123Z` → `2026-09-26 03:12:04`。
 *
 * 直接用 ISO 串切片而不是 `toLocaleString`：后者随宿主语种与时区变化，
 * 同一个时间戳在不同机器上长得不一样，既不可测也让"哪条更早"变得难比。
 * 显示的是 UTC —— 与文件里写的是同一个钟，人工比对 JSONL 时不用换算。
 */
function formatTs(ts: string): string {
  return ts.replace("T", " ").slice(0, 19);
}

/**
 * runId / taskId 太长会把一行撑到换行，这里截短。
 *
 * 截**尾部**而不是头部：runId 形如 `run-<编号>`，公共前缀吃掉前四位，
 * 截头部会让两次不同的 run 显示成同一个串（`run-0000…`）——看着像同一条记录。
 * 区分度全在后面那几位。
 */
function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}
