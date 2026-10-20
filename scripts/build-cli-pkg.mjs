/**
 * 打包 npx 可分发的 CLI 包 → `dist-cli/`（git 忽略，构建产物）。
 *
 * 为什么存在：桌面端的分发物是几十 MB 的安装包，而 headless 这一侧真正的门槛是
 * 「先 clone 仓库、装 devDeps、跑 tsc」—— 外部宿主只想 `npx oxcommander` 驱动一次 run。
 * 这一格是竞品对位里最便宜的一格（cezar `npx cezar-run`、superset `brew install`），
 * 缺了它，1723 处逐点验证过的判据对陌生人来说等于不存在（没人会为了试一下先装 Electron）。
 *
 * 产出形态刻意极小：只有 `bin/ox.js` + `dist-headless/`（不含 sourceMap）+ 一份英文 README。
 * 不含 Electron、不含 React、不含 devDependencies —— `files` 白名单是唯一把关的地方，
 * 所以新增产物目录要显式登记，别指望 npm 的默认行为。
 *
 * 用法：
 *   node scripts/build-cli-pkg.mjs            # 构建 dist-cli/
 *   node scripts/build-cli-pkg.mjs --json     # 机器可读摘要（smoke 用）
 *
 * 前置：`dist-headless/` 已存在（先 `npm run build:headless`）。不存在就 exit 2 并说明，
 * 不静默产出半个包 —— 半个包的 `--version` 照样能过，而 `ox` 一跑就崩。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "dist-headless");
const OUT = path.join(ROOT, "dist-cli");
const ENTRY_DIR = path.join(SRC, "headless");

/** 发布时排除：sourceMap 只是体积，.tsbuildinfo 是本机增量状态。 */
const EXCLUDE_SUFFIX = [".map", ".tsbuildinfo"];

const BIN_SOURCE = [
  '#!/usr/bin/env node',
  '"use strict";',
  '/**',
  ' * ox —— OxCommander CLI（`npx oxcommander`）。',
  ' *',
  ' * 这一层只做「找入口 + 转发」：不加参数解析、不改协议、不吞退出码。',
  ' * 协议与事件的所有语义都在 dist-headless 里，CLI 只是让它不需要 clone 仓库就能被摸到。',
  ' *',
  ' *   ox                     读 stdin 的 spec，跑一次交付（等价原 headless-main）',
  ' *   ox serve --port=8787   常驻服务（状态页 + SSE）',
  ' *   ox mcp                 MCP stdio server（接进 agent 生态）',
  ' *   ox receipt <file>      独立复核一份交付凭据',
  ' *   ox chat [exec|resume]  交互式编码智能体（REPL / 单发 / 恢复）',
  ' */',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { spawn } = require("node:child_process");',
  '',
  'const DIST = path.join(__dirname, "..", "dist-headless", "headless");',
  'const ENTRIES = {',
  '  run: "headless-main.js",',
  '  serve: "serve-main.js",',
  '  mcp: "mcp-main.js",',
  '  receipt: "receipt-verify-main.js",',
  '  chat: "chat-main.js",',
  '};',
  '',
  'const USAGE = [',
  '  "ox - OxCommander CLI",',
  '  "",',
  '  "  ox                     run a delivery from a spec on stdin (JSONL events on stdout)",',
  '  "  ox serve --port=8787   long-running server: status page + SSE events + POST /run",',
  '  "  ox mcp                 MCP stdio server (ox_status / ox_receipt / ox_events / ox_run / ox_control)",',
  '  "  ox receipt <file>      verify a delivery receipt independently (--replay re-runs its checks)",',
  '  "  ox chat                interactive coding agent (REPL; /help for commands)",',
  '  "  ox chat exec \\"<prompt>\\" run one prompt (--json for JSONL events)",',
  '  "  ox chat resume [id]    continue the latest or a named session",',
  '  "",',
  '  "  --version, -V          print version",',
  '  "  --help, -h             print this help",',
  '  "",',
  '  "Docs: https://github.com/fengxingxuerong/ox-commander#readme",',
  '].join("\\n");',
  '',
  'function bail(msg) {',
  '  process.stderr.write("ox: " + msg + "\\n");',
  '  process.exit(1);',
  '}',
  '',
  'const argv = process.argv.slice(2);',
  '',
  'if (argv.indexOf("--version") !== -1 || argv.indexOf("-V") !== -1) {',
  '  process.stdout.write(require("../package.json").version + "\\n");',
  '  process.exit(0);',
  '}',
  '',
  '// 子命令自己的 --help 要转发进去（ox chat --help 是一份 chat 专属用法）；',
  '// 其余子命令保持原行为：打印全局 USAGE，避免 serve --help 真的起服务。',
  'const chatHelp = argv[0] === "chat" && (argv.indexOf("--help") !== -1 || argv.indexOf("-h") !== -1);',
  'if (!chatHelp && (argv.indexOf("--help") !== -1 || argv.indexOf("-h") !== -1)) {',
  '  process.stdout.write(USAGE + "\\n");',
  '  process.exit(0);',
  '}',
  '',
  'if (!fs.existsSync(DIST)) {',
  '  bail("bundled build not found at " + DIST + " — this install is incomplete.");',
  '}',
  '',
  'if (argv.length === 0 && process.stdin.isTTY) {',
  '  process.stdout.write(USAGE + "\\n");',
  '  process.exit(0);',
  '}',
  '',
  '/** 子命令只在首参数精确匹配时才吞掉它：其余一切原样转发给 run 入口。 */',
  'const head = argv.length > 0 ? argv[0] : "run";',
  'const isSubcommand = Object.prototype.hasOwnProperty.call(ENTRIES, head);',
  'const entry = ENTRIES[head] !== undefined ? ENTRIES[head] : ENTRIES.run;',
  'const rest = isSubcommand ? argv.slice(1) : argv;',
  '',
  'const child = spawn(process.execPath, [path.join(DIST, entry)].concat(rest), { stdio: "inherit" });',
  'child.on("error", function (err) { bail(String(err && err.message)); });',
  'child.on("exit", function (code, signal) {',
  '  if (signal !== null && signal !== undefined) { process.exit(1); }',
  '  process.exit(code === null || code === undefined ? 0 : code);',
  '});',
  '',
].join("\n");

