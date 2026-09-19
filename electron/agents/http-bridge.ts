import fs from "node:fs";
import type { AgentEvent, RunHandle, TaskPayload } from "../../shared/types";
import {
  AGENT_PROTOCOL_VERSION,
  DEFAULT_AGENT_LIMITS,
  type AgentAdapterV2,
  type AgentCapabilities,
  type AgentCredential,
  type AgentLimits,
  type AgentRunResult,
  type TaskRequest,
} from "../../shared/agent-contract";
import { RunSession } from "./run-session";
import { TimeoutGate } from "../sandbox/timeout-gate";

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface HttpBridgeOptions {
  id: string;
  name?: string;
  baseUrl: string;
  healthPath?: string;
  runsPath?: string;
  pollMs?: number;
  headers?: Record<string, string>;
  credential?: AgentCredential;
  capabilities?: AgentCapabilities;
  limits?: Partial<AgentLimits>;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Resolves the bearer token (env / file / execToken are handled by the caller). */
  resolveToken?: () => Promise<string | undefined>;
}

interface BridgeRun {
  session: RunSession;
  /** Host-side run id (the key `lastResult` is queried with). */
  runId: string;
  remoteRunId: string | null;
  poller: ReturnType<typeof setInterval> | null;
  cursor: number;
  taskId: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "aborted";
  lastError?: string;
  done: Promise<void>;
  resolveDone: () => void;
}

type IncomingEvent = { kind?: string; text?: string; changes?: unknown };

/**
 * Adapter for agents exposed as an HTTP service (WorkBuddy bridge, MCP gateway,
 * a local sidecar …).
 *
 * Wire protocol (deliberately small):
 *   GET  {baseUrl}{healthPath}                 → 2xx ⇒ healthy
 *   POST {baseUrl}{runsPath}   TaskRequest     → { runId } | { events: [...] }
 *   GET  {baseUrl}{runsPath}/{id}/events?since=N → { events: [...], status? }
 *   POST {baseUrl}{runsPath}/{id}/abort        → 2xx ⇒ aborted
 *
 * Polling (not SSE) keeps the client dependency-free and trivially testable;
 * `pollMs` bounds the latency between remote progress and the board.
 */
