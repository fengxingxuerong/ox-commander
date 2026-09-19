# OxCommander → 多智能体编排与统一沙箱平台（增量改造方案）

> 日期：2026-09-19
> 对象：`D:\ox\ox-commander`
> 基线实测：`vitest run` → **124 passed / 6 skipped**（11 files）；`tsc -b` 与 `tsc -b tsconfig.electron.json` → **双绿**。以下所有结论均有源码行号支撑。

---

## 1. 现状盘点（事实，非推测）

### 1.1 目录与职责

| 路径 | 职责 | 关键事实 |
| --- | --- | --- |
| `src/` | Renderer（React18 + Zustand） | `store.ts` 持有全局 AppState；`handleEvent` 消费主进程单向事件流 |
| `src/pages/` | 4 页：`projects / prd-review / board / settings` | `App.tsx:18-27` 路由 |
| `electron/main.ts` | Electron 主入口 | `contextIsolation: true, nodeIntegration: false`（`main.ts:24-28`） |
| `electron/preload.ts` | `contextBridge.exposeInMainWorld("oxCommander", api)` | **唯一 IPC 面**，17 个方法 |
| `electron/ipc.ts` | 全部 IPC handler + 引擎装配 | `buildEngine()` 每次调用重建引擎（`ipc.ts:115`） |
| `electron/store.ts` | `ProjectStore`（JSON 文件）、`SettingsStore` | `load()` 用 `{...DEFAULT_SETTINGS, ...parsed}` → **天然向后兼容**（`store.ts:85-89`） |
| `electron/keys-store.ts` | API Key 落盘 `keys.json` | 明文 JSON，P4 需迁移 OS keychain |
| `electron/engine/orchestrator.ts` | 六阶段流水线大脑 | `PRD→PLANNING→DEVELOPMENT→VERIFICATION→DELIVERY→DONE`，含 repair loop + escalation |
| `electron/engine/scheduler.ts` | 批内并发分发 + 结果回收 | zone 冲突检测 + ZoneGuard 事后校验 |
| `electron/engine/verifier.ts` | 跑 build/typecheck/test | `spawn(cmd, args, {shell: win32})`（`verifier.ts:17`） |
| `electron/engine/zone-guard.ts` | 前后快照 diff → 归属判定 | md5 全仓扫描，`.` zone 拥有全部（`zone-guard.ts:26-30`） |
| `electron/agents/` | **唯一 agent**：`SensenovaApiAdapter` | `agents/index.ts:9-11` 注释明确"只有一个 worker" |
| `shared/` | 大脑层共享：LLM 客户端、failover、prompt、schema、graph、routing | Electron 与 headless 共用，防漂移 |
| `headless/headless-main.ts` | JSONL 协议无 UI 入口 | stdin(spec) → stdout(JSONL events) → exitCode 0/1/2 |

### 1.2 现有执行链路

```
Renderer store.ts
  → preload.ts (oxCommander.*)
  → ipcMain.handle("orchestration:start")            ipc.ts:253
  → OrchestratorEngine.execute()                     orchestrator.ts:120
      ├─ 按 batch 串行                               orchestrator.ts:150
      └─ Scheduler.runBatch(pendingTasks)            scheduler.ts:76
            ├─ batch 内 zone 去重（重复即抛错）        scheduler.ts:81-86
            ├─ pickAgents(): round-robin 轮询池       scheduler.ts:60-74
            ├─ agent.dispatch(TaskPayload)           sensenova-api.ts:108
            └─ ZoneGuard.diff → unownedChanges        scheduler.ts:119-131
  → verifyProject()                                  verifier.ts:43
  → routeVerificationErrors(): 按 zone 路由错误       routing.ts:63
  → repair loop / escalation                         orchestrator.ts:227-276
```

### 1.3 与"多智能体平台"的差距（每条都有证据）

| # | 缺口 | 证据 |
| --- | --- | --- |
| G1 | **只有一个 worker**，`preferredAgents` 只是排序偏好，无能力匹配 | `agents/index.ts:9-11`；`scheduler.ts:44-51` |
| G2 | `Task.suggestedRole` 是**死字段**：只在 schema 校验与 UI 显示出现，从不参与分派 | `shared/schema.ts:78`、全仓 grep 仅 prompts/schema/test/UI 命中 |
| G3 | 分派策略是 round-robin，**不考虑任务需求与 agent 能力** | `scheduler.ts:73` |
| G4 | 无注册/注销：adapter 硬编码 `new SensenovaApiAdapter()`，外部 agent 无法加入 | `agents/index.ts:10`、`ipc.ts:122`、`headless-main.ts:103` |
| G5 | **无超时**：HTTP 层有 AbortSignal（120s/300s），但单次 agent run 无 deadline，无 idle 检测 | `http-clients.ts:145-147`，`scheduler.ts:136-152` 无计时 |
| G6 | **无熔断**：`probe()` 结果被永久缓存，queued 后不再体检 | `scheduler.ts:34-41` |
| G7 | **无命令沙箱**：verificationCommands 用户可配，Windows 下直接进 shell 执行 | `types.ts:121,129-131`；`verifier.ts:17` |
| G8 | **zone="." 拥有全仓**，ZoneGuard 形同虚设 | `zone-guard.ts:26-30`；`prompts.ts:54` 示例就用 `"."` |
| G9 | **无回滚**：越权只报错，改动已落盘 | `scheduler.ts:126-131` 只改 `logDigest` |
| G10 | ZoneGuard 每批两次全仓 md5 扫描，O(files) 重 IO | `zone-guard.ts:36-65, 76-81` |
| G11 | `agents/meta.kind` 预留 `"ui"` 从未实现 | `types.ts:95` |
| G12 | 密钥明文落 `%userData%/keys.json` | `keys-store.ts` |

**结论**：现有抽象其实很干净——`AgentAdapter`（probe/dispatch/collect/abort）+ `AgentEvent` 流 + `RunSession` 内存队列 已经是"统一接入"的雏形。改造是**在它之上长能力**，不是推倒重来。

---

## 2. 目标架构（三层，增量叠加）

```
┌───────────────────────────────────────────────────────────────┐
│ L1  Orchestrator 层（大脑 + 治理）                              │
│   保留：OrchestratorEngine（六阶段/repair/escalation）          │
│   新增：CapabilityRouter · ArbitrationPolicy · RetryPolicy      │
│         LeaseTable · CircuitBreaker · Snapshot/Rollback         │
└───────────────────────────┬───────────────────────────────────┘
                            │ TaskRequest（统一任务契约）
┌───────────────────────────▼───────────────────────────────────┐
│ L2  Agent Access Layer（统一适配层）                            │
│   AgentRegistry  ──  probe / health / lease / quota            │
│     ├─ LocalLlmApiAdapter（包装现有 SensenovaApiAdapter）        │
│     ├─ CliAgentAdapter（Codex CLI / Trae / Claude Code …）      │
│     └─ HttpBridgeAdapter（WorkBuddy / MCP over HTTP / SSE）     │
└───────────────────────────┬───────────────────────────────────┘
                            │ 全部经 ↓
┌───────────────────────────▼───────────────────────────────────┐
│ L3  Sandbox Runtime（强制束缚是所有 adapter 的共同底座）         │
│   PathPolicy · CommandPolicy · TimeoutGate · ResourceLimit      │
│   SnapshotProvider(git ▸ fs-backup) · AuditLog                  │
└───────────────────────────────────────────────────────────────┘
```

**核心原则**：`L2` 的每个 adapter 都不能自己碰文件系统和进程；所有副作用必须过 `L3`。现有 `SensenovaApiAdapter.writeFiles`（`sensenova-api.ts:285-313`）里的越权判断，正是要上提到 L3 的第一块逻辑。

---

## 3. Orchestrator 层设计

### 3.1 职责切分（不做重复）

| 关注点 | 归属 | 现状/改动 |
| --- | --- | --- |
| PRD 生成、任务分解 | `OrchestratorEngine`（保留） | 不动 |
| 批次规划（拓扑 + zone 互斥） | `shared/graph.ts planBatches`（保留） | 不动，只把 zone 判定换成 `ZoneRule.canCoExist` |
| **任务→agent 指派** | 新增 `CapabilityRouter` | 替换 `scheduler.pickAgents` |
| **结果汇总** | 新增 `ResultMerger` | 落在 `Scheduler.runBatch` 尾部 |
| **冲突仲裁** | 新增 `ArbitrationPolicy` | 替换现有"整批连坐"（`scheduler.ts:126-131`） |
| **失败重试** | 新增 `RetryPolicy` + `CircuitBreaker` | 现有 repair loop（按 batch 重跑）保留，agent 级微重试新增 |
| 验证命令编排 | `verifier.ts`（改造） | 加 CommandPolicy + timeout |

### 3.2 指派算法（CapabilityRouter）

硬性过滤 + 打分排序，取代 round-robin：

```
候选 = registry.list().filter(a =>
        a.healthy
     && a.capabilities.protocolVersion 兼容
     && task.requiredTags ⊆ a.capabilities.supports
     && (task.suggestedRole ∈ a.capabilities.roles || a.capabilities.roles ⊇ "*")
     && lease.freeFor(task.zone, a.id)          // zone 租约互斥
     && a.inflight < a.capabilities.maxConcurrency
)

score(a) =  100 · roleMatch(task.suggestedRole, a)
          +  40 · zoneAffinity(task.zone, a.zoneGlobs)
          +  20 · qualityBonus(a.stats.successRate)      // 滑动窗口
          -  30 · circuitPenalty(a.circuitState)          // half-open 减半 / open 已过滤
          -  10 · loadPenalty(a.inflight / a.maxConcurrency)
          +   5 · declaredPriority(a.priority)
```

**降级保证**：候选为空 → 回落到 **`legacy-pool` 策略**（= 今天的行为：`enabledAgents` 排序 + round-robin）。这条保证在任何阶段出错时行为不劣化。

### 3.3 冲突仲裁（ArbitrationPolicy）

冲突的三类判定，全部基于 L3 的观测（`FileJournal`，替代现有全仓 md5 diff）：

| 冲突类型 | 判定 | 默认策略 |
| --- | --- | --- |
| **越权写**（zone 外） | 写路径 ∉ zone 且 ∉ `delegatedWrite` | `revert-task`：回滚该 run 全部改动，run 判 failed，**不连坐** batch |
| **同文件竞写**（两 run 写同一文件） | `FileJournal` 同一路径 ≥2 生产者 | `owner-wins`：zone 拥有者胜；无 owner 则 `first-wins`，败者标记 `conflict` 进 repair |
| **共享文件漂移**（共享区被改） | 路径 ∈ `sharedPaths`（如 `package.json`） | `deny`：默认禁止写，确需则走 Owner 审批队列 |

策略可配：`"deny-all" | "revert-task"(默认) | "quarantine"`（越权文件移入 `.ox-quarantine/<runId>/`，平台保留证据）。

### 3.4 失败重试（双层）

```
Layer A — Agent 级微重试（新增，分钟内）
  触发：进程启动失败 / 协议解析失败 / agent 自报 retryable
  策略：backoff 500ms·2^k（capped 8s，同 failover 现有手感），同一 task 内最多 2 次；
        优先换同能力的**另一个 agent**，无备选才原地重试
Layer B — 流水线 repair loop（保留）
  触发：verification 不过
  现状：整批/全员重跑 orchestrator.ts:136-148
  增强：只重跑 routeVerificationErrors 归因到的任务（已按 zone 路由），
        repairOf 附带 "上次你改过哪些文件" 清单，而不是整份 digest
```

