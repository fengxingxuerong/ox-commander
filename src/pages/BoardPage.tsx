import { useApp } from "../store";
import { STAGE_ORDER } from "../../shared/types";

const STAGE_LABELS: Record<string, string> = {
  PRD: "① 需求理解",
  PLANNING: "② 任务分解",
  DEVELOPMENT: "③ 并行开发",
  VERIFICATION: "④ 硬性验证",
  DELIVERY: "⑤ 集成交付",
  DONE: "✅ 已交付",
};

export function BoardPage() {
  const stage = useApp((s) => s.stage);
  const tasks = useApp((s) => s.tasks);
  const logs = useApp((s) => s.logs);
  const verification = useApp((s) => s.verification);
  const escalations = useApp((s) => s.escalations);
  const start = useApp((s) => s.startOrchestration);
  const cancel = () => void window.oxCommander.cancel();
  const pause = () => void window.oxCommander.pause();
  const resume = () => void window.oxCommander.resume();
  const setPage = useApp((s) => s.setPage);

  const taskList = Object.values(tasks);

  return (
    <div className="page board">
      <header className="board-header">
        <button onClick={() => setPage("projects")}>← 项目列表</button>
        <h2>任务看板</h2>
      </header>

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
                </span>
              </div>
            ))}
          </section>
        </aside>

        {/* 中栏：实时日志流 */}
        <main className="col col-center">
          <section className="card log-card">
            <h3>执行日志</h3>
            <pre className="log-view">{logs.join("\n") || "等待开始…"}</pre>
          </section>
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

          {verification && (
            <section className="card">
              <h3>最近验证：{verification.passed ? "✅ 通过" : "❌ 未通过"}</h3>
              {verification.results.map((r) => (
                <p key={r.kind}>
                  {r.kind}: {r.ok ? "通过" : `失败 (exit=${r.exitCode})`} ·{" "}
                  {(r.durationMs / 1000).toFixed(1)}s
                </p>
              ))}
            </section>
          )}

          {escalations.length > 0 && (
            <section className="card escalation">
              <h3>⚠️ 需要你决策</h3>
              {escalations.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
