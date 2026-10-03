import { create } from "zustand";
import type { AppState, TaskView } from "./types";
import type { Stage, TaskStatus } from "../shared/types";
import { formatUsageLine, type UsageSnapshot } from "../shared/usage-meter";

const api = () => window.oxCommander;

/**
 * Monotonic token for the in-flight planning request.
 *
 * `createAndOpen` and `retryPlanning` can both fire `runPlanning`, and a slow
 * first request would otherwise land *after* the newer one and overwrite it —
 * the board then shows the stale PRD while the operator is looking at the
 * retry's result. Only the newest request is allowed to commit.
 */
let planningSeq = 0;

/**
 * 看板把一次越权裁决念成人话时用的词表。
 *
 * 键必须与**生产端**同词：`BatchGuard.remedyFor` 只会发 `revert` / `quarantine` /
 * `fail-batch` / `pass`，两个宿主在找不到对应裁决时发 `none`。旧版这里写的
 * `isolate` / `keep` 从来没人发过，于是"移入隔离区"和"保留文件判失败"两种处置
 * 都被念成"仅记录"。防漂移的用例在 src/sandbox-journal.test.ts：它把四档真跑一遍，
 * 拿实际产出的 action 来比对这张表。
 */
export const REMEDY_VERB: Record<string, string> = {
  revert: "已回滚",
  quarantine: "已隔离",
  "fail-batch": "保留文件、判批次失败",
  pass: "仅记录",
  none: "仅记录",
};

