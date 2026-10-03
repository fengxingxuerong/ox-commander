/**
 * 交付凭据复核工具的端到端冒烟（P0-②）。
 *
 * 为什么要有它：`receipt-verify-main.ts` 是"外部的人能自己复核交付结论"的
 * **唯一入口**。它整层是 IO 胶水 —— 读文件、解析 argv、决定退出码、可选复跑。
 * 单测（`src/delivery-receipt.test.ts`）覆盖的是 `shared/delivery-receipt.ts`
 * 的纯逻辑；胶水错了（退出码反过来、`--replay` 忘了传 cwd、tampered 还去复跑）
 * 单测一律看不见 —— 而退出码恰恰是下游流水线唯一消费的东西。
 *
 * 边界：被测对象是 `dist-headless` 里的**编译产物**，以**子进程**方式运行
 * （真 argv、真 stdout/stderr、真退出码）。不做进程内 import —— 那个入口
 * import 即执行，且绕过 argv 就绕过了本冒烟要验的整层。
 *
 * 每个用例都带**非空转证据**：
 *   · 复跑类用例里，命令会写一个标记文件 —— 断言标记存在，才算"命令真的跑了"；
 *   · tampered + --replay 用例里，断言标记**不存在** —— 证明指纹不符时确实没有复跑。
 * 只断言退出码是不够的：一个"什么都不做、只返回预期码"的实现也能全过。
 *
 * 用法：node scripts/receipt-verify-smoke.mjs
 *   前置：npm run build:headless（消费 dist-headless 的产物）
 *   exit 0 = 全部通过；exit 1 = 有 FAIL 行
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist-headless", "headless", "receipt-verify-main.js");
const LIB = path.join(ROOT, "dist-headless", "shared", "delivery-receipt.js");

if (!fs.existsSync(CLI)) {
  console.error(`FAIL: 找不到 ${path.relative(ROOT, CLI)} —— 先跑 npm run build:headless`);
  process.exit(1);
}

/** 指纹用**产物里的**生产实现算，而不是在本脚本里重写一遍算法。 */
const { sealReceipt } = createRequire(import.meta.url)(LIB);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------- 凭据构造 */

function makeReceipt(over = {}) {
  return {
    outcome: "delivered",
    verified: true,
    rounds: 0,
    checks: [],
    tasks: [],
    conflicts: [],
    counts: {
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      conflicts: 0,
      checksFailed: 0,
      preexisting: 0,
    },
    headline: "已交付：0/0 个任务完成",
    ...over,
  };
}

/** 一条带命令的凭据检查（可被 --replay 复跑）。 */
const commandCheck = (kind, script) => ({
  kind,
  ok: true,
  exitCode: 0,
  preexisting: false,
  headline: "",
  command: "node",
  args: [script],
});

/* --------------------------------------------------------------- 跑 CLI */

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let failures = 0;

/**
 * @param label  用例名
 * @param want   期望退出码
 * @param probe  额外断言（拿整份运行结果），返回 true 表示通过
 */
