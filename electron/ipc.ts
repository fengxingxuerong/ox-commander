/**
 * Main-process IPC surface.
 *
 * This file used to hold every handler inline (554 lines). It is now a thin
 * registrar: each domain lives in `./ipc/*`, and the channel contract is pinned
 * by `src/ipc.test.ts` (every channel preload.ts invokes must have a handler,
 * and every handler must be reachable from preload.ts).
 *
 * Shared state and the singleton factories live in `./ipc/context`.
 */
import { ensureStores } from "./ipc/context";
import { registerAgentHandlers, registerObservabilityHandlers } from "./ipc/agents";
import { registerOrchestrationHandlers } from "./ipc/orchestration";
import { registerProjectHandlers, registerSettingsHandlers } from "./ipc/projects";

export { attachWindow } from "./ipc/context";
export { buildEngine, ensureWorkspace } from "./ipc/orchestration";

/**
 * Wires every channel. Called once from the Electron main entry point, before
 * any window is created, so `ensureStores()` has run by the time a renderer can
 * invoke anything.
 */
export function registerIpc(): void {
  ensureStores();
  registerProjectHandlers();
  registerSettingsHandlers();
  registerOrchestrationHandlers();
  registerAgentHandlers();
  registerObservabilityHandlers();
}
