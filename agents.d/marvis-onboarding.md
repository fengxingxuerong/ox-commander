# 加入 OxCommander 沙箱：Marvis 接入任务书

> 致：Marvis（Amazon）
> 发件：OxCommander 平台方
> 目标：读完本文档后，**自己动手**把一个本地 HTTP 服务跑起来，完成注册，然后就能接收 OxCommander 总指挥官派发的开发任务。

---

## 1. 你将扮演的角色

OxCommander（位于 `D:\ox\ox-commander`）是一个多智能体编排交付平台：总指挥官把项目需求拆成任务（每个任务绑定一个 zone 目录），按能力路由并行派发给执行器，最后用 build + typecheck + test 硬性验证后交付。

你将作为一个**外聘工程师智能体**加入：总指挥官会把命中你专属 zone 的任务派给你，你在沙箱约束下完成编码、写盘、汇报。平台的 PathPolicy / ZoneGuard 会**独立复核**你的每一次写盘，越权写入 = 任务失败 + 熔断计数。

## 2. 你要实现的东西：本地 HTTP 服务（ox-agent/2 协议）

监听 `127.0.0.1:18666`（端口可换，换Port后同步改 manifest），实现且仅需实现 4 个接口：

### 2.1 健康检查

```
GET /health
→ 200 {"ok": true, "agent": "marvis"}
```

### 2.2 接单

```
POST /v1/runs
请求体（TaskRequest）：
{
  "protocolVersion": "ox-agent/2",
  "taskId": "t2",
  "title": "实现 math 模块",
  "description": "实现 add/sub/mul/divide…（完整任务说明）",
  "zone": "src/marvis",
  "projectRoot": "C:\\Users\\...\\workspace-xxx",
  "deadlineMs": 420000,
  "repairContext": { "round": 2, "errorLogDigest": "上一轮失败摘要" }
}
→ 立即返回（不要等任务做完）：200 {"runId": "<你生成的唯一 id>"}
```

任务在后台异步执行。

### 2.3 进度上报（平台每 500ms 轮询一次）

```
GET /v1/runs/{runId}/events?since=N
→ 200 {"events": [{"kind": "...", "text": "..."}], "status": "running"}
```

- `events` 是**追加流**：返回第 N 条之后的全部事件（从 0 计数），务必精确切片
- `kind` 只允许四种：`log`（过程日志） / `completed`（成功终结） / `failed`（失败终结） / `aborted`
- `status`：`running` → `completed` | `failed` | `aborted`（终态后不再追加事件）
- **必须发出 `completed` 或 `failed` 终结事件**：不发的话平台会按 idle 超时判你失败并熔断

### 2.4 中止

```
POST /v1/runs/{runId}/abort
→ 200，尽快停止该任务，补一条 {"kind":"aborted"} 事件
```

## 3. 干活规则（硬约束，违反即失败）

1. **只允许在 `{projectRoot}\{zone}\` 目录内创建/修改文件**。zone 之外一个字节都不能碰——平台会复核，越权直接判 conflict。
2. 禁止触碰：`node_modules`、`.git`、`.env`、`package.json`、`package-lock.json`、`ox-scripts/`。
3. 代码用 **CommonJS**（`module.exports`），禁止第三方依赖。
4. 在 `deadlineMs`（默认 420 秒）内完成；做不完就发 `failed` 并附原因摘要，别硬扛。
5. `description` 是完整任务契约（含接口签名与边界条件），**严格按契约实现**——你的产出会被 node:test 用例交叉验证，接口对不齐会触发重修循环，重修超过 3 轮整个项目会升级人工决策。
6. 事件 `text` 写有信息量的中文摘要；失败时把**根因 + 涉及文件**写清楚（这段文字会原样进入重修上下文）。

## 4. 干活方式建议

收到 TaskRequest 后：理解 `title` + `description` → 用你自己的内置能力完成编码（不需要再调用外部 LLM）→ 把每个产出文件写进 `{projectRoot}\{zone}\` → 逐文件发 `log` 事件 → 发 `completed` + 一句话总结。

 Golden reference：`D:\ox\ox-commander\scripts\loomy-bridge.mjs` 是平台方已经跑通的同协议参考实现（含 zone 校验、事件切片、中止处理的完整写法），直接读它、照着改。

最小骨架（Node 18+，零依赖，可直接扩展）：

```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = 18666;
const runs = new Map();
let n = 0;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, agent: "marvis" }));
  }
  if (req.method === "POST" && url.pathname === "/v1/runs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const task = JSON.parse(body || "{}");
      const id = `marvis-${Date.now()}-${++n}`;
      const run = { id, status: "running", events: [], aborted: false, task };
      runs.set(id, run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: id }));
      doRun(run); // ← 你的干活逻辑：完成 title/description，把文件写进 task.zone
    });
    return;
  }
  const m = url.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/abort)?$/);
  const run = m && runs.get(decodeURIComponent(m[1]));
  if (!run) { res.writeHead(404); return res.end("{}"); }
  if (req.method === "GET" && m[2] === "/events") {
    const since = Number(url.searchParams.get("since") ?? 0);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ events: run.events.slice(since), status: run.status }));
  }
  if (req.method === "POST" && m[2] === "/abort") {
    run.aborted = true; run.events.push({ kind: "aborted", text: "收到中止" });
    run.status = "aborted"; res.writeHead(200); return res.end("ok");
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`marvis bridge on :${PORT}`));

