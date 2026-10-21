import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import {
  changeStat,
  changesHeadline,
  collectChangedFiles,
  type FileChangeView,
} from "../../shared/chat-changes";
import { diffText } from "../../shared/text-diff";
import type { InlineComment } from "../types";

/**
 * 右栏 · 改动审查（M2 + M3a 行级评论）。
 *
 * 与左栏的分工：左栏选**哪条线**，这一栏看**这条线动过什么**。它从中栏转录里
 * 聚合补丁改动（`shared/chat-changes` 的纯逻辑），所以不需要新的 IPC ——
 * 数据本来就在会话条目里，此前的问题是它被摊在几百行工具输出中间，要滚到底
 * 才看得见。
 *
 * 四条纪律：
 * 1. **撤销按 (turn, path) 做**：同一个文件被多个回合改过时，默认撤的是最近
 *    一次，恢复到"那次补丁之前"，不是恢复到项目初始状态。界面上每轮都可选，
 *    不把这件事藏成"一键还原"。
 * 2. **不可撤销的改动仍然列出来**（超过记录上限、没存 before/after 的那些）——
 *    藏起来等于瞒；按钮缺席、原因写在行里。
 * 3. **行级评论是一次性附录**（M3a）：挂在具体某一行上，下一条消息发出时整批
 *    拼进 prompt 并清空。评论必须带 (文件, 轮次, 行号, 改前/改后) —— diff 来自
 *    会话内快照而不是盘上现状，少一样模型就只能靠猜是哪一行。
 * 4. 空态说清楚"这里为什么是空的"：没有补丁 ≠ 没有干活（它可能只读了文件）。
 */

const DIFF_MARK: Record<string, string> = { same: " ", add: "+", del: "-" };

/** diff 一行的行内评论入口 + 已有评论标记。 */
function LineCommentButton({
  line,
  side,
  comments,
  onAdd,
  onRemove,
}: {
  line: number;
  side: "before" | "after";
  comments: InlineComment[];
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  if (comments.length === 0 && !open) {
    return (
      <button
        type="button"
        className="review-line-add"
        title={`给${side === "before" ? "改前" : "改后"}第 ${line} 行加评论`}
        onClick={() => setOpen(true)}
      >
        +
      </button>
    );
  }
  return (
    <span className="review-line-comments">
      {comments.map((c) => (
        <span key={c.id} className="review-line-comment" title={`${c.text}（点 × 删除）`}>
          {c.text}
          <button type="button" className="review-line-del" onClick={() => onRemove(c.id)} aria-label="删除评论">
            ×
          </button>
        </span>
      ))}
      {open ? (
        <span className="review-line-draft">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim() !== "") {
                onAdd(draft.trim());
                setDraft("");
                setOpen(false);
              }
              if (e.key === "Escape") {
                setDraft("");
                setOpen(false);
              }
            }}
            placeholder="这一行要怎么改（Enter 提交，Esc 取消）"
            aria-label="行级评论内容"
          />
        </span>
      ) : (
        <button type="button" className="review-line-add" title="再加一条" onClick={() => setOpen(true)}>
          +
        </button>
      )}
    </span>
  );
}

function DiffBody({
  change,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  change: FileChangeView;
  comments: InlineComment[];
  onAddComment: (c: { line: number; side: "before" | "after"; text: string }) => void;
  onRemoveComment: (id: string) => void;
}) {
  const d = diffText(change.before ?? undefined, change.after ?? undefined);
  if (d.lines.length === 0) {
    return (
      <p className="muted">
        {change.revertable ? "内容未变" : "没有记录可显示的内容（超出记录上限）"}
      </p>
    );
  }
  // 行号按**改后**顺序数（`add`/`same`），另按改前给 `del` 行一个对应号 ——
  // 同一个数字在两侧指的不是同一行，所以评论必须带 side。
  let afterNo = 0;
  let beforeNo = 0;
  return (
    <pre className="chat-diff review-diff">
      {d.lines.slice(0, 600).map((line, i) => {
        if (line.kind === "add") afterNo += 1;
        if (line.kind === "del") beforeNo += 1;
        if (line.kind === "same") {
          afterNo += 1;
          beforeNo += 1;
        }
        const side = line.kind === "del" ? "before" : "after";
        const no = side === "before" ? beforeNo : afterNo;
        const mine = comments.filter((c) => c.side === side && c.line === no);
        return (
          <span key={i} className={`diff-${line.kind} review-line`}>
            <span className="review-line-no">{no}</span>
            {`${DIFF_MARK[line.kind] ?? " "}${line.text}\n`}
            <LineCommentButton
              line={no}
              side={side}
              comments={mine}
              onAdd={(text) => onAddComment({ line: no, side, text })}
              onRemove={onRemoveComment}
            />
          </span>
        );
      })}
    </pre>
  );
}

