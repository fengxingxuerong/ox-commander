import { describe, expect, it } from "vitest";
import {
  ActionGate,
  EMPTY_FACTS,
  escalatedVerdict,
  extractActionFacts,
} from "../electron/sandbox/action-gate";
import { CommandPolicy } from "../electron/sandbox/command-policy";
import { verifyProject } from "../electron/engine/verifier";

/**
 * Behavioural lock for the cross-action state machine (competitor research
 * §5.1): the static CommandPolicy judges each command in isolation; this adds
 * the "what already happened in this batch" dimension. Pure functions carry
 * the rules; the tracker and the verifier wiring are thin.
 */

describe("extractActionFacts", () => {
  it("recognises install / publish / push traces in command-line form", () => {
    for (const [line, key] of [
      ["npm install express", "installs"],
      ["$ pnpm i --frozen-lockfile", "installs"],
      ["yarn add zod", "installs"],
      ["bun add -d typescript", "installs"],
      ["npm publish --access public", "publishes"],
      ["git push origin main", "pushes"],
    ] as const) {
      const f = extractActionFacts(line);
      expect(f[key], line).toBe(1);
    }
  });

  it("recognises the canonical npm install output line", () => {
    expect(extractActionFacts("added 47 packages in 2m").installs).toBe(1);
    expect(extractActionFacts("added 1 package in 3s").installs).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(extractActionFacts("NPM INSTALL express").installs).toBe(1);
    expect(extractActionFacts("GIT PUSH --force").pushes).toBe(1);
  });

  it("reports nothing for ordinary build output", () => {
    const f = extractActionFacts("npm run build → tsc --noEmit → 0 errors");
    expect(f).toEqual(EMPTY_FACTS);
  });

  it("truncates the sample line and keeps the first hit per class", () => {
    const f = extractActionFacts(`npm install ${"x".repeat(400)}`);
    expect(f.installs).toBe(1);
    expect((f.samples.installs ?? "").length).toBeLessThanOrEqual(120);
  });
});

describe("escalatedVerdict", () => {
  it("returns undefined when nothing was observed (no escalation at all)", () => {
    for (const [cmd, args] of [
      ["npx", ["tsc", "--noEmit"]],
      ["npm", ["publish"]],
      ["git", ["push", "origin"]],
      ["node", ["build.js"]],
    ] as const) {
      expect(escalatedVerdict(EMPTY_FACTS, cmd, [...args])).toBeUndefined();
    }
  });

  it("refuses npx once any high-impact trace was observed (rule 1)", () => {
    const facts = extractActionFacts("npm install express");
    const v = escalatedVerdict(facts, "npx", ["cowsay"]);
    expect(v?.ok).toBe(false);
    expect(v && !v.ok ? v.reason : "").toContain("npx");
    // A plain runner is untouched by rule 1.
    expect(escalatedVerdict(facts, "node", ["build.js"])).toBeUndefined();
    expect(escalatedVerdict(facts, "npm", ["run", "build"])).toBeUndefined();
  });

  it("refuses npm publish/account subcommands after installs (defence in depth)", () => {
    const facts = extractActionFacts("added 5 packages in 2s");
    expect(escalatedVerdict(facts, "npm", ["publish"])?.ok).toBe(false);
    expect(escalatedVerdict(facts, "npm", ["login"])?.ok).toBe(false);
    expect(escalatedVerdict(facts, "pnpm", ["publish"])?.ok).toBe(false);
  });

  it("refuses installs once an external write happened (rule 2)", () => {
    const published = extractActionFacts("npm publish");
    const pushed = extractActionFacts("git push origin main");
    for (const facts of [published, pushed]) {
      expect(escalatedVerdict(facts, "npm", ["install"])?.ok).toBe(false);
      expect(escalatedVerdict(facts, "yarn", ["add", "zod"])?.ok).toBe(false);
      // …but plain builds stay allowed.
      expect(escalatedVerdict(facts, "npm", ["run", "build"])).toBeUndefined();
    }
  });

  it("resolves the command base through paths and extensions", () => {
    const facts = extractActionFacts("npm install express");
    expect(escalatedVerdict(facts, "C:/tools/npx.cmd", ["cowsay"])?.ok).toBe(false);
  });
});

