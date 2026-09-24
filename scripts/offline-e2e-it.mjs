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
 * 四个场景：
 *   clean     —— 两个任务都在自己 zone 内写 → 交付，exit 0；
 *   rogue      —— 实现任务顺手写 zone 外的 README.md → 判越权、回滚、重修一轮仍越权 → exit 2；
 *   prebroken —— 动手前就有一条验证命令是红的 → 基线归因必须出现在日志与每一份重修上下文里；
 *   interrupt —— 第一次派单刚落地就把进程杀掉 → journal 可续跑、遗留备份保留、到期才回收。
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

/** 造一个待改造的目标项目（两个任务各自 zone 内写文件就能通过验证）。 */
function makeProject(proj, mode) {
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0" }), "utf8");
  fs.writeFileSync(path.join(proj, "src", "add.js"), "module.exports.add = (a, b) => a + b;\n", "utf8");
  if (mode === "prebroken") {
    // 失败必须落在某个 zone 之内 —— 否则计划期的 zone 覆盖预检（orchestrator 那条
    // "验证命令引用的路径无人认领"防线）会直接拒绝整份计划，根本到不了运行期。
    fs.writeFileSync(path.join(proj, "src", "broken.js"), "throw new Error('pre-existing host-project failure');\n", "utf8");
  }
}

/**
 * 起一次完整 run：本地冒充大脑 + 假 http-bridge 智能体 + 临时目标项目。
 *
 * `reuse` 给定时不新建也不删项目目录 —— 断点续跑那组用例要在**同一份工作区**上
 * 连跑多个进程。`interrupt` 给定时，第一次派单刚落到桥端就把子进程杀掉：
 * POSIX 发 SIGTERM（走 headless 自己的中断处理器），Windows 只能 TerminateProcess
 * （信号投不进去，这是平台事实，不是被测代码的分支）。
 */
