/**
 * 离线全链路集成测试（零网络、零配额、零真实凭据）。
 *
 * 为什么单独有它：`verify` 其余各步要么在**函数层**跑引擎（注入假件），要么只查
 * 产物语法与协议退出码。没有一步真的穿过进程边界 —— 而下面这些只有在
 * "stdin 一份 spec → headless-main → orchestrator → 能力路由 → http-bridge 适配器
 * → 真 fs 落盘 → 真 FileJournal/SnapshotStore 仲裁 → 真 `node --test` 验证 →
 * stdout JSONL → 退出码" 这条路上才成立：
 *
 *   · 六个阶段的先后顺序与终态事件（done / error）是否真的按协议发；
 *   · 越权回滚是不是**外科手术式**的（zone 内的产出必须留下）；
 *   · 仲裁发出的 remedy 值与看板词表是否同源；
 *   · 重修轮是否只重派越权的那个任务，而不是整批；
 *   · 退出码 0 / 2 的分野。
 *
 * 两个场景：clean（都在 zone 内 → 交付，exit 0）/ rogue（实现任务顺手写 zone 外的
 * README.md → 判越权、回滚、重修一轮仍越权 → exit 2）。
 *
 * 大脑层冒充方式：`ollama` 是 providers 表里唯一 `apiKeyEnvVar: ""` 的条目，
 * baseUrl 写死 `http://localhost:11434/v1`，所以本脚本必须占住 11434。
 * **端口被占时直接失败并说明原因**，不静默跳过 —— 跳过的门禁比没有门禁更误导。
 *
 * 用法：node scripts/offline-e2e-it.mjs
 *   前置：npm run build && npm run build:headless
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "dist-headless", "headless", "headless-main.js");
const BRAIN_PORT = 11434; // 与 shared/providers.ts 里 ollama 的写死地址一致

if (!fs.existsSync(RUNNER)) {
  console.error("FAIL: 找不到 dist-headless/headless/headless-main.js —— 先跑 npm run build:headless");
  process.exit(1);
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const TASKS = {
  tasks: [
    {
      id: "t-impl",
      title: "给 add.js 补 sub",
      description: "在 src/add.js 增加 sub(a,b) 返回差，保留 add。",
      zone: "src",
      dependencies: [],
      suggestedRole: "fullstack-dev",
    },
    {
      id: "t-test",
      title: "补测试",
      description: "在 tests/add.test.js 用 node:test 覆盖 add 与 sub。",
      zone: "tests",
      dependencies: ["t-impl"],
      suggestedRole: "test-writer",
    },
  ],
};

const IMPL = "module.exports.add = (a, b) => a + b;\nmodule.exports.sub = (a, b) => a - b;\n";
const TEST_FILE =
  'const { test } = require("node:test");\nconst assert = require("node:assert");\n' +
  'const { add, sub } = require("../src/add.js");\n' +
  'test("add", () => assert.strictEqual(add(1, 2), 3));\n' +
  'test("sub", () => assert.strictEqual(sub(3, 1), 2));\n';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

/** 起一次完整 run：本地冒充大脑 + 假 http-bridge 智能体 + 临时目标项目。 */
async function runOnce({ mode }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ox-offline-e2e-${mode}-`));
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0" }), "utf8");
  fs.writeFileSync(path.join(proj, "src", "add.js"), "module.exports.add = (a, b) => a + b;\n", "utf8");

  const brain = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(TASKS) } }],
          usage: { total_tokens: 42 },
        }),
      );
    });
  });

  const dispatched = [];
  let count = 0;
  const bridge = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const write = (rel, content) => {
        const abs = path.join(proj, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
      };
      if (url === "/health") return json(200, { ok: true });
      if (req.method === "POST" && url === "/v1/runs") {
        count += 1;
        const task = JSON.parse(body || "{}");
        dispatched.push({ taskId: String(task.taskId), zone: String(task.zone) });
        if (/impl/.test(String(task.taskId))) {
          write("src/add.js", IMPL);
          // 越权场景：声明的 zone 只有 src 与 tests，README.md 在两者之外。
          if (mode === "rogue") write("README.md", "# written outside the declared zone\n");
        } else {
          write("tests/add.test.js", TEST_FILE);
        }
        return json(200, { runId: `remote-${count}` });
      }
      if (/^\/v1\/runs\/[^/]+\/events/.test(url)) {
        const since = Number(new URL(url, "http://x").searchParams.get("since") ?? "0");
        return json(200, {
          events: since === 0 ? [{ kind: "completed", text: "wrote files", timestamp: Date.now() }] : [],
          status: "completed",
        });
      }
      if (/\/abort$/.test(url)) return json(200, { ok: true });
      return json(404, { error: "unhandled" });
    });
  });

  await listen(brain, BRAIN_PORT);
  await listen(bridge, 0);
  const bridgePort = bridge.address().port;
  try {
    const spec = {
      requirement: "给 src/add.js 补 sub 并加测试",
      projectRoot: proj,
      // 免密钥的本地 provider；池也必须指过去，否则默认池仍要求 SenseNova key。
      llmProvider: "ollama",
      llmPool: ["ollama"],
      prd: {
        goal: "src/add.js 提供 add 与 sub，tests 覆盖两者",
        features: ["sub(a,b) 返回差", "tests/add.test.js 覆盖 add 与 sub"],
        techStack: ["CommonJS", "node:test"],
        acceptanceCriteria: ["node --test tests/add.test.js 全部通过"],
      },
      maxRepairRounds: 1,
      escalationPolicy: "exhaust",
      verificationCommands: [{ kind: "test", command: "node", args: ["--test", "tests/add.test.js"] }],
      arbitration: "revert-batch",
      agents: [
        {
          id: "e2e-bridge",
          name: "e2e-bridge",
          adapter: "http-bridge",
          entry: {
            kind: "http",
            baseUrl: `http://127.0.0.1:${bridgePort}`,
            healthPath: "/health",
            runsPath: "/v1/runs",
            pollMs: 50,
          },
          capabilities: {
            roles: ["*"],
            zoneGlobs: ["src/**", "tests/**"],
            supports: ["read", "edit", "create"],
            artifactKinds: ["files"],
            maxConcurrency: 2,
            selfIsolated: false,
          },
          credential: { kind: "none" },
        },
      ],
    };

    const child = spawn(process.execPath, [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("exit", resolve));
    const events = out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: "unparsable", text: l.slice(0, 200) };
        }
      });
    const read = (rel) => {
      try {
        return fs.readFileSync(path.join(proj, rel), "utf8");
      } catch {
        return null;
      }
    };
    return { code, events, err, dispatched, impl: read("src/add.js"), readme: read("README.md") };
  } finally {
    brain.close();
    bridge.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// spec 里给了 `prd` 就跳过 PRD 生成阶段（协议文档 §1：「提供则跳过」），
// 所以这里断言的是后五个阶段的顺序，外加 `prd` 事件把传入的 PRD 回显。
const STAGES = ["PLANNING", "DEVELOPMENT", "VERIFICATION", "DELIVERY", "DONE"];

async function main() {
  // 先单独占一次端口：占用与"跑不起来"要能区分开，别让人以为测试过了。
  const probe = http.createServer();
  try {
    await listen(probe, BRAIN_PORT);
  } catch (e) {
    console.error(
      `FAIL: 端口 ${BRAIN_PORT} 已被占用（本机在跑真的 Ollama？）。本用例必须占住它来冒充大脑层，` +
        `因为 ollama 的 baseUrl 写死在 shared/providers.ts 里。\n` +
        `      停掉占用进程再跑（Windows：netstat -ano | findstr ${BRAIN_PORT}）。原始错误：${e.code ?? e.message}`,
    );
    process.exit(1);
  }
  probe.close();

  console.log("=== 场景 A：两个任务都守在自己的 zone 内 → 应交付 ===");
  const clean = await runOnce({ mode: "clean" });
  const types = clean.events.map((e) => e.type);
  const stageAt = (s) => clean.events.findIndex((e) => e.type === "stage" && e.stage === s);
  const stageIndexes = STAGES.map(stageAt);
  check(
    "六个阶段按序出现",
    stageIndexes.every((i) => i >= 0) && stageIndexes.every((i, k) => k === 0 || i > stageIndexes[k - 1]),
    JSON.stringify(clean.events.filter((e) => e.type === "stage").map((e) => e.stage)),
  );
  check("退出码 0", clean.code === 0, `实际 ${clean.code}`);
  check("hello 是第一条事件", types[0] === "hello", String(types[0]));
  const prdEvent = clean.events.find((e) => e.type === "prd");
  check("给了 prd 就跳过生成，但仍回显给宿主", !!prdEvent?.prd?.goal, JSON.stringify(prdEvent?.prd?.goal));
  check("done 是终态且 passed 为真", types.at(-1) === "done" && clean.events.at(-1).passed === true);
  check("verification 恰好一轮且通过", JSON.stringify(clean.events.filter((e) => e.type === "verification").map((e) => e.passed)) === "[true]");
  check("无越权裁决", clean.events.filter((e) => e.type === "conflict").length === 0);
  check("两次派单都带 zone", clean.dispatched.length === 2 && clean.dispatched.every((d) => !!d.zone), JSON.stringify(clean.dispatched));
  check("run 归因齐了（每个任务 start+end）", clean.events.filter((e) => e.type === "run").length === 4);
  check("实现真落盘（sub 存在）", !!clean.impl && clean.impl.includes("sub"));
  check("README 未被写过", clean.readme === null);
  const usage = clean.events.find((e) => e.type === "usage");
  check("用量落账：1 次调用 42 token", usage?.calls === 1 && usage?.totalTokens === 42, JSON.stringify(usage));
  check("stdout 每行都是合法 JSON", !types.includes("unparsable"));
  check("stderr 干净", clean.err.trim() === "", clean.err.slice(0, 200));

  console.log("\n=== 场景 B：实现任务顺手写 zone 外的 README.md → 应判越权并回滚 ===");
  const rogue = await runOnce({ mode: "rogue" });
  const conflicts = rogue.events.filter((e) => e.type === "conflict");
  check("重修耗尽 → 退出码 2", rogue.code === 2, `实际 ${rogue.code}`);
  check(
    "越权清单精确指向 README.md",
    conflicts.length > 0 && conflicts.every((c) => c.kind === "unauthorized-write" && c.paths.join() === "README.md"),
    JSON.stringify(conflicts),
  );
  check("remedy 发的是 revert（与看板词表同源）", conflicts.every((c) => c.remedy === "revert"));
  check("README 已回滚（盘上不再存在）", rogue.readme === null, JSON.stringify(rogue.readme));
  check("zone 内的实现仍然留下（回滚是外科手术式的）", !!rogue.impl && rogue.impl.includes("sub"));
  check(
    "只重派越权的那个任务，后继任务没跑",
    rogue.dispatched.filter((d) => d.taskId === "t-impl").length === 2 && !rogue.dispatched.some((d) => d.taskId === "t-test"),
    JSON.stringify(rogue.dispatched),
  );
  check(
    "终态是 error 且 exhausted 为真",
    rogue.events.at(-1)?.type === "error" && rogue.events.at(-1)?.exhausted === true,
    JSON.stringify(rogue.events.at(-1)),
  );

  console.log(failures === 0 ? "\n=== 判定：IT PASS ✓（离线全链路，零配额）===" : `\n=== 判定：IT FAIL ✗（${failures} 项）===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAIL: 探针自身异常：${e?.stack ?? e}`);
  process.exit(1);
});
