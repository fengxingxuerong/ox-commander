/**
 * import-headless-run 集成测试（零真实桌面端依赖）。
 *
 * 用临时 workspace + 临时 store 覆盖：参数与交付点校验、写入前备份、
 * 重复导入跳过，以及**项目库缺失 / 损坏时的错误路径**。
 *
 * 用法：node scripts/import-headless-run-it.mjs   （exit 0 = 通过）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const SCRIPT = path.join(root, "scripts", "import-headless-run.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-import-it-"));
const ws = path.join(tmp, "ws");
const storeDir = path.join(tmp, "store");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(storeDir, { recursive: true });
const storePath = path.join(storeDir, "projects.json");

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const firstLine = (s) => s.split("\n").find((l) => l.trim() !== "") ?? "";

// ---- 1. 参数与交付点校验 -------------------------------------------------
check("缺 --workspace 时提示用法", run([]).code === 1 && /用法/.test(run([]).out));
check(
  "workspace 不存在时拒绝",
  run(["--workspace", path.join(tmp, "nope")]).code === 1,
);

const journalPath = path.join(ws, "ox-run-journal.json");
check(
  "无 journal 时拒绝（无快照无法证明交付）",
  run(["--workspace", ws]).code === 1 && /ox-run-journal\.json/.test(run(["--workspace", ws]).out),
);

fs.writeFileSync(
  journalPath,
  JSON.stringify({ requirement: "做一个待办应用", snapshot: { allDone: [], batches: [] } }),
  "utf8",
);
check(
  "快照为空时拒绝（运行未到交付点）",
  run(["--workspace", ws]).code === 1 && /交付点/.test(run(["--workspace", ws]).out),
);

// ---- 2. 错误路径：项目库不存在 / 损坏 -------------------------------------
// 场景很现实：headless 用户第一次用这个工具时，可能从没打开过桌面端，
// projects.json 还不存在。此时必须给可行动的提示，而不是 node 的 ENOENT 堆栈。
fs.writeFileSync(
  journalPath,
  JSON.stringify({ requirement: "做一个待办应用", snapshot: { allDone: ["t1"], batches: [["t1"]] } }),
  "utf8",
);

const missing = run(["--workspace", ws, "--store", storePath]);
check(
  "项目库缺失时给出可行动的提示（不是 node 堆栈）",
  missing.code === 1 && /项目库/.test(missing.out) && !/ENOENT/.test(missing.out),
  firstLine(missing.out),
);

fs.writeFileSync(storePath, "{ 这不是 JSON", "utf8");
const corrupt = run(["--workspace", ws, "--store", storePath]);
check(
  "项目库损坏时给出可行动的提示（不是 SyntaxError 堆栈）",
  corrupt.code === 1 && /项目库/.test(corrupt.out) && !/SyntaxError/.test(corrupt.out),
  firstLine(corrupt.out),
);

fs.writeFileSync(storePath, '{"projects":[]}', "utf8");
const notArray = run(["--workspace", ws, "--store", storePath]);
check(
  "项目库是合法 JSON 但不是数组时拒绝（避免 push 到对象上）",
  notArray.code === 1 && /不是项目数组/.test(notArray.out),
  firstLine(notArray.out),
);

// ---- 3. 正常路径 ---------------------------------------------------------
fs.writeFileSync(storePath, "[]", "utf8");
const first = run(["--workspace", ws, "--store", storePath]);

if (/桌面端正在运行/.test(first.out)) {
  // 进程检查是环境相关的前置条件：桌面端开着时 projects.json 会被内存态覆盖，
  // 拒绝是对的。此时明确跳过并说明，绝不让它静默变绿。
  console.log("SKIP: OxCommander 桌面端正在运行，正常导入 / 重复导入两条路径本次未验证");
} else {
  check("正常导入 exit 0", first.code === 0, firstLine(first.out));

  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  check(
    "写入 stage=DONE 的记录",
    store.length === 1 && store[0].stage === "DONE" && store[0].requirement === "做一个待办应用",
  );
  check("快照批次随记录写入", store[0].batchesJson === '[["t1"]]');
  check("写入前生成备份（零删除偏好）", fs.existsSync(`${storePath}.backup`));

  const again = run(["--workspace", ws, "--store", storePath]);
  const after = JSON.parse(fs.readFileSync(storePath, "utf8"));
  check(
    "重复导入跳过且不污染项目库",
    again.code === 0 && /SKIP/.test(again.out) && after.length === 1,
    firstLine(again.out),
  );

  const renamed = run(["--workspace", ws, "--store", storePath, "--name", "自定义名"]);
  check(
    "--name 覆盖默认名称并视为不同项目",
    renamed.code === 0 &&
      JSON.parse(fs.readFileSync(storePath, "utf8")).some((p) => p.name === "自定义名"),
    firstLine(renamed.out),
  );
}

try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
} catch {
  /* 清理尽力而为 */
}

console.log(`\n=== 判定：${failures === 0 ? "IT PASS ✓" : `IT FAIL（${failures} 项）`} ===`);
process.exit(failures === 0 ? 0 : 1);
