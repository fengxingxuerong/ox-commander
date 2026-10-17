/**
 * 桌面通知判据的测试（C1）。判据是纯函数，弹窗本身是 Electron 副作用 ——
 * 单测钉的是"哪些事件值得打扰人"与"通知文案从哪来"。
 */
import { describe, expect, it } from "vitest";
import { desktopNotificationOf } from "../electron/notify-rules";

describe("desktopNotificationOf：判据（保守，只挑卡住/错过的事件）", () => {
  it("receipt · delivered 弹完成通知，正文取凭据 headline", () => {
    const n = desktopNotificationOf({ type: "receipt", receipt: { outcome: "delivered", headline: "已交付：2/2 个任务完成" } });
    expect(n?.title).toContain("交付完成");
    expect(n?.body).toBe("已交付：2/2 个任务完成");
  });

  it("receipt · 未交付也弹 —— 没交付更要回来看", () => {
    const n = desktopNotificationOf({ type: "receipt", receipt: { outcome: "failed", headline: "3 个任务未过" } });
    expect(n?.title).toContain("未交付");
    expect(n?.body).toBe("3 个任务未过");
  });

  it("receipt 缺 headline 时兜底文案不是 undefined", () => {
    const n = desktopNotificationOf({ type: "receipt", receipt: { outcome: "delivered" } });
    expect(n?.body).toBe("门禁通过，凭据已生成");
  });

  it("escalation 弹决策请求", () => {
    const n = desktopNotificationOf({ type: "escalation", taskId: "t-1", summary: "任务 1 重修后仍未通过" });
    expect(n?.title).toContain("需要你决策");
    expect(n?.body).toBe("任务 1 重修后仍未通过");
  });

  it("approval-request 弹审批请求，正文带命令", () => {
    const n = desktopNotificationOf({ type: "approval-request", requestId: "a-1", command: "npm", args: ["install"] });
    expect(n?.title).toContain("审批");
    expect(n?.body).toBe("npm install");
  });

  it("长正文截断到 120 字符", () => {
    const n = desktopNotificationOf({ type: "escalation", summary: "x".repeat(500) });
    expect(n?.body.length).toBeLessThanOrEqual(121);
  });

  it("日志/进度类事件不弹（通知的价值与频率成反比）", () => {
    for (const payload of [
      { type: "log", text: "[router] t-1 → demo" },
      { type: "run", phase: "start", taskId: "t-1" },
      { type: "stage", stage: "DEVELOPMENT" },
      { type: "conflict", kind: "unauthorized-write", paths: ["src/a.ts"] },
      { type: "line-health", lines: [] },
    ]) {
      expect(desktopNotificationOf(payload)).toBeUndefined();
    }
  });

  it("无 type 的负载不弹", () => {
    expect(desktopNotificationOf({})).toBeUndefined();
  });
});

describe("send → 通知（集成：判据真的挂在事件出口上）", () => {
  it("receipt 事件走一次 Notification.show", async () => {
    const { notificationShows } = await import("./__fakes__/electron");
    const { send, attachWindow } = await import("../electron/ipc/context");
    attachWindow({ webContents: { send: () => {} } } as never);
    notificationShows.length = 0;
    send({ type: "receipt", receipt: { outcome: "delivered", headline: "已交付：2/2 个任务完成" } });
    expect(notificationShows).toHaveLength(1);
    expect(notificationShows[0]!.title).toContain("交付完成");
  });

  it("log 事件不弹 —— 集成层同样不能被高频事件打扰", async () => {
    const { notificationShows } = await import("./__fakes__/electron");
    const { send, attachWindow } = await import("../electron/ipc/context");
    attachWindow({ webContents: { send: () => {} } } as never);
    notificationShows.length = 0;
    send({ type: "log", text: "[router] t-1 → demo-bridge" });
    expect(notificationShows).toHaveLength(0);
  });
});
