/**
 * Orchestration: planning, PRD edits, run start, cancel/pause/resume and the
 * escalation reply channel. Also owns the per-project workspace scaffold.
 *
 * Registration only — all state lives in `./context`.
 */
import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OrchestratorCallbacks, OrchestratorEngine, RunSnapshot } from "../engine";
import { redactSecrets } from "../../shared/redact";
import {
  abortAllApprovals,
  abortAllEscalations,
  buildPlatformLayer,
  enginesOf,
  ensureAudit,
  getRunningProjectId,
  resolveApproval,
  resolveEscalation,
  send,
  setRunningProjectId,
  settingsStore,
  stores,
  workspaceRoot,
  writeJournal,
} from "./context";
import type { EscalationAction, PrdDocument, SmokeCheck, Task } from "../../shared/types";
import { deriveBoardView } from "../board-derive";

/**
 * Scaffold scripts written into each project workspace. The workspace is a plain
 * CommonJS Node project with no dependencies, so verification (build/typecheck/
 * test) runs offline and deterministically.
 */
const WORKSPACE_SCRIPTS = {
  "build.js": [
    "const { execFileSync } = require('node:child_process');",
    "let failed = 0;",
    "for (const f of require('node:fs').readdirSync('src')) {",
    "  if (!f.endsWith('.js')) continue;",
    "  try { new (require('node:vm').Script)(require('node:fs').readFileSync(`src/${f}`, 'utf8'), { filename: f }); } catch (e) { console.error(`${f}: ${e.message}`); failed++; }",
    "}",
    "if (failed) process.exit(1);",
    "console.log('syntax check passed');",
  ].join("\n"),
  "test.js": [
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const files = fs.existsSync('tests') ? fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')) : [];",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, `tests/${f}`], { stdio: 'inherit' });",
    "  if (r.status !== 0) process.exit(r.status ?? 1);",
    "}",
  ].join("\n"),
} as const;

