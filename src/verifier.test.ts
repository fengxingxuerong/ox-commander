/**
 * runSmokeChecks 直接单测：用注入的 fake spawn 覆盖边界分支
 * （沙箱拒 / 缺失期望片段 / stdin 传递 / 非零退出 / 超时 / 空期望只看退出码）。
 * 这一段全部确定性，不真实 spawn 任何进程。
 *
 * ⚠️ 末尾「stdin 送达」那一组**必须真 spawn**，是这个文件的例外（2026-10-09）：
 * fake 的 stdin 是一块内存 Writable，写完就回调，**永远不会**在子进程退出之后
 * 补一条 write error —— 于是"样例压在父进程缓冲里、子进程不看管道输入就退出"
 * 这条真实路径在这里全绿，而生产上它会以未处理的 error 打死宿主进程。
 * 这正是"只测被调函数、入口却是坏的"那一类：替身替掉的那一步就是缺陷藏身的地方。
 */
import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSmokeChecks } from "../electron/engine/verifier";
import type { SmokeCheck } from "../shared/types";

interface FakeBehavior {
  out?: string;
  code?: number;
  err?: string;
  /** close 延迟（毫秒）；undefined = 立即，null = 永不（配合超时测用 60ms 场景） */
  closeDelay?: number | null;
  onStdin?: (chunk: string) => void;
  /**
   * 写回调永不归宿（`_write` 不调 `cb`）。真实 Node 迟早会给个结果，这一档
   * 替身建模的是"结果还没来而超时先到"——收口的两个出口之一只能这么造。
   */
  stdinStall?: boolean;
  /** 拿到真正传给 spawn 的 env —— 断言"子进程看不到凭证"要用它，不能只测 scopedEnv 纯函数。 */
  onSpawn?: (env: NodeJS.ProcessEnv | undefined) => void;
}

interface FakeChild {
  pid: number;
  exitCode: number | null;
  kill: () => boolean;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  on: (ev: string, fn: (...a: unknown[]) => void) => FakeChild;
  emit: (ev: string, ...args: unknown[]) => void;
}

function fakeSpawnImpl(b: FakeBehavior) {
  return (
    _file?: string,
    _args?: readonly string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ): FakeChild => {
    b.onSpawn?.(opts?.env);
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const child: FakeChild = {
      pid: 99999,
      exitCode: null,
      kill: () => true,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk, _enc, cb) {
          b.onStdin?.(String(chunk));
          // ⚠️ 真实 pipe 的写要等冲出去才回调，所以"回调还没来"是一种合法状态；
          // 建模它就必须**不**调 cb —— 否则替身永远比生产快一步收口。
          if (!b.stdinStall) cb();
        },
      }),
      on(ev, fn) {
        (listeners[ev] ??= []).push(fn);
        return child;
      },
      emit(ev, ...args) {
        for (const fn of listeners[ev] ?? []) fn(...args);
      },
    };
    queueMicrotask(() => {
      if (b.err) {
        child.emit("error", new Error(b.err));
        return;
      }
      if (b.out !== undefined) {
        // ⚠️ 必须按真实 pipe 粒度**分块**投递，不能一次 `write(整串)`。
        // `PassThrough.write(huge)` 会把整串塞进 readableLength，`data` 只触发
        // 一次且 chunk 就是全部内容 —— 而生产代码的字节预算是**块粒度**判定
        // （`if (logBytes >= MAX_LOG_BYTES) 丢弃`），单块超大输入必然整套漏掉，
        // 让"超预算丢弃"这条路径在测试里永远不可达（实测：一次 write
        // 2.09MiB → 单次 data、dropped 恒为 0）。
        // 真实子进程经 OS pipe（~64KB）分块到达，分块才是忠实的替身。
        const CHUNK = 256 * 1024;
        const out = b.out;
        for (let i = 0; i < out.length; i += CHUNK) {
          (child.stdout as PassThrough).write(out.slice(i, i + CHUNK));
        }
      }
      const finish = () => {
        child.exitCode = b.code ?? 0;
        child.emit("close", child.exitCode);
        (child.stdout as PassThrough).end();
        (child.stderr as PassThrough).end();
      };
      if (b.closeDelay === null) return;
      if (b.closeDelay) setTimeout(finish, b.closeDelay);
      else finish();
    });
    return child;
  };
}

function check(over: Partial<SmokeCheck>): SmokeCheck {
  return { title: "t", command: "node", args: ["run.js"], ...over };
}

