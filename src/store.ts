import { create } from "zustand";
import type { AppState } from "./types";
import type { Stage, TaskStatus } from "../shared/types";

const api = () => window.oxCommander;

export const useApp = create<AppState>((set, get) => ({
  page: "projects",
  projects: [],
  stage: "PRD" as Stage,
  logs: [],
  tasks: {},
  escalations: [],
  newProjectName: "",
  newRequirement: "",

  setPage: (page) => set({ page }),
  setNewProjectName: (newProjectName) => set({ newProjectName }),
  setNewRequirement: (newRequirement) => set({ newRequirement }),

  refreshProjects: async () => {
    const projects = await api().listProjects();
    set({ projects });
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
      page: "board",
      stage: "PRD",
      logs: [],
      tasks: {},
      escalations: [],
      verification: undefined,
    });
  },

  startOrchestration: async () => {
    const { activeProjectId } = get();
    if (!activeProjectId) return;
    try {
      await api().startOrchestration(activeProjectId, activeProjectId === "" ? "." : ".");
    } catch (err) {
      set((s) => ({ logs: [...s.logs, `[错误] ${(err as Error).message}`] }));
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
      case "escalation":
        set((s) => ({ escalations: [...s.escalations, String(p.summary)] }));
        break;
    }
  },
}));
