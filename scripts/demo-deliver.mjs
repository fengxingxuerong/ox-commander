/**
 * 对外可复现样例：一条命令跑一次**真实交付**，零凭据、零网络、零外部依赖。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 仓库里已经有一堆各司其职的门禁（22 步 verify），其中 `offline-e2e-it.mjs` 覆盖
 * 的甚至是同一条进程链路。那为什么还要多这一个？
 *
 * 因为"能跑"与"能被看见"是两件事。此前所有门禁的**读者**都是维护者自己：
 *   · 想快速了解这套东西到底能干什么的人，只能读 README 里的架构描述；
 *   · 想照着复现一次真交付的人，得先看懂 4 个 IT 脚本各自在验什么；
 *   · 想验证"交付结论可被外部复核"的人，没有任何现成入口 —— 那条链
 *     （receipt → 独立复核 CLI → --replay 复跑）从来没有一次**端到端**跑通过。
 *
 * 所以本脚本的目标读者是**第一次接触这个项目的人**，它同时是三样东西：
 *   1. README 里那条"你也能跑一遍"的演示（一段可读的 transcript）；
 *   2. 新人的上手路径（一次看到六阶段、能力路由、真验证、真凭据）；
 *   3. 回归基线（自带断言，见文件末尾的"断言"一节）。
 *
 * ── 它和 `offline-e2e-it.mjs` 的分工 ────────────────────────────────────────
 * IT 那条盯的是**反常路径**：越权回滚、基线红、进程被杀后断点续跑。
 * 这条盯的是**正常路径 + 凭据闭环**：一次干净交付，并把产出的凭据拿去
 * `receipt:verify --replay` 复核 —— 这一步 IT 里没有，而它是"外部可验证"
 * 这句承诺唯一的实证。
 *
 * ── 零凭据是怎么做到的 ──────────────────────────────────────────────────────
 * 大脑层冒充成 `ollama` —— 目录里唯一 `apiKeyEnvVar: ""` 的 provider，不需要密钥。
 * 而它的 baseUrl 在 `shared/providers.ts` 里写死 `http://localhost:11434/v1`，
 * 所以本样例通过 `OX_LLM_BASE_URL_OLLAMA` 把端点**改到本次随机端口**上：
 *   · 不再需要占住 11434（本机真跑着 Ollama 也不会冲突）；
 *   · 顺带成为那个覆盖开关的端到端实证 —— 断言里有一条就是"大脑真的打到了本进程"。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   npm run demo                     # 跑一遍，打印 transcript 与结论
 *   node scripts/demo-deliver.mjs --keep     # 保留现场（临时项目 / 凭据 / 事件流）
 *   node scripts/demo-deliver.mjs --quiet    # 只打印结论与断言
 *   前置：npm run build:headless
 *   exit 0 = 交付成功且凭据复核通过；exit 1 = 有 FAIL
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
const VERIFIER = path.join(ROOT, "dist-headless", "headless", "receipt-verify-main.js");

const KEEP = process.argv.includes("--keep");
const QUIET = process.argv.includes("--quiet");

if (!fs.existsSync(RUNNER) || !fs.existsSync(VERIFIER)) {
  console.error(
    `FAIL: 找不到编译产物（${path.relative(ROOT, RUNNER)} / ${path.relative(ROOT, VERIFIER)}）。\n` +
      "      先跑：npm run build:headless",
  );
  process.exit(1);
}

/* ------------------------------------------------------------ 目标项目内容 */

/** 交付物：一个读写 CSV 的小工具。够小，但**是真的**（有解析、有测试、有 CLI 出口）。 */
const IMPL_JS = `/**
 * csvstat —— 极简 CSV 统计：给一个 CSV 文件，报出行数与列数。
 * 契约（tests/csvstat.test.js 断言的就是这几条）：
 *   · 以逗号切分、去掉单元格两侧空白；
 *   · 空行忽略（含只有空白的行）；
 *   · 行尾 CRLF 与 LF 一视同仁。
 */
"use strict";

const fs = require("node:fs");

function parseCsv(text) {
  return text
    .trim()
    .split(/\\r?\\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

function summarize(rows) {
  return { rows: rows.length, cols: rows.length > 0 ? rows[0].length : 0 };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node src/csvstat.js <file.csv>");
    process.exit(2);
  }
  const stats = summarize(parseCsv(fs.readFileSync(file, "utf8")));
  console.log(\`rows=\${stats.rows} cols=\${stats.cols}\`);
}

module.exports = { parseCsv, summarize };
`;

