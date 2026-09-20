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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "shared/**/*.test.ts", "electron/**/*.test.ts"],
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
