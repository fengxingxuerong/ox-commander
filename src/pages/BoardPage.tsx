import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useApp, REMEDY_VERB } from "../store";
import { AuditPanel } from "../components/AuditPanel";
import { STAGE_ORDER, type FailureClass, type Stage } from "../../shared/types";
import type { ReceiptTaskStatus, ReceiptVerdict } from "../../shared/delivery-receipt";
import { usageFact } from "../../shared/usage-meter";
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

      <div className="board-columns">
        {/* 左栏：阶段进度 + 任务列表（DAG 分组） */}
        <aside className="col col-left">
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
              </div>
            ))}
          </section>
        </aside>

        {/* 中栏：实时日志流 + 落盘审计。执行日志只活在内存里、重载即消失，
            审计日志回答的是"上一次到底发生过什么"（run 起止、批次守卫裁决）且重启不丢。
            两份事实放同一栏：操作者盯着的正是这里，不用换页去设置里翻 JSONL。 */}
        <main className="col col-center">
          <section className="card log-card">
            <h3>执行日志</h3>
            <LogView />
          </section>
          <AuditPanel />
        </main>

        {/* 右栏：验证结果 / 升级提示 / 控制 */}
        <aside className="col col-right">
          <section className="card">
            <h3>控制</h3>
            <div className="btn-row">
              <button
                className="primary"
                onClick={() => void start()}
                disabled={runActive}
                title={runActive ? "已有 run 在跑；要重来先取消" : undefined}
              >
                开始
              </button>
              <button onClick={pause} disabled={!runActive} title={runActive ? undefined : "没有在跑的 run"}>
                暂停
              </button>
              <button onClick={resume} disabled={!runActive} title={runActive ? undefined : "没有在跑的 run"}>
                继续
              </button>
              <button className="danger" onClick={cancel} disabled={!runActive} title={runActive ? undefined : "没有在跑的 run"}>
                取消
              </button>
            </div>
          </section>

          {/* 本次运行的 token 用量。`calls - measuredCalls`（端点没上报用量的次数）
              必须和总数一起显示 —— 否则"3k tokens"会被读成全部支出。 */}
          {fact && (
            <section className="card">
              <h3>本次运行用量</h3>
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
              {escalations.map((e) => (
                <div key={e.taskId} className="escalation-item">
                  <pre className="escalation-summary">{e.summary}</pre>
                  {e.resolved ? (
                    <p className="muted">已处理</p>
                  ) : (
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
                  )}
                </div>
              ))}
            </section>
          )}

          {approvals.length > 0 && (
            <section className="card escalation">
              <h3>🛂 命令需要审批</h3>
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