describe("ActionGate", () => {
  it("accumulates observations, escalates, and forgets on reset", () => {
    const gate = new ActionGate();
    expect(gate.check("npx", ["cowsay"])).toBeUndefined();
    gate.observe("… npm install express …");
    gate.observe("git push origin main");
    expect(gate.snapshot().installs).toBe(1);
    expect(gate.snapshot().pushes).toBe(1);
    expect(gate.check("npx", ["cowsay"])?.ok).toBe(false);
    expect(gate.check("npm", ["install"])?.ok).toBe(false);
    gate.reset();
    expect(gate.snapshot()).toEqual(EMPTY_FACTS);
    expect(gate.check("npx", ["cowsay"])).toBeUndefined();
  });

  it("tolerates multi-line chunks and blank lines", () => {
    const gate = new ActionGate();
    gate.observe("ok\nnpm publish --access public\n\ndone");
    expect(gate.snapshot().publishes).toBe(1);
  });

  it("skips leading blank lines and keeps the FIRST sample per class", () => {
    const gate = new ActionGate();
    // A leading blank line must be skipped, not stop the scan (break would
    // drop every fact after it); and the second install must not overwrite
    // the first sample — "first observed" is the audit-relevant one.
    gate.observe("\nnpm install first-pkg\nnpm install second-pkg");
    expect(gate.snapshot().installs).toBe(2);
    expect(gate.snapshot().samples.installs).toContain("first-pkg");
  });
});

describe("CommandPolicy · npm subcommand floor", () => {
  const p = new CommandPolicy();

  it("refuses publish/credential/config subcommands on the npm family", () => {
    for (const [cmd, sub] of [
      ["npm", "publish"],
      ["pnpm", "publish"],
      ["yarn", "publish"],
      ["npm", "adduser"],
      ["npm", "login"],
      ["npm", "token"],
      ["npm", "config"],
    ] as const) {
      const d = p.check(cmd, [sub]);
      expect(d.ok, `${cmd} ${sub}`).toBe(false);
    }
  });

  it("keeps legitimate npm actions allowed", () => {
    expect(p.check("npm", ["install"]).ok).toBe(true);
    expect(p.check("npm", ["test"]).ok).toBe(true);
    expect(p.check("npm", ["run", "build"]).ok).toBe(true);
  });

  it("accepts extra npm subcommands to refuse", () => {
    const p2 = new CommandPolicy({ denyNpmSubcommands: ["rebuild"] });
    expect(p2.check("npm", ["rebuild"]).ok).toBe(false);
    expect(p.check("npm", ["rebuild"]).ok).toBe(true);
  });
});

describe("verifyProject · cross-action escalation wiring", () => {
  it("a gate refusal becomes a failed step and nothing is spawned", async () => {
    let spawned = 0;
    const results = await verifyProject([{ kind: "build", command: "npx", args: ["cowsay"] }], {
      cwd: () => ".",
      spawnImpl: (() => {
        spawned += 1;
        throw new Error("must not spawn");
      }) as never,
      actionGate: {
        observe: () => undefined,
        check: () => ({ ok: false, reason: "升级拒绝（测试桩）" }),
        reset: () => undefined,
      },
    });
    expect(spawned).toBe(0);
    expect(results.passed).toBe(false);
    expect(results.results[0]!.logDigest).toContain("升级拒绝");
    expect(results.results[0]!.exitCode).toBeNull();
  });

  it("a quiet gate leaves the static policy in charge", async () => {
    const results = await verifyProject([{ kind: "build", command: "npx", args: ["nope-nothing"] }], {
      cwd: () => ".",
      spawnImpl: (() => {
        throw new Error("must not spawn");
      }) as never,
      actionGate: {
        observe: () => undefined,
        check: () => undefined,
        reset: () => undefined,
      },
    });
    // Static policy refused npx? No — npx is allow-listed; the fake spawn threw,
    // which surfaces as a failed *run*, proving the gate did not short-circuit.
    expect(results.results[0]!.logDigest).not.toContain("升级拒绝");
  });
});
