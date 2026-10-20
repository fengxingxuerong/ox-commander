import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useApp, REMEDY_VERB } from "../store";
import { AuditPanel } from "../components/AuditPanel";
import { DeliveryPanel } from "../components/DeliveryPanel";
import { PreviewPanel } from "../components/PreviewPanel";
import { STAGE_ORDER, type FailureClass, type Stage } from "../../shared/types";
import type { ReceiptTaskStatus, ReceiptVerdict } from "../../shared/delivery-receipt";
import { usageFact } from "../../shared/usage-meter";
import type { FileDiff } from "../../shared/text-diff";
import type { TaskTrail, TrailRun } from "../../electron/board-derive";

/**
 * 阶段标签。键是 `Record<Stage, string>`（2026-10-09 盲区补扫收口）：此前是
 * `Record<string, string>`，新增一个 `Stage` 时这里静默漏一档、界面回落到
 * `?? s` 吐英文 token —— 与 `ERROR_LABELS` 同病，同样按"把手抄换成编译期事实"处置。
 * `check:exhaustive-maps` 现在也管这张表（联合类型键 ⇒ 逐档登记）。
 */
const STAGE_LABELS: Record<Stage, string> = {
  PRD: "① 需求理解",
  PLANNING: "② 任务分解",
  DEVELOPMENT: "③ 并行开发",
  VERIFICATION: "④ 硬性验证",
  DELIVERY: "⑤ 集成交付",
  DONE: "✅ 已交付",
};

/**
 * Failure classes in operator language.
 *
 * 键的**类型**是整个收口的核心：`Record<FailureClass, string>` 缺一键是
 * **编译错**，而不是等某个人把两张表并排对照才发现（2026-10-07）。
 * 此前它是 `Record<string, string>`，于是引擎自写的 `contract` 这一档
 * 一直没进这张表 —— 契约路径违规（文件交成了 `index` 布局那种错）在中文
 * 界面里吐出一个英文裸 token，而那一档恰恰是 2026-10-06 真实拆解 e2e
 * 里最花时间的一个场景。
 *
 * ⚠️ 值已在边界经 `isFailureClass` 收窄，正常情况下这里不会遇到表外的键；
 * 渲染处仍保留 `?? t.errorClass` 那句兜底 —— 界面宁可吐 token，也不该白屏。
 */
const ERROR_LABELS: Record<FailureClass, string> = {
  auth: "密钥/鉴权",
  "rate-limit": "限流",
  timeout: "超时",
  protocol: "协议/输出格式",
  conflict: "zone 越权",
  resource: "资源",
  "no-agent": "无可用智能体",
  contract: "契约路径违规（点名的文件没落在盘上）",
  loop: "循环空转（同一输出反复刷，已被中止）",
  unknown: "未知",
};

/** 静默超过这个秒数才点名 —— 短静默是常态（执行器在跑长命令）。 */
const SILENCE_THRESHOLD_S = 30;

/**
 * 静默提示文案（纯函数，测试直接打表）：静默不足阈值返回 undefined（不显示），
 * 超过则给"⏸ 静默 Xs"。"可能挂死"这句话刻意不带 —— 点名是提醒不是断言。
 */
export function SILENCE_LABEL(lastActivityTs: number, now: number): string | undefined {
  const silentS = Math.floor((now - lastActivityTs) / 1000);
  if (silentS < SILENCE_THRESHOLD_S) return undefined;
  return `⏸ 静默 ${silentS}s`;
}

/**
 * 逐行窗口化样式。两个属性是**性能机制不是皮肤**，所以跟着组件走而不是进
 * styles.css —— 读 LogView 的人应该在同一屏里看到"它为什么不卡"。
 *
 * `content-visibility: auto`：视口外的行，浏览器跳过布局与绘制（DOM 里仍在，
 * 可选中、可复制、find-in-page 照样找得到）。`contain-intrinsic-size` 的
 * 20px 是**占位高度**（line-height 1.7 × 12px ≈ 20.4px）：从未渲染过的行按它
 * 撑高度，Chromium 渲染出真实高度后会记住（`auto` 关键字），滚动条因此
 * 不会突然变短。
 *
 * ⚠️ jsdom 的 CSSOM 不认这两个属性（setProperty 静默丢弃），所以单测钉的是
 * **结构**（一行一个 `.log-line`），跳过渲染的行为由 Chromium 的标准机制保证，
 * 不在单测里假装验证。
 */
const LOG_LINE_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 20px",
};

