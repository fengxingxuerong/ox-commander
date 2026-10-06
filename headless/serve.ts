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
  /**
   * 当前 run 是否被暂停（P1-5）：只在暂停期间为 true，恢复后**键消失**
   * （字段即承诺 —— "没有这个键"就是"没暂停"，不给宿主第三种状态可读）。
   */
  paused?: boolean;
  /**
   * 等待人工审批的请求（P2-3）：`approvalCommands` 命中的命令执行前挂在这，
   * `POST /approve` 作答后出队。无 pending 时**键消失**（字段即承诺）——
   * 状态页/MCP 客户端据此知道"此刻没有人等审批"。
   */
  pendingApprovals?: Array<{ requestId: string; command: string; args: string[] }>;
  /**
   * 当前 run 已被要求中止（2026-10-05 横向比对补齐）。
   *
   * 与 `paused` 同样"键消失即承诺"：run 收尾后键被删掉，所以这个字段只表示
   * "中止已被受理"，**不表示引擎已经停了** —— 中止同样只在引擎的下一个检查点
   * 生效（正在跑的那一批任务不会被掐断）。状态页因此只说"已请求中止"。
   */
  cancelled?: boolean;
}

/**
 * 宿主能递给引擎的控制面；`startServe` 只转发，不解释语义。
 *
 * `cancel` 是可选的：桌面形态的 run 会递一个带 cancel 的引擎，而只测引擎逻辑的
 * 宿主可能只给 pause/resume。缺 cancel 时 `/cancel` 返回 501 而不是假装成功 ——
 * 见 `ServeState.cancellable`。
 */
export interface EngineControl {
  pause(): void;
  resume(): void;
  /** 缺失 = 这个引擎不支持中止（`OrchestratorEngine` 有，但注入的替身可能没有）。 */
  cancel?: () => void;
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
  else if (evt.type === "approval-request") {
    state.pendingApprovals = [
      ...(state.pendingApprovals ?? []),
      { requestId: evt.requestId, command: evt.command, args: evt.args },
    ];
  }
  return evt;
}

/** 审批请求的答复路径（P2-3）：出队并返回被移除的请求；无此请求时返回 undefined。 */
export function resolvePendingApproval(
  state: ServeState,
  requestId: string,
): { requestId: string; command: string; args: string[] } | undefined {
  const pending = state.pendingApprovals ?? [];
  const found = pending.find((p) => p.requestId === requestId);
  if (!found) return undefined;
  const rest = pending.filter((p) => p.requestId !== requestId);
  if (rest.length === 0) delete state.pendingApprovals; // 字段即承诺：清空后键消失
  else state.pendingApprovals = rest;
  return found;
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
  /** 控制面指令：由调用方转给引擎（纯路由不做副作用）。 */
  control?: "pause" | "resume" | "cancel";
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
  // 控制面（P1-5）：暂停/继续/中止只能 POST，GET 要拿到 405 而不是被当成状态查询。
  //
  // ⚠️ `/cancel` 与桌面形态的 `orchestration:cancel` 对齐（2026-10-05 横向比对发现）：
  // 桌面有中止而 serve 没有，于是**一个卡在等审批上的 run 在 serve 形态下无法脱困**
  // —— pause/resume 都答"没有 run 在跑"（引擎还没跑起来），后续 /run 又被 busy 挡住。
  if (path === "/pause" || path === "/resume" || path === "/cancel") {
    if (method !== "POST") return { status: 405, headers: {}, body: `use POST ${path}` };
    const control = path === "/pause" ? "pause" : path === "/resume" ? "resume" : "cancel";
    return { status: 200, headers: {}, body: "", control };
  }
  return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "not found" };
}

/**
 * 状态标签。
 *
 * ⚠️ **`failed` 必须再分一层**（2026-10-05 状态标签审计）。
 *
 * 旧写法把两种完全不同的结局印成同一句 `未交付 / 出错`：
 *   · `done(passed=false)` —— **跑完了**，代码也在，只是门禁没过（最普通的一种红）；
 *   · `error` —— **崩了**，可能连凭据都没产出。
 *
 * 实测真实 run 的第一种形状：
 *
 *   status=failed  outcome=blocked  rounds=1
 *   tasks 1/1 完成，仅验证命令未通过
 *   页面顶上印的是：「未交付 / 出错」
 *
 * 读者据此会去找**崩溃日志**，而实际上一切正常跑完了、该看的是验证输出。
 * 更糟的是它把"引擎崩了"这件事**藏了起来** —— 真崩时同样只印这句，
 * 两边都看不出差别。
 *
 * 有凭据 = 引擎走完了正常的收尾流程（`receipt` 事件先于终态到达）；
 * 无凭据 = 崩在中途，只能看 `error` 事件。凭据本身就是判据。
 */