async function expect(label, args, want, probe, workdir) {
  const res = await runCli(args, workdir);
  const probes = probe ? probe(res) : [];
  const badProbe = probes.filter((p) => !p.ok);
  const codeOk = res.code === want;
  const ok = codeOk && badProbe.length === 0;
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${label}`);
    if (!codeOk) {
      console.log(`      退出码 期望 ${want} / 实际 ${res.code}`);
    }
    for (const p of badProbe) console.log(`      断言失败：${p.what}`);
    // 出错时把尾巴打出来，否则排查要重跑一遍
    console.log(`      stdout: ${res.stdout.split("\n").slice(0, 12).join(" / ")}`);
    if (res.stderr.trim()) console.log(`      stderr: ${res.stderr.trim().split("\n").slice(-4).join(" / ")}`);
  }
  return res;
}

const has = (text, needle, what) => ({ ok: text.includes(needle), what: `${what ?? needle}（输出里没出现）` });

/* ---------------------------------------------------------------- 用例 */

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-receipt-smoke-"));

  // 复跑用的真实脚本：先落标记，再决定退出码 —— 标记本身就是"真的执行过"的证据。
  fs.writeFileSync(path.join(tmp, "ok.js"), 'require("fs").writeFileSync("marker-ok.txt","");\n');
  fs.writeFileSync(path.join(tmp, "fail.js"), 'require("fs").writeFileSync("marker-fail.txt","");\nprocess.exit(1);\n');
  // 若 tampered 用例误去复跑，这个标记就会冒出来
  fs.writeFileSync(path.join(tmp, "sentinel.js"), 'require("fs").writeFileSync("marker-sentinel.txt","");\n');

  const write = (name, obj) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const marker = (n) => fs.existsSync(path.join(tmp, n));

  // ① 盖章凭据但一条命令都没有 → 只能到 not-replayed（指纹一致 ≠ 结论为真）
  const noCmd = write("no-command.json", sealReceipt(makeReceipt(), sha256));
  await expect("T1 无命令凭据：指纹一致但仍判 not-replayed", [noCmd], 5, (res) => [
    has(res.stdout, "not-replayed", "裁决为 not-replayed"),
    has(res.stdout, "可独立复跑的命令（0 条）", "打印了 0 条可复跑命令"),
  ]);

  // ② 盖章后改一个字节 → tampered。凭据被改过，结论一律不采信。
  // 注意顺序：**先盖章、后改动**才是"被改过"；先改后盖只会得到一份合法的假凭据。
  const tamperedFile = write("tampered.json", sealReceipt(makeReceipt(), sha256));
  const tamperEdit = JSON.parse(fs.readFileSync(tamperedFile, "utf8"));
  tamperEdit.outcome = "blocked";
  fs.writeFileSync(tamperedFile, JSON.stringify(tamperEdit, null, 2));
  await expect("T2 盖章后改动内容：判 tampered", [tamperedFile], 3, (res) => [
    has(res.stdout, "tampered", "裁决为 tampered"),
    has(res.stdout, "被改过", "说明了被改过"),
  ]);

  // ③ 没有 fingerprint → unsigned（不是"被篡改"）。抹黑与"没盖章"是两件事。
  const unsigned = makeReceipt();
  delete unsigned.fingerprint;
  const unsignedFile = write("unsigned.json", unsigned);
  await expect("T3 无指纹凭据：判 unsigned（不是 tampered）", [unsignedFile], 4, (res) => [
    has(res.stdout, "unsigned", "裁决为 unsigned"),
    has(res.stdout, "没有指纹", "说明了缺指纹"),
  ]);

  // ④ --replay 复跑全绿 → verified，且命令**真的执行了**（标记文件为证）
  const okReceipt = write(
    "replay-ok.json",
    sealReceipt(makeReceipt({ checks: [commandCheck("test", "ok.js")] }), sha256),
  );
  await expect(
    "T4 --replay 复跑复现：判 verified（命令真的跑过）",
    [okReceipt, "--replay", `--cwd=${tmp}`],
    0,
    (res) => [
      has(res.stdout, "verified", "裁决为 verified"),
      has(res.stdout, "reproduced", "逐条比对为 reproduced"),
      { ok: marker("marker-ok.txt"), what: "被复跑的命令留下了标记（证明真执行）" },
    ],
  );

  // ⑤ --replay 复跑与凭据矛盾 → contradicted，同样要有"真跑过"的证据
  const badReceipt = write(
    "replay-contradict.json",
    sealReceipt(makeReceipt({ checks: [commandCheck("test", "fail.js")] }), sha256),
  );
  await expect(
    "T5 --replay 复跑矛盾：判 contradicted",
    [badReceipt, "--replay", `--cwd=${tmp}`],
    2,
    (res) => [
      has(res.stdout, "contradicted", "裁决为 contradicted"),
      { ok: marker("marker-fail.txt"), what: "被复跑的命令留下了标记（证明真执行）" },
    ],
  );

  // ⑥ 指纹不符 + --replay：**必须不复跑**（比的是假凭据，比出来的矛盾是伪证产物）
  const sentinelBase = makeReceipt({ checks: [commandCheck("test", "sentinel.js")] });
  const sentinelFile = write("tampered-replay.json", sealReceipt(sentinelBase, sha256));
  const tamperObj = JSON.parse(fs.readFileSync(sentinelFile, "utf8"));
  tamperObj.headline = "被改过的结论";
  fs.writeFileSync(sentinelFile, JSON.stringify(tamperObj, null, 2));
  await expect(
    "T6 指纹不符时即使给了 --replay 也不复跑",
    [sentinelFile, "--replay", `--cwd=${tmp}`],
    3,
    () => [{ ok: !marker("marker-sentinel.txt"), what: "tampered 凭据里的命令**没有**被执行" }],
  );

  // ⑦ 没给文件 → 用法提示，exit 1（不是 5：这不是"没复跑"，是用不了）
  await expect("T7 没给凭据文件：打印用法并 exit 1", [], 1, (res) => [
    has(res.stderr, "用法", "打了用法到 stderr"),
  ]);

  // ⑧ 读不到的路径 → exit 1。"没法读"与"凭据坏"是两回事，不该混成 tampered。
  await expect(
    "T8 凭据不存在：exit 1 而不是 tampered",
    [path.join(tmp, "no-such-receipt.json")],
    1,
    (res) => [has(res.stderr, "读不了凭据", "说明了读不到")],
  );

  // 收尾：只删本脚本自己造的有限几个文件
  for (const n of fs.readdirSync(tmp)) {
    try {
      fs.unlinkSync(path.join(tmp, n));
    } catch {
      /* 残留无害 */
    }
  }
  try {
    fs.rmdirSync(tmp);
  } catch {
    /* 残留无害 */
  }

  console.log(failures === 0 ? "\n凭据复核工具冒烟全部通过 ✅" : `\n凭据复核工具冒烟失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("冒烟自身故障（非被测代码失败）:", e);
  process.exit(1);
});
