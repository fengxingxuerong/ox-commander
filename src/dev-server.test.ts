/**
 * dev server 托管检查（竞品 5.4）的测试：
 *  · probeVerdictOf / pollDevServer —— 纯函数真值表（假 fetch + 注入时钟，零联网零真等）；
 *  · pollDevServerProcess —— 真子进程的退出守卫；
 *  · runSmokeChecks 的 devServer 分支 —— 真子进程 + 真 HTTP 的集成
 *   （项目惯例：HTTP 层断言真实字节；子进程用 node 跑临时脚本，Windows 上
 *    taskkill 树杀对真进程才是正确行为）。
 */
import { afterAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  killDevServer,
  pollDevServer,
  pollDevServerProcess,
  probeVerdictOf,
  type PollResult,
} from "../electron/engine/dev-server";
import { runSmokeChecks } from "../electron/engine/verifier";

const servers: Array<{ close: () => Promise<void> }> = [];

afterAll(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

/** 起一个本地 HTTP 端点，返回其 URL（端口 0 = 系统分配）。 */
function startEndpoint(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

describe("probeVerdictOf：2xx/3xx 算活，其余全死", () => {
  it.each([200, 204, 301, 308, 399])("HTTP %i → alive", (status) => {
    expect(probeVerdictOf(status)).toBe("alive");
  });
  it.each([199, 400, 404, 500, 503])("HTTP %i → dead", (status) => {
    expect(probeVerdictOf(status)).toBe("dead");
  });
});

describe("pollDevServer：纯轮询（假 fetch + 注入时钟）", () => {
  const noopSleep = async () => {};

  it("前几次死、后来活：ok=true，attempts 记录真实次数", async () => {
    let t = 0;
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      t += 40; // 每次探活"耗时"40ms
      if (n < 3) throw new Error("ECONNREFUSED");
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    const r = await pollDevServer("http://x/", { fetchImpl, sleep: noopSleep, now: () => t, timeoutMs: 1_000, intervalMs: 50 });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.detail).toBe("HTTP 200");
  });

  it("一直 5xx 到超时：ok=false，detail 带最后一次死因", async () => {
    let t = 0;
    const fetchImpl = (async () => {
      t += 40;
      return { status: 503 } as Response;
    }) as unknown as typeof fetch;
    const r = await pollDevServer("http://x/", { fetchImpl, sleep: noopSleep, now: () => t, timeoutMs: 200, intervalMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("超时");
    expect(r.detail).toContain("503");
  });

  it("404 是死：探活路径配错的 dev server 不该被当成起来了", async () => {
    let t = 0;
    const fetchImpl = (async () => {
      t += 40;
      return { status: 404 } as Response;
    }) as unknown as typeof fetch;
    const r = await pollDevServer("http://x/", { fetchImpl, sleep: noopSleep, now: () => t, timeoutMs: 120, intervalMs: 50 });
    expect(r.ok).toBe(false);
  });
});

describe("pollDevServerProcess：真子进程的退出守卫", () => {
  it("进程活着且端点 200：探活成功，进程留给调用方处置", async () => {
    const url = await startEndpoint((_q, res) => res.end("ok"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 50)"], { stdio: "ignore" });
    try {
      const r = await pollDevServerProcess(url, child, { timeoutMs: 3_000, intervalMs: 50 });
      expect(r.ok).toBe(true);
    } finally {
      killDevServer(child);
    }
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  });

  it("进程探活期间崩掉：立即判死（不等 HTTP 超时），detail 说出退出码", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    const r = await pollDevServerProcess("http://127.0.0.1:1/", child, { timeoutMs: 10_000, intervalMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("探活期间退出");
    expect(r.detail).toContain("3");
  });
});

describe("runSmokeChecks 的 devServer 分支（真子进程 + 真 HTTP）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-devserver-"));
  // 常驻"dev server"替身（被树杀是预期行为）；探活端点由 startEndpoint 提供
  // —— pollDevServerProcess 的契约里 URL 与子进程本就解耦（探活判定只看 HTTP）。
  const sleepScript = path.join(tmp, "sleep.js");
  fs.writeFileSync(sleepScript, "setInterval(() => {}, 50);\n", "utf8");
  const exitScript = path.join(tmp, "exit.js");
  fs.writeFileSync(exitScript, "process.exit(3);\n", "utf8");
  const okScript = path.join(tmp, "ok.js");
  fs.writeFileSync(okScript, "process.exit(0);\n", "utf8");

  it("通过路径：探活 200 → ok，digest 带探活事实与『进程已按约终止』", async () => {
    const url = await startEndpoint((_q, res) => res.end("ok"));
    const results = await runSmokeChecks(
      [{ title: "dev server 起得来", command: process.execPath, args: [sleepScript], devServer: { url, timeoutMs: 3_000 } }],
      { cwd: tmp },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.logDigest).toContain("[dev-server]");
    expect(results[0]!.logDigest).toContain("HTTP 200");
    expect(results[0]!.logDigest).toContain("进程已按约终止");
  });

  it("失败路径：子进程立即退出 → ok=false，digest 带退出码与失败说明", async () => {
    const results = await runSmokeChecks(
      [{ title: "起不来", command: process.execPath, args: [exitScript], devServer: { url: "http://127.0.0.1:1/", timeoutMs: 5_000 } }],
      { cwd: tmp },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.logDigest).toContain("探活期间退出");
    expect(results[0]!.logDigest).toContain("code=3");
    // 尾部输出为空时的占位文案：没有它排障时分不清"没输出"和"没收集"
    expect(results[0]!.logDigest).toContain("尾部输出：（空）");
  });

  it("沙箱门在 devServer 分支同样生效：node -e 内联求值被拒，且没有 spawn", async () => {
    let spawned = false;
    const results = await runSmokeChecks(
      [{ title: "后门", command: "node", args: ["-e", "x"], devServer: { url: "http://127.0.0.1:1/" } }],
      { cwd: tmp, spawnImpl: (() => { spawned = true; throw new Error("must not spawn"); }) as never },
    );
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.logDigest).toContain("[沙箱]");
    expect(spawned).toBe(false);
  });

  it("探活成功的检查不挡后续检查；失败的检查首败即停（与普通 smoke 同纪律）", async () => {
    const url = await startEndpoint((_q, res) => res.end("ok"));
    const results = await runSmokeChecks(
      [
        { title: "起得来", command: process.execPath, args: [sleepScript], devServer: { url, timeoutMs: 3_000 } },
        { title: "后续也跑", command: process.execPath, args: [okScript] },
      ],
      { cwd: tmp },
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);

    const stopped = await runSmokeChecks(
      [
        { title: "起不来", command: process.execPath, args: [exitScript], devServer: { url: "http://127.0.0.1:1/", timeoutMs: 5_000 } },
        { title: "不该跑到", command: process.execPath, args: [okScript] },
      ],
      { cwd: tmp },
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.ok).toBe(false);
  });
});

// 纯类型冒烟：PollResult 形状被协议消费（receipt / 审计），字段改名要在这里红
const _shape: PollResult = { ok: true, attempts: 1, elapsedMs: 1, detail: "" };
void _shape;
