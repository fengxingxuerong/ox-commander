/**
 * Regenerates `SITE_BASELINE` in `scripts/mutation-check.mjs`.
 *
 * The baseline is the set of per-target site counts that a full `--mode=site`
 * audit has covered. `--mode=site` compares against it so that **adding code
 * with new mutation sites cannot silently pass**: new sites are reported as
 * unreviewed until someone runs this script and commits the new counts.
 *
 * Usage:
 *   node scripts/site-baseline.mjs --write    # rewrite the constant in place
 *   node scripts/site-baseline.mjs            # report drift, exit 1 if drifted
 *   node scripts/site-baseline.mjs --selftest # 先自测"写回"这一步，再照常报漂移
 *                                             # （verify 的 `mutation:baseline` 带这个）
 *
 * Exits 1 on drift when not writing — that is the point: `npm run mutation:site`
 * (and CI's `mutation-full` job) is what proves each site individually, so a
 * count that moved without a fresh audit means the proof is stale.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "mutation-check.mjs");
const write = process.argv.includes("--write");

/**
 * 变异在跑时，本脚本算出来的位点数**不是真值** —— 它读的正是被改着的源码。
 *
 * 不是假想：2026-10-16 在 tier 2 全量跑的途中跑 `check:doc-claims`，它内部的
 * `site-baseline.mjs --json` 读到变异体，报「SITE_BASELINE 已漂移 1 处」。
 * 那 1 处是假象；真正的害处在下一步 —— 人照着提示去 `--write`，把变异体的
 * 位点当真值写进基线，基线从此被污染，而且污染得很安静。
 *
 * 所以这里不是"提示一下"，是拒绝算，`--write` 更要拒。
 *
 * 判据：`.orig` 备份在 ⇒ 变异体正在生效（源码与 git 不一致）。
 * 目录与 `mutation-check.mjs` 的 `PENDING_DIR` 是同一个：
 * `scripts/.mutation-pending`。两处各写一份路径字符串不是好做法，但
 * mutation-check.mjs 顶层自执行（import 它会把整轮变异跑起来），抽不成共享模块；
 * 这份常量即使失配，最坏也只是退回"报假漂移"，不会给出错误结论。
 */
const PENDING_DIR = path.join(HERE, ".mutation-pending");

function mutationBackupAlive(pendingDir, io = { existsSync, readdirSync }) {
  return io.existsSync(pendingDir) && io.readdirSync(pendingDir).some((n) => n.endsWith(".orig"));
}

if (mutationBackupAlive(PENDING_DIR)) {
  console.error(
    "FAIL: 检测到存活的变异台账（scripts/.mutation-pending 里有 .orig）—— 源码此刻正被变异改动。\n" +
      "  这时算出的位点数不是真值，任何\"漂移\"都是假象；照它 --write 会把变异体的位点写进基线。\n" +
      "  处置：先 `npm run check:residue` 确认没有真残留（若另一轮确实在跑，等它跑完），再重跑本命令。",
  );
  process.exit(2);
}

const src = readFileSync(GATE, "utf8");

/**
 * Slices a top-level `const NAME = [...]` declaration out of the gate source.
 *
 * Bracket matching, not string search: `TARGETS` entries contain nested arrays,
 * object literals and comments that themselves contain `];`, so "find the next
 * `\n];`" lands in the middle of the array and yields a syntax error. Track
 * depth while skipping strings, template literals and comments.
 */
function sliceTopLevelArray(source, constName) {
  const decl = `const ${constName} = [`;
  const start = source.indexOf(decl);
  if (start < 0) return null;
  const bodyStart = start + decl.length;
  let depth = 1;
  let i = bodyStart;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  return null;
}

// Reuse the gate's own TARGETS list rather than duplicating it.
const targetsBlock = sliceTopLevelArray(src, "TARGETS");
if (!targetsBlock) {
  console.error("无法在 mutation-check.mjs 里定位 TARGETS（常量不存在或格式变了）");
  process.exit(2);
}
const { TARGETS } = new Function(`${targetsBlock}\nreturn { TARGETS };`)();

/** Count sites per target using the gate's own masker + operator list. */
const opBlock = sliceTopLevelArray(src, "OPERATORS");
const maskStart = src.indexOf("function regexMayStartAt");
const maskEnd = src.indexOf("/** 1-based 行号。 */");
if (!opBlock || maskStart < 0 || maskEnd < 0) {
  console.error("无法在 mutation-check.mjs 里定位算子/掩空函数");
  process.exit(2);
}
const { maskNonCode } = new Function(`${src.slice(maskStart, maskEnd)}\nreturn { maskNonCode };`)();

