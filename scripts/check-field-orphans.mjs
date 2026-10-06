/**
 * 门禁：检测「接口字段只有生产者、没有消费者」。
 *
 * 为什么需要它（2026-10-05 分流审计的真实教训）：
 *
 * `orchestrator.ts` 里有一行
 *   `...(outcome ? { outcomeOk: outcome.ok } : {})`
 * 被展开进了 `receiptTaskStatus({...})` 的**入参**，而不是返回对象。
 * 于是：
 *   · 它"一直在被调用" ⇒ 变异门禁的位点活着；
 *   · `ReceiptTask` 里没有 `outcomeOk` 字段 ⇒ TypeScript **静默丢弃**，不报错；
 *   · 单测只 `toMatchObject([...])` 断言几个已有字段 ⇒ 不变红；
 *   · `grep outcomeOk` 零消费侧 ⇒ 谁也不负责它"在不在"。
 *
 * **三道防线同时失效**，而每一道单独看都是健全的。`check-unwired.mjs` 管的是
 * 「导出的**符号**有没有人调」，接口**字段**是它的盲区 —— 本门禁补这一半。
 *
 * 判定口径（刻意保守，宁可少报不可错报）：
 *   - 只看 `shared/` 里**对外导出**的 interface 字段（有公共契约性质的）；
 *   - "消费者"= 任何**非测试**代码里出现 `.字段名` 的属性访问
 *     或 `{ … 字段名 … }` 的对象字面量键，**含定义文件自身**
 *     （同文件消费也是消费 —— 见 consumersOf 里的注释）；
 *   - 测试引用**不算**消费者 —— 与 check-unwired 同理：
 *     十六轮那处正是"只有测试看得见、生产侧没人管"。
 *
 * 已知局限（写下来而不是假装没有）：
 *   · 字段可能经 `Object.keys` / 展开 / 序列化被**间接**消费 —— 静态扫不出来。
 *     所以 ACCEPTED 里必须留位置（凭据类字段恰恰靠序列化出口，见下）。
 *   · 消费点写在别的仓库/协议文档里时，本门禁看不见。
 *
 * 用法：node scripts/check-field-orphans.mjs          （有新增孤儿字段时 exit 1）
 *       node scripts/check-field-orphans.mjs --list   （打印真实命中项）
 *
 * ⚠️ **这个门禁自己踩过三个坑，全记在这里**（写它的当天）——
 * 三个都是"永远绿"型，且都是被反向注入逼出来的：
 *
 *   1. **字段声明自己算消费**。`injectedOrphan: number;` 这一行本身就是
 *      `injectedOrphan:` 的字面量命中，于是每个字段都被自己的**声明处**
 *      "消费"了，整条门禁永远报 0。修法：判定前先扣掉 interface 体。
 *   2. **不认 ES6 简写**。真实代码写 `{ conflicts: …, checksFailed, preexisting }`
 *      —— 那是 `checksFailed,`，既没点也没冒号。第一版把它判成孤儿（假红）。
 *   3. **"同文件不算消费者"是错的**（第一版的规则）。
 *      `ReceiptCounts.checksFailed` 正是由 `receiptHeadlineFor` 在
 *      **同一个文件**里读出来拼进 headline 的 —— 那就是它在干的事实。
 *
 *   而 `usedHeadline` 这类字段**在本门禁下永远抓不到**，因为凭据是
 *   `canonicalReceiptPayload` 整体序列化给外部的，仓内没有逐字段读取点。
 *   结构性盲区，只能靠 ACCEPTED 显式声明（并写清"谁会读"）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["shared"];
const EXT = new Set([".ts", ".tsx", ".mts"]);
const SKIP_DIR =
  /(^|[\\/])(node_modules|dist|dist-electron|dist-headless|coverage|\.git|__fakes__)([\\/]|$)/;

/**
 * 已评审、明确接受「无消费者」的字段 —— 键为 `文件::接口.字段`。
 * 加项前必须能说清**谁会读它**（哪怕是"外部消费方"，也要写清楚是谁）。
 */
