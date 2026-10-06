/**
 * 门禁：检测「盘上有、但 vitest 根本不收集」的测试文件 —— 从来没跑过的测试。
 *
 * 为什么需要它：本仓库已经踩过一次「漏挂测试文件」（一个模块有两份测试，没被挂上的
 * 那份断言完全不参与判定）。
 *
 * 当初的具体触发点**已经修掉了**：`coverage.include` 含 headless 目录而 `include` 不含，
 * 于是往 headless 下写测试文件会 ① 从不被执行 ② 让覆盖率凭空变高。
 * 现在 `vitest.config.mts:23` 已把 headless 的测试文件纳入 include。
 * （注释里别原样写"星号星号斜杠"这种 glob 片段 —— 它会提前闭合这段块注释，
 *   eslint 已经抓过一次，写这句的我本人就是踩坑的那个人。）
 *
 * ⚠️ 所以这道门禁现在的职责是**守住这个包含关系不被回退**：谁精简 include 精简掉了
 * 某个宿主目录，它会立刻红。（注释曾长期停留在"现在不含 headless" —— 文档过期正是
 * 铁律 1 说的那种系统性风险，本段按 2026-10-04 实测的配置现状重写。）
 *
 * 与 `check-script-wiring.mjs`（写好的脚本没接进入口）是同一族缺陷，差别只是载体不同：
 * 那边是「只跑过一次」，这边是「一次都没跑过」。所以沿用同一套约定：
 * 要么接进收集范围，要么进 ACCEPTED 白名单写清理由。
 *
 * 判定口径：**实际收集集合**，不是"我按 glob 推断它应该被收集"。
 * 收集集合取自 `vitest list --filesOnly`（6s）。这里刻意不自己解析
 * `vitest.config.mts` 的 include 再做 glob 匹配 —— 那样必须重新实现 picomatch 的
 * 语义（`**` 是否跨目录、前导 `./`、Windows 反斜杠），任何一点偏差都会让门禁的
 * 判据与 vitest 的真实行为分叉，而分叉正是本文件要消灭的东西。
 *
 * ⚠️ 收集过程失败必须 FAIL，不能当作"没有未收集项"放过：vitest 起不来时
 * `--filesOnly` 会输出空集合，若把空集合当通过，这道门禁就变成了一个永远绿、
 * 且让人以为"测试文件都挂上了"的摆设（基线失败被静默容忍的同一类空转）。
 *
 * 用法：node scripts/check-tests-collected.mjs
 *       node scripts/check-tests-collected.mjs --list   # 打印每个测试文件的状态
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 测试文件可能出现的目录。`scripts/` 也在内：那里有用 node:test 写的验收套件。 */
const CANDIDATE_DIRS = ["src", "shared", "electron", "headless", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "dist-headless",
  "coverage",
  "release",
  ".git",
  ".ox-quarantine",
]);
const TEST_FILE = /\.test\.(?:ts|tsx|js|mjs|cjs)$/;

/**
 * 已评审、明确接受「不被 vitest 收集」的测试文件。
 *
 * 加项前必须能说清**它靠什么跑**（多数是另一套 runner：node:test、人工验收）。
 * 说不清就该把它挪进 vitest 的 include，而不是加进这里。
 */
const ACCEPTED_ENTRIES = [
  [
    "scripts/acceptance/csvstat-acceptance.test.js",
    "独立验收套件**模板**（见同目录 README）：用 node:test 写的，require 的是被验收项目的 " +
      "scripts/src/{core,report,cli}，本仓库没有那几个文件，它在本仓库里跑不起来；" +
      "由验收方拷进目标项目后手动 `node --test` 跑。它不是本仓库的门禁，是本仓库的样板。",
  ],
];

/** 同 check-script-wiring：`new Map()` 对重复键静默覆盖，理由会凭空消失。 */
const duplicateAccepted = ACCEPTED_ENTRIES.map(([k]) => k).filter((k, i, all) => all.indexOf(k) !== i);
const ACCEPTED = new Map(ACCEPTED_ENTRIES);

const listOnly = process.argv.includes("--list");