`CircuitBreaker`：连续 3 次 terminal-failed → `open` 60s → `half-open` 放行 1 次探测 → 成功闭合。open 期间 `probe()` 返回 false，从候选池移除，但不注销。

---

## 4. 统一智能体接入适配层

### 4.1 接口演进（v1 → v2，向后兼容）

现有 `AgentAdapter`（`types.ts:98-104`）**保持不变**。v2 全部用可选成员实现，因此今天的代码与所有测试无需修改即可继续编译通过：

```ts
// shared/agent-contract.ts（新文件）
export const AGENT_PROTOCOL_VERSION = "ox-agent/2";

/** 能力声明 —— 向 Orchestrator 描述"我能干什么、在哪干、能干多少"。 */
export interface AgentCapabilities {
  protocolVersion: string;              // "ox-agent/2"；缺失视为 v1 legacy
  /** 可承担的角色；"*" 表示通用。对应 Task.suggestedRole */
  roles: Array<"frontend-dev"|"backend-dev"|"fullstack-dev"|"test-writer"|"docs-writer"|"*">;
  /** 可在哪些路径工作（相对 projectRoot 的 glob）；["**"] 表示不限 */
  zoneGlobs: string[];
  /** 能提供的动作：读/写代码、跑命令、跑测试、检索…… */
  supports: Array<"read"|"edit"|"create"|"delete"|"run-command"|"run-test"|"review">;
  /** 产出物类型，决定 ResultMerger 如何汇总 */
  artifactKinds: Array<"files"|"diff"|"logs"|"report">;
  maxConcurrency: number;               // 该 agent 自身并行上限
  /** 是否自带隔离（子进程/容器）；false 时必须由 L3 兜底 */
  selfIsolated: boolean;
}

/** 鉴权方式：仅描述来源，主进程解析，绝不把明文过 IPC 到 renderer */
export type AgentCredential =
  | { kind: "env";        envVar: string }                                  // 现状：全部 provider 走 env
  | { kind: "bearerFile"; tokenFile: string }                               // 从文件读 token
  | { kind: "execToken";  command: string; args: string[]; cacheTtlMs?: number }
  | { kind: "none" };                                                       // 本地 CLI / 子进程，继承宿主权限

export interface AgentLimits {
  runDeadlineMs: number;    // 单次 run 硬上限，默认 600_000
  idleTimeoutMs: number;    // 无事件超时，默认 120_000
  maxStdoutBytes: number;   // 输出预算，默认 2MB
}

/** v2 适配器 = v1 接口 + 可选扩展。老 adapter 直接是合法 v2（capabilities 缺失 → 由 registry 注入默认值） */
export interface AgentAdapterV2 extends AgentAdapter {
  readonly credential?: AgentCredential;
  readonly limits?: Partial<AgentLimits>;
  /** 能力声明；缺省时 registry 用 LegacyFallback 推断（roles:["*"], zoneGlobs:["**"], maxConcurrency:1） */
  capabilities?(): AgentCapabilities;
  /** 优雅退出：等待 in-flight 结束，超时则强制。注销/关窗时调用 */
  drain?(graceMs: number): Promise<"drained"|"timeout">;
  /** 结构化结果：可选。没有时由 FileJournal 反推 */
  lastResult?(handle: RunHandle): Promise<AgentRunResult | undefined>;
}
```

### 4.2 输入契约（下行）

保留 `TaskPayload`（`types.ts:106-114`）字段名全部不变，只**追加**可选项，因此 `sensenova-api.ts` 与 `scheduler.ts` 无需改动：

```ts
export interface TaskRequest extends TaskPayload {   // 超集，老字段位置不变
  // ↓ 新增
  protocolVersion?: string;          // 缺失 = v1 legacy
  requiredTags?: Array<AgentCapabilities["supports"][number]>;   // 默认 ["edit"]
  /** 本次允许写的根目录（相对 projectRoot）；缺省 = [task.zone] */
  writableRoots?: string[];
  delegatedWrite?: string[];         // zone 外的白名单（Owner 审批后下发）
  forbiddenWrite?: string[];         // 强制黑名单，优先级最高
  allowedCommands?: string[];        // 该 run 允许的命令 allowlist
  deadlineMs?: number;
  attempt?: number;                  // 本次是第几次微重试
  previousAttempt?: { agentId: string; filesChanged: string[]; errorDigest: string };
}
```

### 4.3 输出契约（上行）

`AgentEvent`（`types.ts:78-84`）保留四种 kind 不动，**追加**两个可选 kind（老 renderer 忽略未知 type，天然兼容）：

```ts
export type AgentEventKindV2 = AgentEventKind | "artifact" | "heartbeat";

export interface AgentEventV2 extends AgentEvent {
  kind: AgentEventKindV2;
  /** kind==="artifact" 时：本 run 改了哪些文件 + 摘要 */
  changes?: Array<{ path: string; op: "create"|"modify"|"delete"; bytes?: number }>;
  usage?: { tokens?: number; costMs?: number };
}

/** terminal 时的结构化结果 */
export interface AgentRunResult {
  runId: string; agentId: string; taskId: string;
  status: "completed" | "failed" | "aborted";
  changes: FileChange[];                 // 缺失时由 FileJournal diff 补齐
  errorClass?: "auth" | "timeout" | "protocol" | "resource" | "conflict" | "unknown";
  retryable?: boolean;
  logDigest: string;
  durationMs: number;
}
```

### 4.4 鉴权

| 形态 | 适用 | 落点 |
| --- | --- | --- |
| `env` | SenseNova / DeepSeek / GLM / Qwen / Kimi / OpenAI / Anthropic（`PROVIDER_CATALOG` 全部如此） | `process.env`，现状即如此（`ipc.ts:44-47`、`build-llm.ts:19-32`） |
| `bearerFile` | WorkBuddy/MCP bridge 的长期 token | 仅主进程读取，**永不过 preload** |
| `execToken` | `codex auth token`、`trae auth token` 等动态派发 | 主进程 `spawn` 取回，按 `cacheTtlMs` 缓存，带 allowlist |
| `none` | 本地子进程 CLI | 继承宿主权限，靠 L3 的 PathPolicy/CommandPolicy 兜底 |

P4 目标：把 `keys.json` 迁到 Electron `safeStorage`（OS keychain），`keys-store.ts` 接口不变。

### 4.5 注册与注销

**注册三态**：`declared`（配置里有）→ `probed`（`probe()` 通过）→ `ready`（已进候选池）；异常态 `quarantined`（健康检查连续失败，保留注册）。

```ts
// electron/agents/registry.ts（新）
export interface AgentManifest {
  id: string; displayName: string;
  adapter: "local-llm"|"cli"|"http-bridge";
  entry: { command: string; argsTemplate: string[] } | { url: string };
  capabilities: AgentCapabilities;
  credential: AgentCredential;
  limits?: Partial<AgentLimits>;
  priority?: number;
  enabled?: boolean;
}

export class AgentRegistry {
  static fromManifests(ms: AgentManifest[], env?: NodeJS.ProcessEnv): AgentRegistry;
  loadDeclaredDir(dir: string): void;          // agents.d/*.json 热声明（无需改代码即可加 agent）
  register(m: AgentManifest): Promise<RegistrationResult>;   // 校验 capabilities schema → probe → ready
  unregister(id: string, opts?: { graceMs?: number }): Promise<void>;  // drain → 释放 lease → 移除
  setEnabled(id: string, on: boolean): void;   // 复用现有 enabledAgents 语义
  candidates(req: TaskRequest): AgentDescriptor[];
  healthCheck(): Promise<Map<string, boolean>>;
  stats(id: string): { successRate: number; inflight: number; circuit: "closed"|"open"|"half-open" };
}
```

**注销语义**（避免 "runner 突然消失"）：`unregister` 先 drain（默认 5s）→ drain 超时则对 in-flight 发 `abort(handle)` → 释放其持有的 zone lease → 回收事件订阅 → 最后从池移除。所有 in-flight task 立即回收，避免悬空 Session。

### 4.6 WorkBuddy / Codex / Trae 怎么接

| Agent | 接入形态 | adapter | 要点 |
| --- | --- | --- | --- |
| **WorkBuddy** | HTTP bridge（`HttpBridgeAdapter`）：POST `/v1/runs`，SSE 拉事件 | `http-bridge.ts` | 复用 `FailoverLlmClient` 的 backoff 手感；token 走 `bearerFile`；断流按 `idleTimeoutMs` 熔断，可续 `?sinceEventId=` |
| **Codex CLI** | 子进程（`CliAgentAdapter`）| `cli-agent.ts` | `--cd {projectRoot}` + prompt 文件；stdout/stderr 转 `AgentEvent`；退出码映射 run 状态；**禁用 shell**，直接 `spawn` 无 shell |
| **Trae** | 二选一：① CLI 子进程（同 Codex）；② UI 桥（`adapter: "http-bridge"` + 本地 socket） | 同上 | UI 类走 `credential: none`，能力声明 `supports:["edit","review"]`，`maxConcurrency: 1` |

manifest 示例（`agents.d/codex.json`）：

```json
{
  "id": "codex-cli", "displayName": "Codex CLI",
  "adapter": "cli",
  "entry": { "command": "codex", "argsTemplate": ["exec", "--cd", "{{projectRoot}}", "--prompt-file", "{{promptPath}}"] },
  "capabilities": {
    "protocolVersion": "ox-agent/2",
    "roles": ["backend-dev", "fullstack-dev", "test-writer"],
    "zoneGlobs": ["src/**", "tests/**"],
    "supports": ["read", "edit", "create", "run-test"],
    "artifactKinds": ["files", "logs"],
    "maxConcurrency": 2,
    "selfIsolated": true
  },
  "credential": { "kind": "execToken", "command": "codex", "args": ["auth", "token"], "cacheTtlMs": 300000 },
  "limits": { "runDeadlineMs": 900000, "idleTimeoutMs": 120000, "maxStdoutBytes": 2097152 },
  "priority": 10,
  "enabled": true
}
```

**向后兼容点**：`createDefaultAdapters()` 保留函数签名，内部改为返回 `AgentRegistry` 解析后的 pool；未配置任何 manifest/agents.d 时返回 `[SensenovaApiAdapter]`，行为与今天完全一致。

---

## 5. 沙箱隔离边界

### 5.1 文件读写（`PathPolicy`）

```ts
export interface SandboxConfig {
  projectRoot: string;                 // 唯一真根，绝对路径
  writableRoots: string[];             // 默认 [projectRoot]，禁止跨盘
  delegatedWrite?: string[];           // zone 外白名单（Owner 审批）
  forbiddenWrite: string[];            // 默认含 node_modules/**, .git/**, ox-scripts/**, package.json, .env*
  zoneMode: "strict" | "legacy";       // legacy = 兼容今天 zone="." 拥有全仓的行为
}
```

- 判定顺序：`forbiddenWrite` **拒** → 越出 `projectRoot` **拒** → 命中 zone/delegated **放行** → 其余 **拒**。
- 所有路径 `path.resolve()` 后前缀比对 + 拒绝 `..` 穿越（`schema.ts:73-76` 已有 zone 穿越校验，上提到通用层）。
- **修复 G8**：`zoneMode:"strict"` 下 `zone:"."` 不再等于全仓，改为 `["."]` → 仅根目录直属文件；需要全仓权限必须在 `delegatedWrite` 显式申请。升级开关放 Settings，`legacy` 为默认，逐个项目迁移。
- 现有 `SensenovaApiAdapter.writeFiles` 的硬编码禁写表（`sensenova-api.ts:26, 295-305`）改为调用 `PathPolicy.assertWritable()`，行为不变、逻辑上提。