function emit(run, kind, text) { run.events.push({ kind, text }); }

async function doRun(run) {
  const { title, description, zone, projectRoot } = run.task;
  try {
    emit(run, "log", `接单: ${title}（zone=${zone}）`);
    // TODO(Marvis)：在这里用你的能力完成任务，产出文件列表 [{path, content}]
    // 每个文件：校验 path 以 zone/ 开头 → fs.mkdirSync(dirname,{recursive:true}) → writeFileSync
    // 全部写完 → emit(run,"completed", 总结)；任何失败 → emit(run,"failed", 根因+涉及文件)
    throw new Error("doRun 尚未实现"); // 删掉这行，换成你的实现
  } catch (err) {
    const kind = run.aborted ? "aborted" : "failed";
    emit(run, kind, err?.message ?? String(err));
    run.status = kind;
  }
}
```

## 5. 自测清单（注册前先跑一遍）

```bash
curl http://127.0.0.1:18666/health
# → {"ok":true,"agent":"marvis"}

curl -X POST http://127.0.0.1:18666/v1/runs -H "content-type: application/json" \
  -d '{"taskId":"t0","title":"自测","description":"在 zone 内创建 hello.js 导出 hi()","zone":"C:/tmp/marvis-test","projectRoot":"C:/tmp/marvis-test"}'
# → {"runId":"..."}

curl "http://127.0.0.1:18666/v1/runs/<上面拿到的runId>/events?since=0"
# → 能看到 log 事件，最终 status=completed
```

## 6. 注册（二选一）

把下面的 manifest（按实际情况改 `baseUrl` 端口 / `zoneGlobs` / `roles`）：

1. **运行时注册（推荐）**：请平台操作员打开 OxCommander → 设置 → 智能体池 → 粘贴 JSON，即时生效。
2. **声明式注册**：存为 `%APPDATA%\OxCommander\agents.d\marvis.json`，平台重启自动加载。

```json
{
  "id": "marvis",
  "displayName": "Marvis（Amazon）",
  "adapter": "http-bridge",
  "entry": {
    "kind": "http",
    "baseUrl": "http://127.0.0.1:18666",
    "healthPath": "/health",
    "runsPath": "/v1/runs",
    "pollMs": 500
  },
  "capabilities": {
    "protocolVersion": "ox-agent/2",
    "roles": ["backend-dev", "fullstack-dev"],
    "zoneGlobs": ["src/marvis", "src/marvis/**"],
    "supports": ["read", "edit", "create"],
    "artifactKinds": ["files"],
    "maxConcurrency": 1,
    "selfIsolated": false
  },
  "credential": { "kind": "none" },
  "limits": { "runDeadlineMs": 420000, "idleTimeoutMs": 120000, "maxStdoutBytes": 2097152 },
  "priority": 40,
  "enabled": true
}
```

## 7. 首战验收

1. 平台操作员在智能体池点「🩺 健康检查」→ 你显示「**可达**」
2. 创建一个测试项目，把其中一个模块的任务 zone 划进你的 `zoneGlobs`
3. 看板执行日志里应出现 `[router] tX（zone=src/marvis, …）→ marvis` 的派单记录
4. 你完成后，看板任务行会显示 `agentId=marvis` 与耗时；最终 build/typecheck/test 全绿 = 首战成功

## 8. 常见坑（前人踩过的）

- **Windows 路径分隔符**：`path.normalize` 会产生反斜杠，而 zone 字符串是正斜杠——比较前统一替换成 `/`，否则你会把自己的合法写入误判成越权
- **events 精确切片**：`since=N` 必须返回"第 N 条之后"，多返/少返都会让平台轮询错乱
- **终结事件必须发**：没发 `completed`/`failed` 平台只能靠 idle 超时收尸，且你的熔断计数会涨
- **契约漂移**：`description` 里的函数签名、异常行为是跨智能体契约，一个字段对不齐，测试就挂，重修 3 轮后升级人工

——就这些。跑起来之后，欢迎加入，工程师。
