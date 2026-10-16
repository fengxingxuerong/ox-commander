#!/usr/bin/env node
/**
 * 测试文件的**顶层副作用**检查（2026-10-17 新增，`verify` 第 32 段）。
 *
 * 为什么需要它 —— 2026-10-17 体检发现 `%TEMP%` 里堆了 **18352 个 `ox-*` 目录**
 * （15876 个为空）。根因是测试文件在**模块顶层** `fs.mkdtempSync`：而
 * `vitest list` 只导入不执行用例、`afterAll` 根本不会被调度 —— 目录建了，没人清。
 * 最坏的一处是 `src/sandbox-llm-call.smoke.test.ts`：3 条用例整体挂在 `skipIf` 下，
 * 默认跑 **0 条断言**，却每次收集制造一个永久垃圾目录（实测 499 个）。
 *
 * 这类缺陷**躲得过全绿的测试报告**：副作用发生在断言之外，`Tests N passed`
 * 里看不到它，只有 %TEMP% 会一直膨胀。所以要有**一道不跑用例就能看见它**的检查。
 *
 * ── 判据（两条，都 FAIL，不是警告）────────────────────────────────
 *
 *  A. 顶层建了目录/写了文件，而文件里**没有任何** `rmSync` 清理 → FAIL。
 *     「建了不清理」在顶层这个位置上就等于「每次导入泄漏一份」。
 *
 *  B. 顶层有副作用，且文件里存在 `skipIf(` / `describe.skip` 门控 → FAIL。
 *     门控跳过时 `afterAll` **不被调度**，清理不会发生，而副作用照常发生 ——
 *     这正是 sandbox-llm-call 那一档：一个从不执行断言的文件，唯一贡献是造垃圾。
 *
 *  两条都不禁止「顶层建 + afterAll 清」这个既有写法：那 4 个文件（cli-agent /
 *  cli-agent-env / sandbox-path / mutation-residue）实测残留已归零，判据不为难它们。
 *  它拦的是**建了没人清**和**清了也轮不到**这两种必漏形态。
 *
 * ── 为什么只判缩进 0 的行 ────────────────────────────────────────
 *  缩进 0 ⇒ 模块顶层 ⇒ 导入即执行。回调里（缩进 ≥2）的同类调用由用例自己控制
 *  生命周期，不在本段职责内。用缩进而非 AST：AST 要引解析器，而这里要的只是
 *  「这条语句会不会在导入时跑」，缩进对这件事是可靠的 —— 而且是**保守**的
 *  （缩进 0 一定顶层，不会漏报）。
 *
 * 用法：node scripts/check-test-side-effects.mjs [--selftest]
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 与 vitest.config.mts 的 `test.include` 逐字对齐（不同步 ⇒ 这里会漏文件）。 */
const INCLUDE_DIRS = ["src", "shared", "electron", "headless"];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