const PACKAGE_README = [
  "# ox",
  "",
  "OxCommander CLI — decompose a requirement, dispatch tasks to executors in parallel,",
  "gate the result on build + typecheck + test, and emit a **delivery receipt** you can",
  "re-verify in your own environment.",
  "",
  "```bash",
  "npx oxcommander --help",
  "echo '{\"requirement\":\"...\",\"projectRoot\":\".\"}' | npx oxcommander",
  "npx oxcommander serve --port=8787    # status page + SSE + POST /run",
  "npx oxcommander mcp                  # MCP stdio server for agent hosts",
  "npx oxcommander receipt receipt.json --replay",
  "npx oxcommander chat exec \"fix the failing test\" --json",
  "```",
  "",
  "Requires Node >= 20.19 and at least one executor credential (a SenseNova API key, or a",
  "local CLI agent such as Codex / Claude Code exposed through an agent manifest).",
  "",
  "Full docs: <https://github.com/fengxingxuerong/ox-commander#readme>",
  "",
].join("\n");

function readRootPackage() {
  const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  return JSON.parse(raw);
}

function copyTree(from, to) {
  let files = 0;
  let bytes = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const srcPath = path.join(from, name);
    const destPath = path.join(to, name);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      const sub = copyTree(srcPath, destPath);
      files += sub.files;
      bytes += sub.bytes;
      continue;
    }
    if (EXCLUDE_SUFFIX.some((suffix) => name.endsWith(suffix))) continue;
    fs.copyFileSync(srcPath, destPath);
    files += 1;
    bytes += stat.size;
  }
  return { files, bytes };
}

function writeBin(dir) {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "ox.js");
  fs.writeFileSync(file, BIN_SOURCE, "utf8");
  return file;
}

function writePackage(dir, version) {
  const manifest = {
    name: "oxcommander",
    version,
    description:
      "Commander agent: decompose a requirement, dispatch executors in parallel, gate on build/typecheck/test, deliver one verified result with a re-verifiable receipt.",
    license: "MIT",
    author: "fengxingxuerong",
    bin: { ox: "bin/ox.js" },
    // 白名单即把关：新增随包发布的目录必须显式登记在这里。
    files: ["bin", "dist-headless", "README.md"],
    engines: { node: ">=20.19" },
    keywords: ["agent", "orchestrator", "multi-agent", "coding-agent", "ade", "headless", "mcp"],
    repository: { type: "git", url: "git+https://github.com/fengxingxuerong/ox-commander.git" },
    homepage: "https://github.com/fengxingxuerong/ox-commander#readme",
  };
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function main() {
  if (!fs.existsSync(ENTRY_DIR)) {
    process.stderr.write(
      `dist-headless/headless not found — run \`npm run build:headless\` first.\n` +
        `  expected: ${ENTRY_DIR}\n`,
    );
    process.exit(2);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const version = readRootPackage().version;
  const manifest = writePackage(OUT, version);
  const binPath = writeBin(OUT);
  const copied = copyTree(SRC, path.join(OUT, "dist-headless"));
  fs.writeFileSync(path.join(OUT, "README.md"), PACKAGE_README, "utf8");

  const summary = {
    outDir: OUT,
    name: manifest.name,
    version: manifest.version,
    bin: path.relative(ROOT, binPath),
    copiedFiles: copied.files,
    copiedBytes: copied.bytes,
    entries: ["run", "serve", "mcp", "receipt", "chat"],
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  const kb = Math.round(copied.bytes / 1024);
  process.stdout.write(
    `CLI package ready: ${OUT}\n` +
      `  ${manifest.name}@${manifest.version} · bin ox → ${summary.bin}\n` +
      `  dist-headless: ${copied.files} files, ${kb} KiB (sourceMap excluded)\n` +
      `  subcommands: ${summary.entries.join(" / ")}\n` +
      `  publish: cd dist-cli && npm publish\n`,
  );
}

main();
