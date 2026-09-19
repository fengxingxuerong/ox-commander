import fs from "node:fs";
import path from "node:path";
import { CommandPolicy, createDefaultCommandPolicy } from "./command-policy";

/**
 * How to actually spawn a checked command.
 *
 * The problem this exists for (found by a real end-to-end run, not by unit
 * tests): on Windows `npm`, `yarn`, `gradle` … are `.cmd` shims, and
 *
 *     spawn("npm",    ["run","build"], { shell: false })  → ENOENT
 *     spawn("npm.cmd",["run","build"], { shell: false })  → EINVAL   (Node ≥18)
 *
 * Node refuses to execute a `.cmd`/`.bat` without a shell (a hardening change
 * after CVE-2024-27980), and libuv does **not** resolve `npm` → `npm.cmd`.
 * Telling `verifier.ts` to use `shell: false` therefore silently broke every
 * default verification command on Windows: `exitCode: null`, no output.
 *
 * The fix is the documented one — hand the shim to `cmd.exe /d /s /c` — and it
 * is safe **only** because `CommandPolicy` has already rejected shell
 * metacharacters (`; & | ` $ < >` and newlines) in both the command and every
 * argument. That coupling is the whole security argument:
 *
 *     if (!policy.check(command, args).ok) → never reaches buildSpawnSpec()
 *
 * So: check first, wrap second. Never call this on unchecked input.
 */
export interface SpawnSpec {
  file: string;
  args: string[];
  /** Pass through to spawn options: cmd.exe needs the line kept verbatim. */
  windowsVerbatimArguments: boolean;
  /** Why this shape was chosen — surfaced in logs when a command fails. */
  note: string;
}

export interface BuildSpawnSpecOptions {
  /** Injectable for tests; defaults to the real platform. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Resolver override for tests. */
  resolve?: (command: string, env: NodeJS.ProcessEnv) => string;
}

const CMD_EXTENSIONS = [".cmd", ".bat"];

/** Minimal Windows argument quoting; metacharacters were already rejected upstream. */
export function quoteForCmd(value: string): string {
  if (value === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Resolves a bare command against PATH, honouring PATHEXT on Windows. */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (path.isAbsolute(command)) return command;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);

  if (platform !== "win32") {
    for (const dir of dirs) {
      const candidate = path.join(dir, command);
      if (isFile(candidate)) return candidate;
    }
    return command;
  }

  /*
   * Windows: PATHEXT order decides, and an extension-less hit is *not* a valid
   * executable here. This matters in practice — a Node distribution shipped
   * inside a dev sandbox can put a Unix shell script called `npm` on PATH, and
   * a naive lookup (trying the bare name first) resolves to it, then fails with
   * `ENOENT` because Windows cannot exec it. The real `npm.cmd` sitting later
   * on PATH never gets a chance.
   */
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return command;
}

function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when the resolved target is a Windows shim that requires cmd.exe. */
export function needsCmdWrapper(resolved: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const lower = resolved.toLowerCase();
  return CMD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Builds the spawn triple for an **already policy-checked** command.
 *
 * - POSIX: unchanged (`file = command`, `shell: false`).
 * - Windows + `.exe`/built-in: direct, `shell: false`.
 * - Windows + `.cmd`/`.bat`: `%COMSPEC% /d /s /c "<shim>" <args…>`, verbatim.
 */
export function buildSpawnSpec(
  command: string,
  args: readonly string[],
  opts: BuildSpawnSpecOptions = {},
): SpawnSpec {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== "win32") {
    return { file: command, args: [...args], windowsVerbatimArguments: false, note: "posix direct" };
  }
  const resolve = opts.resolve ?? resolveCommand;
  const resolved = resolve(command, env);
  if (!needsCmdWrapper(resolved, platform)) {
    return { file: resolved, args: [...args], windowsVerbatimArguments: false, note: "windows direct" };
  }
  const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  const line = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(" ");
  return {
    file: comspec,
    args: ["/d", "/s", "/c", line],
    windowsVerbatimArguments: true,
    note: "windows cmd shim",
  };
}

/**
 * Convenience for callers that want both halves in one place: check, then build.
 * Throws (like `CommandPolicy.assert`) when the command is refused.
 */
export function planSpawn(
  command: string,
  args: readonly string[],
  policy: CommandPolicy = createDefaultCommandPolicy(),
  opts: BuildSpawnSpecOptions = {},
): SpawnSpec {
  policy.assert(command, args);
  return buildSpawnSpec(command, args, opts);
}
