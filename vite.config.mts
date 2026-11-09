import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", target: "es2020", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  test: {
    // 本机 `os.cpus()` 报 20 核（i7-10750H 实为 6 核 12 线程），vitest 默认开 19 个 worker；
    // 每个 worker 还会 spawn 真子进程（git / node / 执行器 fixture），叠加 WorkBuddy 注入的
    // node 预载 shim，16 GB 的机器上会打穿 Windows 的提交限额。症状完全不像资源问题：
    // `spawn UNKNOWN`、`0xC0000142`、子进程莫名退出、用例 20 s 超时，最后
    // `FATAL ERROR: Committing semi space failed`（申请 9 MB 都失败）。
    //
    // 上限压到 4（2026-11-09 实测：默认并发 8 红，4 并发全绿 79 s —— 默认并发反而更慢，
    // 因为一直在换页）。CI 的 runner 是 4 核，本来也只开 3 个 worker，不受影响。
    maxWorkers: 4,
  },
});
