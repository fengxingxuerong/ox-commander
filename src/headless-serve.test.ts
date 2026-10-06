import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, type DOMWindow } from "jsdom";
import {
  createServeState,
  routeRequest,
  serveEmit,
  serveFinish,
  serveIndexHtml,
  sseFrame,
  startServe,
} from "../headless/serve";
import { parseSpec } from "../headless/protocol";
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

/** 读一次 /state。 */
async function getState(base: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${base}/state`)).json()) as Record<string, unknown>;
}

/**
 * 轮询直到 `cond` 成立。
 *
 * 为什么需要它：这批端到端断言跨了**真实的异步边界**（POST /run 之后 run 才
 * 挂上审批、engine 才填好）。写死一个 sleep 就是在赌机器快慢 —— 赌赢了是绿，
 * 赌输了是**偶发红**，而偶发红会被当成"测试不稳定"忽略掉。
 * 赌注还不小：这里赌的恰恰是"取消能不能解开一个卡死的 run"。
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待条件成立超时（${timeoutMs}ms）`);
}

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

  /**
   * `failed` 的**两种结局不得同形**（2026-10-05 状态标签审计）。
   *
   * 缺陷：旧标签把两种完全不同的结局印成同一句 `未交付 / 出错`：
   *   · `done(passed=false)` —— **跑完了**，代码也在，只是门禁没过；
   *   · `error` —— **崩了**，可能连凭据都没产出。
   *
   * 实测真实 run 的第一种形状（最普通的一种红）：
   *
   *   status=failed  outcome=blocked  rounds=1   tasks 1/1 完成
   *   页面顶上印的是：「未交付 / 出错」
   *
   * 读者据此去找**崩溃日志**，而实际上一切正常跑完了、该看的是验证输出；
   * 反过来真崩时也只印这句，两边看不出差别 —— 崩了这件事被藏起来了。
   *
   * `serveIndexHtml` 此前对这段标签**零断言**（`grep「OxCommander ·」` 无命中），
   * 所以这个合并从未被谁挡下。
   */
  describe("状态标签 · failed 要分两层", () => {
    const heading = (s: ReturnType<typeof createServeState>) =>
      /<h1>OxCommander · ([^<]*)<\/h1>/.exec(serveIndexHtml(s))?.[1] ?? "";

    it("跑完了但门禁没过：有凭据 ⇒ 说「已跑完」，不许说「出错」", () => {
      const s = createServeState();
      serveEmit(s, { type: "hello", protocolVersion: "x", projectRoot: "/p", llmProvider: "s", arbitration: "revert-batch", agentRouter: true, warnings: [] }, now);
      serveEmit(s, { type: "receipt", receipt: receipt() }, now);
      serveEmit(s, { type: "done", passed: false, report: {} }, now);
      expect(s.status).toBe("failed");
      const h = heading(s);
      expect(h).toContain("已跑完");
      expect(h).not.toContain("出错");
    });

    it("中途崩了：无凭据 ⇒ 说「出错」", () => {
      const s = createServeState();
      serveEmit(s, { type: "hello", protocolVersion: "x", projectRoot: "/p", llmProvider: "s", arbitration: "revert-batch", agentRouter: true, warnings: [] }, now);
      serveEmit(s, { type: "error", message: "boom" }, now);
      expect(s.receipt).toBeUndefined();
      expect(heading(s)).toContain("出错");
    });

    it("有凭据但随后 error（崩溃在收尾之后）：仍按有凭据算「已跑完」", () => {
      // receipt 先到、error 后到 —— 这正是上面那条既有测试的形状。
      // 判据取"有没有凭据"而不是"最后一条事件是什么"：
      // 崩溃在收尾之后时，凭据仍然是对这次运行的完整描述。
      const s = createServeState();
      serveEmit(s, { type: "receipt", receipt: receipt() }, now);
      serveEmit(s, { type: "error", message: "boom" }, now);
      expect(heading(s)).toContain("已跑完");
    });

    it("两种结局的标签不得同形（合并就没法分头了）", () => {
      const ran = createServeState();
      serveEmit(ran, { type: "receipt", receipt: receipt() }, now);
      serveEmit(ran, { type: "done", passed: false, report: {} }, now);

      const crashed = createServeState();
      serveEmit(crashed, { type: "error", message: "boom" }, now);

      expect(heading(ran)).not.toBe(heading(crashed));
    });

    it("非 failed 的三种状态不受影响", () => {
      const idle = createServeState();
      expect(heading(idle)).toBe("空闲");

      const running = createServeState();
      serveEmit(running, { type: "hello", protocolVersion: "x", projectRoot: "/p", llmProvider: "s", arbitration: "revert-batch", agentRouter: true, warnings: [] }, now);
      expect(heading(running)).toBe("运行中");

      const ok = createServeState();
      serveEmit(ok, { type: "receipt", receipt: receipt() }, now);
      serveEmit(ok, { type: "done", passed: true, report: {} }, now);
      expect(heading(ok)).toBe("已交付");
    });
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

  it("暂停/继续是 POST-only 的控制面，不是状态查询", () => {
    const s = createServeState();
    // GET 一个控制端点不该被当成"查一下状态"：静默接受会让人以为暂停成功了。
    expect(routeRequest(s, "GET", "/pause").status).toBe(405);
    expect(routeRequest(s, "GET", "/resume").status).toBe(405);
    // POST 只是**指令**，由调用方转给引擎；路由本身不做副作用（可逐位点审）。
    expect(routeRequest(s, "POST", "/pause").control).toBe("pause");
    expect(routeRequest(s, "POST", "/resume").control).toBe("resume");
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
    expect(res.status).toBe(405);
  });
});