/**
 * Counts sites per target **using the gate's own `findSites` + `ACTIVE_OPERATORS`**.
 *
 * ⚠️ Deliberately not a second implementation of the counting: the first version
 * of this script re-counted `masked.matchAll(op.find)` over all `OPERATORS` and
 * produced 19 for `file-journal.ts` where the gate says 18 — the `?? → ||`
 * operator is marked `extra` (opt-in via `--ops=nullish`), so it is *not* in
 * `ACTIVE_OPERATORS`. Two implementations of "how many sites are here" drift,
 * and the drift here is a false FAIL on the very gate this file maintains.
 * Extracting and reusing the gate's functions is the only way they stay equal.
 */
const countBlock = `
  ${src.slice(src.indexOf("function findTernarySites"), src.indexOf("const args = process.argv"))}
`;
const { findSites } = new Function(
  `${src.slice(maskStart, maskEnd)}\n${opBlock}\n${countBlock}\nreturn { findSites };`,
)();

// Mirror the gate's ACTIVE_OPERATORS derivation: `extra` operators are opt-in.
const argvLike = process.argv.slice(2);
const enabledExtra = new Set(
  argvLike
    .filter((a) => a.startsWith("--ops="))
    .flatMap((a) => a.slice(6).split(",").map((s) => s.trim()))
    .filter(Boolean),
);
const { OPERATORS } = new Function(`${opBlock}\nreturn { OPERATORS };`)();
const ACTIVE_OPERATORS = OPERATORS.filter(
  (op) => !op.extra || (op.optName && enabledExtra.has(op.optName)),
);

const ROOT = path.resolve(HERE, "..");

// 复用门禁自己的 EQUIVALENT_SITES：等价条目也只能有一份来源（理由同上面的 TARGETS）。
const equivalentsBlock = sliceTopLevelArray(src, "EQUIVALENT_SITES");
if (!equivalentsBlock) {
  console.error("无法在 mutation-check.mjs 里定位 EQUIVALENT_SITES（常量不存在或格式变了）");
  process.exit(2);
}
const { EQUIVALENT_SITES } = new Function(`${equivalentsBlock}\nreturn { EQUIVALENT_SITES };`)();

const counts = new Map();
/** 每个目标文件里**真实存在**的位点键集合（`op\0line`）—— 等价条目要逐条对得上它。 */
const siteKeysByFile = new Map();
for (const t of TARGETS) {
  const abs = path.join(ROOT, t.file);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    console.error(`读不到目标文件：${t.file}`);
    process.exit(2);
  }
  const masked = maskNonCode(text);
  let n = 0;
  const keys = new Set();
  for (const op of ACTIVE_OPERATORS) {
    const found = findSites(text, masked, op);
    n += found.sites.length;
    for (const s of found.sites) keys.add(`${op.name}\u0000${s.line}`);
  }
  counts.set(t.file, n);
  siteKeysByFile.set(t.file, keys);
}

/**
 * 等价白名单的**失效检查**（2026-10-23 新增）。
 *
 * 此前 `EQUIVALENT_SITES` 是"只加不减、行号漂了就永远对不上"的表：条目按
 * `(file, op, line)` 精确匹配，源码里插几行就再也匹配不到任何位点，于是它
 * 豁免的其实是**空气**；而真正漂到新行的那个位点无人认领，重新进入分母。
 *
 * 那不是理论风险：2026-10-23 一天之内因此红了两轮 CI（`ipc/context.ts` 的
 * 签名行 221 → 225、`sandbox/path-policy.ts` 的 `parent === cur` 92 → 94），
 * 每次都要靠一轮 50 分钟的分片审计才知道是哪个文件。而这两次"漂移"在表里
 * 都留着一条看起来很正常、注释还写着"行号已校回、无漂移风险"的死条目。
 *
 * 判据：**每条等价条目都必须能在目标文件里找到一个 `(算子, 行号)` 完全对得上的
 * 真实位点**。对不上 ⇒ 红（与 `check-unwired` / `check-script-wiring` 的
 * "表项失效即红"同一条纪律）。判据用的是门禁自己的 `findSites` + 目标表，
 * 不另写一份"哪儿有位点"的实现。
 */
const staleEquivalents = EQUIVALENT_SITES.filter((e) => {
  const keys = siteKeysByFile.get(e.file);
  if (!keys) return true; // 文件已不在 TARGETS（或已删除）
  return !keys.has(`${e.op}\u0000${e.line}`);
});
if (staleEquivalents.length > 0) {
  console.error(
    `FAIL: EQUIVALENT_SITES 有 ${staleEquivalents.length} 条失效条目 —— 它们指向的行已经没有任何对应算子：`,
  );
  for (const e of staleEquivalents) console.error(`  ${e.file}  ::  ${e.op} @${e.line}`);
  console.error(
    "\n这不是卫生问题：失效条目豁免的是**空气**，而真正漂到新行的那个位点无人认领、\n" +
      "重新进入分母并（在等价的前提下）存活 —— 2026-10-23 一天内因此红了两轮 CI。\n" +
      "处置：按新行号校回（并重新确认那两层防御仍在），或确认位点已消失后删掉条目。\n",
  );
  process.exit(1);
}