### 5.2 命令执行（`CommandPolicy`）

- 默认 allowlist：`node | npm | npx(node-scoped) | git(status/diff/stash/checkout/apply)`、`ffmpeg` 之类按项目显式开。
- `verifier.ts:17` 的 `shell: process.platform === "win32"` 改为：**始终 `shell:false`**，Windows 通过 `process.platform==="win32"` 时用 `.cmd` 解析 + 参数数组，杜绝 `&&`/`|` 注入。
- `settings.verificationCommands` 保存即校验：命令必须在 allowlist，args 不得含 shell 元字符；非法命令保存时拒绝并提示。
- 子进程环境净化：`cwd = projectRoot`、超时 kill tree（Windows 用 `taskkill /F /T`）、stdout/stderr 双预算截断（复用 `digest()`，`scheduler.ts:156`）。

### 5.3 并发控制（`LeaseTable`）

```ts
interface ZoneLease { zone: string; runId: string; agentId: string; taskId: string; expiresAt: number; }
```

- **zone 互斥**：同一 zone 同时只允许 1 个 run；现有"批内 zone 去重"（`scheduler.ts:81-86` + `graph.planBatches`）保留，LeaseTable 把它从"批内"提升到"跨 run/跨轮"。
- **三级限流**：平台全局 `maxParallelRuns`（默认 4）→ per-agent `maxConcurrency` → zone lease。
- **租约有 TTL**（默认 = `runDeadlineMs`），防止进程消失导致死锁；TTL 到期自动释放并记 audit。

### 5.4 超时与熔断

| 层次 | 默认值 | 触发后果 |
| --- | --- | --- |
| HTTP 单请求 | brain 120s / executor 300s（`http-clients.ts:145-147`，保留） | failover 换组合 |
| run idle | 120s 无事件 | 软终止 → `abort()` → 判 `timeout` 失败 |
| run deadline | 600s | 硬杀进程树 → 释放 lease → 回滚本 run 改动 |
| verification 单命令 | 300s | 该 command 判失败，进入 repair |
| circuit breaker | 连续 3 次 terminal-fail → open 60s | 移出候选池（不注销） |

### 5.5 回滚（`SnapshotProvider`）

```ts
export interface SnapshotProvider {
  begin(scope: { runId: string; zones: string[] }): Promise<SnapshotToken>;
  changed(token: SnapshotToken): Promise<FileChange[]>;      // 替代 ZoneGuard 全仓 md5（修复 G10）
  revert(token: SnapshotToken, sel?: { paths?: string[] }): Promise<RevertResult>;
  commit(token: SnapshotToken): Promise<void>;
}
```

- 优先 `GitSnapshotProvider`：`git status --porcelain` 取变更集 + 脏文件备份，**不用 stash**（避免 `.git` 异常时丢工作区，参照本机已知的 `.git/refs` 被删事故）。
- 无 git → `FsBackupProvider`：把 touched 文件内容写入 `%userData%/snapshots/<runId>/`，`.ox-snapshot.json` 记录清单。
- 触发点：① 越权写（`ArbitrationPolicy=revert-task`）② run 超时/被 abort ③ 验证失败且策略为 revert ④ 用户手动 rollback。
- **粒度约束**：只能回滚本 run touch 过的文件，绝不触碰其他 run 的 zone。

### 5.6 观测替代：`FileJournal`（性能）

ZoneGuard（`zone-guard.ts:36-65`）每批两次全仓 md5。改为：run 前记录 mtime+size 指纹（便宜）→ run 后只重扫**指纹变化**的文件 → 精算 hash。大仓从 O(2N files 读全文) 降到 O(N stat + 少量 read)。`ZoneGuard` 类保留作为 `FileJournal` 的 fallback 实现，现有 `zone-guard.test.ts`（7 用例）继续绿。

---

## 6. 向后兼容矩阵

| 维度 | 保证 | 机制 |
| --- | --- | --- |
| 现有 17 个 IPC 方法 | **签名与语义完全不变** | 只 `ipcMain.handle` 新增 `agents:*` |
| `AgentAdapter` 接口 | **不改** | v2 全用可选成员 + `extends` |
| `TaskPayload` / `AgentEvent` | **字段不删、不改名** | 只追加可选字段 |
| `Scheduler` 构造签名 | 前 3 参不变 | 新增第 4 个可选 `opts?: SchedulerOptions` |
| `OrchestratorDeps` / `Callbacks` | 全为可选增量 | 缺失即走 legacy 分支 |
| `HeadlessSpec` | 全字段可选，新增字段带默认值 | 老 JSONL 消费者无需改 |
| 老 `settings.json` | 直接可读 | `SettingsStore.load()` 的深度合并已具备（`store.ts:88`） |
| 测试 | 124 用例原地不改动 | 新测试放 `src/**` `shared/**` `electron/**`（已被 `vitest.config.mts` include） |
| 默认行为 | 与今天一致 | 三道总闸：`enableAgentRouter` / `zoneMode` / `sandboxEnabled`，默认 legacy/关，逐步开 |

> **回滚按钮**：任一阶段出问题，把 `ProjectSettings` 里的总闸置 false 即退回今天的行为，不需要版本回退。

---

## 7. 分阶段实施路线

统一验收基线：
```bash
npm run typecheck     # tsc -b && tsc -b tsconfig.electron.json
npm test              # vitest run
node scripts/smoke-fullchain.mjs   # 端到端链路冒烟（已有）
```

### P0 — 基线固化（0.5d）
- 目标：把今天的绿灯钉死，作为后续每阶段的回归门。
- 文件：`vitest.config.mts`、`package.json`（补 `test:once` 与 `verify` 聚合脚本）
- 验证：两条命令输出与本文开头一致（124 passed / 6 skipped，typecheck 双 0）。

### P1 — 能力注册与按能力分派（2-3d）
- 目标：修 G1/G2/G3。让 `suggestedRole` 真正参与分派，多 agent 可用。
- 新增：`shared/agent-contract.ts`、`electron/agents/registry.ts`、`electron/engine/router.ts`、`src/router.test.ts`
- 改：`shared/types.ts`（追加可选字段）、`electron/engine/scheduler.ts`（`pickAgents` 委托 router，失败回落）、`electron/agents/index.ts`（`createDefaultAdapters()` 内部接 registry）
- 验证：
  - 单测：role 匹配命中最优 agent；无匹配回落到现有 round-robin；lease 互斥使同 zone 两任务不并行。
  - 回归：`scheduler.test.ts` 12 用例 + `orchestrator.test.ts` 14 用例保持绿。

### P2 — 外部智能体适配 + 注册/注销（3-4d）
- 目标：修 G4/G11。Codex/Trae（CLI）与 WorkBuddy（HTTP bridge）可插拔接入。
- 新增：`electron/agents/cli-agent.ts`、`http-bridge.ts`、`agents.d/README.md`、` electron/agents/dts/manifest-schema.ts`、`src/agents-contract.test.ts`
- 改：`agents/index.ts`、`electron/ipc.ts`（`agents:list/register/unregister/probe`）、`preload.ts`（+4 方法）、`src/pages/SettingsPage.tsx`（agent 面板：启用/禁用/健康检查/注销）
- 验证：
  - 契约测试：假 manifest → register → probe=fail → 状态 `quarantined` 而非崩
  - 注销语义：in-flight run 存在时 unregister，5s drain 后 lease 释放、task 回收、无悬空 session
  - CLI adapter 打靶：用 `echo` 作替身命令跑一次完整 dispatch/collect

### P3 — 沙箱：路径 + 命令 + 超时熔断（3-4d）
- 目标：修 G5/G6/G7/G8。所有副作用强制走 L3。
- 新增：`electron/sandbox/path-policy.ts`、`command-policy.ts`、`timeout-gate.ts`、`circuit-breaker.ts`、对应测试
- 改：`verifier.ts`（`shell:false` + kill tree + 命令超时）、`sensenova-api.ts`（writeFiles 改调 PathPolicy，行为不变）、`agent（各 adapter）`接 TimeoutGate
- 验证：
  - 路径测试：`../`、绝对路径、`node_modules/`、`.git/`、`zone="."` strict 模式全被拒
  - 命令测试：`["npm","run","build; rm -rf /"]`（Win/POSIX）不执行；超限命令被 kill 且不留孤儿进程
  - 熔断测试：连续 3 次失败后该 agent 不进候选池；60s 后半开探测

### P4 — 快照、回滚与冲突仲裁（3-4d）
- 目标：修 G9/G10。越权可回滚、结果可仲裁。
- 新增：`electron/sandbox/file-journal.ts`、`snapshot-git.ts`、`snapshot-fs.ts`、`electron/engine/arbiter.ts`、`electron/engine/result-merger.ts`
- 改：`zone-guard.ts`（保留类，内部改走 FileJournal）、`scheduler.ts`（尾部接 arbiter + merger）、`prompts.ts`（`zone:"."` 引导改为显式目录）、`keys-store.ts`（可选切 safeStorage）
- 验证：
  - 越权写 → `revert-task` → 磁盘回到 run 前状态，`changed(token)` 为空
  - 同文件双写 → `owner-wins` → 败者标记 conflict 且内容未被污染
  - 大仓性能：FileJournal vs ZoneGuard 全仓扫描耗时对比（目标 ≥3× 提升）

### P5 — 编排增强与可观测（2d）
- 目标：把多智能体运行状态在 Board 上可见、可控。
- 新增：`src/pages/AgentsPage.tsx`、`electron/audit-log.ts`（JSONL 落 `%userData%/audit/`）
- 改：`src/store.ts`（agent 状态切片）、`App.tsx`（路由加 `agents`）、`BoardPage.tsx`（显示 agentId/attempt/errorClass/lease）
- 验证：`smoke-fullchain.mjs` 跑通且 audit 日志每条 run 有 `begin/terminal/changes/revert` 四元组。

### P6 — Headless 协议对外化 + 平台化收口（2d）
- 目标：外部宿主（DSH/其他 agent）用同一套协议驱动整个平台。
- 改：`headless/headless-main.ts`（`HeadlessSpec` 增 `agents?: AgentManifest[]`、`delegatedWrite`、`sandbox`，全部可选）、补事件 `agentStatus` / `conflict` / `rollback`
- 验证：`echo '<旧格式 spec>' | node dist-headless/headless/headless-main.js` 行为与今天完全一致（老消费者零改动）。

**总增量**：约 6 个新目录文件簇 + 13 个新文件，改动均为"加分支、加可选参数"，无一处删旧逻辑。

---

## 8. 关键模块接口定义（可直接落地）

