import { create } from "zustand";
import type { AppState, InlineComment, TaskView } from "./types";
import type { Stage, TaskStatus } from "../shared/types";
import { isFailureClass } from "../shared/types";
import { formatUsageLine, type UsageSnapshot } from "../shared/usage-meter";
import { renderIssueRequirement, type GithubIssue } from "../shared/github-issue";
import type { ChatApprovalRequest, ChatEntry, ChatStatus } from "../shared/chat-events";
import { reasoningEffortsOf, type ReasoningEffort } from "../shared/providers";

const api = () => window.oxCommander;

/**
 * 事件归属判定（M4a）。
 *
 * 三条规则，每条都对应一种真实的到达顺序：
 * 1. 事件没有 `sessionId`（旧版本/测试构造）→ 当作当前线程的，否则升级后整个
 *    视图一片空白；
 * 2. 当前还没有 id（刚点发送、返回值未到）→ 接受，否则第一条消息的全部事件
 *    会被自己丢掉；
 * 3. 两边都有且不同 → **不是**本线程，丢弃。
 */
export function isEventForChat(currentSessionId: string | undefined, event: unknown): boolean {
  const sessionId = (event as { sessionId?: unknown } | null | undefined)?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") return true;
  if (!currentSessionId) return true;
  return sessionId === currentSessionId;
}

/**
 * Monotonic token for the in-flight planning request.
 *
 * `createAndOpen` and `retryPlanning` can both fire `runPlanning`, and a slow
 * first request would otherwise land *after* the newer one and overwrite it —
 * the board then shows the stale PRD while the operator is looking at the
 * retry's result. Only the newest request is allowed to commit.
 */
let planningSeq = 0;

/**
 * 看板把一次越权裁决念成人话时用的词表。
 *
 * 键必须与**生产端**同词：`BatchGuard.remedyFor` 只会发 `revert` / `quarantine` /
 * `fail-batch` / `pass`，两个宿主在找不到对应裁决时发 `none`。旧版这里写的
 * `isolate` / `keep` 从来没人发过，于是"移入隔离区"和"保留文件判失败"两种处置
 * 都被念成"仅记录"。防漂移的用例在 src/sandbox-journal.test.ts：它把四档真跑一遍，
 * 拿实际产出的 action 来比对这张表。
 */
export const REMEDY_VERB: Record<string, string> = {
  revert: "已回滚",
  quarantine: "已隔离",
  "fail-batch": "保留文件、判批次失败",
  pass: "仅记录",
  none: "仅记录",
};

/**
 * 把行级评论拼成下一条消息的附录（M3a）。
 *
 * 为什么用附录而不是让模型"自己去看"：评论挂在 diff 行上，而 diff 来自**会话内
 * 的快照**，不是盘上现状。不把 (文件, 轮次, 行号, 改前/改后, 原文) 一次说全，
 * 模型只能靠猜是哪一行 —— 而"猜错行"正是纯文本描述（"上面那个函数第三行不对"）
 * 效率低的全部原因。
 *
 * 两条硬性要求写进提示里：逐条处理、**没有评论涉及的代码严格保持不动**。
 * 少了后半句， agent 会顺手重构周边（Codex 用户的经典抱怨）。
 */
export function appendCommentAppendix(text: string, comments: readonly InlineComment[]): string {
  if (comments.length === 0) return text;
  const lines = comments.map((c) => {
    const side = c.side === "before" ? "改前" : "改后";
    return `- ${c.path} 第 ${c.turn} 轮改动 · ${side}第 ${c.line} 行：${c.text.trim()}`;
  });
  const appendix = [
    "",
    `【行级评论 ${comments.length} 条，请逐条处理】`,
    ...lines,
    "没有评论涉及的代码严格保持不动，不要顺手重构周边。",
  ].join("\n");
  return `${text}${appendix}`;
}