/**
 * 日志视图（2026-10-13 从 BoardPage 拆出 + memo；2026-10-14 帧合并 + 逐行
 * 窗口化）。此前 `logs` 由 BoardPage 整页订阅 —— 日志风暴（每条事件一次 set）
 * 会重渲染整页（任务列表/凭据/审计跟着跑），这是长任务下的首要渲染成本。
 * 拆出后只有本组件订阅 `logs`：非 logs 的状态变化不再触碰它。
 *
 * 2026-10-14 又清掉两笔账（全栈评价的前端性能项）：
 * ① **频率无上界**：流式输出时日志事件可以几十条/秒，每条都走一次
 *    setState → 整块文本重建 → 整块重排，而屏幕 60fps 封顶 —— 中间态没有
 *    任何观察价值。修为按帧合并：一帧之内到达的多次更新只渲染最后一次。
 * ② **单帧成本 O(全部行)**：`<pre>` 是一整个文本块，每帧重排全部（store 侧
 *    已夹到 500 条，折行后视觉行更多）。修为逐行 `<div>` + 上面的
 *    content-visibility：视口外的行不参与布局。
 *
 * 为什么不用手动窗口化（算 scrollTop 切行 + 上下占位 div）：`.log-view` 是
 * `pre-wrap`，折行让视觉行高可变，按行切窗口的行高数学不成立；改成不换行
 * （`pre` + 横滚）又是拿可读性换性能。content-visibility 按**元素**跳过，
 * 两种代价都不付。（将来要精确控制滚动条再上测量方案，那更贵。）
 */
const LogView = memo(function LogView() {
  const logs = useApp((s) => s.logs);
  // 帧合并：logs 引用变化才调度；rAF 触发时渲染**当时最新**的 logs ——
  // 先到后到以最后一次为准，中间态不上屏。cleanup 取消上一次调度，
  // 所以并发到达的多次更新天然合并成一个帧。
  // jsdom（vitest 默认 pretendToBeVisual）有 rAF；没有时退化为同步渲染。
  const [frame, setFrame] = useState(logs);
  useEffect(() => {
    if (frame === logs) return;
    if (typeof requestAnimationFrame !== "function") {
      setFrame(logs);
      return;
    }
    const raf = requestAnimationFrame(() => setFrame(logs));
    return () => cancelAnimationFrame(raf);
  }, [logs, frame]);
  // 终端行为：跟随新输出，除非操作者上滚看历史 —— 那就暂停钉底，滚回底部附近恢复。
  const logRef = useRef<HTMLDivElement>(null);
  const logPinnedRef = useRef(true);
  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    logPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && logPinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [frame]);
  return (
    <div ref={logRef} onScroll={handleLogScroll} className="log-view">
      {frame.length === 0 ? (
        "等待开始…"
      ) : (
        // key 用下标：store 侧 slice(-500) 让数组整体左移，"稳定 id" 要先给
        // 日志行编号（store 重构）；而帧合并已把全量 diff 从"事件速率"降到
        // "帧速率"—— 一帧 500 个文本节点，量级可接受。
        frame.map((line, i) => (
          <div key={i} className="log-line" style={LOG_LINE_STYLE}>
            {line}
          </div>
        ))
      )}
    </div>
  );
});

/**
 * 复核裁决的操作员语言（五档刻意不并档 —— 每档该做的事完全不同）。
 * "verified" 是唯一能说"凭据可信"的档；其余四档各有各的处置。
 */
const RECEIPT_VERDICT_LABELS: Record<ReceiptVerdict, string> = {
  verified: "✅ 复现（指纹一致 + 复跑全对）",
  "not-replayed": "🧾 未复跑（指纹一致，只查了完整性）",
  tampered: "🚨 内容被改过（指纹对不上，别再比对它）",
  unsigned: "⚠️ 未盖章，无从判断完整性",
  contradicted: "❌ 与环境观察矛盾（指纹一致但复跑对不上）",
};

/** 凭据任务账的状态图标（与看板任务状态同色系，但这里是**结论**不是进度）。 */
const RECEIPT_TASK_ICON: Record<ReceiptTaskStatus, string> = {
  done: "✅",
  failed: "❌",
  skipped: "⏭",
  pending: "⏸",
};

/**
 * 一次派发在界面上的一句话：谁跑的 · 多久 · 结局。
 *
 * 结局是**四档**而不是两档，因为 `TrailRun` 的两个布尔字段各自可以缺席，而缺席
 * 是唯一诚实的表达（`board-derive.ts` 的原话）：`endedAt` 缺席 = 这次派发没有
 * 收尾（进程被腰斩 / 重派时前一次还没回来），`ok` 缺席 = run-end 里没带裁决。
 * 把这两种都折进"失败"，就是替审计**编造因果**。
 */
