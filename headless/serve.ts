import * as http from "node:http";
import type { DeliveryReceipt } from "../shared/delivery-receipt";
import type { HeadlessEvent } from "./protocol";

/**
 * headless 的第二种宿主形态：**常驻 HTTP 服务**（`orca serve` 那一格）。
 *
 * 为什么要有它：JSONL 那条入口是"一次 spec 进、一串事件出、一个退出码结束"，
 * 它适合 CI，不适合人 —— 一次 run 动辄几分钟到几十分钟，而唯一能看它的地方
 * 是那个把它 spawn 出来的终端。实测 15 个同类项目里，缺"离开工位也能看"这一格的
 * 只有我们（Orca 有桌面 + 手机伴生 + SSH worktree）。这是**唯一的空白格**。
 *
 * 刻意不做的事：
 *   · 不做鉴权 —— 这是本机/CI 侧的调试与观察面，不是要暴露到公网的服务。
 *     要远程就走 SSH 隧道，别在这里发明一套登录；
 *   · 不做任务队列 —— 一次只跑一个 run，第二个 POST 拿 409。并发编排是引擎
 *     内部的事（批次与并发闸），这里重复做一层只会让"到底哪个在跑"变成猜谜；
 *   · 不内嵌完整 React 看板 —— 那需要把 renderer 的构建产物塞进来，体积与
 *     构建链都不是这个入口该背的。这里给一页自包含 HTML：能看状态、能看凭据。
 *
 * 纯逻辑（状态派生 / SSE 帧 / 路由 / 页面）与 IO（`startServe`）分开，
 * 前半部分进变异门禁。
 */
export type ServeStatus = "idle" | "running" | "delivered" | "failed";

export interface ServeState {
  status: ServeStatus;
  /** 全部已广播的事件（后连上的客户端靠它补全，所以刻意不做上限）。 */
  events: HeadlessEvent[];
  /** 最近一次 run 的退出码；还没跑过时缺席（字段即承诺）。 */
  exitCode?: number;
  /** 最近一份交付凭据。 */
  receipt?: DeliveryReceipt;
  /** 最近一次状态变化的时间（ISO）。 */
  updatedAt?: string;
}

export interface ServeOptions {
  /** 注入时钟：测试要能钉住 `updatedAt`，不然每次都不同。 */
  now?: () => string;
}

export function createServeState(): ServeState {
  return { status: "idle", events: [] };
}

/**
 * 记一条事件并派生状态。
 *
 * 派生的依据是**终态事件**（`done` / `error`），不是"收到 receipt 就算交付"：
 * 凭据只在两条出口上发，但一次崩溃也会留下半截事件流 —— 只有终态能区分
 * "跑完了"和"跑挂了"。返回收到的同一条事件，方便调用方链式转发。
 */
export function serveEmit(state: ServeState, evt: HeadlessEvent, now?: () => string): HeadlessEvent {
  state.events.push(evt);
  state.updatedAt = (now ?? (() => new Date().toISOString()))();
  if (evt.type === "hello") state.status = "running";
  else if (evt.type === "done") state.status = evt.passed ? "delivered" : "failed";
  else if (evt.type === "error") state.status = "failed";
  else if (evt.type === "receipt") state.receipt = evt.receipt;
  return evt;
}

/** 记下退出码：退出码是 CLI 契约的一部分，服务形态也得能读到。 */
export function serveFinish(state: ServeState, code: number, now?: () => string): void {
  state.exitCode = code;
  state.updatedAt = (now ?? (() => new Date().toISOString()))();
}

/** SSE 一帧。`id` 用序号，客户端断线重连时能带 `Last-Event-ID` 续上。 */
export function sseFrame(evt: HeadlessEvent, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(evt)}\n\n`;
}

export interface Routed {
  status: number;
  /** 响应头（Content-Type 等）。 */
  headers: Record<string, string>;
  body: string;
  /** SSE 流需要拿走 socket，不能走普通响应 —— 由调用方单独处理。 */
  stream?: "events";
}

/**
 * 纯路由：方法 + 路径 → 响应。
 *
 * 与 IO 分开的理由和本模块其他部分一样：路由判据错了（404 写成 200、
 * POST 被当 GET）是静默的，只有逐位点审才抓得到。
 */
export function routeRequest(state: ServeState, method: string, path: string): Routed {
  if (path === "/" || path === "/index.html") {
    return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: serveIndexHtml(state) };
  }
  if (path === "/state") {
    return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) };
  }
  if (path === "/events") {
    if (method !== "GET") return { status: 405, headers: {}, body: "use GET" };
    return { status: 200, headers: { "Content-Type": "text/event-stream" }, body: "", stream: "events" };
  }
  if (path === "/run") return { status: 405, headers: {}, body: "POST a spec to /run" };
  return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "not found" };
}

const STATUS_LABEL: Record<ServeStatus, string> = {
  idle: "空闲",
  running: "运行中",
  delivered: "已交付",
  failed: "未交付 / 出错",
};

/**
 * 一页自包含 HTML（无外链、无构建）：状态 + 凭据 + 尾部事件。
 *
 * 它替代的不是桌面看板，是"去倒杯咖啡回来还能看一眼"那件事 —— 所以刻意
 * 只放结论（状态、凭据 headline、最近事件），不放需要交互的东西。
 */
export function serveIndexHtml(state: ServeState): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tail = state.events.slice(-30);
  const rows = tail
    .map((e) => {
      const text =
        e.type === "log"
          ? e.text
          : e.type === "receipt"
            ? e.receipt.headline
            : JSON.stringify(e).slice(0, 400);
      return `<li><b>${esc(e.type)}</b> ${esc(text)}</li>`;
    })
    .join("\n");
  const receipt = state.receipt
    ? `<h2>交付凭据</h2><p>${esc(state.receipt.headline)}</p>
       <pre>${esc(JSON.stringify(state.receipt, null, 2))}</pre>`
    : "<p class=muted>还没有凭据（只在交付成功 / 重修耗尽两条出口上产生）。</p>";
  return `<!doctype html>
