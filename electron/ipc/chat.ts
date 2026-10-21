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

import { buildLlm, buildLlmPinned, send, settingsStore, workspaceRoot } from "./context";
import { ChatSession } from "../chat/session";
import { ToolRunner } from "../chat/tool-runner";
import { ChatSessionStore } from "../chat/session-store";
import { resolveChatRuntime, type ChatRuntime } from "../chat/runtime";
import { ThreadRegistry, type LiveThread } from "../chat/thread-registry";
import { collectChangedFiles, exportablePaths, threadBranchName, threadExportMessage } from "../../shared/chat-changes";
import { deliveryStamp, exportDeliveryBranch } from "../engine/git-export";
import { publishDeliveryRemote } from "../engine/git-remote";
import { focusChatSession } from "../chat/focus";
import { clearThreadWrites, recordThreadWrites, resetThreadWrites, threadWrites } from "../chat/write-ledger";
import { writeFileAtomic } from "../atomic-file";
import {
  getProvider,
  isModelId,
  isReasoningEffort,
  reasoningEffortsOf,
  type ReasoningEffort,
} from "../../shared/providers";
import type { ProjectSettings } from "../../shared/types";
import {
  messagesForProtocol,
  type ChatApprovalAnswer,
  type ChatApprovalRequest,
  type ChatExportResult,
  type ChatFileIndex,
  type ChatHistory,
  type ChatRevertResult,
  type ChatRuntimeProfile,
  type ChatSessionMeta,
  type ChatSessionSnapshot,
  type ChatTranscript,
} from "../../shared/chat-events";
import { isApprovalPolicy, isSandboxMode } from "../../shared/tools/policy";
import type { ChatFileChange } from "../../shared/tools/spec";

interface LiveSession extends LiveThread {
  session: ChatSession;
  controller: AbortController;
  providerId: string;
  /**
   * 会话构造时的运行时签名。工具边界（项目根、沙箱档位、审批策略、模型池）
   * 都是在构造时定死的；设置变了却复用旧会话，会让界面显示的档位与实际执行
   * 的判定不一致 —— 那是最难查的一类越权。
   */
  signature: string;
}

/**
 * 活线程登记表（M4a）：此前是 `let live` 单例，多线程并行下它会静默串台 ——
 * 第二线程一建，第一线程的 transcript 就指向新的，`chat:abort` 会中止别人。
 * 寻址规则（同 id 覆盖、删活跃项退位、同项目"最近活跃"）都在
 * `chat/thread-registry` 里单独测过，这里只做接线。
 */
const liveThreads = new ThreadRegistry<LiveSession>();

/**
 * 切活跃线程 = 同时告诉通知判据"操作者正在看这条"（M4b）。
 *
 * 两个状态必须一起动：登记表的活跃项决定"省略 sessionId 时打给谁"，
 * 焦点决定"后台审批要不要弹通知"。只更新一个的后果是坏的两种 ——
 * 只更新登记表：审批弹窗会在你已经切过去之后又多弹一次；只更新焦点：
 * 事件寻址会打给上一条线程。
 */
function focusLive(sessionId: string): void {
  liveThreads.setActive(sessionId);
  focusChatSession(sessionId);
}
let sessionStore: ChatSessionStore | null = null;
/** 挂起等待人答复的审批：requestId -> 所属线程 + resolver（中止只清自己那几个）。 */
const pendingApprovals = new Map<string, { sessionId: string; resolve: (answer: ChatApprovalAnswer) => void }>();

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
export function toolProtocolOf(
  settings: ProjectSettings,
  providerId: string = settings.llmProvider,
): "native" | "text" {
  const id = providerId;
  try {
    return getProvider(id).tools === "native" ? "native" : "text";
  } catch {
    return "text";
  }
}

/**
 * 只拒绝**目标线程**的审批。
 *
 * 旧实现一刀切地把所有挂起审批按拒绝收尾 —— 单线程下等价，多线程下等于
 * "中止 A 把 B 的审批也关了"，而 B 还在跑：模型那边等的是一个永远不会来的
 * 答复，runner 会一直挂着。`null` = 全部（仅用于应用退出 / 重装配）。
 */
function rejectApprovals(sessionId: string | null, reason: string): void {
  for (const [id, pending] of [...pendingApprovals]) {
    if (sessionId !== null && pending.sessionId !== sessionId) continue;
    pendingApprovals.delete(id);
    pending.resolve({ granted: false, reason });
  }
}

