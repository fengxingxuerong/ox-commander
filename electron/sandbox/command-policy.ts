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
 */
const EVAL_FLAGS: Record<string, readonly string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
  npx: [],
};

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
  private readonly denyMeta: boolean;
  private readonly denyEval: boolean;

  constructor(opts: CommandPolicyOptions = {}) {
    this.allow = new Set((opts.allow ?? DEFAULT_ALLOWED_COMMANDS).map((c) => baseName(c)));
    this.deny = new Set([...(opts.deny ?? DEFAULT_DENIED_COMMANDS), ...(opts.denyMore ?? [])].map((c) => baseName(c)));
    this.denyGit = new Set([
      ...DEFAULT_DENIED_GIT_SUBCOMMANDS,
      ...(opts.denyGitSubcommands ?? []),
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
      if (evalFlags && evalFlags.length > 0) {
        const hit = args.find((a) => evalFlags.includes(a));
        if (hit) {
          return { ok: false, reason: `拒绝内联求值参数 ${hit}（把代码放进脚本文件再执行）` };
        }
      }
    }
    if (base === "git") {
      const sub = (args[0] ?? "").toLowerCase();
      if (this.denyGit.has(sub)) {
        return { ok: false, reason: `git 子命令被沙箱禁止：git ${sub}` };
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
