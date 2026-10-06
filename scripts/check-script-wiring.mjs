/**
 * 门禁：检测「写在 scripts/ 但不在任何自动入口」的脚本 —— 只跑过一次的测试。
 *
 * 为什么需要它：`admission-gateway-it.mjs`（12 例）与 `coze-bridge-it.mjs` 的提交
 * 信息都写着「IT 全绿」，但那是**手动跑的** —— package.json 里没有入口，verify 里
 * 也没有，全仓 grep 唯一的引用是它们自己的用法注释。测试是真的、也真通过过，
 * 于是读提交信息的人会以为有门禁，而**改坏之后不会有任何东西变红**。
 *
 * 与「CI 里路径写错、从来没跑过的 job」同族：差别只是「从来没跑」vs「只跑过一次」，
 * 后果完全一样。本脚本把这件事变成 FAIL，逼作者在「接进入口」和「显式接受」之间选。
 *
 * 判定口径（**可达性**，不是"有没有人引用"）：
 *   - 以 package.json 的 npm scripts 入口为起点，沿「脚本引用脚本」的边做可达性分析
 *   - 可达 → 已接入；不可达 → 未接入，必须在 ACCEPTED 白名单里附理由
 *   - 文档（README、docs/）里的提及**不算接入** —— 那不构成任何自动执行
 *
 * ⚠️ 为什么必须用可达性而不是「有没有人引用」：`loomy-bridge.mjs` 被
 * `run-multiagent-e2e.mjs` 引用、`smoke-fullchain.mjs` 被 `gen-repair-smoke.cjs`
 * 引用 —— 单看"有引用者"它们都算已接入，**而这两个引用者自己也不在入口**。
 * 链条在中间就断了，整条链依然是"只跑过一次"。首版就是栽在这里。
 *
 * ⚠️ 本文件**不参与「引用者」扫描**：白名单的键就是脚本文件名，若本文件被当作
 * 引用者，白名单里每一条都会「证明」自己已被引用 —— 门禁当场形同虚设。
 *
 * 用法：node scripts/check-script-wiring.mjs   （有新增未接入项时 exit 1）
 *       node scripts/check-script-wiring.mjs --list   # 打印每个脚本的当前状态
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "check-script-wiring.mjs";

/**
 * 已评审、明确接受「不在自动入口」的脚本。
 *
 * 加项前必须能说清**它为什么不该进 verify**（多数是环境依赖：需要真实凭据、
 * 真实外部服务、或长跑靶场）。说不清就该接进入口，而不是加进这里。
 */
const ACCEPTED_ENTRIES = [
  ["marvis-bridge.mjs", "外部智能体桥，需对方真实服务在跑；由操作员手动启动"],
  ["run-multiagent-e2e.mjs", "长跑端到端（--max-minutes 可配），需真实 LLM 凭据，人工验收用"],
  ["probe-endpoints.cjs", "诊断工具，探测外部端点连通性，非验收判据"],
  ["gen-repair-smoke.cjs", "生成器：产出 smoke-repair / smoke-fullchain 的用例，人工按需运行"],
  // 下面两条曾被误标为「已被取代，待清理」—— 那是凭脚本名推断的，实际读完才知：
  // bridge-smoke 验的是**跨项目**桥接（DSH 插件 → headless runner），
  // smoke-e2e 用的是 dist-electron 真实引擎 + 真实凭据。两者都不可被别的脚本替代。
  ["smoke-e2e.mjs", "真实凭据端到端（加载 .env，走 dist-electron 的 Engine/Scheduler/verifier）"],
  ["bridge-smoke.mjs", "跨项目桥接冒烟：DSH 插件（外部仓库 dsh-oxcommander）→ headless runner"],
  ["smoke-fullchain.mjs", "全链路冒烟，需真实凭据；被 gen-repair-smoke.cjs 生成后人工跑（引用者自己也不在入口）"],
  ["smoke-repair.mjs", "重修循环冒烟，同上"],
  [
    "doc-claims-injection.mjs",
    "check:doc-claims 的判据体检（注入若干条 + 正向对照，条数由脚本自己打印）：它会**临时改写** README / gates.md / " +
      "package.json 再在 finally 里还原 —— 接进 verify 就等于让门禁链自己制造脏文档现场，" +
      "被强杀时下一段读到的就是注入后的内容。改完那条判据手动跑一次；中断后的现场由它自己的" +
      "正向对照抓（不注入必须绿，否则先报错再停手）",
  ],
  [
    "loomy-bridge.mjs",
    "外部智能体桥，需对端服务在跑（启动方式记在 agents.d/onboarding-universal.md）；" +
      "它被 run-multiagent-e2e.mjs 引用，而该 runner 同样只在人工验收时跑 —— 链条未接到入口",
  ],
];

/**
 * 先查重再建 Map：`new Map()` 对重复键是**静默覆盖**，被盖掉的那条理由就此消失，
 * 而门禁本身看不见（它只读 Map）。本文件的旧版就同时登记过两次 loomy-bridge.mjs。
 */
