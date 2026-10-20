import { useApp } from "../store";
import { IssuePicker } from "../components/IssuePicker";

/**
 * 页头的三步引导：把"这台机器怎么用"写在第一屏。
 * 文案刻意短 —— 它是给人扫一眼的路线图，不是说明书（细节在各步骤的面板里）。
 */
const FLOW: Array<{ step: string; title: string; desc: string }> = [
  { step: "1", title: "说需求", desc: "一句话写清要做什么，或从 GitHub issue 直接摄入" },
  { step: "2", title: "确认 PRD", desc: "机器产出需求文档与任务分解，你改完再批准" },
  { step: "3", title: "看板收尾", desc: "并行开发 + 构建测试门禁，交付时给一份可复核的凭据" },
];

export function ProjectsPage() {
  const projects = useApp((s) => s.projects);
  const name = useApp((s) => s.newProjectName);
  const requirement = useApp((s) => s.newRequirement);
  const setName = useApp((s) => s.setNewProjectName);
  const setRequirement = useApp((s) => s.setNewRequirement);
  const createAndOpen = useApp((s) => s.createAndOpen);
  const deleteProject = useApp((s) => s.deleteProject);
  const openProject = useApp((s) => s.openProject);
  const projectsError = useApp((s) => s.projectsError);

  const handleDelete = (e: React.MouseEvent, id: string, pname: string) => {
    e.stopPropagation();
    if (!window.confirm(`删除项目「${pname}」？工作区目录会移入回收站。`)) return;
    // The store records failures instead of throwing, so the reason is read
    // back from state rather than caught here. A `.catch` here would be dead
    // code and would silently swallow the message.
    void deleteProject(id).then(() => {
      const err = useApp.getState().projectsError;
      if (err) window.alert(`删除失败: ${err}`);
    });
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>项目库</h1>
        <p>说一句话需求 → 机器拆解并写代码 → 构建与测试全绿后交付</p>
      </header>

      <ol className="steps">
        {FLOW.map((f) => (
          <li key={f.step} data-step={f.step}>
            <b>
              {f.step}. {f.title}
            </b>
            {f.desc}
          </li>
        ))}
      </ol>

      {projectsError && (
        <p className="inline-error" role="alert">
          操作失败：{projectsError}
        </p>
      )}

      <section className="card">
        <h2>新建项目</h2>
        <p className="card-sub">填一句话需求，机器会自动生成 PRD 并拆成可并行的任务批次。</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="项目名称（可留空，默认「未命名项目」）"
        />
        <textarea
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          rows={5}
          placeholder="用一句话描述你想做的项目，例如：做一个支持多用户的待办事项 Web 应用"
        />
        <button
          className="primary"
          disabled={!requirement.trim()}
          onClick={() => void createAndOpen()}
          title={requirement.trim() ? "生成 PRD 并进入需求确认页" : "先写一句需求"}
        >
          创建并进入看板
        </button>
      </section>

      <IssuePicker />

      <section className="card">
        <h2>历史项目</h2>
        <p className="card-sub">点一行直接回到它的看板；🗑 会把工作区目录移入回收站。</p>
        {projects.length === 0 && <p className="muted">暂无项目</p>}
        {projects.map((p) => (
          <div
            key={p.id}
            className="project-row"
            onClick={() => openProject(p.id)}
            title="打开该项目的执行看板"
          >
            <span className="project-name">{p.name}</span>
            <span className={`stage-chip stage-${p.stage.toLowerCase()}`}>{p.stage}</span>
            <button
              className="ghost delete-btn"
              title="删除项目（工作区移入回收站）"
              onClick={(e) => handleDelete(e, p.id, p.name)}
            >
              🗑
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
