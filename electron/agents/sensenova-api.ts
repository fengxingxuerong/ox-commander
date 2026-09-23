import fs from "node:fs";
import path from "node:path";
import type {
  AgentAdapter,
  AgentEvent,
  RunHandle,
  TaskPayload,
} from "../../shared/types";
import type { LlmClient } from "../../shared/llm-client";
import { chatJson, JsonParseError } from "../../shared/llm-client";
import { createFailoverClient, EXECUTOR_TIMEOUT_MS } from "../../shared/http-clients";
import { withCooldownRetry } from "../../shared/llm-client";
import { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../../shared/providers";
import { meteredLlm, type UsageMeter } from "../../shared/usage-meter";
import { AGENT_PROTOCOL_VERSION, type AgentCapabilities } from "../../shared/agent-contract";
import { PathPolicy } from "../sandbox/path-policy";
import { RunSession } from "./run-session";
import { fencedBlock, inlineField } from "../../shared/prompt-text";

const SYSTEM_PROMPT = [
  "你是 OxCommander 的代码执行智能体。",
  "根据任务描述和提供的工作区快照直接产出代码文件，只输出一个 JSON 对象，不要 markdown 代码围栏：",
  '{"files":[{"path":"相对路径","content":"完整文件内容"}]}',
  "约定：CommonJS（require/module.exports）、Node >= 18、禁止任何外部 npm 依赖；",
  "测试文件放 tests/*.test.js，且第一行必须是 const { test } = require(\"node:test\"); 第二行 const assert = require(\"node:assert\");",
  'files 只包含需要新增或修改的文件，未列出的文件保持不变；修改时给出该文件的完整新内容。',
  "禁止输出 package.json、package-lock.json、ox-scripts/ 下的文件。",
].join("\n");

const SNAPSHOT_SKIP_DIRS = new Set(["node_modules", ".git", "ox-scripts"]);
const SNAPSHOT_MAX_FILE_CHARS = 4000;
const SNAPSHOT_MAX_TOTAL_CHARS = 32000;

/**
 * 快照 = 发往第三方 LLM 端点的项目内容。凭据类文件一旦入快照就等同于外泄，
 * 因此这里必须按文件名拉黑，不能只靠目录名单（`.env` 就在项目根目录下）。
 * 规则按 basename 小写匹配，覆盖 .env 家族、密钥/证书、凭据文件与 dotenv 常见变体。
 */
const SNAPSHOT_SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/, // .env / .env.local / .env.production …
  /^\.?npmrc$/,
  /^\.?yarnrc(\.yml)?$/,
  /^\.?pnpmrc$/,
  /^\.netrc$/,
  /^\.git-credentials$/,
  /^credentials(\..+)?$/,
  /^secrets?(\..+)?$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/,
  /(^|[-_.])(api[-_]?key|apikey|access[-_]?key|secret[-_]?key|private[-_]?key|auth[-_]?token|access[-_]?token|refresh[-_]?token|password|passwd|credential|credentials)([-_.].*)?$/,
  /^\.(aws|ssh|kube|docker|gnupg)$/,
];

/** True for files whose contents must never be copied into an LLM prompt. */
export function isSecretLikeFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  const lower = base.toLowerCase();
  return SNAPSHOT_SECRET_FILE_PATTERNS.some((re) => re.test(lower));
}

/** Readable-text guard: skip binary-looking files instead of flooding the prompt. */
function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

export interface SensenovaAdapterOptions {
  /** Cap on concurrently in-flight LLM calls; default: number of configured SenseNova keys (injected client: unlimited). */
  maxConcurrent?: number;
  /**
   * Token 用量汇总器，只用于**自己构造**的那个 failover 客户端（见 `client()`）。
   *
   * 为什么只包自建的那一个：执行器是全项目 token 消耗的大头（整文件代码生成），
   * 它不走 `build-llm.ts`（那是大脑层工厂），所以必须在这里单独接一次。
   * 而外部注入的 `llm` 由注入方负责自己的用量 —— 在这一层再包一次，
   * 当注入的恰好是宿主自己的 metered 客户端时会重复计数。
   */
  meter?: UsageMeter;
}

