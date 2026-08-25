import { contextBridge, ipcRenderer } from "electron";

const api = {
  createProject: (name: string, requirement: string) =>
    ipcRenderer.invoke("projects:create", name, requirement),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  startOrchestration: (projectId: string, projectRoot: string) =>
    ipcRenderer.invoke("orchestration:start", projectId, projectRoot),
  cancel: () => ipcRenderer.invoke("orchestration:cancel"),
  pause: () => ipcRenderer.invoke("orchestration:pause"),
  resume: () => ipcRenderer.invoke("orchestration:resume"),
  onEvent: (handler: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on("ox:event", listener);
    return () => ipcRenderer.removeListener("ox:event", listener);
  },
};

contextBridge.exposeInMainWorld("oxCommander", api);

export type OxCommanderApi = typeof api;