```ts
// ── electron/engine/router.ts ─────────────────────────────────
export interface RoutingDecision {
  agentId: string;
  score: number;
  reason: string;                       // 便于 UI/日志解释"为什么派给他"
}
export interface CapabilityRouter {
  assign(req: TaskRequest, cands: AgentDescriptor[]): RoutingDecision | undefined;
}
export function createCapabilityRouter(opts?: {
  weights?: Partial<Record<"role"|"zone"|"quality"|"load"|"circuit"|"priority", number>>;
  fallback?: "round-robin" | "none";    // 默认 round-robin（= 今天的行为）
}): CapabilityRouter;

// ── electron/engine/arbiter.ts ────────────────────────────────
export type ConflictKind = "unauthorized-write" | "concurrent-write" | "shared-drift";
export interface Conflict { kind: ConflictKind; paths: string[]; runs: string[]; }
export type Remedy =
  | { action: "pass" }
  | { action: "fail-task"; taskId: string; reason: string }
  | { action: "revert-task"; taskId: string; paths?: string[] }
  | { action: "quarantine"; paths: string[] }
  | { action: "escalate"; summary: string };         // 复用现有 escalation 通道
export interface ArbitrationPolicy {
  arbitrate(conflicts: Conflict[], ctx: { journal: FileJournal }): Promise<Remedy[]>;
}

// ── electron/engine/result-merger.ts ──────────────────────────
export interface MergeStrategy {
  onFileConflict: "owner-wins" | "first-wins" | "later-wins" | "abort";
  onSharedWrite:  "deny" | "allow" | "escalate";
}
export function mergeRunResults(results: AgentRunResult[], s: MergeStrategy): {
  accepted: FileChange[]; rejected: Array<{ change: FileChange; reason: string }>;
};

// ── electron/sandbox/path-policy.ts ───────────────────────────
export class PathPolicy {
  constructor(cfg: SandboxConfig);
  assertWritable(relPath: string): { ok: true; abs: string } | { ok: false; reason: string };
  assertReadable(relPath: string): boolean;
  isDelegated(relPath: string): boolean;
}

// ── electron/sandbox/command-policy.ts ────────────────────────
export interface CommandPolicy { check(argv: string[]): { ok: boolean; reason?: string }; }
export function createDefaultPolicy(): CommandPolicy;   // node/npm/git-core allowlist

// ── electron/sandbox/timeout-gate.ts ──────────────────────────
export interface TimeoutGateOptions { deadlineMs: number; idleTimeoutMs: number; }
export class TimeoutGate {
  constructor(opts: TimeoutGateOptions, onTrip: (reason: "deadline"|"idle") => void);
  touch(): void;                       // adapter 每收到事件调用
  wrap<T>(p: Promise<T>): Promise<T>;  // 超时即 reject + onTrip
  dispose(): void;
}

// ── electron/sandbox/file-journal.ts ──────────────────────────
export interface FileChange { path: string; op: "create"|"modify"|"delete"; bytes?: number; producer?: string; }
export class FileJournal {
  begin(root: string, zones: string[]): SnapshotToken;
  changed(token: SnapshotToken): Promise<FileChange[]>;
  unauthorized(token: SnapshotToken, zones: string[]): Promise<string[]>;
}

// ── electron/engine/scheduler.ts（签名演进）───────────────────
export interface SchedulerOptions {
  router?: CapabilityRouter;
  leases?: LeaseTable;
  arbiter?: ArbitrationPolicy;
  merger?: MergeStrategy;
  timeout?: TimeoutGateOptions;
  breaker?: CircuitBreaker;
}
export class Scheduler {
  constructor(                                   // 前三参与今天完全一致
    adapters: AgentAdapter[],
    preferredAgents?: string[],
    zoneGuard?: ZoneGuard,
    opts?: SchedulerOptions,                     // ← 新增可选
  );
  runBatch(tasks: Task[], projectRoot: string,
    opts?: { preferredAgentId?: string; repairOf?: Map<string, {round:number; errorLogDigest:string}> }
  ): Promise<DispatchOutcome[]>;                 // ← 返回值不变
}
```

---

## 9. 明确不做（边界）

- **不做容器内/VM 级隔离**：本机 Win11 + Electron，`delegatedWrite` + CommandPolicy + zone lease 已是收益/成本最优解。真要硬隔离，先用-CI-。
- **不做多租户/配额计费**：`maxConcurrency` 之外的配额留给后续。
- **不替换现有 failover 线路池**：`FailoverLlmClient`（3 key × 3 model）是同类里少见的成熟件，只被 `AgentRegistry` 当作"local-llm"一种能力的实现细节。
- **不在本轮改 renderer 设计语言**：主题与布局保持原样，仅增量加 agent 面板。

## 10. 立即可做的第一步

先在 `electron/engine/router.ts` 落地 `createCapabilityRouter()` + 单测，并把 `Scheduler.pickAgents`（`scheduler.ts:60-74`）改成"router 命中即用、未命中走原路径"。这一步不碰任何网络/文件逻辑，风险最低，却立刻让 `suggestedRole` 从死字段变成真正的分派依据——也是验证整套设计是否对味的试金石。

---

## 11. 实施记录 · P1（2026-09-19 已完成）

### 新增文件

| 文件 | 内容 |
| --- | --- |
| `shared/glob.ts` | `compileGlob` / `matchesAnyGlob` / `zoneWithinGlobs` / `isUnrestrictedGlob`，纯函数无依赖 |
| `shared/agent-contract.ts` | `AgentCapabilities` / `AgentCredential` / `AgentLimits` / `AgentManifest` / `AgentDescriptor` / `AgentRunResult` / `TaskRequest` / `AgentEventV2` / `AgentAdapterV2` / `normalizeCapabilities` / `isLegacyAdapter` |
| `electron/agents/registry.ts` | `AgentRegistry`（能力归一化 + 硬过滤）、`wrapLegacyDescriptor`、`createRegistry` |
| `electron/engine/router.ts` | `CapabilityRouter`（打分排序 + legacy 等价回落）、`DEFAULT_ROUTER_WEIGHTS` |
| `src/glob.test.ts`、`src/agent-registry.test.ts`、`src/router.test.ts` | 44 个新用例 |

### 改动文件（均为追加，无一处删旧逻辑）

| 文件 | 改动 |
| --- | --- |
| `shared/types.ts` | `ProjectSettings.agentRouter: boolean`（默认 `true`） |
| `electron/engine/scheduler.ts` | 新增第 4 可选参 `opts: SchedulerOptions`；`pickAgents` → `planPool`（返回每任务一个 adapter）；新增 `descriptorsFor` |
| `electron/agents/index.ts` | 新增 `createAgentLayer()` / `agentRoutingLogLine()`；`createDefaultAdapters()` 签名不变 |
| `electron/agents/sensenova-api.ts` | 新增 `capabilities()` 声明 |
| `electron/ipc.ts`、`headless/headless-main.ts` | 装配改用 `createAgentLayer`，路由决策写入日志流 |

### 实测结果（可复现）

```bash
npx tsc -b && npx tsc -b tsconfig.electron.json && npx tsc -b tsconfig.headless.json
npx vitest run
npx vite build
```

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| vitest | 124 passed / 6 skipped | **172 passed / 6 skipped**（14 files） |
| tsc（renderer / electron / headless） | 0 / 0 / — | **0 / 0 / 0** |
| vite build | — | **EXIT 0**，51 modules，166.20 kB |
| headless 非法输入 | `{"type":"error"}` + exit 1 | 同（行为未变） |

### 实施中发现的两个硬约束（已写进代码注释）

1. **`shared/` 被两套 tsconfig 同时编译**（renderer：`module: ESNext` + DOM；electron：`module: CommonJS`、lib 只有 ES2022）。因此 `shared/` 新文件不得引用 node/DOM API——`glob.ts`、`agent-contract.ts` 都是纯逻辑。
2. **TS 的 `interface X extends Y` 不能放宽属性类型**：`AgentEventV2` 想把 `kind` 从联合类型扩成含 `"artifact"` 的更宽联合，直接 extends 会报 TS2430，必须写成 `extends Omit<AgentEvent, "kind">`。

### 与设计的一处偏离（有意）

方案 §3.2 写的是"候选为空 → 回落 round-robin"。实现上把回落**下沉到两处**：`AgentRegistry.candidates()` 做硬过滤，`CapabilityRouter` 在"打分后无候选"时再回落一次。这样即便某个 agent 的能力声明写得过窄，任务也不会卡死，最差退回今天的行为。

---

## 12. 实施记录 · P2（2026-09-19 已完成）

### 新增文件

| 文件 | 内容 |
| --- | --- |
| `electron/agents/manifest-schema.ts` | `parseAgentManifest` / `parseAgentManifestList` / `exampleManifest`，一次性报出全部校验问题 |
| `electron/agents/cli-agent.ts` | `CliAgentAdapter`：子进程型智能体（Codex / Trae / Claude Code），含 `probe` / `drain` / `abort` / `lastResult` / `killTree` |
| `electron/agents/http-bridge.ts` | `HttpBridgeAdapter`：HTTP 桥接型（WorkBuddy / MCP 网关），轮询事件流 + 四种鉴权 |
| `electron/agents/manifest-loader.ts` | `loadManifestDir`（容错加载 `agents.d/*.json`）、`buildAdaptersFromManifests`、`tokenResolver` |
| `src/components/AgentsPanel.tsx` | 智能体池面板：能力展示 / 健康检查 / 启用停用 / 注销 / 粘贴 manifest 注册 |
| `agents.d/README.md`、`agents.d/*.example.json` | 接入契约文档与两份示例 |
| `src/manifest.test.ts`、`src/cli-agent.test.ts`、`src/http-bridge.test.ts` | 42 个新用例 |

### 改动文件（仍为追加）

| 文件 | 改动 |
| --- | --- |
| `shared/agent-contract.ts` | 新增 `AgentEntry`（cli / http / builtin）与 `AgentManifest.source` |
| `electron/agents/registry.ts` | `register()` / `unregister()`（先 drain）/ `active()` / `activeAdapters()` / `setEnabled` 同步 manifest |
| `electron/engine/scheduler.ts` | 池改为实时读取 `registry.activeAdapters()`；新增 `forgetProbe()`；`findAdapter` 兜底未注册 agent |
| `electron/agents/index.ts` | `createAgentLayer` 支持 `manifests` / `manifestDir` / `promptDir`，返回 manifest 错误与跳过原因 |
| `electron/ipc.ts` | **长生命周期 agentLayer 单例**（动态注册需跨引擎重建存活）+ `agents:list / register / unregister / toggle / probe / example-manifest` |
| `electron/preload.ts`、`src/types.ts` | 6 个新 IPC 方法 + 渲染层类型 |
| `src/pages/SettingsPage.tsx`、`src/styles.css` | 挂载面板、加"按能力分派"开关、面板样式 |
| `headless/headless-main.ts` | `HeadlessSpec` 新增 `agents` / `manifestDir` / `agentRouter`，新事件 `agents` |

### 实测结果（可复现）

```bash
npx tsc -b && npx tsc -b tsconfig.electron.json && npx tsc -b tsconfig.headless.json
npx vitest run
npx vite build
```

| 项 | P1 后 | P2 后 |
| --- | --- | --- |
| vitest | 172 passed / 6 skipped | **231 passed / 6 skipped**（18 files） |
| tsc ×3 | 0 / 0 / 0 | **0 / 0 / 0** |
| vite build | 51 modules / 166.20 kB | **52 modules / 170.21 kB** |

端到端（headless，真实子进程与真实 JSONL 协议）：

```bash
echo '<spec>' | node dist-headless/headless/headless-main.js
# → {"type":"agents","agents":[{"id":"sensenova-api",...},{"id":"codex-cli","adapter":"cli","roles":["backend-dev"],"zoneGlobs":["src/**"]}]}
# 非法 manifest → {"type":"error","message":"agents 声明校验失败：[0] id \"bad id!\" …；[0] capabilities 必须是对象；[0] adapter 为 cli 时必须提供 entry"}
```

