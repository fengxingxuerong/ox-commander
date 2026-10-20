import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { PreviewState } from "../../shared/delivery-guide";

/**
 * 保活预览卡（item 2）：探活成功的 dev server 由主进程持有，这里只显示
 * 管理器的事实（URL / 命令 / 日志尾部 / 到期时间）并给打开、停止两个动作。
 *
 * 打开走系统浏览器而不是内嵌 webview：本地 dev server 的 CSP / HMR / 端口
 * 行为与真实浏览器一致，也避免把任意页面塞进 Electron 渲染进程。
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
      .previewOpen()
      .then((res) => {
        if (!res.ok) setNote(res.reason);
      })
      .catch((e: unknown) => setNote(`打开预览失败：${(e as Error).message}`));
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
            打开走系统浏览器（本机回环地址）。
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
              title="在系统浏览器打开这个 dev server"
            >
              打开预览
            </button>
            <button className="danger" onClick={stop} title="杀掉预览进程并清除这张卡">
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
