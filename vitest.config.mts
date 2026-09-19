import { defineConfig } from "vitest/config";

export default defineConfig({
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
        "dist/**",
        "dist-electron/**",
        "dist-headless/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "text-summary"],
    },
  },
});
