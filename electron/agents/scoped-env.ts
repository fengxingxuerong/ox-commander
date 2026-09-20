/**
 * Environment minimisation for agent subprocesses.
 *
 * Why: `dispatch()` used to pass `{ ...process.env }` to every CLI agent. That
 * hands each child the credentials of *every* provider the operator has
 * configured — so a task routed to the Codex CLI could read the SenseNova and
 * DeepSeek keys straight out of its own environment. An agent that is asked to
 * "print the environment for debugging", or a prompt-injected instruction that
 * does so, leaks billing credentials that have nothing to do with it.
 *
 * Two rules, in order:
 *   1. drop everything secret-looking (a denylist that wins over the allowlist);
 *   2. drop everything not needed to run (an allowlist of process basics).
 *
 * The denylist deliberately wins: a provider key must not be re-admitted just
 * because its name happens to match an allowlist prefix.
 *
 * This is *not* a full sandbox — a determined child can still read the filesystem
 * and the parent's memory is out of reach anyway. It removes the casual leak.
 */
import { getProvider, providerKeyEnvVars } from "../../shared/providers";

/**
 * Names that are environment-shaped secrets whether or not a provider declares
 * them: the naming convention attackers actually grep for.
 */
const SECRET_NAME_PATTERN =
  /(api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth|private[_-]?key|access[_-]?key|session[_-]?id)/i;

/**
 * Variables a child process genuinely needs to function: PATH to resolve
 * binaries, HOME/USERPROFILE so tools find their own config, and the Windows
 * essentials (SystemRoot is required or many tools fail outright).
 *
 * Stored upper-cased and matched case-insensitively: Windows exposes these as
 * `SYSTEMROOT` / `PATH` while some shells surface `SystemRoot` / `Path`. A
 * case-sensitive lookup silently dropped SystemRoot, which is the one variable
 * whose absence makes many Windows tools fail to start.
 */
const REQUIRED_EXACT = new Set(
  [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "NODE_ENV",
  ].map((s) => s.toUpperCase()),
);

/** Prefixes whose *members* are process basics rather than configuration. */
const REQUIRED_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_"];

function isRequired(name: string): boolean {
  const upper = name.toUpperCase();
  if (REQUIRED_EXACT.has(upper)) return true;
  return REQUIRED_PREFIXES.some((p) => upper.startsWith(p));
}

export interface ScopedEnvOptions {
  /**
   * Provider ids whose credentials this child *is* allowed to see. For a CLI
   * agent this is normally empty — the CLI authenticates itself through its own
   * config file, not through our env vars.
   */
  allowProviders?: readonly string[];
  /** Extra names to pass through verbatim (from the agent's envTemplate). */
  extraKeys?: readonly string[];
  /** The parent environment. Defaults to `process.env`; injectable for tests. */
  parent?: NodeJS.ProcessEnv;
}

/**
 * Builds the environment for one agent subprocess.
 *
 * Returns a fresh object — the parent environment is never mutated.
 */
export function scopedEnv(opts: ScopedEnvOptions = {}): NodeJS.ProcessEnv {
  const parent = opts.parent ?? process.env;
  const allowProviders = opts.allowProviders ?? [];
  // Every key var belonging to the providers this child is scoped to.
  const providerVars = new Set<string>();
  for (const id of allowProviders) {
    const provider = getProvider(id);
    if (provider.apiKeyEnvVar) providerVars.add(provider.apiKeyEnvVar);
    // A provider may expose extra key slots (sensenova has three).
    for (const v of providerKeyEnvVars(id)) providerVars.add(v);
  }
  const extra = new Set(opts.extraKeys ?? []);
  // Case-insensitive comparisons: Windows surfaces the same variable as
  // `SYSTEMROOT` or `SystemRoot` depending on the shell that launched us, and a
  // case-sensitive miss here would either leak a secret or drop a required var.
  const grants = new Set([...extra, ...providerVars].map((n) => n.toUpperCase()));

  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    // 1. An explicit grant (the agent's own envTemplate, or a scoped provider)
    //    wins over the secret denylist — otherwise `allowProviders` could never
    //    re-admit anything, because every provider key is secret-shaped.
    if (grants.has(upper)) {
      out[name] = value;
      continue;
    }
    // 2. Everything else that looks like a credential is dropped first.
    if (isSecretName(name)) continue;
    // 3. And of the remainder, only process basics survive.
    if (isRequired(name)) out[name] = value;
  }
  return out;
}

/** True when a variable's *name* marks it as a credential. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Names that were dropped from `parent` for this scope, for diagnostics.
 *
 * Returns names only, never values — this is safe to log or show in the UI.
 */
export function droppedSecretNames(opts: ScopedEnvOptions = {}): string[] {
  const parent = opts.parent ?? process.env;
  const allowed = new Set(scopedEnvKeys(opts));
  return Object.keys(parent)
    .filter((name) => !allowed.has(name))
    .filter((name) => isSecretName(name))
    .sort();
}

function scopedEnvKeys(opts: ScopedEnvOptions): string[] {
  return Object.keys(scopedEnv(opts));
}