### 三个设计决定

1. **agentLayer 是单例**（`ipc.ts`）。`buildEngine` 每次执行都会重建引擎，若 layer 也跟着重建，运行时注册的智能体就会在下一轮消失。现在运行时注册的 adapter/manifest 存在 `dynamicAgents` 里，重建时自动回灌。
2. **`drain` 放在 adapter 上**，而不是注册表里。只有 adapter 自己知道它在跑哪些 run（`CliAgentAdapter` 有子进程表、`HttpBridgeAdapter` 有 poller 表），注册表只负责"先 drain 再摘牌"。
3. **能力声明优先级：manifest ▸ adapter 自报 ▸ legacy 默认**。这条决定了"给一个 v1 适配器补上声明"是安全的——它从 legacy 轮询切换到能力路由，而没有任何声明的池仍然逐字走老路径。

### 本轮踩到的测试坑（均已修）

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| `afterAll` 删临时目录 EPERM | Windows 下子进程仍持有该目录（`cwd` 指向它） | `fs.rmSync` 加 `maxRetries` + `try/catch`，清理失败不算测试失败 |
| 桥接用例 5s 超时 | 假 fetch 是固定回复，轮询永远返回 `running` | 假实现改成**有状态**（第一次 running，第二次 completed） |
| `abort` 断言失败 | `dispatch()` 是投递即返回，`remoteRunId` 尚未回填 | 测试里轮询等待 `/events` 请求出现后再 abort |

---

## 13. 实施记录 · P3（2026-09-19 已完成）

### 新增文件（`electron/sandbox/`）

| 文件 | 内容 |
| --- | --- |
| `path-policy.ts` | `PathPolicy`：绝对路径 / 穿越 / 越根 / 受保护路径 / 可写根 / zone / delegated 七级判定，返回带原因的结构化结论；glob 语义复用 `shared/glob` |
| `command-policy.ts` | `CommandPolicy`：程序白名单 + 危险程序黑名单 + shell 元字符 + 内联求值 + 危险 git 子命令 |
| `timeout-gate.ts` | `TimeoutGate`：deadline 与 idle 双看门狗，可注入时钟/定时器；`guard()` 把超时变成带标签的 `TimeoutError` |
| `circuit-breaker.ts` | `CircuitBreaker`：closed/open/half-open 三态，半开只放行一次探测；`statsProvider()` 直接喂给路由器打分 |
| `kill-tree.ts` | `killTree()` 从 `cli-agent` 上提为共享件（Windows 用 `taskkill /F /T`） |
| `index.ts` | 统一出口 |
| `src/sandbox-path.test.ts`、`src/sandbox-runtime.test.ts` | 51 个新用例（含 verifier 集成） |

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `electron/engine/verifier.ts` | **`shell: true` → `shell: false`**；命令先过 `CommandPolicy`，被拒则不 spawn；单命令超时（默认 300s）+ `killTree` 终止进程树 |
| `electron/agents/sensenova-api.ts` | `writeFiles` 的硬编码禁写表上提到 `PathPolicy`（`FORBIDDEN_TOP` 常量删除） |
| `electron/agents/cli-agent.ts` | 接入 `TimeoutGate`（deadline + idle，子进程无输出也会被收回）；`killTree` 改为 re-export |
| `electron/agents/http-bridge.ts` | 同样接入 `TimeoutGate`；每个事件 `touch()` |
| `electron/engine/scheduler.ts` | `admitBreaker()` 熔断准入（open 跳过、半开放行一次、被挡则换池内其它 agent）；批结束后 `record(ok)` |
| `electron/agents/index.ts` | `createAgentLayer` 统一创建断路器，并把 `statsProvider()` 注入路由器 —— 同一份状态既用于**打分**也用于**准入** |
| `electron/ipc.ts`、`headless/headless-main.ts` | 接线断路器与 verifier 事件日志 |

### 实测结果（可复现）

```bash
npx tsc -b && npx tsc -b tsconfig.electron.json && npx tsc -b tsconfig.headless.json
npx vitest run
npx vite build
```

| 项 | P2 后 | P3 后 |
| --- | --- | --- |
| vitest | 231 passed / 6 skipped | **280 passed / 6 skipped**（20 files） |
| tsc ×3 | 0 / 0 / 0 | **0 / 0 / 0** |
| vite build | 52 modules / 170.21 kB | **EXIT 0** |

端到端（在 **构建产物** `dist-electron/` 上跑真实 `verifyProject` 与 `PathPolicy`）：

```
REJECTED  : [沙箱] 命令被拒绝：命令被沙箱禁止：rm
INJECTION : [沙箱] 命令被拒绝：参数含 shell 元字符：build;
EVAL      : [沙箱] 命令被拒绝：拒绝内联求值参数 -e（把代码放进脚本文件再执行）
ALLOWED   : true | v22.22.2
PATH      : src/a.js             ALLOW
PATH      : .git/config          DENY(受保护路径：.git/config)
PATH      : .env                 DENY(受保护路径：.env)
PATH      : package.json         DENY(受保护路径：package.json)
PATH      : node_modules/x.js    DENY(受保护路径：node_modules/x.js)
PATH      : ../escape.js         DENY(拒绝路径穿越：../escape.js)
CMD       : git push -> git 子命令被沙箱禁止：git push
```

### ⚠️ 一个必须记录的事实：`shell: false` ≠ 没有 shell

方案 §5.2 说"始终 `shell:false`，杜绝注入"。实现时确认了它的**真实边界**：
在 Windows 上，`npm` / `yarn` / `gradle` 这类命令实际是 `.cmd` 垫片，libuv 的 `uv_spawn`
在 PATH 里命中 `.cmd`/`.bat` 时，会**自动改用 `%COMSPEC% /d /s /c` 执行**。也就是说
`spawn("npm", args, {shell:false})` 背后仍然有 `cmd.exe` 在重新解析参数串。

结论：`shell:false` 是必要条件，不是充分条件。真正兜住注入的是
**CommandPolicy 对每个参数做元字符拦截**（`;` `&&` `||` `|` 反引号 `$` `>` `<` 换行），
加上"拒绝内联求值"（`node -e` 会把白名单解释器变成任意代码执行器）。
这两条已写成注释与测试，避免以后有人把元字符检查当成多余。

### 三处有意的行为收紧（相对改造前）

| 项 | 之前 | 现在 | 理由 |
| --- | --- | --- | --- |
| `.git/**`、`.env`、`.env.*` | 可被模型写入 | 禁写 | 不属任何 zone 语义，且写坏 `.git` 会丢历史 |
| `npm run build; rm -rf /` 这类参数 | 会进 shell 拼接执行 | 拒绝并判验证失败 | 注入面 |
| `node -e "…"` 作为验证命令 | 可执行 | 拒绝（改用脚本文件） | 等价于任意代码执行，白名单形同虚设 |

需要时可通过 `CommandPolicyOptions`（`denyShellMetacharacters` / `denyEvalFlags` / `allow`）按项目放开，
但默认值是安全的一侧。

### 熔断与路由的联动方式

断路器**只有一份实例**（`createAgentLayer` 里创建），同时喂给两处：

- `CapabilityRouter({ stats: breaker.statsProvider() })` — 半开扣 15 分、成功率 ×20 加成；
- `Scheduler({ breaker })` — `allow()` 准入（open 直接跳过、半开只放一次探测）、批次结束 `record(ok)`。

这样做的好处是"降权"和"不再派活"不会出现两套判断标准。

---

## 14. 实施记录 · P4（2026-09-19 已完成）

### 新增文件

| 文件 | 内容 |
| --- | --- |
| `electron/sandbox/file-journal.ts` | `FileJournal`：begin 只 `stat` 全树记指纹，changed 只再 `stat` 一次做差集 —— **全程不读文件内容** |
| `electron/sandbox/snapshot-store.ts` | `SnapshotStore`：内容备份（真拷贝）+ `revert(sel)` + `commit`；不 spawn 任何进程，git 无法被牵扯进来 |
| `electron/engine/batch-guard.ts` | `BatchGuard`：把 journal + snapshot + 仲裁策略合起来，`begin()` 记基线、`settle()` 检测→仲裁→回滚→重写 outcomes |
| `src/sandbox-journal.test.ts` | 17 个用例（含性能对比、回滚实盘、四种仲裁模式） |

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `electron/engine/scheduler.ts` | `SchedulerOptions.guard`；`runBatch` 在 `begin()` 之后跑 jobs，结束时交给 `guard.settle()`；**未配置 guard 时仍走原 ZoneGuard 路径** |
| `shared/types.ts` | `ProjectSettings.arbitration`（默认 `revert-batch`）+ `ArbitrationMode` 类型 |
| `electron/agents/index.ts` | `snapshotRoot` 存在时装配 `BatchGuard`；`onEvent` 统一出口 |
| `electron/ipc.ts`、`headless/headless-main.ts` | 传 `snapshotRoot`（userData/snapshots、tmpdir）+ `arbitration`；`signature` 纳入 arbitration 以便改设置后重建 |
| `src/pages/SettingsPage.tsx`、`styles.css` | "zone 越权处置"下拉（回滚 / 隔离 / 保留 / 仅日志） |
| `shared/prompts.ts` | 分解提示词：zone 必须是具体目录，明确禁止用 `"."`；示例不再教模型写 `package.json` |

### 实测结果（可复现）

| 项 | P3 后 | P4 后 |
| --- | --- | --- |
| vitest | 280 passed / 6 skipped | **299 passed / 6 skipped**（21 files） |
| tsc ×3 | 0 / 0 / 0 | **0 / 0 / 0** |
| vite build | EXIT 0 | **EXIT 0** |

**性能**（在真实仓库 `ox-commander` 上跑构建产物，248 个文件，取 3 轮最优）：

```
FileJournal begin+changed   best= 8.2ms   all=[15.3,  9.7,  8.2]
ZoneGuard  snapshot+diff    best=47.5ms   all=[56.5, 47.5, 47.9]
speedup = 5.79x
```

方案的验收线是 ≥3×，实测 **5.79×**。文件数越多差距越大：ZoneGuard 是 O(读全文)，FileJournal 是 O(stat)。

### 🔴 一个差点写错的地方：硬链接不能当备份

最初的实现为了省 IO，用 `fs.linkSync` 做备份（"瞬间完成、不占额外空间"）。测试立刻打脸：

```
SnapshotStore > backs up, then restores modified files…
AssertionError: expected 'after' to be 'before'
```

原因是硬链接共享 inode，而 agent 改文件用的是最常见的方式 —— `fs.writeFileSync(原路径, 新内容)`，它对**同一个 inode 原地 truncate 再写**。于是"备份"跟着一起被改，回滚就还原出了新内容。

结论：备份必须是**真拷贝**（`copyFileSync`）。这类"看起来更聪明的 IO 优化"在回滚场景里是静默错误的来源 —— 它不会报错，只会在需要回滚的那一天失效。已写进注释与测试（`snapshot-store.ts` 现在有 3 条硬规则，第 2 条就是这条）。

### 关于"同文件竞写"的诚实交代

方案 §3.3 列了三类冲突，P4 只实现了两类：`unauthorized-write`、`shared-drift`。

第三类 **`concurrent-write`（两个 run 写同一文件）在当前编排下不可达**：`planBatches` 保证批内 zone 互斥，批与批之间串行。也就是说，一个批里不可能有两个任务同时有资格写同一个文件；真正会发生的是**越权写**，而那正是 `unauthorized-write` 处理的。

