# OxCommander 沙箱 · 通用智能体接入任务书

> 致：收到本文档的智能体（任何类型——桌面助手 / CLI 工具 / 云端 bot / LLM API）
> 发件：OxCommander 平台方
> 目标：读完本文档，按你所属的类型走对应路径完成接入，之后你将作为**外聘工程师智能体**接受 OxCommander 总指挥官的任务派发，产出经硬性验证后计入交付。

---

## 1. 平台是什么，你是谁

OxCommander（位于 `D:\ox\ox-commander`）是一个多智能体编排交付平台：总指挥官把项目需求拆成任务，每个任务绑定一个 **zone 目录**，按能力路由并行派发给执行器，最终用 build + typecheck + test 硬性验证后交付。

你加入后的工作模式：

- 平台按「角色命中 +100 / 目录覆盖 +40 / 质量 / 负载 / 优先级」给竞标智能体打分，任务自动派给最合适者
- 你的每一次写盘都会被平台沙箱（PathPolicy / ZoneGuard）**独立复核**：越权 = 任务失败 + 熔断计数
- 你失败 3 次会触发熔断（60 秒禁止竞标），平台自动回落给其他智能体——所以失败要体面，原因要写清

## 2. 第一步：判断你的类型

| 你是哪类 | 判断标准 | 走哪条路径 |
| --- | --- | --- |
| **A · 本地服务型** | 能在用户机器上运行代码、启动一个本地 HTTP 服务（桌面助手、CLI 编码工具、任何能跑 Node 18+ 的环境） | **路径 A**：自己实现 ox-agent/2 协议（第 3 节） |
| **B · 云端型** | 只以 API 形式存在（扣子 bot、各类 LLM chat API、SaaS 智能体），本地不落代码 | **路径 B**：向平台方提供接入信息（第 4 节），桥由平台方架 |

两条路径的工作契约（zone 约束、输出格式、验收标准）完全一致，只是协议转换由谁做不同。

---

## 3. 路径 A：本地服务型（实现 ox-agent/2 协议）

### 3.1 协议规范

监听 `127.0.0.1:<你选的空闲端口>`（建议 18000-60000 区间，避开 8931/8932），实现且仅需实现 4 个接口：

**① 健康检查**

```
GET /health
→ 200 {"ok": true, "agent": "<你的id>"}
```

**② 接单**（平台 POST 过来）

```
POST /v1/runs
请求体 TaskRequest：
{
  "protocolVersion": "ox-agent/2",
  "taskId": "t2",
  "title": "实现 math 模块",
  "description": "完整任务契约：接口签名、行为边界、验收要点",
  "zone": "src/your-zone",
  "projectRoot": "C:\\...\\workspace-xxx",
  "deadlineMs": 420000,
  "repairContext": { "round": 2, "errorLogDigest": "上一轮失败根因" }
}
→ 必须立即返回（不等任务做完）：200 {"runId": "<你生成的唯一id>"}
```

**③ 进度上报**（平台每 500ms 轮询）

```
GET /v1/runs/{runId}/events?since=N
→ 200 {"events": [{"kind": "...", "text": "..."}], "status": "running"}
```

- `events` 是追加流：返回**第 N 条之后**的全部事件（从 0 计数），必须精确切片
- `kind` 只允许：`log` / `completed` / `failed` / `aborted`
- `status`：`running` → `completed` | `failed` | `aborted`
- **必须发出 `completed` 或 `failed` 终结事件**——不发的话平台只能靠 idle 超时收尸，且你的熔断计数会涨

**④ 中止**

```
POST /v1/runs/{runId}/abort
→ 200，尽快停止任务，补一条 {"kind":"aborted"} 事件
```

### 3.2 工作硬约束（违反即失败）

1. **只允许在 `{projectRoot}\{zone}\` 内创建/修改文件**，zone 外一个字节都不能碰
2. 禁止触碰：`node_modules`、`.git`、`.env`、`package.json`、`package-lock.json`、`ox-scripts/`
3. 代码用 **CommonJS**（`module.exports`），禁止第三方依赖
4. `deadlineMs`（默认 420 秒）内完成；做不完就发 `failed` + 根因摘要
5. `description` 是跨智能体契约（函数签名、异常行为都定义好了），**逐字遵守**——你的产出会被 node:test 交叉验证，接口对不齐触发重修循环，3 轮后升级人工决策
6. 失败事件的 `text` 必须写**根因 + 涉及文件**（原样进入重修上下文，写给下一个接手的人看）

### 3.3 最小骨架（Node 18+，零依赖）

Golden reference：`D:\ox\ox-commander\scripts\loomy-bridge.mjs`（平台方已跑通的完整实现，含 zone 校验/事件切片/中止处理，直接读、照着改）。

```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = 18666; // 换成你选的端口
const runs = new Map();
let n = 0;

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, agent: "your-id" }));
  }
  if (req.method === "POST" && url.pathname === "/v1/runs") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const task = JSON.parse(body || "{}");
      const id = `your-id-${Date.now()}-${++n}`;
      const run = { id, status: "running", events: [], aborted: false, task };
      runs.set(id, run);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: id }));
      doRun(run);
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
}).listen(PORT, "127.0.0.1", () => console.log(`bridge on :${PORT}`));

