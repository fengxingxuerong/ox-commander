import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { dialog } from "electron";
import { buildReceipt, sealReceipt } from "../shared/delivery-receipt";
import { SchemaValidationError } from "../shared/schema";

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
  /** 平台层「跑一组命令」的观察点（欠账 #7：凭据复跑走的就是这一条）。 */
  verifyCommands: null as any,
  writeFileAtomic: null as any,
  saveManifest: null as any,
  removeManifest: null as any,
  generatePrd: null as any,
  decompose: null as any,
  execute: null as any,
  cancelEngine: null as any,
  pauseEngine: null as any,
  resumeEngine: null as any,
  /** 摄入半边：github:list-issues 的供数替身（不真跑 gh）。 */
  listGithubIssues: null as any,
  /**
   * 桌面自动化（M5b）：记录仓的替身状态。handler 测的是"闸门与三态映射"，
   * 落盘语义由 automation-store.test.ts 用真临时目录覆盖。
   */
  automationRows: [] as any[],
  automationInstances: [] as any[],
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

// 摄入半边：listGithubIssues 换替身（不真 spawn gh），其余原样 —— 处理器的
// repo 守卫用的 REPO_RE 必须是真那个，mock 一份正则等于给判据放假。
vi.mock("../electron/context/github-readonly", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/context/github-readonly")>();
  return { ...mod, listGithubIssues: (h.listGithubIssues = vi.fn(async () => ({ ok: true, issues: [] }))) };
});

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

/**
 * 桌面自动化的记录仓：内存替身。**方法必须每次现读 `h.automationRows`**，
 * 否则每条用例就得重建 store（而 `ipc/automations.ts` 里它是模块级单例）。
 */
