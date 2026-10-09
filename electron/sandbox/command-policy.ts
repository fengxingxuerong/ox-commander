/**
 * Programs that may be executed as part of verification. Deliberately broad
 * enough to cover real build/test toolchains (the pre-sandbox behaviour allowed
 * *any* configured command, so a narrow list would be a regression), while the
 * structural checks below are what actually removes the attack surface.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "eslint",
  "prettier",
  "make",
  "cmake",
  "cargo",
  "go",
  "dotnet",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "python",
  "python3",
  "pytest",
  "pip",
  "ruff",
  "mypy",
  "git",
];

/**
 * Programs that are never allowed, even if an allow list mentions them. These
 * can destroy the machine, escape the sandbox, or reach the network — none of
 * which is a legitimate part of "build and test this project".
 */
export const DEFAULT_DENIED_COMMANDS: readonly string[] = [
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "format",
  "diskpart",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "reg",
  "regedit",
  "taskkill",
  "wmic",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "sudo",
  "su",
  "chmod",
  "chown",
  "chattr",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "kill",
  "killall",
];

/** Git subcommands that can rewrite history, mutate config, or touch a remote. */
export const DEFAULT_DENIED_GIT_SUBCOMMANDS: readonly string[] = [
  "push",
  "reset",
  "clean",
  "filter-branch",
  "filter-repo",
  "update-ref",
  "gc",
  "prune",
  "remote",
  "config",
  "reflog",
  "credential",
];

/**
 * npm-family subcommands that verification/smoke commands never need: they
 * publish to a registry, touch account credentials, or mutate npm config.
 * Before this floor existed, an AI-generated smoke command `npm publish`
 * sailed through — `npm` is on the allow list and subcommands were unjudged
 * (2026-09-29, competitor research §5.1). `install`/`add` stay allowed:
 * restoring build dependencies is a legitimate verification action.
 */
export const DEFAULT_DENIED_NPM_SUBCOMMANDS: readonly string[] = [
  "publish",
  "adduser",
  "login",
  "logout",
  "token",
  "config",
];

/**
 * The package-manager family whose subcommands the npm floor judges. Single
 * source of truth: the ActionGate escalation rules import this instead of
 * redefining it, so a new package manager added here is covered by both
 * layers at once.
 */
export const NPM_FAMILY: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * Shell metacharacters. These matter even though nothing is ever spawned with
 * `shell: true`: on Windows, `.cmd`/`.bat` shims (npm, yarn, gradle …) are
 * executed through `cmd.exe` by libuv, which re-parses the argument string.
 * Rejecting them here is what makes that path safe.
 *
 * Windows-specific additions:
 * - `^` is the cmd.exe escape character — it can splice tokens together after
 *   this allow list has judged them.
 * - `!` drives delayed expansion where the host has it enabled.
 * - `%VAR%` (pair form) is expanded by cmd.exe re-parsing the shim command
 *   line; e.g. `--key=%SENSENOVA_API_KEY%` would move the real secret into the
 *   child's argv. A lone `%` with no closing pair (e.g. `100%`) is left alone
 *   by cmd.exe and therefore stays allowed.
 */
