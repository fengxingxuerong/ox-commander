import fs from "node:fs";
import path from "node:path";
import { matchesAnyGlob } from "../../shared/glob";

/**
 * Paths that are never writable by an agent, regardless of zone or delegation.
 *
 * This list is a deliberate tightening of the pre-sandbox behaviour (which only
 * blocked `package.json`, `package-lock.json`, `ox-scripts/**` and
 * `node_modules/**`): `.git/**` and dotenv files are agent-writable paths that
 * can only cause damage, and neither is part of any zone's semantics.
 */
export const DEFAULT_FORBIDDEN_WRITE: readonly string[] = [
  "package.json",
  "package-lock.json",
  "ox-scripts/**",
  "node_modules/**",
  ".git/**",
  ".env",
  ".env.*",
];

export type ZoneMode = "legacy" | "strict";

export interface SandboxConfig {
  /** Absolute project root; every write must land inside it. */
  projectRoot: string;
  /**
   * Roots a write may land in (absolute or project-relative). Defaults to
   * `[projectRoot]` — nothing may escape the project.
   */
  writableRoots?: string[];
  /** Zone-external paths explicitly delegated by the operator. */
  delegatedWrite?: string[];
  /** Overrides `DEFAULT_FORBIDDEN_WRITE` when provided. */
  forbiddenWrite?: string[];
  /**
   * `legacy` (default) keeps the historic meaning of `zone: "."` (owns the
   * whole tree). `strict` reinterprets it as "root-level files only", so an
   * over-broad zone cannot silently grant the entire repository.
   */
  zoneMode?: ZoneMode;
}

export type WritableDecision =
  | { ok: true; abs: string; via: "zone" | "delegated" | "unrestricted" }
  | { ok: false; reason: string };

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Filesystems where `PACKAGE.JSON` and `package.json` are the same file. */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/**
 * Resolves symlinks/junctions and 8.3 short names for the deepest ancestor of
 * `target` that actually exists, then re-appends the not-yet-existing
 * remainder. A purely lexical `path.resolve` cannot see through a junction
 * pointing outside the project, nor can it tell `NODE_M~1` from
 * `node_modules` — either lets a write land somewhere other than where it was
 * judged. The path is judged at its REAL location instead.
 */
