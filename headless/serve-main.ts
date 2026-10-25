/**
 * headless 的**常驻服务**入口：`node dist-headless/headless/serve-main.js [--port=8787]`
 *
 * 与 `headless-main.ts` 的关系：那是「一次 spec 进、一串事件出、退出码结束」的
 * 管道形态（适合 CI）；这是「常驻、可被浏览器/CI/远程随时看」的服务形态
 * （HTTP + SSE）。两者共用同一份协议与同一个 `runSpec`，事件语义完全一致 ——
 * 差别只在**宿主怎么接**，不在跑什么。
 *
 * 先看运行时（`runtimeGap`），理由同另一个入口：宿主可能连上就不管了，
 * 那时"跑到一半才崩"会变成"一个永远不给结论的服务"。
 *
 * ⚠️ 默认只绑 **回环**（`127.0.0.1`，2026-10-13 修正）：以前不传 host，Node 绑的是
 * 所有网卡，而启动信息印的是 127.0.0.1 —— 局域网可达却人以为只有本机。要对外
 * 必须显式 `--host=<地址>`，且**非回环 + 无 OX_SERVE_TOKEN 一律拒绝启动**。
 * 无 TLS：远程走 SSH 隧道（默认主张不变）。
 */
import * as fs from "node:fs";
import { parseSpec, runtimeGap, type HeadlessEvent } from "./protocol";
import { runSpec } from "./run-spec";
import { DEFAULT_HOST, isLoopbackHost, serveSetSchedule, startServe } from "./serve";
import {
  busyRetryMs,
  decideStartupCatchup,
  nextDelayMs,
  parseScheduleArgs,
  type ScheduleArgs,
  type ScheduleState,
} from "../shared/schedule-core";
import { readJsonFile, writeFileAtomic } from "../electron/atomic-file";

/**
 * `--port=8787` / `--port 8787` 都认；不给就端口 0（系统分配，启动时打印真实端口）。
 *
 * ⚠️ **不给 ≠ 给错**（2026-10-05 实测修复）：原实现对"没给"和"给了但非法"
 * 返回同一个 `undefined`，于是 `--port=99999`、`--port=abc`、`--ports=8080`
 * （拼错）全部**静默回落**成随机端口，还照常打印
 * `OxCommander serve: http://127.0.0.1:54118/` 并 exit 0。
 *
 * 为什么这条必须报错而不是回落：`serve` 的契约是"我监听在你说的那个端口"。
 * 调用方（CI 脚本、状态页链接、MCP 客户端）拿到一个自己选的随机端口，
 * 之后每一步都连不上 —— 而服务自己看起来一切正常，正是最难查的那类失败。
 * 这与本文件已有的 `runtimeGap` 分支同一处置：拿不准就 exit 1 并说清楚。
 *
 * 不给 `--port` 仍然是合法的（端口 0 = 系统分配，且启动时会打印真实端口），
 * 那是有意的默认，不是错误。
 *
 * 导出只为入口级测试能直接钉住这张表 —— 以前它是文件私有的，于是"参数写错
 * 静默回落"这件事**没有任何东西会发现**（本文件 0% 覆盖）。
 */
export function portFromArgv(argv: string[]): { port?: number; error?: string } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--port(?:=(\d+))?$/.exec(a);
    if (!m) continue;
    const raw = m[1] ?? argv[i + 1];
    const n = Number(raw);
    if (raw === undefined || raw === "" || !Number.isInteger(n)) {
      return { error: `--port 需要一个整数，实际收到：${JSON.stringify(raw)}` };
    }
    if (n < 0 || n > 65535) {
      return { error: `--port 超出范围（0-65535），实际收到：${n}` };
    }
    return { port: n };
  }
  // 顺带把明显的拼写错误也变成错误：静默忽略一个不认识的 --port* 是上一轮的
  // `--serve=` 教训（文档写 --serve-url=，拼错后 MCP 一路连默认端口、不报错）。
  for (const a of argv) {
    if (/^--?port/i.test(a) && !/^--port(?:=(\d+))?$/.test(a)) {
      return { error: `无法识别的端口参数：${JSON.stringify(a)}（正确写法：--port=<0-65535>）` };
    }
  }
  return {};
}

