/**
 * Zone glob matching for the agent capability layer.
 *
 * Kept dependency-free (no node, no DOM) because `shared/` is compiled by both
 * the renderer project (tsconfig.json) and the electron project
 * (tsconfig.electron.json).
 *
 * Supported syntax: `**` (any depth, including none), `*` (within one
 * segment), `?` (single non-slash char). Paths are matched as posix
 * (`/`-separated) and are always treated as relative to the project root.
 */

/** A glob that grants the whole tree; treated as "unrestricted" rather than "specific". */
const UNRESTRICTED = new Set(["**", "**/*", "*", "."]);

function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Compiles one glob into an anchored RegExp over posix relative paths. */
export function compileGlob(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  // A trailing `/**` also matches the directory itself (`src/**` ⊇ `src`).
  const suffixed = normalized.endsWith("/**");
  const body = suffixed ? normalized.slice(0, -3) : normalized;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "*") {
      if (body[i + 1] === "*") {
        // `**/` also matches zero directories, so `**/x` matches `x`.
        if (body[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += escapeChar(ch);
  }
  if (suffixed) out += "(?:/.*)?";
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = compileGlob(pattern);
    cache.set(pattern, re);
  }
  return re;
}

/** True when `pattern` is so broad that it places no restriction on scope. */
export function isUnrestrictedGlob(pattern: string): boolean {
  return UNRESTRICTED.has(pattern.trim().replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** True when the relative posix path matches any of the globs (empty list ⇒ never). */
export function matchesAnyGlob(relPath: string, globs: readonly string[]): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return globs.some((g) => isUnrestrictedGlob(g) || compiled(g).test(p));
}

/**
 * True when `relPath` is owned by `zone`.
 *
 * Three shapes are accepted, because the planner naturally writes all three:
 * - `zone = ""` or `"."` → owns everything (legacy semantics);
 * - `zone = "src/store"` → owns that directory and everything beneath it;
 * - `zone = "src/duration"` → also owns the **module files** `src/duration.js`,
 *   `src/duration.test.js` …
 *
 * The last case matters: a model told "you own src/duration" writes
 * `src/duration.js`, and a strict directory-prefix check would call that a zone
 * violation, roll it back, and fail the whole batch. Matching is still bounded
 * — `src/duration-extra.js` (dash, not dot) and `src/duration/sub/x.js`
 * (a directory below) are *not* owned.
 */
export function isPathInZone(relPath: string, zone: string): boolean {
  const z = zone.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (z === "" || z === ".") return true;
  const p = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (p === z || p.startsWith(`${z}/`)) return true;
  if (p.startsWith(`${z}.`)) {
    const rest = p.slice(z.length + 1);
    return rest !== "" && !rest.includes("/");
  }
  return false;
}

/** True when the whole zone directory lies inside the globs. `"."` (project
 * root) only matches an unrestricted glob — a scoped agent may not claim the
 * entire tree. */
export function zoneWithinGlobs(zone: string, globs: readonly string[]): boolean {
  const z = zone.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (z === "" || z === ".") return globs.some(isUnrestrictedGlob);
  return globs.some((g) => {
    const pattern = g.replace(/\\/g, "/").replace(/\/+$/, "");
    if (isUnrestrictedGlob(pattern)) return true;
    // A directory is in scope when the glob covers everything beneath it:
    // `src/**` covers `src/core`, but `src/core/*` does not.
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3);
      const re = compiled(base);
      return re.test(z) || z.startsWith(`${base}/`);
    }
    const re = compiled(pattern);
    return re.test(z) || z.startsWith(`${pattern}/`);
  });
}
