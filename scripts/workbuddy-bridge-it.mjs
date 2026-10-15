/**
 * WorkBuddy 桥 × 平台引擎 —— 真进程集成测试（零网络、零配额、零真实凭据）。
 *
 * 为什么门禁里必须有它（与两个邻居的分工）：
 *   · `check:workbuddy-bridge`（段 11）按锚点抠 `assertWritable`/`writeFiles` 两个函数，
 *     跑的是**判定口径**，不起进程；
 *   · `smoke:offline-e2e`（段 30）的桥是**内联假件** —— 收到派单立刻写盘并回 completed，
 *     验的是引擎/仲裁/退出码，跟真桥一行代码都没接触；
 *   · 于是"平台发出的 TaskRequest 真桥认不认、ox-agent/2 四接口对不对得上、
 *     人写回 outbox 的成果与失败理由能不能上抛到引擎事件流"这三件事**没有任何一步看过**。
 *   2026-10-15 实测到的两个洞都长在这一格里：桥的 zone 判定比平台严（`z.` 前缀规则缺失，
 *     合法交付被判越权），以及被拒的一批会在 zone 内留下半个文件（已修，段 11 钉住）。
 *
 * 五个场景（每个都真起 headless 进程 + 真起桥进程）：
 *   clean      —— 人经 outbox 交付 → 桥按 zone 落盘 → 平台真跑 `node --test` → done，exit 0；
 *   rogue     —— 成果里混一份 zone 外文件 → 桥整批拒 → 盘上零产物，理由上抛到引擎侧；
 *   protected —— 成果里混一份 package.json → 桥拒，目标项目的 package.json 逐字未变；
 *   fail-note  —— 人主动判失败（outbox/{runId}.fail.json）→ 理由原样出现在引擎事件流；
 *   malformed  —— outbox 里是坏 JSON → 判失败而不是把 run 卡死。
 *
 * 用法：node scripts/workbuddy-bridge-it.mjs   前置：npm run build:headless
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 * 端口一律随机取（不与 smoke:gateway / smoke:coze 的固定端口抢）。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, "dist-headless", "headless", "headless-main.js");
const BRIDGE_SRC = path.join(ROOT, "scripts", "workbuddy-bridge.mjs");

for (const [label, p] of [["dist-headless/headless/headless-main.js", RUNNER], ["scripts/workbuddy-bridge.mjs", BRIDGE_SRC]]) {
  if (!fs.existsSync(p)) {
    console.error(`FAIL: 找不到 ${label} —— 先跑 npm run build:headless`);
    process.exit(1);
  }
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
const EVIL_PKG = '{"name":"e2e","version":"9.9.9","scripts":{"test":"exit 0"}}';
const FAIL_REASON = "人判定：sub 的返回顺序有歧义，先不交付";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 扮演"人"：读桥落在 inbox 的任务书，按场景写回 outbox。
 * 返回写的那一格（供断言核对派单顺序）。
 */
function humanDeliver(mode, task, outboxDir, runId) {
  const isImpl = /^src/.test(String(task.zone));
  const write = (name, obj) => fs.writeFileSync(path.join(outboxDir, name), JSON.stringify(obj), "utf8");
  if (mode === "deadline") return "silence"; // 人不接这一单：让 deadline 自己收口
  if (isImpl && mode === "fail-note") {
    fs.writeFileSync(path.join(outboxDir, `${runId}.fail.json`), JSON.stringify({ reason: FAIL_REASON }), "utf8");
    return "fail-note";
  }
  if (isImpl && mode === "malformed") {
    fs.writeFileSync(path.join(outboxDir, `${runId}.json`), "{ 这不是 JSON", "utf8");
    return "malformed";
  }
  if (isImpl && mode === "rogue") {
    write(`${runId}.json`, {
      files: [
        { path: "src/add.js", content: IMPL },
        { path: "README.md", content: "# 越权写入\n" },
      ],
      summary: "实现 + 顺手改了 zone 外的 README",
    });
    return "rogue";
  }
  if (isImpl && mode === "protected") {
    write(`${runId}.json`, { files: [{ path: "package.json", content: EVIL_PKG }], summary: "试图改写 package.json" });
    return "protected";
  }
  const files = isImpl ? [{ path: "src/add.js", content: IMPL }] : [{ path: "tests/add.test.js", content: TEST_FILE }];
  write(`${runId}.json`, { files, summary: `交付 ${files[0].path}`, logs: [`人写回 ${task.taskId}`] });
  return isImpl ? "impl" : "test";
}