<meta charset="utf-8">
<title>OxCommander · 运行状态</title>
<style>
body{font:14px/1.6 system-ui;margin:24px;max-width:960px}
h1{margin:0 0 4px}.muted{color:#888}
pre{background:#f6f8fa;padding:12px;overflow:auto}
li{white-space:pre-wrap;word-break:break-word}
</style>
<h1>OxCommander · ${STATUS_LABEL[state.status]}</h1>
<p class=muted>状态 ${esc(state.status)}${
    state.exitCode !== undefined ? ` · 退出码 ${state.exitCode}` : ""
  }${state.updatedAt ? ` · ${esc(state.updatedAt)}` : ""} · 共 ${state.events.length} 条事件</p>
${receipt}
<h2>最近事件</h2>
<ul>${rows}</ul>
<script>
// 只在页面活着时追加新事件：整页刷新会重新拉一份完整状态，不需要两套逻辑。
const es = new EventSource("/events");
const ul = document.querySelector("ul");
es.onmessage = (m) => {
  const e = JSON.parse(m.data);
  const li = document.createElement("li");
  const text = e.type === "log" ? e.text : e.type === "receipt" ? e.receipt.headline : JSON.stringify(e).slice(0, 400);
  li.innerHTML = "<b></b> ";
  li.querySelector("b").textContent = e.type;
  li.appendChild(document.createTextNode(" " + text));
  ul.appendChild(li);
};
</script>
`;
}

export interface ServeServer {
  port: number;
  close(): Promise<void>;
  state: ServeState;
}

/**
 * 起一个 HTTP 服务。
 *
 * `run` 由调用方注入（真入口传 `runSpec`，测试传假件）：本模块刻意不知道
 * 怎么跑一次 run，知道的是"事件怎么广播、状态怎么回答"。
 */
export function startServe(opts: {
  port?: number;
  now?: () => string;
  run: (payload: unknown, emit: (e: HeadlessEvent) => void) => Promise<number>;
}): Promise<ServeServer> {
  const state = createServeState();
  const clients = new Set<http.ServerResponse>();
  const now = opts.now;
  /** 一次只跑一个 run：第二个 POST 拿 409，而不是悄悄排队。 */
  let busy = false;

  const broadcast = (evt: HeadlessEvent): void => {
    serveEmit(state, evt, now);
    const frame = sseFrame(evt, state.events.length - 1);
    for (const res of clients) res.write(frame);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    if (url === "/run" && method === "POST") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        // 正在跑就拒绝，并且把原因写进响应体 —— 409 一个数字说不清"为什么不行"。
        if (busy) {
          res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("已经有一个 run 在跑；本服务一次只跑一个（并发编排在引擎内部）");
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("body 不是合法 JSON");
          return;
        }
        busy = true;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        void opts
          .run(payload, broadcast)
          .then((code) => serveFinish(state, code, now))
          .finally(() => {
            busy = false;
          });
      });
      return;
    }

    const routed = routeRequest(state, method, url);
    if (routed.stream === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // 先把历史事件补齐：后连上的客户端不该只看到半截。
      for (const [i, evt] of state.events.entries()) res.write(sseFrame(evt, i));
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(routed.status, routed.headers);
    res.end(routed.body);
  });

  return new Promise((resolve) => {
    // 端口 0 = 让系统分配，测试因此不会撞上固定端口（项目 smoke 的固定端口
    // 被占是历史上偶发红的根因之一）。
    server.listen(opts.port ?? 0, () => {
      const addr = server.address();
      const port = (typeof addr === "object" ? addr?.port : undefined) ?? 0;
      resolve({
        port,
        state,
        close: () =>
          new Promise<void>((done) => {
            for (const res of clients) res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
