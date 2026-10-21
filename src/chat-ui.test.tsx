// @vitest-environment jsdom
import { act, render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPage } from "./pages/ChatPage";
import { ThreadRail } from "./components/ThreadRail";
import { ReviewRail } from "./components/ReviewRail";
import { useApp } from "./store";
import type { ChatApprovalRequest, ChatEntry } from "../shared/chat-events";

/**
 * 会话页的界面测试。
 *
 * 这里钉的是**交互契约**而不是样式：审批三选一必须真的把 scope 与理由送到桥接
 * 层（`scope` 丢了 = "本次会话都不再问"是个摆设；理由丢了 = 模型只会原样重试），
 * 转录必须逐条渲染（"改了什么"要能在屏幕上被看见，而不是只在凭据里被断言）。
 */
//  Mock 带参数签名：否则 vi.fn() 推断出的实参类型是空元组，
//  `mock.calls[0][0]` 这类断言会是编译错而不是运行错（这正是我们想要的那一类）。
const bridge = {
  sendChat: vi.fn(async (_input: {
    text: string;
    projectId: string;
    profile?: {
      mode: "read-only" | "workspace-write" | "danger-full-access";
      approvalPolicy: "untrusted" | "on-request" | "never";
      providerId?: string;
      model?: string;
      reasoningEffort?: "low" | "medium" | "high";
    };
  }) => ({
    sessionId: "chat-1",
    accepted: true as const,
  })),
  abortChat: vi.fn(async () => true),
  newChat: vi.fn(async (_input: {
    projectId: string;
    profile?: {
      mode: "read-only" | "workspace-write" | "danger-full-access";
      approvalPolicy: "untrusted" | "on-request" | "never";
      providerId?: string;
      model?: string;
      reasoningEffort?: "low" | "medium" | "high";
    };
  }) => ({ sessionId: "chat-2" })),
  chatTranscript: vi.fn(async () => null),
  chatLatest: vi.fn(
    async (_input: { projectId: string }): Promise<import("../shared/chat-events").ChatTranscript | null> => null,
  ),
  listChatSessions: vi.fn(async (_input: { projectId: string }) => [] as import("../shared/chat-events").ChatSessionSummary[]),
  listChatFiles: vi.fn(async (_input: { projectId: string }) => ({
    files: [] as string[],
    truncated: false,
  })),
  loadChatSession: vi.fn(async (_input: { sessionId: string }) => null),
  resumeChat: vi.fn(async (_input: { projectId: string; sessionId: string }) => transcript([])),
  forkChat: vi.fn(async (_input: { projectId: string; sessionId: string }) => transcript([])),
  deleteChat: vi.fn(async (_input: { sessionId: string }) => true),
  revertChat: vi.fn(
    async (_input: { projectId: string; sessionId: string; turn: number; path?: string }) => ({
      reverted: [] as string[],
      skipped: [] as Array<{ path: string; reason: string }>,
    }),
  ),
  resolveChatApproval: vi.fn(
    async (_requestId: string, _answer: { granted: boolean; scope?: "once" | "session"; reason?: string }) => true,
  ),
};

afterEach(() => {
  // vitest 没开 globals，testing-library 不会自动清场：不清则上一个用例的 DOM
  // 还在，第二条用例的 getByText 一律"找到多个"。
  cleanup();
});

beforeEach(() => {
  for (const fn of Object.values(bridge)) fn.mockClear();
  (window as unknown as { oxCommander: unknown }).oxCommander = bridge;
  useApp.setState({
    page: "chat",
    chatInput: "",
    activeProjectId: "p-1",
    chat: {
      sessionId: "chat-1",
      entries: [],
      sessions: [],
      status: "idle",
      turns: 0,
      usageTokens: 0,
      mode: "workspace-write",
      approvalPolicy: "on-request",
      notice: "",
      streaming: "",
      comments: [],
    },
  });
});

const entry = (over: Partial<ChatEntry> & Pick<ChatEntry, "id" | "kind" | "text">): ChatEntry => ({
  ts: 1,
  ...over,
});

function transcript(entries: ChatEntry[]): import("../shared/chat-events").ChatTranscript {
  return {
    meta: {
      sessionId: "chat-old",
      rootAbs: "/tmp/p",
      startedAt: 1,
      updatedAt: 2,
      turns: 3,
      status: "done",
      mode: "workspace-write",
      approvalPolicy: "on-request",
      usageTokens: 10,
    },
    entries,
  };
}

