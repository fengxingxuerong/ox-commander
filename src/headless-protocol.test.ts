import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseSpec, type HeadlessEvent, type ParsedSpec } from "../headless/protocol";
import { runSpec, requiredCredentialVars, missingCredentials, pruneStaleBackups } from "../headless/run-spec";
import { createAgentLayer } from "../electron/agents";
import type { LlmClient } from "../shared/llm-client";
import type { AgentAdapter, Task, TaskPayload, VerificationReport } from "../shared/types";
import type { AgentCapabilities } from "../shared/agent-contract";
import type { PrdDocument } from "../shared/types";

const dirs: string[] = [];

function scratch(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // temp cleaner
    }
  }
});

/** The spec shape the first version of this protocol accepted. */
const LEGACY_SPEC = {
  requirement: "做一个待办清单",
  projectRoot: ".",
  maxRepairRounds: 1,
  verificationCommands: [{ kind: "test", command: "npm", args: ["run", "test"] }],
  escalationPolicy: "skip",
};

function parse(text: string): ParsedSpec {
  const r = parseSpec(text);
  if (!r.ok) throw new Error(`unexpected parse failure: ${r.message}`);
  return r.spec;
}

describe("parseSpec", () => {
  it("accepts the legacy spec unchanged and fills every default", () => {
    const spec = parse(JSON.stringify(LEGACY_SPEC));
    expect(spec.requirement).toBe("做一个待办清单");
    expect(spec.projectRoot).toBe(path.resolve("."));
    expect(spec.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(spec.llmProvider).toBe("sensenova");
    expect(spec.escalationPolicy).toBe("skip");
    expect(spec.settings.maxRepairRounds).toBe(1);
    expect(spec.settings.verificationCommands).toEqual([{ kind: "test", command: "npm", args: ["run", "test"] }]);
    // New fields default without the host having to know about them.
    expect(spec.settings.agentRouter).toBe(true);
    expect(spec.settings.arbitration).toBe("revert-batch");
    expect(spec.agents).toEqual([]);
    expect(spec.maxParallelRuns).toBe(4);
    expect(spec.snapshotRoot).toContain("ox-commander-snapshots");
    expect(spec.warnings).toEqual([]);
  });

  it("echoes a host-supplied protocol version", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, protocolVersion: "ox-headless/9" }));
    expect(spec.protocolVersion).toBe("ox-headless/9");
  });

  it("reports unknown fields as warnings instead of failing", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, futureFlag: true, nested: { a: 1 } }));
    expect(spec.warnings).toHaveLength(2);
    expect(spec.warnings.join()).toContain("futureFlag");
  });

  it("collects every problem at once", () => {
    const r = parseSpec(
      JSON.stringify({
        requirement: "",
        projectRoot: ".",
        maxRepairRounds: -1,
        escalationPolicy: "explode",
        arbitration: "wishful",
        agentRouter: "yes",
        verificationCommands: [{ kind: "lint", command: "" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const fragment of ["requirement", "maxRepairRounds", "escalationPolicy", "arbitration", "agentRouter", "verificationCommands"]) {
      expect(r.message).toContain(fragment);
    }
  });

  it("rejects non-JSON, non-objects and missing required fields", () => {
    expect(parseSpec("{ nope").ok).toBe(false);
    expect(parseSpec("[]").ok).toBe(false);
    expect(parseSpec("null").ok).toBe(false);
    const r = parseSpec(JSON.stringify({ projectRoot: "." }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("requirement");
  });

  it("validates agent declarations with the same schema as agents.d", () => {
    const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, agents: [{ id: "bad id!", adapter: "cli" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("agents 声明校验失败");
  });

  it("accepts a valid agent declaration and a pre-approved PRD", () => {
    const prd = { goal: "g", features: ["f"], techStack: ["Node.js"], acceptanceCriteria: ["npm test"] };
    const spec = parse(
      JSON.stringify({
        ...LEGACY_SPEC,
        prd,
        agents: [
          {
            id: "codex-cli",
            displayName: "Codex",
            adapter: "cli",
            entry: { kind: "cli", command: "codex", argsTemplate: ["exec"] },
            capabilities: {
              roles: ["backend-dev"],
              zoneGlobs: ["src/**"],
              supports: ["read", "edit"],
              maxProfiles: 1,
              maxConcurrency: 2,
              selfIsolated: true,
              artifactKinds: ["files"],
            },
          },
        ],
      }),
    );
    expect(spec.prd).toEqual(prd);
    expect(spec.agents).toHaveLength(1);
    expect(spec.agents[0]!.id).toBe("codex-cli");
  });

  it("resolves relative paths against the runner cwd", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: "./sub", manifestDir: "agents.d", snapshotRoot: "snaps" }));
    expect(path.isAbsolute(spec.projectRoot)).toBe(true);
    expect(spec.manifestDir).toBe(path.resolve("agents.d"));
    expect(spec.snapshotRoot).toBe(path.resolve("snaps"));
  });

  it("honours maxParallelRuns including 0 (unlimited)", () => {
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, maxParallelRuns: 0 })).maxParallelRuns).toBe(0);
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, maxParallelRuns: 8 })).maxParallelRuns).toBe(8);
  });

  it("defaults llmPool to the platform pool (12 SenseNova routes + AMD)", () => {
    expect(parse(JSON.stringify(LEGACY_SPEC)).llmPool).toEqual(["sensenova", "amd-radeon"]);
  });

  it("accepts an explicit llmPool and rejects unknown providers", () => {
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["amd-radeon"] })).llmPool).toEqual(["amd-radeon"]);
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, llmPool: [] })).llmPool).toEqual([]);
    const bad = parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["nope"] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("未知 provider");
    const malformed = parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: "sensenova" }));
    expect(malformed.ok).toBe(false);
  });
});