/**
 * `validate` 预检门（2026-10-05 D3 修复）。
 *
 * 修复前 `POST /run` 只验 JSON 语法，于是 `{"nope":1}` 也回
 * `202 {"accepted":true}`，随后在 run 里静默失败 —— CI 集成方看到 202 会
 * 以为任务已入队，而 `/state` 早已翻成 failed 且没有退出码可读。
 */
describe("serve · /run 的 spec 预检（D3）", () => {
  /** 与 `serve-main.ts` 同一份校验：同一句话，两个宿主。 */
  const validate = (payload: unknown): string | undefined => {
    const parsed = parseSpec(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}));
    return parsed.ok ? undefined : parsed.message;
  };

  async function post(srv: { port: number }, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${srv.port}/run`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
  }

  it("缺必填字段的 spec 得 400，而不是先 202 再静默失败", async () => {
    let ran = false;
    const srv = await startServe({ validate, run: async () => { ran = true; return 0; } });
    open.push(srv);
    const res = await post(srv, JSON.stringify({ nope: 1 }));
    expect(res.status).toBe(400);
    // 与 CLI 入口同源的那句聚合报错
    expect(await res.text()).toContain("requirement 必须是非空字符串");
    expect(await (await fetch(`http://127.0.0.1:${srv.port}/state`)).json()).toMatchObject({
      status: "idle",
    });
    expect(ran).toBe(false); // 被拒的 spec 不得真的开跑
  });

  it("非法枚举与越界数字：一次列全，不半途退出", async () => {
    const srv = await startServe({ validate, run: async () => 0 });
    open.push(srv);
    const res = await post(
      srv,
      JSON.stringify({ requirement: "x", projectRoot: ".", arbitration: "bogus", maxRepairRounds: -1 }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("arbitration 必须是");
    expect(text).toContain("maxRepairRounds 必须是不小于 0 的数字");
  });

  it("合法 spec 仍然 202，且被拒的那次不算占用并发名额", async () => {
    const srv = await startServe({ validate, run: async () => 0 });
    open.push(srv);
    // 先投一份非法的：它不该把 busy 置上，否则下一份合法 spec 会误得 409。
    expect((await post(srv, JSON.stringify({ nope: 1 }))).status).toBe(400);
    expect((await post(srv, JSON.stringify({ requirement: "a", projectRoot: "." }))).status).toBe(202);
  });
});