export const useApp = create<AppState>((set, get) => ({
  page: "projects",
  projects: [],
  stage: "PRD" as Stage,
  logs: [],
  tasks: {},
  escalations: [] as AppState["escalations"],
  approvals: [] as AppState["approvals"],
  conflicts: [] as AppState["conflicts"],
  planning: false,
  planningError: undefined,
  newProjectName: "",
  newRequirement: "",
  chat: {
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
  chatInput: "",
  reviewOpen: true,

  setPage: (page) => set({ page }),
  setNewProjectName: (newProjectName) => set({ newProjectName }),
  setNewRequirement: (newRequirement) => set({ newRequirement }),

  setChatInput: (chatInput) => set({ chatInput }),
  setChatMode: (mode) => set((s) => ({ chat: { ...s.chat, mode } })),
  setChatApproval: (approvalPolicy) => set((s) => ({ chat: { ...s.chat, approvalPolicy } })),
  setChatModel: (line) =>
    set((s) => {
      // 换到未登记推理档的线路时清掉旧档位，避免把上一个模型的能力带过去。
      const keepReasoning =
        line !== null &&
        s.chat.reasoningEffort !== undefined &&
        reasoningEffortsOf(line.providerId, line.model).includes(s.chat.reasoningEffort);
      return {
        chat: {
          ...s.chat,
          providerId: line?.providerId,
          model: line?.model,
          reasoningEffort: keepReasoning ? s.chat.reasoningEffort : undefined,
        },
      };
    }),
  setChatReasoning: (reasoningEffort: ReasoningEffort | undefined) =>
    set((s) => ({ chat: { ...s.chat, reasoningEffort } })),
  setReviewOpen: (reviewOpen) => set({ reviewOpen }),

  sendChat: async () => {
    const text = get().chatInput.trim();
    const projectId = get().activeProjectId;
    if (!projectId) {
      set((s) => ({ chat: { ...s.chat, notice: "先在「项目库」里打开一个项目：会话的工具边界就是它的工作区" } }));
      return;
    }
    // 行级评论是**一次性附录**（M3a）：拼在这条消息里发出，发完即清。
    // 空文本 + 有评论 = 合法操作（"只处理这几条评论，别的别动"）。
    const comments = get().chat.comments;
    const payload = text === "" && comments.length > 0 ? "" : text;
    if (payload === "" && comments.length === 0) return;
    const outgoing = appendCommentAppendix(payload, comments);
    set((s) => ({
      chat: { ...s.chat, notice: "", comments: [] },
      chatInput: "",
    }));
    try {
      const res = await api().sendChat({
        text: outgoing,
        projectId,
        // 指定线程：M4a 之后宿主可同时跑多条，不指明就等于"最近活跃的那条"，
        // 而在两条线程间来回切时"最近活跃"随时会变 —— 那会把话发进别人的线程。
        ...(get().chat.sessionId ? { sessionId: get().chat.sessionId } : {}),
        profile: {
          mode: get().chat.mode,
          approvalPolicy: get().chat.approvalPolicy,
          ...(get().chat.providerId && get().chat.model
            ? {
                providerId: get().chat.providerId,
                model: get().chat.model,
                ...(get().chat.reasoningEffort ? { reasoningEffort: get().chat.reasoningEffort } : {}),
              }
            : {}),
        },
      });
      set((s) => ({ chat: { ...s.chat, sessionId: res.sessionId, status: "running" } }));
      // 首条用户消息落盘后列表会出现这条会话；刷新一次让侧栏不用等下一轮。
      void get().loadChatSessions();
    } catch (e) {
      // 失败要把评论**还回去**：它们没发出去，静默丢掉等于用户白写。
      set((s) => ({ chat: { ...s.chat, notice: `发送失败：${(e as Error).message}`, comments }, chatInput: text }));
    }
  },

  addInlineComment: (c) =>
    set((s) => ({
      chat: {
        ...s.chat,
        comments: [...s.chat.comments, { ...c, id: `ic-${s.chat.comments.length}-${c.turn}-${c.path}-${c.line}`, ts: Date.now() }],
      },
    })),

  removeInlineComment: (id) =>
    set((s) => ({ chat: { ...s.chat, comments: s.chat.comments.filter((c) => c.id !== id) } })),

  dropInlineCommentsFor: (path, turn) =>
    set((s) => ({
      chat: {
        ...s.chat,
        comments: s.chat.comments.filter((c) => !(c.path === path && c.turn === turn)),
      },
    })),

  clearInlineComments: () => set((s) => ({ chat: { ...s.chat, comments: [] } })),

  abortChat: async () => {
    // 只中止当前这条：宿主已支持并行，"停止"波及别的线程是越权。
    const sessionId = get().chat.sessionId;
    await api().abortChat(sessionId ? { sessionId } : undefined);
    // 打字预览一并收掉：停止是用户当场看到的动作，不该等收尾事件回来才消失。
    set((s) => ({ chat: { ...s.chat, status: "aborted", pendingApproval: undefined, streaming: "" } }));
  },

  newChat: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) {
      set((s) => ({ chat: { ...s.chat, notice: "先在「项目库」里打开一个项目" } }));
      return;
    }
    try {
      const res = await api().newChat({
        projectId,
        profile: {
          mode: get().chat.mode,
          approvalPolicy: get().chat.approvalPolicy,
          ...(get().chat.providerId && get().chat.model
            ? {
                providerId: get().chat.providerId,
                model: get().chat.model,
                ...(get().chat.reasoningEffort ? { reasoningEffort: get().chat.reasoningEffort } : {}),
              }
            : {}),
        },
      });
      set((s) => ({
        chat: {
          ...s.chat,
          sessionId: res.sessionId,
          entries: [],
          status: "idle",
          turns: 0,
          usageTokens: 0,
          pendingApproval: undefined,
          notice: "",
          streaming: "",
        },
      }));
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `开新会话失败：${(e as Error).message}` } }));
    }
  },

  loadChatTranscript: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) {
      set((s) => ({ chat: { ...s.chat, entries: [], sessions: [] } }));
      return;
    }
    try {
      // 有活会话就返回它；否则主进程恢复该项目最近一条。这样重启应用后
      // 页面不会只剩一个空输入框，最后一轮对话能直接接上。
      const t = await api().chatLatest({ projectId });
      if (t) {
        set((s) => ({
          chat: {
            ...s.chat,
            sessionId: t.meta.sessionId,
            entries: t.entries,
            status: t.meta.status,
            turns: t.meta.turns,
            usageTokens: t.meta.usageTokens,
            mode: t.meta.mode,
            approvalPolicy: t.meta.approvalPolicy,
            providerId: t.meta.providerId,
            model: t.meta.model,
            reasoningEffort: t.meta.reasoningEffort,
            pendingApproval: undefined,
            streaming: "",
          },
        }));
      } else {
        // 没有记录时不清空内存里的条目：页面刚挂载时状态本来就是空的，
        // 而删除当前会话那条路径会显式先清空再调这里。
        set((s) => ({
          chat: {
            ...s.chat,
            sessionId: undefined,
            status: "idle",
            pendingApproval: undefined,
            streaming: "",
          },
        }));
      }
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `读取会话失败：${(e as Error).message}` } }));
    }
    await get().loadChatSessions();
  },

  loadChatSessions: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    try {
      const sessions = await api().listChatSessions({ projectId });
      set((s) => ({ chat: { ...s.chat, sessions } }));
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `读取会话列表失败：${(e as Error).message}` } }));
    }
  },

  resumeChat: async (sessionId) => {
    const projectId = get().activeProjectId;
    if (!projectId) {
      set((s) => ({ chat: { ...s.chat, notice: "先在「项目库」里打开一个项目" } }));
      return;
    }
    try {
      const t = await api().resumeChat({ projectId, sessionId });
      set((s) => ({
        chat: {
          ...s.chat,
          sessionId: t.meta.sessionId,
          entries: t.entries,
          status: t.meta.status,
          turns: t.meta.turns,
          usageTokens: t.meta.usageTokens,
          mode: t.meta.mode,
          approvalPolicy: t.meta.approvalPolicy,
          providerId: t.meta.providerId,
          model: t.meta.model,
          reasoningEffort: t.meta.reasoningEffort,
          pendingApproval: undefined,
          notice: "",
          streaming: "",
        },
      }));
      await get().loadChatSessions();
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `恢复会话失败：${(e as Error).message}` } }));
    }
  },

  forkChat: async (sessionId) => {
    const projectId = get().activeProjectId;
    if (!projectId) {
      set((s) => ({ chat: { ...s.chat, notice: "先在「项目库」里打开一个项目" } }));
      return;
    }
    try {
      const t = await api().forkChat({ projectId, sessionId });
      set((s) => ({
        chat: {
          ...s.chat,
          sessionId: t.meta.sessionId,
          entries: t.entries,
          status: t.meta.status,
          turns: t.meta.turns,
          usageTokens: t.meta.usageTokens,
          mode: t.meta.mode,
          approvalPolicy: t.meta.approvalPolicy,
          providerId: t.meta.providerId,
          model: t.meta.model,
          reasoningEffort: t.meta.reasoningEffort,
          pendingApproval: undefined,
          notice: "",
          streaming: "",
        },
      }));
      await get().loadChatSessions();
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `分叉失败：${(e as Error).message}` } }));
    }
  },

  deleteChat: async (sessionId) => {
    try {
      await api().deleteChat({ sessionId });
      if (get().chat.sessionId === sessionId) {
        set((s) => ({
          chat: {
            ...s.chat,
            sessionId: undefined,
            entries: [],
            status: "idle",
            pendingApproval: undefined,
            streaming: "",
          },
        }));
        await get().loadChatTranscript();
      } else {
        await get().loadChatSessions();
      }
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `删除会话失败：${(e as Error).message}` } }));
    }
  },

  revertChat: async (turn, path) => {
    const projectId = get().activeProjectId;
    const sessionId = get().chat.sessionId;
    if (!projectId || !sessionId) {
      set((s) => ({ chat: { ...s.chat, notice: "没有可撤销的会话" } }));
      return;
    }
    try {
      const result = await api().revertChat({ projectId, sessionId, turn, ...(path ? { path } : {}) });
      const head =
        result.reverted.length > 0 ? `已撤销：${result.reverted.join("、")}` : "没有文件被撤销";
      const tail =
        result.skipped.length > 0
          ? `；跳过 ${result.skipped.length} 处：${result.skipped
              .map((s) => `${s.path}（${s.reason}）`)
              .join("；")}`
          : "";
      set((s) => ({ chat: { ...s.chat, notice: `${head}${tail}` } }));
    } catch (e) {
      set((s) => ({ chat: { ...s.chat, notice: `撤销失败：${(e as Error).message}` } }));
    }
  },

  resolveChatApproval: async (granted, scope, reason) => {
    const req = get().chat.pendingApproval;
    if (!req) return;
    // 允许一次 / 本会话不再问这两条路径不带理由：`reason` 是可选的，
    // 不能对可能为 undefined 的值直接 `.trim()`（那会让批准按钮抛异常）。
    const trimmed = (reason ?? "").trim();
    await api().resolveChatApproval(req.requestId, {
      granted,
      scope: scope ?? "once",
      ...(trimmed !== "" ? { reason: trimmed } : {}),
    });
    set((s) => ({ chat: { ...s.chat, pendingApproval: undefined } }));
  },

  refreshProjects: async () => {
    // Guarded: this runs on mount, so a rejected IPC call (unreadable projects
    // dir) escaped as an unhandled rejection and left the list silently empty —
    // indistinguishable from "no projects yet".
    try {
      const projects = await api().listProjects();
      set({ projects, projectsError: undefined });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 读取项目列表失败: ${message}`],
      }));
    }
  },

  deleteProject: async (projectId) => {
    try {
      await api().deleteProject(projectId);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== projectId),
        activeProjectId: s.activeProjectId === projectId ? undefined : s.activeProjectId,
        projectsError: undefined,
      }));
    } catch (err) {
      const message = (err as Error).message;
      // The row is kept: deleting only from local state would show a project
      // as gone while its workspace is still on disk.
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 删除项目失败: ${message}`],
      }));
    }
  },

  createAndOpen: async () => {
    const { newProjectName, newRequirement } = get();
    if (!newRequirement.trim()) return;
    try {
      const rec = await api().createProject(
        newProjectName.trim() || "未命名项目",
        newRequirement.trim(),
      );
      get().beginProject(rec.id);
    } catch (err) {
      // Staying on the projects page is deliberate: navigating to the PRD page
      // first and failing afterwards would leave an empty review screen with no
      // project behind it.
      const message = (err as Error).message;
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 创建项目失败: ${message}`],
      }));
      return;
    }
  },

  /**
   * 从 GitHub issue 建项目（摄入半边，2026-10-14）：名字取标题、需求取
   * 标题+正文（成文模板与 headless 的 spec.issue 共用一份，见
   * shared/github-issue.ts）。之后与手填创建没有任何区别 —— 这条链路不复用
   * 规划，只换种子；搬家与开跑走共同的 beginProject。
   */
  createFromIssue: async (issue: GithubIssue) => {
    const name = issue.title.trim() || `GitHub Issue #${issue.number}`;
    try {
      const rec = await api().createProject(name, renderIssueRequirement(issue));
      get().beginProject(rec.id);
    } catch (err) {
      // 与 createAndOpen 同一条规矩：失败留在项目页说，不带着空看板跳走。
      const message = (err as Error).message;
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 从 issue 创建项目失败: ${message}`],
      }));
    }
  },

  /**
   * 从项目库点开已有项目（2026-10-19）。
   *
   * 与 `beginProject` 的差别是**刻意的**：这里不重跑规划 —— PRD 与批次已经
   * 在盘上，看板挂载时会自己 `loadRecovery` 从审计事实恢复进度。此前"点项目
   * 行"只切了页面没设 `activeProjectId`，看板于是继续显示上一个项目，看上去
   * 像点了没反应。
   */
  openProject: (projectId: string) => {
    set({
      activeProjectId: projectId,
      page: "board",
      projectsError: undefined,
    });
  },

  /**
   * 左栏点项目（M1，见 `AppState.focusProject` 的注释）。
   *
   * 顺序是「先落页面、再取数」：反过来（await 完再 set page）会让一次慢的
   * `chatLatest` 把点击表现得像没反应 —— 界面要立刻有反馈，数据随后跟上。
   * 同项目重复点击不重取：那会打断正在读的转录。
   */
  focusProject: async (projectId: string) => {
    if (get().activeProjectId === projectId) return;
    set({ activeProjectId: projectId, page: "chat", projectsError: undefined });
    try {
      await get().loadChatTranscript();
    } catch (err) {
      // loadChatTranscript 内部已把失败写进 notice；这里只兜"它自己抛出来"
      // 的那种，不吞也不重复报。
      const message = (err as Error).message;
      set((s) => ({ chat: { ...s.chat, notice: `切换项目失败：${message}` } }));
    }
  },

  /** 创建成功后的共同搬家：进 PRD 复核页并立即开始规划。 */
  beginProject: (projectId: string) => {
    set({
      activeProjectId: projectId,
      page: "prd-review",
      stage: "PLANNING",
      logs: [],
      tasks: {},
      escalations: [],
      approvals: [],
      conflicts: [],
      verification: undefined,
      receipt: undefined,
      prd: undefined,
      batches: undefined,
      planning: true,
      planningError: undefined,
      projectsError: undefined,
    });
    void get().runPlanning();
  },

  runPlanning: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    const seq = ++planningSeq;
    set((s) => ({ planning: true, planningError: undefined, logs: [...s.logs, "── 正在生成 PRD 并分解任务… ──"] }));
    try {
      const { prd, batches } = await api().runPlanning(activeProjectId);
      if (seq !== planningSeq) return;
      set({ prd, batches, planning: false, logs: [] });
    } catch (err) {
      if (seq !== planningSeq) return;
      set((s) => ({
        planning: false,
        planningError: (err as Error).message,
        logs: [...s.logs, `[错误] 规划失败: ${(err as Error).message}`],
      }));
    }
  },

  retryPlanning: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({
      prd: undefined,
      batches: undefined,
      planning: true,
      planningError: undefined,
      stage: "PLANNING",
      logs: ["── 重新规划中… ──"],
    });
    await get().runPlanning();
  },

  updatePrd: async (prd) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set((s) => ({ logs: [...s.logs, "── PRD 已修改，重新分解任务… ──"] }));
    try {
      const result = await api().updatePrd(activeProjectId, prd);
      set({ prd: result.prd, batches: result.batches });
    } catch (err) {
      set((s) => ({
        planningError: (err as Error).message,
        logs: [...s.logs, `[错误] 更新 PRD 失败: ${(err as Error).message}`],
      }));
    }
  },

  confirmAndExecute: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    // A new run supersedes any recovered history: the interrupted flag belongs
    // to the *previous* run and must not survive into this one.
    set({
      page: "board",
      stage: "DEVELOPMENT",
      interrupted: undefined,
      lastActivityTs: undefined,
      // 上一轮的结论（凭据/验证）属于**上一次**运行，不许带进新 run：混在板子上
      // 会让"这次跑到哪了"读不出真假，也和按钮的运行态联动相互依赖（2026-10-13）。
      verification: undefined,
      receipt: undefined,
      receiptVerdict: undefined,
      runStartedAt: Date.now(),
    });
    try {
      await api().startOrchestration(activeProjectId);
    } catch (err) {
      set((s) => ({ logs: [...s.logs, `[错误] ${(err as Error).message}`] }));
    }
  },

  backToProjects: () =>
    set({ page: "projects", prd: undefined, batches: undefined, stage: "PRD", tasks: {} }),

  loadSettings: async () => {
    // Unguarded before: a rejected IPC call (corrupt settings file, store not
    // ready) escaped as an unhandled rejection and the settings page silently
    // showed defaults — indistinguishable from "nothing configured yet".
    try {
      const settings = await api().getSettings();
      set({ settings, settingsError: undefined });
    } catch (err) {
      // The log alone is not enough: the page renders `settings === undefined`
      // as defaults and disables saving, so a failed load looked exactly like
      // "nothing configured yet" — with no hint about why saving is disabled.
      const message = (err as Error).message;
      set((s) => ({
        settingsError: message,
        logs: [...s.logs, `[错误] 读取设置失败: ${message}`],
      }));
    }
  },

  saveSettings: async (settings) => {
    // Only commit the new settings locally once the write succeeded; otherwise
    // the UI would show settings that were never persisted.
    try {
      await api().saveSettings(settings);
      set({ settings, settingsError: undefined });
    } catch (err) {
      set((s) => ({
        logs: [...s.logs, `[错误] 保存设置失败: ${(err as Error).message}`],
        settingsError: (err as Error).message,
      }));
    }
  },

  resolveEscalation: async (taskId, action) => {
    const before = get().escalations.find((e) => e.taskId === taskId);
    set((s) => ({
      escalations: s.escalations.map((e) =>
        e.taskId === taskId ? { ...e, resolved: true } : e,
      ),
      logs: [...s.logs, `── 已决策 ${taskId}：${action} ──`],
    }));
    try {
      await api().resolveEscalation(taskId, action);
    } catch (err) {
      const message = (err as Error).message;
      // Roll the optimistic update back. Leaving `resolved: true` hides the
      // three action buttons behind a "已处理" label, so the operator can never
      // retry — while the engine never actually received the decision.
      set((s) => ({
        escalations: s.escalations.map((e) => (e.taskId === taskId ? (before ?? e) : e)),
        logs: [...s.logs, `[错误] 决策失败: ${message}`],
      }));
    }
  },

  resolveApproval: async (requestId, granted) => {
    const before = get().approvals.find((a) => a.requestId === requestId);
    set((s) => ({
      approvals: s.approvals.map((a) => (a.requestId === requestId ? { ...a, resolved: true } : a)),
      logs: [...s.logs, `── 审批 ${requestId}：${granted ? "批准" : "拒绝"} ──`],
    }));
    try {
      await api().resolveApproval(requestId, granted);
    } catch (err) {
      const message = (err as Error).message;
      // 与 resolveEscalation 同款乐观回滚：保留按钮，让操作者能重试。
      set((s) => ({
        approvals: s.approvals.map((a) => (a.requestId === requestId ? (before ?? a) : a)),
        logs: [...s.logs, `[错误] 审批回传失败: ${message}`],
      }));
    }
  },

  verifyReceipt: async () => {
    const { activeProjectId, receipt } = get();
    if (!activeProjectId || !receipt) return;
    try {
      // 默认 replay:false（fail-safe）：复核先只做完整性与指纹判定，不执行凭据里
      // 的命令 —— 要复跑走 receipt-verify CLI（--replay 有它自己的警示）。
      const result = await api().verifyReceipt(activeProjectId, false);
      set({ receiptVerdict: result });
    } catch (err) {
      set((s) => ({ logs: [...s.logs, `[错误] 凭据复核失败: ${(err as Error).message}`] }));
    }
  },

  loadRecovery: async () => {
    // Board recovery (facts/derived split): on mount the board asks the main
    // process for the view derived from the audit trail. Before this, a
    // reload — or a killed process tree — left the board blank even though
    // the durable facts of the last run were sitting on disk.
    try {
      const view = await api().boardRecovery();
      set((s) => ({
        tasks: { ...s.tasks, ...view.tasks },
        ...(view.stage ? { stage: view.stage } : {}),
        ...(view.receipt ? { receipt: view.receipt } : {}),
        interrupted: view.interrupted,
        // ⚠️ **恢复批次的时间戳与任务心跳不是同一个字段**（2026-10-07 tsc 修）。
        //
        // `AppState` 上有两个 `lastActivityTs`：`TaskView.lastActivityTs?: number`
        // （毫秒时间戳，任务心跳）与 `AppState.lastActivityTs?: string`
        // （ISO 串，恢复横幅用）。这里回填的是**后者**，
        // 之前直接写了 `view.lastActivityTs`（string）—— `tsc` 早就报过这一行，
        // 一直没被处理。显式点出键名比依赖推断更清楚，两种语义也不会被混。
        lastActivityTs: view.lastActivityTs,
        logs:
          view.interrupted || Object.keys(view.tasks).length > 0
            ? [...s.logs, "── 已从审计日志恢复上次运行的进度 ──"]
            : s.logs,
      }));
    } catch (err) {
      // Recovery is an enhancement, never a blocker: an unreadable trail must
      // not stop the board from working exactly as before.
      set((s) => ({
        logs: [...s.logs, `[提示] 审计恢复不可用: ${(err as Error).message}`],
      }));
    }
  },

  handleEvent: (payload) => {
    const p = payload as Record<string, unknown>;
    // 宿主已经能同时跑多条线程（M4a），事件里带 sessionId。别的线程的事件**不进
    // 本视图** —— 串台的表现是"两条线程的正文拼进同一个转录"，比丢事件难查得多。
    // 当前还没拿到 id 时（首条消息的返回值可能晚于第一个事件）按本线程处理。
    if (typeof p.type === "string" && p.type.startsWith("chat:") && !isEventForChat(get().chat.sessionId, p)) {
      return;
    }
    switch (p.type) {
      case "stage":
        set((s) => ({ stage: p.stage as Stage, logs: [...s.logs, `── 阶段：${String(p.stage)} ──`] }));
        break;
      case "log":
        set((s) => ({ logs: [...s.logs.slice(-500), String(p.text)] }));
        break;
      case "task-activity": {
        const { taskId, at } = p as { taskId: string; at: number };
        set((s) => {
          const prev = s.tasks[taskId];
          // 心跳只对在跑的任务有意义：终态任务收到迟到的心跳不应复活它。
          if (!prev || prev.status !== "running") return {};
          return { tasks: { ...s.tasks, [taskId]: { ...prev, lastActivityTs: at } } };
        });
        break;
      }
      case "task-note": {
        // 操作者附言的状态回声（C2）：设置/清除/退休都合并进任务视图。
        // 空串 = 清除（连键都不留，与"没有附言"同形）。终态任务也收 ——
        // 人可能在失败后写附言再点重派，那时 status 已是 failed。
        const { taskId, note } = p as { taskId: string; note: string };
        set((s) => {
          const prev = s.tasks[taskId];
          if (!prev) return {};
          const next = { ...prev };
          if (note === "") delete next.operatorNote;
          else next.operatorNote = note;
          return { tasks: { ...s.tasks, [taskId]: next } };
        });
        break;
      }
      case "taskStatus": {
        const { taskId, status, attempts, title, zone } = p as {
          taskId: string;
          status: TaskStatus;
          attempts: number;
          title?: string;
          zone?: string;
        };
        set((s) => {
          const prev = s.tasks[taskId];
          return {
            tasks: {
              ...s.tasks,
              [taskId]: {
                // Spread prev first: a repair round re-dispatches the task and
                // emits `running` again — wiping agentId/durationMs/errorClass
                // here would erase the attribution the board needs to explain
                // "who ran it, how long, why it failed".
                ...prev,
                taskId,
                title: title ?? prev?.title ?? taskId,
                zone: zone ?? prev?.zone ?? "",
                status,
                // 重新派发 = 心跳账本重置：上一轮的静默记录不能算到这一轮头上。
                ...(status === "running" ? { lastActivityTs: Date.now() } : { lastActivityTs: undefined }),
                attempts,
              },
            },
          };
        });
        break;
      }
      case "verification":
        set((s) => ({
          verification: p.report as AppState["verification"],
          logs: [...s.logs, "── 硬性验证结果已生成，见右侧面板 ──"],
        }));
        break;
      case "receipt":
        set((s) => ({
          receipt: p.receipt as AppState["receipt"],
          logs: [...s.logs, p.receipt ? (p.receipt as { headline: string }).headline : ""],
        }));
        break;
      case "usage": {
        // 事件载荷是 `Record<string, unknown>`：先过 unknown 再落类型，与其余
        // case 的 `as AppState[...]` 同源（不做逐字段校验，协议保证形状）。
        const snap = p as unknown as UsageSnapshot;
        set((s) => ({ usage: snap, logs: [...s.logs, formatUsageLine(snap)] }));
        break;
      }
      case "line-health":
        set(() => ({ lineHealth: (p as { lines: AppState["lineHealth"] }).lines }));
        break;
      case "escalation": {
        const { taskId, summary } = p as { taskId: string; summary: string };
        set((s) => ({
          escalations: [
            ...s.escalations.filter((e) => e.taskId !== taskId),
            { taskId, summary, resolved: false },
          ],
          logs: [...s.logs, `── ⚠️ 任务 ${taskId} 需要决策（见右侧面板）──`],
        }));
        break;
      }
      case "chat:entry": {
        const entry = (p as { entry: ChatEntry }).entry;
        // 落定的事实到了：正在打字的预览清空（正文以 entry 为准，不重复显示）。
        set((s) => ({ chat: { ...s.chat, entries: [...s.chat.entries, entry], streaming: "" } }));
        break;
      }
      case "chat:delta": {
        const text = String((p as { text?: string }).text ?? "");
        if (text !== "") set((s) => ({ chat: { ...s.chat, streaming: s.chat.streaming + text } }));
        break;
      }
      case "chat:status": {
        const { status, turns } = p as { status: ChatStatus; turns: number };
        set((s) => ({ chat: { ...s.chat, status, turns } }));
        break;
      }
      case "chat:approval-request": {
        // 单条而非数组：会话严格串行，同一时刻最多一个动作在等人。
        const request = (p as { request: ChatApprovalRequest }).request;
        set((s) => ({ chat: { ...s.chat, pendingApproval: request, status: "awaiting-approval" } }));
        break;
      }
      case "chat:done": {
        const { turns, usageTokens } = p as { turns: number; usageTokens: number };
        set((s) => ({
          chat: { ...s.chat, status: "done", turns, usageTokens, pendingApproval: undefined, streaming: "" },
        }));
        break;
      }
      case "chat:error": {
        const message = String(p.message ?? "");
        set((s) => ({
          chat: { ...s.chat, status: "error", pendingApproval: undefined, streaming: "" },
          logs: [...s.logs.slice(-500), `── 会话出错：${message} ──`],
        }));
        break;
      }
      case "approval-request": {
        const { requestId, command, args } = p as { requestId: string; command: string; args: string[] };
        set((s) => ({
          approvals: [
            ...s.approvals.filter((a) => a.requestId !== requestId),
            { requestId, command, args: args ?? [], resolved: false },
          ],
          logs: [...s.logs, `── ⚠️ 命令需要审批（见右侧面板）：${command} ${(args ?? []).join(" ")} ──`],
        }));
        break;
      }
      case "conflict": {
        const { kind, paths, remedy } = p as { kind?: string; paths?: string[]; remedy?: string };
        // 词表与生产端同源，见 REMEDY_VERB 上的注释；未收录的值仍念"仅记录"，
        // 但绝不把原始 token 打到界面上。
        const verb = REMEDY_VERB[remedy ?? "none"] ?? "仅记录";
        set((s) => ({
          conflicts: [
            ...s.conflicts.slice(-49),
            {
              kind: kind ?? "unknown",
              paths: paths ?? [],
              remedy: remedy ?? "none",
              ts: new Date().toISOString(),
            },
          ],
          logs: [
            ...s.logs.slice(-500),
            `── ⚠️ 区域冲突（${kind ?? "unknown"}，${verb}）：${(paths ?? []).join("、").slice(0, 300)} ──`,
          ],
        }));
        break;
      }
      case "taskOutcome": {
        const { taskId, ok, logDigest, agentId, errorClass, durationMs } = p as {
          taskId: string;
          ok: boolean;
          logDigest?: string;
          agentId?: string;
          errorClass?: string;
          durationMs?: number;
        };
        set((s) => {
          const prev = s.tasks[taskId];
          if (!prev) return {};
          // A task can fail and later succeed in a repair round: attribution is
          // kept, but the failure class must be cleared or the board keeps
          // showing a stale error next to a green task.
          const next: TaskView = {
            ...prev,
            failureDigest: ok ? undefined : (logDigest ?? "无日志"),
            ...(agentId ? { agentId } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          };
          if (ok) delete next.errorClass;
          // ⚠️ **收窄发生在这里，这个边界之前是漏的**（2026-10-07）。
          //
          // 旧写法 `next.errorClass = errorClass ?? "unknown"` —— `errorClass`
          // 是从 IPC 事件上读的 `string`，**没有任何检查**就直写进
          // `TaskView.errorClass`（声明为 `FailureClass`）。实测：
          //
          //   送 "quantum-flux"（未登记）→ TaskView.errorClass === "quantum-flux"
          //   送 42（连类型都不是）      → TaskView.errorClass === 42
          //
          // 而 `BoardPage.tsx:26` 的注释白纸黑字写着"值已在边界经
          // `isFailureClass` 收窄" —— **收窄器 `isFailureClass` 一直零调用者**，
          // 由 `check:unwired` 门禁当场抓出。这条注释描述的是一个从未存在的接线。
          //
          // 收窄之后 `Record<FailureClass, string>` 的"键受 tsc 兜着"才真正成立，
          // 界面上 `ERROR_LABELS[c] ?? c` 的兜底才只会兜到 `unknown` 以外的**已知**档。
          else next.errorClass = isFailureClass(errorClass) ? errorClass : "unknown";
          return { tasks: { ...s.tasks, [taskId]: next } };
        });
        break;
      }
    }
  },
}));
