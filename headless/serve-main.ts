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
 * ⚠️ 无鉴权、无 TLS：这是本机 / 内网 / SSH 隧道后的观察面，不是公网服务。
 */
import { parseSpec, runtimeGap, type HeadlessEvent } from "./protocol";
import { runSpec } from "./run-spec";
import { startServe } from "./serve";

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
  const srv = await startServe({
    ...(parsedArgv.port !== undefined ? { port: parsedArgv.port } : {}),
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
  process.stdout.write(
    `OxCommander serve: http://127.0.0.1:${srv.port}/ （/state 看状态，/events 订阅事件流，POST /run 投递 spec，POST /pause · /resume 暂停继续）\n`,
  );
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void srv.close().then(() => process.exit(0));
    });
  }
}

// 只有被当入口直接跑时才启动服务：入口级测试要 import 本模块来钉住
// portFromArgv 的行为（见该函数注释），无条件执行 main() 会让测试真的开端口。
if (require.main === module) void main();
