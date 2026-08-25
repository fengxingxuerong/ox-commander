import type { PrdDocument, Stage, TaskStatus, VerificationReport } from "../shared/types";

export interface TaskView {
  taskId: string;
  title: string;
  zone: string;
  status: TaskStatus;
  attempts: number;
}

export interface AppState {
  page: "projects" | "board";
  projects: Array<{ id: string; name: string; stage: string; requirement: string }>;
  activeProjectId?: string;
  stage: Stage;
  logs: string[];
  tasks: Record<string, TaskView>;
  verification?: VerificationReport;
  escalations: string[];
  newProjectName: string;
  newRequirement: string;

  setPage(page: "projects" | "board"): void;
  setNewProjectName(name: string): void;
  setNewRequirement(text: string): void;
  refreshProjects(): Promise<void>;
  createAndOpen(): Promise<void>;
  startOrchestration(): Promise<void>;
  handleEvent(payload: Record<string, unknown>): void;
}

declare global {
  interface Window {
    oxCommander: {
      createProject(name: string, requirement: string): Promise<{ id: string }>;
      listProjects(): Promise<Array<{ id: string; name: string; stage: string; requirement: string }>>;
      getSettings(): Promise<unknown>;
      startOrchestration(projectId: string, projectRoot: string): Promise<void>;
      cancel(): Promise<void>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      onEvent(handler: (payload: unknown) => void): () => void;
    };
    __prdDraft?: PrdDocument;
  }
}
