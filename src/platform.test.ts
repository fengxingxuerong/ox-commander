import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_POOL_TIMEOUT_MS,
  brainTimeoutMsFor,
  createFileJournal,
  createPlatform,
  executorTimeoutMsFor,
} from "../electron/platform";
import { createAgentLayer } from "../electron/agents";
import { buildLlmPool } from "../shared/build-llm";
import { EXECUTOR_TIMEOUT_MS, type LineHealth } from "../shared/http-clients";
import { SENSENOVA_MODELS } from "../shared/providers";
import { DEFAULT_SETTINGS, type ProjectSettings, type Task } from "../shared/types";
import { BudgetExceededError, UsageMeter } from "../shared/usage-meter";

/**
 * 透传式 spy：保留真实实现（现有用例依赖它），只多一层调用记录，
 * 这样能断言"设置里的超时真的传进了 buildLlmPool"。
 */
vi.mock("../shared/build-llm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../shared/build-llm")>();
  return { ...mod, buildLlmPool: vi.fn(mod.buildLlmPool), buildLlmClient: vi.fn(mod.buildLlmClient) };
});

/** 同为透传式 spy：只为断言"执行器超时真的交给了装配层"，真实装配照旧。 */
vi.mock("../electron/agents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/agents")>();
  return { ...mod, createAgentLayer: vi.fn(mod.createAgentLayer) };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-platform-"));
  dirs.push(dir);
  return dir;
}

function settings(patch: Partial<ProjectSettings> = {}): ProjectSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...patch };
}

/** `SchedulerOptions` fields are all optional; tests read them as concrete. */
interface ConcreteSchedulerOptions {
  maxParallelRuns?: number;
  guard?: { setVerdictSink(sink: (v: { conflicts: Array<{ kind: string }> }) => void): void };
  router?: unknown;
  breaker?: unknown;
  onRunStart?: (agentId: string, task: unknown) => void;
  onRunComplete?: (outcome: unknown, task: unknown) => void;
}

function options(platform: ReturnType<typeof createPlatform>): ConcreteSchedulerOptions {
  return platform.schedulerOptions() as ConcreteSchedulerOptions;
}

/**
 * These tests guard the reason `platform.ts` exists: the desktop and headless
 * entries used to assemble their engines separately, and drifted four ways
 * (missing journal, missing verdict sink, different LLM timeout, dead ZoneGuard
 * argument — the latter has since been deleted from `Scheduler` entirely).
 * Anything asserted here is a structural guarantee both hosts share.
 */
describe("createPlatform · shared structure", () => {
  it("installs a guard when a snapshot root is given (zone rollback wired)", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).guard).toBeDefined();
  });

  it("omits the guard when no snapshot root is given (no rollback, no detection)", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).guard).toBeUndefined();
  });

  it("routes the verdict sink even for an injected layer", () => {
    // The historic headless code attached the sink after construction precisely
    // so an injected (test) layer still reported verdicts. That contract holds.
    const verdicts: string[] = [];
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      host: {
        log: () => undefined,
        onVerdict: (v) => verdicts.push(...v.conflicts.map((c) => c.kind)),
      },
    });
    expect(platform.layer.schedulerOptions.guard).toBeDefined();
    expect(verdicts).toEqual([]);
  });

  it("honours maxParallelRuns over the settings value", () => {
    const platform = createPlatform({
      settings: settings({ maxParallelRuns: 2 }),
      promptDir: tempDir(),
      maxParallelRuns: 7,
      host: { log: () => undefined },
    });
    expect(options(platform).maxParallelRuns).toBe(7);
  });

  it("falls back to the settings concurrency when no override is given", () => {
    const platform = createPlatform({
      settings: settings({ maxParallelRuns: 3 }),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(options(platform).maxParallelRuns).toBe(3);
  });

  it("forwards host run-attribution callbacks into the scheduler", () => {
    const starts: string[] = [];
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: {
        log: () => undefined,
        onRunStart: (agentId) => starts.push(agentId),
      },
    });
    const onRunStart = options(platform).onRunStart;
    expect(onRunStart).toBeDefined();
    onRunStart!("agent-1", { id: "t1", zone: "src" } as never);
    expect(starts).toEqual(["agent-1"]);
  });

  it("accepts host callback overrides without breaking construction", () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: {
        log: () => undefined,
        callbacks: { onStage: () => undefined, onTaskOutcome: () => undefined },
      },
    });
    expect(platform.engine).toBeDefined();
  });

  it("exposes the composed callbacks so hosts can assert what they own", () => {
    // The observable contract is the engine itself: both hosts build one from
    // the same wiring, and the override path must not throw mid-construction.
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(typeof platform.engine.generatePrd).toBe("function");
    expect(typeof platform.engine.execute).toBe("function");
  });
});