export class SensenovaApiAdapter implements AgentAdapter {
  readonly meta = { id: "sensenova-api", name: "SenseNova API 执行器", kind: "api" as const };

  /**
   * Declared capability (protocol ox-agent/2): a generalist code executor.
   * It writes files only — commands and tests are the platform verifier's job,
   * so `run-command`/`run-test` are deliberately absent. `maxConcurrency` is
   * the number of configured failover keys (the real ceiling on parallel calls).
   */
  capabilities(): AgentCapabilities {
    const limit = this.concurrencyLimit();
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      roles: ["frontend-dev", "backend-dev", "fullstack-dev", "test-writer", "docs-writer"],
      zoneGlobs: ["**"],
      supports: ["read", "edit", "create"],
      artifactKinds: ["files", "logs"],
      maxConcurrency: Number.isFinite(limit) ? Math.max(1, limit) : SENSENOVA_KEY_VARS.length,
      selfIsolated: false,
    };
  }

  private sessions = new Map<string, RunSession>();
  private llm: LlmClient | undefined;
  private readonly maxConcurrentOverride: number | undefined;
  private readonly meter: UsageMeter | undefined;
  /** Shared failover client with decision logging wired to live sessions. */
  private sharedFailover: LlmClient | undefined;
  /** Semaphore state: in-flight LLM calls + FIFO waiters. */
  private inflight = 0;
  private waiters: Array<() => void> = [];
  /** projectRoot → {fingerprint, value}：mtime 指纹命中则免读文件内容。 */
  private snapshotCache = new Map<string, { fingerprint: string; value: string }>();

  constructor(llm?: LlmClient, opts?: SensenovaAdapterOptions) {
    this.llm = llm;
    this.maxConcurrentOverride = opts?.maxConcurrent;
    this.meter = opts?.meter;
  }

  private concurrencyLimit(): number {
    if (this.maxConcurrentOverride !== undefined) return this.maxConcurrentOverride;
    if (this.llm) return Number.POSITIVE_INFINITY;
    return Math.max(1, SENSENOVA_KEY_VARS.filter((v) => !!process.env[v]).length);
  }

  /** FIFO semaphore: resolves true when the call had to queue. */
  private async acquireSlot(): Promise<boolean> {
    if (this.inflight < this.concurrencyLimit()) {
      this.inflight++;
      return false;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return true; // slot handed over by releaseSlot(), already counted
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return; // slot transfers, inflight unchanged
    }
    this.inflight--;
  }

  private client(): LlmClient {
    if (this.llm) return this.llm;
    if (!this.sharedFailover) {
      const failover = createFailoverClient("sensenova", SENSENOVA_KEY_VARS, SENSENOVA_MODELS, {
        timeoutMs: EXECUTOR_TIMEOUT_MS,
        onEvent: (text) => this.broadcastFailoverEvent(text),
      });
      // 包在**最外层**：routes 由 FailoverLlmClient 内部自建，包在里面会按线路重复计数。
      this.sharedFailover = this.meter ? meteredLlm(failover, this.meter) : failover;
    }
    return this.sharedFailover;
  }

  /** Failover decisions are engine-global: broadcast to every live session's log stream. */
  private broadcastFailoverEvent(text: string): void {
    for (const session of this.sessions.values()) {
      if (!session.finished) session.push("log", `[failover] ${text}`);
    }
  }

  async probe(): Promise<boolean> {
    if (this.llm) return true;
    return SENSENOVA_KEY_VARS.some((v) => !!process.env[v]);
  }

  async dispatch(payload: TaskPayload): Promise<RunHandle> {
    const session = new RunSession();
    this.sessions.set(payload.runId, session);
    void this.run(payload, session);
    return { runId: payload.runId, agentId: this.meta.id, taskId: payload.taskId };
  }

  private async run(payload: TaskPayload, session: RunSession): Promise<void> {
    try {
      const client = this.client();
      session.push("log", `[sensenova-api] 正在调用模型生成「${payload.title}」的代码…`);
      const snapshot = this.snapshot(payload.projectRoot);
      const userParts: string[] = [
        `任务标题：${inlineField(payload.title)}`,
        `所属区域（zone）：${inlineField(payload.zone)}`,
        `任务描述：${payload.description}`,
      ];
      if (snapshot) {
        userParts.push(
          `\n当前工作区已有文件（相对路径 → 内容，超长文件截断）：\n${snapshot}`,
          "请基于以上现有代码工作：只输出需要新增或修改的文件，与任务无关的已有文件一律不要重写。",
        );
      }
      if (payload.repairContext) {
        userParts.push(
          `\n这是第 ${payload.repairContext.round} 轮修复。上一轮失败日志摘要：\n${fencedBlock(
            payload.repairContext.errorLogDigest,
          )}`,
          "修复时做最小改动：只改导致失败的代码，其余已通过的部分保持原样。",
        );
      }
      const queued = await this.acquireSlot();
      try {
        if (queued && !session.finished) {
          session.push("log", `[sensenova-api] LLM 并发槽位已满，本任务排队等待`);
        }
        const written = this.writeFiles(
          payload.projectRoot,
          await this.generateWithCooldownRetry(client, userParts, session),
          session,
        );
        if (!session.finished) {
          session.push("completed", `写入 ${written} 个文件（run ${payload.runId}）`);
        }
      } finally {
        this.releaseSlot();
      }
    } catch (err) {
      if (!session.finished) {
        session.push("failed", `[sensenova-api] ${(err as Error).message}`);
      }
    }
    session.finished = true;
    session.wake();
  }

  /** chatFiles + cooldown-aware retry: 全组合冷却属暂时性限流，等待后重试而不是直接判失败。 */
  private async generateWithCooldownRetry(
    client: LlmClient,
    userParts: string[],
    session: RunSession,
  ): Promise<Array<{ path: string; content: string }>> {
    return withCooldownRetry(() => this.chatFiles(client, userParts, session), {
      shouldStop: () => session.finished,
      onWait: (ms, n) =>
        session.push(
          "log",
          `[sensenova-api] 全部模型组合冷却中，第 ${n} 次等待约 ${Math.ceil(ms / 1000)}s 后重试`,
        ),
    });
  }

  /**
   * 调用模型并要求其输出文件协议 JSON。
   * 非协议输出（如文档类任务直接吐 Markdown）会触发 chatJson 自纠偏：
   * 把原始输出回喂给模型，要求改写成 {"files":[...]} 后重试。
   */
  private async chatFiles(
    client: LlmClient,
    userParts: string[],
    session: RunSession,
  ): Promise<Array<{ path: string; content: string }>> {
    try {
      return await chatJson(
        client,
        {
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userParts.join("\n") },
          ],
          temperature: 0.2,
          jsonMode: true,
        },
        { schemaName: "files-protocol", validate: parseFilePayload, maxRetries: 2 },
      );
    } catch (e) {
      if (e instanceof JsonParseError) {
        session.push("log", `[sensenova-api] 协议自纠偏失败：${e.message}`);
      }
      throw e;
    }
  }

  private snapshot(projectRoot: string): string {
    const rootAbs = path.resolve(projectRoot);
    if (!fs.existsSync(rootAbs)) return "";
    // Phase 1: cheap stat walk → deterministic fingerprint (readdir + stat only).
    // A same-batch redispatch or an unchanged workspace hits the cache and
    // skips all readFileSync work; any write bumps mtime and invalidates it.
    const statEntries: Array<{ rel: string; size: number; mtimeMs: number }> = [];
    const walkStat = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
          walkStat(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(rootAbs, abs).replace(/\\/g, "/");
        // 凭据类文件既不进指纹也不进内容：进指纹会暴露其存在与大小，
        // 进内容则会随 prompt 发往第三方端点。
        if (isSecretLikeFile(rel)) continue;
        try {
          const st = fs.statSync(abs);
          statEntries.push({
            rel,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // unreadable: treated as absent from the fingerprint
        }
      }
    };
    walkStat(rootAbs);
    statEntries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const fingerprint = JSON.stringify(statEntries);
    const cached = this.snapshotCache.get(rootAbs);
    if (cached && cached.fingerprint === fingerprint) return cached.value;
    // Phase 2: read contents under the existing budget/skip/truncate rules.
    const value = this.readSnapshotContents(rootAbs, statEntries);
    this.snapshotCache.set(rootAbs, { fingerprint, value });
    return value;
  }

  private readSnapshotContents(
    rootAbs: string,
    statEntries: Array<{ rel: string }>,
  ): string {
    const chunks: string[] = [];
    let budget = SNAPSHOT_MAX_TOTAL_CHARS;
    for (const { rel } of statEntries) {
      if (budget <= 0) return chunks.join("\n\n");
      // 二次防线：即使上层 walk 漏过某个凭据文件，这里也不读它的正文。
      if (isSecretLikeFile(rel)) continue;
      const abs = path.join(rootAbs, rel);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (looksBinary(content)) continue;
      const body =
        content.length > SNAPSHOT_MAX_FILE_CHARS
          ? `${content.slice(0, SNAPSHOT_MAX_FILE_CHARS)}\n…（截断）`
          : content;
      const chunk = `=== ${rel} ===\n${body}`;
      if (chunk.length > budget) {
        chunks.push(`=== ${rel} ===（超出快照预算，省略）`);
        return chunks.join("\n\n");
      }
      chunks.push(chunk);
      budget -= chunk.length;
    }
    return chunks.join("\n\n");
  }

  private writeFiles(
    projectRoot: string,
    files: Array<{ path: string; content: string }>,
    session: RunSession,
  ): number {
    // Sandbox gate (P3): the path rules that used to be hard-coded here
    // (project root + protected paths) now live in PathPolicy, so every adapter
    // shares one implementation. Zone enforcement is not applied at write time:
    // it stays an after-the-fact judgement until rollback lands (P4).
    const policy = new PathPolicy({ projectRoot });
    let count = 0;
    for (const f of files) {
      const decision = policy.assertWritable(f.path);
      if (!decision.ok) {
        session.push("log", `[${this.meta.id}] 跳过：${decision.reason}`);
        continue;
      }
      fs.mkdirSync(path.dirname(decision.abs), { recursive: true });
      fs.writeFileSync(decision.abs, f.content, "utf8");
      session.push("log", `[${this.meta.id}] 写入 ${f.path}（${f.content.length} 字符）`);
      count++;
    }
    if (count === 0) throw new Error("模型未返回可写入的文件");
    return count;
  }

  async *collect(handle: RunHandle): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(handle.runId);
    if (!session) throw new Error(`unknown run ${handle.runId}`);
    try {
      while (true) {
        if (session.events.length > 0) {
          yield session.events.shift()!;
          continue;
        }
        if (session.finished && session.events.length === 0) return;
        const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
          session.waiting.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.sessions.delete(handle.runId);
    }
  }

  async abort(handle: RunHandle): Promise<void> {
    const session = this.sessions.get(handle.runId);
    if (!session || session.finished) return;
    session.push("aborted", "run aborted");
    session.finished = true;
    session.wake();
  }
}

export type FilePayload = Array<{ path: string; content: string }>;

/** Validates an already-parsed JSON value against the files protocol. */
export function parseFilePayload(value: unknown): FilePayload {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { files?: unknown }).files)) {
    throw new Error('模型 JSON 缺少 "files" 数组');
  }
  const files = (value as { files: Array<unknown> }).files;
  return files
    .filter(
      (f): f is { path: string; content: string } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { path?: unknown }).path === "string" &&
        typeof (f as { content?: unknown }).content === "string",
    )
    .map((f) => ({ path: f.path, content: f.content }));
}

// `parseFiles(content)` was removed here: it extracted one JSON object with
// indexOf/lastIndexOf and was never called in production. The live path goes
// through `chatJson` → `extractJsonCandidates`, which is strictly stronger
// (tries every balanced candidate, so it also survives reasoning models that
// echo prompt JSON before the answer) and is covered by llm-client.test.ts.
// Its old unit tests were pinning a code path no run could reach.
