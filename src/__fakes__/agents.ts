import type { AgentAdapter } from "../../shared/types";
import type { AgentCapabilities } from "../../shared/agent-contract";

/**
 * 测试用的最小智能体替身。
 *
 * 它放在 `src/__fakes__/` 而不是留在某个 `.test.ts` 里，是因为此前
 * `router.test.ts` 直接 `import { fakeAgent } from "./agent-registry.test"` ——
 * 把一个测试文件当模块导入会**连带执行它的 describe/it**，于是同一批用例被注册两次：
 * vitest 报给 `router.test.ts` 的行数是 40 还是 45 取决于 worker 有没有复用到那份模块缓存
 * （2026-09-25 实测两个数都出现过），而套件总数也跟着虚报。
 */
export function fakeAgent(id: string, declared?: AgentCapabilities): AgentAdapter {
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
  return declared ? (Object.assign(base, { capabilities: () => declared }) as AgentAdapter) : base;
}