describe("会话页（ChatPage）", () => {
  it("没有对话时给出空态提示，而不是一片空白", () => {
    render(<ChatPage />);
    expect(screen.getByText(/还没有对话/)).toBeTruthy();
  });

  it("输入后点发送：文本进了桥接层，输入框清空", async () => {
    render(<ChatPage />);
    const box = screen.getByLabelText("会话输入") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "把 a 改成 b" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(bridge.sendChat).toHaveBeenCalled());
    expect(bridge.sendChat.mock.calls[0][0]).toEqual({
      text: "把 a 改成 b",
      projectId: "p-1",
      profile: { mode: "workspace-write", approvalPolicy: "on-request" },
    });
  });

  it("线程头切沙箱/审批：只改本线程状态，并随下一条消息带出", async () => {
    render(<ChatPage />);
    fireEvent.change(screen.getByLabelText("会话沙箱"), { target: { value: "read-only" } });
    fireEvent.change(screen.getByLabelText("会话审批"), { target: { value: "never" } });
    expect(useApp.getState().chat.mode).toBe("read-only");
    expect(useApp.getState().chat.approvalPolicy).toBe("never");

    fireEvent.change(screen.getByLabelText("会话输入"), { target: { value: "看看现状" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(bridge.sendChat).toHaveBeenCalled());
    expect(bridge.sendChat.mock.calls[0][0].profile).toEqual({
      mode: "read-only",
      approvalPolicy: "never",
    });
  });

  it("线程头选模型：只改本线程，并随下一条消息带出 provider/model", async () => {
    render(<ChatPage />);
    fireEvent.change(screen.getByLabelText("会话模型"), { target: { value: "sensenova\tglm-5.2" } });
    expect(useApp.getState().chat.providerId).toBe("sensenova");
    expect(useApp.getState().chat.model).toBe("glm-5.2");

    fireEvent.change(screen.getByLabelText("会话输入"), { target: { value: "用这个模型" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(bridge.sendChat).toHaveBeenCalled());
    expect(bridge.sendChat.mock.calls[0][0].profile).toEqual({
      mode: "workspace-write",
      approvalPolicy: "on-request",
      providerId: "sensenova",
      model: "glm-5.2",
    });

    fireEvent.change(screen.getByLabelText("会话模型"), { target: { value: "" } });
    expect(useApp.getState().chat.providerId).toBeUndefined();
    expect(useApp.getState().chat.model).toBeUndefined();
  });

  it("线程头推理档：只对登记线路启用，随消息带出；换到未登记线路即清空", async () => {
    render(<ChatPage />);
    const reasoning = screen.getByLabelText("会话推理强度") as HTMLSelectElement;
    expect(reasoning.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("会话模型"), { target: { value: "sensenova	deepseek-v4-flash" } });
    expect(reasoning.disabled).toBe(false);
    fireEvent.change(reasoning, { target: { value: "medium" } });
    expect(useApp.getState().chat.reasoningEffort).toBe("medium");

    fireEvent.change(screen.getByLabelText("会话输入"), { target: { value: "想清楚再答" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(bridge.sendChat).toHaveBeenCalled());
    expect(bridge.sendChat.mock.calls[0][0].profile).toMatchObject({
      providerId: "sensenova",
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
    });

    fireEvent.change(reasoning, { target: { value: "" } });
    expect(useApp.getState().chat.reasoningEffort).toBeUndefined();
    fireEvent.change(screen.getByLabelText("会话模型"), { target: { value: "sensenova	kimi-k3" } });
    expect(useApp.getState().chat.reasoningEffort).toBeUndefined();
    expect((screen.getByLabelText("会话推理强度") as HTMLSelectElement).disabled).toBe(true);
  });

  it("Enter 发送、Shift+Enter 不发送", () => {
    render(<ChatPage />);
    const box = screen.getByLabelText("会话输入") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(bridge.sendChat).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(bridge.sendChat).toHaveBeenCalled();
  });

  it("@ 触发文件补全：方向键选择后插入路径，不会误发送", async () => {
    bridge.listChatFiles.mockResolvedValueOnce({
      files: ["src/alpha.ts", "src/beta.ts"],
      truncated: false,
    });
    render(<ChatPage />);
    const box = screen.getByLabelText("会话输入") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "看看 @src" } });
    box.setSelectionRange(7, 7);
    fireEvent.select(box);

    await vi.waitFor(() => expect(bridge.listChatFiles).toHaveBeenCalledWith({ projectId: "p-1" }));
    const listbox = screen.getByRole("listbox", { name: "文件补全" });
    const options = await within(listbox).findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["src/alpha.ts", "src/beta.ts"]);

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "src/beta.ts" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Enter" });

    expect(useApp.getState().chatInput).toBe("看看 @src/beta.ts ");
    expect(bridge.sendChat).not.toHaveBeenCalled();
  });

  it("Esc 关闭文件补全", async () => {
    bridge.listChatFiles.mockResolvedValueOnce({ files: ["src/a.ts"], truncated: false });
    render(<ChatPage />);
    const box = screen.getByLabelText("会话输入") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@src" } });
    box.setSelectionRange(4, 4);
    fireEvent.select(box);
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("转录逐条渲染：用户、模型、工具调用与结果各占一行", () => {
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [
          entry({ id: "e1", kind: "user", text: "改一下 a.ts" }),
          entry({ id: "e2", kind: "tool_call", text: "读取 a.ts", tool: { id: "t-1", name: "read_file", args: { path: "a.ts" } } }),
          entry({ id: "e3", kind: "tool_result", text: "1: const a = 1;", result: { id: "t-1", name: "read_file", ok: true, output: "1: const a = 1;" } }),
          entry({ id: "e4", kind: "assistant", text: "改好了" }),
        ],
      },
    });
    render(<ChatPage />);
    expect(screen.getByText("改一下 a.ts")).toBeTruthy();
    expect(screen.getByText("读取 a.ts")).toBeTruthy();
    expect(screen.getByText("1: const a = 1;")).toBeTruthy();
    expect(screen.getByText("改好了")).toBeTruthy();
  });

  it("工具结果的详情默认收起，点开才看全文", () => {
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [
          entry({
            id: "e1",
            kind: "tool_result",
            text: "失败：命令被沙箱禁止：rm",
            result: { id: "t-1", name: "run_command", ok: false, output: "", reason: "命令被沙箱禁止：rm" },
          }),
        ],
      },
    });
    render(<ChatPage />);
    fireEvent.click(screen.getByRole("button", { name: "详情 ▼" }));
    expect(screen.getByRole("button", { name: "收起 ▲" })).toBeTruthy();
  });

  it("审批三选一：允许这一次 / 本会话不再问 / 拒绝并说明理由", async () => {
    const request: ChatApprovalRequest = {
      requestId: "t-1",
      tool: "run_command",
      reason: "命令 git 在审批名单内，需要人工确认",
      command: "git",
      args: ["status"],
    };
    useApp.setState({ chat: { ...useApp.getState().chat, pendingApproval: request, status: "awaiting-approval" } });
    render(<ChatPage />);
    expect(screen.getByText(/命令需要确认/)).toBeTruthy();
    expect(screen.getByText(/git status/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "本次会话都不再问" }));
    await vi.waitFor(() => expect(bridge.resolveChatApproval).toHaveBeenCalled());
    expect(bridge.resolveChatApproval.mock.calls[0]).toEqual(["t-1", { granted: true, scope: "session" }]);

    // 拒绝必须带上理由：理由会回灌给模型，不给它只会原样重试同一个动作。
    useApp.setState({ chat: { ...useApp.getState().chat, pendingApproval: request } });
    fireEvent.change(screen.getByLabelText("拒绝理由"), { target: { value: "别动 git" } });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await vi.waitFor(() => expect(bridge.resolveChatApproval.mock.calls.length).toBe(2));
    expect(bridge.resolveChatApproval.mock.calls[1]).toEqual([
      "t-1",
      { granted: false, scope: "once", reason: "别动 git" },
    ]);
  });

  it("运行中才有「停止」，空闲时不摆一个按了没反应的按钮", () => {
    const { unmount } = render(<ChatPage />);
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    unmount();
    useApp.setState({ chat: { ...useApp.getState().chat, status: "running" } });
    render(<ChatPage />);
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  });

  it("没选项目时提示去项目库（不静默失败）", async () => {
    useApp.setState({ activeProjectId: undefined });
    render(<ChatPage />);
    const box = screen.getByLabelText("会话输入") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(useApp.getState().chat.notice).toMatch(/项目库/));
    expect(bridge.sendChat).not.toHaveBeenCalled();
  });

  it("apply_patch 的改动可展开看逐行 diff，并能撤销该轮", async () => {
    const changeEntry = entry({
      id: "e1",
      kind: "tool_result",
      text: "补丁已应用：修改 src/a.ts",
      result: {
        id: "t-1",
        name: "apply_patch",
        ok: true,
        output: "补丁已应用：修改 src/a.ts",
        changes: [
          {
            path: "src/a.ts",
            before: "const a = 1;\nconst b = 2;\n",
            after: "const a = 1;\nconst b = 3;\n",
            created: false,
            turn: 1,
            revertable: true,
          },
        ],
      },
    });
    // 从恢复路径进页面：挂载时的 chatLatest 会带着会话 id 与转录回来。
    // 若只 setState 再 render，挂载 effect 的"没有记录"分支会先清掉 sessionId。
    bridge.chatLatest.mockResolvedValueOnce(transcript([changeEntry]));
    render(<ChatPage />);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /改动 1/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /改动 1/ }));
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "撤销本轮" }));
    await vi.waitFor(() =>
      expect(bridge.revertChat).toHaveBeenCalledWith({ projectId: "p-1", sessionId: "chat-old", turn: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "撤销此文件" }));
    await vi.waitFor(() =>
      expect(bridge.revertChat).toHaveBeenLastCalledWith({
        projectId: "p-1",
        sessionId: "chat-old",
        turn: 1,
        path: "src/a.ts",
      }),
    );
  });

  it("空输入不发送；删除当前会话清空，删除非当前只刷新列表；缺会话撤销给提示", async () => {
    useApp.setState({ chatInput: "   " });
    await useApp.getState().sendChat();
    expect(bridge.sendChat).not.toHaveBeenCalled();

    const seeded = useApp.getState().chat;
    useApp.setState({
      chat: { ...seeded, sessionId: "chat-1", entries: [entry({ id: "e1", kind: "user", text: "旧" })] },
    });
    await useApp.getState().deleteChat("chat-x");
    expect(bridge.deleteChat).toHaveBeenCalledWith({ sessionId: "chat-x" });
    expect(useApp.getState().chat.sessionId).toBe("chat-1");
    expect(bridge.listChatSessions).toHaveBeenCalled();

    await useApp.getState().deleteChat("chat-1");
    expect(useApp.getState().chat.entries).toEqual([]);
    expect(useApp.getState().chat.sessionId).toBeUndefined();
    expect(bridge.chatLatest).toHaveBeenCalled();

    useApp.setState({ chat: { ...useApp.getState().chat, sessionId: undefined } });
    await useApp.getState().revertChat(1);
    expect(useApp.getState().chat.notice).toContain("没有可撤销");
    expect(bridge.revertChat).not.toHaveBeenCalled();
  });

  it("历史会话可恢复，分叉/删除按钮也在同一行（不误触发送）", async () => {
    bridge.listChatSessions.mockResolvedValueOnce([
      {
        sessionId: "chat-old",
        projectId: "p-1",
        title: "旧会话",
        startedAt: 1,
        updatedAt: 2,
        status: "done",
        turns: 3,
        usageTokens: 10,
      },
    ]);
    bridge.resumeChat.mockResolvedValueOnce(transcript([entry({ id: "e-old", kind: "assistant", text: "恢复后的内容" })]));
    // M1 起线程列表搬到左栏：断言随组件一起搬（恢复 / 分叉 / 删除的契约没变，
    // 变的是它不再挤在会话页中段、要滚过整段转录才够得着）。
    render(<ThreadRail />);
    await vi.waitFor(() => expect(screen.getByText("旧会话")).toBeTruthy());
    expect(screen.getByRole("button", { name: "分叉" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "旧会话" }));
    await vi.waitFor(() =>
      expect(bridge.resumeChat).toHaveBeenCalledWith({ projectId: "p-1", sessionId: "chat-old" }),
    );
    expect(bridge.sendChat).not.toHaveBeenCalled();
  });

  it("状态条把档位与审批策略写在一起（两个轴不能分开读）", () => {
    render(<ChatPage />);
    const sub = document.querySelector(".card-sub")?.textContent ?? "";
    expect(sub).toMatch(/可改项目内文件/);
    expect(sub).toMatch(/审批：只问审批名单里的命令/);
  });
});

