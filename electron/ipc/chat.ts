/**
 * 交互式会话的 IPC 面（对标 Codex 的 TUI 那一层）。
 *
 * 与看板那条链的关系：**并行、不共用**。看板是"需求 → PRD → 批次 → 门禁"的
 * 编排流水线，会话是"人说一句 → 模型自己读改写 → 人看着过程"的编码智能体。
 * 两者共用同一套沙箱与同一个 LLM 池，但**不共用审批队列** —— 看板的审批是
 * 批次级的（`orchestration:approval-decide` 是二值），会话的审批要能说"本次
 * 会话都别再问了"、要能把拒绝理由回灌给模型，所以这里另开一条。
 *
 * 三条纪律：
 * 1. **审批问不到人就按拒绝处理**（fail-closed，与 `ApprovalGate` 同源）；
 *    会话被中止时，挂着没答的审批一并按拒绝收尾 —— 否则那个 Promise 会永远
 *    悬着，表现为"会话卡住不动"而不是"已停止"。
 * 2. `chat:send` **不等会话跑完**：它返回 sessionId，过程由 `ox:event` 推。
 *    IPC 通道挂到一轮结束会让人以为界面卡死，而工具循环本来就是分钟级的。
 * 3. **会话记录在状态边界落盘**：重启后能恢复最后一段对话，而不是只剩一个
 *    空白的输入框。恢复时模型消息原样接回，不从 UI 转录反推。
 */
import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { buildLlm, send, settingsStore, workspaceRoot } from "./context";
import { ChatSession } from "../chat/session";
import { ToolRunner } from "../chat/tool-runner";
import { ChatSessionStore } from "../chat/session-store";
import { resolveChatRuntime, type ChatRuntime } from "../chat/runtime";
import { writeFileAtomic } from "../atomic-file";
import { getProvider } from "../../shared/providers";
import type { ProjectSettings } from "../../shared/types";
import {
  messagesForProtocol,
  type ChatApprovalAnswer,
  type ChatApprovalRequest,
  type ChatHistory,
  type ChatRevertResult,
  type ChatSessionSnapshot,
  type ChatTranscript,
} from "../../shared/chat-events";
import type { ChatFileChange } from "../../shared/tools/spec";

interface LiveSession {
  session: ChatSession;
  controller: AbortController;
  rootAbs: string;
  projectId: string;
  providerId: string;
  /**
   * 会话构造时的运行时签名。工具边界（项目根、沙箱档位、审批策略、模型池）
   * 都是在构造时定死的；设置变了却复用旧会话，会让界面显示的档位与实际执行
   * 的判定不一致 —— 那是最难查的一类越权。
   */
  signature: string;
}

let live: LiveSession | null = null;
let sessionStore: ChatSessionStore | null = null;
/** 挂起等待人答复的审批：requestId -> resolver。 */
const pendingApprovals = new Map<string, (answer: ChatApprovalAnswer) => void>();

function chatStore(): ChatSessionStore {
  if (!sessionStore) sessionStore = new ChatSessionStore(path.join(app.getPath("userData"), "chat"));
  return sessionStore;
}

/**
 * 工具调用走哪种协议：端点声明原生支持才走 `tools` 字段。
 *
 * 判定落在**主 provider** 上（`settings.llmProvider`），因为线路池是"同一次
 * 调用在多条线路间轮换"，不可能为每条线路准备一份消息序列；未声明的端点一律
 * 走文本协议（理由见 `ProviderConfig.tools` 的注释）。
 */
export function toolProtocolOf(settings: ProjectSettings): "native" | "text" {
  const id = settings.llmProvider;
  try {
    return getProvider(id).tools === "native" ? "native" : "text";
  } catch {
    return "text";
  }
}

/** 会话被中止 / 应用退出：把挂着没答的审批按拒绝收尾。 */
function rejectAllApprovals(reason: string): void {
  for (const [id, resolve] of [...pendingApprovals]) {
    pendingApprovals.delete(id);
    resolve({ granted: false, reason });
  }
}

export function abortChatSession(): boolean {
  if (!live) return false;
  live.controller.abort();
  rejectAllApprovals("会话已中止");
  return true;
}

function sameRoot(a: string, b: string): boolean {
  const normalize = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(a) === normalize(b);
}

