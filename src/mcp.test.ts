/**
 * 反向 MCP server 的纯逻辑测试：握手 / 工具表 / 五工具 × 成败分支 / 协议错误。
 * HTTP 面全部注入假件（不联网），逐条断言响应 JSON-RPC 形状与文本事实。
 */
import { describe, expect, it } from "vitest";
import { handleMcpMessage, mcpToolDefs, MCP_PROTOCOL_VERSION, type ServeHttp } from "../headless/mcp";

function fakeHttp(over: Partial<Record<"get" | "post", (path: string, body?: unknown) => Promise<{ status: number; body: string }>>> & { state?: unknown } = {}): ServeHttp {
  const state = JSON.stringify(over.state ?? { status: "idle", events: [] });
  return {
    get: over.get ?? (async () => ({ status: 200, body: state })),
    post: over.post ?? (async () => ({ status: 200, body: "" })),
  };
}

function stateObj(over: Record<string, unknown>): Record<string, unknown> {
  return { status: "idle", events: [], ...over };
}

async function call(name: string, args: Record<string, unknown> = {}, http: ServeHttp = fakeHttp()): Promise<{ text: string; isError: boolean }> {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    http,
  );
  const result = (res!.result ?? {}) as { content?: Array<{ text?: string }>; isError?: boolean };
  return { text: result.content?.[0]?.text ?? "", isError: result.isError === true };
}

describe("MCP 握手与协议层", () => {
  it("initialize 返回协议版本、能力与 serverInfo", async () => {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id: 7, method: "initialize", params: {} },
      fakeHttp(),
    );
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ox-commander" } },
    });
  });

  it("notifications/initialized 与 ping 都有响应（有的客户端把它发成请求）", async () => {
    const a = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "notifications/initialized" }, fakeHttp());
    const b = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "ping" }, fakeHttp());
    expect(a).toMatchObject({ id: 1, result: {} });
    expect(b).toMatchObject({ id: 2, result: {} });
  });

  it("纯通知（无 id）不回话；未知方法回 -32601", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/x" }, fakeHttp())).toBeUndefined();
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, fakeHttp());
    expect(res!.error).toMatchObject({ code: -32601 });
  });

  it("坏形状（非对象 / 无 method）静默忽略，不炸会话", async () => {
    expect(await handleMcpMessage(null, fakeHttp())).toBeUndefined();
    expect(await handleMcpMessage("hello", fakeHttp())).toBeUndefined();
    expect(await handleMcpMessage({ id: 1 }, fakeHttp())).toBeUndefined();
  });

  it("tools/list 的工具名与描述表一致，六个工具各带 inputSchema", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, fakeHttp());
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(mcpToolDefs().map((t) => t.name));
    expect(tools).toHaveLength(6);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });
});

describe("MCP 工具（ox_status / ox_receipt / ox_events）", () => {
  it("ox_status 汇总状态行（running + 暂停 + 退出码 + 事件数）", async () => {
    const { text, isError } = await call("ox_status", {}, fakeHttp({
      state: stateObj({ status: "running", paused: true, exitCode: undefined, updatedAt: "2026-10-02T00:00:00Z", events: [{ type: "log" }, { type: "log" }] }),
    }));
    expect(isError).toBe(false);
    expect(text).toContain("状态 running");
    expect(text).toContain("已暂停");
    expect(text).toContain("事件 2 条");
    expect(text).toContain("2026-10-02T00:00:00Z");
  });

  it("ox_receipt 有凭据回全文 JSON，没有时如实说明", async () => {
    const receipt = { outcome: "delivered", headline: "2 任务全部过门禁" };
    const withR = await call("ox_receipt", {}, fakeHttp({ state: stateObj({ receipt }) }));
    expect(withR.isError).toBe(false);
    expect(withR.text).toContain("delivered");
    expect(withR.text).toContain("2 任务全部过门禁");
    const withoutR = await call("ox_receipt", {}, fakeHttp());
    expect(withoutR.text).toContain("还没有交付凭据");
  });

  it("ox_events 默认尾部 30 条、可调、空事件如实说", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ type: "log", text: `e${i}` }));
    const { text } = await call("ox_events", { tail: 5 }, fakeHttp({ state: stateObj({ events: many }) }));
    expect(text).toContain("共 45 条，显示最近 5 条");
    expect(text).toContain("e44");
    expect(text).not.toContain("e39");
    const empty = await call("ox_events", {}, fakeHttp());
    expect(empty.text).toContain("还没有任何事件");
  });

  it("serve 响应体不可解析时 ox_status 如实报错而不是编一个状态", async () => {
    const { isError, text } = await call("ox_status", {}, fakeHttp({ get: async () => ({ status: 200, body: "<html>网关错误页</html>" }) }));
    expect(isError).toBe(true);
    expect(text).toContain("无法解析");
  });
});

