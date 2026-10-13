import { useState } from "react";
import { useApp } from "../store";
import type { GithubIssue } from "../../shared/github-issue";

/**
 * "从 GitHub issue 建项目"的选择器（摄入半边的桌面创建面，2026-10-14）。
 *
 * 三条纪律：
 * ① **只读**：拉取走 `gh issue list`（白名单在 electron/context/github-readonly），
 *    不在 GitHub 上留任何痕迹 —— 选择器不评论、不关 issue、不建 PR。
 * ② **失败与空结果是两件事**：gh 没装 / 没登录 / 仓库不存在 → 显示 reason；
 *    "没有符合条件的 issue" → 另一句。混为一谈，就是把"没拿到"演成了
 *    "没有需求"—— 与审计面板"读取失败 vs 没有记录"同一条规矩。
 * ③ **创建即搬家**：选中一条点创建，store 的 createFromIssue 接手（名字取
 *    标题、需求取正文），之后与手填创建走完全同一条链路。
 */
export function IssuePicker() {
  const createFromIssue = useApp((s) => s.createFromIssue);
  const [repo, setRepo] = useState("");
  const [search, setSearch] = useState("");
  const [issues, setIssues] = useState<GithubIssue[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setPicked(null);
    try {
      const r = await window.oxCommander.listGithubIssues({
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      if (r.ok) setIssues(r.issues);
      else setError(r.reason);
    } catch (err) {
      // 两条失败路径分工：IPC 入参形状校验（repo 不合法那类）抛异常；
      // gh 侧失败（没登录 / 仓库不存在）折进结果对象的 reason。都摆出来。
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const chosen = issues?.find((i) => i.number === picked);

  return (
    <section className="card">
      <h2>从 GitHub Issue 创建</h2>
      <p className="muted">用本机已登录的 gh 拉取 issue（只读），选一条当项目需求。需要本机装有 gh CLI 并已登录。</p>
      <div className="btn-row">
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/repo（留空 = 当前仓库）"
          aria-label="仓库"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索条件（可选）"
          aria-label="搜索条件"
        />
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "拉取中…" : "拉取 issue"}
        </button>
      </div>
      {error && (
        <p className="bad-text" role="alert">
          拉取失败：{error}
        </p>
      )}
      {issues !== null && !error && (
        <>
          {issues.length === 0 && <p className="muted">没有符合条件的 issue。</p>}
          {issues.map((i) => (
            <label key={i.number} className="issue-row">
              <input
                type="radio"
                name="issue-pick"
                checked={picked === i.number}
                onChange={() => setPicked(i.number)}
              />
              <span>
                #{i.number} [{i.state}] {i.title}
              </span>
            </label>
          ))}
          <div className="btn-row">
            <button
              className="primary"
              disabled={!chosen}
              onClick={() => {
                if (chosen) void createFromIssue(chosen);
              }}
            >
              用这条 issue 创建
            </button>
          </div>
        </>
      )}
    </section>
  );
}
