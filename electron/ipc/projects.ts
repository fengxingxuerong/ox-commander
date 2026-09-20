/**
 * Project lifecycle, settings, key store and the one-shot LLM connectivity test.
 *
 * Registration only — all state lives in `./context`.
 */
import { ipcMain, shell } from "electron";
import fs from "node:fs";
import { HttpLlmError } from "../../shared/http-clients";
import type { ProjectSettings } from "../../shared/types";
import { buildLlm, keysStore, settingsStore, stores, workspaceRoot } from "./context";

export function registerProjectHandlers(): void {
  ipcMain.handle("projects:create", (_e, name: string, requirement: string) => {
    return stores().create(name, requirement);
  });

  ipcMain.handle("projects:list", () => stores().list());

  ipcMain.handle("projects:open-workspace", (_e, projectId: string) => {
    if (!stores().get(projectId)) throw new Error(`project ${projectId} not found`);
    const root = workspaceRoot(projectId);
    if (!fs.existsSync(root)) throw new Error(`workspace not created yet for ${projectId}`);
    return shell.showItemInFolder(root);
  });

  ipcMain.handle("projects:delete", async (_e, projectId: string) => {
    const rec = stores().get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (rec.stage === "DEVELOPMENT" || rec.stage === "VERIFICATION") {
      throw new Error("项目正在运行中，请先取消再删除");
    }
    const removed = stores().remove(projectId);
    if (removed) {
      const root = workspaceRoot(projectId);
      if (fs.existsSync(root)) await shell.trashItem(root);
    }
    return removed;
  });
}

export function registerSettingsHandlers(): void {
  ipcMain.handle("settings:get", () => settingsStore().load());

  ipcMain.handle("settings:save", (_e, settings: unknown) => {
    settingsStore().save(settings as ProjectSettings);
    return true;
  });

  ipcMain.handle("keys:status", (_e, envVars: string[]) => keysStore().status(envVars));

  /** Whether values are encrypted at rest, and how many are still plaintext. */
  ipcMain.handle("keys:security", () => ({
    encryptedAtRest: keysStore().isEncryptedAtRest(),
    plaintextCount: keysStore().plaintextCount(),
  }));

  ipcMain.handle("keys:save", (_e, entries: Array<{ envVar: string; value: string }>) => {
    let savedCount = 0;
    for (const { envVar, value } of entries) {
      if (keysStore().set(envVar, value)) savedCount++;
    }
    return savedCount;
  });

  ipcMain.handle("llm:test", async () => {
    try {
      const llm = buildLlm(settingsStore().load());
      const res = await llm.chat({
        messages: [{ role: "user", content: 'Reply with exactly the word: pong' }],
        temperature: 0,
      });
      return { ok: true as const, model: res.model };
    } catch (err) {
      const status = err instanceof HttpLlmError ? err.status : undefined;
      return { ok: false as const, error: `${(err as Error).message}`, status };
    }
  });
}