describe("serve · 审批链（P2-3）", () => {
  it("approvalRequester 广播事件并 park，POST /approve 放行后 resolve true", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const p = srv.approvalRequester("npm", ["run", "deploy"]);
    // 事件已广播 + 状态队列可见（字段即承诺：有 pending 才有键）
    expect(srv.state.pendingApprovals).toHaveLength(1);
    expect(srv.state.pendingApprovals![0]!.command).toBe("npm");
    expect(srv.state.events.at(-1)).toMatchObject({ type: "approval-request", command: "npm", args: ["run", "deploy"] });
    // 还在挂（不会立即 resolve）
    let settled = false;
    void p.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // 批准
    const requestId = srv.state.pendingApprovals![0]!.requestId;
    const res = await fetch(`http://127.0.0.1:${srv.port}/approve`, {
      method: "POST",
      body: JSON.stringify({ requestId, granted: true }),
    });
    expect(res.status).toBe(200);
    expect(await p).toBe(true);
    // 队列清空：键消失（不是空数组）
    expect("pendingApprovals" in srv.state).toBe(false);
  });

  it("拒绝路径：granted=false → resolve false（上层按拒绝处理）", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const p = srv.approvalRequester("npm", ["run", "deploy"]);
    const requestId = srv.state.pendingApprovals![0]!.requestId;
    const res = await fetch(`http://127.0.0.1:${srv.port}/approve`, {
      method: "POST",
      body: JSON.stringify({ requestId, granted: false }),
    });
    expect(res.status).toBe(200);
    expect(await p).toBe(false);
  });

  it("未知 requestId 回 404，且不改动队列", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    void srv.approvalRequester("npm", ["run", "deploy"]);
    const res = await fetch(`http://127.0.0.1:${srv.port}/approve`, {
      method: "POST",
      body: JSON.stringify({ requestId: "nope", granted: true }),
    });
    expect(res.status).toBe(404);
    expect(srv.state.pendingApprovals).toHaveLength(1);
  });

  it("close 时把挂着的审批按拒绝收尾（fail-closed 最后一环：无人再能回答）", async () => {
    const srv = await startServe({ run: async () => 0 });
    const p = srv.approvalRequester("npm", ["run", "deploy"]);
    await srv.close();
    expect(await p).toBe(false);
    expect("pendingApprovals" in srv.state).toBe(false);
  });
});

describe("serve · HTTP 控制面与边界", () => {
  it("暂停/继续真的递到引擎，且在状态里看得见（P1-5 的 CLI 对等能力）", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const srv = await startServe({
      run: async (_payload, emit, control) => {
        emit({ type: "log", text: "working" });
        control?.({
          pause: () => calls.push("pause"),
          resume: () => calls.push("resume"),
        });
        await gate;
        return 0;
      },
    });
    open.push(srv);
    const post = await fetch(`http://127.0.0.1:${srv.port}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    expect(post.status).toBe(202);

    const pause = await fetch(`http://127.0.0.1:${srv.port}/pause`, { method: "POST" });
    expect(pause.status).toBe(200);
    // 2026-10-05 补了 /cancel 之后，响应体多带一个 cancelled 字段（同一组控制面
    // 一次说清当前处于哪种状态，省得客户端为了画一个按钮多发一次 /state）。
    // 用 toEqual 而不是 toMatchObject 是刻意的：多一个字段就该被这条断言看见。
    expect(await pause.json()).toEqual({ paused: true, cancelled: false });
    expect(calls).toEqual(["pause"]);
    // 状态里要看得见，否则"服务说暂停了、界面看不出来"又是一个自报状态
    const paused = await (await fetch(`http://127.0.0.1:${srv.port}/state`)).json();
    expect(paused.paused).toBe(true);
    expect((await (await fetch(`http://127.0.0.1:${srv.port}/`)).text())).toContain("已暂停");

    const resume = await fetch(`http://127.0.0.1:${srv.port}/resume`, { method: "POST" });
    expect(await resume.json()).toEqual({ paused: false, cancelled: false });
    expect(calls).toEqual(["pause", "resume"]);
    // 恢复后键必须消失（字段即承诺：没有这个键就是没暂停）
    const after = await (await fetch(`http://127.0.0.1:${srv.port}/state`)).json();
    expect("paused" in after).toBe(false);
    release!();
  });

  it("没有 run 在跑时暂停无从谈起（409，并把原因说清）", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/pause`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("没有 run 在跑");
  });

  it("rejects a non-JSON body with 400", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/run`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });
});