async function runOnce(mode, opts = {}) {
  const runDeadlineMs = opts.runDeadlineMs ?? 120000;
  const maxRepairRounds = opts.maxRepairRounds ?? 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ox-wb-bridge-it-${mode}-`));
  const proj = path.join(tmp, "proj");
  const bridgeDir = path.join(tmp, "bridge");
  const inboxDir = path.join(bridgeDir, "inbox");
  const outboxDir = path.join(bridgeDir, "outbox");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0" }), "utf8");
  fs.writeFileSync(path.join(proj, "src", "add.js"), "module.exports.add = (a, b) => a + b;\n", "utf8");

  const bridgePort = await freePort();
  const bridge = spawn(process.execPath, [BRIDGE_SRC], {
    env: { ...process.env, WORKBUDDY_BRIDGE_PORT: String(bridgePort), WORKBUDDY_BRIDGE_DIR: bridgeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridgeLog = "";
  bridge.stdout.on("data", (d) => (bridgeLog += d));
  bridge.stderr.on("data", (d) => (bridgeLog += d));

  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(1000) });
      health = await r.json();
    } catch {
      /* 桥还在起 */
    }
  }
  if (!health) {
    console.error(`FAIL: 桥没起来（:${bridgePort}）\n${bridgeLog}`);
    process.exit(1);
  }
  check(`[${mode}] 桥 /health 应答 agent=workbuddy`, health.agent === "workbuddy", JSON.stringify(health));

  // 冒充大脑：ollama 是 providers 表里唯一免 key 的条目，用端点覆盖指到本机随机端口。
  const brain = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(TASKS) } }], usage: { total_tokens: 42 } }),
      );
    });
  });
  await new Promise((r) => brain.listen(0, "127.0.0.1", r));
  const brainPort = brain.address().port;

  const dispatched = [];
  const seen = new Set();
  const watcher = setInterval(() => {
    let names;
    try {
      names = fs.readdirSync(inboxDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const n of names) {
      const runId = n.slice(0, -5);
      if (seen.has(runId)) continue;
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(inboxDir, n), "utf8"));
      } catch {
        continue; // 桥正在写这一份
      }
      seen.add(runId);
      dispatched.push({ taskId: String(task.taskId), zone: String(task.zone), projectRoot: String(task.projectRoot), deadlineMs: task.deadlineMs, deliver: humanDeliver(mode, task, outboxDir, runId) });
    }
  }, 120);

  const spec = {
    requirement: "给 src/add.js 补 sub 并加测试",
    projectRoot: proj,
    llmProvider: "ollama",
    llmPool: ["ollama"],
    prd: {
      goal: "src/add.js 提供 add 与 sub，tests 覆盖两者",
      features: ["sub(a,b) 返回差", "tests/add.test.js 覆盖 add 与 sub"],
      techStack: ["CommonJS", "node:test"],
      acceptanceCriteria: ["node --test tests/add.test.js 全部通过"],
    },
    maxRepairRounds,
    escalationPolicy: "exhaust",
    verificationCommands: [{ kind: "test", command: "node", args: ["--test", "tests/add.test.js"] }],
    arbitration: "revert-batch",
    snapshotRoot: path.join(tmp, "snaps"),
    agents: [
      {
        id: "workbuddy-bridge",
        name: "workbuddy-bridge",
        adapter: "http-bridge",
        entry: { kind: "http", baseUrl: `http://127.0.0.1:${bridgePort}`, healthPath: "/health", runsPath: "/v1/runs", pollMs: 100 },
        capabilities: {
          protocolVersion: "ox-agent/2",
          roles: ["*"],
          zoneGlobs: ["src/**", "tests/**"],
          supports: ["read", "edit", "create"],
          artifactKinds: ["files", "logs"],
          maxConcurrency: 2,
          selfIsolated: true,
        },
        credential: { kind: "none" },
        limits: { runDeadlineMs, idleTimeoutMs: 90000 },
      },
    ],
  };

  const child = spawn(process.execPath, [RUNNER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OX_LLM_BASE_URL_OLLAMA: `http://127.0.0.1:${brainPort}/v1` },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.stdin.write(JSON.stringify(spec));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearInterval(watcher);

  const events = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: "unparsable", text: l.slice(0, 300) };
      }
    });
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(proj, rel), "utf8");
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(proj, rel));

  try {
    await fetch(`http://127.0.0.1:${bridgePort}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1500) });
  } catch {
    /* 收摊尽力而为 */
  }
  await sleep(150);
  bridge.kill();
  brain.close();

  const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : []);
  return {
    code,
    events,
    err,
    bridgeLog,
    dispatched,
    read,
    exists,
    tmp,
    inboxLeft: listJson(inboxDir),
    outboxLeft: listJson(outboxDir),
    outboxAll: fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir) : [],
  };
}

/** 引擎侧某个任务的终态（task 事件按 taskId 取最后一条）。 */
const taskStatus = (r, taskId) => {
  const hits = r.events.filter((e) => e.type === "task" && e.taskId === taskId);
  return hits.length ? String(hits.at(-1).status) : null;
};
/** 适配器回报给引擎的 run 终态（ok / errorClass / agentId）。 */
const runEnd = (r, taskId) => r.events.filter((e) => e.type === "run" && e.phase === "end" && e.taskId === taskId).at(-1);

console.log("=== 场景 1：clean —— 人经桥交付，平台真跑 node --test，终态 done ===");
{
  const r = await runOnce("clean");
  check("两次派单都带 taskId/zone/projectRoot/deadlineMs（真桥认平台的 TaskRequest 字段）", r.dispatched.length === 2 && r.dispatched.every((d) => d.taskId && d.zone && d.projectRoot && d.deadlineMs), JSON.stringify(r.dispatched));
  check("退出码 0", r.code === 0, `实际 ${r.code}`);
  check("终态是 done 且 passed 为真", r.events.at(-1)?.type === "done" && r.events.at(-1)?.passed === true, JSON.stringify(r.events.at(-1)));
  check("验证恰好一轮且通过（真起了 node --test）", JSON.stringify(r.events.filter((e) => e.type === "verification").map((e) => e.passed)) === "[true]", JSON.stringify(r.events.filter((e) => e.type === "verification")));
  check("交付物逐字落进 projectRoot", r.read("src/add.js") === IMPL && r.read("tests/add.test.js") === TEST_FILE, `add.js=${String(r.read("src/add.js")).length}B test=${String(r.read("tests/add.test.js")).length}B`);
  check("桥的 completed 终态被适配器映射成 ok:true（不是同步返回那种假完成）", r.events.filter((e) => e.type === "run" && e.phase === "end").every((e) => e.ok === true && e.agentId === "workbuddy-bridge"), JSON.stringify(r.events.filter((e) => e.type === "run" && e.phase === "end")));
  check("任务书用完即删（inbox 无残留）", r.inboxLeft.length === 0, JSON.stringify(r.inboxLeft));
  check("stdout 每行都是合法 JSON", !r.events.some((e) => e.type === "unparsable"), r.events.filter((e) => e.type === "unparsable").map((e) => e.text).join(" | "));
  check("stderr 干净", r.err.trim() === "", r.err.slice(0, 200));
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("\n=== 场景 2：rogue —— 成果里混一份 zone 外文件 → 整批拒、盘上零产物 ===");
{
  const r = await runOnce("rogue");
  check("zone 外那份没落盘", r.exists("README.md") === false);
  check("zone 内那份也没落盘（整批原子性：盘上还是动手前的骨架）", r.read("src/add.js") === "module.exports.add = (a, b) => a + b;\n", `实际内容 ${JSON.stringify(r.read("src/add.js"))}`);
  check("引擎判这个任务 failed", taskStatus(r, "t-impl") === "failed", String(taskStatus(r, "t-impl")));
  check("run 终态带归因（ok:false 且 errorClass 有值）", runEnd(r, "t-impl")?.ok === false && !!runEnd(r, "t-impl")?.errorClass, JSON.stringify(runEnd(r, "t-impl")));
  check("不以 done 收场且退出码非 0", r.events.at(-1)?.type !== "done" && r.code !== 0, `终态 ${r.events.at(-1)?.type} / code ${r.code}`);
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("\n=== 场景 3：protected —— package.json 不属于任何 zone 的交付 ===");
{
  const r = await runOnce("protected");
  check("目标项目 package.json 逐字未变", r.read("package.json") === JSON.stringify({ name: "e2e", version: "1.0.0" }), String(r.read("package.json")).slice(0, 80));
  check("引擎判这个任务 failed", taskStatus(r, "t-impl") === "failed", String(taskStatus(r, "t-impl")));
  check("不以 done 收场", r.events.at(-1)?.type !== "done" && r.code !== 0, `终态 ${r.events.at(-1)?.type} / code ${r.code}`);
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("\n=== 场景 4：fail-note —— 人主动判失败，平台必须当失败（不能当成功交付） ===");
{
  const r = await runOnce("fail-note");
  check("引擎判这个任务 failed", taskStatus(r, "t-impl") === "failed", String(taskStatus(r, "t-impl")));
  check("后继任务没被派（依赖未就绪，不烧配额）", r.dispatched.every((d) => d.taskId !== "t-test"), JSON.stringify(r.dispatched.map((d) => d.taskId)));
  check("目标项目零改动（tests/ 不存在、src 还是骨架）", r.exists("tests/add.test.js") === false && r.read("src/add.js") === "module.exports.add = (a, b) => a + b;\n");
  check("不以 done 收场", r.events.at(-1)?.type !== "done" && r.code !== 0, `终态 ${r.events.at(-1)?.type} / code ${r.code}`);
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("\n=== 场景 5：malformed —— outbox 坏 JSON 判失败而不是把 run 卡死 ===");
{
  const r = await runOnce("malformed");
  check("runner 自己收了摊（有退出码，且非 0）", typeof r.code === "number" && r.code !== 0, `code=${r.code}`);
  check("引擎判这个任务 failed", taskStatus(r, "t-impl") === "failed", String(taskStatus(r, "t-impl")));
  check("坏 JSON 不再留在待消费队列里", r.outboxLeft.length === 0, JSON.stringify(r.outboxLeft));
  check("现场保留成 .bad（不扔人的字节，但也不让它继续当成果）", r.outboxAll.some((n) => n.endsWith(".bad")), JSON.stringify(r.outboxAll));
  check("不以 done 收场", r.events.at(-1)?.type !== "done", `终态 ${r.events.at(-1)?.type} / code ${r.code}`);
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("\n=== 场景 6：deadline —— 人不接单，两边都不许永等，任务书也不能留在盘上 ===");
{
  const r = await runOnce("deadline", { runDeadlineMs: 3000 });
  check("run 在时限内自己收口了（进程退出、退出码非 0）", r.code !== 0, `code=${r.code}`);
  check("不以 done 收场", r.events.at(-1)?.type !== "done", `终态 ${r.events.at(-1)?.type}`);
  check("确实派过单（不是没接上就收摊）", r.dispatched.length >= 1, JSON.stringify(r.dispatched.map((d) => d.taskId)));
  check("超时/中止路径也删任务书（inbox 不无限涨）", r.inboxLeft.length === 0, JSON.stringify(r.inboxLeft));
  fs.rmSync(r.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures === 0 ? "\nIT PASS：真桥 × 真引擎端到端通过（协议字段/落盘/越权整批拒/失败终态/deadline 收口/inbox 清理）" : `\nIT FAIL：${failures} 条`);
process.exit(failures === 0 ? 0 : 1);
