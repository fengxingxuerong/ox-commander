// @vitest-environment jsdom
/**
 * Renderer smoke tests: every page + the agents panel must render from a
 * mocked `window.oxCommander` bridge without crashing, and the operator
 * actions exercised here must reach the bridge with the right arguments.
 *
 * These are render-level tests (not pixel tests): they pin the event→state→UI
 * mapping that store.test.ts covers only up to the store boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../shared/providers";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AgentsPanel } from "./components/AgentsPanel";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";
import { PrdReviewPage } from "./pages/PrdReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useApp } from "./store";
import { DEFAULT_SETTINGS, type PrdDocument, type Task, type VerificationReport } from "../shared/types";
import type { AgentListResult, AgentSummary } from "./types";

type Bridge = Window["oxCommander"];

const PRD: PrdDocument = {
  goal: "做一个待办事项应用",
  features: ["任务增删", "标记完成"],
  techStack: ["React", "Node"],
  acceptanceCriteria: ["能创建任务", "能完成任务"],
};

const TASK_A: Task = {
  id: "t1",
  title: "实现任务列表",
  description: "在 src/todo 写增删改查",
  zone: "src/todo",
  dependencies: [],
  suggestedRole: "frontend-dev",
};
const BATCHES: Task[][] = [[TASK_A]];

const VERIFICATION: VerificationReport = {
  passed: true,
  results: [
    { kind: "build", ok: true, exitCode: 0, logDigest: "ok", durationMs: 1200 },
    { kind: "test", ok: true, exitCode: 0, logDigest: "ok", durationMs: 2300 },
  ],
};

function agentSummary(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "sensenova-api",
    displayName: "SenseNova 执行器",
    adapter: "local-llm",
    source: "builtin",
    enabled: true,
    inferredLegacy: false,
    priority: 0,
    capabilities: {
      protocolVersion: "ox-agent/2",
      roles: ["*"],
      zoneGlobs: ["**"],
      supports: ["edit", "create", "run-test"],
      artifactKinds: ["files", "logs"],
      maxConcurrency: 3,
      selfIsolated: false,
    },
    limits: { runDeadlineMs: 600_000, idleTimeoutMs: 120_000, maxStdoutBytes: 2_097_152 },
    credentialKind: "env",
    ...over,
  };
}

function agentList(over: Partial<AgentListResult> = {}): AgentListResult {
  return {
    agents: [agentSummary()],
    manifestDir: "C:\\tmp\\agents.d",
    manifestErrors: [],
    skippedManifests: [],
    ...over,
  };
}

/** Full bridge mock; every method is a vi.fn with a harmless default. */
function makeBridge(): Bridge {
  return {
    createProject: vi.fn(async () => ({ id: "p-1" })),
    listProjects: vi.fn(async () => []),
    openWorkspace: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => true),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    saveSettings: vi.fn(async () => true),
    getKeysStatus: vi.fn(async () => [
      { envVar: "SENSENOVA_API_KEY", configured: true, source: "env" as const },
      { envVar: "AMD_API_KEY", configured: false, source: "store" as const },
    ]),
    getKeySecurity: vi.fn(async () => ({ encryptedAtRest: true, plaintextCount: 0 })),
    saveKeys: vi.fn(async () => 1),
    testLlm: vi.fn(async () => ({ ok: true as const, model: "deepseek-v4-flash" })),
    runPlanning: vi.fn(async () => ({ prd: PRD, batches: BATCHES })),
    updatePrd: vi.fn(async () => ({ prd: PRD, batches: BATCHES })),
    startOrchestration: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    resolveEscalation: vi.fn(async () => true),
    listAgents: vi.fn(async () => agentList()),
    exampleManifest: vi.fn(async () => ({ id: "example" }) as never),
    registerAgent: vi.fn(async () => ({ ok: true, id: "x" }) as never),
    unregisterAgent: vi.fn(async () => ({ ok: true, drained: "drained" }) as never),
    toggleAgent: vi.fn(async () => true),
    probeAgents: vi.fn(async () => ({ "sensenova-api": true })),
    getAgentStats: vi.fn(async () => ({ circuits: {} })),
    recentAudit: vi.fn(async () => []),
    auditFiles: vi.fn(async () => []),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as Bridge;
}