const ACCEPTED = new Map([
  // ---- 2026-10-05 首跑清点：6 项，全部是「从未被读、也从未被写」的可选字段 ----
  //
  // 判据（三条都查过，不是猜的）：
  //   1. `git log -S` 显示它们都在**首版提交**（a90ff3b）里，此后从未被动过；
  //   2. 仓内既无读取点，也无写入点 —— `grep` 只命中定义处那一行本身；
  //   3. 删掉它们不会让任何现有测试变红（它们压根没进过任何断言）。
  //
  // 它们既不是"别人在用的契约"，也不是"忘了接线的实现" ——
  // 就是**预留了但从未兑现的接口面**。
  //
  // 处置：**显式接受并留下名字**，而不是删掉。理由：
  //   · `agent-contract.ts` 是**跨进程契约**（第 151 行明说
  //     "Downstream contract: a strict superset of TaskPayload so v1
  //     adapters keep working"）—— 外部适配器可能正按这个形状读；
  //   · `types.ts` 里的 `TaskState` 是**渲染层直接消费**的类型，
  //     删字段会波及看板形状。
  //
  // 仓内的 grep 看不见仓外，这是本门禁的结构性盲区（见上方"已知局限"）。
  // 所以：**记录 > 删除**。真要删，应当是显式的破坏性变更决策，
  // 而不是被一条静态检查顺手删掉。
  ["shared/agent-contract.ts::FileChange.producer", "自首版 a90ff3b 起从未被读写；跨进程契约的预留面，外部适配器可能按此读，仓内 grep 看不见"],
  ["shared/agent-contract.ts::TaskRequest.allowedCommands", "同上：预留未兑现，保留以免破坏外部适配器"],
  ["shared/agent-contract.ts::TaskRequest.previousAttempt", "同上：预留未兑现，保留以免破坏外部适配器"],
  ["shared/types.ts::TaskState.assignedAgentId", "自首版起从未被读写；TaskState 是渲染层直接消费的类型，删字段会波及看板形状"],
  ["shared/types.ts::RepairRecord.dispatchedAt", "RepairRecord 整体从未被读过（repairHistory 也没被读）；时间戳字段预留未兑现"],
  ["shared/types.ts::TaskState.repairHistory", "自首版起从未被读写；重修历史目前只活在 journal（RunSnapshot）里，这两套账还没打通 —— 属于已知缺口而非死字段，见 docs/2026-10-05-full-audit.md"],
]);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const isTest = (p) => /\.test\.(ts|tsx|mts)$/.test(p);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

// ── 复用 mutation-check 的掩空器：注释与字符串里出现字段名不算"消费" ──
// 自己写一份必然与它漂移（同 site-baseline.mjs 的教训）。注释里提到字段名
// 是最容易写、最不代表消费的地方。
const GATE = path.join(ROOT, "scripts", "mutation-check.mjs");
const gateSrc = fs.readFileSync(GATE, "utf8");
const maskStart = gateSrc.indexOf("function regexMayStartAt");
const maskEnd = gateSrc.indexOf("/** 1-based 行号。 */");
if (maskStart < 0 || maskEnd < 0) {
  console.error("无法在 mutation-check.mjs 里定位 maskNonCode（函数被改名或移动了？）");
  process.exit(2);
}
const { maskNonCode } = new Function(`${gateSrc.slice(maskStart, maskEnd)}\nreturn { maskNonCode };`)();

const defFiles = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
/** 消费侧：整个仓的非测试源码（字段的消费者可能不在 shared/ 里）。 */
const consumerFiles = walk(path.join(ROOT, "shared"))
  .concat(walk(path.join(ROOT, "electron")))
  .concat(walk(path.join(ROOT, "src")))
  .concat(walk(path.join(ROOT, "headless")))
  .map((p) => ({ file: p, masked: maskNonCode(fs.readFileSync(p, "utf8")) }));

// ── 抽 interface 字段 ──
/** `export interface X { a: T; b?: U; /** 注释 *\/ c: V }` —— 顶层大括号配平。 */
function interfaceFields(text) {
  const out = [];
  const re = /^export\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/gm;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const body = text.slice(start, i - 1);
    // 逐行取 `字段名?: 类型`，跳过方法签名（有括号）与注释行
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      const fm = t.match(/^([A-Za-z_$][\w$]*)\??\s*:/);
      if (fm) out.push({ iface: name, field: fm[1] });
    }
  }
  return out;
}

