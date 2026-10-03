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

/** `--port=8787` / `--port 8787` 都认；不给就端口 0（系统分配，启动时打印真实端口）。 */
function portFromArgv(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const m = /^--port(?:=(\d+))?$/.exec(a);
    if (!m) continue;
    const raw = m[1] ?? argv[i + 1];
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
  }
  return undefined;
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
  const port = portFromArgv(process.argv.slice(2));
  const srv = await startServe({
    ...(port !== undefined ? { port } : {}),
    run: async (
      payload: unknown,
      emit: (e: HeadlessEvent) => void,
      control?: (engine: { pause(): void; resume(): void }) => void,
    ): Promise<number> => {
      const parsed = parseSpec(typeof payload === "string" ? payload : JSON.stringify(payload ?? {}));
      if (!parsed.ok) {
        emit({ type: "error", message: parsed.message });
        return 1;
      }
      return runSpec(parsed.spec, {
        emit,
        // 引擎交给服务：POST /pause / POST /resume 才能真的影响这次 run（P1-5）。
        ...(control ? { onEngine: control } : {}),
        // 审批（P2-3）：服务广播 approval-request 事件，POST /approve 作答。
        // 命令命中 approvalCommands 时不再"问不到人就拒绝" —— 有人（状态页/
        // MCP 客户端）真的能回答了。
        requestApproval: srv.approvalRequester,
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

void main();
