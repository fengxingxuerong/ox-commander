/**
 * 门禁：文档里那几个「N 段」「N 通过 + M 跳过」必须是**当场算得出来**的数。
 *
 * 为什么需要它（2026-10-06 实测到的漂移）：本仓的验收口径写在三个地方
 * （README 门禁节、`references/gates.md` 逐段表、`SKILL.md` 段数），而它们**没有任何
 * 判据在看**。实测证据：`package.json` 的 verify 串已经是 26 段，README 与 gates.md
 * 还写着 23 段；`npm test` 现跑 1694 通过，README 还写 1589。同一批未提交改动新接进
 * 链里的 3 段（`check:field-orphans` / `check:ipc-channels` / `check:mutation-targets`）
 * 在 gates.md 的表里**一行都没有** —— 与 2026-10-03 那次「smoke:target-range 进了串
 * 却不在表里」是同一个缺陷的第三次复发。
 *
 * `SKILL.md` 把这件事写成纪律（「碰 verify 链必须同改四处」），但**纪律没有判据就会漂**，
 * 而且漂的方向特别坏：数字看起来比实际强，读文档的人以为门禁比代码严。
 *
 * 判定（三条，全部以命令输出为真值，不以人抄的数为真值）：
 *   1. 段数：`package.json` 里 verify 切出的段数，必须等于三份文档里**每一处**段数声明
 *      （排除「第 N 段」这种序数引用与「B-1 段」这种名字碎片）
 *   2. 逐段有名：verify 链里每一段的 npm script 名，必须在 README 与 gates.md 里都被提到
 *      —— 这条抓的是「进了串但清单漏行」，比第 1 条更常犯
 *   3. 用例数：文档声明的「A 通过 + B 跳过」必须在两份文档里一致，且 A 必须等于
 *      `vitest list` 当场收集到的用例数（可选 companions：合计 == A+B、
 *      文件数 == list 输出里的不同文件数）
 *
 * ⚠️ 第 2 条的口径是**全文提到**，不是「门禁节里有一行」。后者要把判据绑在版式上，
 * 而版式正是最常改的东西。全文提到已经足以抓住真正的那件事：新段完全没人写。
 *
 * ⚠️ 段名按 **token 边界**匹配，不用纯 `includes`：`build` 是 `build:headless` 的前缀，
 * 纯包含匹配会让只写了后者的文档被判成「两段都有行」。与 check-script-wiring.mjs
 * 2026-10-05 那次改严是同一个坑（「脚本名不再被别家名字的后缀洗白」）。
 *
 * ⚠️ 读不到任何一处声明必须 FAIL，不能当作「没有不一致」放过 —— 与
 * `check-tests-collected.mjs` / `check-ipc-channels.mjs` 同一纪律：文档措辞一改而正则
 * 解析不到，这道门禁就变成永远绿的摆设，而它承诺的恰好是「这些数字不会骗人」。
 *
 * ⚠️ 口径：第 3 条以**默认配置**（不带 `OX_SMOKE`）为准。带 `OX_SMOKE=1` 加真 key 跑时
 * 那些真实 API 用例会进收集集合，文档数字必然对不上 —— 那不该被读成「文档错了」，
 * 所以本门禁在那种配置下直接 FAIL 并说明原因，而不是去猜「应该匹配哪个数」。
 *
 * 用法：node scripts/check-doc-claims.mjs             （有漂移时 exit 1）
 *       node scripts/check-doc-claims.mjs --selftest   （判据自身的用例，verify 里带这个）
 *       node scripts/check-doc-claims.mjs --list       （打印各处声明与实物）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 声明段数的文档。SKILL.md 也在内：它是给 agent 的工作手册，同样会漂。 */
const SEGMENT_DOCS = [
  "README.md",
  ".qoder/skills/ox-commander-dev/references/gates.md",
  ".qoder/skills/ox-commander-dev/SKILL.md",
];

/** 承载逐段清单的文档 —— 每一段都得在这里有行。 */
const CHECKLIST_DOCS = ["README.md", ".qoder/skills/ox-commander-dev/references/gates.md"];

/** 承载用例数声明的文档。 */
const COUNT_DOCS = ["README.md", ".qoder/skills/ox-commander-dev/references/gates.md"];

const PASS_RE = /(\d+)\s*通过\s*\+\s*(\d+)\s*跳过/;
const TOTAL_RE = /合计\s*(\d+)\s*条/;
const FILES_RE = /(\d+)\s*个有可执行用例的文件/;

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

const readDoc = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(`读不到 ${rel} —— 判据失配（文档被改名或移动？）`);
  return fs.readFileSync(p, "utf8");
};

/**
 * verify 链的段（真值来源 = package.json，不是文档）。
 *
 * `npm test` 在链里是不带 run 的那一段，段名归一化成 `test`。
 */
