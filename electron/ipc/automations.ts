/**
 * 桌面自动化（M5b）：CRUD + 立即触发 + 触发历史，以及调度环的起停。
 *
 * 与编排的分工：这一段只负责"**什么时候该跑**"（间隔/补跑/忙跳过），真正跑起来
 * 仍走 `startProjectRun`（与手动启动同一道单飞闸、同一条路）—— 自动化不是第二条
 * 执行路径，它是同一路径上的一个触发器。
 *
 * 两条持久事实：
 * - 自动化本身在 `<userData>/automations/automations.json`（原子落盘）；
 * - 每次触发尝试落审计（`phase: "automation"`）。JSONL 是唯一的持久账本，
 *   重开窗口/重启后仍能回答"这条最近跑过没有、为什么没跑"。
 */
import { app, ipcMain } from "electron";
import path from "node:path";

import { AutomationScheduler, type TriggerOutcome } from "../automations/automation-scheduler";
import { AutomationStore, type AutomationUpdate } from "../automations/automation-store";
import { ensureAudit, logLine } from "./context";
import { runGate, startProjectRun } from "./orchestration";
import type { Automation, AutomationHistoryEntry } from "../../shared/automation";

let storeSingleton: AutomationStore | null = null;
let schedulerSingleton: AutomationScheduler | null = null;

export function automationStore(): AutomationStore {
  if (!storeSingleton) {
    storeSingleton = new AutomationStore(path.join(app.getPath("userData"), "automations"));
  }
  return storeSingleton;
}

/**
 * 读列表的统一入口。文件损坏时**不抛**给调度环与界面，而是把问题带回去：
 * 调度环拿到空表（它不该因为一个坏文件停摆），界面拿到 `problem` 并说破 ——
 * 静默当空表会让"我的自动化全没了"没有任何痕迹。
 */
function readList(): { automations: Automation[]; problem?: string } {
  try {
    return { automations: automationStore().list() };
  } catch (err) {
    const problem = (err as Error).message;
    logLine(`[automation] 读取 automations.json 失败：${problem}`);
    return { automations: [], problem };
  }
}

/** 一次触发尝试落审计（三态都记 —— "没跑"和"跑了"一样是需要回答的问题）。 */
function recordAttempt(a: Automation, outcome: TriggerOutcome, detail?: string): void {
  ensureAudit().append({
    phase: "automation",
    automationId: a.id,
    automationName: a.name,
    projectId: a.projectId,
    automationOutcome: outcome,
    ok: outcome === "accepted",
    ...(detail !== undefined ? { detail: detail.slice(0, 300) } : {}),
  });
}

/**
 * 触发一条自动化：**同步闸门 + 异步起飞**。
 *
 * 不 `await startProjectRun`：一次编排可能跑几小时，调度环（以及 IPC 的"立即
 * 运行"）等它就是被一个长任务卡死。这与 serve 的 `POST /run` 同形 —— 立刻回
 * "已接受"，运行本身的成败由 run-start/run-end 与这里的运行期失败记录交代。
 *
 * 闸门是同步的（`runGate` 只读内存 + 一次记录查询），所以 busy / 没计划能在
 * **不起火**的前提下分辨出来，不靠错误消息猜。
 */
function triggerNow(a: Automation): TriggerOutcome {
  const gate = runGate(a.projectId);
  if (gate.kind === "busy") {
    recordAttempt(a, "busy", gate.message);
    return "busy";
  }
  if (gate.kind === "no-plan") {
    recordAttempt(a, "failed", gate.message);
    return "failed";
  }
  recordAttempt(a, "accepted");
  startProjectRun(a.projectId).catch((err: Error) => {
    // 已经起飞了才失败（引擎内部抛错）：另记一条，不覆盖"已接受"那一条。
    logLine(`[automation] ${a.name} 运行失败：${err.message}`);
    recordAttempt(a, "failed", `运行期失败：${err.message}`);
  });
  return "accepted";
}

export function ensureAutomationScheduler(): AutomationScheduler {
  if (!schedulerSingleton) {
    const store = automationStore();
    schedulerSingleton = new AutomationScheduler({
      // 读失败时调度环拿空表（loop 不停摆），问题由 readList 那行日志说破。
      list: () => readList().automations,
      trigger: async (a) => triggerNow(a),
      markFired: (id, now) => {
        store.markFired(id, now);
      },
      log: logLine,
    });
  }
  return schedulerSingleton;
}

export function registerAutomationHandlers(): void {
  ipcMain.handle("automations:list", () => readList());

  ipcMain.handle("automations:create", (_e, input: { name: string; projectId: string; everyMs: number }) => {
    const created = automationStore().create(input, Date.now());
    // 新建后立刻重排：新任务"一个间隔后首次触发"要真的排上，否则得等到下一次
    // 任何改动才被看见（调度环只在 reschedule 时重算）。
    ensureAutomationScheduler().reschedule();
    return created;
  });

  ipcMain.handle("automations:update", (_e, id: string, patch: AutomationUpdate) => {
    const updated = automationStore().update(id, patch, Date.now());
    if (!updated) throw new Error(`没有这条自动化：${id}`);
    // 改间隔/停用都要立刻生效：停用的任务不该再被下一次到点叫醒。
    ensureAutomationScheduler().reschedule();
    return updated;
  });

  ipcMain.handle("automations:delete", (_e, id: string) => {
    const removed = automationStore().remove(id);
    if (removed) ensureAutomationScheduler().reschedule();
    return removed;
  });

  ipcMain.handle("automations:run", (_e, id: string) => {
    const store = automationStore();
    const target = store.get(id);
    if (!target) throw new Error(`没有这条自动化：${id}`);
    const outcome = triggerNow(target);
    // 手动跑一次也算"跑过了一次"：不落时间戳的话，下一次到点会紧接着再起一次
    // （同一份工作连跑两遍）。记账失败只说破 —— 运行已经起来了，不能改判没触发。
    if (outcome === "accepted") {
      try {
        store.markFired(id, Date.now());
      } catch (err) {
        logLine(`[automation] ${target.name} 的触发时间记账失败：${(err as Error).message}`);
      }
    }
    return outcome;
  });

  ipcMain.handle("automations:history", (_e, limit?: number) => {
    const records = ensureAudit().read({ limit: limit ?? 50, phase: "automation" });
    return records.map((r): AutomationHistoryEntry => ({
      ts: r.ts,
      ...(r.automationId !== undefined ? { automationId: r.automationId } : {}),
      ...(r.automationName !== undefined ? { automationName: r.automationName } : {}),
      ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
      outcome: r.automationOutcome ?? "unknown",
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
    }));
  });

  // 调度环随 handler 一起起（registerIpc 在 app.whenReady 里只调一次；start 幂等）。
  ensureAutomationScheduler().start();
}