vi.mock("../electron/automations/automation-store", () => ({
  AutomationStore: class {
    list = vi.fn(() => h.automationRows);
    get = vi.fn((id: string) => h.automationRows.find((a: any) => a.id === id) ?? null);
    create = vi.fn((input: any) => ({ id: "auto-new", enabled: false, createdAt: 1, updatedAt: 1, ...input }));
    update = vi.fn((id: string, patch: any) => {
      const cur = h.automationRows.find((a: any) => a.id === id);
      return cur ? { ...cur, ...patch } : null;
    });
    remove = vi.fn((id: string) => {
      const before = h.automationRows.length;
      h.automationRows = h.automationRows.filter((a: any) => a.id !== id);
      return h.automationRows.length < before;
    });
    markFired = vi.fn();
    constructor() {
      h.automationInstances.push(this);
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
  // 默认成功（返回的路径带 id，方便断言"写到了哪"）；测试可用
  // `h.saveManifest.mockReturnValue({ ok: false, reason: "EACCES" })` 模拟落盘失败。
  saveManifestFile: (h.saveManifest = vi.fn((_dir: string, m: any) => ({
    ok: true,
    path: `/agents.d/${m.id}.json`,
  }))),
  removeManifestFile: (h.removeManifest = vi.fn(() => ({ ok: true, removed: true }))),
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
      // 延迟读 h.verifyCommands（本工厂执行时它还没赋值），与上面几个同形状。
      // `??=` 而非 `=`：本工厂**每次**建平台都会跑，用 `=` 会在 receipt:verify
      // 复跑时把测试刚设好的 mockResolvedValue 冲成一个新的空 vi.fn()，
      // 于是 `report.results` 读到 undefined（2026-10-10 接手修）。
      verifyCommands: (h.verifyCommands ??= vi.fn()),
    };
  }),
  // 原样实现：context.ts 用它算 agent layer 的缓存 signature，这里不该被 mock 掉
  // （漏了它，ensureAgentLayer 会直接抛"No export is defined on the mock"）。
  executorTimeoutMsFor: (s: { executorTimeoutMs?: number }) =>
    s.executorTimeoutMs !== undefined && s.executorTimeoutMs > 0 ? s.executorTimeoutMs : 300_000,
  brainTimeoutMsFor: (s: { brainTimeoutMs?: number }) =>
    s.brainTimeoutMs !== undefined && s.brainTimeoutMs > 0 ? s.brainTimeoutMs : 300_000,
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
import { createdWindows, clearedPartitions, fireAppEvent } from "./__fakes__/electron";
import { app, shell } from "electron";
import { attachWindow, buildEngine, ensureWorkspace, registerIpc } from "../electron/ipc";
import { registerChatHandlers } from "../electron/ipc/chat";
import { ChatSessionStore } from "../electron/chat/session-store";
import type { ChatSessionMeta, ChatSessionSnapshot } from "../shared/chat-events";
import type { ChatFileChange } from "../shared/tools/spec";
import type { ReceiptVerifyResult } from "../shared/delivery-receipt";
import {
  abortAllApprovals,
  abortAllEscalations,
  buildLlm,
  buildPlatformLayer,
  dynamicAgentMap,
  enginesOf,
  ensureAgentLayer,
  ensureAudit,
  getRunningProjectId,
  resolveApproval,
  resolveEscalation,
  seedKeysFromStore,
  setRunningProjectId,
  workspaceRoot,
  writeJournal,
  readJournal,
  setJournalRequirement,
  clearJournal,
} from "../electron/ipc/context";
import { exampleManifest } from "../electron/agents/manifest-schema";
import { SnapshotStore } from "../electron/sandbox/snapshot-store";
import { HttpLlmError } from "../shared/http-clients";
import { getPreview, keepDevServer, stopPreview } from "../electron/preview-manager";
import { closePreviewWindow } from "../electron/preview-window";
import { runSmokeChecks } from "../electron/engine/verifier";
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
  // 自动化：每条用例从空表起（启用的行会在 reschedule 时排真 timer，见 describe 说明）
  h.automationRows.length = 0;
  // 复跑默认「命令跑通」；要造矛盾的用例各自改返回值。
  h.verifyCommands?.mockReset();
  h.verifyCommands?.mockResolvedValue({ results: [] });
  h.writeFileAtomic.mockClear();
  // 落盘相关的两个 mock 带"可编程返回值"：`mockClear` 只清调用记录、**不清
  // mockReturnValue**，上一条用例的 EACCES 会漏进下一条。必须连默认实现一起重设。
  h.saveManifest?.mockReset();
  h.saveManifest?.mockImplementation((_dir: string, m: any) => ({
    ok: true,
    path: `/agents.d/${m.id}.json`,
  }));
  h.removeManifest?.mockReset();
  h.removeManifest?.mockImplementation(() => ({ ok: true, removed: true }));
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
  // SettingsStore 实例跨用例共享；不复位 load 的话，上一个用例设置的
  // `approvalPolicy: "untrusted"` 会漏进下一个会话用例，让补丁一直等人审批。
  for (const settings of h.settingsInstances) {
    (settings.load as Mock).mockReset().mockReturnValue({
      llmProvider: "sensenova",
      llmPool: [],
      agentRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 1,
      verificationCommands: ["node ox-scripts/test.js"],
    });
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

  it("settings:save 形状不过关 → 拒绝且不落盘（控制面不再零校验，2026-10-13）", () => {
    const settings = inst(h.settingsInstances);
    // handler 是同步的：fake 的 invoke 直调，同步抛错就地可见（真 Electron 里
    // ipcRenderer.invoke 会把它变成 reject —— 渲染层 settingsError 横幅同一句话）。
    // 用相对计数而不是 not.toHaveBeenCalled：实例跨用例共享，前面的用例可能已调过。
    const callsBefore = (settings.save as Mock).mock.calls.length;
    expect(() => (h.ipcMain as FakeIpcMain).invoke("settings:save", { maxRepairRounds: -1 })).toThrow(
      SchemaValidationError,
    );
    expect((settings.save as Mock).mock.calls.length).toBe(callsBefore); // 畸形的绝不落盘
    // 部分合法对象照旧通过（旧调用方的兼容面不收窄）
    expect((h.ipcMain as FakeIpcMain).invoke("settings:save", { llmProvider: "sensenova" })).toBe(true);
    expect((settings.save as Mock).mock.calls.length).toBe(callsBefore + 1); // 合法的只有这一次进 store
  });

  it("keys:save 非数组 / 项缺字段 → 明确报错而不是 TypeError", () => {
    expect(() => (h.ipcMain as FakeIpcMain).invoke("keys:save", "GOOD_1=x")).toThrow(/数组/);
    expect(() => (h.ipcMain as FakeIpcMain).invoke("keys:save", [{ envVar: 7, value: "a" }])).toThrow(
      /每项都需要/,
    );
    // 用具体消息而非 /envVar/：TypeError("Cannot read … envVar") 也能匹配 /envVar/，
    // 会放过 `!item || …` → `&&` 的存活变异（null 漏进解引用）。
    expect(() => (h.ipcMain as FakeIpcMain).invoke("keys:save", [null])).toThrow(/每项都需要/);
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

  it("账号热切换：保存新 key 立刻覆盖进程 env（换 key 不重启就生效）", () => {
    // env-wins 语义（KeysStore.get）下，env 里残留的旧值会遮蔽 store 里的新值 ——
    // 保存动作不同步 env 的话，"换 key"只有重启应用才生效。
    const prior = process.env["OX_TEST_KEY"];
    process.env["OX_TEST_KEY"] = "old-key";
    try {
      (h.ipcMain as FakeIpcMain).invoke("keys:save", [{ envVar: "OX_TEST_KEY", value: "new-key" }]);
      expect(process.env["OX_TEST_KEY"]).toBe("new-key");
    } finally {
      if (prior === undefined) delete process.env["OX_TEST_KEY"];
      else process.env["OX_TEST_KEY"] = prior;
    }
  });

  it("账号热切换：空值清除 key 时 env 同步删除（停用也真的生效）", () => {
    const prior = process.env["OX_TEST_KEY"];
    process.env["OX_TEST_KEY"] = "stale-key";
    try {
      (h.ipcMain as FakeIpcMain).invoke("keys:save", [{ envVar: "OX_TEST_KEY", value: "  " }]);
      expect("OX_TEST_KEY" in process.env).toBe(false);
    } finally {
      if (prior !== undefined) process.env["OX_TEST_KEY"] = prior;
    }
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

/**
 * 摄入半边（2026-10-14）：github:list-issues 的入参守卫。
 *
 * 与 settings:save 同一条规矩（P0-3）：**触发外部命令的入口**不能直落 ——
 * 渲染层传来的 repo/search 是不可信输入，白名单与字符集校验在
 * github-readonly，形状校验在这一层。gh 侧的失败（没登录等）不走异常，
 * 折进结果对象的 reason，由选择器摆出来。
 */
describe("github handlers（摄入半边）", () => {
  it("合法入参原样透传给 listGithubIssues（三个字段都可缺席）", async () => {
    const res = await (h.ipcMain as FakeIpcMain).invoke("github:list-issues", {
      repo: "owner/repo",
      search: "label:bug",
      limit: 5,
    });
    expect(res).toEqual({ ok: true, issues: [] });
    expect(h.listGithubIssues).toHaveBeenCalledWith({ repo: "owner/repo", search: "label:bug", limit: 5 });
    // 空对象 = 三个都缺席（gh 按 cwd 认仓库），不补默认键
    await (h.ipcMain as FakeIpcMain).invoke("github:list-issues", {});
    expect(h.listGithubIssues).toHaveBeenLastCalledWith({});
  });

  it("入参 null / 整个缺席 → 按全部缺席处理，不炸 TypeError", async () => {
    // 判据不只是"别崩"：`input !== null && typeof input === "object"` 换成 `||`
    // 时，null 会走进 `null["repo"]` 抛 TypeError —— 这条用例就是钉那个变异的。
    const res = await (h.ipcMain as FakeIpcMain).invoke("github:list-issues", null);
    expect(res).toEqual({ ok: true, issues: [] });
    expect(h.listGithubIssues).toHaveBeenLastCalledWith({});
    // 一个参数都不给（preload 侧漏传）同理
    await (h.ipcMain as FakeIpcMain).invoke("github:list-issues");
    expect(h.listGithubIssues).toHaveBeenLastCalledWith({});
  });

  it("repo 不合法 / search 非字符串 / limit 非正 → 拒绝且不碰 gh", () => {
    const callsBefore = (h.listGithubIssues as Mock).mock.calls.length;
    expect(() => (h.ipcMain as FakeIpcMain).invoke("github:list-issues", { repo: "bad;rm" })).toThrow(
      /owner\/repo/,
    );
    expect(() => (h.ipcMain as FakeIpcMain).invoke("github:list-issues", { search: 7 })).toThrow(/字符串/);
    expect(() => (h.ipcMain as FakeIpcMain).invoke("github:list-issues", { limit: 0 })).toThrow(/正整数/);
    expect(() => (h.ipcMain as FakeIpcMain).invoke("github:list-issues", { limit: 1.5 })).toThrow(/正整数/);
    expect((h.listGithubIssues as Mock).mock.calls.length).toBe(callsBefore);
  });

  it("gh 侧失败折进结果对象（没登录 / 仓库不存在），不抛异常", async () => {
    (h.listGithubIssues as Mock).mockImplementationOnce(async () => ({
      ok: false,
      reason: "gh issue list 失败（gh 未安装 / 未登录 / 仓库不存在？）:not logged in",
    }));
    const res = await (h.ipcMain as FakeIpcMain).invoke("github:list-issues", {});
    expect(res).toMatchObject({ ok: false });
    expect((res as { reason: string }).reason).toContain("未登录");
  });
});

describe("agents:detect（C6 执行器自动探测）", () => {
  it("每个候选都带安装提示与可直接注册的 manifest；已在池里的标记 registered", () => {
    (h.layer.registry.list as Mock).mockReturnValue([
      { manifest: { id: "claude-code" }, capabilities: {}, enabled: true },
    ]);
    const out = (h.ipcMain as FakeIpcMain).invoke("agents:detect") as Array<{
      id: string;
      command: string;
      found: boolean;
      installHint: string;
      registered: boolean;
      manifest: Record<string, unknown>;
    }>;
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.command).toBeTruthy();
      expect(c.installHint.trim()).not.toBe(""); // 没装的一律要有提示
      expect(c.manifest.id).toBe(c.id);
      expect("absPath" in c === false || c.found).toBe(true); // 没找到就不给路径
    }
    expect(out.find((c) => c.id === "claude-code")!.registered).toBe(true);
    expect(out.find((c) => c.id === "codex-cli")!.registered).toBe(false);
  });

  it("扫不到的候选不编路径：found=false 时 absPath 这个键不出现", () => {
    (h.layer.registry.list as Mock).mockReturnValue([]);
    // 用一个不存在的 PATH：所有候选都必须按"未找到"呈现
    const prev = process.env.PATH;
    process.env.PATH = "";
    try {
      const out = (h.ipcMain as FakeIpcMain).invoke("agents:detect") as Array<{
        found: boolean;
        absPath?: string;
      }>;
      expect(out.every((c) => c.found === false)).toBe(true);
      expect(out.every((c) => c.absPath === undefined)).toBe(true);
    } finally {
      process.env.PATH = prev;
    }
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
    expect(res).toEqual({
      ok: true,
      id: "codex-cli",
      replaced: false,
      persisted: { ok: true, path: "/agents.d/codex-cli.json" },
    });
    expect(dynamicAgentMap().has("codex-cli")).toBe(true);
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "agent-change", agentId: "codex-cli" }),
    );
  });

  it("[80] 覆盖注册才说『覆盖原注册』，首次注册不能这么说", () => {
    // 第 80 行 `res.replaced ? "覆盖原注册" : ""`。交换分支后：真的覆盖时闭口不提，
    // 首次注册反而被记成"覆盖原注册" —— 审计里"这次动的是既有条目"这件事被说反，
    // 事后追"谁什么时候改过这个 agent"会得出错误结论。
    const layer = h.layer;
    const audit = inst(h.auditInstances);
    const details = (): string[] =>
      audit.append.mock.calls.map((c: unknown[]) => (c[0] as { detail?: string } | undefined)?.detail ?? "");

    (layer.registry.register as Mock).mockReturnValue({ ok: true, replaced: false });
    (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    expect(details().some((d) => d.includes("覆盖原注册"))).toBe(false);

    audit.append.mockClear();
    (layer.registry.register as Mock).mockReturnValue({ ok: true, replaced: true });
    (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    expect(details().some((d) => d.includes("覆盖原注册"))).toBe(true);
  });

  it("注册成功但落不了盘时照样报成功，且把『重启后会丢』说进审计", () => {
    h.saveManifest.mockReturnValue({ ok: false, reason: "EACCES" });
    const res = (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest()) as {
      ok: boolean;
      persisted?: { ok: boolean; reason?: string };
    };
    // 不回滚：这一轮 agent 确实能用。但 persisted 必须如实为 false，
    // 否则 UI 会把"记住了"当成真的。
    expect(res.ok).toBe(true);
    expect(res.persisted).toEqual({ ok: false, reason: "EACCES" });
    expect(dynamicAgentMap().has("codex-cli")).toBe(true);
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("落盘失败：EACCES") }),
    );
  });

  it("注销会把 agents.d 里那份文件一起删掉，否则重启它又回来", async () => {
    (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    h.removeManifest.mockReturnValue({ ok: true, removed: true });
    const res = (await (h.ipcMain as FakeIpcMain).invoke("agents:unregister", "codex-cli")) as {
      persisted?: { removed?: boolean };
    };
    expect(res.persisted).toEqual({ ok: true, removed: true });
    expect(h.removeManifest).toHaveBeenCalled();
  });

  it("文件被改过就只注销内存，不删用户的文件，并把原因带出去", async () => {
    (h.ipcMain as FakeIpcMain).invoke("agents:register", exampleManifest());
    h.removeManifest.mockReturnValue({
      ok: true,
      removed: false,
      reason: "agents.d 里的文件已被改动，未删除",
    });
    const res = (await (h.ipcMain as FakeIpcMain).invoke("agents:unregister", "codex-cli")) as {
      persisted?: { removed?: boolean; reason?: string };
    };
    expect(res.persisted?.removed).toBe(false);
    expect(res.persisted?.reason).toContain("已被改动");
    const audit = inst(h.auditInstances);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("已被改动") }),
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
    expect(res).toEqual({ ok: true, drained: 2, persisted: { ok: true, removed: true } });
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

  it("board:recovery derives the view from the full audit trail", async () => {
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockReturnValue([
      { ts: "2026-09-29T10:00:00.000Z", phase: "run-start", projectId: "p1", taskId: "t1", title: "A", zone: "z" },
      { ts: "2026-09-29T10:05:00.000Z", phase: "stage", projectId: "p1", stage: "VERIFICATION" },
    ]);
    // No limit argument: recovery needs the whole trail, not a tail window.
    const res = (await (h.ipcMain as FakeIpcMain).invoke("board:recovery")) as {
      tasks: Record<string, unknown>;
      stage?: string;
      interrupted: boolean;
    };
    expect(audit.read).toHaveBeenCalledWith();
    expect(res.stage).toBe("VERIFICATION");
    expect(res.interrupted).toBe(true);
    expect(res.tasks.t1).toMatchObject({ status: "running", title: "A", attempts: 1 });
  });

  it("audit:trail 从完整审计推导一个任务的运行履历（P1-3 上下文回溯）", async () => {
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockReturnValue([
      { ts: "T-start", phase: "run-start", projectId: "p1", taskId: "t1", title: "A", zone: "z", agentId: "plan-a" },
      // 别家任务的事实：履历只收 taskId 精确匹配的，这条不得混进来。
      { ts: "T-other", phase: "run-start", projectId: "p1", taskId: "t2", title: "B", zone: "y", agentId: "x" },
      {
        ts: "T-end",
        phase: "run-end",
        projectId: "p1",
        taskId: "t1",
        agentId: "exec-b",
        ok: false,
        durationMs: 1200,
        errorClass: "timeout",
        detail: "boom",
      },
    ]);
    const res = (await (h.ipcMain as FakeIpcMain).invoke("audit:trail", "t1")) as Record<string, unknown>;
    // 履历要的是"这个任务的全部历史"，窗口取满 5000 而不是 audit:recent 的 100。
    expect(audit.read).toHaveBeenCalledWith({ limit: 5000 });
    // agentId 以 run-end 的真实执行器为准（重派后 run-start 的计划值会过期）。
    expect(res).toEqual({
      taskId: "t1",
      title: "A",
      zone: "z",
      runs: [
        {
          startedAt: "T-start",
          endedAt: "T-end",
          agentId: "exec-b",
          durationMs: 1200,
          ok: false,
          errorClass: "timeout",
          digest: "boom",
        },
      ],
    });
  });

  it("audit:trail 空串/非字符串 taskId：守卫直接空回执，不碰审计", () => {
    // 守卫行 `typeof taskId !== "string" || taskId === ""` 的三个变异体
    // （||→&&、===→!==、!==→===）都会让某一种非法输入穿过守卫走到
    // read()/taskTrail —— 「read 不被调用」与「taskId 回显空串」一起把它们钉死。
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockClear();
    const ipc = h.ipcMain as FakeIpcMain;
    expect(ipc.invoke("audit:trail", "")).toEqual({ taskId: "", runs: [] });
    expect(ipc.invoke("audit:trail", 42)).toEqual({ taskId: "", runs: [] });
    expect(audit.read).not.toHaveBeenCalled();
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

  it("plans: 第二次规划把上一次的快照当背景注入（形态 B：读落盘事实，不是模型自述）", async () => {
    const store = inst(h.projectInstances);
    const prd = { title: "Todo", sections: [] };
    const batches = [[task({ id: "t1", title: "拆分逻辑" })]];
    (store.get as Mock).mockReturnValue({ id: "p1", requirement: "做一个 CSV 工具", stage: "DRAFT" });
    h.generatePrd.mockResolvedValue(prd);
    h.decompose.mockResolvedValue({ batches, smoke: [] });

    // 第一次：还没有历史 ⇒ 第三个参数是空串（提示里不产段）。
    await (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1");
    expect(h.generatePrd).toHaveBeenLastCalledWith("做一个 CSV 工具", expect.anything(), "");
    // 审计实例与 handler 用的是同一个（`ensureAudit()` 的单例），按实例数组取会拿到
    // 一条旧用例留下的那个。
    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };
    // 落快照：phase plan + projectId + 快照字段
    const appended = (audit.append as Mock).mock.calls.map((c) => c[0] as {
      phase: string;
      projectId?: string;
      plan?: { taskCount: number; taskTitles: string[]; requirementHash: string };
    });
    const planRecord = appended.find((r) => r.phase === "plan");
    expect(planRecord).toBeDefined();
    expect(planRecord!.projectId).toBe("p1");
    expect(planRecord!.plan!.taskCount).toBe(1);
    expect(planRecord!.plan!.taskTitles).toEqual(["拆分逻辑"]);
    expect(planRecord!.plan!.requirementHash).toMatch(/^[0-9a-f]{8}$/);

    // 第二次：审计里已经有本项目的 plan 快照 ⇒ 必须把它渲染成块传进去。
    (audit.read as Mock).mockReturnValue([
      { phase: "plan", projectId: "p1", ts: "2026-10-25T10:00:00.000Z", plan: planRecord!.plan },
      // 别的项目的快照不该混进来（两个项目互相污染拆法是最隐蔽的一种错）。
      { phase: "plan", projectId: "p2", ts: "2026-10-25T11:00:00.000Z", plan: planRecord!.plan },
    ]);
    await (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1");
    const history = (h.generatePrd as Mock).mock.calls.at(-1)![2] as string;
    expect(history).toContain("【上次规划");
    expect(history).toContain("上次拆出 1 个任务");
    expect(history).toContain("拆分逻辑");
    // 需求没改：块里要印「未变」（这个项目两次的需求都是同一句）。
    expect(history).toContain("未变");
    // 任务级差异（2026-10-25）：任务清单要等拆完才有，所以它只能喂给**分解**那一步 ——
    // 这是"上次切成哪几个任务"真正能被模型看见的唯一位置。
    const planInput = (h.decompose as Mock).mock.calls.at(-1)!;
    const previousBlock = planInput[2] as string;
    expect(previousBlock).toContain("【上次规划");
    expect(previousBlock).toContain("上次 1 个任务");
    expect(previousBlock).toContain("拆分逻辑");
    expect(previousBlock).toContain("沿用同一套切法");
  });

  it("plans: 落快照时按 projectId 过滤历史 —— 别的项目的规划不许被算成「上次」", async () => {
    // 这条钉的是 `filter((r) => r.projectId === projectId)`：判反（`!==`）会把
    // 别的项目的拆法当成"上次"，于是差异会全部算错 —— 而提示看起来完全正常。
    const store = inst(h.projectInstances);
    const prd = { goal: "g", features: [], techStack: [], acceptanceCriteria: [] };
    (store.get as Mock).mockReturnValue({ id: "p1", requirement: "需求 A", stage: "DRAFT" });
    h.generatePrd.mockResolvedValue(prd);
    h.decompose.mockResolvedValue({ batches: [[task({ id: "t1", title: "本项目任务" })]], smoke: [] });

    const otherSnapshot = {
      ts: "2026-10-25T09:00:00.000Z",
      requirement: "别的项目",
      goal: "别的目标",
      taskTitles: ["别人的任务 A", "别人的任务 B", "别人的任务 C"],
      taskCount: 3,
      requirementHash: "deadbeef",
      featureCount: 9,
    };
    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };
    audit.read.mockReturnValue([
      // 顺序刻意把"别的项目"放前面：按 ts 它更早，但按项目它根本不该被看见。
      { phase: "plan", projectId: "p2", ts: otherSnapshot.ts, plan: otherSnapshot },
    ]);

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1");

    // 本项目的第一次规划 ⇒ 注入的历史必须是空串（不算"上次"）。
    expect(h.generatePrd).toHaveBeenLastCalledWith("需求 A", expect.anything(), "");
  });

  it("plans: 同一项目的历史才会算出差异（新增/不再出现的任务都进日志）", async () => {
    const store = inst(h.projectInstances);
    const prd = { goal: "g", features: [], techStack: [], acceptanceCriteria: [] };
    (store.get as Mock).mockReturnValue({ id: "p1", requirement: "需求 A", stage: "DRAFT" });
    h.generatePrd.mockResolvedValue(prd);
    h.decompose.mockResolvedValue({ batches: [[task({ id: "t1", title: "新任务" })]], smoke: [] });

    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };
    audit.read.mockReturnValue([
      {
        phase: "plan",
        projectId: "p1",
        ts: "2026-10-25T09:00:00.000Z",
        plan: {
          ts: "2026-10-25T09:00:00.000Z",
          requirement: "需求 A",
          goal: "g",
          taskTitles: ["旧任务"],
          taskCount: 1,
          requirementHash: "deadbeef",
          featureCount: 0,
        },
      },
    ]);

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:planning", "p1");

    // 差异进日志（`recordPlanSnapshot` 里那条）：新增「新任务」、不再出现「旧任务」、
    // 需求已改动。日志是唯一能让人读到"这一版比上一版变了什么"的地方。
    const sent = win.webContents.send as unknown as Mock;
    const logLines = sent.mock.calls
      .filter((c) => (c[1] as { type?: string }).type === "log")
      .map((c) => (c[1] as { text: string }).text);
    const diffLine = logLines.find((l) => l.includes("[plan-history]") && l.includes("任务数"));
    expect(diffLine).toBeDefined();
    expect(diffLine).toContain("已改动");
    expect(diffLine).toContain("新增「新任务」");
    expect(diffLine).toContain("不再出现「旧任务」");
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
    // B3 起第二个参数是项目根（规划阶段也注入项目约定）：断言它非空，
    // 而不是钉死 tmp 路径 —— 路径由 app.getPath("userData") 决定，逐版本会变。
    // 形态 B 起第三个参数是"上次规划"块：这个项目还没有历史，所以是空串
    // （历史缺席 = 提示里不产段，不是"没有这个参数"）。
    expect(h.generatePrd).toHaveBeenCalledWith("r", expect.stringContaining("workspaces"), "");
    expect(store.update).toHaveBeenNthCalledWith(1, "p1", {
      prdJson: JSON.stringify(prd),
      stage: "PLANNING",
    });
    expect(h.decompose).toHaveBeenCalledWith(prd, ["node ox-scripts/test.js"], "");
    expect(store.update).toHaveBeenNthCalledWith(2, "p1", {
      batchesJson: JSON.stringify(batches),
      smokeJson: JSON.stringify(smoke),
    });
  });

  it("resets stale batches when the PRD is edited", async () => {
    const store = inst(h.projectInstances);
    // PRD 从渲染层来，入口会过 parsePrd（2026-10-13）—— 用一份合法的，
    // 并断言落盘/返回的都是**校验后的形状**（不是把原样 unknown 写进盘）。
    const prd = { goal: "Todo v2", features: ["f"], techStack: ["ts"], acceptanceCriteria: ["a"] };
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

  /**
   * 2026-10-05（体检 §6）：`orchestration.ts` 的**函数**覆盖 66.7% —— 全项目
   * 信任面最重的文件里最低。逐个定位后确认未覆盖的是这七类：
   * ① 两个事件转发闭包（save / log / onTaskStatus / onVerification /
   *    onEscalation）—— 它们是**引擎 → 渲染进程**的桥，渲染端 UI 全靠它们刷新，
   *    断了不会有任何报错，只是界面不动；
   * ② `orchestration:pause` / `:resume` —— 暂停继续的 IO 边界；
   * ③ `update-prd` 的两个守卫分支（项目不存在 / 执行中禁止改 PRD）。
   *
   * 其中 ③ 是 fail-closed 链条的一环：执行中改 PRD 会让"正在跑的批次"与
   * "新拆出来的批次"不一致，所以守卫必须真的会红。
   */
  it("pause / resume 会对每个已建引擎调用对应方法", async () => {
    const e1 = { pause: vi.fn(), resume: vi.fn() };
    const e2 = { pause: vi.fn(), resume: vi.fn() };
    enginesOf().set("a", e1 as never);
    enginesOf().set("b", e2 as never);

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:pause");
    expect(e1.pause).toHaveBeenCalledTimes(1);
    expect(e2.pause).toHaveBeenCalledTimes(1);
    expect(e1.resume).not.toHaveBeenCalled();

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:resume");
    expect(e1.resume).toHaveBeenCalledTimes(1);
    expect(e2.resume).toHaveBeenCalledTimes(1);
  });

  it("pause / resume 在没有引擎时不崩（幂等，不是异常）", async () => {
    enginesOf().clear();
    // 这两个 handler 是**同步**的：invoke 直接返回 undefined，不包 Promise。
    // 用 rejects/throws 才安全 —— 上游写成 .resolves 会拿到
    // "You must provide a Promise" 的类型错，那是在测测试，不是在测产品。
    expect(() => (h.ipcMain as FakeIpcMain).invoke("orchestration:pause")).not.toThrow();
    expect(() => (h.ipcMain as FakeIpcMain).invoke("orchestration:resume")).not.toThrow();
  });

  it("update-prd 拒绝不存在的项目（fail-closed 守卫）", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue(undefined);
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:update-prd", "ghost", { title: "x" }),
    ).rejects.toThrow(/project ghost not found/);
    // 守卫必须发生在任何写入之前：项目都没找到，绝不能先 update 再报错
    expect(store.update).not.toHaveBeenCalled();
    expect(h.decompose).not.toHaveBeenCalled();
  });

  it("update-prd 的 PRD 形状不过关 → SchemaValidationError（渲染层编辑也要过闸，2026-10-13）", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PLANNING" });
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:update-prd", "p1", { title: "x" }),
    ).rejects.toThrow(SchemaValidationError);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("update-prd 在该项目执行中时拒绝（批次与 PRD 会不一致）", async () => {
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p-busy", prdJson: "{}" });
    setRunningProjectId("p-busy");
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:update-prd", "p-busy", { title: "x" }),
    ).rejects.toThrow(/项目正在执行中，请先取消再修改 PRD/);
    // 这是本条用例的全部意义：改 PRD 绝不能顺手把正在跑的批次换掉
    expect(store.update).not.toHaveBeenCalled();
    setRunningProjectId(null);
  });

  it("start 在没有 smokeJson 时用空数组，不当成解析错误（冒烟可选）", async () => {
    // 覆盖 `rec.smokeJson ? ... : []` 的 else 分支：老项目只有 batches 没有 smoke，
    // 走到 else 若抛错就是"历史数据全部无法启动"。
    const store = inst(h.projectInstances);
    (store.get as Mock).mockReturnValue({ id: "p-nosmoke", batchesJson: "[[]]" });
    h.execute.mockResolvedValue(undefined);

    await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-nosmoke");
    // 与上面那条用同一个断言形状（workspaceRoot），别用 expect.any(String)：
    // 那会顺带放过"工作区路径算错了"这种回归，而这条要守的正是它没有变化。
    const [batchesArg, rootArg, optsArg] = (h.execute as Mock).mock.calls[0]!;
    expect(batchesArg).toEqual([[]]); // 原样解析 `[[]]`，不去重不修剪
    expect(rootArg).toBe(workspaceRoot("p-nosmoke"));
    expect(optsArg).toEqual({ smoke: [] });
  });

  /**
   * 2026-10-05：引擎 → 渲染进程的**事件桥**。这五个转发闭包此前一个都没被调用过
   * （函数覆盖 66.7% 的一部分）。
   *
   * 它们的特点是"断了不会报错"：回调体只是 `send(...)`，少接一个就是 UI 上某个
   * 面板永远不刷新，没有任何异常、没有任何日志。所以必须逐个点名。
   */
  it("log / onTaskStatus / onVerification / onEscalation 都真的转发到渲染进程", () => {
    buildEngine("p-bridge");
    const cfg = lastPlatformConfig();
    const cb = cfg.host.callbacks;

    cfg.host.log("hello from engine");
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", { type: "log", text: "hello from engine" });

    // 实时日志流同样过脱敏（2026-10-13）：报错文本回显 token 不许原样上屏可复制。
    cfg.host.log("调用失败 sk-abc123def456ghi789 请重试");
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", {
      type: "log",
      text: "调用失败 sk-[REDACTED] 请重试",
    });

    cb.onTaskStatus("t1", "running", 2);
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", {
      type: "taskStatus",
      taskId: "t1",
      status: "running",
      attempts: 2,
    });

    const report = { ok: false, results: [] };
    cb.onVerification(report);
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", { type: "verification", report });

    cb.onEscalation("t1", "需要人工确认");
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", {
      type: "escalation",
      taskId: "t1",
      summary: "需要人工确认",
    });
  });

  it("onTaskOutcome 无 meta：事件不带多余字段（`...(meta ?? {})` 的缺省分支）", () => {
    // 引擎对没带 meta 的任务也发 outcome —— 缺省分支不走到，就没人验证
    // "没有 meta 时事件里不多出 undefined 字段"这个形状。
    buildEngine("p-nometa");
    const cb = lastPlatformConfig().host.callbacks;
    cb.onTaskOutcome("t1", true, "digest");
    expect(win.webContents.send).toHaveBeenLastCalledWith("ox:event", {
      type: "taskOutcome",
      taskId: "t1",
      ok: true,
      logDigest: "digest",
    });
  });

  it("journal.save 把快照写进该项目的日志（按 projectId 分，不串号）", () => {
    buildEngine("p-journal");
    // `journal` 是 createPlatform 配置的**顶层**字段（context.ts:278），
    // 而 `log` 在 host 上 —— 这两个不在同一层，写错会拿到 undefined。
    const journal = lastPlatformConfig().journal;
    expect(journal).toBeDefined();

    const snapshot = { phase: "stage", projectId: "p-journal" } as never;
    expect(() => journal.save(snapshot)).not.toThrow();

    // 写盘本身由 writeJournal 的测试守着；这里守的是"闭包接到了它，并且绑对了
    // projectId"——绑错项目会让一个项目的快照覆盖另一个项目的（文件名就是 id）。
    // 路径来自 context.ts:67 `journalDir()` = userData/runs，文件名 `${id}.json`。
    const file = path.join(tmp, "runs", "p-journal.json");
    expect(fs.existsSync(file), `journal.save 应写到 ${file}`).toBe(true);
    expect(fs.existsSync(path.join(tmp, "runs", "other.json"))).toBe(false);
  });

  it("onStage 同时更新 store、审计流和渲染进程（三处都不能少）", () => {
    const store = inst(h.projectInstances);
    buildEngine("p-stage");
    lastPlatformConfig().host.callbacks.onStage("IMPLEMENTING");

    expect(store.update).toHaveBeenCalledWith("p-stage", { stage: "IMPLEMENTING" });
    // 少了 send 就是"重启后看板空白"，少了 audit 就是"恢复不出进度"
    expect(win.webContents.send).toHaveBeenCalledWith("ox:event", { type: "stage", stage: "IMPLEMENTING" });
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
    // 第四个参数是续跑状态：没有快照时 `execute` 只收到 `{ smoke }`
    // （`opts.resume` 缺席 —— 不是显式 undefined，见 startProjectRun）。
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

  /**
   * 桌面断点续跑（2026-10-25）：journal 从 2026-09-19 起每批都落盘，却**从来没被读回**
   * —— `execute` 只收到 `{ smoke }`，`ResumeState` 在桌面侧永远是 undefined。
   * 于是长 run 被强杀 / 关窗之后，规划重做、已完成批次重做。这一组用例钉的是
   * "读回来"这条路：什么时候续、什么时候绝不续。
   */
  describe("桌面断点续跑（journal 读回）", () => {
    function seedJournal(projectId: string, requirement: string, snapshot: Record<string, unknown>): void {
      setJournalRequirement(requirement);
      try {
        writeJournal(projectId, snapshot as never);
      } finally {
        setJournalRequirement(undefined);
      }
    }

    const plan = [[task({ id: "t1" })]];
    const realSnapshot = {
      batches: plan,
      allDone: ["t1"],
      skipped: [],
      attempts: {},
      round: 1,
      extraRounds: 0,
      lastDigest: "红过",
    };

    it("有快照且需求没变 ⇒ 续跑：用快照里的 batches、带上 resume、跑完清掉快照", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-resume",
        requirement: "需求甲",
        // 项目记录里的计划**故意与快照不同**：续跑必须用快照里的那一份，
        // 用当前记录会"上次跑到哪"与"这次跑什么"错配。
        batchesJson: JSON.stringify([[task({ id: "t-current" })]]),
      });
      seedJournal("p-resume", "需求甲", realSnapshot);
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-resume");

      expect(h.execute).toHaveBeenCalledTimes(1);
      const [batches, , opts] = (h.execute as Mock).mock.calls[0] as [
        Task[][],
        string,
        { smoke?: unknown; resume?: { allDone: string[]; round: number } },
      ];
      expect(batches).toEqual(plan); // 快照里的，不是记录里的
      expect(opts.resume).toMatchObject({ allDone: ["t1"], round: 1 });
      // 跑完就清：留着它下一次会拿"已全部完成"的旧快照再跑一遍（看着成功、其实空转）。
      expect(readJournal("p-resume").kind).toBe("absent");
    });

    it("快照属于**另一份需求** ⇒ 绝不续（宁可重跑）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-mismatch",
        requirement: "新需求",
        batchesJson: JSON.stringify(plan),
      });
      // 快照是旧需求写下的。
      seedJournal("p-mismatch", "旧需求", realSnapshot);
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-mismatch");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: unknown }];
      expect(opts.resume).toBeUndefined();
      // 旧快照留着（不清）：下一次如果需求改回去，还能续。
      expect(readJournal("p-mismatch").kind).toBe("resumable");
    });

    it("快照损坏 ⇒ 按全新运行处理，并说破（不静默当成没有）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-corrupt",
        requirement: "需求甲",
        batchesJson: JSON.stringify(plan),
      });
      fs.mkdirSync(path.join(tmp, "runs"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "runs", "p-corrupt.json"), "{ broken", "utf8");
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-corrupt");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: unknown }];
      expect(opts.resume).toBeUndefined();
      const sent = win.webContents.send as unknown as Mock;
      const logs = sent.mock.calls
        .filter((c) => (c[1] as { type?: string }).type === "log")
        .map((c) => (c[1] as { text: string }).text);
      expect(logs.some((l) => l.includes("[journal]") && l.includes("解析失败"))).toBe(true);
    });

    it("快照刚写下第一笔（一批都没跑）⇒ 不当作'恢复'（续不续都一样）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-fresh",
        requirement: "需求甲",
        batchesJson: JSON.stringify(plan),
      });
      seedJournal("p-fresh", "需求甲", {
        batches: plan,
        allDone: [],
        skipped: [],
        attempts: {},
        round: 0,
        extraRounds: 0,
        lastDigest: "",
      });
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-fresh");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: unknown }];
      expect(opts.resume).toBeUndefined();
      // 没到"恢复"那一步，就不该播报"断点续跑"（播报会让人以为上次跑过东西）。
      const sent = win.webContents.send as unknown as Mock;
      const logs = sent.mock.calls
        .filter((c) => (c[1] as { type?: string }).type === "log")
        .map((c) => (c[1] as { text: string }).text);
      expect(logs.some((l) => l.includes("断点续跑"))).toBe(false);
    });

    it("round=0 但已有完成的任务 ⇒ 仍然续跑（判据是「一批都没跑」，不是「round=0」）", async () => {
      // 两个条件必须**同时**成立才算"刚写下第一笔"。只看 round 会把"第一批已跑完、
      // 但轮次还是 0"的现场判成新 run，已完成的任务白跑一遍。
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-round0",
        requirement: "需求甲",
        batchesJson: JSON.stringify([[task({ id: "t-other" })]]),
      });
      seedJournal("p-round0", "需求甲", {
        batches: plan,
        allDone: ["t1"],
        skipped: [],
        attempts: {},
        round: 0,
        extraRounds: 0,
        lastDigest: "",
      });
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-round0");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: unknown }];
      expect(opts.resume).toBeDefined();
    });

    it("快照没有 smoke ⇒ resume 里也不带 smoke（不塞一个 undefined 进去）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-nosmoke",
        requirement: "需求甲",
        batchesJson: JSON.stringify(plan),
      });
      seedJournal("p-nosmoke", "需求甲", {
        batches: plan,
        allDone: ["t1"],
        skipped: [],
        attempts: {},
        round: 1,
        extraRounds: 0,
        lastDigest: "",
      });
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-nosmoke");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: object }];
      // `smoke: undefined` 与"没有 smoke 这个键"在执行期行为一致，但在断言/序列化里
      // 是两件事 —— 快照里没有的东西不该被凭空造出来。
      expect(opts.resume).toBeDefined();
      expect("smoke" in opts.resume!).toBe(false);
    });

    it("没有快照 ⇒ 行为与以前逐字一致（不传 resume）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-nosnap",
        requirement: "需求甲",
        batchesJson: JSON.stringify(plan),
      });
      h.execute.mockResolvedValue(undefined);

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-nosnap");

      const [, , opts] = (h.execute as Mock).mock.calls[0] as [Task[][], string, { resume?: unknown }];
      expect(opts.resume).toBeUndefined();
    });

    it("run 收尾后 journal 需求被清空（不把 A 项目的需求带进 B 项目的快照）", async () => {
      const store = inst(h.projectInstances);
      (store.get as Mock).mockReturnValue({
        id: "p-clean",
        requirement: "需求甲",
        batchesJson: JSON.stringify(plan),
      });
      h.execute.mockImplementationOnce(async () => {
        // run 进行中写一笔快照 —— 外壳里应该是这个项目的需求。
        writeJournal("p-clean", realSnapshot as never);
      });

      await (h.ipcMain as FakeIpcMain).invoke("orchestration:start", "p-clean");
      const during = JSON.parse(fs.readFileSync(path.join(tmp, "runs", "p-clean.json"), "utf8")) as {
        requirement?: string;
      };
      expect(during.requirement).toBe("需求甲");

      // 收尾之后（run 已结束）再有一笔写入：外壳里不该再有"需求甲"。
      writeJournal("p-clean", realSnapshot as never);
      const after = JSON.parse(fs.readFileSync(path.join(tmp, "runs", "p-clean.json"), "utf8")) as {
        requirement?: string;
      };
      expect("requirement" in after).toBe(false);
    });
  });

  it("ensureWorkspace 幂等：脚手架已存在时不重写（重复 start 不冲掉手改内容）", () => {    // 二次调用走的是 `if (!fs.existsSync(pkg))` / `if (!fs.existsSync(file))`
    // 的 **else 分支** —— 头一次 start 只验证"写出来了"，没验证"第二次别再动"。
    // 幂等不是礼貌：智能体在项目里手改的 build.js / package.json，重跑一轮就被
    // 冲回模板，验证判据就跟这次会话的实际约定脱钩了。
    const root = ensureWorkspace("p-idem");
    const pkgPath = path.join(root, "package.json");
    const buildPath = path.join(root, "ox-scripts", "build.js");
    const pkgBefore = fs.readFileSync(pkgPath, "utf8");
    const buildBefore = fs.readFileSync(buildPath, "utf8");

    // 模拟"上一轮之后被人动过"：故意改掉 package.json 的 name，重跑必须保留
    fs.writeFileSync(pkgPath, pkgBefore.replace('"name": "ox-p-idem"', '"name": "ox-renamed"'), "utf8");

    const again = ensureWorkspace("p-idem");
    expect(again).toBe(root);
    expect(fs.readFileSync(pkgPath, "utf8")).toContain("ox-renamed");
    expect(fs.readFileSync(buildPath, "utf8")).toBe(buildBefore);
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

  it("writes board-recovery facts into the audit trail (projectId/title/stage/receipt)", async () => {
    buildEngine("p-rec");
    const config = lastPlatformConfig();
    const audit = inst(h.auditInstances);
    (audit.append as Mock).mockClear();

    // The task passed to onRunStart carries the plan's title — the one fact a
    // bare run-start otherwise lacks for board recovery.
    config.host.onRunStart("agent-x", { id: "t1", title: "登录页", zone: "src/auth" });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "run-start",
        projectId: "p-rec",
        agentId: "agent-x",
        taskId: "t1",
        title: "登录页",
        zone: "src/auth",
      }),
    );

    config.host.onRunComplete({ ok: false, errorClass: "timeout", logDigest: "boom" }, { id: "t1", zone: "src/auth" });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "run-end", projectId: "p-rec", taskId: "t1", ok: false }),
    );

    config.host.callbacks.onStage("VERIFICATION");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "stage", projectId: "p-rec", stage: "VERIFICATION" }),
    );

    const receipt = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [],
      tasks: [],
      conflicts: [],
    });
    config.host.callbacks.onReceipt(receipt);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "receipt", projectId: "p-rec", receipt }),
    );
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

  it("delivers an approval decision to the parked resolver (P2-3)", async () => {
    // The positive twin of the ghost guard in ipc.test.ts. Without it the
    // `return true` in resolveApproval is never observed: flipping it to
    // `false` would still leave every test green because the only other path
    // throws before reaching it.
    buildEngine("p-approval");
    const host = lastPlatformConfig().host;
    const parked: Promise<boolean> = host.requestApproval("rm", ["-rf", "dist"]);

    // The requestId is minted per call (seq + clock), so read it back off the
    // event the host actually sent rather than guessing the format.
    const sent = win.webContents.send.mock.calls.map((c) => c[1] as Record<string, unknown>);
    const request = sent.find((p) => p.type === "approval-request")!;
    expect(request).toMatchObject({ command: "rm", args: ["-rf", "dist"] });

    expect(
      (h.ipcMain as FakeIpcMain).invoke("orchestration:approval-decide", request.requestId, true),
    ).toBe(true);
    await expect(parked).resolves.toBe(true);
  });

  it("aborts every parked approval as denied when the run is cancelled (P2-3)", async () => {
    // fail-closed 最后一环：无人再能回答的审批按拒绝收尾，不能永远挂住 run。
    buildEngine("p-approval-cancel");
    const host = lastPlatformConfig().host;
    const parked: Promise<boolean> = host.requestApproval("git", ["push", "--force"]);

    (h.ipcMain as FakeIpcMain).invoke("orchestration:cancel");
    await expect(parked).resolves.toBe(false);
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
      conflicts: [{ kind: "overlap", paths: ["src/a.ts"], runs: ["r1"] }],
      remedies: [{ action: "skip", paths: ["src/a.ts"] }],
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "conflict", kind: "overlap", paths: ["src/a.ts"], remedy: "skip" }),
    );
    // 同一条事实也落审计：事件流是内存的，而"这轮拦下过什么"要能跨运行统计。
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "batch-guard",
        conflictKind: "overlap",
        remedy: "skip",
        paths: ["src/a.ts"],
      }),
    );
  });

  it("falls back to remedy 'none' when no remedy matches the conflict paths", () => {
    buildEngine("p-verdict2");
    const host = lastPlatformConfig().host;
    host.onVerdict({
      conflicts: [{ kind: "overlap", paths: ["src/other.ts"], runs: [] }],
      remedies: [{ action: "skip", paths: ["src/a.ts"] }],
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "conflict", remedy: "none" }),
    );
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    // 没有 run 归属时 detail 这个键也不出现（审计契约：缺失 !== 空串）。
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "batch-guard", remedy: "none" }),
    );
    expect(audit.append).not.toHaveBeenCalledWith(expect.objectContaining({ detail: undefined }));
  });

  it("persists the delivery receipt on the project and pushes it to the board", () => {
    buildEngine("p-receipt");
    const callbacks = lastPlatformConfig().host.callbacks;
    const receipt = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      tasks: [],
      conflicts: [],
    });
    callbacks.onReceipt(receipt);

    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "receipt", receipt: expect.objectContaining({ outcome: "delivered" }) }),
    );
    // 落盘一份：窗口重载后"上次交付了什么"仍然看得到，而日志是内存的。
    const store = h.projectInstances[h.projectInstances.length - 1] as { update: Mock };
    expect(store.update).toHaveBeenCalledWith("p-receipt", expect.objectContaining({
      receiptJson: JSON.stringify(receipt),
    }));
  });

  it("pushes line health (cooldown + rate-limit tally) to the board", () => {
    // 冷却表此前只活在故障转移客户端内部，界面没有出口 —— 这条钉住平台把
    // 它推给宿主这件事（字段，不是一行给人看的话）。
    buildEngine("p-lines");
    const host = lastPlatformConfig().host;
    expect(host.onLineHealth).toBeTypeOf("function");
    const lines = [
      { key: "sensenova:SENSENOVA_API_KEY#0", cooling: true, remainingMs: 5_000, failures: 2, rateLimitHits: 1 },
    ];
    host.onLineHealth!(lines);
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "line-health", lines }),
    );
  });

  it("pushes the run's token usage to the board as its own event", () => {
    // 用量走独立事件而不是日志行：看板要的是**字段**（`calls - measuredCalls`
    // 决定这份数字可信到什么程度），而平台默认实现只落一行 `[usage] …`。
    buildEngine("p-usage");
    const callbacks = lastPlatformConfig().host.callbacks;
    const snapshot = {
      totalTokens: 42,
      calls: 3,
      measuredCalls: 1,
      byModel: { "ollama/qwen2.5:14b": 42 },
    };
    callbacks.onUsage(snapshot);
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "usage", totalTokens: 42, calls: 3, measuredCalls: 1 }),
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

  it("writeJournal 把当前需求写进外壳（续跑靠它判'这份进度属于哪份需求'）", () => {
    setJournalRequirement("需求甲");
    try {
      writeJournal("p-j3", { batches: [["t1"]] } as never);
      const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "runs", "p-j3.json"), "utf8")) as {
        requirement?: string;
      };
      expect(parsed.requirement).toBe("需求甲");
    } finally {
      setJournalRequirement(undefined);
    }
  });

  it("writeJournal 没有当前需求时不写这个键（不写 undefined，也不写空串）", () => {
    setJournalRequirement(undefined);
    writeJournal("p-j4", { batches: [] } as never);
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, "runs", "p-j4.json"), "utf8")) as {
      requirement?: string;
    };
    expect("requirement" in parsed).toBe(false);
  });

  it("readJournal：缺席 / 坏 JSON / 缺 batches 各报各的（不一律当'没有'）", () => {
    expect(readJournal("p-absent")).toEqual({ kind: "absent" });

    fs.mkdirSync(path.join(tmp, "runs"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "runs", "p-bad.json"), "{ not json", "utf8");
    expect(readJournal("p-bad").kind).toBe("corrupted");

    // 有 snapshot 但没有 batches：恢复不了批次，按损坏处理（headless 同一判据）。
    fs.writeFileSync(
      path.join(tmp, "runs", "p-nobatches.json"),
      JSON.stringify({ snapshot: { allDone: [] } }),
      "utf8",
    );
    expect(readJournal("p-nobatches").kind).toBe("corrupted");
  });

  it("readJournal 读回快照外壳里的需求", () => {
    setJournalRequirement("需求乙");
    try {
      writeJournal("p-j5", { batches: [["t1"]], allDone: ["t1"], round: 1 } as never);
    } finally {
      setJournalRequirement(undefined);
    }
    const read = readJournal("p-j5");
    expect(read.kind).toBe("resumable");
    if (read.kind === "resumable") {
      expect(read.requirement).toBe("需求乙");
      expect(read.snapshot.allDone).toEqual(["t1"]);
    }
  });

  it("clearJournal 清掉快照；没有快照时也不抛（卫生动作不制造故障）", () => {
    setJournalRequirement("需求丙");
    try {
      writeJournal("p-j6", { batches: [], allDone: ["t1"], round: 1 } as never);
    } finally {
      setJournalRequirement(undefined);
    }
    expect(readJournal("p-j6").kind).toBe("resumable");

    clearJournal("p-j6");
    expect(readJournal("p-j6").kind).toBe("absent");

    // 再清一次：不存在的文件不该让收尾路径抛错。
    expect(() => clearJournal("p-j6")).not.toThrow();
    expect(() => clearJournal("p-never-existed")).not.toThrow();
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
    const base = {
      llmProvider: "sensenova",
      llmPool: [],
      arbitration: "skip",
    };
    (settings.load as Mock).mockReturnValue({ ...base, agentRouter: false });
    const before = h.createAgentLayerFn.mock.calls.length;
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    // Two list calls with one signature → exactly one rebuild; the cache is
    // what lets runtime-registered agents survive engine rebuilds.
    expect(h.createAgentLayerFn.mock.calls.length - before).toBe(1);
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(expect.objectContaining({ enableRouter: false }));

    // 旧 settings 没有 agentRouter 时 enableRouter 仍是 true，与显式 true 同义；
    // signature 必须把它们归一成同一个值，否则升级后会白重建一次 layer。
    (settings.load as Mock).mockReturnValue({ ...base, agentRouter: true });
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    const afterTrue = h.createAgentLayerFn.mock.calls.length;
    (settings.load as Mock).mockReturnValue({ ...base, agentRouter: undefined });
    (h.ipcMain as FakeIpcMain).invoke("agents:list");
    expect(h.createAgentLayerFn.mock.calls.length).toBe(afterTrue);
  });

  it("执行器超时进了 layer 的缓存 signature —— 改了会重建，不改则复用", () => {
    // 这条防的是一个很隐蔽的失效：agent layer 是**缓存的单例**，而适配器在构造时
    // 就把 timeoutMs 存成了字段。signature 里漏掉这个字段的话，设置页改了超时、
    // layer 却是旧的 —— 界面上有输入框，实际改不动。
    const base: ProjectSettings = { ...DEFAULT_SETTINGS };
    const before = h.createAgentLayerFn.mock.calls.length;

    ensureAgentLayer({ ...base, executorTimeoutMs: 45_000 });
    const mid = h.createAgentLayerFn.mock.calls.length;
    expect(mid - before).toBe(1);
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(expect.objectContaining({ executorTimeoutMs: 45_000 }));

    ensureAgentLayer({ ...base, executorTimeoutMs: 45_000 });
    expect(h.createAgentLayerFn.mock.calls.length).toBe(mid); // 同 signature → 复用

    ensureAgentLayer({ ...base, executorTimeoutMs: 60_000 });
    expect(h.createAgentLayerFn.mock.calls.length - mid).toBe(1); // 值变了 → 重建
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(expect.objectContaining({ executorTimeoutMs: 60_000 }));
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

describe("buildPlatformLayer · 桌面侧三字段（P1-5 补齐）", () => {
  it("manifestDir / snapshotRoot 进了 layer 的缓存 signature —— 改了重建，不改复用", () => {
    // 与 executorTimeoutMs 同理的失效面：agent layer 是**缓存的单例**，SnapshotStore
    // 与清单加载器在构造时就把根目录存成字段。signature 里漏掉这两个值的话，
    // 设置页改了路径、layer 还是旧的 —— 界面上有输入框，实际改不动。
    const base = { ...DEFAULT_SETTINGS };
    const mid = h.createAgentLayerFn.mock.calls.length;

    ensureAgentLayer({ ...base, manifestDir: "D:/custom-agents.d", snapshotRoot: "D:/custom-snaps" });
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(
      expect.objectContaining({ manifestDir: "D:/custom-agents.d", snapshotRoot: "D:/custom-snaps" }),
    );
    const after = h.createAgentLayerFn.mock.calls.length;
    expect(after).toBeGreaterThan(mid);

    ensureAgentLayer({ ...base, manifestDir: "D:/custom-agents.d", snapshotRoot: "D:/custom-snaps" });
    expect(h.createAgentLayerFn.mock.calls.length).toBe(after); // 同 signature → 复用

    ensureAgentLayer({ ...base, manifestDir: "D:/other-agents.d", snapshotRoot: "D:/custom-snaps" });
    expect(h.createAgentLayerFn.mock.calls.length - after).toBe(1); // 值变了 → 重建
  });

  it("空串与省略都回退内置默认路径", () => {
    ensureAgentLayer({ ...DEFAULT_SETTINGS, manifestDir: "", snapshotRoot: "" });
    expect(h.createAgentLayerFn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        manifestDir: path.join(tmp, "agents.d"),
        snapshotRoot: path.join(tmp, "snapshots"),
      }),
    );
  });

  it("buildPlatformLayer 把自定义路径传给平台层", () => {
    h.createPlatformCalls.length = 0;
    buildPlatformLayer(
      { ...DEFAULT_SETTINGS, manifestDir: "D:/m", snapshotRoot: "D:/s" },
      { log: () => {} },
    );
    expect(lastPlatformConfig()).toMatchObject({ manifestDir: "D:/m", snapshotRoot: "D:/s" });
  });

  it("默认（ask）升级决策挂起等人，resolveEscalation 能解", async () => {
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS }, { log: () => {} });
    const host = lastPlatformConfig().host;
    const pending = host.requestEscalationDecision("t-ask", "summary");
    expect(resolveEscalation("t-ask", "skip")).toBe(true);
    await expect(pending).resolves.toBe("skip");
  });

  it("skip / abort 策略自动决策且不进弹窗队列", async () => {
    buildPlatformLayer({ ...DEFAULT_SETTINGS, escalationPolicy: "skip" }, { log: () => {} });
    const host = lastPlatformConfig().host;
    await expect(host.requestEscalationDecision("t1", "s")).resolves.toBe("skip");
    expect(resolveEscalation("t1", "skip")).toBe(false); // 没东西挂起 —— 无需人答

    buildPlatformLayer({ ...DEFAULT_SETTINGS, escalationPolicy: "abort" }, { log: () => {} });
    const host2 = lastPlatformConfig().host;
    await expect(host2.requestEscalationDecision("t1", "s")).resolves.toBe("abort");
    expect(resolveEscalation("t1", "abort")).toBe(false);
  });

  it("redispatch_once 每任务只自动重派一次，再次升级自动终止；账本按任务隔离", async () => {
    buildPlatformLayer(
      { ...DEFAULT_SETTINGS, escalationPolicy: "redispatch_once" },
      { log: () => {} },
    );
    const host = lastPlatformConfig().host;
    await expect(host.requestEscalationDecision("t1", "s")).resolves.toBe("redispatch");
    // 与 CLI 的 redispatch_once 同义：第二次升级自动终止 —— 承诺的就是只重派一次。
    await expect(host.requestEscalationDecision("t1", "s")).resolves.toBe("abort");
    await expect(host.requestEscalationDecision("t1", "s")).resolves.toBe("abort");
    // 账本按任务记：别的任务的第一次升级照样拿到 redispatch。
    await expect(host.requestEscalationDecision("t2", "s")).resolves.toBe("redispatch");
  });

  it("exhaust 决策回调整个缺席（引擎随后把预算耗尽报成结构化错误）", () => {
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS, escalationPolicy: "exhaust" }, { log: () => {} });
    expect(lastPlatformConfig().host.requestEscalationDecision).toBeUndefined();
  });
});

