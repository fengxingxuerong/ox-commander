import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentAdapter } from "../../shared/types";
import type { AgentCredential, AgentLimits, AgentManifest } from "../../shared/agent-contract";
import { ManifestValidationError, parseAgentManifestList } from "./manifest-schema";
import { CliAgentAdapter } from "./cli-agent";
import { HttpBridgeAdapter } from "./http-bridge";

export interface ManifestLoadError {
  file: string;
  message: string;
}

export interface LoadedManifests {
  manifests: AgentManifest[];
  errors: ManifestLoadError[];
}

/** Files ending in `.example.json` are documentation, never loaded. */
function isManifestFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".example.json");
}

/**
 * Reads `agents.d/*.json`. A malformed file is reported and skipped — one bad
 * declaration must never take the whole agent pool down.
 */
export function loadManifestDir(dir: string): LoadedManifests {
  const manifests: AgentManifest[] = [];
  const errors: ManifestLoadError[] = [];
  if (!fs.existsSync(dir)) return { manifests, errors };
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return { manifests, errors: [{ file: dir, message: (err as Error).message }] };
  }
  for (const name of entries.filter(isManifestFile).sort()) {
    const file = path.join(dir, name);
    try {
      const parsed = parseAgentManifestList(JSON.parse(stripBom(fs.readFileSync(file, "utf8"))));
      for (const m of parsed) manifests.push({ ...m, source: "agents.d" });
    } catch (err) {
      errors.push({
        file: name,
        message: err instanceof ManifestValidationError ? err.issues.join("；") : (err as Error).message,
      });
    }
  }
  return { manifests, errors };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface BuildAdaptersOptions {
  /** Directory for CLI prompt files; defaults to a temp dir per agent. */
  promptDir?: string;
  /** Reserved for future per-agent env overrides. */
  env?: NodeJS.ProcessEnv;
}

export interface BuildAdaptersResult {
  adapters: AgentAdapter[];
  /** Manifests that could not be turned into an adapter, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Turns validated manifests into live adapters. `local-llm` manifests are
 * skipped on purpose: those agents are compiled in (they need the provider
 * catalog and the key store) and are registered by the assembly layer.
 */
export function buildAdaptersFromManifests(
  manifests: readonly AgentManifest[],
  opts: BuildAdaptersOptions = {},
): BuildAdaptersResult {
  const adapters: AgentAdapter[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const m of manifests) {
    const caps = m.capabilities;
    const limits: Partial<AgentLimits> | undefined = m.limits;
    try {
      if (m.entry?.kind === "cli") {
        adapters.push(
          new CliAgentAdapter({
            id: m.id,
            name: m.displayName,
            command: m.entry.command,
            argsTemplate: m.entry.argsTemplate,
            ...(m.entry.probeArgs ? { probeArgs: m.entry.probeArgs } : {}),
            ...(m.entry.envTemplate ? { envTemplate: m.entry.envTemplate } : {}),
            capabilities: caps,
            ...(limits ? { limits } : {}),
            ...(opts.promptDir ? { promptDir: path.join(opts.promptDir, m.id) } : {}),
          }),
        );
        continue;
      }
      if (m.entry?.kind === "http") {
        adapters.push(
          new HttpBridgeAdapter({
            id: m.id,
            name: m.displayName,
            baseUrl: m.entry.baseUrl,
            ...(m.entry.healthPath ? { healthPath: m.entry.healthPath } : {}),
            ...(m.entry.runsPath ? { runsPath: m.entry.runsPath } : {}),
            ...(m.entry.pollMs !== undefined ? { pollMs: m.entry.pollMs } : {}),
            ...(m.entry.headers ? { headers: m.entry.headers } : {}),
            ...(m.credential ? { credential: m.credential } : {}),
            capabilities: caps,
            ...(limits ? { limits } : {}),
            ...(m.credential ? { resolveToken: tokenResolver(m.credential) } : {}),
          }),
        );
        continue;
      }
      skipped.push({
        id: m.id,
        reason:
          m.entry?.kind === "builtin"
            ? `内置适配器（provider=${m.entry.provider}）由装配层注册，无需声明`
            : "manifest 缺少可执行的 entry",
      });
    } catch (err) {
      skipped.push({ id: m.id, reason: (err as Error).message });
    }
  }
  return { adapters, skipped };
}

/** `execToken` credential: run the command and read the token from stdout. */
export function tokenResolver(cred: AgentCredential): () => Promise<string | undefined> {
  if (cred.kind !== "execToken") return async () => undefined;
  const { command, args } = cred;
  return () =>
    new Promise<string | undefined>((resolve) => {
      let out = "";
      let settled = false;
      const done = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
        const timer = setTimeout(() => {
          child.kill();
          done(undefined);
        }, 10_000);
        child.stdout?.on("data", (c: Buffer) => {
          out += c.toString("utf8");
        });
        child.on("error", () => {
          clearTimeout(timer);
          done(undefined);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done(code === 0 ? out.trim() || undefined : undefined);
        });
      } catch {
        done(undefined);
      }
    });
}
