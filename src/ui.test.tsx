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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SENSENOVA_KEY_VARS, SENSENOVA_MODELS } from "../shared/providers";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AgentsPanel } from "./components/AgentsPanel";
import { AuditPanel } from "./components/AuditPanel";
import { ProjectsPage } from "./pages/ProjectsPage";
import { BoardPage } from "./pages/BoardPage";
import { PrdReviewPage } from "./pages/PrdReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useApp } from "./store";
import { DEFAULT_SETTINGS, type PrdDocument, type ProjectSettings, type Task, type VerificationReport } from "../shared/types";
import type { AgentListResult, AgentSummary, AuditRecordView } from "./types";

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
    resolveApproval: vi.fn(async () => true),
    listAgents: vi.fn(async () => agentList()),
    exampleManifest: vi.fn(async () => ({ id: "example" }) as never),
    registerAgent: vi.fn(async () => ({ ok: true, id: "x" }) as never),
    unregisterAgent: vi.fn(async () => ({ ok: true, drained: "drained" }) as never),
    toggleAgent: vi.fn(async () => true),
    probeAgents: vi.fn(async () => ({ "sensenova-api": true })),
    getAgentStats: vi.fn(async () => ({ circuits: {} })),
    recentAudit: vi.fn(async () => []),
    listChanges: vi.fn(async () => []),
    // B1 第二半：逐行 diff 与单文件回滚（有 archiveId 的批次才点亮）。
    fileDiff: vi.fn(async () => ({
      ok: true as const,
      diff: {
        status: "modified" as const,
        lines: [
          { kind: "same" as const, text: "line1", beforeNo: 1, afterNo: 1 },
          { kind: "del" as const, text: "old", beforeNo: 2 },
          { kind: "add" as const, text: "new", afterNo: 2 },
          { kind: "same" as const, text: "line3", beforeNo: 3, afterNo: 3 },
        ],
        truncated: false,
        added: 1,
        deleted: 1,
        beforeLines: 3,
        afterLines: 3,
      },
    })),
    revertFile: vi.fn(async () => ({ ok: true as const, action: "restored" as const })),
    setTaskNote: vi.fn(async () => true),
    auditFiles: vi.fn(async () => []),
    exportAudit: vi.fn(async () => ({ ok: true as const, path: "/x/out.jsonl" })),
    // 2026-10-13 补盲区：这两个此前不在 fake 里 —— 看板恢复的成功路径与
    // interrupted 横幅因此**从未被断言过**（loadRecovery 的 catch 恒被走到）。
    boardRecovery: vi.fn(async () => ({ tasks: {}, interrupted: false })),
    verifyReceipt: vi.fn(async () => ({
      audit: {
        verdict: "not-replayed" as const,
        fingerprint: { ok: true as const, reason: "match" as const },
        replayable: 0,
        comparisons: [],
        summary: "指纹一致，未复跑。",
      },
      commands: [],
      replayed: false,
    })),
    onEvent: vi.fn(() => () => undefined),
    taskTrail: vi.fn(async () => ({ taskId: "t1", runs: [] })),
    // 2026-10-14 摄入半边：issue 选择器的供数替身（不真跑 gh）。
    listGithubIssues: vi.fn(async () => ({ ok: true as const, issues: [] })),
  };
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
    usage: undefined,
    lineHealth: undefined,
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

  /*
   * 摄入半边（2026-10-14）：从 GitHub issue 建项目。
   * 判据三条：拉取 → 列表上板；选中 → 创建时名字取标题、需求取标题+正文
   * （成文模板与 headless 共用，这里钉"用对了字段"）；没选中 → 不可点。
   * "空结果"与"失败"是两种话说法 —— 与审计面板同一条规矩。
   */
  describe("从 GitHub Issue 创建（摄入半边）", () => {
    const ISSUE = { number: 42, title: "支持暗色模式", body: "用户希望夜间使用不刺眼", state: "OPEN" };

    it("拉取 → 选中 → 创建：名字取标题、需求取标题+正文，然后进规划", async () => {
      vi.mocked(window.oxCommander.listGithubIssues).mockResolvedValue({ ok: true, issues: [ISSUE] });
      render(<ProjectsPage />);
      fireEvent.click(screen.getByRole("button", { name: "拉取 issue" }));
      await waitFor(() => expect(screen.getByText(/#42 \[OPEN\] 支持暗色模式/)).toBeTruthy());
      fireEvent.click(screen.getByRole("radio"));
      fireEvent.click(screen.getByRole("button", { name: "用这条 issue 创建" }));
      await waitFor(() =>
        expect(window.oxCommander.createProject).toHaveBeenCalledWith(
          "支持暗色模式",
          "GitHub Issue #42：支持暗色模式\n\n用户希望夜间使用不刺眼",
        ),
      );
      // 与手填创建同一条链路：建完即进 PRD 复核页并开跑规划
      await waitFor(() => expect(window.oxCommander.runPlanning).toHaveBeenCalled());
    });

    it("没选中时创建按钮不可点（不能建一个空需求项目）", async () => {
      vi.mocked(window.oxCommander.listGithubIssues).mockResolvedValue({ ok: true, issues: [ISSUE] });
      render(<ProjectsPage />);
      fireEvent.click(screen.getByRole("button", { name: "拉取 issue" }));
      await waitFor(() => expect(screen.getByText(/#42/)).toBeTruthy());
      expect(screen.getByRole("button", { name: "用这条 issue 创建" })).toHaveProperty("disabled", true);
    });

    it("空列表与失败是两种话说法（'没有 issue' ≠ '没拿到'）", async () => {
      vi.mocked(window.oxCommander.listGithubIssues).mockResolvedValue({ ok: true, issues: [] });
      render(<ProjectsPage />);
      fireEvent.click(screen.getByRole("button", { name: "拉取 issue" }));
      await waitFor(() => expect(screen.getByText("没有符合条件的 issue。")).toBeTruthy());
      expect(screen.queryByRole("alert")).toBeNull();

      vi.mocked(window.oxCommander.listGithubIssues).mockResolvedValue({
        ok: false,
        reason: "gh issue list 失败（gh 未安装 / 未登录 / 仓库不存在？）:not logged in",
      });
      fireEvent.click(screen.getByRole("button", { name: "拉取 issue" }));
      await waitFor(() => expect(screen.getByRole("alert")?.textContent).toContain("not logged in"));
      expect(screen.queryByText("没有符合条件的 issue。")).toBeNull();
    });
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
      approvals: [{ requestId: "a-1", command: "npm", args: ["run", "deploy"], resolved: false }],
    });
  }

  /**
   * 批次改动面板（B1）：第一半"改了哪些文件"，第二半"改了什么、能不能只撤
   * 这一个"。钉三件事：diff 按钮把 (batchId, path) 原样送进桥、回滚要过
   * confirm 且成功后重新取数、没有 archiveId 的批次不出现按钮（不放必然
   * 失败的操作）。
   */
  describe("改动文件面板（changes:list + diff / 回滚）", () => {
    const withArchive = [
      {
        ts: "2026-10-17T02:00:00Z",
        changed: 1,
        archiveId: "r-1__abc-1",
        files: [{ path: "src/a.js", op: "modify", bytes: 12 }],
      },
    ];

    it("点 diff：桥收到 (batchId, path)，逐行 diff 上屏（增删带 +/- 号不只靠颜色）", async () => {
      (window.oxCommander.listChanges as ReturnType<typeof vi.fn>).mockResolvedValue(withArchive);
      seedBoard();
      render(<BoardPage />);

      // listChanges 是 Promise：等首批记录上屏再点
      await waitFor(() =>
        expect(screen.getByTitle("看这一版的逐行 diff（存档旧内容 × 盘上现状）")).toBeTruthy(),
      );
      fireEvent.click(screen.getByTitle("看这一版的逐行 diff（存档旧内容 × 盘上现状）"));
      await waitFor(() => expect(window.oxCommander.fileDiff).toHaveBeenCalledWith("r-1__abc-1", "src/a.js"));

      // del 行与 add 行都在，且带符号
      expect(screen.getByText("old")).toBeTruthy();
      expect(screen.getByText("new")).toBeTruthy();
      expect(screen.getByText("+1 / -1 行")).toBeTruthy();
      // 汇总行说明这是"有存档"的一批（summary 与底部说明各有一处，取大于 0）
      expect(screen.getAllByText(/有存档/).length).toBeGreaterThan(0);
    });

    it("点回滚：confirm 取消就不打桥；确认后打桥、成功后重新取数", async () => {
      const listChanges = window.oxCommander.listChanges as ReturnType<typeof vi.fn>;
      listChanges.mockResolvedValue(withArchive);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      seedBoard();
      render(<BoardPage />);

      // 取消 ⇒ 一个 IPC 都不打
      const revertTitle = "从本批存档恢复这个文件（需二次确认）";
      fireEvent.click(await waitFor(() => screen.getByTitle(revertTitle)));
      expect(window.oxCommander.revertFile).not.toHaveBeenCalled();

      // 确认 ⇒ 打桥 + 成功反馈 + 重新取数（盘上变了，列表与 diff 都旧了）
      confirmSpy.mockReturnValue(true);
      listChanges.mockClear();
      fireEvent.click(await waitFor(() => screen.getByTitle(revertTitle)));
      await waitFor(() =>
        expect(window.oxCommander.revertFile).toHaveBeenCalledWith("r-1__abc-1", "src/a.js"),
      );
      await waitFor(() => expect(screen.getByText("已恢复为存档里的旧内容。")).toBeTruthy());
      expect(listChanges).toHaveBeenCalled();
    });

    it("回滚被主进程拒绝时把理由摆出来（不静默）", async () => {
      (window.oxCommander.listChanges as ReturnType<typeof vi.fn>).mockResolvedValue(withArchive);
      (window.oxCommander.revertFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        reason: "无备份、也没有本批新建的证据：这可能是既有文件，不删",
      });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      seedBoard();
      render(<BoardPage />);

      fireEvent.click(
        await waitFor(() => screen.getByTitle("从本批存档恢复这个文件（需二次确认）")),
      );
      await waitFor(() => expect(screen.getByText(/回滚被拒绝：无备份/)).toBeTruthy());
    });

    it("没有 archiveId 的批次不出现 diff / 回滚按钮", async () => {
      (window.oxCommander.listChanges as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ts: "2026-10-17T01:00:00Z", changed: 1, files: [{ path: "src/b.js", op: "create" }] },
      ]);
      seedBoard();
      render(<BoardPage />);

      // 等面板取数回来（无 archiveId 的那一条）
      await waitFor(() => expect(screen.getByText("src/b.js")).toBeTruthy());
      expect(screen.queryByTitle("看这一版的逐行 diff（存档旧内容 × 盘上现状）")).toBeNull();
      expect(screen.queryByTitle("从本批存档恢复这个文件（需二次确认）")).toBeNull();
      // 边界写在卡片上，不是藏进文档
      expect(screen.getByText(/没有存档的批次/)).toBeTruthy();
    });
  });

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

  /**
   * 日志视图的两笔性能账（2026-10-14 全栈评价的前端性能项），各钉一条：
   *
   * ① **帧合并**：流式输出时日志事件几十条/秒，旧实现每条事件同步重建整块
   *    文本；新实现按帧合并，后到的更新取消前一次的调度。判据选"中间态
   *    从未上屏"—— 它同时是一条**回归测试**：旧实现会在第一次 act 就把
   *    "第 3 行日志"渲染出来，`queryByText` 非空即红。
   * ② **逐行结构**：content-visibility 按元素跳过布局，前提是一行一个元素
   *    （jsdom 的 CSSOM 不认 content-visibility，跳过渲染本身由 Chromium
   *    保证，单测只钉结构面）。
   */
  it("日志按帧合并：后到的更新合掉前一次的帧，中间态不上屏", async () => {
    seedBoard();
    render(<BoardPage />);
    expect(screen.getByText(/第 1 行日志/)).toBeTruthy();
    // 第一次帧更新：入队但未渲染（rAF 未到）
    act(() => {
      useApp.setState({ logs: [...useApp.getState().logs, "第 3 行日志"] });
    });
    // 第二次帧更新：取消上一次调度，改挂最新的
    act(() => {
      useApp.setState({ logs: [...useApp.getState().logs, "第 4 行日志"] });
    });
    // "第 3 行日志" 从未上过屏 —— 旧实现（每条事件同步渲染）会在这里红
    expect(screen.queryByText("第 3 行日志")).toBeNull();
    // 帧到：直接是最新
    await waitFor(() => expect(screen.getByText("第 4 行日志")).toBeTruthy());
  });

  it("日志逐行渲染：一行一个节点；空态有占位（content-visibility 窗口化的结构面）", () => {
    seedBoard();
    const first = render(<BoardPage />);
    expect(first.container.querySelectorAll(".log-line").length).toBe(2);
    expect(screen.getByText("第 2 行日志")).toBeTruthy();
    first.unmount();

    useApp.setState({ logs: [] });
    const second = render(<BoardPage />);
    expect(screen.getByText("等待开始…")).toBeTruthy();
    expect(second.container.querySelectorAll(".log-line").length).toBe(0);
  });

  it("renders approval cards and forwards approval decisions to the bridge", () => {
    seedBoard();
    render(<BoardPage />);
    // 审批卡：命令 + 参数可见，批准/拒绝两个动作
    expect(screen.getByText("🛂 命令需要审批")).toBeTruthy();
    expect(screen.getByText("npm run deploy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(window.oxCommander.resolveApproval).toHaveBeenCalledWith("a-1", true);
  });

  /**
   * 操作者附言编辑器（C2 的界面出口）。钉三件事：① 保存真的过桥
   * （不是只改本地 state）；② 已挂附言的任务摘要显示"已挂"；③ 升级卡里
   * 也有入口 —— "带话重派"是人在回路里最常用的形态。
   */
  it("附言编辑器：保存过桥、已挂附言有标记、升级卡也有入口", async () => {
    useApp.setState({
      activeProjectId: "p-1",
      stage: "VERIFICATION",
      tasks: {
        t2: { taskId: "t2", title: "编写测试", zone: "tests", status: "failed", attempts: 2, operatorNote: "先修编译错" },
      },
      escalations: [{ taskId: "t9", summary: "预算耗尽", resolved: false }],
    });
    render(<BoardPage />);
    expect(screen.getByText("✏️ 附言（已挂）")).toBeTruthy();
    fireEvent.click(screen.getByText("✏️ 附言（已挂）"));
    // 任务行与升级卡各有一个编辑器：取任务行那个（第一个）
    fireEvent.change(screen.getAllByPlaceholderText(/纠偏指示/)[0]!, { target: { value: "改口径" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存附言" })[0]!);
    await waitFor(() => expect(window.oxCommander.setTaskNote).toHaveBeenCalledWith("t2", "改口径"));
    // 升级卡：未决任务的附言入口（"带话重派"）
    expect(screen.getByText(/带话重派/)).toBeTruthy();
  });

  it("SILENCE_LABEL 打表：不足阈值不显示，超过点名（长任务与挂死可区分）", async () => {
    const { SILENCE_LABEL } = await import("./pages/BoardPage");
    const now = 1_000_000;
    expect(SILENCE_LABEL(now - 5_000, now)).toBeUndefined(); // 5s：正常
    expect(SILENCE_LABEL(now - 29_000, now)).toBeUndefined(); // 29s：阈值内
    expect(SILENCE_LABEL(now - 30_000, now)).toBe("⏸ 静默 30s");
    expect(SILENCE_LABEL(now - 125_000, now)).toBe("⏸ 静默 125s");
  });

  /**
   * 任务运行履历（`audit:trail` 的界面出口，2026-10-14 接线）。
   *
   * 这条通道此前是**静默不可用**的：主进程 handler 与 preload 转发都在，但渲染层
   * 桥接类型里没声明它 ⇒ 界面拿不到有类型的句柄、从没调用过。所以这里除了钉 UI
   * 行为，还钉住"它真的被调用了"。
   */
  describe("任务运行履历（audit:trail）", () => {
    /**
     * 展开某一条任务行的履历。
     *
     * 直接置 `open` 再派发 `toggle`，不靠 `fireEvent.click(summary)`：jsdom 对
     * `<details>` 的点击→展开行为支持不稳定，而**我们的契约**是 `onToggle` 里读
     * `currentTarget.open`（"展开了就去取数"），不是"点击一定展开" —— 后者是浏览器
     * 的行为，不该由本仓库的用例替它担保。
     *
     * 用 `fireEvent(el, new Event("toggle"))` 而不是 `fireEvent.toggle`：后者在这个
     * 版本的 testing-library 里不存在；而 React 把 `toggle` 归在非委托事件里
     * （直接挂元素，不走根容器），所以派发到元素本身就够。
     *
     * ⚠️ **jsdom 会为同一次 `open` 变更自己再补发一个 `toggle`**（按 spec，toggle 是
     * 异步排队的）。所以一次 `openTrail` 大概率会让 `onToggle` 跑两遍 —— 真实浏览器里
     * 用户展开只派发一次，这是脚手架的产物。两个后果必须知道：
     *   1. 桩要用**持久**实现（`mockResolvedValue` / `mockRejectedValue`），
     *      不能用 `…Once`：第一发被第二次事件覆盖，断言会看到"另一个结局"。
     *   2. 正好顺带证明了 `loadTrail` 的去重是必要的 —— 没有 `trailRequested`，
     *      每次展开都会打两次全量审计读。
     */
    function openTrail(container: HTMLElement, index = 0): void {
      const details = container.querySelectorAll<HTMLDetailsElement>(".trail-details")[index]!;
      details.open = true;
      fireEvent(details, new Event("toggle"));
    }

    it("TRAIL_RUN_LINE 打表：四档结局分开，缺席不许折进失败", async () => {
      const { TRAIL_RUN_LINE } = await import("./pages/BoardPage");
      expect(
        TRAIL_RUN_LINE({ startedAt: "s", endedAt: "e", agentId: "a", ok: true, durationMs: 1200 }),
      ).toBe("a · 1.2s · ✅ 成功");
      expect(
        TRAIL_RUN_LINE({ startedAt: "s", endedAt: "e", agentId: "b", ok: false, durationMs: 2000 }),
      ).toBe("b · 2.0s · ❌ 失败");
      // endedAt 缺席 = 这次派发没有收尾（进程被腰斩 / 重派时前一次还没回来）
      expect(TRAIL_RUN_LINE({ startedAt: "s", agentId: "c" })).toBe("c · 时长未知 · ⚠️ 未收尾");
      // ok 缺席 = run-end 里没带裁决。把它算作失败就是替审计编造因果
      expect(TRAIL_RUN_LINE({ startedAt: "s", endedAt: "e" })).toBe("未知执行器 · 时长未知 · 结局未知");
    });

    it("挂载时不打 IPC；展开才取数，同一任务只取一次", async () => {
      seedBoard();
      const { container } = render(<BoardPage />);

      // 挂载即取数的话，几十条任务行会在看板打开时各打一次全量审计读 —— 那是固定成本
      expect(window.oxCommander.taskTrail).not.toHaveBeenCalled();

      openTrail(container);
      await waitFor(() => expect(window.oxCommander.taskTrail).toHaveBeenCalledWith("t1"));

      // 折叠再展开：履历是**归档事实**，本次 run 里不会变，没必要再问一遍
      openTrail(container);
      expect(vi.mocked(window.oxCommander.taskTrail)).toHaveBeenCalledTimes(1);
    });

    it("多条派发按序列出，并给出执行器、耗时与结局", async () => {
      seedBoard();
      vi.mocked(window.oxCommander.taskTrail).mockResolvedValue({
        taskId: "t1",
        runs: [
          { startedAt: "t1", endedAt: "t2", agentId: "cli-a", ok: false, durationMs: 900, errorClass: "timeout", digest: "超时" },
          { startedAt: "t3", agentId: "cli-b" },
        ],
      });
      const { container } = render(<BoardPage />);
      openTrail(container);

      await waitFor(() => expect(screen.getByText(/#1/)).toBeTruthy());
      expect(screen.getByText("cli-a · 0.9s · ❌ 失败")).toBeTruthy();
      expect(screen.getByText("错误类型：超时")).toBeTruthy();
      expect(screen.getByText("cli-b · 时长未知 · ⚠️ 未收尾")).toBeTruthy();
      // 未收尾那一条要被单独标出来（CSS 上有区分），不能和失败混成一样
      expect(container.querySelectorAll(".trail-list li.trail-open")).toHaveLength(1);
    });

    it("取不到要说得清，并且允许再展开一次重试", async () => {
      seedBoard();
      vi.mocked(window.oxCommander.taskTrail).mockRejectedValue(new Error("审计目录不可读"));
      const { container } = render(<BoardPage />);

      openTrail(container);
      // 持久失败（不是 …Once）：见 openTrail 的注释 —— 一次展开可能触发两次 toggle
      await waitFor(() =>
        expect(container.querySelector(".trail-details")!.textContent).toContain(
          "读不到履历：审计目录不可读",
        ),
      );

      // 失败不是终态：再展开一次要真的重试（IPC 抖一下不该让履历永久空白）
      vi.mocked(window.oxCommander.taskTrail).mockResolvedValue({
        taskId: "t1",
        runs: [{ startedAt: "s", endedAt: "e", agentId: "cli-a", ok: true }],
      });
      openTrail(container);
      await waitFor(() => expect(screen.getByText("cli-a · 时长未知 · ✅ 成功")).toBeTruthy());
    });

    it("没有记录时如实说没有记录，不装成空白加载态", async () => {
      seedBoard();
      vi.mocked(window.oxCommander.taskTrail).mockResolvedValue({ taskId: "t1", runs: [] });
      const { container } = render(<BoardPage />);
      openTrail(container);
      await waitFor(() => expect(screen.getByText("审计里没有这个任务的派发记录")).toBeTruthy());
    });

    it("不同任务各取各的（履历按 taskId 分开，不串行）", async () => {
      seedBoard();
      vi.mocked(window.oxCommander.taskTrail).mockResolvedValue({ taskId: "x", runs: [] });
      const { container } = render(<BoardPage />);

      openTrail(container, 0);
      openTrail(container, 1);
      await waitFor(() => expect(window.oxCommander.taskTrail).toHaveBeenCalledTimes(2));
      expect(vi.mocked(window.oxCommander.taskTrail).mock.calls.map((c) => c[0])).toEqual(["t1", "t2"]);
    });
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
    // 2026-10-13 起"开始"在 run 运行中禁用（runActive）：seedBoard 是 VERIFICATION，
    // 这里回到未开工的 PRD 态再点 —— 用例意图（桥接转发）不变。
    useApp.setState({ stage: "PRD" });
    render(<BoardPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => expect(window.oxCommander.startOrchestration).toHaveBeenCalledWith("p-1"));
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => {
      expect(window.oxCommander.resolveEscalation).toHaveBeenCalledWith("t9", "skip");
      expect(screen.getByText("已处理")).toBeTruthy();
    });
  });

  it("控制按钮按运行态联动：跑的时候不能重新开始，有结论后不能取消（2026-10-13）", () => {
    seedBoard(); // VERIFICATION 且无凭据 = 运行态
    render(<BoardPage />);
    expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "暂停" }) as HTMLButtonElement).disabled).toBe(false);
    // 凭据出现 = 本 run 有结论（failed 也是结论）→ 控制面收回、开始解锁。
    // render 之后改 store 要包 act：zustand 的订阅在 React 18 里走微任务批处理，
    // 不包 act 时 DOM 还没刷，断言会读到旧帧。
    act(() => {
      useApp.setState({
        stage: "DONE",
        receipt: {
          outcome: "blocked",
          verified: false,
          rounds: 0,
          headline: "未交付",
          counts: { total: 2, done: 1, failed: 1, skipped: 0, pending: 0, conflicts: 0, checksFailed: 1, preexisting: 0 },
          checks: [],
          tasks: [],
          conflicts: [],
        },
      });
    });
    expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "暂停" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("重新开始会清掉上一轮的凭据与验证结论（它们属于上一次运行，2026-10-13）", async () => {
    seedBoard();
    useApp.setState({
      verification: VERIFICATION,
      receipt: {
        outcome: "blocked",
        verified: false,
        rounds: 0,
        headline: "未交付",
        counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
        checks: [],
        tasks: [],
        conflicts: [],
      },
    });
    await useApp.getState().confirmAndExecute();
    const s = useApp.getState();
    expect(s.stage).toBe("DEVELOPMENT");
    expect(s.receipt).toBeUndefined();
    expect(s.verification).toBeUndefined();
    expect(typeof s.runStartedAt).toBe("number"); // 已耗时展示的数据源
  });

  it("看板显示运行已耗时（runStartedAt 起算，2026-10-13）", () => {
    seedBoard(); // VERIFICATION = 运行态
    useApp.setState({ runStartedAt: Date.now() - 65_000 });
    render(<BoardPage />);
    expect(screen.getByText(/已耗时/)).toBeTruthy();
    // 无运行态（有凭据）时不显示 —— 它是"本次 run"的计时器（render 后改 store 要包 act）
    act(() => {
      useApp.setState({ stage: "DONE" });
    });
    expect(screen.queryByText(/已耗时/)).toBeNull();
  });

  it("verifyReceipt 的守卫：没凭据或没项目就不打桥（2026-10-13）", async () => {
    // 杀 `!pid || !receipt` → `&&`：变异后两个负例都会继续调桥 —— 守卫失效
    // 的形态是"没有凭据也能点复核"，桥上会拿到一次注定失败的调用。
    const RECIPT = {
      outcome: "delivered" as const,
      verified: true,
      rounds: 0,
      headline: "交付完成",
      counts: { total: 1, done: 1, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
      checks: [],
      tasks: [],
      conflicts: [],
    };
    useApp.setState({ activeProjectId: "p-1", receipt: undefined });
    await useApp.getState().verifyReceipt();
    expect(window.oxCommander.verifyReceipt).not.toHaveBeenCalled();
    useApp.setState({ activeProjectId: undefined, receipt: RECIPT });
    await useApp.getState().verifyReceipt();
    expect(window.oxCommander.verifyReceipt).not.toHaveBeenCalled();
  });

  it("恢复路径上板：interrupted 横幅、恢复日志与恢复的任务都出现（2026-10-13 补盲区）", async () => {
    // 此前 fake bridge 没有 boardRecovery，loadRecovery 的 catch 恒被走到 ——
    // "恢复成功"这条主线（被杀进程后重开看板）零断言。
    useApp.setState({ activeProjectId: "p-1" });
    (window.oxCommander.boardRecovery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tasks: {
        t1: { taskId: "t1", title: "实现任务列表", zone: "src/todo", status: "done", attempts: 1, agentId: "sensenova-api" },
      },
      stage: "VERIFICATION",
      interrupted: true,
      lastActivityTs: "2026-10-13T00:00:00.000Z",
    });
    render(<BoardPage />);
    await waitFor(() => expect(screen.getByText(/上一次运行未正常收尾/)).toBeTruthy());
    // 恢复日志走 LogView 的帧合并（2026-10-14）：横幅是 BoardPage 自己的 state、
    // 同步上板；日志行要等下一个动画帧 —— 所以这条断言等帧，上面那条不等。
    await waitFor(() => expect(screen.getByText(/已从审计日志恢复上次运行的进度/)).toBeTruthy());
    expect(screen.getByText("实现任务列表")).toBeTruthy();
    expect(screen.getByText(/最后活动时间/)).toBeTruthy();
  });

  it("凭据卡一键复核并摆出五档裁决（2026-10-13：把 receipt:verify 接上 UI）", async () => {
    seedBoard();
    useApp.setState({
      receipt: {
        outcome: "delivered",
        verified: true,
        rounds: 0,
        headline: "交付完成",
        counts: { total: 1, done: 1, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
        checks: [],
        tasks: [],
        conflicts: [],
        fingerprint: "fp-abc",
      },
    });
    render(<BoardPage />);
    fireEvent.click(screen.getByRole("button", { name: /复核凭据/ }));
    await waitFor(() => expect(screen.getByText(/复核裁决/)).toBeTruthy());
    // 默认 replay:false —— 裁决与"未复跑"标注一起摆
    expect(window.oxCommander.verifyReceipt).toHaveBeenCalledWith("p-1", false);
    expect(screen.getByText(/未复跑/)).toBeTruthy();
  });

  it("本次运行用量上板：可信边界与预算盲区都念出来", () => {
    seedBoard();
    useApp.setState({
      usage: {
        totalTokens: 42,
        calls: 3,
        measuredCalls: 1,
        byModel: { "ollama/qwen2.5:14b": 42 },
        limit: 1000,
      },
    });
    render(<BoardPage />);
    expect(screen.getByText("本次运行用量")).toBeTruthy();
    expect(
      screen.getByText("42 tokens · 3 次调用 · 2 次未上报用量 · ollama/qwen2.5:14b=42"),
    ).toBeTruthy();
    expect(screen.getByText("预算上限 1000 tokens")).toBeTruthy();
    // 有预算 + 有未上报 ⇒ 必须说破"这道闸看不见它们"，否则数字被读成全部支出
    expect(screen.getByText(/这道闸看不见它们/)).toBeTruthy();
  });

  it("全部调用都上报时不喊盲区（别把安全读成危险）", () => {
    seedBoard();
    useApp.setState({
      usage: { totalTokens: 7, calls: 1, measuredCalls: 1, byModel: {}, limit: 1000 },
    });
    render(<BoardPage />);
    expect(screen.getByText("7 tokens · 1 次调用")).toBeTruthy();
    expect(screen.getByText("预算上限 1000 tokens")).toBeTruthy();
    expect(screen.queryByText(/这道闸看不见它们/)).toBeNull();
  });

  it("线路健康上板：冷却剩余与限流次数都要看得见", () => {
    seedBoard();
    useApp.setState({
      lineHealth: [
        { key: "sensenova:SENSENOVA_API_KEY#0", cooling: true, remainingMs: 7_000, failures: 3, rateLimitHits: 2, consecutiveFailures: 2 },
        { key: "sensenova:SENSENOVA_API_KEY#1", cooling: false, remainingMs: 0, failures: 0, rateLimitHits: 0, consecutiveFailures: 0 },
      ],
    });
    render(<BoardPage />);
    expect(screen.getByText("线路健康")).toBeTruthy();
    expect(screen.getByText(/冷却中（约 7s）/)).toBeTruthy();
    expect(screen.getByText(/sensenova:SENSENOVA_API_KEY#0 · 失败 3 次（限流 2） · 连续坏 2 轮/)).toBeTruthy();
    // 可用那条也要在表里：界面要能回答"还剩几条能用"
    expect(screen.getByText(/可用 · sensenova:SENSENOVA_API_KEY#1/)).toBeTruthy();
  });

  it("没有线路数据时不该摆一张空表", () => {
    seedBoard();
    render(<BoardPage />);
    expect(screen.queryByText("线路健康")).toBeNull();
  });

  it("交付凭据把外部可验证性的两半都摆出来：跑过的命令 + 内容指纹", () => {
    // 这两样在 serve 状态页是整份渲染的，桌面此前一个都没有 —— "过了门禁"在那里
    // 是可复核的结论，在这里只是一句自述。任务账同样此前在桌面无出口。
    seedBoard();
    useApp.setState({
      receipt: {
        outcome: "delivered",
        verified: true,
        rounds: 1,
        headline: "交付完成：1 个任务全过",
        counts: { total: 1, done: 1, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 1, preexisting: 0 },
        checks: [
          { kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "", command: "npm", args: ["run", "build"] },
          { kind: "test", ok: false, exitCode: 1, preexisting: false, headline: "2 failed", command: "npm", args: ["run", "test"] },
        ],
        tasks: [
          { id: "t1", title: "实现任务列表", zone: "src/todo", status: "done", attempts: 2, agentId: "sensenova-api", durationMs: 15_200 },
        ],
        conflicts: [],
        fingerprint: "fp-9f8e7d6c5b4a",
      },
    });
    render(<BoardPage />);
    // 第一半：命令原样可见（command + args 拼成一条能直接粘走执行的串）
    expect(screen.getByText("npm run build")).toBeTruthy();
    expect(screen.getByText("npm run test")).toBeTruthy();
    // 第二半：指纹整串可见可选 —— 截短显示等于"看得到但用不了"
    expect(screen.getByText("fp-9f8e7d6c5b4a")).toBeTruthy();
    expect(screen.getByText(/实现任务列表 · src\/todo · 2 次 · sensenova-api · 15\.2s/)).toBeTruthy();
  });

  it("命令 / 指纹 / 任务账缺席时一个空壳都不摆（字段即承诺）", () => {
    seedBoard();
    useApp.setState({
      receipt: {
        outcome: "blocked",
        verified: false,
        unverifiedReason: "没有配置验证命令",
        rounds: 0,
        headline: "未交付",
        counts: { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, conflicts: 0, checksFailed: 0, preexisting: 0 },
        // 没有 command 的检查是合法的（纯逻辑判定），不能摆出一个空行
        checks: [{ kind: "build", ok: true, exitCode: 0, preexisting: false, headline: "" }],
        tasks: [],
        conflicts: [],
      },
    });
    render(<BoardPage />);
    expect(screen.queryByText(/内容指纹/)).toBeNull();
    expect(screen.queryByText(/任务账/)).toBeNull();
  });

  it("看板页挂审计日志：落盘的历史跟着实时流同栏可见（改前应挂的基线用例）", () => {
    seedBoard();
    render(<BoardPage />);
    // 实时日志只活在内存里，重载即消失；落盘审计管的是"上一次到底发生过什么"。
    // 两者语义相邻，看板页必须同时给出这两份事实。
    expect(screen.getByText("审计日志")).toBeTruthy();
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

  it("停用某个账号：写进设置的是「停用」而不是删密钥（P1-2 热切换）", async () => {
    // 停用 = 这个 key 名下的整组线路立刻不进池，而密钥值还在盘上（随时能开回来）；
    // 与"清除"是两件事。写错成清除就是不可逆操作。
    render(<SettingsPage />);
    await screen.findByLabelText("提供商");
    const toggles = await screen.findAllByLabelText("停用这个账号");
    expect(toggles.length).toBeGreaterThan(0);
    fireEvent.click(toggles[0]!);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved.disabledKeyVars).toEqual(["SENSENOVA_API_KEY"]);
  });

  it("线路顺序可调：↓ 把靠前的提供商挪到后面", async () => {
    render(<SettingsPage />);
    await screen.findByLabelText("提供商");
    // 顺序即优先级：越靠前越先被试。默认 sensenova 在 amd-radeon 之前。
    fireEvent.click(screen.getAllByTitle("下移")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved.llmPool).toEqual(["amd-radeon", "sensenova"]);
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

  it("大脑层超时按秒填、按毫秒存；填 0 是『用默认』而不是 0 毫秒", async () => {
    render(<SettingsPage />);
    const input = await screen.findByLabelText("大脑层单次调用超时（秒）");

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByText("保存设置"));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved.brainTimeoutMs).toBe(45_000);

    // 0 毫秒的超时没有意义：存成 undefined（= 用内置默认），不能存 0。
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText("保存设置"));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalledTimes(2));
    const saved2 = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved2.brainTimeoutMs).toBeUndefined();
  });

  it("执行器超时同样按秒填、按毫秒存；填 0 是『用默认』", async () => {
    render(<SettingsPage />);
    const input = await screen.findByLabelText("执行器单次调用超时（秒）");

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.click(screen.getByText("保存设置"));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved.executorTimeoutMs).toBe(45_000);

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText("保存设置"));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalledTimes(2));
    const saved2 = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved2.executorTimeoutMs).toBeUndefined();
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

  it("三个 P1-5 控件（升级策略 / 快照根 / 清单目录）进保存载荷；路径空串存 undefined", async () => {
    render(<SettingsPage />);
    await screen.findByLabelText("提供商");
    fireEvent.change(screen.getByLabelText("重修耗尽处置"), { target: { value: "redispatch_once" } });
    fireEvent.change(screen.getByLabelText("快照备份根目录"), { target: { value: "  D:/custom-snaps  " } });
    fireEvent.change(screen.getByLabelText("智能体清单目录"), { target: { value: "D:/custom-agents.d" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(window.oxCommander.saveSettings).toHaveBeenCalled());
    const saved = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(saved.escalationPolicy).toBe("redispatch_once");
    expect(saved.snapshotRoot).toBe("D:/custom-snaps"); // 两端空白要 trim
    expect(saved.manifestDir).toBe("D:/custom-agents.d");

    // 空串与"想回到默认"同义：存 undefined（省略字段 = 用内置默认），不能存空串 ——
    // 空串进到 `||` 回退里虽然也是默认，但省略字段才是 DEFAULT_SETTINGS 的合并语义。
    fireEvent.change(screen.getByLabelText("快照备份根目录"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(vi.mocked(window.oxCommander.saveSettings).mock.calls.length).toBeGreaterThanOrEqual(2));
    const back = vi.mocked(window.oxCommander.saveSettings).mock.calls.at(-1)![0] as ProjectSettings;
    expect(back.snapshotRoot).toBeUndefined();
    expect(back.escalationPolicy).toBe("redispatch_once"); // 其他控件的状态不被清空
  });
});

describe("AuditPanel", () => {
  // 组件级行为测试：钉的是"记录真的被念出来"，而不是"组件渲染了没崩"——
  // 后者空数组也能过。渲染 AuditPanel 本体而不是宿主页面，行为断言与
  // 页面布局解耦：面板挂在设置页还是看板页，这些测试都不用动。
  it("智能体统计：同一只手的多条记录折成一行成功/失败，失败多的排前面", async () => {
    vi.mocked(window.oxCommander.recentAudit).mockResolvedValue([
      { ts: "2026-09-26T03:09:00.000Z", phase: "run-start" },
      { ts: "2026-09-26T03:15:00.000Z", phase: "run-end", ok: true, durationMs: 42000 },
      { ts: "2026-09-26T03:10:00.000Z", phase: "agent-change", agentId: "sensenova-api", ok: true },
      {
        ts: "2026-09-26T03:11:00.000Z",
        phase: "batch-guard",
        agentId: "sensenova-api",
        ok: false,
        errorClass: "conflict",
      },
      {
        ts: "2026-09-26T03:12:00.000Z",
        phase: "batch-guard",
        agentId: "codex-cli",
        ok: false,
        errorClass: "rate-limit",
      },
      {
        ts: "2026-09-26T03:13:00.000Z",
        phase: "batch-guard",
        agentId: "codex-cli",
        ok: false,
        errorClass: "timeout",
      },
    ] as AuditRecordView[]);

    render(<AuditPanel />);
    expect(await screen.findByText(/codex-cli：成功 0 · 失败 2/)).toBeTruthy();
    expect(screen.getByText(/sensenova-api：成功 1 · 失败 1/)).toBeTruthy();
    // run 起止没有 agentId：它们是 run 级事实，不是某只手的，不进聚合
    expect(screen.queryByText(/成功 0 · 失败 0/)).toBeNull();
    // 失败多的智能体排在前面 —— 操作者先看到最不稳的那只手
    const rows = screen.getAllByText(/：成功 /);
    expect(rows[0]!.textContent).toContain("codex-cli");
  });

  it("把落盘的记录念出来：最新在上、失败分类与路径总数都在", async () => {
    vi.mocked(window.oxCommander.recentAudit).mockResolvedValue([
      {
        ts: "2026-09-26T03:10:00.000Z",
        phase: "run-end",
        runId: "run-0000000000000001",
        ok: true,
        durationMs: 42000,
      },
      {
        ts: "2026-09-26T03:12:04.123Z",
        phase: "batch-guard",
        runId: "run-0000000000000001",
        agentId: "sensenova-api",
        zone: "src/todo",
        ok: false,
        errorClass: "conflict",
        changed: 3,
        paths: ["src/todo/a.ts", "src/todo/b.ts", "src/todo/c.ts", "src/todo/d.ts"],
        pathsTotal: 9,
      },
    ] as AuditRecordView[]);
    vi.mocked(window.oxCommander.auditFiles).mockResolvedValue(["audit-2026-09-26-000.jsonl"]);

    render(<AuditPanel />);
    expect(await screen.findByText("审计日志")).toBeTruthy();

    // 留了几份文件要说出来，否则用户不知道历史到底有多长
    expect(screen.getByText(/当前共 1 个文件/)).toBeTruthy();
    expect(screen.getByText(/audit-2026-09-26-000\.jsonl/)).toBeTruthy();

    // 最新在上 —— read() 返回的是 newest last
    const stamps = screen.getAllByText(/03:1[02]/);
    expect(stamps.length).toBe(2);
    expect(stamps[0]!.textContent).toContain("03:12:04");
    expect(stamps[1]!.textContent).toContain("03:10:00");

    // 限定 li：阶段名在筛选下拉的 <option> 里也有一份，不加 selector 会匹配到两个元素
    expect(screen.getByText(/批次守卫/, { selector: "li" })).toBeTruthy();
    expect(screen.getByText(/失败 · conflict/)).toBeTruthy();
    expect(screen.getByText(/变更 3 个文件/)).toBeTruthy();
    // 只预览 3 个路径，但总数要说全 —— 否则看着像"只动了 3 个文件"
    expect(screen.getByText(/等 9 个/)).toBeTruthy();
    // 截尾部：runId 的公共前缀是 `run-`，截头部会让两次 run 显示成同一个串。
    // 两条记录同属一个 run，每条都要带出短 id，所以这里必须用 getAllByText
    // 钉住"两条都在"，getByText 的唯一匹配在这里反而是错的。
    expect(screen.getAllByText(/run …00000001/).length).toBe(2);
  });

  it("只看失败：把成功的记录滤掉，而不是只给失败的高亮", async () => {
    vi.mocked(window.oxCommander.recentAudit).mockResolvedValue([
      { ts: "2026-09-26T03:10:00.000Z", phase: "run-end", ok: true },
      { ts: "2026-09-26T03:12:04.123Z", phase: "batch-guard", ok: false, errorClass: "conflict" },
    ] as AuditRecordView[]);

    render(<AuditPanel />);
    expect(await screen.findByText(/03:10:00/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("只看失败"));

    await waitFor(() => expect(screen.queryByText(/03:10:00/)).toBeNull());
    expect(screen.getByText(/03:12:04/)).toBeTruthy();
  });

  it("读取审计失败时说出来，不与『还没有记录』长得一样", async () => {
    vi.mocked(window.oxCommander.recentAudit).mockRejectedValue(new Error("EACCES: 读不了"));

    render(<AuditPanel />);
    expect(await screen.findByText(/读取审计日志失败：EACCES/)).toBeTruthy();
    // 关键：失败不能退化成"没有记录" —— 那等于把故障说成空闲
    expect(screen.queryByText("还没有审计记录。")).toBeNull();
  });

  it("导出成功：把保存路径说出来，让人知道证据落在哪", async () => {
    vi.mocked(window.oxCommander.exportAudit).mockResolvedValue({ ok: true, path: "D:\\audit\\out.jsonl" });

    render(<AuditPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "导出 JSONL" }));
    expect(await screen.findByText(/已导出到 D:\\audit\\out\.jsonl/)).toBeTruthy();
  });

  it("导出被取消：轻声说一句，不算成功也不算故障", async () => {
    vi.mocked(window.oxCommander.exportAudit).mockResolvedValue({ ok: false, reason: "canceled" });

    render(<AuditPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "导出 JSONL" }));
    expect(await screen.findByText("已取消导出。")).toBeTruthy();
    // 取消不是失败：不进 alert，免得每次改主意都像出了事故
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("导出写盘失败：当作故障说出来，不假装导出落了地", async () => {
    vi.mocked(window.oxCommander.exportAudit).mockResolvedValue({ ok: false, reason: "EACCES: 写不了" });

    render(<AuditPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "导出 JSONL" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("导出失败");
    expect(alert.textContent).toContain("EACCES: 写不了");
  });
});