/**
 * 取消时"把挂起的人_answer_ 全部收尾"是 fail-closed 的最后一环。
 *
 * 为什么这组用例以前不存在：`ipc.test.ts` 只钉了 ghost 路径
 * （"对不存在的任务作答要抛错"），而挂起**存在**时 cancel 会不会真的把
 * promise 收掉、收成什么值，一条断言都没有。生产上这条路是
 * `orchestration:cancel` → `abortAllEscalations`/`abortAllApprovals`
 * （`electron/ipc/orchestration.ts:211/214`），也就是"窗口被关掉 / 用户按停"
 * 之后 run 能不能观察到取消 —— 观察不到就是永久挂死。
 *
 * 反面后果是不对称的，所以两个方向都要钉：
 * - escalation 收成 `"abort"`：任务按"人已放弃"收尾，而不是伪装成
 *   `"redispatch"` 继续烧 token；
 * - approval 收成 `false`：**命令不许跑**。收成 true 等于无人应答时
 *   自动放行一条 `rm -rf`。
 */
describe("cancel 收尾挂起的人_answer_ 通道（fail-closed）", () => {
  /** 挂起一个 escalation，返回它的 promise 与宿主回调。 */
  function parkEscalation(taskId: string): { promise: Promise<string>; host: any } {
    h.createPlatformCalls.length = 0;
    // 只有 "ask" 会 park；其余四态在回调里就地 resolve，不进 pendingEscalations。
    buildPlatformLayer({ ...DEFAULT_SETTINGS, escalationPolicy: "ask" }, { log: () => {} });
    const host = lastPlatformConfig().host;
    return { promise: host.requestEscalationDecision(taskId, "验证失败"), host };
  }

  it("abortAllEscalations 把挂起的决策收成 abort（不是 redispatch）", async () => {
    const { promise } = parkEscalation("t-cancel");
    // 先证明它真的挂起了：未被 abort 前不得有结论。
    let settled = false;
    void promise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    abortAllEscalations();
    // 判据是"值"不只是"结束了"：abort 与 redispatch/skip 的后果完全不同。
    await expect(promise).resolves.toBe("abort");
  });

  it("abortAllEscalations 收尾后不留残渣：再答一次必须是 ghost", async () => {
    parkEscalation("t-clean");
    abortAllEscalations();
    // map 被 clear 过 —— 否则这里会 true，说明"收尾"只 resolve 没删除，
    // 同一个 taskId 之后会被第二次决策误当成还挂着。
    expect(resolveEscalation("t-clean", "skip")).toBe(false);
  });

  it("abortAllEscalations 一次收掉多条挂起，不只第一条", async () => {
    const a = parkEscalation("t-a");
    const b = parkEscalation("t-b");
    const c = parkEscalation("t-c");
    abortAllEscalations();
    // 逐条 resolve 而非只 resolve 第一条 —— 少一条就意味着那个 run 永久挂死。
    await expect(a.promise).resolves.toBe("abort");
    await expect(b.promise).resolves.toBe("abort");
    await expect(c.promise).resolves.toBe("abort");
  });

  it("abortAllApprovals 把挂起的审批收成拒绝（fail-closed：命令不许跑）", async () => {
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS }, { log: () => {} });
    const host = lastPlatformConfig().host;
    // 真实的审批请求通道，参数取生产上会命中的形状。
    const promise = host.requestApproval("rm", ["-rf", "dist"]);
    let settled = false;
    void promise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    abortAllApprovals();
    // 关键判据：必须是 false。true 等于"没人应答就放行破坏性命令"。
    await expect(promise).resolves.toBe(false);
  });

  it("abortAllApprovals 收尾后不留残渣：再答一次必须是 ghost", async () => {
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS }, { log: () => {} });
    const host = lastPlatformConfig().host;
    void host.requestApproval("npm", ["publish"]);
    // requestId 是生成式的（`a-<seq>-<ts>`），不能硬编码 —— 从事件里读回来。
    const sent = (win.webContents.send as Mock).mock.calls
      .map((c) => c[1] as { type?: string; requestId?: string })
      .filter((e) => e.type === "approval-request");
    const requestId = inst(sent).requestId!;

    abortAllApprovals();
    expect(resolveApproval(requestId, true)).toBe(false);
  });

  it("cancel 一次把 escalation 与 approval 两条通道都收掉", async () => {
    // 两条通道是同一个 `orchestration:cancel` 的两份职责，分开测会漏掉
    // "只收了一条"的回归 —— 那正是挂死最常见的形态。
    const esc = parkEscalation("t-both");
    h.createPlatformCalls.length = 0;
    buildPlatformLayer({ ...DEFAULT_SETTINGS }, { log: () => {} });
    const approval = lastPlatformConfig().host.requestApproval("git", ["push"]);

    (h.ipcMain as FakeIpcMain).invoke("orchestration:cancel");
    await expect(esc.promise).resolves.toBe("abort");
    await expect(approval).resolves.toBe(false);
  });
});

