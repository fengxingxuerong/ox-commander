/**
 * Renderer 状态管理的错误路径 —— 目前 `store.test.ts` 只覆盖了
 * `handleEvent` 的事件映射与 settings 的 save 路径。这里补齐「IPC 调用失败时
 * 状态机会停在哪种状态」，因为这一层决定了操作失败后 UI 是否还能恢复。
 *
 * 驱动方式同 `store.test.ts`：直接走 store 的公开接口，不渲染 React。
 * 运行在 node 环境（无 `window`），用 globalThis 撑一个 bridge。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "./store";
import { DEFAULT_SETTINGS, type PrdDocument } from "../shared/types";

type Bridge = {
  listProjects: () => Promise<unknown>;
  createProject: (name: string, requirement: string) => Promise<unknown>;
  deleteProject: (id: string) => Promise<unknown>;
  getSettings: () => Promise<unknown>;
  saveSettings: (s: unknown) => Promise<unknown>;
  runPlanning: (id: string) => Promise<unknown>;
  updatePrd: (id: string, prd: unknown) => Promise<unknown>;
  startOrchestration: (id: string) => Promise<unknown>;
  resolveEscalation: (taskId: string, action: string) => Promise<unknown>;
};

function reset(): void {
  useApp.setState({
    page: "projects",
    projects: [],
    activeProjectId: undefined,
    stage: "PRD",
    logs: [],
    tasks: {},
    escalations: [],
    conflicts: [],
    verification: undefined,
    prd: undefined,
    batches: undefined,
    planning: false,
    planningError: undefined,
    settings: undefined,
    settingsError: undefined,
    newProjectName: "",
    newRequirement: "",
  });
}

function prd(goal: string): PrdDocument {
  return { goal, features: [], techStack: [], acceptanceCriteria: [] };
}

let bridge: Bridge;

beforeEach(() => {
  reset();
  bridge = {
    listProjects: async () => [],
    createProject: async () => ({ id: "p-1" }),
    deleteProject: async () => true,
    getSettings: async () => ({ ...DEFAULT_SETTINGS }),
    saveSettings: async () => true,
    runPlanning: async () => ({ prd: prd("初始"), batches: [] }),
    updatePrd: async () => ({ prd: prd("初始"), batches: [] }),
    startOrchestration: async () => undefined,
    resolveEscalation: async () => true,
  };
  const g = globalThis as { window?: unknown };
  g.window = { oxCommander: bridge };
});

const state = () => useApp.getState();

describe("store · IPC 失败不该逃逸成 unhandled rejection", () => {
  it("refreshProjects 失败时记录错误而不是抛出", async () => {
    bridge.listProjects = async () => {
      throw new Error("projects 目录不可读");
    };
    await expect(state().refreshProjects()).resolves.toBeUndefined();
    expect(state().logs.join("\n")).toContain("projects 目录不可读");
  });

  it("createAndOpen 失败时不跳转、不抛出，并给出可见错误", async () => {
    useApp.setState({ newRequirement: "做一个待办应用" });
    bridge.createProject = async () => {
      throw new Error("磁盘已满");
    };
    await expect(state().createAndOpen()).resolves.toBeUndefined();
    // 关键：还停在列表页 —— 否则用户会看到一个空白的 PRD 页
    expect(state().page).toBe("projects");
    expect(state().activeProjectId).toBeUndefined();
    expect(state().logs.join("\n")).toContain("磁盘已满");
  });

  it("deleteProject 失败时保留该项目", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "待办应用", stage: "PRD", requirement: "x" }],
    });
    bridge.deleteProject = async () => {
      throw new Error("回收站不可用");
    };
    await expect(state().deleteProject("p1")).resolves.toBeUndefined();
    expect(state().projects.map((p) => p.id)).toEqual(["p1"]);
    expect(state().logs.join("\n")).toContain("回收站不可用");
  });
});

describe("store · settings 读取失败要有可见后果", () => {
  it("loadSettings 失败时写入 settingsError", async () => {
    bridge.getSettings = async () => {
      throw new Error("settings.json 损坏");
    };
    await state().loadSettings();
    // 只写日志是不够的：设置页把 `settings === undefined` 渲染成默认值，
    // 又用 `disabled={!settings}` 禁用保存按钮 —— 用户看到的是"还没配过"，
    // 于是改一堆设置后发现根本保存不了，且没有任何提示解释为什么。
    expect(state().settingsError).toContain("settings.json 损坏");
  });
});

describe("store · resolveEscalation 的乐观更新必须可回滚", () => {
  it("IPC 失败时把升级项退回未处理，否则操作入口消失且无法重试", async () => {
    useApp.setState({
      escalations: [{ taskId: "t1", summary: "预算耗尽", resolved: false }],
    });
    bridge.resolveEscalation = async () => {
      throw new Error("任务已结束");
    };
    await state().resolveEscalation("t1", "skip");
    // 若这里 resolved 仍为 true，看板上三个按钮被替换成"已处理"，
    // 用户再也点不到，而后端其实没收到这次决策。
    expect(state().escalations[0]).toMatchObject({ taskId: "t1", resolved: false });
    expect(state().logs.join("\n")).toContain("任务已结束");
  });
});

describe("store · runPlanning 并发", () => {
  it("后发起的规划请求不能被先发起的慢请求覆盖", async () => {
    useApp.setState({ activeProjectId: "p-1" });
    let n = 0;
    bridge.runPlanning = async () => {
      n += 1;
      const round = n;
      if (round === 1) await new Promise((r) => setTimeout(r, 60));
      return { prd: prd(`第${round}次`), batches: [] };
    };
    const first = state().runPlanning();
    const second = state().runPlanning();
    await Promise.all([first, second]);
    expect((state().prd as PrdDocument | undefined)?.goal).toBe("第2次");
  });
});
