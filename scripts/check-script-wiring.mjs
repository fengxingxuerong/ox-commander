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
const ACCEPTED = new Map([
  ["marvis-bridge.mjs", "外部智能体桥，需对方真实服务在跑；由操作员手动启动"],
  ["loomy-bridge.mjs", "同上（agents.d/onboarding-universal.md 记录了启动方式）"],
  ["run-multiagent-e2e.mjs", "长跑端到端（--max-minutes 可配），需真实 LLM 凭据，人工验收用"],
  ["probe-endpoints.cjs", "诊断工具，探测外部端点连通性，非验收判据"],
  ["gen-repair-smoke.cjs", "生成器：产出 smoke-repair / smoke-fullchain 的用例，人工按需运行"],
  ["smoke-e2e.mjs", "旧版 e2e，已被 run-multiagent-e2e.mjs 取代（保留待清理）"],
  ["bridge-smoke.mjs", "旧版桥冒烟，已被 admission-gateway-it.mjs 取代（保留待清理）"],
  ["smoke-fullchain.mjs", "全链路冒烟，需真实凭据；被 gen-repair-smoke.cjs 生成后人工跑（引用者自己也不在入口）"],
  ["smoke-repair.mjs", "重修循环冒烟，同上"],
  ["loomy-bridge.mjs", "被 run-multiagent-e2e.mjs 引用，但该 runner 同样只在人工验收时跑 —— 链条未接到入口"],
]);

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
const sources = scripts
  .filter((p) => path.basename(p) !== SELF) // 见文件头「⚠️」：本文件必须排除
  .map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, "utf8") }));

/** name → 它引用的其他脚本名 */
const edges = new Map();
for (const s of sources) {
  edges.set(
    s.name,
    [...names].filter((t) => t !== s.name && s.text.includes(t)),
  );
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