function verifyChain() {
  const pkg = JSON.parse(readDoc("package.json"));
  const chain = String(pkg.scripts?.verify ?? "");
  if (chain.trim() === "") fail("package.json 里没有 verify —— 唯一验收入口不存在，本门禁判据坏了");
  const segs = chain
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) fail("verify 串切出 0 段 —— 判据失配（串联写法变了？）");
  return segs;
}

function segmentName(seg) {
  if (seg === "npm test") return "test";
  return seg.replace(/^npm\s+run\s+/, "").trim();
}

/**
 * 抽取段数声明。两个排除项都是实测踩出来的，不是想象中的：
 *   - 「第 9 段 vitest」（README）与「verify 第 1 段就是它」（SKILL.md）是**序数引用**，
 *     不是段数声明；
 *   - 「多出 B-1 段串行」（README 里 zone:cost 的输出示例）紧贴着「段」的是数字 1，
 *     按纯数字匹配会把它当成一处声明 —— 那样这条门禁第一天就红得没道理。
 * 所以数字前面既不能是「第」，也不能是词字符 / `-` / `.`（那说明它是某个名字的一部分）。
 */
function segmentClaims(text) {
  const out = [];
  for (const m of text.matchAll(/(\d+)\s*段/g)) {
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    if (/第\s*$/.test(before)) continue;
    if (/[\w.-]\s*$/.test(before)) continue;
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * 段名 → 文档里可接受的写法。
 *
 * `test` 这一段在两份清单里都写作 vitest（读者认的是 runner 名，不是 npm script 名），
 * 所以给它一个别名而不是改文档。别名表必须保持小：每加一条，就是把「文档里根本没提这段」
 * 变成一次静默放过。
 */
const NAME_ALIASES = { test: ["test", "vitest"] };

/** 词字符与 `-` `.` `:`：段名本身含冒号，所以冒号也要当边界的一部分排除掉。 */
const TOKEN_EDGE = /[\w.:-]/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `name` 在 `text` 里是否作为**完整 token** 出现（不是别名的前缀或后缀）。 */
function mentions(text, name) {
  const re = new RegExp(`(\\P{L}|^)${escapeRe(name)}(?![\\w.:-])`, "gu");
  for (const m of text.matchAll(re)) {
    const at = m.index + m[1].length;
    const before = text.slice(at - 1, at);
    if (before && TOKEN_EDGE.test(before)) continue;
    const after = text.slice(at + name.length, at + name.length + 1);
    if (after && TOKEN_EDGE.test(after)) continue;
    return true;
  }
  return false;
}

function mentionsSegment(text, name) {
  return (NAME_ALIASES[name] ?? [name]).some((f) => mentions(text, f));
}

/** 数一遍 `vitest list` 的真实收集结果（不执行用例，实测约 4s）。 */
function listCollected() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "list"],
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

/** 从 list 输出里算出「可执行用例数」与「有可执行用例的文件数」。 */
function parseList(out) {
  const files = new Set();
  let tests = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.*\.test\.[A-Za-z0-9]+)\s*>/.exec(line.trim());
    if (!m) continue;
    tests += 1;
    files.add(m[1].replace(/\\/g, "/"));
  }
  return { tests, files: files.size };
}

const args = process.argv.slice(2);
const listMode = args.includes("--list");
const selfTest = args.includes("--selftest");

