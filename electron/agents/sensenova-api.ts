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
import { DEFAULT_SKIP_DIRS } from "../sandbox/file-journal";
import { createFailoverClient, EXECUTOR_TIMEOUT_MS } from "../../shared/http-clients";
import { withCooldownRetry } from "../../shared/llm-client";
import { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../../shared/providers";
import { meteredLlm, type UsageMeter } from "../../shared/usage-meter";
import { AGENT_PROTOCOL_VERSION, DEFAULT_AGENT_LIMITS, type AgentCapabilities, type AgentLimits } from "../../shared/agent-contract";
import { PathPolicy } from "../sandbox/path-policy";
import { TimeoutGate } from "../sandbox/timeout-gate";
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

// The snapshot is what the model gets to see of the project, and the budget is
// spent in path order — `coverage/` and `dist/` sort before `src/`, so without
// the shared generated-dir list the prompt is filled with bundles and the real
// source never reaches the request at all. `ox-scripts` is this platform's own
// helper directory, skipped here but not in the change journal.
const SNAPSHOT_SKIP_DIRS = new Set([...DEFAULT_SKIP_DIRS, "ox-scripts"]);
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
  /**
   * Per-run ceilings, same shape the external adapters take.
   *
   * Only `runDeadlineMs` is honoured here: `idleTimeoutMs` means "no event for
   * N ms", and this adapter emits nothing while a single request is in flight
   * (up to `EXECUTOR_TIMEOUT_MS`), so an idle watchdog would fire on every
   * slow-but-healthy generation.
   */
  limits?: Partial<AgentLimits>;
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
  readonly limits: AgentLimits;
  /** Per-run watchdog: hard ceiling on how long one task may stay alive. */
  private readonly gate: TimeoutGate;
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
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...(opts?.limits ?? {}) };
    this.gate = new TimeoutGate({
      deadlineMs: this.limits.runDeadlineMs,
      // See `SensenovaAdapterOptions.limits`: idling is normal mid-request, so
      // the gate only enforces the deadline and never the idle window.
      idleTimeoutMs: Number.POSITIVE_INFINITY,
    });
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
    this.gate.attach({ id: payload.runId }, () => {
      // 看门狗只说明"为什么"，真正把 run 收口的是下面 `guard()` 抛出的 TimeoutError。
      session.cancel.abort(); // 在途那一次请求一并掐掉，不再占线路池、也不再花 token
      session.push(
        "log",
        `[sensenova-api] 已超出 run 时限 ${this.limits.runDeadlineMs}ms，不再等待本回合结果` +
          `（在途请求已中止，那一笔 token 可能已经花掉）`,
      );
    });
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
      if (queued && !session.finished) {
        session.push("log", `[sensenova-api] LLM 并发槽位已满，本任务排队等待`);
      }
      /*
       * 槽位跟着**真实请求**的结束释放，不跟着 `guard()` 的结束释放：超时只是
       * 不再等它，那一回合仍在途并占着一条线路，提前释放会让信号量放进更多并发。
       */
      const work = this.generateWithCooldownRetry(client, userParts, session).finally(() =>
        this.releaseSlot(),
      );
      const generated = await this.gate.guard(payload.runId, work);
      if (session.finished) {
        /*
         * run 已被中止。这一回合的 token 多半已经花了（`abort()` 掐的是 socket，
         * 请求可能刚好已经答完），但写盘是不可逆副作用 —— 取消之后再落文件，
         * 用户看到的是一份他叫停过的改动。
         */
        session.push(
          "log",
          `[sensenova-api] run 已中止，丢弃本回合生成的 ${generated.length} 个文件`,
        );
        return;
      }
      const res = this.writeFiles(payload.projectRoot, generated, session);
      if (!session.finished) {
        // 终态里带上被拒数量与路径：重修 prompt 传的是这份摘要，只说"写入 N 个"
        // 的话，模型下一轮会原样再写一遍被沙箱拒掉的那条路径，预算空烧。
        session.push("completed", SensenovaApiAdapter.completedNote(res, payload.runId));
      }
    } catch (err) {
      if (!session.finished) {
        session.push("failed", `[sensenova-api] ${(err as Error).message}`);
      }
    } finally {
      // 幂等：`guard()` 收口时已经解过。放这里是为了让"进 guard 之前就返回/抛出"
      // 的路径也不留在臂上的定时器 —— 它会让进程退不出去。
      this.gate.detach(payload.runId);
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
          signal: session.cancel.signal,
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
  ): { written: number; refused: string[] } {
    // Sandbox gate (P3): the path rules that used to be hard-coded here
    // (project root + protected paths) now live in PathPolicy, so every adapter
    // shares one implementation. Zone is deliberately left out: this gate uses a
    // strict prefix, so honouring it here would reject `src/duration.js` for zone
    // `src/duration` — a write the arbitration gate owns and must not roll back.
    const policy = new PathPolicy({ projectRoot });
    const refused: string[] = [];
    let written = 0;
    for (const f of files) {
      const decision = policy.assertWritable(f.path);
      if (!decision.ok) {
        session.push("log", `[${this.meta.id}] 跳过：${decision.reason}`);
        refused.push(f.path);
        continue;
      }
      fs.mkdirSync(path.dirname(decision.abs), { recursive: true });
      fs.writeFileSync(decision.abs, f.content, "utf8");
      session.push("log", `[${this.meta.id}] 写入 ${f.path}（${f.content.length} 字符）`);
      written++;
    }
    if (written === 0) {
      // 点名被拒的路径：只说"没有可写入的文件"，重修那一轮就会让模型原样再写一遍
      // 同一条被沙箱拒的路径 —— 预算空烧，而日志里那句「跳过」没人带进 prompt。
      throw new Error(
        refused.length > 0
          ? `模型返回的 ${files.length} 个文件全部被沙箱拒绝：${refused.join("、")}`
          : "模型未返回可写入的文件",
      );
    }
    return { written, refused };
  }

  /** 终态文案：写了多少、被沙箱拒了多少（被拒路径逐条点名，它会随重修上下文回到模型手里）。 */
  private static completedNote(res: { written: number; refused: string[] }, runId: string): string {
    const head = `写入 ${res.written} 个文件（run ${runId}）`;
    if (res.refused.length === 0) return head;
    return `${head}；沙箱拒绝 ${res.refused.length} 个：${res.refused.join("、")}`;
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
    session.cancel.abort(); // 先掐在途请求，再收事件流：晚一步就是取消之后还在烧钱
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
