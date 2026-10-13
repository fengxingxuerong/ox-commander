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
