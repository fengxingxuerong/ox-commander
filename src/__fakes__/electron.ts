/**
 * Test double for the `electron` module.
 *
 * Why this exists: `node_modules/electron/index.js` does
 * `module.exports = getElectronPath()`, so importing it under vitest resolves to
 * a *string* (the binary path) and every named export is `undefined`. Any
 * main-process module that wires `ipcMain.handle(...)` therefore cannot be
 * imported in a unit test at all.
 *
 * `vitest.config.mts` aliases `electron` here. Tests that need to observe or
 * drive the wiring call `vi.mock("electron", ...)` and forward to these
 * factories, so the harness stays in one place.
 */
import { vi } from "vitest";

export interface FakeInvokeHandler {
  channel: string;
  /** Runs the real handler with a fake `event`; returns its (possibly async) result. */
  call(...args: unknown[]): unknown;
}

export interface FakeIpcMain {
  /** Channel -> handler, in registration order. */
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
  /** Channels in registration order, for contract assertions. */
  channels(): string[];
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  /** Invokes a registered channel with a synthetic event (no renderer needed). */
  invoke(channel: string, ...args: unknown[]): unknown;
}

export function createFakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    channels: () => [...handlers.keys()],
    handle(channel, handler) {
      // Mirrors Electron: registering the same channel twice throws. The split
      // into per-domain modules makes an accidental double-registration a real
      // risk, so the fake enforces the same rule the runtime does.
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      return handler({}, ...args);
    },
  };
}

export interface FakeWebContents {
  send: ReturnType<typeof vi.fn>;
  /** Every payload pushed to the renderer, oldest first. */
  sent(): Array<Record<string, unknown>>;
}

export function createFakeWebContents(): FakeWebContents {
  const send = vi.fn();
  return {
    send,
    sent: () => send.mock.calls.map((c) => c[1] as Record<string, unknown>),
  };
}

/** userData root used by every fake app; tests may override `app.getPath`. */
export const fakeUserData = "/tmp/ox-test-userdata";

export const app = {
  getPath: vi.fn((_name: string) => fakeUserData),
  getVersion: vi.fn(() => "0.0.0-test"),
};

export const ipcMain = createFakeIpcMain();

export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((s: string) => Buffer.from(s, "utf8")),
  decryptString: vi.fn((b: Buffer) => b.toString("utf8")),
};

export const shell = {
  showItemInFolder: vi.fn(),
  trashItem: vi.fn(async () => undefined),
  openExternal: vi.fn(async () => undefined),
};

export class BrowserWindow {}

/** Only used by preload.ts, which this project never exercises in tests. */
export const contextBridge = { exposeInMainWorld: vi.fn() };
export const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