export const useApp = create<AppState>((set, get) => ({
  page: "projects",
  projects: [],
  stage: "PRD" as Stage,
  logs: [],
  tasks: {},
  escalations: [] as AppState["escalations"],
  approvals: [] as AppState["approvals"],
  conflicts: [] as AppState["conflicts"],
  planning: false,
  planningError: undefined,
  newProjectName: "",
  newRequirement: "",

  setPage: (page) => set({ page }),
  setNewProjectName: (newProjectName) => set({ newProjectName }),
  setNewRequirement: (newRequirement) => set({ newRequirement }),

  refreshProjects: async () => {
    // Guarded: this runs on mount, so a rejected IPC call (unreadable projects
    // dir) escaped as an unhandled rejection and left the list silently empty —
    // indistinguishable from "no projects yet".
    try {
      const projects = await api().listProjects();
      set({ projects, projectsError: undefined });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 读取项目列表失败: ${message}`],
      }));
    }
  },

  deleteProject: async (projectId) => {
    try {
      await api().deleteProject(projectId);
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== projectId),
        activeProjectId: s.activeProjectId === projectId ? undefined : s.activeProjectId,
        projectsError: undefined,
      }));
    } catch (err) {
      const message = (err as Error).message;
      // The row is kept: deleting only from local state would show a project
      // as gone while its workspace is still on disk.
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 删除项目失败: ${message}`],
      }));
    }
  },

  createAndOpen: async () => {
    const { newProjectName, newRequirement } = get();
    if (!newRequirement.trim()) return;
    try {
      const rec = await api().createProject(
        newProjectName.trim() || "未命名项目",
        newRequirement.trim(),
      );
      set({
        activeProjectId: rec.id,
        page: "prd-review",
        stage: "PLANNING",
        logs: [],
        tasks: {},
        escalations: [],
        approvals: [],
        conflicts: [],
        verification: undefined,
        receipt: undefined,
        prd: undefined,
        batches: undefined,
        planning: true,
        planningError: undefined,
        projectsError: undefined,
      });
    } catch (err) {
      // Staying on the projects page is deliberate: navigating to the PRD page
      // first and failing afterwards would leave an empty review screen with no
      // project behind it.
      const message = (err as Error).message;
      set((s) => ({
        projectsError: message,
        logs: [...s.logs, `[错误] 创建项目失败: ${message}`],
      }));
      return;
    }
    void get().runPlanning();
  },

  runPlanning: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    const seq = ++planningSeq;
    set((s) => ({ planning: true, planningError: undefined, logs: [...s.logs, "── 正在生成 PRD 并分解任务… ──"] }));
    try {
      const { prd, batches } = await api().runPlanning(activeProjectId);
      if (seq !== planningSeq) return;
      set({ prd, batches, planning: false, logs: [] });
    } catch (err) {
      if (seq !== planningSeq) return;
      set((s) => ({
        planning: false,
        planningError: (err as Error).message,
        logs: [...s.logs, `[错误] 规划失败: ${(err as Error).message}`],
      }));
    }
  },

  retryPlanning: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set({
      prd: undefined,
      batches: undefined,
      planning: true,
      planningError: undefined,
      stage: "PLANNING",
      logs: ["── 重新规划中… ──"],
    });
    await get().runPlanning();
  },

  updatePrd: async (prd) => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set((s) => ({ logs: [...s.logs, "── PRD 已修改，重新分解任务… ──"] }));
    try {
      const result = await api().updatePrd(activeProjectId, prd);
      set({ prd: result.prd, batches: result.batches });
    } catch (err) {
      set((s) => ({
        planningError: (err as Error).message,
        logs: [...s.logs, `[错误] 更新 PRD 失败: ${(err as Error).message}`],
      }));
    }
  },

  confirmAndExecute: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    // A new run supersedes any recovered history: the interrupted flag belongs
    // to the *previous* run and must not survive into this one.
    set({ page: "board", stage: "DEVELOPMENT", interrupted: undefined, lastActivityTs: undefined });
    try {
      await api().startOrchestration(activeProjectId);
    } catch (err) {
      set((s) => ({ logs: [...s.logs, `[错误] ${(err as Error).message}`] }));
    }
  },

  backToProjects: () =>
    set({ page: "projects", prd: undefined, batches: undefined, stage: "PRD", tasks: {} }),

  loadSettings: async () => {
    // Unguarded before: a rejected IPC call (corrupt settings file, store not
    // ready) escaped as an unhandled rejection and the settings page silently
    // showed defaults — indistinguishable from "nothing configured yet".
    try {
      const settings = await api().getSettings();
      set({ settings, settingsError: undefined });
    } catch (err) {
      // The log alone is not enough: the page renders `settings === undefined`
      // as defaults and disables saving, so a failed load looked exactly like
      // "nothing configured yet" — with no hint about why saving is disabled.
      const message = (err as Error).message;
      set((s) => ({
        settingsError: message,
        logs: [...s.logs, `[错误] 读取设置失败: ${message}`],
      }));
    }
  },

  saveSettings: async (settings) => {
    // Only commit the new settings locally once the write succeeded; otherwise
    // the UI would show settings that were never persisted.
    try {
      await api().saveSettings(settings);
      set({ settings, settingsError: undefined });
    } catch (err) {
      set((s) => ({
        logs: [...s.logs, `[错误] 保存设置失败: ${(err as Error).message}`],
        settingsError: (err as Error).message,
      }));
    }
  },

  resolveEscalation: async (taskId, action) => {
    const before = get().escalations.find((e) => e.taskId === taskId);
    set((s) => ({
      escalations: s.escalations.map((e) =>
        e.taskId === taskId ? { ...e, resolved: true } : e,
      ),
      logs: [...s.logs, `── 已决策 ${taskId}：${action} ──`],
    }));
    try {
      await api().resolveEscalation(taskId, action);
    } catch (err) {
      const message = (err as Error).message;
      // Roll the optimistic update back. Leaving `resolved: true` hides the
      // three action buttons behind a "已处理" label, so the operator can never
      // retry — while the engine never actually received the decision.
      set((s) => ({
        escalations: s.escalations.map((e) => (e.taskId === taskId ? (before ?? e) : e)),
        logs: [...s.logs, `[错误] 决策失败: ${message}`],
      }));
    }
  },

  resolveApproval: async (requestId, granted) => {
    const before = get().approvals.find((a) => a.requestId === requestId);
    set((s) => ({
      approvals: s.approvals.map((a) => (a.requestId === requestId ? { ...a, resolved: true } : a)),
      logs: [...s.logs, `── 审批 ${requestId}：${granted ? "批准" : "拒绝"} ──`],
    }));
    try {
      await api().resolveApproval(requestId, granted);
    } catch (err) {
      const message = (err as Error).message;
      // 与 resolveEscalation 同款乐观回滚：保留按钮，让操作者能重试。
      set((s) => ({
        approvals: s.approvals.map((a) => (a.requestId === requestId ? (before ?? a) : a)),
        logs: [...s.logs, `[错误] 审批回传失败: ${message}`],
      }));
    }
  },

  loadRecovery: async () => {
    // Board recovery (facts/derived split): on mount the board asks the main
    // process for the view derived from the audit trail. Before this, a
    // reload — or a killed process tree — left the board blank even though
    // the durable facts of the last run were sitting on disk.
    try {
      const view = await api().boardRecovery();
      set((s) => ({
        tasks: { ...s.tasks, ...view.tasks },
        ...(view.stage ? { stage: view.stage } : {}),
        ...(view.receipt ? { receipt: view.receipt } : {}),
        interrupted: view.interrupted,
        lastActivityTs: view.lastActivityTs,
        logs:
          view.interrupted || Object.keys(view.tasks).length > 0
            ? [...s.logs, "── 已从审计日志恢复上次运行的进度 ──"]
            : s.logs,
      }));
    } catch (err) {
      // Recovery is an enhancement, never a blocker: an unreadable trail must
      // not stop the board from working exactly as before.
      set((s) => ({
        logs: [...s.logs, `[提示] 审计恢复不可用: ${(err as Error).message}`],
      }));
    }
  },

  handleEvent: (payload) => {
    const p = payload as Record<string, unknown>;
    switch (p.type) {
      case "stage":
        set((s) => ({ stage: p.stage as Stage, logs: [...s.logs, `── 阶段：${String(p.stage)} ──`] }));
        break;
      case "log":
        set((s) => ({ logs: [...s.logs.slice(-500), String(p.text)] }));
        break;
      case "task-activity": {
        const { taskId, at } = p as { taskId: string; at: number };
        set((s) => {
          const prev = s.tasks[taskId];
          // 心跳只对在跑的任务有意义：终态任务收到迟到的心跳不应复活它。
          if (!prev || prev.status !== "running") return {};
          return { tasks: { ...s.tasks, [taskId]: { ...prev, lastActivityTs: at } } };
        });
        break;
      }
      case "taskStatus": {
        const { taskId, status, attempts, title, zone } = p as {
          taskId: string;
          status: TaskStatus;
          attempts: number;
          title?: string;
          zone?: string;
        };
        set((s) => {
          const prev = s.tasks[taskId];
          return {
            tasks: {
              ...s.tasks,
              [taskId]: {
                // Spread prev first: a repair round re-dispatches the task and
                // emits `running` again — wiping agentId/durationMs/errorClass
                // here would erase the attribution the board needs to explain
                // "who ran it, how long, why it failed".
                ...prev,
                taskId,
                title: title ?? prev?.title ?? taskId,
                zone: zone ?? prev?.zone ?? "",
                status,
                // 重新派发 = 心跳账本重置：上一轮的静默记录不能算到这一轮头上。
                ...(status === "running" ? { lastActivityTs: Date.now() } : { lastActivityTs: undefined }),
                attempts,
              },
            },
          };
        });
        break;
      }
      case "verification":
        set((s) => ({
          verification: p.report as AppState["verification"],
          logs: [...s.logs, "── 硬性验证结果已生成，见右侧面板 ──"],
        }));
        break;
      case "receipt":
        set((s) => ({
          receipt: p.receipt as AppState["receipt"],
          logs: [...s.logs, p.receipt ? (p.receipt as { headline: string }).headline : ""],
        }));
        break;
      case "usage": {
        // 事件载荷是 `Record<string, unknown>`：先过 unknown 再落类型，与其余
        // case 的 `as AppState[...]` 同源（不做逐字段校验，协议保证形状）。
        const snap = p as unknown as UsageSnapshot;
        set((s) => ({ usage: snap, logs: [...s.logs, formatUsageLine(snap)] }));
        break;
      }
      case "line-health":
        set(() => ({ lineHealth: (p as { lines: AppState["lineHealth"] }).lines }));
        break;
      case "escalation": {
        const { taskId, summary } = p as { taskId: string; summary: string };
        set((s) => ({
          escalations: [
            ...s.escalations.filter((e) => e.taskId !== taskId),
            { taskId, summary, resolved: false },
          ],
          logs: [...s.logs, `── ⚠️ 任务 ${taskId} 需要决策（见右侧面板）──`],
        }));
        break;
      }
      case "approval-request": {
        const { requestId, command, args } = p as { requestId: string; command: string; args: string[] };
        set((s) => ({
          approvals: [
            ...s.approvals.filter((a) => a.requestId !== requestId),
            { requestId, command, args: args ?? [], resolved: false },
          ],
          logs: [...s.logs, `── ⚠️ 命令需要审批（见右侧面板）：${command} ${(args ?? []).join(" ")} ──`],
        }));
        break;
      }
      case "conflict": {
        const { kind, paths, remedy } = p as { kind?: string; paths?: string[]; remedy?: string };
        // 词表与生产端同源，见 REMEDY_VERB 上的注释；未收录的值仍念"仅记录"，
        // 但绝不把原始 token 打到界面上。
        const verb = REMEDY_VERB[remedy ?? "none"] ?? "仅记录";
        set((s) => ({
          conflicts: [
            ...s.conflicts.slice(-49),
            {
              kind: kind ?? "unknown",
              paths: paths ?? [],
              remedy: remedy ?? "none",
              ts: new Date().toISOString(),
            },
          ],
          logs: [
            ...s.logs.slice(-500),
            `── ⚠️ 区域冲突（${kind ?? "unknown"}，${verb}）：${(paths ?? []).join("、").slice(0, 300)} ──`,
          ],
        }));
        break;
      }
      case "taskOutcome": {
        const { taskId, ok, logDigest, agentId, errorClass, durationMs } = p as {
          taskId: string;
          ok: boolean;
          logDigest?: string;
          agentId?: string;
          errorClass?: string;
          durationMs?: number;
        };
        set((s) => {
          const prev = s.tasks[taskId];
          if (!prev) return {};
          // A task can fail and later succeed in a repair round: attribution is
          // kept, but the failure class must be cleared or the board keeps
          // showing a stale error next to a green task.
          const next: TaskView = {
            ...prev,
            failureDigest: ok ? undefined : (logDigest ?? "无日志"),
            ...(agentId ? { agentId } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          };
          if (ok) delete next.errorClass;
          else next.errorClass = errorClass ?? "unknown";
          return { tasks: { ...s.tasks, [taskId]: next } };
        });
        break;
      }
    }
  },
}));
