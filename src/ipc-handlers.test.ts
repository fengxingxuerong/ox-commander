import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { dialog } from "electron";

/**
 * Behavioural tests for the per-domain IPC handlers under `electron/ipc/*`.
 *
 * `src/ipc.test.ts` pins the *wiring* (which channels exist, symmetric with
 * preload). This file pins what each handler *does*: parameter guards, state
 * transitions, persistence calls and the redaction boundary — the logic that
 * used to hide inside the old 554-line `ipc.ts` and had no coverage after the
 * C1 split (the four handler modules sat at 12–22 % statement coverage).
 *
 * Strategy: register the real handlers against the fake `ipcMain`, then invoke
 * channels directly. Heavy collaborators (stores, agent layer, platform, audit)
 * are mocked with instances captured at construction so each test can
 * reprogramme return values; `context.ts` singletons are reset between tests.
 */

const h = vi.hoisted(() => ({
  ipcMain: undefined as unknown,
  projectInstances: [] as any[],
  settingsInstances: [] as any[],
  keysInstances: [] as any[],
  auditInstances: [] as any[],
  createPlatformCalls: [] as any[],
  layer: null as any,
  llmChat: null as any,
  builtAdapter: null as any,
  buildAdapters: null as any,
  createAgentLayerFn: null as any,
  writeFileAtomic: null as any,
  generatePrd: null as any,
  decompose: null as any,
  execute: null as any,
  cancelEngine: null as any,
  pauseEngine: null as any,
  resumeEngine: null as any,
}));

vi.mock("electron", async () => {
  const mod = await import("./__fakes__/electron");
  h.ipcMain = mod.ipcMain;
  return mod;
});

vi.mock("../electron/store", () => ({
  ProjectStore: class {
    create = vi.fn(() => ({ id: "p-new", stage: "PRD" }));
    list = vi.fn(() => []);
    get = vi.fn(() => undefined);
    update = vi.fn();
    remove = vi.fn(() => true);
    constructor() {
      h.projectInstances.push(this);
    }
  },
  SettingsStore: class {
    load = vi.fn(() => ({
      llmProvider: "sensenova",
      llmPool: [],
      agentRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 1,
      verificationCommands: ["node ox-scripts/test.js"],
    }));
    save = vi.fn();
    constructor() {
      h.settingsInstances.push(this);
    }
  },
}));

vi.mock("../electron/keys-store", () => ({
  KeysStore: class {
    status = vi.fn(() => []);
    isEncryptedAtRest = vi.fn(() => true);
    plaintextCount = vi.fn(() => 0);
    set = vi.fn(() => true);
    get = vi.fn(() => "");
    constructor() {
      h.keysInstances.push(this);
    }
  },
  createSafeStorageCrypto: vi.fn(() => ({})),
}));

vi.mock("../electron/audit-log", () => ({
  AuditLog: class {
    append = vi.fn();
    read = vi.fn(() => [{ phase: "run-start" }]);
    files = vi.fn(() => ["/x/audit-2026-09-22-001.jsonl"]);
    exportTo = vi.fn((p: string) => p);
    constructor() {
      h.auditInstances.push(this);
    }
  },
}));

// Pass-through by default; individual tests flip `mockImplementationOnce` to
// make the atomic write fail (writeJournal's best-effort contract).
vi.mock("../electron/atomic-file", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/atomic-file")>();
  h.writeFileAtomic = vi.fn((file: string, data: string) => mod.writeFileAtomic(file, data));
  return { ...mod, writeFileAtomic: h.writeFileAtomic };
});

vi.mock("../electron/agents", async (importOriginal) => {
  const layer = {
    registry: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      register: vi.fn(() => ({ ok: true, replaced: false })),
      unregister: vi.fn(async () => ({ ok: true, drained: 2 })),
      setEnabled: vi.fn(() => true),
    },
    breaker: { snapshot: vi.fn(() => ({ "a1": { state: "closed" } })) },
    manifestErrors: [],
    skippedManifests: [],
  };
  h.layer = layer;
  return {
    ...(await importOriginal<typeof import("../electron/agents")>()),
    createAgentLayer: (h.createAgentLayerFn = vi.fn(() => layer)),
  };
});

vi.mock("../electron/agents/manifest-loader", () => ({
  buildAdaptersFromManifests: (h.buildAdapters = vi.fn(() => ({
    adapters: [h.builtAdapter],
    skipped: [],
  }))),
}));

vi.mock("../electron/platform", () => ({
  createPlatform: vi.fn((config: any) => {
    h.createPlatformCalls.push(config);
    return {
      engine: {
        generatePrd: h.generatePrd,
        decompose: h.decompose,
        execute: h.execute,
        cancel: h.cancelEngine,
        pause: h.pauseEngine,
        resume: h.resumeEngine,
      },
      buildLlm: vi.fn(() => ({ chat: h.llmChat })),
    };
  }),
}));