/** Same idea as `sliceTopLevelArray`, for an object literal constant. */
function sliceTopLevelObject(source, constName) {
  const decl = `const ${constName} = {`;
  const start = source.indexOf(decl);
  if (start < 0) return null;
  let depth = 1;
  let i = start + decl.length;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  return null;
}

const BASELINE_DECL = "const SITE_BASELINE = {";

/**
 * 把新的 `SITE_BASELINE` 块换回门禁源码，返回整份新文本（不落盘，纯字符串）。
 *
 * ⚠️ 替换区间必须**吃过块尾之后那一串分号**再接回自带的 `};`。
 * `sliceTopLevelObject` 返回的区间止于 `}`，不含结尾分号；旧写法从那个位置接回
 * 自己带 `};` 的新块 ⇒ 每跑一次 `--write` 就多一个空语句。HEAD 上的
 * `};;;;;;;;;;;;` 就是这么攒起来的，而 `check:scripts` 按语法解析、空语句合法，
 * 所以它一路静默累积。少吞一个分号是脏，多吞一个换行就是把下一段代码吃了。
 */
function withBaselineBlock(text, block) {
  const start = text.indexOf(BASELINE_DECL);
  if (start < 0) return null;
  const slice = sliceTopLevelObject(text, "SITE_BASELINE");
  if (!slice || !text.startsWith(BASELINE_DECL, start)) return null;
  let end = start + slice.length;
  while (text[end] === ";") end += 1;
  return text.slice(0, start) + block + text.slice(end);
}

/** `--write` 与自测共用同一个块构造器 —— 不留第二份实现（它会漂）。 */
function buildBaselineBlock(counts) {
  const entries = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([f, n]) => `  ${JSON.stringify(f)}: ${n},`)
    .join("\n");
  return `const SITE_BASELINE = {\n${entries}\n};`;
}

/**
 * 判据自测：真源码 + 合成靶点两头都跑，走的就是 `--write` 那条分支的同一个
 * `withBaselineBlock`，不是第二份实现（只测一个被抠出来的小函数会让真入口坏着报绿）。
 *
 * 每条断言都标明"什么输入会让它红"。
 */
function selfTestBaselineWrite(text, counts) {
  const block = buildBaselineBlock(counts);

  /** 块尾跟着几枚分号（-1 = 定位不到块）。 */
  const tailSemicolons = (source) => {
    const slice = sliceTopLevelObject(source, "SITE_BASELINE");
    if (!slice) return -1;
    let i = source.indexOf(slice) + slice.length;
    let n = 0;
    while (source[i + n] === ";") n += 1;
    return n;
  };

  const checks = [];
  const once = withBaselineBlock(text, block);
  checks.push(["门禁源码里定位得到 SITE_BASELINE", once !== null]);
  checks.push([
    "真源码连写两次与写一次逐字节相同（漏吞块尾分号会红）",
    once !== null && withBaselineBlock(once, block) === once,
  ]);
  checks.push([
    "真源码块尾恰好一枚分号（多于 1 枚 = 历史脏没收敛）",
    once !== null && tailSemicolons(once) === 1,
  ]);

  // 合成靶点：HEAD 上真存在过的脏形态（块尾多攒了 3 枚空语句），块后还有别的源码。
  const after = "\n\nconst AFTER = 1;\n";
  const cleaned = withBaselineBlock(`${block};;;${after}`, block);
  checks.push([
    "攒了额外空语句的块尾一次收敛，且不吃掉块后的源码",
    cleaned === `${block}${after}`,
  ]);
  checks.push(["脏块收敛后再写一次逐字节相同", cleaned !== null && withBaselineBlock(cleaned, block) === cleaned]);

  // 正向对照：本来就该长这样的源码，写回必须**不动它**（判据不误伤）。
  checks.push(["无漂移的源码写回后逐字节不变", withBaselineBlock(`${block}${after}`, block) === `${block}${after}`]);

  checks.push(["找不到声明时返回 null 而不是产出坏文件", withBaselineBlock("export const X = 1;\n", block) === null]);

  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (failed.length > 0) {
    console.error(`\nFAIL: SITE_BASELINE 写回判据自测 ${failed.length}/${checks.length} 条不通过`);
    process.exit(1);
  }
  console.log(`PASS: SITE_BASELINE 写回判据自测 ${checks.length} 条（幂等 + 历史脏收敛 + 正向对照）`);
}

