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

describe("HttpBridgeAdapter · 事件归一与看门狗文案", () => {
  it("[236] 未知类型的事件归一成 log，且不能把 run 标成终态", () => {
    // 第 236 行 `e.kind === "completed" || e.kind === "failed" || e.kind === "aborted" ? e.kind : "log"`。
    // 三个 `===` / 两个 `||` 里此前只有"正常终态"那一条被走到：
    //
    // - 任一个 `===` 改成 `!==`：对**未知 kind**（比如 "progress"）来说条件变成真，
    //   于是 `kind = e.kind` 把未知类型原样透传，紧接着
    //   `if (kind !== "log") this.markTerminal(run, kind)` —— **一个进度事件把 run 判成了终态**。
    // - 任一 `||` 改成 `&&`：要求三种 kind 同时成立，永远为假 ——
    //   连真正的 completed 也被降级成 log，远端状态与看板不一致。
    return (async () => {
      let polls = 0;
      const fetchImpl = fakeFetch([
        {
          match: "/v1/runs/42/events",
          reply: () => {
            polls += 1;
            return polls === 1
              ? { status: 200, body: { events: [{ kind: "progress", text: "50%" }], status: "running" } }
              : { status: 200, body: { events: [{ kind: "completed", text: "done" }], status: "completed" } };
          },
        },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
      ]);
      const adapter = bridge(fetchImpl);
      const events = await collect(adapter, await adapter.dispatch(payload()));
      const kinds = events.map((e) => e.kind);

      // 未知 kind 不能原样透传
      expect(kinds).not.toContain("progress");
      expect(events.find((e) => e.text === "50%")!.kind).toBe("log");
      // 也不会因为未知事件就提前终态：还要继续轮询到真正的 completed
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(kinds).toContain("completed");
    })();
  });

  it("[150] 超总时限触发的看门狗说明是「超出总时限」，不是「空闲无输出」", () => {
    // 第 150 行 `reason === "deadline" ? "超出总时限" : "空闲无输出"`。
    // 改成 `!==` 后两种原因的文案**对调** —— 排障时会被引到错误的方向
    // （明明是整个 run 超时，却提示"空闲无输出"，去查远端为什么没输出）。
    // 既有用例完全没有覆盖看门狗路径。
    return (async () => {
      const fetchImpl = fakeFetch([
        {
          match: "/v1/runs/42/events",
          reply: () => ({ status: 200, body: { events: [], status: "running" } }),
        },
        { match: "/v1/runs/42/abort", method: "POST", reply: () => ({ status: 200, body: {} }) },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
      ]);
      // 总时限设得极短，让 deadline 看门狗先于任何输出触发
      const adapter = bridge(fetchImpl, { limits: { runDeadlineMs: 30 } });
      const events = await collect(adapter, await adapter.dispatch(payload()));
      const logs = events.map((e) => e.text).join("\n");
      expect(logs).toContain("超出总时限");
      expect(logs).not.toContain("空闲无输出");
    })();
  });
});

describe("HttpBridgeAdapter · 结果缓存", () => {
  it("[338] 超过 50 条后淘汰最旧的，缓存不能无界增长", () => {
    // 第 338 行 `if (oldest !== undefined) this.results.delete(oldest);`。
    // 改成 `===` 之后这个删除**永远不会执行**：缓存随 run 数无界增长，
    // 每个 run 的结果都含 logDigest / changes，长跑（几十轮重修）下内存只增不减。
    // 反过来看，"只增不删"不会报任何错，只会在一段时间后 OOM —— 正是最该被断言的那类退化。
    return (async () => {
      let nextId = 0;
      const fetchImpl = fakeFetch([
        // 事件路由必须排在 POST 之前（按顺序 find）
        { match: "/events", reply: () => ({ status: 200, body: { events: [], status: "completed" } }) },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: String(++nextId) } }) },
      ]);
      const adapter = bridge(fetchImpl);
      const handles: Awaited<ReturnType<HttpBridgeAdapter["dispatch"]>>[] = [];
      for (let i = 0; i < 55; i++) {
        const h = await adapter.dispatch(payload());
        await collect(adapter, h);
        handles.push(h);
      }
      // 55 条已越过 50 的阈值：最旧的几条必须已被淘汰
      expect(await adapter.lastResult(handles[0]!)).toBeUndefined();
      expect(await adapter.lastResult(handles[4]!)).toBeUndefined();
      // 最新的仍在
      expect(await adapter.lastResult(handles[54]!)).toBeDefined();
    })();
  });
});