export function ReviewRail({ onClose }: { onClose: () => void }) {
  const entries = useApp((s) => s.chat.entries);
  const status = useApp((s) => s.chat.status);
  const revertChat = useApp((s) => s.revertChat);
  const comments = useApp((s) => s.chat.comments);
  const addComment = useApp((s) => s.addInlineComment);
  const removeComment = useApp((s) => s.removeInlineComment);
  const clearComments = useApp((s) => s.clearInlineComments);
  const dropComments = useApp((s) => s.dropInlineCommentsFor);
  const exportThread = useApp((s) => s.exportChat);
  const [selected, setSelected] = useState<string | null>(null);
  const [push, setPush] = useState(false);
  const [exporting, setExporting] = useState(false);

  const groups = useMemo(() => collectChangedFiles(entries), [entries]);
  const busy = status === "running" || status === "awaiting-approval";

  // 选中项与评论都随聚合结果收敛：文件被撤掉后它不该继续留在选中态（那会渲染一个
  // 空面板，看着像"加载中"），指向它的评论也失去了指涉对象。
  useEffect(() => {
    if (selected !== null && !groups.some((g) => g.path === selected)) setSelected(null);
  }, [groups, selected]);

  const active = groups.find((g) => g.path === selected) ?? null;
  const activeComments = active ? comments.filter((c) => c.path === active.path) : [];

  return (
    <aside className="review-rail" aria-label="改动审查">
      <div className="review-rail-head">
        <span className="hud-stat-label">改动</span>
        <span className="btn-row">
          {groups.length > 0 ? (
            <>
              <label className="muted review-push" title="默认只建本地分支；显式勾选才会 push">
                <input
                  type="checkbox"
                  checked={push}
                  onChange={(e) => setPush(e.target.checked)}
                  disabled={busy || exporting}
                />
                推送
              </label>
              <button
                type="button"
                className="small"
                disabled={busy || exporting}
                title={
                  push
                    ? "导出为 git 分支并推送到设置的 remote"
                    : "导出为 git 分支 + commit（不推送；当前工作树会切到该分支）"
                }
                onClick={() => {
                  setExporting(true);
                  void exportThread(push).finally(() => setExporting(false));
                }}
              >
                {exporting ? "导出中…" : "导出分支"}
              </button>
            </>
          ) : null}
          {comments.length > 0 ? (
            <button type="button" className="small" onClick={() => void clearComments()} title="丢掉全部待处理评论">
              评论 {comments.length}
            </button>
          ) : null}
          <button type="button" className="small" onClick={onClose} title="收起右栏（窄屏时自动折叠）">
            收起
          </button>
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="muted review-rail-empty">
          本线程还没有补丁改动。它可能只读了文件、跑了命令 —— 那些不在这里，在中间的转录里。
        </p>
      ) : (
        <>
          <p className="muted review-rail-headline">{changesHeadline(groups)}</p>
          <div className="review-rail-files" data-testid="review-files">
            {groups.map((g) => {
              const stat = changeStat(g.latest);
              return (
                <button
                  key={g.path}
                  type="button"
                  className={`review-file${g.path === selected ? " active" : ""}`}
                  onClick={() => setSelected(g.path === selected ? null : g.path)}
                  title={g.path}
                >
                  <span className="review-file-path">{g.path}</span>
                  <span className="muted review-file-meta">
                    {g.edits > 1 ? `${g.edits} 轮 · ` : ""}第 {g.latest.turn} 轮
                    {stat ? ` · +${stat.added}/-${stat.deleted}` : ""}
                    {g.latest.created ? " · 新建" : ""}
                    {g.revertable ? "" : " · 不可撤销"}
                  </span>
                </button>
              );
            })}
          </div>

          {active ? (
            <div className="review-rail-detail" data-testid="review-detail">
              <div className="review-rail-detail-head">
                <span className="hud-stat-label">{active.path}</span>
                {/* 不可撤销时按钮**缺席**而不是置灰：这一行已经有"不可撤销"的
                    标注与 title 说明，再摆一个点不动的按钮只是重复同一句话。 */}
                {active.latest.revertable ? (
                  <button
                    type="button"
                    className="small danger"
                    disabled={busy}
                    onClick={() => {
                      // 撤销与清评论必须同一次点击完成：这一轮的改动没了，
                      // 挂在它行上的评论就失去了指涉对象 —— 留着会指向
                      // 一个已经不存在的 diff（模型收到也对照不上）。
                      void revertChat(active.latest.turn, active.path);
                      dropComments(active.path, active.latest.turn);
                    }}
                    title={`恢复到第 ${active.latest.turn} 轮补丁之前（不是项目初始状态）`}
                  >
                    撤销此文件
                  </button>
                ) : (
                  <span className="muted">不可撤销</span>
                )}
              </div>

              {active.history.length > 1 ? (
                <div className="review-turns" data-testid="review-turns">
                  <span className="hud-stat-label">各轮改动</span>
                  {active.history.map((h) => (
                    <span key={h.turn} className="muted review-turn">
                      第 {h.turn} 轮{h.revertable ? "" : "（不可撤销）"}
                    </span>
                  ))}
                </div>
              ) : null}

              <DiffBody
                change={active.latest}
                comments={activeComments}
                onAddComment={(c) =>
                  addComment({ path: active.path, turn: active.latest.turn, ...c })
                }
                onRemoveComment={removeComment}
              />
              {activeComments.length > 0 ? (
                <p className="muted review-comment-hint">
                  {activeComments.length} 条评论会随下一条消息一起发出（发完清空）。没有评论涉及的代码严格保持不动。
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
