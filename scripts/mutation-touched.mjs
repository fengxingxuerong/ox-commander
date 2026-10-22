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
 *   1. 工作区/暂存区有**已跟踪的**改动 ⇒ 以 `HEAD` 为基线（审"我准备交出去的东西"）；
 *   2. 否则取 `HEAD~1..HEAD`（审刚落在最后的这一笔）—— 在 `main` 上跑也不是空转。
 *   未跟踪文件**不算脏、也不漏审**：不算脏，是因为它们不进 `git diff HEAD`，把它们
 *   算进来会让一个杂散文件把基线顶成 HEAD、待审集合为空、这一步假 PASS（2026-10-23
 *   实弹）；不漏审，是因为它们恒并入待审集合 —— 全新的生产文件在 diff 的两种形态里
 *   都看不见，而它恰恰是"正在写、还没提交"的那批。口径细节见 resolveAuditScope。
 * 退出码：任一目标审出存活或基线失败 ⇒ 非 0（由审计器自己给）。
 */
import { execFileSync, spawn } from "node:child_process";
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
    // 四个宿主目录都要认：以前只收 `src/`，于是挂在 `electron/*.test.ts`、
    // `shared/*.test.ts` 下的目标全被打印成「← (没挂测试文件)」，读的人会以为
    // 那里没有断言、从而不去补 —— 而断言其实一直在跑。
    const tests = [...m[0].matchAll(/"((?:src|electron|shared|headless)\/[^"]+\.test\.tsx?)"/g)].map(
      (x) => x[1],
    );
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

/*
 * 决定本轮审谁：基线选择 + 恒并入的未跟踪文件。
 *
 * 两条口径都是吃过亏才定的（本区由 src/mutation-touched.test.ts 按锚点抠出
 * `resolveAuditScope` 注入假 git 逐条钉住 —— 门禁脚本刻意不在变异 TARGETS 里，
 * 它的正确性靠这类用例担保）：
 *
 * 1. 「脏」只看已跟踪/已暂存的改动。旧判据是 `git status --porcelain` 非空，而它把
 *    未跟踪文件也算进来；未跟踪文件又不进 `git diff HEAD`，于是工作区里一个杂散
 *    文件（构建残渣、临时产物）就能把基线顶成 HEAD、让待审集合为空，这一步报
 *    PASS 而「最后一笔提交」整个没被审（2026-10-23 现场：工作区明明干净、只因多了
 *    一个未跟踪的 audit.json，输出就是「基线=HEAD 改动文件=0」）。审计范围不许被
 *    无关文件静默改写。
 * 2. 未跟踪文件恒并入待审集合。全新的生产文件在 `git diff HEAD` 与
 *    `git diff --cached HEAD` 两种形态里都看不见（还没 add 时连暂存区都没有它），
 *    而它恰恰是「正在写、还没提交」的那批 —— 落在变异目标路径上的新文件必须被审。
 */
function resolveAuditScope(gitFn, args) {
  const explicit = explicitBase(args);
  if (explicit !== undefined) return { base: explicit, untracked: listUntracked(gitFn) };
  const base = hasTrackedChanges(gitFn) ? "HEAD" : "HEAD~1";
  return { base, untracked: listUntracked(gitFn) };
}

/** 显式 `--base=<ref>`：覆盖基线选择（不覆盖「未跟踪恒并入」）。 */
function explicitBase(args) {
  for (const a of args) {
    const m = /^--base=(.*)$/.exec(a);
    if (m) return m[1];
  }
  return undefined;
}

