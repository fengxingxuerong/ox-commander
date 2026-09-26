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
  // ── Agent pool (P2) ──
  listAgents: () => ipcRenderer.invoke("agents:list"),
  exampleManifest: () => ipcRenderer.invoke("agents:example-manifest"),
  registerAgent: (manifest: unknown) => ipcRenderer.invoke("agents:register", manifest),
  unregisterAgent: (id: string, graceMs?: number) =>
    ipcRenderer.invoke("agents:unregister", id, graceMs),
  toggleAgent: (id: string, enabled: boolean) => ipcRenderer.invoke("agents:toggle", id, enabled),
  probeAgents: (id?: string) => ipcRenderer.invoke("agents:probe", id),
  getAgentStats: () => ipcRenderer.invoke("agents:stats"),
  recentAudit: (limit?: number) => ipcRenderer.invoke("audit:recent", limit),
  auditFiles: () => ipcRenderer.invoke("audit:files"),
  exportAudit: () => ipcRenderer.invoke("audit:export"),
  onEvent: (handler: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on("ox:event", listener);
    return () => ipcRenderer.removeListener("ox:event", listener);
  },
};

contextBridge.exposeInMainWorld("oxCommander", api);

export type OxCommanderApi = typeof api;
