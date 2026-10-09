/**
 * 门禁：改过的生产代码，要么已在变异门禁的 `TARGETS` 里，要么在显式豁免表里。
 *
 * 为什么需要它（2026-10-05 第七轮的真实教训）：
 * `mutation-check.mjs` 的 `TARGETS` 表上面写着"新文件必须显式入表 ——
 * touched 口径靠这张表映射，**漏挂 = 永远无人审计**"。而我本轮改的三个文件
 * （`headless/serve-main.ts` / `headless/mcp-main.ts` / `electron/ipc/orchestration.ts`）
 * **一个都没在表里** —— 前两轮的修复当时没有被任何变异验证覆盖，
 * 直到手动入表才一次暴露 **9 处存活位点**。
 *
 * 与 `check-script-wiring.mjs`（写好的脚本没接进入口）是同一族缺陷，差别只是载体：
 * 那边是「只跑过一次」，这边是「一次都没被变异跑过」。后果同样严重 ——
 * 变异门禁的 PASS 读起来是"每个算子至少有一处被断言覆盖"，
 * 而漏挂的文件根本没参与统计，**那个 PASS 对它是空的**。
 *
 * 判定口径：**从 git 拿"本次改了哪些文件"**，与 `TARGETS` 的实际内容比对。
 * 不用"分支数阈值"去猜哪些文件"值得"入表 —— 那是启发式，而启发式会被绕过：
 * 真要防的是"我改了它却忘了登记"这个动作本身。
 *
 * ⚠️ 为什么不给 `src/**`（UI）也套这条：变异门禁的成本随位点数线性增长，
 * 而 UI 的正确性判据是"渲染结果"而非"分支走向"，用变异衡量它不成立。
 * 这一点写进豁免表并说明理由，而不是靠过滤器悄悄放过。
 *
 * 用法：node scripts/check-mutation-targets.mjs            （有未登记项时 exit 1）
 *       node scripts/check-mutation-targets.mjs --list     # 打印全部生产文件的状态
 *       node scripts/check-mutation-targets.mjs --base=HEAD~1   # 指定比较基线
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 生产代码目录。`src/**` 刻意不在内（见文件头注释）。 */
const PROD_DIRS = ["electron", "shared", "headless"];

/** 视为"非生产"的路径：入口胶水、类型声明、构建产物、测试替身。 */
const EXCLUDE = [
  /(^|\/)__fakes__\//,
  /\.test\.ts$/,
  /\.d\.ts$/,
  /(^|\/)main\.tsx?$/,
  /^electron\/preload\.ts$/,
];

/**
 * 已评审、明确接受「不在变异门禁 TARGETS 里」的文件。
 *
 * ⚠️ 这里的每一条都在说一件具体的事，不是"暂时不测"。**空表本身是个信号**：
 * 它意味着全仓生产代码 100% 被变异覆盖，任何新文件都必须显式登记 ——
 * 那是纪律要求最高的形态，也是这个门禁存在的意义。
 */
const EXEMPT = [
  {
    file: "src/**",
    reason:
      "UI 代码不在变异门禁范围内：它的正确性判据是「渲染出什么」，不是「分支走向」，" +
      "用变异衡量不成立。UI 的门禁是 ui.test.tsx + 类型检查 + 人工评审。",
  },
  {
    file: "electron/sandbox/index.ts",
    reason: "纯再导出（barrel），无自有逻辑 —— 没有分支可供变异。",
  },
  {
    file: "electron/engine/index.ts",
    reason: "纯再导出（barrel），无自有逻辑。",
  },
  {
    file: "electron/ipc.ts",
    reason: "只做 registerIpc() 的一行转发，逻辑在 electron/ipc/*.ts（那些文件都在表里）。",
  },
];

function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