describe("runSmokeChecks", () => {
  it("沙箱门拒绝内联求值命令（node -e 视为后门）", async () => {
    const results = await runSmokeChecks([check({ command: "node", args: ["-e", "x"] })], {
      cwd: ".",
      spawnImpl: fakeSpawnImpl({ out: "x" }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.logDigest).toMatch(/沙箱/);
    // 失败类别（P2-3）：拒绝执行 ≠ 命令真实失败 —— 重修循环要据此区分
    expect(results[0]!.errorClass).toBe("sandbox-denied");
  });

  it("审批拒绝带 approval-denied 失败类别（不是项目本来就坏）", async () => {
    const results = await runSmokeChecks([check({ command: "node", args: ["run.js"] })], {
      cwd: ".",
      approvalGate: {
        active: true,
        check: async () => ({ ok: false, reason: "命令需要人工确认，但当前无审批回调可用，按拒绝处理" }),
      } as never,
      spawnImpl: fakeSpawnImpl({ out: "x" }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.errorClass).toBe("approval-denied");
  });

  it("冒烟子进程拿到的是最小化环境，不含任何凭证形状变量", async () => {
    process.env.OX_SMOKE_CANARY_SECRET = "canary";
    try {
      let seen: NodeJS.ProcessEnv | undefined;
      const results = await runSmokeChecks([check({ expectContains: [] })], {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: "", onSpawn: (env) => (seen = env) }) as never,
      });
      expect(results[0]!.ok).toBe(true);
      expect(seen, "未显式传 env ⇒ 子进程继承宿主全部凭证").toBeDefined();
      expect(Object.keys(seen!).filter((k) => /SECRET|TOKEN|API_KEY|PASSWORD/i.test(k))).toEqual([]);
      expect(seen!.PATH).toBeTruthy();
    } finally {
      delete process.env.OX_SMOKE_CANARY_SECRET;
    }
  });

  it("stdout 缺失期望片段 → 判定失败并注明缺失项", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["EXPECTED"] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "hello world" }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    // 进程本身退出码 0（运行成功），契约判定失败来自期望片段缺失
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.logDigest).toMatch(/缺失期望片段/);
    expect(results[0]!.logDigest).toContain("EXPECTED");
  });

  it("输出包含全部期望片段 → 通过", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["col0", "type="] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "col0: type=string total=5" }) as never },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBe(0);
  });

  it("空期望列表 → 只看退出码", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "anything", code: 0 }) as never },
    );
    expect(results[0]!.ok).toBe(true);
  });

  it("非零退出码 → 失败", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "", code: 2 }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBe(2);
    // 非超时分支：digest 里那一行必须是真实退出码，不能写成 timeout
    // （与上一条 timeout 用例合起来把三分支两两分开）。
    expect(results[0]!.logDigest).toContain("[exit]2");
  });

  it("stdin 样例数据被完整传入子进程", async () => {
    let received = "";
    const results = await runSmokeChecks(
      [check({ stdin: "name,age\n张三,28\n", expectContains: [] })],
      {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: "", onStdin: (c) => (received += c) }) as never,
      },
    );
    expect(results[0]!.ok).toBe(true);
    expect(received).toBe("name,age\n张三,28\n");
  });

  it("spawn 报错 → 失败并携带错误信息", async () => {
    const results = await runSmokeChecks(
      [check({})],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ err: "boom" }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.logDigest).toMatch(/boom/);
  });

  it("超时 → 终止进程树并判失败（close 晚于超时窗口）", async () => {
    const events: string[] = [];
    const results = await runSmokeChecks([check({})], {
      cwd: ".",
      timeoutMs: 40,
      onEvent: (t) => events.push(t),
      spawnImpl: fakeSpawnImpl({ out: "", closeDelay: 60 }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(40);
    expect(events.some((t) => t.includes("超过") && t.includes("终止进程树"))).toBe(true);
    // 超时行必须如实写成 timeout，不能写成退出码（超时时根本没有退出码）。
    // 这是 digest 里给人排障看的那一行事实。
    expect(results[0]!.logDigest).toContain("[exit]timeout");
  });

  it("首败即停：多条冒烟中第一条失败后不再执行后续", async () => {
    let calls = 0;
    const spawnImpl = (() => {
      calls += 1;
      return fakeSpawnImpl({ out: "x" })();
    }) as never;
    const results = await runSmokeChecks(
      [check({ expectContains: ["NO"] }), check({ expectContains: ["y"] })],
      { cwd: ".", spawnImpl },
    );
    expect(calls).toBe(1); // 第二条冒烟未执行
    expect(results.length).toBe(1);
  });

  /**
   * R1「判据必须独立于被判定方」的回归钉。
   *
   * 旧实现把退出码编码进输出串（`${log}\n[exit]${code}`）再用
   * `/\n\[exit\](\d+)/` **取第一个匹配**解析回来。于是子进程只要在自己的
   * stdout 里打印一行 `[exit]0`，真实退出码即便是 1，判定也会读到那个更早出现
   * 的"0"并判**通过** —— 被判定方一行打印就撤销了自己的失败。
   *
   * 现在退出码只来自 `close` 事件（它与 OS 之间的直接约定，子进程写不到），
   * 输出文本只用于**正向**的期望片段匹配。这条用例锁住这个语义：
   * 伪造的退出码标记不得影响判定。
   */
  it("子进程伪造 [exit]0 也改不了判定：真实退出码非零必须判失败（R1）", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      {
        cwd: ".",
        // 真实退出码 1，但在 stdout 里抢先打印一行形如退出码标记的文本
        spawnImpl: fakeSpawnImpl({ out: "BOOM: 我失败了\n[exit]0\n", code: 1 }) as never,
      },
    );
    expect(results[0]!.ok).toBe(false); // 伪造无效
    expect(results[0]!.exitCode).toBe(1); // 如实上报真实退出码
  });

  it("子进程伪造 [exit]0 且退出码为 0 时才算通过（正向条件仍须真达成）", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["EXPECTED"] })],
      {
        cwd: ".",
        // 退出码 0，但期望片段缺失 —— 打印退出码标记不能顶替真实产出
        spawnImpl: fakeSpawnImpl({ out: "[exit]0\n", code: 0 }) as never,
      },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.logDigest).toMatch(/缺失期望片段/);
  });
});

