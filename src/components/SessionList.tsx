import { useState } from "react";
import type { ChatSessionSummary } from "../../shared/chat-events";
import type { ThreadStatusView } from "../../shared/chat-thread-status";

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
 * 2. 切换**不再**因为别处有线程在跑而禁用（M4b）：宿主已按 sessionId 寻址，
 *    换线程只是换看哪条；仍要禁的是"会毁掉线程"的动作（删除一条正在跑的）。
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
  threads,
  onResume,
  onFork,
  onDelete,
}: {
  sessions: ChatSessionSummary[];
  activeSessionId?: string;
  /** 运行时状态位（M4b）：有事件的线程在这里，历史线程回落到 `s.status`。 */
  threads: Record<string, ThreadStatusView>;
  onResume: (sessionId: string) => void;
  onFork: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  return (
    <div className="chat-sessions" data-testid="chat-sessions">
      <span className="hud-stat-label">线程</span>
      {sessions.map((s) => {
        const live = threads[s.sessionId];
        const status = live?.status ?? s.status;
        const turns = live?.turns ?? s.turns;
        // 一条正在跑的线程被删 = 中止它并抹掉记录。禁用的判据是**那一行自己的**
        // 状态，不是"当前线程忙不忙" —— 后者会让"后台在跑"连带锁住整棵树。
        const rowBusy = status === "running" || status === "awaiting-approval";
        return (
        <div
          key={s.sessionId}
          className={`chat-session${s.sessionId === activeSessionId ? " active" : ""}`}
          data-testid="chat-session"
        >
          <span
            className={`chat-session-dot status-${status}`}
            data-testid="thread-dot"
            aria-label={statusText(status)}
            title={statusText(status)}
          />
          <button
            type="button"
            className="chat-session-title"
            onClick={() => onResume(s.sessionId)}
            disabled={s.sessionId === activeSessionId}
            title={s.title}
          >
            {s.title || "新会话"}
          </button>
          {live && live.unread > 0 ? (
            <span className="chat-session-unread" data-testid="thread-unread" title="离开之后新增的条目">
              {live.unread > 99 ? "99+" : live.unread}
            </span>
          ) : null}
          <span className="muted chat-session-meta">
            {turns} 轮 · {statusText(status)}
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
                disabled={rowBusy}
                title={rowBusy ? "这条线程还在跑：先停它再分叉" : "复制一条新线程"}
              >
                分叉
              </button>
              <button
                type="button"
                className="small"
                onClick={() => setConfirmDelete(s.sessionId)}
                disabled={rowBusy}
                title={rowBusy ? "这条线程还在跑：先停它再删" : "删除这条线程"}
              >
                删除
              </button>
            </>
          )}
        </div>
        );
      })}
    </div>
  );
}