/** Creates the workspace directory plus its package.json and ox-scripts/. */
export function ensureWorkspace(projectId: string): string {
  const root = workspaceRoot(projectId);
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ["src", "tests"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const pkg = path.join(root, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: `ox-${projectId}`,
          version: "0.0.0",
          private: true,
          scripts: {
            build: "node ox-scripts/build.js",
            typecheck: "node ox-scripts/build.js",
            test: "node ox-scripts/test.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    const file = path.join(root, "ox-scripts", name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }
  return root;
}

/**
 * Builds a fresh engine bound to one project and records it as the project's
 * live engine (for cancel/pause/resume). Always rebuilt from current settings,
 * so settings changes take effect on the next planning/start; re-entry while
 * running is blocked by the runningProjectId checks in the handlers.
 */
export function buildEngine(projectId: string): OrchestratorEngine {
  const projectStore = stores();
  const settings = settingsStore().load();
  const journal = {
    save: (snapshot: RunSnapshot): void => writeJournal(projectId, snapshot),
  };
  const platform = buildPlatformLayer(settings, {
    log: (text) => send({ type: "log", text }),
    journal,
    projectId,
    callbacks: {
      onStage: (stage) => {
        projectStore.update(projectId, { stage });
        // Durable fact: the board rebuilds "where was I" from this after a
        // restart. Cheap JSONL line, no read-modify-write.
        ensureAudit().append({ phase: "stage", projectId, stage });
        send({ type: "stage", stage });
      },
      onTaskStatus: (taskId, status, attempts) => send({ type: "taskStatus", taskId, status, attempts }),
      // The renderer is a display surface: strip credentials before the digest
      // becomes visible/copyable text on the board.
      onTaskOutcome: (taskId, ok, logDigest, meta) =>
        send({
          type: "taskOutcome",
          taskId,
          ok,
          logDigest: redactSecrets(logDigest).slice(0, 2000),
          ...(meta ?? {}),
        }),
      onVerification: (report) => send({ type: "verification", report }),
      onEscalation: (taskId, summary) => send({ type: "escalation", taskId, summary }),
      // 交付凭据：看板要把它整份留下来（它是这次运行唯一的对外结论），
      // 同时 projectStore 存一份，重载窗口后仍看得到上次交付的结论。
      onReceipt: (receipt) => {
        projectStore.update(projectId, { receiptJson: JSON.stringify(receipt) });
        // Durable fact: the receipt also lands in the audit trail so board
        // recovery can show the last delivery verdict after a full restart.
        // Audit JSONL is durable: redact before it hits disk. The receipt is
        // a plain JSON object, so a stringify→redact→parse round-trip is the
        // same boundary the run-end digest already uses.
        try {
          const redacted = JSON.parse(redactSecrets(JSON.stringify(receipt))) as typeof receipt;
          ensureAudit().append({ phase: "receipt", projectId, receipt: redacted });
        } catch {
          // never let recovery bookkeeping break the run
        }
        send({ type: "receipt", receipt });
      },
      // 用量走独立事件而不是日志行：platform 的默认实现只落一行 `[usage] …`，
      // 而看板要的是**字段**（`calls - measuredCalls` 决定这份数字可信到什么程度）。
      // 三条出口（交付 / 取消 / 抛错）都会到 —— 失败的运行一样烧了 token。
      onUsage: (snapshot) => send({ type: "usage", ...snapshot }),
    } satisfies Partial<OrchestratorCallbacks>,
  });
  const engine = platform.engine;
  enginesOf().set(projectId, engine);
  return engine;
}

export function registerOrchestrationHandlers(): void {
  ipcMain.handle("orchestration:planning", async (_e, projectId: string) => {
    const rec = stores().get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (getRunningProjectId() === projectId) throw new Error("项目正在执行中，请先取消再重新规划");
    const engine = buildEngine(projectId);
    const prd = await engine.generatePrd(rec.requirement);
    stores().update(projectId, { prdJson: JSON.stringify(prd), stage: "PLANNING" });
    send({ type: "stage", stage: "PLANNING" });
    // 与 headless 入口保持一致：把验证命令交给 zone 覆盖校验。它引用的文件若
    // 不被任何任务 zone 覆盖，重修会把整个预算烧在一个不可能完成的任务上。
    const { batches, smoke } = await engine.decompose(prd, settingsStore().load().verificationCommands);
    stores().update(projectId, { batchesJson: JSON.stringify(batches), smokeJson: JSON.stringify(smoke) });
    return { prd, batches };
  });

  ipcMain.handle("orchestration:update-prd", async (_e, projectId: string, prd: PrdDocument) => {
    const rec = stores().get(projectId);
    if (!rec) throw new Error(`project ${projectId} not found`);
    if (getRunningProjectId() === projectId) throw new Error("项目正在执行中，请先取消再修改 PRD");
    stores().update(projectId, { prdJson: JSON.stringify(prd), batchesJson: undefined, smokeJson: undefined });
    const engine = buildEngine(projectId);
    const { batches, smoke } = await engine.decompose(prd, settingsStore().load().verificationCommands);
    stores().update(projectId, { batchesJson: JSON.stringify(batches), smokeJson: JSON.stringify(smoke) });
    return { prd, batches };
  });

  // Board recovery (facts/derived split): the renderer asks for the board view
  // derived from the audit trail when it mounts, so a restart shows the last
  // run's progress instead of a blank board. The derive layer is a pure
  // function; this handler is only the IO boundary around it.
  ipcMain.handle("board:recovery", () => deriveBoardView(ensureAudit().read()));

  ipcMain.handle("orchestration:start", async (_e, projectId: string) => {
    const running = getRunningProjectId();
    if (running) throw new Error(`项目 ${running} 正在执行中，无法同时启动`);
    const rec = stores().get(projectId);
    if (!rec?.batchesJson) throw new Error(`no plan for project ${projectId}`);
    const engine = buildEngine(projectId);
    setRunningProjectId(projectId);
    try {
      const smoke: SmokeCheck[] = rec.smokeJson ? (JSON.parse(rec.smokeJson) as SmokeCheck[]) : [];
      await engine.execute(JSON.parse(rec.batchesJson) as Task[][], ensureWorkspace(projectId), { smoke });
    } finally {
      setRunningProjectId(null);
    }
  });

  ipcMain.handle("orchestration:cancel", () => {
    for (const e of enginesOf().values()) e.cancel();
    // Unblock any escalation wait so execute() can observe the cancel.
    abortAllEscalations();
    // Unblock any approval wait the same way — but fail-closed: nobody is
    // going to answer now, so the pending command must not run.
    abortAllApprovals();
  });
  ipcMain.handle("orchestration:pause", () => {
    for (const e of enginesOf().values()) e.pause();
  });
  ipcMain.handle("orchestration:resume", () => {
    for (const e of enginesOf().values()) e.resume();
  });

  ipcMain.handle("orchestration:escalation-decide", (_e, taskId: string, action: EscalationAction) => {
    if (!resolveEscalation(taskId, action)) throw new Error(`没有等待决策的任务：${taskId}`);
    return true;
  });

  ipcMain.handle("orchestration:approval-decide", (_e, requestId: string, granted: boolean) => {
    if (!resolveApproval(requestId, granted)) throw new Error(`没有等待审批的请求：${requestId}`);
    return true;
  });
}