因此没有实现 `ResultMerger` 的 owner-wins 策略 —— 处理一个不可能发生的情况，比明确说出"它不可能发生"更糟。这条判断写进了 `batch-guard.ts` 的注释，并有一条测试钉住这段说明，防止它被误当成遗漏。

### 回滚的可信边界

| 情形 | 回滚结果 |
| --- | --- |
| 越权**新建**文件 | 删除（基线里没有它） |
| 越权**修改**既有文件 | 从备份恢复 |
| 备份超出预算（`maxFiles`，默认 5000） | 该文件记为 `skipped`，**绝不删除**（可能本来就存在） |
| 只回滚选中路径 | 只回滚越权路径，zone 内的正常改动保留（有测试钉住） |

最后一条很重要：越权回滚不应该顺手把任务合法的产出也抹掉。

---

## 15. 实施记录 · P5（2026-09-19 已完成）

### 新增文件

| 文件 | 内容 |
| --- | --- |
| `electron/audit-log.ts` | `AuditLog`：按天 + 按大小轮转的 JSONL 追加写、`read({phase, limit})` 回读、`classifyFailure()` 失败粗分类 |
| `src/audit-log.test.ts` | 12 个用例（落盘 / 轮转 / 回读 / 截断 / 并发闸 / run 归因） |

### 改动文件

| 文件 | 改动 |
| --- | --- |
| `electron/engine/scheduler.ts` | `DispatchOutcome` 加 `agentId` / `durationMs` / `errorClass`；**平台级并发闸** `maxParallelRuns`（默认 4）；`onRunStart` / `onRunComplete` 回调；`activeRuns()` |
| `electron/engine/orchestrator.ts` | `outcomes` 类型换成 `DispatchOutcome`（否则额外字段在透传时被静默丢弃）；`onTaskOutcome` 追加**可选**第 4 参 meta |
| `electron/ipc.ts` | 审计落 `userData/audit/`；register/unregister/toggle 记 `agent-change`；新增 `agents:stats`、`audit:recent`、`audit:files` |
| `electron/preload.ts`、`src/types.ts` | 3 个新 IPC + `AgentCircuitStats` / `AuditRecordView` / `TaskView` 三字段 |
| `src/store.ts`、`src/pages/BoardPage.tsx` | 任务行显示 agent / 耗时 / **错误类型（中文化）**；失败分类常量表 |
| `src/components/AgentsPanel.tsx` | 每个智能体显示熔断状态、成功/失败计数、成功率、剩余冷却 |
| `headless/headless-main.ts` | 新事件 `run {phase, taskId, agentId, ok, durationMs, errorClass}` —— headless 没有 userData，归因交给宿主持久化 |

### 实测结果（可复现）

| 项 | P4 后 | P5 后 |
| --- | --- | --- |
| vitest | 299 passed / 6 skipped | **311 passed / 6 skipped**（22 files） |
| tsc ×3 | 0 / 0 / 0 | **0 / 0 / 0** |
| vite build | EXIT 0 | **EXIT 0** |

端到端（构建产物 `dist-electron/` 上真实写盘 + 回读）：

```
records  : 4
phases   : run-start, run-end, batch-guard, agent-change
run-end  : {"ts":"2026-09-19T05:27:04.694Z","phase":"run-end","taskId":"t1","agentId":"codex-cli",
            "ok":false,"durationMs":1234,"errorClass":"timeout","detail":"timeout"}
files    : audit-2026-09-19-000.jsonl
```

### 一个容易被忽略的透传坑

`OrchestratorEngine` 里 outcomes 原本声明为
`Array<{ taskId: string; ok: boolean; logDigest: string }>`，Scheduler 返回再多的字段也会在这一层被**静默裁掉**。
改成 `DispatchOutcome[]` 才让 `agentId` / `errorClass` / `durationMs` 真正到达 UI。
教训：给结构化结果加字段时，别忘了检查中间的**类型声明**是不是窄的 —— 它不会报错，只会丢数据。

### 三处与方案的偏离（都有理由）

| 方案 | 实施 | 理由 |
| --- | --- | --- |
| P5 新增 `src/pages/AgentsPage.tsx` | 不新建页，增强 P2 已落在设置页的「智能体池」面板 | 同一个面板建两处是重复；缺的是状态展示（熔断/成功率），已补齐 |
| P5 展示 "lease" 状态 | 未做，改为展示熔断 + 并发闸 | `LeaseTable` 的 zone 互斥语义已由 `planBatches`（批内 zone 唯一）+ 批间串行覆盖，跨批并发不存在 → lease 没有可观测的状态 |
| 审计四元组 `begin/terminal/changes/revert` | `run-start` / `run-end` / `batch-guard` / `agent-change` | 回滚事件与 run 终态同批发生，合并进 `batch-guard` 更符合实际时序；`agent-change` 覆盖注册/注销/启停 |

### 关于"并发控制"的补充

P3 方案里写的 `LeaseTable` 没有实现（理由见上表），P5 补上的是**另一层**并发控制：
平台级 `maxParallelRuns`（默认 4，`0` = 不限）。

为什么需要它：批内 zone 互斥只保证"不同目录的任务能并行"，但一个 10 任务的批会在 3 密钥的
Failover 池上瞬间打出 10 个并发请求 —— 那不是"并行更快"，那是把配额烧成 429。
并发闸用 FIFO 信号量实现，槽位在释放时**转移**给下一个等待者而不是先减后加（避免计数漂移），
并有测试用"可控 adapter"观测并发峰值确实是 2 而非 4。

---

## 16. 实施记录 · P6（2026-09-19 已完成）

### 交付物

| 文件 | 角色 |
| --- | --- |
| `headless/protocol.ts`（新） | **契约**：`HeadlessSpec` / `ParsedSpec` / `HeadlessEvent` 类型、`parseSpec()` 校验与默认值（纯函数，不碰 fs/process 输出） |
| `headless/run-spec.ts`（新） | **执行**：`runSpec(spec, io)`，LLM / 智能体池 / 验证器全部可注入 → 可测 |
| `headless/headless-main.ts`（重写） | **胶水**：读 stdin → parseSpec → runSpec → 设退出码（30 行） |
| `docs/headless-protocol.md`（新） | 对外协议文档：字段表、事件表、退出码、兼容承诺、宿主消费示例 |
| `src/headless-protocol.test.ts`（新） | 17 个用例：解析、默认值、兼容基线、全流程事件序列、退出码、conflict 事件 |

改造前 `headless-main.ts` 是一个 230 行的 IIFE 脚本：读 stdin、拼引擎、跑、写 stdout 全混在一起，
**没有任何一条测试能碰它**。现在是"契约 + 执行 + 胶水"三层，执行层用注入的假 LLM/假 adapter/假验证器
跑完整流程 —— 协议第一次有了可执行的证据。

### 新增能力

- **`hello` 事件**：含 `protocolVersion`、`projectRoot`、`arbitration`、`agentRouter`、`warnings[]`。
  宿主用它做版本握手，而不是靠猜。
- **`conflict` 结构化事件**：`{kind, paths[], remedy}`。此前越权只以中文日志出现，宿主只能做字符串匹配。
- **未知字段降级为 warning**：宿主可以先用上新字段而不被旧 runner 拒绝。

### 测试暴露的一个真问题：退出码 2 是死代码

写"验证不过应当 exit 2"的用例时，实测拿到的是 `1`。追下去发现：

`OrchestratorEngine.execute()` 在验证失败时**永远抛异常**，而 `runSpec` 里
`return report.passed ? 0 : 2` 的 `2` 分支根本走不到 —— 只有 `passed === true` 才会执行到那行。

更细一层：抛出的是哪种异常取决于"宿主是否提供了 escalation 决策回调"。
Electron 端总提供（弹面板问人），headless 端原本也总提供 → 那条 `throw new VerificationExhaustedError`
的路径**从来不会被执行**。

修法不是改断言，而是让语义成立：
1. `VerificationExhaustedError` 成为具名错误类型（不再是无从分辨的 `Error`），message 保持原文；
2. `escalationPolicy` 增加 `"exhaust"`：该策略下 runner **不提供**决策回调，引擎随即走"预算耗尽"路径；
3. `runSpec` 捕获该类型 → emit `{type:"error", exhausted:true}` → 退出码 2。

于是四个策略各有清晰语义：`abort`/`skip`/`redispatch_once` → 1（做过干预），`exhaust` → 2（预算真花完了）。

> 教训：退出码、状态字段这类"写在那里没被验证过"的分支，八成从来没有生效过。
> 测试的价值不在于证明它对，而在于逼你发现它根本没跑。

### 实测结果（可复现）

| 项 | P5 后 | P6 后 |
| --- | --- | --- |
| vitest | 311 passed / 6 skipped | **328 passed / 6 skipped**（23 files） |
| tsc ×3 | 0 / 0 / 0 | **0 / 0 / 0** |
| vite build | EXIT 0 | **EXIT 0** |

二进制层端到端（真实 `dist-headless/headless/headless-main.js`，无密钥环境）：

```
--- 非法 JSON         exit=1  {"type":"error","message":"stdin 不是合法 JSON：Expected property name ..."}
--- 缺 projectRoot    exit=1  {"type":"error","message":"projectRoot 必须是非空字符串"}
--- 旧格式 + 未知字段  exit=1
    {"type":"hello","protocolVersion":"ox-headless/1","projectRoot":"D:\\ox\\ox-commander",
     "llmProvider":"sensenova","arbitration":"revert-batch","agentRouter":true,
     "warnings":["未知字段 \"futureFlag\" 已忽略"]}
    {"type":"log","text":"[protocol] 未知字段 \"futureFlag\" 已忽略"}
    {"type":"agents","agents":[{"id":"sensenova-api",...}]}
    {"type":"stage","stage":"PRD"}
    {"type":"error","message":"failover client has no groups"}   ← 无密钥，符合预期
```

最后一条尤其说明问题：旧 spec（只含 `requirement` / `projectRoot` / `maxRepairRounds` /
`escalationPolicy`）+ 一个它不认识的字段，**照常跑到 PRD 阶段**，新字段全部取默认值。

### 六阶段总体进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 基线固化 | ✅ 124 passed / 6 skipped |
| P1 | 能力契约 + 注册表 + 能力路由 | ✅ 172 passed |
| P2 | CLI / HTTP 适配器 + 注册注销 + agents.d | ✅ 231 passed |
| P3 | 沙箱：路径 / 命令 / 超时 / 熔断 | ✅ 280 passed |
| P4 | FileJournal + 快照回滚 + 越权仲裁 | ✅ 299 passed |
| P5 | 审计 JSONL + run 归因 + 并发闸 | ✅ 311 passed |
| P6 | headless 协议对外化 | ✅ **328 passed** |

累计：**124 → 328 个用例**（+204），`tsc ×3` 与 `vite build` 全程保持绿，
旧用例一条未改，所有改动均为追加 + 可选参数 + 默认值切换。

---

## 17. 收口（2026-09-19）

六阶段交付后回头补三件欠账。

### 17.1 门禁本身有个洞

`package.json` 原本是：

```json
"typecheck": "tsc -b && tsc -b tsconfig.electron.json"
```

**少了 headless 那套 tsconfig**。P0 之后我每轮都手动跑三套，所以这个洞一直没暴露 ——
一旦换成"跑 `npm run verify` 就完事"，headless 的类型错误会直接溜进产物。