/**
 * 右栏 · 改动审查（M2）。
 *
 * 钉四条**会静默退化**的契约：
 * 1. 补丁改动从转录里聚合出来，文件行可点开看逐行 diff；
 * 2. 撤销调的是 (turn, path) —— 同一个文件被多轮改过时撤的是最近一轮，
 *    不是"一键还原到初始"（那会恢复出一个谁都没见过的状态）；
 * 3. 不可撤销的改动仍列出来，按钮缺席但行在；
 * 4. 收起之后中栏给出回归入口（右栏自己已经不在屏幕上了）。
 */
describe("右栏（ReviewRail）", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    path: "src/a.ts",
    before: "旧行\n",
    after: "新行\n新增\n",
    created: false,
    turn: 1,
    revertable: true,
    ...over,
  });

  const patchEntry = (changes: unknown[]): ChatEntry =>
    entry({
      id: `e-${Math.random()}`,
      kind: "tool_result",
      text: "补丁",
      result: { id: "t1", name: "apply_patch", ok: true, output: "", changes } as unknown as ChatEntry["result"],
    });

  it("聚合补丁改动并渲染逐行 diff", () => {
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [entry({ id: "u1", kind: "user", text: "改一下" }), patchEntry([change()])],
      },
    });
    render(<ReviewRail onClose={() => undefined} />);
    expect(screen.getByTestId("review-files")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    // 头部总数说破：几个文件、几处改动
    expect(screen.getByText("1 个文件 · 1 处改动")).toBeTruthy();
  });

  it("撤销按 (turn, path) 调桥接层（同一文件多轮时撤最近一轮）", async () => {
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [patchEntry([change({ turn: 1 }), change({ path: "src/b.ts", turn: 2 })])],
      },
    });
    render(<ReviewRail onClose={() => undefined} />);
    fireEvent.click(screen.getByText("src/b.ts"));
    fireEvent.click(screen.getByRole("button", { name: "撤销此文件" }));
    await vi.waitFor(() =>
      expect(bridge.revertChat).toHaveBeenCalledWith({
        projectId: "p-1",
        sessionId: "chat-1",
        turn: 2,
        path: "src/b.ts",
      }),
    );
  });

  it("不可撤销的改动仍列出来，但没有可点的撤销按钮", () => {
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [patchEntry([change({ revertable: false, before: null, after: null })])],
      },
    });
    render(<ReviewRail onClose={() => undefined} />);
    // 头部与文件行各出现一次"不可撤销"：一个是总数说破，一个是那一行的标注。
    expect(screen.getAllByText(/不可撤销/).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByText("src/a.ts"));
    expect(screen.queryByRole("button", { name: "撤销此文件" })).toBeNull();
  });

  it("没有补丁时说清楚为什么空着", () => {
    useApp.setState({ chat: { ...useApp.getState().chat, entries: [entry({ id: "u1", kind: "user", text: "读一下" })] } });
    render(<ReviewRail onClose={() => undefined} />);
    expect(screen.getByText(/还没有补丁改动/)).toBeTruthy();
    expect(screen.queryByTestId("review-files")).toBeNull();
  });

  it("收起右栏后，中栏状态行给出回归入口", () => {
    useApp.setState({ reviewOpen: false });
    render(<ChatPage />);
    expect(screen.getByRole("button", { name: "改动审查" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "改动审查" }));
    expect(useApp.getState().reviewOpen).toBe(true);
  });
});

