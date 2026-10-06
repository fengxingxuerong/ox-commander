/**
 * 门禁：掩空器（`maskNonCode`）的正确性 —— 位点计数的地基。
 *
 * 变异门禁靠「位点数」判断有没有逐点验证过（`--mode=site` / `SITE_BASELINE`），
 * 而位点数来自掩空器：它必须把**注释与字符串里**的算子挖掉，只留下真代码里的。
 * 掩空器一旦判错，两个方向都会坏：
 *
 *   - **判松**（把注释/字符串当代码）→ 位点虚高 → 报出一堆改不动的假位点（假红）
 *   - **判严**（把真代码当注释/字符串吞掉）→ 位点静默归零 → **门禁假绿**
 *
 * 第二种后果最严重：`SITE_BASELINE` 会跟着降，看起来"每个位点都验过了"。
 * 正则字面量尤其危险 —— `/[;&|`$<>^!]/` 里同时有反引号和 `|`，
 * 误判成模板字面量起点就会把**整份文件**吞进字符串里。
 *
 * 所以这里逐个场景钉住期望位点数，而不是靠"跑起来没报错"。
 *
 * 用法：node scripts/masker-selftest.mjs   （有任何一条不符时 exit 1）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "mutation-check.mjs");

// 从门禁脚本里抠出掩空相关函数，避免复制粘贴造成两份实现（两份必然漂移）。
const scriptSrc = readFileSync(GATE, "utf8");
const start = scriptSrc.indexOf("function regexMayStartAt");
const end = scriptSrc.indexOf("/** 1-based 行号。 */");
if (start < 0 || end < 0) {
  console.error("无法在 mutation-check.mjs 里定位掩空函数（函数被改名或移动了？）");
  process.exit(2);
}
const helpers = scriptSrc.slice(start, end);
// 把抠出来的函数体装进新作用域（不是 eval 用户输入：helpers 来自本仓库的固定区间）。
const { maskNonCode } = new Function(`${helpers}\nreturn { maskNonCode };`)();

const OPERATORS = [
  { name: "&&", find: /&&/g },
  { name: "||", find: /\|\|/g },
  { name: "===", find: /===/g },
  { name: "!==", find: /!==/g },
  // 2026-10-05 补齐（D7）：门禁实际启用 9 个算子，自测原本只数前 4 个 ——
  // 掩空器在 `return true` / `continue;` 这类**单词边界**算子上判错，
  // 位点数会静默偏掉，而那正是"零位点仍 PASS"那一族空转的上游。
  { name: "return true", find: /\breturn true\b/g },
  { name: "return false", find: /\breturn false\b/g },
  { name: "continue;", find: /\bcontinue;/g },
  { name: "??", find: /\?\?/g },
];

/**
 * 真实靶位点 > 0：掩空器最容易的失败是**判严**（把真代码当注释吞掉），
 * 于是位点数归零 —— 而 `mutation-check.mjs` 只在 `--mode=site` 下才把
 * 零位点判 FAIL，aggregate 口径下"零位点"仍算 PASS（2026-10-04 已修的一半）。
 *
 * 拿**真实源文件**当靶子，而不是人造片段：人造片段证明不了掩空器在这批
 * 代码上没判严。这里抽几个变异门禁的真实目标文件，断言掩空后仍有位点。
 */
const REAL_TARGETS = [
  { file: "electron/sandbox/command-policy.ts", min: 5 },
  { file: "electron/sandbox/file-journal.ts", min: 5 },
  { file: "shared/zone-coverage.ts", min: 3 },
  { file: "electron/board-derive.ts", min: 3 },
];

function sitesOf(src) {
  const masked = maskNonCode(src);
  let n = 0;
  for (const op of OPERATORS) for (const _ of masked.matchAll(op.find)) n += 1;
  return n;
}

