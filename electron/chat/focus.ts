/**
 * "操作者此刻正在看哪条线程"（M4b）。
 *
 * 通知判据需要它：一条审批请求如果就摆在屏幕上，就不该再弹系统通知（那是
 * 噪声，而且会训练人关掉通知）。渲染层每次切线程都会走 chat:resume /
 * chat:transcript，宿主在那里更新这里。
 *
 * 为什么单独一个模块而不是塞进 ipc/chat：`ipc/context.send` 要读它，而
 * `ipc/chat` 反过来要 import `send` —— 放一起就是循环依赖。两边都只依赖这个
 * 不依赖任何东西的小模块，读的写的都清楚。
 *
 * 已知边界：主进程**不**知道窗口焦点。窗口被切走、但正在看的还是同一条线程时，
 * 这条规则不弹通知（对话框确实还开着）。真正的"窗口失焦也提醒"需要
 * `BrowserWindow.isFocused()`，属于通知策略的下一轮（与"只在窗口失焦时提醒"
 * 一起做才有意义）。
 */
let focused: string | null = null;

export function focusChatSession(sessionId: string | null): void {
  focused = sessionId;
}

export function focusedChatSession(): string | null {
  return focused;
}