const duplicateAccepted = ACCEPTED_ENTRIES.map(([name]) => name).filter(
  (name, i, all) => all.indexOf(name) !== i,
);
const ACCEPTED = new Map(ACCEPTED_ENTRIES);

const listOnly = process.argv.includes("--list");

// ---- 收集 scripts/ 下的所有可执行脚本 --------------------------------------
const SCRIPT_DIR = path.join(ROOT, "scripts");
function collectScripts(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectScripts(p, out);
    else if (/\.(mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const scripts = collectScripts(SCRIPT_DIR).sort();

// ---- ① npm scripts 入口 ----------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const npmWired = new Set();
for (const cmd of Object.values(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/scripts[\\/]([\w.-]+\.(?:mjs|cjs))/g)) npmWired.add(m[1]);
}

// ---- ② 脚本之间的引用边 ----------------------------------------------------
// 只读 scripts/ 目录：文档与 README 的提及不构成自动执行，刻意不计入。
const names = new Set(scripts.map((p) => path.basename(p)));

/**
 * Comment-only stripper for this gate.
 *
 * ⚠️ Deliberately NOT `maskNonCode`: that masker blanks **string literals** too,
 * which is right for counting mutation sites but wrong here — a script really is
 * wired when it does `spawn(node, [path.join(root, "scripts", "x.mjs")])`, and
 * that name lives in a string literal. Masking it turned all three IT scripts
 * into false "orphan" reports (2026-10-05 measured: `admission-gateway-it` →
 * `admission-gateway.mjs` is masked away entirely).
 *
 * So: blank **comments only**, keep strings. What that removes is the real
 * leak — a doc comment saying "see also x.mjs" while nothing ever calls it.
 * Measured 17 comment-only edges, of which the misleading family is exactly this.
 *
 * Written here (rather than reusing the gate's masker) because the two gates
 * need opposite treatment of strings; a shared "blank comments" helper was not
 * worth a third file. The comment-only scanner is simple enough to state here:
 * it must not confuse `//` inside a string with a line comment, nor `/*` in a
 * regex or a URL.
 */
function blankComments(text) {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip the whole literal so `//` and `/*` inside it are not taken as comments.
      i += 1;
      while (i < n && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const sources = scripts
  .filter((p) => path.basename(p) !== SELF) // 见文件头「⚠️」：本文件必须排除
  .map((p) => {
    const text = fs.readFileSync(p, "utf8");
    return { name: path.basename(p), text, masked: blankComments(text) };
  });

/**
 * `text` 里是否**作为一个完整脚本名**提到 `name`。
 *
 * 原来是纯 `includes`，方向是**漏报**：`heck.mjs` 是孤儿，但 "mutation-check.mjs"
 * 里含 "heck.mjs" 这一段，于是它被打成"已接入" —— 名字是别家名字后缀的脚本
 * 全都洗白。门禁绿着、孤儿一直没人管，比误报更隐蔽（误报会当场红，漏报不会）。
 * 所以按边界判：命中位置的前后都不能是名字里会出现的字符（字母数字 _ - .）。
 */
const NAME_CHAR = /[\w.-]/;
function mentions(text, name) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = text.slice(at - 1, at);
    const after = text.slice(at + name.length, at + name.length + 1);
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
    from = at + 1;
  }
}

// 判据自身的自测（门禁的判据也要有判据）：改严那次就是靠这几条钉住"边界"的
// 语义 —— 纯子串版本会漏掉"名字是别家名字后缀"的孤儿，而那种漏报不会当场红。
if (process.argv.includes("--selftest")) {
  const cases = [
    ["node scripts/mutation-check.mjs --audit", "mutation-check.mjs", true],
    ["mutation-check.mjs", "heck.mjs", false], // 后缀命中：漏报的原型
    ["foo-check.mjs", "check.mjs", false], // 前面是 -（别家名字的一部分）
    ["check.mjs", "check.mjs", true], // 整串就是它
    ["check.mjs.bak", "check.mjs", false], // 后面是 .（.bak 不是脚本名）
    ["mycheck.mjs", "check.mjs", false], // 前面是字母
    ["`check.mjs`", "check.mjs", true], // 反引号是边界
    ["scripts/check.mjs\nscripts/other.mjs", "other.mjs", true],
    // ---- 注释不是接线，字符串是接线（2026-10-05 补）----
    ["// 参见 check.mjs\nconst x = 1;", "check.mjs", false], // 注释里提到 = 没接
    ["/* 见 check.mjs */\nconst x = 1;", "check.mjs", false],
    ["spawn(node, [path.join(root, 'scripts', 'check.mjs')]);", "check.mjs", true], // 字符串里 = 真接
    ["const u = 'http://x'; // 注释里有 check.mjs", "check.mjs", false], // // 在字符串里不算行注释
    ["const s = '/*'; // 注释里有 check.mjs", "check.mjs", false], // /* 在字符串里不算块注释
  ];
  let bad = 0;
  for (const [text, name, want] of cases) {
    // 判据链完整跑一遍：先按边界切名字，再在**去注释**后的文本上找 ——
    // 这样这些用例同时钉住"边界"与"注释不算接线"两件事。
    const got = mentions(blankComments(text), name);
    if (got !== want) {
      bad += 1;
      console.error(`  ✗ mentions(blankComments(${JSON.stringify(text)}), ${name}) = ${got}，期望 ${want}`);
    }
  }
  if (bad > 0) {
    console.error(`FAIL: 边界匹配自测 ${bad}/${cases.length} 例不符`);
    process.exit(1);
  }
  console.log(
    `PASS: 边界匹配自测 ${cases.length} 例（名字不再被别家名字的后缀洗白；注释里的提及不算接线）`,
  );
}

/** name → 它引用的其他脚本名（只看**可执行代码**里的提及） */
const edges = new Map();
for (const s of sources) {
  edges.set(s.name, [...names].filter((t) => t !== s.name && mentions(s.masked, t)));
}

// ---- ③ 从 npm 入口做可达性分析 ---------------------------------------------
const reachable = new Set();
const via = new Map(); // name → 到达它的上一层（用于报告链条）
const queue = [...npmWired].filter((n) => names.has(n));
for (const n of queue) via.set(n, "npm scripts");
while (queue.length > 0) {
  const cur = queue.shift();
  if (reachable.has(cur)) continue;
  reachable.add(cur);
  for (const next of edges.get(cur) ?? []) {
    if (!reachable.has(next) && !via.has(next)) via.set(next, cur);
    if (!reachable.has(next)) queue.push(next);
  }
}

const wired = [];
const orphans = [];
for (const n of [...names].sort()) {
  if (n === SELF) continue; // 门禁自身由 verify 直接调用
  if (reachable.has(n)) wired.push({ name: n, via: via.get(n) ?? "npm scripts" });
  else orphans.push(n);
}

if (listOnly) {
  console.log("=== 已接入 ===");
  for (const w of wired) console.log(`  ${w.name.padEnd(32)} ${w.via}`);
  console.log(`\n=== 未接入（${orphans.length}）===`);
  for (const n of orphans) {
    const reason = ACCEPTED.get(n);
    console.log(`  ${n.padEnd(32)} ${reason ? `已接受：${reason}` : "✗ 未接受"}`);
  }
  process.exit(0);
}

const unaccepted = orphans.filter((n) => !ACCEPTED.has(n));
const stale = [...ACCEPTED.keys()].filter((n) => !orphans.includes(n));

console.log(
  `scripts 接线检查：${scripts.length} 个脚本，已接入 ${wired.length}，` +
    `已接受未接入 ${orphans.length - unaccepted.length}，未接受 ${unaccepted.length}`,
);

// 白名单自身的完整性先查：重复键在 Map 里是静默覆盖，第二条理由会顶掉第一条，
// 于是"评审过的理由"变成另一条 —— 没有任何信号。
if (duplicateAccepted.length > 0) {
  console.error(`\nFAIL: ACCEPTED 里有 ${duplicateAccepted.length} 个重复键 —— Map 静默覆盖，只有一条理由生效：`);
  for (const n of duplicateAccepted) console.error(`  ${n}`);
  console.error("\n处置：把两条理由合并成一条，而不是删掉其中一条。\n");
  process.exit(1);
}

// 白名单过期同样要报：条目指向已接线的脚本（或已删除的脚本）说明白名单在腐烂，
// 而腐烂的白名单会让下一个人以为"这里有人管过"。
if (stale.length > 0) {
  console.error(
    `\nFAIL: ACCEPTED 里有 ${stale.length} 条已失效（脚本已接入或已不存在）—— 请删除：`,
  );
  for (const n of stale) console.error(`  ${n}`);
  console.error("\n白名单腐烂比白名单缺失更糟：它会让人以为这里已经被维护过。\n");
  process.exit(1);
}

if (unaccepted.length > 0) {
  console.error(`\nFAIL: ${unaccepted.length} 个脚本不在任何自动入口 —— 它们只会在手跑时通过：`);
  for (const n of unaccepted) console.error(`  scripts/${n}`);
  console.error(
    "\n处置二选一：\n" +
      "  1. 接进入口 —— package.json 加 npm script 并挂进 verify（若耗时可控）；\n" +
      "  2. 若确实需要人工运行（真实凭据 / 外部服务 / 长跑），加进本文件的 ACCEPTED 并写明理由。\n" +
      "不允许静默存在：提交信息写「全绿」而实际没人跑，比没有测试更误导。\n",
  );
  process.exit(1);
}

console.log("\nPASS: 所有脚本要么在自动入口内，要么已显式接受人工运行");
