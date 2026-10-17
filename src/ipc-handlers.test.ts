import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
import { app, shell } from "electron";
import { attachWindow, buildEngine, ensureWorkspace, registerIpc } from "../electron/ipc";
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
} from "../electron/ipc/context";
import { exampleManifest } from "../electron/agents/manifest-schema";
import { SnapshotStore } from "../electron/sandbox/snapshot-store";
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

  it("ensureWorkspace 幂等：脚手架已存在时不重写（重复 start 不冲掉手改内容）", () => {
    // 二次调用走的是 `if (!fs.existsSync(pkg))` / `if (!fs.existsSync(file))`
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
