import { spawn } from "node:child_process";
import type { SmokeCheck, VerificationCommand, VerificationReport } from "../../shared/types";
import { digest } from "./scheduler";
import { CommandPolicy, createDefaultCommandPolicy } from "../sandbox/command-policy";
import type { ActionGateLike } from "../sandbox/action-gate";
import type { ApprovalGate } from "../sandbox/approval-gate";
import { buildSpawnSpec } from "../sandbox/spawn-plan";
import { killTree } from "../sandbox/kill-tree";
import { killDevServer, pollDevServerProcess } from "./dev-server";
import { scopedEnv } from "../agents/scoped-env";

export interface VerifierDeps {
  cwd: () => string;
  spawnImpl?: typeof spawn;
  /**
   * Structural gate for the configured commands. Defaults to the built-in
   * policy (allow common build/test toolchains, refuse destructive programs and
   * shell metacharacters).
   */
  policy?: CommandPolicy;
  /**
   * Cross-action escalation (optional): queried after the static policy passes.
   * The same batch-scoped instance the scheduler observes — installs seen in
   * agent logs tighten what the verifier will spawn afterwards.
   */
  actionGate?: ActionGateLike;
  /**
   * 审批门（P2-3，可选）：静态策略与跨动作升级都放行之后、**spawn 之前**问一次人。
   *
   * 位置是刻意的：放在最后一道，因为它问的是"现在真的要跑了吗"—— 前面几层
   * 拒绝掉的命令根本不该打扰人。配了 `approvalCommands` 才有实例；没配时
   * 调用方传 undefined，本模块零影响（默认路径不多出人工环节）。
   */
  approvalGate?: ApprovalGate;
  /** Per-command ceiling; the process tree is killed when it expires. 300s default. */
  timeoutMs?: number;
  /** Observability sink (rejections, timeouts). */
  onEvent?: (text: string) => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Byte budget for one command's captured output (aligned with the agent
 * `maxStdoutBytes` default). Without it a pathological build script stuck in a
 * print loop balloons memory per verification round. The stream is ALWAYS
 * drained — only the accumulation stops — so the child never blocks on a full
 * pipe; the budget is enforced at chunk granularity (worst case overshoot is
 * one pipe chunk).
 */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