describe("交付凭据复核（receipt:verify · 欠账 #7）", () => {
  const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

  /** 一份带命令、已盖章的凭据 —— 可复跑这一格必须有东西，否则测的是"没命令"那条路径。 */
  function sealedReceipt(overrides: Partial<Parameters<typeof buildReceipt>[0]> = {}): any {
    return sealReceipt(
      buildReceipt({
        outcome: "delivered",
        verified: true,
        rounds: 0,
        checks: [
          { kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "", command: "node", args: ["ox-scripts/test.js"] },
        ],
        tasks: [{ id: "t1", title: "t1", zone: "src/**", attempts: 1, status: "done" as const }],
        conflicts: [],
        ...overrides,
      }),
      sha256,
    );
  }

  function withReceipt(receipt: unknown): void {
    (inst(h.projectInstances).get as Mock).mockReturnValue({
      id: "p1",
      stage: "DONE",
      receiptJson: JSON.stringify(receipt),
    });
  }

  const invoke = (...args: unknown[]) =>
    (h.ipcMain as FakeIpcMain).invoke("receipt:verify", ...(args as [])) as Promise<ReceiptVerifyResult>;

  it("拒绝复核一个不存在的项目", async () => {
    await expect(invoke("ghost")).rejects.toThrow(/project ghost not found/);
    expect(h.verifyCommands).not.toHaveBeenCalled();
  });

  it("没有凭据时说清「跑完一次才会有」，而不是报一个空裁决", async () => {
    (inst(h.projectInstances).get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    await expect(invoke("p1")).rejects.toThrow(/还没有交付凭据/);
  });

  it("凭据本身读不出来时如实报坏，不静默当成「没凭据」", async () => {
    (inst(h.projectInstances).get as Mock).mockReturnValue({ id: "p1", receiptJson: "{ 不是 JSON" });
    await expect(invoke("p1")).rejects.toThrow(/读不出来/);
  });

  it("默认模式只查完整性 —— 一条命令都不执行", async () => {
    withReceipt(sealedReceipt());
    const res = await invoke("p1");
    // 指纹一致 ≠ 结论为真：没复跑就必须停在 not-replayed，报 verified 是撒谎。
    expect(res.audit.verdict).toBe("not-replayed");
    expect(res.replayed).toBe(false);
    expect(res.commands).toEqual([{ kind: "test", command: "node", args: ["ox-scripts/test.js"] }]);
    expect(h.verifyCommands).not.toHaveBeenCalled();
  });

  it("显式 replay 才真的跑，且跑的是凭据里的命令、落在项目工作区", async () => {
    withReceipt(sealedReceipt());
    h.verifyCommands.mockResolvedValue({
      results: [{ kind: "test", ok: true, exitCode: 0, logDigest: "", durationMs: 12 }],
    });
    const res = await invoke("p1", { replay: true });
    expect(res.replayed).toBe(true);
    expect(res.audit.verdict).toBe("verified");
    expect(res.audit.comparisons[0]).toMatchObject({ kind: "test", verdict: "reproduced" });
    expect(h.verifyCommands).toHaveBeenCalledWith(
      [{ kind: "test", command: "node", args: ["ox-scripts/test.js"] }],
      workspaceRoot("p1"),
    );
  });

  it("复跑与凭据矛盾时判 contradicted —— 不把矛盾粉饰成复现", async () => {
    withReceipt(sealedReceipt());
    h.verifyCommands.mockResolvedValue({
      results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 3 }],
    });
    const res = await invoke("p1", { replay: true });
    expect(res.audit.verdict).toBe("contradicted");
    expect(res.audit.comparisons[0]).toMatchObject({ claimed: true, observed: false });
  });

  it("指纹被改过时连命令都不跑 —— 比出来的「矛盾」是伪证的产物", async () => {
    const receipt = sealedReceipt();
    receipt.checks[0].ok = false; // 改内容但不重算指纹 ⇒ mismatch
    withReceipt(receipt);
    const res = await invoke("p1", { replay: true });
    expect(res.audit.verdict).toBe("tampered");
    expect(res.replayed).toBe(false);
    expect(h.verifyCommands).not.toHaveBeenCalled();
  });

  it("没盖章的凭据不复跑（比对结果会被整档丢掉，跑了是白跑副作用）", async () => {
    const receipt = sealedReceipt();
    delete receipt.fingerprint;
    withReceipt(receipt);
    const res = await invoke("p1", { replay: true });
    expect(res.audit.verdict).toBe("unsigned");
    expect(h.verifyCommands).not.toHaveBeenCalled();
  });

  it("凭据不经过任何命令时，replay 也没有东西可跑（不是「能跑但不想跑」）", async () => {
    withReceipt(
      sealedReceipt({
        checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
      }),
    );
    const res = await invoke("p1", { replay: true });
    expect(res.commands).toEqual([]);
    expect(res.replayed).toBe(false);
    expect(res.audit.verdict).toBe("not-replayed");
    expect(h.verifyCommands).not.toHaveBeenCalled();
  });

  it("复跑走的是平台层那一道门（不是自己另装一套策略）", async () => {
    withReceipt(sealedReceipt());
    h.verifyCommands.mockResolvedValue({ results: [] });
    await invoke("p1", { replay: true });
    // 平台是现建的：命令的沙箱白名单 / 审批门 / 超时都挂在它身上，
    // 这里只钉住「复跑真的经过了平台」这件事本身。
    expect(h.createPlatformCalls.length).toBeGreaterThan(0);
  });
});

describe("changes handlers（diff 面板供数，竞品缺口 B1）", () => {
  it("changes:list 按项目过滤 batch-changes 记录，最新在前", () => {
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockReturnValue([
      { phase: "batch-changes", ts: "2026-10-17T01:00:00Z", projectId: "p-other", changed: 1 },
      {
        phase: "batch-changes",
        ts: "2026-10-17T02:00:00Z",
        projectId: "p-1",
        changed: 2,
        files: [
          { path: "src/b.js", op: "modify", bytes: 10 },
          { path: "src/c.js", op: "delete" },
        ],
      },
      { phase: "run-start", ts: "2026-10-17T00:00:00Z" },
    ]);
    const out = (h.ipcMain as FakeIpcMain).invoke("changes:list", "p-1") as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!.files).toEqual([
      { path: "src/b.js", op: "modify", bytes: 10 },
      { path: "src/c.js", op: "delete" },
    ]);
  });

  it("changes:list 无项目过滤时把最新批次排最前", () => {
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockReturnValue([
      { phase: "batch-changes", ts: "2026-10-17T01:00:00Z", changed: 1 },
      { phase: "batch-changes", ts: "2026-10-17T02:00:00Z", changed: 1 },
    ]);
    const out = (h.ipcMain as FakeIpcMain).invoke("changes:list") as Array<{ ts: string }>;
    expect(out.map((r) => r.ts)).toEqual(["2026-10-17T02:00:00Z", "2026-10-17T01:00:00Z"]);
  });

  it("onVerdict 把批次改动落成 batch-changes 审计：clean 批也落、files 带 op", () => {
    buildEngine("p-changes");
    const host = lastPlatformConfig().host;
    host.onVerdict({ conflicts: [], remedies: [] }, { changes: [{ path: "src/a.js", op: "create", bytes: 7 }] });
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "batch-changes",
        changed: 1,
        files: [{ path: "src/a.js", op: "create", bytes: 7 }],
      }),
    );
  });

  it("onVerdict 的 files 超 100 条时截断并写 filesTotal", () => {
    buildEngine("p-changes-overflow");
    const host = lastPlatformConfig().host;
    const many = Array.from({ length: 130 }, (_, i) => ({ path: `f/${i}.js`, op: "modify", bytes: i }));
    host.onVerdict({ conflicts: [], remedies: [] }, { changes: many });
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    const call = (audit.append as Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as { phase?: string }).phase === "batch-changes",
    ) as unknown as [{ files: unknown[]; filesTotal?: number; changed: number }];
    expect(call[0].files).toHaveLength(100);
    expect(call[0].filesTotal).toBe(130);
    expect(call[0].changed).toBe(130);
  });

  it("scope 缺席（无 guard 的装配）不编一条空记录", () => {
    buildEngine("p-changes-noscope");
    const host = lastPlatformConfig().host;
    host.onVerdict({ conflicts: [], remedies: [] });
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    expect(audit.append).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "batch-changes" }));
  });

  it("onVerdict 把 scope.archiveId 落进审计（diff 与单文件回滚的供数键）", () => {
    buildEngine("p-changes-arch");
    const host = lastPlatformConfig().host;
    host.onVerdict(
      { conflicts: [], remedies: [] },
      { changes: [{ path: "src/a.js", op: "create", bytes: 7 }], archiveId: "r-1__abc-1" },
    );
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    const call = (audit.append as Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as { phase?: string }).phase === "batch-changes",
    ) as unknown as [{ archiveId?: string }];
    expect(call[0].archiveId).toBe("r-1__abc-1");
  });

  it("scope 没有 archiveId 时审计里这个键也不出现（字段即承诺）", () => {
    buildEngine("p-changes-noarch");
    const host = lastPlatformConfig().host;
    host.onVerdict({ conflicts: [], remedies: [] }, { changes: [{ path: "src/a.js", op: "create", bytes: 7 }] });
    const audit = h.auditInstances[h.auditInstances.length - 1] as { append: Mock };
    const call = (audit.append as Mock).mock.calls.find(
      (c: unknown[]) => (c[0] as { phase?: string }).phase === "batch-changes",
    ) as unknown as [Record<string, unknown>];
    expect("archiveId" in call[0]).toBe(false);
  });
});

/**
 * 交付成果面（本次产物 + 怎么验收）：
 * `delivery:guide` 只做审计/package.json 的 IO，推导在 shared（双宿主同源）；
 * `delivery:read` 是只读预览，必须挡住越界路径与符号链接逃逸。
 */