现在：

```json
"typecheck": "tsc -b && tsc -b tsconfig.electron.json && tsc -b tsconfig.headless.json",
"verify": "npm run typecheck && npm test && npm run build && npm run build:headless"
```

`npm run verify` 是唯一入口：类型（三套）→ 测试 → 桌面构建 → headless 构建。

> 门禁的价值当场兑现：第一次跑 `verify` 就报出
> `src/store.ts(208,23): error TS2304: Cannot find name 'TaskView'` ——
> 那是本节改动里漏掉的一个 import。手跑时我"以为"没问题，门禁不这么想。

### 17.2 补上唯一没被覆盖的层：renderer 事件映射

P0–P6 有 328 个用例，全部集中在 main 进程侧。**`src/store.ts` 的 `handleEvent` 一条测试都没有** ——
而它正是引擎算出来的所有信息（agent 归因、失败分类、耗时）进入看板的唯一通道；
P5 已经因为"中间层窄类型"丢过一次数据，同类风险依然敞着。

新增 `src/store.test.ts`（17 例），直接用 zustand 的公开接口驱动，不需要渲染 React：

- 事件 → state 映射（stage / log / taskStatus / taskOutcome / verification / escalation）；
- 日志缓冲上限（500）；
- 未知事件类型、缺 `type`、非字符串载荷都不该抛出；
- 对没见过的 taskId 的事件应被忽略；
- **归因字段（`agentId` / `errorClass` / `durationMs`）必须完整穿透**。

### 17.3 测试抓到的真 bug：成功后错误类型残留

写上面第 5 组用例时，断言直接失败：

```
AssertionError: expected 'protocol' to be undefined
  await emit({ ok: false, errorClass: "protocol" });
  await emit({ ok: true,  agentId: "trae-cli" });
  expect(t.errorClass).toBeUndefined();   // ← 实际仍是 "protocol"
```

`store.ts` 只在失败分支写 `errorClass`，成功分支不动它。后果不是崩，而是**看板骗人**：
一个任务重修成功后显示绿色状态，旁边却挂着"错误类型：协议/输出格式"。

修法是显式清除，并把这个行为写进注释：

```ts
const next: TaskView = { ...prev, failureDigest: …, … };
if (ok) delete next.errorClass;          // 重修成功必须清掉旧的错误分类
else next.errorClass = errorClass ?? "unknown";
```

这是在数据流里找到的**第二个**同类问题（第一个是 P5 的窄类型裁字段）。
两者的共同点：都不报错，只是让界面与现实不一致。

### 17.4 最终验收

```
$ npm run verify
> tsc -b && tsc -b tsconfig.electron.json && tsc -b tsconfig.headless.json
> vitest run
   Test Files  23 passed | 1 skipped (24)
        Tests  345 passed | 6 skipped (351)
> vite build                    ✓ 52 modules / 171.89 kB
> tsc -b tsconfig.headless.json ✓
EXIT 0
```

| 指标 | 改造前 | 最终 |
| --- | --- | --- |
| 测试用例 | 124 passed / 6 skipped | **345 passed / 6 skipped** |
| 测试文件 | 11 | **24** |
| 类型检查 | 2 套 tsconfig | **3 套**（补齐 headless） |
| 聚合门禁 | 无 | **`npm run verify`** |
| 旧用例改动 | — | **0 条** |

### 17.5 还剩什么没做（诚实清单）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 桌面 GUI 交互 | 仅类型 + 构建 + store 逻辑验证 | Electron 窗口需要人眼看；面板与看板的事件链路已有测试，但"点按钮长什么样"没测 |
| 真 LLM 端到端 | 未跑（无密钥环境） | `sensenova.smoke.test.ts` 的 6 个用例需要 `SENSENOVA_API_KEY`，默认 skipped |
| 密钥迁 OS keychain | 未做 | `keys-store.ts` 仍是明文 JSON（方案 P4 列为可选） |
| CI | 未加 | 项目当前无 `.github/`；有 CI 后把 `npm run verify` 接上去即可 |
| `maxParallelRuns` 在 Electron 侧可配 | 未做 | 目前只有 headless 能通过 spec 覆盖，桌面端固定 4 |

---

## 18. 剩余项收口（2026-09-19）

### 18.1 桌面端并发上限可配

`maxParallelRuns` 原是 headless 独占的 spec 字段，桌面端写死 4。现在进了 `ProjectSettings`（默认 4，`0` = 不限）：
设置页加了数字输入，`ipc.ts` 装配时传给 Scheduler，headless 的默认值改为引用 `DEFAULT_SETTINGS`（单一来源，不再各自硬编码 4）。

### 18.2 密钥进 OS keychain

`keys-store.ts` 从"JSON 里存明文"改为**可插拔加密 + 自动迁移**：

| 关注点 | 做法 |
| --- | --- |
| 加密来源 | `SecretCrypto` 接口 + `createSafeStorageCrypto(electron.safeStorage)` —— DPAPI / Keychain / libsecret |
| 可测性 | crypto **注入**而非 import，测试用假实现验证往返、迁移、回退，不需要 Electron 运行时 |
| 文件格式 | v1 扁平明文 → v2 `{version:2, keys:{ENV:{value,enc}}}`；**读 v1 时自动识别**，下次写入即迁移 |
| 平台无 keychain | 回退明文，并在设置页如实告知（不假装加密了） |
| 换机器 / 钥匙串重置 | 解密失败视为"未配置"，不让设置页崩掉 |
| 旧数据不丢 | v1 里的其它键在迁移后原样保留（只是仍为明文），重新保存才升级 |

设置页会显示当前状态：`已通过系统钥匙串加密存储` 或 `当前系统钥匙串不可用，密钥以明文保存`，
以及"其中 N 条为旧版明文，重新保存后会自动加密"。

新增 `src/keys-store.test.ts`（15 例），覆盖：加密往返、磁盘上**看不到明文**、无 keychain 回退、
env 优先、v1 读取与迁移、解密失败降级、损坏文件与 BOM 容错、safeStorage 适配器。

### 18.3 CI 门禁

新增 `.github/workflows/verify.yml`：矩阵 `ubuntu-latest` + `windows-latest`
（Windows 必须跑：沙箱的 `taskkill` 分支与 CLI 适配器的 `.cmd` 垫片在 Linux 上根本不会执行），
步骤就是 `npm ci` + `npm run verify` —— **薄到不含任何自己的逻辑**，否则门禁就漂移出 `package.json` 了。

`env.ELECTRON_SKIP_BINARY_DOWNLOAD: 1`：CI 上不需要那 ~100 MB 的 Electron 二进制，只需要类型定义。

> 诚实标注：YAML 已用 `js-yaml`（node_modules 里现成）**解析验证过**，
> 解析出的触发条件、矩阵、步骤、env 均符合预期；但**没有在真实 GitHub Actions 上跑过** ——
> 那需要把仓库推上去。

### 18.4 最终验收

```
$ npm run verify
> tsc -b && tsc -b tsconfig.electron.json && tsc -b tsconfig.headless.json
> vitest run       Test Files 24 passed | 1 skipped (25)
                   Tests      360 passed | 6 skipped (366)
> vite build       ✓ built in 698ms
> tsc -b tsconfig.headless.json  ✓
EXIT 0
```

> 门禁第二次兑现价值：加上 keychain 改动后第一次 `verify` 又报出
> `electron/keys-store.ts(148,11): error TS6133: 'stored' is declared but its value is never read`
> —— 重构 `status()` 时留下的死变量。手跑很可能会漏。

| 指标 | 改造前 | 最终 |
| --- | --- | --- |
| 测试用例 | 124 passed / 6 skipped | **360 passed / 6 skipped** |
| 测试文件 | 11 | **25** |
| 类型检查 | 2 套 tsconfig | **3 套** |
| 聚合门禁 | 无 | **`npm run verify`** |
| CI | 无 | **GitHub Actions（双平台矩阵）** |
| 密钥存储 | 明文 JSON | **OS keychain（不可用时明确回退）** |

### 18.5 仍然没做的（以及为什么）

| 项 | 原因 | 需要什么 |
| --- | --- | --- |
| 真 LLM 端到端 | 无 `SENSENOVA_API_KEY`，6 个 smoke 用例保持 skipped | 一个可用密钥；`DSH_LIVE` 式的开关已就位（`sensenova.smoke.test.ts`） |
| 桌面 GUI 交互 | Electron 窗口需要渲染环境与人工判断；本轮把能自动化的那一层（事件映射）补上了 | 要么人工点一遍，要么引入 Playwright 的 Electron driver（新依赖，~100 MB） |
| 在真实 CI 上跑一次 | 需要把仓库推到 GitHub | 推送后首跑即可确认 |

---

## 19. 真 LLM 端到端（2026-09-19，用真实 API Key 跑通）

单元测试全绿不等于系统能跑。这一节是拿真密钥、真模型、真子进程跑完整交付的记录 ——
**它抓出了两个 380 个单测都没发现的缺陷**。

### 19.1 方法

1. 在临时目录搭一个真能验证的最小工程（`package.json` + `ox-scripts/build.js`（语法检查）+ `ox-scripts/test.js`（跑 `node --test`））；
2. 用 **构建产物**（`dist-headless/headless/headless-main.js`）而不是源码跑，`stdin` 递 spec；
3. 需求写死可验证的规格：「实现 `src/duration.js` 的 `formatDuration(seconds)`，把秒格式化成 `H时M分S秒`；在 `tests/duration.test.js` 用 `node:test` 写至少 3 个用例覆盖 0 / 跨分钟 / 跨小时」；
4. 解析 stdout JSONL，检查阶段序列、run 归因、verification、冲突、退出码，并打印模型真正落盘的文件。

Key 只走环境变量，不写进任何文件、文档或日志。

### 19.2 三次运行

| | 第 1 次 | 第 2 次 | 第 3 次（修复后） |
| --- | --- | --- | --- |
| 退出码 | 2 | 2 | **0 ✅** |
| 阶段 | 停在与验证死循环 | 同上 | **PRD→PLANNING→DEVELOPMENT→VERIFICATION→DELIVERY→DONE** |
| 越权冲突 | **3 次**（`unauthorized-write`） | 0 | 0 |
| `build` 步骤 | `exitCode: null` | `exitCode: null` | **`exitCode: 0`** |
| 模型产物 | 全被回滚删除 | 保留但验证不过 | **2 个文件，验证全过** |
| run 归因 | 有 | 有 | 有（agentId / durationMs / ok） |

第 3 次的终态事件：

```json
{"type":"verification","passed":true,"results":[
  {"kind":"build","ok":true,"exitCode":0},
  {"kind":"typecheck","ok":true,"exitCode":0},
  {"kind":"test","ok":true,"exitCode":0}]}
{"type":"done","passed":true, "report":{... "logDigest":"TAP version 13\n# Subtest: formatDuration returns 0时0分0秒 for 0 seconds\nok 1 - formatDura…"}}
```

模型落盘的代码（它自己写的，未加任何干预）：

```js
// src/duration.js
module.exports = { formatDuration };
function formatDuration(seconds) {
  const H = Math.floor(seconds / 3600);
  const M = Math.floor((seconds % 3600) / 60);
  const S = seconds % 60;
  return `${H}时${M}分${S}秒`;
}
```

### 19.3 缺陷 A：Windows 上 `npm run …` 根本起不来（P3 引入的回归）

