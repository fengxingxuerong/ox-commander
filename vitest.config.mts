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
