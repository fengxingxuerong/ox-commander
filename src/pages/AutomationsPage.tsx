import { useEffect, useState } from "react";

import { useApp } from "../store";
import { describeAutomation } from "../../shared/automation";

/**
 * 「自动化」页（M5b）：时间触发的任务清单。
 *
 * 与 Codex 的 Automations 对位的是**一件事**：让"定期把同一份需求再跑一遍"成为
 * 一等公民（回归检查、每晚构建、每周依赖升级）。所以这一页只做时间触发，
 * 不做 webhook 事件触发 —— 后者需要常驻可达性，价值还没验证（蓝图 §五 可做档）。
 *
 * 三条交互上的取舍：
 * - **触发走的是 `orchestration:start` 的同一道闸**：所以"有别的 run 在跑"是
 *   正常结果（busy），不是错误弹窗 —— 页面上说清"跳过，不积压"；
 * - **间隔用预设档而不是自由填毫秒**：手填 500ms 只会撞成连续空转（下限 1s 由
 *   主进程把关），预设让"选错"比"填错"难发生；
 * - **触发历史来自审计 JSONL**（重启仍在）：这一页的核心问题不是"配了几个"，
 *   而是"昨晚到底跑了没有、为什么没跑"。
 */

/** 间隔预设。1s 是主进程的下限，但秒级定时在这里没有使用场景，所以不列。 */
const EVERY_CHOICES: Array<{ label: string; everyMs: number }> = [
  { label: "每 1 分钟", everyMs: 60_000 },
  { label: "每 5 分钟", everyMs: 300_000 },
  { label: "每 30 分钟", everyMs: 1_800_000 },
  { label: "每 1 小时", everyMs: 3_600_000 },
  { label: "每 6 小时", everyMs: 21_600_000 },
  { label: "每 24 小时", everyMs: 86_400_000 },
];

const OUTCOME_LABEL: Record<string, string> = {
  accepted: "已派发",
  busy: "忙时跳过",
  failed: "未触发",
};

export function AutomationsPage() {
  const projects = useApp((s) => s.projects);
  const automations = useApp((s) => s.automations);
  const error = useApp((s) => s.automationsError);
  const history = useApp((s) => s.automationHistory);
  const loadAutomations = useApp((s) => s.loadAutomations);
  const loadHistory = useApp((s) => s.loadAutomationHistory);
  const createAutomation = useApp((s) => s.createAutomation);
  const updateAutomation = useApp((s) => s.updateAutomation);
  const deleteAutomation = useApp((s) => s.deleteAutomation);
  const runAutomation = useApp((s) => s.runAutomation);

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [everyMs, setEveryMs] = useState(EVERY_CHOICES[1]!.everyMs);
  const [notice, setNotice] = useState("");
  /** 让"上次 N 秒前"跟着走（不 tick 的话它会停在进页面那一刻）。 */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void loadAutomations();
    void loadHistory();
  }, [loadAutomations, loadHistory]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const submit = async () => {
    setNotice("");
    const ok = await createAutomation({ name, projectId: projectId || projects[0]?.id || "", everyMs });
    if (ok) setName("");
  };

  const run = async (id: string) => {
    const outcome = await runAutomation(id);
    setNotice(
      outcome === "busy"
        ? "没有触发：有别的项目正在执行（忙时跳过，不积压）。等它跑完再来。"
        : outcome === "failed"
          ? "没有触发：这个项目还没有可执行的计划 —— 先去编排页做完 PRD 与任务分解。"
          : outcome === "accepted"
            ? "已触发：这次运行的过程去看板页看。"
            : "",
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>自动化</h1>
        <p>按间隔把同一个项目的编排再跑一遍：回归检查、每晚构建、每周依赖升级。</p>
      </header>

      {error && (
        <p className="inline-error" role="alert">
          自动化状态有问题：{error}
        </p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}

      <section className="card">
        <h2>新建自动化</h2>
        <p className="card-sub">
          触发跑的就是「执行」那条路（同一道单飞闸）：已有别的项目在跑时本轮跳过，不积压。
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称（例如：每晚回归）"
          maxLength={40}
        />
        <select value={projectId || projects[0]?.id || ""} onChange={(e) => setProjectId(e.target.value)}>
          {projects.length === 0 && <option value="">先建一个项目</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={everyMs} onChange={(e) => setEveryMs(Number(e.target.value))}>
          {EVERY_CHOICES.map((c) => (
            <option key={c.everyMs} value={c.everyMs}>
              {c.label}
            </option>
          ))}
        </select>
        <div className="btn-row">
          <button
            type="button"
            className="primary"
            disabled={name.trim() === "" || projects.length === 0}
            onClick={() => void submit()}
            title={projects.length === 0 ? "还没有项目可自动化" : "首次触发在一个间隔之后"}
          >
            创建
          </button>
        </div>
      </section>

      <section className="card">
        <h2>已配置（{automations.length}）</h2>
        {automations.length === 0 ? (
          <p className="muted">还没有自动化。上面的表单建一条，首次触发会在一个间隔之后。</p>
        ) : (
          <ul className="automation-list">
            {automations.map((a) => (
              <li key={a.id} data-testid="automation-row">
                <div>
                  <b>{a.name}</b>
                  <div className="muted">
                    {projects.find((p) => p.id === a.projectId)?.name ?? a.projectId} ·{" "}
                    {describeAutomation(a, now)}
                  </div>
                </div>
                <div className="btn-row">
                  <button type="button" onClick={() => void updateAutomation(a.id, { enabled: !a.enabled })}>
                    {a.enabled ? "停用" : "启用"}
                  </button>
                  <button type="button" onClick={() => void run(a.id)}>
                    立即运行
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`删除自动化「${a.name}」？（触发历史会保留）`)) {
                        void deleteAutomation(a.id);
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>触发历史</h2>
        <p className="card-sub">
          来自审计记录（重启后仍在）。"忙时跳过"不是失败 —— 单飞语义下同时只能跑一个编排。
        </p>
        {history.length === 0 ? (
          <p className="muted">还没有触发记录。</p>
        ) : (
          <ul className="automation-history">
            {history.slice(0, 20).map((h, i) => (
              <li key={`${h.ts}-${i}`} data-testid="automation-history-row">
                <span className="muted">{new Date(h.ts).toLocaleString()}</span>{" "}
                <b>{h.automationName ?? h.automationId ?? "（已删除）"}</b>{" "}
                <span>{OUTCOME_LABEL[h.outcome] ?? h.outcome}</span>
                {h.detail ? <span className="muted"> · {h.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
