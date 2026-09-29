import { useEffect, useRef, useState } from "react";
import { useApp, REMEDY_VERB } from "../store";
import { AuditPanel } from "../components/AuditPanel";
import { STAGE_ORDER } from "../../shared/types";
import { usageFact } from "../../shared/usage-meter";

const STAGE_LABELS: Record<string, string> = {
  PRD: "① 需求理解",
  PLANNING: "② 任务分解",
  DEVELOPMENT: "③ 并行开发",
  VERIFICATION: "④ 硬性验证",
  DELIVERY: "⑤ 集成交付",
  DONE: "✅ 已交付",
};

/** Failure classes from the audit layer, in operator language. */
const ERROR_LABELS: Record<string, string> = {
  auth: "密钥/鉴权",
  "rate-limit": "限流",
  timeout: "超时",
  protocol: "协议/输出格式",
  conflict: "zone 越权",
  resource: "资源",
  "no-agent": "无可用智能体",
  unknown: "未知",
};

export function BoardPage() {
  const stage = useApp((s) => s.stage);
  const tasks = useApp((s) => s.tasks);
  const logs = useApp((s) => s.logs);
  const verification = useApp((s) => s.verification);
  const receipt = useApp((s) => s.receipt);
  const usage = useApp((s) => s.usage);
  const escalations = useApp((s) => s.escalations);
  const resolveEscalation = useApp((s) => s.resolveEscalation);
  const interrupted = useApp((s) => s.interrupted);
  const lastActivityTs = useApp((s) => s.lastActivityTs);
  const loadRecovery = useApp((s) => s.loadRecovery);
  const start = useApp((s) => s.confirmAndExecute);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const cancel = () => void window.oxCommander.cancel();
  const pause = () => void window.oxCommander.pause();
  const resume = () => void window.oxCommander.resume();
  const setPage = useApp((s) => s.setPage);
  // 用量事实的判定（可信边界、盲区提示、模型排序）都在 usageFact 里，UI 只负责摆。
  const fact = usage ? usageFact(usage) : undefined;
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // Board recovery: on mount, rebuild the view from the durable audit trail
  // (facts/derived split). Idempotent — the store merge is additive, and the
  // live push events keep overwriting from here on.
  useEffect(() => {
    void loadRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);
  // Terminal behavior: the log view follows new output, unless the operator
  // has scrolled up to inspect history — then pinning pauses until they
  // scroll back near the bottom.
  const logRef = useRef<HTMLPreElement>(null);
  const logPinnedRef = useRef(true);
  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    logPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && logPinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);
  const openWorkspace = async () => {
    if (!activeProjectId) return;
    setWorkspaceError(null);
    try {
      await window.oxCommander.openWorkspace(activeProjectId);
    } catch (err) {
      setWorkspaceError((err as Error).message);
    }
  };

  const taskList = Object.values(tasks);

  return (
    <div className="page board">
      <header className="board-header">
        <button onClick={() => setPage("projects")}>← 项目列表</button>
        <h2>任务看板</h2>
        <button onClick={() => void openWorkspace()} title="在资源管理器中打开工作区目录">
          📂 打开工作区
        </button>
        {workspaceError && <span className="error-text">{workspaceError}</span>}
      </header>

      {interrupted && (
        <div className="recovery-banner" role="alert">
          ⚠️ 上一次运行未正常收尾（进程被中断），以下为审计日志恢复的当时进度。
          {lastActivityTs ? ` 最后活动时间：${new Date(lastActivityTs).toLocaleString()}` : ""}
        </div>
      )}

      <div className="board-columns">
        {/* 左栏：阶段进度 + 任务列表（DAG 分组） */}
        <aside className="col col-left">
          <section className="card">
            <h3>流水线阶段</h3>
            <ol className="stage-list">
              {STAGE_ORDER.map((s) => (
                <li key={s} className={s === stage ? "current" : ""}>
                  {STAGE_LABELS[s] ?? s}
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h3>任务</h3>
            {taskList.length === 0 && <p className="muted">尚未分解</p>}
            {taskList.map((t) => (
              <div key={t.taskId} className={`task-row status-${t.status}`}>
                <span className="task-title">{t.title}</span>
                <span className="task-meta">
                  {t.zone} · 第 {t.attempts} 次
                  {t.agentId ? ` · ${t.agentId}` : ""}
                  {t.durationMs !== undefined ? ` · ${(t.durationMs / 1000).toFixed(1)}s` : ""}
                </span>
                {t.status === "failed" && t.errorClass && (
                  <span className="task-meta error-class">错误类型：{ERROR_LABELS[t.errorClass] ?? t.errorClass}</span>
                )}
                {t.status === "failed" && t.failureDigest && (
                  <details className="failure-details">
                    <summary>❌ 失败原因</summary>
                    <pre>{t.failureDigest}</pre>
                  </details>
                )}
              </div>
            ))}
          </section>
        </aside>

        {/* 中栏：实时日志流 + 落盘审计。执行日志只活在内存里、重载即消失，
            审计日志回答的是"上一次到底发生过什么"（run 起止、批次守卫裁决）且重启不丢。
            两份事实放同一栏：操作者盯着的正是这里，不用换页去设置里翻 JSONL。 */}
        <main className="col col-center">
          <section className="card log-card">
            <h3>执行日志</h3>
            <pre ref={logRef} onScroll={handleLogScroll} className="log-view">{logs.join("\n") || "等待开始…"}</pre>
          </section>
          <AuditPanel />
        </main>

        {/* 右栏：验证结果 / 升级提示 / 控制 */}
        <aside className="col col-right">
          <section className="card">
            <h3>控制</h3>
            <div className="btn-row">
              <button className="primary" onClick={() => void start()}>
                开始
              </button>
              <button onClick={pause}>暂停</button>
              <button onClick={resume}>继续</button>
              <button className="danger" onClick={cancel}>
                取消
              </button>
            </div>
          </section>

          {/* 本次运行的 token 用量。`calls - measuredCalls`（端点没上报用量的次数）
              必须和总数一起显示 —— 否则"3k tokens"会被读成全部支出。 */}
          {fact && (
            <section className="card">
              <h3>本次运行用量</h3>
              <p className="task-meta">{fact.summary}</p>
              {fact.limit !== undefined && <p className="task-meta">预算上限 {fact.limit} tokens</p>}
              {fact.blindNote ? <p className="muted">{fact.blindNote}</p> : null}
            </section>
          )}

          {/* 交付凭据：一次运行唯一的对外结论。放在验证结果**之上** —— 验证回答
              "哪些命令红了"，凭据回答"这次到底交付了什么、凭什么"。 */}
          {receipt && (
            <section className="card">
              <h3>{receipt.outcome === "delivered" ? "📦 交付凭据" : "🚧 未交付"}</h3>
              <p className="muted">{receipt.headline}</p>
              <p className="task-meta">
                {receipt.counts.done}/{receipt.counts.total} 完成 · 跳过 {receipt.counts.skipped} ·
                失败 {receipt.counts.failed} · 未启动 {receipt.counts.pending} · 重修 {receipt.rounds} 轮
              </p>
              <ul>
                {receipt.checks.map((c, i) => (
                  <li key={`${c.kind}-${i}`} className="task-meta">
                    {c.ok ? "✅" : "❌"} {c.kind}
                    {c.ok ? "" : `（exit=${c.exitCode ?? "null"}）`}
                    {c.preexisting ? " · 本次运行前就已失败" : ""}
                    {c.headline ? ` · ${c.headline}` : ""}
                  </li>
                ))}
              </ul>
              {receipt.conflicts.length > 0 && (
                <details className="failure-details">
                  <summary>越权 {receipt.conflicts.length} 次（已处置）</summary>
                  {receipt.conflicts.map((c, i) => (
                    <p key={`${c.kind}-${i}`} className="task-meta">
                      {REMEDY_VERB[c.remedy] ?? c.remedy} · {c.kind} · {c.paths.join("、")}
                    </p>
                  ))}
                </details>
              )}
              {receipt.usage && (
                <p className="task-meta">
                  {receipt.usage.totalTokens} tokens · {receipt.usage.calls} 次调用
                  {receipt.usage.calls - receipt.usage.measuredCalls > 0
                    ? `（${receipt.usage.calls - receipt.usage.measuredCalls} 次未上报用量）`
                    : ""}
                </p>
              )}
            </section>
          )}

          {verification && (
            <section className="card">
              <h3>最近验证：{verification.passed ? "✅ 通过" : "❌ 未通过"}</h3>
              {verification.results.map((r) => (
                <div key={r.kind}>
                  <p>
                    {r.kind}: {r.ok ? "通过" : `失败 (exit=${r.exitCode})`} ·{" "}
                    {(r.durationMs / 1000).toFixed(1)}s
                  </p>
                  {!r.ok && r.logDigest && (
                    <details className="failure-details">
                      <summary>查看错误详情</summary>
                      <pre>{r.logDigest}</pre>
                    </details>
                  )}
                </div>
              ))}
            </section>
          )}

          {escalations.length > 0 && (
            <section className="card escalation">
              <h3>⚠️ 需要你决策</h3>
              {escalations.map((e) => (
                <div key={e.taskId} className="escalation-item">
                  <pre className="escalation-summary">{e.summary}</pre>
                  {e.resolved ? (
                    <p className="muted">已处理</p>
                  ) : (
                    <div className="btn-row">
                      <button onClick={() => void resolveEscalation(e.taskId, "skip")} title="放弃该任务，继续交付其余部分">
                        跳过
                      </button>
                      <button className="primary" onClick={() => void resolveEscalation(e.taskId, "redispatch")} title="追加一轮修复并重派">
                        重派一次
                      </button>
                      <button className="danger" onClick={() => void resolveEscalation(e.taskId, "abort")} title="终止整个项目执行">
                        终止
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
