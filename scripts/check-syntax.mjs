/**
 * scripts/ 语法门禁：对本目录（含子目录）所有 .mjs/.cjs 做 node --check。
 *
 * 背景：scripts 层已成长为关键基础设施（runner、三座桥、网关、验收套件），
 * 但 vitest/eslint/tsc 都不覆盖它——一个语法错误只会在运行时才爆。
 * 本门禁让 verify 在构建前就把整层脚本钉死。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = [];
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs")) files.push(p);
  }
})(dir);

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    bad += 1;
    console.error(`✗ ${path.relative(dir, f)}\n${r.stderr}`);
  }
}
console.log(`scripts 语法检查：${files.length - bad}/${files.length} 通过`);
if (bad > 0) process.exit(1);