/**
 * `/cancel`（2026-10-05 横向比对补齐）。
 *
 * **为什么要有这个端点**：桌面形态有 `orchestration:cancel`，serve 形态没有。
 * 实测的坏后果不是"少一个按钮"，而是一个**卡死**：
 *
 * ```
 * state.status = "idle"          ← 引擎还没挂上，pause/resume 都答 409
 * 等待审批 = ["git"]
 * POST /pause  → 409   POST /resume → 409   POST /cancel → 404（修复前）
 * 再 POST /run → 409 "已经有一个 run 在跑"
 * ```
 *
 * 也就是说：一个等审批的 run 在 serve 形态下**永远出不来**，而后续 run 全被
 * busy 挡住 —— 整个服务只剩一个待审批的决定可以解开它。桌面形态点一下取消就解了。
 *
 * 两处设计要一起看，否则会从一个坑掉进另一个：
 *  ① **中止必须 fail-closed**：把挂着的审批 resolve(false)，不是 resolve(true)。
 *     "没人回答"绝不能读成"批准" —— 这正是桌面 `abortAllApprovals()` 的纪律。
 *  ② **引擎还没挂上时也要能中止**：这恰恰是最需要中止的那种（正卡在审批里），
 *     所以不能沿用 pause 的"没有 run 就 409"。
 */