describe("delivery handlers（本次产物 + 只读预览）", () => {
  function stubAudit(records: unknown[]) {
    ensureAudit();
    const audit = inst(h.auditInstances);
    (audit.read as Mock).mockReturnValue(records);
    return audit;
  }

  function seedWorkspace(projectId: string): string {
    const root = path.join(tmp, "workspaces", projectId);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    return root;
  }

  it("delivery:guide 从审计推导按任务分组的产物，并补上 package.json 的启动脚本", () => {
    const root = seedWorkspace("p-delivery");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }),
      "utf8",
    );
    const receipt = buildReceipt({
      outcome: "delivered",
      verified: true,
      rounds: 0,
      checks: [{ kind: "test", ok: true, exitCode: 0, preexisting: false, headline: "", command: "npm", args: ["run", "test"] }],
      tasks: [{ id: "t1", title: "接口", zone: "src", status: "done", attempts: 1 }],
      conflicts: [],
    });
    stubAudit([
      { phase: "stage", stage: "PRD", projectId: "p-delivery" },
      { phase: "run-start", taskId: "t1", title: "接口", zone: "src", projectId: "p-delivery" },
      { phase: "batch-changes", projectId: "p-delivery", files: [{ path: "src/a.js", op: "modify", bytes: 3 }] },
      { phase: "batch-changes", projectId: "p-delivery", files: [{ path: "outside.js", op: "create" }] },
      { phase: "batch-changes", projectId: "p-other", files: [{ path: "other.js", op: "create" }] },
      { phase: "receipt", projectId: "p-delivery", receipt },
    ]);

    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:guide", "p-delivery") as {
      artifacts: Array<{ taskId: string; files: Array<{ path: string }> }>;
      unassigned?: Array<{ path: string }>;
      commands: Array<{ kind: string; label: string; command: string; args: string[] }>;
      totalFiles: number;
    };
    expect(out.artifacts).toEqual([{ taskId: "t1", title: "接口", zone: "src", files: [{ path: "src/a.js", op: "modify", bytes: 3 }] }]);
    expect(out.unassigned?.map((f) => f.path)).toEqual(["outside.js"]);
    expect(out.totalFiles).toBe(2);
    expect(out.commands).toEqual([
      { kind: "verify", label: "复跑 test", command: "npm", args: ["run", "test"] },
      { kind: "start", label: "启动 · dev", command: "npm", args: ["run", "dev"] },
    ]);
  });

  it("delivery:guide 无 projectId 时不做工作区读取（package.json 缺席）", () => {
    stubAudit([{ phase: "batch-changes", files: [{ path: "src/a.js", op: "create" }] }]);
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:guide") as {
      commands: unknown[];
      unassigned?: Array<{ path: string }>;
    };
    expect(out.commands).toEqual([]);
    expect(out.unassigned?.map((f) => f.path)).toEqual(["src/a.js"]);
  });

  it("delivery:guide 对非字符串 projectId 当作未指定（不拼工作区路径）", () => {
    stubAudit([{ phase: "batch-changes", files: [{ path: "src/a.js", op: "create" }] }]);
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:guide", 42) as {
      commands: unknown[];
      unassigned?: Array<{ path: string }>;
    };
    expect(out.commands).toEqual([]);
    expect(out.unassigned?.map((f) => f.path)).toEqual(["src/a.js"]);
  });

  it("delivery:read 返回工作区内文本文件的完整内容", () => {
    const root = seedWorkspace("p-read");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.js"), "hello\nworld\n", "utf8");
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:read", "p-read", "src/a.js") as {
      ok: boolean;
      content: string;
      bytes: number;
      truncated: boolean;
      binary: boolean;
    };
    expect(out).toEqual({ ok: true, content: "hello\nworld\n", bytes: 12, truncated: false, binary: false });
  });

  it("delivery:read 对二进制文件不返回内容，只说体积", () => {
    const root = seedWorkspace("p-read-bin");
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:read", "p-read-bin", "blob.bin") as {
      ok: boolean;
      content: string;
      bytes: number;
      binary: boolean;
    };
    expect(out).toEqual({ ok: true, content: "", bytes: 3, truncated: false, binary: true });
  });

  it("delivery:read 超过 512KiB 时截断并标记", () => {
    const root = seedWorkspace("p-read-big");
    const text = "x".repeat(512 * 1024 + 17);
    fs.writeFileSync(path.join(root, "big.txt"), text, "utf8");
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:read", "p-read-big", "big.txt") as {
      ok: boolean;
      content: string;
      bytes: number;
      truncated: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.truncated).toBe(true);
    expect(out.content).toHaveLength(512 * 1024);
  });

  it("delivery:read 对已删除文件、目录、绝对路径与穿越路径都返回原因", () => {
    const root = seedWorkspace("p-read-bad");
    fs.mkdirSync(path.join(root, "dir"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "escape.txt"), "secret", "utf8");
    const invoke = (rel: string) =>
      (h.ipcMain as FakeIpcMain).invoke("delivery:read", "p-read-bad", rel) as { ok: boolean; reason?: string };
    expect(invoke("missing.txt").ok).toBe(false);
    expect(invoke("missing.txt").reason).toContain("不在工作区");
    expect(invoke("dir").reason).toContain("不是普通文件");
    expect(invoke(path.join(tmp, "escape.txt")).reason).toContain("相对路径");
    expect(invoke("../escape.txt").reason).toContain("越出工作区");
    expect(invoke("src/../../escape.txt").reason).toContain("越出工作区");
  });

  it("delivery:read 拒绝非法的 projectId / path 入参", () => {
    const invoke = (...args: unknown[]) =>
      (h.ipcMain as FakeIpcMain).invoke("delivery:read", ...args) as { ok: boolean; reason?: string };
    expect(invoke("", "a.js").reason).toContain("projectId");
    expect(invoke("p", "").reason).toContain("path");
    expect(invoke("p", 3).reason).toContain("path");
  });

  it("delivery:read 拒绝经符号链接逃出工作区的路径（POSIX）", () => {
    if (process.platform === "win32") return;
    const root = seedWorkspace("p-read-link");
    const outside = path.join(tmp, "outside-secret.txt");
    fs.writeFileSync(outside, "secret", "utf8");
    fs.symlinkSync(outside, path.join(root, "link.txt"));
    const out = (h.ipcMain as FakeIpcMain).invoke("delivery:read", "p-read-link", "link.txt") as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("符号链接");
  });
});

/**
 * 保活预览（item 2）：PreviewManager 是真实单例，这里用假 child 接管；
 * `pid` 故意留空，stop 时 killTree 会在 pid 缺失处直接返回（不碰真实进程）。
 */
describe("preview handlers（保活 dev server）", () => {
  interface FakeChild extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: undefined;
    exitCode: number | null;
    killed: boolean;
  }

  function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    child.killed = false;
    return child;
  }

  function keep(url = "http://127.0.0.1:5173/", child = fakeChild()): FakeChild {
    keepDevServer({
      title: "dev server 起得来",
      url,
      command: "node",
      args: ["server.js"],
      cwd: tmp,
      child: child as never,
      log: "boot\n",
    });
    return child;
  }

  afterEach(() => {
    stopPreview();
    // 预览窗口是模块单例状态：不收干净会漏进下一条用例（窗口数断言就失真了）。
    closePreviewWindow();
    createdWindows.length = 0;
  });

  it("preview:status 没有预览时返回 null，有预览时返回完整事实", () => {
    expect((h.ipcMain as FakeIpcMain).invoke("preview:status")).toBeNull();
    keep();
    const state = (h.ipcMain as FakeIpcMain).invoke("preview:status") as {
      url: string;
      running: boolean;
      command: string;
      log: string;
    };
    expect(state).toMatchObject({
      url: "http://127.0.0.1:5173/",
      running: true,
      command: "node",
      log: "boot\n",
    });
  });

  it("preview:open 只在应用内窗口打开管理器里那条本机 HTTP(S) 地址（profile 按项目隔离）", async () => {
    const open = (projectId?: unknown) =>
      (h.ipcMain as FakeIpcMain).invoke("preview:open", projectId) as
        | { ok: true }
        | { ok: false; reason: string };

    expect(open("p-1-1").ok).toBe(false); // 还没有可预览的服务
    expect(createdWindows).toHaveLength(0);

    keep();
    expect(open("p-1-1")).toEqual({ ok: true });
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0]!.loaded).toBe("http://127.0.0.1:5173/");
    expect(
      (createdWindows[0]!.options.webPreferences as Record<string, unknown>).partition,
    ).toBe("persist:ox-preview-p-1-1");
    // 不再交给系统浏览器：隔离要求 profile 由我们指定，外部浏览器给不了这个控制权。
    expect(shell.openExternal).not.toHaveBeenCalled();

    for (const allowed of [
      "http://localhost:5173/",
      "https://localhost:5173/",
      "http://[::1]:5173/",
    ]) {
      stopPreview();
      keep(allowed);
      expect(open("p-1-1"), allowed).toEqual({ ok: true });
    }

    for (const blockedUrl of ["https://example.com/", "file:///etc/passwd", "not-a-url"]) {
      stopPreview();
      keep(blockedUrl);
      const blocked = open("p-1-1");
      expect(blocked.ok, blockedUrl).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toContain("本机 HTTP");
      expect(shell.openExternal, blockedUrl).not.toHaveBeenCalled();
    }
  });

  it("preview:open 对已退出进程返回原因，不打开", async () => {
    const child = keep();
    child.exitCode = 1;
    child.emit("close", 1);
    expect(getPreview()!.running).toBe(false);
    const out = (h.ipcMain as FakeIpcMain).invoke("preview:open", "p-1-1") as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("已退出");
    expect(createdWindows).toHaveLength(0);
  });

  it("preview:open 缺 projectId 或 id 非法：拒绝且一个窗口都不建（不回退到共享 profile）", () => {
    keep();
    for (const bad of [undefined, "", "项目", 42]) {
      const out = (h.ipcMain as FakeIpcMain).invoke("preview:open", bad) as {
        ok: boolean;
        reason?: string;
      };
      expect(out.ok, String(bad)).toBe(false);
      if (!out.ok) expect(out.reason).toContain("项目 id");
    }
    expect(createdWindows).toHaveLength(0);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("preview:reset 清掉该项目预览 profile 的存储；id 非法时拒绝", async () => {
    const reset = (projectId: unknown) =>
      (h.ipcMain as FakeIpcMain).invoke("preview:reset", projectId) as Promise<
        { ok: true } | { ok: false; reason: string }
      >;

    expect(await reset("p-1-1")).toEqual({ ok: true });
    expect(clearedPartitions).toEqual(["persist:ox-preview-p-1-1"]);

    const bad = await reset("项目");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("项目 id");
    expect(clearedPartitions).toEqual(["persist:ox-preview-p-1-1"]);
  });

  it("preview:stop 停止并清除（连预览窗口一起收）；应用退出时也会清掉", () => {
    keep();
    (h.ipcMain as FakeIpcMain).invoke("preview:open", "p-1-1");
    expect(createdWindows).toHaveLength(1);

    expect((h.ipcMain as FakeIpcMain).invoke("preview:stop")).toBe(true);
    expect(getPreview()).toBeNull();
    expect(createdWindows[0]!.closed).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("preview:stop")).toBe(false);

    keep();
    (h.ipcMain as FakeIpcMain).invoke("preview:open", "p-1-1");
    fireAppEvent("before-quit");
    expect(getPreview()).toBeNull();
    expect(createdWindows[1]!.closed).toBe(true);
  });

  it("接线：验证器把通过冒烟的进程交给预览管理器；新引擎构建前先停旧预览", async () => {
    // 不真 spawn：假 child + 假 fetch 足够走完"探活 → 页面冒烟 → 接管"。
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const fetchImpl = (async () =>
      new Response("ok", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const results = await runSmokeChecks(
      [
        {
          title: "dev server 起得来",
          command: "node",
          args: ["server.js"],
          devServer: { url: "http://127.0.0.1:5173/", timeoutMs: 500 },
        },
      ],
      { cwd: tmp, spawnImpl, devServerFetch: fetchImpl },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.logDigest).toContain("进程保留为预览");
    expect(getPreview()!.url).toBe("http://127.0.0.1:5173/");

    // 下一轮规划/执行开始：旧预览必须先停，避免占着端口。
    buildEngine("p-preview-stop");
    expect(getPreview()).toBeNull();
  });
});

/**
 * B1 第二半：changes:file（逐行 diff）与 changes:revert（单文件回滚）。
 *
 * 这里用**真的 SnapshotStore**（临时目录）而不是替身 —— 这两个 handler 的
 * 全部价值就在"存档里真的读得到 before、回滚后盘上真的是旧内容"，mock 掉
 * store 等于把要证的东西证没了。审计（create 证据的来源）仍是替身。
 */
describe("changes:file / changes:revert（B1 第二半：diff 与单文件回滚）", () => {
  /** 造一个存档批次：before 内容先进盘，begin，再改成 after。返回 batchId 与 root。 */
  async function makeArchive(tag: string, runId: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-chg-${tag}-`));
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ox-chg-${tag}-bk-`));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.js"), "line1\nold\nline3\n", "utf8");
    const store = new SnapshotStore({ backupRoot });
    const token = await store.begin({ runId, root, zones: ["src"] });
    fs.writeFileSync(path.join(root, "src/a.js"), "line1\nnew\nline3\n", "utf8");
    const record = await store.archive(token, { runId });
    return { root, backupRoot, store, batchId: record!.id };
  }

  /** 让审计替身只认得一条带 archiveId 的 batch-changes 记录。 */
  function stubAudit(files: Array<{ path: string; op: string }>, archiveId: string) {
    // 先确保实例已经建出来：`inst(h.auditInstances)` 依赖"前面某个用例
    // 已经触发过 ensureAudit"——那是顺序依赖，`-t` 单跑时就会炸。
    ensureAudit();
    (inst(h.auditInstances).read as Mock).mockReturnValue([
      { phase: "batch-changes", ts: "2026-10-17T00:00:00Z", archiveId, files },
    ]);
  }

  afterEach(() => {
    h.layer.snapshots = undefined;
  });

  it("changes:file 返回逐行 diff：before 来自存档、after 来自盘上", async () => {
    const { store, batchId } = await makeArchive("diff", "r-chg-diff");
    h.layer.snapshots = store;
    stubAudit([{ path: "src/a.js", op: "modify" }], batchId);

    const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId, path: "src/a.js" }) as {
      ok: boolean;
      diff?: { status: string; added: number | null; deleted: number | null; lines: Array<{ kind: string; text: string }> };
    };
    expect(out.ok).toBe(true);
    expect(out.diff!.status).toBe("modified");
    expect(out.diff!.added).toBe(1);
    expect(out.diff!.deleted).toBe(1);
    expect(out.diff!.lines.map((l) => l.text)).toContain("old");
    expect(out.diff!.lines.map((l) => l.text)).toContain("new");
  });

  it("changes:file：不在存档 files 里的路径按 created 呈现（本批新建）", async () => {
    const { root, store, batchId } = await makeArchive("diff-new", "r-chg-diff-new");
    fs.writeFileSync(path.join(root, "src/brand-new.js"), "n1\nn2\n", "utf8");
    h.layer.snapshots = store;
    stubAudit([{ path: "src/brand-new.js", op: "create" }], batchId);

    const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId, path: "src/brand-new.js" }) as {
      ok: boolean;
      diff?: { status: string; added: number | null };
    };
    expect(out.ok).toBe(true);
    expect(out.diff!.status).toBe("created");
    expect(out.diff!.added).toBe(2);
  });

  it("changes:file：盘上文件已不在 ⇒ deleted（而不是当成空文件）", async () => {
    const { root, store, batchId } = await makeArchive("diff-gone", "r-chg-diff-gone");
    fs.rmSync(path.join(root, "src/a.js"), { force: true });
    h.layer.snapshots = store;
    stubAudit([{ path: "src/a.js", op: "delete" }], batchId);

    const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId, path: "src/a.js" }) as {
      ok: boolean;
      diff?: { status: string };
    };
    expect(out.diff!.status).toBe("deleted");
  });

  it("changes:file：未配置快照存储 ⇒ 明说，不装成空 diff", () => {
    h.layer.snapshots = undefined;
    const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId: "r__1", path: "src/a.js" }) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("未配置快照存储");
  });

  it("changes:file：存档不存在（被容量策略回收）⇒ 明说", () => {
    h.layer.snapshots = new SnapshotStore({ backupRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ox-chg-empty-bk-")) });
    const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId: "ghost__1", path: "src/a.js" }) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("不存在");
  });

  it("changes:file：路径穿越被拒（../ 与绝对路径）", async () => {
    const { store, batchId } = await makeArchive("diff-trav", "r-chg-diff-trav");
    h.layer.snapshots = store;
    stubAudit([], batchId);
    for (const bad of ["../../etc/passwd", "/etc/passwd", ".."]) {
      const out = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId, path: bad }) as {
        ok: boolean;
        reason?: string;
      };
      expect(out.ok, `路径 ${bad} 应被拒`).toBe(false);
    }
  });

  it("changes:file：请求形状不对时明说（null / 坏 batchId / path 非字符串）", () => {
    h.layer.snapshots = new SnapshotStore({ backupRoot: fs.mkdtempSync(path.join(os.tmpdir(), "ox-chg-shape-bk-")) });
    // null：typeof null === "object"，单靠前者放行 —— 解构就会抛
    const nullOut = (h.ipcMain as FakeIpcMain).invoke("changes:file", null) as { ok: boolean; reason?: string };
    expect(nullOut.ok).toBe(false);
    expect(nullOut.reason).toContain("请求形状不对");
    // 带分隔符的 batchId（会变成存档目录名的一部分）
    const slashOut = (h.ipcMain as FakeIpcMain).invoke("changes:file", { batchId: "a/b", path: "x" }) as {
      ok: boolean;
      reason?: string;
    };
    expect(slashOut.ok).toBe(false);
    expect(slashOut.reason).toContain("请求形状不对");
  });

  it("changes:revert：目标记录排在别的记录后面也扫得到（continue 不是 break）", async () => {
    const { root, store, batchId } = await makeArchive("rev-scan", "r-chg-rev-scan");
    const target = path.join(root, "src/generated.js");
    fs.writeFileSync(target, "gen", "utf8");
    h.layer.snapshots = store;
    // 先一条别人的记录：`continue` 换成 `break` 时这里就停，扫不到目标的 create 证据。
    // 目标故意选**无备份**的新建文件 —— 删除分支才让"证据有没有扫到"可观测
    // （有备份的文件走恢复分支，与 created 无关，break 版行为相同 → 杀不掉）。
    ensureAudit();
    (inst(h.auditInstances).read as Mock).mockReturnValue([
      { phase: "batch-changes", ts: "2026-10-17T00:00:00Z", archiveId: "other__1", files: [] },
      {
        phase: "batch-changes",
        ts: "2026-10-17T01:00:00Z",
        archiveId: batchId,
        files: [{ path: "src/generated.js", op: "create" }],
      },
    ]);
    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", {
      batchId,
      path: "src/generated.js",
    })) as { ok: boolean; action?: string };
    expect(out).toEqual({ ok: true, action: "removed" });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("changes:revert：审计里一条该批的记录都没有 ⇒ 拒绝删除（末尾 return false 不是 true）", async () => {
    const { root, store, batchId } = await makeArchive("rev-norec", "r-chg-rev-norec");
    const target = path.join(root, "package.json");
    fs.writeFileSync(target, '{"name":"user"}', "utf8");
    h.layer.snapshots = store;
    // 审计被轮转清空（或查询窗口里根本没有这一批）：没有任何 create 证据。
    ensureAudit();
    (inst(h.auditInstances).read as Mock).mockReturnValue([]);

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", {
      batchId,
      path: "package.json",
    })) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("不删");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("changes:revert：审计说 modify 而存储里没有备份 ⇒ 仍拒绝删除（证据必须是 create）", async () => {
    const { root, store, batchId } = await makeArchive("rev-mismatch", "r-chg-rev-mismatch");
    const target = path.join(root, "package.json");
    fs.writeFileSync(target, '{"name":"user"}', "utf8");
    h.layer.snapshots = store;
    // 审计记录说它是 modify —— 但快照里没有它的备份（zone 外）。删除许可只认
    // create：把 op 写错（或记录被截断）时不能顺手把用户的文件删掉。
    stubAudit([{ path: "package.json", op: "modify" }], batchId);

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", { batchId, path: "package.json" })) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("不删");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("changes:revert：有备份的 modify ⇒ 恢复旧内容，盘上真的变回去", async () => {
    const { root, store, batchId } = await makeArchive("rev", "r-chg-rev");
    h.layer.snapshots = store;
    stubAudit([{ path: "src/a.js", op: "modify" }], batchId);

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", { batchId, path: "src/a.js" })) as {
      ok: boolean;
      action?: string;
    };
    expect(out).toEqual({ ok: true, action: "restored" });
    expect(fs.readFileSync(path.join(root, "src/a.js"), "utf8")).toBe("line1\nold\nline3\n");
  });

  it("changes:revert：审计里 op=create 的新文件 ⇒ 撤销新建（删除）", async () => {
    const { root, store, batchId } = await makeArchive("rev-new", "r-chg-rev-new");
    const target = path.join(root, "src/brand-new.js");
    fs.writeFileSync(target, "new", "utf8");
    h.layer.snapshots = store;
    stubAudit([{ path: "src/brand-new.js", op: "create" }], batchId);

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", { batchId, path: "src/brand-new.js" })) as {
      ok: boolean;
      action?: string;
    };
    expect(out).toEqual({ ok: true, action: "removed" });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("changes:revert：无备份又无 create 证据 ⇒ 拒绝删除（可能是既有文件）", async () => {
    const { root, store, batchId } = await makeArchive("rev-refuse", "r-chg-rev-refuse");
    const target = path.join(root, "package.json");
    fs.writeFileSync(target, '{"name":"user"}', "utf8");
    h.layer.snapshots = store;
    // 审计里这个文件根本没出现（files 截断没带上它）⇒ 没有 create 证据
    stubAudit([{ path: "src/a.js", op: "modify" }], batchId);

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", { batchId, path: "package.json" })) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("不删");
    expect(fs.existsSync(target)).toBe(true); // 原样保留
  });

  it("changes:revert：存档不存在 ⇒ 明说，不动盘上文件", async () => {
    const { root, backupRoot, store, batchId } = await makeArchive("rev-gone", "r-chg-rev-gone");
    h.layer.snapshots = store;
    stubAudit([{ path: "src/a.js", op: "modify" }], batchId);
    // 直接删存档目录（不用 private getter）：模拟"被容量策略回收"的现场。
    fs.rmSync(path.join(backupRoot, "archive", batchId), { recursive: true, force: true });

    const out = (await (h.ipcMain as FakeIpcMain).invoke("changes:revert", { batchId, path: "src/a.js" })) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("不存在");
    expect(fs.readFileSync(path.join(root, "src/a.js"), "utf8")).toBe("line1\nnew\nline3\n"); // 没被碰
  });
});