const SHELL_METACHARACTERS = /[;&|`$<>^!]|%[A-Za-z0-9_()#][^%]*%|\$\(|\r|\n/;

/**
 * Inline-evaluation flags. `node -e`, `python -c` … turn a whitelisted
 * interpreter into an arbitrary-code launcher, which defeats the point of a
 * command allow list: the sandbox would be checking the door while the window
 * is open. Real verification scripts live in files, which stay allowed.
 *
 * `npx` has no entry here on purpose: it does not evaluate, it forwards, and the
 * forwarding is judged by the launcher rules below. An empty list used to sit in
 * this table, and the empty-list guard skipped it outright, so npx was never
 * judged at all — `npx -c 'node -e …'` reached arbitrary code through the door
 * that `node -e` is refused at (2026-10-09).
 */
const EVAL_FLAGS: Record<string, readonly string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
};

/**
 * Subcommands that hand the rest of argv to *another* program, so the inline-eval
 * flags never appear in that program's own position: `npm exec` and its `x`
 * alias, verified against npm 11.16 (`npm e` is not an alias there, so it is not
 * listed), and pnpm's `dlx`, verified against pnpm 11.21. Yarn Berry and bun use
 * the same names but are not installed on this machine. `npx` is `npm exec`.
 */
const EXEC_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "x", "dlx"]);

/**
 * Launcher options that consume the token after them as their value. While only
 * these come first, no nested program has been named yet — that is what tells
 * `npm exec --package cowsay -c 'node -e …'` (a shell string) apart from
 * `npm exec eslint -c config.json` (eslint's own flag). Read off
 * `npm exec --help` on npm 11.16.
 */
const EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--package", "-w", "--workspace"]);

/** The launcher's own shell-string option: one string, handed to a shell. */
function isShellCallFlag(token: string): boolean {
  return token === "-c" || token === "--call" || token.startsWith("--call=");
}

const NO_EVAL_FLAGS: readonly string[] = [];

/**
 * An inline-eval token reachable only through a launcher, or null when the
 * command forwards nothing. The forwarded argv reads left to right: a `-c/--call`
 * in the launcher's option position is a shell string; once a plain token names
 * the nested program, its own argv is judged with the same EVAL_FLAGS table.
 */
function launcherEvalHit(base: string, args: readonly string[]): string | null {
  let tail: readonly string[] | null = null;
  if (base === "npx") tail = args;
  else if (NPM_FAMILY.has(base) && EXEC_SUBCOMMANDS.has((args[0] ?? "").toLowerCase())) {
    tail = args.slice(1);
  }
  if (tail === null) return null;

  let flags: readonly string[] | null = null;
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i] ?? "";
    if (flags !== null) {
      if (flags.includes(token)) return token;
      continue;
    }
    if (isShellCallFlag(token)) return token;
    if (EXEC_VALUE_OPTIONS.has(tail[i - 1] ?? "")) continue;
    if (!token.startsWith("-")) flags = EVAL_FLAGS[baseName(token)] ?? NO_EVAL_FLAGS;
  }
  return null;
}

export interface CommandPolicyOptions {
  /** Replaces `DEFAULT_ALLOWED_COMMANDS` when provided. */
  allow?: readonly string[];
  /** Extends `DEFAULT_DENIED_COMMANDS`. */
  denyMore?: readonly string[];
  /** Replaces `DEFAULT_DENIED_COMMANDS` when provided (escape hatch for tests). */
  deny?: readonly string[];
  /** Set false to permit metacharacters (only for exotic, reviewed toolchains). */
  denyShellMetacharacters?: boolean;
  /** Set false to permit `node -e` / `python -c` style inline evaluation. */
  denyEvalFlags?: boolean;
  /** Extra git subcommands to refuse. */
  denyGitSubcommands?: readonly string[];
  /** Extra npm-family subcommands to refuse (extends the default floor). */
  denyNpmSubcommands?: readonly string[];
}

export type CommandDecision = { ok: true } | { ok: false; reason: string };

function baseName(command: string): string {
  const posix = command.trim().replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
}

/**
 * Structural gate for every command the platform runs on behalf of an agent.
 *
 * Order: denied program → metacharacters (command *and* args) → allowed program
 * → denied git subcommand. A program that appears in both allow and deny is
 * denied: the deny list is a safety floor, not a preference.
 */
export class CommandPolicy {
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly denyGit: Set<string>;
  private readonly denyNpm: Set<string>;
  private readonly denyMeta: boolean;
  private readonly denyEval: boolean;

  constructor(opts: CommandPolicyOptions = {}) {
    this.allow = new Set((opts.allow ?? DEFAULT_ALLOWED_COMMANDS).map((c) => baseName(c)));
    this.deny = new Set([...(opts.deny ?? DEFAULT_DENIED_COMMANDS), ...(opts.denyMore ?? [])].map((c) => baseName(c)));
    this.denyGit = new Set([
      ...DEFAULT_DENIED_GIT_SUBCOMMANDS,
      ...(opts.denyGitSubcommands ?? []),
    ]);
    this.denyNpm = new Set([
      ...DEFAULT_DENIED_NPM_SUBCOMMANDS,
      ...(opts.denyNpmSubcommands ?? []),
    ]);
    this.denyMeta = opts.denyShellMetacharacters ?? true;
    this.denyEval = opts.denyEvalFlags ?? true;
  }

  check(command: string, args: readonly string[] = []): CommandDecision {
    if (typeof command !== "string" || command.trim() === "") {
      return { ok: false, reason: "命令为空" };
    }
    const base = baseName(command);
    if (base === "") return { ok: false, reason: `无法解析命令：${command}` };

    if (this.deny.has(base)) {
      return { ok: false, reason: `命令被沙箱禁止：${base}` };
    }
    if (!this.allow.has(base)) {
      return { ok: false, reason: `命令不在白名单内：${base}（如需使用请在设置中显式放开）` };
    }
    if (this.denyMeta) {
      if (SHELL_METACHARACTERS.test(command)) {
        return { ok: false, reason: `命令含 shell 元字符：${command}` };
      }
      for (const arg of args) {
        if (SHELL_METACHARACTERS.test(arg)) {
          return { ok: false, reason: `参数含 shell 元字符：${arg}` };
        }
      }
    }
    if (this.denyEval) {
      const evalFlags = EVAL_FLAGS[base];
      if (evalFlags) {
        const hit = args.find((a) => evalFlags.includes(a));
        if (hit) {
          return { ok: false, reason: `拒绝内联求值参数 ${hit}（把代码放进脚本文件再执行）` };
        }
      }
      const forwarded = launcherEvalHit(base, args);
      if (forwarded) {
        return {
          ok: false,
          reason: `拒绝经 ${base} 转发的内联求值参数 ${forwarded}（把代码放进脚本文件再执行）`,
        };
      }
    }
    if (base === "git") {
      const sub = (args[0] ?? "").toLowerCase();
      if (this.denyGit.has(sub)) {
        return { ok: false, reason: `git 子命令被沙箱禁止：git ${sub}` };
      }
    }
    // npm-family publish/credential/config subcommands: verification and smoke
    // commands never need them. Same shape as the git check above.
    if (NPM_FAMILY.has(base)) {
      const sub = (args[0] ?? "").toLowerCase();
      if (this.denyNpm.has(sub)) {
        return { ok: false, reason: `${base} 子命令被沙箱禁止：${base} ${sub}（验证/冒烟命令不需要对外发布、账号或配置操作）` };
      }
    }
    return { ok: true };
  }

  /** Convenience for callers that want an exception on rejection. */
  assert(command: string, args: readonly string[] = []): void {
    const d = this.check(command, args);
    if (!d.ok) throw new Error(d.reason);
  }

  /** Human-readable summary for the settings panel. */
  describe(): { allowed: string[]; denied: string[]; deniedGitSubcommands: string[] } {
    return {
      allowed: [...this.allow].sort(),
      denied: [...this.deny].sort(),
      deniedGitSubcommands: [...this.denyGit].sort(),
    };
  }
}

export function createDefaultCommandPolicy(): CommandPolicy {
  return new CommandPolicy();
}