function resolveExistingReal(target: string): string {
  let cur = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      // `.native` on purpose: the JS implementation walks lstat+readlink and
      // resolves junctions but leaves 8.3 short names untouched, while the
      // native one (GetFinalPathNameByHandle) expands short names too.
      const real = fs.realpathSync.native(cur);
      return suffix.length === 0 ? real : path.join(real, ...suffix);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return target; // reached the fs root; judge lexically
      suffix.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Strips `./`, leading slashes and trailing slashes; keeps the value relative. */
function normalizeRel(raw: string): string {
  return toPosix(raw.trim()).replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isInsideAbs(abs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Glob matching reuses `shared/glob.ts` on purpose: the sandbox and the
 * capability router must agree on what `src/**` means, and a second
 * implementation would drift.
 */
function matchesAny(rel: string, patterns: readonly string[]): boolean {
  return matchesAnyGlob(rel, patterns);
}

/**
 * The single gate every agent-side file write must pass.
 *
 * Decision order (first hit wins):
 *   1. malformed input (absolute / traversal / empty)      → deny
 *   2. escapes the project root                            → deny
 *   3. `forbiddenWrite` (lockfiles, .git, dotenv …)        → deny
 *   4. outside every `writableRoot`                        → deny
 *   5. inside the task's zone (or unrestricted)            → allow
 *   6. matches `delegatedWrite`                            → allow
 *   7. otherwise                                           → deny (zone 越权)
 */
export class PathPolicy {
  private readonly rootAbs: string;
  private readonly writableRootsAbs: string[];
  private readonly forbidden: readonly string[];
  private readonly forbiddenLower: readonly string[] | null;
  private readonly delegated: readonly string[];
  private readonly zoneMode: ZoneMode;

  constructor(cfg: SandboxConfig) {
    // Realpath the root too, so containment math below compares two
    // consistently-resolved paths (an 8.3-cased tmp root would otherwise not
    // match its own realpath'd children).
    this.rootAbs = resolveExistingReal(path.resolve(cfg.projectRoot));
    this.writableRootsAbs = (cfg.writableRoots && cfg.writableRoots.length > 0
      ? cfg.writableRoots
      : [this.rootAbs]
    ).map((r) => resolveExistingReal(path.isAbsolute(r) ? path.resolve(r) : path.resolve(this.rootAbs, r)));
    this.forbidden = cfg.forbiddenWrite ?? DEFAULT_FORBIDDEN_WRITE;
    this.forbiddenLower = CASE_INSENSITIVE_FS ? this.forbidden.map((p) => p.toLowerCase()) : null;
    this.delegated = (cfg.delegatedWrite ?? []).map(normalizeRel);
    this.zoneMode = cfg.zoneMode ?? "legacy";
  }

  get projectRoot(): string {
    return this.rootAbs;
  }

  /** True when the path may be read (all in-project paths are, by construction). */
  assertReadable(relPath: string): boolean {
    const rel = normalizeRel(relPath);
    if (rel === "" || hasTraversal(rel)) return false;
    return isInsideAbs(path.resolve(this.rootAbs, rel), this.rootAbs);
  }

  isDelegated(relPath: string): boolean {
    const rel = normalizeRel(relPath);
    return this.delegated.length > 0 && matchesAny(rel, this.delegated);
  }

  assertWritable(relPath: string, zone?: string): WritableDecision {
    const rel = normalizeRel(relPath);
    if (rel === "") return { ok: false, reason: "路径为空" };
    if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath.trim())) {
      return { ok: false, reason: `拒绝绝对路径：${relPath}` };
    }
    if (hasTraversal(rel)) return { ok: false, reason: `拒绝路径穿越：${relPath}` };

    const abs = path.resolve(this.rootAbs, rel);
    // Judge the write at its REAL location: see through junctions (a link to
    // outside must deny) and 8.3 short names (`NODE_M~1` must hit
    // `node_modules/**`), and keep the decision's `abs` honest for the writer.
    const realAbs = resolveExistingReal(abs);
    const relReal = toPosix(path.relative(this.rootAbs, realAbs));
    if (!isInsideAbs(realAbs, this.rootAbs)) {
      return { ok: false, reason: `越出项目根目录：${relReal}` };
    }
    if (
      this.forbiddenLower
        ? matchesAnyGlob(relReal.toLowerCase(), this.forbiddenLower)
        : matchesAnyGlob(relReal, this.forbidden)
    ) {
      return { ok: false, reason: `受保护路径：${relReal}` };
    }
    if (!this.writableRootsAbs.some((r) => isInsideAbs(realAbs, r))) {
      return { ok: false, reason: `越出可写根：${rel}` };
    }

    // Zone semantics keep matching the agent's *input* path — the real-location
    // safety floor above has already denied anything that escaped physically.
    if (this.zoneAllows(rel, zone)) {
      return { ok: true, abs: realAbs, via: this.zoneIsUnrestricted(zone) ? "unrestricted" : "zone" };
    }
    if (matchesAny(rel, this.delegated)) return { ok: true, abs: realAbs, via: "delegated" };
    return { ok: false, reason: `zone 越权：${rel} 不在 zone「${zone}」内` };
  }

  /** Convenience wrapper for callers that only need a yes/no plus a reason. */
  check(relPath: string, zone?: string): { ok: true; abs: string } | { ok: false; reason: string } {
    const d = this.assertWritable(relPath, zone);
    return d.ok ? { ok: true, abs: d.abs } : d;
  }

  private zoneIsUnrestricted(zone?: string): boolean {
    const z = normalizeRel(zone ?? "");
    if (this.zoneMode === "legacy") return z === "" || z === ".";
    // strict: "." owns root-level files only, i.e. it is scoped, not unrestricted.
    return z === "";
  }

  private zoneAllows(rel: string, zone?: string): boolean {
    const z = normalizeRel(zone ?? "");
    if (this.zoneMode === "legacy") {
      if (z === "" || z === ".") return true;
      return rel === z || rel.startsWith(`${z}/`);
    }
    if (z === "") return true;
    if (z === ".") return !rel.includes("/"); // root-level files only
    return rel === z || rel.startsWith(`${z}/`);
  }
}

function hasTraversal(rel: string): boolean {
  return rel.split("/").some((seg) => seg === "..");
}

/**
 * Path-policy factory that mirrors the built-in workspace rules used by the
 * SenseNova executor before the sandbox existed, so switching to PathPolicy
 * does not change which files that adapter may write.
 */
export function createWorkspacePathPolicy(projectRoot: string, zone?: ZoneMode): PathPolicy {
  return new PathPolicy({ projectRoot, ...(zone ? { zoneMode: zone } : {}) });
}
