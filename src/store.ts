import { create } from "zustand";
import type { AppState, TaskView } from "./types";
import type { Stage, TaskStatus } from "../shared/types";

const api = () => window.oxCommander;

export const useApp = create<AppState>((set, get) => ({
  page: "projects",
  projects: [],
  stage: "PRD" as Stage,
  logs: [],
  tasks: {},
  escalations: [] as AppState["escalations"],
  planning: false,
  planningError: undefined,
  newProjectName: "",
  newRequirement: "",

  setPage: (page) => set({ page }),
  setNewProjectName: (newProjectName) => set({ newProjectName }),
  setNewRequirement: (newRequirement) => set({ newRequirement }),

  refreshProjects: async () => {
    const projects = await api().listProjects();
    set({ projects });
  },

  deleteProject: async (projectId) => {
    await api().deleteProject(projectId);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== projectId),
      activeProjectId: s.activeProjectId === projectId ? undefined : s.activeProjectId,
    }));
  },

  createAndOpen: async () => {
    const { newProjectName, newRequirement } = get();
    if (!newRequirement.trim()) return;
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
      verification: undefined,
      prd: undefined,
      batches: undefined,
      planning: true,
      planningError: undefined,
    });
    void get().runPlanning();
  },

  runPlanning: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    set((s) => ({ planning: true, planningError: undefined, logs: [...s.logs, "── 正在生成 PRD 并分解任务… ──"] }));
    try {
      const { prd, batches } = await api().runPlanning(activeProjectId);
      set({ prd, batches, planning: false, logs: [] });
    } catch (err) {
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
    const settings = await api().getSettings();
    set({ settings });
  },

  saveSettings: async (settings) => {
    await api().saveSettings(settings);
    set({ settings });
  },

  resolveEscalation: async (taskId, action) => {
    set((s) => ({
      escalations: s.escalations.map((e) =>
        e.taskId === taskId ? { ...e, resolved: true } : e,
      ),
      logs: [...s.logs, `── 已决策 ${taskId}：${action} ──`],
    }));
    try {
      await api().resolveEscalation(taskId, action);
    } catch (err) {
      set((s) => ({ logs: [...s.logs, `[错误] 决策失败: ${(err as Error).message}`] }));
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