h.llmChat = vi.fn();
h.generatePrd = vi.fn();
h.decompose = vi.fn();
h.execute = vi.fn();
h.cancelEngine = vi.fn();
h.pauseEngine = vi.fn();
h.resumeEngine = vi.fn();
h.builtAdapter = {
  meta: { id: "built", name: "built", kind: "api" },
  probe: vi.fn(async () => true),
  dispatch: vi.fn(),
  collect: vi.fn(),
  abort: vi.fn(),
};

import type { FakeIpcMain } from "./__fakes__/electron";
import { app, shell } from "electron";
import { attachWindow, buildEngine, registerIpc } from "../electron/ipc";
import {
  buildLlm,
  buildPlatformLayer,
  dynamicAgentMap,
  enginesOf,
  getRunningProjectId,
  seedKeysFromStore,
  setRunningProjectId,
  workspaceRoot,
  writeJournal,
} from "../electron/ipc/context";
import { exampleManifest } from "../electron/agents/manifest-schema";
import { HttpLlmError } from "../shared/http-clients";
import type { AgentCapabilities, AgentDescriptor } from "../shared/agent-contract";
import { DEFAULT_SETTINGS, type ProjectSettings, type Task } from "../shared/types";

function caps(partial: Partial<AgentCapabilities>): AgentCapabilities {
  return {
    roles: ["*"],
    zoneGlobs: ["**"],
    supports: ["read", "edit", "create", "run-test"],
    artifactKinds: ["files"],
    maxConcurrency: 1,
    selfIsolated: false,
    ...partial,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return { id: "t1", title: "t1", description: "", zone: "src/**", dependencies: [], suggestedRole: "dev", ...overrides };
}

function inst<T>(arr: T[]): T {
  expect(arr.length).toBeGreaterThan(0);
  return arr[arr.length - 1]!;
}

/** Latest engine built through buildPlatformLayer (i.e. via buildEngine). */
function lastPlatformConfig(): any {
  expect(h.createPlatformCalls.length).toBeGreaterThan(0);
  return h.createPlatformCalls[h.createPlatformCalls.length - 1];
}

let tmp = "";
let win: { webContents: { send: Mock } };

function resetRegistryMocks(): void {
  const layer = h.layer;
  layer.registry.list.mockReset().mockReturnValue([]);
  layer.registry.get.mockReset().mockReturnValue(undefined);
  layer.registry.has.mockReset().mockReturnValue(false);
  layer.registry.register.mockReset().mockReturnValue({ ok: true, replaced: false });
  layer.registry.unregister.mockReset().mockResolvedValue({ ok: true, drained: 2 });
  layer.registry.setEnabled.mockReset().mockReturnValue(true);
  layer.breaker.snapshot.mockReset().mockReturnValue({});
  layer.manifestErrors = [];
  layer.skippedManifests = [];
  h.buildAdapters.mockReset().mockReturnValue({ adapters: [h.builtAdapter], skipped: [] });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-ipc-handlers-"));
  (app.getPath as unknown as Mock).mockImplementation(() => tmp);
  win = { webContents: { send: vi.fn() } };
  attachWindow(win as never);

  const fake = h.ipcMain as FakeIpcMain;
  fake.handlers.clear();
  (shell.showItemInFolder as unknown as Mock).mockClear();
  (shell.trashItem as unknown as Mock).mockClear();
  registerIpc();

  // Context singletons survive across tests (module state); reset everything
  // the tests reprogramme so ordering can never matter.
  enginesOf().clear();
  dynamicAgentMap().clear();
  setRunningProjectId(null);
  h.createPlatformCalls.length = 0;
  h.writeFileAtomic.mockClear();
  resetRegistryMocks();
  for (const store of h.projectInstances) {
    (store.get as Mock).mockReset().mockReturnValue(undefined);
    (store.create as Mock).mockClear();
    (store.update as Mock).mockClear();
    (store.remove as Mock).mockReset().mockReturnValue(true);
    (store.list as Mock).mockReset().mockReturnValue([]);
  }
  for (const audit of h.auditInstances) {
    (audit.append as Mock).mockClear();
    (audit.read as Mock).mockReset().mockReturnValue([]);
    (audit.files as Mock).mockReset().mockReturnValue([]);
    (audit.exportTo as Mock).mockReset();
  }
  // 每个 handler 测试都自己 stub 对话框结果；默认回到「取消」，
  // 防止上一个测试的 stub 漏进下一个测试把文件写到盘上。
  (dialog.showSaveDialog as Mock).mockReset().mockResolvedValue({ canceled: true, filePath: undefined });
  for (const keys of h.keysInstances) {
    (keys.set as Mock).mockReset().mockReturnValue(true);
    (keys.status as Mock).mockReset().mockReturnValue([]);
    (keys.isEncryptedAtRest as Mock).mockReset().mockReturnValue(true);
    (keys.plaintextCount as Mock).mockReset().mockReturnValue(0);
  }
  h.generatePrd.mockReset();
  h.decompose.mockReset();
  h.execute.mockReset();
  h.cancelEngine.mockReset();
  h.pauseEngine.mockReset();
  h.resumeEngine.mockReset();
  h.llmChat.mockReset();
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // temp cleaner
  }
});

