/**
 * CLI 分发包的端到端冒烟（`npx oxcommander` 那一格）。
 *
 * 为什么要有它：这一格的价值是「陌生人一条命令能摸到产物」，而它最容易坏的方式
 * 恰恰是**表面正常**——`ox --version` 照样打印、包照样能 pack，但 `dist-headless`
 * 少拷了一个入口、`bin` 指到了不存在的文件、子命令被当成 run 转发。
 * 这些在仓库里跑测试时全看不见（没人从 dist-cli 里启动过它）。
 *
 * 冒烟盯的是**包本身**，不是 headless 的协议行为（后者由 `smoke:artifact` / `smoke:demo` 管）：
 *   · 包是自洽的：bin 指向的文件真在盘上，五个入口都在；
 *   · 版本与仓库一致（不与根 package.json 漂移）；
 *   · 转发真的工作：非法 spec 走 run 入口拿到协议层的 `error` 事件 + 退出码 1；
 *   · 子命令路由真的工作：`receipt` 拿到的是复核工具的报错，而不是 run 的报错；
 *   · 发布面干净：不带 sourceMap、不带 electron / devDependencies。
 *
 * 用法：node scripts/cli-pkg-smoke.mjs
 *   前置：npm run build:headless（本冒烟自己会调 `build-cli-pkg.mjs` 构建 dist-cli）
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(ROOT, "scripts", "build-cli-pkg.mjs");
const OUT = path.join(ROOT, "dist-cli");
const BIN = path.join(OUT, "bin", "ox.js");
const ENTRY_DIR = path.join(OUT, "dist-headless", "headless");
const ENTRIES = ["headless-main.js", "serve-main.js", "mcp-main.js", "receipt-verify-main.js", "chat-main.js"];

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS: ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL: ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function runBin(args, input) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: OUT,
    shell: false,
    input: input === undefined ? undefined : input,
    encoding: "utf8",
  });
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function main() {
  // ① 先构建：包不存在时本冒烟自己造，而不是报「先跑 build」（那样它会常年绿在没造过的地方）
  const build = spawnSync(process.execPath, [BUILDER, "--json"], { cwd: ROOT, encoding: "utf8" });
  check("构建 dist-cli 成功", build.status === 0, `exit=${build.status} stderr=${(build.stderr || "").trim()}`);
  if (build.status !== 0) {
    console.log(build.stderr || "");
    process.exit(1);
  }

  const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "package.json"), "utf8"));

  // ② manifest：可发布的最小面
  check("包名与版本正确", manifest.name === "oxcommander" && manifest.version === rootVersion,
    `name=${manifest.name} version=${manifest.version} 期望 ${rootVersion}`);
  check("非 private（publish 不被 npm 拒）", manifest.private !== true, "private 为 true 时 npm publish 直接失败");
  check("有 bin 入口", typeof manifest.bin === "object" && typeof manifest.bin.ox === "string", JSON.stringify(manifest.bin));
  check("bin 指向的文件在盘上", fs.existsSync(BIN), BIN);
  check("engines.node 与仓库一致", manifest.engines && manifest.engines.node === ">=20.19", JSON.stringify(manifest.engines));
  const files = manifest.files || [];
  check("files 白名单含 bin 与 dist-headless", files.includes("bin") && files.includes("dist-headless"), JSON.stringify(files));
  check("不带 devDependencies", manifest.devDependencies === undefined, "发布包不该带 electron/ vitest 等");

  // ③ 五个入口都在（少一个 = 那个子命令一按就崩）
  for (const entry of ENTRIES) {
    check(`入口存在 ${entry}`, fs.existsSync(path.join(ENTRY_DIR, entry)), path.join(ENTRY_DIR, entry));
  }

  // ④ 版本与帮助：CLI 自身
  const version = runBin(["--version"]);
  check("--version 输出与仓库版本一致", version.status === 0 && (version.stdout || "").trim() === rootVersion,
    `exit=${version.status} out=${(version.stdout || "").trim()}`);
  const help = runBin(["--help"]);
  const helpText = help.stdout || "";
  check("--help 列出子命令", help.status === 0
    && ["serve", "mcp", "receipt", "chat"].every((word) => helpText.includes(word)),
    `exit=${help.status}`);

  // ⑤ 转发非空转：非法 spec 必须走 run 入口、拿到协议层的 error 事件（不是 CLI 自己编的错）
  const badSpec = runBin([], '{"bad":1}\n');
  const badOut = badSpec.stdout || "";
  check("非法 spec 转发到 run 入口（协议层 error）", badSpec.status === 1 && badOut.includes('"type":"error"'),
    `exit=${badSpec.status} out=${badOut.slice(0, 120)}`);

  // ⑥ 子命令路由：拿到的必须是复核工具的报错，不是 run 的报错
  const receipt = runBin(["receipt", "no-such-file.json"]);
  const receiptErr = `${receipt.stdout || ""}${receipt.stderr || ""}`;
  check("receipt 子命令路由到复核入口", receipt.status === 1 && receiptErr.includes("读不了凭据"),
    `exit=${receipt.status} out=${receiptErr.slice(0, 120)}`);

  // ⑦ 新增 chat 子命令也真的路由到自己的入口（不是被当成 run 转发）
  const chatHelp = runBin(["chat", "--help"]);
  check("chat 子命令路由到 chat 入口", chatHelp.status === 0
    && `${chatHelp.stdout || ""}`.includes("ox chat - interactive coding agent"),
    `exit=${chatHelp.status} out=${(chatHelp.stdout || chatHelp.stderr || "").slice(0, 160)}`);

  // ⑧ 发布面干净：不带 sourceMap、不带 node_modules
  const packed = walk(OUT);
  check("包内无 sourceMap", packed.every((p) => !p.endsWith(".map")),
    packed.filter((p) => p.endsWith(".map")).slice(0, 3).join(" / "));
  check("包内无 node_modules", packed.every((p) => !p.split(path.sep).includes("node_modules")));
  check("包内有入口产物", packed.some((p) => p.endsWith(path.join("dist-headless", "headless", "headless-main.js"))));

  console.log(failures === 0
    ? `\nCLI 分发包冒烟全部通过 ✅（${packed.length} 个文件）`
    : `\nCLI 分发包冒烟失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