/**
 * 行级评论（M3a）。
 *
 * 钉的是**回路是否闭着**：评论加在右栏 diff 行上 → 中栏出现待处理条 → 发送时
 * 带走 → 发完两处都清。任何一环断了，用户看到的是"我评了但好像没用"，
 * 而这正是纯文本描述（"上面那个函数第三行不对"）一直被容忍的原因。
 */
describe("行级评论（M3a）", () => {
  const patchEntry = (changes: unknown[]): ChatEntry =>
    entry({
      id: `e-${Math.random()}`,
      kind: "tool_result",
      text: "补丁",
      result: { id: "t1", name: "apply_patch", ok: true, output: "", changes } as unknown as ChatEntry["result"],
    });

  const seedPatch = () =>
    useApp.setState({
      chat: {
        ...useApp.getState().chat,
        entries: [
          patchEntry([
            {
              path: "src/a.ts",
              before: "第一行\n第二行\n",
              after: "第一行\n改过的第二行\n第三行\n",
              created: false,
              turn: 1,
              revertable: true,
            },
          ]),
        ],
      },
    });

  it("diff 行可加评论；中栏待处理条与右栏计数同步出现", () => {
    seedPatch();
    render(<ReviewRail onClose={() => undefined} />);
    fireEvent.click(screen.getByText("src/a.ts"));
    // 行尾 + 按钮：hover 才可见，测试里直接点（jsdom 不跑 CSS）
    const adds = document.querySelectorAll(".review-line-add");
    expect(adds.length).toBeGreaterThan(0);
    fireEvent.click(adds[0]);
    const box = screen.getByLabelText("行级评论内容") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "这行要加判空" } });
    fireEvent.keyDown(box, { key: "Enter" });

    // 右栏计数
    expect(screen.getByRole("button", { name: /评论 1/ })).toBeTruthy();
    // 中栏待处理条（它和"发送"在同一个组件里，必须互相看得见）
    cleanup();
    render(<ChatPage />);
    expect(screen.getByTestId("chat-comment-banner")).toBeTruthy();
    expect(screen.getByText(/1 条行级评论待处理/)).toBeTruthy();
  });

  it("发送后评论清空（一次性附录，不留给下一条）", async () => {
    seedPatch();
    render(<ReviewRail onClose={() => undefined} />);
    fireEvent.click(screen.getByText("src/a.ts"));
    const adds = document.querySelectorAll(".review-line-add");
    fireEvent.click(adds[0]);
    const box = screen.getByLabelText("行级评论内容") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "改" } });
    fireEvent.keyDown(box, { key: "Enter" });

    cleanup();
    render(<ChatPage />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => expect(bridge.sendChat).toHaveBeenCalled());
    expect(useApp.getState().chat.comments).toEqual([]);
  });

  it("只有评论时发送按钮也可用（不写正文是合法操作）", () => {
    useApp.getState().addInlineComment({ path: "a.ts", turn: 1, line: 1, side: "after", text: "看看这行" });
    render(<ChatPage />);
    const btn = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("评论可整批丢弃，也可单条删", () => {
    useApp.getState().addInlineComment({ path: "a.ts", turn: 1, line: 1, side: "after", text: "甲" });
    useApp.getState().addInlineComment({ path: "a.ts", turn: 1, line: 2, side: "after", text: "乙" });
    render(<ChatPage />);
    fireEvent.click(screen.getByRole("button", { name: "全部丢弃" }));
    expect(useApp.getState().chat.comments).toEqual([]);

    useApp.getState().addInlineComment({ path: "a.ts", turn: 1, line: 1, side: "after", text: "甲" });
    useApp.getState().removeInlineComment(useApp.getState().chat.comments[0].id);
    expect(useApp.getState().chat.comments).toEqual([]);
  });
});