describe("project handlers", () => {
  it("creates a project through the store", () => {
    const store = inst(h.projectInstances);
    (store.create as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    const res = (h.ipcMain as FakeIpcMain).invoke("projects:create", "my app", "build a todo");
    expect(store.create).toHaveBeenCalledWith("my app", "build a todo");
    expect(res).toEqual({ id: "p1", stage: "PRD" });
  });

  it("refuses to open the workspace of an unknown project", () => {
    expect(() => (h.ipcMain as FakeIpcMain).invoke("projects:open-workspace", "ghost")).toThrow(
      /project ghost not found/,
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("opens an existing workspace in the file manager", () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    const root = workspaceRoot("p1");
    fs.mkdirSync(root, { recursive: true });
    (h.ipcMain as FakeIpcMain).invoke("projects:open-workspace", "p1");
    expect(shell.showItemInFolder).toHaveBeenCalledWith(root);
  });

  it("reports a missing workspace instead of opening nothing", () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    expect(() => (h.ipcMain as FakeIpcMain).invoke("projects:open-workspace", "p1")).toThrow(
      /workspace not created yet/,
    );
  });

  it("refuses to delete a project that is still running", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "DEVELOPMENT" });
    await expect((h.ipcMain as FakeIpcMain).invoke("projects:delete", "p1")).rejects.toThrow(
      /项目正在运行中，请先取消再删除/,
    );
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("deletes an idle project and trashes its workspace", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    const root = workspaceRoot("p1");
    fs.mkdirSync(root, { recursive: true });
    const res = await (h.ipcMain as FakeIpcMain).invoke("projects:delete", "p1");
    expect(res).toBe(true);
    expect(store.remove).toHaveBeenCalledWith("p1");
    expect(shell.trashItem).toHaveBeenCalledWith(root);
  });

  it("deletes without trashing when no workspace was ever created", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    await (h.ipcMain as FakeIpcMain).invoke("projects:delete", "p1");
    expect(store.remove).toHaveBeenCalledWith("p1");
    expect(shell.trashItem).not.toHaveBeenCalled();
  });
});

describe("settings & key handlers", () => {
  it("persists saved settings and echoes success", () => {
    const settings = inst(h.settingsInstances);
    const value = { llmProvider: "sensenova" };
    expect((h.ipcMain as FakeIpcMain).invoke("settings:save", value)).toBe(true);
    expect(settings.save).toHaveBeenCalledWith(value);
  });

  it("counts only the key entries the store accepted", () => {
    const keys = inst(h.keysInstances);
    (keys.set as Mock).mockImplementation((envVar: string) => envVar !== "BAD_NAME");
    const res = (h.ipcMain as FakeIpcMain).invoke("keys:save", [
      { envVar: "GOOD_1", value: "a" },
      { envVar: "BAD_NAME", value: "b" },
      { envVar: "GOOD_2", value: "c" },
    ]);
    expect(res).toBe(2);
    expect(keys.set).toHaveBeenCalledWith("BAD_NAME", "b");
  });

  it("reports key security posture for the settings screen", () => {
    const keys = inst(h.keysInstances);
    (keys.isEncryptedAtRest as Mock).mockReturnValue(false);
    (keys.plaintextCount as Mock).mockReturnValue(3);
    expect((h.ipcMain as FakeIpcMain).invoke("keys:security")).toEqual({
      encryptedAtRest: false,
      plaintextCount: 3,
    });
  });

  it("returns the model on a successful connectivity test", async () => {
    h.llmChat.mockResolvedValue({ content: "pong", provider: "sensenova", model: "deepseek-v4-flash" });
    const res = await (h.ipcMain as FakeIpcMain).invoke("llm:test");
    expect(res).toEqual({ ok: true, model: "deepseek-v4-flash" });
    expect(h.llmChat).toHaveBeenCalledTimes(1);
  });

  it("surfaces HTTP status on a failed connectivity test instead of throwing", async () => {
    h.llmChat.mockRejectedValue(new HttpLlmError(429, "rate limited"));
    const res = await (h.ipcMain as FakeIpcMain).invoke("llm:test");
    expect(res).toEqual({ ok: false, error: "LLM HTTP 429: rate limited", status: 429 });
  });
});

