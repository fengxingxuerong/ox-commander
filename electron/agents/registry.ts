import type { AgentAdapter, Task } from "../../shared/types";
import {
  DEFAULT_AGENT_LIMITS,
  LEGACY_CAPABILITIES,
  normalizeCapabilities,
  type AgentAction,
  type AgentAdapterV2,
  type AgentDescriptor,
  type AgentLimits,
  type AgentManifest,
} from "../../shared/agent-contract";
import { matchesAnyGlob, zoneWithinGlobs } from "../../shared/glob";

/** One registry entry as handed over by the assembly layer (ipc.ts / headless). */
export interface AgentSpec {
  adapter: AgentAdapter;
  /** Optional declaration. Absent ⇒ inferred legacy capabilities (v1 behaviour). */
  manifest?: Partial<AgentManifest> & { id?: string };
}

export interface CandidateQuery {
  task: Pick<Task, "zone" | "suggestedRole">;
  /** Actions the task needs; defaults to `["edit"]`. Ignored for legacy (v1) agents. */
  requiredTags?: AgentAction[];
}

export type RegistrationResult =
  | { ok: true; id: string; replaced: boolean }
  | { ok: false; error: string };

export type UnregisterResult =
  | { ok: true; drained: "drained" | "timeout" | "unsupported" }
  | { ok: false; error: string };

export interface UnregisterOptions {
  /** Grace period handed to `adapter.drain()`; defaults to 5s. */
  graceMs?: number;
}

/**
 * Capability registry: the single place that knows which agents exist, what
 * they can do, and whether they are enabled. It performs *hard* filtering only
 * (enabled / role / action / zone). Ranking lives in the CapabilityRouter so
 * the two concerns stay independently testable.
 *
 * It is also the live pool: `activeAdapters()` is what the Scheduler routes to,
 * so `register()` / `unregister()` take effect on the next batch without
 * rebuilding any engine.
 */
export class AgentRegistry {
  private readonly byId = new Map<string, AgentDescriptor>();
  private readonly order: string[] = [];

  constructor(specs: AgentSpec[]) {
    for (const spec of specs) this.put(spec);
  }

