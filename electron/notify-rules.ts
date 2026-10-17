/**
 * 桌面通知的判定（C1，竞品缺口：superset 的 completion chime / cezar 的
 * "what needs you"）。serve 解决了"能看"，没解决"该看了"—— 长 run 在后台跑，
 * 操作者切走了，唯一的回工位信号应该由操作系统替看板喊一嗓子。
 *
 * 为什么是纯函数：通知本身（Electron Notification）没法在单测里真弹，而"哪些
 * 事件值得打扰人"是判据不是副作用 —— 判据进纯函数逐条钉住，弹窗只是一行
 * `new Notification(n.title, { body: n.body }).show()`。
 *
 * 判据刻意**保守**：只挑三类「不来就卡住 / 不来就错过」的事件。日志、任务进度、
 * 批次完成都不弹 —— 通知的价值与频率成反比，第三条"任务完成"弹出来之后人就
 * 会把它关掉，然后错过真正要命的第四条"审批卡住"。
 */

export interface DesktopNotification {
  title: string;
  body: string;
}

/** 事件负载只需要这几个字段；其余字段对判定不可见（宽进，别把类型绑死在协议上）。 */
export interface NotifyEventShape {
  type?: string;
  receipt?: { outcome?: string; headline?: string };
  taskId?: string;
  summary?: string;
  requestId?: string;
  command?: string;
  args?: string[];
}

/** summary/command 最长带这么多字符：通知是预告不是全文。 */
const BODY_CAP = 120;

function clip(text: string | undefined, fallback: string): string {
  const s = (text ?? "").trim();
  if (s === "") return fallback;
  return s.length > BODY_CAP ? `${s.slice(0, BODY_CAP)}…` : s;
}

/**
 * 给一个引擎事件返回该弹的桌面通知；不值得弹就 undefined。
 * 事件清单（三档，全部是"人不在场就卡住"的场景）：
 *   · receipt —— run 出了结论（交付与未交付都算：没交付更要回来）；
 *   · escalation —— 三选一裁决没人回答就挂住；
 *   · approval-request —— 命令审批 fail-closed，问不到人就不执行。
 */
export function desktopNotificationOf(payload: NotifyEventShape): DesktopNotification | undefined {
  if (payload.type === "receipt") {
    const delivered = payload.receipt?.outcome === "delivered";
    return {
      title: delivered ? "✅ OxCommander：交付完成" : "🚧 OxCommander：本轮未交付",
      body: clip(payload.receipt?.headline, delivered ? "门禁通过，凭据已生成" : "回来看失败原因"),
    };
  }
  if (payload.type === "escalation") {
    return {
      title: "⚠️ OxCommander：任务需要你决策",
      body: clip(payload.summary, `${payload.taskId ?? "任务"} 在等一个裁决`),
    };
  }
  if (payload.type === "approval-request") {
    const cmdline = [payload.command, ...(payload.args ?? [])].join(" ").trim();
    return {
      title: "🛂 OxCommander：命令等待审批",
      body: clip(cmdline, "一条命令在等批准"),
    };
  }
  return undefined;
}
