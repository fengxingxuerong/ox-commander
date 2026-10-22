import { useEffect } from "react";
import { useApp } from "../store";

/**
 * 「技能」页（M6a）。
 *
 * 这一页只回答三件事：**有哪些技能**、**它们是项目级的还是全局的**、**哪些扫到了
 * 但用不了**。它刻意不做"新建/编辑技能" —— 技能的内容是"教模型怎么做一件事"，
 * 两行表单能生出来的只有空壳；Codex 自己最有效的获取方式也是"演示一遍生成
 * SKILL.md"（蓝图里列为「可做」档）。
 *
 * 三条诚实边界（都写在界面上，不摆假按钮）：
 * 1. **技能全文要靠 `read_skill` 现取**，而工具目录目前还是六件套 —— 目录块里
 *    点名了 read_skill，但真正能取全文要等 M6b；
 * 2. 技能是背景不是合同：与平台契约冲突时以契约为准（与项目约定同一条）；
 * 3. 停用（同目录放 `.disabled`）不等于删除：它仍在列表里，只是不进目录。
 */
export function SkillsPage() {
  const skills = useApp((s) => s.skills);
  const issues = useApp((s) => s.skillIssues);
  const error = useApp((s) => s.skillsError);
  const loadSkills = useApp((s) => s.loadSkills);
  const activeProjectId = useApp((s) => s.activeProjectId);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills, activeProjectId]);

  return (
    <section className="card">
      <h2>技能</h2>
      <p className="card-sub">
        项目 <code>.ox/skills</code> 与全局 <code>~/.ox/skills</code> · 同名时项目级优先
      </p>

      {error ? <p className="notice error">读取技能目录失败：{error}</p> : null}

      {skills.length === 0 && issues.length === 0 ? (
        <p className="muted" data-testid="skill-empty">
          还没有技能。放一个目录进去就有了：在项目根的 <code>.ox/skills/&lt;名字&gt;/SKILL.md</code>
          （或全局 <code>~/.ox/skills/</code>）写一个 front matter，里面给 <code>name</code> 与
          <code> description</code>，正文写"该怎么做"。目录名起对了，front matter 里就可以不写 name。
        </p>
      ) : null}

      {skills.length > 0 ? (
        <div className="thread-rail-block">
          <span className="hud-stat-label">可用技能（{skills.length}）</span>
          <ul className="skill-list">
            {skills.map((skill) => (
              <li key={`${skill.origin}:${skill.name}`} className="skill-row" data-testid="skill-row">
                <span className="skill-row-head">
                  <b>{skill.name}</b>
                  <span className={`skill-badge ${skill.origin}`} title={skill.path}>
                    {skill.origin === "project" ? "项目" : "全局"}
                  </span>
                  {skill.enabled ? null : (
                    <span className="skill-badge off" title="同目录里有 .disabled">
                      已停用
                    </span>
                  )}
                  <span className="muted skill-path">{skill.path}</span>
                </span>
                <span className="muted">
                  {skill.description}
                  {skill.descriptionTruncated ? "（描述超长已截断）" : ""}
                </span>
                <span className="muted skill-path">正文 {skill.bodyChars} 字符 · 全文由 read_skill 按需取</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div className="thread-rail-block">
          <span className="hud-stat-label">扫到了但不可用（{issues.length}）</span>
          <ul className="skill-list">
            {issues.map((issue) => (
              <li key={issue.path} className="skill-row" data-testid="skill-issue">
                <span className="muted skill-path">{issue.path}</span>
                <span className="muted">{issue.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
