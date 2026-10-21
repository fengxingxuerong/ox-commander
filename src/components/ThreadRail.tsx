import { useEffect } from "react";
import { useApp } from "../store";
import { SessionList } from "./SessionList";

/**
 * 左栏 · 项目与线程（M1，对标 Codex 的 sidebar）。
 *
 * 这一栏回答两个问题：「现在这台机器上有哪些项目」和「这个项目里开过哪些
 * 线程」。它刻意**只导航、不发起动作** —— 切项目不会开始规划，切线程不会
 * 发送任何东西；所有"跑起来"的入口都在中栏。
 *
 * 为什么线程树值得常驻：会话页的转录可以拖得很长，而"换一条线继续干活"是
 * 长任务里最高频的操作（一个任务一条线，是 Codex 工作法的基本单元）。
 * 把它藏在页面中段意味着每次切换都要先滚过几百行工具输出。
 *
 * 切项目的语义是**带着跳转**的：没有当前项目时左栏点哪一行都不会有线程可
 * 看，所以这里必须同时设 `activeProjectId` 与 `page`；但切线程不跳页 ——
 * 操作者可能正停在看板上瞄执行进度，点一下线程名只换会话内容。
 */

export function ThreadRail() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const focusProject = useApp((s) => s.focusProject);
  const sessions = useApp((s) => s.chat.sessions);
  const threads = useApp((s) => s.chat.threads);
  const sessionId = useApp((s) => s.chat.sessionId);
  const resumeChat = useApp((s) => s.resumeChat);
  const forkChat = useApp((s) => s.forkChat);
  const deleteChat = useApp((s) => s.deleteChat);
  const newChat = useApp((s) => s.newChat);
  const loadChatSessions = useApp((s) => s.loadChatSessions);

  const activeProject = projects.find((p) => p.id === activeProjectId);

  // 左栏自己管列表：它现在是线程的一等入口，不能等中栏挂载才知道有哪些线。
  // 空列表才取 —— 非空时再取一次只会让"刚删完"的那种边缘场景多一轮请求。
  useEffect(() => {
    if (activeProjectId && sessions.length === 0) void loadChatSessions();
  }, [activeProjectId, sessions.length, loadChatSessions]);

  return (
    <aside className="thread-rail" aria-label="项目与线程">
      <div className="thread-rail-block">
        <span className="hud-stat-label">项目</span>
        {projects.length === 0 ? (
          <p className="muted thread-rail-empty">还没有项目。去「项目库」新建一个，线程的工具边界就是它的工作区。</p>
        ) : (
          <div className="thread-rail-projects">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`thread-rail-project${p.id === activeProjectId ? " active" : ""}`}
                aria-current={p.id === activeProjectId ? "true" : undefined}
                onClick={() => void focusProject(p.id)}
                title={`${p.name} — ${p.requirement}`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="thread-rail-block thread-rail-threads">
        <div className="thread-rail-head">
          <span className="hud-stat-label">线程</span>
          <button
            type="button"
            className="small"
            onClick={() => void newChat()}
            disabled={!activeProjectId}
            title={activeProjectId ? "开一条新线程" : "先选一个项目"}
          >
            新线程
          </button>
        </div>
        {activeProject ? (
          <p className="muted thread-rail-project-name">{activeProject.name}</p>
        ) : null}
        {sessions.length === 0 ? (
          <p className="muted thread-rail-empty">
            {activeProjectId ? "这个项目还没有线程。说一句要它做什么，第一条线程就出现在这里。" : "选一个项目才看得到它的线程。"}
          </p>
        ) : (
          <SessionList
            sessions={sessions}
            activeSessionId={sessionId}
            threads={threads}
            onResume={(id) => void resumeChat(id)}
            onFork={(id) => void forkChat(id)}
            onDelete={(id) => void deleteChat(id)}
          />
        )}
      </div>

      <div className="thread-rail-block">
        <button
          type="button"
          className="small"
          onClick={() => void loadChatSessions()}
          disabled={!activeProjectId}
          title="从会话记录重新读一次列表"
        >
          刷新线程列表
        </button>
      </div>
    </aside>
  );
}