  private buildDescriptor(spec: AgentSpec): AgentDescriptor {
    const adapter = spec.adapter as AgentAdapterV2;
    const fromAdapter = typeof adapter.capabilities === "function" ? adapter.capabilities() : undefined;
    // Precedence: explicit manifest declaration ▸ adapter's own declaration ▸ legacy defaults.
    const declared = spec.manifest?.capabilities ?? fromAdapter;
    // A v1 adapter with no declaration at all keeps legacy routing semantics.
    const inferredLegacy = declared === undefined;
    const capabilities = normalizeCapabilities(declared);
    const manifest: AgentManifest = {
      id: spec.manifest?.id ?? adapter.meta.id,
      displayName: spec.manifest?.displayName ?? adapter.meta.name,
      adapter: spec.manifest?.adapter ?? (adapter.meta.kind === "ui" ? "http-bridge" : "local-llm"),
      ...(spec.manifest?.entry ? { entry: spec.manifest.entry } : {}),
      capabilities,
      ...(spec.manifest?.credential ?? adapter.credential
        ? { credential: spec.manifest?.credential ?? adapter.credential }
        : {}),
      ...(spec.manifest?.limits ?? adapter.limits
        ? { limits: spec.manifest?.limits ?? adapter.limits }
        : {}),
      priority: spec.manifest?.priority ?? 0,
      enabled: spec.manifest?.enabled ?? true,
      source: spec.manifest?.source ?? "builtin",
    };
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, ...(adapter.limits ?? {}), ...(manifest.limits ?? {}) };
    return {
      manifest,
      capabilities,
      limits,
      adapter,
      inferredLegacy,
      enabled: manifest.enabled !== false,
      priority: manifest.priority ?? 0,
    };
  }

  private put(spec: AgentSpec): AgentDescriptor {
    const descriptor = this.buildDescriptor(spec);
    if (!this.byId.has(descriptor.manifest.id)) this.order.push(descriptor.manifest.id);
    this.byId.set(descriptor.manifest.id, descriptor);
    return descriptor;
  }

  /**
   * Adds (or replaces) an agent. The caller is expected to have validated the
   * raw manifest (see `manifest-schema.ts`); this method only enforces the
   * invariants the registry itself depends on.
   */
  register(spec: AgentSpec): RegistrationResult {
    const id = spec.manifest?.id ?? spec.adapter?.meta?.id;
    if (!id || id.trim() === "") return { ok: false, error: "agent id 不能为空" };
    if (!spec.adapter || typeof spec.adapter.dispatch !== "function") {
      return { ok: false, error: "adapter 必须实现 dispatch()" };
    }
    const replaced = this.byId.has(id);
    this.put({ ...spec, manifest: { ...spec.manifest, id } });
    return { ok: true, id, replaced };
  }

  /** Drains the agent (waiting for in-flight runs), then removes it from the pool. */
  async unregister(id: string, opts: UnregisterOptions = {}): Promise<UnregisterResult> {
    const d = this.byId.get(id);
    if (!d) return { ok: false, error: `未注册的 agent：${id}` };
    const drain = d.adapter.drain?.bind(d.adapter);
    const drained: "drained" | "timeout" | "unsupported" = drain
      ? await drain(opts.graceMs ?? 5_000)
      : "unsupported";
    this.byId.delete(id);
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    return { ok: true, drained };
  }

  /** Registry order — stable, so equal-scoring routers reproduce v1 behaviour. */
  list(): AgentDescriptor[] {
    return this.order.map((id) => this.byId.get(id)!);
  }

  /** Enabled descriptors only; the routing pool. */
  active(): AgentDescriptor[] {
    return this.list().filter((d) => d.enabled);
  }

  /** Enabled adapters in registry order — what the Scheduler dispatches to. */
  activeAdapters(): AgentAdapter[] {
    return this.active().map((d) => d.adapter);
  }

  get(id: string): AgentDescriptor | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  setEnabled(id: string, on: boolean): boolean {
    const d = this.byId.get(id);
    if (!d) return false;
    d.enabled = on;
    d.manifest.enabled = on;
    return true;
  }

  size(): number {
    return this.order.length;
  }

  /**
   * Hard filter for one task. Legacy (v1) agents bypass every capability check
   * so a registry-wrapped v1 pool behaves exactly like the pre-router pool.
   */
  candidates(query: CandidateQuery): AgentDescriptor[] {
    const required = query.requiredTags ?? ["edit"];
    return this.list().filter((d) => {
      if (!d.enabled) return false;
      if (d.inferredLegacy) return true;
      const caps = d.capabilities;
      const roleOk = caps.roles.includes("*") || (caps.roles as string[]).includes(query.task.suggestedRole);
      if (!roleOk) return false;
      if (!required.every((tag) => caps.supports.includes(tag))) return false;
      if (!zoneWithinGlobs(query.task.zone, caps.zoneGlobs)) return false;
      return true;
    });
  }

  /** True when the descriptor can touch at least one path of the run's zone (advisory). */
  coversPath(id: string, relPath: string): boolean {
    const d = this.byId.get(id);
    if (!d || d.inferredLegacy) return true;
    return matchesAnyGlob(relPath, d.capabilities.zoneGlobs);
  }
}

/** Wraps a bare v1 adapter as a descriptor so routing has a uniform input type. */
export function wrapLegacyDescriptor(adapter: AgentAdapter): AgentDescriptor {
  const a = adapter as AgentAdapterV2;
  return {
    manifest: {
      id: a.meta.id,
      displayName: a.meta.name,
      adapter: a.meta.kind === "ui" ? "http-bridge" : "local-llm",
      capabilities: { ...LEGACY_CAPABILITIES },
      priority: 0,
      enabled: true,
      source: "builtin",
    },
    capabilities: { ...LEGACY_CAPABILITIES },
    limits: { ...DEFAULT_AGENT_LIMITS, ...(a.limits ?? {}) },
    adapter: a,
    inferredLegacy: true,
    enabled: true,
    priority: 0,
  };
}

/**
 * Builds a registry from the legacy adapter list plus optional declarations,
 * reproducing the old pool when nothing is declared: every adapter becomes a
 * legacy descriptor and stays enabled.
 *
 * Note: `enabledAgents` is a *preference* ordering (see Scheduler.preferredAgents)
 * and deliberately does not disable anything — disabling is explicit, via
 * `manifest.enabled` or `setEnabled()`.
 */
export function createRegistry(
  adapters: AgentAdapter[],
  opts: { manifests?: readonly AgentManifest[] } = {},
): AgentRegistry {
  const manifestById = new Map((opts.manifests ?? []).map((m) => [m.id, m]));
  const specs: AgentSpec[] = adapters.map((adapter) => {
    const declared = manifestById.get(adapter.meta.id);
    return declared ? { adapter, manifest: declared } : { adapter };
  });
  return new AgentRegistry(specs);
}