/** 从 mutation-check.mjs 的源码里抠出 TARGETS —— 不留第二份副本（它会漂）。 */
function readTargets() {
  const p = path.join(ROOT, "scripts", "mutation-check.mjs");
  const src = fs.readFileSync(p, "utf8");
  const start = src.indexOf("const TARGETS = [");
  if (start < 0) fail("scripts/mutation-check.mjs 里找不到 `const TARGETS = [` —— 判据本身坏了");
  const end = src.indexOf("\n];", start);
  if (end < 0) fail("TARGETS 数组没有闭合 —— 判据本身坏了");
  const files = [...src.slice(start, end).matchAll(/file:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (files.length === 0) fail("从 TARGETS 里解析出 0 个文件 —— 判据失配（写法变了？）");
  return new Set(files);
}

/** 本次改动涉及的文件（相对仓库根，正斜杠分隔）。 */
function changedFiles(base) {
  const r = spawnSync("git", ["diff", "--name-only", base, "--"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    fail(
      `git diff --name-only ${base} 失败：${r.error?.message ?? ""}\n` +
        "      浅克隆里没有这个基线时用 --base=<ref> 显式指定。",
    );
  }
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, "/"));
}

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith("--base="));
const listMode = args.includes("--list");

const targets = readTargets();

/**
 * 精确路径的豁免项。**必须参与**下面的 unregistered 判定 —— 否则 EXEMPT 只是
 * 一句声明："已评审接受不在 TARGETS 里"的文件一旦被改动，照样被判 FAIL
 * （2026-10-10：receipt 改动第一次让 `electron/ipc.ts` 落入这条缝，暴露了它）。
 * 带 `*` 的 glob 项（`src/**`）不在此列：`src/` 不在 PROD_DIRS 内，本就进不了判定。
 */
const exemptExact = new Set(EXEMPT.filter((e) => !e.file.includes("*")).map((e) => e.file));

// 豁免表的失效检查与 check-unwired.mjs 同一纪律：腐烂的白名单比缺失的更糟。
const staleExempt = EXEMPT.filter((e) => {
  if (e.file.includes("*")) return false;
  return targets.has(e.file) || !fs.existsSync(path.join(ROOT, e.file));
});
if (staleExempt.length > 0 && !listMode) {
  console.error(`\nFAIL: ${staleExempt.length} 条豁免已失效（文件已删除或已入表）—— 请清理：`);
  for (const e of staleExempt) console.error(`  ${e.file}`);
  console.error(
    "\n失效条目不清理，下一个人会把这份豁免当成「已经评审过」的证据。\n" +
      "用 `node scripts/check-mutation-targets.mjs --list` 看当前真实命中项。\n",
  );
  process.exit(1);
}

if (listMode) {
  console.log(`TARGETS ${targets.size} 个 · 豁免 ${EXEMPT.length} 条\n`);
  for (const e of EXEMPT) console.log(`豁免  ${e.file}\n      ${e.reason}\n`);
  for (const t of [...targets].sort()) console.log(`在册  ${t}`);
  process.exit(0);
}

const changed = changedFiles(baseArg ? baseArg.slice("--base=".length) : "HEAD");

const isProd = (f) =>
  PROD_DIRS.some((d) => f.startsWith(`${d}/`)) && !EXCLUDE.some((re) => re.test(f));

const unregistered = changed.filter(
  (f) => isProd(f) && !targets.has(f) && !exemptExact.has(f),
);

if (unregistered.length > 0) {
  console.error(
    `\nFAIL: 改了 ${unregistered.length} 个生产文件，但它们都不在变异门禁的 TARGETS 里：`,
  );
  for (const f of unregistered) console.error(`  ${f}`);
  console.error(
    "\n为什么这是 FAIL 而不是提示：`mutation:touched` 与 `mutation:site` 都靠这张表\n" +
      "决定审哪些文件。漏挂的文件**根本不参与统计** —— 门禁照样报 PASS，\n" +
      "而那个 PASS 对它没有任何含义（2026-10-07 实测：三个漏挂文件入表后一次\n" +
      "暴露 9 处存活位点）。\n\n" +
      "处置（三选一）：\n" +
      "  ① 逻辑密集且可测 → 加进 scripts/mutation-check.mjs 的 TARGETS（连同\n" +
      "     它对应的测试文件；tests 数组可挂多个，别只挂主测试）\n" +
      "  ② 确认没有值得变异覆盖的逻辑 → 写进本文件的 EXEMPT 并说明理由\n" +
      "  ③ 本来就改错了 → 改回去\n\n" +
      "改动清单：\n" + changed.map((f) => `    ${f}`).join("\n") + "\n",
  );
  process.exit(1);
}

console.log(
  `PASS: 本次改动的生产文件都已登记 —— ${changed.filter(isProd).length} 个生产文件全部在变异 TARGETS 或显式豁免中`,
);