// ---- ① 盘上的候选测试文件 -------------------------------------------------
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), out);
      continue;
    }
    if (e.isFile() && TEST_FILE.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const onDisk = CANDIDATE_DIRS.flatMap((d) => collect(path.join(ROOT, d)))
  .map((p) => path.relative(ROOT, p).replace(/\\/g, "/"))
  .sort();

// ---- ② vitest 实际收集的文件 -----------------------------------------------
function runVitestList() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const r = await runVitestList();
const collected = new Set(
  r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // vitest 会打印进度/统计行，只收看起来像路径的行（以某个候选目录开头）
    .filter((l) => CANDIDATE_DIRS.some((d) => l === d || l.startsWith(`${d}/`)))
    .map((l) => l.replace(/\\/g, "/")),
);

const notCollected = onDisk.filter((f) => !collected.has(f));

if (listOnly) {
  console.log("=== 被 vitest 收集 ===");
  for (const f of [...collected].sort()) console.log(`  ${f}`);
  console.log(`\n=== 未被收集（${notCollected.length}）===`);
  for (const f of notCollected) {
    const reason = ACCEPTED.get(f);
    console.log(`  ${f.padEnd(46)} ${reason ? `已接受：${reason}` : "✗ 未接受"}`);
  }
  process.exit(0);
}

// 基线失败先报：收集不到任何文件 == vitest 起不来/配置坏了，此时"未收集 0 个"毫无意义。
if (r.code !== 0 || collected.size === 0) {
  console.error(
    `FAIL: \`vitest list --filesOnly\` 没产出任何文件（exit=${r.code}）—— ` +
      "收集过程本身坏了，本门禁的判定不可用。\n" +
      "不允许把它当成「没有未收集项」放过：那样这道门禁永远绿，而它承诺的事情一件也没查。\n",
  );
  if (r.err.trim()) console.error(r.err.trim().split(/\r?\n/).slice(-15).join("\n"));
  process.exit(1);
}

console.log(`测试文件收集检查：盘上 ${onDisk.length} 个，vitest 收集 ${collected.size} 个`);

if (duplicateAccepted.length > 0) {
  console.error(`\nFAIL: ACCEPTED 里有 ${duplicateAccepted.length} 个重复键 —— Map 静默覆盖，只有一条理由生效：`);
  for (const k of duplicateAccepted) console.error(`  ${k}`);
  process.exit(1);
}

const stale = [...ACCEPTED.keys()].filter((k) => !notCollected.includes(k));
if (stale.length > 0) {
  console.error(
    `\nFAIL: ACCEPTED 里有 ${stale.length} 条已失效（该测试文件已被收集，或已不存在）—— 请删除：`,
  );
  for (const k of stale) console.error(`  ${k}`);
  console.error("\n白名单腐烂比白名单缺失更糟：它会让人以为这里已经被维护过。\n");
  process.exit(1);
}

const unaccepted = notCollected.filter((f) => !ACCEPTED.has(f));
if (unaccepted.length > 0) {
  console.error(`\nFAIL: ${unaccepted.length} 个测试文件 vitest 根本不收集 —— 它们一次都没跑过：`);
  for (const f of unaccepted) console.error(`  ${f}`);
  console.error(
    "\n后果：那里的断言不参与任何判定，而 `coverage.include` 可能仍然统计它的源码目录，\n" +
      "于是覆盖率数字照涨、门禁照绿。\n\n处置二选一：\n" +
      "  1. 让 vitest 收集它 —— 往 `vitest.config.mts` 的 `test.include` 加对应 glob；\n" +
      "  2. 若它靠另一套 runner（node:test / 人工验收）跑，加进本文件的 ACCEPTED 并写明靠什么跑。\n",
  );
  process.exit(1);
}

console.log("\nPASS: 每个测试文件要么被 vitest 收集，要么已显式登记由另一套 runner 执行");

/**
 * ③ 反向缺陷：测试文件**互相 import**。
 *
 * 为什么和"没被收集"放在同一个门禁里：那是一枚硬币的两面 —— 一边是"以为在跑其实没跑"，
 * 另一边是"跑了一遍，却被算成两遍"。本仓库踩过的是后者：`router.test.ts` 写过
 * `import { fakeAgent } from "./agent-registry.test"`，于是收集 router 时连带**执行**
 * agent-registry 的 describe/it，同一批用例注册两次，vitest 报给 router.test.ts 的行数
 * 在 40/45 之间漂（取决于 worker 是否复用到那份模块缓存），而 `Tests N passed` 这个
 * 门禁头条数字被虚报。夹具该住 `src/__fakes__/`（`check-unwired` 已跳过那个目录）。
 *
 * 判定：只认能解析到**盘上某个测试文件**的相对说明符（`./x.test` 会补 .ts/.tsx 再试），
 * 不做字符串包含匹配 —— 否则注释里提一句"见 a.test"就会把门禁弄红。
 */
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const onDiskSet = new Set(onDisk);
const importsTestFile = [];
for (const f of onDisk) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    const spec = m[1];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/\\/g, "/");
    const hit = onDiskSet.has(base)
      ? base
      : EXTENSIONS.map((e) => `${base}${e}`).find((cand) => onDiskSet.has(cand));
    if (hit) {
      importsTestFile.push([f, spec, hit]);
      break; // 一个文件报一次就够，多份只是噪音
    }
  }
}
if (importsTestFile.length > 0) {
  console.error(`\nFAIL: ${importsTestFile.length} 个测试文件 import 了另一个测试文件 —— 被 import 的那份会连带执行，`);
  console.error("      同一批用例被注册两次，`Tests N` 与每个文件的行数都不再可信：");
  for (const [f, spec, hit] of importsTestFile) console.error(`  ${f}  ←  "${spec}"  ⇒  ${hit}`);
  console.error("\n处置：把共享夹具挪进 `src/__fakes__/`（check-unwired 已跳过该目录），两边都从那里 import。\n");
  process.exit(1);
}

