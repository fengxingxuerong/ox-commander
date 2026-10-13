import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `require("electron")` from vitest returns the *path to the binary*
      // (node_modules/electron/index.js does `module.exports = getElectronPath()`),
      // so any main-process module imported in a test sees `ipcMain === undefined`.
      // Point it at a controllable fake instead; tests that need it drive the
      // behaviour via vi.mock("electron", ...).
      electron: path.resolve(import.meta.dirname, "src/__fakes__/electron.ts"),
    },
  },
  test: {
    // 2026-10-13：默认 5s → 20s。CI 的 site 全量审计用 --jobs=3 在 2 vCPU 上跑，
    // 重集成文件（orchestrator / gateway / import / receipt-verify 那一档）在互撞下
    // 超过 5s 被判"基线失败"，mutation-check 的 fail-safe 再串行复核一遍 = 双倍
    // 耗时，今天把 site job 顶破了 60 分钟超时（4 连 cancelled）。给足余量后，
    // 重文件在并行下不再假红，串行复核链消失，总时长回落。
    testTimeout: 20_000,
    /*
     * 2026-10-13：默认 10s → 60s。与上面 `testTimeout` 同源的病，但落在不同位置：
     * 本机全量 67 个测试文件并行时，一堆文件的 `afterEach`/`afterAll` 要删自己造的
     * 临时目录，实测撞破 10s 预算报 `Hook timed out in 10000ms` —— 而**单独跑那
     * 个文件 466ms 就全绿**。红的不是判据，是"清盘没赶上"。
     *
     * 关键：这些 hook 里**只有清盘**、没有一条断言，所以放长预算不会削弱任何判据，
     * 只是不再让"卫生问题"有能力掐断链条（`verify` 是 `&&` 串联，首段失败即中断，
     * 一次 flake 会让后面 14 段一次都跑不到）。它也不是某一个文件的问题：本机连着
     * 三次全量分别红在 policy-dir / store / atomic-store / main-wiring 四个不同文件，
     * 逐个文件改 = 打地鼠，所以在这里一次性放开。
     */
    hookTimeout: 60_000,
    // `headless/**` 的源码在 coverage.include 里（第 21 行），所以这里的 include 必须同步含它：
    // 否则往 headless/ 下加测试文件会「不执行但计入覆盖率」。由 check-tests-collected.mjs 守着。
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "shared/**/*.test.ts",
      "electron/**/*.test.ts",
      "headless/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "dist-electron"],
    coverage: {
      provider: "v8",
      // 只统计手写源码；构建产物与入口胶水不计入
      include: ["src/**", "shared/**", "electron/**", "headless/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/main.tsx",
        "src/__fakes__/**",
        "dist/**",
        "dist-electron/**",
        "dist-headless/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "text-summary"],
    },
  },
});