/**
 * `parseCommands` 的四个 `continue` 此前零覆盖：现有用例只传**单个**非法项，
 * 于是"跳过本条"与"中止整个循环"行为相同。变异成 `break` 后测试全绿。
 *
 * 下面每条都让**非法项后面还有更多项** —— 这才分得开两个分支。共同后果是
 * **错误收集不全**：`parseSpec` 的设计承诺是"一次把所有问题报给宿主"
 * （见 `collects every problem at once`），而 break 会让它半途而废。
 */
describe("parseCommands · 逐项校验不中途放弃（变异测试发现的缺口）", () => {
  function issueLines(commands: unknown[]): string {
    const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, verificationCommands: commands }));
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.message;
  }

  it("非对象项之后的非法项仍被检查出来", () => {
    const msg = issueLines([
      "not-an-object",
      { kind: "test", command: "" }, // 必须仍然报出：command 不能为空
    ]);
    expect(msg).toContain("verificationCommands[0] 必须是对象");
    expect(msg).toContain("verificationCommands[1].command 必须是非空字符串");
  });

  it("非法 kind 之后的非法 command 仍被检查出来", () => {
    const msg = issueLines([
      { kind: "nope", command: "x" },
      { kind: "test", command: "" },
    ]);
    expect(msg).toContain("verificationCommands[0].kind 必须是");
    expect(msg).toContain("verificationCommands[1].command 必须是非空字符串");
  });

  it("空 command 之后的非法 args 仍被检查出来", () => {
    const msg = issueLines([
      { kind: "test", command: "" },
      { kind: "test", command: "node", args: [1, 2] },
    ]);
    expect(msg).toContain("verificationCommands[0].command 必须是非空字符串");
    expect(msg).toContain("verificationCommands[1].args 必须是字符串数组");
  });

  it("前三项全非法时四条诊断一次报齐，且合法项照常入列", () => {
    // 这一条把四个 continue 全部钉住：任何一处变 break，后面的诊断就会消失。
    const commands = [
      "not-an-object",
      { kind: "nope", command: "x" },
      { kind: "test", command: "" },
      { kind: "test", command: "node", args: [1] },
      { kind: "build", command: "npm", args: ["run", "build"] }, // 唯一合法的项
    ];
    const msg = issueLines(commands);
    expect(msg).toContain("verificationCommands[0] 必须是对象");
    expect(msg).toContain("verificationCommands[1].kind");
    expect(msg).toContain("verificationCommands[2].command");
    expect(msg).toContain("verificationCommands[3].args");
  });

  it("非法 args 之后仍有合法项时，合法项的 args 校验不被跳过（172 行 continue → break 会漏掉它）", () => {
    // 关键：后面那一项的 args 也非法。continue → break 时循环在第 1 项就退出，
    // 于是 [1] 的 args 诊断永远不出现 —— 宿主需要改两轮才能把 spec 改对。
    const msg = issueLines([
      { kind: "test", command: "node", args: [1, 2] }, // 非法 args
      { kind: "build", command: "npm", args: "run build" }, // args 也不是数组
    ]);
    expect(msg).toContain("verificationCommands[0].args 必须是字符串数组");
    expect(msg).toContain("verificationCommands[1].args 必须是字符串数组");
  });

  it("kind 非法之后的项仍被继续检查（163 行 continue → break 会漏掉）", () => {
    const msg = issueLines([
      { kind: "nope", command: "x" },
      { kind: "test", command: "" }, // 必须报出：command 为空
    ]);
    expect(msg).toContain("verificationCommands[0].kind 必须是");
    expect(msg).toContain("verificationCommands[1].command 必须是非空字符串");
  });

  it("空 command 之后的项仍被继续检查（167 行 continue → break 会漏掉）", () => {
    const msg = issueLines([
      { kind: "test", command: "  " }, // 纯空白 = 空
      { kind: "build", command: "npm", args: [1] }, // args 非法，必须报出
    ]);
    expect(msg).toContain("verificationCommands[0].command 必须是非空字符串");
    expect(msg).toContain("verificationCommands[1].args 必须是字符串数组");
  });

  it("非对象项之后的项仍被继续检查（158 行 continue → break 会漏掉）", () => {
    const msg = issueLines([
      "not-an-object",
      { kind: "nope", command: "x" }, // kind 非法，必须报出
    ]);
    expect(msg).toContain("verificationCommands[0] 必须是对象");
    expect(msg).toContain("verificationCommands[1].kind 必须是");
  });

  it("全部合法时逐项校验通过（对照组：确认上面的诊断只来自非法项）", () => {
    const spec = parse(
      JSON.stringify({
        ...LEGACY_SPEC,
        verificationCommands: [
          { kind: "build", command: "npm", args: ["run", "build"] },
          { kind: "test", command: "npm", args: ["test"] },
        ],
      }),
    );
    expect(spec.settings.verificationCommands).toHaveLength(2);
  });

  it("逐项校验通过后保留 args 的原始顺序与内容", () => {
    const spec = parse(
      JSON.stringify({
        ...LEGACY_SPEC,
        verificationCommands: [
          { kind: "build", command: "npm", args: ["run", "build"] },
          { kind: "test", command: "npm", args: ["run", "test", "--silent"] },
          { kind: "typecheck", command: "tsc" }, // args 缺省 → 空数组
        ],
      }),
    );
    expect(spec.settings.verificationCommands).toEqual([
      { kind: "build", command: "npm", args: ["run", "build"] },
      { kind: "test", command: "npm", args: ["run", "test", "--silent"] },
      { kind: "typecheck", command: "tsc", args: [] },
    ]);
  });
});