/**
 * `--host=0.0.0.0` / `--host 0.0.0.0` 都认；不给就是回环（`startServe` 的默认）。
 *
 * 与 `portFromArgv` 同一纪律：给了但非法/拼错**当场报错**，不静默回落 ——
 * 地址写错而服务照常起来，意味着"我以为暴露在哪"和"实际暴露在哪"分叉了，
 * 那正是这一轮要修掉的那类失败（打印 127.0.0.1 实际绑全域）。
 *
 * 校验宽松（只挡空白与显然的注入面）：地址形态的最终裁决属于 Node 的 listen，
 * 它给的错误比我们手写的正则更准；这里负责的是"说清楚哪个参数错了"。
 */
export function hostFromArgv(argv: string[]): { host?: string; error?: string } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--host(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const raw = m[1] ?? argv[i + 1];
    if (raw === undefined || raw === "" || /\s/.test(raw)) {
      return { error: `--host 需要一个地址（如 127.0.0.1 / 0.0.0.0），实际收到：${JSON.stringify(raw)}` };
    }
    return { host: raw };
  }
  // 拼写错的 --host* 同样不许静默忽略（`--port` 那条注释里的 `--serve=` 教训）。
  for (const a of argv) {
    if (/^--?host/i.test(a) && !/^--host(?:=(.*))?$/.test(a)) {
      return { error: `无法识别的地址参数：${JSON.stringify(a)}（正确写法：--host=<地址>）` };
    }
  }
  return {};
}

/**
 * 定时环自调用该连哪个地址（纯函数）。
 *
 * 通配地址（`0.0.0.0` / `::`）不是可连的地址，自调用必须换成回环；
 * 绑到某个具体网卡地址时就得连那个地址（此刻回环上没有监听）。
 */
export function selfCallHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host;
}

/**
 * 非回环 + 没 token = 拒绝启动的判据（纯函数，入口与库共用同一句话的来源）。
 * 返回 `undefined` = 可以启动。
 */
export function exposureProblem(host: string, token: string | undefined): string | undefined {
  if (isLoopbackHost(host) || token) return undefined;
  return (
    `拒绝启动：--host=${host} 会让同网络的机器访问到本服务，但没有设置 OX_SERVE_TOKEN。\n` +
    `要么用默认的 --host=127.0.0.1，要么设一个 token 再绑：\n` +
    `  OX_SERVE_TOKEN=<你自己生成的一串随机值> node dist-headless/headless/serve-main.js --host=${host}`
  );
}

/**
 * 把 `run` 的第三个参数（引擎控制口的接收器）转成 `runSpec` 的 `onEngine`。
 *
 * 单独抽出来是为了**能被直接断言**（2026-10-05 接入变异门禁时暴露）：
 * 这一行原先内联在 `main()` 里，而 `main()` 只有当服务真的在跑一个 run 时
 * 才会走到 —— 没有可用 LLM 的机器上那次 run 几百毫秒就结束，
 * `POST /pause` 永远只拿到 409（`serve.ts:406`），于是**端到端根本够不到它**。
 *
 * 硬凑一条端到端测试只能靠真密钥，那在离线 CI 里必然失败 —— 假绿比缺测试更糟。
 * 抽成纯函数后这一行可被逐位点验证，语义一字未改（仍是"有 control 才挂 onEngine"）。
 */
export function onEngineOption(
  control?: (engine: { pause(): void; resume(): void; cancel(): void }) => void,
): { onEngine?: (engine: { pause(): void; resume(): void; cancel(): void }) => void } {
  return control ? { onEngine: control } : {};
}

/**
 * 定时触发时间戳的落盘。账本语义与熔断器持久化同一纪律：**账本是增强不是
 * 权威**——缺文件/损坏按"从未触发"处理（无补跑，等一个间隔），落盘失败
 * 不影响调度（下次触发再试），绝不因为状态文件让定时服务起不来。
 */
export function scheduleStateIo(stateFile?: string): {
  loadState: () => ScheduleState | undefined;
  saveState: (s: ScheduleState) => void;
} {
  if (!stateFile) return { loadState: () => undefined, saveState: () => undefined };
  return {
    loadState: () => {
      try {
        const raw = readJsonFile<unknown>(stateFile, undefined);
        const v = (raw as ScheduleState | undefined)?.lastFiredMs;
        // 形状校验：只认 number。JSON.parse 产出的 number 必然有限
        // （NaN/Infinity 不可序列化），所以不需要 isFinite——写了反而贡献一个
        // 永远杀不死的等价位点（2026-10-11 site 审计实证后删）。
        return typeof v === "number" ? { lastFiredMs: v } : undefined;
      } catch {
        return undefined;
      }
    },
    saveState: (s) => {
      try {
        writeFileAtomic(stateFile, JSON.stringify(s));
      } catch {
        // 落盘失败不影响本次调度；代价只是"重启后可能补跑一次"。
      }
    },
  };
}

