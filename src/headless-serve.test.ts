import { afterEach, describe, expect, it } from "vitest";
import {
  createServeState,
  routeRequest,
  serveEmit,
  serveFinish,
  serveIndexHtml,
  sseFrame,
  startServe,
} from "../headless/serve";
import { buildReceipt } from "../shared/delivery-receipt";

/**
 * serve 形态的测试：路由与状态派生走纯函数，**HTTP 那一层走真实请求**
 * （端口 0 = 系统分配，所以不会撞上 smoke 用的固定端口 —— 历史上偶发红的根因之一）。
 * 断言真实字节而不是"某个函数被调过"。
 */
const open: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

function receipt() {
  return buildReceipt({
    outcome: "delivered",
    verified: true,
    rounds: 0,
    checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
    tasks: [],
    conflicts: [],
  });
}

describe("serve · 状态派生", () => {
  const now = () => "2026-09-29T00:00:00.000Z";

  it("moves to running on hello and to delivered only on a terminal done", () => {
    const s = createServeState();
    serveEmit(s, { type: "hello", protocolVersion: "x", projectRoot: "/p", llmProvider: "sensenova", arbitration: "revert-batch", agentRouter: true, warnings: [] }, now);
    expect(s.status).toBe("running");
    // receipt 到不代表交付：崩溃也可能留下半截事件流，只有终态能区分。
    serveEmit(s, { type: "receipt", receipt: receipt() }, now);
    expect(s.status).toBe("running");
    serveEmit(s, { type: "done", passed: true, report: {} }, now);
    expect(s.status).toBe("delivered");
    expect(s.events).toHaveLength(3);
    expect(s.updatedAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("marks a failed run as failed even when the report says passed", () => {
    const s = createServeState();
    serveEmit(s, { type: "done", passed: false, report: {} }, now);
    expect(s.status).toBe("failed");
  });

  it("marks an error as failed and keeps the receipt visible", () => {
    const s = createServeState();
    serveEmit(s, { type: "receipt", receipt: receipt() }, now);
    serveEmit(s, { type: "error", message: "boom" }, now);
    expect(s.status).toBe("failed");
    expect(s.receipt?.outcome).toBe("delivered");
  });

  it("records the CLI exit code so hosts can read it over HTTP too", () => {
    const s = createServeState();
    expect("exitCode" in s).toBe(false);
    serveFinish(s, 2, now);
    expect(s.exitCode).toBe(2);
  });
});

describe("serve · SSE 帧", () => {
  it("frames an event with an id the client can resume from", () => {
    const frame = sseFrame({ type: "log", text: "hi" }, 7);
    expect(frame).toBe(`id: 7\ndata: {"type":"log","text":"hi"}\n\n`);
  });
});

describe("serve · 路由", () => {
  it("serves the page, the state JSON and the event stream", () => {
    const s = createServeState();
    const page = routeRequest(s, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers["Content-Type"]).toContain("text/html");

    const state = routeRequest(s, "GET", "/state");
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ status: "idle" });

    const events = routeRequest(s, "GET", "/events");
    expect(events.stream).toBe("events");
    expect(events.headers["Content-Type"]).toContain("text/event-stream");
  });

  it("rejects non-GET on the stream and non-POST on /run", () => {
    const s = createServeState();
    // POST /events 不该被当成订阅：那是"我要投一个 run"的形状，静默接受会让人
    // 以为订阅成功了而实际上什么都没连上。
    expect(routeRequest(s, "POST", "/events").status).toBe(405);
    expect(routeRequest(s, "GET", "/run").status).toBe(405);
  });

  it("404s unknown paths instead of falling back to the page", () => {
    // 兜底到首页会让"打错地址"看起来像"服务正常"。
    expect(routeRequest(createServeState(), "GET", "/nope").status).toBe(404);
  });
});

describe("serve · 首页", () => {
  it("shows the conclusion and escapes event text", () => {
    const s = createServeState();
    serveEmit(s, { type: "log", text: "<script>alert(1)</script>" });
    serveEmit(s, { type: "receipt", receipt: receipt() });
    const html = serveIndexHtml(s);
    expect(html).toContain("已交付");
    expect(html).toContain(receipt().headline);
    // 事件文本来自模型输出 = 不可信输入，必须转义。
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says there is no receipt yet rather than rendering an empty block", () => {
    const html = serveIndexHtml(createServeState());
    expect(html).toContain("还没有凭据");
  });

  it("renders a receipt row as its headline, not as raw JSON", () => {
    // 事件行里 receipt 那一格用的是 headline；退化成 JSON.stringify 也能让
    // "页面含 headline"通过（凭据块本身就有），所以必须钉住**这一行**。
    const s = createServeState();
    serveEmit(s, { type: "receipt", receipt: receipt() });
    const html = serveIndexHtml(s);
    expect(html).toContain(`<b>receipt</b> ${receipt().headline}`);
    expect(html).not.toContain(`<b>receipt</b> {"type"`);
  });

  it("shows the exit code once there is one, and omits it before that", () => {
    const s = createServeState();
    expect(serveIndexHtml(s)).not.toContain("退出码");
    serveFinish(s, 2);
    expect(serveIndexHtml(s)).toContain("退出码 2");
  });

  it("stamps updatedAt with the injected clock, or the real one when absent", () => {
    const injected = createServeState();
    serveEmit(injected, { type: "log", text: "x" }, () => "2026-09-29T00:00:00.000Z");
    expect(injected.updatedAt).toBe("2026-09-29T00:00:00.000Z");

    const real = createServeState();
    serveEmit(real, { type: "log", text: "x" });
    // 不传时钟时用真实时钟 —— 那个分支没人盯就会退化成"永远不更新时间"。
    expect(typeof real.updatedAt).toBe("string");
    expect(Date.parse(real.updatedAt!)).toBeGreaterThan(0);
  });
});

describe("serve · HTTP", () => {
  it("answers state over a real socket", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "idle" });
  });

  it("streams events and replays history to a late subscriber", async () => {
    const srv = await startServe({
      run: async (_payload, emit) => {
        emit({ type: "log", text: "first" });
        return 0;
      },
    });
    open.push(srv);
    // 先跑一次，制造历史
    const post = await fetch(`http://127.0.0.1:${srv.port}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    expect(post.status).toBe(202);

    // 后连上的客户端必须能拿到**已经发生过的**事件，否则晚打开一秒就看不到开头。
    const res = await fetch(`http://127.0.0.1:${srv.port}/events`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("id: 0");
    expect(text).toContain("first");
    await reader.cancel();
  });

  it("refuses a second concurrent run with 409 and a reason", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const srv = await startServe({
      run: async () => {
        await gate;
        return 0;
      },
    });
    open.push(srv);
    const first = await fetch(`http://127.0.0.1:${srv.port}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "a", projectRoot: "." }),
    });
    expect(first.status).toBe(202);
    const second = await fetch(`http://127.0.0.1:${srv.port}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "b", projectRoot: "." }),
    });
    expect(second.status).toBe(409);
    // 光一个 409 说不清为什么不行 —— 原因写在响应体里。
    expect(await second.text()).toContain("一次只跑一个");
    release!();
  });

  it("rejects GET /run over HTTP instead of treating it as a run submission", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/run`);
    // 405 而不是 400/202：GET 进到 POST 分支会去解析空 body，报成"body 不是合法
    // JSON"—— 那个错误和"你用错方法了"是两回事，混起来排查时指向错的地方。
    expect(res.status).toBe(405);
  });

  it("rejects a non-JSON body with 400", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/run`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });
});
