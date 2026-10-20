import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { DeliveryGuide, DeliveryFileRead } from "../../shared/delivery-guide";

type GuideState =
  | { kind: "loading" }
  | { kind: "ready"; guide: DeliveryGuide }
  | { kind: "error"; message: string };

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "shown"; path: string; result: DeliveryFileRead }
  | { kind: "error"; path: string; message: string };

/**
 * 本次运行的成果面（B1 最后一米）：
 *   · 按任务列产物路径，点「查看」直接读只读全文；
 *   · 固化"怎么验收"：凭据里的复跑命令 + package.json 的 dev/start/preview/serve。
 *
 * 刷新信号是 `receipt`：主进程先落审计、再推凭据事件，所以收到凭据时
 * `delivery:guide` 已经能读到这一次 run 的全部批次改动。
 */
export function DeliveryPanel() {
  const activeProjectId = useApp((s) => s.activeProjectId);
  const receipt = useApp((s) => s.receipt);
  const [state, setState] = useState<GuideState>({ kind: "loading" });
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setPreview({ kind: "idle" });
    window.oxCommander
      .deliveryGuide(activeProjectId)
      .then((guide) => {
        if (!cancelled) setState({ kind: "ready", guide });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, receipt]);

  if (!activeProjectId) return null;
  if (state.kind === "loading") {
    return (
      <section className="card delivery-panel">
        <h3>本次产物</h3>
        <p className="muted">正在读取本次运行的产物…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className="card delivery-panel">
        <h3>本次产物</h3>
        <p className="muted">读不到交付成果：{state.message}</p>
      </section>
    );
  }

  const guide = state.guide;
  if (!guide.hasReceipt && guide.totalFiles === 0 && guide.commands.length === 0) return null;

  const openFile = (path: string): void => {
    setPreview({ kind: "loading", path });
    window.oxCommander
      .readDeliveryFile(activeProjectId, path)
      .then((result) => setPreview({ kind: "shown", path, result }))
      .catch((e: unknown) =>
        setPreview({ kind: "error", path, message: (e as Error).message }),
      );
  };

  const copy = (line: string): void => {
    if (!navigator.clipboard) {
      setCopied(null);
      return;
    }
    navigator.clipboard
      .writeText(line)
      .then(() => setCopied(line))
      .catch(() => setCopied(null));
  };

  const rows = (files: DeliveryGuide["artifacts"][number]["files"]) =>
    files.map((f) => (
      <div key={f.path} className="change-row">
        <p className="task-meta">
          <span className="artifact-op">{f.op}</span> <code>{f.path}</code>
          {f.bytes !== undefined ? ` · ${f.bytes} B` : ""}
          {f.op === "delete" ? (
            <span className="muted">（已删除）</span>
          ) : (
            <span className="change-actions">
              <button
                className="link-btn"
                onClick={() => openFile(f.path)}
                disabled={preview.kind === "loading" && preview.path === f.path}
                title="只读查看这个文件（读取工作区当前内容）"
              >
                查看
              </button>
            </span>
          )}
        </p>
        {preview.kind === "idle" || preview.path !== f.path ? null : preview.kind === "loading" ? (
          <p className="muted">正在读取…</p>
        ) : preview.kind === "error" ? (
          <p className="muted">读取失败：{preview.message}</p>
        ) : preview.result.ok ? (
          preview.result.binary ? (
            <p className="muted">二进制文件，不渲染内容（{preview.result.bytes} B）。</p>
          ) : (
            <>
              {preview.result.truncated ? (
                <p className="muted">
                  内容已截断：只显示前 512KiB（原文 {preview.result.bytes} B）。
                </p>
              ) : null}
              <pre className="artifact-content">{preview.result.content}</pre>
            </>
          )
        ) : (
          <p className="muted">{preview.result.reason}</p>
        )}
      </div>
    ));

  return (
    <section className="card delivery-panel">
      <h3>
        本次产物 <span className="task-meta">{guide.totalFiles} 个文件</span>
      </h3>
      <p className="card-sub">
        按任务列出这次 run 落地的文件；点「查看」直接读只读全文，不用打开工作目录。
      </p>
      {guide.totalFiles === 0 ? <p className="muted">本次没有文件改动。</p> : null}
      {guide.artifacts.map((group, i) => (
        <details className="failure-details" key={group.taskId} open={i === 0}>
          <summary>
            {group.title} · {group.zone} · {group.files.length} 个文件
          </summary>
          {rows(group.files)}
        </details>
      ))}
      {guide.unassigned ? (
        <details className="failure-details">
          <summary>未归属任务 · {guide.unassigned.length} 个文件</summary>
          {rows(guide.unassigned)}
        </details>
      ) : null}

      <h4 className="delivery-subhead">怎么验收</h4>
      <p className="card-sub">在工作区根目录执行；凭据里的命令按原样列出，可独立复跑。</p>
      {guide.commands.length === 0 ? (
        <p className="muted">
          本次没有记录可复跑的命令（凭据为空，package.json 也没有 dev/start/preview/serve）。
        </p>
      ) : (
        <ul className="acceptance-commands">
          {guide.commands.map((c, i) => {
            const line = [c.command, ...c.args].join(" ");
            return (
              <li key={`${c.kind}-${i}`} className="task-meta">
                <span className="acceptance-label">{c.label}</span>
                <code>{line}</code>
                <button className="link-btn" onClick={() => copy(line)} title="复制命令">
                  复制
                </button>
                {copied === line ? <span className="muted">已复制</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
