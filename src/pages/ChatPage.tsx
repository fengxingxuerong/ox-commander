import { useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import {
  summarizeTranscript,
  type ChatEntry,
  type ChatSessionMeta,
  type ChatStatus,
} from "../../shared/chat-events";
import { describeSandbox, type ApprovalPolicy, type SandboxMode } from "../../shared/tools/policy";
import { diffText } from "../../shared/text-diff";

/**
 * 交互式会话页（对标 Codex 的 TUI 那一层）。
 *
 * 与看板的分工：看板是"需求 → PRD → 批次 → 门禁"的编排流水线，这一页是
 * "人说一句 → 模型自己读文件 / 打补丁 / 跑命令 → 人盯着过程"的编码智能体。
 * 两条链共用沙箱与 LLM 池，但**不共用审批队列**（这里的审批要能说"本次会话
 * 都别再问"，也要能把拒绝理由回灌给模型）。
 *
 * 三条界面纪律：
 * 1. **过程逐条可见**：每一条工具调用与它的结果都单独成行、可展开看全文 ——
 *    "改了什么"要能在屏幕上被看见，而不是只在凭据里被断言。
 * 2. **状态与动作分开**：「停止」按钮只在 running / awaiting-approval 时出现，
 *    空闲时不摆一个按了没反应的按钮。
 * 3. **审批三选一必带理由框**：不给理由的拒绝会让模型原样重试同一个动作，
 *    所以拒绝时**必须**写一句话（界面不替用户默认勾选"始终允许"）。
 */

const KIND_MARK: Record<ChatEntry["kind"], string> = {
  user: "▸",
  assistant: "◂",
  tool_call: "⚙",
  tool_result: "↳",
  approval: "🛂",
  error: "✖",
  system: "·",
};

const STATUS_TEXT: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  "awaiting-approval": "等你拍板",
  done: "已完成",
  aborted: "已中止",
  error: "出错",
};

function chatMeta(chat: { sessionId?: string; status: ChatStatus; turns: number; usageTokens: number; mode: SandboxMode; approvalPolicy: ApprovalPolicy }): ChatSessionMeta {
  const now = Date.now();
  return {
    sessionId: chat.sessionId ?? "",
    rootAbs: "",
    startedAt: now,
    updatedAt: now,
    turns: chat.turns,
    status: chat.status,
    mode: chat.mode,
    approvalPolicy: chat.approvalPolicy,
    usageTokens: chat.usageTokens,
  };
}

const DIFF_MARK: Record<string, string> = { same: " ", add: "+", del: "-" };

