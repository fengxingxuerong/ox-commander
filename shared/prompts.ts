import type { PrdDocument } from "./types";

export function buildPrdPrompt(userRequirement: string): string {
  return `You are the planning brain of OxCommander, an orchestrator that decomposes software projects and dispatches them to coding agents.

Convert the user's requirement below into a structured PRD.

Respond with ONLY a JSON object (no markdown fences) matching:
{
  "goal": string,
  "features": string[],
  "techStack": string[],
  "acceptanceCriteria": string[]
}

Rules:
- goal: one sentence describing the deliverable.
- features: 3-8 concrete, independently verifiable features.
- techStack: MUST stay inside the execution sandbox: Node.js (CommonJS modules), Node built-in modules and the built-in node:test runner only. NEVER propose Python, browsers/bundlers, or external npm packages — the workspace has no network installs and verification runs npm scripts backed by node only.
- acceptanceCriteria: objective, machine-checkable criteria (build passes, tests pass, feature X works). Tests must be runnable via "npm test" with test files under tests/*.test.js using require("node:test").

User requirement:
${userRequirement}`;
}

/**
 * 平台契约模板：派发时强制注入每个任务（防跨智能体口径漂移）。
 *
 * 历史教训（docs/2026-09-19-real-task-e2e.md）：total/表头语义空白导致
 * stats.js 两次口径错位；期望片段照抄实现导致自测与实现同盲。契约空白
 * 必须由平台统一兜底，而不是赌 planner 或执行者自觉。
 */
export const CONTRACT_MARKER = "[平台契约条款]";

export const STANDARD_CONTRACT_RULES = `【平台契约条款 · 必读】
1. description 中的接口签名、行为边界、数据口径是本任务的跨智能体合同，逐字遵守。
2. description 未定义的语义点禁止自由发挥或静默选择，必须在实现前明确并在测试中钉住，包括：表头/总数口径（total 是否含表头行）、缺失值与空值处理（null/空串/空白）、数值精度与四舍五入、排序规则、错误行为（退出码 / stderr 提示文案）、输出格式（stdout 只输出结果，日志走 stderr）。
3. 测试断言必须从契约与真实样例数据推导，不得照抄实现行为（防止自测与实现同盲）。
4. 只在你的 zone 目录内创建/修改文件；禁止触碰 node_modules/.git/.env/package.json/lockfile 与 ox-scripts。`;

export function buildDecomposePrompt(prd: PrdDocument): string {
  return `You are the planning brain of OxCommander. Decompose the PRD into parallelizable development tasks for coding agents.

Respond with ONLY a JSON object (no markdown fences) matching:
{
  "tasks": [
    {
      "id": string,
      "title": string,
      "description": string,
      "zone": string,
      "dependencies": string[],
      "suggestedRole": "frontend-dev" | "backend-dev" | "fullstack-dev" | "test-writer" | "docs-writer"
    }
  ],
  "smoke": [
    {
      "title": string,
      "command": string,
      "args": string[],
      "stdin": string,
      "expectContains": string[]
    }
  ]
}

Rules:
- id: short unique slug (e.g. "t1", "t2").
- zone: a concrete directory this task owns (e.g. "src/store", "tests/unit"). Tasks touching the same zone cannot run in parallel, so partition zones to maximize parallelism while respecting dependencies.
- NEVER use "." or "" as a zone unless the task genuinely must add or change root-level files: "." claims the entire repository, blocks every other task in the batch, and disables zone-based protection for the whole tree.
- dependencies: ids of tasks that must finish before this one starts.
- description: detailed enough for an agent to implement without further questions, including file paths when possible.
- suggestedRole must be one of: frontend-dev, backend-dev, fullstack-dev, test-writer, docs-writer.
- Produce 3-10 tasks. Maximize the size of the first parallel batch.
- Every element of "tasks" MUST be a complete OBJECT with all six fields (id, title, description, zone, dependencies, suggestedRole). Never use plain strings as task entries.
- Every task description MUST carry a contract clause list covering: interface signatures, boundary behavior, data semantics (header/total semantics - whether total counts the header row, missing/empty/whitespace handling, rounding), error behavior (exit codes, stderr messages), and output format (stdout carries results only). Semantics the PRD leaves undefined must be EXPLICITLY pinned in the description - implementers must never invent conventions silently (they are injected a platform contract block that forbids it).
- Test files MUST be created directly under tests/ (e.g. tests/csv.test.js, tests/stats.test.js) — the verification runner scans only the top level of tests/; test files in subdirectories like tests/unit/ will NOT be found and the run will fail verification. Zones for test tasks should therefore be "tests" (top level), never "tests/something".
- All code is CommonJS Node.js with no external npm packages; descriptions must not require Python, browsers, or any dependency installation.
- Do not create or modify package.json, lockfiles or .env files: those paths are protected and any write to them is rejected.

Example shape:
{"tasks": [{"id": "t1", "title": "Scaffold config module", "description": "Create src/config/defaults.js exporting the default settings object.", "zone": "src/config", "dependencies": [], "suggestedRole": "fullstack-dev"}, {"id": "t2", "title": "Implement store", "description": "...", "zone": "src/store", "dependencies": ["t1"], "suggestedRole": "backend-dev"}], "smoke": [{"title": "CLI 打印统计报告", "command": "node", "args": ["src/cli.js", "sample-data.csv"], "expectContains": ["col0", "type="]}]}

Smoke rules (the anti-self-confirmation layer — the tests you write may share blind spots with the code, so these run the DELIVERED entrypoint against real sample data):
- 0-3 entries, each running the delivered main entrypoint (CLI/script) with CONCRETE sample data you invent (create any needed sample files as part of a task's zone, e.g. "sample-data.csv").
- expectContains: 2-4 short substrings that the correct output MUST contain (e.g. computed stat values, column names). They must be derived from the sample data by hand, not copied from the implementation.
- Include at least one edge case when the requirement implies data formats (empty values, quoted fields, unicode) — the exact blind spot that self-written tests miss.
- command/args must pass a strict sandbox policy: no shell metacharacters, no destructive programs; stdin carries sample piped data when needed.
- If the deliverable has no runnable entrypoint, return an empty "smoke" array.

PRD:
${JSON.stringify(prd, null, 2)}`;
}