function buildSession(
  rootAbs: string,
  settings: ProjectSettings,
  runtime: ChatRuntime,
  projectId: string,
  history?: ChatHistory,
): ChatSession {
  const providerId = settings.llmProvider;
  // Capture the store instance for this session's lifetime. `chatStore()` is a
  // mutable module singleton reset on re-registration (tests do this every case);
  // resolving it lazily would make an older session write into the newer test's
  // userData directory after a restart.
  const storeForSession = chatStore();
  const controller = new AbortController();
  // 先定 sessionId：审批事件可能在 `live` 赋值前发生（runner 是构造期依赖），
  // 从 `live` 反读会得到一个空 id，渲染层就无法把审批挂回当前会话。
  const sessionId = history?.sessionId ?? `chat-${randomUUID()}`;
  for (const issue of runtime.issues) send({ type: "log", text: `[chat] ${issue}` });
  const runner = new ToolRunner({
    rootAbs,
    pathPolicy: runtime.pathPolicy,
    commandPolicy: runtime.commandPolicy,
    mode: runtime.mode,
    approvalPolicy: runtime.approvalPolicy,
    approvalCommands: runtime.approvalCommands,
    requestApproval: async (req: ChatApprovalRequest) =>
      await new Promise<ChatApprovalAnswer>((resolve) => {
        pendingApprovals.set(req.requestId, resolve);
        send({ type: "chat:approval-request", sessionId, request: req });
      }),
    onEvent: (text) => send({ type: "log", text }),
  });
  const session = new ChatSession({
    client: buildLlm(settings),
    runner,
    rootAbs,
    sessionId,
    ...(history ? { history } : {}),
    systemPrompt: runtime.systemPrompt,
    toolProtocol: toolProtocolOf(settings),
    mode: runtime.mode,
    approvalPolicy: runtime.approvalPolicy,
    ...(runtime.maxTurns !== undefined ? { maxTurns: runtime.maxTurns } : {}),
    signal: controller.signal,
    onEvent: (event) => send({ ...event } as unknown as Record<string, unknown>),
    onPersist: (snapshot: ChatSessionSnapshot) => {
      try {
        storeForSession.save(projectId, rootAbs, providerId, snapshot);
      } catch (e) {
        // 落盘失败不能让会话本身崩掉；但要让人看见"这段没记下来"。
        send({ type: "log", text: `[chat] 会话记录保存失败：${(e as Error).message}` });
      }
    },
  });
  live = { session, controller, rootAbs, projectId, providerId, signature: runtime.signature };
  return session;
}

function runtimeOf(rootAbs: string, settings: ProjectSettings): ChatRuntime {
  return resolveChatRuntime({
    rootAbs,
    settings,
    globalPolicyDir: path.join(app.getPath("userData"), "policy.d"),
    homeDir: app.getPath("home"),
  });
}

/**
 * 取当前会话；没有、属于别的项目、设置变了、或已被中止，都重建。
 *
 * 中止后重建是必要的：AbortSignal 一旦落下就不会复位，复用旧会话会让用户
 * 在“停止”之后再也发不出下一条消息（表现为每句话都立刻变成“已中止”）。
 * 同项目内的重建会带上旧转录（设置变了不等于聊天记录消失），跨项目不带。
 */
function ensureLiveSession(rootAbs: string, settings: ProjectSettings, projectId: string): ChatSession {
  const runtime = runtimeOf(rootAbs, settings);
  if (
    live !== null &&
    live.signature === runtime.signature &&
    live.projectId === projectId &&
    !live.controller.signal.aborted
  ) {
    return live.session;
  }
  let history: ChatHistory | undefined;
  if (live !== null && sameRoot(live.rootAbs, rootAbs)) {
    const snap = live.session.snapshot();
    history = {
      sessionId: live.session.sessionId,
      entries: snap.entries,
      messages: messagesForProtocol(snap.messages, toolProtocolOf(settings)),
      meta: snap.meta,
    };
  }
  abortChatSession();
  return buildSession(rootAbs, settings, runtime, projectId, history);
}

function requireProjectRoot(projectId: string, action: string): string {
  const rootAbs = workspaceRoot(projectId);
  if (!fs.existsSync(rootAbs)) {
    throw new Error(`项目工作区还不存在：${rootAbs}（${action}前先跑一次这个项目，或到项目库里打开它）`);
  }
  return rootAbs;
}

function resumeIntoLive(projectId: string, sessionId: string, settings: ProjectSettings): ChatSession {
  const env = chatStore().load(sessionId);
  if (!env) throw new Error(`会话不存在或已损坏：${sessionId}`);
  if (env.projectId !== projectId) throw new Error("该会话不属于当前项目");
  const rootAbs = requireProjectRoot(projectId, "恢复会话");
  if (!sameRoot(env.rootAbs, rootAbs)) {
    throw new Error(`会话绑定的工作区已变化：${env.rootAbs}（当前 ${rootAbs}）`);
  }
  abortChatSession();
  live = null;
  const history: ChatHistory = {
    sessionId: env.snapshot.meta.sessionId,
    entries: env.snapshot.entries,
    messages: messagesForProtocol(env.snapshot.messages, toolProtocolOf(settings)),
    meta: env.snapshot.meta,
  };
  return buildSession(rootAbs, settings, runtimeOf(rootAbs, settings), projectId, history);
}

