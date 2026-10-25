import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { PreviewState } from "../../shared/delivery-guide";

/**
 * 保活预览卡（item 2）：探活成功的 dev server 由主进程持有，这里只显示
 * 管理器的事实（URL / 命令 / 日志尾部 / 到期时间）并给打开、清除数据、停止三个动作。
 *
 * 打开走**应用内窗口 + 按项目隔离的 profile**（2026-10-25，C3 的剩余半）。此前走系统
 * 浏览器，而"隔离"在那条路上根本做不到：profile 由使用者的浏览器决定 —— 一个项目的
 * 登录态跟着使用者的日常浏览走，别的项目的预览也共用同一份 cookie。换成应用内窗口后，
 * 被预览的页面待在独立 session 里、拿不到 IPC 桥、只允许在本机回环地址上导航
 * （判据与守卫都在 `electron/preview-window.ts`）。代价是它不再是使用者的那个浏览器
 * （扩展、DevTools 习惯都不同），换来的是"预览之间不串、也不脏我的浏览器"。
 */
export function PreviewPanel() {
  const activeProjectId = useApp((s) => s.activeProjectId);
  const receipt = useApp((s) => s.receipt);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = (): void => {
    if (!activeProjectId) {
      setPreview(null);
      return;
    }
    window.oxCommander
      .previewStatus()
      .then((next) => {
        setPreview(next);
        setError(null);
      })
      .catch((e: unknown) => setError((e as Error).message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- receipt 只作为 run 收束的刷新信号
  }, [activeProjectId, receipt]);

  if (!activeProjectId) return null;
  if (!preview && !error && !note) return null;

  const open = (): void => {
    setNote(null);
    window.oxCommander
      .previewOpen(activeProjectId)
      .then((res) => {
        if (!res.ok) setNote(res.reason);
      })
      .catch((e: unknown) => setNote(`打开预览失败：${(e as Error).message}`));
  };

  const reset = (): void => {
    setNote(null);
    window.oxCommander
      .previewReset(activeProjectId)
      .then((res) => {
        setNote(res.ok ? "已清除这个项目的预览数据。" : res.reason);
      })
      .catch((e: unknown) => setNote(`清除预览数据失败：${(e as Error).message}`));
  };

  const stop = (): void => {
    setNote(null);
    window.oxCommander
      .previewStop()
      .then(() => {
        setPreview(null);
        setNote("已停止预览。");
      })
      .catch((e: unknown) => setNote(`停止失败：${(e as Error).message}`));
  };

  return (
    <section className="card preview-panel">
      <h3>
        运行预览
        {preview ? (
          <span className={`stage-chip${preview.running ? " chip-ok" : ""}`}>
            {preview.running ? "运行中" : "已退出"}
          </span>
        ) : null}
        <button className="refresh-btn" onClick={load} title="重新读取预览状态">
          ↻
        </button>
      </h3>
      {error ? <p className="muted">读不到预览状态：{error}</p> : null}
      {preview ? (
        <>
          <p className="card-sub">
            {preview.title} · 由主进程保活，{new Date(preview.expiresAt).toLocaleTimeString()} 自动停止。
            打开走应用内窗口，profile 按项目隔离（本机回环地址）。
          </p>
          <p className="task-meta">
            <code>{preview.url}</code>
            {preview.pid !== undefined ? ` · pid ${preview.pid}` : ""}
            {preview.exitCode !== undefined ? ` · 退出码 ${preview.exitCode ?? "signal"}` : ""}
          </p>
          <p className="task-meta">
            命令：<code>{[preview.command, ...preview.args].join(" ")}</code>
          </p>
          <div className="btn-row">
            <button
              className="primary"
              onClick={open}
              disabled={!preview.running}
              title="在本项目的隔离预览窗口里打开这个 dev server"
            >
              打开预览
            </button>
            <button
              onClick={reset}
              title="清掉这个项目的预览 cookie / localStorage（下次预览需重新登录）"
            >
              清除预览数据
            </button>
            <button className="danger" onClick={stop} title="杀掉预览进程、关掉预览窗口并清除这张卡">
              停止预览
            </button>
          </div>
          <details className="failure-details">
            <summary>服务日志（尾部）</summary>
            <pre>{preview.log || "（暂无输出）"}</pre>
          </details>
        </>
      ) : null}
      {note ? <p className="muted">{note}</p> : null}
    </section>
  );
}