// ---- 判据自身的用例：抽取 / 排除 / 边界 / 算术 -------------------------------
if (selfTest) {
  const claimCases = [
    ["本机实测 EXIT 0，**23 段**", [23]],
    ["# 逐段机制（26 段）", [26]],
    ["症状是第 9 段 vitest 堆涨", []],
    ["verify 第 1 段就是它", []],
    ["相对全并行多出 B-1 段串行", []],
    ["本表停在「23」这个旧数", []],
    ["README 与本表都停在 23 段", [23]], // 陷阱示范：叙述历史也会被抓，所以历史数字要加引号
    ["20 个 npm run 段 串联", []],
    ["**27 段**，以及（27 段）", [27, 27]],
    ["1 段 2 段", [1, 2]],
  ];
  const mentionCases = [
    ["→ check:residue（首段，卫生预检）", "check:residue", true],
    ["| 0 | `check:residue` |", "check:residue", true],
    ["这里什么都没提", "check:residue", false],
    ["→ vitest（现跑 1694 通过）", "test", true],
    ["| 12 | `test` | vitest run |", "test", true],
    // ---- 关键三条：短名不被长名的前后缀洗白 ----
    ["npm run build:headless 已经跑过", "build", false],
    ["npm run build:headless", "build:headless", true],
    ["→ vite build + tsc headless 构建", "build", true],
    ["只有 mutation-check.mjs 提到它", "mutation", false],
    ["mutation:quick 与 mutation 都写了", "mutation", true],
    ["check:scripts / check:scripts-wired 两道", "check:scripts", true],
    ["check:scripts / check:scripts-wired 两道", "check:scripts-wired", true],
  ];
  const countCases = [
    ["2026-10-06 实测 1694 通过 + 9 跳过", { passed: 1694, skipped: 9 }],
    ["**1694 通过 + 9 跳过**", { passed: 1694, skipped: 9 }],
    ["没有数字的措辞", null],
  ];
  const totalCases = [
    ["1694 通过 + 9 跳过，合计 1703 条", 1703],
    ["1694 通过 + 9 跳过（没有合计）", null],
  ];
  const listCases = [
    ["a.test.ts > s > n\nb.test.ts > m\nb.test.ts > n\n", { tests: 3, files: 2 }],
    ["没有一行像用例\n", { tests: 0, files: 0 }],
    ["src/x.test.ts > 顶层用例\nsrc/x.test.ts > 另一条\n", { tests: 2, files: 1 }],
    ["src\\x.test.ts > s > n\n", { tests: 1, files: 1 }],
  ];

  let bad = 0;
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const [text, want] of claimCases) {
    const got = segmentClaims(text);
    if (!eq(got, want)) {
      bad += 1;
      console.error(`  ✗ segmentClaims(${JSON.stringify(text)}) = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
    }
  }
  for (const [text, name, want] of mentionCases) {
    const got = mentionsSegment(text, name);
    if (got !== want) {
      bad += 1;
      console.error(`  ✗ mentionsSegment(…, ${name}) = ${got}，期望 ${want} —— 原文 ${JSON.stringify(text)}`);
    }
  }
  for (const [text, want] of countCases) {
    const m = PASS_RE.exec(text);
    const got = m ? { passed: Number(m[1]), skipped: Number(m[2]) } : null;
    if (!eq(got, want)) {
      bad += 1;
      console.error(`  ✗ 通过+跳过解析 ${JSON.stringify(text)} = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
    }
  }
  for (const [text, want] of totalCases) {
    const m = TOTAL_RE.exec(text);
    const got = m ? Number(m[1]) : null;
    if (got !== want) {
      bad += 1;
      console.error(`  ✗ 合计解析 ${JSON.stringify(text)} = ${got}，期望 ${want}`);
    }
  }
  for (const [out, want] of listCases) {
    const got = parseList(out);
    if (!eq(got, want)) {
      bad += 1;
      console.error(`  ✗ parseList = ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
    }
  }
  if (bad > 0) {
    console.error(
      "\nFAIL: 判据自测有出入 —— 抽取、排除、token 边界、算术任一失配，后面的判定都不可信。\n",
    );
    process.exit(1);
  }
  const n =
    claimCases.length +
    mentionCases.length +
    countCases.length +
    totalCases.length +
    listCases.length;
  console.log(
    `PASS: 判据自测 ${n} 例（「第 N 段」与「B-1 段」不算声明；短名不被长名洗白；算术与收集解析）`,
  );
}

// ---- ① 段数：package.json 是真值，三份文档的每一处声明都要相等 ---------------
const chain = verifyChain();
const names = chain.map(segmentName);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) {
  // 同一段出现两次会让段数算多，而清单里只会有一行提到它 —— 先钉住这件事本身。
  fail(`verify 串里有重复段：${[...new Set(dupes)].join(", ")} —— 段数与逐段清单都失去意义`);
}

const claimByDoc = new Map();
for (const rel of SEGMENT_DOCS) {
  const claims = segmentClaims(readDoc(rel));
  if (claims.length === 0 && !listMode) {
    fail(`${rel} 里解析不到任何段数声明 —— 判据失配（措辞改了？）。不许当作「没有不一致」放过。`);
  }
  claimByDoc.set(rel, claims);
}

const staleSeg = [];
for (const [rel, claims] of claimByDoc) {
  for (const c of claims) if (c !== chain.length) staleSeg.push(`${rel} 声明 ${c} 段`);
}

// ---- ② 逐段有名：链里每一段都要在两处清单里出现 ------------------------------
const missing = [];
for (const rel of CHECKLIST_DOCS) {
  const text = readDoc(rel);
  for (const n of names) if (!mentionsSegment(text, n)) missing.push(`${rel} ← 缺 ${n}`);
}

// ---- ③ 用例数：两份文档一致，且通过数等于现跑收集数 --------------------------
const counts = [];
for (const rel of COUNT_DOCS) {
  const text = readDoc(rel);
  const m = PASS_RE.exec(text);
  if (!m) {
    // --list 是维护工具：它自己判红就没法用来诊断了，所以只记录「读不到」。
    if (listMode) {
      counts.push({ rel, passed: null, skipped: null, total: null, files: null });
      continue;
    }
    fail(`${rel} 里解析不到「A 通过 + B 跳过」声明 —— 判据失配，不许当通过放过。`);
  }
  const t = TOTAL_RE.exec(text);
  const f = FILES_RE.exec(text);
  counts.push({
    rel,
    passed: Number(m[1]),
    skipped: Number(m[2]),
    total: t ? Number(t[1]) : null,
    files: f ? Number(f[1]) : null,
  });
}

let live = null;
if (!listMode) {
  const r = await listCollected();
  if (r.code !== 0) {
    fail(`\`vitest list\` 退出码 ${r.code} —— 收集本身失败，用例数真值不可用：\n${r.err.slice(-800)}`);
  }
  live = parseList(r.out);
  if (live.tests === 0) {
    fail("`vitest list` 一条用例都没列出 —— 收集过程坏了。空集合不等于「数字都对」。");
  }
  if (process.env.OX_SMOKE === "1") {
    fail(
      "本门禁以默认配置为口径：OX_SMOKE=1 时真实 API 用例也会被收集，" +
        "文档声明必然与收集数不符。请用默认配置跑 verify（文档数字记的就是默认口径）。",
    );
  }
}

if (listMode) {
  console.log(`verify 链：${chain.length} 段`);
  for (const [rel, claims] of claimByDoc) console.log(`  ${rel.padEnd(54)} 声明 ${claims.join("/")}`);
  console.log(`\n缺行的段（${missing.length}）：`);
  for (const m of missing) console.log(`  ${m}`);
  console.log("\n用例数声明：");
  for (const c of counts) console.log(`  ${c.rel.padEnd(54)} ${JSON.stringify(c)}`);
  console.log(`\n段名清单：\n${names.map((n, i) => `  ${String(i).padStart(2)} ${n}`).join("\n")}`);
  process.exit(0);
}

// ---- 判定汇总：几类不一致一起报，别让人改一处跑一次 --------------------------
const problems = [];

for (const p of staleSeg) {
  problems.push(`【段数】${p}，而 package.json 的 verify 串实为 ${chain.length} 段`);
}

for (const m of missing) problems.push(`【漏行】${m} —— 这一段进了串，清单里没有它`);

const [readmeClaims, gateClaims] = counts;
if (readmeClaims.passed !== gateClaims.passed || readmeClaims.skipped !== gateClaims.skipped) {
  problems.push(
    `【不一致】README 声明 ${readmeClaims.passed}+${readmeClaims.skipped}，` +
      `gates.md 声明 ${gateClaims.passed}+${gateClaims.skipped}`,
  );
}
for (const c of counts) {
  if (c.total !== null && c.total !== c.passed + c.skipped) {
    problems.push(`【算术】${c.rel} 的合计 ${c.total} 不等于 ${c.passed} + ${c.skipped}`);
  }
  if (c.passed !== live.tests) {
    problems.push(
      `【用例数】${c.rel} 声明 ${c.passed} 通过，而 \`vitest list\` 现跑收集到 ${live.tests} 条可执行用例`,
    );
  }
  if (c.files !== null && c.files !== live.files) {
    problems.push(`【文件数】${c.rel} 声明 ${c.files} 个有可执行用例的文件，现跑是 ${live.files} 个`);
  }
}

if (problems.length > 0) {
  console.error(
    `\nFAIL: 文档声明的门禁数字与实物不符（${problems.length} 处）——\n` +
      "      这类漂移的方向是「数字看起来比实际强」，读文档的人会以为门禁比代码严：\n",
  );
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n处置：改文档，让数字等于实物。真值来自这几条命令，不是上一版文档：\n" +
      "  段数 = package.json 里 verify 切出的段数；\n" +
      "  用例数 = 默认配置下 `npx vitest list` 的输出行数；\n" +
      "  文件数 = 那些行里不同的 *.test.* 文件名个数。\n" +
      "若是往链里加了新段：README 门禁节、references/gates.md 逐段表、SKILL.md 的段数\n" +
      "必须同批改（SKILL.md 的四同步规则）—— 本门禁就是把那条纪律接上电的那一半。\n" +
      "⚠️ 讲历史时别把旧数字紧贴「段」字（「停在 23 段」会被读成一处声明 —— 判据分不清\n" +
      "   你在陈述实物还是在回顾历史，所以统一写成「停在「23」这个旧数」）。\n",
  );
  process.exit(1);
}

console.log(
  `PASS: 门禁数字与实物一致 —— ${chain.length} 段在三份文档的每一处声明都相等，` +
    `每段在 README 与 gates.md 都被提到，用例数 ${live.tests}（${live.files} 个文件有可执行用例）`,
);