export interface ScheduleLoopOptions {
  args: ScheduleArgs;
  /**
   * 每次触发原样自投递的 spec —— **spec 文件的原文**，不是 `parseSpec` 的归一化结果。
   *
   * 2026-10-13 端到端实测为什么这一条必须写死：投归一化结果时，输出里带着派生字段
   * `settings` 与 `warnings`，它们**不是**输入形状，再投回去会被 /run 报成"未知字段已忽略"，
   * 用户写在 spec 里的 settings 于是静默丢掉；而 `agents` 那个派生的空数组当时更直接被
   * 校验判成"manifest 列表为空"，每一次触发都是 400。投原文 = 定时跑的就是你看的那份文件。
   */
  specPayload: string;
  /** startServe 返回的真实端口（--port=0 时是系统分配的那个）。 */
  port: number;
  /**
   * 自调用该连的地址（2026-10-13）。缺省 `127.0.0.1`；宿主用 `selfCallHost`
   * 把通配地址换成回环、把具体网卡地址原样传入 —— 绑到具体地址时回环上没有
   * 监听，写死 127.0.0.1 的定时环会静默每次触发都失败。
   */
  host?: string;
  /** OX_SERVE_TOKEN：自调用也要过鉴权，不能因为是自己人就绕开。 */
  token?: string;
  log: (text: string) => void;
  loadState: () => ScheduleState | undefined;
  saveState: (s: ScheduleState) => void;
  /**
   * 定时可见性（2026-10-25，第一档竞品吸收）：每次排程后把"下一次触发点"写进
   * serve 状态 —— /state、状态页因此可预测（Orca automation 监控的对位）。
   * 注入的是 `serveSetSchedule`；测试不传也不受影响（可见性是增强不是权威，
   * 与 scheduleStateIo 同一纪律）。
   */
  announceSchedule?: (schedule: { everyMs: number; nextFireAt: string; lastFiredAt?: string }) => void;
  /** 以下四项只为测试注入；生产用全局实现。 */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * 定时触发环：到点自 `POST /run`（127.0.0.1 自调用），复用单 run 语义的全部
 * 既有判断——409 = 上一次没跑完 → 本轮跳过且**不计已触发**（时间戳不动，
 * 短重试后若已空闲则正常触发）；2xx = 已接受 → 落盘时间戳；其他失败 → 记日志、
 * 不计已触发，下个重试窗口再试。触发点按"上次触发 + 间隔"推算，漂移自校正。
 */
export function startScheduleLoop(opts: ScheduleLoopOptions): { stop(): void } {
  const now = opts.now ?? Date.now;
  const setTimeoutImpl = opts.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutImpl = opts.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const doFetch =
    opts.fetchImpl ??
    ((url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      fetch(url, init));
  let stopped = false;
  let timer: unknown;
  /** 上一次**被接受**的触发时刻（409 跳过不算 —— 与"跳过不计已触发"同口径）。 */
  let lastAcceptedFiredMs: number | undefined;

  /** 返回 true = 触发被接受（时间戳已落盘）；false = 跳过/失败（时间戳不动）。 */
  const attemptFire = async (): Promise<boolean> => {
    try {
      const res = await doFetch(`http://${opts.host ?? "127.0.0.1"}:${opts.port}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.specPayload,
      });
      if (res.status === 409) {
        opts.log(
          `[schedule] 上一次 run 还没结束，本轮触发跳过（${Math.round(busyRetryMs(opts.args.everyMs) / 1000)}s 后重试）`,
        );
        return false;
      }
      if (res.ok) {
        lastAcceptedFiredMs = now();
        opts.saveState({ lastFiredMs: lastAcceptedFiredMs });
        opts.log(`[schedule] 定时触发：run 已接受（间隔 ${Math.round(opts.args.everyMs / 1000)}s）`);
        return true;
      }
      opts.log(`[schedule] 定时触发失败：POST /run → HTTP ${res.status}（不计已触发，稍后重试）`);
      return false;
    } catch (err) {
      opts.log(`[schedule] 定时触发失败：${(err as Error).message}（不计已触发，稍后重试）`);
      return false;
    }
  };

  const scheduleAt = (atMs: number): void => {
    if (stopped) return;
    timer = setTimeoutImpl(() => void tick(), Math.max(0, atMs - now()));
    // 每次排程重写"下一次触发点"（ISO）：409 重试也会走到这里，所以短重试窗口
    // 的推算同样可见 —— 状态页读到的永远是当下最真的那一个。
    opts.announceSchedule?.({
      everyMs: opts.args.everyMs,
      nextFireAt: new Date(atMs).toISOString(),
      ...(lastAcceptedFiredMs !== undefined ? { lastFiredAt: new Date(lastAcceptedFiredMs).toISOString() } : {}),
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const accepted = await attemptFire();
    const delay = accepted
      ? nextDelayMs({ now: now(), lastFiredMs: opts.loadState()?.lastFiredMs, everyMs: opts.args.everyMs })
      : busyRetryMs(opts.args.everyMs);
    scheduleAt(now() + delay);
  };

  const lastFiredMs = opts.loadState()?.lastFiredMs;
  // 可见性的 lastFiredAt 与补跑判断同一出处：重启后的"上次触发"来自持久账本，
  // 不是空值 —— 否则状态页在重启后会谎称"从未触发过"。
  lastAcceptedFiredMs = lastFiredMs;
  // 启动即广播一次：catchup 的 fetch 在途期间（VPS 重启后第一次自调用可能
  // 要等网络），状态面此刻就该能回答"间隔多少、上次什么时候触发过" ——
  // 下次触发点未知，先以"上次 + 间隔"推算（fetch 收尾后的排程会覆盖它）。
  opts.announceSchedule?.({
    everyMs: opts.args.everyMs,
    nextFireAt: new Date(now() + nextDelayMs({ now: now(), lastFiredMs, everyMs: opts.args.everyMs })).toISOString(),
    ...(lastFiredMs !== undefined ? { lastFiredAt: new Date(lastFiredMs).toISOString() } : {}),
  });
  const catchup = decideStartupCatchup({ now: now(), lastFiredMs, everyMs: opts.args.everyMs });
  if (catchup.fire) {
    opts.log(
      `[schedule] 停机期间错过触发点（上次 ${new Date(lastFiredMs!).toISOString()}），启动补跑一次（至多一次）`,
    );
    void tick();
  } else {
    const delay = nextDelayMs({ now: now(), lastFiredMs, everyMs: opts.args.everyMs });
    opts.log(
      `[schedule] 定时已生效：间隔 ${Math.round(opts.args.everyMs / 1000)}s，首次触发在 ${Math.round(delay / 1000)}s 后` +
        (lastFiredMs === undefined ? "" : `（上次触发 ${new Date(lastFiredMs).toISOString()}）`),
    );
    scheduleAt(now() + delay);
  }

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeoutImpl(timer);
    },
  };
}

async function main(): Promise<void> {
  const gap = runtimeGap({
    nodeVersion: process.versions.node,
    hasAbortSignalAny: typeof AbortSignal.any === "function",
  });
  if (gap) {
    process.stderr.write(`${gap}\n`);
    process.exitCode = 1;
    return;
  }
  const parsedArgv = portFromArgv(process.argv.slice(2));
  if (parsedArgv.error) {
    process.stderr.write(`${parsedArgv.error}\n`);
    process.exitCode = 1;
    return;
  }
  const parsedHost = hostFromArgv(process.argv.slice(2));
  if (parsedHost.error) {
    process.stderr.write(`${parsedHost.error}\n`);
    process.exitCode = 1;
    return;
  }
  // 绑定地址的 fail-closed 判据：非回环 = 暴露面，没有 token 就不许起。
  // `startServe` 里还有同一道守卫（库入口那道），这里先拦是为了给出一句
  // 人类可读的启动错误，而不是让异常以栈的形式掉出来。
  const token = process.env.OX_SERVE_TOKEN;
  const problem = exposureProblem(parsedHost.host ?? DEFAULT_HOST, token);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }
  // 定时参数（2026-10-11，Orca scheduled automations 对位）：与 --port 同一纪律，
  // 拼写错误/缺对/间隔过小都当场报错，而不是静默当"没配定时"。
  const schedule = parseScheduleArgs(process.argv.slice(2));
  if (schedule.error) {
    process.stderr.write(`${schedule.error}\n`);
    process.exitCode = 1;
    return;
  }
  // 定时 spec 启动即读取并预校验：带着坏 spec 起来的定时服务，最坏的不是
  // "起不来"，而是"看起来正常、每次触发都 400"。fail fast，说出同一句话。
  let scheduledSpecRaw = "";
  if (schedule.schedule) {
    let raw: string;
    try {
      raw = fs.readFileSync(schedule.schedule.specFile, "utf8");
    } catch (err) {
      process.stderr.write(`--spec 读取失败：${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    const parsed = parseSpec(raw);
    if (!parsed.ok) {
      process.stderr.write(`--spec 校验失败：${parsed.message}\n`);
      process.exitCode = 1;
      return;
    }
    // 预校验只取"错在哪"；投递用的是**原文**（理由见 specPayload 的注释）。
    scheduledSpecRaw = raw;
  }
  const srv = await startServe({
    ...(parsedArgv.port !== undefined ? { port: parsedArgv.port } : {}),
    // host 不注入时由 startServe 落到回环默认（单一真源在 serve.ts）。
    ...(parsedHost.host !== undefined ? { host: parsedHost.host } : {}),
    // 同一个 parseSpec 同时服务两个宿主：这里只取"错在哪"，spec 本身仍由 run
    // 重新解析一次 —— 让 /run 的 400 与 CLI 的 exit 1 说出**同一句话**。
    validate: (payload) => {
      const parsed = parseSpec(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}));
      return parsed.ok ? undefined : parsed.message;
    },
    run: async (
      payload: unknown,
      emit: (e: HeadlessEvent) => void,
      control?: (engine: { pause(): void; resume(): void; cancel(): void }) => void,
    ): Promise<number> => {
      const parsed = parseSpec(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}));
      if (!parsed.ok) {
        emit({ type: "error", message: parsed.message });
        return 1;
      }
      return runSpec(parsed.spec, {
        emit,
        // 引擎交给服务：POST /pause / POST /resume 才能真的影响这次 run（P1-5）。
        ...onEngineOption(control),
        // 审批（P2-3）：服务广播 approval-request 事件，POST /approve 作答。
        // 命令命中 approvalCommands 时不再"问不到人就拒绝" —— 有人（状态页/
        // MCP 客户端）真的能回答了。
        requestApproval: srv.approvalRequester,
        // 活性心跳：每条 agent 事件广播一次 task-activity，UI 可显示"静默 Xs"。
        onTaskActivity: (taskId, at) => emit({ type: "task-activity", taskId, at }),
      });
    },
  });
  // 打印**真实的绑定地址**（srv.host），不是常量 —— 这一行以前永远写 127.0.0.1，
  // 而实际绑的是所有网卡；"印出来的就是绑到的"是这轮修的事（2026-10-13）。
  const exposure = isLoopbackHost(srv.host)
    ? ""
    : `\n⚠️ 已绑定 ${srv.host}：同网络的机器可达（已启用 Bearer 鉴权，token 来自 OX_SERVE_TOKEN）。` +
      (srv.host === "0.0.0.0" || srv.host === "::" ? `本机可直接用 http://127.0.0.1:${srv.port}/` : "");
  process.stdout.write(
    `OxCommander serve: http://${srv.host}:${srv.port}/ （/state 看状态，/events 订阅事件流，POST /run 投递 spec，POST /pause · /resume 暂停继续）${exposure}\n`,
  );
  if (schedule.schedule) {
    const io = scheduleStateIo(schedule.schedule.stateFile);
    startScheduleLoop({
      args: schedule.schedule,
      specPayload: scheduledSpecRaw,
      port: srv.port,
      // 自调用地址跟着绑定地址走（通配换成回环；具体网卡地址原样）——
      // 写死 127.0.0.1 时，绑到具体地址的部署会让定时环每次触发都连不上。
      host: selfCallHost(srv.host),
      // 无条件透传：token 缺席就是 undefined，调度环对它自己兜底（不带头）。
      token: process.env.OX_SERVE_TOKEN,
      log: (text) => process.stdout.write(`${text}\n`),
      // 定时可见性（2026-10-25）：每次排程把下一次触发点写进 /state 与状态页 ——
      // VPS 场景没有终端可翻日志，"下次什么时候跑"从状态面就能回答。
      announceSchedule: (s) => serveSetSchedule(srv.state, s),
      ...io,
    });
    process.stdout.write(
      `[schedule] 定时已配置：间隔 ${Math.round(schedule.schedule.everyMs / 1000)}s · spec=${schedule.schedule.specFile} · 下次触发点见 /state 的 schedule 字段\n`,
    );
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void srv.close().then(() => process.exit(0));
    });
  }
}

// 只有被当入口直接跑时才启动服务：入口级测试要 import 本模块来钉住
// portFromArgv 的行为（见该函数注释），无条件执行 main() 会让测试真的开端口。
if (require.main === module) void main();