describe("chat handlers（交互式编码会话）", () => {
  function seedChatWorkspace(projectId = "p-chat"): string {
    const root = path.join(tmp, "workspaces", projectId);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  function events(): Array<Record<string, any>> {
    return win.webContents.send.mock.calls.map(([, payload]) => payload as Record<string, any>);
  }

  function settingsMock(): { load: Mock } {
    return inst(h.settingsInstances) as { load: Mock };
  }

  async function waitForEvent(type: string, count = 1): Promise<void> {
    await vi.waitFor(() => {
      expect(events().filter((p) => p.type === type)).toHaveLength(count);
    });
  }

  /** 直接写一条带任意 changes 的会话记录（不经过模型/工具），专测撤销分支。 */
  function saveStoredSession(
    changes: ChatFileChange[],
    opts: {
      id?: string;
      projectId?: string;
      rootAbs?: string;
      userText?: string;
      userAfterTool?: boolean;
      meta?: Partial<ChatSessionMeta>;
    } = {},
  ): string {
    const projectId = opts.projectId ?? "p-chat";
    const rootAbs = opts.rootAbs ?? seedChatWorkspace(projectId);
    const id = opts.id ?? "chat-stored";
    const snapshot: ChatSessionSnapshot = {
      meta: {
        sessionId: id,
        rootAbs,
        startedAt: 1,
        updatedAt: 2,
        turns: 1,
        status: "done",
        mode: "workspace-write",
        approvalPolicy: "on-request",
        usageTokens: 0,
        ...(opts.meta ?? {}),
      },
      entries: [
        ...(opts.userText && !opts.userAfterTool
          ? [{ id: "e-0", ts: 1, kind: "user" as const, text: opts.userText }]
          : []),
        {
          id: "e-1",
          ts: 1,
          kind: "tool_result",
          text: "补丁",
          result: { id: "t-1", name: "apply_patch", ok: true, output: "", changes },
        },
        ...(opts.userText && opts.userAfterTool
          ? [{ id: "e-2", ts: 2, kind: "user" as const, text: opts.userText }]
          : []),
      ],
      messages: [],
      toolProtocol: "text",
    };
    new ChatSessionStore(path.join(tmp, "chat")).save(projectId, rootAbs, "sensenova", snapshot);
    return id;
  }

  function storedEnvelopePath(id: string): string {
    return path.join(tmp, "chat", "sessions", `${id}.json`);
  }

  it("首条消息：没有 chat:new 也会建会话，并真的把答复推进转录", async () => {
    seedChatWorkspace();
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "收到", provider: "fake", model: "fake", usageTokens: 7 });

    const res = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "你好", projectId: "p-chat" }) as {
      sessionId: string;
      accepted: boolean;
    };
    // 旧实现在 live === null 时直接 `live!.session` —— 这条用例在修前会抛
    // "Cannot read properties of null"。它必须从空会话开始，不能先 chat:new。
    expect(res.accepted).toBe(true);
    expect(res.sessionId).toMatch(/^chat-/);
    await waitForEvent("chat:done");

    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(transcript.entries[1].text).toBe("收到");
  });

  it("chat:files 只列可读文件，跳过重目录与密钥文件", () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist-old"), { recursive: true });
    fs.mkdirSync(path.join(root, "release-notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "readme");
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};");
    fs.writeFileSync(path.join(root, "with space.txt"), "");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(root, ".env.example"), "SECRET=");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
    fs.writeFileSync(path.join(root, "dist", "out.js"), "");
    fs.writeFileSync(path.join(root, "dist-old", "out.js"), "");
    fs.writeFileSync(path.join(root, "release-notes", "notes.md"), "");

    const out = (h.ipcMain as FakeIpcMain).invoke("chat:files", { projectId: "p-chat" }) as {
      files: string[];
      truncated: boolean;
    };
    expect(out.files).toContain("README.md");
    expect(out.files).toContain("src/a.ts");
    expect(out.files).toContain(".env.example");
    expect(out.files).not.toContain(".env");
    expect(out.files).not.toContain("with space.txt");
    expect(out.files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(out.files.some((file) => file.startsWith("dist/"))).toBe(false);
    expect(out.files.some((file) => file.startsWith("dist-old/"))).toBe(false);
    expect(out.files.some((file) => file.startsWith("release-notes/"))).toBe(false);
    expect(out.files).toEqual([...out.files].sort((a, b) => a.localeCompare(b)));
    expect(out.truncated).toBe(false);
  });

  it("沙箱/审批设置变化后重建会话（工具边界更新，但对话历史保留）", async () => {
    seedChatWorkspace();
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "第一轮", provider: "fake", model: "fake", usageTokens: 1 });
    const first = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "a", projectId: "p-chat" }) as {
      sessionId: string;
    };
    await waitForEvent("chat:done");

    const store = settingsMock();
    const base = store.load.mock.results[0]?.value ?? store.load();
    store.load.mockReturnValue({ ...base, approvalPolicy: "untrusted" });

    const second = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "b", projectId: "p-chat" }) as {
      sessionId: string;
    };
    // 设置变化只换执行边界，不换会话身份；否则用户每改一次档位就"开新聊天"，
    // 前文全丢（而那正是恢复功能要避免的）。
    expect(second.sessionId).toBe(first.sessionId);
    await waitForEvent("chat:done", 2);

    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: { approvalPolicy: string };
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.meta.approvalPolicy).toBe("untrusted");
    expect(transcript.entries.some((e) => e.kind === "user" && e.text === "a")).toBe(true);
    expect(transcript.entries.some((e) => e.kind === "user" && e.text === "b")).toBe(true);
  });

  it("审批真的拦在写盘前：批准一次后才落盘，拒绝理由不落盘", async () => {
    const root = seedChatWorkspace();
    const store = settingsMock();
    const base = store.load.mock.results[0]?.value ?? store.load();
    store.load.mockReturnValue({ ...base, approvalPolicy: "untrusted" });

    const patch = ["*** Begin Patch", "*** Add File: guarded.txt", "+hello", "*** End Patch"].join("\n");
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "先写\n```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "写好了", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "新建 guarded.txt", projectId: "p-chat" });
    await waitForEvent("chat:approval-request");
    const req = events().find((p) => p.type === "chat:approval-request")!.request as { requestId: string };
    expect(fs.existsSync(path.join(root, "guarded.txt"))).toBe(false);

    expect(
      (h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", req.requestId, { granted: true, scope: "once" }),
    ).toBe(true);
    await waitForEvent("chat:done");
    expect(fs.readFileSync(path.join(root, "guarded.txt"), "utf8")).toBe("hello");
  });

  it("项目约定进 system prompt，项目 policy.d 的 denyCommands 真的拦住命令", async () => {
    const root = seedChatWorkspace();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "项目约定：只改 src\n", "utf8");
    fs.mkdirSync(path.join(root, ".ox", "policy.d"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".ox", "policy.d", "deny.json"),
      JSON.stringify({ version: 1, denyCommands: ["node"] }),
      "utf8",
    );
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content:
          "```tool\n" +
          JSON.stringify({ tool: "run_command", arguments: { command: "node", args: ["-v"] } }) +
          "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "收到", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "看看 node 版本", projectId: "p-chat" });
    await waitForEvent("chat:done");
    const system = String(h.llmChat.mock.calls[0]?.[0]?.messages?.[0]?.content ?? "");
    expect(system).toContain("项目约定：只改 src");
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.entries.some((e) => e.kind === "tool_result" && e.text.includes("命令被沙箱禁止：node"))).toBe(
      true,
    );
  });

  it("M6b：read_skill 端到端 —— 运行时扫到的技能能被工具取到全文并回灌给模型", async () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, ".ox", "skills", "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".ox", "skills", "demo", "SKILL.md"),
      ["---", "name: demo", "description: 演示技能", "---", "", "技能正文：先跑门禁。"].join("\n"),
      "utf8",
    );
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "read_skill", arguments: { name: "demo" } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "读到了", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "看看 demo 技能", projectId: "p-chat" });
    await waitForEvent("chat:done");
    // 第一轮请求里的目录块必须与工具表同源：提示点名了 demo，工具就得真给得到
    // —— 断了这根线（比如把 skills 漏传给 runner），模型只会得到「没有这个技能」，
    // 而提示里明明写着有，界面上没有任何痕迹。
    const system = String(h.llmChat.mock.calls[0]?.[0]?.messages?.[0]?.content ?? "");
    expect(system).toContain("demo");
    expect(system).toContain("read_skill");
    // 第二轮请求里必须带着技能全文 —— 工具结果真的回到了模型，不是"模型假装读过"。
    const secondRequest = JSON.stringify(h.llmChat.mock.calls[1]?.[0]?.messages ?? []);
    expect(secondRequest).toContain("技能正文：先跑门禁。");
  });

  it("项目 .ox/config.json 的 read-only 档位真的拦住补丁写盘", async () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, ".ox"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".ox", "config.json"),
      JSON.stringify({ version: 1, sandboxMode: "read-only" }),
      "utf8",
    );
    const patch = ["*** Begin Patch", "*** Add File: blocked.txt", "+x", "*** End Patch"].join("\n");
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "没法写", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "写个文件", projectId: "p-chat" });
    await waitForEvent("chat:done");
    expect(fs.existsSync(path.join(root, "blocked.txt"))).toBe(false);
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.entries.some((e) => e.kind === "tool_result" && e.text.includes("read-only"))).toBe(true);
  });

  it("线程级 profile 的 read-only 压过项目 config 的 workspace-write，且写盘真的被拦", async () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, ".ox"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".ox", "config.json"),
      JSON.stringify({ version: 1, sandboxMode: "workspace-write" }),
      "utf8",
    );
    const patch = ["*** Begin Patch", "*** Add File: blocked-by-profile.txt", "+x", "*** End Patch"].join("\n");
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "没法写", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", {
      text: "写个文件",
      projectId: "p-chat",
      profile: { mode: "read-only", approvalPolicy: "on-request" },
    });
    await waitForEvent("chat:done");
    expect(fs.existsSync(path.join(root, "blocked-by-profile.txt"))).toBe(false);
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: { mode: string };
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.meta.mode).toBe("read-only");
    expect(transcript.entries.some((e) => e.kind === "tool_result" && e.text.includes("read-only"))).toBe(true);
  });

  it("chat:send 的 profile 拼错时原地报错，不静默退回默认档", () => {
    seedChatWorkspace();
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "yolo", approvalPolicy: "on-request" },
      }),
    ).toThrow(/profile\.mode/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "sometimes" },
      }),
    ).toThrow(/profile\.approvalPolicy/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", providerId: "not-a-provider" },
      }),
    ).toThrow(/profile\.providerId/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", providerId: null },
      }),
    ).toThrow(/profile\.providerId/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", providerId: "deepseek", model: "bad model" },
      }),
    ).toThrow(/profile\.model/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", providerId: "sensenova", model: "deepseek-v4-flash", reasoningEffort: "max" },
      }),
    ).toThrow(/reasoningEffort 不合法/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", reasoningEffort: "high" },
      }),
    ).toThrow(/需要固定 provider 与 model/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:send", {
        text: "hi",
        projectId: "p-chat",
        profile: { mode: "read-only", approvalPolicy: "on-request", providerId: "sensenova", model: "kimi-k3", reasoningEffort: "high" },
      }),
    ).toThrow(/不被当前线路支持/);
  });

  it("chat:new 的线程线路：只给 provider 用默认模型，只给 model 用全局 provider", () => {
    seedChatWorkspace();
    const base = { mode: "read-only" as const, approvalPolicy: "on-request" as const };
    (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: { ...base, providerId: "deepseek" },
    });
    let transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: { providerId?: string; model?: string };
    };
    expect(transcript.meta.providerId).toBe("deepseek");
    expect(transcript.meta.model).toBe("deepseek-chat");

    (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: { ...base, model: "deepseek-v4-flash" },
    });
    transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: { providerId?: string; model?: string };
    };
    expect(transcript.meta.providerId).toBe("sensenova");
    expect(transcript.meta.model).toBe("deepseek-v4-flash");
  });

  it("chat:new 的推理强度：合法线路写入 meta，缺线路/不支持时拒绝", () => {
    seedChatWorkspace();
    const base = { mode: "read-only" as const, approvalPolicy: "on-request" as const };
    (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: { ...base, providerId: "sensenova", model: "deepseek-v4-flash", reasoningEffort: "medium" },
    });
    let transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: { reasoningEffort?: string };
    };
    expect(transcript.meta.reasoningEffort).toBe("medium");

    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:new", {
        projectId: "p-chat",
        profile: { ...base, reasoningEffort: "high" },
      }),
    ).toThrow(/需要固定 provider 与 model/);
    // 半截组合同样要拒：给了 model 没给 providerId 时，线路仍未固定。
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:new", {
        projectId: "p-chat",
        profile: { ...base, model: "deepseek-v4-flash", reasoningEffort: "high" },
      }),
    ).toThrow(/需要固定 provider 与 model/);
    // 反过来：只有 provider 没有 model —— 同样不是一条确定的线路。
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:new", {
        projectId: "p-chat",
        profile: { ...base, providerId: "sensenova", reasoningEffort: "high" },
      }),
    ).toThrow(/需要固定 provider 与 model/);
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:new", {
        projectId: "p-chat",
        profile: { ...base, providerId: "sensenova", model: "kimi-k3", reasoningEffort: "high" },
      }),
    ).toThrow(/不被当前线路支持/);

    // 钉了线路、没选强度：meta 里**不能有这个键**（`reasoningEffort: undefined`
    // 落盘后在 JSON 里变成缺键，但内存断言与分叉合并会把它当"已选"）。
    (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: { ...base, providerId: "sensenova", model: "deepseek-v4-flash" },
    });
    const plain = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      meta: Record<string, unknown>;
    };
    expect("reasoningEffort" in plain.meta).toBe(false);
  });

  it("chat:latest 中止后按 meta 的 provider/model 重建线路", () => {
    seedChatWorkspace();
    (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: {
        mode: "read-only",
        approvalPolicy: "on-request",
        providerId: "deepseek",
        model: "deepseek-reasoner",
      },
    });
    (h.ipcMain as FakeIpcMain).invoke("chat:abort");
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" }) as {
      meta: { providerId?: string; model?: string };
    };
    expect(transcript.meta.providerId).toBe("deepseek");
    expect(transcript.meta.model).toBe("deepseek-reasoner");
  });

  it("chat:latest 保留合法推理档，并丢弃旧快照里已不支持的档", () => {
    seedChatWorkspace();
    const created = (h.ipcMain as FakeIpcMain).invoke("chat:new", {
      projectId: "p-chat",
      profile: {
        mode: "read-only",
        approvalPolicy: "on-request",
        providerId: "sensenova",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
    }) as { sessionId: string };
    (h.ipcMain as FakeIpcMain).invoke("chat:abort");
    let transcript = (h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" }) as {
      meta: { reasoningEffort?: string };
    };
    expect(transcript.meta.reasoningEffort).toBe("high");
    (h.ipcMain as FakeIpcMain).invoke("chat:delete", { sessionId: created.sessionId });

    const id = saveStoredSession([]);
    const file = storedEnvelopePath(id);
    const env = JSON.parse(fs.readFileSync(file, "utf8")) as {
      snapshot: { meta: Record<string, unknown> };
    };
    env.snapshot.meta.providerId = "sensenova";
    env.snapshot.meta.model = "kimi-k3";
    env.snapshot.meta.reasoningEffort = "high";
    env.snapshot.meta.updatedAt = Date.now() + 10_000;
    fs.writeFileSync(file, JSON.stringify(env), "utf8");
    fs.rmSync(path.join(tmp, "chat", "index.json"), { force: true });
    transcript = (h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" }) as {
      meta: { reasoningEffort?: string };
    };
    expect(transcript.meta.reasoningEffort).toBeUndefined();
  });

  it("撤销第 N 轮补丁：内容仍等于补丁后版本才恢复；之后被改过则跳过", async () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ ",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "*** End Patch",
    ].join("\n");
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "改好了", provider: "fake", model: "fake", usageTokens: 1 });

    const sent = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "改 a.ts", projectId: "p-chat" }) as {
      sessionId: string;
    };
    await waitForEvent("chat:done");
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");

    const reverted = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: sent.sessionId,
      turn: 1,
    }) as { reverted: string[]; skipped: Array<{ path: string; reason: string }> };
    expect(reverted.reverted).toEqual(["src/a.ts"]);
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(
      transcript.entries.some(
        (e) => e.kind === "system" && e.text.includes("已撤销第 1 轮") && e.text.includes("src/a.ts"),
      ),
    ).toBe(true);

    // 文件在补丁之后又被改过：撤销必须拒绝覆盖，而不是把新内容写回旧的 before。
    fs.writeFileSync(path.join(root, "src", "a.ts"), "// 用户后来改的\n", "utf8");
    const skipped = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: sent.sessionId,
      turn: 1,
    }) as { reverted: string[]; skipped: Array<{ path: string; reason: string }> };
    expect(skipped.reverted).toEqual([]);
    expect(skipped.skipped[0]?.path).toBe("src/a.ts");
    expect(skipped.skipped[0]?.reason).toMatch(/又被改过/);
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("// 用户后来改的\n");

    // 第二轮新建的文件：撤销依据 created 证据删除；turn 必须是累计的 2，
    // 不能与第一轮撞号（否则"撤第 2 轮"会找不到或误撤第一轮）。
    const addPatch = ["*** Begin Patch", "*** Add File: b.txt", "+new", "*** End Patch"].join("\n");
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch: addPatch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "建好了", provider: "fake", model: "fake", usageTokens: 1 });
    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "新建 b.txt", projectId: "p-chat" });
    await waitForEvent("chat:done", 2);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("new");
    const undoAdd = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: sent.sessionId,
      turn: 2,
    }) as { reverted: string[] };
    expect(undoAdd.reverted).toEqual(["b.txt"]);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });

  it("abort 无会话返回 false、有会话返回 true；未知审批请求返回 false", () => {
    seedChatWorkspace();
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort")).toBe(false);
    (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" });
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort")).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", "no-such-request", { granted: true })).toBe(false);
  });

  /**
   * M4a：宿主从"一条 live 单例"变成登记表。
   *
   * 这一层最容易出的错**都不抛异常**：建第二条线程时把第一条顶掉、`chat:abort`
   * 没有参数于是中止了"最近活跃的那条"（用户想停的是屏幕上这条）、
   * `chat:transcript` 不带 id 就读回别人的转录。三条断言各钉一个。
   */
  it("两条线程同时活着：按 id 寻址，中止一条不影响另一条", () => {
    seedChatWorkspace();
    const first = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    const second = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    expect(second.sessionId).not.toBe(first.sessionId);

    // 两条都在（建第二条没有顶掉第一条）
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort", { sessionId: first.sessionId })).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort", { sessionId: second.sessionId })).toBe(true);
    // 中止过的线程仍在登记表里（可再发消息 = 重建），所以重复中止不是错误；
    // 但**不存在的 id** 必须明确是 false，否则界面永远不知道"停的是哪条"。
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort", { sessionId: "chat-unknown" })).toBe(false);
  });

  /**
   * `sessionId` 不是字符串时的口径：**当作没给**，走"本项目最近活跃那条"。
   *
   * 判据写宽一格（`typeof x === "string" || x !== ""`）就会出现两种坏结果：
   * 数字 id 被当成真 id 传给登记表（查不到 → 走到 `resumeIntoLive` → 抛
   * "会话不存在"），或者中止时传进 `undefined` 让"停止"静默失效。两种都不报
   * 编译错，只在用户点了按钮之后表现为"点了没反应"。
   */
  it("sessionId 传非字符串时按缺省处理（不是拿数字去查表）", () => {
    seedChatWorkspace();
    const created = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    // 发送：数字 id 不该让"发一条新消息"变成"恢复一条不存在的会话"。
    const sent = (h.ipcMain as FakeIpcMain).invoke("chat:send", {
      text: "hi",
      projectId: "p-chat",
      sessionId: 42,
    }) as { sessionId: string };
    expect(sent.sessionId).toBe(created.sessionId);
    // 中止：数字 id 当缺省 → 中止最近活跃那条（返回 true），而不是 false。
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort", { sessionId: 42 })).toBe(true);
  });

  it("按 id 取转录：两条线程各读各的，不串台", () => {
    seedChatWorkspace();
    const first = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    const second = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    const a = (h.ipcMain as FakeIpcMain).invoke("chat:transcript", { sessionId: first.sessionId }) as {
      meta: { sessionId: string };
    };
    const b = (h.ipcMain as FakeIpcMain).invoke("chat:transcript", { sessionId: second.sessionId }) as {
      meta: { sessionId: string };
    };
    expect(a.meta.sessionId).toBe(first.sessionId);
    expect(b.meta.sessionId).toBe(second.sessionId);
    // 不存在的 id 不给"最近活跃那条"顶包 —— 那会让界面以为切到了新线程。
    expect((h.ipcMain as FakeIpcMain).invoke("chat:transcript", { sessionId: "chat-missing" })).toBeNull();
  });

  it("中止一条线程只关它自己的审批：另一条挂着的审批仍能答、仍能落盘", async () => {
    const root = seedChatWorkspace();
    const store = settingsMock();
    const base = store.load.mock.results[0]?.value ?? store.load();
    store.load.mockReturnValue({ ...base, approvalPolicy: "untrusted" });

    const patchFor = (file: string): string =>
      ["*** Begin Patch", `*** Add File: ${file}`, "+hi", "*** End Patch"].join("\n");
    h.llmChat.mockReset();
    h.llmChat.mockImplementation(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const user = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const file = user.includes("a.txt") ? "a.txt" : "b.txt";
      return {
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch: patchFor(file) } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      };
    });

    const first = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    const second = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-chat" }) as { sessionId: string };
    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "写 a.txt", projectId: "p-chat", sessionId: first.sessionId });
    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "写 b.txt", projectId: "p-chat", sessionId: second.sessionId });
    await waitForEvent("chat:approval-request", 2);

    const requests = events().filter((p) => p.type === "chat:approval-request");
    const forFirst = requests.find((p) => p.sessionId === first.sessionId);
    const forSecond = requests.find((p) => p.sessionId === second.sessionId);
    expect(forFirst).toBeDefined();
    expect(forSecond).toBeDefined();

    // 中止**后请求的那条**（它在挂起表里排在后面）：判据若写成 break，
    // 遍历到前面那条别人的审批就收摊，被中止线程的审批永远挂着。
    expect((h.ipcMain as FakeIpcMain).invoke("chat:abort", { sessionId: second.sessionId })).toBe(true);
    const stillPending = (forFirst as { request: { requestId: string } }).request.requestId;
    expect((h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", stillPending, { granted: true, scope: "once" })).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
    });
    // 被中止那条的审批已经不在挂起表里：再答一次是 false。
    expect(
      (h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", (forSecond as { request: { requestId: string } }).request.requestId, {
        granted: true,
      }),
    ).toBe(false);
  });

  it("项目 .ox/config.json 的 maxTurns 真的决定工具循环上限", async () => {
    const root = seedChatWorkspace();
    fs.mkdirSync(path.join(root, ".ox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".ox", "config.json"), JSON.stringify({ version: 1, maxTurns: 1 }), "utf8");
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({
      content: "```tool\n" + JSON.stringify({ tool: "list_dir", arguments: {} }) + "\n```",
      provider: "fake",
      model: "fake",
      usageTokens: 1,
    });
    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "一直列目录", projectId: "p-chat" });
    await waitForEvent("chat:done");
    expect(h.llmChat).toHaveBeenCalledTimes(1);
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(transcript.entries.some((e) => e.text.includes("达到轮次上限（1 轮）"))).toBe(true);
  });

  it("chat:latest 不把别的项目的活会话当成当前项目的；中止后能重建并返回转录", async () => {
    seedChatWorkspace("p-chat");
    seedChatWorkspace("p-other");
    (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-other" });
    expect((h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" })).toBeNull();

    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "好了", provider: "fake", model: "fake", usageTokens: 1 });
    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "你好", projectId: "p-chat" });
    await waitForEvent("chat:done");
    (h.ipcMain as FakeIpcMain).invoke("chat:abort");
    const latest = (h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" }) as {
      meta: { sessionId: string };
      entries: Array<{ text: string }>;
    } | null;
    expect(latest).not.toBeNull();
    expect(latest?.entries.some((e) => e.text === "好了")).toBe(true);
  });

  it("删除非当前会话不会中止当前 live；删除当前才中止", async () => {
    seedChatWorkspace();
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "好了", provider: "fake", model: "fake", usageTokens: 1 });
    const sent = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "你好", projectId: "p-chat" }) as {
      sessionId: string;
    };
    await waitForEvent("chat:done");
    const other = saveStoredSession([], { id: "chat-other-live" });
    expect((h.ipcMain as FakeIpcMain).invoke("chat:delete", { sessionId: other })).toBe(true);
    const still = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as { meta: { sessionId: string } } | null;
    expect(still?.meta.sessionId).toBe(sent.sessionId);

    expect((h.ipcMain as FakeIpcMain).invoke("chat:delete", { sessionId: sent.sessionId })).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("chat:transcript")).toBeNull();
  });

  it("resume 的根路径比较按平台归一：win32 不区分大小写，POSIX 区分", async () => {
    const root = seedChatWorkspace();
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "好了", provider: "fake", model: "fake", usageTokens: 1 });
    const sent = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "你好", projectId: "p-chat" }) as {
      sessionId: string;
    };
    await waitForEvent("chat:done");
    const file = storedEnvelopePath(sent.sessionId);
    const env = JSON.parse(fs.readFileSync(file, "utf8")) as { rootAbs: string };
    env.rootAbs = root.toUpperCase();
    fs.writeFileSync(file, JSON.stringify(env), "utf8");
    if (process.platform === "win32") {
      const t = (h.ipcMain as FakeIpcMain).invoke("chat:resume", {
        projectId: "p-chat",
        sessionId: sent.sessionId,
      }) as { meta: { sessionId: string } };
      expect(t.meta.sessionId).toBe(sent.sessionId);
    } else {
      expect(() =>
        (h.ipcMain as FakeIpcMain).invoke("chat:resume", { projectId: "p-chat", sessionId: sent.sessionId }),
      ).toThrow(/工作区已变化/);
    }
  });

  it("chat:revert 拒绝坏 turn / 坏 path / 别的项目的会话", () => {
    seedChatWorkspace();
    const id = saveStoredSession([], { id: "chat-val" });
    const bad = (extra: Record<string, unknown>) => () =>
      (h.ipcMain as FakeIpcMain).invoke("chat:revert", { projectId: "p-chat", sessionId: id, ...extra });
    expect(bad({ turn: -1 })).toThrow(/非负整数/);
    expect(bad({ turn: 1.5 })).toThrow(/非负整数/);
    expect(bad({ turn: "1" })).toThrow(/非负整数/);
    expect(bad({ turn: 1, path: 42 })).toThrow(/path 必须是字符串/);
    const other = saveStoredSession([], { id: "chat-other-proj", projectId: "p-other" });
    expect(() =>
      (h.ipcMain as FakeIpcMain).invoke("chat:revert", { projectId: "p-chat", sessionId: other, turn: 1 }),
    ).toThrow(/不属于当前项目/);
  });

  it("chat:revert 的 path 只撤指定文件（同一补丁多文件不串）", () => {
    const root = seedChatWorkspace();
    const id = saveStoredSession([
      { path: "a.txt", before: null, after: "a", created: true, turn: 1, revertable: true },
      { path: "b.txt", before: null, after: "b", created: true, turn: 1, revertable: true },
    ]);
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    const res = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: id,
      turn: 1,
      path: "b.txt",
    }) as { reverted: string[] };
    expect(res.reverted).toEqual(["b.txt"]);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });

  it("撤销遇到跳过项后继续处理后面的可撤销项", () => {
    const root = seedChatWorkspace();
    const changes: ChatFileChange[] = [
      { path: "ok.txt", before: "old", after: "new", created: false, turn: 1, revertable: true },
      { path: "too-large-recorded.txt", before: null, after: null, created: false, turn: 1, revertable: false },
      { path: "node_modules/x.txt", before: "oldA", after: "newA", created: false, turn: 1, revertable: true },
      { path: "mismatch.txt", before: "oldB", after: "newB", created: false, turn: 1, revertable: true },
      { path: "big.txt", before: "oldC", after: "newC", created: false, turn: 1, revertable: true },
      { path: "dir", before: "oldD", after: "newD", created: false, turn: 1, revertable: true },
      { path: "not-created.txt", before: null, after: "whatever", created: false, turn: 1, revertable: true },
      // 放在原数组末尾 ⇒ reverse 后第一个走"删除新建"分支；若在该分支后 break，
      // 后面的 ok.txt 就永远轮不到。
      { path: "created-last.txt", before: null, after: "c", created: true, turn: 1, revertable: true },
    ];
    const id = saveStoredSession(changes);
    fs.writeFileSync(path.join(root, "ok.txt"), "new");
    fs.writeFileSync(path.join(root, "mismatch.txt"), "user");
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(4 * 1024 * 1024 + 1));
    fs.mkdirSync(path.join(root, "dir"));
    fs.writeFileSync(path.join(root, "not-created.txt"), "whatever");
    fs.writeFileSync(path.join(root, "created-last.txt"), "c");

    const res = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: id,
      turn: 1,
    }) as { reverted: string[]; skipped: Array<{ path: string; reason: string }> };
    expect(res.reverted).toEqual(["created-last.txt", "ok.txt"]);
    expect(fs.existsSync(path.join(root, "created-last.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "ok.txt"), "utf8")).toBe("old");
    expect(res.skipped.map((s) => s.path).sort()).toEqual(
      ["big.txt", "dir", "mismatch.txt", "node_modules/x.txt", "not-created.txt", "too-large-recorded.txt"].sort(),
    );
  });

  it("chat:revert 只撤指定 turn 的改动（同一结果条目里混着两轮也不串）", () => {
    const root = seedChatWorkspace();
    const id = saveStoredSession([
      { path: "a.txt", before: null, after: "a", created: true, turn: 1, revertable: true },
      { path: "b.txt", before: null, after: "b", created: true, turn: 2, revertable: true },
    ]);
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    const res = (h.ipcMain as FakeIpcMain).invoke("chat:revert", {
      projectId: "p-chat",
      sessionId: id,
      turn: 2,
    }) as { reverted: string[] };
    expect(res.reverted).toEqual(["b.txt"]);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });

  it("chat:export 在真 git 仓库导出线程分支与 commit；默认不推送", async () => {
    const root = seedChatWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "old\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "-q"]);
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "init"]);
    fs.writeFileSync(path.join(root, "a.txt"), "new\n", "utf8");

    const id = saveStoredSession(
      [{ path: "a.txt", before: "old\n", after: "new\n", created: false, turn: 1, revertable: true }],
      { id: "chat-export", rootAbs: root },
    );
    const result = (await (h.ipcMain as FakeIpcMain).invoke("chat:export", {
      projectId: "p-chat",
      sessionId: id,
    })) as {
      ok: boolean;
      branch?: string;
      commit?: string;
      filesCommitted?: number;
      skipped?: string;
      push?: unknown;
      unrevertable: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.branch).toMatch(/^oxcommander\/thread-/);
    expect(result.commit).toMatch(/^[0-9a-f]+$/);
    expect(result.filesCommitted).toBe(1);
    expect(result.push).toBeUndefined();
    expect(result.unrevertable).toEqual([]);

    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: root, stdio: "pipe" }).toString().trim();
    expect(branch).toBe(result.branch);
    const committed = execFileSync("git", ["show", "--name-only", "--format="], { cwd: root, stdio: "pipe" })
      .toString()
      .trim()
      .split("\n");
    expect(committed).toEqual(["a.txt"]);
  });

  it("chat:export 的 commit message 取线程首条非空 user 文本", async () => {
    const root = seedChatWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "old\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "-q"]);
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "init"]);
    fs.writeFileSync(path.join(root, "a.txt"), "new\n", "utf8");
    const id = saveStoredSession(
      [{ path: "a.txt", before: "old\n", after: "new\n", created: false, turn: 1, revertable: true }],
      { id: "chat-export-title", rootAbs: root, userText: "修登录流程", userAfterTool: true },
    );
    const result = (await (h.ipcMain as FakeIpcMain).invoke("chat:export", {
      projectId: "p-chat",
      sessionId: id,
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, stdio: "pipe" })
      .toString()
      .trim();
    expect(subject).toContain("修登录流程");
    expect(subject).toContain("1 个文件");
  });

  it("chat:export push=true 且无 remote：返回 push 事实，但不伪造 pushed/remote/reason", async () => {
    const root = seedChatWorkspace();
    fs.writeFileSync(path.join(root, "a.txt"), "old\n", "utf8");
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "-q"]);
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "init"]);
    fs.writeFileSync(path.join(root, "a.txt"), "new\n", "utf8");
    const id = saveStoredSession(
      [{ path: "a.txt", before: "old\n", after: "new\n", created: false, turn: 1, revertable: true }],
      { id: "chat-export-push", rootAbs: root },
    );
    const result = (await (h.ipcMain as FakeIpcMain).invoke("chat:export", {
      projectId: "p-chat",
      sessionId: id,
      push: true,
    })) as { ok: boolean; branch?: string; push?: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.branch).toMatch(/^oxcommander\/thread-/);
    // 没有 remote 时 publish 返回 skipped:no-remote；push 结果里不能出现
    // `pushed: undefined` / `remote: undefined` 这类假字段，也不能把 skipped 吞掉
    // 让界面念成"已推送"。
    expect(result.push).toEqual({ ok: true, skipped: "no-remote" });
    expect("pushed" in (result.push ?? {})).toBe(false);
    expect("remote" in (result.push ?? {})).toBe(false);
    expect("reason" in (result.push ?? {})).toBe(false);
  });

  it("chat:export 导出未成功时 push 分支说清「未推送」", async () => {
    seedChatWorkspace();
    const id = saveStoredSession(
      [{ path: "../evil.txt", before: "a", after: "b", created: false, turn: 1, revertable: true }],
      { id: "chat-export-fail" },
    );
    const result = (await (h.ipcMain as FakeIpcMain).invoke("chat:export", {
      projectId: "p-chat",
      sessionId: id,
      push: true,
    })) as { ok: boolean; skipped?: string; push?: { ok: boolean; reason?: string } };
    // 工作区不是 git 仓库 ⇒ 导出本身是 skipped（不是失败），但 push 分支必须
    // 明确说"没有分支可推"；不能因为 skipped 就假装推送成功。
    expect(result).toMatchObject({ ok: true, skipped: "no-repo" });
    expect(result.push).toMatchObject({ ok: false, reason: "导出未成功，未推送" });
  });

  it("chat:resume 对半截线路 meta（只有 provider 没有 model）回落到全局，不补默认模型", async () => {
    seedChatWorkspace();
    const id = saveStoredSession([], { id: "chat-half-line", meta: { providerId: "deepseek" } });
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:resume", {
      projectId: "p-chat",
      sessionId: id,
    }) as { meta: Record<string, unknown> };
    expect("providerId" in transcript.meta).toBe(false);
    expect("model" in transcript.meta).toBe(false);
  });

  it("chat:export 拒绝导出属于别的项目的活线程", async () => {
    seedChatWorkspace("p-chat");
    seedChatWorkspace("p-other");
    const other = (h.ipcMain as FakeIpcMain).invoke("chat:new", { projectId: "p-other" }) as {
      sessionId: string;
    };
    await expect(
      (h.ipcMain as FakeIpcMain).invoke("chat:export", { projectId: "p-chat", sessionId: other.sessionId }),
    ).rejects.toThrow(/不属于当前项目/);
  });

  it("chat:export 没有补丁改动时返回 no-changes（不建分支）", async () => {
    seedChatWorkspace();
    const id = saveStoredSession([], { id: "chat-export-none" });
    const result = (await (h.ipcMain as FakeIpcMain).invoke("chat:export", {
      projectId: "p-chat",
      sessionId: id,
    })) as { ok: boolean; skipped?: string; branch?: string };
    expect(result).toMatchObject({ ok: true, skipped: "no-changes" });
    expect(result.branch).toBeUndefined();
  });

  it("审批答『本会话都不再问』经 IPC 保留：第二个同类动作不再问人", async () => {
    seedChatWorkspace();
    const store = settingsMock();
    const base = store.load.mock.results[0]?.value ?? store.load();
    store.load.mockReturnValue({ ...base, approvalPolicy: "untrusted" });
    const patch = (name: string) =>
      "```tool\n" +
      JSON.stringify({
        tool: "apply_patch",
        arguments: { patch: `*** Begin Patch\n*** Add File: ${name}\n+x\n*** End Patch` },
      }) +
      "\n```";
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({ content: patch("a.txt"), provider: "fake", model: "fake", usageTokens: 1 })
      .mockResolvedValueOnce({ content: "a 好了", provider: "fake", model: "fake", usageTokens: 1 })
      .mockResolvedValueOnce({ content: patch("b.txt"), provider: "fake", model: "fake", usageTokens: 1 })
      .mockResolvedValueOnce({ content: "b 好了", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "写 a", projectId: "p-chat" });
    await waitForEvent("chat:approval-request");
    const req = events().find((p) => p.type === "chat:approval-request")!.request as { requestId: string };
    (h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", req.requestId, { granted: true, scope: "session" });
    await waitForEvent("chat:done");

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "写 b", projectId: "p-chat" });
    await waitForEvent("chat:done", 2);
    expect(events().filter((p) => p.type === "chat:approval-request")).toHaveLength(1);
  });

  it("会话落盘：list / load / 重启后 latest / 继续 / fork / delete", async () => {
    seedChatWorkspace();
    h.llmChat.mockReset();
    h.llmChat.mockResolvedValue({ content: "第一轮答复", provider: "fake", model: "fake", usageTokens: 5 });

    const first = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "第一轮问题", projectId: "p-chat" }) as {
      sessionId: string;
    };
    await waitForEvent("chat:done");

    const list = (h.ipcMain as FakeIpcMain).invoke("chat:list", { projectId: "p-chat" }) as Array<{
      sessionId: string;
      title: string;
      turns: number;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(first.sessionId);
    expect(list[0].title).toBe("第一轮问题");
    expect(list[0].turns).toBe(1);

    const loaded = (h.ipcMain as FakeIpcMain).invoke("chat:load", { sessionId: first.sessionId }) as {
      entries: Array<{ kind: string; text: string }>;
    };
    expect(loaded.entries.some((e) => e.kind === "assistant" && e.text === "第一轮答复")).toBe(true);

    // 模拟应用重启：清掉已注册通道后重新装配会话 IPC（fake 与 Electron 一样
    // 拒绝同一通道注册两次），live / store 缓存随之清空；随后 chat:latest
    // 必须从磁盘把最近一条接回来。
    (h.ipcMain as FakeIpcMain).handlers.clear();
    registerChatHandlers();
    const latest = (h.ipcMain as FakeIpcMain).invoke("chat:latest", { projectId: "p-chat" }) as {
      meta: { sessionId: string; status: string };
      entries: Array<{ kind: string; text: string }>;
    };
    expect(latest.meta.sessionId).toBe(first.sessionId);
    expect(latest.meta.status).toBe("idle");
    expect(latest.entries.some((e) => e.text === "第一轮答复")).toBe(true);

    h.llmChat.mockResolvedValueOnce({ content: "第二轮答复", provider: "fake", model: "fake", usageTokens: 5 });
    const second = (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "继续", projectId: "p-chat" }) as {
      sessionId: string;
    };
    expect(second.sessionId).toBe(first.sessionId);
    await waitForEvent("chat:done", 2);
    // 恢复后第一轮请求里必须带着上一轮的模型消息，而不是只把 UI 转录贴回去。
    const request = h.llmChat.mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> };
    expect(request.messages.some((m) => m.content.includes("第一轮答复"))).toBe(true);
    expect(request.messages.some((m) => m.content.includes("继续"))).toBe(true);

    const forked = (h.ipcMain as FakeIpcMain).invoke("chat:fork", {
      projectId: "p-chat",
      sessionId: first.sessionId,
    }) as { meta: { sessionId: string }; entries: Array<{ text: string }> };
    expect(forked.meta.sessionId).not.toBe(first.sessionId);
    expect(forked.entries.some((e) => e.text === "第一轮答复")).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("chat:list", { projectId: "p-chat" })).toHaveLength(2);

    expect((h.ipcMain as FakeIpcMain).invoke("chat:delete", { sessionId: first.sessionId })).toBe(true);
    const after = (h.ipcMain as FakeIpcMain).invoke("chat:list", { projectId: "p-chat" }) as Array<{
      sessionId: string;
    }>;
    expect(after.map((s) => s.sessionId)).toEqual([forked.meta.sessionId]);
  });

  it("拒绝审批：文件不落盘，拒绝理由作为工具结果回灌给模型", async () => {
    const root = seedChatWorkspace();
    const store = settingsMock();
    const base = store.load.mock.results[0]?.value ?? store.load();
    store.load.mockReturnValue({ ...base, approvalPolicy: "untrusted" });

    const patch = ["*** Begin Patch", "*** Add File: denied.txt", "+nope", "*** End Patch"].join("\n");
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content: "```tool\n" + JSON.stringify({ tool: "apply_patch", arguments: { patch } }) + "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "收到拒绝", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "新建 denied.txt", projectId: "p-chat" });
    await waitForEvent("chat:approval-request");
    const req = events().find((p) => p.type === "chat:approval-request")!.request as { requestId: string };
    (h.ipcMain as FakeIpcMain).invoke("chat:approval-decide", req.requestId, {
      granted: false,
      scope: "once",
      reason: "别建这个文件",
    });
    await waitForEvent("chat:done");
    expect(fs.existsSync(path.join(root, "denied.txt"))).toBe(false);
    const secondRequest = String(h.llmChat.mock.calls[1]?.[0]?.messages?.map((m: any) => m.content).join("\n"));
    expect(secondRequest).toContain("别建这个文件");
  });

  /**
   * M7：桌面侧真的把 `mcp.d` 接进会话。
   *
   * 这里不 mock 连接池：fixture 是一个真实的 stdio MCP server 子进程，工具的
   * 输出必须真的从它那里回来。缺了这条，MCP 只会在单测里"能连"，而 IPC
   * 装配漏掉 `mcpServers` / `dynamicTools` 时界面仍然一片绿。
   */
  it("MCP：mcp.d 清单进会话，工具由真实外部进程执行，mcp:list 也能看到", async () => {
    seedChatWorkspace();
    const dir = path.join(tmp, "mcp.d");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fixture.json"),
      JSON.stringify({
        command: process.execPath,
        args: [path.resolve(__dirname, "__fixtures__", "mcp-echo-server.mjs")],
        timeoutMs: 5_000,
      }),
      "utf8",
    );
    h.llmChat.mockReset();
    h.llmChat
      .mockResolvedValueOnce({
        content:
          "```tool\n" +
          JSON.stringify({ tool: "mcp__fixture__echo", arguments: { text: "via ipc" } }) +
          "\n```",
        provider: "fake",
        model: "fake",
        usageTokens: 1,
      })
      .mockResolvedValueOnce({ content: "MCP 完成", provider: "fake", model: "fake", usageTokens: 1 });

    (h.ipcMain as FakeIpcMain).invoke("chat:send", { text: "用 MCP 回显", projectId: "p-chat" });
    await waitForEvent("chat:done");
    const transcript = (h.ipcMain as FakeIpcMain).invoke("chat:transcript") as {
      entries: Array<{ kind: string; text: string; result?: { ok: boolean; output: string } }>;
    };
    expect(transcript.entries.some((e) => e.kind === "system" && e.text.includes("已接入 MCP 工具 5 个"))).toBe(true);
    const result = transcript.entries.find((e) => e.kind === "tool_result");
    expect(result?.result).toMatchObject({ ok: true, output: "echo:via ipc" });

    const list = (h.ipcMain as FakeIpcMain).invoke("mcp:list") as {
      servers: Array<{ name: string; envNames: string[] }>;
    };
    expect(list.servers.map((s) => s.name)).toEqual(["fixture"]);
    expect(list.servers[0]?.envNames).toEqual([]);
    (h.ipcMain as FakeIpcMain).invoke("chat:abort");
  });
});