export interface RepairDecisionInput {
  taskTitle: string;
  /**
   * 本任务**总共**被派发过几次（含首次）。
   *
   * ⚠️ 它与 `maxRepairRounds` **不是同一个量纲**（2026-10-05 多轮审计）：
   * 首次派发不算"重修"，所以 `attempts` 天然是 `maxRepairRounds + 1`。
   * 拿它去渲染"重修 N 轮（上限 M）"会印出 `重修 3 轮（上限 2）`
   * —— 一个不可能成立的句子，而用户正是照着这两个数判断
   * "还剩没有机会再来一次"。实测真实 run 里就是这么出来的。
   *
   * 这里只做**如实改名**：`attemptsSoFar` 的语义由调用方保证是"派发总次数"。
   */
  attemptsSoFar: number;
  maxRepairRounds: number;
  lastErrorDigest: string;
  /**
   * 本轮**验证步骤**的结论（`VerificationReport.passed`）。
   *
   * 缺席/未定义时按 `true`（旧行为：当作"验证红着"）——`=== true` 才切到
   * 新措辞，所以不传就仍是旧文案，不会因为新增字段让别处静默改口。
   * 传它的是 orchestrator（`orchestrator.ts:785`）。
   */
  verificationPassed?: boolean;
}

export function buildEscalationSummary(input: RepairDecisionInput): string {
  // ⚠️ **不能一律说"仍未通过验证"**（2026-10-05 运行时观察）。
  // `errorClass` 说的是"这个任务**为什么**没做出来"，而它常常与验证命令无关：
  // 死因是 `no-agent`（没匹配到执行者）时，项目文件压根没人动，验证命令必然全绿。
  // 那种情况下弹出的对话框写着"仍未通过验证"，紧跟着下面一行却是
  // "no agent available" —— 两行自相矛盾，而**用户正是要照着这三选一做决定**：
  // 他会以为是代码写坏了去选"重派"，于是又烧一轮。
  //
  // 判据用 `verificationPassed`（引擎给的**验证步骤结论**），不是任务状态。
  //
  // ⚠️ **两个数必须是同一个量纲**（2026-10-05 多轮审计）：
  // `attemptsSoFar` 是**派发总次数**（含首次），`maxRepairRounds` 是**重修轮数**
  // （不含首次）。直接并排印会得到 `重修 3 轮（上限 2）` —— 一句不可能成立的话，
  // 而用户正是照这两个数判断"还剩没有机会再试一次"。所以两边都换成同一口径。
  const dispatched = input.attemptsSoFar;
  const repairRounds = Math.max(0, dispatched - 1);
  const budgetNote =
    repairRounds >= input.maxRepairRounds
      ? `（已达重修上限 ${input.maxRepairRounds}）`
      : `（还能再重修 ${input.maxRepairRounds - repairRounds} 轮）`;
  const counts =
    `已尝试 ${dispatched} 次（首次 + 重修 ${repairRounds} 轮）${budgetNote}`;
  const framing =
    input.verificationPassed === true
      ? `任务「${input.taskTitle}」${counts}，仍未完成。验证命令是通过的 —— 卡住的是任务本身没做出来。`
      : `任务「${input.taskTitle}」${counts}，仍未通过验证。`;
  return [
    framing,
    "最近一次错误摘要：",
    input.lastErrorDigest || "(空)",
    "请选择处理方式：跳过该任务 / 更换智能体重派 / 终止项目。",
  ].join("\n");
}
