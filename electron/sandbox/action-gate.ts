/**
 * Cross-action state machine (competitor research §5.1, learned from Omnigent's
 * stateful pre-checks).
 *
 * A batch is not a set of independent commands: an agent that installs a new
 * dependency mid-batch changes what every later command in that batch means.
 * The static CommandPolicy judges each command in isolation and cannot see
 * that context — this gate adds the missing "already happened in this batch"
 * dimension.
 *
 * Two layers, on purpose:
 * - `extractActionFacts` / `escalatedVerdict` are **pure functions** — same
 *   text in, same facts out; same facts + command in, same verdict out. That
 *   is the shape the mutation gate attacks best.
 * - `ActionGate` is a thin stateful shell with a batch lifetime: the scheduler
 *   feeds it every log line (the observation surface), the verifier queries it
 *   before spawning (the enforcement surface), and the orchestrator resets it
 *   at batch boundaries.
 *
 * The observation surface is heuristic on purpose: agent output is prose, and
 * a pattern that misses an install is a missed escalation, not a bypass — the
 * static policy floor (denied npm subcommands, denied git subcommands) stays
 * in charge regardless.
 */
import { NPM_FAMILY, type CommandDecision } from "./command-policy";

/** High-impact action traces observed within one batch. */
export interface ActionFacts {
  /** Dependency installs (npm install / yarn add / "added 5 packages" output). */
  installs: number;
  /** Publish actions (npm publish …) — an external write already happened. */
  publishes: number;
  /** Remote pushes (git push …) — the remote already moved. */
  pushes: number;
  /** First matching line per class, truncated, for the escalation reason. */
  samples: { installs?: string; publishes?: string; pushes?: string };
}

export const EMPTY_FACTS: ActionFacts = {
  installs: 0,
  publishes: 0,
  pushes: 0,
  samples: {},
};

const PATTERNS: Array<{ key: "installs" | "publishes" | "pushes"; re: RegExp }> = [
  // Command-line forms. `npm run install` (a script literally named install)
  // also matches: for an escalation trigger, over-observing is the safe side.
  { key: "installs", re: /\b(?:npm|pnpm|pnpx|yarn|bun)\s+(?:install|-i|i|add)\b/i },
  // The canonical npm install *output* line — agents often install without
  // echoing the command itself, but this line betrays it.
  { key: "installs", re: /\badded\s+\d+\s+packages?\s+in\b/i },
  { key: "publishes", re: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i },
  { key: "pushes", re: /\bgit\s+push\b/i },
];

const MAX_SAMPLE_LENGTH = 120;

/** Reduces one line of output to the action facts it betrays. Pure. */
export function extractActionFacts(line: string): ActionFacts {
  const facts: ActionFacts = { ...EMPTY_FACTS, samples: {} };
  for (const { key, re } of PATTERNS) {
    const hit = re.exec(line);
    if (!hit) continue;
    facts[key] += 1;
    if (!facts.samples[key]) {
      facts.samples[key] = line.trim().slice(0, MAX_SAMPLE_LENGTH);
    }
  }
  return facts;
}

const PUBLISH_ACTIONS = new Set(["publish", "adduser", "login", "token"]);

function baseName(command: string): string {
  const posix = command.trim().replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/, "");
}

/**
 * The escalation verdict, or `undefined` when no rule fires (the caller keeps
 * the static policy's verdict). Rules:
 *
 * 1. Any observed trace (install / publish / push) → `npx` is refused. npx
 *    silently downloads and executes an arbitrary package from the registry;
 *    once the dependency surface has been touched within the batch, that
 *    implicit fetch is no longer trustworthy.
 * 2. An external write already happened (publish / push) → `install`/`add`
 *    are refused too: what was published and what is on disk have diverged,
 *    and patching on top of that state belongs in a fresh batch.
 *
 * Commands the static policy already refuses (git push, npm publish …) are
 * refused there first — this layer is defence in depth plus a reason that
 * carries context, not the only line of defence.
 */
export function escalatedVerdict(
  facts: ActionFacts,
  command: string,
  args: readonly string[],
): CommandDecision | undefined {
  const base = baseName(command);
  const touched = facts.installs > 0 || facts.publishes > 0 || facts.pushes > 0;
  if (!touched) return undefined;

  const sub = (args[0] ?? "").toLowerCase();
  const context = () => {
    const seen: string[] = [];
    if (facts.installs > 0) seen.push(facts.samples.installs ?? "依赖安装");
    if (facts.publishes > 0) seen.push(facts.samples.publishes ?? "发布动作");
    if (facts.pushes > 0) seen.push(facts.samples.pushes ?? "远端推送");
    return seen.join("；");
  };

  if (base === "npx") {
    return {
      ok: false,
      reason: `批次内已观察到高影响动作（${context()}），npx 的隐式 registry 下载升级为拒绝（请改用项目内已安装的工具）`,
    };
  }
  if (NPM_FAMILY.has(base)) {
    if (PUBLISH_ACTIONS.has(sub)) {
      return {
        ok: false,
        reason: `批次内已观察到高影响动作（${context()}），对外发布/账号类子命令升级为拒绝：${base} ${sub}`,
      };
    }
    if (facts.publishes > 0 || facts.pushes > 0) {
      if (sub === "install" || sub === "add" || sub === "i") {
        return {
          ok: false,
          reason: `本批次已发生过对外发布/推送（${context()}），依赖变更升级为拒绝：${base} ${sub}（请在新批次中重做）`,
        };
      }
    }
  }
  return undefined;
}

/** The narrow shape the scheduler observes and the verifier queries. */
export interface ActionGateLike {
  observe(text: string): void;
  check(command: string, args: readonly string[]): CommandDecision | undefined;
  reset(): void;
}

/** Batch-scoped tracker: observe on every log line, query before every spawn. */
export class ActionGate implements ActionGateLike {
  private facts: ActionFacts = { ...EMPTY_FACTS, samples: {} };

  observe(text: string): void {
    // `observe` receives streamed log lines; tolerate multi-line chunks anyway
    // so callers that buffer output stay correct.
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const f = extractActionFacts(line);
      this.facts.installs += f.installs;
      this.facts.publishes += f.publishes;
      this.facts.pushes += f.pushes;
      for (const key of ["installs", "publishes", "pushes"] as const) {
        if (!this.facts.samples[key] && f.samples[key]) this.facts.samples[key] = f.samples[key];
      }
    }
  }

  check(command: string, args: readonly string[]): CommandDecision | undefined {
    return escalatedVerdict(this.facts, command, args);
  }

  reset(): void {
    this.facts = { ...EMPTY_FACTS, samples: {} };
  }

  /** Diagnostic snapshot (tests / settings panel). */
  snapshot(): ActionFacts {
    return this.facts;
  }
}
