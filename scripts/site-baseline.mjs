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
 *
 * Exits 1 on drift when not writing — that is the point: `npm run mutation:site`
 * (and CI's `mutation-full` job) is what proves each site individually, so a
 * count that moved without a fresh audit means the proof is stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "mutation-check.mjs");
const write = process.argv.includes("--write");

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
const counts = new Map();
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
  for (const op of ACTIVE_OPERATORS) n += findSites(text, masked, op).sites.length;
  counts.set(t.file, n);
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

if (write) {
  const entries = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([f, n]) => `  ${JSON.stringify(f)}: ${n},`)
    .join("\n");
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const block = `const SITE_BASELINE = {\n${entries}\n};`;
  const start = src.indexOf("const SITE_BASELINE = {");
  const next = src.slice(0, start) + block + src.slice(start + baselineBlock.length);
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