describe("agent handlers", () => {
  it("lists agents with renderer-safe defaults", () => {
    const layer = h.layer;
    (layer.registry.list as Mock).mockReturnValue([
      {
        manifest: { id: "a1", displayName: "One", adapter: "cli", capabilities: caps({}) },
        capabilities: caps({}),
        limits: { runDeadlineMs: 1, idleTimeoutMs: 1 },
        adapter: h.builtAdapter,
        inferredLegacy: false,
        enabled: true,
        priority: 3,
      },
      {
        manifest: {
          id: "a2",
          displayName: "Two",
          adapter: "http-bridge",
          source: "agents.d",
          capabilities: caps({}),
          credential: { kind: "env" },
        },
        capabilities: caps({}),
        limits: { runDeadlineMs: 1, idleTimeoutMs: 1 },
        adapter: h.builtAdapter,
        inferredLegacy: true,
        enabled: false,
        priority: 0,
      },
    ] as unknown as AgentDescriptor[]);
    const res = (h.ipcMain as FakeIpcMain).invoke("agents:list") as {
      agents: Array<Record<string, unknown>>;
      manifestErrors: unknown[];
    };
    expect(res.agents[0]).toMatchObject({ id: "a1", source: "builtin", credentialKind: "none", priority: 3 });
    expect(res.agents[1]).toMatchObject({ id: "a2", source: "agents.d", credentialKind: "env", enabled: false });
    expect(res.manifestErrors).toEqual([]);
  });

  it("rejects registering an id already owned by builtin or agents.d", () => {
    const layer = h.layer;
    (layer.registry.has as Mock).mockReturnValue(true);
    const res = (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain("已被内置或 agents.d 声明占用");
    expect(layer.registry.register).not.toHaveBeenCalled();
  });

  it("registers a valid manifest as a dynamic agent and audits the change", () => {
    const raw = exampleManifest();
    const res = (h.ipcMain as FakeIpcMain).invoke("agents:register", raw) as { ok: boolean; id: string };
    expect(res).toEqual({ ok: true, id: "codex-cli", replaced: false });
    expect(dynamicAgentMap().has("codex-cli")).toBe(true);
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "agent-change", agentId: "codex-cli" }),
    );
  });

  it("reports the builder's skip reason when no adapter can be built", () => {
    h.buildAdapters.mockReturnValue({ adapters: [], skipped: [{ manifest: { id: "x" }, reason: "entry kind unsupported" }] });
    const res = (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest()) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("entry kind unsupported");
  });

  it("unregisters a dynamic agent and forgets it only on success", async () => {
    const raw = exampleManifest();
    (h.ipcMain as FakeIpcMain).invoke("agents:register", raw);
    expect(dynamicAgentMap().has("codex-cli")).toBe(true);
    const layer = h.layer;
    const res = await (h.ipcMain as FakeIpcMain).invoke("agents:unregister", "codex-cli", 100);
    expect(res).toEqual({ ok: true, drained: 2 });
    // The drain window must reach the registry: unregister(id) vs
    // unregister(id, {graceMs}) are different contracts.
    expect(layer.registry.unregister).toHaveBeenCalledWith("codex-cli", { graceMs: 100 });
    expect(dynamicAgentMap().has("codex-cli")).toBe(false);
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "agent-change", agentId: "codex-cli", detail: expect.stringContaining("drain: 2") }),
    );
  });

  it("keeps a dynamic agent when the registry refuses the unregister", async () => {
    (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    const layer = h.layer;
    (layer.registry.unregister as Mock).mockResolvedValue({ ok: false, reason: "busy" });
    const res = await (h.ipcMain as FakeIpcMain).invoke("agents:unregister", "codex-cli");
    expect(res).toEqual({ ok: false, reason: "busy" });
    expect(dynamicAgentMap().has("codex-cli")).toBe(true);
  });

  it("toggles an agent and audits only successful changes", () => {
    const layer = h.layer;
    expect((h.ipcMain as FakeIpcMain).invoke("agents:toggle", "a1", false)).toBe(true);
    expect(layer.registry.setEnabled).toHaveBeenCalledWith("a1", false);
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "agent-change", agentId: "a1", detail: "disabled" }),
    );

    (layer.registry.setEnabled as Mock).mockReturnValue(false);
    (audit.append as Mock).mockClear();
    expect((h.ipcMain as FakeIpcMain).invoke("agents:toggle", "ghost", true)).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("probes one agent and reports a rejected probe as false", async () => {
    const layer = h.layer;
    const failing = {
      manifest: { id: "bad", displayName: "bad", adapter: "cli", capabilities: caps({}) },
      capabilities: caps({}),
      limits: {},
      adapter: { probe: vi.fn(async () => {
        throw new Error("down");
      }) },
      inferredLegacy: false,
      enabled: true,
      priority: 0,
    } as unknown as AgentDescriptor;
    (layer.registry.get as Mock).mockImplementation((id: string) =>
      id === "bad" ? failing : undefined,
    );
    const res = await (h.ipcMain as FakeIpcMain).invoke("agents:probe", "bad");
    expect(res).toEqual({ bad: false });
  });

  it("clamps the audit tail to a sane window", () => {
    const audit = inst(h.auditInstances);
    (h.ipcMain as FakeIpcMain).invoke("audit:recent", -5);
    (h.ipcMain as FakeIpcMain).invoke("audit:recent");
    (h.ipcMain as FakeIpcMain).invoke("audit:recent", 99_999);
    expect(audit.read).toHaveBeenNthCalledWith(1, { limit: 1 });
    expect(audit.read).toHaveBeenNthCalledWith(2, { limit: 100 });
    expect(audit.read).toHaveBeenNthCalledWith(3, { limit: 1000 });
  });

  it("lists audit file basenames only", () => {
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue(["/deep/dir/audit-1.jsonl"]);
    expect((h.ipcMain as FakeIpcMain).invoke("audit:files")).toEqual(["audit-1.jsonl"]);
  });

  it("audit:export 把全部历史写进用户选定的文件，返回保存路径", async () => {
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue(["/x/audit-1.jsonl"]);
    (dialog.showSaveDialog as Mock).mockResolvedValue({ canceled: false, filePath: "/x/out.jsonl" });
    const res = await (h.ipcMain as FakeIpcMain).invoke("audit:export");
    expect(res).toEqual({ ok: true, path: "/x/out.jsonl" });
    expect(audit.exportTo).toHaveBeenCalledWith("/x/out.jsonl");
  });

  it("audit:export 用户取消时不碰日志，如实报 canceled", async () => {
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue(["/x/audit-1.jsonl"]);
    (dialog.showSaveDialog as Mock).mockResolvedValue({ canceled: true, filePath: undefined });
    const res = await (h.ipcMain as FakeIpcMain).invoke("audit:export");
    expect(res).toEqual({ ok: false, reason: "canceled" });
    expect(audit.exportTo).not.toHaveBeenCalled();
  });

  it("audit:export 对话框异常返回（未取消却没给路径）时也不能拿 undefined 写盘", async () => {
    // Electron 正常不会返回这种组合，但 canceled || !filePath 的防御分支
    // 必须有断言钉住：一旦有人把 || 改成 &&，这个用例就是第一个死的。
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue(["/x/audit-1.jsonl"]);
    (dialog.showSaveDialog as Mock).mockResolvedValue({ canceled: false, filePath: undefined });
    const res = await (h.ipcMain as FakeIpcMain).invoke("audit:export");
    expect(res).toEqual({ ok: false, reason: "canceled" });
    expect(audit.exportTo).not.toHaveBeenCalled();
  });

  it("audit:export 没有审计文件时先说 empty，对话框都不弹", async () => {
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue([]);
    const res = await (h.ipcMain as FakeIpcMain).invoke("audit:export");
    expect(res).toEqual({ ok: false, reason: "empty" });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it("audit:export 写盘失败时上抛原因，不假装导出落了地", async () => {
    (dialog.showSaveDialog as Mock).mockResolvedValue({ canceled: false, filePath: "/x/out.jsonl" });
    const audit = inst(h.auditInstances);
    (audit.files as Mock).mockReturnValue(["/x/audit-1.jsonl"]);
    (audit.exportTo as Mock).mockImplementation(() => {
      throw new Error("EACCES: 写不了");
    });
    const res = await (h.ipcMain as FakeIpcMain).invoke("audit:export");
    expect(res).toEqual({ ok: false, reason: "EACCES: 写不了" });
  });
});