function resetStore() {
  useApp.setState({
    page: "projects",
    projects: [],
    activeProjectId: undefined,
    stage: "PRD",
    logs: [],
    tasks: {},
    verification: undefined,
    escalations: [],
    conflicts: [],
    prd: undefined,
    batches: undefined,
    planning: false,
    planningError: undefined,
    settings: undefined,
    settingsError: undefined,
    projectsError: undefined,
    newProjectName: "",
    newRequirement: "",
  });
}

beforeEach(() => {
  window.oxCommander = makeBridge();
  resetStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("mounts on the projects page, subscribes to events and refreshes projects", async () => {
    render(<App />);
    expect(screen.getByText("新建项目")).toBeTruthy();
    await waitFor(() => {
      expect(window.oxCommander.listProjects).toHaveBeenCalled();
      expect(window.oxCommander.onEvent).toHaveBeenCalled();
    });
  });

  it("switches pages from the store without remount glitches", async () => {
    render(<App />);
    useApp.setState({ page: "board" });
    expect(await screen.findByText("任务看板")).toBeTruthy();
    useApp.setState({ page: "settings" });
    expect(await screen.findByText("线路池（多 API 同时工作）")).toBeTruthy();
    useApp.setState({ page: "projects" });
    expect(await screen.findByText("新建项目")).toBeTruthy();
  });
});