function statusLabel(state: ServeState): string {
  if (state.status !== "failed") return STATUS_LABEL[state.status];
  return state.receipt ? STATUS_LABEL.failed_ran : STATUS_LABEL.failed_crashed;
}

const STATUS_LABEL = {
  idle: "空闲",
  running: "运行中",
  delivered: "已交付",
  /** 跑完了但没通过门禁 —— 该去看验证输出，不是去找崩溃日志。 */
  failed_ran: "未交付（已跑完，门禁未过）",
  /** 中途崩了 —— 该去看 error 事件。 */
  failed_crashed: "出错（中途异常终止）",
} as const;

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
  const pauseNote = state.paused
    ? `<p class=muted>已暂停：当前任务跑完就停，不再派新的（POST /resume 继续）。</p>`
    : "";
  // 中止与暂停**不是一回事**，措辞必须区分开：
  //  · 暂停 = 可恢复，正在跑的那一批照常跑完；
  //  · 中止 = 不可恢复，正在跑的那一批**不会**被掐断，它只在自己的检查点退出。
  // 所以这里写"已请求中止"而不是"已中止"——后者是引擎真正停下来才配得上的一句话。
  const cancelNote = state.cancelled
    ? `<p class=muted>已请求中止：正在跑的任务不会被掐断，它跑完后引擎在下一个检查点退出。</p>`
    : "";
  const approvals =
    state.pendingApprovals && state.pendingApprovals.length > 0
      ? `<h2>等待人工审批（${state.pendingApprovals.length} 条）</h2><ul class=approvals>${state.pendingApprovals
          .map(
            (p) =>
              `<li><code>${esc(p.command)} ${esc(p.args.join(" "))}</code>` +
              ` · <button onclick="settle('${p.requestId}', true)">批准</button>` +
              ` <button onclick="settle('${p.requestId}', false)">拒绝</button></li>`,
          )
          .join("")}</ul>`
      : "";
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
<h1>OxCommander · ${statusLabel(state)}</h1>
${pauseNote}
      ${cancelNote}
${approvals}
<p class=muted>状态 ${esc(state.status)}${
    state.exitCode !== undefined ? ` · 退出码 ${state.exitCode}` : ""
  }${state.updatedAt ? ` · ${esc(state.updatedAt)}` : ""} · 共 ${state.events.length} 条事件</p>