describe("orchestration handlers", () => {
  it("refuses planning for an unknown project", async () => {
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "ghost"),
    ).rejects.toThrow(/project ghost not found/);
  });

  it("refuses re-planning while the project is executing", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", requirement: "r", stage: "PRD" });
    setRunningProjectId("p1");
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1"),
    ).rejects.toThrow(/项目正在执行中，请先取消再重新规划/);
  });

  it("plans: persists PRD, decomposes, and stores batches + smoke", async () => {
    const store = inst(h.projectInstances);
    const prd = { title: "Todo", sections: [] };
    const batches = [[task({ id: "t1" })]];
    const smoke = [{ name: "ping", command: "node -v" }];
    (store.get as Mock).mockReturnValue({ id: "p1", requirement: "r", stage: "DRAFT" });
    h.generatePrd.mockResolvedValue(prd);
    h.decompose.mockResolvedValue({ batches, smoke });

    const res = await (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1");
    expect(res).toEqual({ prd, batches });
    expect(h.generatePrd).toHaveBeenCalledWith("r");
    expect(store.update).toHaveBeenNthCalledWith(1, "p1", {
      prdJson: JSON.stringify(prd),
      stage: "PLANNING",
    });
    expect(h.decompose).toHaveBeenCalledWith(prd, ["node ox-scripts/test.js"]);
    expect(store.update).toHaveBeenNthCalledWith(2, "p1", {
      batchesJson: JSON.stringify(batches),
      smokeJson: JSON.stringify(smoke),
    });
  });

  it("resets stale batches when the PRD is edited", async () => {
    const store = inst(h.projectInstances);
    const prd = { title: "Todo v2" };
    const batches = [[task({ id: "t2" })]];
    (store.get as Mock).mockReturnValue({ id: "p1", prdJson: "{}", batchesJson: "[[]]", stage: "PLANNING" });
    h.decompose.mockResolvedValue({ batches, smoke: [] });

    const res = await (h.ipcMain as FakeIpcMain).invoke("orchestration:update-prd", "p1", prd);
    expect(res).toEqual({ prd, batches });
    // First write clears the stale plan; the second one stores the new batches.
    expect(store.update).toHaveBeenNthCalledWith(1, "p1", {
      prdJson: JSON.stringify(prd),
      batchesJson: undefined,
      smokeJson: undefined,
    });
    expect(store.update).toHaveBeenNthCalledWith(2, "p1", {
      batchesJson: JSON.stringify(batches),
      smokeJson: JSON.stringify([]),
    });
  });

  it("refuses to start without a plan or while another run is active", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PLANNING" });
    await expect((h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p1")).rejects.toThrow(
      /no plan for project p1/,
    );

    (store.get as Mock).mockReturnValue({ id: "p1", batchesJson: "[[]]" });
    setRunningProjectId("p2");
    await expect((h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p1")).rejects.toThrow(
      /项目 p2 正在执行中，无法同时启动/,
    );
    expect(getRunningProjectId()).toBe("p2"); // guard fired before the flag flipped
    setRunningProjectId(null);
  });

  it("starts a run: scaffolds the workspace, executes the plan, releases the lock", async () => {
    const store = inst(h.projectInstances);
    const batches = [[task({ id: "t1" })]];
    const smoke = [{ name: "s", command: "node -v" }];
    (store.get as Mock).mockReturnValue({
      id: "p-run",
      batchesJson: JSON.stringify(batches),
      smokeJson: JSON.stringify(smoke),
    });
    h.execute.mockResolvedValue(undefined);

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-run");

    const root = workspaceRoot("p-run");
    expect(h.execute).toHaveBeenCalledWith(batches, root, { smoke });
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "ox-scripts", "build.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "ox-scripts", "test.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src"))).toBe(true);
    expect(fs.existsSync(path.join(root, "tests"))).toBe(true);
    // The scaffold scripts ARE the verification contract: build.js must keep
    // syntax-checking every .js file (skipping the rest), test.js must drive
    // `node --test`. Pinning the load-bearing tokens also keeps the mutation
    // gate honest about string-templated code.
    const buildJs = fs.readFileSync(path.join(root, "ox-scripts", "build.js"), "utf8");
    expect(buildJs).toContain("endsWith('.js')");
    expect(buildJs).toContain("continue;");
    const testJs = fs.readFileSync(path.join(root, "ox-scripts", "test.js"), "utf8");
    expect(testJs).toContain("--test");
    // The test scaffold must fail the run when a test file fails — flip the
    // comparison and a red verification loop would silently read as green.
    expect(testJs).toContain("r.status !== 0");
    expect(getRunningProjectId()).toBeNull();
  });

  it("releases the running lock even when execute throws", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p-err", batchesJson: "[[]]", smokeJson: "[]" });
    h.execute.mockRejectedValue(new Error("agent exploded"));
    await expect((h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-err")).rejects.toThrow(
      /agent exploded/,
    );
    expect(getRunningProjectId()).toBeNull();
  });

  it("cancels every engine and aborts parked escalations", async () => {
    buildEngine("p-cancel");
    const host = lastPlatformConfig().host;
    const parked: Promise<string> = host.requestEscalationDecision("t-c");

    (h.ipcMain as FakeIpcMain).invoke("orchestration:cancel");
    expect(h.cancelEngine).toHaveBeenCalledTimes(1);
    await expect(parked).resolves.toBe("abort");
  });

  it("delivers an escalation decision to the parked resolver", async () => {
    buildEngine("p-esc");
    const host = lastPlatformConfig().host;
    const parked: Promise<string> = host.requestEscalationDecision("t-esc");

    expect((h.ipcMain as FakeIpcMain).invoke("orchestration:escalation-decide", "t-esc", "skip")).toBe(true);
    await expect(parked).resolves.toBe("skip");
  });

  it("redacts credentials before a task outcome reaches the renderer", () => {
    buildEngine("p-redact");
    const callbacks = lastPlatformConfig().host.callbacks;
    callbacks.onTaskOutcome("t1", true, "stderr: key=sk-live-abcdef123456 end", { agentId: "a1", durationMs: 5 });

    const payload = win.webContents.send.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).toMatchObject({ type: "taskOutcome", taskId: "t1", ok: true, agentId: "a1" });
    const digest = payload.logDigest as string;
    expect(digest).not.toContain("sk-live-abcdef123456");
    expect(digest).toContain("[REDACTED]");
  });

  it("forwards zone-conflict verdicts to the board with a remedy", () => {
    buildEngine("p-verdict");
    const host = lastPlatformConfig().host;
    host.onVerdict({
      conflicts: [{ kind: "overlap", paths: ["src/a.ts"] }],
      remedies: [{ action: "skip", paths: ["src/a.ts"] }],
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "conflict", kind: "overlap", paths: ["src/a.ts"], remedy: "skip" }),
    );
  });

  it("falls back to remedy 'none' when no remedy matches the conflict paths", () => {
    buildEngine("p-verdict2");
    const host = lastPlatformConfig().host;
    host.onVerdict({
      conflicts: [{ kind: "overlap", paths: ["src/other.ts"] }],
      remedies: [{ action: "skip", paths: ["src/a.ts"] }],
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "conflict", remedy: "none" }),
    );
  });
});

