/**
 * Artifact-layer offline smoke: no network, no API keys.
 *
 * Unit tests run against sources via vitest's transform pipeline, so they can
 * never catch "compiles but the artifact is broken" failures (the historical
 * `"type": "module"` incident shipped exactly that way). This script checks the
 * built artifacts directly and is part of `npm run verify`:
 *
 *   1. renderer bundle exists (dist/index.html)
 *   2. every emitted CJS file under dist-electron parses (`node --check`)
 *   3. the headless binary speaks its protocol: invalid stdin  → exit 1 + JSON
 *      error event; spec missing projectRoot → exit 1 with a named message
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

// 1. renderer bundle
const rendererIndex = path.join(root, "dist", "index.html");
check("dist/index.html exists", fs.existsSync(rendererIndex));

// 2. every dist-electron file is parseable CJS
const distElectron = path.join(root, "dist-electron");
const cjsFiles = [];
if (fs.existsSync(distElectron)) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) cjsFiles.push(p);
    }
  };
  walk(distElectron);
}
check("dist-electron has emitted files", cjsFiles.length > 0, `${cjsFiles.length} files`);
// 并行 `node --check`（53 个文件串行约 3.5s，并行约 0.7s）——同 check-syntax
// 的优化：产物冒烟每秒都跑，把常量时间省下来。输出按扫描序排回。
const parseResults = await Promise.all(
  cjsFiles.map(
    (file) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ file, code, err }));
      }),
  ),
);
let parseErrors = 0;
for (const r of parseResults) {
  if (r.code !== 0) {
    parseErrors += 1;
    console.error(`  node --check ${path.relative(root, r.file)}\n${r.err}`);
  }
}
check(`node --check across ${cjsFiles.length} dist-electron files`, parseErrors === 0, `${parseErrors} errors`);
check("dist-electron/electron/main.js exists", fs.existsSync(path.join(distElectron, "electron", "main.js")));

// 3. headless binary protocol
const headless = path.join(root, "dist-headless", "headless", "headless-main.js");
check("dist-headless/headless/headless-main.js exists", fs.existsSync(headless));
if (fs.existsSync(headless)) {
  const run = (stdinText) =>
    spawnSync(process.execPath, [headless], { input: stdinText, encoding: "utf8" });

  const badJson = run("not json");
  let event = null;
  try {
    event = JSON.parse(badJson.stdout);
  } catch {
    /* keep null */
  }
  check(
    "headless: invalid JSON stdin → exit 1 + error event",
    badJson.status === 1 && event?.type === "error",
    `exit=${badJson.status} event=${event?.type ?? "none"}`,
  );

  const noRoot = run(JSON.stringify({ requirement: "x" }));
  let event2 = null;
  try {
    event2 = JSON.parse(noRoot.stdout);
  } catch {
    /* keep null */
  }
  check(
    "headless: spec missing projectRoot → exit 1 + named message",
    noRoot.status === 1 && event2?.type === "error" && /projectRoot/.test(event2.message ?? ""),
    `exit=${noRoot.status} msg=${event2?.message ?? "none"}`,
  );
}

// 3b. MCP stdio server protocol（反向 MCP，竞品 5.5 的产物层冒烟）
const mcpMain = path.join(root, "dist-headless", "headless", "mcp-main.js");
check("dist-headless/headless/mcp-main.js exists", fs.existsSync(mcpMain));
if (fs.existsSync(mcpMain)) {
  const runMcp = (stdinText) =>
    spawnSync(process.execPath, [mcpMain, "--serve-url=http://127.0.0.1:1"], {
      input: stdinText,
      encoding: "utf8",
    });
  // initialize → tools/list 两连发：握手响应带 protocolVersion，工具表非空。
  // --serve-url 指向一个必然拒绝的端口：tools/list 不发 HTTP，响应不受影响 ——
  // 同时证明"stdout 只出协议、stderr 才是日志"的纪律。
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    "",
  ].join("\n");
  const r = runMcp(lines);
  const outLines = r.stdout.trim().split("\n").filter(Boolean);
  let init = null;
  let tools = null;
  try {
    init = JSON.parse(outLines[0] ?? "null");
    tools = JSON.parse(outLines[1] ?? "null");
  } catch {
    /* keep null */
  }
  check(
    "mcp: initialize + tools/list over stdio",
    init?.result?.protocolVersion === "2024-11-05" &&
      Array.isArray(tools?.result?.tools) &&
      tools.result.tools.length === 6,
    `lines=${outLines.length} tools=${tools?.result?.tools?.length ?? "none"}`,
  );
  const bad = runMcp("not json\n");
  check(
    "mcp: 非法 JSON 行被忽略（不回话、不崩、stdin 关闭后退出 0）",
    bad.status === 0 && bad.stdout.trim() === "",
    `exit=${bad.status} stdout=${bad.stdout.trim().slice(0, 40)}`,
  );
}

if (failed > 0) {
  console.error(`\nartifact smoke: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nartifact smoke: all checks passed");