function runOnce(
  cmd: VerificationCommand,
  cwd: string,
  spawnImpl: typeof spawn,
  timeoutMs: number,
  onEvent?: (text: string) => void,
): Promise<{ kind: typeof cmd.kind; ok: boolean; exitCode: number | null; log: string; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // `shell: false` on every platform: the argv reaches the program verbatim.
    // Windows `.cmd` shims (npm, yarn, gradle) cannot be spawned that way, so
    // `buildSpawnSpec` wraps them in `cmd.exe /d /s /c` — safe only because the
    // CommandPolicy gate above already rejected shell metacharacters.
    const plan = buildSpawnSpec(cmd.command, cmd.args);
    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(plan.file, plan.args, {
        cwd,
        shell: false,
        // 验证命令跑的是智能体刚写下的脚本。默认继承 process.env 会把手上的
        // 每一把 provider key 交给它 —— 桌面端的 keychain 正是播种进 process.env 的。
        env: scopedEnv(),
        // 2026-09-28：原为 `...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})`。
        // spawn 只看真假，`undefined` 与"不传"同义（三元算子评估后简化）。
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (err) {
      resolve({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        log: `spawn failed (${plan.note}): ${String(err)}`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    let log = "";
    let logBytes = 0;
    let droppedBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onEvent?.(`[verifier] ${cmd.command} 超过 ${Math.round(timeoutMs / 1000)}s，终止进程树`);
      killTree(child);
    }, timeoutMs);

    const onChunk = (c: Buffer): void => {
      if (logBytes >= MAX_LOG_BYTES) {
        droppedBytes += c.length;
        return;
      }
      logBytes += c.length;
      log += c.toString("utf8");
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        log: `spawn failed (${plan.note}): ${String(err)}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let finalLog = timedOut ? `${log}\n[沙箱] 超过 ${timeoutMs}ms，已终止进程树` : log;
      if (droppedBytes > 0) {
        finalLog += `\n[沙箱] 输出超过 ${Math.round(MAX_LOG_BYTES / 1024)}KB 预算，已丢弃约 ${Math.round(droppedBytes / 1024)}KB`;
      }
      resolve({
        kind: cmd.kind,
        ok: !timedOut && code === 0,
        exitCode: timedOut ? null : code,
        log: finalLog,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Runs build → typecheck → test in order and stops at the first failure.
 *
 * Sandbox gate (P3): every configured command is checked against the
 * CommandPolicy first. A rejected command is reported as a failed step carrying
 * the reason instead of being spawned, so a bad setting cannot silently execute
 * something destructive — the pipeline treats it like any other failed
 * verification and goes into repair.
 */
export async function verifyProject(
  commands: VerificationCommand[],
  deps: VerifierDeps,
): Promise<VerificationReport> {
  const results: VerificationReport["results"] = [];
  const spawnImpl = deps.spawnImpl ?? spawn;
  const policy = deps.policy ?? createDefaultCommandPolicy();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  for (const cmd of commands) {
    const verdict = policy.check(cmd.command, cmd.args);
    if (!verdict.ok) {
      deps.onEvent?.(`[verifier] 拒绝执行：${verdict.reason}`);
      results.push({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 命令被拒绝：${verdict.reason}`,
        durationMs: 0,
        errorClass: "sandbox-denied",
      });
      break;
    }
    // Static policy passed — now the cross-action layer: a command that is
    // fine in isolation may still be escalated by what happened earlier in
    // the batch (installs observed in agent logs …).
    const escalated = deps.actionGate?.check(cmd.command, cmd.args);
    if (escalated && !escalated.ok) {
      deps.onEvent?.(`[verifier] 升级拒绝：${escalated.reason}`);
      results.push({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 升级拒绝：${escalated.reason}`,
        durationMs: 0,
        errorClass: "escalation-denied",
      });
      break;
    }
    // 审批门（P2-3）放在最后一道：前面几层拒掉的命令不该打扰人。
    // async —— 这里会阻塞在人的响应上，与上面两个同步判定刻意不同。
    const approved = await deps.approvalGate?.check(cmd.command, cmd.args);
    if (approved && !approved.ok) {
      deps.onEvent?.(`[verifier] 审批拒绝：${approved.reason}`);
      results.push({
        kind: cmd.kind,
        ok: false,
        exitCode: null,
        logDigest: `[审批] ${approved.reason}`,
        durationMs: 0,
        errorClass: "approval-denied",
      });
      break;
    }
    const r = await runOnce(cmd, deps.cwd(), spawnImpl, timeoutMs, deps.onEvent);
    results.push({
      kind: r.kind,
      ok: r.ok,
      exitCode: r.exitCode,
      logDigest: digest(r.log),
      durationMs: r.durationMs,
    });
    if (!r.ok) break;
  }
  return { passed: results.every((r) => r.ok), results };
}

export interface SmokeRunnerDeps {
  cwd: string;
  spawnImpl?: typeof spawn;
  /** 冒烟命令同样过沙箱门（默认策略）。 */
  policy?: CommandPolicy;
  /** 跨动作升级审查（可选），与 verifyProject 同一实例。 */
  actionGate?: ActionGateLike;
  /** 审批门（P2-3，可选），与 verifyProject 同一实例。 */
  approvalGate?: ApprovalGate;
  timeoutMs?: number;
  onEvent?: (text: string) => void;
  /** dev server 探活用的 fetch（测试注入假件；缺省用全局 fetch 走真 HTTP）。 */
  devServerFetch?: typeof fetch;
}

/**
 * 一次冒烟子进程的**原始事实**。
 *
 * 刻意不把退出码编码进 `log` 再解析回来：那样判据就落在了被判定方能写的
 * 字节里 —— 子进程只要在 stdout 打印一行形如 `[exit]0` 的文本，就能把
 * 自己真实的失败改写成一串更早出现的"通过"标记（取第一个匹配时必然如此）。
 * 退出码只能来自 `close` 事件，这是它与操作系统之间的直接约定。
 */
interface SmokeOutcome {
  /** 已按 `MAX_LOG_BYTES` 截断的子进程输出（含截断标注）。 */
  log: string;
  /** `close` 事件给出的真实退出码；被信号杀死或 spawn 失败时为 null。 */
  exitCode: number | null;
  /** 超时终止（此时退出码无意义）。 */
  timedOut: boolean;
}

/**
 * 独立样本冒烟：运行规划期生成的真实样例命令（防自证盲区层）。
 *
 * 与 verifyProject 的区别：命令来自大脑的 decompose 产物（针对交付后的主入口），
 * 支持通过 stdin 喂样例数据，且 ok = **真实退出码为 0** 且 stdout 包含全部
 * expectContains 片段。同样过 CommandPolicy 沙箱门 —— 冒烟命令也不得越界。
 * 首败即停，与 verifyProject 保持一致，让失败进入重修循环。
 *
 * ⚠️ 判定不读子进程的输出文本（R1「判据必须独立于被判定方」）：`ok` 只看
 * `close` 事件的退出码与期望片段是否出现，子进程无法通过在输出里写字影响自己的判定。
 */
export async function runSmokeChecks(
  checks: SmokeCheck[],
  deps: SmokeRunnerDeps,
): Promise<VerificationReport["results"]> {
  const results: VerificationReport["results"] = [];
  const spawnImpl = deps.spawnImpl ?? spawn;
  const policy = deps.policy ?? createDefaultCommandPolicy();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  for (const check of checks) {
    const verdict = policy.check(check.command, check.args);
    if (!verdict.ok) {
      results.push({
        kind: "smoke",
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 冒烟命令被拒绝：${verdict.reason}\n[${check.title}]`,
        durationMs: 0,
        errorClass: "sandbox-denied",
      });
      break;
    }
    // 静态门放行后叠加跨动作升级：冒烟命令是大脑的生成产物，批次内出现过
    // 依赖安装/发布/推送痕迹后，隐式下载类命令（npx 等）升级为拒绝。
    const escalated = deps.actionGate?.check(check.command, check.args);
    if (escalated && !escalated.ok) {
      results.push({
        kind: "smoke",
        ok: false,
        exitCode: null,
        logDigest: `[沙箱] 冒烟命令升级拒绝：${escalated.reason}\n[${check.title}]`,
        durationMs: 0,
        errorClass: "escalation-denied",
      });
      break;
    }
    // 审批门（P2-3）：与 verifyProject 同位置、同实例（批次内批准过就不再问）。
    const approved = await deps.approvalGate?.check(check.command, check.args);
    if (approved && !approved.ok) {
      results.push({
        kind: "smoke",
        ok: false,
        exitCode: null,
        logDigest: `[审批] ${approved.reason}\n[${check.title}]`,
        durationMs: 0,
        errorClass: "approval-denied",
      });
      break;
    }

    const startedAt = Date.now();
    const plan = buildSpawnSpec(check.command, check.args);

    // dev server 托管检查（竞品 5.4）：驻留进程 + HTTP 探活。三道沙箱门与
    // 普通 smoke 完全同一套 —— dev server 也是智能体写的代码，spawn 前同样
    // 要过策略/升级/审批。判定只看探活状态码（R1：子进程无法用 stdout 影响
    // 判定）；无论成败，进程树都会在检查结束时被杀掉（验证道具不留驻）。
    if (check.devServer) {
      let server: ReturnType<typeof spawnImpl>;
      try {
        server = spawnImpl(plan.file, plan.args, {
          cwd: deps.cwd,
          shell: false,
          env: scopedEnv(),
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        });
      } catch (err) {
        results.push({
          kind: "smoke",
          ok: false,
          exitCode: null,
          logDigest: `[smoke] ${check.title}\n命令：${check.command} ${check.args.join(" ")}\nspawn failed (${plan.note}): ${String(err)}`,
          durationMs: Date.now() - startedAt,
        });
        break;
      }
      // dev server 的 stdout 必须被消费：pipe 缓冲写满会阻塞子进程本身。
      // 收集尾部 4KB 用于失败诊断，其余丢弃。
      let tail = "";
      server.stdout?.on("data", (c: Buffer) => {
        tail = `${tail}${c.toString("utf8")}`.slice(-4096);
      });
      server.stderr?.on("data", (c: Buffer) => {
        tail = `${tail}${c.toString("utf8")}`.slice(-4096);
      });
      const verdict = await pollDevServerProcess(
        check.devServer.url,
        server,
        {
          timeoutMs: check.devServer.timeoutMs ?? 30_000,
          fetchImpl: deps.devServerFetch,
        },
      );
      killDevServer(server);
      results.push({
        kind: "smoke",
        ok: verdict.ok,
        exitCode: null,
        logDigest: digest(
          [
            `[smoke] ${check.title}`,
            `命令：${check.command} ${check.args.join(" ")}`,
            `[dev-server] ${check.devServer.url} → ${verdict.detail}（探活 ${verdict.attempts} 次，${verdict.elapsedMs}ms）`,
            verdict.ok ? "进程已按约终止" : `进程已终止；尾部输出：${tail.trim() || "（空）"}`,
          ].join("\n"),
        ),
        durationMs: Date.now() - startedAt,
      });
      if (!verdict.ok) break;
      continue;
    }

    const outcome = await new Promise<SmokeOutcome>((resolve) => {
      let timedOut = false;
      let child: ReturnType<typeof spawnImpl>;
      try {
        child = spawnImpl(plan.file, plan.args, {
          cwd: deps.cwd,
          shell: false,
          // 同 runOnce：冒烟命令也是智能体写的代码，不给它看凭证。
          env: scopedEnv(),
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        });
      } catch (err) {
        resolve({ log: `spawn failed (${plan.note}): ${String(err)}`, exitCode: null, timedOut: false });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        deps.onEvent?.(`[smoke] ${check.title} 超过 ${Math.round(timeoutMs / 1000)}s，终止进程树`);
        killTree(child);
      }, timeoutMs);
      // Same byte budget as runOnce. Note: expect-fragment matching runs
      // against the capped log — a fragment past the budget reads as missing,
      // which is the honest outcome for output that large anyway.
      let log = "";
      let logBytes = 0;
      let droppedBytes = 0;
      const onChunk = (c: Buffer): void => {
        if (logBytes >= MAX_LOG_BYTES) {
          droppedBytes += c.length;
          return;
        }
        logBytes += c.length;
        log += c.toString("utf8");
      };
      const withDroppedMark = (): string => {
        if (droppedBytes === 0) return log;
        return (
          log +
          `\n[沙箱] 输出超过 ${Math.round(MAX_LOG_BYTES / 1024)}KB 预算，已丢弃约 ${Math.round(droppedBytes / 1024)}KB`
        );
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ log: `${log}\nspawn failed: ${String(err)}`, exitCode: null, timedOut });
      });
      // 退出码只从这里来：`close` 是子进程与操作系统之间的直接约定，
      // 子进程无法通过在 stdout 写字影响它（R1）。
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ log: withDroppedMark(), exitCode: timedOut ? null : code, timedOut });
      });
      if (check.stdin !== undefined) child.stdin?.write(check.stdin);
      child.stdin?.end();
    });

    // 判定只看结构化事实：真实退出码 + 期望片段是否出现。
    // 期望片段仍是对输出文本的匹配 —— 但它是**正向**要求（必须出现什么），
    // 子进程无法用"多打印一行"把失败改写成通过，只能靠真的输出正确内容达成。
    const missing = (check.expectContains ?? []).filter((frag) => !outcome.log.includes(frag));
    const ok = !outcome.timedOut && outcome.exitCode === 0 && missing.length === 0;

    const digestParts = [
      `[smoke] ${check.title}`,
      `命令：${check.command} ${check.args.join(" ")}`,
      // 退出码作为**独立的一行事实**随日志留档，方便排障时肉眼核对；
      // 它不参与判定解析（上面已经用过了），所以造假这行没有意义。
      `[exit]${outcome.timedOut ? "timeout" : String(outcome.exitCode)}`,
      outcome.log,
    ];
    if (missing.length > 0) digestParts.push(`缺失期望片段：${JSON.stringify(missing)}`);

    results.push({
      kind: "smoke",
      ok,
      exitCode: outcome.exitCode,
      logDigest: digest(digestParts.join("\n")),
      durationMs: Date.now() - startedAt,
    });
    if (!ok) break;
  }
  return results;
}

