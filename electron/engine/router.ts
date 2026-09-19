import type { Task } from "../../shared/types";
import type { AgentAction, AgentDescriptor } from "../../shared/agent-contract";
import { isUnrestrictedGlob, zoneWithinGlobs } from "../../shared/glob";

/** Rolling per-agent signal supplied by the host (batch-local or platform-wide). */
export interface AgentLoadStats {
  /** 0..1, sliding-window success rate. Absent ⇒ no evidence, no bonus. */
  successRate?: number;
  /** Runs currently in flight. Absent ⇒ taken from the batch-local counter. */
  inflight?: number;
  circuit?: "closed" | "open" | "half-open";
}

export interface RouteContext {
  task: Pick<Task, "id" | "zone" | "suggestedRole">;
  /** Position of the task inside the batch; used by the legacy round-robin fallback. */
  index: number;
  /** Probe-passing candidates, preference order first. */
  candidates: AgentDescriptor[];
  /** Batch-local assignment counter (how many tasks each agent already took). */
  inflight?: ReadonlyMap<string, number>;
  /** Declared actions the task needs; defaults to `["edit"]`. */
  requiredTags?: AgentAction[];
  /** `enabledAgents` order used as a tie-breaker. */
  preferredAgents?: readonly string[];
}

export interface RoutingDecision {
  /** `undefined` when no candidate can serve the task. */
  agentId: string | undefined;
  score: number;
  /** Human-readable scoring breakdown, surfaced in the board log. */
  reason: string;
}

export interface CapabilityRouter {
  assign(ctx: RouteContext): RoutingDecision;
}

export interface RouterWeights {
  /** Exact role match. */
  roleExact: number;
  /** Role is declared as `"*"`. */
  roleWildcard: number;
  /** Zone covered by a scoped glob (specialised agent). */
  zoneScoped: number;
  /** Zone covered only by an unrestricted glob. */
  zoneBroad: number;
  /** Multiplied by successRate when stats are available. */
  quality: number;
  /** Applied per unit of `inflight / maxConcurrency`. */
  load: number;
  /** Applied (negatively) to half-open circuits; open circuits are filtered out. */
  circuitHalfOpen: number;
  /** Multiplied by the declared manifest priority. */
  priority: number;
}

export const DEFAULT_ROUTER_WEIGHTS: RouterWeights = {
  roleExact: 100,
  roleWildcard: 60,
  zoneScoped: 40,
  zoneBroad: 20,
  quality: 20,
  load: 10,
  circuitHalfOpen: 15,
  priority: 1,
};

export interface RouterOptions {
  weights?: Partial<RouterWeights>;
  /** Behaviour when no candidate scores: `"round-robin"` reproduces v1, `"none"` reports no agent. */
  fallback?: "round-robin" | "none";
  stats?: (agentId: string) => AgentLoadStats | undefined;
  /** Injectable for tests / for the host to explain decisions. */
  onDecision?: (decision: RoutingDecision, ctx: RouteContext) => void;
}

interface Scored {
  descriptor: AgentDescriptor;
  score: number;
  parts: string[];
}

function isRoleMatch(descriptor: AgentDescriptor, role: string): "exact" | "wildcard" | "none" {
  const roles = descriptor.capabilities.roles as string[];
  if (roles.includes(role)) return "exact";
  if (roles.includes("*")) return "wildcard";
  return "none";
}

function zoneScope(descriptor: AgentDescriptor, zone: string): "scoped" | "broad" | "out" {
  const globs = descriptor.capabilities.zoneGlobs;
  if (!zoneWithinGlobs(zone, globs)) return "out";
  return globs.every(isUnrestrictedGlob) ? "broad" : "scoped";
}

/**
 * Scores candidates for a task. Hard filtering already happened in the
 * AgentRegistry; this layer only ranks, so both are independently testable.
 *
 * Guarantee (see plan §6): when every candidate is a v1 adapter — i.e. nothing
 * declared capabilities — the router reproduces the legacy
 * `available[index % n]` assignment byte for byte.
 */
