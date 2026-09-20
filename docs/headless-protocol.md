# OxCommander Headless 协议 `ox-headless/1`

给外部宿主（DSH、CI、其他 agent）用的无 UI 驱动接口。宿主把一份 JSON 从 stdin 递进来，
OxCommander 把执行过程以 JSONL 事件流从 stdout 吐出去。

```
echo '<spec-json>' | node dist-headless/headless/headless-main.js
```

- **stdin**：完整读入后按 JSON 解析成 spec（一个对象）。
- **stdout**：每行一个 JSON 对象（JSONL）。除事件流外不输出任何内容。
- **stderr**：保留给 Node 自身的告警，宿主可忽略。
- **退出码**：`0` 交付成功 / `2` 重修预算耗尽 / `1` 致命错误（输入非法、LLM 不可用等）。

> 实现分层：`headless/protocol.ts` 是**契约**（校验 + 默认值，纯函数），
> `headless/run-spec.ts` 是**执行**（可注入假件、可测），`headless-main.ts` 只是 stdin/stdout 胶水。

---

## 1. spec 字段表

除 `requirement` / `projectRoot` 外**每个字段都有默认值**。未知字段只产生 warning，不报错。

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `requirement` | string | ✅ | — | 自然语言需求。提供 `prd` 时仍必填（用于日志/回显） |
| `projectRoot` | string | ✅ | — | 目标项目根目录；相对路径按 runner 的 cwd 解析 |
| `protocolVersion` | string | | `ox-headless/1` | 宿主声明自己按哪个版本写的，会在 `hello` 事件里回显 |
| `prd` | object | | — | 已确认的 PRD（`goal` / `features` / `techStack` / `acceptanceCriteria`）；提供则跳过 PRD 生成阶段 |
| `llmProvider` | string | | `sensenova` | 大脑层 provider，取值见 `shared/providers.ts` |
| `maxRepairRounds` | number ≥ 0 | | `3` | 重修轮上限 |
| `verificationCommands` | array | | npm build/typecheck/test | `[{kind: "build"\|"typecheck"\|"test", command, args}]` |
| `escalationPolicy` | enum | | `abort` | 见 §3 |
| `agents` | array | | `[]` | 额外智能体声明（`cli` / `http-bridge`），schema 同 `agents.d/*.json` |
| `manifestDir` | string | | — | 扫描 `*.json` 智能体声明的目录 |
| `agentRouter` | boolean | | `true` | 关闭后退回轮询分发 |
| `snapshotRoot` | string | | `<tmp>/ox-commander-snapshots` | 回滚用的内容备份目录。**建议放在项目之外**（放项目内会被判定为 zone 外改动） |
| `arbitration` | enum | | `revert-batch` | zone 越权处置：`report-only` / `deny-all` / `revert-batch` / `quarantine` |
| `maxParallelRuns` | number ≥ 0 | | `4` | 平台级并发上限；`0` 表示不限 |

参数错误会**一次性列出所有问题**（不半途退出），例如：

```json
{"type":"error","message":"requirement 必须是非空字符串；maxRepairRounds 必须是不小于 0 的数字；arbitration 必须是 report-only / deny-all / revert-batch / quarantine"}
```

## 2. 事件表

| type | 载荷 | 何时 |
| --- | --- | --- |
| `hello` | `protocolVersion, projectRoot, llmProvider, arbitration, agentRouter, warnings[]` | 解析成功、开始执行前。宿主用它确认版本并读取 warning |
| `stage` | `stage` | 阶段切换：`PRD → PLANNING → DEVELOPMENT → VERIFICATION → DELIVERY → DONE` |
| `log` | `text` | 流水线日志（含 `[sandbox]` / `[breaker]` / `[router]` 前缀） |
| `agents` | `agents[]`（`id, adapter, enabled, declared, roles, zoneGlobs`） | 智能体池就绪 |
| `prd` | `prd` | PRD 生成或回显 |
| `tasks` | `batches`（二维数组：批次 → 任务） | 任务分解与批次规划结果 |
| `task` | `taskId, status, attempts` | 单任务状态变化 |
| `run` | `phase: "start"\|"end", taskId, agentId?, zone?, ok?, durationMs?, errorClass?` | 每次 run 的开始/结束归因，供宿主持久化审计 |
| `conflict` | `kind, paths[], remedy` | 批结束时检出 zone 越权 / 共享文件漂移 |
| `verification` | `passed, results[{kind, ok, exitCode}]` | 每一轮硬性验证（摘要，不含日志正文） |
| `escalation` | `taskId, summary` | 重修耗尽需要宿主决策（`escalationPolicy=abort/skip/redispatch_once` 时） |
| `done` | `passed, report` | 终态：交付 |
| `error` | `message, exhausted?` | 终态：致命错误。`exhausted: true` 对应退出码 2 |

