import type { PrdDocument, Task, TaskPayload } from "./types";

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
- techStack: concrete technologies; prefer mainstream, well-supported choices.
- acceptanceCriteria: objective, machine-checkable criteria (build passes, tests pass, feature X works).

User requirement:
${userRequirement}`;
}

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
  ]
}

Rules:
- id: short unique slug (e.g. "t1", "t2").
- zone: directory area this task owns. Tasks touching the same zone cannot run in parallel, so partition zones to maximize parallelism while respecting dependencies.
- dependencies: ids of tasks that must finish before this one starts.
- description: detailed enough for an agent to implement without further questions, including file paths when possible.
- suggestedRole must be one of: frontend-dev, backend-dev, fullstack-dev, test-writer, docs-writer.
- Produce 3-10 tasks. Maximize the size of the first parallel batch.

PRD:
${JSON.stringify(prd, null, 2)}`;
}

export function buildRepairPrompt(payload: TaskPayload): string {
  const repair = payload.repairContext;
  return `Your previous attempt at this task failed automated verification.

Task: ${payload.title}
Zone (you may only modify files inside this area): ${payload.zone}
Repair round: ${repair?.round ?? 1}

Verification error digest:
${repair?.errorLogDigest ?? "(no digest)"}

Original description:
${payload.description}

Fix the failing code inside your zone. Do not rewrite unrelated code.`;
}

export function buildTaskDispatchPrompt(payload: TaskPayload): string {
  if (payload.repairContext) return buildRepairPrompt(payload);
  return `${payload.description}

Constraints:
- You may only create or modify files inside the zone: ${payload.zone}
- The project root is: ${payload.projectRoot}
- When finished, the code must compile and pass tests.`;
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

export function summarizeTasks(tasks: Task[]): string {
  return tasks
    .map((t) => `- [${t.id}] ${t.title} (zone=${t.zone}, deps=[${t.dependencies.join(",")}], role=${t.suggestedRole})`)
    .join("\n");
}