/**
 * ④ `*.smoke.test.ts`：必须**仍然**被一个真实条件 `skipIf` 门控。
 *
 * 为什么盯这个（2026-10-05 核实登记项 2）：
 * `npm test` 的头条是 `Tests 1598 passed | 9 skipped`，那 9 个 skip 是 SenseNova
 * 与沙箱内真实 LLM 调用 —— 它们需要 `OX_SMOKE=1` **和**一把真 key，**该**跳过，
 * 这一点不是问题。问题在**没人能证明它还在门控**：把
 * `describe.skipIf(!enabled)` 改成 `describe` 不会让任何门禁变红，只会让
 * `npm test` 变成"跑真 API"，然后在某台有网的机器上开始烧钱或 429 ——
 * 一个"以为在跑、其实没跑"的同族反向缺陷。
 *
 * 判定：文件里有 `skipIf(`，且条件**引用了至少一个进程环境变量**。
 * 只有 `skipIf(true)` 这种写法会被判红 —— 它把"该跑的不跑"伪装成"门控"。
 */
const smokeFiles = onDisk.filter((f) => /\.smoke\.test\.[cm]?[jt]sx?$/.test(f));
const ungated = [];
for (const f of smokeFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const conditions = [...src.matchAll(/skipIf\(\s*([^)]*)\)/g)].map((m) => m[1]);
  if (conditions.length === 0) {
    ungated.push([f, "没有 skipIf —— 该文件会无条件执行真实外部调用"]);
    continue;
  }
  // 条件里必须出现 process.env（允许 `!enabled` 这种间接变量：那行定义处会带 env）
  const mentionsEnv =
    conditions.some((c) => /process\.env/.test(c)) || /process\.env/.test(src);
  if (!mentionsEnv) {
    ungated.push([f, "skipIf 的条件与进程环境无关 —— 门控形同虚设"]);
  }
}
if (ungated.length > 0) {
  console.error(`\nFAIL: ${ungated.length} 个 smoke 测试文件没有真实的 skip 门控：`);
  for (const [f, why] of ungated) console.error(`  ${f}  ${why}`);
  console.error(
    "\n这些文件打真实外部 API（SenseNova / LLM 端点）。门控失效不会让任何门禁变红，\n" +
      "只会让 `npm test` 在有网的机器上开始消耗真实额度或被 429。\n" +
      "处置：用 `describe.skipIf(!enabled)` 门控，且 `enabled` 必须由 `process.env.OX_SMOKE`\n" +
      "      与 key 是否存在共同决定。\n",
  );
  process.exit(1);
}
console.log(
  `PASS: ${smokeFiles.length} 个 smoke 测试文件均受 process.env 门控（默认 npm test 不出网）`,
);
console.log("  跨测试文件 import：0 处（夹具没让用例重复注册）");
