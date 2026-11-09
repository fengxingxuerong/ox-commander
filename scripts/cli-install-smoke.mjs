/**
 * CLI 分发包的真实安装链冒烟（`npm install -g oxcommander` 那一格）。
 *
 * 为什么要有它：`smoke:cli-pkg` 盯的是手工拼出的 dist-cli/ 目录本身，而 0.4.0 的
 * 交付声明是「npm 包能装」—— 那中间还隔着 npm 的 files 白名单、bin shim 生成、
 * 安装位布局三道真手续。白名单漏登记一个目录时 npm pack 会**静默不打包**
 * （本地 dist-cli/ 里还在），bin 字段写错时 shim 指不到入口 —— 这些
 * "本机全绿、用户装了没有"的坏法，只有把 tarball 真装一遍、从安装位真跑一遍才现形。
 *
 * 冒烟盯的是**安装链**，不是包内容自洽（后者由 `smoke:cli-pkg` 管）：
 *   · npm pack 真出 tarball，白名单里的 bin/ demo/ dist-headless/ 真被打进包
 *     （files 白名单第一次有了真消费者 —— 之前那只是对本地目录的静态推断）；
 *   · 包里不混进 sourceMap / node_modules；
 *   · `npm install -g --prefix <临时前缀>` 从 tarball 离线装成功（发布包零 dependencies）；
 *   · 装完 PATH 里真有 `ox`（Windows 是 ox.cmd/ox/ox.ps1 shim 三件套）；
 *   · 从安装位跑 `ox --version`（版本不漂）、`ox receipt`（子命令路由）、
 *     `ox demo --quiet`（完整一次真交付）—— 全是从**装出来的包**里跑的，
 *     不是仓库里的 dist-cli。
 *
 * 用法：node scripts/cli-install-smoke.mjs
 *   前置：无（dist-cli 由本冒烟自己调 `build-cli-pkg.mjs` 构建；npm 在 PATH）
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = path.join(ROOT, "scripts", "build-cli-pkg.mjs");
const OUT = path.join(ROOT, "dist-cli");
/**
 * 白名单要罩住的包内文件：bin 入口、五个协议入口、随包 demo、清单自身。
 * 一律正斜杠 —— tarball 条目永远是 POSIX 分隔符，path.join 在 Windows 会给出反斜杠。
 */
const REQUIRED_ENTRIES = [
  "bin/ox.js",
  "dist-headless/headless/headless-main.js",
  "dist-headless/headless/serve-main.js",
  "dist-headless/headless/mcp-main.js",
  "dist-headless/headless/receipt-verify-main.js",
  "dist-headless/headless/chat-main.js",
  "demo/demo-deliver.mjs",
  "package.json",
];

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

/** npm / ox 都可能有 .cmd shim：不经 shell 直接 spawn 会被 Node 拒（安全限制），统一 shell 单串。 */
function runCmd(cmdStr, opts = {}) {
  return spawnSync(cmdStr, {
    shell: true,
    cwd: opts.cwd ?? ROOT,
    env: opts.env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeout,
  });
}

