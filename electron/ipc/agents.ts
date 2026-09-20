/**
 * Agent pool: listing, manifest example, runtime register/unregister, enable/
 * toggle and probe. Plus the observability channels (breaker stats + audit).
 *
 * Registration only — all state lives in `./context`.
 */
import { ipcMain } from "electron";
import path from "node:path";
import { buildAdaptersFromManifests } from "../agents/manifest-loader";
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
    ensureAudit().append({
      phase: "agent-change",
      agentId: manifest.id,
      detail: `register（${manifest.adapter}）${res.replaced ? "覆盖原注册" : ""}`,
    });
    return { ok: true, id: manifest.id, replaced: res.replaced };
  });

  ipcMain.handle("agents:unregister", async (_e, id: string, graceMs?: number) => {
    const layer = ensureAgentLayer(settingsStore().load());
    const res = await layer.registry.unregister(id, graceMs !== undefined ? { graceMs } : {});
    if (res.ok) {
      dynamicAgentMap().delete(id);
      ensureAudit().append({ phase: "agent-change", agentId: id, detail: `unregister（drain: ${res.drained}）` });
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
}