/**
 * 「变异体正在生效」这条判据的自测。
 *
 * 用注入的 fs 假件，不去真造 `.mutation-pending` —— 那个目录是仓库级全局路径，
 * 造一份假的 .orig 会让**另一轮正在跑的变异**以为自己有残留要还原。
 *
 * 承重方向：判据若退化成「目录存在就算」（不看有没有 .orig），第 4 条会红 ——
 * 已还原干净、只剩 .json 台账的目录会被误判成"变异在跑"，于是基线永远算不出来。
 * 反过来若退化成「有文件就算」，第 5 条红。两边都得钉。
 */
function selfTestBackupAlive() {
  const io = (exists, names) => ({ existsSync: () => exists, readdirSync: () => names });
  const checks = [
    ["目录不存在 → 放行", mutationBackupAlive("/p", io(false, [])) === false],
    ["空目录 → 放行", mutationBackupAlive("/p", io(true, [])) === false],
    ["有 .orig → 拒绝", mutationBackupAlive("/p", io(true, ["a.orig"])) === true],
    ["只剩 .json 台账（已还原）→ 放行", mutationBackupAlive("/p", io(true, ["a.json"])) === false],
    [".json 与 .orig 混杂 → 拒绝", mutationBackupAlive("/p", io(true, ["a.json", "b.orig"])) === true],
    ["同名但不是 .orig 后缀 → 拒绝", mutationBackupAlive("/p", io(true, ["a.orig.bak"])) === false],
    ["注入件缺省时走真 fs（不吞异常）", typeof mutationBackupAlive("/p") === "boolean"],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (failed.length > 0) {
    console.error(`\nFAIL: 变异在跑判据自测 ${failed.length}/${checks.length} 条不通过`);
    process.exit(1);
  }
  console.log(`PASS: 变异在跑判据自测 ${checks.length} 条（注入假件，不真造台账目录）`);
}

// ---- Compare against the committed baseline ----
const baselineBlock = sliceTopLevelObject(src, "SITE_BASELINE");
if (!baselineBlock) {
  console.error("无法在 mutation-check.mjs 里定位 SITE_BASELINE（常量不存在或格式变了）");
  process.exit(2);
}
const SITE_BASELINE = new Function(`${baselineBlock}\nreturn SITE_BASELINE;`)();

const drifted = [];
for (const [file, n] of counts) {
  const prev = SITE_BASELINE[file];
  if (prev === undefined) drifted.push({ file, prev: "缺失", now: n });
  else if (prev !== n) drifted.push({ file, prev, now: n });
}
for (const file of Object.keys(SITE_BASELINE)) {
  if (!counts.has(file)) drifted.push({ file, prev: SITE_BASELINE[file], now: "已删除" });
}

const json = process.argv.includes("--json");

// 判据自测只在人读的那一面跑：--json 的输出喂给 check:doc-claims，多一行就把它砸了。
if (process.argv.includes("--selftest") && !json) {
  selfTestBaselineWrite(src, counts);
  selfTestBackupAlive();
}

if (json) {
  // 机器可读的那一面：给 check:doc-claims 用，让它能把 README 里那句
  // 「N 个目标 / N 处位点」对**实物**核，而不是对上一版文档核。
  // 有漂移时照样 exit 1 —— 打印的不是诊断报告，判据不能因为换了输出格式就松。
  const baselineSites = Object.values(SITE_BASELINE).reduce((a, b) => a + b, 0);
  const currentSites = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(
    JSON.stringify({
      targets: counts.size,
      baselineSites,
      currentSites,
      drifted: drifted.length,
    }),
  );
  if (drifted.length > 0) process.exit(1);
} else if (write) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const next = withBaselineBlock(src, buildBaselineBlock(counts));
  if (next === null) {
    // 定位不到声明块时必须**什么都不写**：写出一份坏文件等于把门禁脚本本身砸了，
    // 而下一个人看到的第一个症状会是 typecheck/lint 全绿但 mutation 报读不到常量。
    console.error(`无法在 ${GATE} 里定位 SITE_BASELINE 声明 —— 拒绝写出半个坏文件。`);
    process.exit(2);
  }
  writeFileSync(GATE, next, "utf8");
  console.log(`已写入 SITE_BASELINE：${counts.size} 个目标 / ${total} 处位点`);
} else if (drifted.length === 0) {
  console.log(`SITE_BASELINE 无漂移：${counts.size} 个目标一致。`);
} else {
  console.error(`\nFAIL: SITE_BASELINE 与源码不符（${drifted.length} 处漂移）：`);
  for (const d of drifted) console.error(`  ${d.file}  基线 ${d.prev} → 当前 ${d.now}`);
  console.error(
    "\n这些位点**没人逐点审计过** —— 位点数变了却仍然 PASS，等于" +
      '"每个位点都验过了"的假象。\n' +
      "处置：跑 `npm run mutation:audit`（逐位点判定，约 3.5 倍成本），\n" +
      "      确认全部被杀之后 `node scripts/site-baseline.mjs --write` 更新基线。\n",
  );
  process.exit(1);
}