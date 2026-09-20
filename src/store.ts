import { create } from "zustand";
import type { AppState, TaskView } from "./types";
import type { Stage, TaskStatus } from "../shared/types";

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

export const useApp = create<AppState>((set, get) => ({
  page: "projects",
  projects: [],
  stage: "PRD" as Stage,
  logs: [],
  tasks: {},
  escalations: [] as AppState["escalations"],
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
        conflicts: [],
        verification: undefined,
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
    set({ page: "board", stage: "DEVELOPMENT" });
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

  handleEvent: (payload) => {
    const p = payload as Record<string, unknown>;
    switch (p.type) {
      case "stage":
        set((s) => ({ stage: p.stage as Stage, logs: [...s.logs, `── 阶段：${String(p.stage)} ──`] }));
        break;
      case "log":
        set((s) => ({ logs: [...s.logs.slice(-500), String(p.text)] }));
        break;
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
      case "conflict": {
        const { kind, paths, remedy } = p as { kind?: string; paths?: string[]; remedy?: string };
        const verb =
          remedy === "revert"
            ? "已回滚"
            : remedy === "isolate"
              ? "已隔离"
              : remedy === "keep"
                ? "保留改动"
                : "仅记录";
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
