import { useState } from "react";
import type { ChatSessionSummary } from "../../shared/chat-events";

/**
 * 线程列表（M1 · 左侧栏的一块）。
 *
 * 它从 ChatPage 内联的那块整体搬来，行为一字未改：标题行可点恢复、行尾分叉 /
 * 删除、删除要二次确认。搬动的原因是**位置**而不是逻辑 —— 原来它挤在会话页
 * 中段，操作者每次切线程都要先滚过整段转录；Codex 式工作台里线程树是常驻
 * 左栏，换线程与看执行流是两件互不打断的事。
 *
 * 三条界面纪律（沿用原页的）：
 * 1. 删除必须二次确认：历史线程里可能有还没归档的补丁。
 * 2. 运行 / 等审批时禁用一切切换：换线程会让在途的工具结果串到另一条线上。
 * 3. 按钮不带"发送"字样：列表里没有输入框，命名撞车只会让按 role 取按钮的
 *    界面测试变成多选。
 */

const STATUS_TEXT: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  "awaiting-approval": "等你拍板",
  done: "已完成",
  aborted: "已中止",
  error: "出错",
};

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export function SessionList({
  sessions,
  activeSessionId,
  busy,
  onResume,
  onFork,
  onDelete,
}: {
  sessions: ChatSessionSummary[];
  activeSessionId?: string;
  busy: boolean;
  onResume: (sessionId: string) => void;
  onFork: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <div className="chat-sessions" data-testid="chat-sessions">
      <span className="hud-stat-label">线程</span>
      {sessions.map((s) => (
        <div
          key={s.sessionId}
          className={`chat-session${s.sessionId === activeSessionId ? " active" : ""}`}
          data-testid="chat-session"
        >
          <button
            type="button"
            className="chat-session-title"
            onClick={() => onResume(s.sessionId)}
            disabled={busy || s.sessionId === activeSessionId}
            title={s.title}
          >
            {s.title || "新会话"}
          </button>
          <span className="muted chat-session-meta">
            {s.turns} 轮 · {statusText(s.status)}
          </span>
          {confirmDelete === s.sessionId ? (
            <>
              <button type="button" className="small danger" onClick={() => void onDelete(s.sessionId)}>
                确认删除
              </button>
              <button type="button" className="small" onClick={() => setConfirmDelete(null)}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="small"
                onClick={() => void onFork(s.sessionId)}
                disabled={busy}
              >
                分叉
              </button>
              <button
                type="button"
                className="small"
                onClick={() => setConfirmDelete(s.sessionId)}
                disabled={busy}
              >
                删除
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