const cases = [
  // ---- 基本：代码里的算子必须被数到 ----
  { name: "纯代码", src: "const a = x && y || z;", want: 2 },
  { name: "严格比较", src: "if (a === b) { c !== d; }", want: 2 },

  // ---- 注释：不该计入 ----
  { name: "行注释含算子", src: "// a && b || c\nconst x = p && q;", want: 1 },
  { name: "行注释含单引号", src: "// don't do this\nconst x = p && q;", want: 1 },
  { name: "块注释含算子", src: "/* a && b */\nconst x = p || q;", want: 1 },
  { name: "块注释含撇号", src: "/* child's argv */\nconst x = p || q;", want: 1 },
  { name: "JSDoc 含多个算子", src: "/**\n * x === y && z\n * a !== b\n */\nconst v = p || q;", want: 1 },

  // ---- 字符串：不该计入 ----
  { name: "双引号字符串含算子", src: 'const s = "a && b"; const t = x || y;', want: 1 },
  { name: "单引号字符串含算子", src: "const s = 'a === b'; const t = x !== y;", want: 1 },
  { name: "字符串内转义引号", src: 'const s = "a\\" && b"; const t = p || q;', want: 1 },
  { name: "字符串里有 // 不误判注释", src: 'const u = "http://x"; const t = p || q;', want: 1 },
  { name: "字符串里有 /* 不误判块注释", src: 'const u = "/*"; const t = p || q;', want: 1 },

  // ---- 正则字面量：必须识别，否则整份文件被吞 ----
  {
    name: "正则含反引号（command-policy 实测形态）",
    src: "const R = /[;&|`$<>^!]/;\nconst x = p && q;",
    want: 1,
  },
  { name: "正则含单引号", src: "const R = /['\"]/;\nconst x = p && q;", want: 1 },
  { name: "正则含 || ", src: "const R = /a||b/;\nconst x = p && q;", want: 1 },
  { name: "正则字符类里有 /", src: "const R = /[a/b]/;\nconst x = p && q;", want: 1 },
  { name: "正则带标志位", src: "const R = /x/gim;\nconst x = p && q;", want: 1 },
  { name: "除法不被当正则", src: "const a = (x + y) / 2; const b = p && q;", want: 1 },

  // ---- 模板字面量：文本挖空、${} 里按代码处理 ----
  { name: "模板文本含算子", src: "const s = `a && b`; const t = x || y;", want: 1 },
  { name: "模板表达式含算子（真代码）", src: "const s = `${a === b ? 1 : 2}`; const t = x && y;", want: 2 },
  {
    name: "模板表达式里嵌对象字面量",
    src: "const s = `${f({ k: a && b })}`; const t = x || y;",
    want: 2,
  },
  {
    name: "嵌套模板",
    src: "const s = `${ `${a === b}` }`; const t = x && y;",
    want: 2,
  },

  // ---- 组合：最容易出错的地方 ----
  {
    name: "多行：注释 + 正则 + 模板 + 代码",
    src: [
      "/**",
      " * child's argv: a && b",
      " */",
      "const R = /[;&|`$]/;",
      "const s = `text ${x === y} more`;",
      "const z = p && q;",
    ].join("\n"),
    want: 2, // `${x === y}` 一处 + `p && q` 一处
  },

  // ---- 失效保护：掩空器出错必须抛错，不能静默 ----
  { name: "未闭合块注释必须抛错", src: "/* never closed\nconst x = p && q;", want: "throw" },

  // ---- 单词边界类算子：计数不得越界（掩空器判错的第二种形态）----
  {
    name: "注释里的 return true / continue; 不计入",
    src: "// return true; continue;\nconst x = p && q;",
    want: 1,
  },
  {
    name: "字符串里的 ?? 不计入",
    src: 'const s = "a ?? b"; const t = x || y;',
    want: 1,
  },
  {
    name: "标识符里的 continue 不能被当成算子（词边界）",
    src: "const continued = 1; const x = p && q;",
    want: 1,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  let got;
  let threw = false;
  try {
    got = sitesOf(c.src);
  } catch {
    threw = true;
  }
  const ok = c.want === "throw" ? threw : !threw && got === c.want;
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`✗ ${c.name}  期望 ${c.want}，实得 ${threw ? "抛错" : got}`);
  }
}

/* ---------------- 真实靶位点 > 0（掩空器判严的探针） ---------------- */

const ROOT = path.resolve(HERE, "..");
for (const t of REAL_TARGETS) {
  const abs = path.join(ROOT, t.file);
  let src;
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    fail += 1;
    console.error(`✗ 真实靶点读不到：${t.file}`);
    continue;
  }
  let got;
  try {
    got = sitesOf(src);
  } catch {
    got = -1;
  }
  if (got >= t.min) {
    pass += 1;
  } else {
    fail += 1;
    console.error(
      `✗ 真实靶点 ${t.file}  期望 ≥${t.min} 个真实位点，实得 ${got}` +
        ` —— 掩空器可能判严（把代码吞成注释），位点归零会让门禁假绿`,
    );
  }
}

console.log(
  `掩空器自测：${pass}/${cases.length + REAL_TARGETS.length} 通过` +
    `（片段 ${cases.length} · 真实靶点 ${REAL_TARGETS.length}）`,
);
if (fail > 0) process.exit(1);