describe("serve · /cancel（横向比对补齐：桌面有、serve 原来没有）", () => {
  it("路由先认下 /cancel，且只收 POST", () => {
    expect(routeRequest(createServeState(), "POST", "/cancel").control).toBe("cancel");
    expect(routeRequest(createServeState(), "GET", "/cancel").status).toBe(405);
    // 与 pause/resume 同一条纪律：控制面不能被 GET 悄悄读走
    expect(routeRequest(createServeState(), "GET", "/pause").status).toBe(405);
  });

  it("没有 run 在跑 → 409（与 pause 一致；真的什么也没在跑就没得中止）", async () => {
    const srv = await startServe({ run: async () => 0 });
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    // ⚠️ 这里的判据必须是 "**有没有 run 在跑**"，不是 "有没有引擎"。
    // 第一版我按 engine 判，结果从来没跑过任何 run 时 engine 恒为 undefined，
    // `/cancel` 会报 200 "已中止" —— 而它什么都没中止，只是给一张空表做了遍循环。
    // 那比 404 更坏：客户端会把"已中止"当成事实记下来。
    //
    // 所以这条断言要能区分"引擎为 undefined"和"没有 run 在跑"两种状态。
    // 二次收紧：先跑完一个 run（此时 engine 曾挂上又被清空，busy 也回到 false），
    // 再取消 —— 那时 engine 仍是 undefined，而"没有 run"必须答 409。
    const res = await fetch(`${base}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("没有 run 在跑");

    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    await waitFor(async () => (await getState(base)).status !== "running");
    // run 跑完了：engine 已清空、busy 也回到 false，但服务端状态里可能还留着痕迹。
    // 再来一次取消 —— 仍然必须 409。写成 `if (!engine)` 的话这里会变 200。
    const after = await fetch(`${base}/cancel`, { method: "POST" });
    expect(after.status, "run 结束后取消必须仍是 409").toBe(409);
    expect(await after.text()).toContain("没有 run 在跑");
  });

  it("引擎不支持中止 → 501，不假装成功", async () => {
    // EngineControl.cancel 是可选的（只测引擎逻辑的宿主可能只给 pause/resume）。
    // 报 200 就等于说"已中止"，而什么也没发生 —— 那比 404 更坏。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const srv = await startServe({
      run: async (_p, _e, control) => {
        control?.({ pause: () => {}, resume: () => {} }); // 故意不给 cancel
        await gate;
        return 0;
      },
    });
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    // 等 engine 真的挂上 —— 不然 /cancel 会在"还没有 run"那条路上答 409，
    // 于是 501 那条断言即使实现坏了也会"因为别的原因绿"。
    await waitFor(async () => (await fetch(`${base}/pause`, { method: "POST" })).status === 200);
    const res = await fetch(`${base}/cancel`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.text()).toContain("不支持中止");
    release();
  });

  it("卡在等审批上的 run 能被中止脱困，且审批 fail-closed 放行", async () => {
    // 这是本组用例的核心：修复前这个 run **永远**出不来（见文件头）。
    let grantedToRun: boolean | undefined;

    // run 里要用到 srv.approvalRequester，而 srv 此刻还不存在 —— 用这个盒子过桥，
    // 免得写成"在 startServe 的回调里引用还没初始化的 const"那种 TDZ 陷阱。
    const box: { srv?: Awaited<ReturnType<typeof startServe>> } = {};
    box.srv = await startServe({
      run: async (_p, _e, control) => {
        // 真实时序：引擎在规划前挂上，但审批发生在更后面的执行阶段。
        control?.({ pause: () => {}, resume: () => {}, cancel: () => {} });
        grantedToRun = await box.srv!.approvalRequester("git", ["push"]);
        return grantedToRun ? 0 : 1;
      },
    });
    const srv = box.srv;
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;

    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    // 等审批真的挂上
    await waitFor(async () => {
      const st = await getState(base);
      return ((st.pendingApprovals as unknown[] | undefined)?.length ?? 0) === 1;
    });

    const res = await fetch(`${base}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean; releasedApprovals: number };
    expect(body.cancelled).toBe(true);
    // 挂着的审批被放掉了 —— 不放掉的话 run 永远停在 await 上
    expect(body.releasedApprovals).toBe(1);

    await waitFor(async () => grantedToRun !== undefined);
    // ⚠️ **fail-closed**：中止时一律按"拒绝"放行，绝不能是"批准"。
    // 这正是桌面 abortAllApprovals() 的纪律；写成 true 就是把中止当成默认放行命令。
    expect(grantedToRun, "中止时必须按拒绝放行（fail-closed）").toBe(false);

    // 关键后果：run 结束了，服务不再 busy —— 下一个 run 能进来
    await waitFor(async () => (await getState(base)).status !== "running");
    const again = await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "第二个", projectRoot: "." }),
    });
    expect(again.status, "中止后服务不应还卡在 busy").toBe(202);
  });

  it("中止会把暂停标记一起清掉（两个状态不同时成立）", async () => {
    // 中止是终止性的；留着"已暂停"会让状态页同时说两件互斥的事。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const srv = await startServe({
      run: async (_p, _e, control) => {
        control?.({ pause: () => {}, resume: () => {}, cancel: () => {} });
        await gate;
        return 0;
      },
    });
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    await waitFor(async () => (await fetch(`${base}/pause`, { method: "POST" })).status === 200);
    expect((await getState(base)).paused).toBe(true);

    expect((await fetch(`${base}/cancel`, { method: "POST" })).status).toBe(200);
    const s2 = await getState(base);
    expect(s2.paused, "中止后不该还显示已暂停").toBeUndefined();
    expect(s2.cancelled).toBe(true);

    // 状态页措辞：只说"已请求中止"，不说"已中止" —— 后者要等引擎真停下来才配得上
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("已请求中止");
    expect(html).not.toContain("已暂停");
    release();
  });

  it("run 在跑但引擎还没挂上 → 暂停/继续答 409，并说清要用 /cancel", async () => {
    // 这个窗口真实存在：`onEngine` 在规划前才调用（run-spec.ts:312），而 run 一被
    // 接受 busy 就已经是 true。于是有一段时间"run 在跑、引擎还没挂上"。
    //
    // 此时 pause/resume 无从生效（没有引擎可转发），但 cancel **是**有效的 ——
    // 那正是审批卡住时所处的位置。所以答复必须区分：不能笼统说"没有 run 在跑"，
    // 那样会让人以为"再等等就好"，而实际上要换另一个端点。
    const srv = await startServe({
      run: async (_p, emit) => {
        // ⚠️ `status` 只有在 **`hello` 事件**里才会变成 running（serveEmit:90，
        // log/error/done 都不改 status）—— 我第一版发的是 `log`，于是 /state 的
        // status 永远是 idle，等条件一直超时。这里等的是"run 确实在跑"，
        // 而 hello 正是这个信号本身。
        emit({
          type: "hello",
          protocolVersion: "x",
          projectRoot: ".",
          llmProvider: "sensenova",
          arbitration: "revert-batch",
          agentRouter: true,
          warnings: [],
        });
        await new Promise((r) => setTimeout(r, 400));
        return 0;
      },
      // 注意 run 里**不**调 control：这就是"引擎还没挂上"的样子。
    });
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    // run 一被接受就 busy=true；等第一条事件落地，确认 handler 已经进去了。
    await waitFor(async () => (await getState(base)).status === "running");

    for (const path of ["/pause", "/resume"]) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      expect(res.status, `${path} 在引擎未挂上时应 409`).toBe(409);
      expect(await res.text(), `${path} 的答复必须指向 /cancel`).toContain("/cancel");
    }
    // 同一个窗口里 cancel 必须**可用**（它不依赖引擎，走 cancelWithoutEngine）
    expect((await fetch(`${base}/cancel`, { method: "POST" })).status).toBe(200);
  });

  it("run 结束后 cancelled 键消失（字段即承诺，不留过期的中止标记）", async () => {
    // 与 paused 同一纪律（serve.ts 原注释已说明）：跑完了就没有"已中止"这回事。
    // 不清的坏处很具体：下一个 run 一上来，状态页/MCP 客户端就显示"已请求中止"，
    // 而那次 run 其实完全正常 —— 一个过期的标记会变成一句谎话。
    //
    // ⚠️ 所以必须**真的取消过一次**再断言键消失。run 一路正常跑完时
    // `state.cancelled` 本来就一直是 undefined，删不删这条断言都过 ——
    // 那样这条用例就是装饰品。
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const srv = await startServe({
      run: async (_p, _e, control) => {
        control?.({ pause: () => {}, resume: () => {}, cancel: () => {} });
        await gate;
        return 0;
      },
    });
    open.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    await fetch(`${base}/run`, {
      method: "POST",
      body: JSON.stringify({ requirement: "x", projectRoot: "." }),
    });
    await waitFor(async () => (await fetch(`${base}/pause`, { method: "POST" })).status === 200);
    expect((await fetch(`${base}/cancel`, { method: "POST" })).status).toBe(200);
    // 中止当下键必须在，否则"已请求中止"这件事根本没被记录
    expect((await getState(base)).cancelled).toBe(true);

    release();
    await waitFor(async () => (await getState(base)).status !== "running");
    expect("cancelled" in (await getState(base)), "run 结束后不该还留着中止标记").toBe(false);
    expect((await getState(base)).paused).toBeUndefined();
  });
});

