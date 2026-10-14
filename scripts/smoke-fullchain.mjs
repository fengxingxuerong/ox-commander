/* Full-chain integration smoke: real LLM writes files, ZoneGuard checks zones,
 * verifyProject runs npm scripts, repair loop reacts to real failures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OrchestratorEngine } = require("../dist-electron/electron/engine/orchestrator.js");
const { Scheduler } = require("../dist-electron/electron/engine/scheduler.js");
const { ZoneGuard } = require("../dist-electron/electron/engine/zone-guard.js");
const { verifyProject } = require("../dist-electron/electron/engine/verifier.js");
const { SensenovaApiAdapter } = require("../dist-electron/electron/agents/sensenova-api.js");
const { DEFAULT_SETTINGS } = require("../dist-electron/shared/types.js");

function loadDotEnv() {
  const p = path.join(import.meta.dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const WORKSPACE_SCRIPTS = {
  "build.js": [
    "const { execFileSync } = require('node:child_process');",
    "let failed = 0;",
    "for (const f of require('node:fs').readdirSync('src')) {",
    "  if (!f.endsWith('.js')) continue;",
    "  try { new (require('node:vm').Script)(require('node:fs').readFileSync(`src/${f}`, 'utf8'), { filename: f }); } catch (e) { console.error(`${f}: ${e.message}`); failed++; }",
    "}",
    "if (failed) process.exit(1);",
    "console.log('syntax check passed');",
  ].join("\n"),
  "test.js": [
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const files = fs.existsSync('tests') ? fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')) : [];",
    "if (files.length === 0) { console.error('no test files found in tests/'); process.exit(1); }",
    "for (const f of files) {",
    "  const r = spawnSync(process.execPath, [`--test`, `tests/${f}`], { stdio: 'inherit' });",
    "  if (r.status !== 0) process.exit(r.status ?? 1);",
    "}",
  ].join("\n"),
};

function ensureWorkspace(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ["src", "tests"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const pkg = path.join(root, "package.json");
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: "ox-it",
          version: "0.0.0",
          private: true,
          scripts: {
            build: "node ox-scripts/build.js",
            typecheck: "node ox-scripts/build.js",
            test: "node ox-scripts/test.js",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [name, content] of Object.entries(WORKSPACE_SCRIPTS)) {
    const file = path.join(root, "ox-scripts", name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }
}

async function main() {
  loadDotEnv();
  if (!process.env.SENSENOVA_API_KEY) {
    console.log("SKIP: no SENSENOVA_API_KEY");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ox-it-"));
  ensureWorkspace(root);
  console.log("workspace:", root);

  // Hard-coded tiny plan: two tasks, distinct zones, mirroring what decompose
  // would produce — keeps the run short and deterministic in shape.
  const batches = [
    [
      {
        id: "t1",
        title: "实现字符串工具模块",
        description:
          "在 src/strutil.js 中实现 CommonJS 模块，导出 capitalize(s)：把字符串首字母变大写其余小写；导出 words(s)：按空白拆分返回数组。禁止外部依赖。",
        zone: "src",
        dependencies: [],
        suggestedRole: "backend-dev",
      },
    ],
    [
      {
        id: "t2",
        title: "编写单元测试",
        description:
          "在 tests/strutil.test.js 中为 src/strutil.js 的 capitalize 和 words 写 node:test 单元测试，至少覆盖：普通字符串、空字符串、多空格拆分。文件第一行必须是 const { test } = require(\"node:test\"); 第二行 const assert = require(\"node:assert\");",
        zone: "tests",
        dependencies: ["t1"],
        suggestedRole: "test-writer",
      },
    ],
  ];

  const settings = { ...DEFAULT_SETTINGS, maxRepairRounds: 2 };
  const logs = [];
  /*
   * 契约路径合规（Stage 3.5）的存在性探针。
   *
   * 为什么必须在这里显式接上：引擎对这条判据的口径是 **不喂就是没检查** ——
   * 宿主没接 `fileExists` 时，它只打一行「这一轮没有执行」就继续，不会静默给绿，
   * 但也**不会**让这条冒烟变红。结果就是一处"自称全链路、其实少一环"的覆盖洞：
   * 契约路径合规正是 2026-10-14 幽灵义务那轮修的防线，在冒烟里却是断的。
   *
   * 所以这里做两件事：① 接真文件系统（与 platform.ts / run-spec.ts 同一实现：
   * 引擎已把路径过成干净相对路径，宿主只 join + existsSync）；② 记调用次数，
   * 结尾断言它**真的被调用过** —— 接上但从未调用，同样是空转。
   */
  let probeCalls = 0;
  const engine = new OrchestratorEngine(
    {
      llm: { chat: async () => { throw new Error("planning not used here"); } },
      scheduler: new Scheduler([new SensenovaApiAdapter()], [], new ZoneGuard()),
      verify: (cwd) => verifyProject(settings.verificationCommands, { cwd: () => cwd }),
      fileExists: (r, rel) => {
        probeCalls += 1;
        return fs.existsSync(path.join(r, rel));
      },
      settings,
    },
    {
      onStage: (s) => console.log(`[阶段] ${s}`),
      onLog: (l) => { logs.push(l); console.log(`  [日志] ${l}`); },
      onTaskStatus: (id, st, at) => console.log(`  [任务] ${id}: ${st}（第 ${at} 次）`),
      onVerification: (r) =>
        console.log(`  [验证] ${r.passed ? "通过" : "失败"}: ${r.results.map((x) => `${x.kind}=${x.ok}`).join(" ")}`),
      onTaskOutcome: (id, ok, d) => { if (!ok) console.log(`  [失败摘要] ${id}: ${String(d).slice(0, 300)}`); },
      onEscalation: (id, s) => console.log(`  [升级] ${id}: ${s.slice(0, 200)}`),
    },
  );

  try {
    const report = await engine.execute(batches, root);
    console.log("\n=== 结果 ===");
    console.log("passed:", report.passed);
    const strutil = path.join(root, "src", "strutil.js");
    const test = path.join(root, "tests", "strutil.test.js");
    console.log("src/strutil.js exists:", fs.existsSync(strutil));
    console.log("tests/strutil.test.js exists:", fs.existsSync(test));
    if (fs.existsSync(strutil)) {
      const m = require(strutil);
      console.log("capitalize('hELLO') =", m.capitalize ? m.capitalize("hELLO") : "(missing)");
      console.log("words('a  b c') =", m.words ? JSON.stringify(m.words("a  b c")) : "(missing)");
    }
    /*
     * 覆盖断言：契约路径合规这一层必须**真跑过**，否则这条冒烟不能算全链路。
     * 两个信号都要有 —— 探针被调用（引擎进了 Stage 3.5）+ 引擎自报"核了 N 条"
     * （真的从任务描述里提取出了可核的点名路径，而不是核了 0 条还打绿）。
     */
    const contractLine = logs.find((l) => String(l).startsWith("契约路径合规：核了"));
    const skipped = logs.some((l) => String(l).includes("没有执行") || String(l).includes("什么都没检查"));
    console.log("contract probe calls:", probeCalls);
    console.log("contract check line:", contractLine ?? (skipped ? "(空转：引擎说这一层没检查)" : "(无)"));
    const covered = probeCalls > 0 && Boolean(contractLine);
    if (!covered) {
      console.log(
        "FAIL: 契约路径合规没有被真正执行 —— 这条冒烟失去覆盖它的意义" +
          `（probeCalls=${probeCalls}，跳过/空转=${skipped}）`,
      );
    }
    process.exit(report.passed && covered ? 0 : 1);
  } finally {
    // Keep the workspace for inspection on failure; clean on success.
    if (process.exitCode === 0) fs.rmSync(root, { recursive: true, force: true });
    else console.log("workspace kept:", root);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
