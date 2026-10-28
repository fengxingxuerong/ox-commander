import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import { AcceptanceEditor } from "../components/AcceptanceEditor";
import { normalizeAcceptanceChecks } from "../../shared/acceptance";
import type { AcceptanceCheck, PrdDocument, Task } from "../../shared/types";

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
  const settings = useApp((s) => s.settings);
  const loadSettings = useApp((s) => s.loadSettings);
  const saveSettings = useApp((s) => s.saveSettings);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * 操作者验收判据（B7）：PRD 确认页是它**被看见**的地方 —— 判据与 PRD 的
   * 自然语言验收标准并排摆着，操作者在批准开工前确认"机器到底要跑哪几条黑盒检查"。
   * 它是项目设置的一部分（存进 `settings.acceptanceChecks`），不是 PRD 文档的字段：
   * PRD 会被重新分解覆盖，判据不该跟着丢。
   */
  const [accDraft, setAccDraft] = useState<AcceptanceCheck[]>(settings?.acceptanceChecks ?? []);
  const [accIssues, setAccIssues] = useState<string[]>([]);
  const [accDirty, setAccDirty] = useState(false);
  const [accSaving, setAccSaving] = useState(false);
  const [accSaved, setAccSaved] = useState(false);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  // 设置异步到达时填进草稿；用户已经在编辑（dirty）就不覆盖 —— 那是他的输入。
  useEffect(() => {
    if (!accDirty) setAccDraft(settings?.acceptanceChecks ?? []);
  }, [settings, accDirty]);
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

  /**
   * 保存验收判据到项目设置。返回是否真的落盘 —— 调用方（批准开工）据此决定
   * 要不要继续：判据没存成功就开工，这一轮用的还是旧判据，而界面已经显示过新的。
   */
  const saveAcceptance = async (): Promise<boolean> => {
    const normalized = normalizeAcceptanceChecks(accDraft);
    if (normalized.issues.length > 0) {
      setAccIssues(normalized.issues);
      return false;
    }
    setAccIssues([]);
    const current = useApp.getState().settings;
    if (!current) {
      setAccIssues(["设置还没读取成功（可能是设置文件损坏）—— 先修好它再保存判据。"]);
      return false;
    }
    setAccSaving(true);
    try {
      await saveSettings({
        ...current,
        acceptanceChecks: normalized.checks.length > 0 ? normalized.checks : undefined,
      });
      const failure = useApp.getState().settingsError;
      if (failure) {
        setAccIssues([`保存失败：${failure}`]);
        return false;
      }
      setAccDirty(false);
      setAccSaved(true);
      return true;
    } finally {
      setAccSaving(false);
    }
  };

  /** 批准开工：先确保判据落盘（有未保存改动才写），再启动。 */
  const approve = async () => {
    if (accDirty && !(await saveAcceptance())) return;
    await confirmAndExecute();
  };

  return (
    <div className="page">
      <header className="page-header">
        <button onClick={backToProjects}>← 返回项目列表</button>
          <h1>PRD 确认</h1>
          <p>先看机器理解得对不对：改完点「批准开工」，它会按下面的批次并行开发。</p>
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
            <h2>🧪 操作者验收判据（{accDraft.length} 条，机械可判）</h2>
            <p className="card-sub">
              上面是 PRD 的<strong>自然语言</strong>验收标准；这里是机器真正会跑的黑盒检查：
              命令退出 0、输出含全部期望片段、产物真在盘上，三条都满足才算过。
              它们<strong>不进任务描述、不进规划提示</strong> —— 执行器看不到，也就没法靠改自测让验收变绿。
              留空 = 本轮不跑这一层。
            </p>
            <AcceptanceEditor
              checks={accDraft}
              disabled={accSaving}
              onChange={(checks) => {
                setAccDraft(checks);
                setAccDirty(true);
                setAccSaved(false);
                setAccIssues([]);
              }}
            />
            {accIssues.length > 0 && (
              <div className="inline-error" role="alert">
                <strong>验收判据还不能保存：</strong>
                <ul className="plain-list">
                  {accIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="btn-row">
              <button disabled={accSaving || !accDirty} onClick={() => void saveAcceptance()}>
                {accSaving ? "保存中…" : "保存验收判据"}
              </button>
              {accSaved && <span className="ok-text">已保存：本轮按这些判据验收。</span>}
              {accDirty && <span className="muted">有未保存的改动 ——「批准开工」前会自动保存。</span>}
            </div>
          </section>

          <section className="card">
            <h2>
              📦 批次规划（{totalTasks} 个任务 · {batches?.length ?? 0} 个批次）
            </h2>
            <p className="card-sub">同批次内的任务并行开发，批次之间串行；有依赖的任务自动排到后面的批次。</p>
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
            <button className="primary" disabled={!batches || accSaving} onClick={() => void approve()}>
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