describe("HttpBridgeAdapter · 终态来源与状态记录", () => {
  it("[236] 终态事件本身就要能结束 run（不能只靠 poll 的 status 字段）", () => {
    // 上一条用例的终态来自 poll 的 `status` 字段 —— 桥会**据此合成**一个终态事件，
    // 所以即便事件 kind 被降级成 log，那条断言也照样过。
    // 这条把 `status` 固定成 running，只让**事件**给出终态：
    // `|| → &&` 把 completed 降级成 log 之后，就再没有任何东西能结束这个 run。
    // 用 Promise.race 兜住，避免改坏的构建把整个套件挂死到 vitest 超时。
    let polls = 0;
    const fetchImpl = fakeFetch([
      {
        match: "/events",
        reply: () => {
          polls += 1;
          return {
            status: 200,
            body: { events: [{ kind: "completed", text: "done" }], status: "running" },
          };
        },
      },
      { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
    ]);
    const adapter = bridge(fetchImpl);
    return (async () => {
      const handle = await adapter.dispatch(payload());
      const events = await Promise.race([
        collect(adapter, handle),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      expect(events).not.toBeNull();
      expect(events!.find((e) => e.text === "done")!.kind).toBe("completed");
      expect(polls).toBe(1);
    })();
  });

  it("[256] 三种终态各自记成对应状态，completed 不能被记成 failed", () => {
    // 第 256 行 `run.status = kind === "completed" ? "completed" : kind === "aborted" ? "aborted" : "failed"`。
    // 第一个 `===` 改成 `!==` 后走到嵌套三目的 else 分支 ——
    // **成功完成的 run 状态被记成 "failed"**，交付判定与重修轮次全部错位。
    // 既有用例只断言事件流里出现了 completed，从没看过 lastResult 的状态。
    return (async () => {
      const cases: Array<[string, string]> = [
        ["completed", "completed"],
        ["aborted", "aborted"],
        ["failed", "failed"],
      ];
      for (const [kind, want] of cases) {
        const adapter = bridge(
          fakeFetch([
            {
              match: "/events",
              reply: () => ({
                status: 200,
                body: { events: [{ kind, text: "x" }], status: "running" },
              }),
            },
            { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
          ]),
        );
        const handle = await adapter.dispatch(payload());
        await collect(adapter, handle);
        // collect 结束后 run 已从 runs 移出，lastResult 会回落到 results 缓存 ——
        // 那正是 rememberResult 存下的 buildResult，状态取自同一个 run.status。
        expect((await adapter.lastResult(handle))!.status, `kind=${kind}`).toBe(want);
      }
    })();
  });
});

describe("HttpBridgeAdapter · drain 的宽限期收敛", () => {
  it("[309] 宽限期内成功收敛时不得中止任何 run", () => {
    // 第 309 行 `if (settled === "timeout")`。改成 `!==` 后两个分支对调：
    // **优雅收敛（drained）反而会把在跑的 run 全部强制 abort**，
    // 而真正超时的情形什么都不做（该杀的没杀，批次卡住）。
    // 改坏的后果是"正常的收尾流程把已经跑完的任务标成中止"。
    //
    // 构造要点：`drain` 在 `this.runs` 为空时**提前返回** "drained"，
    // 所以必须让一个 run 同时满足「其 done 已 resolve」且「仍在 runs 表里」——
    // `runs.delete` 在 collect 生成器的 finally 里，只要**只拉一次** next()
    // 让生成器挂在 yield 上，就既完成了 run、又留住了表项。
    let polls = 0;
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      [
        {
          match: "/events",
          reply: () => {
            polls += 1;
            return { status: 200, body: { events: [], status: polls >= 2 ? "completed" : "running" } };
          },
        },
        { match: "/abort", method: "POST", reply: () => ({ status: 200, body: {} }) },
        { match: "/v1/runs", method: "POST", reply: () => ({ status: 200, body: { runId: "42" } }) },
      ],
      calls,
    );
    const adapter = bridge(fetchImpl);
    return (async () => {
      const handle = await adapter.dispatch(payload());
      const iter = adapter.collect(handle)[Symbol.asyncIterator]();
      await iter.next(); // 只拉一次：run 跑完，但生成器仍挂在 yield 上
      const settled = await adapter.drain(500);
      expect(settled).toBe("drained");
      expect(calls.filter((c) => c.url.includes("/abort"))).toEqual([]);
      await iter.return?.(undefined); // 收尾，避免留下悬挂的生成器
    })();
  });
});