describe("task-note handlers（C2 操作者附言）", () => {
  it("没有在跑的 run 时明确拒绝（不静默成功）", () => {
    enginesOf().clear();
    setRunningProjectId(null);
    expect(() => (h.ipcMain as FakeIpcMain).invoke("orchestration:task-note", "t1", "注意口径")).toThrow(
      /没有在跑的 run/,
    );
  });

  it("有 run 时透传到引擎（含空串 = 清除）", () => {
    const engine = { setOperatorNote: vi.fn() };
    enginesOf().set("p-run", engine as never);
    setRunningProjectId("p-run");
    // 返回值也要断言：handler 的 `return true` 是位点（site 审计实测
    // `return true → false` 在只验证"引擎被调用"的测试下稳定存活 ——
    // 调用发生了，返回值错没错没人管）。
    expect((h.ipcMain as FakeIpcMain).invoke("orchestration:task-note", "t1", "  按无表头口径实现  ")).toBe(true);
    expect(engine.setOperatorNote).toHaveBeenCalledWith("t1", "  按无表头口径实现  ");
    // 清除走同一条通道：空串是合法值，不是"缺省 undefined"
    expect((h.ipcMain as FakeIpcMain).invoke("orchestration:task-note", "t1", "")).toBe(true);
    expect(engine.setOperatorNote).toHaveBeenLastCalledWith("t1", "");
    setRunningProjectId(null);
    enginesOf().clear();
  });

  it("拒绝坏形状输入（taskId 空串 / note 非字符串）", () => {
    setRunningProjectId(null);
    expect(() => (h.ipcMain as FakeIpcMain).invoke("orchestration:task-note", "", "x")).toThrow(
      /taskId 必须是非空字符串/,
    );
    expect(() => (h.ipcMain as FakeIpcMain).invoke("orchestration:task-note", "t1", 42)).toThrow(
      /note 必须是字符串/,
    );
  });
});