describe("parseSpec · maxTokensPerRun", () => {
  it("合法正数流进 settings；缺省时不出现该字段，也不产生警告（KNOWN_FIELDS 已注册）", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, maxTokensPerRun: 120_000 }));
    expect(spec.settings.maxTokensPerRun).toBe(120_000);
    expect(spec.warnings).toEqual([]);

    const bare = parse(JSON.stringify(LEGACY_SPEC));
    expect(bare.settings.maxTokensPerRun).toBeUndefined();
    expect(bare.warnings).toEqual([]);
  });

  it("0 / 负数 / 非数字都被拒绝（宿主显式传坏值是 bug，不能静默解释成不限）", () => {
    // 与 UsageMeter 内核口径刻意不同：协议层面向宿主程序，错误要立刻暴露；
    // NaN 在 JSON 里序列化成 null，同样落在"非数字"分支。
    for (const bad of [0, -5, Number.NaN, "many"]) {
      const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, maxTokensPerRun: bad }));
      expect(r.ok, `maxTokensPerRun=${String(bad)}`).toBe(false);
      if (!r.ok) expect(r.message).toContain("maxTokensPerRun");
    }
  });

  it("小数向下取整（token 数是整数）", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, maxTokensPerRun: 100.9 }));
    expect(spec.settings.maxTokensPerRun).toBe(100);
  });

  it("1e999 这类合法 JSON 超大数（parse 出 Infinity）同样被拒绝", () => {
    // 这条是为 site 口径的 `|| → &&` 变异准备的：三段条件里只有
    // `!Number.isFinite` 能拦住 Infinity，而 JSON 可表达的 Infinity
    // 恰恰只出现在这里（1e999 解析溢出）—— 缺了它，前两段合取后的
    // 变异对全部普通输入都与原文等价，门禁杀不掉。
    const r = parseSpec('{"requirement":"x","projectRoot":".","maxTokensPerRun":1e999}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("maxTokensPerRun");
  });
});