describe("输出字节预算（P2-4）", () => {
  it("超预算的输出被丢弃并注明，而不是无限累积", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: [] })],
      { cwd: ".", spawnImpl: fakeSpawnImpl({ out: "x".repeat(6 * 1024 * 1024), code: 0 }) as never },
    );
    // 截断只影响日志，不改变退出码判定
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBe(0);
    // ⚠️ 不要断言 logDigest 含「输出超过」：digest() 只保留首尾各 2000 字符，
    // 中间被 `...[truncated]...` 顶掉。截断标注恰好落在中段 —— 6MiB 输出时
    // 它前面有 2MiB 的 `x`，后面只剩 `[exit]0`，首尾各取 2000 都取不到它，
    // 正则一律匹配不上，测试必然假红。要验这条备注必须走**未截断的原始 output**：
    // 让超额量小于 digest 的 maxLen（4000），首尾窗口即可覆盖全串。
    const small = await runSmokeChecks(
      [check({ expectContains: [] })],
      {
        cwd: ".",
        // 超出 2MiB 帽 100KB → 丢 98KB（余量不足 1KB 时 Math.round 会给 0）
        spawnImpl: fakeSpawnImpl({ out: "x".repeat(2 * 1024 * 1024 + 100_000), code: 0 }) as never,
      },
    );
    const note = small[0]!.logDigest.match(/输出超过 (\d+)KB 预算，已丢弃约 (\d+)KB/);
    expect(note).not.toBeNull();
    // 帽值如实引用 MAX_LOG_BYTES，不是硬编码在提示语里的另一个数
    expect(Number(note![1])).toBe(2048);
    // 丢弃量如实上报（累计被截掉的字节），不是占位 0
    expect(Number(note![2])).toBe(98);
  });

  it("帽内头部保留：期望片段在头部仍能命中", async () => {
    const results = await runSmokeChecks(
      [check({ expectContains: ["HEAD-MARK"] })],
      {
        cwd: ".",
        spawnImpl: fakeSpawnImpl({ out: `HEAD-MARK\n${"x".repeat(6 * 1024 * 1024)}`, code: 0 }) as never,
      },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.logDigest).toContain("HEAD-MARK");
  });
});