// ── 判定「有人消费」 ──
/** 属性访问 `.字段` / 对象字面量键 `字段:` / **ES6 简写** `{ 字段 }` —— 都不含注释与字符串。 */
function consumersOf(field) {
  const access = new RegExp(`\\.${field}\\b`);
  const literal = new RegExp(`(^|[{,\\s])${field}\\s*:`, "m");
  // ⚠️ **必须认 ES6 简写**：真实代码写的是
  //   return { conflicts: conflicts.length, checksFailed, preexisting };
  // 那是 `checksFailed,` —— 既没有点也没有冒号。第一版只认前两种形态，
  // 于是 `checksFailed`（headline 真的在用它！）被判成孤儿。
  // 这是**假红**，而假红比假绿更消耗信任。
  const shorthand = new RegExp(`(^|[{,\\s])${field}\\s*[,}]`, "m");
  const hits = [];
  for (const { file, masked } of consumerFiles) {
    if (isTest(file)) continue;
    // ⚠️ **同文件也算消费者**（2026-10-05 修正，这是本门禁第一版的错）。
    //
    // 我最初写的是"定义文件之外的读取才算"，理由是照搬 check-unwired 的
    // 「自己文件内部引用不算接线」。但那条规则针对的是**导出符号**：
    // 一个没导出的 helper 在自己文件里被调，只说明它在自己文件里活着。
    //
    // 接口字段是**另一回事**：`ReceiptCounts.checksFailed` 正是由
    // `receiptHeadlineFor` 在**同一个文件**里读出来拼进 headline 的 ——
    // 那就是它在干的事实，也是它存在的全部理由。把它判成"孤儿"是**假红**，
    // 而假红比假绿更消耗信任（check-unwired 自己的注释里就写着这句）。
    //
    // 真正的孤儿判据是：**整个仓（含自己文件）没有任何非测试代码读它**。
    if (access.test(masked)) {
      hits.push(rel(file));
      continue;
    }
    // ⚠️ 对象字面量键的判定**必须先扣掉 interface 自己的字段声明**
    // （2026-10-05 反向注入抓到的第二个 bug）。
    //
    // `ReceiptCounts { injectedOrphan: number }` 这一行**本身就是**
    // `injectedOrphan:` 的字面量命中 —— 于是每个字段都被自己的**声明处**
    // "消费"了，整条门禁永远报 0。
    //
    // 这是**自查抓出来的**，不是注入抓的：注入 ① 报"门禁没咬住"时我先怀疑
    // 注入没写进文件，绕了三轮才发现是门禁自己瞎了。
    // 教训：**门禁的"永远绿"必须先怀疑自己，而不是怀疑注入。**
    const withoutDecl = stripOwnFieldDecls(masked, file, field);
    if (literal.test(withoutDecl) || shorthand.test(withoutDecl)) hits.push(rel(file));
  }
  return hits;
}

/**
 * 扣掉「本文件里 interface 的字段声明行」。
 *
 * 只删**声明形态**的行（`字段名?: 类型` 出现在行首、后面是类型而不是值），
 * 不动正文里的赋值 —— `counts: { failed: 1 }` 这种真消费必须留住。
 */
function stripOwnFieldDecls(masked, file, field) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx") && !file.endsWith(".mts")) return masked;
  // interface 体：把 `export interface X { … }` 的内容整段挖空
  const re = /^export\s+interface\s+[A-Za-z_$][\w$]*[^{]*\{/gm;
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(re)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < masked.length && depth > 0) {
      const ch = masked[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    out += masked.slice(last, start) + masked.slice(start, i - 1).replace(new RegExp(field, "g"), " ");
    last = i - 1;
  }
  out += masked.slice(last);
  return out;
}

const orphans = [];
for (const file of defFiles) {
  const text = maskNonCode(fs.readFileSync(file, "utf8"));
  for (const { iface, field } of interfaceFields(text)) {
    const key = `${rel(file)}::${iface}.${field}`;
    if (ACCEPTED.has(key)) continue;
    const hits = consumersOf(field);
    if (hits.length === 0) orphans.push({ key, file: rel(file), iface, field });
  }
}

if (process.argv.includes("--list")) {
  console.log(`接口字段孤儿（无仓内消费者）：${orphans.length}`);
  for (const o of orphans) console.log(`  ${o.key}`);
  process.exit(0);
}

if (orphans.length > 0) {
  console.error(`\n❌ 发现 ${orphans.length} 个「只有生产者、没有消费者」的接口字段：\n`);
  for (const o of orphans) {
    console.error(`   ${o.key}`);
    console.error(`     ${o.iface} 的 ${o.field} 字段在定义文件之外没有任何非测试代码读取它。`);
  }
  console.error(
    `\n三条防线会同时放过这种字段：TS 允许展开多余属性、单测只断言已有字段、` +
      `\n变异门禁看的是"这行有没有被调用"。\n` +
      `处置二选一：接上消费者，或写进 ACCEPTED 并说明**谁**会读它。`,
  );
  process.exit(1);
}

console.log("PASS: 没有「只有生产者、没有消费者」的接口字段。");