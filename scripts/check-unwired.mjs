/**
 * 门禁：检测「生产代码零调用的运行时导出」—— 静默失效的防线。
 *
 * 为什么需要它：一个写完就被忘掉的 helper（安全过滤、渲染防护、schema 校验）
 * 单测可以全绿，而生产代码从未调用它。覆盖率数字看不出来，`npm run verify`
 * 也全绿。本项目实际踩过：`fencedBlock` 承诺"围栏自动加长"但真实路径用硬编码
 * 三反引号；`sensenova-api.ts` 是默认适配器却完全没接 `inlineField`。
 *
 * 判定口径：
 *   - 只查**运行时**导出（function / const / class / enum）。interface / type 不查，
 *     零引用通常无害。
 *   - 消费者分类：prod（真实生产路径）/ test / 同文件内部调用。
 *   - 三类都为空 → 报「未接线」。
 *
 * 已评审并接受的项写进 ACCEPTED，附理由。**新增未接线项会让门禁 FAIL** ——
 * 逼作者在「接线」和「显式接受」之间选一个，不允许静默存在。
 *
 * 用法：node scripts/check-unwired.mjs   （有新增未接线项时 exit 1）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["shared", "electron", "src", "headless"];
const EXT = new Set([".ts", ".tsx", ".mts"]);
const SKIP_DIR = /(^|[\\/])(node_modules|dist|dist-electron|dist-headless|coverage|\.git)([\\/]|$)/;

/**
 * 已评审、明确接受「生产零调用」的项 —— 键为 `文件::符号`。
 * 加项前必须能说清为什么不接线也安全。
 *
 * 用 `node scripts/check-unwired.mjs --list` 打印当前真实命中项。
 */
const ACCEPTED = new Map([
  // ---- 「为可测试而导出」：注释已声明，设计意图就是给测试用 ----
  ["shared/redact.ts::containsLikelySecret", "断言辅助（注释：assert helper），与 redactSecrets 共享 KEY_PREFIXES/JWT 判定"],
  ["shared/http-clients.ts::countPoolRoutes", "池展开测试的断言辅助：验证 pool 规格 → 线路数，避免构造真实 client"],
  // ---- 配置表：数据而非逻辑，测试用它钉住「默认轮转不含扩展模型」 ----
  ["shared/providers.ts::SENSENOVA_MODELS_EXTRA", "模型名扩展表（kimi-k3），刻意不加入默认轮转；测试守着这一点"],
  // ---- 诊断：安全地只输出名字，尚未接到生产日志 ----
  ["electron/agents/scoped-env.ts::droppedSecretNames", "诊断辅助，只给名字不给值；接上日志后即可移出本表"],
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

const TYPE_RE = /^export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm;
const VALUE_RE =
  /^export\s+(?:async\s+)?(?:function|const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;
const BRACE_RE = /^export\s*\{([^}]*)\}/gm;
const isTest = (p) => /\.test\.(ts|tsx|mts)$/.test(p);

const sources = files.map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") }));
const exportsByFile = new Map();
for (const { file, text } of sources) {
  if (isTest(file)) continue;
  const values = new Set();
  for (const m of text.matchAll(VALUE_RE)) values.add(m[1]);
  for (const m of text.matchAll(BRACE_RE)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t || /^type\s+/.test(t)) continue;
      const name = t.split(/\s+as\s+/).pop().trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) values.add(name);
    }
  }
  if (values.size) exportsByFile.set(file, [...values]);
}

const unwired = [];
for (const [file, values] of exportsByFile) {
  const selfText = sources.find((s) => s.file === file).text;
  for (const name of values) {
    const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
    // 「已接线」= 满足任一条：
    //   a) 同文件内部除定义外还有引用（如 `topologicalSort` 被同文件 `planBatches` 调用，
    //      `CycleError` 被同文件 throw）
    //   b) 存在**非测试**文件引用它
    //
    // 测试引用刻意不算 —— 这正是本门禁要抓的「单测全绿但生产零调用」形态。
    //
    // 已知局限：链式死代码（A 只被死代码 B 调用）会漏检。试过加 fixpoint 迭代，
    // 但实测误报大量在用的符号（`inlineField` 等）；误报比漏检更消耗信任，故不做。
    const selfHits = (selfText.match(word) || []).length;
    const wired =
      selfHits > 1 ||
      sources.some(({ file: other, text }) => {
        if (other === file || isTest(other)) return false;
        word.lastIndex = 0;
        return word.test(text);
      });
    if (!wired) unwired.push({ key: `${rel(file)}::${name}`, file: rel(file), symbol: name });
  }
}

const unexpected = unwired.filter((u) => !ACCEPTED.has(u.key));
const stale = [...ACCEPTED.keys()].filter((k) => !unwired.some((u) => u.key === k));

// `--list`：打印真实命中项，便于维护 ACCEPTED 白名单。
if (process.argv.includes("--list")) {
  for (const u of unwired) console.log(u.key);
  process.exit(0);
}

console.log(`扫描 ${files.length} 个源文件`);
console.log(`生产零调用的运行时导出：${unwired.length} 个（已接受 ${unwired.length - unexpected.length} 个）\n`);

if (unexpected.length > 0) {
  console.error(`FAIL: 发现 ${unexpected.length} 个未接线的导出——生产代码从未调用：\n`);
  for (const u of unexpected) console.error(`  ${u.file}  ::  ${u.symbol}`);
  console.error(
    "\n处置二选一：\n" +
      "  1) 接到真实路径（推荐）—— 一个没被调用的防护等于没有防护\n" +
      "  2) 若是设计意图（测试辅助 / 对外 API），加进 scripts/check-unwired.mjs 的 ACCEPTED 并写理由\n",
  );
  process.exit(1);
}

// 白名单失效同样 FAIL —— 与 check-script-wiring.mjs 保持同一口径。
//
// 曾经只是"提示"，结果是它悄悄腐烂：删掉的导出仍留在表里，读的人以为
// "这里有人评审过"。**腐烂的白名单比缺失的更糟**，因为它是一份假证据。
if (stale.length > 0) {
  console.error(`\nFAIL: ${stale.length} 条 ACCEPTED 已失效（导出已删除或已接线）—— 请清理：`);
  for (const k of stale) console.error(`  ${k}`);
  console.error(
    "\n失效条目不清理，下一个人会把这份白名单当成'已经评审过'的证据。\n" +
      "用 `node scripts/check-unwired.mjs --list` 看当前真实命中项。\n",
  );
  process.exit(1);
}

console.log("PASS: 无新增未接线导出");