/**
 * 状态页的**浏览器行为**（2026-10-05 修的一个真实缺陷）。
 *
 * 缺陷：页面脚本用 `document.querySelector("ul")` 取事件列表，但页面上有两个
 * `ul` —— 有审批在等时先渲染的是**审批列表**。于是新事件被追加进审批列表，
 * 跟"批准/拒绝"按钮混在一起。jsdom 实测：事件落在 ul[0]（approvals）。
 *
 * 为什么用 jsdom 而不是断言 HTML 字符串：bug 在**脚本执行后**的 DOM 里，
 * 字符串断言只能证明"class 写对了"，证明不了"脚本按 class 选中了"。
 * 这里跑页面自己的 <script>，EventSource 用真实 SSE 喂。
 *
 * 为什么 mock 掉 EventSource 而不是连真服务：jsdom 无 EventSource；
 * 这里要验的是"脚本往哪个 <ul> 里 append"，与传输无关。
 */
describe("serve · 状态页的事件流落点（D8）", () => {
  it("有审批在等时，新事件仍然追加进事件列表而不是审批列表", async () => {
    const state = createServeState();
    state.pendingApprovals = [{ requestId: "a-1-m0abc", command: "npm", args: ["run", "deploy"] }];
    state.events = [{ type: "log", text: "before-page-load" }];

    const html = serveIndexHtml(state);
    // 页面自带的订阅回调：把一帧 SSE 喂给页面里那个 es.onmessage。
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(win: DOMWindow) {
        const handlers: Array<(m: { data: string }) => void> = [];
        win.EventSource = class {
          onmessage: ((m: { data: string }) => void) | null = null;
          constructor() {
            handlers.push((m) => this.onmessage?.(m));
          }
          close() {}
        };
        (win as unknown as { __push: (e: unknown) => void }).__push = (e) => {
          for (const h of handlers) h({ data: JSON.stringify(e) });
        };
      },
    });
    const win = dom.window as unknown as {
      document: Document;
      __push: (e: unknown) => void;
    };
    // 脚本先取到 ul 再由 handler append，所以 push 之前它已经选好了目标。
    win.__push({ type: "log", text: "LIVE-EVENT" });

    const approvalsUl = win.document.querySelector("ul.approvals")!;
    const eventsUl = win.document.querySelector("ul.events")!;
    expect(approvalsUl, "审批列表应有独立 class").not.toBeNull();
    expect(eventsUl, "事件列表应有独立 class").not.toBeNull();
    // 事件只进事件列表；审批列表里只有那一条待批项，一个事件都不该混进来
    expect(eventsUl.textContent).toContain("LIVE-EVENT");
    expect(approvalsUl.textContent).not.toContain("LIVE-EVENT");
    expect(approvalsUl.querySelectorAll("li")).toHaveLength(1);
    // 反向锚点：若有人把选择器改回 "ul"（第一个 ul），事件会落进 ul[0] —— 这里会红
    expect(win.document.querySelectorAll("ul")[0]).toBe(approvalsUl);
    dom.window.close();
  });
});