describe("createPlatform · brain client grade", () => {
  it("uses the same 300s budget on both hosts (drift regression)", () => {
    // Headless used to hard-code 300_000 while Electron passed nothing, so the
    // two hosts cut long generations off at different points.
    expect(BRAIN_POOL_TIMEOUT_MS).toBe(300_000);
  });

  it("config.seedKeys 在建平台时就播种：run 路径的引擎大脑不再漏掉密钥库", () => {
    // 回归：播种器只能挂在 config 上。引擎自己的大脑客户端是在 `createPlatform`
    // 内部**无参**构造的，把播种器留在某个调用点就等于「只有『测试连接』读得到
    // Key」—— 桌面端把密钥加密存进 key store 后，正式 run 依然无凭证。
    const seed = vi.fn();
    createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      seedKeys: seed,
      host: { log: () => undefined },
    });
    expect(seed).toHaveBeenCalledTimes(1);
    // 播种器收到的是「值得解析的变量名」集合，它自己决定往哪写。
    expect(seed.mock.calls[0][0]).toBeInstanceOf(Set);
  });

  it("调用点显式传入的播种器压过 config.seedKeys", () => {
    const fromConfig = vi.fn();
    const fromCall = vi.fn();
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      seedKeys: fromConfig,
      host: { log: () => undefined },
    });
    fromConfig.mockClear();

    platform.buildLlm(fromCall);

    expect(fromCall).toHaveBeenCalledTimes(1);
    expect(fromConfig).not.toHaveBeenCalled();
  });

  it("注入的 brain 客户端仍被使用，且它的用量被计入 platform.usage()", async () => {
    // 这条以前断言 `platform.buildLlm() === fake`（身份相等）。身份相等其实
    // 证明不了"它被用了" —— 换成**行为断言**：调用确实转到了注入的客户端，
    // 响应原样返回，用量进了 meter。加计量装饰器后 `buildLlm()` 返回的是包装层，
    // 而"没有被换成别的 provider 的客户端"这件事由前两条断言保证。
    const seen: number[] = [];
    const fake = {
      async chat() {
        seen.push(1);
        return { content: "{}", provider: "injected", model: "m", usageTokens: 120 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    const res = await platform.buildLlm().chat({ messages: [] });

    expect(seen).toHaveLength(1);
    expect(res).toEqual({ content: "{}", provider: "injected", model: "m", usageTokens: 120 });
    expect(platform.usage()).toEqual({
      totalTokens: 120,
      calls: 1,
      measuredCalls: 1,
      byModel: { "injected/m": 120 },
    });
  });

  it("用量在同一个平台内跨多次 buildLlm() 累加（每次包一层，不重复计数）", async () => {
    // `buildLlm` 是**工厂**：ipc/context 每次调用都会得到新的包装层。
    // 只要每次都指向同一个 meter，总量就不会漏；而"没有重复计数"由 totalTokens
    // 精确等于两次响应的和来保证（各 60 → 120，不是 240）。
    const fake = {
      async chat() {
        return { content: "{}", provider: "p", model: "m", usageTokens: 60 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });
    await platform.buildLlm().chat({ messages: [] });

    expect(platform.usage().totalTokens).toBe(120);
    expect(platform.usage().calls).toBe(2);
  });

  it("配了预算而端点不回报用量 ⇒ 日志当场说出这道闸看不见它", async () => {
    const lines: string[] = [];
    const fake = {
      async chat() {
        return { content: "{}", provider: "injected", model: "m" }; // 没有 usageTokens
      },
    };
    const platform = createPlatform({
      settings: { ...settings(), maxTokensPerRun: 500 },
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: (l: string) => lines.push(l) },
    });
    await platform.buildLlm().chat({ messages: [] });
    expect(lines.some((l) => l.startsWith("[budget]") && l.includes("maxTokensPerRun=500"))).toBe(true);
    // 总量仍然是 0：没上报就是没上报，这里不拿估算冒充账单口径。
    expect(platform.usage().totalTokens).toBe(0);
    expect(platform.usage().calls).toBe(1);
  });

  it("可以自带 meter：宿主想复用同一个计数器时，platform.usage() 就是它的快照", async () => {
    // `config.meter` 这个缝的用途：宿主（或测试）自建计数器并观察同一份数据，
    // 而不是让 platform 自己藏一个。断言两者指向同一份计数，而不是各自一份。
    const meter = new UsageMeter();
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      meter,
      llm: { chat: async () => ({ content: "{}", provider: "p", model: "m", usageTokens: 9 }) } as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });

    expect(meter.snapshot().totalTokens).toBe(9);
    expect(platform.usage()).toEqual(meter.snapshot());
  });

  it("未上报用量的调用不污染总量（provider 沉默时的可见边界）", async () => {
    let call = 0;
    const fake = {
      async chat() {
        call += 1;
        // 第一条不给 usageTokens（有的兼容层就是不返回 usage）。
        return call === 1
          ? { content: "{}", provider: "p", model: "m" }
          : { content: "{}", provider: "p", model: "m", usageTokens: 30 };
      },
    };
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    await platform.buildLlm().chat({ messages: [] });
    await platform.buildLlm().chat({ messages: [] });

    const s = platform.usage();
    expect(s.totalTokens).toBe(30);
    expect(s.calls).toBe(2);
    expect(s.measuredCalls).toBe(1);
  });

  it("settings.maxTokensPerRun 流入 meter：超限后 buildLlm 的客户端拒绝再调用", async () => {
    // 预算从 settings 一路到闸门的接线断不得：断了两端宿主都以为设了上限，
    // 实际照烧。断言的是行为（第二次调用被拒、内层不再被透传），不是结构。
    const fake = {
      async chat() {
        return { content: "{}", provider: "p", model: "m", usageTokens: 60 };
      },
    };
    const platform = createPlatform({
      settings: settings({ maxTokensPerRun: 60 }),
      promptDir: tempDir(),
      llm: fake as never,
      host: { log: () => undefined },
    });

    const client = platform.buildLlm();
    await client.chat({ messages: [] }); // 第一次：正好用满预算
    await expect(client.chat({ messages: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(platform.usage().totalTokens).toBe(60); // 穿透的只有记录到的这一次
  });

  it("未配置 maxTokensPerRun 时闸门不启用（与旧行为一致）", async () => {
    const platform = createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      llm: { chat: async () => ({ content: "{}", provider: "p", model: "m", usageTokens: 9 }) } as never,
      host: { log: () => undefined },
    });

    const client = platform.buildLlm();
    await expect(client.chat({ messages: [] })).resolves.toBeTruthy();
    await expect(client.chat({ messages: [] })).resolves.toBeTruthy();
    expect(platform.usage().totalTokens).toBe(18);
  });
});

