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
  attemptsSoFar: number;
  maxRepairRounds: number;
  lastErrorDigest: string;
}

export function buildEscalationSummary(input: RepairDecisionInput): string {
  return [
    `任务「${input.taskTitle}」重修 ${input.attemptsSoFar} 轮后仍未通过验证（上限 ${input.maxRepairRounds}）。`,
    "最近一次错误摘要：",
    input.lastErrorDigest || "(空)",
    "请选择处理方式：跳过该任务 / 更换智能体重派 / 终止项目。",
  ].join("\n");
}
