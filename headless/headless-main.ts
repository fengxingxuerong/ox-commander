/**
 * OxCommander headless entry —— 无 UI 入口，供外部宿主（DSH 等智能体）以子进程驱动。
 *
 * 这一层只做 IO 胶水：读 stdin → 解析成 ParsedSpec → 交给 runSpec → 设退出码。
 * 协议定义在 `protocol.ts`（契约 + 校验 + 默认值），执行在 `run-spec.ts`（可注入、可测）。
 * 完整字段表与事件表见 `docs/headless-protocol.md`。
 *
 *  - stdin：完整读入后按 JSON 解析（spec）
 *  - stdout：JSONL 事件流，每行一个 JSON 对象
 *  - 退出码：0 = 交付成功；2 = 重修轮耗尽仍未通过验证；1 = 致命错误（输入非法 / LLM 不可用）
 *
 * 环境变量：SENSENOVA_API_KEY(+_2/_3) 提供执行器密钥；切换 llmProvider 时读取对应 *_API_KEY。
 */
import { PROTOCOL_VERSION, parseSpec, type HeadlessEvent } from "./protocol";
import { runSpec } from "./run-spec";

function emit(evt: HeadlessEvent): void {
  process.stdout.write(`${JSON.stringify(evt)}\n`);
}

/**
 * 中断处理。此前这个进程**没有任何 signal 处理器**：Ctrl-C 之后宿主只拿到被截断的
 * JSONL（没有终态事件），而中断留下的备份目录永远没人回收。
 *
 * 这里刻意不删备份：被中断的那一批可能正处在"越界文件已经写了、还没仲裁"的状态，
 * 那份备份是人工恢复现场的唯一材料。回收是下一次运行启动时的事
 * （`run-spec.ts` 的 `pruneStaleBackups`：只认 `batch-*` 且超过保留期的目录）。
 */
function installInterruptHandlers(snapshotRoot: string): void {
  let seen = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (seen) {
        // 第二下：别再等了，直接走。
        process.exit(1);
      }
      seen = true;
      emit({
        type: "error",
        message:
          `收到 ${sig}，运行被中断。工作区可能停在未仲裁的一批上；` +
          `本次的快照备份保留在 ${snapshotRoot} 下（由下一次运行回收）。`,
      });
      // 不 process.exit()：让 stdout 刷出去，也给在飞的仲裁一次落盘机会。
      process.exitCode = 1;
    });
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (raw += c));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("close", () => resolve(raw));
  });
}

async function main(): Promise<number> {
  const parsed = parseSpec(await readStdin());
  if (!parsed.ok) {
    emit({ type: "error", message: parsed.message });
    return 1;
  }
  installInterruptHandlers(parsed.spec.snapshotRoot);
  return runSpec(parsed.spec, { emit });
}

// 用 exitCode（而非 process.exit）让 stdout 缓冲自然刷出，避免 JSONL 截断。
void main().then((code: number) => {
  process.exitCode = code;
});

export { PROTOCOL_VERSION };
