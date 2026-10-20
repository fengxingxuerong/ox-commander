import { contextBridge, ipcRenderer } from "electron";

const api = {
  createProject: (name: string, requirement: string) =>
    ipcRenderer.invoke("projects:create", name, requirement),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  openWorkspace: (projectId: string) =>
    ipcRenderer.invoke("projects:open-workspace", projectId),
  deleteProject: (projectId: string) => ipcRenderer.invoke("projects:delete", projectId),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  getKeysStatus: (envVars: string[]) => ipcRenderer.invoke("keys:status", envVars),
  getKeySecurity: () => ipcRenderer.invoke("keys:security"),
  saveKeys: (entries: Array<{ envVar: string; value: string }>) =>
    ipcRenderer.invoke("keys:save", entries),
  testLlm: () => ipcRenderer.invoke("llm:test"),
  runPlanning: (projectId: string) => ipcRenderer.invoke("orchestration:planning", projectId),
  updatePrd: (projectId: string, prd: unknown) =>
    ipcRenderer.invoke("orchestration:update-prd", projectId, prd),
  startOrchestration: (projectId: string) =>
    ipcRenderer.invoke("orchestration:start", projectId),
  cancel: () => ipcRenderer.invoke("orchestration:cancel"),
  pause: () => ipcRenderer.invoke("orchestration:pause"),
  resume: () => ipcRenderer.invoke("orchestration:resume"),
  resolveEscalation: (taskId: string, action: "skip" | "redispatch" | "abort") =>
    ipcRenderer.invoke("orchestration:escalation-decide", taskId, action),
  setTaskNote: (taskId: string, note: string) =>
    ipcRenderer.invoke("orchestration:task-note", taskId, note),
  resolveApproval: (requestId: string, granted: boolean) =>
    ipcRenderer.invoke("orchestration:approval-decide", requestId, granted),
  // ── Agent pool (P2) ──
  listAgents: () => ipcRenderer.invoke("agents:list"),
  exampleManifest: () => ipcRenderer.invoke("agents:example-manifest"),
  // ── 执行器自动探测（C6：扫 PATH 出候选，带可直接注册的 manifest）──
  detectClis: () => ipcRenderer.invoke("agents:detect"),
  registerAgent: (manifest: unknown) => ipcRenderer.invoke("agents:register", manifest),
  unregisterAgent: (id: string, graceMs?: number) =>
    ipcRenderer.invoke("agents:unregister", id, graceMs),
  toggleAgent: (id: string, enabled: boolean) => ipcRenderer.invoke("agents:toggle", id, enabled),
  probeAgents: (id?: string) => ipcRenderer.invoke("agents:probe", id),
  getAgentStats: () => ipcRenderer.invoke("agents:stats"),
  recentAudit: (limit?: number) => ipcRenderer.invoke("audit:recent", limit),
  listChanges: (projectId?: string) => ipcRenderer.invoke("changes:list", projectId),
  // ── 批次 diff 与单文件回滚（竞品缺口 B1 第二半）──
  // 只有带 archiveId 的批次有存档可 diff / 可回滚；界面据此决定按钮显隐。
  fileDiff: (batchId: string, path: string) =>
    ipcRenderer.invoke("changes:file", { batchId, path }),
  revertFile: (batchId: string, path: string) =>
    ipcRenderer.invoke("changes:revert", { batchId, path }),
  taskTrail: (taskId: string) => ipcRenderer.invoke("audit:trail", taskId),
  // ── 交付成果面：本次产物清单 + 怎么验收（B1 最后一米）──
  deliveryGuide: (projectId?: string) => ipcRenderer.invoke("delivery:guide", projectId),
  readDeliveryFile: (projectId: string, path: string) =>
    ipcRenderer.invoke("delivery:read", projectId, path),
  // ── 保活预览（item 2）：探活成功的 dev server 由主进程持有 ──
  previewStatus: () => ipcRenderer.invoke("preview:status"),
  previewOpen: () => ipcRenderer.invoke("preview:open"),
  previewStop: () => ipcRenderer.invoke("preview:stop"),
  auditFiles: () => ipcRenderer.invoke("audit:files"),
  exportAudit: () => ipcRenderer.invoke("audit:export"),
  boardRecovery: () => ipcRenderer.invoke("board:recovery"),
  // ── GitHub 只读（摄入半边：从 issue 建任务的选择器供数）──
  listGithubIssues: (input: { repo?: string; search?: string; limit?: number }) =>
    ipcRenderer.invoke("github:list-issues", input),
  // ── 交付凭据复核（欠账 #7）──
  // 默认只查指纹 + 列出可复跑命令；`replay: true` 才真的执行（与 CLI 默认模式
  // "没复跑就不等于结论为真"同一条纪律，界面不能替用户默认勾选）。
  verifyReceipt: (projectId: string, replay?: boolean) =>
    ipcRenderer.invoke("receipt:verify", projectId, replay ? { replay: true } : undefined),
  // ── 交互式会话（对标 Codex TUI 那一层）──
  // 会话在后台跑、过程由 ox:event 逐条推，所以 send 立刻返回 sessionId。
  sendChat: (input: { text: string; projectId: string }) =>
    ipcRenderer.invoke("chat:send", input),
  abortChat: () => ipcRenderer.invoke("chat:abort"),
  newChat: (input: { projectId: string }) => ipcRenderer.invoke("chat:new", input),
  chatTranscript: () => ipcRenderer.invoke("chat:transcript"),
  /** 有活会话就返回，否则恢复该项目最近一条记录；没有记录返回 null。 */
  chatLatest: (input: { projectId: string }) => ipcRenderer.invoke("chat:latest", input),
  listChatSessions: (input: { projectId: string }) => ipcRenderer.invoke("chat:list", input),
  loadChatSession: (input: { sessionId: string }) => ipcRenderer.invoke("chat:load", input),
  resumeChat: (input: { projectId: string; sessionId: string }) => ipcRenderer.invoke("chat:resume", input),
  forkChat: (input: { projectId: string; sessionId: string }) => ipcRenderer.invoke("chat:fork", input),
  deleteChat: (input: { sessionId: string }) => ipcRenderer.invoke("chat:delete", input),
  revertChat: (input: { projectId: string; sessionId: string; turn: number; path?: string }) =>
    ipcRenderer.invoke("chat:revert", input),
  /**
   * 审批三选一：允许一次 / 本次会话不再问 / 拒绝并说明理由。
   * 理由会回灌给模型（不给理由它只会原样重试同一个动作）。
   */
  resolveChatApproval: (
    requestId: string,
    answer: { granted: boolean; scope?: "once" | "session"; reason?: string },
  ) => ipcRenderer.invoke("chat:approval-decide", requestId, answer),
  onEvent: (handler: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on("ox:event", listener);
    return () => ipcRenderer.removeListener("ox:event", listener);
  },
};

contextBridge.exposeInMainWorld("oxCommander", api);

export type OxCommanderApi = typeof api;