describe("context singletons (seedKeys / journal / buildLlm / audit)", () => {
  /** Env vars the SenseNova/AMD seeding may touch; every test cleans up. */
  function deleteSeededEnvVars(): void {
    for (const v of ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3", "AMD_API_KEY"]) {
      delete process.env[v];
    }
  }

  it("writeJournal persists an atomically written checkpoint", () => {
    writeJournal("p-j", { batches: [["t1"]] } as never);
    const file = path.join(tmp, "runs", "p-j.json");
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { savedAt: string; snapshot: unknown };
    expect(parsed.snapshot).toEqual({ batches: [["t1"]] });
    expect(typeof parsed.savedAt).toBe("string");
  });

  it("writeJournal never breaks a run when the disk write fails", () => {
    h.writeFileAtomic.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => writeJournal("p-j2", { batches: [] } as never)).not.toThrow();
  });

  it("seedKeysFromStore expands the pool into provider env vars and seeds missing ones", () => {
    try {
      const keys = inst(h.keysInstances);
      (keys.get as Mock).mockImplementation((v: string) => (v === "AMD_API_KEY" ? "amd-store" : "sk-store"));
      const envVars = new Set<string>();
      seedKeysFromStore({ llmPool: ["sensenova", "amd-radeon"] } as never, envVars);
      // SenseNova contributes its 3 key vars + primary; AMD only its primary.
      expect(envVars.has("SENSENOVA_API_KEY")).toBe(true);
      expect(envVars.has("SENSENOVA_API_KEY_3")).toBe(true);
      expect(envVars.has("AMD_API_KEY")).toBe(true);
      expect(process.env.AMD_API_KEY).toBe("amd-store");
      expect(process.env.SENSENOVA_API_KEY).toBe("sk-store");
    } finally {
      deleteSeededEnvVars();
    }
  });

  it("seedKeysFromStore never overwrites a var already present in the environment", () => {
    process.env.SENSENOVA_API_KEY = "env-wins";
    try {
      const keys = inst(h.keysInstances);
      (keys.get as Mock).mockReturnValue("sk-store");
      const envVars = new Set<string>();
      seedKeysFromStore({ llmPool: ["sensenova"] } as never, envVars);
      expect(process.env.SENSENOVA_API_KEY).toBe("env-wins");
    } finally {
      deleteSeededEnvVars();
    }
  });

  it("seedKeysFromStore falls back to the single provider when the pool is empty", () => {
    try {
      const envVars = new Set<string>();
      seedKeysFromStore({ llmProvider: "amd-radeon" } as never, envVars);
      expect(envVars).toEqual(new Set(["AMD_API_KEY"]));
    } finally {
      deleteSeededEnvVars();
    }
  });

  it("buildLlm 的一次性客户端由 config.seedKeys 播种，调用点不再各自传参", async () => {
    try {
      h.llmChat.mockResolvedValue({ content: "pong", provider: "sensenova", model: "m1" });
      const keys = inst(h.keysInstances);
      (keys.get as Mock).mockReturnValue("sk-store");
      const llm = buildLlm({ llmProvider: "sensenova", llmPool: [] } as never);
      const res = await llm.chat({ messages: [{ role: "user", content: "ping" }] });
      expect(res.model).toBe("m1");

      const envVars = new Set<string>();
      lastPlatformConfig().seedKeys(envVars);
      expect(envVars.has("SENSENOVA_API_KEY")).toBe(true);
      expect(process.env.SENSENOVA_API_KEY).toBe("sk-store");
    } finally {
      deleteSeededEnvVars();
    }
  });

  it("run 路径的平台配置自带 keychain 播种器（P1 回归）", () => {
    // 曾经只有「设置 → 测试连接」那条一次性路径把 seeder 传给 buildLlm，而 run
    // 走的 buildEngine → buildPlatformLayer 不传，于是引擎的大脑客户端与内置执行器
    // 都只看得见进程环境 —— key store 里存了 Key 也照样无凭证跑 run。
    try {
      deleteSeededEnvVars();
      const keys = inst(h.keysInstances);
      (keys.get as Mock).mockImplementation((v: string) => (v === "AMD_API_KEY" ? "amd-store" : "sk-store"));

      buildEngine("p-seed-run");
      const seedKeys = lastPlatformConfig().seedKeys;
      expect(typeof seedKeys).toBe("function");

      const envVars = new Set<string>();
      seedKeys(envVars);
      expect(envVars.has("SENSENOVA_API_KEY")).toBe(true);
      expect(process.env.SENSENOVA_API_KEY).toBe("sk-store");
    } finally {
      deleteSeededEnvVars();
    }
  });

  it("caches the agent layer per settings signature", () => {
    const settings = inst(h.settingsInstances);
    (settings.load as Mock).mockReturnValue({
      llmProvider: "sensenova",
      llmPool: [],
      agentRouter: false,
      arbitration: "skip",
    });
    const before = h.createAgentLayerFn.mock.calls.length;
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    // Two list calls with one signature → exactly one rebuild; the cache is
    // what lets runtime-registered agents survive engine rebuilds.
    expect(h.createAgentLayerFn.mock.calls.length - before).toBe(1);
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(expect.objectContaining({ enableRouter: false }));
  });

  it("audits run start/end with redacted digests", () => {
    buildEngine("p-audit");
    const host = lastPlatformConfig().host;
    host.onRunStart("a1", task({ id: "t1", zone: "src/**" }));
    host.onRunComplete(
      { ok: true, agentId: "a1", durationMs: 12, logDigest: "boom sk-live-abcdef123456" },
      task({ id: "t1", zone: "src/**" }),
    );
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: "run-start", agentId: "a1", taskId: "t1", zone: "src/**" }),
    );
    const endCall = audit.append.mock.calls[1]![0] as Record<string, unknown>;
    expect(endCall).toMatchObject({ phase: "run-end", ok: true, durationMs: 12 });
    // The JSONL is durable: credentials must not survive to disk. (The redactor
    // requires 12+ body chars, so the test key must be realistically long.)
    expect(endCall.detail).not.toContain("sk-live-abcdef123456");
    expect(endCall.detail).toContain("sk-[REDACTED]");
  });

  it("omits optional fields from the run-end audit when absent", () => {
    buildEngine("p-audit2");
    const host = lastPlatformConfig().host;
    host.onRunComplete({ ok: false, logDigest: "x" }, task({ id: "t9", zone: "z" }));
    const call = inst(h.auditInstances).append.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call).toMatchObject({ phase: "run-end", ok: false, taskId: "t9" });
    expect("agentId" in call).toBe(false);
    expect("durationMs" in call).toBe(false);
    expect("errorClass" in call).toBe(false);
  });
});