/**
 * 桌面自动化（M5b）：CRUD 转发 + 立即触发的三态映射 + 触发历史口径。
 *
 * 三态为什么逐条钉：**忙**在单飞语义下是正常结果，而它与"派不出去"若被混成
 * 一个 false 或一个异常，界面就只能说一句含糊的"没成功" —— 可这两件事对操作者
 * 的处置完全相反（等一会儿 vs 先去规划）。
 *
 * ⚠️ 夹具默认 `enabled: false`：create/update/delete 之后调度环会重排，一条**启用
 * 且早已到点**的行会在测试进程里排一个真 timer（延迟 0 → 立刻起跑），把日志与
 * 审计写到别的用例头上。启用态的排程语义由 automation-scheduler.test.ts 的注入式
 * 时钟覆盖，这里只用停用行验证"转发与映射"。
 */
describe("automation handlers（M5b 定时任务）", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "auto-1",
    name: "每晚回归",
    projectId: "p1",
    everyMs: 3_600_000,
    enabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it("list：原样回传；读不出来时给空表 + problem 并记日志（不静默全没了）", () => {
    h.automationRows.push(row());
    expect((h.ipcMain as FakeIpcMain).invoke("automations:list")).toEqual({ automations: [row()] });

    const store = inst(h.automationInstances);
    (store.list as Mock).mockImplementationOnce(() => {
      throw new Error("Unexpected token } in JSON");
    });
    const res = (h.ipcMain as FakeIpcMain).invoke("automations:list") as {
      automations: unknown[];
      problem?: string;
    };
    expect(res.automations).toEqual([]);
    expect(res.problem).toMatch(/Unexpected token/);
    // 日志是唯一在现场留下的痕迹：界面可能没开在这一页。
    expect(win.webContents.send).toHaveBeenCalledWith(
      "ox:event",
      expect.objectContaining({ type: "log", text: expect.stringContaining("读取 automations.json 失败") }),
    );
  });

  it("create 转发入参；update 让仓做合并后校验，id 不存在时明说", () => {
    expect(
      (h.ipcMain as FakeIpcMain).invoke("automations:create", { name: "每晚回归", projectId: "p1", everyMs: 60_000 }),
    ).toMatchObject({ id: "auto-new", name: "每晚回归", projectId: "p1", everyMs: 60_000 });
    const store = inst(h.automationInstances);
    expect(store.create).toHaveBeenCalledWith({ name: "每晚回归", projectId: "p1", everyMs: 60_000 }, expect.any(Number));

    h.automationRows.push(row());
    expect((h.ipcMain as FakeIpcMain).invoke("automations:update", "auto-1", { enabled: true })).toMatchObject({
      enabled: true,
    });
    expect(() => (h.ipcMain as FakeIpcMain).invoke("automations:update", "auto-ghost", { name: "x" })).toThrow(
      /没有这条自动化/,
    );
  });

  it("delete：回传仓的真结果（删不掉就是 false，不假装成功）", () => {
    h.automationRows.push(row());
    expect((h.ipcMain as FakeIpcMain).invoke("automations:delete", "auto-1")).toBe(true);
    expect((h.ipcMain as FakeIpcMain).invoke("automations:delete", "auto-1")).toBe(false);
  });

  it("run：忙 → busy、没计划 → failed，两种都落审计（三态都记账）", () => {
    h.automationRows.push(row());
    const store = inst(h.projectInstances);
    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };

    setRunningProjectId("p9");
    expect((h.ipcMain as FakeIpcMain).invoke("automations:run", "auto-1")).toBe("busy");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "automation",
        automationId: "auto-1",
        automationName: "每晚回归",
        projectId: "p1",
        automationOutcome: "busy",
        ok: false,
      }),
    );
    // 忙时**不**记账（不落 lastFiredMs）：下一轮还得再试
    expect(inst(h.automationInstances).markFired).not.toHaveBeenCalled();
    setRunningProjectId(null);

    (store.get as Mock).mockReturnValue({ id: "p1", stage: "PRD" });
    expect((h.ipcMain as FakeIpcMain).invoke("automations:run", "auto-1")).toBe("failed");
    expect(audit.append).toHaveBeenLastCalledWith(
      expect.objectContaining({ automationOutcome: "failed", detail: expect.stringContaining("no plan") }),
    );
  });

  it("run：accepted → 真起跑、落审计、并记 lastFiredMs（否则下一轮连跑两遍）", async () => {
    h.automationRows.push(row());
    const store = inst(h.projectInstances);
    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };
    const automationStore = inst(h.automationInstances);
    (store.get as Mock).mockReturnValue({ id: "p1", batchesJson: "[[{\"id\":\"t1\"}]]" });

    expect((h.ipcMain as FakeIpcMain).invoke("automations:run", "auto-1")).toBe("accepted");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "automation", automationOutcome: "accepted", ok: true }),
    );
    expect(automationStore.markFired).toHaveBeenCalledWith("auto-1", expect.any(Number));
    // 起火是异步的（不 await 整个 run），这里等它把 execute 走到
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalled());
  });

  it("run：未知 id 明说；history 把审计字段翻成界面口径（不动渲染层的字段认知）", () => {
    expect(() => (h.ipcMain as FakeIpcMain).invoke("automations:run", "auto-ghost")).toThrow(/没有这条自动化/);

    const audit = ensureAudit() as unknown as { append: Mock; read: Mock };
    (audit.read as Mock).mockReturnValue([
      {
        ts: "2026-10-22T11:00:00.000Z",
        phase: "automation",
        automationId: "auto-1",
        automationName: "每晚回归",
        projectId: "p1",
        automationOutcome: "busy",
        detail: "项目 p9 正在执行中，无法同时启动",
        ok: false,
      },
    ]);
    expect((h.ipcMain as FakeIpcMain).invoke("automations:history", 10)).toEqual([
      {
        ts: "2026-10-22T11:00:00.000Z",
        automationId: "auto-1",
        automationName: "每晚回归",
        projectId: "p1",
        outcome: "busy",
        detail: "项目 p9 正在执行中，无法同时启动",
      },
    ]);
    expect(audit.read).toHaveBeenCalledWith({ limit: 10, phase: "automation" });
  });
});

/**
 * 技能（M6a）的桌面通道。
 *
 * 钉三条：项目内与全局**都**要列（漏一边等于"我明明加了技能却看不见"）、
 * 不传 projectId 时只列全局（还没打开项目时不能报错）、坏技能以 issues 返回
 * （而不是让 `skills` 少一个、看起来像"没扫到"）。
 */
describe("skill handlers（M6a 技能目录）", () => {
  const doc = (name: string, description: string): string =>
    ["---", `name: ${name}`, `description: ${description}`, "---", "", "正文"].join("\n");

  const put = (rel: string, text: string): void => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  };

  it("list：项目内 + 全局都列；同名时项目级优先", () => {
    put("workspaces/p-skills/.ox/skills/ship-it/SKILL.md", doc("ship-it", "项目里的上线流程"));
    put(".ox/skills/ship-it/SKILL.md", doc("ship-it", "全局默认的上线流程"));
    put(".ox/skills/global-only/SKILL.md", doc("global-only", "只在全局有"));

    const res = (h.ipcMain as FakeIpcMain).invoke("skills:list", { projectId: "p-skills" }) as {
      skills: Array<{ name: string; origin: string; description: string }>;
      issues: unknown[];
    };
    expect(res.skills.map((s) => s.name)).toEqual(["global-only", "ship-it"]);
    expect(res.skills.find((s) => s.name === "ship-it")?.origin).toBe("project");
    expect(res.issues).toEqual([]);
  });

  it("不传 projectId 时只列全局（还没打开项目不该报错）", () => {
    // tmp 在每个用例里重建，所以全局目录要这条用例自己建。
    put(".ox/skills/only-global/SKILL.md", doc("only-global", "只在全局有"));
    const res = (h.ipcMain as FakeIpcMain).invoke("skills:list", {}) as {
      skills: Array<{ name: string; origin: string }>;
    };
    expect(res.skills.map((s) => s.name)).toEqual(["only-global"]);
    expect(res.skills[0]?.origin).toBe("global");
  });

  it("坏技能进 issues：路径 + 能照做的原因", () => {
    put("workspaces/p-skills-bad/.ox/skills/broken/SKILL.md", "没有 front matter");
    const res = (h.ipcMain as FakeIpcMain).invoke("skills:list", { projectId: "p-skills-bad" }) as {
      skills: unknown[];
      issues: Array<{ path: string; reason: string }>;
    };
    expect(res.skills).toEqual([]);
    expect(res.issues.some((i) => i.path === ".ox/skills/broken/SKILL.md")).toBe(true);
    expect(res.issues.some((i) => /front matter/.test(i.reason))).toBe(true);
  });
});