/** 中止一条活线程；`sessionId` 缺席 = 最近活跃的那条（兼容旧调用）。 */
export function abortChatSession(sessionId?: string): boolean {
  const target = sessionId === undefined ? liveThreads.active() : liveThreads.get(sessionId);
  if (!target) return false;
  target.controller.abort();
  rejectApprovals(target.sessionId, "会话已中止");
  return true;
}

/** 应用退出 / 重装配 IPC：所有线程一起收尾（生产只在启动时走到一次）。 */
function abortAllChatSessions(): void {
  for (const entry of liveThreads.all()) entry.controller.abort();
  rejectApprovals(null, "会话已中止");
  liveThreads.clear();
}

function sameRoot(a: string, b: string): boolean {
  const normalize = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(a) === normalize(b);
}

/** 线程钉死的线路；省略/未选 = undefined（继续走全局池）。 */
function pinnedLineOf(
  profile: ChatRuntimeProfile | undefined,
  settings: ProjectSettings,
): { providerId: string; model: string } | undefined {
  if (!profile?.providerId && !profile?.model) return undefined;
  const providerId = profile.providerId ?? settings.llmProvider;
  return { providerId, model: profile.model ?? getProvider(providerId).defaultModel };
}

function buildSession(
  rootAbs: string,
  settings: ProjectSettings,
  runtime: ChatRuntime,
  projectId: string,
  history?: ChatHistory,
  profile?: ChatRuntimeProfile,
): ChatSession {
  const pinned = pinnedLineOf(profile, settings);
  const providerId = pinned?.providerId ?? settings.llmProvider;
  const toolProtocol = toolProtocolOf(settings, providerId);
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
    // M4c：冲突检测的两个注入点都在这里接 —— 本线程 id 与"别人的写台账"。
    // CLI / headless 单线程形态走同一个 ToolRunner，只是不注入，于是天然不检测。
    sessionId,
    conflictWrites: () => threadWrites(),
    onWrite: (paths: readonly string[]) => recordThreadWrites(sessionId, paths),
    requestApproval: async (req: ChatApprovalRequest) =>
      await new Promise<ChatApprovalAnswer>((resolve) => {
        // 审批 id 只在**会话内**唯一（文本协议是 `t-1`/`t-2`，原生协议是模型给的
        // call id）—— 两条线程同时问第一件事时就是同一个键：答一条等于答两条，
        // 或者一条被另一条顶掉、永远挂着。对外暴露的 id 因此带上会话前缀。
        const approvalId = `${sessionId}#${req.requestId}`;
        pendingApprovals.set(approvalId, { sessionId, resolve });
        send({ type: "chat:approval-request", sessionId, request: { ...req, requestId: approvalId } });
      }),
    onEvent: (text) => send({ type: "log", text }),
  });
  const session = new ChatSession({
    client: pinned ? buildLlmPinned(settings, pinned.providerId, pinned.model) : buildLlm(settings),
    runner,
    rootAbs,
    sessionId,
    ...(history ? { history } : {}),
    systemPrompt: runtime.systemPrompt,
    toolProtocol,
    mode: runtime.mode,
    approvalPolicy: runtime.approvalPolicy,
    ...(pinned ? { providerId: pinned.providerId, model: pinned.model } : {}),
    // ChatSession 自己会再判一次"线路与强度必须同时成立"；这里传 undefined
    // 与整个键缺席在 meta 上等价，少一层永远等价的 && 位点。
    reasoningEffort: profile?.reasoningEffort,
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
  focusChatSession(session.sessionId);
  liveThreads.add({
    sessionId: session.sessionId,
    session,
    controller,
    rootAbs,
    projectId,
    providerId,
    signature: runtime.signature,
  });
  return session;
}

function runtimeOf(
  rootAbs: string,
  settings: ProjectSettings,
  profile?: ChatRuntimeProfile,
): ChatRuntime {
  return resolveChatRuntime({
    rootAbs,
    settings,
    globalPolicyDir: path.join(app.getPath("userData"), "policy.d"),
    homeDir: app.getPath("home"),
    ...(profile ? { profile } : {}),
  });
}

/**
 * 取当前会话；没有、属于别的项目、设置变了、或已被中止，都重建。
 *
 * 中止后重建是必要的：AbortSignal 一旦落下就不会复位，复用旧会话会让用户
 * 在“停止”之后再也发不出下一条消息（表现为每句话都立刻变成“已中止”）。
 * 同项目内的重建会带上旧转录（设置变了不等于聊天记录消失），跨项目不带。
 */
function ensureLiveSession(
  rootAbs: string,
  settings: ProjectSettings,
  projectId: string,
  profile?: ChatRuntimeProfile,
  sessionId?: string,
): ChatSession {
  const runtime = runtimeOf(rootAbs, settings, profile);
  // 带 id = 只认那一条；不带 id = 本项目最近活跃的那条（旧客户端的口径）。
  const existing = sessionId === undefined ? liveThreads.latestOf(projectId) : liveThreads.get(sessionId);
  if (
    existing !== undefined &&
    existing.signature === runtime.signature &&
    existing.projectId === projectId &&
    !existing.controller.signal.aborted
  ) {
    focusLive(existing.sessionId);
    return existing.session;
  }
  // 重建只接**自己的**历史：设置变了不等于聊天记录消失，但另一条线程的转录
  // 与本条无关 —— 顺手接过来就是把两条线搅在一起（多线程下最隐蔽的串台）。
  let history: ChatHistory | undefined;
  if (existing !== undefined && sameRoot(existing.rootAbs, rootAbs)) {
    const snap = existing.session.snapshot();
    history = {
      sessionId: existing.session.sessionId,
      entries: snap.entries,
      messages: messagesForProtocol(
        snap.messages,
        toolProtocolOf(settings, profile?.providerId ?? settings.llmProvider),
      ),
      meta: snap.meta,
    };
    liveThreads.remove(existing.sessionId);
  }
  return buildSession(rootAbs, settings, runtime, projectId, history, profile);
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
  // 已经在跑的那条直接切过去（它的内存态比盘上更新，重建会丢本轮增量）。
  const already = liveThreads.get(sessionId);
  if (already !== undefined && !already.controller.signal.aborted) {
    focusLive(sessionId);
    return already.session;
  }
  // 不必先 remove：`buildSession` 用同一个 sessionId 登记，登记表的"同 id 覆盖"
  // 就是为重建准备的（删了再插也一样，多一行只是多一条要审计的位点）。
  const profile = profileOfMeta(env.snapshot.meta);
  const history: ChatHistory = {
    sessionId: env.snapshot.meta.sessionId,
    entries: env.snapshot.entries,
    messages: messagesForProtocol(
      env.snapshot.messages,
      toolProtocolOf(settings, profile.providerId ?? settings.llmProvider),
    ),
    meta: env.snapshot.meta,
  };
  return buildSession(rootAbs, settings, runtimeOf(rootAbs, settings, profile), projectId, history, profile);
}

function projectIdOf(input: unknown, channel: string): string {
  const payload = (input ?? {}) as { projectId?: unknown };
  const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
  if (projectId === "") throw new Error(`${channel} 需要 projectId`);
  return projectId;
}

/**
 * 视图查询的目标线程：给了 id 就按 id 找，否则最近活跃的那条。
 *
 * 找不到返回 undefined（而不是报错）：`chat:transcript` 在页面挂载时会被无条件
 * 调用一次，"还没有任何活线程"是正常状态，不是错误。
 */
function liveTargetOf(input: unknown): LiveSession | undefined {
  const payload = (input ?? {}) as { sessionId?: unknown };
  if (typeof payload.sessionId !== "string" || payload.sessionId === "") return liveThreads.active();
  return liveThreads.get(payload.sessionId);
}

function sessionIdOf(input: unknown, channel: string): string {
  const payload = (input ?? {}) as { sessionId?: unknown };
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (sessionId === "") throw new Error(`${channel} 需要 sessionId`);
  return sessionId;
}

/** 线程级运行档（M3c）：只接受已知档位/已登记线路，拼错时原地报错而不是静默回退。 */
function chatProfileOf(input: unknown): ChatRuntimeProfile | undefined {
  const raw = (input as { profile?: unknown } | null | undefined)?.profile;
  if (raw === undefined) return undefined;
  const profile = (raw ?? {}) as {
    mode?: unknown;
    approvalPolicy?: unknown;
    providerId?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
  };
  if (!isSandboxMode(profile.mode)) throw new Error("chat:send 的 profile.mode 不合法");
  if (!isApprovalPolicy(profile.approvalPolicy)) {
    throw new Error("chat:send 的 profile.approvalPolicy 不合法");
  }
  let providerId: string | undefined;
  if (profile.providerId !== undefined) {
    if (typeof profile.providerId !== "string" || profile.providerId.trim() === "") {
      throw new Error("chat:send 的 profile.providerId 不合法");
    }
    try {
      getProvider(profile.providerId);
    } catch {
      throw new Error("chat:send 的 profile.providerId 不合法");
    }
    providerId = profile.providerId;
  }
  if (profile.model !== undefined && !isModelId(profile.model)) {
    throw new Error("chat:send 的 profile.model 不合法");
  }
  let reasoningEffort: ReasoningEffort | undefined;
  if (profile.reasoningEffort !== undefined) {
    if (!isReasoningEffort(profile.reasoningEffort)) {
      throw new Error("chat:send 的 profile.reasoningEffort 不合法");
    }
    if (!providerId || profile.model === undefined) {
      throw new Error("chat:send 的 profile.reasoningEffort 需要固定 provider 与 model");
    }
    if (!reasoningEffortsOf(providerId, profile.model).includes(profile.reasoningEffort)) {
      throw new Error("chat:send 的 profile.reasoningEffort 不被当前线路支持");
    }
    reasoningEffort = profile.reasoningEffort;
  }
  return {
    mode: profile.mode,
    approvalPolicy: profile.approvalPolicy,
    ...(providerId ? { providerId } : {}),
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * 从落盘 meta 恢复线程档位。旧快照没有 provider/model（字段缺席），照旧跟随全局；
 * 新快照里若线路字段被手工改坏，丢掉线路而不是让恢复整条会话失败。
 */
function profileOfMeta(meta: ChatSessionMeta): ChatRuntimeProfile {
  const base: ChatRuntimeProfile = { mode: meta.mode, approvalPolicy: meta.approvalPolicy };
  // model 缺席交给下面的 `isModelId`（它本来就返回 false）；这里只挡 provider。
  // 写成 `!provider || !model` 会多一个后半段永远被 isModelId 覆盖的位点。
  if (!meta.providerId) return base;
  try {
    getProvider(meta.providerId);
  } catch {
    return base;
  }
  if (!isModelId(meta.model)) return base;
  const line: ChatRuntimeProfile = { ...base, providerId: meta.providerId, model: meta.model };
  if (
    meta.reasoningEffort !== undefined &&
    isReasoningEffort(meta.reasoningEffort) &&
    reasoningEffortsOf(meta.providerId, meta.model).includes(meta.reasoningEffort)
  ) {
    return { ...line, reasoningEffort: meta.reasoningEffort };
  }
  return line;
}

const MENTION_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  ".ox",
  ".qoder",
  ".workbuddy",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "target",
  "venv",
]);

const MENTION_FILE_LIMIT = 2000;

function ignoredMentionDir(name: string): boolean {
  const lower = name.toLowerCase();
  return MENTION_IGNORED_DIRS.has(lower) || lower.startsWith("dist-") || lower.startsWith("release");
}

function collectProjectFiles(rootAbs: string, runtime: ChatRuntime): ChatFileIndex {
  const files: string[] = [];
  let truncated = false;

  const walk = (absDir: string, relDir: string): void => {
    if (files.length >= MENTION_FILE_LIMIT) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MENTION_FILE_LIMIT) {
        truncated = true;
        return;
      }
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignoredMentionDir(entry.name)) walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile() && !/\s/.test(rel) && runtime.pathPolicy.assertReadable(rel)) {
        files.push(rel);
      }
    }
  };

  walk(rootAbs, "");
  files.sort((a, b) => a.localeCompare(b));
  return { files, truncated };
}