describe("buildPlatformLayer · agentRouter 的第三态", () => {
  it("[216] 未设置 agentRouter（缺省）时 enableRouter 仍须为 true", () => {
    // 第 216 行 `enableRouter: settingsValue.agentRouter !== false` 是**三态**判断：
    // true / false / 缺省。改成 `=== false` 之后，**缺省会变成 false** ——
    // 即"从没碰过这个开关的用户"会**静默失去能力路由**：任务不再按
    // capabilities / zone 择优派发，退回 pre-router 的 round-robin，且不报任何错。
    //
    // 既有用例的 settings 里 `agentRouter` 恒为显式布尔（fixture 里写死 true，
    // 「caches the agent layer…」那条写死 false），第三态从来没人覆盖 ——
    // 这正是三态写法最容易漏掉的一格。
    //
    // 类型上 `agentRouter: boolean` 是**必需**的，但磁盘上的旧 settings 文件可以
    // 根本没有这个字段 —— `!== false` 这个写法本身就是为那一格存在的
    //（否则直接写 `settingsValue.agentRouter` 就够了）。这里用一次显式收窄
    // 还原那个运行时状态，而不是改生产代码的类型。
    const legacy = {
      ...DEFAULT_SETTINGS,
      arbitration: "deny-all" as const,
      agentRouter: undefined,
    } as unknown as ProjectSettings;

    h.createPlatformCalls.length = 0;
    buildPlatformLayer(legacy, { log: () => {} });
    expect(lastPlatformConfig().enableRouter).toBe(true);

    // 反向也要断言：显式 false 必须真的关掉
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS, arbitration: "quarantine", agentRouter: false }, {
      log: () => {},
    });
    expect(lastPlatformConfig().enableRouter).toBe(false);
  });
});
