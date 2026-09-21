/**
 * 把 headless --real 运行的交付物导入桌面端项目库（打通两世界隔离）。
 *
 * 用法：
 *   node scripts/import-headless-run.mjs --workspace <dir> [--name <名称>]
 *
 * 行为：
 *   1. 读取 <workspace>/ox-run-journal.json（必须存在——无快照的运行无法证明交付）
 *   2. 校验桌面端未运行（避免 projects.json 写冲突）
 *   3. 备份 projects.json → projects.json.backup（零删除偏好）
 *   4. 以 stage=DONE 写入项目记录（名称默认取 journal 首行需求的 slug）
 *
 * 安全：桌面端运行时拒绝执行；写入前自动备份；已存在的同名项目跳过。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i > -1 && args[i + 1] ? path.resolve(args[i + 1]) : undefined;
}
const workspace = argOf("--workspace");
if (!workspace || !fs.existsSync(workspace)) {
  console.error("用法：node scripts/import-headless-run.mjs --workspace <ox-multiagent-XXX 目录>");
  process.exit(1);
}
const journalPath = path.join(workspace, "ox-run-journal.json");
if (!fs.existsSync(journalPath)) {
  console.error("FAIL: 工作区无 ox-run-journal.json —— 只有完成过快照的运行才能导入");
  process.exit(1);
}
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const snapshot = journal.snapshot ?? {};
const allDone = snapshot.allDone ?? [];
if (allDone.length === 0) {
  console.error("FAIL: 快照显示没有任何已完成任务（运行未到达交付点）");
  process.exit(1);
}

const userData = argOf("--store")
  ? path.dirname(argOf("--store"))
  : path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "ox-commander",
      "data",
    );
const storePath = path.join(userData, "projects.json");

// 桌面端运行中 → 拒绝（projects.json 会被应用内存态覆盖）
const { execSync } = await import("node:child_process");
try {
  const out = execSync(
    `powershell -NoProfile -Command "(Get-Process | Where-Object { $_.ProcessName -match 'OxCommander|electron' }).Count"`,
    { encoding: "utf8" },
  ).trim();
  if (Number(out) > 0) {
    console.error("FAIL: OxCommander 桌面端正在运行——projects.json 会被内存态覆盖。请先关闭桌面端再导入。");
    process.exit(1);
  }
} catch {
  /* 查询失败不阻断（保守继续，写入前仍有备份） */
}

const store = JSON.parse(fs.readFileSync(storePath, "utf8").replace(/^\uFEFF/, ""));
const nameArg = args.indexOf("--name");
const name =
  nameArg > -1 && args[nameArg + 1]
    ? args[nameArg + 1]
    : `headless: ${journal.requirement.slice(0, 40)}${journal.requirement.length > 40 ? "…" : ""}`;

if (store.some((p) => p.name === name)) {
  console.log(`SKIP: 已存在同名项目「${name}」，不重复导入`);
  process.exit(0);
}

// 写入前备份（零删除偏好）
fs.copyFileSync(storePath, storePath + ".backup");

const now = new Date().toISOString();
const id = `headless-${Date.now()}`;
const record = {
  id,
  name,
  requirement: journal.requirement,
  stage: "DONE",
  prdJson: undefined,
  batchesJson: JSON.stringify(snapshot.batches),
  smokeJson: JSON.stringify(snapshot.smoke ?? []),
  createdAt: now,
  updatedAt: now,
};
store.push(record);
fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");

console.log(`PASS: 已导入项目「${name}」`);
console.log(`  id: ${id} | 阶段: DONE | 完成任务: ${allDone.length}/${snapshot.batches.flat().length}`);
console.log(`  交付物工作区: ${workspace}`);
console.log(`  备份: ${storePath}.backup`);
console.log(`  下次打开 OxCommander 桌面端即可在项目列表看到它`);
