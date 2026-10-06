/**
 * 门禁：检测「从 `app.getAppPath()` 读取运行时配置文件」的形态。
 *
 * 为什么需要它（真实案例，2026-09-24）：`electron/main.ts` 的 `loadEnvFile()`
 * 只从 `app.getAppPath()` 读 `.env`。开发态它是项目根，一切正常；
 * **打包后它指向 `resources/app.asar` —— 归档内部，用户放不进任何文件**。
 * 于是安装版用户根本没法配密钥。
 *
 * 这类缺陷**产物冒烟查不到**：`smoke:artifact` 只查"dist 存在性 + 语法 +
 * headless 退出码"，查不到"路径在打包后失效"这种语义问题。而它又必然在
 * 打包后才暴露 —— 所以必须有一道**在源码层就能判**的门禁。
 *
 * 判定口径（**保守**：宁可漏报，不可误报阻塞）：
 *   源文件同时满足以下三条才认为可疑：
 *     1. 出现 `getAppPath`
 *     2. 出现读文件的动作（`readFileSync` / `existsSync` / `readFile`）
 *     3. **没有**出现 asar 之外的落点（`getPath("userData")` 或 `getPath("exe")`）
 *   可疑 → FAIL，并在输出里点名文件与行号。
 *
 * 修法（三选一，按推荐度）：
 *   - 增加 `userData` / exe 目录作为候选位置（见 `electron/main.ts` 的现写法）
 *   - 确认该文件只在开发态被用到 → 在本文件顶部 `ACCEPTED` 里附理由登记
 *   - 改用 `process.resourcesPath` 之外的可写目录
 *
 * 用法：node scripts/check-packaged-paths.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 已评审、明确接受「从 getAppPath 读文件」的文件。
 *
 * 加项前必须能说清**为什么打包后这仍然成立**（最常见的是：该文件只在开发态
 * 被加载，或读的是打包时一并归档的只读资源）。
 */
const ACCEPTED = new Set([
  // 暂无。第一个真实案例（main.ts）是**修掉**而不是登记 —— 因为它在安装版
  // 是坏的，登记等于把缺陷写进白名单。
]);

/** 要扫的源码根目录。renderer（src/）不在此列：它跑在 asar 内但由主进程喂数据。 */
const SCAN_DIRS = ["electron", "shared"];

const READ_ACTIONS = /\b(readFileSync|existsSync|readFile)\s*\(/;
const APP_PATH = /\bgetAppPath\s*\(/;
/** asar 之外的可写落点。命中任一即认为作者已经考虑过打包形态。 */
const OUTSIDE_ASAR = /getPath\s*\(\s*["'](userData|exe)["']/;

/**
 * 单个文件是否命中「只从 getAppPath 读配置」的形态。
 *
 * 抽成函数是为了让它能被下面的**自检**直接调用 —— 判据与使用它的是同一份代码，
 * 不会出现"自检测的是另一套正则"这种假证据。
 */
function isSuspect(src) {
  if (!APP_PATH.test(src)) return false;
  if (!READ_ACTIONS.test(src)) return false;
  return !OUTSIDE_ASAR.test(src);
}

/**
 * 自检：这道门禁现在**恒绿**（唯一那处真实缺陷已在 2026-09-24 修掉）。
 *
 * 恒绿的门禁与没有的门禁，区别只在它会让人以为"这件事有人看着"。
 * 所以每次执行都先用构造样例验证一遍判据仍然成立 —— 正则写坏、口径被人
 * "顺手放宽"时，这道门禁必须自己先红，而不是继续打印 PASS。
 */
function selftest() {
  const read = 'fs.readFileSync(path.join(app.getAppPath(), ".env"), "utf8");';
  const cases = [
    { name: "只读 getAppPath → 必须判可疑", src: read, suspect: true },
    { name: "另有 userData 落点 → 必须豁免", src: `${read}\nconst alt = app.getPath("userData");`, suspect: false },
    { name: "另有 exe 落点 → 必须豁免", src: `${read}\nconst alt = app.getPath("exe");`, suspect: false },
    { name: "有 getAppPath 但不读文件 → 必须豁免", src: "const p = app.getAppPath();", suspect: false },
  ];
  const broken = cases.filter((c) => isSuspect(c.src) !== c.suspect).map((c) => c.name);
  if (broken.length > 0) {
    console.error("FAIL: check-packaged-paths 判据自检失败 —— 以下样例的判定与预期相反：");
    for (const b of broken) console.error(`      ${b}`);
    console.error("\n门禁自身的判据坏了却仍在打印 PASS，比没有这道门禁更危险。\n");
    process.exit(1);
  }
  console.log("  判据自检：4/4（可疑样例判可疑、豁免样例判豁免）");
}

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

selftest();

const offenders = [];
for (const dir of SCAN_DIRS) {
  for (const rel of walk(dir)) {
    if (ACCEPTED.has(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    if (!isSuspect(src)) continue;

    const line = src.split(/\r?\n/).findIndex((l) => APP_PATH.test(l)) + 1;
    offenders.push(`${rel}:${line}`);
  }
}

if (offenders.length > 0) {
  console.error("FAIL: 以下文件从 `app.getAppPath()` 读文件，但没有 asar 之外的落点 ——");
  console.error("      打包后 getAppPath() 指向 resources/app.asar（归档内部，用户放不进文件），");
  console.error("      安装版用户将无法提供该配置。");
  console.error("");
  for (const o of offenders) console.error(`      ${o}`);
  console.error("");
  console.error("修法：补 `getPath(\"userData\")` 或 `getPath(\"exe\")` 作为候选位置；");
  console.error("      若确认只在开发态用到，在本文件顶部 ACCEPTED 里附理由登记。");
  process.exit(1);
}

console.log("PASS: 没有「只从 app.getAppPath() 读配置文件」的形态（打包后可配置）");