const TEST_JS = `"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { parseCsv, summarize } = require("../src/csvstat.js");

test("parseCsv：按逗号切分、去两侧空白、忽略空行、容忍 CRLF", () => {
  assert.deepStrictEqual(parseCsv("a, b\\r\\nc,d\\n\\n  \\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("summarize：给出数据行数与列数", () => {
  assert.deepStrictEqual(summarize([["a", "b"], ["c", "d"], ["e", "f"]]), { rows: 3, cols: 2 });
});

test("summarize：空表不崩（列数为 0 而不是 undefined）", () => {
  assert.deepStrictEqual(summarize([]), { rows: 0, cols: 0 });
});
`;

const SAMPLE_CSV = "name,age\nalice,30\nbob,25\n";

/** 规划期交给大脑的 PRD（本样例预置，见下面 spec 里的说明）。 */
const PRD = {
  goal: "交付 csvstat：读一个 CSV 文件，报出行数与列数",
  features: ["parseCsv 解析（逗号切分 / 去空白 / 忽略空行 / 容忍 CRLF）", "summarize 统计", "CLI 出口打印 rows/cols"],
  techStack: ["CommonJS", "node:test"],
  acceptanceCriteria: ["node --test tests/csvstat.test.js 全绿", "node src/csvstat.js tests/sample.csv 打印 rows=3 cols=2"],
};

/** 大脑层的规划应答：两批任务（实现 → 测试），各自声明自己的 zone。 */
const TASKS_JSON = {
  tasks: [
    {
      id: "t-impl",
      title: "实现 csvstat",
      description: "在 src/csvstat.js 实现 parseCsv 与 summarize，并提供 CLI 出口。",
      zone: "src",
      dependencies: [],
      suggestedRole: "fullstack-dev",
    },
    {
      id: "t-test",
      title: "补测试与样例数据",
      description: "在 tests/csvstat.test.js 用 node:test 覆盖解析与统计；并提供 tests/sample.csv。",
      zone: "tests",
      dependencies: ["t-impl"],
      suggestedRole: "test-writer",
    },
  ],
};

/** 待改造的项目初始态：只有一个 package.json —— 交付物全部由智能体写出来。 */
function makeProject(proj) {
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "csvstat", version: "1.0.0", private: true }, null, 2) + "\n",
    "utf8",
  );
}

