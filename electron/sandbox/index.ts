/**
 * Sandbox runtime (phase P3): every side effect an agent can cause passes
 * through one of these gates.
 *
 *   PathPolicy      — where a write may land (project root / zone / protected)
 *   CommandPolicy   — which programs may run, and with which arguments
 *   TimeoutGate     — per-run deadline + idle watchdog
 *   CircuitBreaker  — three-state breaker so a broken agent is skipped, not retried
 *   killTree        — tear down a whole process tree (no orphaned builds)
 */
export {
  PathPolicy,
  DEFAULT_FORBIDDEN_WRITE,
  createWorkspacePathPolicy,
  type SandboxConfig,
  type WritableDecision,
  type ZoneMode,
} from "./path-policy";
export {
  CommandPolicy,
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_DENIED_COMMANDS,
  DEFAULT_DENIED_GIT_SUBCOMMANDS,
  createDefaultCommandPolicy,
  type CommandDecision,
  type CommandPolicyOptions,
} from "./command-policy";
export {
  buildSpawnSpec,
  needsCmdWrapper,
  planSpawn,
  quoteForCmd,
  resolveCommand,
  type BuildSpawnSpecOptions,
  type SpawnSpec,
} from "./spawn-plan";
export { TimeoutGate, TimeoutError, type TimeoutGateOptions, type TripReason } from "./timeout-gate";
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  type CircuitStats,
} from "./circuit-breaker";
export {
  FileJournal,
  isInsideZone,
  type FileChange,
  type FileJournalOptions,
  type JournalStats,
  type JournalToken,
} from "./file-journal";
export {
  SnapshotStore,
  withinZones,
  type RevertResult,
  type SnapshotScope,
  type SnapshotStoreOptions,
  type SnapshotToken,
} from "./snapshot-store";
export { killTree, hasExited } from "./kill-tree";
