/**
 * 只审「本次真的改到的变异目标文件」，逐位点（site）口径。
 *
 * 为什么需要它：`verify` 里的 `mutation:quick` 是 aggregate 口径、每目标 1 个变异，
 * 抓不到"我在某个承判文件里新加了一个判断、没人逐点验过"。全量 `mutation:audit`
 * 才是那道保险，但它约 15 分钟、只在 CI 的 ubuntu job 上跑 —— 本机没人肯跑，
 * 于是真出现过：改完只重跑了其中一个目标文件的审计就交付，远端 job 红了几笔才回头定位。
 * 这一步把"改了就得审"变成机器判：范围只随本次 diff，成本随改动大小走。
 *
 * 基线取法（`--base=<ref>` 可覆盖）：
 *   1. 工作区/暂存区有改动 ⇒ 以 `HEAD` 为基线（审"我准备交出去的东西"）；
 *   2. 否则取 `HEAD~1..HEAD`（审刚落在最后的这一笔）—— 在 `main` 上跑也不是空转。
 * 退出码：任一目标审出存活或基线失败 ⇒ 非 0（由审计器自己给）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BS = String.fromCharCode(92); // 一个反斜杠：写在常量里，免得被任何转义层吃掉

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function lines(out) {
  return out.split(/\r?\n/).filter((s) => s.trim() !== "");
}

/** 变异目标与它挂的测试文件：从 mutation-check.mjs 的 TARGETS 里抠，不留第二份副本（它会漂）。 */
function targetsTable() {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "mutation-check.mjs"), "utf8");
  const from = src.indexOf("const TARGETS");
  const head = src.slice(from, src.indexOf("];", from));
  const byFile = new Map();
  for (const m of head.matchAll(/\{\s*file:\s*"([^"]+)"[\s\S]*?\}/g)) {
    const file = m[1];
    const tests = [...m[0].matchAll(/"(src\/[^"]+\.test\.tsx?)"/g)].map((x) => x[1]);
    byFile.set(file.replace(new RegExp(BS + BS, "g"), "/"), tests);
  }
  return byFile;
}

function hasRev(rev) {
  try {
    git(["rev-parse", "--verify", "--quiet", rev]);
    return true;
  } catch {
    return false;
  }
}

function baseFromArgs() {
  for (const a of process.argv.slice(2)) {
    const m = /^--base=(.*)$/.exec(a);
    if (m) return m[1];
  }
  if (git(["status", "--porcelain"]).trim() !== "") return "HEAD";
  /*
   * CI 的 `actions/checkout` 默认是 depth=1 的浅克隆，那里**没有父提交**，
   * `HEAD~1` 直接解析失败。以前这一步会把一坨裸 node 堆栈抛给 job 日志
   * （2026-09-25 的 ubuntu/windows 两个 verify job 就是这么红的，而本机永远复现不了）。
   *
   * 也**不能**退化成"审 `git diff HEAD`" —— 干净工作区下那是个空集，
   * 于是这一步会宣称 PASS 而一个位点都没审。宁可红着说清楚。
   */
  if (!hasRev("HEAD~1")) {
    console.error(
      "FAIL: 仓库是浅克隆（没有 HEAD~1），这一步无法确定「本次改了哪些文件」的基线。\n" +
        "      CI 请把 checkout 改成 `fetch-depth: 0`（见 .github/workflows/verify.yml）；\n" +
        "      本机可用 `--base=<ref>` 显式指定基线。",
    );
    process.exit(1);
  }
  return "HEAD~1";
}

const base = baseFromArgs();
if (base !== "HEAD" && !hasRev(base)) {
  // `--base=<ref>` 写错时也给一句人话，而不是让 `git diff` 抛一坨裸堆栈。
  console.error(`FAIL: 基线 "${base}" 在这个仓库里解析不出来（浅克隆？写错的 ref？）。`);
  process.exit(1);
}
const touched =
  base === "HEAD"
    ? [...lines(git(["diff", "--name-only", "-M", "HEAD"])), ...lines(git(["diff", "--name-only", "-M", "--cached", "HEAD"]))]
    : lines(git(["diff", "--name-only", "-M", `${base}...HEAD`]));

const table = targetsTable();
const uniq = [...new Set(touched.map((f) => f.replace(new RegExp(BS + BS, "g"), "/")))];
const hits = uniq.filter((f) => table.has(f));

console.log(`基线=${base} 改动文件=${uniq.length} 其中变异目标=${hits.length}`);
for (const h of hits) {
  const tests = table.get(h);
  console.log(`  · ${h}${tests && tests.length > 0 ? ` ← ${tests.join(", ")}` : " ← (没挂测试文件)"}`);
}
if (hits.length === 0) {
  console.log("PASS: 本次改动没有触及任何变异目标文件 —— 无需逐位点审计");
  process.exit(0);
}

const failed = [];
for (const f of hits) {
  console.log(`\n=== site 口径审计：${f} ===`);
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "mutation-check.mjs"), "--mode=site", `--file=${path.basename(f, ".ts")}`, "--limit=999"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (r.status !== 0) failed.push(f);
}
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} 个被改到的目标文件未通过逐位点审计：`);
  for (const f of failed) console.error(`  ${f}`);
  console.error("处置：补断言；确认是等价变异则进 EQUIVALENT_SITES 并写理由（别放宽 MAX_SURVIVORS）。");
  process.exit(1);
}
console.log(`\nPASS: 本次改动涉及的 ${hits.length} 个变异目标已全部逐位点审计通过`);