/** tarball 条目清单：优先 `npm pack --json` 自带的 files（npm 10+），缺失时退回 tar 列表。 */
function listTarball(packResult, tarballPath) {
  const parsed = JSON.parse(packResult.stdout || "[]");
  if (Array.isArray(parsed[0]?.files)) {
    return parsed[0].files.map((f) => String(f.path).replace(/^package\//, ""));
  }
  const tar = spawnSync(`tar -tzf "${tarballPath}"`, { shell: true, encoding: "utf8" });
  if (tar.status !== 0) return [];
  return (tar.stdout || "")
    .split("\n")
    .map((line) => line.trim().replace(/^package\//, ""))
    .filter(Boolean);
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ox-cli-install-"));
  try {
    // ① 构建 dist-cli（包不存在时本冒烟自己造，而不是常年绿在没造过的地方）
    const build = spawnSync(process.execPath, [BUILDER, "--json"], { cwd: ROOT, encoding: "utf8" });
    check("构建 dist-cli 成功", build.status === 0, `exit=${build.status} stderr=${(build.stderr || "").trim()}`);
    if (build.status !== 0) {
      console.log(build.stderr || "");
      process.exit(1);
    }

    const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

    // ② 真打包：npm pack 出 tarball（落进临时目录，dist-cli 保持干净）
    const pack = runCmd(`npm pack --json --pack-destination "${tmpRoot}"`, { cwd: OUT });
    let tarballPath = "";
    try {
      const packed = JSON.parse(pack.stdout || "[]");
      tarballPath = path.join(tmpRoot, packed[0]?.filename ?? "");
    } catch {
      // JSON 解析失败留给下面的状态码断言去报
    }
    check(
      "npm pack 产出 tarball",
      pack.status === 0 && !!tarballPath && fs.existsSync(tarballPath),
      `exit=${pack.status} out=${(pack.stdout || "").slice(0, 120)} err=${(pack.stderr || "").slice(0, 200)}`,
    );
    if (pack.status !== 0 || !tarballPath || !fs.existsSync(tarballPath)) {
      process.exit(1);
    }

    // ③ 白名单的真消费者：断言名单上的文件真被打进 tarball（漏登记 → npm 静默不打包）
    const entries = listTarball(pack, tarballPath);
    for (const rel of REQUIRED_ENTRIES) {
      check(`tarball 含 ${rel}`, entries.includes(rel), `共 ${entries.length} 个条目`);
    }
    const leakedMaps = entries.filter((e) => e.endsWith(".map"));
    const leakedModules = entries.filter((e) => e.split("/").includes("node_modules"));
    check("tarball 无 sourceMap", leakedMaps.length === 0, leakedMaps.slice(0, 3).join(" / "));
    check("tarball 无 node_modules", leakedModules.length === 0, leakedModules.slice(0, 3).join(" / "));

    // ④ 真安装：从 tarball 离线装入临时全局前缀（发布包零 dependencies，不需要网络）
    const prefix = path.join(tmpRoot, "prefix");
    const install = runCmd(
      `npm install -g --prefix "${prefix}" "${tarballPath}" --no-audit --no-fund --loglevel=error`,
    );
    check("tarball 离线安装成功", install.status === 0,
      `exit=${install.status} err=${(install.stderr || "").slice(-200)}`);
    if (install.status !== 0) {
      console.log(install.stderr || "");
      process.exit(1);
    }

    // ⑤ shim 真在盘上：这是 bin 字段正确性的第一手证据（装了但敲 ox 无效 = shim 没生成）
    const shims = process.platform === "win32"
      ? ["ox.cmd", "ox", "ox.ps1"]
      : [path.join("bin", "ox")];
    for (const shim of shims) {
      check(`安装位 shim 存在 ${shim}`, fs.existsSync(path.join(prefix, shim)), path.join(prefix, shim));
    }

    // ⑥ 从安装位跑：PATH 指向临时前缀，`ox` 就像装好的全局命令一样被找到
    const env = { ...process.env, PATH: `${prefix}${path.delimiter}${process.env.PATH ?? ""}` };
    const version = runCmd("ox --version", { env });
    check("安装位 ox --version 与仓库版本一致",
      version.status === 0 && (version.stdout || "").trim() === rootVersion,
      `exit=${version.status} out=${(version.stdout || "").trim()} 期望 ${rootVersion}`);

    // 子命令路由：拿到复核工具的报错，不是 run 的报错
    const receipt = runCmd("ox receipt no-such-file.json", { env });
    const receiptOut = `${receipt.stdout || ""}${receipt.stderr || ""}`;
    check("安装位 receipt 子命令路由到复核入口",
      receipt.status === 1 && receiptOut.includes("读不了凭据"),
      `exit=${receipt.status} out=${receiptOut.slice(0, 120)}`);

    // demo 从安装位跑完一次真实交付：装出来的 dist-headless 要真能规划/派单/门禁/出凭据/被复核
    const demo = runCmd("ox demo --quiet", { env, timeout: 120_000 });
    const demoOut = `${demo.stdout || ""}${demo.stderr || ""}`;
    check("安装位 demo 跑完一次真实交付", demo.status === 0
      && demoOut.includes("一次真实交付完成") && !demoOut.includes("FAIL:"),
      `exit=${demo.status} out=${demoOut.slice(-200)}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(failures === 0
    ? "\nCLI 真安装链冒烟全部通过 ✅"
    : `\nCLI 真安装链冒烟失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
