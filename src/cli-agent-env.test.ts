import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CliAgentAdapter } from "../electron/agents/cli-agent";
import type { TaskPayload } from "../shared/types";

/**
 * End-to-end proof that env minimisation actually reaches the child process.
 *
 * The unit tests in `scoped-env.test.ts` prove the pure function is correct;
 * this file proves `dispatch()` uses it. Both are needed — the previous bug was
 * a correct-looking helper that no caller invoked.
 *
 * A real `node` child is spawned and asked to dump its own environment, so the
 * assertion is against externally observable fact, not against our own object.
 */
const NODE = process.execPath;
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-env-e2e-"));

/** Canary credentials planted in the parent process for the child to try to see. */
const CANARIES = {
  SENSENOVA_API_KEY: "sk-canary-sensenova",
  OPENAI_API_KEY: "sk-canary-openai",
  GITHUB_TOKEN: "ghp-canary-github",
  DB_PASSWORD: "canary-password",
} as const;

afterAll(() => {
  for (const name of Object.keys(CANARIES)) delete process.env[name];
  try {
    fs.rmSync(promptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // left to the OS temp cleaner
  }
});

function payload(): TaskPayload {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`,
    taskId: "t1",
    title: "dump env",
    description: "dump env",
    zone: "src",
    projectRoot: promptDir,
  };
}

/** Spawns a child that prints its own environment as JSON, and parses the result. */
async function childEnv(over: Partial<ConstructorParameters<typeof CliAgentAdapter>[0]> = {}) {
  const adapter = new CliAgentAdapter({
    id: "env-probe",
    command: NODE,
    argsTemplate: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    promptDir,
    ...over,
  });
  const handle = await adapter.dispatch(payload());
  const lines: string[] = [];
  for await (const e of adapter.collect(handle)) {
    // The child's stdout lines are emitted as `log` events, unfiltered; the
    // adapter's own synthetic notices carry a `[<id>] ` prefix and are skipped.
    if (e.kind !== "log") continue;
    if (e.text.startsWith(`[${adapter.meta.id}]`)) continue;
    lines.push(e.text);
  }
  // The child's JSON is one line; anything the adapter wrapped around it is not
  // our concern, so locate the object instead of assuming a clean payload.
  const json = lines.find((l) => l.trimStart().startsWith("{"));
  expect(json, `no JSON object in child output: ${lines.join(" | ").slice(0, 200)}`).toBeDefined();
  return JSON.parse(json!) as NodeJS.ProcessEnv;
}

describe("CliAgentAdapter.dispatch · subprocess environment", () => {
  it("does not leak unrelated provider credentials to the child", async () => {
    for (const [k, v] of Object.entries(CANARIES)) process.env[k] = v;
    const env = await childEnv();
    // THE regression: `{ ...process.env }` handed every one of these to the child.
    expect(env.SENSENOVA_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it("still gives the child everything it needs to run", async () => {
    const env = await childEnv();
    // Case-insensitive lookup: Windows exposes these upper-cased.
    const get = (n: string) =>
      Object.entries(env).find(([k]) => k.toUpperCase() === n.toUpperCase())?.[1];
    // A child with no PATH cannot resolve anything; no SystemRoot breaks Windows.
    expect(get("PATH")).toBeTruthy();
    if (process.platform === "win32") expect(get("SYSTEMROOT")).toBeTruthy();
  });

  it("passes envTemplate values through, including a granted credential", async () => {
    process.env.OX_E2E_GRANT = "granted-value";
    try {
      const env = await childEnv({
        envTemplate: { AGENT_MODE: "review", OX_E2E_GRANT: "{{taskId}}" },
      });
      expect(env.AGENT_MODE).toBe("review");
      // Templates are rendered before the child sees them.
      expect(env.OX_E2E_GRANT).toBe("t1");
    } finally {
      delete process.env.OX_E2E_GRANT;
    }
  });

  it("honours allowProviders for exactly the scoped provider", async () => {
    for (const [k, v] of Object.entries(CANARIES)) process.env[k] = v;
    const env = await childEnv({ allowProviders: ["openai"] });
    // Scoped in: visible. Not scoped: still hidden.
    expect(env.OPENAI_API_KEY).toBe("sk-canary-openai");
    expect(env.SENSENOVA_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  /**
   * probe() 也是真跑一次那个二进制（`--version`），所以它和 dispatch 一样是凭证出口。
   * 它 stdio 全 ignore，故让被探测的"CLI"把自身环境写进文件，再断言外部事实。
   */
  it("probe() does not hand the binary the operator's credentials either", async () => {
    process.env.OX_PROBE_CANARY_TOKEN = "canary";
    const file = path.join(promptDir, "probe-env.json");
    try {
      const adapter = new CliAgentAdapter({
        id: "probe-env",
        command: NODE,
        argsTemplate: ["--version"],
        probeArgs: ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env))`],
        promptDir,
      });
      expect(await adapter.probe()).toBe(true);
      const env = JSON.parse(fs.readFileSync(file, "utf8")) as NodeJS.ProcessEnv;
      expect(env.OX_PROBE_CANARY_TOKEN).toBeUndefined();
      expect(env.SENSENOVA_API_KEY).toBeUndefined();
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally {
      delete process.env.OX_PROBE_CANARY_TOKEN;
    }
  });
});