describe("MCP 工具（ox_run / ox_control）与失败分支", () => {
  it("ox_run 受 202；busy 409 如实转述 serve 的原因", async () => {
    let posted: unknown;
    const ok = await call("ox_run", { spec: { requirement: "x", projectRoot: "/p" } }, fakeHttp({
      post: async (path, body) => {
        posted = { path, body };
        return { status: 202, body: JSON.stringify({ accepted: true }) };
      },
    }));
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("已受理");
    expect(posted).toMatchObject({ path: "/run", body: { requirement: "x" } });

    const busy = await call("ox_run", { spec: {} }, fakeHttp({
      post: async () => ({ status: 409, body: "已经有一个 run 在跑" }),
    }));
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("409");
    expect(busy.text).toContain("已经有一个 run 在跑");
  });

  it("ox_run 缺 spec / spec 非对象在工具侧拒绝", async () => {
    const r = await call("ox_run", {}, fakeHttp());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("spec 必须是对象");
  });

  it("ox_control pause/resume 各走对应路径，409（无 run 在跑）如实转述", async () => {
    const paths: string[] = [];
    const http = fakeHttp({
      post: async (path) => {
        paths.push(path);
        if (path === "/pause") return { status: 200, body: JSON.stringify({ paused: true }) };
        return { status: 409, body: "当前没有 run 在跑" };
      },
    });
    const p = await call("ox_control", { action: "pause" }, http);
    expect(p.text).toContain("已暂停");
    const r = await call("ox_control", { action: "resume" }, http);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("当前没有 run 在跑");
    expect(paths).toEqual(["/pause", "/resume"]);
    const bad = await call("ox_control", { action: "restart" }, http);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('action 必须是');
  });

  /**
   * `ox_control cancel`（2026-10-05 随 serve 的 `/cancel` 一起补的）。
   *
   * 为什么 MCP 这侧也得有：横向比对发现 serve 补了 `/cancel` 之后，
   * **MCP 客户端仍然完全中止不了** —— 它只有 pause/resume，而 pause 在卡住时
   * 恰恰不生效（引擎还没挂上）。那等于"用 MCP 驱动的人永远解不开死锁"。
   */
  it("ox_control cancel 走 /cancel，且说清它与 pause 的区别", async () => {
    const paths: string[] = [];
    const http = fakeHttp({
      post: async (path) => {
        paths.push(path);
        return { status: 200, body: JSON.stringify({ cancelled: true, releasedApprovals: 1 }) };
      },
    });
    const r = await call("ox_control", { action: "cancel" }, http);
    expect(r.isError).toBe(false);
    expect(paths).toEqual(["/cancel"]);
    // 三件事必须都在答复里，否则客户端会误判：
    expect(r.text).toContain("已请求中止");
    //   ① 不可恢复（不像 pause 能 resume）
    expect(r.text).toContain("不可恢复");
    //   ② 正在跑的任务不会被掐断 —— 这是中止与暂停最容易被混同的地方
    expect(r.text).toContain("不会被掐断");
    //   ③ 等待中的审批被按拒绝放行（fail-closed）
    expect(r.text).toContain("拒绝");
  });

  it("ox_control cancel 的 409/501 如实转述，不吞掉原因", async () => {
    const http409 = fakeHttp({ post: async () => ({ status: 409, body: "当前没有 run 在跑" }) });
    const a = await call("ox_control", { action: "cancel" }, http409);
    expect(a.isError).toBe(true);
    expect(a.text).toContain("无法中止");
    expect(a.text).toContain("当前没有 run 在跑");
    // 501 = 引擎不支持中止；不能被含糊成"中止失败"
    const http501 = fakeHttp({ post: async () => ({ status: 501, body: "当前引擎不支持中止" }) });
    const b = await call("ox_control", { action: "cancel" }, http501);
    expect(b.isError).toBe(true);
    expect(b.text).toContain("不支持中止");
  });

  it("ox_status 报出已请求中止（此前只认 paused，中止在 MCP 里完全不可见）", async () => {
    // 中止是最需要被看见的状态：run 即将结束、审批被 fail-closed 放掉了。
    // 看不见它，客户端只能看到"状态 running"。
    const { text } = await call("ox_status", {}, fakeHttp({ state: { status: "running", cancelled: true } }));
    expect(text).toContain("已请求中止");
    // 措辞里必须带"正在跑的任务跑完后退出"，否则与"已中止"混同
    expect(text).toContain("跑完后退出");
  });

  it("ox_control 的 action 枚举含 cancel（schema 与实现必须一致）", async () => {
    // 直接问 handleMcpMessage 的原始信封 —— call() 那个 helper 只解 text/isError。
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "tools/list" }, fakeHttp());
    const tools = (res?.result as { tools?: Array<{ name: string; inputSchema?: { properties?: { action?: { enum?: string[] } } } }> })?.tools ?? [];
    const control = tools.find((t) => t.name === "ox_control");
    // schema 里没有 cancel、而实现认 cancel = 客户端根本发现不了这个能力
    expect(control?.inputSchema?.properties?.action?.enum).toContain("cancel");
    expect(control?.inputSchema?.properties?.action?.enum).toEqual(["pause", "resume", "cancel"]);
  });

  it("ox_approve 批准/拒绝/404 如实转述 serve 的答复", async () => {
    const posted: Array<{ requestId?: unknown; granted?: unknown }> = [];
    const http = fakeHttp({
      post: async (_path, body) => {
        posted.push(body as { requestId?: unknown; granted?: unknown });
        if ((body as { requestId?: string }).requestId === "gone") {
          return { status: 404, body: "没有等待中的审批请求：gone" };
        }
        return { status: 200, body: JSON.stringify({ settled: true, granted: true }) };
      },
    });
    const ok = await call("ox_approve", { requestId: "a-1", granted: true }, http);
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("已批准 a-1");
    expect(posted[0]).toEqual({ requestId: "a-1", granted: true });
    const nok = await call("ox_approve", { requestId: "gone", granted: false }, http);
    expect(nok.isError).toBe(true);
    expect(nok.text).toContain("没有等待中的审批请求");
    // 404 专属尾巴：变异（=== → !==）会落到通用 "serve 拒绝（HTTP 404）" 分支，
    // 失去"可能已答复/已关闭服务"的提示 —— 断言尾巴钉住 404 分流。
    expect(nok.text).toContain("可能已答复/已关闭服务");
    expect(nok.text).not.toContain("serve 拒绝");
    const bad = await call("ox_approve", { granted: true }, http);
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("requestId 必须是字符串");
  });

  it("ox_status 在有待审批请求时列出明细（requestId + 命令）", async () => {
    const pending = [{ requestId: "a-1", command: "npm", args: ["run", "deploy"] }];
    const { text, isError } = await call("ox_status", {}, fakeHttp({
      state: { status: "running", events: [], pendingApprovals: pending },
    }));
    expect(isError).toBe(false);
    expect(text).toContain("等待审批 1 条");
    expect(text).toContain("a-1: npm run deploy");
    const idle = await call("ox_status", {}, fakeHttp());
    expect(idle.text).not.toContain("等待审批");
  });

  it("serve 不可达（fetch reject）转成工具失败，异常不逃出分发器", async () => {
    const r = await call("ox_status", {}, fakeHttp({ get: async () => { throw new Error("ECONNREFUSED"); } }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ECONNREFUSED");
  });

  it("未知工具是工具失败（isError），不是协议错误", async () => {
    const r = await call("ox_nope", {}, fakeHttp());
    expect(r.isError).toBe(true);
    expect(r.text).toContain("未知工具");
  });
});

