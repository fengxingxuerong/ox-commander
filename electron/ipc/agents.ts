/**
 * Agent pool: listing, manifest example, runtime register/unregister, enable/
 * toggle and probe. Plus the observability channels (breaker stats + audit).
 *
 * Registration only — all state lives in `./context`.
 */
import { dialog, ipcMain } from "electron";
import path from "node:path";
import {
  buildAdaptersFromManifests,
  removeManifestFile,
  saveManifestFile,
} from "../agents/manifest-loader";
import { exampleManifest, parseAgentManifest } from "../agents/manifest-schema";
import type { AgentDescriptor } from "../../shared/agent-contract";
import {
  agentDir,
  dynamicAgentMap,
  ensureAgentLayer,
  ensureAudit,
  promptDir,
  settingsStore,
} from "./context";

/** Serializable view of a registry entry for the renderer (never leaks credentials). */
function describeAgent(d: AgentDescriptor) {
  return {
    id: d.manifest.id,
    displayName: d.manifest.displayName,
    adapter: d.manifest.adapter,
    source: d.manifest.source ?? "builtin",
    enabled: d.enabled,
    inferredLegacy: d.inferredLegacy,
    priority: d.priority,
    capabilities: d.capabilities,
    limits: d.limits,
    credentialKind: d.manifest.credential?.kind ?? "none",
  };
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agents:list", () => {
    const layer = ensureAgentLayer(settingsStore().load());
    return {
      agents: layer.registry.list().map(describeAgent),
      manifestDir: agentDir(),
      manifestErrors: layer.manifestErrors,
      skippedManifests: layer.skippedManifests,
    };
  });

  ipcMain.handle("agents:example-manifest", () => exampleManifest());

  ipcMain.handle("agents:register", (_e, raw: unknown) => {
    const settings = settingsStore().load();
    const manifest = parseAgentManifest(raw); // throws ManifestValidationError with all issues
    const layer = ensureAgentLayer(settings);
    const dynamic = dynamicAgentMap();
    if (layer.registry.has(manifest.id) && !dynamic.has(manifest.id)) {
      return {
        ok: false,
        error: `agent id "${manifest.id}" 已被内置或 agents.d 声明占用（内置适配器优先）`,
      };
    }
    const built = buildAdaptersFromManifests([manifest], { promptDir: promptDir() });
    if (built.adapters.length === 0) {
      return { ok: false, error: built.skipped[0]?.reason ?? "无法从该 manifest 构建适配器" };
    }
    const adapter = built.adapters[0]!;
    const res = layer.registry.register({ adapter, manifest });
    if (!res.ok) return res;
    dynamic.set(manifest.id, { adapter, manifest });
    // 写回 agents.d：注册只进内存的话，重启（或崩溃）就没了。
    // 落盘失败**不**回滚注册 —— 这一轮的 agent 确实能用，但必须如实报上去，
    // 否则用户以为"记住了"，下次开机才发现没了。
    const saved = saveManifestFile(agentDir(), manifest);
    ensureAudit().append({
      phase: "agent-change",
      agentId: manifest.id,
      detail: `register（${manifest.adapter}）${res.replaced ? "覆盖原注册" : ""}${
        saved.ok ? "已落盘" : `落盘失败：${saved.reason ?? "未知原因"}`
      }`,
    });
    return {
      ok: true,
      id: manifest.id,
      replaced: res.replaced,
      persisted: saved.ok ? { ok: true, path: saved.path! } : { ok: false, reason: saved.reason },
    };
  });

  ipcMain.handle("agents:unregister", async (_e, id: string, graceMs?: number) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const res = await layer.registry.unregister(id, graceMs !== undefined ? { graceMs } : {});
    if (res.ok) {
      const registered = dynamicAgentMap().get(id);
      dynamicAgentMap().delete(id);
      // 顺手删掉当初写下的那份文件，否则"注销"只在本轮生效、重启它又回来了。
      // 找不到当初的 manifest（比如是内置/agents.d 加载的）就只改内存。
      const removed = registered
        ? removeManifestFile(agentDir(), registered.manifest)
        : { ok: true as const, removed: false };
      ensureAudit().append({
        phase: "agent-change",
        agentId: id,
        detail: `unregister（drain: ${res.drained}）${
          removed.removed ? "已删除 agents.d 中的文件" : removed.reason ? `（${removed.reason}）` : ""
        }`,
      });
      return { ...res, persisted: removed };
    }
    return res;
  });

  ipcMain.handle("agents:toggle", (_e, id: string, enabled: boolean) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const ok = layer.registry.setEnabled(id, enabled);
    if (ok) ensureAudit().append({ phase: "agent-change", agentId: id, detail: enabled ? "enabled" : "disabled" });
    return ok;
  });

  ipcMain.handle("agents:probe", async (_e, id?: string) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const targets = id
      ? [layer.registry.get(id)].filter((d): d is NonNullable<typeof d> => d !== undefined)
      : layer.registry.list();
    const results: Record<string, boolean> = {};
    await Promise.all(
      targets.map(async (d) => {
        results[d.manifest.id] = await d.adapter.probe().catch(() => false);
      }),
    );
    return results;
  });
}

export function registerObservabilityHandlers(): void {
  ipcMain.handle("agents:stats", () => {
    const layer = ensureAgentLayer(settingsStore().load());
    return { circuits: layer.breaker.snapshot() };
  });

  /** Recent audit records, newest last. */
  ipcMain.handle("audit:recent", (_e, limit?: number) => {
    return ensureAudit().read({ limit: Math.max(1, Math.min(limit ?? 100, 1000)) });
  });

  ipcMain.handle("audit:files", () => ensureAudit().files().map((f) => path.basename(f)));

  /**
   * Export the whole audit history to a file the user picks in a save dialog.
   *
   * The renderer never names a path: the dialog *is* the authorization, so no
   * path whitelist is needed here. Outcomes are reported as data (ok/reason)
   * instead of throwing, because "canceled" is not an error and the operator
   * must be able to tell it apart from "nothing exported".
   */
  ipcMain.handle("audit:export", async () => {
    const files = ensureAudit().files();
    if (files.length === 0) return { ok: false as const, reason: "empty" };
    const picked = await dialog.showSaveDialog({
      title: "导出审计日志（JSONL）",
      defaultPath: `ox-audit-export-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false as const, reason: "canceled" };
    try {
      const saved = ensureAudit().exportTo(picked.filePath);
      ensureAudit().append({ phase: "settings", detail: `审计日志已导出到 ${saved}` });
      return { ok: true as const, path: saved };
    } catch (err) {
      return { ok: false as const, reason: (err as Error).message };
    }
  });
}
