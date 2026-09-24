/**
 * scripts/ 语法门禁：对本目录（含子目录）所有 .mjs/.cjs 做 node --check。
 *
 * 背景：scripts 层已成长为关键基础设施（runner、三座桥、网关、验收套件），
 * 但 vitest/eslint/tsc 都不覆盖它——一个语法错误只会在运行时才爆。
 * 本门禁让 verify 在构建前就把整层脚本钉死。
 */
import { spawn } from "node:child_process";
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

/**
 * 并行 `node --check`：23 个脚本串行 spawn 约 2.8s，并行约 0.8s ——
 * 门禁每秒都跑，这个常数值得省。spawn 并发不会打爆机器（瞬时 20+ 个
 * 轻量进程，--check 只做语法解析），输出顺序按文件扫描序排回。
 */
function check(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ file, code, err }));
  });
}

const results = await Promise.all(files.map((f) => check(f)));
const bad = [];
for (const r of results) {
  if (r.code !== 0) bad.push(r);
}
for (const r of bad) {
  console.error(`✗ ${path.relative(dir, r.file)}\n${r.err}`);
}
console.log(`scripts 语法检查：${files.length - bad.length}/${files.length} 通过`);
if (bad.length > 0) process.exit(1);