describe("MCP 坏形状输入（类型守卫真值表——变异审计的用例来源）", () => {
  it("tools/call 的 params 缺席/null/标量：按空处理，不崩、不误判", async () => {
    const noParams = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call" }, fakeHttp());
    expect((noParams!.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("未知工具");
    const nullParams = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: null },
      fakeHttp(),
    );
    expect((nullParams!.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("未知工具");
  });

  it("arguments 为 null/标量：按空对象处理（ox_run 的 spec 检查接住）", async () => {
    for (const bad of [null, 42, "x"]) {
      const r = await handleMcpMessage(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ox_run", arguments: bad } },
        fakeHttp(),
      );
      expect((r!.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("spec 必须是对象");
    }
  });

  it("argNum 宽进：字符串/NaN/Infinity/null 的 tail 回默认 30", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: "log", text: `e${i}` }));
    const http = fakeHttp({ state: { status: "idle", events: many } });
    for (const bad of ["abc", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const { text } = await call("ox_events", { tail: bad as never }, http);
      expect(text).toContain("共 40 条，显示最近 30 条");
    }
  });

  it("parseState 对数组/标量 JSON 报无法解析（状态必须是对象）", async () => {
    for (const body of ["[1,2]", '"ok"', "42"]) {
      const r = await call("ox_status", {}, fakeHttp({ get: async () => ({ status: 200, body }) }));
      expect(r.isError).toBe(true);
      expect(r.text).toContain("无法解析");
    }
  });

  it("eventLine 坏形状事件：text/receipt/headline 类型不对时 JSON 截断兜底", async () => {
    const events = [
      { type: "log", text: 42 },
      { type: "receipt", receipt: "boom" },
      { type: "receipt", receipt: { headline: 7 } },
      { type: "receipt", receipt: { headline: "good headline" } },
      { type: "mystery" },
    ];
    const { text, isError } = await call("ox_events", {}, fakeHttp({ state: { status: "idle", events } }));
    expect(isError).toBe(false);
    expect(text).toContain("42");
    expect(text).toContain("boom");
    expect(text).toContain("7");
    expect(text).toContain("mystery");
    // 字符串 headline 走原文：变异（三元互换）会把它 JSON.stringify 成 {"headline":...}
    expect(text).toContain("receipt good headline");
    expect(text).not.toContain('{"headline":"good headline"}');
    // receipt:"boom"（非对象）必须落**整事件兜底行**（`{"type":"receipt"...}`），
    // 而不是把 receipt 字段单独 stringify 成 `receipt "boom"` —— 两种形状都
    // 含 "boom"，区分点在兜底行的 JSON 形态。
    expect(text).toContain('{"type":"receipt"');
  });

  it("receipt 字段为 null 不是对象：落兜底行，不进 receipt 分支", async () => {
    const { text } = await call("ox_events", {}, fakeHttp({
      state: { status: "idle", events: [{ type: "receipt", receipt: null }] },
    }));
    expect(text).toContain('{"type":"receipt"');
  });

  it("log 事件带着对象 receipt 字段也只走 log 兜底（type 是第一判据）", async () => {
    const { text } = await call("ox_events", {}, fakeHttp({
      state: { status: "idle", events: [{ type: "log", text: "plain", receipt: { headline: "h" } }] },
    }));
    expect(text).toContain("log plain");
    expect(text).not.toContain("receipt h");
  });

  it("receipt 事件带 text 字段也不走 log 分支（type 与 text 是合取，缺一不可）", async () => {
    const { text } = await call("ox_events", {}, fakeHttp({
      state: { status: "idle", events: [{ type: "receipt", text: "plain", receipt: { headline: "h" } }] },
    }));
    // receipt 形态的行以 headline 呈现，绝不能借 text 字段伪装成 log 行
    expect(text).toContain("receipt h");
    expect(text).not.toContain("log plain");
  });

  it("ox_run busy 409 的文案说『serve 忙』（拒绝通用文案不是同一个词）", async () => {
    const busy = await call("ox_run", { spec: {} }, fakeHttp({
      post: async () => ({ status: 409, body: "已经有一个 run 在跑" }),
    }));
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("serve 忙");
    expect(busy.text).not.toContain("serve 拒绝");
  });

  it("没有退出码时不显示『退出码』字样（字段即承诺，无键无文案）", async () => {
    const { text } = await call("ox_status", {}, fakeHttp());
    expect(text).not.toContain("退出码");
    const withCode = await call("ox_status", {}, fakeHttp({ state: { status: "failed", exitCode: 2 } }));
    expect(withCode.text).toContain("退出码 2");
  });

  it("ox_control 409 文案按 action 分流动词（暂停/恢复各说各的）", async () => {
    const http = fakeHttp({ post: async () => ({ status: 409, body: "no run" }) });
    const p = await call("ox_control", { action: "pause" }, http);
    expect(p.isError).toBe(true);
    expect(p.text).toContain("无法暂停");
    const r = await call("ox_control", { action: "resume" }, http);
    expect(r.text).toContain("无法恢复");
  });
});
