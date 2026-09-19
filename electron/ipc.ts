import { app, ipcMain, safeStorage, shell, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { OrchestratorEngine, Scheduler, verifyProject, ZoneGuard } from "./engine";
import { agentRoutingLogLine, createAgentLayer, type AgentLayer } from "./agents";
import { buildAdaptersFromManifests } from "./agents/manifest-loader";
import { exampleManifest, parseAgentManifest } from "./agents/manifest-schema";
import { AuditLog } from "./audit-log";
import type { AgentAdapter } from "../shared/types";
import type { AgentDescriptor, AgentManifest } from "../shared/agent-contract";
import { ProjectStore, SettingsStore } from "./store";
import { KeysStore, createSafeStorageCrypto } from "./keys-store";
import { getProvider, providerKeyEnvVars } from "../shared/providers";
import { buildLlmClient, buildLlmPool } from "../shared/build-llm";
import { HttpLlmError } from "../shared/http-clients";
import type { EscalationAction, PrdDocument, ProjectSettings, Task } from "../shared/types";

let store: ProjectStore | null = null;
let settingsStore: SettingsStore | null = null;
let keysStore: KeysStore | null = null;
/** One engine per project, so switching projects never crosses wires. */
const engines = new Map<string, OrchestratorEngine>();
let currentWindow: BrowserWindow | null = null;
/** ProjectId of the engine currently inside execute(); guards re-entry. */
let runningProjectId: string | null = null;
/** Pending user decisions for escalated tasks: taskId -> resolver. */
const pendingEscalations = new Map<string, (action: EscalationAction) => void>();

/**
 * The agent pool is a long-lived singleton: agents registered at runtime must
 * survive engine rebuilds, and the Scheduler reads the pool on every batch.
 */
let agentLayer: AgentLayer | null = null;
/** Runtime-registered agents, re-applied whenever the layer is rebuilt. */
const dynamicAgents = new Map<string, { adapter: AgentAdapter; manifest: AgentManifest }>();
/** Signature of the settings the live layer was built with. */
let layerSignature: string | null = null;

function agentDir(): string {
  return path.join(app.getPath("userData"), "agents.d");
}

function promptDir(): string {
  return path.join(app.getPath("userData"), "runs");
}

function snapshotRoot(): string {
  return path.join(app.getPath("userData"), "snapshots");
}

let audit: AuditLog | null = null;

/** Append-only run audit under userData/audit (survives reloads and restarts). */
function ensureAudit(): AuditLog {
  if (!audit) audit = new AuditLog({ dir: path.join(app.getPath("userData"), "audit") });
  return audit;
}

function ensureAgentLayer(settings: ProjectSettings): AgentLayer {
  const signature = `router=${settings.agentRouter !== false};arbitration=${settings.arbitration}`;
  if (agentLayer && layerSignature === signature) return agentLayer;
  const log = (text: string): void => {
    currentWindow?.webContents.send("ox:event", { type: "log", text });
  };
  agentLayer = createAgentLayer({
    enableRouter: settings.agentRouter !== false,
    manifestDir: agentDir(),
    promptDir: promptDir(),
    snapshotRoot: snapshotRoot(),
    arbitration: settings.arbitration,
    onRouting: (decision, task) => log(agentRoutingLogLine(decision, task)),
    onEvent: (text) => log(`[sandbox] ${text}`),
    breakerOptions: { onEvent: (text) => log(`[breaker] ${text}`) },
  });
  for (const { adapter, manifest } of dynamicAgents.values()) {
    agentLayer.registry.register({ adapter, manifest });
  }
  layerSignature = signature;
  return agentLayer;
}

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

function ensureStores(): void {
  if (!store) {
    store = new ProjectStore(path.join(app.getPath("userData"), "data"));
  }
  if (!settingsStore) {
    settingsStore = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  }
  if (!keysStore) {
    keysStore = new KeysStore(
      path.join(app.getPath("userData"), "keys.json"),
      // OS keychain (DPAPI / Keychain / libsecret) when the platform has one;
      // the store falls back to plaintext and reports that state to the UI.
      createSafeStorageCrypto(safeStorage),
    );
  }
}

function buildLlm(settings: ProjectSettings) {
  const pool = settings.llmPool ?? [];
  // Seed every pooled provider's keys from the store before building, so a
  // provider with no key in the environment still participates when the
  // operator saved one in the settings screen.
  const envVars = new Set<string>();
  for (const id of pool.length > 0 ? pool : [settings.llmProvider]) {
    const provider = getProvider(id);
    for (const v of providerKeyEnvVars(id)) envVars.add(v);
    if (provider.apiKeyEnvVar) envVars.add(provider.apiKeyEnvVar);
  }
  for (const v of envVars) {
    if (!process.env[v]) process.env[v] = keysStore!.get(v);
  }
  // A pool of one behaves exactly like the old single-provider client.
  return pool.length > 0 ? buildLlmPool({ providers: pool }) : buildLlmClient(settings.llmProvider);
}

const WORKSPACE_SCRIPTS = {
  "build.js": [
    "const { execFileSync } = require('node:child_process');",
    "let failed = 0;",
    "for (const f of require('node:fs').readdirSync('src')) {",
    "  if (!f.endsWith('.js')) continue;",
    "  try { new (require('node:vm').Script)(require('node:fs').readFileSync(`src/${f}`, 'utf8'), { filename: f }); } catch (e) { console.error(`${f}: ${e.message}`); failed++; }",
    "}",
    "if (failed) process.exit(1);",
    "console.log('syntax check passed');",
  ].join("\n"),
  "test.js": [
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const files = fs.existsSync('tests') ? fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')) : [];",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, `tests/${f}`], { stdio: 'inherit' });",
    "  if (r.status !== 0) process.exit(r.status ?? 1);",
    "}",
  ].join("\n"),
} as const;

function ensureWorkspace(projectId: string): string {
  const root = path.join(app.getPath("userData"), "workspaces", projectId);
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ["src", "tests"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const pkg = path.join(root, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: `ox-${projectId}`,
          version: "0.0.0",
          private: true,
          scripts: {
            build: "node ox-scripts/build.js",
            typecheck: "node ox-scripts/build.js",
            test: "node ox-scripts/test.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    const file = path.join(root, "ox-scripts", name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }
  return root;
}

/**
 * Builds a fresh engine bound to one project and records it as the project's
 * live engine (for cancel/pause/resume). Always rebuilt from current settings,
 * so settings changes take effect on the next planning/start; re-entry while
 * running is blocked by runningProjectId checks in the handlers.
 */
function buildEngine(projectId: string): OrchestratorEngine {
  const s1 = store!;
  const settings = settingsStore!.load();
  // Capability routing (P1) + pluggable agents (P2): the pool is a singleton so
  // runtime registration survives engine rebuilds. The pool stays on legacy
  // round-robin whenever no agent declares capabilities, so enabling routing
  // cannot regress a single-agent setup.
  const layer = ensureAgentLayer(settings);
  const audit = ensureAudit();
  const engine = new OrchestratorEngine(
    {
      llm: buildLlm(settings),
      scheduler: new Scheduler(layer.adapters, settings.enabledAgents, new ZoneGuard(), {
        ...layer.schedulerOptions,
        maxParallelRuns: settings.maxParallelRuns,
        // P5 observability: every run start/end is attributed and persisted, so
        // "which agent did what" survives a reload.
        onRunStart: (agentId, task) => {
          audit.append({ phase: "run-start", agentId, taskId: task.id, zone: task.zone });
        },
        onRunComplete: (outcome, task) => {
          audit.append({
            phase: "run-end",
            taskId: task.id,
            zone: task.zone,
            ok: outcome.ok,
            ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
            ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
            ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
            detail: outcome.logDigest.slice(0, 300),
          });
        },
      }),
      verify: (cwd: string) =>
        verifyProject(settings.verificationCommands, {
          cwd: () => cwd,
          onEvent: (text) => currentWindow?.webContents.send("ox:event", { type: "log", text }),
        }),
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
      onTaskOutcome: (taskId, ok, logDigest, meta) =>
        currentWindow?.webContents.send("ox:event", {
          type: "taskOutcome",
          taskId,
          ok,
          logDigest: logDigest.slice(0, 2000),
          ...(meta ?? {}),
        }),
      onVerification: (report) =>
        currentWindow?.webContents.send("ox:event", { type: "verification", report }),
      onEscalation: (taskId, summary) =>
        currentWindow?.webContents.send("ox:event", { type: "escalation", taskId, summary }),
      requestEscalationDecision: (taskId) =>
        new Promise<EscalationAction>((resolve) => {
          // The escalation event itself is already sent by onEscalation; here
          // we only park the resolver until the renderer answers.
          pendingEscalations.set(taskId, resolve);
        }),
    },
  );
  engines.set(projectId, engine);
  return engine;
}

export function registerIpc(): void {
  ensureStores();
  const s1 = store!;
  const s2 = settingsStore!;

  ipcMain.handle("projects:create", (_e, name: string, requirement: string) => {
    return s1.create(name, requirement);
  });

  ipcMain.handle("projects:list", () => s1.list());

  ipcMain.handle("projects:open-workspace", (_e, projectId: string) => {
    if (!s1.get(projectId)) throw new Error(`project ${projectId} not found`);
    const root = path.join(app.getPath("userData"), "workspaces", projectId);
    if (!fs.existsSync(root)) throw new Error(`workspace not created yet for ${projectId}`);
    return shell.showItemInFolder(root);
  });

  ipcMain.handle("projects:delete", async (_e, projectId: string) => {
    const rec = s1.get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (rec.stage === "DEVELOPMENT" || rec.stage === "VERIFICATION") {
      throw new Error("项目正在运行中，请先取消再删除");
    }
    const removed = s1.remove(projectId);
    if (removed) {
      const root = path.join(app.getPath("userData"), "workspaces", projectId);
      if (fs.existsSync(root)) await shell.trashItem(root);
    }
    return removed;
  });

  ipcMain.handle("settings:get", () => s2.load());

  ipcMain.handle("settings:save", (_e, settings: unknown) => {
    s2.save(settings as ProjectSettings);
    return true;
  });

  ipcMain.handle("keys:status", (_e, envVars: string[]) => keysStore!.status(envVars));

  /** Whether values are encrypted at rest, and how many are still plaintext. */
  ipcMain.handle("keys:security", () => ({
    encryptedAtRest: keysStore!.isEncryptedAtRest(),
    plaintextCount: keysStore!.plaintextCount(),
  }));

  ipcMain.handle("keys:save", (_e, entries: Array<{ envVar: string; value: string }>) => {
    let savedCount = 0;
    for (const { envVar, value } of entries) {
      if (keysStore!.set(envVar, value)) savedCount++;
    }
    return savedCount;
  });

  ipcMain.handle("llm:test", async () => {
    try {
      const llm = buildLlm(s2.load());
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

  ipcMain.handle(
    "orchestration:planning",
    async (_e, projectId: string) => {
      const rec = s1.get(projectId);
      if (!rec) throw new Error(`project ${projectId} not found`);
      if (runningProjectId === projectId) throw new Error("项目正在执行中，请先取消再重新规划");
      const engine = buildEngine(projectId);
      const prd = await engine.generatePrd(rec.requirement);
      s1.update(projectId, { prdJson: JSON.stringify(prd), stage: "PLANNING" });
      currentWindow?.webContents.send("ox:event", { type: "stage", stage: "PLANNING" });
      const batches = await engine.decompose(prd);
      s1.update(projectId, { batchesJson: JSON.stringify(batches) });
      return { prd, batches };
    },
  );

  ipcMain.handle(
    "orchestration:update-prd",
    async (_e, projectId: string, prd: PrdDocument) => {
      const rec = s1.get(projectId);
      if (!rec) throw new Error(`project ${projectId} not found`);
      if (runningProjectId === projectId) throw new Error("项目正在执行中，请先取消再修改 PRD");
      s1.update(projectId, { prdJson: JSON.stringify(prd), batchesJson: undefined });
      const engine = buildEngine(projectId);
      const batches = await engine.decompose(prd);
      s1.update(projectId, { batchesJson: JSON.stringify(batches) });
      return { prd, batches };
    },
  );

  ipcMain.handle(
    "orchestration:start",
    async (_e, projectId: string) => {
      if (runningProjectId) throw new Error(`项目 ${runningProjectId} 正在执行中，无法同时启动`);
      const rec = store!.get(projectId);
      if (!rec?.batchesJson) throw new Error(`no plan for project ${projectId}`);
      const engine = buildEngine(projectId);
      runningProjectId = projectId;
      try {
        await engine.execute(JSON.parse(rec.batchesJson) as Task[][], ensureWorkspace(projectId));
      } finally {
        runningProjectId = null;
      }
    },
  );

  ipcMain.handle("orchestration:cancel", () => {
    for (const e of engines.values()) e.cancel();
    // Unblock any escalation wait so execute() can observe the cancel.
    for (const resolve of pendingEscalations.values()) resolve("abort");
    pendingEscalations.clear();
  });
  ipcMain.handle("orchestration:pause", () => {
    for (const e of engines.values()) e.pause();
  });
  ipcMain.handle("orchestration:resume", () => {
    for (const e of engines.values()) e.resume();
  });
  ipcMain.handle(
    "orchestration:escalation-decide",
    (_e, taskId: string, action: EscalationAction) => {
      const resolve = pendingEscalations.get(taskId);
      if (!resolve) throw new Error(`没有等待决策的任务：${taskId}`);
      pendingEscalations.delete(taskId);
      resolve(action);
      return true;
    },
  );

  // ── Agent pool (P2) ────────────────────────────────────────────────────────
  ipcMain.handle("agents:list", () => {
    const layer = ensureAgentLayer(s2.load());
    return {
      agents: layer.registry.list().map(describeAgent),
      manifestDir: agentDir(),
      manifestErrors: layer.manifestErrors,
      skippedManifests: layer.skippedManifests,
    };
  });

  ipcMain.handle("agents:example-manifest", () => exampleManifest());

  ipcMain.handle("agents:register", (_e, raw: unknown) => {
    const settings = s2.load();
    const manifest = parseAgentManifest(raw); // throws ManifestValidationError with all issues
    const layer = ensureAgentLayer(settings);
    if (layer.registry.has(manifest.id) && !dynamicAgents.has(manifest.id)) {
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
    dynamicAgents.set(manifest.id, { adapter, manifest });
    ensureAudit().append({
      phase: "agent-change",
      agentId: manifest.id,
      detail: `register（${manifest.adapter}）${res.replaced ? "覆盖原注册" : ""}`,
    });
    return { ok: true, id: manifest.id, replaced: res.replaced };
  });

  ipcMain.handle("agents:unregister", async (_e, id: string, graceMs?: number) => {
    const layer = ensureAgentLayer(s2.load());
    const res = await layer.registry.unregister(id, graceMs !== undefined ? { graceMs } : {});
    if (res.ok) {
      dynamicAgents.delete(id);
      ensureAudit().append({ phase: "agent-change", agentId: id, detail: `unregister（drain: ${res.drained}）` });
    }
    return res;
  });

  ipcMain.handle("agents:toggle", (_e, id: string, enabled: boolean) => {
    const layer = ensureAgentLayer(s2.load());
    const ok = layer.registry.setEnabled(id, enabled);
    if (ok) ensureAudit().append({ phase: "agent-change", agentId: id, detail: enabled ? "enabled" : "disabled" });
    return ok;
  });

  ipcMain.handle("agents:probe", async (_e, id?: string) => {
    const layer = ensureAgentLayer(s2.load());
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

  // ── Observability (P5) ─────────────────────────────────────────────────────
  ipcMain.handle("agents:stats", () => {
    const layer = ensureAgentLayer(s2.load());
    return { circuits: layer.breaker.snapshot() };
  });

  /** Recent audit records, newest last. */
  ipcMain.handle("audit:recent", (_e, limit?: number) => {
    return ensureAudit().read({ limit: Math.max(1, Math.min(limit ?? 100, 1000)) });
  });

  ipcMain.handle("audit:files", () => ensureAudit().files().map((f) => path.basename(f)));
}

export function attachWindow(win: BrowserWindow): void {
  currentWindow = win;
}
