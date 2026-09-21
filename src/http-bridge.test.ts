import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpBridgeAdapter, type FetchLike } from "../electron/agents/http-bridge";
import type { AgentEvent, TaskPayload } from "../shared/types";

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** Scripted fetch double: routes are matched by substring, in order. */
function fakeFetch(
  routes: Array<{ match: string; method?: string; reply: (call: Call) => { status: number; body?: unknown } }>,
  calls: Call[] = [],
): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string>) ?? {};
    const call: Call = { url, method, headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    calls.push(call);
    const route = routes.find((r) => url.includes(r.match) && (r.method ?? "GET") === method);
    if (!route) return { ok: false, status: 404, text: async () => "no route", json: async () => ({}) };
    const { status, body } = route.reply(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body ?? ""),
      json: async () => body ?? {},
    };
  };
}

function payload(over: Partial<TaskPayload> = {}): TaskPayload {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`,
    taskId: "t1",
    title: "实现接口",
    description: "写一个接口",
    zone: "src/api",
    projectRoot: os.tmpdir(),
    ...over,
  };
}

function bridge(fetchImpl: FetchLike, over: Partial<ConstructorParameters<typeof HttpBridgeAdapter>[0]> = {}) {
  return new HttpBridgeAdapter({
    id: "workbuddy-bridge",
    baseUrl: "http://127.0.0.1:9999",
    pollMs: 10,
    fetchImpl,
    ...over,
  });
}

async function collect(adapter: HttpBridgeAdapter, handle: Awaited<ReturnType<HttpBridgeAdapter["dispatch"]>>) {
  const events: AgentEvent[] = [];
  for await (const e of adapter.collect(handle)) events.push(e);
  return events;
}

describe("HttpBridgeAdapter", () => {
  it("probes the health endpoint", async () => {
    expect(await bridge(fakeFetch([{ match: "/health", reply: () => ({ status: 200 }) }])).probe()).toBe(true);
    expect(await bridge(fakeFetch([{ match: "/health", reply: () => ({ status: 503 }) }])).probe()).toBe(false);
    // Transport failure must not throw out of probe().
    const throwing = bridge(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await throwing.probe()).toBe(false);
  });

  it("posts the task with the v2 protocol version and follows the run to completion", async () => {
    const calls: Call[] = [];
    let polls = 0;
    const fetchImpl = fakeFetch(
      [
        {
          match: "/v1/runs/42/events",
          reply: () => {
            polls += 1;
            // First poll: still running. Second: terminal.
            return polls === 1
              ? { status: 200, body: { events: [{ kind: "log", text: "working" }], status: "running" } }
              : { status: 200, body: { events: [], status: "completed" } };
          },
        },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
      ],
      calls,
    );
    const adapter = bridge(fetchImpl);
    const handle = await adapter.dispatch(payload());
    const events = await collect(adapter, handle);

    const posted = calls.find((c) => c.method === "POST")!;
    const sent = JSON.parse(posted.body!) as { protocolVersion?: string; zone: string; taskId: string };
    expect(sent.protocolVersion).toBe("ox-agent/2");
    expect(sent.zone).toBe("src/api");
    expect(events.map((e) => e.kind)).toContain("completed");
    expect(events.map((e) => e.text).join("\n")).toContain("working");
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("finishes immediately when the dispatch response is already terminal", async () => {
    // `body.status === "completed" || body.status === "failed"` — with `&&` the
    // dispatch falls through to polling instead of finishing. Racing the
    // collect against a timeout keeps a stuck run from hanging the suite for
    // the full vitest timeout: the mutated build simply yields no events.
    const calls: Call[] = [];
    const adapter = bridge(
      fakeFetch(
        [
          {
            match: "/v1/runs",
            method: "POST",
            reply: () => ({ status: 200, body: { runId: "42", status: "completed" } }),
          },
        ],
        calls,
      ),
    );
    const handle = await adapter.dispatch(payload());
    const events = await Promise.race([
      collect(adapter, handle),
      new Promise<AgentEvent[]>((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);
    expect(events.map((e) => e.kind)).toContain("completed");
    expect(calls.some((c) => c.url.includes("/events"))).toBe(false);
  });

  it("ends a run from an incoming terminal event, not only from the poll status", async () => {
    // `pushIncoming` maps `e.kind` through a three-way `||`. With `&&` every
    // event degrades to "log", `markTerminal` is never called, and a run whose
    // remote status stays "running" never finishes at all. Existing tests all
    // completed via the *status* field, so this path had no coverage.
    const adapter = bridge(
      fakeFetch([
        {
          match: "/v1/runs/42/events",
          reply: () => ({
            status: 200,
            body: { events: [{ kind: "completed", text: "远端已完成" }], status: "running" },
          }),
        },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
      ]),
    );
    const handle = await adapter.dispatch(payload());
    const events = await Promise.race([
      collect(adapter, handle),
      new Promise<AgentEvent[]>((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);
    expect(events.map((e) => e.kind)).toContain("completed");
    expect(events.map((e) => e.text).join("\n")).toContain("远端已完成");
  });

  it("aborts an unknown run id without crashing", async () => {
    // Same guard shape as the CLI adapter: `!run || run.session.finished`
    // written with `&&` throws a TypeError on `run.session`.
    const adapter = bridge(fakeFetch([]));
    await expect(
      adapter.abort({ runId: "ghost-run", agentId: "workbuddy-bridge", taskId: "" }),
    ).resolves.toBeUndefined();
  });

  it("treats a synchronous response with events and no runId as terminal", async () => {
    const adapter = bridge(
      fakeFetch([
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { events: [{ kind: "log", text: "hi" }] } }) },
      ]),
    );
    const handle = await adapter.dispatch(payload());
    const events = await collect(adapter, handle);
    expect(events.map((e) => e.kind)).toContain("completed");
  });

  it("fails the run when the bridge rejects the dispatch", async () => {
    const adapter = bridge(
      fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 500, body: "boom" }) }]),
    );
    const handle = await adapter.dispatch(payload());
    const events = await collect(adapter, handle);
    expect(events.at(-1)!.kind).toBe("failed");
    expect(events.at(-1)!.text).toContain("500");
  });

  it("fails the run when the bridge is unreachable", async () => {
    const adapter = bridge(async () => {
      throw new Error("ECONNREFUSED");
    });
    const handle = await adapter.dispatch(payload());
    const events = await collect(adapter, handle);
    expect(events.at(-1)!.kind).toBe("failed");
    expect(events.at(-1)!.text).toContain("ECONNREFUSED");
  });

  it("propagates a remote failure status", async () => {
    const adapter = bridge(
      fakeFetch([
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "7" } }) },
        { match: "/v1/runs/7/events", reply: () => ({ status: 200, body: { status: "failed" } }) },
      ]),
    );
    const handle = await adapter.dispatch(payload());
    const events = await collect(adapter, handle);
    expect(events.at(-1)!.kind).toBe("failed");
  });

  it("aborts remotely and locally", async () => {
    const calls: Call[] = [];
    const adapter = bridge(
      fakeFetch(
        [
          { match: "/abort", method: "POST", reply: () => ({ status: 204 }) },
          { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "9" } }) },
          { match: "/v1/runs/9/events", reply: () => ({ status: 200, body: { events: [], status: "running" } }) },
        ],
        calls,
      ),
    );
    const handle = await adapter.dispatch(payload());
    // `dispatch` returns as soon as the POST is in flight; wait for the remote
    // run id so the abort has something to cancel.
    for (let i = 0; i < 20 && !calls.some((c) => c.url.includes("/9/events")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await adapter.abort(handle);
    const events = await collect(adapter, handle);
    expect(events.at(-1)!.kind).toBe("aborted");
    expect(calls.some((c) => c.url.includes("/9/abort") && c.method === "POST")).toBe(true);
  });

  it("drains when a run finishes and times out on a stuck one", async () => {
    // Finishes immediately (synchronous bridge with no runId).
    const fast = bridge(
      fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: {} }) }]),
    );
    await fast.dispatch(payload());
    expect(await fast.drain(200)).toBe("drained");

    const stuck = bridge(
      fakeFetch([
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "1" } }) },
        { match: "/v1/runs/1/events", reply: () => ({ status: 200, body: { events: [], status: "running" } }) },
        { match: "/abort", method: "POST", reply: () => ({ status: 200 }) },
      ]),
    );
    await stuck.dispatch(payload());
    expect(await stuck.drain(120)).toBe("timeout");
  });

  it("injects a bearer token read from a file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-token-"));
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, "  secret-token\n", "utf8");
    try {
      const calls: Call[] = [];
      const adapter = bridge(
        fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: {} }) }], calls),
        { credential: { kind: "bearerFile", tokenFile } },
      );
      await adapter.dispatch(payload());
      expect(calls[0]!.headers.authorization).toBe("Bearer secret-token");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an environment credential when present", async () => {
    const calls: Call[] = [];
    process.env.OX_TEST_BRIDGE_TOKEN = "env-token";
    try {
      const adapter = bridge(
        fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: {} }) }], calls),
        { credential: { kind: "env", envVar: "OX_TEST_BRIDGE_TOKEN" } },
      );
      await adapter.dispatch(payload());
      expect(calls[0]!.headers.authorization).toBe("Bearer env-token");
    } finally {
      delete process.env.OX_TEST_BRIDGE_TOKEN;
    }
  });

  it("caches an execToken credential via the injected resolver", async () => {
    let resolved = 0;
    const calls: Call[] = [];
    const adapter = bridge(
      fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: {} }) }], calls),
      {
        credential: { kind: "execToken", command: "irrelevant", args: [], cacheTtlMs: 60_000 },
        resolveToken: async () => {
          resolved += 1;
          return "exec-token";
        },
      },
    );
    await adapter.dispatch(payload());
    await adapter.dispatch(payload());
    expect(resolved).toBe(1);
    expect(calls[0]!.headers.authorization).toBe("Bearer exec-token");
  });

  it("reports a structured result after collection", async () => {
    const adapter = bridge(
      fakeFetch([{ match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: {} }) }]),
    );
    const handle = await adapter.dispatch(payload());
    await collect(adapter, handle);
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("completed");
    expect(result?.agentId).toBe("workbuddy-bridge");
  });
});