export class HttpBridgeAdapter implements AgentAdapterV2 {
  readonly meta: { id: string; name: string; kind: "api" | "ui" };
  readonly credential: AgentCredential;
  readonly limits: AgentLimits;
  private readonly baseUrl: string;
  private readonly runs = new Map<string, BridgeRun>();
  private readonly results = new Map<string, AgentRunResult>();
  /** Per-run watchdog: a remote run that stops reporting must not hang the batch. */
  private readonly gate: TimeoutGate;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private opts: HttpBridgeOptions) {
    this.meta = { id: opts.id, name: opts.name ?? opts.id, kind: "api" };
    this.credential = opts.credential ?? { kind: "none" };
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...(opts.limits ?? {}) };
    this.gate = new TimeoutGate({
      deadlineMs: this.limits.runDeadlineMs,
      idleTimeoutMs: this.limits.idleTimeoutMs,
    });
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  capabilities(): AgentCapabilities {
    return (
      this.opts.capabilities ?? {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        roles: ["*"],
        zoneGlobs: ["**"],
        supports: ["read", "edit", "create", "review"],
        artifactKinds: ["files", "logs"],
        maxConcurrency: 2,
        selfIsolated: true,
      }
    );
  }

  async probe(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.baseUrl}${this.opts.healthPath ?? "/health"}`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async dispatch(payload: TaskPayload): Promise<RunHandle> {
    const session = new RunSession();
    const handle: RunHandle = { runId: payload.runId, agentId: this.meta.id, taskId: payload.taskId };
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const run: BridgeRun = {
      session,
      runId: payload.runId,
      remoteRunId: null,
      poller: null,
      cursor: 0,
      taskId: payload.taskId,
      startedAt: Date.now(),
      status: "running",
      done,
      resolveDone,
    };
    this.runs.set(payload.runId, run);
    this.gate.attach(
      {
        id: payload.runId,
        deadlineMs: this.limits.runDeadlineMs,
        idleTimeoutMs: this.limits.idleTimeoutMs,
      },
      (reason) => {
        if (run.session.finished) return;
        run.session.push(
          "log",
          `[${this.meta.id}] 看门狗触发（${reason === "deadline" ? "超出总时限" : "空闲无输出"}），中止 run`,
        );
        void this.abort(handle);
      },
    );
    void this.start(payload, run);
    return handle;
  }

  private async start(payload: TaskPayload, run: BridgeRun): Promise<void> {
    const runsPath = this.opts.runsPath ?? "/v1/runs";
    const request: TaskRequest = {
      ...payload,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      ...(this.limits ? { deadlineMs: this.limits.runDeadlineMs } : {}),
    };
    try {
      const res = await this.fetch(`${this.baseUrl}${runsPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await this.authHeaders()) },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        this.finish(run, "failed", `[${this.meta.id}] 投递失败：HTTP ${res.status} ${await safeText(res)}`);
        return;
      }
      const body = (await res.json()) as { runId?: unknown; events?: unknown; status?: unknown };
      const remoteId = typeof body.runId === "string" ? body.runId : null;
      run.remoteRunId = remoteId;
      run.session.push("log", `[${this.meta.id}] 已投递（remote run=${remoteId ?? "unknown"}）`);
      if (Array.isArray(body.events)) {
        for (const e of body.events as IncomingEvent[]) this.pushIncoming(run, e);
      }
      if (body.status === "completed" || body.status === "failed") {
        this.finish(run, body.status === "completed" ? "completed" : "failed", `[${this.meta.id}] 远端已终态：${body.status}`);
        return;
      }
      if (!remoteId) {
        // A synchronous bridge that returned events and no run id is done here.
        this.finish(run, "completed", `[${this.meta.id}] 同步返回完成`);
        return;
      }
      this.startPolling(run, remoteId);
    } catch (err) {
      this.finish(run, "failed", `[${this.meta.id}] 投递异常：${(err as Error).message}`);
    }
  }

  private startPolling(run: BridgeRun, remoteRunId: string): void {
    const runsPath = this.opts.runsPath ?? "/v1/runs";
    const pollMs = this.opts.pollMs ?? 500;
    run.poller = setInterval(() => {
      void (async () => {
        try {
          const res = await this.fetch(
            `${this.baseUrl}${runsPath}/${encodeURIComponent(remoteRunId)}/events?since=${run.cursor}`,
            { method: "GET", headers: await this.authHeaders(), signal: AbortSignal.timeout(15_000) },
          );
          if (!res.ok) {
            this.finish(run, "failed", `[${this.meta.id}] 拉取事件失败：HTTP ${res.status}`);
            return;
          }
          const body = (await res.json()) as { events?: unknown; status?: unknown };
          if (Array.isArray(body.events)) {
            for (const e of body.events as IncomingEvent[]) {
              run.cursor += 1;
              this.pushIncoming(run, e);
            }
          }
          if (body.status === "completed") this.finish(run, "completed", `[${this.meta.id}] 远端完成`);
          else if (body.status === "failed") this.finish(run, "failed", `[${this.meta.id}] 远端失败`);
          else if (body.status === "aborted") this.finish(run, "aborted", `[${this.meta.id}] 远端已中止`);
        } catch (err) {
          run.lastError = (err as Error).message;
          // Transient poll failures are ignored: the next tick retries.
        }
      })();
    }, pollMs);
    // Do not keep the process alive just because a run is polling.
    (run.poller as unknown as { unref?: () => void }).unref?.();
  }

  private pushIncoming(run: BridgeRun, e: IncomingEvent): void {
    if (run.session.finished) return;
    this.gate.touch(run.runId);
    const kind = e.kind === "completed" || e.kind === "failed" || e.kind === "aborted" ? e.kind : "log";
    run.session.push(kind, e.text ?? "");
    if (kind !== "log") this.markTerminal(run, kind);
  }

  private finish(run: BridgeRun, kind: AgentEvent["kind"], text: string): void {
    if (run.session.finished) return;
    run.session.push(kind, text);
    this.markTerminal(run, kind);
  }

  private markTerminal(run: BridgeRun, kind: AgentEvent["kind"]): void {
    if (run.poller) {
      clearInterval(run.poller);
      run.poller = null;
    }
    this.gate.detach(run.runId);
    if (run.session.finished) return;
    run.session.finished = true;
    run.session.wake();
    run.status = kind === "completed" ? "completed" : kind === "aborted" ? "aborted" : "failed";
    this.rememberResult(run);
    run.resolveDone();
  }

  async *collect(handle: RunHandle): AsyncGenerator<AgentEvent> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new Error(`unknown run ${handle.runId}`);
    try {
      while (true) {
        if (run.session.events.length > 0) {
          yield run.session.events.shift()!;
          continue;
        }
        if (run.session.finished) return;
        const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
          run.session.waiting.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.runs.delete(handle.runId);
    }
  }

  async abort(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run || run.session.finished) return;
    const runsPath = this.opts.runsPath ?? "/v1/runs";
    if (run.remoteRunId) {
      try {
        await this.fetch(`${this.baseUrl}${runsPath}/${encodeURIComponent(run.remoteRunId)}/abort`, {
          method: "POST",
          headers: await this.authHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // best-effort: we mark the run aborted locally regardless
      }
    }
    this.finish(run, "aborted", `[${this.meta.id}] run 已被中止`);
  }

  async drain(graceMs: number): Promise<"drained" | "timeout"> {
    const pending = [...this.runs.values()].map((r) => r.done);
    if (pending.length === 0) return "drained";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    const settled = await Promise.race([Promise.all(pending).then(() => "drained" as const), timeout]);
    if (timer) clearTimeout(timer);
    if (settled === "timeout") {
      for (const [runId, run] of this.runs) await this.abort({ runId, agentId: this.meta.id, taskId: run.taskId });
    }
    return settled;
  }

  async lastResult(handle: RunHandle): Promise<AgentRunResult | undefined> {
    const run = this.runs.get(handle.runId);
    if (run) return this.buildResult(run, handle.runId);
    return this.results.get(handle.runId);
  }

  private buildResult(run: BridgeRun, runId: string): AgentRunResult {
    return {
      runId,
      agentId: this.meta.id,
      taskId: run.taskId,
      status: run.status === "running" ? "failed" : run.status,
      changes: [],
      ...(run.lastError ? { errorClass: "resource" as const, retryable: true } : {}),
      logDigest: "",
      durationMs: Date.now() - run.startedAt,
    };
  }

  private rememberResult(run: BridgeRun): void {
    this.results.set(run.runId, this.buildResult(run, run.runId));
    if (this.results.size > 50) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
  }

  /** Cached bearer token; `execToken` credentials are refreshed after their TTL. */
  private async authHeaders(): Promise<Record<string, string>> {
    const base = { ...(this.opts.headers ?? {}) };
    const cred = this.credential;
    if (cred.kind === "env") {
      const token = process.env[cred.envVar];
      return token ? { ...base, authorization: `Bearer ${token}` } : base;
    }
    if (cred.kind === "bearerFile") {
      try {
        const token = fs.readFileSync(cred.tokenFile, "utf8").trim();
        return token ? { ...base, authorization: `Bearer ${token}` } : base;
      } catch {
        return base;
      }
    }
    if (cred.kind === "execToken") {
      const ttl = cred.cacheTtlMs ?? 300_000;
      if (this.token && this.token.expiresAt > Date.now()) {
        return { ...base, authorization: `Bearer ${this.token.value}` };
      }
      const token = await this.opts.resolveToken?.();
      if (!token) return base;
      this.token = { value: token, expiresAt: Date.now() + ttl };
      return { ...base, authorization: `Bearer ${token}` };
    }
    return base;
  }

  private fetch(url: string, init?: RequestInit): Promise<FetchResponseLike> {
    const impl = this.opts.fetchImpl ?? (fetch as unknown as FetchLike);
    return impl(url, init);
  }
}

async function safeText(res: FetchResponseLike): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