/**
 * 流式预览行（P1-1）。
 *
 * 钉两条：① 增量要在**同一条**实时行里逐字变长（不是每段新起一行）；② 正文
 * entry 一到，这一行必须消失 —— 留着就是同一段话显示两遍。
 */
describe("会话页 · 流式预览", () => {
  it("有增量时渲染实时行，正文落定后消失", () => {
    useApp.setState({ chat: { ...useApp.getState().chat, streaming: "正在读 a.ts" } });
    render(<ChatPage />);
    const row = screen.getByTestId("chat-streaming");
    expect(row.textContent).toContain("正在读 a.ts");

    act(() => {
      useApp.getState().handleEvent({ type: "chat:delta", sessionId: "chat-1", text: "，然后改" });
    });
    // 同一个节点继续变长：不是又起了一行。
    expect(screen.getAllByTestId("chat-streaming")).toHaveLength(1);
    expect(screen.getByTestId("chat-streaming").textContent).toContain("正在读 a.ts，然后改");

    act(() => {
      useApp.getState().handleEvent({
        type: "chat:entry",
        sessionId: "chat-1",
        entry: entry({ id: "e-s1", kind: "assistant", text: "改完了" }),
      });
    });
    expect(screen.queryByTestId("chat-streaming")).toBeNull();
    expect(screen.getByText("改完了")).toBeTruthy();
  });

  it("首轮还没有任何条目时，实时行顶替空态提示（不能一边说'还没有对话'一边在打字）", () => {
    useApp.setState({ chat: { ...useApp.getState().chat, entries: [], streaming: "先说一句" } });
    render(<ChatPage />);
    expect(screen.queryByText(/还没有对话/)).toBeNull();
    expect(screen.getByTestId("chat-streaming").textContent).toContain("先说一句");
  });
});