## 3. escalationPolicy 语义与退出码

| 取值 | 行为 | 退出码 |
| --- | --- | --- |
| `abort`（默认） | 终止整个流水线 | 1 |
| `skip` | 跳过失败任务，其余能交付就交付；验证仍不过则致命 | 0 / 1 |
| `redispatch_once` | 每个任务额外给一轮修复，再不行终止 | 0 / 1 |
| `exhaust` | 不做任何干预，直接判定"预算耗尽" | **2** |

`exhaust` 是唯一能拿到退出码 2 的策略：其余三种都会在耗尽时先尝试一次人工/策略决策，
因此失败表现为退出码 1。宿主想区分"预算花完了"和"出错了"，就用 `exhaust`。

## 4. 兼容性承诺

1. **未知字段只 warning，不报错** —— 宿主提前使用新字段，旧 runner 不会拒绝整份 spec。
2. **除两个必填字段外都有默认值** —— 只写 `{requirement, projectRoot}` 也能跑。
3. **事件是增量追加的** —— 现有事件类型与字段名不会改；新事件类型宿主可以忽略。
4. **`hello.protocolVersion` 是握手点** —— 宿主可据此拒绝过旧的 runner，而不是靠猜。

已用测试钉住的兼容基线：协议第一版能接受的 spec（`requirement` / `projectRoot` /
`maxRepairRounds` / `verificationCommands` / `escalationPolicy`）在解析后能得到全部新字段的默认值。

## 5. 示例

最小可用：

```json
{ "requirement": "实现一个带过期时间的 LRU 缓存", "projectRoot": "/path/to/target" }
```

带外部智能体与回滚：

```json
{
  "requirement": "给现有 API 加参数校验",
  "projectRoot": "/path/to/target",
  "llmProvider": "sensenova",
  "maxRepairRounds": 2,
  "escalationPolicy": "exhaust",
  "maxParallelRuns": 2,
  "arbitration": "revert-batch",
  "snapshotRoot": "/var/tmp/ox-snapshots",
  "agents": [
    {
      "id": "codex-cli",
      "displayName": "Codex CLI",
      "adapter": "cli",
      "entry": { "kind": "cli", "command": "codex", "argsTemplate": ["exec", "--cd", "{{projectRoot}}", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "严格按文件 {{promptPath}} 中的任务书执行（先读该文件）。"] },
      "capabilities": {
        "roles": ["backend-dev", "test-writer"],
        "zoneGlobs": ["src/**", "tests/**"],
        "supports": ["read", "edit", "create", "run-test"],
        "artifactKinds": ["files", "logs"],
        "maxConcurrency": 2,
        "selfIsolated": true
      },
      "credential": { "kind": "none" }
    }
  ]
}
```

宿主消费（伪代码）：

```ts
const child = spawn("node", ["dist-headless/headless/headless-main.js"], { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.end(JSON.stringify(spec));
let buf = "";
for await (const chunk of child.stdout) {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const evt = JSON.parse(line);
    if (evt.type === "hello" && evt.protocolVersion !== "ox-headless/1") warn(evt.protocolVersion);
    if (evt.type === "run" && evt.phase === "end") audit(evt);
    if (evt.type === "conflict") alert(evt);
  }
}
const code = await once(child, "exit"); // 0 交付 / 2 预算耗尽 / 1 致命
```

## 6. 与 Electron 端的关系

同一套内核（`OrchestratorEngine` / `Scheduler` / 沙箱 / 仲裁），差别只在装配与出口：

| | Electron | Headless |
| --- | --- | --- |
| 智能体池 | `userData/agents.d` + 运行时注册 | `spec.agents` + `manifestDir` |
| 审计 | `userData/audit/*.jsonl` | `run` 事件交给宿主持久化 |
| 并发闸 | `maxParallelRuns` 默认 4 | 同（可由 spec 覆盖） |
| escalation | 弹出面板等操作者决策 | 由 `escalationPolicy` 决定 |

因此 headless 跑出来的行为与桌面端一致——包括沙箱拦截、熔断、越权回滚。
