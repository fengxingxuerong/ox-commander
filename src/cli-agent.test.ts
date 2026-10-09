import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CliAgentAdapter, killTree } from "../electron/agents/cli-agent";
import { createDefaultCommandPolicy } from "../electron/sandbox/command-policy";
import { parseDecompose } from "../shared/schema";
import type { AgentEvent, TaskPayload } from "../shared/types";

const NODE = process.execPath;
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-cli-prompts-"));

afterAll(() => {
  // Child processes may still hold the directory on Windows; retry briefly and
  // never fail the suite over temp-file cleanup.
  try {
    fs.rmSync(promptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // left to the OS temp cleaner
  }
});

function payload(over: Partial<TaskPayload> = {}): TaskPayload {
  return {
    runId: `r-${Math.random().toString(36).slice(2)}`,
    taskId: "t1",
    title: "实现解析器",
    description: "写一个解析器",
    zone: "src/core",
    projectRoot: promptDir,
    ...over,
  };
}

function cli(args: string[], over: Partial<ConstructorParameters<typeof CliAgentAdapter>[0]> = {}) {
  return new CliAgentAdapter({
    id: "cli-under-test",
    command: NODE,
    argsTemplate: args,
    promptDir,
    ...over,
  });
}

async function drainEvents(adapter: CliAgentAdapter, handle: Awaited<ReturnType<CliAgentAdapter["dispatch"]>>) {
  const events: AgentEvent[] = [];
  for await (const e of adapter.collect(handle)) events.push(e);
  return events;
}

describe("CliAgentAdapter", () => {
  it("probes an existing binary and rejects a missing one", async () => {
    expect(await cli(["-e", ""]).probe()).toBe(true);
    const missing = new CliAgentAdapter({
      id: "missing",
      command: "ox-missing-binary-xyz",
      argsTemplate: [],
      promptDir,
    });
    expect(await missing.probe()).toBe(false);
  });

  it("streams stdout as log events and completes on exit code 0", async () => {
    const adapter = cli(["-e", "console.log('line one');console.log('line two')"]);
    const handle = await adapter.dispatch(payload());
    const events = await drainEvents(adapter, handle);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("completed");
    const text = events.map((e) => e.text).join("\n");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  it("dispatch 记录被裁掉的密钥名（只记名字、永不记值）", async () => {
    // droppedSecretNames 接线（2026-09-27）：unwired 白名单挂了很久的"接上
    // 日志后即可移出本表"——dispatch 的事件流现在要如实报告裁了哪些密钥名，
    // 让操作员能核对最小化环境没有误裁也没有漏裁。值永远不出现在日志里。
    process.env.OX_TEST_SECRET_TOKEN = "do-not-leak";
    try {
      const adapter = cli(["-e", ""], { envTemplate: { MY_AGENT_KEY: "x" } });
      const handle = await adapter.dispatch(payload());
      const events = await drainEvents(adapter, handle);
      const text = events.map((e) => e.text).join("\n");
      expect(text).toMatch(/裁掉.*密钥/);
      expect(text).toContain("OX_TEST_SECRET_TOKEN");
      expect(text).not.toContain("do-not-leak");
    } finally {
      delete process.env.OX_TEST_SECRET_TOKEN;
    }
  });

  it("fails the run on a non-zero exit code", async () => {
    const adapter = cli(["-e", "console.error('boom');process.exit(3)"]);
    const handle = await adapter.dispatch(payload());
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("failed");
    expect(events.map((e) => e.text).join("\n")).toContain("boom");
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("failed");
  });

  it("writes a prompt file and substitutes it into the argv", async () => {
    const adapter = cli([
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8').split('\\n')[0])",
      "{{promptPath}}",
    ]);
    const handle = await adapter.dispatch(payload());
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain("# 任务：实现解析器");
  });

  it("passes the repair context into the prompt", async () => {
    const adapter = cli([
      "-e",
      "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
      "{{promptPath}}",
    ]);
    const handle = await adapter.dispatch(
      payload({ repairContext: { round: 2, errorLogDigest: "TypeError: x is not a function" } }),
    );
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain("第 2 轮修复");
    expect(text).toContain("TypeError: x is not a function");
  });

  it("runs with shell:false so metacharacters reach the child verbatim", async () => {
    // With a shell in the loop, `a && echo pwned` would be split into two
    // commands; without one it must arrive as a single argv element.
    const adapter = cli([
      "-e",
      "process.stdout.write('ARGV:' + JSON.stringify(process.argv.slice(1)))",
      "a && echo pwned",
      "b|c",
    ]);
    const handle = await adapter.dispatch(payload());
    const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
    expect(text).toContain('ARGV:["a && echo pwned","b|c"]');
  });

  it("aborts a long-running child and reports an aborted terminal event", async () => {
    const adapter = cli(["-e", "setTimeout(() => {}, 30000)"]);
    const handle = await adapter.dispatch(payload());
    expect(adapter.activeRunCount()).toBe(1);
    await adapter.abort(handle);
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("aborted");
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("aborted");
  });

  it("aborts an unknown run id without crashing", async () => {
    // The guard is `!run || run.session.finished`. With `&&` instead, a missing
    // run falls through to `run.session.finished` and throws a TypeError —
    // aborting something already reaped would take down the caller.
    const adapter = cli(["-e", ""]);
    await expect(
      adapter.abort({ runId: "ghost-run", agentId: "cli-under-test", taskId: "" }),
    ).resolves.toBeUndefined();
  });

  it("does not label an in-flight run as a timeout", async () => {
    // `lastKind === "failed" && run.exitCode === null` — both halves matter.
    // Flipping to `||` marks ANY run that has not exited yet (including one
    // still streaming output) as a retryable timeout.
    const adapter = cli(["-e", "setTimeout(() => {}, 5000)"]);
    const handle = await adapter.dispatch(payload());
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("failed");
    expect(result?.errorClass).toBeUndefined();
    await adapter.abort(handle);
  });

  it("已结束但尚未被 collect 移除的 run：lastResult 回报真实终态，不误报 failed", async () => {
    // 与 `http-bridge.ts` 同判据（2026-10-09 成对读代码，清单第 12 项）。
    // 旧写法 `run.session.finished ? "failed" : "log"` 两个分支都映成 `failed`，
    // 于是"跑完了、但 collect 还没来得及把它移出 runs"这一小段窗口里，
    // 一个 `completed` 的 run 会被读成 `failed` —— 与 bridge 相反。
    const adapter = cli(["-e", ""]);
    const handle = await adapter.dispatch(payload());
    // drain 只等 done、**不移除** run（移除只发生在 collect 的 finally）——
    // 正好构造出"已结束且仍在 runs 里"的那个窗口。
    expect(await adapter.drain(5000)).toBe("drained");
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("completed");
    // 收尾：正常消费事件流。
    await drainEvents(adapter, handle);
  });

  it("lastResult 对未知 run 返回 undefined（不因缺 run 而抛）", async () => {
    // 判据是 `run && !run.session.finished`：`&&` 改成 `||` 后，
    // 缺 run 时会去读 `run.session` 抛 TypeError；这条钉住短路语义。
    const adapter = cli(["-e", ""]);
    expect(await adapter.lastResult({ runId: "ghost", agentId: "cli-under-test", taskId: "" })).toBeUndefined();
  });

  it("caps the finished-result cache instead of growing forever", async () => {
    // The eviction guard is `oldest !== undefined`. With `===` it never fires,
    // because the key of a non-empty Map is never undefined — `results` then
    // grows without bound for the lifetime of the adapter.
    const adapter = cli(["-e", ""]);
    const internals = adapter as unknown as {
      results: Map<string, unknown>;
      rememberResult(run: unknown, runId: string, kind: string): void;
    };
    for (let i = 0; i < 60; i++) {
      internals.rememberResult(
        { taskId: "t1", logs: [], startedAt: Date.now(), exitCode: 0 },
        `r-${i}`,
        "completed",
      );
    }
    expect(internals.results.size).toBeLessThanOrEqual(50);
  });

  it("drains immediately when nothing is running", async () => {
    expect(await cli(["-e", ""]).drain(100)).toBe("drained");
  });

  it("reports drain timeout and aborts the stragglers", async () => {
    const adapter = cli(["-e", "setTimeout(() => {}, 30000)"]);
    const handle = await adapter.dispatch(payload());
    expect(await adapter.drain(150)).toBe("timeout");
    const events = await drainEvents(adapter, handle);
    expect(events.at(-1)!.kind).toBe("aborted");
  });

  it("keeps the result available after the run was collected", async () => {
    const adapter = cli(["-e", "console.log('done')"]);
    const handle = await adapter.dispatch(payload());
    await drainEvents(adapter, handle);
    const result = await adapter.lastResult(handle);
    expect(result?.status).toBe("completed");
    expect(result?.logDigest).toContain("done");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("exposes declared capabilities and limits", () => {
    const adapter = cli(["-e", ""], {
      capabilities: {
        roles: ["test-writer"],
        zoneGlobs: ["tests/**"],
        supports: ["read", "edit"],
        artifactKinds: ["files"],
        maxConcurrency: 1,
        selfIsolated: true,
      },
      limits: { runDeadlineMs: 12_345 },
    });
    expect(adapter.capabilities().roles).toEqual(["test-writer"]);
    expect(adapter.limits.runDeadlineMs).toBe(12_345);
    expect(adapter.limits.idleTimeoutMs).toBeGreaterThan(0);
  });
});

describe("killTree", () => {
  it("is a no-op for a process without a pid", () => {
    expect(() => killTree({ pid: undefined } as never)).not.toThrow();
  });

  it("survives a child that throws on kill", () => {
    // The portable path must swallow a kill() that throws rather than
    // propagating into the caller's finally block.
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error("ESRCH");
      },
    };
    expect(() => killTree(child as never, { graceMs: 1 })).not.toThrow();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const signals: string[] = [];
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: (sig: string) => {
        signals.push(sig);
        return true;
      },
    };
    killTree(child as never, { graceMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});

describe("CliAgentAdapter · 看门狗原因与失败分类", () => {
  it("[219] 超总时限触发的看门狗说明是「超出总时限」，不是「空闲无输出」", () => {
    // 第 219 行 `reason === "deadline" ? "超出总时限" : "空闲无输出"`。
    // 改成 `!==` 后两种原因的**文案对调** —— 排障时被引向错误方向：
    // 明明是整个 run 超过硬上限，日志却说"空闲无输出"，于是去查远端
    // 为什么不输出，而不是去查为什么跑这么久。
    //
    // 触发手段：把 idle 超时设得远大于 deadline，确保是 deadline 这一支
    //（否则静默的子进程会先命中 idle，两种写法都会说"空闲无输出"）。
    return (async () => {
      const adapter = cli(["-e", "setTimeout(() => {}, 5000)"], {
        limits: { runDeadlineMs: 80, idleTimeoutMs: 60_000 },
      });
      const handle = await adapter.dispatch(payload());
      const text = (await drainEvents(adapter, handle)).map((e) => e.text).join("\n");
      expect(text).toContain("超出总时限");
      expect(text).not.toContain("空闲无输出");
    })();
  });

  it("[333] 带真实退出码的失败不能被标成 timeout", () => {
    // 第 333 行 `lastKind === "failed" && run.exitCode === null`。
    // `exitCode === null` 的含义是"进程没正常退出"（被看门狗杀掉），
    // 改成 `!==` 之后**方向反了**：真正跑完但返回非 0 的失败（编译错误、
    // 断言失败）会被标成 `errorClass: "timeout"`。重修策略会按"超时"去重试，
    // 而真实错误从未被处理 —— 表现为"同一处反复重修、每轮都超时"。
    return (async () => {
      const adapter = cli(["-e", "console.error('boom');process.exit(3)"]);
      const handle = await adapter.dispatch(payload());
      await drainEvents(adapter, handle);
      const result = await adapter.lastResult(handle);
      expect(result?.status).toBe("failed");
      expect(result?.errorClass).not.toBe("timeout");
    })();
  });
});

/**
 * D9（2026-10-05 全方面体检 → **一条被推翻的建议**）。
 *
 * 体检发现：`cli-agent.ts` 是 `buildSpawnSpec` 的调用点里唯一不查
 * `CommandPolicy` 的（`verifier.ts` 两处都查），而真机实测 `quoteForCmd`
 * 的 `\"` 转义挡不住注入（`say"hi&whoami` 里的 `&whoami` 真的执行了）。
 * 当时的建议是"给本文件补 policy.check"。
 *
 * **实测之后这个建议是错的，已撤销。** `CommandPolicy` 的白名单是
 * **构建/测试工具链**（node/npm/tsc/vitest/git…），它服务的是"验证阶段允许跑
 * 哪些命令"；CLI 智能体的 command 是 codex / claude / aider / goose / qwen，
 * 实测 `agents.d/` 下 **11/11** 个清单都会被默认策略拒绝 —— 补上检查等于
 * **让所有 CLI 智能体全部不可用**。这正是"假红比假绿更消耗信任"的又一次实例。
 *
 * 这组用例钉住的是**推翻它的那条证据**，而不是那条错误建议：
 * 若将来有人再次"顺手"把 CommandPolicy 套到 agent 适配器上，本组会先红。
 */
describe("CLI 智能体命令与验证命令策略的边界（2026-10-05 D9）", () => {
  const agentsDir = path.resolve(__dirname, "..", "agents.d");

  it("CommandPolicy 的白名单服务的是构建/测试工具链，不是 agent CLI", () => {
    const policy = createDefaultCommandPolicy();
    // 构建工具链在白名单里 —— 这正是它该在的地方。
    expect(policy.check("npm", ["run", "build"]).ok).toBe(true);
    expect(policy.check("vitest", ["run"]).ok).toBe(true);
    // agent CLI **不在** —— 这就是不能把这套策略套到 agent 适配器上的原因。
    expect(policy.check("codex", ["exec"]).ok).toBe(false);
  });

  it("agents.d 下每个真实清单的 command 都不在 CommandPolicy 白名单里", () => {
    const policy = createDefaultCommandPolicy();
    const files = fs.readdirSync(agentsDir).filter((n) => n.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const cliEntry = files.filter((f) => {
      const m = JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf8"));
      return typeof m.entry?.command === "string" && m.entry.command !== "";
    });
    expect(cliEntry.length, "至少要有几个带 command 的 CLI 清单").toBeGreaterThan(0);
    for (const f of cliEntry) {
      const m = JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf8"));
      expect(
        policy.check(m.entry.command, m.entry.argsTemplate ?? []).ok,
        `${f}: ${m.entry.command} 若**能**通过 CommandPolicy，说明白名单变了，` +
          "本组用例的前提（两套命令面互不相干）已失效，请重新评估",
      ).toBe(false);
    }
  });

  it("agent argv 的安全靠取值来源（生成物），不靠 CommandPolicy", () => {
    // 把这条推理链钉死：将来加占位符时，这三条前提里断一条就要重新审视。
    const policy = createDefaultCommandPolicy();
    const spec = (zone: string) => ({
      tasks: [{ id: "t1", title: "t", description: "d", zone, dependencies: [], suggestedRole: "backend-dev" }],
      smoke: [],
    });
    // ① {{zone}} 的白名单不含任何 shell 元字符（shared/schema.ts）
    expect(() => parseDecompose(spec("a&b"))).toThrow();
    expect(() => parseDecompose(spec("src/core"))).not.toThrow();
    // ② CommandPolicy 确实会拦元字符 —— 它是有用的，只是**用在这里用错了地方**
    expect(policy.check("node", ["a&b"]).ok).toBe(false);
  });
});
