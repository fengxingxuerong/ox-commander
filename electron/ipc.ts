import { app, ipcMain, BrowserWindow } from "electron";
import path from "node:path";
import { OrchestratorEngine, Scheduler, verifyProject } from "./engine";
import { createDefaultAdapters } from "./agents";
import { ProjectStore, SettingsStore } from "./store";
import { getProvider } from "../shared/providers";
import { createLlmClient } from "../shared/http-clients";

let store: ProjectStore | null = null;
let settingsStore: SettingsStore | null = null;
let engine: OrchestratorEngine | null = null;
let currentWindow: BrowserWindow | null = null;

function ensureStores(): void {
  if (!store) {
    store = new ProjectStore(path.join(app.getPath("userData"), "data"));
  }
  if (!settingsStore) {
    settingsStore = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  }
}

export function registerIpc(): void {
  ensureStores();
  const s1 = store!;
  const s2 = settingsStore!;

  ipcMain.handle("projects:create", (_e, name: string, requirement: string) => {
    return s1.create(name, requirement);
  });

  ipcMain.handle("projects:list", () => s1.list());

  ipcMain.handle("settings:get", () => s2.load());

  ipcMain.handle(
    "orchestration:start",
    async (_e, projectId: string, projectRoot: string) => {
      const s1 = store!;
      const s2 = settingsStore!;
      const rec = s1.get(projectId);
      if (!rec) throw new Error(`project ${projectId} not found`);
      const settings = s2.load();
      const provider = getProvider(settings.llmProvider);
      const apiKey = provider.apiKeyEnvVar ? (process.env[provider.apiKeyEnvVar] ?? "") : "";
      const llm = createLlmClient(provider, apiKey);
      const adapters = createDefaultAdapters();
      engine = new OrchestratorEngine(
        {
          llm,
          scheduler: new Scheduler(adapters),
          verify: (cwd: string) => verifyProject(settings.verificationCommands, { cwd: () => cwd }),
          settings,
        },
        {
          onStage: (stage) => {
            s1.update(projectId, { stage });
            currentWindow?.webContents.send("ox:event", { type: "stage", stage });
          },
          onLog: (text) => currentWindow?.webContents.send("ox:event", { type: "log", text }),
          onTaskStatus: (taskId, status, attempts) =>
            currentWindow?.webContents.send("ox:event", { type: "taskStatus", taskId, status, attempts }),
          onVerification: (report) =>
            currentWindow?.webContents.send("ox:event", { type: "verification", report }),
          onEscalation: (taskId, summary) =>
            currentWindow?.webContents.send("ox:event", { type: "escalation", taskId, summary }),
        },
      );
      const prd = await engine.generatePrd(rec.requirement);
      s1.update(projectId, { prdJson: JSON.stringify(prd) });
      const batches = await engine.decompose(prd);
      s1.update(projectId, { batchesJson: JSON.stringify(batches) });
      await engine.execute(batches, projectRoot);
    },
  );

  ipcMain.handle("orchestration:cancel", () => engine?.cancel());
  ipcMain.handle("orchestration:pause", () => engine?.pause());
  ipcMain.handle("orchestration:resume", () => engine?.resume());
}

export function attachWindow(win: BrowserWindow): void {
  currentWindow = win;
}
