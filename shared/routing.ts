import type { Task, VerificationReport } from "./types";
import { isPathInZone } from "./glob";

/**
 * Extracts workspace-relative file paths referenced by errors in build/test
 * logs. Matches the output shapes of tsc, node stack traces, and the node:test
 * runner. Absolute stack paths are relativized against `rootAbs` when given;
 * paths under node_modules/ are ignored (library internals, not code the
 * agents can fix).
 */
export function extractErrorFiles(log: string, rootAbs?: string): string[] {
  const rootPrefix = rootAbs
    ? rootAbs.replace(/\\/g, "/").replace(/\/+$/, "") + "/"
    : undefined;
  const out = new Set<string>();
  const push = (raw: string): void => {
    // Normalize separators; strip a leading ./ and any drive/root prefix.
    let rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rootPrefix && rel.startsWith(rootPrefix)) rel = rel.slice(rootPrefix.length);
    else if (rootPrefix && /^[A-Za-z]:\//.test(rel)) {
      // Absolute path under a different root: unusable for zone matching.
      return;
    }
    if (rel.startsWith("node_modules/")) return;
    // Only keep plausible workspace-relative source paths.
    if (!/\.(js|cjs|mjs|ts|tsx|jsx|json)$/.test(rel)) return;
    out.add(rel);
  };

  // tsc: src/foo.ts(12,3): error TS2339  |  src/foo.ts:12:3 - error
  for (const m of log.matchAll(/(?:^|[\s(])([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?::\d+:\d+|\(\d+,\d+\))[:\s]/g)) {
    push(m[1]);
  }
  // node stack frames: at fn (/abs/root/src/foo.js:12:34)  |  at fn (src/foo.js:12:34)
  for (const m of log.matchAll(/at\s+(?:[\w$.<>]+)\s+\(([^()]+?):\d+:\d+\)/g)) {
    push(m[1]);
  }
  // node:test / jest / mocha failure lines: ✖/FAIL/failing file
  for (const m of log.matchAll(/(?:✖|FAIL|failing tests:?)\s*([\w./\\-]+\.(?:test\.)?(?:js|cjs|mjs|ts|tsx))/g)) {
    push(m[1]);
  }
  return [...out];
}

function isInsideZone(relPath: string, zone: string): boolean {
  return isPathInZone(relPath, zone);
}

export interface RoutedErrors {
  /** Digest handed to the task whose zone owns the failing files. */
  byTask: Map<string, string>;
  /** Digest for errors that could not be attributed to any task's zone. */
  unattributed: string;
}

/**
 * Routes verification errors to the task responsible for the failing file.
 * Attributed errors go only to the owning task; unattributed ones go to every
 * pending task (the previous behaviour of blasting the whole digest at
 * everyone, which drowned the signal).
 */
export function routeVerificationErrors(
  report: VerificationReport,
  pendingTasks: Task[],
  rootAbs?: string,
): RoutedErrors {
  const failing = report.results.filter((r) => !r.ok);
  const errorText = failing
    .map((r) => `[${r.kind}] exit=${r.exitCode}\n${r.logDigest}`)
    .join("\n\n");
  if (!errorText) return { byTask: new Map(), unattributed: "" };

  const attributed = new Map<string, Array<{ kind: string; digest: string }>>();
  const unattributed: Array<{ kind: string; digest: string }> = [];

  for (const r of failing) {
    const files = extractErrorFiles(r.logDigest, rootAbs);
    const fileLines = files.length > 0 ? `\n涉及文件：${files.join("、")}` : "";
    const owners = files
      .map((f) => pendingTasks.find((t) => isInsideZone(f, t.zone)))
      .filter((t): t is Task => t !== undefined);
    const uniqueOwners = [...new Set(owners.map((t) => t.id))];
    const entry = { kind: r.kind, digest: `${r.logDigest}${fileLines}` };
    if (uniqueOwners.length === 0) {
      unattributed.push(entry);
    } else {
      for (const id of uniqueOwners) {
        if (!attributed.has(id)) attributed.set(id, []);
        attributed.get(id)!.push(entry);
      }
    }
  }

  const byTask = new Map<string, string>();
  for (const [taskId, entries] of attributed) {
    byTask.set(
      taskId,
      entries.map((e) => `[${e.kind}]（已定位到你的 zone）\n${e.digest}`).join("\n\n"),
    );
  }
  return { byTask, unattributed: unattributed.map((e) => `[${e.kind}]\n${e.digest}`).join("\n\n") };
}
