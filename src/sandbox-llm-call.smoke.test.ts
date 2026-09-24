/**
 * 沙箱内的 LLM 可达性探针：真实端点 + 真实沙箱门。
 *
 * 子进程按生产 `cli-agent.dispatch` 的同一条路径起：
 *   planSpawn（CommandPolicy 检查 → buildSpawnSpec 包装）→ spawn(shell:false, env: scopedEnv(…))
 * 于是这里把两个容易混在一起的问题分开钉：
 *   - 出网：沙箱里的子进程连得到端点吗（拿到任何 HTTP 状态码即算连到）
 *   - 凭证：不显式给 allowProviders 时，它环境里还有没有 key
 *
 * 真实链路、花钱，刻意不进 `npm run verify`。手动跑：
 *
 *   set -a && . ./.env && set +a && OX_SMOKE=1 npx vitest run src/sandbox-llm-call.smoke.test.ts
 *
 * 撞 429 是限流不是密钥失效，等 ≥5 分钟重跑失败用例一次（同 sensenova.smoke.test.ts 的 SOP）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultCommandPolicy, planSpawn } from "../electron/sandbox";
import { scopedEnv } from "../electron/agents/scoped-env";
import { verifyProject } from "../electron/engine/verifier";
import type { VerificationCommand } from "../shared/types";

const KEY = process.env.SENSENOVA_API_KEY ?? "";
const enabled = process.env.OX_SMOKE === "1" && !!KEY;

const ENDPOINT = "https://token.sensenova.cn/v1/chat/completions";

/** 只打印凭证的**变量名**，任何时候都不打印值。 */
const PROBE_SRC = [
  "const mode = process.argv[2];",
  "const bearer = mode === 'grant' ? (process.env.SENSENOVA_API_KEY ?? '') : 'sk-sandbox-invalid';",
  "const names = Object.keys(process.env)",
  "  .filter((n) => /SENSENOVA|API_KEY|TOKEN|SECRET|PASSWORD/i.test(n))",
  "  .sort()",
  "  .join(',');",
  "let status = -1;",
  "let content = '';",
  "if (mode !== 'envonly') {",
  "  try {",
  "    const res = await fetch('" + ENDPOINT + "', {",
  "      method: 'POST',",
  "      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },",
  "      body: JSON.stringify({ model: 'deepseek-v4-flash', max_tokens: 16, enable_thinking: false, messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }] }),",
  "      signal: AbortSignal.timeout(90000),",
  "    });",
  "    status = res.status;",
  "    const j = await res.json().catch(() => null);",
  "    const m = j && j.choices && j.choices[0] && j.choices[0].message;",
  "    content = String((m && (m.content || m.reasoning_content)) || '').slice(0, 60).replace(/\\s+/g, ' ');",
  "  } catch (e) {",
  "    content = 'TRANSPORT_ERROR ' + String(e && e.message).slice(0, 100);",
  "    status = -1;",
  "  }",
  "}",
  "console.log('KEYNAMES=[' + names + '] STATUS=' + status + ' CONTENT=' + content);",
].join("\n");

interface Probe {
  code: number | null;
  out: string;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ox-sbx-llm-"));
const PROBE_FILE = path.join(ROOT, "probe.mjs");

/**
 * 起一个真正过沙箱门的子进程：命令与参数先过 CommandPolicy，再按平台包成 spawn 三元组。
 * 计划本身也在这里被断言 —— 未过门的 argv 不该走到 spawn 这一步。
 */
function runSandboxed(mode: string, env: NodeJS.ProcessEnv): Promise<Probe> {
  const policy = createDefaultCommandPolicy();
  const spec = planSpawn("node", ["probe.mjs", mode], policy);
  const child = spawn(spec.file, spec.args, {
    cwd: ROOT,
    shell: false,
    env,
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  let out = "";
  child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
  return new Promise<Probe>((resolve) => {
    child.on("error", (err) => resolve({ code: null, out: out + String(err) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

beforeAll(() => {
  if (enabled) fs.writeFileSync(PROBE_FILE, PROBE_SRC, "utf8");
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // temp cleaner
  }
});

describe.skipIf(!enabled)("沙箱内真实调用 LLM", () => {
  it("显式授权 sensenova 后，沙箱子进程拿到真实响应", async () => {
    const p = await runSandboxed("grant", scopedEnv({ allowProviders: ["sensenova"] }));
    console.log(`[grant] exit=${p.code} ${p.out.trim().slice(0, 200)}`);
    expect(p.out).toMatch(/SENSENOVA_API_KEY/);
    expect(p.out).toMatch(/STATUS=200/);
    expect(p.out.toLowerCase()).toMatch(/pong/);
  }, 120_000);

  it("默认最小化环境下：拿不到 key，端点可达但被拒绝（出网未被沙箱阻断）", async () => {
    const p = await runSandboxed("bogus", scopedEnv());
    console.log(`[bogus] exit=${p.code} ${p.out.trim().slice(0, 200)}`);
    const names = /\[([^\]]*)\]/.exec(p.out)?.[1] ?? "?";
    expect(names).toBe("");
    // 状态码是 4xx 而不是 -1：说明请求真的到达了端点，沙箱没有掐断网络
    expect(p.out).toMatch(/STATUS=4\d\d/);
  }, 120_000);

  it("验证链（verifyProject）起的子进程同样不得继承宿主凭证环境", async () => {
    const cmds: VerificationCommand[] = [{ kind: "build", command: "node", args: ["probe.mjs", "envonly"] }];
    const report = await verifyProject(cmds, { cwd: () => ROOT });
    const log = report.results[0]?.logDigest ?? "";
    console.log(`[verify-env] passed=${report.passed} ${log.trim().slice(0, 200)}`);
    expect(log).toMatch(/KEYNAMES=\[\]/);
  }, 60_000);
});