describe("runSpec", () => {
  function fakeTask(id: string, zone: string, role = "backend-dev"): Task {
    return { id, title: `任务 ${id}`, description: "做点事", zone, dependencies: [], suggestedRole: role };
  }

  function tasksResponse(tasks: Task[]): LlmClient {
    return {
      async chat(req) {
        const prompt = req.messages.map((m) => m.content).join("\n");
        if (prompt.includes("structured PRD")) {
          const prd: PrdDocument = {
            goal: "g",
            features: ["f"],
            techStack: ["Node.js"],
            acceptanceCriteria: ["npm test"],
          };
          return { content: JSON.stringify(prd), provider: "fake", model: "fake-1" };
        }
        return { content: JSON.stringify({ tasks }), provider: "fake", model: "fake-1" };
      },
    };
  }

  function fakeAdapter(id: string): AgentAdapter {
    const caps: AgentCapabilities = {
      roles: ["backend-dev"],
      zoneGlobs: ["**"],
      supports: ["read", "edit"],
      artifactKinds: ["files"],
      maxConcurrency: 2,
      selfIsolated: true,
    };
    const base: AgentAdapter = {
      meta: { id, name: id, kind: "api" },
      async probe() {
        return true;
      },
      async dispatch(payload) {
        return { runId: payload.runId, agentId: id, taskId: payload.taskId };
      },
      async *collect() {
        yield { kind: "completed" as const, text: "done", timestamp: Date.now() };
      },
      async abort() {},
    };
    return Object.assign(base, { capabilities: () => caps });
  }

  function collect(): { events: HeadlessEvent[]; emit: (e: HeadlessEvent) => void } {
    const events: HeadlessEvent[] = [];
    return { events, emit: (e) => events.push(e) };
  }

  const pass: VerificationReport = {
    passed: true,
    results: [{ kind: "test", ok: true, exitCode: 0, logDigest: "ok", durationMs: 5 }],
  };

  it("runs the whole pipeline and exits 0 with a stable event order", async () => {
    const root = scratch("headless-ok");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    const { events, emit } = collect();
    const adapter = fakeAdapter("worker");
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [adapter] }),
      verify: async () => pass,
    });

    expect(code, JSON.stringify(events.filter((e) => e.type === "error"))).toBe(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("hello");
    expect(types).toContain("agents");
    expect(types).toContain("prd");
    expect(types).toContain("tasks");
    expect(types).toContain("verification");
    expect(types.at(-1)).toBe("done");

    const stages = events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(["PRD", "PLANNING", "DEVELOPMENT", "VERIFICATION", "DELIVERY", "DONE"]);

    const runs = events.filter((e) => e.type === "run") as Array<{ phase: string; agentId?: string; ok?: boolean; durationMs?: number }>;
    expect(runs.map((r) => r.phase)).toEqual(["start", "end"]);
    expect(runs[1]!.agentId).toBe("worker");
    expect(runs[1]!.ok).toBe(true);
    // 耗时是宿主唯一的逐次耗时来源（批次级数字盖不住一次 run），必须原样带出来。
    expect(typeof runs[1]!.durationMs).toBe("number");

    const hello = events[0] as Extract<HeadlessEvent, { type: "hello" }>;
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.projectRoot).toBe(root);
    expect(hello.agentRouter).toBe(true);
  });

  it("llmProvider 真的进 settings（它决定池为空时用哪家，不能只 echo 进 hello）", () => {
    // 旧行为：`llmProvider` 只出现在 `hello` 事件里，settings 仍是默认值 ——
    // 于是宿主写 "llmProvider": "ollama" 之后，池为空时大脑层照打 SenseNova。
    const s = parse(JSON.stringify({ ...LEGACY_SPEC, llmProvider: "ollama", llmPool: [] }));
    expect(s.settings.llmProvider).toBe("ollama");
    expect(s.llmProvider).toBe("ollama");
    // 不传时仍是默认 provider，且默认池非空（12 条线路 + AMD）优先于单 provider。
    const d = parse(JSON.stringify(LEGACY_SPEC));
    expect(d.settings.llmProvider).toBe(d.llmProvider);
    expect(d.llmPool.length).toBeGreaterThan(0);
  });

  it("凭证要求按大脑层**实际会用的** provider 算，不按默认池", () => {
    // 默认池是 SenseNova + AMD；只看 `settings.llmPool` 会把本地 Ollama 的宿主
    // 挡在门外，而池为空时又必须退回单 provider —— 两处口径都钉在这里。
    const keyless = parse(JSON.stringify({ ...LEGACY_SPEC, llmProvider: "ollama", llmPool: ["ollama"] }));
    expect(requiredCredentialVars(keyless)).toEqual([]);

    const pooled = parse(JSON.stringify(LEGACY_SPEC));
    expect(requiredCredentialVars(pooled).sort()).toEqual([
      "AMD_API_KEY",
      "SENSENOVA_API_KEY",
      "SENSENOVA_API_KEY_2",
      "SENSENOVA_API_KEY_3",
    ]);

    // 这一条同时钉住 `llmProvider` 进了 settings（旧行为下它只 echo 进 hello，
    // 这里会算出 SenseNova 那 4 个变量）。
    const single = parse(JSON.stringify({ ...LEGACY_SPEC, llmProvider: "deepseek", llmPool: [] }));
    expect(requiredCredentialVars(single)).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("凭证闸的三个分支各自判对：全缺拒跑、有一条就放行、不需要 Key 的不误伤", () => {
    // 这一格曾经把"有 Key 的线路"和"所有线路"混成一格：只要不是全缺就拒跑，
    // 于是宿主手里有一条可用线路也进不来。反过来，本地 provider 的 wanted 是空集，
    // 空数组在调用方是真值 —— 当成"缺东西"返回会把零配额的 Ollama 挡在门外。
    const vars = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3", "AMD_API_KEY"];
    const pooled = parse(JSON.stringify(LEGACY_SPEC));
    const keyless = parse(JSON.stringify({ ...LEGACY_SPEC, llmProvider: "ollama", llmPool: ["ollama"] }));
    const saved: Record<string, string | undefined> = {};
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      expect(missingCredentials(pooled)).toEqual(requiredCredentialVars(pooled));
      process.env.SENSENOVA_API_KEY_2 = " sk-partial ";
      expect(missingCredentials(pooled)).toBeUndefined();
      // 纯空白不算持有凭证
      process.env.SENSENOVA_API_KEY_2 = "   ";
      expect(missingCredentials(pooled)).toEqual(requiredCredentialVars(pooled));
      expect(missingCredentials(keyless)).toBeUndefined();
    } finally {
      for (const v of vars) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
    }
  });

  it("中断遗留的快照备份：只回收过期的 batch-* 目录", () => {
    const root = scratch("prune-backups");
    const old = Date.parse("2020-01-01T00:00:00Z");
    const fresh = Date.now();
    const mk = (name: string, when: number) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "src__a.js"), "backup", "utf8");
      fs.utimesSync(dir, new Date(when), new Date(when));
      return dir;
    };
    // 名字是排过序的：回收按字典序遍历，所以两条"跳过"（非 batch- 的杂项、没过保留期）
    // 都排在待删项之前 —— 否则"跳过这一条"和"整个循环到此为止"看不出区别。
    const stale1 = mk("batch-old-1", old);
    const stale2 = mk("batch-old-2", old);
    const keepFresh = mk("batch-fresh", fresh);
    const keepForeign = mk("b-foreign-dir", old);
    const keepFile = path.join(root, "a-loose.txt");
    fs.writeFileSync(keepFile, "x", "utf8");

    // 保留期是"超过 24h"，所以这里给 48h —— 正好卡在边界上应当保留，
    // 那不是本用例要测的东西（边界由下面的 fresh/old 两侧共同说明）。
    const res = pruneStaleBackups(root, { now: Date.parse("2020-01-03T00:00:00Z") });
    expect(res.failed, `删不掉的原因要说出来：${JSON.stringify(res.failed)}`).toEqual([]);
    expect(res.removed).toBe(2);
    expect([fs.existsSync(stale1), fs.existsSync(stale2)]).toEqual([false, false]);
    expect(fs.existsSync(keepFresh)).toBe(true);
    // 宿主把 snapshotRoot 指到共享目录时，非本方案命名的目录一个都不能碰。
    expect(fs.existsSync(keepForeign)).toBe(true);
    expect(fs.existsSync(keepFile)).toBe(true);
    // 备份根不存在（首次运行）不是错误，但要说得清"是没得删"而不是"删不动"。
    const missing = pruneStaleBackups(path.join(root, "missing"));
    expect(missing.removed).toBe(0);
    expect(missing.missingRoot).toBe(true);
    expect(missing.kept).toEqual([]);
    // 未到期不等于"没事"：留下来的目录必须被列出来，调用方才有可能报出"未结算的批"。
    expect(pruneStaleBackups(root, { now: Date.parse("2020-01-01T00:00:00Z") }).kept.length).toBeGreaterThan(0);
    expect(missing.failed).toEqual([]);
  });

  it("没有凭证时给一句能行动的话，而不是内部术语", async () => {
    // 大脑层拿不到 key 时，原先一路跑到第一次调用才炸，宿主看到的是
    // "failover client has no groups" —— 不知道该做什么。headless 不读 .env
    // （只有桌面端主进程加载它），所以要说清"由宿主注入进程环境变量"。
    const root = scratch("headless-nokey");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    const { events, emit } = collect();
    const saved: Record<string, string | undefined> = {};
    const vars = ["SENSENOVA_API_KEY", "SENSENOVA_API_KEY_2", "SENSENOVA_API_KEY_3", "AMD_API_KEY"];
    for (const v of vars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      // 注意不传 io.llm：注入假客户端的调用方本来就不需要凭证，那条路必须照常走。
      const code = await runSpec(spec, {
        emit,
        layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
        verify: async () => pass,
      });
      expect(code).toBe(1);
      const err = events.find((e) => e.type === "error") as Extract<HeadlessEvent, { type: "error" }>;
      expect(err.message).toContain("没有可用凭证");
      expect(err.message).toContain("SENSENOVA_API_KEY");
      expect(err.message).toContain("宿主注入");
      // hello 仍然先发出去：宿主的用法是先读 hello 再判其余事件。
      expect(events[0]!.type).toBe("hello");
    } finally {
      for (const v of vars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
      }
    }
  });

  it("用量事件：在 done 之前发一次，金额等于大脑两次调用的和", async () => {
    // 走完整链路（真实 platform 装配 + 真解析），只把 LLM 换成会报用量的假件。
    // 这样断言的是"宿主真的能拿到用量"，而不是"某个函数被调过"。
    const root = scratch("headless-usage");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    const { events, emit } = collect();
    const inner = tasksResponse([fakeTask("t1", "src")]);
    const metered: LlmClient = {
      async chat(req) {
        return { ...(await inner.chat(req)), usageTokens: 100 };
      },
    };

    const code = await runSpec(spec, {
      emit,
      llm: metered,
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });

    expect(code).toBe(0);
    const usage = events.find((e) => e.type === "usage") as
      | Extract<HeadlessEvent, { type: "usage" }>
      | undefined;
    expect(usage).toBeDefined();
    // PRD 一次 + 分解一次；两条都上报了用量，所以 measuredCalls === calls。
    expect(usage!.totalTokens).toBe(200);
    expect(usage!.calls).toBe(2);
    expect(usage!.measuredCalls).toBe(2);
    expect(usage!.byModel).toEqual({ "fake/fake-1": 200 });
    // 顺序也是契约：宿主按行处理事件，用量必须在终态之前到。
    expect(events.findIndex((e) => e.type === "usage")).toBeLessThan(
      events.findIndex((e) => e.type === "done"),
    );
  });

  it("用量事件在失败路径上也发（未上报用量体现在 measuredCalls 的差上）", async () => {
    const root = scratch("headless-usage-fail");
    // `escalationPolicy: "exhaust"` 是唯一能拿到退出码 2 的策略（见协议文档 §3），
    // 这里正好把"预算耗尽"那条终态路径也走一遍。
    const spec = parse(
      JSON.stringify({
        ...LEGACY_SPEC,
        projectRoot: root,
        verificationCommands: [],
        maxRepairRounds: 0,
        escalationPolicy: "exhaust",
      }),
    );
    const { events, emit } = collect();
    const failingVerify: VerificationReport = {
      passed: false,
      results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 5 }],
    };

    const code = await runSpec(spec, {
      emit,
      // `tasksResponse` 的响应里没有 usageTokens —— 正是"服务商没上报"那一格。
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => failingVerify,
    });

    expect(code).toBe(2);
    const usage = events.find((e) => e.type === "usage") as Extract<HeadlessEvent, { type: "usage" }>;
    expect(usage).toBeDefined();
    expect(usage.totalTokens).toBe(0);
    expect(usage.calls).toBeGreaterThan(0);
    expect(usage.measuredCalls).toBe(0);
    expect(events.findIndex((e) => e.type === "usage")).toBeLessThan(
      events.findIndex((e) => e.type === "error"),
    );
  });

  it("断点续跑：journal 匹配需求时跳过规划（LLM 零调用），恢复执行", async () => {
    const root = scratch("headless-resume");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    // 预写运行日志：t1 已完成（快照携带恢复后的计划）
    const snapshot = {
      batches: [[fakeTask("t1", "src")]],
      allDone: ["t1"],
      skipped: [],
      attempts: { t1: 1 },
      round: 1,
      extraRounds: 0,
      lastDigest: "",
    };
    fs.writeFileSync(
      path.join(root, "ox-run-journal.json"),
      JSON.stringify({ requirement: spec.requirement, snapshot }),
      "utf8",
    );
    const { events, emit } = collect();
    let llmCalled = 0;
    const llm: LlmClient = {
      async chat() {
        llmCalled += 1;
        throw new Error("resume 模式不应调用 LLM");
      },
    };
    const adapter = fakeAdapter("worker");
    const code = await runSpec(spec, {
      emit,
      llm,
      layer: createAgentLayer({ adapters: [adapter] }),
      verify: async () => pass,
    });

    expect(code).toBe(0);
    expect(llmCalled).toBe(0); // 跳过 PRD/分解 → 大脑零调用
    expect(events.some((e) => e.type === "log" && e.text.includes("断点续跑"))).toBe(true);
    const runs = events.filter((e) => e.type === "run") as Array<{ phase: string }>;
    expect(runs.length).toBe(0); // t1 已完成 → 无任何派发
    expect(events.at(-1)?.type).toBe("done");
    // 快照在运行中被更新（journal.save 钩子生效）
    const saved = JSON.parse(fs.readFileSync(path.join(root, "ox-run-journal.json"), "utf8"));
    expect(saved.requirement).toBe(spec.requirement);
    expect(saved.snapshot.batches.length).toBe(1);
  });

  it("journal 需求不匹配 → 忽略旧日志按全新运行", async () => {
    const root = scratch("headless-journal-mismatch");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    fs.writeFileSync(
      path.join(root, "ox-run-journal.json"),
      JSON.stringify({
        requirement: "另一个需求",
        snapshot: { batches: [], allDone: [], skipped: [], attempts: {}, round: 3, extraRounds: 0, lastDigest: "" },
      }),
      "utf8",
    );
    const { events, emit } = collect();
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    expect(code).toBe(0);
    expect(events.some((e) => e.type === "log" && e.text.includes("需求不匹配"))).toBe(true);
    expect(events.some((e) => e.type === "prd")).toBe(true); // 走了全新规划
  });

  it("journal 快照解析失败 → 忽略并按全新运行", async () => {
    const root = scratch("headless-journal-corrupt");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, verificationCommands: [] }));
    fs.writeFileSync(path.join(root, "ox-run-journal.json"), "{not-json", "utf8");
    const { events, emit } = collect();
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    expect(code).toBe(0);
    expect(events.some((e) => e.type === "log" && e.text.includes("解析失败"))).toBe(true);
    expect(events.some((e) => e.type === "prd")).toBe(true);
  });

  it("skips PRD generation when the host supplies one", async () => {
    const root = scratch("headless-prd");
    const prd: PrdDocument = { goal: "g", features: [], techStack: [], acceptanceCriteria: [] };
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, prd }));
    const { events, emit } = collect();
    let chatCalls = 0;
    const llm: LlmClient = {
      async chat(req) {
        chatCalls += 1;
        const t = req.messages.map((m) => m.content).join("\n");
        expect(t).not.toContain("structured PRD");
        return { content: JSON.stringify({ tasks: [fakeTask("t1", "src")] }), provider: "fake", model: "fake-1" };
      },
    };
    const code = await runSpec(spec, {
      emit,
      llm,
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    expect(code).toBe(0);
    expect(chatCalls).toBe(1); // decomposition only
    expect(events.find((e) => e.type === "prd")).toBeTruthy();
  });

  it("exits 2 when the repair budget is spent with escalationPolicy=exhaust", async () => {
    const root = scratch("headless-fail");
    const spec = parse(
      JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, maxRepairRounds: 0, escalationPolicy: "exhaust" }),
    );
    const { events, emit } = collect();
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => ({
        passed: false,
        results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 5 }],
      }),
    });
    expect(code).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "error", exhausted: true });
  });

  it("exits 1 when the host aborts instead of exhausting the budget", async () => {
    const root = scratch("headless-abort");
    const spec = parse(
      JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, maxRepairRounds: 0, escalationPolicy: "abort" }),
    );
    const { events, emit } = collect();
    // A failing agent (not just failing verification) is what triggers escalation.
    const failing: AgentAdapter = Object.assign(fakeAdapter("worker"), {
      async *collect() {
        yield { kind: "failed" as const, text: "exit 1", timestamp: Date.now() };
      },
    });
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [failing] }),
      verify: async () => ({
        passed: false,
        results: [{ kind: "test", ok: false, exitCode: 1, logDigest: "boom", durationMs: 5 }],
      }),
    });
    expect(code).toBe(1);
    const escalation = events.find((e) => e.type === "escalation") as Extract<HeadlessEvent, { type: "escalation" }>;
    expect(escalation).toBeTruthy();
    expect(escalation.taskId).toBe("t1");
    expect(events.at(-1)!.type).toBe("error");
  });

  it("exits 1 before emitting hello when the project root is missing", async () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: path.join(os.tmpdir(), "ox-does-not-exist-xyz") }));
    const { events, emit } = collect();
    const code = await runSpec(spec, { emit, isDirectory: () => false });
    expect(code).toBe(1);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("projectRoot") }]);
  });

  it("projectRoot 指向一个文件（存在、但不是目录）时同样拒跑", async () => {
    // 上一条注入的是 isDirectory，所以默认实现那一格从没被走过 —— 只看 existsSync
    // 的实现会把一个普通文件当成合法根目录，然后一路走到第一次真读写才炸。
    const file = path.join(scratch("headless-root-file"), "not-a-dir.txt");
    fs.writeFileSync(file, "x", "utf8");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: file }));
    const { events, emit } = collect();
    const code = await runSpec(spec, { emit });
    expect(code).toBe(1);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("不是目录") }]);
  });

  it("上次被中断留下的备份目录在 hello 之后就被回收，并且说出来", async () => {
    // 静默回收等于没回收：snapshotRoot 只会变大的那个前提，就是没人告诉宿主它被清过。
    const root = scratch("headless-prune-run");
    const snap = path.join(root, ".snap");
    const stale = path.join(snap, "batch-interrupted");
    fs.mkdirSync(stale, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    const spec = parse(
      JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, snapshotRoot: snap, verificationCommands: [] }),
    );
    const { events, emit } = collect();
    const code = await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    expect(code, JSON.stringify(events.filter((e) => e.type === "error"))).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    const logs = events.filter((e) => e.type === "log").map((e) => e.text);
    expect(logs.some((t) => t.includes("[snapshots] 回收 1 个"))).toBe(true);
    // hello 仍然先发出：宿主的读法是先拿 hello 再判其余事件。
    expect(events[0]!.type).toBe("hello");
  });

  it("三种升级策略在“还要不要再派一次”上是三种行为", async () => {
    // 都只断言"最后报了 escalation"的话，三者就退化成一种 —— 取反位点正是在这里存活。
    const rows: Array<{ policy: string; code: number; dispatches: number; escalations: number }> = [];
    for (const policy of ["skip", "redispatch_once", "abort"] as const) {
      const root = scratch(`headless-esc-${policy}`);
      const spec = parse(
        JSON.stringify({
          ...LEGACY_SPEC,
          projectRoot: root,
          maxRepairRounds: 0,
          escalationPolicy: policy,
          verificationCommands: [],
        }),
      );
      const { events, emit } = collect();
      let dispatches = 0;
      const failing: AgentAdapter = Object.assign(fakeAdapter("worker"), {
        async dispatch(payload: TaskPayload) {
          dispatches += 1;
          return { runId: payload.runId, agentId: "worker", taskId: payload.taskId };
        },
        async *collect() {
          yield { kind: "failed" as const, text: "exit 1", timestamp: Date.now() };
        },
      });
      const code = await runSpec(spec, {
        emit,
        llm: tasksResponse([fakeTask("t1", "src")]),
        layer: createAgentLayer({ adapters: [failing] }),
        verify: async () => pass,
      });
      rows.push({
        policy,
        code,
        dispatches,
        escalations: events.filter((e) => e.type === "escalation").length,
      });
    }
    expect(rows).toEqual([
      { policy: "skip", code: 0, dispatches: 1, escalations: 1 },
      { policy: "redispatch_once", code: 1, dispatches: 2, escalations: 2 },
      { policy: "abort", code: 1, dispatches: 1, escalations: 1 },
    ]);
  });

  it("surfaces protocol warnings as log lines", async () => {
    const root = scratch("headless-warn");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, futureFlag: 1 }));
    const { events, emit } = collect();
    await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [fakeAdapter("worker")] }),
      verify: async () => pass,
    });
    const hello = events[0] as Extract<HeadlessEvent, { type: "hello" }>;
    expect(hello.warnings.join()).toContain("futureFlag");
    expect(events.some((e) => e.type === "log" && e.text.includes("futureFlag"))).toBe(true);
  });

  it("reports a zone violation as a structured conflict event", async () => {
    const root = scratch("headless-conflict");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.js"), "a", "utf8");
    const rogue: AgentAdapter = Object.assign(fakeAdapter("rogue"), {
      async dispatch(payload: { runId: string; taskId: string; projectRoot: string }) {
        fs.mkdirSync(path.join(root, "outside"), { recursive: true });
        fs.writeFileSync(path.join(root, "outside/x.js"), "rogue", "utf8");
        return { runId: payload.runId, agentId: "rogue", taskId: payload.taskId };
      },
    });
    // Snapshots live outside the project (as they do in production, under
    // userData) — otherwise the backup directory itself counts as a zone change.
    const snapRoot = scratch("headless-conflict-snap");
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, snapshotRoot: snapRoot }));
    const { events, emit } = collect();
    await runSpec(spec, {
      emit,
      llm: tasksResponse([fakeTask("t1", "src")]),
      layer: createAgentLayer({ adapters: [rogue], snapshotRoot: snapRoot }),
      verify: async () => pass,
    });
    const conflict = events.find((e) => e.type === "conflict") as Extract<HeadlessEvent, { type: "conflict" }>;
    expect(conflict).toBeTruthy();
    expect(conflict.kind).toBe("unauthorized-write");
    expect(conflict.paths).toEqual(["outside/x.js"]);
    expect(conflict.remedy).toBe("revert");
    // The rogue file is gone: revert is the default arbitration mode.
    expect(fs.existsSync(path.join(root, "outside/x.js"))).toBe(false);
  });
});

