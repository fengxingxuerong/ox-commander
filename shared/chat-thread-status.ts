/**
 * 线程状态位（M4b）。
 *
 * 宿主从 M4a 起可以同时跑多条线程，但界面只渲染"当前这条"。其余线程的事件
 * **不能直接丢掉** —— 丢掉之后左栏看不出"后台那条在跑还是在等你拍板"，而
 * 指挥中心的第一职责就是"一眼看见谁在等我"。
 *
 * 这一层是纯判据：`(上一条状态, 事件, 当前正在看哪条) -> 新状态`。它不碰
 * store、不碰 React，所以每条规则都能单独钉 —— 界面组件只负责把结果画成
 * 一个圆点和一个数字。
 *
 * 三条纪律：
 * 1. **正在看的那条不涨未读**。否则你盯着它跑，每个字都在给自己计一个红点。
 * 2. **审批是独立一位**（`awaiting`），不只是 status 的别名：答掉审批之后
 *    线程会回到 running，但"刚刚有东西在等你"这件事在左栏留过痕迹才合理；
 *    清它的时机是**切回去看过一眼**，不是审批被答掉。
 * 3. **不认识的事件不改状态**（返回原对象）。宁可少一格信息，也不要因为一个
 *    新增事件类型把状态机打乱 —— 状态机会一直错下去，直到重启。
 */
import type { ChatStatus } from "./chat-events";

export interface ThreadStatusView {
  status: ChatStatus;
  turns: number;
  /** 离开这条线程期间新增的条目数；切回去即清零。 */
  unread: number;
  /** 有审批在等。左栏红点用它，不用 status。 */
  awaiting: boolean;
}

/** 判定只需要这几个字段；不把类型绑死在协议上（宽进）。 */
export interface ThreadEventShape {
  type?: string;
  sessionId?: string;
  status?: ChatStatus;
  turns?: number;
}

const EMPTY_THREAD_STATUS: ThreadStatusView = {
  status: "idle",
  turns: 0,
  unread: 0,
  awaiting: false,
};

/**
 * 吃一个 `chat:*` 事件，返回这条线程的新状态。
 *
 * 非 chat 事件、没有 `sessionId` 的事件一律返回 `prev` 原对象（调用方可以
 * 用引用相等判断"没变"，省一次渲染）。
 */
export function applyThreadStatus(
  prev: ThreadStatusView | undefined,
  event: ThreadEventShape,
  viewingSessionId?: string,
): ThreadStatusView | undefined {
  const type = event.type ?? "";
  if (!type.startsWith("chat:")) return prev;
  if (typeof event.sessionId !== "string" || event.sessionId === "") return prev;

  const viewing = viewingSessionId !== undefined && viewingSessionId === event.sessionId;
  // 正在看的那条：任何事件到达都说明它的进展就在屏幕上 → 未读归零。
  // （`chat:entry` 的"不涨"是另一回事：涨与不涨都不该留着一个旧红点。）
  const base = (viewing ? (markThreadRead(prev) ?? EMPTY_THREAD_STATUS) : prev) ?? EMPTY_THREAD_STATUS;

  switch (type) {
    case "chat:status": {
      const status = event.status ?? base.status;
      return { ...base, status, turns: event.turns ?? base.turns };
    }
    case "chat:approval-request":
      return { ...base, status: "awaiting-approval", awaiting: true };
    case "chat:done":
      return {
        ...base,
        status: "done",
        turns: event.turns ?? base.turns,
        awaiting: false,
      };
    case "chat:error":
      return { ...base, status: "error", awaiting: false };
    case "chat:entry":
      // 正在看的那条不涨未读（纪律 1）；后台那条每落定一条事实就 +1。
      return viewing ? prev : { ...base, unread: base.unread + 1 };
    default:
      // `chat:delta` 之类不改状态位：增量层不是事实（见 ChatEvent 注释）。
      // 但"正在看"这一件事本身要落账：旧红点在眼前线程上留着是纯噪声。
      return viewing ? base : prev;
  }
}

/** 切回某条线程 = 读过了。只清未读，不动状态与轮次。 */
export function markThreadRead(prev: ThreadStatusView | undefined): ThreadStatusView | undefined {
  if (prev === undefined || prev.unread === 0) return prev;
  return { ...prev, unread: 0 };
}

/**
 * 从会话摘要/转录 meta 生成状态（历史线程没有运行时事件；恢复时 meta 就是真相）。
 *
 * `awaiting` 与 status **一起**从 meta 推：一条落盘时正等审批的线程，恢复后
 * 左栏就该是橙点 —— 只看 status 的话它是对的，但 `awaiting` 留 false 会让
 * "等审批"在别处（通知、徽标）判不出来。
 */
export function threadStatusOfSummary(summary: {
  status: ChatStatus;
  turns: number;
}): ThreadStatusView {
  return {
    status: summary.status,
    turns: summary.turns,
    unread: 0,
    awaiting: summary.status === "awaiting-approval",
  };
}
