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

/** userData root used by every fake app; tests may override `app.getPath`. */
export const fakeUserData = "/tmp/ox-test-userdata";

/** App-wide listeners, keyed by event name (`second-instance`, `window-all-closed`, …). */
const appListeners = new Map<string, (...args: unknown[]) => void>();

/** Fires a listener registered via `app.on(name, …)`; no-op when nothing is listening. */
export function fireAppEvent(name: string, ...args: unknown[]): void {
  appListeners.get(name)?.(...args);
}

/** Names of the events `app.on` was called with, in registration order. */
export function appEventNames(): string[] {
  return [...appListeners.keys()];
}

export function resetFakeApp(): void {
  appListeners.clear();
  createdWindows.length = 0;
  app.requestSingleInstanceLock.mockReturnValue(true);
  app.whenReady.mockImplementation(() => Promise.resolve());
}

export const app = {
  getPath: vi.fn((_name: string) => fakeUserData),
  getVersion: vi.fn(() => "0.0.0-test"),
  getAppPath: vi.fn(() => "/app"),
  disableHardwareAcceleration: vi.fn(),
  /** Defaults to `true` (the first instance); tests flip it for the second-instance path. */
  requestSingleInstanceLock: vi.fn(() => true),
  quit: vi.fn(),
  /** Resolved promise by default; the then() body runs on the microtask queue. */
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn((name: string, listener: (...args: unknown[]) => void) => {
    appListeners.set(name, listener);
  }),
};

export const ipcMain = createFakeIpcMain();

/**
 * Every window the main entry constructed, in creation order.
 *
 * `electron/main.ts` is the process entry: it had no assertions at all until
 * this fake grew the surface it needs (`whenReady` / `requestSingleInstanceLock`
 * / a BrowserWindow with behaviour). The window double records what was loaded
 * and what was called on it so the entry's wiring can be asserted instead of
 * eyeballed.
 */
export interface FakeBrowserWindow {
  /** URL or file path passed to `loadURL` / `loadFile`. */
  loaded: string | null;
  minimized: boolean;
  focusCalls: number;
  restoreCalls: number;
  readonly messages: Array<{ channel: string; payload: unknown }>;
  /** Set by `close()`; mirrors the window being destroyed. */
  closed: boolean;
  webContents: { send(channel: string, payload: unknown): void };
  loadURL(url: string): Promise<void>;
  loadFile(file: string): Promise<void>;
  on(name: string, listener: () => void): void;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  /** Test helper: fires the `closed` listener so the entry can drop its reference. */
  close(): void;
}

export const createdWindows: FakeBrowserWindow[] = [];

export class BrowserWindow {
  static getAllWindows(): FakeBrowserWindow[] {
    return createdWindows.filter((w) => !w.closed);
  }

  constructor(public readonly options: Record<string, unknown>) {
    const windowEvents = new Map<string, () => void>();
    const self: FakeBrowserWindow = {
      loaded: null,
      minimized: false,
      focusCalls: 0,
      restoreCalls: 0,
      messages: [],
      closed: false,
      webContents: {
        send: (channel, payload) => {
          self.messages.push({ channel, payload });
        },
      },
      loadURL: async (url) => {
        self.loaded = url;
      },
      loadFile: async (file) => {
        self.loaded = file;
      },
      on: (name, listener) => {
        windowEvents.set(name, listener);
      },
      isMinimized: () => self.minimized,
      restore: () => {
        self.restoreCalls += 1;
        self.minimized = false;
      },
      focus: () => {
        self.focusCalls += 1;
      },
      close: () => {
        self.closed = true;
        windowEvents.get("closed")?.();
      },
    };
    createdWindows.push(self);
    return self as unknown as BrowserWindow;
  }
}

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

/** Only used by preload.ts, which this project never exercises in tests. */
export const contextBridge = { exposeInMainWorld: vi.fn() };
export const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
