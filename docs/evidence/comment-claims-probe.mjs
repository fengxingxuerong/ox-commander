/**
 * 一次性探针（2026-10-08）：**源码注释里的符号声明**能不能做成门禁判据？
 *
 * 命题（来自 `docs/2026-10-05-full-audit.md` §7「还没盯过的面」第一条）：
 *   注释里提到的本仓符号（`xxx()` / `Type.field`），必须真的在被注释的那个
 *   文件里存在 —— 即"源码版 `check:doc-claims`"。
 *
 * 起因是 `src/pages/BoardPage.tsx` 那句"值已在边界经 `isFailureClass` 收窄"，
 * 而收窄器当时**零调用者**：注释描述了一条从未存在的接线，没有任何东西会红。
 *
 * 结论（见 `docs/2026-10-08-comment-claims-probe.md`）：**不做成门禁**。
 * 判据的精确率太低 —— 87 处"不在本文件"里绝大多数是合法的跨文件指称。
 * 本文件保留是为了让结论可复跑，不是门禁的一部分，也不进 `verify`。
 *
 * 用法：node docs/evidence/comment-claims-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const DIRS = ["shared", "electron", "src", "headless"];
const SKIP =
  /(^|[\\/])(node_modules|dist|dist-electron|dist-headless|coverage|\.git|__fakes__)([\\/]|$)/;

function walk(dir, out = []) {
  let es;
  try {
    es = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 用 TS 扫描器取注释原文 —— 而不是自己写一份注释解析。
 * 手写解析器的下场是第二种失败：把字符串/正则里的 `//` 当注释，
 * 于是位点数与命中数都会偏（`mutation-check.mjs` 的 `maskNonCode` 与
 * `masker-selftest.mjs` 为这件事存在，不重复踩）。
 */
function commentsOf(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  const out = [];
  for (;;) {
    const tok = scanner.scan();
    if (tok === ts.SyntaxKind.EndOfFileToken) break;
    if (
      tok === ts.SyntaxKind.SingleLineCommentTrivia ||
      tok === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      out.push(text.slice(scanner.getTokenPos(), scanner.getTextPos()));
    }
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const srcs = files.map((f) => ({
  rel: path.relative(ROOT, f).replace(/\\/g, "/"),
  text: fs.readFileSync(f, "utf8"),
}));

// 「本仓声明过的符号」：名字先得在全仓有定义，才谈得上"注释在指称它"。
const DECL = /(?:function|const|let|var|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;
const decls = new Set();
for (const s of srcs) for (const m of s.text.matchAll(DECL)) decls.add(m[1]);

const CALL = /^([A-Za-z_$][\w$]*)\s*\(/;
const FIELD = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const PLAIN = /^([A-Za-z_$][\w$]*)$/;

const hits = [];
for (const s of srcs) {
  for (const c of commentsOf(s.text)) {
    for (const m of c.matchAll(/`([^`\n]+)`/g)) {
      const inner = m[1].trim();
      const call = inner.match(CALL);
      const field = inner.match(FIELD);
      const plain = inner.match(PLAIN);
      const name = call ? call[1] : field ? field[1] : plain ? plain[1] : null;
      if (!name || !decls.has(name)) continue;
      // 「这个文件自己的代码里有没有这个名字」—— 判据的候选形态。
      const inFile = new RegExp(`\\b${name}\\b`).test(s.text.replace(c, ""));
      hits.push({
        rel: s.rel,
        name,
        kind: call ? "call" : field ? "field" : "plain",
        inFile,
        ctx: c.replace(/\s+/g, " ").slice(0, 100),
      });
    }
  }
}

const notInFile = hits.filter((h) => !h.inFile);
console.log(`扫描 ${srcs.length} 个文件`);
console.log(`反引号里提到「全仓已声明符号」：${hits.length} 处`);
console.log(`  其中该文件代码里没有这个名字：${notInFile.length} 处`);
for (const k of ["call", "field", "plain"]) {
  console.log(`    ${k}: ${notInFile.filter((h) => h.kind === k).length}`);
}
console.log("\n--- 明细（判据若启用，下面这些都会红）---");
for (const h of notInFile) console.log(`  [${h.kind}] ${h.rel} :: ${h.name}\n      ← ${h.ctx}`);