/**
 * `enableRouter: config.enableRouter ?? settings.agentRouter !== false` ——
 * 这一行的 `!==` 变 `===` 后测试全绿（变异测试发现）。语义差异在于
 * **只有显式 `agentRouter: false` 才关路由**：缺省 true 与显式 true 都必须开。
 * 现有用例全用默认 settings（`agentRouter` 为 true），于是两个分支等价。
 */
describe("createPlatform · router 开关的三态（变异测试发现的缺口）", () => {
  function routerEnabled(patch: Partial<ProjectSettings>): boolean {
    const platform = createPlatform({
      settings: settings(patch),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    return Boolean(options(platform).router);
  }

  it("缺省即开启：未显式设置时路由必须是开的", () => {
    // `agentRouter !== false` 的默认态。变异成 `===` 时此项仍为真 → 无法区分，
    // 所以下面两项才是关键。
    expect(routerEnabled({})).toBe(true);
  });

  it("显式 true 开启路由", () => {
    expect(routerEnabled({ agentRouter: true })).toBe(true);
  });

  it("只有显式 false 才关闭路由", () => {
    // 这是 `!== false` 与 `=== false` 唯一分开的一格：变异版会把
    // 「缺省 true」也判成关闭 —— 即默认配置下静默失去能力路由。
    expect(routerEnabled({ agentRouter: false })).toBe(false);
  });

  it("config.enableRouter 覆盖 settings（两者冲突时以 config 为准）", () => {
    const platform = createPlatform({
      settings: settings({ agentRouter: false }),
      promptDir: tempDir(),
      enableRouter: true,
      host: { log: () => undefined },
    });
    // `??` 的左侧优先：显式传了 enableRouter 就不再看 settings
    expect(Boolean(options(platform).router)).toBe(true);
  });

  it("enableRouter: false 也覆盖 settings 的 true", () => {
    const platform = createPlatform({
      settings: settings({ agentRouter: true }),
      promptDir: tempDir(),
      enableRouter: false,
      host: { log: () => undefined },
    });
    expect(Boolean(options(platform).router)).toBe(false);
  });
});

describe("createPlatform · policy.d 接线（策略即代码）", () => {
  function policyDirWith(name: string, body: unknown): string {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
    return dir;
  }

  /**
   * `policy.d/` 的三元位点：`loaded.files > 0 ? loaded.policy : undefined` 与
   * `...(policy ? { policy: … } : {})`。
   *
   * 两个位点都在"同一个 run 里策略到底有没有生效"这条链上：分支互换会让**有**策略
   * 时把它丢掉（安全边界静默消失 —— 最坏的失败方式），或在**没有**策略时塞进一个
   * 空对象（把"没写策略"变成"写了一份空策略"）。
   *
   * 观测点选日志与命令沙箱行为，而不是内部变量：策略是安全边界，要断的是
   * "它真的管住了命令"，不是"这个字段有值"。
   */
  it("策略目录为空 ⇒ 日志不谎报已加载", () => {
    const logs: string[] = [];
    createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      policyDir: tempDir(), // 存在但没有任何 *.json
      host: { log: (t) => logs.push(t) },
    });
    // 没有生效策略就不该出现"已加载 N 份"；否则等于对外承诺了一条不存在的规则。
    expect(logs.filter((l) => l.includes("已加载"))).toEqual([]);
  });

  it("有策略文件 ⇒ 日志说出加载了几份，且该规则真的管住了验证命令", async () => {
    const logs: string[] = [];
    const root = tempDir();
    const platform = createPlatform({
      settings: settings({
        // node 在内置白名单里。策略把它禁掉之后，这条验证命令必须在 spawn
        // **之前**被沙箱拒绝 —— 断的是行为，不是"某个字段有值"。
        verificationCommands: [{ kind: "build", command: "node", args: ["-v"] }],
        maxRepairRounds: 0,
      }),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, denyCommands: ["node"] }),
      host: { log: (t) => logs.push(t) },
    });

    // 位点一：files > 0 才让 policy 有值；位点二：有值才展开进 verifyProject。
    // 任一分支互换 ⇒ policy 丢失 ⇒ node -v 被内置白名单放行 ⇒ 下面的 rejects 不成立。
    await expect(platform.engine.execute([], root)).rejects.toThrow(/repair rounds/);
    expect(logs.some((l) => l.includes("已加载") && l.includes("1"))).toBe(true);
    expect(logs.join("\n")).toContain("命令被沙箱禁止");
  });

  /**
   * 审批门接线（P2-3）。
   *
   * 断的是**行为**而不是"某个字段有值"：配了 `approvalCommands: ["node"]` 后，
   * 白名单里的 node 不再直接跑，而是走审批 —— 宿主拒绝时该命令必须**没被执行**。
   * 这条同时也钉住"审批门在 verifier 链上真的被 await 了"（漏 await 会让
   * 拒绝裁决变成 undefined，命令照跑）。
   */
  it("审批门：宿主拒绝时命令不执行，且日志说清是审批而不是沙箱拒绝", async () => {
    const logs: string[] = [];
    const root = tempDir();
    let asked: string[] = [];
    const platform = createPlatform({
      settings: settings({
        verificationCommands: [{ kind: "build", command: "node", args: ["-v"] }],
        maxRepairRounds: 0,
      }),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, approvalCommands: ["node"] }),
      host: {
        log: (t) => logs.push(t),
        requestApproval: async (cmd) => {
          asked.push(cmd);
          return false; // 人工拒绝
        },
      },
    });

    await expect(platform.engine.execute([], root)).rejects.toThrow(/repair rounds/);
    // 问了两次是**正确行为**，不是重复打扰：基线验证与交付闸各跑一轮 verifyProject，
    // 而"被拒绝"刻意不进已批准缓存（拒绝不该被缓存，否则一次误拒会让该命令在本批
    // 内永久静默）。批准的缓存只对"通过"生效。
    expect(asked).toEqual(["node", "node"]);
    expect(logs.join("\n")).toContain("审批门已启用");
    expect(logs.join("\n")).toContain("人工拒绝");
    // 关键区分：这是审批拒绝，不是沙箱地板拒绝 —— 措辞不能混
    expect(logs.join("\n")).not.toContain("命令被沙箱禁止");
  });

  /**
   * 审批拒绝会**连带**让基线验证变红，从而被引擎记成"本次运行前就已失败"。
   *
   * 这是一个需要知道的边界：那条日志的本意是"目标项目本来就坏着（不是智能体的账）"，
   * 而审批拒绝是第三种原因（既不是智能体写坏的，也不是项目本来坏的，是**人按住了**）。
   * 本用例把当前行为**如实钉住**，避免它被无声改动；同时说明为什么没在这轮顺手改：
   * 要正确区分三类原因，得让 `VerificationReport` 带上"失败类别"（沙箱拒 / 审批拒 /
   * 真的跑失败），那是验证器的契约变更，应与 P2-3 的 UI 面（审批队列）同批做。
   */
  it("边界：审批拒绝会让基线也报红，日志归因可能读成「项目本来就坏」", async () => {
    const logs: string[] = [];
    const platform = createPlatform({
      settings: settings({
        verificationCommands: [{ kind: "build", command: "node", args: ["-v"] }],
        maxRepairRounds: 0,
      }),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, approvalCommands: ["node"] }),
      host: { log: (t) => logs.push(t), requestApproval: async () => false },
    });

    await expect(platform.engine.execute([], tempDir())).rejects.toThrow(/repair rounds/);
    const joined = logs.join("\n");
    // 如实钉住：确实出现了那句归因措辞（本意的"不是智能体的账"）
    expect(joined).toContain("在本次运行开始前就失败");
    // 但原因在实践中是可见的：审批日志就在同一串里，且失败摘要带 [审批] 前缀，
    // 所以不是静默误报 —— 人能看到"是被按住，不是项目坏了"。
    expect(joined).toContain("审批拒绝");
    expect(joined).toContain("[审批]");
  });

  it("审批门：宿主批准时命令照常执行（不把审批变成一律拒绝）", async () => {
    const logs: string[] = [];
    const root = tempDir();
    const platform = createPlatform({
      settings: settings({
        verificationCommands: [{ kind: "build", command: "node", args: ["-v"] }],
        maxRepairRounds: 0,
      }),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, approvalCommands: ["node"] }),
      host: { log: (t) => logs.push(t), requestApproval: async () => true },
    });

    // node -v 真实执行成功 ⇒ 验证命令全过 ⇒ 走到交付（而不是 repair exhausted）。
    const report = await platform.engine.execute([], root);
    expect(report.passed).toBe(true);
    expect(logs.join("\n")).toContain("已批准");
  });

  it("没配 approvalCommands 时不建审批门（默认路径零影响）", () => {
    const logs: string[] = [];
    createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, denyCommands: ["rm-rf"] }),
      host: { log: (t) => logs.push(t) },
    });
    // 不该出现审批相关日志 —— 没配就是完全静默
    expect(logs.join("\n")).not.toContain("审批门已启用");
  });

  it("配了审批但宿主没接回调 ⇒ 日志当场说破这些命令会被拒绝", () => {
    const logs: string[] = [];
    createPlatform({
      settings: settings(),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, approvalCommands: ["deploy"] }),
      host: { log: (t) => logs.push(t) }, // 故意不给 requestApproval
    });
    const joined = logs.join("\n");
    expect(joined).toContain("审批门已启用");
    // fail-closed 的事实必须当场说出来，否则用户以为审批在等他，实际命令必被拒
    expect(joined).toContain("未接审批回调");
  });

  /**
   * 审批门必须交给引擎（`deps.approvalGate`）—— 否则批次边界不会 reset，
   * "本批已批准"的缓存会跨批存活。
   *
   * 这是该接线的**唯一可观测后果**：单批次下传不传都一样（没有第二个批次去
   * 检验缓存是否被清），所以必须用**两个批次**来断。构造：批 1 批准过 node、
   * 批 2 仍要问 —— 若引擎没拿到门（位点被改坏），批 2 会复用批 1 的批准而不再问。
   */
  it("审批门交给引擎：批准缓存不跨批（批次边界真的 reset 了）", async () => {
    const asked: string[] = [];
    const t1: Task = { id: "t1", title: "t1", description: "", zone: "src/a", dependencies: [], suggestedRole: "backend-dev" };
    const t2: Task = { id: "t2", title: "t2", description: "", zone: "src/b", dependencies: [], suggestedRole: "backend-dev" };
    const platform = createPlatform({
      settings: settings({
        // node -v 真实可跑，所以走真实 verifyProject（不注入 verify —— 注入会绕过
        // 审批门所在的链路，那样这个用例就什么也没断到）。
        verificationCommands: [{ kind: "build", command: "node", args: ["-v"] }],
        maxRepairRounds: 0,
      }),
      promptDir: tempDir(),
      policyDir: policyDirWith("a.json", { version: 1, approvalCommands: ["node"] }),
      host: {
        log: () => undefined,
        requestApproval: async (cmd) => {
          asked.push(cmd);
          return true;
        },
      },
    });

    // 两批任务，各自触发一轮 verifyProject ⇒ 批间有 reset 的机会。
    await platform.engine.execute([[t1], [t2]], tempDir()).catch(() => undefined);

    // 只在**批 2 那一次**独立计数：若引擎没拿到门（该位点被改坏），批 1 的批准
    // 缓存会存活到批 2，批 2 就不再问 —— 总次数会少一次。
    // 至少两次 = 批 1 一次 + 批 2 一次（基线+交付闸会让实际次数更多，故用 >=）。
    expect(asked.filter((c) => c === "node").length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The drift guard proper: build a platform the way each host builds one and
 * compare the structural fields. If a future change wires the desktop host
 * differently from headless, this fails instead of silently diverging.
 */
describe("createPlatform · desktop/headless parity", () => {
  function buildAsDesktop() {
    return createPlatform({
      settings: settings({ maxParallelRuns: 4, arbitration: "revert-batch" }),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      manifestDir: tempDir(),
      enableRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 4,
      journal: { save: () => undefined },
      host: { log: () => undefined, onRunStart: () => undefined },
    });
  }

  function buildAsHeadless() {
    return createPlatform({
      settings: settings({ maxParallelRuns: 4, arbitration: "revert-batch" }),
      promptDir: tempDir(),
      snapshotRoot: tempDir(),
      enableRouter: true,
      arbitration: "revert-batch",
      maxParallelRuns: 4,
      llmPool: [],
      journal: { save: () => undefined },
      host: { log: () => undefined, onRunStart: () => undefined },
    });
  }

  it("produces the same scheduler shape on both hosts", () => {
    const desktop = options(buildAsDesktop());
    const headless = options(buildAsHeadless());
    expect(desktop.maxParallelRuns).toBe(headless.maxParallelRuns);
    expect(Boolean(desktop.guard)).toBe(Boolean(headless.guard));
    expect(Boolean(desktop.router)).toBe(Boolean(headless.router));
    expect(Boolean(desktop.breaker)).toBe(Boolean(headless.breaker));
    expect(Boolean(desktop.onRunStart)).toBe(Boolean(headless.onRunStart));
    expect(Boolean(desktop.onRunComplete)).toBe(Boolean(headless.onRunComplete));
  });

  it("installs the guard on both hosts when a snapshot root is present", () => {
    // The desktop entry previously passed a legacy ZoneGuard third argument while
    // headless passed undefined — same behaviour, different expression. That
    // argument is gone; both hosts now express the same thing: guard present.
    expect(options(buildAsDesktop()).guard).toBeDefined();
    expect(options(buildAsHeadless()).guard).toBeDefined();
  });
});

describe("createFileJournal", () => {
  const snapshot = {
    batches: [[{ id: "t1", title: "T", zone: "src", description: "d", dependencies: [] }]],
    allDone: ["t1"],
    skipped: [],
    attempts: { t1: 1 },
    round: 1,
    extraRounds: 0,
    lastDigest: "",
  };

  it("round-trips a snapshot for the same requirement", () => {
    const root = tempDir();
    const j = createFileJournal(root, "req-A");
    j.save(snapshot as never);
    const loaded = j.load();
    expect(loaded?.allDone).toEqual(["t1"]);
    expect(loaded?.round).toBe(1);
  });

  it("refuses to resume a different requirement", () => {
    const root = tempDir();
    createFileJournal(root, "req-A").save(snapshot as never);
    const other = createFileJournal(root, "req-B");
    expect(other.load()).toBeUndefined();
    expect(other.mismatched()).toBe(true);
  });

  it("reports a corrupt journal instead of throwing", () => {
    const root = tempDir();
    const j = createFileJournal(root, "req-A");
    fs.writeFileSync(j.path, "{ not json", "utf8");
    expect(j.load()).toBeUndefined();
    expect(j.corrupted()).toBe(true);
  });

  it("returns undefined when there is simply no journal", () => {
    const j = createFileJournal(tempDir(), "req-A");
    expect(j.load()).toBeUndefined();
    expect(j.mismatched()).toBe(false);
    expect(j.corrupted()).toBe(false);
  });

  it("does not abort the caller when the write fails", () => {
    // A nonexistent directory makes writeFileSync throw; checkpointing is a
    // best-effort fuse and must never take a run down with it.
    const j = createFileJournal(path.join(tempDir(), "no", "such", "dir"), "req-A");
    expect(() => j.save(snapshot as never)).not.toThrow();
  });
});

describe("brainTimeoutMsFor · 大脑层超时的取值归属", () => {
  it("省略字段 = 用内置默认", () => {
    expect(brainTimeoutMsFor({})).toBe(BRAIN_POOL_TIMEOUT_MS);
  });

  it("0 不是『不限』而是『用默认』—— 0 毫秒的超时没有意义", () => {
    // 与 runWallClockMs（0 = 不限）刻意不是同一套语义，别照抄成 v ?? 0。
    expect(brainTimeoutMsFor({ brainTimeoutMs: 0 })).toBe(BRAIN_POOL_TIMEOUT_MS);
  });

  it("负数同样按默认处理", () => {
    expect(brainTimeoutMsFor({ brainTimeoutMs: -1 })).toBe(BRAIN_POOL_TIMEOUT_MS);
  });

  it("正数原样采用", () => {
    expect(brainTimeoutMsFor({ brainTimeoutMs: 45_000 })).toBe(45_000);
  });
});

describe("executorTimeoutMsFor · 执行器超时的取值归属", () => {
  it("省略字段 = 用内置默认", () => {
    expect(executorTimeoutMsFor({})).toBe(EXECUTOR_TIMEOUT_MS);
  });

  it("0 不是『不限』而是『用默认』", () => {
    expect(executorTimeoutMsFor({ executorTimeoutMs: 0 })).toBe(EXECUTOR_TIMEOUT_MS);
  });

  it("负数同样按默认处理", () => {
    expect(executorTimeoutMsFor({ executorTimeoutMs: -1 })).toBe(EXECUTOR_TIMEOUT_MS);
  });

  it("正数原样采用", () => {
    expect(executorTimeoutMsFor({ executorTimeoutMs: 45_000 })).toBe(45_000);
  });
});

describe("设置里的 executorTimeoutMs 真的传进了装配层", () => {
  it("createAgentLayer 收到设置里的毫秒值", () => {
    vi.mocked(createAgentLayer).mockClear();
    createPlatform({
      settings: settings({ executorTimeoutMs: 45_000 }),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(vi.mocked(createAgentLayer).mock.calls[0]![0]).toMatchObject({ executorTimeoutMs: 45_000 });
  });

  it("没给设置时回落到内置默认，而不是 undefined 或 0", () => {
    vi.mocked(createAgentLayer).mockClear();
    createPlatform({ settings: settings(), promptDir: tempDir(), host: { log: () => undefined } });
    expect(vi.mocked(createAgentLayer).mock.calls[0]![0]).toMatchObject({
      executorTimeoutMs: EXECUTOR_TIMEOUT_MS,
    });
  });
});

describe("设置里的 brainTimeoutMs 真的传进了大脑客户端", () => {
  it("buildLlmPool 收到设置里的毫秒值", () => {
    vi.mocked(buildLlmPool).mockClear();
    createPlatform({
      settings: settings({ brainTimeoutMs: 45_000 }),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    const calls = vi.mocked(buildLlmPool).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![0]).toMatchObject({ timeoutMs: 45_000 });
  });

  it("没给设置时回落到内置默认，而不是 undefined 或 0", () => {
    vi.mocked(buildLlmPool).mockClear();
    createPlatform({ settings: settings(), promptDir: tempDir(), host: { log: () => undefined } });
    expect(vi.mocked(buildLlmPool).mock.calls[0]![0]).toMatchObject({
      timeoutMs: BRAIN_POOL_TIMEOUT_MS,
    });
  });

  it("停用的密钥真的传进了池（账号热切换不是只改设置里的字）", () => {
    // 设置里多一个字段不等于生效：断在这一跳的表现是"界面写着已停用，池子里它还在跑"。
    vi.mocked(buildLlmPool).mockClear();
    createPlatform({
      settings: settings({ disabledKeyVars: ["SENSENOVA_API_KEY_2"] }),
      promptDir: tempDir(),
      host: { log: () => undefined },
    });
    expect(vi.mocked(buildLlmPool).mock.calls[0]![0]).toMatchObject({
      disabledKeyVars: ["SENSENOVA_API_KEY_2"],
    });
  });

  it("线路健康：池里每条线路都进表，宿主拿到的是字段（P1-2 的宿主出口）", () => {
    // 冷却表此前只活在故障转移客户端内部，宿主没有任何结构化出口 —— 界面
    // 问不出"还有几条线能用、哪条在被限流"。这条钉住 `buildLlm()` 把这份表
    // 推给宿主、且 `lineHealth()` 拿到的就是最后一份。
    const key = "SENSENOVA_API_KEY";
    const had = process.env[key];
    process.env[key] = "test-key-line-health";
    try {
      const seen: LineHealth[][] = [];
      const platform = createPlatform({
        settings: settings({ llmPool: ["sensenova"] }),
        promptDir: tempDir(),
        host: { log: () => undefined, onLineHealth: (l) => seen.push(l) },
      });
      platform.buildLlm();
      expect(seen.length).toBeGreaterThan(0);
      const last = seen.at(-1)!;
      // 1 个 key × N 个模型 = N 条线路；没失败过的线路也要在表里（零值）
      expect(last).toHaveLength(SENSENOVA_MODELS.length);
      expect(last.every((l) => l.cooling === false && l.failures === 0)).toBe(true);
      expect(platform.lineHealth()).toEqual(last);
    } finally {
      if (had === undefined) delete process.env[key];
      else process.env[key] = had;
    }
  });
});
