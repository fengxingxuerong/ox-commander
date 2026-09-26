import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `electron/ipc.ts` is the only place the main process exposes capability to the
 * renderer, and it had no test at all — which is why a channel could be renamed
 * on one side and the failure would only surface as a runtime "No handler
 * registered" in a packaged build.
 *
 * The contract is symmetric and is asserted from both directions:
 *   1. every `ipcRenderer.invoke("x")` in preload.ts has a handler;
 *   2. every registered handler is reachable from preload.ts.
 *
 * That pair is what makes the C1 split into per-domain modules safe: moving a
 * handler between files cannot silently drop it.
 */

const fakes = vi.hoisted(() => ({ ipcMain: undefined as unknown }));
vi.mock("electron", async () => {
  const mod = await import("./__fakes__/electron");
  fakes.ipcMain = mod.ipcMain;
  return mod;
});

// Keep the heavy side effect owners (real stores, agent layer, audit log) out of
// the way: this test is about the wiring, not about what each handler computes.
vi.mock("../electron/store", () => ({
  ProjectStore: class {
    create = vi.fn(() => ({ id: "p1" }));
    list = vi.fn(() => []);
    get = vi.fn(() => undefined);
    update = vi.fn();
    remove = vi.fn(() => true);
  },
  SettingsStore: class {
    load = vi.fn(() => ({ llmProvider: "sensenova", llmPool: [] }));
    save = vi.fn();
  },
}));

vi.mock("../electron/keys-store", () => ({
  KeysStore: class {
    status = vi.fn(() => ({}));
    isEncryptedAtRest = vi.fn(() => true);
    plaintextCount = vi.fn(() => 0);
    set = vi.fn(() => true);
    get = vi.fn(() => undefined);
  },
  createSafeStorageCrypto: vi.fn(() => ({})),
}));

vi.mock("../electron/audit-log", () => ({
  AuditLog: class {
    append = vi.fn();
    read = vi.fn(() => []);
    files = vi.fn(() => []);
    exportTo = vi.fn((p: string) => p);
  },
}));

vi.mock("../electron/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../electron/agents")>()),
  createAgentLayer: vi.fn(() => ({
    registry: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      register: vi.fn(() => ({ ok: true, replaced: false })),
      unregister: vi.fn(async () => ({ ok: true, drained: 0 })),
      setEnabled: vi.fn(() => true),
    },
    breaker: { snapshot: vi.fn(() => ({})) },
    manifestErrors: [],
    skippedManifests: [],
  })),
}));

vi.mock("../electron/platform", () => ({
  createPlatform: vi.fn(() => ({
    engine: {
      generatePrd: vi.fn(),
      decompose: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
    buildLlm: vi.fn(() => ({ chat: vi.fn() })),
  })),
}));

import type { FakeIpcMain } from "./__fakes__/electron";
import { registerIpc } from "../electron/ipc";

/** Channel names extracted from preload.ts by static analysis of the source. */
function channelsExposedToRenderer(): string[] {
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/preload.ts"), "utf8");
  const found = new Set<string>();
  for (const m of source.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("registerIpc · channel contract", () => {
  let ipcMain: FakeIpcMain;

  beforeEach(() => {
    ipcMain = fakes.ipcMain as FakeIpcMain;
    ipcMain.handlers.clear();
    registerIpc();
  });

  it("registers a handler for every channel the preload bridge invokes", () => {
    const registered = new Set(ipcMain.channels());
    const missing = channelsExposedToRenderer().filter((c) => !registered.has(c));
    // A missing channel is a dead button in the packaged app.
    expect(missing).toEqual([]);
  });

  it("registers no channel the preload bridge cannot reach", () => {
    const exposed = new Set(channelsExposedToRenderer());
    const unreachable = ipcMain.channels().filter((c) => !exposed.has(c));
    // The reverse direction catches copy-paste channel names and dead handlers.
    expect(unreachable).toEqual([]);
  });

  it("registers each channel exactly once", () => {
    const channels = ipcMain.channels();
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("pins the full channel set, so a rename cannot pass unnoticed", () => {
    // Deliberately explicit rather than derived: this is the list a reviewer
    // diffs against when a channel changes.
    expect(ipcMain.channels().sort()).toEqual([
      "agents:example-manifest",
      "agents:list",
      "agents:probe",
      "agents:register",
      "agents:stats",
      "agents:toggle",
      "agents:unregister",
      "audit:export",
      "audit:files",
      "audit:recent",
      "keys:save",
      "keys:security",
      "keys:status",
      "llm:test",
      "orchestration:cancel",
      "orchestration:escalation-decide",
      "orchestration:pause",
      "orchestration:planning",
      "orchestration:resume",
      "orchestration:start",
      "orchestration:update-prd",
      "projects:create",
      "projects:delete",
      "projects:list",
      "projects:open-workspace",
      "settings:get",
      "settings:save",
    ]);
  });

  it("throws for an escalation decision on a task that is not waiting", () => {
    // Guards the parked-resolver map: answering a stale prompt must fail loudly
    // instead of silently resolving nothing.
    expect(() => ipcMain.invoke("orchestration:escalation-decide", "t-ghost", "skip")).toThrow(
      /没有等待决策的任务/,
    );
  });
});
