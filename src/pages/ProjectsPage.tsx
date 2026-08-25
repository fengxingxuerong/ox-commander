import { useApp } from "../store";

export function ProjectsPage() {
  const projects = useApp((s) => s.projects);
  const name = useApp((s) => s.newProjectName);
  const requirement = useApp((s) => s.newRequirement);
  const setName = useApp((s) => s.setNewProjectName);
  const setRequirement = useApp((s) => s.setNewRequirement);
  const createAndOpen = useApp((s) => s.createAndOpen);
  const setPage = useApp((s) => s.setPage);

  return (
    <div className="page">
      <header className="page-header">
        <h1>OxCommander</h1>
        <p>总指挥智能体：拆解需求 → 并行派发 → 多轮验证 → 交付</p>
      </header>

      <section className="card">
        <h2>新建项目</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="项目名称（可选）"
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
        >
          创建并进入看板
        </button>
      </section>

      <section className="card">
        <h2>历史项目</h2>
        {projects.length === 0 && <p className="muted">暂无项目</p>}
        {projects.map((p) => (
          <div key={p.id} className="project-row" onClick={() => setPage("board")}>
            <span className="project-name">{p.name}</span>
            <span className={`stage-chip stage-${p.stage.toLowerCase()}`}>{p.stage}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