/** 会往盘上留东西的调用。删也算副作用：顶层 rmSync 在导入时就动别人的盘。 */
const SIDE_EFFECT_RE =
  /\b(?:fs\.)?(?:mkdtempSync|mkdirSync|writeFileSync|appendFileSync|copyFileSync|rmSync|rm|renameSync|symlinkSync)\s*\(/;
const CREATE_RE = /\b(?:fs\.)?(?:mkdtempSync|mkdirSync|writeFileSync|appendFileSync|copyFileSync)\s*\(/;
const CLEANUP_RE = /\b(?:fs\.)?(?:rmSync|rm)\s*\(/;
const GATED_RE = /skipIf\s*\(|\bdescribe\.skip\b|\bit\.skip\b|\btest\.skip\b/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEST_FILE_RE.test(e.name)) out.push(p);
  }
  return out;
}

function testFiles() {
  const out = [];
  for (const d of INCLUDE_DIRS) walk(path.join(ROOT, d), out);
  return out.map((p) => path.relative(ROOT, p).replace(/\\/g, "/")).sort();
}

/** 只看「缩进 0 且不是注释」的行 —— 那才是导入即执行的代码。 */
function topLevelLines(code) {
  const lines = [];
  let inBlockComment = false;
  for (const raw of code.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (/^\s/.test(raw)) continue; // 缩进 ⇒ 在某个块内 ⇒ 不是导入即执行
    lines.push(raw);
  }
  return lines;
}

/**
 * 扫描一份测试文件的内容，返回问题列表（空数组 = 干净）。
 * 判据独立于文件系统，所以自检可以直接喂字符串。
 */
export function scanSource(code) {
  const problems = [];
  const topLines = topLevelLines(code);
  const top = topLines.join("\n");

  const hasTopSideEffect = SIDE_EFFECT_RE.test(top);
  if (!hasTopSideEffect) return problems;

  const creates = CREATE_RE.test(top);
  const cleans = CLEANUP_RE.test(code); // 清理允许写在回调里，所以查全文
  const gated = GATED_RE.test(code);

  if (creates && !cleans) {
    problems.push(
      "A: 顶层建目录/写文件，而全文件没有任何 `rmSync` 清理 —— 每次导入泄漏一份" +
        "（vitest list 只导入不执行，afterAll 不会被调度）",
    );
  }
  if (gated) {
    problems.push(
      "B: 顶层有副作用，且文件里存在 skipIf/skip 门控 —— 门控跳过时 afterAll 不调度，" +
        "清理不会发生而副作用照常发生（见 sandbox-llm-call.smoke.test.ts 的 499 个残留）",
    );
  }
  return problems;
}

function selftest() {
  const cases = [
    {
      name: "干净：副作用在回调里（惰性）",
      code: ["let ROOT = \"\";", "function ensure() {", "  ROOT = fs.mkdtempSync(p);", "}"].join("\n"),
      want: 0,
    },
    {
      name: "干净：顶层建 + afterAll 清理（既有 4 个文件的写法）",
      code: [
        "const dir = fs.mkdtempSync(path.join(os.tmpdir(), \"ox-x-\"));",
        "afterAll(() => {",
        "  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}",
        "});",
      ].join("\n"),
      want: 0,
    },
    {
      name: "坏 A：顶层建且完全没清理",
      code: ["const dir = fs.mkdtempSync(path.join(os.tmpdir(), \"ox-y-\"));"].join("\n"),
      want: 1,
    },
    {
      name: "坏 B：顶层建 + 有清理，但整体被 skipIf 门控（清了也轮不到）",
      code: [
        "const dir = fs.mkdtempSync(path.join(os.tmpdir(), \"ox-z-\"));",
        "afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });",
        "describe.skipIf(!enabled)(\"x\", () => { it(\"y\", () => {}); });",
      ].join("\n"),
      want: 1,
    },
    {
      name: "干净：注释里的顶层调用不算（注释不执行）",
      code: ["// const dir = fs.mkdtempSync(\"nope\");", "const x = 1;"].join("\n"),
      want: 0,
    },
    {
      name: "干净：缩进的调用不算顶层",
      code: ["describe(\"x\", () => {", "  const d = fs.mkdtempSync(\"p\");", "});"].join("\n"),
      want: 0,
    },
  ];

  let bad = 0;
  for (const c of cases) {
    const got = scanSource(c.code).length;
    const ok = got === c.want;
    if (!ok) bad++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.name}（期望 ${c.want} 条，实得 ${got} 条）`);
  }
  if (bad > 0) {
    console.error(`\nFAIL: 自检 ${cases.length} 例里 ${bad} 例不符 —— 判据自己先站不住。`);
    process.exit(2);
  }
  console.log(`PASS: 自检 ${cases.length} 例全过（判据先证明自己认得出这几种形态）`);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
  process.exit(0);
}

const files = testFiles();
if (files.length === 0) {
  console.error("FAIL: 一个测试文件都没找到 —— 扫描范围坏了。空集合不等于「没有副作用」。");
  process.exit(2);
}

const offenders = [];
for (const rel of files) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const problems = scanSource(code);
  if (problems.length > 0) offenders.push({ rel, problems });
}

console.log(`测试文件顶层副作用检查：扫了 ${files.length} 个测试文件，命中 ${offenders.length} 个`);

if (offenders.length > 0) {
  console.error("");
  for (const o of offenders) {
    for (const p of o.problems) console.error(`FAIL  ${o.rel}\n      ${p}`);
  }
  console.error(
    "\n处置（按这个顺序想）：\n" +
      "  1. 把建目录挪进回调 / 惰性函数 —— 只有真要跑时才建（首选，根治）。\n" +
      "  2. 副作用必须留在顶层时，补上 afterAll 清理，且**别**把它放进 skipIf 门控的块里。\n" +
      "  3. 确实要豁免的，加进本文件的白名单并写明理由 —— 但先回答「每次导入泄漏一份，谁负责清」。\n" +
      "\n背景：%TEMP% 里曾有 18352 个 ox-* 目录，其中 15876 个是空的 —— 建了、没用过、也没清掉。",
  );
  process.exit(2);
}

console.log("PASS: 没有「建了没人清」或「清了也轮不到」的顶层副作用");
