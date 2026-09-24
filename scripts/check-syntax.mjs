/**
 * scripts/ 语法门禁：对本目录（含子目录）所有 .mjs/.cjs/.js 做 node --check。
 *
 * 背景：scripts 层已成长为关键基础设施（runner、三座桥、网关、验收套件），
 * 但 vitest/eslint/tsc 都不覆盖它——一个语法错误只会在运行时才爆。
 * 本门禁让 verify 在构建前就把整层脚本钉死。
 *
 * 为什么现在也收 `.js`：原先只收 `.mjs/.cjs`，于是
 * `scripts/acceptance/csvstat-acceptance.test.js`（独立验收套件模板）两头都不沾——
 * vitest 不收它（不在 test.include 里）、本门禁也不收它。一个语法坏掉的验收套件
 * 会在"验收方真的拿去用"那天才炸，而本仓库的门禁全程绿。
 * 它被 vitest 排除是**有理由的**（见 check-tests-collected.mjs 的 ACCEPTED），
 * 但"不被执行"不等于"不该做语法检查"——这两件事被同一个盲区一起漏掉了。
 *
 * ⚠️ `.js` 按 CommonJS 解析：本仓库 package.json 没有 `"type": "module"`，
 * `node --check` 对 `.js` 走 CJS，所以 `require()` 正常、`import` 会报错。
 * 若将来 scripts/ 下出现 ESM 的 `.js`，把它改成 `.mjs`（而不是放宽本门禁）。
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
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(p);
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