export function registerChatHandlers(): void {
  // 重新装配 IPC（测试里每个用例都会走一次）不能把上一个会话的控制器与
  // 挂起的审批带进来；生产只在启动时调用一次，这里等于空操作。
  abortAllChatSessions();
  sessionStore = null;
  pendingApprovals.clear();
  resetThreadWrites();

  ipcMain.handle("chat:send", (_e, input: unknown) => {
    const payload = (input ?? {}) as { text?: unknown; projectId?: unknown; sessionId?: unknown };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text === "") throw new Error("chat:send 需要非空的 text");
    const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
    if (projectId === "") throw new Error("chat:send 需要 projectId：会话绑在项目工作区里，路径判定以它为界");
    const rootAbs = requireProjectRoot(projectId, "发送消息");
    const settings = settingsStore().load();
    const profile = chatProfileOf(input);
    // 换项目/换设置/上一个会话已被中止都在这一处收口。首条消息也必须从这里
    // 拿会话 —— 旧实现只在“已有会话且项目变化”时重建，新装应用第一次发送
    // 会直接对 null 取 `.session`。
    const target = typeof payload.sessionId === "string" && payload.sessionId !== "" ? payload.sessionId : undefined;
    // 指定了一条没在跑的线程（重启后、或从另一台设备恢复的 id）：先按记录恢复它，
    // 而不是拿一条全新的会话顶替 —— 那会让"回这条线程继续"变成"又开了一条线"。
    const session =
      target !== undefined && liveThreads.get(target) === undefined
        ? resumeIntoLive(projectId, target, settings)
        : ensureLiveSession(rootAbs, settings, projectId, profile, target);
    void session.send(text).catch((e) => {
      send({ type: "chat:error", sessionId: session.sessionId, message: (e as Error).message });
    });
    return { sessionId: session.sessionId, accepted: true as const };
  });

  ipcMain.handle("chat:abort", (_e, input: unknown) => {
    const payload = (input ?? {}) as { sessionId?: unknown };
    return typeof payload.sessionId === "string" && payload.sessionId !== ""
      ? abortChatSession(payload.sessionId)
      : abortChatSession();
  });

  ipcMain.handle("chat:transcript", (_e, input: unknown) => {
    const target = liveTargetOf(input);
    return target ? target.session.transcript() : null;
  });

  /**
   * 页面挂载时调用：有活会话就返回它，否则恢复该项目最近的一条记录。
   * 没有任何记录时返回 null（不是错误）。
   */
  ipcMain.handle("chat:latest", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:latest");
    const projectLive = liveThreads.latestOf(projectId);
    if (projectLive !== undefined) {
      if (projectLive.controller.signal.aborted) {
        ensureLiveSession(
          projectLive.rootAbs,
          settingsStore().load(),
          projectId,
          profileOfMeta(projectLive.session.transcript().meta),
          projectLive.sessionId,
        );
        return liveThreads.get(projectLive.sessionId)?.session.transcript() ?? null;
      }
      focusLive(projectLive.sessionId);
      return projectLive.session.transcript();
    }
    const latest = chatStore().latest(projectId);
    if (!latest) return null;
    return resumeIntoLive(projectId, latest.sessionId, settingsStore().load()).transcript();
  });

  ipcMain.handle("chat:list", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:list");
    return chatStore().list(projectId);
  });

  ipcMain.handle("chat:files", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:files");
    const rootAbs = requireProjectRoot(projectId, "列出项目文件");
    const runtime = runtimeOf(rootAbs, settingsStore().load());
    return collectProjectFiles(rootAbs, runtime);
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
    // 分叉出一条**新**线程：原来那条继续跑（并行下"复制一份再改"是常见动作）。
    const settings = settingsStore().load();
    const profile = profileOfMeta(forked.snapshot.meta);
    const history: ChatHistory = {
      sessionId: forked.snapshot.meta.sessionId,
      entries: forked.snapshot.entries,
      messages: messagesForProtocol(
        forked.snapshot.messages,
        toolProtocolOf(settings, profile.providerId ?? settings.llmProvider),
      ),
      meta: forked.snapshot.meta,
    };
    return buildSession(
      rootAbs,
      settings,
      runtimeOf(rootAbs, settings, profile),
      projectId,
      history,
      profile,
    ).transcript();
  });

  ipcMain.handle("chat:delete", (_e, input: unknown) => {
    const sessionId = sessionIdOf(input, "chat:delete");
    if (liveThreads.get(sessionId) !== undefined) {
      abortChatSession(sessionId);
      liveThreads.remove(sessionId);
      // 它已经不在登记表里了：写台账里不能继续留着它的名字去拦后来的写。
      clearThreadWrites(sessionId);
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
    const liveEntry = liveThreads.get(sessionId);
    if (liveEntry) {
      if (liveEntry.projectId !== projectId) throw new Error("该会话不属于当前项目");
      entries = liveEntry.session.transcript().entries;
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
    if (liveEntry) {
      const parts = [`已撤销第 ${turn} 轮改动：${reverted.length > 0 ? reverted.join("、") : "无"}`];
      if (skipped.length > 0) parts.push(`未撤销 ${skipped.length} 处（${skipped.map((s) => `${s.path}：${s.reason}`).join("；")}）`);
      liveEntry.session.note(parts.join("；"));
    }
    return result;
  });

  /**
   * 把一条线程的 apply_patch 改动导出成 git 分支 + commit（M5a）。
   *
   * 默认不 push：本地分支是操作者可以自己 review / 推送的东西；勾选推送时走
   * `publishDeliveryRemote`（永不 --force、不碰凭据）。导出失败不影响会话本身。
   *
   * 边界：`exportDeliveryBranch` 会 `checkout -B` 到新分支（与编排侧同一语义），
   * 所以导出后当前工作树的分支会变；`unrevertable` 列出的文件没有 before/after，
   * 仍会被提交，但界面必须把它们摆出来。
   */
  ipcMain.handle("chat:export", async (_e, input: unknown) => {
    const payload = (input ?? {}) as { projectId?: unknown; sessionId?: unknown; push?: unknown };
    const projectId = projectIdOf(payload, "chat:export");
    const sessionId = sessionIdOf(payload, "chat:export");
    const push = payload.push === true;
    const rootAbs = requireProjectRoot(projectId, "导出线程");

    let entries: ChatHistory["entries"];
    const liveEntry = liveThreads.get(sessionId);
    if (liveEntry) {
      if (liveEntry.projectId !== projectId) throw new Error("该会话不属于当前项目");
      entries = liveEntry.session.transcript().entries;
    } else {
      const env = chatStore().load(sessionId);
      if (!env) throw new Error(`会话不存在或已损坏：${sessionId}`);
      if (env.projectId !== projectId) throw new Error("该会话不属于当前项目");
      entries = env.snapshot.entries;
    }

    const groups = collectChangedFiles(entries);
    const paths = exportablePaths(groups);
    const unrevertable = groups.filter((g) => !g.revertable).map((g) => g.path);
    if (paths.length === 0) {
      return { ok: true, skipped: "no-changes", unrevertable } satisfies ChatExportResult;
    }

    const title = entries.find((e) => e.kind === "user" && e.text.trim() !== "")?.text ?? "会话改动";
    const branch = threadBranchName(sessionId, deliveryStamp());
    const exported = await exportDeliveryBranch({
      projectRoot: rootAbs,
      paths,
      branch,
      message: threadExportMessage(title, paths.length),
    });
    const result: ChatExportResult = { ...exported, unrevertable };

    if (push) {
      if (!result.ok || !result.branch) {
        result.push = { ok: false, reason: "导出未成功，未推送" };
      } else {
        const settings = settingsStore().load();
        const pushed = await publishDeliveryRemote({
          projectRoot: rootAbs,
          branch: result.branch,
          mode: "push",
          // publish 自己的缺省也是 origin；显式给同一个值，避免一个永远等价的
          // `remote !== undefined` 三元位点。
          remote: settings.deliveryRemote?.remote ?? "origin",
        });
        result.push = {
          ok: pushed.ok,
          skipped: pushed.skipped,
          ...(pushed.pushed !== undefined ? { pushed: pushed.pushed } : {}),
          ...(pushed.remote !== undefined ? { remote: pushed.remote } : {}),
          ...(pushed.reason !== undefined ? { reason: pushed.reason } : {}),
        };
      }
    }
    return result;
  });

  ipcMain.handle("chat:new", (_e, input: unknown) => {
    const projectId = projectIdOf(input, "chat:new");
    const rootAbs = requireProjectRoot(projectId, "新建会话");
    const settings = settingsStore().load();
    const profile = chatProfileOf(input);
    const session = buildSession(
      rootAbs,
      settings,
      runtimeOf(rootAbs, settings, profile),
      projectId,
      undefined,
      profile,
    );
    return { sessionId: session.sessionId };
  });

  ipcMain.handle("chat:approval-decide", (_e, requestId: string, answer: unknown) => {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    pendingApprovals.delete(requestId);
    const a = (answer ?? {}) as ChatApprovalAnswer;
    pending.resolve({
      granted: a.granted === true,
      scope: a.scope === "session" ? "session" : "once",
      ...(typeof a.reason === "string" && a.reason.trim() !== "" ? { reason: a.reason.trim() } : {}),
    });
    return true;
  });
}