/**
 * stdin 样例的送达（2026-10-09 补，缺陷来自真实链路而非推理）。
 *
 * 生产代码把样例一次性 `write` 进子进程就 `end`，从不监听 stdin 的 error。
 * 样例超过 OS 管道缓冲（本机实测 64KB 这一线，超过就有一截留在父进程里）而
 * 子进程不读管道输入就退出时，那条挂起的写会以 error 事件落在 stdin 流上 ——
 * **没有监听器，Node 就把它抛成未处理的 error 事件，宿主进程当场退出**：
 * 桌面端整个应用没了，headless 编排断在半路、连交付凭据都不写。
 *
 * 本机四种形状各跑十次的复现率：子进程不读 stdin（立即退出）与（活 300ms 再退）
 * 各 10/10，64KB 载荷 0/10，**会读 stdin 的对照组 0/10** —— 最后这条是关键：
 * 触发条件不是"载荷大"，而是"样例压根没被消费"。而"交付物不看管道输入"
 * 恰是冒烟最常见的死法，所以这一条既易触发又难归因（表现为应用无故退出）。
 *
 * ⚠️ 本组钉住的范围是"写坏了要接住、且要计入判定"。样例小于一块内核缓冲时
 * 写完即成功，压根不读管道的交付物照样退 0 报绿 —— 那一次假绿不在这里的判据
 * 范围内：要判"吃没吃"得子进程自己回执，那不是验证器能替它承诺的事。
 */
describe("runSmokeChecks · stdin 送达（真 spawn，fake 替不掉的那一步）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-stdin-"));
  // 压根不碰 stdin 就退出的交付物
  const ignoreScript = path.join(tmp, "ignore.js");
  fs.writeFileSync(ignoreScript, "process.exit(0);\n", "utf8");
  // 对照组：把样例读到底再报数
  const readScript = path.join(tmp, "read.js");
  fs.writeFileSync(
    readScript,
    'let n = 0;\nprocess.stdin.on("data", (c) => {\n  n += c.length;\n});\nprocess.stdin.on("end", () => {\n  console.log("READ " + n);\n});\n',
    "utf8",
  );
  // 1MB：远超 Windows 与 Linux 两侧的管道缓冲，不靠某一档实测阈值取边界值
  const bigSample = "a".repeat(1024 * 1024);

  it("子进程不看管道输入就退出：error 必须被接住，且这一格判失败", async () => {
    const uncaught: string[] = [];
    const record = (err: Error): void => {
      uncaught.push(String(err));
    };
    process.on("uncaughtException", record);
    try {
      const results = await runSmokeChecks(
        [check({ command: process.execPath, args: [ignoreScript], stdin: bigSample, expectContains: [] })],
        { cwd: tmp, timeoutMs: 15_000 },
      );
      // 摘掉监听器 ⇒ 这里收到 write EOF ⇒ 生产上进程已经没了
      expect(uncaught, `未处理的 stdin error 会打死宿主进程：${uncaught.join("; ")}`).toEqual([]);
      expect(results).toHaveLength(1);
      // 退出码确实是 0（交付物自己退得干干净净）。这一格必须因为"样例没交进去"
      // 而判失败 —— 只挂着监听器不记入判定，等于"应用不崩了，但冒烟报的是假绿"。
      expect(results[0]!.exitCode).toBe(0);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.logDigest).toContain("样例数据写入失败");
    } finally {
      process.removeListener("uncaughtException", record);
    }
  }, 30_000);

  it("子进程真把 1MB 样例读到底：判过，且 digest 带得上消费字节数", async () => {
    const results = await runSmokeChecks(
      [check({ command: process.execPath, args: [readScript], stdin: bigSample, expectContains: [] })],
      { cwd: tmp, timeoutMs: 15_000 },
    );
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.logDigest).toContain(`READ ${bigSample.length}`);
  }, 30_000);

  it("写回调迟迟不归宿时，超时那一下必须自己收口（判定不得挂在 stdin 上）", async () => {
    // 这条回到 fake：要建模的正是"回调还没来"，真 spawn 造不出这一档且也不必 ——
    // 它守的是收口的另一半：万一写永不归宿，代价应是一次超时，而不是一次永久挂起。
    const results = await runSmokeChecks([check({ stdin: "sample", expectContains: [] })], {
      cwd: ".",
      timeoutMs: 40,
      spawnImpl: fakeSpawnImpl({ out: "", code: 0, closeDelay: 10, stdinStall: true }) as never,
    });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.logDigest).toContain("[exit]timeout");
  }, 5_000);
});