export function createCapabilityRouter(opts: RouterOptions = {}): CapabilityRouter {
  const w: RouterWeights = { ...DEFAULT_ROUTER_WEIGHTS, ...(opts.weights ?? {}) };
  const fallback = opts.fallback ?? "round-robin";

  function legacyDecision(ctx: RouteContext, why: string): RoutingDecision {
    if (fallback === "none" || ctx.candidates.length === 0) {
      return { agentId: undefined, score: 0, reason: why };
    }
    const picked = ctx.candidates[ctx.index % ctx.candidates.length]!;
    return { agentId: picked.manifest.id, score: 0, reason: why };
  }

  return {
    assign(ctx: RouteContext): RoutingDecision {
      if (ctx.candidates.length === 0) {
        return { agentId: undefined, score: 0, reason: "no candidate" };
      }
      // Pure v1 pool: keep the old round-robin so registration cannot change behaviour.
      if (ctx.candidates.every((c) => c.inferredLegacy)) {
        const decision = legacyDecision(ctx, "legacy round-robin（无能力声明）");
        opts.onDecision?.(decision, ctx);
        return decision;
      }

      const required = ctx.requiredTags ?? (["edit"] as AgentAction[]);
      const preferredRank = new Map((ctx.preferredAgents ?? []).map((id, i) => [id, i]));
      const scored: Scored[] = [];

      for (const descriptor of ctx.candidates) {
        const caps = descriptor.capabilities;
        // Defensive re-check: the registry normally filters these out already.
        if (!required.every((tag) => caps.supports.includes(tag))) continue;
        const role = isRoleMatch(descriptor, ctx.task.suggestedRole);
        if (role === "none") continue;
        const scope = zoneScope(descriptor, ctx.task.zone);
        if (scope === "out") continue;

        const stats = opts.stats?.(descriptor.manifest.id);
        if (stats?.circuit === "open") continue;

        const parts: string[] = [];
        let score = 0;

        if (role === "exact") {
          score += w.roleExact;
          parts.push(`role=${ctx.task.suggestedRole}(+${w.roleExact})`);
        } else {
          score += w.roleWildcard;
          parts.push(`role=*(+${w.roleWildcard})`);
        }

        if (scope === "scoped") {
          score += w.zoneScoped;
          parts.push(`zone=${caps.zoneGlobs.join(",")}(+${w.zoneScoped})`);
        } else {
          score += w.zoneBroad;
          parts.push(`zone=**(+${w.zoneBroad})`);
        }

        if (stats?.successRate !== undefined) {
          const bonus = Math.round(w.quality * stats.successRate);
          score += bonus;
          parts.push(`quality=${stats.successRate.toFixed(2)}(+${bonus})`);
        }
        if (stats?.circuit === "half-open") {
          score -= w.circuitHalfOpen;
          parts.push(`circuit=half-open(-${w.circuitHalfOpen})`);
        }
        const inflight = stats?.inflight ?? ctx.inflight?.get(descriptor.manifest.id) ?? 0;
        const loadPenalty = Math.round(w.load * (inflight / caps.maxConcurrency));
        score -= loadPenalty;
        parts.push(`load=${inflight}/${caps.maxConcurrency}(-${loadPenalty})`);
        if (descriptor.priority !== 0) {
          score += w.priority * descriptor.priority;
          parts.push(`priority=${descriptor.priority >= 0 ? "+" : ""}${descriptor.priority * w.priority}`);
        }
        scored.push({ descriptor, score, parts });
      }

      if (scored.length === 0) {
        const decision = legacyDecision(ctx, "能力匹配为空，回落 round-robin");
        opts.onDecision?.(decision, ctx);
        return decision;
      }

      const anyDeclared = scored.some((s) => !s.descriptor.inferredLegacy);
      scored.sort((a, b) => {
        if (anyDeclared && a.descriptor.inferredLegacy !== b.descriptor.inferredLegacy) {
          // A declared agent that matches beats an undeclared generalist at equal score.
          if (a.descriptor.inferredLegacy) return 1;
          if (b.descriptor.inferredLegacy) return -1;
        }
        if (b.score !== a.score) return b.score - a.score;
        const pa = preferredRank.get(a.descriptor.manifest.id) ?? Number.MAX_SAFE_INTEGER;
        const pb = preferredRank.get(b.descriptor.manifest.id) ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return ctx.candidates.indexOf(a.descriptor) - ctx.candidates.indexOf(b.descriptor);
      });

      const winner = scored[0]!;
      const decision: RoutingDecision = {
        agentId: winner.descriptor.manifest.id,
        score: winner.score,
        reason: winner.parts.join(" "),
      };
      opts.onDecision?.(decision, ctx);
      return decision;
    },
  };
}
