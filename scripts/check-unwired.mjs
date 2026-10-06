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
/** 定义侧：只在这些目录里找"导出"。`scripts/` 不算 —— 脚本不产出对外契约。 */
const SCAN_DIRS = ["shared", "electron", "src", "headless"];
/**
 * 消费侧**额外**把 `scripts/` 算作"非测试消费者"（见下方 consumerFiles）。
 *
 * 为什么（2026-10-05 实测修）：`scripts/loomy-bridge.mjs` 是真实的运行时消费方
 * —— 它 `require` 了 `dist-electron/shared/deliverable-format.js` 的
 * `parseDeliverable` 并在 :149 调用，那正是 LLM 交付格式的解析入口。
 * 但 `scripts/` 不在 `SCAN_DIRS` 里，所以它对门禁**不可见**，
 * `parseDeliverable` 被判成"生产零调用" —— 一个假红。
 *
 * 假红比假绿更消耗信任（这是本门禁自己在注释里写的话），所以消费侧必须看得见
 * 脚本。注意方向性：`scripts/` 只**消费**，不贡献"导出"判定 —— 否则
 * `check-unwired.mjs` 自己会把它内部提到的名字算成导出。
 */
const EXT = new Set([".ts", ".tsx", ".mts"]);
/**
 * `__fakes__/` 是**测试替身**，不是生产代码 —— 与 `vitest.config.mts` 的
 * `coverage.exclude` 同一判定。替身里的导出天然只被测试引用（那正是它的用途），
 * 让本门禁去要求它们"有生产调用"只会逼人把测试基础设施写进 ACCEPTED 表。
 *
 * 注意这条不放宽门禁的**语义**：本门禁问的是"生产代码有没有调用"，
 * 而测试替身从来不是生产代码。真生产模块（shared / electron / headless / src
 * 下的非 __fakes__ 文件）一律照旧扫描。
 */
const SKIP_DIR =
  /(^|[\\/])(node_modules|dist|dist-electron|dist-headless|coverage|\.git|__fakes__)([\\/]|$)/;

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
  // （droppedSecretNames 已于 2026-09-27 接进 cli-agent dispatch 事件流，移出本表）
  //
  // 2026-10-05 移出 6 条「经 scripts/ 桥消费、静态扫描不可见」的条目
  // （deliverable-format 的 buildOutputRules / resolveDeliverablePath / zoneWriteRule，
  //  zone-cost 的 summarizeZoneCost / planCost / formatZoneCostReport）。
  // 它们当初进表的理由就是"桥消费它"；现在 `scripts/` 进了**消费侧**扫描范围
  // （CONSUMER_DIRS 注释），这些导出都能被看见并判为已接线 —— 白名单留着会让
  // 下一个人以为"评审过 = 没接线"，而门禁会把它报成失效条目逼着清理。
]);

function walk(dir, exts = EXT, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
/**
 * 消费侧多看 `scripts/` —— 桥与 IT 都是 `.mjs`，而 `walk` 默认只收 `.ts/.tsx/.mts`，
 * 所以这里必须显式换扩展名集合（上一版把过滤写在 walk 之后，于是 `.mjs` 一个都
 * 没进来，症状是 `parseDeliverable` 仍然被判死码）。
 */
const SCRIPT_EXT = new Set([".ts", ".mts", ".mjs", ".js", ".cjs"]);
const consumerFiles = [...files, ...walk(path.join(ROOT, "scripts"), SCRIPT_EXT)];
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

// 只扫「值导出」：type/interface 是编译期产物，运行时没有可调用点，
// 按"零调用即死码"判它们会把每一个契约类型都判红。
const VALUE_RE =
  /^export\s+(?:async\s+)?(?:function|const|class|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm;
const BRACE_RE = /^export\s*\{([^}]*)\}/gm;
const isTest = (p) => /\.test\.(ts|tsx|mts)$/.test(p);

const sources = consumerFiles.map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") }));

/**
 * 「已接线」只在**可执行代码**里找，注释与字符串不算。
 *
 * 为什么（2026-10-05 实测修）：原先拿 `word.test(原文)` 打整份文件，
 * 于是**注释里提到符号名**就算接线。实测 291 个导出里 **22 个**是这么被
 * "洗白"的，其中 `topologicalSort` / `CycleError` 只因 `graph.ts:11` 的 JSDoc
 * 提了一句就算已接线 —— 而它其实接在同文件 78 行，靠的是**同文件内部引用**
 * 那条规则，不是那条注释。这条门禁的全部意义是"生产真的调用了它"，而注释
 * 恰恰是最容易写、最不代表调用的地方。
 *
 * 复用 mutation-check 的 `maskNonCode` 而不是自己写一份：掩空器一旦判错，
 * 位点数会静默归零（`masker-selftest` 就是为此存在的），而**两份实现必然
 * 漂移** —— 同一条教训见 `scripts/site-baseline.mjs` 的注释。
 */
const GATE = path.join(ROOT, "scripts", "mutation-check.mjs");
const gateSrc = fs.readFileSync(GATE, "utf8");
const maskStart = gateSrc.indexOf("function regexMayStartAt");
const maskEnd = gateSrc.indexOf("/** 1-based 行号。 */");
if (maskStart < 0 || maskEnd < 0) {
  console.error("无法在 mutation-check.mjs 里定位 maskNonCode（函数被改名或移动了？）");
  process.exit(2);
}
const { maskNonCode } = new Function(`${gateSrc.slice(maskStart, maskEnd)}\nreturn { maskNonCode };`)();
// 导出名抽取也走掩空后的文本：注释里写的 `export function foo` 不该算一个导出。
for (const s of sources) s.masked = maskNonCode(s.text);

const exportsByFile = new Map();
for (const { file, masked } of sources) {
  if (isTest(file)) continue;
  const values = new Set();
  for (const m of masked.matchAll(VALUE_RE)) values.add(m[1]);
  for (const m of masked.matchAll(BRACE_RE)) {
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
  const selfText = sources.find((s) => s.file === file).masked;
  for (const name of values) {
    const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
    // 「已接线」= 满足任一条：
    //   a) 同文件内部除定义外还有引用（如 `topologicalSort` 被同文件 `planBatches` 调用，
    //      `CycleError` 被同文件 throw）
    //   b) 存在**非测试**文件引用它
    //
    // 测试引用刻意不算 —— 这正是本门禁要抓的「单测全绿但生产零调用」形态。
    //
    // ⚠️ 一律在**掩空后**的文本上判定：注释/字符串里出现符号名不算调用
    // （见上面 sources.masked 的注释：实测因此漏放 22 个导出）。
    //
    // 已知局限：链式死代码（A 只被死代码 B 调用）会漏检。试过加 fixpoint 迭代，
    // 但实测误报大量在用的符号（`inlineField` 等）；误报比漏检更消耗信任，故不做。
    const selfHits = (selfText.match(word) || []).length;
    const wired =
      selfHits > 1 ||
      sources.some(({ file: other, masked }) => {
        if (other === file || isTest(other)) return false;
        word.lastIndex = 0;
        return word.test(masked);
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
