import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentAdapter } from "../../shared/types";
import type { AgentCredential, AgentLimits, AgentManifest } from "../../shared/agent-contract";
import { ManifestValidationError, parseAgentManifestList } from "./manifest-schema";
import { writeFileAtomic } from "../atomic-file";
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

/* ──────────────────────────── 动态注册的落盘 ──────────────────────────── */

export interface SaveManifestResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

export interface RemoveManifestResult {
  ok: boolean;
  /** 文件确实被删掉了（false = 本来就不存在，或因为被改过而没删）。 */
  removed: boolean;
  reason?: string;
}

/**
 * 运行时注册的智能体写回 `agents.d/<id>.json`，这样重启后 `loadManifestDir`
 * 还能把它读出来。
 *
 * 为什么必须落盘：注册此前只进内存 Map，重启即失，而 UI 只是提示用户
 * "自己把 JSON 抄到 agents.d" —— 一次注销或崩溃，配置就没了。
 *
 * 文件名由 id 决定，这样**重启之后也能定位**（注销时内存里的映射已经没了）。
 * id 里的路径分隔符等非法字符换成 `_`；只有真发生了替换才追加一段短哈希，
 * 否则 `a/b` 与 `a b` 会撞成同一个文件名。
 */
export function manifestFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const stem = safe === id ? id : `${safe}-${fnv1a32(id)}`;
  return `${stem || "agent"}.json`;
}

export function saveManifestFile(dir: string, manifest: AgentManifest): SaveManifestResult {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, manifestFileName(manifest.id));
    writeFileAtomic(file, `${JSON.stringify(stripped(manifest), null, 2)}\n`);
    return { ok: true, path: file };
  } catch (err) {
    // 注册本身已经成功了，落盘失败不能把它变成失败 —— 但要如实报上去，
    // 否则用户以为"这次记住了"。
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * 注销时删掉当初写下的那个文件。
 *
 * **只在文件内容与注册进来时一致才删**：用户可能手工编辑过这份 JSON
 * （比如改了 limits），那时文件已经是他的东西了，注销一个 agent 不该连带
 * 删掉他改过的配置 —— 不删，并把原因报出来。
 */
export function removeManifestFile(dir: string, manifest: AgentManifest): RemoveManifestResult {
  const file = path.join(dir, manifestFileName(manifest.id));
  try {
    if (!fs.existsSync(file)) return { ok: true, removed: false };
    const parsed = parseAgentManifestList(JSON.parse(stripBom(fs.readFileSync(file, "utf8"))));
    if (parsed.length !== 1 || !sameManifest(parsed[0]!, manifest)) {
      return { ok: true, removed: false, reason: "agents.d 里的文件已被改动，未删除" };
    }
    fs.rmSync(file, { force: true });
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, reason: (err as Error).message };
  }
}

/** 去掉 loader 自己加的 `source`：写回文件的应该是用户当初填的那份。 */
function stripped(manifest: AgentManifest): AgentManifest {
  const { source: _drop, ...rest } = manifest;
  return rest;
}

/** 忽略 `source`（loader 加的标记），比对其余字段。 */
function sameManifest(a: AgentManifest, b: AgentManifest): boolean {
  const canon = (m: AgentManifest) => {
    const { source: _drop, ...rest } = m;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return canon(a) === canon(b);
}

/** FNV-1a 32 位，只为在 id 含非法字符时消歧 —— 不用于任何安全用途。 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
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