export function TRAIL_RUN_LINE(run: TrailRun): string {
  const who = run.agentId ?? "未知执行器";
  const how = run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)}s` : "时长未知";
  const verdict =
    run.endedAt === undefined
      ? "⚠️ 未收尾"
      : run.ok === true
        ? "✅ 成功"
        : run.ok === false
          ? "❌ 失败"
          : "结局未知";
  return `${who} · ${how} · ${verdict}`;
}

/**
 * 履历的取数状态。四档分开是为了让界面能如实说清"为什么这里是空的" ——
 * 取不到和"审计里本来就没记录"是两件事，前者要能被看见（IPC 挂了会静默失败）。
 */
type TrailState =
  | { kind: "loading" }
  | { kind: "ready"; trail: TaskTrail }
  | { kind: "error"; message: string };

/** 任务运行履历（`audit:trail` 的界面出口）。 */
function TrailView({ state }: { state?: TrailState }) {
  if (state?.kind === "loading") return <p className="muted">正在读取履历…</p>;
  if (state?.kind === "error") return <p className="muted">读不到履历：{state.message}</p>;
  if (!state || state.trail.runs.length === 0) {
    return <p className="muted">审计里没有这个任务的派发记录</p>;
  }
  return (
    <ol className="trail-list">
      {state.trail.runs.map((run, i) => (
        // 键用「开始时间 + 序号」：同一毫秒重派的两次都留着，序号兜住同 ts 的碰撞
        <li key={`${run.startedAt ?? "?"}#${i}`} className={run.endedAt === undefined ? "trail-open" : ""}>
          <span className="trail-index">#{i + 1}</span>
          <span className="trail-line">{TRAIL_RUN_LINE(run)}</span>
          {run.errorClass !== undefined && (
            <span className="task-meta error-class">
              错误类型：{ERROR_LABELS[run.errorClass] ?? run.errorClass}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * 批次改动记录（`changes:list` 的返回形状）。files 截断上限 100（主进程侧），
 * 超限有 filesTotal —— 界面把"没显示的"说出来。
 *
 * `archiveId`（B1 第二半）：本批备份的存档 id。有它才点亮 diff / 回滚按钮；
 * 缺席的三种情况（未配置快照存储、存档失败已回收、纯新建批）按钮不出现，
 * 底部说明文字念出来 —— 不放必然失败的按钮。
 */
type ChangeRecord = {
  ts: string;
  projectId?: string;
  changed?: number;
  paths?: string[];
  files?: Array<{ path: string; op: string; bytes?: number }>;
  filesTotal?: number;
  archiveId?: string;
};

const OP_ICON: Record<string, string> = { create: "➕", modify: "✏️", delete: "🗑" };

/** diff 取数的三态（每个文件行各自一份，按 path 归属）。 */
type DiffState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "shown"; path: string; diff: FileDiff }
  | { kind: "error"; path: string; message: string };

/** 回滚结果的一行反馈（成功也说 —— "点了之后发生了什么"要可见）。 */
type RevertNote = { path: string; message: string } | null;

function revertOkText(action: "restored" | "removed" | "already-gone"): string {
  if (action === "restored") return "已恢复为存档里的旧内容。";
  if (action === "removed") return "已删除（本批新建的文件，没有旧内容可恢复）。";
  return "文件已不在盘上，无需操作。";
}

/**
 * diff 状态的人话说明（纯函数）。
 *
 * ⚠️ 逐档登记、**不留 default**：`check:exhaustive` 管的就是"被 default 吞掉的档"
 * （tsc 只兜得住 Record 缺键，switch + default 是它的盲区）。这里六档全列，
 * 将来 DiffStatus 加一档会先在 typecheck 报"函数可能返回 undefined"。
 */
function diffStatusText(status: FileDiff["status"]): string {
  switch (status) {
    case "modified":
      return "";
    case "created":
      return "本批新建的文件（没有旧内容）。";
    case "deleted":
      return "文件已不在盘上（本批删除，或之后被别的东西删了）。";
    case "unchanged":
      return "与存档相比没有变化（这一批之后没有再动过它）。";
    case "binary":
      return "二进制文件，不渲染内容。";
    case "too-large":
      return "文件行数超过渲染上限，只显示统计。";
  }
}

/** 行级 diff 渲染。增删不只靠颜色：每行带 +/- 号与行号（色觉无障碍）。 */
function DiffView({ diff }: { diff: FileDiff }) {
  const head = diffStatusText(diff.status);
  return (
    <div className="diff-view">
      <p className="muted">
        {head}
        {diff.status === "modified" || diff.status === "created" || diff.status === "deleted"
          ? ` +${diff.added ?? "—"} / -${diff.deleted ?? "—"} 行`
          : ""}
        {diff.truncated ? "（内容已截断）" : ""}
      </p>
      {diff.lines.length > 0 ? (
        <div className="diff-lines">
          {diff.lines.map((l, i) => (
            <div key={`${l.beforeNo ?? 0}-${l.afterNo ?? 0}-${i}`} className={`diff-line diff-${l.kind}`}>
              <span className="diff-no">{l.beforeNo ?? ""}</span>
              <span className="diff-no">{l.afterNo ?? ""}</span>
              <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
              <span className="diff-text">{l.text === "" ? " " : l.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 批次改动面板（`changes:list` 的界面出口，竞品缺口 B1：第一半"改了哪些文件"，
 * 第二半"改了什么、能不能只撤这一个"）。
 *
 * 取数是懒加载 + 手动刷新：改动是批次结算时落的审计事实，run 进行中会持续
 * 增加，但没有值得为它开推送通道的事件量（一批一条）。
 *
 * 回滚的边界（2026-10-17 第二半起有真实备份支撑）：只回滚**有存档**的批次，
 * 从该批存档恢复 before；本批新建的文件撤销新建（需审计里的 create 证据，
 * 没有证据主进程拒绝删除）。它不是 git 操作，也不跨批次 —— 回滚后该批的
 * 审计记录与存档仍在（事实不因为回滚消失），后续批次若又改过同一文件，
 * 这里恢复的是**这一批**的旧内容，界面在确认框里说破这一点。
 */
function ChangesPanel() {
  const activeProjectId = useApp((s) => s.activeProjectId);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; records: ChangeRecord[] } | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [diff, setDiff] = useState<DiffState>({ kind: "idle" });
  const [revertNote, setRevertNote] = useState<RevertNote>(null);
  const load = () => {
    setState({ kind: "loading" });
    window.oxCommander
      .listChanges(activeProjectId ?? undefined)
      .then((records) => setState({ kind: "ready", records }))
      .catch((e: unknown) => setState({ kind: "error", message: (e as Error).message }));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 取数跟随项目切换
  }, [activeProjectId]);

  const showDiff = (batchId: string, filePath: string) => {
    setRevertNote(null);
    setDiff({ kind: "loading", path: filePath });
    window.oxCommander
      .fileDiff(batchId, filePath)
      .then((res) =>
        res.ok
          ? setDiff({ kind: "shown", path: filePath, diff: res.diff })
          : setDiff({ kind: "error", path: filePath, message: res.reason }),
      )
      .catch((e: unknown) => setDiff({ kind: "error", path: filePath, message: (e as Error).message }));
  };

  const revert = (batchId: string, filePath: string, op: string) => {
    // 二次确认把后果说清：这是直接改工作区，不是 git 操作；新建文件会被删掉。
    const what = op === "create" ? "删除这个文件（本批新建，没有旧内容）" : "用本批存档里的旧内容覆盖当前文件";
    if (!window.confirm(`回滚 ${filePath}？\n${what}。\n这是直接改工作区的操作，不走 git；之后若有别的批次又改过它，恢复的是本批的旧内容。`)) {
      return;
    }
    setDiff({ kind: "idle" });
    window.oxCommander
      .revertFile(batchId, filePath)
      .then((res) => {
        setRevertNote({ path: filePath, message: res.ok ? revertOkText(res.action) : `回滚被拒绝：${res.reason}` });
        if (res.ok) load();
      })
      .catch((e: unknown) =>
        setRevertNote({ path: filePath, message: `回滚失败：${(e as Error).message}` }),
      );
  };

  if (state.kind === "loading") return <p className="muted">正在读取改动…</p>;
  if (state.kind === "error") return <p className="muted">读不到改动记录：{state.message}</p>;
  return (
    <section className="card">
      <h3>
        改动文件
        <button className="refresh-btn" onClick={load} title="重新读取">
          ↻
        </button>
      </h3>
      {state.records.length === 0 ? (
        <p className="muted">还没有批次改动记录（跑一次就有了）</p>
      ) : (
        state.records.map((r, i) => {
          const files = r.files ?? [];
          return (
            <details className="failure-details" key={r.ts} open={i === 0}>
              <summary>
                {new Date(r.ts).toLocaleTimeString()} · {r.changed ?? files.length} 个文件
                {r.filesTotal !== undefined ? `（清单截断，共 ${r.filesTotal}）` : ""}
                {r.archiveId ? " · 有存档" : ""}
              </summary>
              {files.map((f) => (
                <div key={f.path} className="change-row">
                  <p className="task-meta">
                    {OP_ICON[f.op] ?? "·"} <code>{f.path}</code>
                    {f.bytes !== undefined ? ` · ${f.bytes} B` : ""}
                    {r.archiveId ? (
                      <span className="change-actions">
                        <button
                          className="link-btn"
                          onClick={() => showDiff(r.archiveId!, f.path)}
                          disabled={diff.kind === "loading" && diff.path === f.path}
                          title="看这一版的逐行 diff（存档旧内容 × 盘上现状）"
                        >
                          diff
                        </button>
                        <button
                          className="link-btn"
                          onClick={() => revert(r.archiveId!, f.path, f.op)}
                          title="从本批存档恢复这个文件（需二次确认）"
                        >
                          回滚
                        </button>
                      </span>
                    ) : null}
                  </p>
                  {diff.kind !== "idle" && diff.path === f.path ? (
                    diff.kind === "loading" ? (
                      <p className="muted">正在算 diff…</p>
                    ) : diff.kind === "error" ? (
                      <p className="muted">diff 取数失败：{diff.message}</p>
                    ) : (
                      <DiffView diff={diff.diff} />
                    )
                  ) : null}
                  {revertNote && revertNote.path === f.path ? (
                    <p className="muted">{revertNote.message}</p>
                  ) : null}
                </div>
              ))}
            </details>
          );
        })
      )}
      <p className="muted">
        每批改动是结算时落的审计事实；有「存档」标记的批次可看逐行 diff、可单文件回滚
        （从该批备份恢复，不走 git）。存档只保留最近 8 批，超出后旧批次的按钮随之消失；
        没有存档的批次（未配置快照存储 / 存档失败 / 纯新建批）不提供 diff 与回滚。
      </p>
    </section>
  );
}

/**
 * 任务附言编辑器（C2 的界面出口）。
 *
 * 三条边界写在组件里而不是藏进文档：① **下一次派发生效**，不是在途生成里
 * 插话（执行器全是一问一答形态）；② 任务成功后引擎自动清除；③ 只对在跑的
 * run 有效 —— 没有 run 时主进程抛错，这里把错误原样显示出来（"静默成功"
 * 会让人以为附言在跑之前就存下来了）。
 */
function TaskNoteEditor({ taskId, note }: { taskId: string; note?: string }) {
  const [draft, setDraft] = useState(note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = (value: string) => {
    setSaving(true);
    setError(null);
    window.oxCommander
      .setTaskNote(taskId, value)
      .then(() => setDraft(value.trim()))
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setSaving(false));
  };
  const dirty = draft.trim() !== (note ?? "");
  return (
    <div className="task-note-editor">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="给这个任务的纠偏指示，保存后下一次派发生效（任务成功后自动清除）"
        rows={2}
      />
      <div className="btn-row">
        <button className="primary" onClick={() => save(draft)} disabled={saving || !dirty} title="保存附言">
          保存附言
        </button>
        {note ? (
          <button onClick={() => save("")} disabled={saving} title="清除附言">
            清除
          </button>
        ) : null}
      </div>
      {error && <p className="error-text">{error}</p>}
      {note ? <p className="muted">当前附言将在下一次派发时带进 prompt。</p> : null}
    </div>
  );
}

export function BoardPage() {
  const stage = useApp((s) => s.stage);
  const tasks = useApp((s) => s.tasks);
  const verification = useApp((s) => s.verification);
  const receipt = useApp((s) => s.receipt);
  const usage = useApp((s) => s.usage);
  const lines = useApp((s) => s.lineHealth);
  const escalations = useApp((s) => s.escalations);
  const approvals = useApp((s) => s.approvals);
  const resolveEscalation = useApp((s) => s.resolveEscalation);
  const resolveApproval = useApp((s) => s.resolveApproval);
  const interrupted = useApp((s) => s.interrupted);
  // 静默显示的时钟：心跳只在事件到达时更新，"已经静默多久"需要一个周期性 tick
  // 才能自己走表 —— 5s 一跳，足够了（静默阈值是 30s）。
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTickNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  /*
   * 任务运行履历（P1-3 `audit:trail` 的界面出口，2026-10-14 接线）。
   *
   * 懒加载 + 每任务只取一次：履历是**归档事实**，不会在本次 run 里变；而任务行
   * 可能有几十条，挂载时逐个打 IPC（每个 handler 都要 `read({limit:5000})` 全量
   * 审计）会成为看板打开时的固定成本。所以取数时机 = 操作者真的展开那一条。
   *
   * `requested` 用 ref 而不是从 state 派生：它记的是"**已经承诺过**取数"，
   * 而 state 的更新是异步的 —— 连点两下展开会在两次渲染之间重复打 IPC。
   * 失败时从表里摘掉，让"再展开一次"能真的重试（失败不是终态）。
   */
  const [trails, setTrails] = useState<Record<string, TrailState>>({});
  const trailRequested = useRef(new Set<string>());
  const loadTrail = (taskId: string): void => {
    if (trailRequested.current.has(taskId)) return;
    trailRequested.current.add(taskId);
    setTrails((prev) => ({ ...prev, [taskId]: { kind: "loading" } }));
    void window.oxCommander
      .taskTrail(taskId)
      .then((trail) => setTrails((prev) => ({ ...prev, [taskId]: { kind: "ready", trail } })))
      .catch((e: unknown) => {
        trailRequested.current.delete(taskId);
        setTrails((prev) => ({
          ...prev,
          [taskId]: { kind: "error", message: (e as Error).message },
        }));
      });
  };
  const lastActivityTs = useApp((s) => s.lastActivityTs);
  const runStartedAt = useApp((s) => s.runStartedAt);
  const verifyReceiptAction = useApp((s) => s.verifyReceipt);
  const receiptVerdict = useApp((s) => s.receiptVerdict);
  const loadRecovery = useApp((s) => s.loadRecovery);
  const start = useApp((s) => s.confirmAndExecute);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const cancel = () => void window.oxCommander.cancel();
  const pause = () => void window.oxCommander.pause();
  const resume = () => void window.oxCommander.resume();
  const setPage = useApp((s) => s.setPage);
  // 用量事实的判定（可信边界、盲区提示、模型排序）都在 usageFact 里，UI 只负责摆。
  const fact = usage ? usageFact(usage) : undefined;
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // Board recovery: on mount, rebuild the view from the durable audit trail
  // (facts/derived split). Idempotent — the store merge is additive, and the
  // live push events keep overwriting from here on.
  useEffect(() => {
    void loadRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);
  const openWorkspace = async () => {
    if (!activeProjectId) return;
    setWorkspaceError(null);
    try {
      await window.oxCommander.openWorkspace(activeProjectId);
    } catch (err) {
      setWorkspaceError((err as Error).message);
    }
  };

  const taskList = Object.values(tasks);
  // 运行态判据（2026-10-13）：引擎只在 run 活着时把 PLANNING→DELIVERY 推过来；
  // 凭据出现 = 本 run 已有结论（failed 也是结论）。confirmAndExecute 会清掉上一轮的
  // receipt/verification，所以"重新开始"也能正确回到运行态。此前四个控制按钮
  // 恒可点 —— 没跑的时候取消/暂停是必报错的无效操作，跑的时候还能再点一次开始。
  const runActive =
    (stage === "PLANNING" || stage === "DEVELOPMENT" || stage === "VERIFICATION" || stage === "DELIVERY") &&
    receipt === undefined;

  return (
    <div className="page board">
      <header className="board-header">
        <button onClick={() => setPage("projects")}>← 项目列表</button>
        <h2>任务看板</h2>
        <button onClick={() => void openWorkspace()} title="在资源管理器中打开工作区目录">
          📂 打开工作区
        </button>
        {workspaceError && <span className="error-text">{workspaceError}</span>}
      </header>

      {interrupted && (
        <div className="recovery-banner" role="alert">
          ⚠️ 上一次运行未正常收尾（进程被中断），以下为审计日志恢复的当时进度。
          {lastActivityTs ? ` 最后活动时间：${new Date(lastActivityTs).toLocaleString()}` : ""}
        </div>
      )}

      {!activeProjectId && (
        <p className="empty-hint">还没有选中项目 —— 先回「项目库」点一个项目名，或在那里新建。</p>
      )}

      <div className="board-columns">
        {/* 左栏：阶段进度 + 任务列表（DAG 分组） */}
        <aside className="col col-left">
          <p className="col-label">① 进度 · 这一步跑到哪了</p>
          <section className="card">
            <h3>
              流水线阶段
              {runActive && runStartedAt !== undefined && (
                <span className="task-meta"> · ⏱ 已耗时 {Math.max(0, Math.floor((tickNow - runStartedAt) / 1000))}s</span>
              )}
            </h3>
            <ol className="stage-list">
              {STAGE_ORDER.map((s) => (
                <li key={s} className={s === stage ? "current" : ""}>
                  {STAGE_LABELS[s] ?? s}
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h3>任务</h3>
            <p className="card-sub">
              左侧圆点是状态：青=在跑 · 绿=完成 · 红=失败 · 灰=已取消。每条任务可展开看运行履历、挂纠偏附言。
            </p>
            {taskList.length === 0 && <p className="muted">尚未分解</p>}
            {taskList.map((t) => (
              <div key={t.taskId} className={`task-row status-${t.status}`}>
                <span className="task-title">{t.title}</span>
                <span className="task-meta">
                  {t.zone} · 第 {t.attempts} 次
                  {t.agentId ? ` · ${t.agentId}` : ""}
                  {t.durationMs !== undefined ? ` · ${(t.durationMs / 1000).toFixed(1)}s` : ""}
                  {/* 静默心跳（竞品吸收）：running 且 >30s 无任何 agent 事件时点名
                      —— "长任务在推进"与"可能挂死"从此在板子上长得不一样。 */}
                  {t.status === "running" && t.lastActivityTs !== undefined && (
                    <span className="heartbeat">{SILENCE_LABEL(t.lastActivityTs, tickNow)}</span>
                  )}
                </span>
                {t.status === "failed" && t.errorClass && (
                  <span className="task-meta error-class">错误类型：{ERROR_LABELS[t.errorClass] ?? t.errorClass}</span>
                )}
                {t.status === "failed" && t.failureDigest && (
                  <details className="failure-details">
                    <summary>❌ 失败原因</summary>
                    <pre>{t.failureDigest}</pre>
                  </details>
                )}
                {/* 上面那行 `第 N 次 / agentId / 耗时` 只反映**最后一次**派发
                    （看板视图是"现在是什么状态"）；要回答"它经历过什么" ——
                    前几次换过谁、各自怎么没成的 —— 得读归档履历。 */}
                <details
                  className="trail-details"
                  onToggle={(e) => {
                    if (e.currentTarget.open) loadTrail(t.taskId);
                  }}
                >
                  <summary>📜 运行履历</summary>
                  <TrailView state={trails[t.taskId]} />
                </details>
                {/* 操作者附言（C2）：升级裁决之外的常态化纠偏入口。
                    升级卡里也放一个（见下）—— 那里是"run 正卡着等人"的时刻，
                    带话重派比干巴巴的 redispatch 强得多。 */}
                <details className="task-note-details">
                  <summary>✏️ 附言{t.operatorNote ? "（已挂）" : ""}</summary>
                  <TaskNoteEditor taskId={t.taskId} note={t.operatorNote} />
                </details>
              </div>
            ))}
          </section>
        </aside>

        {/* 中栏：实时日志流 + 落盘审计。执行日志只活在内存里、重载即消失，
            审计日志回答的是"上一次到底发生过什么"（run 起止、批次守卫裁决）且重启不丢。
            两份事实放同一栏：操作者盯着的正是这里，不用换页去设置里翻 JSONL。 */}
        <main className="col col-center">
          <p className="col-label">② 实况 · 机器正在说什么</p>
          <section className="card log-card">
            <h3>执行日志</h3>
            <LogView />
          </section>
          <DeliveryPanel />
          <PreviewPanel />
          <ChangesPanel />
          <AuditPanel />
        </main>

        {/* 右栏：验证结果 / 升级提示 / 控制 */}
        <aside className="col col-right">
          <p className="col-label">③ 干预 · 你在这里拍板</p>
          <section className="card">
            <h3>
              控制
              <span className={`stage-chip${runActive ? " chip-ok" : ""}`}>{runActive ? "运行中" : "空闲"}</span>
            </h3>
            <p className="card-sub">
              开始 = 按已批准的 PRD 跑一轮；暂停只是挂起当前批次；取消会停掉整个 run。
            </p>
            <div className="btn-row">
              <button
                className="primary"
                onClick={() => void start()}
                disabled={runActive}
                title={runActive ? "已有 run 在跑；要重来先取消" : "按已批准的 PRD 开始一轮执行"}
              >
                开始
              </button>
              <button onClick={pause} disabled={!runActive} title={runActive ? "挂起当前批次" : "没有在跑的 run"}>
                暂停
              </button>
              <button onClick={resume} disabled={!runActive} title={runActive ? "从暂停处继续" : "没有在跑的 run"}>
                继续
              </button>
              <button className="danger" onClick={cancel} disabled={!runActive} title={runActive ? "终止整个 run" : "没有在跑的 run"}>
                取消
              </button>
            </div>
          </section>

          {/* 本次运行的 token 用量。`calls - measuredCalls`（端点没上报用量的次数）
              必须和总数一起显示 —— 否则"3k tokens"会被读成全部支出。 */}
          {fact && (
            <section className="card">
              <h3>本次运行用量</h3>
              <p className="card-sub">本次 run 真实烧掉的 token；「未上报」是端点没回用量的次数，那部分不可考。</p>
              <p className="task-meta">{fact.summary}</p>
              {fact.limit !== undefined && <p className="task-meta">预算上限 {fact.limit} tokens</p>}
              {fact.blindNote ? <p className="muted">{fact.blindNote}</p> : null}
            </section>
          )}

          {/* 线路健康：现在还有几条线能用、哪几条在被限流。与上面的用量是**两个
              维度**（一共烧了多少 vs 哪条线还能用），所以分开摆。 */}
          {lines && lines.length > 0 && (
            <section className="card">
              <h3>线路健康</h3>
              <p className="card-sub">冷却中的线路会自动跳过、请求落到下一条；连续失败越多，说明这条线在拖后腿。</p>
              <ul>
                {lines.map((l) => (
                  <li key={l.key} className="task-meta">
                    {l.cooling ? `冷却中（约 ${Math.ceil(l.remainingMs / 1000)}s）` : "可用"} ·{" "}
                    {l.key} · 失败 {l.failures} 次（限流 {l.rateLimitHits}）
                    {l.consecutiveFailures >= 2 ? ` · 连续坏 ${l.consecutiveFailures} 轮` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 交付凭据：一次运行唯一的对外结论。放在验证结果**之上** —— 验证回答
              "哪些命令红了"，凭据回答"这次到底交付了什么、凭什么"。 */}
          {receipt && (
            <section className="card">
              <h3>{receipt.outcome === "delivered" ? "📦 交付凭据" : "🚧 未交付"}</h3>
              <p className="muted">{receipt.headline}</p>
              <p className="task-meta">
                {receipt.counts.done}/{receipt.counts.total} 完成 · 跳过 {receipt.counts.skipped} ·
                失败 {receipt.counts.failed} · 未启动 {receipt.counts.pending} · 重修 {receipt.rounds} 轮
              </p>
              <ul>
                {receipt.checks.map((c, i) => (
                  <li key={`${c.kind}-${i}`} className="task-meta">
                    {c.ok ? "✅" : "❌"} {c.kind}
                    {c.ok ? "" : `（exit=${c.exitCode ?? "null"}）`}
                    {c.preexisting ? " · 本次运行前就已失败" : ""}
                    {c.headline ? ` · ${c.headline}` : ""}
                    {/* 外部可验证性的第一半：**把跑过的命令原样摆出来**。
                        没有它，"这份交付过了门禁"只是一句自述 —— 拿到凭据的人
                        只能选择相信我们；有了它，任何人在自己的环境里跑同一条
                        命令就能得到自己的观察。缺席 = 这条检查不经过命令。 */}
                    {c.command ? (
                      <span className="receipt-command">
                        <br />
                        <code>{[c.command, ...(c.args ?? [])].join(" ")}</code>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {/* 第二半：内容指纹。整串可见可选 —— 复核工具要拿它比对，
                  截短显示等于"看得到但用不了"。它保证内容与指纹一致，
                  不保证签名（能改凭据的人同样能重算指纹），这句话在类型注释里。 */}
              {receipt.fingerprint ? (
                <details className="failure-details">
                  <summary>内容指纹（点开取完整串，交给复核工具比对）</summary>
                  <pre>{receipt.fingerprint}</pre>
                </details>
              ) : null}
              {/* 第三半：**就地复核**（2026-10-13 把 receipt:verify 接上 UI）。此前
                  五档裁决只有 receipt-verify CLI 能出 —— 现在凭据卡一键可查。
                  默认 replay:false：先只查完整性与指纹，不执行凭据里的命令。 */}
              <div className="btn-row">
                <button onClick={() => void verifyReceiptAction()} title="本机复核：比对指纹与验证历史（默认不执行凭据里的命令）">
                  🔍 复核凭据
                </button>
              </div>
              {receiptVerdict && (
                <p className="task-meta">
                  复核裁决：{RECEIPT_VERDICT_LABELS[receiptVerdict.audit.verdict] ?? receiptVerdict.audit.verdict}
                  {receiptVerdict.replayed ? " · 已复跑" : " · 未复跑"}
                </p>
              )}
              {receipt.tasks.length > 0 && (
                <details className="failure-details">
                  <summary>任务账 {receipt.tasks.length} 条</summary>
                  {receipt.tasks.map((t) => (
                    <p key={t.id} className="task-meta">
                      {RECEIPT_TASK_ICON[t.status] ?? t.status} {t.title} · {t.zone} · {t.attempts} 次
                      {t.agentId ? ` · ${t.agentId}` : ""}
                      {t.durationMs !== undefined ? ` · ${(t.durationMs / 1000).toFixed(1)}s` : ""}
                      {t.errorClass ? ` · ${t.errorClass}` : ""}
                    </p>
                  ))}
                </details>
              )}
              {receipt.conflicts.length > 0 && (
                <details className="failure-details">
                  <summary>越权 {receipt.conflicts.length} 次（已处置）</summary>
                  {receipt.conflicts.map((c, i) => (
                    <p key={`${c.kind}-${i}`} className="task-meta">
                      {REMEDY_VERB[c.remedy] ?? c.remedy} · {c.kind} · {c.paths.join("、")}
                    </p>
                  ))}
                </details>
              )}
              {receipt.usage && (
                <p className="task-meta">
                  {receipt.usage.totalTokens} tokens · {receipt.usage.calls} 次调用
                  {receipt.usage.calls - receipt.usage.measuredCalls > 0
                    ? `（${receipt.usage.calls - receipt.usage.measuredCalls} 次未上报用量）`
                    : ""}
                </p>
              )}
            </section>
          )}

          {verification && (
            <section className="card">
              <h3>最近验证：{verification.passed ? "✅ 通过" : "❌ 未通过"}</h3>
              {verification.results.map((r) => (
                <div key={r.kind}>
                  <p>
                    {r.kind}: {r.ok ? "通过" : `失败 (exit=${r.exitCode})`} ·{" "}
                    {(r.durationMs / 1000).toFixed(1)}s
                  </p>
                  {!r.ok && r.logDigest && (
                    <details className="failure-details">
                      <summary>查看错误详情</summary>
                      <pre>{r.logDigest}</pre>
                    </details>
                  )}
                </div>
              ))}
            </section>
          )}

          {escalations.length > 0 && (
            <section className="card escalation">
              <h3>⚠️ 需要你决策</h3>
              <p className="card-sub">这些任务重修轮数用完仍未通过，停在这里等你处置：放弃它 / 再给一轮 / 终止整个项目。</p>
              {escalations.map((e) => (
                <div key={e.taskId} className="escalation-item">
                  <pre className="escalation-summary">{e.summary}</pre>
                  {e.resolved ? (
                    <p className="muted">已处理</p>
                  ) : (
                    <>
                      {/* 带话重派（C2）：先写附言再点重派，附言随下一次派发
                          进 prompt —— 这是"人在回路里"最常用的形态。 */}
                      <details className="task-note-details">
                        <summary>✏️ 带话重派（附言随下一次派发生效）</summary>
                        <TaskNoteEditor taskId={e.taskId} note={tasks[e.taskId]?.operatorNote} />
                      </details>
                      <div className="btn-row">
                      <button onClick={() => void resolveEscalation(e.taskId, "skip")} title="放弃该任务，继续交付其余部分">
                        跳过
                      </button>
                      <button className="primary" onClick={() => void resolveEscalation(e.taskId, "redispatch")} title="追加一轮修复并重派">
                        重派一次
                      </button>
                      <button className="danger" onClick={() => void resolveEscalation(e.taskId, "abort")} title="终止整个项目执行">
                        终止
                      </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}

          {approvals.length > 0 && (
            <section className="card escalation">
              <h3>🛂 命令需要审批</h3>
              <p className="card-sub">沙箱拦下了这条命令（不在白名单里）。批准只在本批次内有效；拒绝会记成一次验证失败。</p>
              {approvals.map((a) => (
                <div key={a.requestId} className="escalation-item">
                  <pre className="escalation-summary">
                    <code>
                      {a.command} {a.args.join(" ")}
                    </code>
                  </pre>
                  {a.resolved ? (
                    <p className="muted">已处理</p>
                  ) : (
                    <div className="btn-row">
                      <button
                        className="primary"
                        onClick={() => void resolveApproval(a.requestId, true)}
                        title="批准放行（本批次内不再重复询问）"
                      >
                        批准
                      </button>
                      <button
                        className="danger"
                        onClick={() => void resolveApproval(a.requestId, false)}
                        title="拒绝执行；该命令将计入验证失败"
                      >
                        拒绝
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