async function runOnce({ mode, reuse = null, interrupt = false }) {
  const owned = reuse === null;
  const tmp = owned ? fs.mkdtempSync(path.join(os.tmpdir(), `ox-offline-e2e-${mode}-`)) : reuse.tmp;
  const proj = owned ? path.join(tmp, "proj") : reuse.proj;
  const snapshotRoot = owned ? path.join(tmp, "snaps") : reuse.snapshotRoot;
  if (owned) makeProject(proj, mode);

  let child = null;
  let killedByUs = false;
  const stopChild = () => {
    if (killedByUs || !child) return;
    killedByUs = true;
    if (process.platform === "win32") child.kill();
    else child.kill("SIGTERM");
  };

  let brainCalls = 0;
  const brain = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      brainCalls += 1;
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
  const payloads = [];
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
        payloads.push(String(task.repairContext?.errorLogDigest ?? task.description ?? ""));
        // 派单刚落地就动手杀进程：此刻计划期的 journal 已经写过（`save()` 在派单之前），
        // 而这一批的产物还没写完整 —— 正是"被中断的一批"的形状。
        if (interrupt) stopChild();
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
      verificationCommands:
        mode === "prebroken"
          ? [
              // 顺序有讲究：验证器**首败即停**（verifier.ts:151），所以把智能体能修好的
              // 那条放前面，才能让两条结果都出现在报告里。
              { kind: "test", command: "node", args: ["--test", "tests/add.test.js"] },
              { kind: "build", command: "node", args: ["src/broken.js"] },
            ]
          : [{ kind: "test", command: "node", args: ["--test", "tests/add.test.js"] }],
      arbitration: "revert-batch",
      // 备份目录钉在本次的 tmp 里：断点续跑那组用例要看它留没留、什么时候被回收。
      snapshotRoot,
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

    // 赋给外层那个 `child`：桥端的回调闭包看到的是外层变量，这里若写成 `const`
    // 就会遮蔽掉它，`stopChild()` 永远拿到 null（= 杀不掉，中断用例静默退化成正常跑完）。
    child = spawn(process.execPath, [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
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
    let backups = [];
    try {
      backups = fs.readdirSync(snapshotRoot).filter((n) => n.startsWith("batch-"));
    } catch {
      /* 还没有任何备份目录 */
    }
    return {
      code,
      events,
      err,
      dispatched,
      payloads,
      impl: read("src/add.js"),
      readme: read("README.md"),
      journal: read("ox-run-journal.json"),
      brainCalls,
      killedByUs,
      backups,
      tmp,
      proj,
      snapshotRoot,
    };
  } finally {
    brain.close();
    bridge.close();
    // `reuse` 的项目由调用方收尾：续跑用例要在同一份工作区上连跑三个进程。
    if (owned) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  console.log("\n=== 场景 C：动手前就有一条验证命令是红的（在 zone 内，但没人被派去修它）===");
  const pre = await runOnce({ mode: "prebroken" });
  const preLogs = pre.events.filter((e) => e.type === "log").map((e) => e.text);
  check(
    "基线红被当场说出来（并写清不是智能体造成的）",
    preLogs.some((t) => t.includes("基线验证") && t.includes("在本次运行开始前就失败")),
    JSON.stringify(preLogs.filter((t) => t.includes("基线")).map((t) => t.slice(0, 60))),
  );
  // 重修轮派给桥端的载荷里必须带这句归因 —— 这是基线验证存在的唯一理由。
  check(
    "重修轮把「动手前就已失败」随上下文发给智能体",
    pre.payloads.filter((p) => p.includes("本次运行前就已失败")).length >= 1,
    JSON.stringify(pre.payloads.map((p) => p.slice(0, 50))),
  );
  check(
    "首轮派单里没有这句（还没有历史可标注）",
    !pre.payloads[0]?.includes("本次运行前就已失败"),
    JSON.stringify(pre.payloads[0]?.slice(0, 60)),
  );
  const lastVer = pre.events.filter((e) => e.type === "verification").at(-1);
  check(
    "智能体那部分确实交付了：test 转绿，红的只有那条动手前就红的历史失败",
    JSON.stringify((lastVer?.results ?? []).map((r) => `${r.kind}:${r.ok ? "ok" : "fail"}`)) === '["test:ok","build:fail"]',
    JSON.stringify((lastVer?.results ?? []).map((r) => [r.kind, r.ok])),
  );
  check(
    "不因为基线红就放行交付 → 退出码 2",
    pre.code === 2,
    `实际 ${pre.code} / 事件 ${JSON.stringify(pre.events.map((e) => e.type))} / ${JSON.stringify(
      pre.events.filter((e) => e.type === "error"),
    )}`,
  );
  check("仍然照常走完重修轮（基线红不短路引擎）", pre.dispatched.filter((d) => d.taskId === "t-impl").length === 2);

  console.log("\n=== 场景 D：第一次派单刚落地就被杀 → 续跑、遗留备份保留、到期才回收 ===");
  // 这条盯的是只有"多个真进程 + 真 fs"才成立的三件事：中断留下可读的 journal、
  // 下一次启动真的跳过规划、以及备份**在不该删的时候没被删**（保留 24h 是给人工恢复留材料）。
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "ox-offline-e2e-int-"));
  const projD = path.join(tmpD, "proj");
  const snapsD = path.join(tmpD, "snaps");
  const reuseD = { tmp: tmpD, proj: projD, snapshotRoot: snapsD };
  makeProject(projD, "clean");
  try {
    const first = await runOnce({ mode: "clean", reuse: reuseD, interrupt: true });
    check(
      "第一次确实是被杀的（不是自己跑完）",
      first.killedByUs === true,
      JSON.stringify({ killed: first.killedByUs, code: first.code, types: first.events.map((e) => e.type) }),
    );
    check(
      "被杀的那次没有走到 done",
      first.code !== 0 && !first.events.some((e) => e.type === "done"),
      `code=${first.code}`,
    );
    check(
      "续跑入口已经落盘（计划期就存过一次 journal）",
      first.journal !== null && first.journal.includes("t-impl"),
      String(first.journal?.slice(0, 60)),
    );
    check(
      "中断那一批的快照备份留在盘上",
      first.backups.length > 0,
      JSON.stringify(first.backups),
    );
    if (process.platform === "win32") {
      console.log("NOTE: win32 投不进 SIGTERM（kill 就是 TerminateProcess），下面两条只在 POSIX 侧断言");
    } else {
      const last = first.events.at(-1) ?? {};
      check(
        "SIGTERM 的终态事件是最后一条，且说清备份留在哪",
        last.type === "error" && String(last.message ?? "").includes("快照备份保留在"),
        JSON.stringify(last),
      );
      check(
        "error 之后没有再发任何后续事件（终态就是终态）",
        !first.events.some((e) => e.type === "done" || e.type === "verification"),
        JSON.stringify(first.events.map((e) => e.type)),
      );
    }

    const second = await runOnce({ mode: "clean", reuse: reuseD });
    const secondLogs = second.events.filter((e) => e.type === "log").map((e) => e.text);
    check(
      "第二次当场说出「断点续跑：恢复快照」",
      secondLogs.some((t) => t.includes("[journal] 断点续跑")),
      JSON.stringify(secondLogs.filter((t) => t.includes("journal")).map((t) => t.slice(0, 44))),
    );
    check(
      "续跑没有再叫大脑做规划（这一轮 LLM 零调用）",
      second.brainCalls === 0,
      `brainCalls=${second.brainCalls}`,
    );
    check(
      "第二次跑完了：退出码 0 且终态是 done",
      second.code === 0 && second.events.at(-1)?.type === "done",
      `code=${second.code} types=${JSON.stringify(second.events.map((e) => e.type))}`,
    );
    check(
      "产出齐了（sub 与测试文件都落盘）",
      !!second.impl && second.impl.includes("sub") && fs.existsSync(path.join(projD, "tests", "add.test.js")),
    );
    check(
      "没到保留期的遗留备份一个都没删，也没谎报回收",
      second.backups.length > 0 && !secondLogs.some((t) => t.includes("[snapshots] 回收")),
      JSON.stringify(second.backups),
    );

    // 第三次：把那几个遗留目录的 mtime 推到 48h 前 —— 回收该发生在启动时，且要说出来。
    const aged = second.backups;
    const when = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const n of aged) fs.utimesSync(path.join(snapsD, n), when, when);
    fs.rmSync(path.join(projD, "ox-run-journal.json"), { force: true });
    fs.rmSync(path.join(projD, "tests"), { recursive: true, force: true });
    makeProject(projD, "clean");
    const third = await runOnce({ mode: "clean", reuse: reuseD });
    const thirdLogs = third.events.filter((e) => e.type === "log").map((e) => e.text);
    check(
      `到期的遗留备份在第三次启动时被回收（${aged.length} 个）并被说出来`,
      aged.length > 0 && thirdLogs.some((t) => t.includes("[snapshots] 回收")),
      JSON.stringify(thirdLogs.filter((t) => t.includes("snapshots"))),
    );
    const stillThere = aged.filter((n) => fs.existsSync(path.join(snapsD, n)));
    check("被点名回收的那几个目录真的没了", stillThere.length === 0, JSON.stringify(stillThere));
    check(
      "回收是卫生工作，不影响这一次正常交付",
      third.code === 0 && third.events.at(-1)?.type === "done",
      `code=${third.code}`,
    );
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }


  console.log(failures === 0 ? "\n=== 判定：IT PASS ✓（离线全链路，零配额）===" : `\n=== 判定：IT FAIL ✗（${failures} 项）===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAIL: 探针自身异常：${e?.stack ?? e}`);
  process.exit(1);
});
