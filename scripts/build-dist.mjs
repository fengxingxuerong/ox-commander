/**
 * 按当前平台选择打包目标，再调 electron-builder。
 *
 * 为什么需要它：`build:dist` 原先写死 `--win --linux`，于是一次调用里总有一半是
 * **跨平台目标** —— Windows 上打 AppImage/deb（要 Docker）、Linux 上打 NSIS（要 wine）。
 * 两个 CI job 都在 20~30 秒内失败（不是下载超时，是目标一开始就站不住），
 * 而本地 `verify` 只做产物语法检查，永远看不见这类问题 —— 打包配置此前从未真跑过。
 *
 * 默认只打**当前平台**的原生目标。确实装了 wine / Docker 的人可以用
 * `--targets=win,linux` 显式要求跨平台，责任自负。
 *
 * 为什么不直接 spawn `npx electron-builder`：npx 会在 PATH 里找 `electron-builder` 这个
 * 可执行名，而它依赖 `node_modules/.bin` 的软链 —— 本机那份 node_modules 就是缺这个软链
 * （目录与 cli.js 都在，bin 没有）。直接调 `cli.js` 与软链是否存在无关，更稳。
 *
 * 用法：node scripts/build-dist.mjs [--targets=win,linux] [--dir]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "node_modules", "electron-builder", "cli.js");

const args = process.argv.slice(2);
const wanted = args.find((a) => a.startsWith("--targets="))?.slice("--targets=".length);
const passthrough = args.filter((a) => !a.startsWith("--targets="));

/** macOS 不产出：没有签名凭据，未签名 .app 会被 Gatekeeper 拦下（见 electron-builder.yml 头）。 */
function nativeTargets() {
  if (process.platform === "win32") return ["win"];
  if (process.platform === "linux") return ["linux"];
  return [];
}

const targets = wanted ? wanted.split(",").map((s) => s.trim()).filter(Boolean) : nativeTargets();

if (targets.length === 0) {
  console.error(
    `FAIL: 当前平台（${process.platform}）没有默认打包目标。\n` +
      "macOS 刻意不产出（无签名凭据，未签名 .app 会被 Gatekeeper 拦下）；\n" +
      "要在本机出 Linux 产物请用 Docker，或用 --targets=linux 显式指定。",
  );
  process.exit(1);
}

if (!fs.existsSync(CLI)) {
  console.error(`FAIL: 找不到 electron-builder 的 cli：${CLI}\n先 npm ci（或 npm i）把依赖装全。`);
  process.exit(1);
}

const argv = [CLI, ...targets.map((t) => `--${t}`), "--publish", "never", ...passthrough];
console.log(`build-dist: 平台 ${process.platform} → 目标 ${targets.join(", ")}`);
console.log(`build-dist: node ${path.relative(ROOT, CLI)} ${argv.slice(1).join(" ")}`);

const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: "inherit" });
child.on("close", (code) => {
  if (code !== 0) {
    console.error(
      "\nbuild-dist: electron-builder 失败。最常见的三类原因：\n" +
        "  1. 打了跨平台目标 —— Windows 上的 AppImage/deb 要 Docker、Linux 上的 NSIS 要 wine；\n" +
        "     （本脚本默认只打原生目标，若这里失败说明 --targets 显式指定了跨平台）\n" +
        "  2. Electron 二进制没下载 —— 打包**不能**设 ELECTRON_SKIP_BINARY_DOWNLOAD（那是给 verify 用的）；\n" +
        "  3. 产物缺失 —— `files` 里的 dist / dist-electron / dist-headless 要先由 build 与 build:headless 产出。\n",
    );
  }
  process.exit(code ?? 1);
});