```
spawn("npm",     ["run","build"], { shell: false })  →  ENOENT: spawn npm ENOENT
spawn("npm.cmd", ["run","build"], { shell: false })  →  EINVAL      (Node ≥18)
```

两件事我原先都判断错了：

1. **libuv 不会把 `npm` 解析成 `npm.cmd`** —— 所以我以为"`shell:false` 只是更安全"是错的，它是**直接失效**；
2. Node ≥18 出于安全（CVE-2024-27980）**拒绝** `shell:false` 直接执行 `.cmd`/`.bat`。

于是 P3 那次"`shell:true` → `shell:false`"的安全加固，把 Windows 上**默认的
`npm run build/typecheck/test` 全部变成了静默失败**：`exitCode: null`、零输出、只当成"验证没过"，
然后重跑重修轮，永远救不回来。

**为什么 380 个单测没发现**：测试里验证命令都用 `process.execPath`（直接跑 `.js`），
从来没用过 `npm` —— 被测路径和真实路径不是同一条。这是"测试通过 ≠ 系统可用"的教科书案例。

**修法**（`electron/sandbox/spawn-plan.ts`）：把 `cmd.exe /d /s /c` 包装做成显式的规划步骤：

```ts
// posix / windows .exe → 原样，shell:false
// windows .cmd/.bat   → %COMSPEC% /d /s /c "<shim> <args…>"，windowsVerbatimArguments
```

安全性论证是**成对**的，所以写在模块注释最上面：
`CommandPolicy` 必须先拒绝元字符（`; & | ` $ < >` 与换行）→ 才允许走到 `buildSpawnSpec()`。
`planSpawn()` 把这两步合并，`CommandPolicy.assert()` 在前，包装在后。

### 19.4 缺陷 B：PATH 查找顺序让"不可执行的文件"遮蔽了真的 `.cmd`

修完 A 之后 **`build` 依然 `exitCode: null`**，报的是：

```
spawn failed (windows direct): ENOENT … \.workbuddy\binaries\node\versions\22.22.2-3\npm
```

PATH 里存在一个**无扩展名的 `npm`**（Node 发行版里的 Unix shell 脚本，在 Windows 上不可执行），
而我的查找顺序是 `["", ".exe", ".cmd", …]` —— 空扩展名排第一，于是先命中它，
`needsCmdWrapper()` 看到它不是 `.cmd`/`.bat`，判定"直接跑"，然后 ENOENT。
真正的 `npm.cmd` 就在 PATH 后面，永远等不到机会。

**修法**：Windows 上严格按 `PATHEXT` 顺序查找，且**不接受无扩展名的命中**：

```ts
const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(lower).filter(Boolean);
for (const dir of dirs) for (const ext of exts) if (isFile(dir/command+ext)) return …;
return command;   // 找不到就交给 spawn 报错，而不是返回一个不可执行的路径
```

这不只是本机环境的问题：**任何 PATH 里带 Unix 工具链的 Windows 用户（Git Bash、MSYS2、WSL 混装）
都会踩到**，而且表现同样是"命令静默失败"。

### 19.5 缺陷 C：zone 语义把"模块"当成了"目录"

第 1 次运行里，模型把任务 zone 写成 `src/duration` / `tests/duration`（它的意思是"我负责这个模块"），
而平台按**目录前缀**判定，于是 `src/duration.js` 被判为**越权**：

```
{"type":"conflict","kind":"unauthorized-write","paths":["src/duration.js","tests/duration.test.js"],"remedy":"revert"}
```

回滚 → 文件消失 → 验证失败 → 重修 → 再越权 → 三轮全废（退出码 2）。
模型写的东西完全正确，是平台的判定太窄。

**修法**：`isPathInZone()` 接受三种形态 —— 根（`""`/`"."`）、目录（前缀 + `/`）、
**模块（`src/duration` 拥有 `src/duration.js`、`src/duration.test.js`）**，
同时保持有界：`src/duration-extra.js`（横杠）与 `src/duration/sub/x.js`（子目录）**不属于**它。

顺手把 zone 判定**收敛到一份实现**（`shared/glob.ts`）：改动前它有**三份拷贝**
（`file-journal.ts`、`zone-guard.ts`、`routing.ts`），这正是"两套实现必然漂移"的隐患。

### 19.6 真实限流也被观察到了

冒烟阶段拿到货真价实的 429：

```
HttpLlmError: LLM HTTP 429: {"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}
```

它同时验证了两件事：三把 key 属**同一账号**、共享 rpm 配额（单 key 直连会直接失败），
以及 failover 客户端在这种情况下的价值 —— 后面几次全链路调用都靠它换组合顶过去了。

另外第 2 次运行中熔断器也真实生效了一次：

```
[breaker] sensenova-api 连续失败 3 次，熔断 60s
[router]  t3 → sensenova-api · score=133 · quality=0.67(+13)   ← 成功率随失败下滑
```

### 19.7 结论

| | 单测（380 passed） | 真 e2e |
| --- | --- | --- |
| 能发现"命令起不来" | ❌ 测试用 `node` 不用 `npm` | ✅ |
| 能发现 PATH 遮蔽 | ❌ 用的是注入的 env | ✅ |
| 能发现 zone 语义过窄 | ❌ 用例是我按自己理解写的 | ✅ |
| 能发现限流/熔断真实行为 | ❌ 全是 mock | ✅ |
| 成本 | 秒级、离线、可重复 | 分钟级、要配额、依赖外部服务 |

**两者都需要，且不能互相替代**：单测保证"我理解的逻辑是对的"，真 e2e 保证"真实世界跑得通"。
这次的分工很典型 —— 单测 380 条全绿，系统在 Windows 上连 `npm run build` 都起不来。

> 顺带修掉一个可观测性缺口：`verification` 事件原先只带 `{kind, ok, exitCode}`，
> 失败时宿主看不到原因（`exitCode: null` 无法区分"测试没过"和"命令没起来"）。
> 现在失败步骤会带上 `logDigest`（截断 400 字符）。

---

## 20. 多 API 线路池（2026-09-19，真 API 验证）

需求：**商汤 12 种组合**（3 密钥 × 4 模型），**再加 AMD**；遇到 429 就切组合，**多个 API 同时工作**。

### 20.1 池怎么建

一个关键设计选择：**不是**把 provider 客户端套成一层层 failover，
而是把所有线路**摊平进同一张故障转移表**：

```
sensenova:KEY1 × {flash, 6.8-flash-lite, v4-pro, glm-5.2}   ← 4 条
sensenova:KEY2 × {…}                                        ← 4 条
sensenova:KEY3 × {…}                                        ← 4 条
amd-radeon:AMD_API_KEY × {MiniCPM5-2B}                      ← 1 条
                                                             ── 13 条，共享一张 cooldown 表
```

于是"切组合"的粒度天然正确：某条线路 429 → 只冷却它自己 → 下一次尝试可能落到
同一 key 的另一个模型、另一个 key，或另一个 provider —— 一次 `chat()` 调用内部完成，
调用方（引擎/编排层）对此完全无感。

新增/改动：`SENSENOVA_MODELS` 扩到 4 个（12 组合）、`createMultiProviderFailover()` /
`buildLlmPool()`、`ProjectSettings.llmPool`（默认 `["sensenova","amd-radeon"]`）、
设置页新增「线路池」区块（勾选参与方 + 池内所有 provider 的密钥输入框）。

### 20.2 一个跨 provider 才暴露的问题：401 会拖垮整池

原实现的权衡是"同一个 provider 内认证失败 ⇒ 凭据全错 ⇒ 立刻终止，别浪费时间"。
放进跨 provider 池后这条变成了毒药：**AMD 的 key 缺一个，商汤 12 条健康线路全部不可用**。

修法：`failFastOnAuth` 变成可配置，且**按池的 provider 数量自动推导** ——
单 provider 保持 fail-fast（用户配置错了要立刻知道），多 provider 则只冷却出错的那条线路。

真实验证（场景 B）确认：AMD key 换成垃圾值，请求仍然 1.3s 内成功。

### 20.3 第二个问题：认证失败不该等 backoff

场景 C/D 第一次跑出来是 **84s / 74s** —— 因为每条失败线路后都睡了 backoff。
但 401 不是限流，**等多久都不会变好**。

改成认证失败直接 `continue`（跳过 backoff），结果：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 全坏池失败耗时 | 73.9s | **1.07s**（快 ~70×） |
| 仅 AMD 有效 | 84.6s 后失败 | **1.68s 成功** |

### 20.4 第三个发现：AMD 端点上根本没有 DeepSeek

配置文件里写的是 `DeepSeek-V4-Flash`，实测：

```
POST chat model="DeepSeek-V4-Flash"  → 400 {"message":"Requested model DeepSeek-V4-Flash not supported"}
GET  /models                         → 200, 2 models:
     MinerU2.5-Pro     out=["ocr"]     ctx=0
     MiniCPM5-2B       out=["text"]    ctx=131072
```

该端点只提供两个模型，其中只有 `MiniCPM5-2B` 能用于对话（`MinerU2.5-Pro` 的输出模态是
`ocr`）。所以 provider 的 `defaultModel` 改成 `MiniCPM5-2B`，并把实测结论写进注释 ——
**模型名是外部事实，不能照抄文档**。

同时把它排在池的第二位：2B 模型当兜底合适，当主力不合适。

### 20.5 真实验证结果

四个场景（每次真实调用，key 只走环境变量）：

| 场景 | 池内线路 | 结果 | 耗时 |
| --- | --- | --- | --- |
| A · 全部真实 key | 13 | ✅ `model=deepseek-v4-flash` | 1.33s |
| B · AMD key 换成垃圾 | 13 | ✅ 商汤照常（坏 provider 只冷却自己） | 1.28s |
| C · 商汤三把 key 全换成垃圾 | 13 | ✅ `model=self-dploy/MiniCPM5-2B`（12 条商汤全 401 后 AMD 兜底） | 1.68s |
| D · 全部垃圾 | 13 | ✅ 逐条试完再报 401（不 fail-fast） | 1.07s |

**并发**（这是"多个 API 同时工作"最有说服力的一条）：

```
### AMD 坏 + 商汤真 · 并发 4
concurrent=4  wall=1777ms
  #0 OK  model=sensenova-6.8-flash-lite
  #1 OK  model=deepseek-v4-flash
  #2 OK  model=sensenova-6.8-flash-lite
  #3 OK  model=sensenova-6.8-flash-lite
summary: 4/4 succeeded | distinct models=["sensenova-6.8-flash-lite","deepseek-v4-flash"]

events: sensenova:SENSENOVA_API_KEY#0 失败（429 rpm exhausted），冷却 30s
        sensenova:SENSENOVA_API_KEY#0 失败（429 rpm exhausted），冷却 30s
        sensenova:SENSENOVA_API_KEY#0 失败（429 rpm exhausted），冷却 30s
```

三个并发请求撞上 `429 rpm exhausted`，**自动切到其它线路，4 个全部成功** ——
这就是"遇到 429 切换组合"的现场证据，而且整体墙钟 1.78s（串行约需 4×）。

### 20.6 最终数字

| 项 | 值 |
| --- | --- |
| 测试 | **399 passed / 6 skipped**（27 files） |
| 门禁 | `npm run verify` EXIT 0 |
| 线路池 | 13 条（商汤 12 + AMD 1），跨 provider 共享一张 cooldown 表 |
| 池内可配置 | 设置页可勾选参与方；池内所有 provider 都有密钥输入框 |









