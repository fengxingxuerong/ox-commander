/**
 * Project lifecycle, settings, key store and the one-shot LLM connectivity test.
 *
 * Registration only — all state lives in `./context`.
 */
import { ipcMain, shell } from "electron";
import fs from "node:fs";
import { parseSettings } from "../../shared/schema";
import { HttpLlmError } from "../../shared/http-clients";
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
    // 入参校验（2026-10-13）：以前 `as ProjectSettings` 直接落盘 = 控制面零校验，
    // 畸形类型会一路带进引擎。形状不过关就抛 SchemaValidationError（invoke 会把
    // 它带到渲染层的 settingsError 横幅），**不落盘**。
    settingsStore().save(parseSettings(settings));
    return true;
  });

  ipcMain.handle("keys:status", (_e, envVars: string[]) => keysStore().status(envVars));

  /** Whether values are encrypted at rest, and how many are still plaintext. */
  ipcMain.handle("keys:security", () => ({
    encryptedAtRest: keysStore().isEncryptedAtRest(),
    plaintextCount: keysStore().plaintextCount(),
  }));

  ipcMain.handle("keys:save", (_e, entries: unknown) => {
    if (!Array.isArray(entries)) {
      throw new Error("keys:save 需要一个数组：[{ envVar, value }]");
    }
    let savedCount = 0;
    for (const raw of entries) {
      const item = raw as { envVar?: unknown; value?: unknown } | null;
      if (!item || typeof item !== "object" || typeof item.envVar !== "string" || typeof item.value !== "string") {
        throw new Error("keys:save 的每项都需要 { envVar: string, value: string }");
      }
      const envVar = item.envVar;
      const value = item.value;
      if (!keysStore().set(envVar, value)) continue;
      savedCount++;
      // 账号热切换（P1-5）：保存动作是**最新的意图**，必须立刻反映到进程环境 ——
      // 否则 `KeysStore.get` 的 env-wins 语义会让 env 里残留的旧 key 一直遮蔽
      // store 里的新值：换 key 不重启就永远不生效（llm:test 与下一次 run 都
      // 还在用旧 key）。空值 = 清除，env 同步删掉，让"停用"也真的生效。
      const trimmed = value.trim();
      if (trimmed) process.env[envVar] = trimmed;
      else delete process.env[envVar];
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