/* -------------------------------------------------------------- 两个假端点 */

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-demo-"));
  const proj = path.join(tmp, "proj");
  const snapshots = path.join(tmp, "snapshots");
  const out = path.join(tmp, "out");
  makeProject(proj);
  fs.mkdirSync(out, { recursive: true });

  const say = (s = "") => {
    if (!QUIET) console.log(s);
  };
  const head = (s) => say(`\n${s}`);

  let brainCalls = 0;
  const brain = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      brainCalls += 1;
      // OpenAI 兼容的最小应答。规划阶段只需要一段能解析成任务表的 JSON。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(TASKS_JSON) } }],
          usage: { total_tokens: 128 },
        }),
      );
    });
  });

  /** 假执行器（http-bridge 适配器）：按 taskId 把自己 zone 内的文件写到盘上。 */
  const dispatched = [];
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
        const task = JSON.parse(body || "{}");
        const taskId = String(task.taskId ?? "");
        dispatched.push({ taskId, zone: String(task.zone ?? "") });
        if (/impl/.test(taskId)) write("src/csvstat.js", IMPL_JS);
        else {
          write("tests/csvstat.test.js", TEST_JS);
          write("tests/sample.csv", SAMPLE_CSV);
        }
        return json(200, { runId: `demo-run-${dispatched.length}` });
      }
      if (/^\/v1\/runs\/[^/]+\/events/.test(url)) {
        const since = Number(new URL(url, "http://x").searchParams.get("since") ?? "0");
        return json(200, {
          events: since === 0 ? [{ kind: "completed", text: "files written", timestamp: Date.now() }] : [],
          status: "completed",
        });
      }
      if (/\/abort$/.test(url)) return json(200, { ok: true });
      return json(404, { error: "unhandled" });
    });
  });

  await listen(brain, 0); // 随机端口：不占 11434，也就不和本机真 Ollama 打架
  await listen(bridge, 0);
  const brainPort = brain.address().port;
  const bridgePort = bridge.address().port;
  const brainBaseUrl = `http://127.0.0.1:${brainPort}/v1`;

  const spec = {
    requirement: "交付 csvstat：读一个 CSV 文件，报出行数与列数",
    projectRoot: proj,
    // 免密钥的本地 provider。池也必须指过去，否则默认池（sensenova/amd）仍会要密钥。
    llmProvider: "ollama",
    llmPool: ["ollama"],
    // 预置 PRD：让演示**确定性**（不然每轮都要一个真模型把 PRD 生成出来）。
    // 给了它只跳过"生成 PRD"这一步，后面的分解/执行/验证/凭据一步不少。
    prd: PRD,
    maxRepairRounds: 1,
    escalationPolicy: "exhaust",
    arbitration: "revert-batch",
    snapshotRoot: snapshots,
    verificationCommands: [
      { kind: "test", command: "node", args: ["--test", "tests/csvstat.test.js"] },
      // 第二条走 CLI 出口 —— 它把 tests/sample.csv 也拉进验证面，
      // 于是"交付物真的能被跑起来"这件事进了凭据（可被 --replay 复现）。
      { kind: "smoke", command: "node", args: ["src/csvstat.js", "tests/sample.csv"] },
    ],
    agents: [
      {
        id: "demo-bridge",
        name: "demo-bridge",
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

  head("① 现场");
  say(`   临时工作区 : ${tmp}`);
  say(`   目标项目   : ${path.relative(tmp, proj)}/  （初始只有一个 package.json）`);
  head("② 两个假端点（全部开在随机端口上）");
  say(`   大脑层     : ${brainBaseUrl}   ← OX_LLM_BASE_URL_OLLAMA 指到这里`);
  say(`   执行器     : http://127.0.0.1:${bridgePort}  （http-bridge 适配器）`);
  head("③ 驱动 headless CLI（stdin 喂 spec，stdout 读 JSONL 事件）");

  let events = [];
  let code = null;
  let stderr = "";
  let spawnError = null;
  try {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: ROOT,
      // 端点覆盖只在这一处注入：环境是子进程唯一的入口，不需要改任何源码/配置。
      env: { ...process.env, OX_LLM_BASE_URL_OLLAMA: brainBaseUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
    code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    events = stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: "unparsable", text: l.slice(0, 200) };
        }
      });
  } catch (e) {
    spawnError = e;
  } finally {
    brain.close();
    bridge.close();
  }

  // 事件流落盘，方便逐个查看（这一份是"过程证据"，与凭据那个"结论证据"互补）
  fs.writeFileSync(path.join(out, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  if (!QUIET) for (const e of events) say(`   ${describeEvent(e)}`);

  /* ------------------------------------------------------------ 取交付凭据 */

  const receiptEvent = events.find((e) => e.type === "receipt");
  const receipt = receiptEvent?.receipt;
  const receiptFile = path.join(out, "receipt.json");
  if (receipt) fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");

  head("④ 交付凭据（这份东西是给交付对象看的，不是给我们自己看的）");
  if (receipt) {
    say(`   ${receipt.headline}`);
    say(`   outcome=${receipt.outcome}  verified=${receipt.verified}  rounds=${receipt.rounds}`);
    for (const c of receipt.checks ?? []) {
      say(`   · [${c.kind}] ${c.ok ? "通过" : "失败"}  ${c.command ?? "?"} ${(c.args ?? []).join(" ")}`);
    }
    say(`   fingerprint: ${receipt.fingerprint ?? "(没有盖章)"}`);
    say(`   已写入     : ${path.relative(tmp, receiptFile)}`);
    // 交付物清单：把"智能体真在 zone 内写出了东西"变成可见事实，而不只是断言里的一行。
    for (const rel of listFiles(proj)) {
      const bytes = fs.statSync(path.join(proj, rel)).size;
      say(`   交付物     : proj/${rel}  (${bytes} B)`);
    }
  } else {
    say("   （本次没有产出凭据）");
  }

  /* --------------------------------------------------- 独立复核（凭据闭环） */

  let verifyDefault = { code: null, stdout: "", stderr: "" };
  let verifyReplay = { code: null, stdout: "", stderr: "" };
  if (receipt) {
    head("⑤ 用独立复核工具核这份凭据（任何拿到它的人都能自己跑）");
    say(`   $ npm run receipt:verify -- ${path.relative(ROOT, receiptFile)}`);
    verifyDefault = await runVerifier([receiptFile]);
    say(`   → 退出码 ${verifyDefault.code}（${verdictOf(verifyDefault.stdout) ?? "?"}）` +
      `  —— 指纹一致只说明"没被改过"，不等于结论为真`);
    say(`   $ npm run receipt:verify -- ${path.relative(ROOT, receiptFile)} --replay --cwd=<项目>   # 真的重跑那两条命令`);
    verifyReplay = await runVerifier([receiptFile, "--replay", `--cwd=${proj}`]);
    say(`   → 退出码 ${verifyReplay.code}（${verdictOf(verifyReplay.stdout) ?? "?"}）`);
  }

  /* ------------------------------------------------------------------ 断言 */

  head("⑥ 断言");
  let failures = 0;
  const check = (label, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  const types = events.map((e) => e.type);
  const last = events.at(-1);
  check("headless 正常退出（exit 0）", code === 0, `实际 code=${code}${spawnError ? ` / ${spawnError.message}` : ""}`);
  check("事件流里没有解析不了的坏行", !types.includes("unparsable"));
  check("hello 是第一条事件", types[0] === "hello", String(types[0]));
  const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
  check(
    "五个阶段按序走完（PRD 是预置的，故从 PLANNING 起）",
    JSON.stringify(stages) === JSON.stringify(["PLANNING", "DEVELOPMENT", "VERIFICATION", "DELIVERY", "DONE"]),
    JSON.stringify(stages),
  );
  check("终态事件是 done 且 passed=true", last?.type === "done" && last.passed === true, JSON.stringify(last?.type));
  check(
    "能力路由把两个任务各派了一次（且都带 zone）",
    dispatched.length === 2 && dispatched.every((d) => d.zone !== ""),
    JSON.stringify(dispatched),
  );
  check(
    "大脑层请求由**本进程**的假端点收到（证明端点覆盖真的生效）",
    brainCalls >= 1,
    `brainCalls=${brainCalls}（若为 0，说明请求打去了 11434 而不是覆盖后的端口）`,
  );
  check(
    "真验证：两条命令都跑了且都通过",
    JSON.stringify(events.filter((e) => e.type === "verification").map((e) => e.passed)) === "[true]",
    JSON.stringify(events.filter((e) => e.type === "verification").map((e) => [e.passed, e.results])),
  );
  check("stderr 干净", stderr.trim() === "", stderr.trim().split("\n").slice(0, 2).join(" / "));

  check("产出了交付凭据", !!receipt);
  check("凭据已盖章（有 fingerprint）", !!receipt?.fingerprint);
  check(
    "凭据里的检查都带可复跑的命令（外部可验证的基石）",
    (receipt?.checks ?? []).length === 2 && (receipt?.checks ?? []).every((c) => !!c.command && Array.isArray(c.args)),
    JSON.stringify((receipt?.checks ?? []).map((c) => [c.command, c.args])),
  );
  check("凭据结论与运行结果自洽（delivered + verified）", receipt?.outcome === "delivered" && receipt?.verified === true, JSON.stringify(receipt?.headline));

  check(
    "复核（默认模式）= not-replayed（指纹一致 ≠ 结论为真）",
    verifyDefault.code === 5,
    `实际 ${verifyDefault.code} / verdict=${verdictOf(verifyDefault.stdout)}`,
  );
  check(
    "复核（--replay）= verified（凭据记的命令被重跑且结论复现）",
    verifyReplay.code === 0,
    `实际 ${verifyReplay.code} / verdict=${verdictOf(verifyReplay.stdout)}`,
  );

  const implPath = path.join(proj, "src", "csvstat.js");
  check("交付物真的落在盘上（src/csvstat.js）", fs.existsSync(implPath));
  check("测试文件真的落在盘上（tests/csvstat.test.js）", fs.existsSync(path.join(proj, "tests", "csvstat.test.js")));

  head("⑦ 结论");
  if (failures === 0) {
    console.log("一次真实交付完成：规划 → 派单 → 落盘 → 门禁 → 交付凭据 → 外部复核通过。");
    console.log("（本样例零凭据、零网络：大脑层与执行器都是本进程起的假端点。）");
  } else {
    console.log(`样例失败 ${failures} 项 ❌`);
  }

  if (KEEP) {
    console.log(`\n现场已保留：${tmp}`);
    console.log(`  项目      ${path.relative(tmp, proj)}/`);
    console.log(`  事件流    ${path.relative(tmp, path.join(out, "events.jsonl"))}`);
    if (receipt) console.log(`  交付凭据  ${path.relative(tmp, receiptFile)}`);
  } else {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  process.exit(failures === 0 ? 0 : 1);
}

/** 目录下所有文件的相对 posix 路径（升序）。演示用，不处理软链与权限异常。 */
function listFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) found.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found;
}

/** 把一条 JSONL 事件翻成一行可读文本（演示用，不求完备）。 */
function describeEvent(e) {
  switch (e.type) {
    case "hello":
      return `[hello] protocolVersion=${e.protocolVersion} provider=${e.llmProvider}`;
    case "stage":
      return `──────── 阶段：${e.stage} ────────`;
    case "prd":
      return `[prd] ${e.prd?.goal ?? ""}`;
    case "tasks":
      return `[tasks] ${JSON.stringify((e.batches ?? []).map((b) => b.map((t) => `${t.id}@${t.zone}`)))}`;
    case "agents":
      return `[agents] ${(e.agents ?? []).map((a) => `${a.id}(${a.adapter})`).join(" ")}`;
    case "run":
      return `[run] ${e.phase} ${e.taskId ?? ""}${e.ok === undefined ? "" : e.ok ? " ok" : " 失败"}`;
    case "task":
      return `[task] ${e.taskId} → ${e.status}`;
    case "verification":
      return `[verification] passed=${e.passed} ${JSON.stringify((e.results ?? []).map((r) => `${r.kind}:${r.ok ? "ok" : "fail"}`))}`;
    case "usage":
      return `[usage] calls=${e.calls} tokens=${e.totalTokens}`;
    case "conflict":
      return `[conflict] ${e.kind} ${JSON.stringify(e.paths)} → ${e.remedy}`;
    case "receipt":
      return `[receipt] ${e.receipt?.headline ?? ""}`;
    case "log":
      return `· ${e.text}`;
    case "done":
      return `[done] passed=${e.passed}`;
    case "error":
      return `[error] ${e.message}`;
    default:
      return `[${e.type}]`;
  }
}

function runVerifier(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFIER, ...args], { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 复核工具把裁决放在 stdout 的 JSON 里；取出来只为人看。 */
function verdictOf(stdout) {
  // 默认模式下 stdout = 裁决 JSON + 一段"可独立复跑的命令"人读清单，
  // 所以不能整体 JSON.parse —— 只取开头那个**配平**的 JSON 对象。
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, i + 1)).verdict;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

run().catch((e) => {
  console.error(`样例自身故障（不是被测代码失败）：${e?.stack ?? e}`);
  process.exit(1);
});