describe("ErrorBoundary", () => {
  function Boom({ armed }: { armed: boolean }) {
    if (armed) throw new Error("渲染时炸了");
    return <p>恢复正常</p>;
  }

  it("replaces a crashed tree with a recoverable panel instead of a blank window", async () => {
    // A throw during render normally unmounts everything: without a boundary
    // the operator sees a blank window and has to restart the app.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let armed = true;
    const { rerender } = render(
      <ErrorBoundary>
        <Boom armed={armed} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("界面出错了")).toBeTruthy();
    expect(screen.getByText("渲染时炸了")).toBeTruthy();

    // Disarm first: resetting while the children still throw would just
    // re-crash on the very next render. The boundary must then re-render
    // children for real, not merely clear its own error flag.
    armed = false;
    rerender(
      <ErrorBoundary>
        <Boom armed={armed} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试渲染" }));
    expect(screen.getByText("恢复正常")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("ProjectsPage", () => {
  it("shows the empty state and enables creation only with a requirement", async () => {
    render(<App />);
    expect(screen.getByText("暂无项目")).toBeTruthy();
    const create = screen.getByRole("button", { name: "创建并进入看板" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/用一句话描述你想做的项目/), {
      target: { value: "  待办应用  " },
    });
    expect(create.disabled).toBe(false);
    // planning never resolves: the app must stay in the in-progress state
    vi.mocked(window.oxCommander.runPlanning).mockReturnValue(new Promise(() => undefined));
    fireEvent.click(create);
    expect(await screen.findByText("规划进行中")).toBeTruthy();
    expect(vi.mocked(window.oxCommander.createProject)).toHaveBeenCalledWith("未命名项目", "待办应用");
  });

  it("renders projects with stage chips and deletes after confirm", async () => {
    useApp.setState({
      projects: [{ id: "p1", name: "待办应用", stage: "DONE", requirement: "x" }],
    });
    window.confirm = vi.fn(() => true);
    render(<ProjectsPage />);
    expect(screen.getByText("待办应用")).toBeTruthy();
    expect(screen.getByText("DONE")).toBeTruthy();
    fireEvent.click(screen.getByTitle("删除项目（工作区移入回收站）"));
    await waitFor(() => expect(window.oxCommander.deleteProject).toHaveBeenCalledWith("p1"));
    expect(screen.queryByText("待办应用")).toBeNull();
  });

  it("keeps the row when the user cancels the confirm dialog", () => {
    useApp.setState({
      projects: [{ id: "p1", name: "待办应用", stage: "PRD", requirement: "x" }],
    });
    window.confirm = vi.fn(() => false);
    render(<ProjectsPage />);
    fireEvent.click(screen.getByTitle("删除项目（工作区移入回收站）"));
    expect(window.oxCommander.deleteProject).not.toHaveBeenCalled();
    expect(screen.getByText("待办应用")).toBeTruthy();
  });

  it("shows why a failed delete kept the row, instead of failing silently", async () => {
    // The store records the failure rather than rejecting, so the alert has to
    // be driven from state — a `.catch` on the promise would never fire.
    useApp.setState({
      projects: [{ id: "p1", name: "待办应用", stage: "PRD", requirement: "x" }],
    });
    vi.mocked(window.oxCommander.deleteProject).mockRejectedValue(new Error("回收站不可用"));
    window.confirm = vi.fn(() => true);
    window.alert = vi.fn();
    render(<ProjectsPage />);
    fireEvent.click(screen.getByTitle("删除项目（工作区移入回收站）"));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith("删除失败: 回收站不可用"));
    // The row stays: the workspace is still on disk.
    expect(screen.getByText("待办应用")).toBeTruthy();
  });

  it("surfaces a project-list failure on the page that has no log view", () => {
    useApp.setState({ projectsError: "projects 目录不可读" });
    render(<ProjectsPage />);
    expect(screen.getByRole("alert").textContent).toContain("projects 目录不可读");
  });
});

describe("BoardPage", () => {
  function seedBoard() {
    useApp.setState({
      activeProjectId: "p-1",
      stage: "VERIFICATION",
      logs: ["第 1 行日志", "第 2 行日志"],
      tasks: {
        t1: { taskId: "t1", title: "实现任务列表", zone: "src/todo", status: "done", attempts: 1, agentId: "sensenova-api", durationMs: 15200 },
        t2: { taskId: "t2", title: "编写测试", zone: "tests", status: "failed", attempts: 2, errorClass: "rate-limit", failureDigest: "429 rpm exhausted" },
      },
      verification: VERIFICATION,
      escalations: [{ taskId: "t9", summary: "预算耗尽", resolved: false }],
    });
  }

  it("renders stages, task attribution, error labels, verification and logs", () => {
    seedBoard();
    render(<BoardPage />);
    expect(screen.getByText("④ 硬性验证")).toBeTruthy();
    expect(screen.getByText("实现任务列表")).toBeTruthy();
    expect(screen.getByText(/sensenova-api · 15\.2s/)).toBeTruthy();
    // errorClass → operator language mapping
    expect(screen.getByText("错误类型：限流")).toBeTruthy();
    expect(screen.getByText("429 rpm exhausted")).toBeTruthy();
    expect(screen.getByText("最近验证：✅ 通过")).toBeTruthy();
    expect(screen.getByText(/test: 通过 · 2\.3s/)).toBeTruthy();
    expect(screen.getByText(/第 1 行日志/)).toBeTruthy();
  });

  it("forwards control actions to the bridge", () => {
    seedBoard();
    render(<BoardPage />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "📂 打开工作区" }));
    expect(window.oxCommander.pause).toHaveBeenCalled();
    expect(window.oxCommander.cancel).toHaveBeenCalled();
    expect(window.oxCommander.openWorkspace).toHaveBeenCalledWith("p-1");
  });

  it("starts orchestration and resolves escalations through the bridge", async () => {
    seedBoard();
    render(<BoardPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(window.oxCommander.startOrchestration).toHaveBeenCalledWith("p-1"));
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => {
      expect(window.oxCommander.resolveEscalation).toHaveBeenCalledWith("t9", "skip");
      expect(screen.getByText("已处理")).toBeTruthy();
    });
  });
});

describe("PrdReviewPage", () => {
  it("shows the planning state and the failure state with retry", async () => {
    useApp.setState({ planning: true, activeProjectId: "p-1", logs: ["生成中…"] });
    const { unmount } = render(<PrdReviewPage />);
    expect(screen.getByText(/正在生成 PRD 并分解任务/)).toBeTruthy();
    unmount();

    resetStore();
    useApp.setState({ planningError: "failover client has no groups", activeProjectId: "p-1" });
    render(<PrdReviewPage />);
    expect(screen.getByText("❌ 规划失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(window.oxCommander.runPlanning).toHaveBeenCalledWith("p-1"));
  });

  it("renders the PRD with batches and approves the plan", async () => {
    useApp.setState({ prd: PRD, batches: BATCHES, activeProjectId: "p-1" });
    render(<PrdReviewPage />);
    expect(screen.getByText(PRD.goal)).toBeTruthy();
    expect(screen.getByText("任务增删")).toBeTruthy();
    expect(screen.getByText(/1 个任务 · 1 个批次/)).toBeTruthy();
    // expand the task card
    fireEvent.click(screen.getByText("实现任务列表"));
    expect(screen.getByText("在 src/todo 写增删改查")).toBeTruthy();
    expect(screen.getByText(/依赖：无/)).toBeTruthy();

    const approve = screen.getByRole("button", { name: /批准开工/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(window.oxCommander.startOrchestration).toHaveBeenCalledWith("p-1"));
  });

  it("edits the PRD and re-plans through updatePrd", async () => {
    useApp.setState({ prd: PRD, batches: BATCHES, activeProjectId: "p-1" });
    render(<PrdReviewPage />);
    fireEvent.click(screen.getByRole("button", { name: "✏️ 编辑 PRD" }));
    const goalBox = screen.getByDisplayValue(PRD.goal) as HTMLTextAreaElement;
    fireEvent.change(goalBox, { target: { value: "做一个更好的待办应用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新分解" }));
    await waitFor(() => expect(window.oxCommander.updatePrd).toHaveBeenCalled());
    const patch = vi.mocked(window.oxCommander.updatePrd).mock.calls[0]![1] as PrdDocument;
    expect(patch.goal).toBe("做一个更好的待办应用");
  });
});

describe("AgentsPanel interactions", () => {
  it("probes, toggles and unregisters agents through the bridge", async () => {
    render(<AgentsPanel />);
    expect(await screen.findByText("SenseNova 执行器")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /健康检查/ }));
    await waitFor(() => expect(window.oxCommander.probeAgents).toHaveBeenCalled());
    expect(await screen.findByText("可达")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(window.oxCommander.toggleAgent).toHaveBeenCalledWith("sensenova-api", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "注销" }));
    await waitFor(() =>
      expect(window.oxCommander.unregisterAgent).toHaveBeenCalledWith("sensenova-api", 5000),
    );
    expect(await screen.findByText(/已注销 sensenova-api/)).toBeTruthy();
  });

  it("shows the unregister failure instead of pretending it worked", async () => {
    vi.mocked(window.oxCommander.unregisterAgent).mockResolvedValue({
      ok: false,
      error: "drain 超时：仍有任务在跑",
    } as never);
    render(<AgentsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "注销" }));
    expect(await screen.findByText("drain 超时：仍有任务在跑")).toBeTruthy();
  });

  it("fills the example manifest, registers it and refreshes the pool", async () => {
    const example = { id: "codex-cli", displayName: "Codex CLI", adapter: "cli" };
    vi.mocked(window.oxCommander.exampleManifest).mockResolvedValue(example as never);
    vi.mocked(window.oxCommander.registerAgent).mockResolvedValue({
      ok: true,
      id: "codex-cli",
      replaced: false,
    } as never);
    render(<AgentsPanel />);
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    // The register button is disabled while nothing has been pasted.
    fireEvent.click(screen.getByRole("button", { name: "填入示例" }));
    await waitFor(() => expect(textarea.value).toContain("codex-cli"));
    fireEvent.click(screen.getByRole("button", { name: "注册智能体" }));
    await waitFor(() => expect(window.oxCommander.registerAgent).toHaveBeenCalled());
    expect(await screen.findByText(/已注册 codex-cli/)).toBeTruthy();
    // Success triggers a pool refresh so the new agent shows up.
    expect(vi.mocked(window.oxCommander.listAgents).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reports a JSON parse failure without calling the bridge", async () => {
    render(<AgentsPanel />);
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "{ not json" } });
    fireEvent.click(screen.getByRole("button", { name: "注册智能体" }));
    expect(await screen.findByText(/JSON 解析失败/)).toBeTruthy();
    expect(window.oxCommander.registerAgent).not.toHaveBeenCalled();
  });

  it("surfaces the handler's rejection reason for a bad manifest", async () => {
    vi.mocked(window.oxCommander.registerAgent).mockResolvedValue({
      ok: false,
      error: 'agent id "codex-cli" 已被内置或 agents.d 声明占用',
    } as never);
    render(<AgentsPanel />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: '{"id":"codex-cli"}' } });
    fireEvent.click(screen.getByRole("button", { name: "注册智能体" }));
    expect(await screen.findByText(/已被内置或 agents.d 声明占用/)).toBeTruthy();
  });

  it("shows an open circuit chip with its retry countdown", async () => {
    vi.mocked(window.oxCommander.getAgentStats).mockResolvedValue({
      circuits: {
        "sensenova-api": {
          state: "open",
          consecutiveFailures: 3,
          successes: 0,
          failures: 3,
          successRate: 0,
          retryInMs: 42_000,
        },
      },
    });
    render(<AgentsPanel />);
    expect(await screen.findByText("熔断中")).toBeTruthy();
    expect(screen.getByText(/42s 后允许探测/)).toBeTruthy();
  });

  it("surfaces a pool-list failure as an inline message", async () => {
    vi.mocked(window.oxCommander.listAgents).mockRejectedValue(new Error("agents.d 不可读"));
    render(<AgentsPanel />);
    expect(await screen.findByText("agents.d 不可读")).toBeTruthy();
  });
});

