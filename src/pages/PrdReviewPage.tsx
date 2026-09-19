import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import type { PrdDocument, Task } from "../../shared/types";

type EditState = {
  goal: string;
  features: string[];
  techStack: string[];
  acceptanceCriteria: string[];
};

function toEdit(prd: PrdDocument): EditState {
  return {
    goal: prd.goal,
    features: [...prd.features],
    techStack: [...prd.techStack],
    acceptanceCriteria: [...prd.acceptanceCriteria],
  };
}

function StringList({
  title,
  items,
  onChange,
}: {
  title: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="edit-list">
      <h4>{title}</h4>
      {items.map((item, i) => (
        <div className="edit-row" key={i}>
          <input
            value={item}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            className="danger small"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...items, ""])}>
        ＋ 添加一项
      </button>
    </div>
  );
}

function TaskCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="task-detail">
      <div className="task-detail-head" onClick={() => setOpen(!open)}>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {task.zone} · {task.suggestedRole} · {open ? "收起 ▲" : "详情 ▼"}
        </span>
      </div>
      {open && (
        <div className="task-detail-body">
          <p>{task.description}</p>
          <p className="muted">依赖：{task.dependencies.length ? task.dependencies.join(", ") : "无"}</p>
        </div>
      )}
    </div>
  );
}

export function PrdReviewPage() {
  const prd = useApp((s) => s.prd);
  const batches = useApp((s) => s.batches);
  const planning = useApp((s) => s.planning);
  const planningError = useApp((s) => s.planningError);
  const logs = useApp((s) => s.logs);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const confirmAndExecute = useApp((s) => s.confirmAndExecute);
  const backToProjects = useApp((s) => s.backToProjects);
  const retryPlanning = useApp((s) => s.retryPlanning);
  const updatePrd = useApp((s) => s.updatePrd);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  // 规划日志自动跟随新输出（终端行为）
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  if (!prd || planningError) {
    return (
      <div className="page">
        <header className="page-header">
          <button onClick={backToProjects}>← 返回项目列表</button>
          <h1>规划{planning ? "进行中" : "失败"}</h1>
        </header>
        {planning && !planningError && (
          <section className="card">
            <p className="loading-line">⏳ 正在生成 PRD 并分解任务，通常需要几十秒…</p>
            <pre ref={logRef} className="log-view small-log">{logs.join("\n")}</pre>
          </section>
        )}
        {planningError && (
          <section className="card escalation">
            <h3>❌ 规划失败</h3>
            <p>{planningError}</p>
            <div className="btn-row">
              <button className="primary" onClick={() => void retryPlanning()}>
                重试
              </button>
              <button onClick={() => void window.oxCommander.testLlm().then(() => undefined)}>
                检查 LLM 连接
              </button>
            </div>
          </section>
        )}
      </div>
    );
  }

  const totalTasks = batches?.reduce((n: number, b: Task[]) => n + b.length, 0) ?? 0;

  const startEdit = () => {
    setDraft(toEdit(prd));
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!draft || !activeProjectId) return;
    setSaving(true);
    try {
      await updatePrd({
        goal: draft.goal.trim(),
        features: draft.features.map((x) => x.trim()).filter(Boolean),
        techStack: draft.techStack.map((x) => x.trim()).filter(Boolean),
        acceptanceCriteria: draft.acceptanceCriteria.map((x) => x.trim()).filter(Boolean),
      });
      setEditing(false);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <button onClick={backToProjects}>← 返回项目列表</button>
        <h1>PRD 确认</h1>
        {!editing && (
          <button className="ghost" onClick={startEdit}>
            ✏️ 编辑 PRD
          </button>
        )}
      </header>

      {editing && draft ? (
        <>
          <section className="card">
            <h2>🎯 目标</h2>
            <textarea
              rows={2}
              value={draft.goal}
              onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
            />
          </section>
          <section className="card">
            <StringList title="✨ 功能列表" items={draft.features} onChange={(features) => setDraft({ ...draft, features })} />
          </section>
          <section className="card">
            <StringList title="🛠 技术栈" items={draft.techStack} onChange={(techStack) => setDraft({ ...draft, techStack })} />
          </section>
          <section className="card">
            <StringList
              title="✅ 验收标准"
              items={draft.acceptanceCriteria}
              onChange={(acceptanceCriteria) => setDraft({ ...draft, acceptanceCriteria })}
            />
          </section>
          <section className="card btn-row">
            <button className="primary" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? "重新分解任务中…" : "保存并重新分解"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
            >
              取消编辑
            </button>
          </section>
        </>
      ) : (
        <>
          <section className="card">
            <h2>🎯 目标</h2>
            <p>{prd.goal}</p>
          </section>

          <section className="card">
            <h2>✨ 功能列表</h2>
            <ul className="plain-list">
              {prd.features.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>🛠 技术栈</h2>
            <div className="btn-row">
              {prd.techStack.map((t, i) => (
                <span key={i} className="stage-chip">
                  {t}
                </span>
              ))}
            </div>
          </section>

          <section className="card">
            <h2>✅ 验收标准</h2>
            <ul className="plain-list">
              {prd.acceptanceCriteria.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>
              📦 批次规划（{totalTasks} 个任务 · {batches?.length ?? 0} 个批次）
            </h2>
            {!batches && <p className="muted">批次尚未生成…</p>}
            {batches?.map((batch: Task[], bi: number) => (
              <div key={bi} className="batch-block">
                <h4>批次 {bi + 1}（并行）</h4>
                {batch.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            ))}
          </section>

          <section className="card btn-row">
            <button className="primary" disabled={!batches} onClick={() => void confirmAndExecute()}>
              ✅ 批准开工
            </button>
            <button onClick={() => void retryPlanning()}>🔄 重新规划</button>
            <button onClick={backToProjects}>← 返回修改需求</button>
          </section>
        </>
      )}
    </div>
  );
}