${receipt}
<h2>最近事件</h2>
<ul class=events>${rows}</ul>
<script>
// 只在页面活着时追加新事件：整页刷新会重新拉一份完整状态，不需要两套逻辑。
const es = new EventSource("/events");
// **按 class 选，不按标签选**（2026-10-05 修）：页面上有两个 ul ——
// 审批列表（有审批时才渲染）与事件列表。querySelector("ul") 取的是**第一个**，
// 于是"有审批在等"时新事件被追加进审批列表，跟批准/拒绝按钮混在一起
// （jsdom 复现：事件跑到了 approvals 的 ul 里）。这页存在的理由是
// "离开工位也能看一眼"，事件流落在别人的列表里正是它最不该出的错。
const ul = document.querySelector("ul.events");
es.onmessage = (m) => {
  const e = JSON.parse(m.data);
  const li = document.createElement("li");
  const text = e.type === "log" ? e.text : e.type === "receipt" ? e.receipt.headline : JSON.stringify(e).slice(0, 400);
  li.innerHTML = "<b></b> ";
  li.querySelector("b").textContent = e.type;
  li.appendChild(document.createTextNode(" " + text));
  ul.appendChild(li);
};
async function settle(id, granted) {
  await fetch("/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: id, granted }) });
  location.reload();
}
async function cancelRun() {
  await fetch("/cancel", { method: "POST" });
  location.reload();
}
</script>
`;
}

export interface ServeServer {
  port: number;
  close(): Promise<void>;
  state: ServeState;
  /**
   * 审批询问器（P2-3）：宿主（serve-main）把它交给 runSpec 的
   * `host.requestApproval` —— 命令命中 `approvalCommands` 时，它广播
   * `approval-request` 事件并 park；`POST /approve` 作答后 resolve。
   * 无人作答 = 永不 resolve（fail-closed 的上游：ApprovalGate 在宿主回调
   * 缺席时按拒绝处理，这里 promise 挂着不算拒绝，关闭服务时按拒绝收尾）。
   */
  approvalRequester: (command: string, args: readonly string[]) => Promise<boolean>;
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
  /**
   * Pre-flight spec validation, run **before** the 202 is written.
   *
   * ⚠️ Why this exists: without it, `POST /run` only checked that the body was
   * syntactically JSON and answered `202 {"accepted":true}` to *any* object —
   * a spec missing `requirement`/`projectRoot`, or carrying an invalid enum,
   * was "accepted" and then failed silently inside the run. A CI integration
   * watching for 202 would read that as "queued" while `/state` had already
   * flipped to `failed` with no exit code (measured 2026-10-05).
   *
   * Returning a message makes the endpoint answer `400` with the same
   * aggregated text the CLI entrypoint prints — one validation, two hosts.
   * Optional so tests can inject a permissive stub.
   */
  validate?: (payload: unknown) => string | undefined;
  run: (
    payload: unknown,
    emit: (e: HeadlessEvent) => void,
    /** run 把自己的引擎交给服务，服务才能转发暂停/继续（P1-5）。 */
    control?: (engine: EngineControl) => void,
  ) => Promise<number>;
}): Promise<ServeServer> {
  const state = createServeState();
  const clients = new Set<http.ServerResponse>();
  const now = opts.now;
  /** 一次只跑一个 run：第二个 POST 拿 409，而不是悄悄排队。 */
  let busy = false;
  /** 当前 run 的引擎控制面；没有 run 在跑时为 undefined。 */
  let engine: EngineControl | undefined;
  /** 等待人工审批的 resolver（P2-3）：requestId -> 是否放行。 */
  const pendingResolvers = new Map<string, (granted: boolean) => void>();
  let approvalSeq = 0;

  const broadcast = (evt: HeadlessEvent): void => {
    serveEmit(state, evt, now);
    const frame = sseFrame(evt, state.events.length - 1);
    for (const res of clients) res.write(frame);
  };

  const approvalRequester = (command: string, args: readonly string[]): Promise<boolean> => {
    const requestId = `a-${(approvalSeq += 1)}-${Date.now().toString(36)}`;
    return new Promise<boolean>((resolve) => {
      pendingResolvers.set(requestId, resolve);
      broadcast({ type: "approval-request", requestId, command, args: [...args] });
    });
  };

  /** 从 pendingResolvers 里移除并 resolve；不存在时返回 false（调用方报 404）。 */
  const settleApproval = (requestId: string, granted: boolean): boolean => {
    const resolve = pendingResolvers.get(requestId);
    if (!resolve) return false;
    pendingResolvers.delete(requestId);
    resolvePendingApproval(state, requestId); // 同步状态队列（键消失即无 pending）
    resolve(granted);
    return true;
  };

  /**
   * 把挂着的审批**一律 fail-closed 放掉**，返回放掉了几条。
   *
   * 这正是桌面 `orchestration:cancel` 里 `abortAllApprovals()` 的那条纪律 ——
   * 中止之后不会再有人来回答，而"没人回答"绝不能读成"批准"（`ApprovalGate`
   * 的 fail-closed 就是为这件事存在的）。所以这里一律 resolve(false)，
   * 不是 resolve(true)，也不是把 Promise 晾着不管。
   *
   * 晾着不管 = run 永远停在 await 上、busy 永远 true、后续 /run 全部 409 ——
   * 那正是 2026-10-05 之前 serve 形态的实际处境。
   */
  const releaseAllApprovals = (): number => {
    const waiting = [...pendingResolvers.keys()];
    for (const requestId of waiting) settleApproval(requestId, false);
    return waiting.length;
  };

  /**
   * 没有引擎时的中止：放掉挂着的审批并如实汇报。
   *
   * ⚠️ 这条路径**同样必须放审批**。第一版我以为"卡在审批里说明引擎还没挂上"，
   * 实测那个前提是错的 —— `onEngine` 在规划前就调用了（`run-spec.ts:312`），
   * 审批发生在更后面的执行阶段。所以现在两条路径都调 `releaseAllApprovals()`。
   */
  const cancelWithoutEngine = (res: http.ServerResponse): void => {
    const released = releaseAllApprovals();
    state.cancelled = true;
    delete state.paused;
    state.updatedAt = (now ?? (() => new Date().toISOString()))();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ paused: false, cancelled: true, releasedApprovals: released }));
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
        // 语法合法 ≠ spec 合法：缺 `requirement` / `projectRoot`、枚举写错之类
        // 的问题必须在这一层就变成 400，而不是先回 202 再悄悄跑失败
        // （见 startServe 的 `validate` 注释）。
        const problem = opts.validate?.(payload);
        if (problem) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(problem);
          return;
        }
        busy = true;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        void opts
          .run(payload, broadcast, (e) => {
            engine = e;
          })
          .then((code) => serveFinish(state, code, now))
          .finally(() => {
            busy = false;
            engine = undefined;
            // 跑完了就没有"暂停中""已请求中止"这回事：键必须消失，
            // 否则状态页会一直显示暂停/中止（serve.ts 原注释已为 paused 说明过理由）。
            delete state.paused;
            delete state.cancelled;
          });
      });
      return;
    }

    // 审批答复（P2-3）：POST /approve，body { requestId, granted }。
    if (url === "/approve" && method === "POST") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        let body: { requestId?: unknown; granted?: unknown };
        try {
          body = JSON.parse(raw) as { requestId?: unknown; granted?: unknown };
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("body 不是合法 JSON");
          return;
        }
        const requestId = typeof body.requestId === "string" ? body.requestId : "";
        const granted = body.granted === true;
        if (requestId === "") {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("缺少 requestId");
          return;
        }
        if (!settleApproval(requestId, granted)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`没有等待中的审批请求：${requestId}`);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ settled: true, granted }));
      });
      return;
    }

    const routed = routeRequest(state, method, url);
    if (routed.control) {
      // 没有 run 在跑时暂停/继续无从谈起 —— 409，并把原因写进响应体。
      //
      // ⚠️ `/cancel` 是例外，但判据必须是 **`busy` 而不是 `engine`**：
      // 卡在等审批上的 run 引擎还没挂上（`engine` 为 undefined），它确实在跑，
      // 而且正是最需要中止的那种 —— 按 engine 判会把它挡在 409 外面，
      // 于是"审批没人答 → run 永远出不来"。
      // 反过来按 engine 判也不对：从来没跑过任何 run 时 engine 永远是 undefined，
      // 那样 `/cancel` 会报 200 "已中止"，而它什么都没中止（只是给空表做了遍循环）。
      // busy 才是"此刻确有一个 run 在跑"的事实。
      if (!busy && !engine) {
        res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("当前没有 run 在跑，暂停/继续/中止无从谈起");
        return;
      }
      if (!engine) {
        if (routed.control === "cancel") return cancelWithoutEngine(res);
        // busy 为真但引擎还没挂上（正卡在规划/审批阶段）：暂停与继续此刻无法生效，
        // 说清楚比假装成功好。
        res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("run 还在准备中（尚未挂上引擎），暂停/继续暂不可用；需要中止请用 POST /cancel");
        return;
      }
      if (routed.control === "cancel") {
        // 引擎不支持中止（如只注入 pause/resume 的替身）→ 501，不假装成功。
        if (!engine.cancel) {
          res.writeHead(501, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("当前引擎不支持中止");
          return;
        }
        engine.cancel();
        // ⚠️ **必须连挂着的审批一起放掉**，哪怕引擎已经挂上了。
        // 这是 2026-10-05 修 bug 时自己踩的第二坑：第一版只在"没有 engine"那条
        // 路上放审批，理由是"卡在审批里说明引擎还没挂上" —— 实测**那个前提是错的**，
        // `onEngine` 在规划前就被调用（run-spec.ts:312），审批发生在更后面的执行阶段，
        // 于是引擎早就挂上了、走的正是这条分支、审批一个都没放 —— 死锁原封不动。
        // `engine.cancel()` 只让引擎在检查点退出，**不会**去解审批的 Promise。
        // 桌面那条纪律是对的：`orchestration:cancel` 里 cancel/abortEscalations/
        // abortApprovals 三件事**并列**，少一件就解不开。
        const released = releaseAllApprovals();
        state.cancelled = true;
        // 暂停中再中止：状态不该还留着"已暂停"（引擎已经在停，暂停标记会误导）
        delete state.paused;
        state.updatedAt = (now ?? (() => new Date().toISOString()))();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            paused: false,
            cancelled: true,
            releasedApprovals: released,
          }),
        );
        return;
      } else if (routed.control === "pause") {
        engine.pause();
        state.paused = true;
      } else {
        engine.resume();
        delete state.paused;
      }
      state.updatedAt = (now ?? (() => new Date().toISOString()))();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ paused: state.paused === true, cancelled: state.cancelled === true }),
      );
      return;
    }
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
        approvalRequester,
        close: () =>
          new Promise<void>((done) => {
            // 关服 = 不再可能有人回答：把还挂着的审批按拒绝收尾（fail-closed
            // 的最后一环 —— 不 resolve 的话 run 会永远等下去）。
            for (const [requestId, resolve] of pendingResolvers) {
              pendingResolvers.delete(requestId);
              resolvePendingApproval(state, requestId);
              resolve(false);
            }
            for (const res of clients) res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