describe("SettingsPage", () => {
  it("loads settings, lists pool providers and key rows with security notice", async () => {
    render(<SettingsPage />);
    const select = (await screen.findByLabelText("提供商")) as HTMLSelectElement;
    expect(select.value).toBe("sensenova");
    // llmPool defaults: sensenova + amd-radeon checkboxes
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    await screen.findByPlaceholderText("••••••••（输入新值覆盖，留空不变）");
    expect(screen.getByText("环境变量")).toBeTruthy();
    expect(screen.getByText("未配置")).toBeTruthy();
    expect(screen.getByText(/已通过系统钥匙串加密存储/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it("reports the LLM connection test result", async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /测试连接/ }));
    expect(await screen.findByText(/✅ 连接成功（模型：deepseek-v4-flash）/)).toBeTruthy();
  });

  it("derives the route-pool copy from the provider constants instead of hard-coded counts", async () => {
    // 同一页面曾两处互不相符（线路池卡片写 4 模型、执行器说明写 3 模型）：
    // 数字手抄一遍就漂移一次，所以这里把两处都钉回常量。
    const { container } = render(<SettingsPage />);
    await screen.findByLabelText("提供商");
    const text = container.textContent ?? "";
    const keys = SENSENOVA_KEY_VARS.length;
    const models = SENSENOVA_MODELS.length;
    expect(text).toContain(`商汤 = ${keys} 密钥 × ${models} 模型`);
    expect(text).toContain(`${keys * models} 条线路`);
    expect(text).toContain(`SenseNova API 执行器：${keys} 组密钥 × ${models} 个模型`);
    // 模型名同样来自常量：手抄清单在扩池那天就会说谎
    for (const model of SENSENOVA_MODELS) expect(text).toContain(model);
  });

  it("embeds the agents panel: capabilities, circuit stats and manifest errors", async () => {
    vi.mocked(window.oxCommander.listAgents).mockResolvedValue(
      agentList({
        manifestErrors: [{ file: "bad.json", message: "id 不能为空" }],
      }),
    );
    vi.mocked(window.oxCommander.getAgentStats).mockResolvedValue({
      circuits: {
        "sensenova-api": {
          state: "closed", consecutiveFailures: 0, successes: 5, failures: 1, successRate: 0.83, retryInMs: 0,
        },
      },
    });
    render(<SettingsPage />);
    expect(await screen.findByText("智能体池")).toBeTruthy();
    expect(screen.getByText(/角色：\* · 目录：\*\*/)).toBeTruthy();
    expect(screen.getByText(/熔断：正常 · 成功 5 \/ 失败 1/)).toBeTruthy();
    expect(screen.getByText(/成功率 83%/)).toBeTruthy();
    expect(screen.getByText(/agents\.d 中有 1 个文件未通过校验/)).toBeTruthy();
    expect(screen.getByText("bad.json")).toBeTruthy();
  });

  it("saves keys typed into the password inputs", async () => {
    render(<SettingsPage />);
    const input = await screen.findByPlaceholderText("粘贴 API Key");
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
    await waitFor(() =>
      expect(window.oxCommander.saveKeys).toHaveBeenCalledWith([
        { envVar: expect.any(String), value: "sk-test-123" },
      ]),
    );
  });

  it("labels a failed load as a read failure, not a save failure", async () => {
    // `settings` stays undefined on a failed load, which also disables saving —
    // saying "保存失败" there would point at a write that never happened.
    vi.mocked(window.oxCommander.getSettings).mockRejectedValue(new Error("settings.json 损坏"));
    render(<SettingsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("读取失败");
    expect(alert.textContent).toContain("settings.json 损坏");
    const save = screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("persists edited settings via saveSettings", async () => {
    render(<SettingsPage />);
    const save = await screen.findByRole("button", { name: "保存设置" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("最大重修轮数"), { target: { value: "5" } });
    fireEvent.click(save);
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls[0]![0];
    expect(saved.maxRepairRounds).toBe(5);
  });

  it("drives the execution-strategy controls into the saved payload", async () => {
    render(<SettingsPage />);
    await screen.findByLabelText("提供商");
    fireEvent.click(screen.getByLabelText(/按能力分派任务/));
    fireEvent.click(screen.getByRole("checkbox", { name: "sensenova-api" }));
    fireEvent.change(screen.getByLabelText("并行上限"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("zone 越权处置"), { target: { value: "quarantine" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0];
    expect(saved.agentRouter).toBe(false);
    expect(saved.enabledAgents).toEqual([]);
    expect(saved.maxParallelRuns).toBe(4);
    expect(saved.arbitration).toBe("quarantine");
  });

  it("墙钟上限按分钟给、按毫秒存，归零是不限而不是立刻超时", async () => {
    render(<SettingsPage />);
    const label = "单次运行墙钟上限（分钟）";
    await screen.findByLabelText(label);
    fireEvent.change(screen.getByLabelText(label), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0].runWallClockMs).toBe(180000);

    fireEvent.change(screen.getByLabelText(label), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(vi.mocked(window.oxCommander.saveSettings).mock.calls.length).toBeGreaterThanOrEqual(2));
    const back = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0];
    expect("runWallClockMs" in back ? back.runWallClockMs : undefined).toBeUndefined();
  });

  it("persists the token budget control into the saved payload", async () => {
    render(<SettingsPage />);
    const save = await screen.findByRole("button", { name: "保存设置" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Token 预算上限"), { target: { value: "250000" } });
    fireEvent.click(save);
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0];
    expect(saved.maxTokensPerRun).toBe(250000);
  });

  it("keeps the save failure visible instead of resetting the button silently", async () => {
    vi.mocked(window.oxCommander.saveSettings).mockRejectedValue(new Error("settings.json 只读"));
    render(<SettingsPage />);
    const save = await screen.findByRole("button", { name: "保存设置" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("settings.json 只读");
  });
});