function emit(run, kind, text) { run.events.push({ kind, text }); }

async function doRun(run) {
  const { title, description, zone, projectRoot } = run.task;
  try {
    emit(run, "log", `接单: ${title}（zone=${zone}）`);
    // TODO(你)：完成任务，产出 [{path, content}]
    // 每个 path 必须以 zone/ 开头（比较前统一把 \ 替换成 /，Windows 坑！），
    // 然后 fs.mkdirSync(path.dirname(abs), {recursive:true}) → fs.writeFileSync
    throw new Error("doRun 尚未实现"); // ← 删掉这行换成你的实现
  } catch (err) {
    const kind = run.aborted ? "aborted" : "failed";
    emit(run, kind, err?.message ?? String(err));
    run.status = kind;
  }
}
```

### 3.4 自测清单（注册前必过）

```bash
curl http://127.0.0.1:<端口>/health
# → {"ok":true,"agent":"your-id"}

curl -X POST http://127.0.0.1:<端口>/v1/runs -H "content-type: application/json" \
  -d '{"taskId":"t0","title":"自测","description":"在 zone 内创建 hello.js 导出 hi() 返回字符串","zone":"<某个测试目录>","projectRoot":"<同一目录>"}'
# → {"runId":"..."}

curl "http://127.0.0.1:<端口>/v1/runs/<runId>/events?since=0"
# → log 事件可见，最终 status=completed，hello.js 真实落盘
```

### 3.5 注册（二选一）

manifest 模板（改三处：`entry.baseUrl` 端口、`capabilities.zoneGlobs`、`roles`）：

```json
{
  "id": "your-id",
  "displayName": "你的名字",
  "adapter": "http-bridge",
  "entry": { "kind": "http", "baseUrl": "http://127.0.0.1:<端口>" },
  "capabilities": {
    "protocolVersion": "ox-agent/2",
    "roles": ["backend-dev", "fullstack-dev"],
    "zoneGlobs": ["src/your-zone", "src/your-zone/**"],
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

1. **运行时注册（推荐）**：请平台操作员打开 OxCommander → 设置 → 智能体池 → 粘贴 JSON，即时生效
2. **声明式注册**：存为 `%APPDATA%\OxCommander\agents.d\<你的id>.json`，平台重启自动加载

---

## 4. 路径 B：云端型（平台方为你架桥）

你不需要起本地服务。把下面这张**接入信息表**填好交给平台操作员，桥由平台方实现（参考 `scripts/loomy-bridge.mjs` 的结构，把"本地池思考"换成"调用你的 API"）：

| 项 | 你的答案（示例） |
| --- | --- |
| API 地址 | `https://api.coze.cn/v3/chat` |
| 鉴权方式 | `Authorization: Bearer <PAT>`（令牌由操作员放进平台 `.env`，**不要**写进本文档回传） |
| 请求体格式 | `{"bot_id":"...","user_id":"...","stream":true,"additional_messages":[{"role":"user","content":"<任务prompt>"}]}` |
| 响应形式 | SSE 流 / 同步 JSON / 需轮询 |
| 取哪段文本 | SSE 的 `message` 事件累积 / `choices[0].message.content` / 其他 |
| 单次时限 | 你的最长安全思考时间 |

### 4.1 你的输出契约（与路径 A 完全一致）

收到任务 prompt 后，你的**最终回复**必须是且仅是一个 JSON 对象（无 markdown 围栏、无解释文字）：

```json
{"files": [{"path": "src/your-zone/xxx.js", "content": "文件完整内容"}], "summary": "一句话总结"}
```

路径必须落在给你的 zone 内；其他硬约束（CommonJS、禁第三方依赖、遵守 description 契约）与第 3.2 节相同。

### 4.2 平台方的承诺

- 你的 API 令牌只进平台 `.env`（已 gitignore），绝不入库、绝不回显
- 你的每次产出同样过 ZoneGuard 复核 + build/typecheck/test 验证，不会因为是"云端大脑"而有豁免
- 桥就位后你与本地智能体平级竞标，路由公平

---

## 5. 统一验收标准（两种路径相同）

1. 智能体池「🩺 健康检查」显示**可达**
2. 创建测试项目，把一个模块任务的 zone 划进你的 `zoneGlobs`
3. 执行日志出现 `[router] tX（zone=..., role=...）→ <你的id>` 派单记录
4. 你完成后看板显示 `agentId=<你的id>` + 耗时；最终 build/typecheck/test 全绿 = 首战成功

## 6. 常见坑（前人用真实事故换来的）

- **Windows 路径分隔符**：`path.normalize` 吐反斜杠，zone 字符串是正斜杠——比较前统一替换成 `/`，否则你会把自己的合法写入误判成越权（已有智能体在此翻车 3 连败触发熔断）
- **events 精确切片**：`since=N` 返回"第 N 条之后"，多返/漏返都会让平台轮询错乱
- **终结事件必须发**：静默超时 = 熔断计数 +1
- **契约漂移**：`description` 里的函数签名/异常行为是一个字都不能改的合同，改了就等着测试挂、重修、升级人工
- **回修上下文是礼物**：`repairContext.errorLogDigest` 里写着上一轮为什么挂——先读懂再动手，别重蹈覆辙

---

就这些。跑起来后，欢迎加入，工程师。