/** 一个 apply_patch 结果里的逐文件 diff；只读内容来自工具结果本身。 */
function ChangesView({
  changes,
  busy,
  onRevert,
}: {
  changes: NonNullable<NonNullable<ChatEntry["result"]>["changes"]>;
  busy: boolean;
  onRevert: (turn: number, path?: string) => void;
}) {
  const turn = changes[0]?.turn ?? 0;
  return (
    <div className="chat-changes">
      <div className="chat-changes-head">
        <span className="hud-stat-label">改动 {changes.length} 个文件</span>
        <button type="button" className="small" onClick={() => onRevert(turn)} disabled={busy}>
          撤销本轮
        </button>
      </div>
      <p className="muted chat-changes-note">只记录 apply_patch；命令产生的改动请用 git diff 查看。</p>
      {changes.map((change) => {
        const d = diffText(change.before ?? undefined, change.after ?? undefined);
        return (
          <div key={`${change.turn}:${change.path}`} className="chat-change">
            <div className="chat-change-head">
              <span>{change.path}</span>
              <span className="muted">
                {d.status}
                {d.added !== null ? ` · +${d.added}/-${d.deleted ?? 0}` : ""}
              </span>
              {change.revertable ? (
                <button
                  type="button"
                  className="small"
                  onClick={() => onRevert(change.turn, change.path)}
                  disabled={busy}
                >
                  撤销此文件
                </button>
              ) : (
                <span className="muted">不可撤销</span>
              )}
            </div>
            {d.lines.length > 0 ? (
              <pre className="chat-diff">
                {d.lines.slice(0, 400).map((line, i) => (
                  <span key={i} className={`diff-${line.kind}`}>
                    {`${DIFF_MARK[line.kind] ?? " "}${line.text}\n`}
                  </span>
                ))}
              </pre>
            ) : (
              <p className="muted">
                {d.status === "unchanged" ? "内容未变" : d.status === "binary" ? "二进制，不渲染" : "文件过大，只给统计"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EntryRow({
  entry,
  busy,
  onRevert,
}: {
  entry: ChatEntry;
  busy: boolean;
  onRevert: (turn: number, path?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // 失败的结果也要能展开：它的 output 常常是空的，真正的解释在 reason 里 ——
  // 只按 output 判会让"为什么失败"这一条永远点不开。
  const detail = entry.result
    ? entry.result.output || entry.result.reason || ""
    : entry.tool
      ? JSON.stringify(entry.tool.args, null, 2)
      : "";
  const changes = entry.result?.changes ?? [];
  const hasDetail = detail.trim() !== "" || changes.length > 0;
  return (
    <div className={`chat-entry chat-${entry.kind}`}>
      <div className="chat-entry-head">
        <span className="chat-mark" aria-hidden="true">
          {KIND_MARK[entry.kind]}
        </span>
        <span className="chat-entry-text">{entry.text}</span>
        {hasDetail ? (
          <button type="button" className="small" onClick={() => setOpen(!open)} title={open ? "收起" : "展开"}>
            {open ? "收起 ▲" : changes.length > 0 ? `改动 ${changes.length} ▼` : "详情 ▼"}
          </button>
        ) : null}
      </div>
      {open && detail.trim() !== "" ? <pre className="chat-detail">{detail}</pre> : null}
      {open && changes.length > 0 ? <ChangesView changes={changes} busy={busy} onRevert={onRevert} /> : null}
    </div>
  );
}

export function ChatPage() {
  const chat = useApp((s) => s.chat);
  const input = useApp((s) => s.chatInput);
  const setInput = useApp((s) => s.setChatInput);
  const sendChat = useApp((s) => s.sendChat);
  const abortChat = useApp((s) => s.abortChat);
  const newChat = useApp((s) => s.newChat);
  const loadTranscript = useApp((s) => s.loadChatTranscript);
  const resolveApproval = useApp((s) => s.resolveChatApproval);
  const revertChat = useApp((s) => s.revertChat);
  const reviewOpen = useApp((s) => s.reviewOpen);
  const setReviewOpen = useApp((s) => s.setReviewOpen);
  const [reason, setReason] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadTranscript();
  }, [loadTranscript]);

  useEffect(() => {
    // jsdom 没有实现 scrollIntoView（界面测试里它是 undefined）：用可选调用，
    // 没这个函数就不滚 —— 自动滚动是体验，不该让整页在测试环境里挂掉。
    const el = bottomRef.current as (HTMLDivElement & { scrollIntoView?: (o: unknown) => void }) | null;
    el?.scrollIntoView?.({ block: "end" });
    // 流式增量也要跟着滚：否则逐字变长的那一行会顶出可视区，看着像卡住了。
  }, [chat.entries.length, chat.streaming]);

  const busy = chat.status === "running" || chat.status === "awaiting-approval";

  return (
    <div className="page">
      <section className="card">
        <h2>交互式会话</h2>
        <p className="card-sub">
          直接说话，让它自己读代码、打补丁、跑命令。当前：{describeSandbox(chat.mode, chat.approvalPolicy)}
        </p>

        <div className="chat-status">
          <span className="chat-stat">
            <span className="hud-stat-label">状态</span>
            <span className="hud-stat-value">{STATUS_TEXT[chat.status] ?? chat.status}</span>
          </span>
          <span className="chat-stat">
            <span className="hud-stat-label">轮次</span>
            <span className="hud-stat-value">{chat.turns}</span>
          </span>
          <span className="chat-stat">
            <span className="hud-stat-label">TOKENS</span>
            <span className="hud-stat-value">{chat.usageTokens}</span>
          </span>
          <span className="btn-row">
            <button type="button" className="small" onClick={() => void newChat()} disabled={busy}>
              新会话
            </button>
            {/* 右栏收起后的唯一回归入口。放在状态行而不是只放在右栏自己的
                "收起"按钮上 —— 收起之后那一栏已经不见了，没处点。 */}
            {!reviewOpen ? (
              <button
                type="button"
                className="small"
                onClick={() => setReviewOpen(true)}
                title="展开右栏：这个线程动过哪些文件、每处能不能退回去"
              >
                改动审查
              </button>
            ) : null}
            {busy ? (
              <button type="button" className="small danger" onClick={() => void abortChat()}>
                停止
              </button>
            ) : null}
          </span>
        </div>

        {chat.notice ? <p className="muted">⚠ {chat.notice}</p> : null}

        {/* 线程列表已搬到左栏（M1）：它在常驻位置，不随转录滚走。
            恢复 / 分叉 / 删除的交互与断言一起搬到了 SessionList 与 ThreadRail。 */}

        {chat.entries.length > 0 ? (
          // 摘要给的是"它动过哪些文件、调了几次工具"—— 转录逐条往下翻之前，
          // 操作者先要知道该不该停下来看一眼。它由 shared 侧的纯函数导出，
          // 与 serve 状态页将来要用的是同一份口径。
          <p className="muted" data-testid="chat-summary">
            {(() => {
              const sum = summarizeTranscript({ meta: chatMeta(chat), entries: chat.entries });
              const files = sum.changedPaths.length > 0 ? `涉及文件：${sum.changedPaths.join("、")}` : "没有文件改动";
              return `工具调用 ${sum.toolCalls} 次 · ${files}`;
            })()}
          </p>
        ) : null}

        <div className="chat-transcript" data-testid="chat-transcript">
          {chat.entries.length === 0 && chat.streaming === "" ? (
            <p className="muted">还没有对话。说一句要它做什么，过程会在这里逐条展开。</p>
          ) : (
            chat.entries.map((e) => (
              <EntryRow key={e.id} entry={e} busy={busy} onRevert={(turn, path) => void revertChat(turn, path)} />
            ))
          )}
          {/* 正在打字的那一行：只此一行，正文一到就被顶替（不叠加，避免同一段话double）。 */}
          {chat.streaming !== "" ? (
            <div className="chat-entry chat-assistant chat-streaming" data-testid="chat-streaming">
              <div className="chat-entry-head">
                <span className="chat-mark" aria-hidden="true">
                  {KIND_MARK.assistant}
                </span>
                <span className="chat-entry-text">{chat.streaming}</span>
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>

        {chat.pendingApproval ? (
          <div className="chat-approval">
            <h3>🛂 {chat.pendingApproval.tool === "run_command" ? "命令需要确认" : "改动需要确认"}</h3>
            <p className="muted">{chat.pendingApproval.reason}</p>
            <pre className="chat-detail">
              {chat.pendingApproval.tool === "run_command"
                ? `${chat.pendingApproval.command ?? ""} ${(chat.pendingApproval.args ?? []).join(" ")}`
                : (chat.pendingApproval.paths ?? []).join("\n")}
            </pre>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝时说明理由（会回灌给模型，它据此换个办法）"
              aria-label="拒绝理由"
            />
            <div className="btn-row">
              <button type="button" onClick={() => void resolveApproval(true, "once")}>
                允许这一次
              </button>
              <button type="button" onClick={() => void resolveApproval(true, "session")}>
                本次会话都不再问
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void resolveApproval(false, "once", reason);
                  setReason("");
                }}
              >
                拒绝
              </button>
            </div>
          </div>
        ) : null}

        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行：与主流编码智能体的 composer 一致。
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          placeholder="说一句要它做什么（Enter 发送，Shift+Enter 换行）"
          aria-label="会话输入"
        />
        <div className="btn-row">
          <button type="button" onClick={() => void sendChat()} disabled={busy || input.trim() === ""}>
            发送
          </button>
        </div>
      </section>
    </div>
  );
}