function projectIdOf(input: unknown, channel: string): string {
  const payload = (input ?? {}) as { projectId?: unknown };
  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  if (projectId === "") throw new Error(`${channel} 需要 projectId`);
  return projectId;
}

function sessionIdOf(input: unknown, channel: string): string {
  const payload = (input ?? {}) as { sessionId?: unknown };
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (sessionId === "") throw new Error(`${channel} 需要 sessionId`);
  return sessionId;
}

export function registerChatHandlers(): void {
  // 重新装配 IPC（测试里每个用例都会走一次）不能把上一个会话的控制器与
  // 挂起的审批带进来；生产只在启动时调用一次，这里等于空操作。
  abortChatSession();
  live = null;
  sessionStore = null;
  pendingApprovals.clear();

  ipcMain.handle("chat:send", (_e, input: unknown) => {
    const payload = (input ?? {}) as { text?: unknown; projectId?: unknown };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text === "") throw new Error("chat:send 需要非空的 text");
    const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
    if (projectId === "") throw new Error("chat:send 需要 projectId：会话绑在项目工作区里，路径判定以它为界");
    const rootAbs = requireProjectRoot(projectId, "发送消息");
    const settings = settingsStore().load();
    // 换项目/换设置/上一个会话已被中止都在这一处收口。首条消息也必须从这里
    // 拿会话 —— 旧实现只在“已有会话且项目变化”时重建，新装应用第一次发送
    // 会直接对 null 取 `.session`。
    const session = ensureLiveSession(rootAbs, settings, projectId);
    void session.send(text).catch((e) => {
      send({ type: "chat:error", sessionId: session.sessionId, message: (e as Error).message });
    });
    return { sessionId: session.sessionId, accepted: true as const };
  });

  ipcMain.handle("chat:abort", () => abortChatSession());

  ipcMain.handle("chat:transcript", () => (live ? live.session.transcript() : null));

  /**
   * 页面挂载时调用：有活会话就返回它，否则恢复该项目最近的一条记录。
   * 没有任何记录时返回 null（不是错误）。
   */
  ipcMain.handle("chat:latest", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:latest");
    if (live && live.projectId === projectId) {
      if (live.controller.signal.aborted) ensureLiveSession(live.rootAbs, settingsStore().load(), projectId);
      return live ? live.session.transcript() : null;
    }
    const latest = chatStore().latest(projectId);
    if (!latest) return null;
    return resumeIntoLive(projectId, latest.sessionId, settingsStore().load()).transcript();
  });

  ipcMain.handle("chat:list", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:list");
    return chatStore().list(projectId);
  });

  ipcMain.handle("chat:load", (_e, input: unknown) => {
    const sessionId = sessionIdOf(input, "chat:load");
    const env = chatStore().load(sessionId);
    return env ? ({ meta: env.snapshot.meta, entries: env.snapshot.entries } satisfies ChatTranscript) : null;
  });

  ipcMain.handle("chat:resume", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:resume");
    const sessionId = sessionIdOf(input, "chat:resume");
    return resumeIntoLive(projectId, sessionId, settingsStore().load()).transcript();
  });

  ipcMain.handle("chat:fork", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:fork");
    const sessionId = sessionIdOf(input, "chat:fork");
    const source = chatStore().load(sessionId);
    if (!source) throw new Error(`会话不存在或已损坏：${sessionId}`);
    if (source.projectId !== projectId) throw new Error("该会话不属于当前项目");
    const forked = chatStore().fork(sessionId);
    if (!forked) throw new Error(`分叉失败：${sessionId}`);
    const rootAbs = requireProjectRoot(projectId, "分叉会话");
    abortChatSession();
    live = null;
    const settings = settingsStore().load();
    const history: ChatHistory = {
      sessionId: forked.snapshot.meta.sessionId,
      entries: forked.snapshot.entries,
      messages: messagesForProtocol(forked.snapshot.messages, toolProtocolOf(settings)),
      meta: forked.snapshot.meta,
    };
    return buildSession(rootAbs, settings, runtimeOf(rootAbs, settings), projectId, history).transcript();
  });

  ipcMain.handle("chat:delete", (_e, input: unknown) => {
    const sessionId = sessionIdOf(input, "chat:delete");
    if (live?.session.sessionId === sessionId) {
      abortChatSession();
      live = null;
    }
    return chatStore().delete(sessionId);
  });

  /**
   * 撤销某一轮（可限定单个文件）的 apply_patch 改动。
   *
   * 只在"文件当前内容仍等于补丁应用后的内容"时才动手：用户或后续命令已经
   * 改过的文件一律跳过，绝不把别人的新改动覆盖回旧版本。命令产生的改动不在
   * 这里（没有 before 全文），界面会明说这一点。
   */
  ipcMain.handle("chat:revert", (_e, input: unknown) => {
    const payload = (input ?? {}) as { projectId?: unknown; sessionId?: unknown; turn?: unknown; path?: unknown };
    const projectId = projectIdOf(payload, "chat:revert");
    const sessionId = sessionIdOf(payload, "chat:revert");
    const turn = typeof payload.turn === "number" && Number.isInteger(payload.turn) && payload.turn >= 0 ? payload.turn : null;
    if (turn === null) throw new Error("chat:revert 需要非负整数 turn");
    const onlyPath = payload.path === undefined ? undefined : typeof payload.path === "string" ? payload.path : null;
    if (onlyPath === null) throw new Error("chat:revert 的 path 必须是字符串");
    const rootAbs = requireProjectRoot(projectId, "撤销改动");
    const settings = settingsStore().load();
    const runtime = runtimeOf(rootAbs, settings);

    let entries: ChatHistory["entries"];
    const liveSession = live?.session.sessionId === sessionId ? live.session : null;
    if (liveSession) {
      if (live?.projectId !== projectId) throw new Error("该会话不属于当前项目");
      entries = liveSession.transcript().entries;
    } else {
      const env = chatStore().load(sessionId);
      if (!env) throw new Error(`会话不存在或已损坏：${sessionId}`);
      if (env.projectId !== projectId) throw new Error("该会话不属于当前项目");
      entries = env.snapshot.entries;
    }

    const changes: ChatFileChange[] = [];
    for (const entry of entries) {
      for (const change of entry.result?.changes ?? []) {
        if (change.turn !== turn) continue;
        if (onlyPath !== undefined && change.path !== onlyPath) continue;
        changes.push(change);
      }
    }
    // 同一轮里同一文件可能被多次补丁改过；撤销必须逆序（后改的先还原）。
    changes.reverse();

    const reverted: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const change of changes) {
      if (!change.revertable) {
        skipped.push({ path: change.path, reason: "文件过大，未记录可撤销内容" });
        continue;
      }
      const decision = runtime.pathPolicy.assertWritable(change.path);
      if (!decision.ok) {
        skipped.push({ path: change.path, reason: decision.reason });
        continue;
      }
      const abs = decision.abs;
      let current: string | null = null;
      try {
        if (fs.existsSync(abs)) {
          if (fs.statSync(abs).size > 4 * 1024 * 1024) {
            skipped.push({ path: change.path, reason: "文件当前过大，拒绝覆盖" });
            continue;
          }
          current = fs.readFileSync(abs, "utf8");
        }
      } catch (e) {
        skipped.push({ path: change.path, reason: `读取当前内容失败：${(e as Error).message}` });
        continue;
      }
      if (current !== change.after) {
        skipped.push({ path: change.path, reason: "文件在补丁之后又被改过，未覆盖" });
        continue;
      }
      if (change.before === null) {
        if (!change.created) {
          skipped.push({ path: change.path, reason: "没有可恢复的原内容，也不是本补丁新建" });
          continue;
        }
        fs.rmSync(abs, { force: true });
        reverted.push(change.path);
        continue;
      }
      writeFileAtomic(abs, change.before);
      reverted.push(change.path);
    }

    const result: ChatRevertResult = { reverted, skipped };
    if (liveSession) {
      const parts = [`已撤销第 ${turn} 轮改动：${reverted.length > 0 ? reverted.join("、") : "无"}`];
      if (skipped.length > 0) parts.push(`未撤销 ${skipped.length} 处（${skipped.map((s) => `${s.path}：${s.reason}`).join("；")}）`);
      liveSession.note(parts.join("；"));
    }
    return result;
  });

  ipcMain.handle("chat:new", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:new");
    abortChatSession();
    live = null;
    const rootAbs = requireProjectRoot(projectId, "开新会话");
    const settings = settingsStore().load();
    const session = buildSession(rootAbs, settings, runtimeOf(rootAbs, settings), projectId);
    return { sessionId: session.sessionId };
  });

  ipcMain.handle("chat:approval-decide", (_e, requestId: string, answer: unknown) => {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return false;
    pendingApprovals.delete(requestId);
    const a = (answer ?? {}) as ChatApprovalAnswer;
    resolve({
      granted: a.granted === true,
      scope: a.scope === "session" ? "session" : "once",
      ...(typeof a.reason === "string" && a.reason.trim() !== "" ? { reason: a.reason.trim() } : {}),
    });
    return true;
  });
}