/** 工作区有没有已跟踪/已暂存的改动（未跟踪文件不算脏，见 resolveAuditScope 的口径 1）。 */
function hasTrackedChanges(gitFn) {
  return gitFn(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
}

/**
 * 未跟踪文件清单（恒并入待审集合，见 resolveAuditScope 的口径 2）。
 * 目录项带尾斜杠、剥掉即可；空目录剥完就是空串，滤掉。git 对非 ASCII 路径的
 * 引号包裹刻意不去解：变异目标路径全是 ASCII，解不开的路径自然匹配不上任何目标。
 */
function listUntracked(gitFn) {
  return gitFn(["status", "--porcelain", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).replace(/\/$/, ""))
    .filter((l) => l !== "");
}

/*
 * 基线落定后的主流程。
 */
const { base, untracked } = resolveAuditScope(git, process.argv.slice(2));
/*
 * CI 的 `actions/checkout` 默认是 depth=1 的浅克隆，那里**没有父提交**，
 * `HEAD~1` 直接解析失败。以前这一步会把一坨裸 node 堆栈抛给 job 日志
 * （2026-09-25 的 ubuntu/windows 两个 verify job 就是这么红的，而本机永远复现不了）。
 *
 * 也**不能**退化成"审 `git diff HEAD`" —— 干净工作区下那是个空集，
 * 于是这一步会宣称 PASS 而一个位点都没审。宁可红着说清楚。
 */
if (base === "HEAD~1" && !hasRev(base)) {
  console.error(
    "FAIL: 仓库是浅克隆（没有 HEAD~1），这一步无法确定「本次改了哪些文件」的基线。\n" +
      "      CI 请把 checkout 改成 `fetch-depth: 0`（见 .github/workflows/verify.yml）；\n" +
      "      本机可用 `--base=<ref>` 显式指定基线。",
  );
  process.exit(1);
}
if (base !== "HEAD" && !hasRev(base)) {
  // `--base=<ref>` 写错时也给一句人话，而不是让 `git diff` 抛一坨裸堆栈。
  console.error(`FAIL: 基线 "${base}" 在这个仓库里解析不出来（浅克隆？写错的 ref？）。`);
  process.exit(1);
}
const diffTouched =
  base === "HEAD"
    ? [...lines(git(["diff", "--name-only", "-M", "HEAD"])), ...lines(git(["diff", "--name-only", "-M", "--cached", "HEAD"]))]
    : lines(git(["diff", "--name-only", "-M", `${base}...HEAD`]));
// 未跟踪文件不进任何一种 diff，这里与 diff 结果并成一份待审清单（口径 2）。
const touched = [...diffTouched, ...untracked];

const table = targetsTable();
const uniq = [...new Set(touched.map((f) => f.replace(new RegExp(BS + BS, "g"), "/")))];
const hits = uniq.filter((f) => table.has(f));

console.log(`基线=${base} 改动文件=${uniq.length} 其中变异目标=${hits.length}`);
for (const h of hits) {
  const tests = table.get(h);
  console.log(`  · ${h}${tests && tests.length > 0 ? ` ← ${tests.join(", ")}` : " ← (没挂测试文件)"}`);
}
/*
 * 把「改了门禁自己」这件事在输出里说破。
 *
 * 2026-10-15 实测的盲区：`scripts/mutation-check.mjs`（判据本身）不在 TARGETS 里 ——
 * 这是刻意的，门禁不能把变异体写进自己身上再启动自己去测，自指会让审计失去意义。
 * 但于是本次只改判据时，上面那行会打印「其中变异目标=0」，下面紧跟着一句
 * 「无需逐位点审计」—— 读的人会以为这批改动没有任何审计要求，而它恰恰是最需要
 * 审计的那批：改坏了不会有任何变异位点变红，只会让后面的段集体说谎。
 *
 * 所以这里点名这些文件，并说清它们的正确性靠什么：不是变异审计，而是单元用例
 * （`src/mutation-residue.test.ts` 里按锚点抠函数注入假件那一套）。只提示、不改退出码
 * —— 判「该不该有单元用例」需要人，机器只能保证这件事没被忘掉。
 */
const gateScripts = uniq.filter((f) => f.startsWith("scripts/") && f.endsWith(".mjs") && !table.has(f));
if (gateScripts.length > 0) {
  console.log(
    `  ⚠️ 改了门禁脚本（刻意不在 TARGETS 内，避免自指审计）：${gateScripts.join(", ")}`,
  );
  console.log(
    "     这批文件没有逐位点变异审计可做，正确性靠单元用例担保（锚点抠函数 + 注入假件）；" +
      "没有用例的改动请一并补上。",
  );
}
if (hits.length === 0) {
  console.log("PASS: 本次改动没有触及任何变异目标文件 —— 无需逐位点审计");
  process.exit(0);
}

const failed = [];
// 串行（2026-10-14 教训）：此前 JOBS=3 并行，每个目标一个 mutation-check 子进程，
// 各自往**自己的目标文件**写变异体 —— 但多个目标的测试集共享 import 图（本机实测：
// orchestrator/router/scheduler/zone-coverage 四个目标同批改动时，scheduler 的
// **基线** vitest 传递 import 了 router.ts，而 router 的并行审计正把变异体写在
// 那上面 ⇒ 别人的基线被我的变异体打红（fixture 期望 a1 实得 v1，路由签名），
// 目标被误判"基线失败"整轮跳过 —— 该目标**完全没被验证**还报非零，两头都是错的。
// 并行只在"目标间无 import 耦合"时才成立，而耦合检查做不对就等于没做 —— 串行。
const JOBS = 1;
let cursor = 0;
const runOne = (f) =>
  new Promise((resolve) => {
    console.log(`\n=== site 口径审计：${f} ===`);
    // 异步 spawn 而不是 spawnSync：spawnSync 会阻塞事件循环，"并行池"就退化成串行。
    const child = spawn(
      process.execPath,
      // 传**完整相对路径**而不是 basename：mutation-check 的 --file 匹配
      // 收紧为「全路径精确 / 路径末段」后，全路径命中唯一目标。此前传
      // basename（如 store）会把同名/含名的其他目标拖进同一轮，任何一个
      // 基线失败都会算到当前目标头上（2026-09-29 CI windows 教训）。
      [path.join(ROOT, "scripts", "mutation-check.mjs"), "--mode=site", `--file=${f}`, "--limit=999"],
      { cwd: ROOT, stdio: "inherit" },
    );
    child.on("close", (code) => {
      if (code !== 0) failed.push(f);
      resolve();
    });
    child.on("error", (e) => {
      console.error(`无法启动审计子进程（${f}）：${e.message}`);
      failed.push(f);
      resolve();
    });
  });
const workers = Array.from({ length: Math.min(JOBS, hits.length) }, async () => {
  while (cursor < hits.length) {
    const f = hits[cursor];
    cursor += 1;
    if (!f) break;
    await runOne(f);
  }
});
await Promise.all(workers);
// 并行下的偶发失败（2026-10-11 实测：index/platform/serve-main 的测试会起真实
// 服务/子进程，三个 worker 并发时互相打架，单跑各绿）—— 池排空后对失败目标
// **单跑复核**，单跑仍红才是真红。复核是顺序的，结论确定。
if (failed.length > 0) {
  const retry = [...failed];
  failed.length = 0;
  console.log(`\n[pool] ${retry.length} 个目标并行下未过 —— 单跑复核（并发打架与真失败以单跑为准）`);
  for (const f of retry) {
    await runOne(f);
  }
}
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} 个被改到的目标文件未通过逐位点审计：`);
  for (const f of failed) console.error(`  ${f}`);
  console.error("处置：补断言；确认是等价变异则进 EQUIVALENT_SITES 并写理由（别放宽 MAX_SURVIVORS）。");
  process.exit(1);
}
console.log(`\nPASS: 本次改动涉及的 ${hits.length} 个变异目标已全部逐位点审计通过`);