describe("headless entry point", () => {
  it("keeps a legacy spec working through the whole binary contract", async () => {
    // The shell itself is trivial by design; this pins that the pieces it wires
    // together still accept the original spec shape.
    const root = scratch("headless-entry");
    const parsed = parseSpec(JSON.stringify({ ...LEGACY_SPEC, projectRoot: root, snapshotRoot: path.join(root, ".snap") }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const events: HeadlessEvent[] = [];
    const code = await runSpec(parsed.spec, {
      emit: (e) => events.push(e),
      llm: { async chat() { return { content: JSON.stringify({ tasks: [] }), provider: "fake", model: "fake" }; } },
      layer: createAgentLayer({ adapters: [] }),
    });
    // No tasks ⇒ nothing to develop; the engine still reports a terminal state.
    expect([0, 1, 2]).toContain(code);
    expect(events[0]!.type).toBe("hello");
  });
});

/**
 * 下面这一组来自 site 逐位点审计（protocol.ts 11 处存活）。
 *
 * 全部是 `parseSpec` 的**多条件校验**。共同形态：条件用 `||` 串起来
 * （"任一不满足即拒绝"），既有用例只触发了其中**一条** ——
 * 因为 `||` 短路，前面成立时后面根本不求值。
 *
 * 改成 `&&`（"全部不满足才拒绝"）之后，**非法 spec 会被静默接受** ——
 * 契约面失效，而且是往"放行"的方向失效。
 */
describe("parseSpec · 数值字段的三个条件各自生效", () => {
  for (const field of ["maxRepairRounds", "maxParallelRuns"] as const) {
    it(`${field} 拒绝非数字`, () => {
      // 条件一：`typeof !== "number"`
      const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, [field]: "3" }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(field);
    });

    it(`${field} 拒绝非有限数（JSON 的 1e999 会溢出成 Infinity）`, () => {
      // 条件二：`!Number.isFinite`。这一条**只有非有限数能触发** ——
      // 而 JSON 语法允许 `1e999`（解析结果就是 Infinity），所以它可达。
      // 既有用例只测了 -1（条件三）与合法数，条件二从未被求值过。
      const r = parseSpec(`{"requirement":"x","projectRoot":".","${field}":1e999}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(field);
    });

    it(`${field} 拒绝负数`, () => {
      const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, [field]: -1 }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain(field);
    });

    it(`${field} 接受 0 与正数`, () => {
      expect(parse(JSON.stringify({ ...LEGACY_SPEC, [field]: 0 }))).toBeTruthy();
      expect(parse(JSON.stringify({ ...LEGACY_SPEC, [field]: 3 }))).toBeTruthy();
    });
  }
});

describe("parseSpec · arbitration 合法值必须被接受", () => {
  it("显式传入合法模式时写进 settings", () => {
    // 既有用例从不传 arbitration（LEGACY_SPEC 里没有这个字段），
    // 报错分支那条用例传的是 "wishful"（合法的**字符串**、非法的模式）——
    // 于是 `typeof raw.arbitration !== "string"` 改成 `===` 也照样全绿。
    // 改坏后**任何合法模式都会被判成非法**，headless 入口直接不可用。
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, arbitration: "revert-batch" }));
    expect(spec.settings.arbitration).toBe("revert-batch");
  });

  it("拒绝非字符串与未知模式", () => {
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, arbitration: 7 })).ok).toBe(false);
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, arbitration: "wishful" })).ok).toBe(false);
  });
});

describe("parseSpec · llmPool 元素的两个条件", () => {
  it("拒绝非字符串元素", () => {
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: [7] })).ok).toBe(false);
  });

  it("拒绝纯空白元素", () => {
    // 条件二 `p.trim() === ""`：既有用例只测了"非字符串"与"未知 provider"，
    // 纯空白串既不是非字符串、也过不了 provider 查表 —— 但它在更早的
    // 元素校验就该被拦下，否则会带着空白 id 走进后面的 provider 解析。
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["   "] })).ok).toBe(false);
  });

  it("接受合法 provider 列表", () => {
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, llmPool: ["sensenova"] })).llmPool).toEqual([
      "sensenova",
    ]);
  });
});

describe("parseSpec · prd 四个字段逐个校验", () => {
  const good = { goal: "做一个待办", features: [], techStack: [], acceptanceCriteria: [] };

  it("接受完整的 prd", () => {
    const spec = parse(JSON.stringify({ ...LEGACY_SPEC, prd: good }));
    expect(spec.prd).toBeTruthy();
  });

  it("四个字段各自缺失时都要拒绝", () => {
    // `bad` 由四个 `||` 串成。既有用例只覆盖其中一类缺失，
    // 于是另外三处改成 `&&` 也看不出来 —— 改坏后缺字段的 prd 会被放行，
    // 后面按 prd 派单/生成 zone 时会拿到 undefined。
    for (const missing of ["goal", "features", "techStack", "acceptanceCriteria"]) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[missing];
      const r = parseSpec(JSON.stringify({ ...LEGACY_SPEC, prd: bad }));
      expect(r.ok, `prd 缺 ${missing} 时应当被拒绝`).toBe(false);
    }
  });

  it("goal 为空串也算缺失", () => {
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, prd: { ...good, goal: "  " } })).ok).toBe(false);
  });
});

describe("parseSpec · agentRouter 透传到 settings", () => {
  it("true 与 false 都要原样写进 settings", () => {
    // 第 302 行 `raw.agentRouter !== undefined && agentRouter !== undefined`。
    // 两个 `!==` 分别改成 `===` 后，条件恒假 —— settings 会**丢掉 agentRouter**，
    // 用户显式配置的能力路由被静默忽略，回落到 DEFAULT_SETTINGS 的值。
    // 两种取值都断言，是为了不依赖 "默认值恰好等于其中一个"。
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, agentRouter: true })).settings.agentRouter).toBe(true);
    expect(parse(JSON.stringify({ ...LEGACY_SPEC, agentRouter: false })).settings.agentRouter).toBe(
      false,
    );
  });

  it("非布尔值被拒绝", () => {
    expect(parseSpec(JSON.stringify({ ...LEGACY_SPEC, agentRouter: "yes" })).ok).toBe(false);
  });
});
